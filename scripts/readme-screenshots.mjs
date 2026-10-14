// Regenerates the Viewer screenshots in docs/screenshots from a review report, in light and dark
// (the README shows them with <picture>; GitHub Mobile ignores the dark source and shows light). The reference app is euxy
// (github.com/brentvatne/euxy): skills/readme-refresh/SKILL.md says which report to pass and how.
//
// Usage: npm run readme:screenshots -- --report ios.zip [--select /settings] [--compare patterns]
//        [--pr https://github.com/brentvatne/euxy/pull/148]
//
//   --report   a sealed review report (the hosted link's report.zip?platform=ios, or the PR's zip artifact)
//   --select   the route selected on the hero Map (opens the Inspector); default /settings
//   --compare  the Compare key of a modified screen: the slug in the Viewer's #/compare/<key> URL; default patterns
//   --pr       a GitHub PR URL whose Explore comment becomes readme-pr-comment-light.png (public repository): the comment
//              at its own size on a soft stage, cut off with a fade after the list of changed screens
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { startReportViewer } from "../test/ci/lib/report-viewer.mjs";

const { values: args } = parseArgs({
  options: {
    report: { type: "string" },
    select: { type: "string", default: "/settings" },
    compare: { type: "string", default: "patterns" },
    pr: { type: "string" },
  },
});
if (!args.report) {
  console.error("Pass --report <review report zip>. See skills/readme-refresh/SKILL.md for where the euxy report comes from.");
  process.exit(2);
}

const out = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
const SHOTS = [
  { file: "readme-hero", hash: "#/map", viewport: { width: 2200, height: 1240 }, click: "Fit canvas", select: args.select },
  { file: "readme-compare", hash: `#/compare/${args.compare}`, viewport: { width: 1760, height: 1000 } },
  { file: "readme-screens", hash: "#/screens", viewport: { width: 1760, height: 1000 } },
];

const bytes = await readFile(args.report);
const { server, url } = await startReportViewer({ bytes, watch: false });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"]) for (const shot of SHOTS) {
    const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2, colorScheme: theme });
    await context.addInitScript(value => localStorage.setItem("expo-explore:theme", value), theme);
    const page = await context.newPage();
    await page.goto(url + shot.hash);
    await page.waitForSelector(".react-flow__node, .compare-stage, .screens-cell", { timeout: 60_000 });
    await page.waitForTimeout(4000);
    if (shot.click) {
      await page.getByRole("button", { name: shot.click }).click();
      await page.mouse.move(400, shot.viewport.height - 30);
      await page.waitForTimeout(1500);
    }
    if (shot.select) {
      // Selecting a screen opens the Inspector without moving the fitted camera.
      await page.locator(`.screen-screenshot-target[title="${shot.select}"]`).click();
      await page.mouse.move(400, shot.viewport.height - 30);
      await page.waitForTimeout(1500);
    }
    if (shot.hash.startsWith("#/compare/") && !page.url().includes(shot.hash)) {
      throw new Error(`Compare key ${args.compare} is not a screen of this report (the Viewer went to ${page.url()}); pass --compare <key> from a #/compare/<key> URL.`);
    }
    const path = `${out}${shot.file}-${theme}.png`;
    await page.screenshot({ path });
    console.log(path);
    await context.close();
  }
  for (const theme of args.pr ? ["light", "dark"] : []) {
    // Signed-out github.com follows prefers-color-scheme.
    const context = await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await page.goto(args.pr, { waitUntil: "domcontentloaded" });
    const comment = page.locator(".timeline-comment").filter({ has: page.locator("h3", { hasText: /Explore review/ }) }).first();
    await comment.waitFor({ timeout: 30_000 });
    await comment.scrollIntoViewIfNeeded();
    // The comment's pointer toward the avatar would show as a stray tick above the card.
    await page.addStyleTag({ content: ".timeline-comment::before, .timeline-comment::after { display: none !important; }" });
    await page.waitForTimeout(1000);
    // Cut after the list of changed screens: the launch timings, validation, and footer below it are detail.
    const clip = await comment.evaluate((card) => {
      const box = card.getBoundingClientRect();
      const after = [...card.querySelectorAll("p")].find(p => /Launch:/.test(p.textContent ?? ""));
      const bottom = after ? after.getBoundingClientRect().top : box.bottom;
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
  await server.close?.();
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
