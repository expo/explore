import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_ICON_FILE, adaptiveIconBackground, appIconSource, downscaleFrame, isWebp, loadAppIcon, loadCachedAppIcon, storeAppIcon, webpSize } from "../../dist/capture/app-icon.js";
import { assertPublicReview } from "../../dist/contracts/review-validation.js";

const { PNG } = createRequire(import.meta.url)("pngjs");
const { tsImport } = await import("tsx/esm/api");
const { publicReviewToWorkspace } = await tsImport("../../viewer/src/public/public-workspace.ts", import.meta.url);
const walletIcon = new URL("../ci/apps/wallet/assets/icon.png", import.meta.url);

function frame(width, height, pixel) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set(pixel(index % width, Math.floor(index / width)), index * 4);
  return { width, height, data };
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "explore-app-icon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets", "icon.png"), await readFile(walletIcon));
  return root;
}

test("the iOS PNG icon wins over the shared icon, and only PNG paths count", () => {
  assert.equal(appIconSource({ icon: "./assets/icon.png", ios: { icon: "./assets/ios.png" } }), "./assets/ios.png");
  assert.equal(appIconSource({ icon: "./assets/icon.png", ios: { icon: "./assets/app.icon" } }), "./assets/icon.png");
  assert.equal(appIconSource({ icon: "./assets/icon.jpg" }), undefined);
  assert.equal(appIconSource({ ios: { icon: { light: "./a.png" } } }), undefined);
  assert.equal(appIconSource({ icon: "./assets/icon.png", ios: { icon: "./assets/ios.png" }, android: { icon: "./assets/android.png" } }, "android"), "./assets/android.png");
  assert.equal(appIconSource({ icon: "./assets/icon.png", android: { adaptiveIcon: { foregroundImage: "./assets/fg.png" } } }, "android"), "./assets/fg.png");
  assert.equal(appIconSource({ icon: "./assets/icon.png", ios: { icon: "./assets/ios.png" } }, "android"), "./assets/icon.png");
  assert.equal(appIconSource({}), undefined);
});

test("downscaling averages blocks and weights colour by alpha", () => {
  // Left half opaque red, right half transparent green: the green must not tint the result.
  const source = frame(256, 256, x => x < 128 ? [255, 0, 0, 255] : [0, 255, 0, 0]);
  const small = downscaleFrame(source, 128);
  assert.deepEqual([small.width, small.height], [128, 128]);
  assert.deepEqual([...small.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...small.data.subarray(127 * 4, 128 * 4)], [0, 0, 0, 0]);
  const wide = downscaleFrame(frame(512, 256, () => [10, 20, 30, 255]), 128);
  assert.deepEqual([wide.width, wide.height], [128, 64]);
  assert.deepEqual([...wide.data.subarray(0, 4)], [10, 20, 30, 255]);
  const tiny = frame(32, 32, () => [1, 2, 3, 4]);
  assert.equal(downscaleFrame(tiny, 128), tiny);
});

