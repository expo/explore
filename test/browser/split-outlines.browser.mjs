import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

function pngBytes(width, height, color) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) image.data.set([...color, 255], index);
  return PNG.sync.write(image);
}
const png = (width, height, color) => `data:image/png;base64,${pngBytes(width, height, color).toString("base64")}`;
const GREEN = [40, 200, 40];

// Split over one screen with two changed areas and a card that moved 40% of the width right (at 60% in After, so
// at 20% in Before), and a second screen with one changed area elsewhere. The status bar CI left out is a foldable's
// rail pill, not a band across the top. Keys stand in for the controller's, so the pointer can stay where it is:
// 1 and 2 pick Split and Swipe, o toggles the outlines, n steps to the other screen, j selects the first area.
const entry = `
import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { CompareStage } from "/src/components/compare/compare-section.tsx";
import "/src/styles.css";
const screens = [
  [
    { x: 10, y: 20, width: 30, height: 20, share: 40, regionCount: 1 },
    { x: 60, y: 60, width: 30, height: 20, share: 30, regionCount: 1, move: { x: 40, y: 0, amount: { x: 400, y: 0 }, unit: "px" } },
    { x: 55, y: 20, width: 35, height: 20, share: 30, regionCount: 1 },
  ],
  [{ x: 10, y: 85, width: 20, height: 10, share: 100, regionCount: 1 }],
];
const systemRegions = [{ kind: "status-bar", x: 40, y: 0, width: 20, height: 4 }];
function Harness() {
  const [mode, setMode] = useState("split");
  const [outlines, setOutlines] = useState(true);
  const [screen, setScreen] = useState(0);
  const [active, setActive] = useState();
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "1") setMode("split");
      if (event.key === "2") setMode("swipe");
      if (event.key === "o") setOutlines((shown) => !shown);
      if (event.key === "n") setScreen((index) => 1 - index);
      if (event.key === "j") setActive(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The second screen has screenshots of its own when the test gives it some.
  const diff = { id: "s" + screen, status: "modified", beforeScreenshot: screen && window.nextBefore || window.before,
    afterScreenshot: screen && window.nextAfter || window.after };
  return (
    <div className={"compare-stage mode-" + mode} style={{ width: 800, height: 500, display: "flex" }}>
      <CompareStage key="stage" mode={mode} diff={diff} title="Share" areas={screens[screen]} activeArea={active}
        showOutlines={outlines} systemRegions={systemRegions} overlay={null} flipSide="after" onFlip={() => {}}
        swipePosition={50} onSwipePosition={() => {}} aspect={1} onAspect={() => {}} />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Harness />);
`;

