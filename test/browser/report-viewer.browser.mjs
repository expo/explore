import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { writeViewerMapFixture } from "../helpers/viewer-map-fixture.mjs";
import { startReportViewer } from "../ci/lib/report-viewer.mjs";

const root = new URL("../../", import.meta.url);
// The recorded `explore-review-35721157511-1` artifact (Meow, expo/explore-playground PR #1): 35 screens, 31 modified,
// one added, one removed, pixel regions on /settings, /cats and /games. The same report the artifact tests open.
const REPORT = new URL("../fixtures/example-review-artifact.zip", import.meta.url);

/** The Viewer's sources with the recorded report open at /r, the way `npm run ci:local:view` serves one. */
async function openReport(t, viewport) {
  const cacheDir = await mkdtemp(join(tmpdir(), "explore-report-viewer-"));
  const { server, url } = await startReportViewer({ bytes: await readFile(REPORT), port: "free", watch: false, cacheDir });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { page, url, errors };
}


/** The Changes list lives in the top-left pill's menu; open it from the change-count chip. */
async function openChangesMenu(page) {
  // The pill has no chip: ⌘B (Ctrl+B) opens the Changes menu, as Compare's title does there.
  const menu = page.locator(".changes-menu");
  // The Compare button appears once the changes are loaded; the shortcut needs them too.
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true })).toBeVisible();
  if (!(await menu.isVisible())) await page.keyboard.press("ControlOrMeta+KeyB");
  await expect(menu).toBeVisible();
  return menu;
}

