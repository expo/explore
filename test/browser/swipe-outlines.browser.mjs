import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

function png(width, height, color) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) image.data.set([...color, 255], index);
  return `data:image/png;base64,${PNG.sync.write(image).toString("base64")}`;
}

// A card that moved 40% of the width right: it is at 60% in After, so it was at 20% in Before.
const entry = `
import { createRoot } from "react-dom/client";
import { SwipeCompare } from "/src/components/panels/visual-diff.tsx";
import "/src/styles.css";
const changes = [{ x: 60, y: 30, width: 30, height: 30, share: 100, regionCount: 1,
  move: { x: 40, y: 0, amount: { x: 400, y: 0 }, unit: "px" } }];
createRoot(document.getElementById("root")).render(<div style={{ width: 400, display: "flex" }}>
  <SwipeCompare title="Share" before={window.before} after={window.after} imageAspect={1} changes={changes} position={50} />
</div>);
`;

test("Swipe draws a moved area where its content was on Before's half and where it is on After's", { timeout: 30_000 }, async t => {
  const vite = await createBrowserVite(t, {
    configFile: false, root: fileURLToPath(new URL("../../viewer", import.meta.url)),
    logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{
      name: "swipe-outlines-fixture",
      resolveId: id => id === "/__swipe-outlines.tsx" ? id : undefined,
      load: id => id === "/__swipe-outlines.tsx" ? entry : undefined,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (new URL(request.url, "http://localhost").pathname !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/__swipe-outlines.tsx"></script></body></html>');
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(images => Object.assign(window, images), { before: png(100, 100, [240, 240, 240]), after: png(100, 100, [230, 230, 230]) });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);

  const frame = page.locator(".visual-swipe");
  const before = page.locator(".visual-swipe-outlines.before .visual-change-outline.moved");
  const after = page.locator(".visual-swipe-outlines.after .visual-change-outline.moved");
  await expect(before).toHaveCount(1);
  await expect(after).toHaveCount(1);
  const [box, beforeBox, afterBox] = await Promise.all([frame.boundingBox(), before.boundingBox(), after.boundingBox()]);
  assert.ok(Math.abs((afterBox.x - beforeBox.x) - 0.4 * box.width) < 1, "Before's outline is back by the move");
  // Each side's outlines show only over its own half of the frame.
  const clips = await page.locator(".visual-swipe-outlines").evaluateAll(spans => spans.map(span => getComputedStyle(span).clipPath));
  assert.deepEqual(clips.map(clip => clip.startsWith("inset(")), [true, true]);
  assert.deepEqual(errors, []);
});