async function openSplit(t, contextOptions = {}, images = {}) {
  const vite = await createBrowserVite(t, {
    configFile: false, root: fileURLToPath(new URL("../../viewer", import.meta.url)),
    logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{
      name: "split-outlines-fixture",
      resolveId: id => id === "/__split-outlines.tsx" ? id : undefined,
      load: id => id === "/__split-outlines.tsx" ? entry : undefined,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          // The next screen's Before, which takes a while to arrive.
          if (request.url === "/__slow-before.png") {
            response.setHeader("Content-Type", "image/png");
            setTimeout(() => response.end(pngBytes(100, 100, GREEN)), 1000);
            return;
          }
          if (new URL(request.url, "http://localhost").pathname !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/__split-outlines.tsx"></script></body></html>');
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, ...contextOptions });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(images => Object.assign(window, images), { before: png(100, 100, [240, 240, 240]), after: png(100, 100, [230, 230, 230]), ...images });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  const outline = (side, index) => page.locator(`[data-side="${side}"] .visual-change-outline`).nth(index);
  await expect(outline("after", 0)).toBeVisible();
  return { page, outline };
}

const opacity = locator => locator.evaluate(element => Number(getComputedStyle(element).opacity));

test("Split keeps the ignored system regions the report names on both sides", { timeout: 30_000 }, async t => {
  const { page } = await openSplit(t);
  for (const side of ["before", "after"]) {
    const band = page.locator(`[data-side="${side}"] .visual-system-region-status-bar`);
    await expect(band).toHaveCount(1);
    const [frame, box] = await Promise.all([page.locator(`[data-side="${side}"] .compare-frame`).boundingBox(), band.boundingBox()]);
    assert.ok(Math.abs((box.x - frame.x) - 0.4 * frame.width) < 1, `${side}'s band sits where the report puts the rail pill`);
    assert.ok(Math.abs(box.width - 0.2 * frame.width) < 1);
  }
});

test("Split hides Before's changed outlines but keeps a moved area where its content was", { timeout: 30_000 }, async t => {
  const { page, outline } = await openSplit(t);
  await expect.poll(() => opacity(outline("before", 0))).toBe(0);
  await expect.poll(() => opacity(outline("before", 1))).toBe(1);
  await expect(outline("before", 1).locator(".visual-change-measure")).toHaveCount(1);
  const frame = side => page.locator(`[data-side="${side}"] .compare-frame`).boundingBox();
  const [before, after, beforeFrame, afterFrame] = await Promise.all([outline("before", 1).boundingBox(), outline("after", 1).boundingBox(),
    frame("before"), frame("after")]);
  assert.ok(Math.abs(((after.x - afterFrame.x) - (before.x - beforeFrame.x)) - 0.4 * afterFrame.width) < 1, "Before's moved outline is back by the move");
});

test("A hover is dropped when the screen, the mode or the outlines change under the pointer", { timeout: 30_000 }, async t => {
  const { page, outline } = await openSplit(t);
  const hovered = page.locator(".visual-change-outline.hovered");
  for (const [away, back] of [["2", "1"], ["o", "o"], ["n", "n"]]) {
    await outline("after", 0).hover();
    await expect(outline("before", 0)).toHaveClass(/hovered/);
    // The outline goes from under the pointer, which then moves off the frame before it comes back.
    await page.keyboard.press(away);
    await page.mouse.move(0, 0);
    await page.keyboard.press(back);
    await expect(outline("after", 0)).toBeVisible();
    await expect(hovered).toHaveCount(0);
  }
});

test("The hovered outline on After stays lit while another area is selected", { timeout: 30_000 }, async t => {
  const { page, outline } = await openSplit(t);
  await page.keyboard.press("j");
  await outline("after", 2).hover();
  await expect.poll(() => opacity(outline("after", 2))).toBe(1);
  await expect.poll(() => opacity(outline("before", 2))).toBe(1);
  await expect.poll(() => opacity(outline("after", 1))).toBe(0.35);
});

test("A screen without hover keeps Before's outlines, as it cannot reveal one", { timeout: 30_000 }, async t => {
  const { page, outline } = await openSplit(t, { hasTouch: true, isMobile: true });
  assert.equal(await page.evaluate(() => matchMedia("(hover: none)").matches), true);
  await expect.poll(() => opacity(outline("before", 0))).toBe(1);
  await expect.poll(() => opacity(outline("before", 2))).toBe(1);
});

test("Stepping never shows the screen before's pictures under the next one's outlines: a side still loading is an empty frame", { timeout: 30_000 }, async t => {
  const images = { before: png(100, 100, [200, 40, 40]), after: png(100, 100, [40, 40, 200]),
    nextBefore: "/__slow-before.png", nextAfter: png(100, 100, [200, 200, 40]) };
  const { page } = await openSplit(t, {}, images);
  for (const side of ["before", "after"]) await expect(page.locator(`[data-side="${side}"] img`)).toHaveAttribute("data-screenshot-state", "ready");
  // Every frame from the step on: the screen the outlines belong to, and any picture of the screen before still showing.
  await page.evaluate(previous => {
    window.stepFrames = [];
    const sample = () => {
      const outlines = document.querySelectorAll('[data-side="after"] .visual-change-outline').length;
      const stale = [...document.querySelectorAll(".compare-frame img")].filter(image => previous.includes(image.getAttribute("src"))
        && Number(getComputedStyle(image).opacity) > 0).length;
      window.stepFrames.push({ outlines, stale });
      if (window.stepFrames.length < 30) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, [images.before, images.after]);
  await page.keyboard.press("n");
  await expect.poll(() => page.evaluate(() => window.stepFrames.length)).toBe(30);
  const frames = await page.evaluate(() => window.stepFrames);
  assert.ok(frames.some(frame => frame.outlines === 1), "The step landed while the frames were sampled");
  assert.deepEqual(frames.filter(frame => frame.outlines === 1 && frame.stale > 0), [], "No frame showed a picture of the screen before under the next one's outlines");

  // Before is still loading: its frame is empty, After's shows the new screen.
  const before = page.locator('[data-side="before"] img');
  await expect(before).toHaveAttribute("data-screenshot-state", "loading");
  await expect(before).toHaveCSS("opacity", "0");
  await expect(page.locator('[data-side="after"] img')).toHaveAttribute("data-screenshot-state", "ready");
  await expect(before).toHaveAttribute("data-screenshot-state", "ready", { timeout: 5000 });
});