/** Choosing a row closes the menu, so each changed screen opens from a fresh menu. */
async function openChangedScreen(page, name) {
  const menu = await openChangesMenu(page);
  await menu.getByRole("button", { name, exact: true }).click();
}

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function launcher(t, script, args = [], env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Launcher timed out: ${output}`)); }, 30_000);
    const collect = bytes => {
      output += bytes.toString();
      const match = /(?:Report Viewer:|dev viewer with HMR →) (http:\/\/[^\s]+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Launcher exited before ready: ${output}`)); });
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(url)).ok) return { child, exited, url }; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Launcher never became ready: ${output}`);
}

async function expectStopped({ child, exited, url }, signal) {
  child.kill(signal);
  const [code, exitSignal] = await exited;
  assert.equal(code, 0);
  assert.equal(exitSignal, null);
  await assert.rejects(fetch(url));
}

test("a recorded review opens on the real map and before/after evidence and survives reload", { timeout: 90_000 }, async t => {
  const { page, url, errors } = await openReport(t, { width: 1600, height: 900 });
  const external = [];
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
  });
  await page.goto(url);
  await expect(page.locator(".collapsed-app-identity strong")).toContainText("Meow");
  await expect(page.locator(".collapsed-pr")).toContainText("PR #1");
  // The map is one card per screen; changed screens carry their diff status on the card.
  await expect(page.locator(".map-canvas .react-flow__node-screen")).toHaveCount(33);
  await expect(page.locator('.map-canvas .screen-node-title[aria-label="Copy deep link /games"]')).toBeVisible();
  await expect(page.getByText("No report open")).toHaveCount(0);
  const menu = await openChangesMenu(page);
  // Changes lists the screens with something to see: the three with pixel changes, the added and the removed one.
  await expect(menu.locator(".changes-screen-row")).toHaveCount(5);
  await page.keyboard.press("Escape");
  // A changed screen opens the sidebar review in the inspector.
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/#\/screens/);
  await openChangedScreen(page, /, Modified, \/games$/);
  const diff = page.locator(".right-panel .inspector-diff");
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Modified");
  // What changed is an accordion under the review: it opens the findings in place and folds them
  // away again, and the Inspector stays open.
  await diff.getByRole("button", { name: /^What changed/ }).click();
  await expect(diff.getByRole("region", { name: "What changed on this screen" })).not.toBeEmpty();
  await diff.getByRole("button", { name: /^What changed/ }).click();
  await expect(diff.getByRole("region", { name: "What changed on this screen" })).toHaveCount(0);
  await expect(page.locator(".right-panel")).toBeVisible();
  const imagesLoaded = async () => {
    for (const side of ["before", "after"]) {
      await expect.poll(() => diff.locator(`[data-side="${side}"] img`).first().evaluate(image => ({
        width: image.naturalWidth, height: image.naturalHeight,
      }))).toEqual({ width: 402, height: 874 });
    }
  };
  await imagesLoaded();
  const selectedUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(selectedUrl);
  await imagesLoaded();
  await expect(page.getByText("No report open")).toHaveCount(0);
  await openChangedScreen(page, /, Added, \/cats\/care-guide$/);
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Added");
  // A one-sided screen shows only the side it has, with no Before or After: nothing to compare.
  await expect(diff.locator('[data-side="before"]')).toHaveCount(0);
  await expect(diff.getByRole("button", { name: /^(Before|After)$/ })).toHaveCount(0);
  await expect.poll(() => diff.locator('[data-side="after"] img').first().evaluate(image => image.naturalWidth)).toBe(402);
  await openChangedScreen(page, /, Removed, \/games\/sweet-bee$/);
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Removed");
  await expect(diff.locator('[data-side="after"]')).toHaveCount(0);
  await expect(diff.getByRole("button", { name: /^(Before|After)$/ })).toHaveCount(0);
  await expect.poll(() => diff.locator('[data-side="before"] img').first().evaluate(image => image.naturalWidth)).toBe(402);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test("Compare steps through changed screens and their changed areas", { timeout: 90_000 }, async t => {
  const { page, url, errors } = await openReport(t, { width: 1600, height: 1000 });
  await page.goto(url);

  // A changed screen opens the same review in the Inspector on every canvas: Compare at sidebar
  // size. CI compares the images pixel for pixel, so /games's four CI regions read as changed
  // areas, outlined at the same place on both sides.
  await openChangedScreen(page, /, Modified, \/games$/);
  const inspector = page.locator(".right-panel");
  const review = inspector.getByRole("region", { name: "Changes in /games" });
  const outlineCount = async side => review.locator(`[data-side="${side}"] .visual-change-outline`).count();
  await expect(review).toBeVisible();
  // Stepping through the changed screens is Compare's; the Inspector has no pager.
  await expect(review.getByRole("group", { name: "Changed screens" })).toHaveCount(0);
  await expect.poll(() => outlineCount("after")).toBeGreaterThan(0);
  const areas = await outlineCount("after");
  assert.equal(await outlineCount("before"), areas);
  // Esc closes the Inspector; the selection stays, a second Esc clears it.
  const selected = page.locator(".map-canvas .react-flow__node-screen.selected");
  await page.keyboard.press("Escape");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(selected).toHaveAttribute("data-id", /games-index/);
  await openChangedScreen(page, /, Modified, \/games$/);
  await expect(review).toBeVisible();
  // Neither the arrows nor h j k l step the Inspector through the changed screens or areas: on the
  // map they walk the drawing from the selected screen (here to the neighbour to its right and
  // back), the Inspector following. Changed areas step with J/K in Compare only.
  await page.keyboard.press("ArrowRight");
  await expect(selected).not.toHaveAttribute("data-id", /games-index/);
  const neighbour = await selected.getAttribute("data-id");
  await expect(review).toHaveCount(0);
  await expect(review.locator(".visual-change-outline.active")).toHaveCount(0);
  await page.keyboard.press("h");
  await expect(selected).toHaveAttribute("data-id", /games-index/);
  await expect(review).toBeVisible();
  await page.keyboard.press("l");
  await expect(selected).toHaveAttribute("data-id", neighbour);
  await page.keyboard.press("ArrowLeft");
  await expect(selected).toHaveAttribute("data-id", /games-index/);
  await expect(review).toBeVisible();

  // Screens shows the same review.
  await page.keyboard.press("s");
  await openChangedScreen(page, /, Modified, \/games$/);
  await expect(review).toBeVisible();
  await expect(review.locator('[data-side="after"] .visual-change-outline')).toHaveCount(areas);

  // Compare is a section of its own, with a URL, the same chrome and a command bar that steps.
  await inspector.locator(".right-head").getByRole("button", { name: "Open in Compare" }).click();
  await expect(page).toHaveURL(/#\/compare\/games$/);
  const compare = page.getByRole("region", { name: "Compare /games" });
  await expect(compare.locator(".compare-nav-route")).toHaveText("/games");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
  await expect(toolbar.getByRole("button", { name: "Compare", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(compare.locator(".compare-nav-position")).toHaveText(/^\d of 5$/);
  const position = await compare.locator(".compare-nav-position").textContent();
  // The modes sit in Compare's own bar; the bottom toolbar is the same on every section.
  const modes = page.locator(".compare-section .compare-bar").getByRole("group", { name: "Comparison mode" });
  await expect(modes.getByRole("button")).toHaveText(["Split", "Swipe", "Flip"]);
  // The arrows belong to the screens, even while a mode button has focus.
  await modes.getByRole("button", { name: "Swipe" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page).not.toHaveURL(/#\/compare\/games$/);
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/#\/compare\/games$/);
  await expect(compare.locator(".compare-nav-position")).toHaveText(position);
  await expect(modes.getByRole("button", { name: "Swipe" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("1");
  await expect(modes.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true");
  await expect(compare.locator('[data-side="before"] .visual-change-outline')).toHaveCount(areas);
  await expect(compare.locator('[data-side="after"] .visual-change-outline')).toHaveCount(areas);
  for (const side of ["before", "after"]) {
    await expect.poll(() => compare.locator(`[data-side="${side}"] img`).first()
      .evaluate(image => image.naturalWidth)).toBe(402);
  }

  // J and K step through the changed areas; Esc clears the highlight.
  const outlines = compare.locator('[data-side="after"] .visual-change-outline');
  await page.keyboard.press("j");
  await expect(outlines.nth(0)).toHaveClass(/active/);
  await page.keyboard.press("j");
  await expect(outlines.nth(1)).toHaveClass(/active/);
  await page.keyboard.press("k");
  await expect(outlines.nth(0)).toHaveClass(/active/);
  await page.keyboard.press("Escape");
  await expect(compare.locator(".visual-change-outline.active")).toHaveCount(0);

  // O hides and shows the outlines.
  await page.keyboard.press("o");
  await expect(compare.locator(".visual-change-outline")).toHaveCount(0);
  await page.keyboard.press("o");
  await expect(compare.locator('[data-side="after"] .visual-change-outline')).toHaveCount(areas);

  // What changed lists the CI facts in a popover under its button.
  await compare.getByRole("button", { name: "What changed" }).click();
  await expect(compare.getByRole("region", { name: "What changed on this screen" })).not.toBeEmpty();
  await page.keyboard.press("Escape");
  await expect(compare.getByRole("region", { name: "What changed on this screen" })).toHaveCount(0);

  // Swipe: [ and ] move the divider; a focused divider owns the arrow keys.
  await page.keyboard.press("2");
  const divider = compare.getByRole("slider", { name: "Before and after divider" });
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("BracketLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "45");
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "40");
  await expect(page).toHaveURL(/#\/compare\/games$/);

  // Flip: X shows the other side; the mode is remembered across a reload.
  // The label names both sides and lights the one on screen; clicking the other flips to it.
  await page.keyboard.press("3");
  const flipLabel = compare.locator(".compare-flip-label");
  await expect(flipLabel.getByRole("button", { name: "After" })).toHaveAttribute("aria-pressed", "true");
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.keyboard.press("x");
  await expect(flipLabel.getByRole("button", { name: "Before" })).toHaveAttribute("aria-pressed", "true");
  await flipLabel.getByRole("button", { name: "After" }).click();
  await expect(flipLabel.getByRole("button", { name: "After" })).toHaveAttribute("aria-pressed", "true");
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.keyboard.press("x");
  await page.reload();
  await expect(page.getByRole("group", { name: "Comparison mode" })
    .getByRole("button", { name: "Flip" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("1");

  // The header's steps move between changed screens in review order; a removed screen has one
  // side: it opens in Flip, and the other modes are off.
  await page.goto(`${url}#/compare/games/sweet-bee`);
  const removed = page.getByRole("region", { name: "Compare /games/sweet-bee" });
  await expect(removed).toBeVisible();
  await expect(removed.locator('[data-side="after"]')).toHaveCount(0);
  await expect(modes.getByRole("button", { name: "Swipe" })).toBeDisabled();
  await removed.getByRole("button", { name: "Previous changed screen" }).click();
  await expect(page).toHaveURL(/#\/compare\//);
  await expect(page).not.toHaveURL(/sweet-bee$/);

  // "?" opens the keyboard reference; M returns to the map.
  await page.keyboard.press("?");
  const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(shortcuts).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shortcuts).toHaveCount(0);
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/#\/map/);
  assert.deepEqual(errors, []);
});

