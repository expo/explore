import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mergeSchemeOutcomes } from "../../dist/capture/appearance.js";
import { mergeCaptureExports } from "../../dist/ci/export-merge.js";

async function writeExport(root, { screens, images, outcomes, launch, diagnostics }) {
  await mkdir(join(root, "artifacts"), { recursive: true });
  await mkdir(join(root, "capture-diagnostics"), { recursive: true });
  const artifacts = [];
  for (const screen of screens) {
    const path = `artifacts/${screen}.png`;
    await writeFile(join(root, path), screen);
    artifacts.push({ id: `artifact-${screen}`, path, sha256: screen, bytes: screen.length, mimeType: "image/png" });
  }
  const map = { contract: "explore.map", revision: 1, run: { id: "run", environment: { colorSchemes: ["light", "dark"] } }, artifacts,
    screens: screens.map(id => ({ id, colorScheme: id.endsWith("@dark") ? "dark" : "light" })), variants: [], observations: screens.map(id => ({ screenId: id })),
    elements: [], actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [] };
  await writeFile(join(root, "screen-map.json"), JSON.stringify(map));
  await writeFile(join(root, "bundle.json"), JSON.stringify({ contract: "explore.bundle", side: "head", runtimeProfile: { colorSchemes: "light,dark" }, images, outcomes, ...(launch ? { launch } : {}) }));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ contract: "explore.map", runId: "run", revision: 1, files: artifacts.map(({ id: _id, ...file }) => file) }));
  await writeFile(join(root, "capture-diagnostics", "controller-timing.jsonl"), diagnostics);
  return root;
}

test("a dark session's export folds into the light session's: @dark frames, outcomes, launch, map records, files and diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-merge-"));
  const primary = await writeExport(join(root, "head-export"), { screens: ["home", "settings"],
    images: { home: { path: "artifacts/home.png" }, settings: { path: "artifacts/settings.png" } },
    outcomes: { home: { status: "captured", landing: "verified", attempts: 1 }, settings: { status: "captured", landing: "verified", attempts: 1 } },
    launch: { light: { splash: "l" } }, diagnostics: "{\"pass\":\"light\"}\n" });
  const dark = await writeExport(join(root, "head-export-dark"), { screens: ["home@dark", "settings@dark"],
    images: { "home@dark": { path: "artifacts/home@dark.png" }, "settings@dark": { path: "artifacts/settings@dark.png" } },
    // A secondary-only run reports a route it lost under the route id, as a run's dark pass does before the passes merge.
    outcomes: { "home@dark": { status: "captured", landing: "verified", attempts: 2 }, settings: { status: "failed", landing: "unverified", attempts: 3 } },
    launch: { dark: { splash: "d" } }, diagnostics: "{\"pass\":\"dark\"}\n" });
  await mergeCaptureExports(primary, [{ directory: dark, scheme: "dark" }]);
  const bundle = JSON.parse(await readFile(join(primary, "bundle.json"), "utf8"));
  assert.deepEqual(Object.keys(bundle.images).sort(), ["home", "home@dark", "settings", "settings@dark"]);
  // As in one run: a dark frame verified beside its light one needs no record of its own; a lost one is the scheme's own outcome.
  assert.deepEqual(bundle.outcomes, { home: { status: "captured", landing: "verified", attempts: 2 }, settings: { status: "captured", landing: "verified", attempts: 3 },
    "settings@dark": { status: "failed", landing: "unverified", attempts: 3 } });
  assert.deepEqual(bundle.launch, { light: { splash: "l" }, dark: { splash: "d" } });
  const map = JSON.parse(await readFile(join(primary, "screen-map.json"), "utf8"));
  assert.deepEqual(map.screens.map(screen => screen.id), ["home", "settings", "home@dark", "settings@dark"]);
  assert.equal(map.observations.length, 4);
  assert.equal(map.artifacts.length, 4);
  const manifest = JSON.parse(await readFile(join(primary, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map(file => file.path).sort(), ["artifacts/home.png", "artifacts/home@dark.png", "artifacts/settings.png", "artifacts/settings@dark.png"]);
  assert.equal(await readFile(join(primary, "artifacts/home@dark.png"), "utf8"), "home@dark");
  assert.equal(await readFile(join(primary, "capture-diagnostics/controller-timing.jsonl"), "utf8"), "{\"pass\":\"light\"}\n{\"pass\":\"dark\"}\n");
  // Merging is idempotent for records already present.
  await mergeCaptureExports(primary, [{ directory: dark, scheme: "dark" }]);
  assert.equal(JSON.parse(await readFile(join(primary, "screen-map.json"), "utf8")).screens.length, 4);
});

