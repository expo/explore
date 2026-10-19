// Regenerates the README's pictures in docs/screenshots from a review report, in light and dark
// (the README shows them with <picture>; GitHub Mobile ignores the dark source and shows light). The reference app is euxy
// (github.com/brentvatne/euxy): skills/readme-refresh/SKILL.md says which report to pass and how.
//
// Usage: npm run readme:screenshots -- --report ios.zip [--select /settings] [--compare patterns]
//        [--pr https://github.com/brentvatne/euxy/pull/148]
//
//   --report   a sealed review report (the hosted link's report.zip?platform=ios, or the PR's zip artifact)
//   --select   the route selected on the hero Map (opens the Inspector); default /settings. The hero zooms in around it
//              (--zoom, default 73%) and is an animated SVG of a window on a soft stage (readme-animations.mjs): the
//              Map's cards appear, its transitions wipe in, and a click on this screen opens the Inspector
//   --compare  the Compare key of a modified screen: the slug in the Viewer's #/compare/<key> URL; default patterns.
//              It becomes readme-compare-*.svg, its before capture wiping to its after capture
//   --pr       a GitHub PR URL whose Explore comment becomes readme-pr-comment-light.png (public repository): the comment
//              at its own size on a soft stage, cut off with a fade after the list of changed screens
//   --only     the pictures to write, comma-separated, of hero, compare, screens and pr-comment; default all of them (the
//              PR comment only with --pr). --only pr-comment needs no --report
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { startReportViewer } from "../test/ci/lib/report-viewer.mjs";
import { captureHeroFrames, compareSurface, compareSvg, heroSvg, mapCard, openReport } from "./readme-animations.mjs";

const { values: args } = parseArgs({
  options: {
    report: { type: "string" },
    select: { type: "string", default: "/settings" },
    compare: { type: "string", default: "patterns" },
    pr: { type: "string" },
    zoom: { type: "string", default: "73" },
    only: { type: "string" },
  },
});
const PICTURES = ["hero", "compare", "screens", "pr-comment"];
const only = args.only?.split(",").map(name => name.trim()).filter(Boolean);
const unknown = only?.filter(name => !PICTURES.includes(name)) ?? [];
if (unknown.length) {
  console.error(`Unknown --only ${unknown.join(", ")}; pass some of ${PICTURES.join(", ")}.`);
  process.exit(2);
}
const wanted = name => !only || only.includes(name);
const fromReport = PICTURES.filter(name => name !== "pr-comment").some(wanted);
if (fromReport && !args.report) {
  console.error("Pass --report <review report zip>. See skills/readme-refresh/SKILL.md for where the euxy report comes from.");
  process.exit(2);
}

const out = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
const SHOTS = [
  { name: "hero", file: "readme-hero", hash: "#/map", viewport: { width: 1376, height: 774 }, click: page => page.getByRole("button", { name: "Fit canvas" }), select: args.select, zoom: Number(args.zoom), animated: true },
  // Screens shows its Changed filter, so the added, removed and modified dots are all in view wherever the tree sorts them.
  { name: "screens", file: "readme-screens", hash: "#/screens", viewport: { width: 1760, height: 1000 }, click: page => page.locator(".screens-chip", { hasText: "Changed" }) },
].filter(shot => wanted(shot.name));