test("the Wallet icon is read from the app config and shrunk to at most 128 pixels", async t => {
  const root = await project(t);
  const bytes = await loadAppIcon(root, { icon: "./assets/icon.png" });
  assert.ok(bytes);
  const decoded = PNG.sync.read(bytes);
  assert.ok(decoded.width <= 128 && decoded.height <= 128);
  const output = await mkdtemp(join(tmpdir(), "explore-app-icon-out-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const stored = await storeAppIcon(output, bytes);
  assert.deepEqual(stored, { path: APP_ICON_FILE, sha256: createHash("sha256").update(bytes).digest("hex"),
    width: decoded.width, height: decoded.height });
  assert.deepEqual(await loadCachedAppIcon(output, stored), bytes);
  assert.equal(await loadCachedAppIcon(output, { ...stored, sha256: "0".repeat(64) }), undefined);
});

test("an icon outside the project, missing, too large or not a PNG is skipped, not an error", async t => {
  const root = await project(t);
  const outside = await mkdtemp(join(tmpdir(), "explore-app-icon-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "icon.png"), await readFile(walletIcon));
  await symlink(join(outside, "icon.png"), join(root, "assets", "linked.png"));
  await writeFile(join(root, "assets", "fake.png"), "not a png");
  await writeFile(join(root, "assets", "huge.png"), Buffer.alloc(3 * 1024 * 1024));
  for (const icon of [join(outside, "icon.png"), "../icon.png", "./assets/linked.png", "./assets/missing.png",
    "./assets/fake.png", "./assets/huge.png"]) {
    assert.equal(await loadAppIcon(root, { icon }), undefined, icon);
  }
});

function review(appIcon) {
  const baseSha = "a".repeat(40), headSha = "b".repeat(40), timestamp = "2026-09-01T00:00:00Z";
  return {
    contract: "explore.review", mode: "all", createdAt: timestamp, runId: "1", runAttempt: "1",
    pullRequest: { base: { sha: baseSha }, head: { sha: headSha } },
    runtime: { projectId: "project", buildId: "head-build", gitCommit: headSha, appName: "Wallet", ...(appIcon ? { appIcon } : {}) },
    surfaces: [],
  };
}

const icon = { url: `https://embedded.expo-explore.invalid/${"e".repeat(64)}.png`, sha256: "e".repeat(64), width: 128, height: 128 };

test("a review accepts a small HTTPS app icon and keeps older reports without one valid", () => {
  assert.doesNotThrow(() => assertPublicReview(review()));
  assert.doesNotThrow(() => assertPublicReview(review(icon)));
  for (const invalid of [
    { ...icon, url: "http://example.com/icon.png" },
    { ...icon, url: "https://user:pass@example.com/icon.png" },
    { ...icon, sha256: "nope" },
    { ...icon, width: 129 },
    { ...icon, height: 0 },
    { ...icon, extra: true },
  ]) assert.throws(() => assertPublicReview(review(invalid)), /app icon/i);
});

test("the Viewer puts the head icon on the current map only", () => {
  const workspace = publicReviewToWorkspace(review(icon));
  const head = workspace.builds[workspace.catalog.currentBuildId];
  const base = workspace.builds[workspace.catalog.defaultBaselineBuildId];
  assert.equal(head.map.run.appIcon.sha256, icon.sha256);
  assert.equal(head.map.run.appIcon.publicUrl, icon.url);
  assert.equal(base.map.run.appIcon, undefined);
  assert.equal(publicReviewToWorkspace(review()).builds[workspace.catalog.currentBuildId].map.run.appIcon, undefined);
});

test("a WebP's canvas size is read from its VP8X, VP8L or VP8 header", () => {
  const webp = (chunk, payload) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(chunk), Buffer.alloc(4), payload, Buffer.alloc(16)]);
  const vp8x = Buffer.alloc(10); vp8x.writeUIntLE(191, 4, 3); vp8x.writeUIntLE(95, 7, 3);
  assert.deepEqual(webpSize(webp("VP8X", vp8x)), { width: 192, height: 96 });
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE((191) | (95 << 14), 1);
  assert.deepEqual(webpSize(webp("VP8L", vp8l)), { width: 192, height: 96 });
  const vp8 = Buffer.alloc(10); vp8.set([0x9d, 0x01, 0x2a], 3); vp8.writeUInt16LE(192, 6); vp8.writeUInt16LE(96, 8);
  assert.deepEqual(webpSize(webp("VP8 ", vp8)), { width: 192, height: 96 });
  assert.equal(webpSize(webp("ALPH", Buffer.alloc(10))), undefined);
  assert.equal(isWebp(Buffer.from("\x89PNG\r\n\x1a\n".padEnd(40, "\0"), "latin1")), false);
  assert.equal(webpSize(Buffer.alloc(8)), undefined);
});

test("an Android adaptive foreground is drawn as the launcher shows it: cropped to its safe zone, on its background colour", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-adaptive-icon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  // 108 units: transparent margin, a white 36-unit square in the middle.
  const foreground = frame(108, 108, (x, y) => (x >= 36 && x < 72 && y >= 36 && y < 72 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
  await writeFile(join(root, "assets", "fg.png"), PNG.sync.write(foreground));
  const config = { android: { adaptiveIcon: { foregroundImage: "./assets/fg.png", backgroundColor: "#08080A" } } };
  assert.deepEqual(adaptiveIconBackground(config), [8, 8, 10]);
  assert.equal(adaptiveIconBackground({ android: { icon: "./assets/a.png", adaptiveIcon: config.android.adaptiveIcon } }), undefined, "android.icon is a whole icon already");
  assert.equal(adaptiveIconBackground({ android: { adaptiveIcon: { foregroundImage: "./assets/fg.png" } } }), undefined, "no colour, no composite");

  const decoded = PNG.sync.read(await loadAppIcon(root, config, "android"));
  assert.equal(decoded.width, 72);
  const pixel = (x, y) => [...decoded.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 0), [8, 8, 10, 255], "the corner is the background, opaque");
  assert.deepEqual(pixel(36, 36), [255, 255, 255, 255], "the glyph sits in the middle, now half the icon wide");
});