test("merged passes recombine as one run's: an unattributed dark frame beside a verified light one is kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-merge-"));
  const light = { status: "captured", landing: "verified", attempts: 1 };
  const wrong = { status: "captured", landing: "unverified", attempts: 2, screenshotSha256: "x", observed: { reason: "landing-mismatch", route: "/login", attempts: 2 } };
  const primary = await writeExport(join(root, "head-export"), { screens: ["settings"], images: { settings: { path: "artifacts/settings.png" } },
    outcomes: { settings: light }, diagnostics: "" });
  const dark = await writeExport(join(root, "head-export-dark"), { screens: ["settings@dark"], images: { "settings@dark": { path: "artifacts/settings@dark.png" } },
    outcomes: { "settings@dark": wrong }, diagnostics: "" });
  await mergeCaptureExports(primary, [{ directory: dark, scheme: "dark" }]);
  const bundle = JSON.parse(await readFile(join(primary, "bundle.json"), "utf8"));
  assert.deepEqual(bundle.outcomes, mergeSchemeOutcomes([{ settings: light }, { settings: wrong }], ["light", "dark"]));
  assert.deepEqual(bundle.outcomes["settings@dark"], wrong);
});

test("a dark session that could not show dark (Argent without appearance.set) adds nothing, and an open gap leaves the run partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-merge-"));
  const primary = await writeExport(join(root, "head-export"), { screens: ["home"], images: { home: { path: "artifacts/home.png" } },
    outcomes: { home: { status: "captured", landing: "verified", attempts: 1 } }, diagnostics: "" });
  const bundlePath = join(primary, "bundle.json"), mapPath = join(primary, "screen-map.json");
  // The primary session could not switch either: it captured light only.
  await writeFile(bundlePath, JSON.stringify({ ...JSON.parse(await readFile(bundlePath, "utf8")), runtimeProfile: { colorScheme: "light" } }));
  await writeFile(mapPath, JSON.stringify({ ...JSON.parse(await readFile(mapPath, "utf8")), run: { id: "run", status: "complete", environment: {} } }));
  const narrowed = await writeExport(join(root, "head-export-dark"), { screens: [], images: {}, outcomes: {}, diagnostics: "" });
  const narrowedBundle = join(narrowed, "bundle.json");
  await writeFile(narrowedBundle, JSON.stringify({ ...JSON.parse(await readFile(narrowedBundle, "utf8")), runtimeProfile: { colorScheme: "light" } }));
  await mergeCaptureExports(primary, [{ directory: narrowed, scheme: "dark" }]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(bundlePath, "utf8")).outcomes), ["home"]);
  assert.equal(JSON.parse(await readFile(mapPath, "utf8")).run.status, "complete");

  const gapped = await writeExport(join(root, "other-export-dark"), { screens: ["home@dark"], images: { "home@dark": { path: "artifacts/home@dark.png" } },
    outcomes: { "home@dark": { status: "captured", landing: "verified", attempts: 1 } }, diagnostics: "" });
  const gappedMap = join(gapped, "screen-map.json");
  await writeFile(gappedMap, JSON.stringify({ ...JSON.parse(await readFile(gappedMap, "utf8")), gaps: [{ id: "gap-1", status: "open" }] }));
  await writeFile(bundlePath, JSON.stringify({ ...JSON.parse(await readFile(bundlePath, "utf8")), runtimeProfile: { colorSchemes: "light,dark" } }));
  await mergeCaptureExports(primary, [{ directory: gapped, scheme: "dark" }]);
  assert.equal(JSON.parse(await readFile(mapPath, "utf8")).run.status, "partial", "a complete run has no open gaps");
});