/** The Inspector's one frame for a screen outside the review, and its Swipe frame for a changed one, in this viewport. */
async function inspectorFrames(page, url) {
  const games = "expo-tabs-games-index-2c6605360b11";
  const index = "expo-index-02872ff9f2ca";
  const open = async id => {
    await page.goto(`${url}#/screens`);
    const all = page.getByRole("button", { name: /^All/ }).first();
    await expect(all).toBeVisible();
    if ((await all.getAttribute("aria-pressed")) !== "true") await all.click();
    const cell = page.locator(`.screens-cell[data-screen-id="${id}"]`);
    await cell.scrollIntoViewIfNeeded();
    await cell.click();
  };
  await open(games);
  await page.locator(".sidebar-review-modes").getByRole("button", { name: "Swipe" }).click();
  const swipeImage = page.locator(".sidebar-review-stage img").first();
  await expect(swipeImage).toBeVisible();
  const changed = await swipeImage.boundingBox();
  await open(index);
  const single = page.locator(".sidebar-review-off .variant-preview");
  await expect(single).toBeVisible();
  return { changed, single: await single.boundingBox() };
}

test("the Inspector frames an unchanged screen at the size of a changed screen's Swipe frame", { timeout: 90_000 }, async t => {
  // / is unchanged (not compared); /games is modified. The single frame used to take at most half the panel, the
  // width of one frame of a Before/After pair, while Swipe and Flip fill the panel up to 70 % (phone: 52 %) of the window.
  for (const viewport of [{ width: 1024, height: 820 }, { width: 390, height: 844 }]) {
    const { page, url, errors } = await openReport(t, viewport);
    const { changed, single } = await inspectorFrames(page, url);
    assert.ok(changed.height > viewport.height * 0.5, `${viewport.width}px: Swipe frame ${changed.height}px high`);
    assert.ok(Math.abs(single.height - changed.height) <= 6, `${viewport.width}px: single ${single.height}px vs Swipe ${changed.height}px high`);
    assert.ok(Math.abs(single.width - changed.width) <= 6, `${viewport.width}px: single ${single.width}px vs Swipe ${changed.width}px wide`);
    assert.deepEqual(errors, []);
  }
});