const bytes = fromReport ? await readFile(args.report) : undefined;
const report = bytes && await openReport(bytes);
const { server, url } = bytes ? await startReportViewer({ bytes, watch: false }) : {};
const browser = await chromium.launch();
try {
  for (const theme of wanted("compare") ? ["light", "dark"] : []) {
    const surface = compareSurface(report.review, args.compare, theme);
    const path = `${out}readme-compare-${theme}.svg`;
    await writeFile(path, await compareSvg(browser, report, surface, theme,
      `The ${surface.head.route} screen of euxy wiping from its capture before the pull request to its capture after it, with the changed regions outlined`));
    console.log(path);
  }
  for (const theme of ["light", "dark"]) for (const shot of SHOTS) {
    const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2, colorScheme: theme });
    await context.addInitScript(value => localStorage.setItem("expo-explore:theme", value), theme);
    const page = await context.newPage();
    await page.goto(url + shot.hash);
    await page.waitForSelector(".react-flow__node, .compare-stage, .screens-cell", { timeout: 60_000 });
    await page.waitForTimeout(4000);
    if (shot.click) {
      await shot.click(page).click();
      await page.mouse.move(400, shot.viewport.height - 30);
      await page.waitForTimeout(1500);
    }
    if (shot.select && !shot.animated) {
      // Selecting a screen opens the Inspector without moving the fitted camera. The animated hero selects it last.
      await mapCard(page, report.review, shot.select).click();
      await page.mouse.move(400, shot.viewport.height - 30);
      await page.waitForTimeout(1500);
    }
    if (shot.zoom) {
      // Zoom around the selected screen with the wheel, which keeps it under the pointer, then pan it left and up, clear
      // of the minimap and the bottom bar. The camera stops at the first wheel step past the zoom asked for.
      const box = await mapCard(page, report.review, shot.select).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let step = 0; step < 60; step++) {
        if (Number((await page.locator(".zoom-button span").first().textContent()).replace("%", "")) >= shot.zoom) break;
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -12);
        await page.keyboard.up("Control");
        await page.waitForTimeout(150);
      }
      await page.mouse.wheel(160, 90);
      await page.mouse.move(shot.viewport.width - 60, shot.viewport.height / 2);
      await page.waitForTimeout(1200);
    }
    const path = `${out}${shot.file}-${theme}.${shot.animated ? "svg" : "png"}`;
    if (shot.animated) {
      const frames = await captureHeroFrames(page, { select: shot.select, card: mapCard(page, report.review, shot.select), viewport: shot.viewport });
      await writeFile(path, heroSvg(frames, theme,
        `Explore's Map of a euxy pull request: the screen cards appear row by row, the transitions between them wipe in, then a click selects ${shot.select} and the Inspector opens on it`));
    } else await page.screenshot({ path });
    console.log(path);
    await context.close();
  }
  for (const theme of args.pr && wanted("pr-comment") ? ["light", "dark"] : []) {
    // Signed-out github.com follows prefers-color-scheme.
    const context = await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(args.pr, { waitUntil: "domcontentloaded" });
    const comment = page.locator(".timeline-comment").filter({ has: page.locator("h3", { hasText: /Review in Explore|Explore review/ }) }).first();
    await comment.waitFor({ timeout: 30_000 });
    await comment.scrollIntoViewIfNeeded();
    // The comment's pointer toward the avatar would show as a stray tick above the card.
    await page.addStyleTag({ content: ".timeline-comment::before, .timeline-comment::after { display: none !important; }" });
    await page.waitForTimeout(1000);
    // Cut after the list of changed screens: the collapsed blocks and footer below it are detail.
    const clip = await comment.evaluate((card) => {
      const box = card.getBoundingClientRect();
      const list = [...card.querySelectorAll("ul")].find(ul => ul.querySelector(":scope > li code"));
      const after = list?.nextElementSibling;
      const bottom = after ? after.getBoundingClientRect().top : list ? list.getBoundingClientRect().bottom : box.bottom;
      return { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: Math.round(bottom - box.top) };
    });
    const shot = await page.screenshot({ clip, fullPage: true });
    await context.close();
    const path = `${out}readme-pr-comment-${theme}.png`;
    await writeFile(path, await stagedComment(browser, shot, clip, theme));
    console.log(path);
  }
} finally {
  await browser.close();
  await server?.close?.();
}

/**
 * The comment on a rounded stage as wide as the README column (880 px, drawn at 2x), with a soft shadow and a fade at
 * the cut. The corners outside the stage stay transparent, so the image sits on either GitHub theme.
 */
async function stagedComment(browser, shot, clip, theme) {
  const dark = theme === "dark";
  const stage = dark ? "#151B23" : "#F6F8FA";
  const shadow = dark ? "0 1px 2px rgba(1,4,9,0.4), 0 8px 24px rgba(1,4,9,0.5)" : "0 1px 2px rgba(31,35,40,0.06), 0 8px 24px rgba(31,35,40,0.08)";
  const context = await browser.newContext({ viewport: { width: 880, height: 400 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div id="stage" style="width:880px;box-sizing:border-box;padding:48px 0 0;display:flex;justify-content:center;background:${stage};border-radius:12px;overflow:hidden">
      <div style="position:relative;width:${clip.width}px;height:${clip.height}px;border-radius:6px 6px 0 0;overflow:hidden;box-shadow:${shadow}">
        <img src="data:image/png;base64,${shot.toString("base64")}" style="display:block;width:${clip.width}px;height:${clip.height}px">
        <div style="position:absolute;left:0;right:0;bottom:0;height:96px;background:linear-gradient(to bottom, transparent, ${stage})"></div>
      </div>
    </div></body></html>`);
  const png = await page.locator("#stage").screenshot({ omitBackground: true });
  await context.close();
  return png;
}
