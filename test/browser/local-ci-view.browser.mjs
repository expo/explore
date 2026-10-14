import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { chromium, expect } from "@playwright/test";
import { standaloneReportFixture } from "../helpers/standalone-report-fixture.mjs";
import { startReportViewer, VIEWER_ROOT } from "../ci/lib/report-viewer.mjs";

async function reportZip(t) {
  const input = await standaloneReportFixture();
  t.after(() => rm(input.directory, { recursive: true, force: true }));
  const [{ sha256 }] = input.assets;
  const report = { kind: "explore.report", review: input.publicReview, onboarding: input.onboarding,
    assets: [{ sha256, path: `assets/${sha256}.png` }] };
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  await writer.add("review.json", new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(report))), { level: 6 });
  await writer.add(`assets/${sha256}.png`, new Uint8ArrayReader(input.bytes), { level: 0 });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

test("ci:local:view reopens the report after a Viewer source edit reloads the page", { timeout: 60_000 }, async t => {
  // Its own cache: Vite's default is the node_modules/.vite that checkouts sharing node_modules share.
  const cacheDir = await mkdtemp(join(tmpdir(), "explore-local-ci-view-"));
  let server;
  t.after(async () => {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  let url;
  ({ server, url } = await startReportViewer({ bytes: await reportZip(t), port: 'free', cacheDir }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const reportOpen = async () => {
    // The Viewer replaces the loading and drop shell once the report has opened.
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".report-loading-shell")).toHaveCount(0);
  };
  await page.goto(url);
  await reportOpen();
  assert.ok((await readdir(cacheDir)).length, "Vite optimized the Viewer's dependencies into this test's cache");

  // An edit to a module report-source.ts imports: Vite invalidates report-source.ts, reloads the
  // page, and the app now imports it with a ?t= timestamp. This server's watcher alone sees the
  // event, so no file changes and no other test's Viewer reloads.
  const reloaded = page.waitForEvent("load");
  server.watcher.emit("change", join(VIEWER_ROOT, "src/utils/artifact-report.ts"));
  await reloaded;
  await reportOpen();
  const loaded = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname
    + new URL(entry.name).search).filter(name => name.startsWith("/src/utils/report-source.ts")));
  assert.equal(loaded.length, 1, `One report-source instance, not ${loaded.join(", ")}`);
  assert.match(loaded[0], /\?t=\d+$/);

  await page.reload();
  await reportOpen();
  assert.deepEqual(errors, []);
});