test("Back from Compare returns to the Map with the screen in view", { timeout: 60_000 }, async t => {
  const { page, url } = await openReport(t, { width: 1440, height: 900 });
  await page.goto(url);
  await openChangedScreen(page, /, Modified, \/games$/);
  await page.locator(".right-panel").getByRole("button", { name: "Open in Compare" }).click();
  await expect(page).toHaveURL(/#\/compare\/games$/);
  // The Map remounts with an unplaced camera; the selection must still bring the screen into view.
  await page.goBack();
  await expect(page).toHaveURL(/#\/map\/games$/);
  const selected = page.locator(".map-canvas .react-flow__node-screen.selected");
  await expect(selected).toBeVisible();
  await expect.poll(async () => {
    const box = await selected.boundingBox();
    return Boolean(box && box.width > 100 && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900);
  }).toBe(true);
});

test("a fresh link to a Map screen lays out flow detail without cards over the screen", { timeout: 60_000 }, async t => {
  const { page, url } = await openReport(t, { width: 1440, height: 900 });
  // The landing focus claims the camera before the first layout settles. The area cards must
  // still take the flow-detail positions, not keep the overview grid's.
  await page.goto(`${url}#/map/settings`);
  await expect(page.locator(".react-flow__node-screen")).not.toHaveCount(0);
  const overlaps = () => page.evaluate(() => {
    const boxes = (selector) => [...document.querySelectorAll(selector)].map((element) => element.getBoundingClientRect());
    const screens = boxes(".react-flow__node-screen");
    const cards = boxes(".react-flow__node-summary");
    return cards.filter((card) => screens.some((screen) => (
      card.left < screen.right && screen.left < card.right && card.top < screen.bottom && screen.top < card.bottom
    ))).length;
  });
  await expect.poll(overlaps, { timeout: 5_000 }).toBe(0);
  await page.waitForTimeout(800);
  assert.equal(await overlaps(), 0);
});

test("the Screens tree folds by row, by keyboard, and all at once, and remembers its folds", { timeout: 60_000 }, async t => {
  const { page, url, errors } = await openReport(t, { width: 1440, height: 900 });
  await page.goto(`${url}#/screens`);
  const tree = page.locator(".screens-tree");
  await tree.getByRole("button", { name: /^All/ }).click();
  const rows = tree.locator(".screens-tree-row");
  const folder = tree.locator(".screens-tree-row.folder", { hasText: "onboarding/" });
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("button", { name: "/onboarding/cat-name" })).toBeVisible();
  const expandedRows = await rows.count();

  // A click folds a folder; ← and → fold and unfold the focused one.
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("button", { name: "/onboarding/cat-name" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");

  // Collapse all folds every folder and turns into Expand all.
  await tree.getByRole("button", { name: "Collapse all" }).click();
  await expect(tree.locator('.screens-tree-row[aria-expanded="true"]')).toHaveCount(0);
  const foldedRows = await rows.count();
  assert.ok(foldedRows < expandedRows);

  // The folds outlast a reload; Expand all opens everything again.
  await page.reload();
  await tree.getByRole("button", { name: /^All/ }).click();
  await expect.poll(() => rows.count()).toBe(foldedRows);
  await tree.getByRole("button", { name: "Expand all" }).click();
  await expect.poll(() => rows.count()).toBe(expandedRows);

  // The tree names the folders, so the page beside it is one grid without section headings, in the tree's order.
  await expect(page.locator(".screens-page .screens-section-head")).toHaveCount(0);
  await expect(page.locator(".screens-page .screens-grid")).toHaveCount(1);
  const treeOrder = await tree.locator(".screens-tree-row[data-screen-id]").evaluateAll(rows => rows.map(row => row.dataset.screenId));
  const gridOrder = await page.locator(".screens-page .screens-cell").evaluateAll(cells => cells.map(cell => cell.dataset.screenId));
  assert.ok(gridOrder.length > 1);
  assert.deepEqual(gridOrder, treeOrder);
  assert.deepEqual(errors, []);
});

test("a fold tried during a find changes nothing: the tree's own folds come back, and are what a reload remembers", { timeout: 60_000 }, async t => {
  const { page, url, errors } = await openReport(t, { width: 1440, height: 900 });
  await page.goto(`${url}#/screens`);
  const tree = page.locator(".screens-tree");
  await tree.getByRole("button", { name: /^All/ }).click();
  const folder = tree.locator(".screens-tree-row.folder", { hasText: "onboarding/" });
  const other = tree.locator(".screens-tree-row.folder").filter({ hasNotText: "onboarding/" }).first();
  await expect(other).toHaveAttribute("aria-expanded", "true");
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");

  // While a find is on every row stays open; folding one there neither shows nor sticks.
  await page.keyboard.press("/");
  const field = page.getByRole("searchbox", { name: "Find screens" });
  await field.fill("/");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await other.click();
  await page.keyboard.press("ArrowLeft");
  await expect(other).toHaveAttribute("aria-expanded", "true");
  await field.press("Escape");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(other).toHaveAttribute("aria-expanded", "true");

  await page.reload();
  await tree.getByRole("button", { name: /^All/ }).click();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await expect(other).toHaveAttribute("aria-expanded", "true");
  assert.deepEqual(errors, []);
});

test("dev opens the report ZIP named by EXPLORE_REPORT and preserves the explicit map API proxy", { timeout: 90_000 }, async t => {
  const reportDev = await launcher(t, "scripts/dev-viewer.mjs", [], {
    EXPLORE_DIR: "", EXPLORE_REPORT: fileURLToPath(REPORT), EXPLORE_DEV_PORT: String(await freePort()),
  });
  assert.equal(new URL(reportDev.url).pathname, "/r");
  const served = await fetch(new URL("/__local-report.zip", reportDev.url));
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), await readFile(REPORT));
  await expectStopped(reportDev, "SIGTERM");

  const directory = await mkdtemp(join(tmpdir(), "explore-dev-map-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeViewerMapFixture(directory);
  const mapDev = await launcher(t, "scripts/dev-viewer.mjs", [], {
    EXPLORE_DIR: directory, EXPLORE_DEV_PORT: String(await freePort()), EXPLORE_API_PORT: String(await freePort()),
  });
  const payload = await (await fetch(new URL("/api/map", mapDev.url))).json();
  assert.equal(payload.map.run.name, "Viewer fixture");
  assert.equal(payload.map.screens.length, 32);
  await expectStopped(mapDev, "SIGINT");
});

test("a Screens card keeps its status dot on the route's line, however tall its row", { timeout: 60_000 }, async t => {
  const { page, url, errors } = await openReport(t, { width: 1440, height: 900 });
  await page.goto(`${url}#/screens`);
  const all = page.getByRole("button", { name: /^All/ }).first();
  await expect(all).toBeVisible();
  if ((await all.getAttribute("aria-pressed")) !== "true") await all.click();
  await expect(page.locator(".screens-cell .diff-label").first()).toBeVisible();
  const layout = await page.locator(".screens-page").evaluate(async () => {
    const cards = [...document.querySelectorAll(".screens-cell .screen-screenshot-card")];
    // A row grows with a neighbour's notes ("Changed in dark") and stretches every card in it: stretch each one well past its content.
    for (const card of cards) card.style.height = `${card.getBoundingClientRect().height + 48}px`;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const offsets = cards.filter(card => card.querySelector(".diff-label")).map(card => {
      const dot = card.querySelector(".diff-label").getBoundingClientRect(), title = card.querySelector(".screen-node-title").getBoundingClientRect();
      const line = parseFloat(getComputedStyle(card.querySelector(".screen-node-title")).lineHeight);
      return Math.abs(dot.top + dot.height / 2 - (title.top + line / 2));
    });
    return { offsets };
  });
  assert.ok(layout.offsets.length > 0, "the report has changed screens");
  assert.ok(layout.offsets.every(offset => offset <= 1), `each dot is centred on its route's first line: ${layout.offsets}`);
  assert.deepEqual(errors, []);
});
