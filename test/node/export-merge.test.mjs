import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mergeSchemeOutcomes } from "../../dist/capture/appearance.js";
import { mergeCaptureExports } from "../../dist/ci/export-merge.js";
import { captureSideInSessions } from "../../dist/ci/pipeline.js";
import { CiError } from "../../dist/shared/ci-errors.js";

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
  await writeFile(join(root, "bundle.json"), JSON.stringify({ contract: "explore.bundle", side: "head", runtimeProfile: { colorSchemes: "light,dark" },
    selectedSurfaceIds: [...new Set(Object.keys(outcomes).map(id => id.replace(/@(light|dark)$/, "")))], images, outcomes, ...(launch ? { launch } : {}) }));
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

// brentvatne/euxy's main baseline run 39506374824: the light session captured every route, then the dark session's install failed.
const DARK_FAILURE = { code: "CAPTURE_SESSION_FAILED", stage: "session", message: "install: argent run list-devices failed: GET /tools failed: 404 Not Found",
  nextAction: "Rerun the capture on a new session.", retryable: true };
const failedDark = { status: "failed", attempts: 0, landing: "unverified", reason: DARK_FAILURE.message, error: DARK_FAILURE };

test("a dark session that left no export records its failure as every route's own dark outcome, and the run is partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-merge-"));
  const lost = { status: "failed", landing: "unverified", attempts: 3, reason: "The route observer never answered." };
  const primary = await writeExport(join(root, "head-export"), { screens: ["home"], images: { home: { path: "artifacts/home.png" } },
    outcomes: { home: { status: "captured", landing: "verified", attempts: 1 }, settings: lost }, diagnostics: "" });
  const mapPath = join(primary, "screen-map.json");
  await writeFile(mapPath, JSON.stringify({ ...JSON.parse(await readFile(mapPath, "utf8")), run: { id: "run", status: "complete", environment: { colorSchemes: ["light", "dark"] } } }));
  await mergeCaptureExports(primary, [{ scheme: "dark", error: DARK_FAILURE }]);
  const bundle = JSON.parse(await readFile(join(primary, "bundle.json"), "utf8"));
  // A route the light session lost keeps its own reason, and its dark frame carries the dark session's, not the light one's.
  assert.deepEqual(bundle.outcomes, { home: { status: "captured", landing: "verified", attempts: 1 }, settings: lost, "home@dark": failedDark, "settings@dark": failedDark });
  assert.deepEqual(bundle.sessionFailures, [{ scheme: "dark", error: DARK_FAILURE }]);
  assert.deepEqual(Object.keys(bundle.images), ["home"]);
  const map = JSON.parse(await readFile(mapPath, "utf8"));
  assert.equal(map.run.status, "partial");
  assert.equal(map.run.stopReason, `The dark session failed (CAPTURE_SESSION_FAILED): ${DARK_FAILURE.message}.`);
});

test("a dark session that failed beside a primary that renders no dark has no frames to fail, and stays on the bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-merge-"));
  const primary = await writeExport(join(root, "head-export"), { screens: ["home"], images: { home: { path: "artifacts/home.png" } },
    outcomes: { home: { status: "captured", landing: "verified", attempts: 1 } }, diagnostics: "" });
  const bundlePath = join(primary, "bundle.json");
  // The light session could not switch appearance (Argent without appearance.set): it captured light alone.
  await writeFile(bundlePath, JSON.stringify({ ...JSON.parse(await readFile(bundlePath, "utf8")), runtimeProfile: { colorScheme: "light" } }));
  await mergeCaptureExports(primary, [{ scheme: "dark", error: DARK_FAILURE }]);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.deepEqual(Object.keys(bundle.outcomes), ["home"]);
  assert.deepEqual(bundle.sessionFailures, [{ scheme: "dark", error: DARK_FAILURE }], "the comment still names the failed session");
  assert.equal(JSON.parse(await readFile(join(primary, "screen-map.json"), "utf8")).run.status, "partial");
});

/** The side's sessions as captureSideInSessions runs them: the light one exports, the dark one does what `dark` says. */
async function sideInSessions({ light, dark, leftSessionFile = false, environment = {}, signal } = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-sessions-"));
  const progress = [];
  const mapOptions = { side: "head", outputDirectory: join(root, "head-export"), mapDirectory: join(root, "head-map"), buildShare: join(root, "builds"),
    sessionStatePath: join(root, "head-session"), expoToken: "expo-secret-token", environment };
  const runPass = async options => {
    const scheme = options.appearancePass.capture[0];
    const outcome = scheme === "light" ? light : dark;
    // A capture removes its session file only once its session is confirmed stopped.
    if (scheme === "dark" && leftSessionFile) await writeFile(options.sessionStatePath, "01a15b61-4df9\n");
    if (outcome instanceof Error) throw outcome;
    const id = scheme === "light" ? "home" : "home@dark";
    await writeExport(options.outputDirectory, { screens: [id], images: { [id]: { path: `artifacts/${id}.png` } },
      outcomes: { [id]: { status: "captured", landing: "verified", attempts: 1 } }, diagnostics: "" });
    return { runStatus: "complete", outputDirectory: options.outputDirectory, scheme };
  };
  const run = () => captureSideInSessions(mapOptions, [["light"], ["dark"]], line => progress.push(line), signal, true, runPass);
  return { root, progress, run, bundle: async () => JSON.parse(await readFile(join(mapOptions.outputDirectory, "bundle.json"), "utf8")) };
}

test("a side keeps its light captures when only its dark session fails, and the report marks every dark frame failed", async () => {
  const side = await sideInSessions({ dark: new CiError({ ...DARK_FAILURE, message: `${DARK_FAILURE.message} (tokens expo-secret-token, gh-secret)` }),
    environment: { GITHUB_TOKEN: "gh-secret", PATH: "/usr/bin" } });
  const result = await side.run();
  assert.equal(result.scheme, "light", "the primary session's result");
  assert.equal(result.runStatus, "partial");
  const bundle = await side.bundle();
  assert.deepEqual(Object.keys(bundle.images), ["home"]);
  assert.equal(bundle.outcomes["home@dark"].status, "failed");
  assert.equal(bundle.outcomes["home@dark"].error.code, "CAPTURE_SESSION_FAILED");
  assert.doesNotMatch(JSON.stringify(bundle), /expo-secret-token|gh-secret/, "the session's error is stored without any secret the environment holds");
  assert.ok(side.progress.some(line => /^head: the dark session failed \(CAPTURE_SESSION_FAILED: install: argent run list-devices failed/.test(line)
    && line.endsWith("keeping the light captures, and the report marks every dark frame failed")), side.progress.join("\n"));
});

test("a side whose light session fails still fails, whatever the dark session did", async () => {
  const light = new CiError({ ...DARK_FAILURE, code: "CAPTURE_INSTALL_FAILED" });
  await assert.rejects((await sideInSessions({ light })).run(), { code: "CAPTURE_INSTALL_FAILED" });
  await assert.rejects((await sideInSessions({ light, dark: new CiError({ ...DARK_FAILURE }) })).run(), { code: "CAPTURE_INSTALL_FAILED" });
});

test("a dark session not proven stopped fails the side, so a running session is never hidden behind a partial report", async () => {
  const cleanup = new CiError({ code: "SESSION_CLEANUP_FAILED", stage: "cleanup", message: "The exact EAS session could not be confirmed stopped.",
    nextAction: "Stop EAS Simulator session 01a15b61 and verify its status.", retryable: false });
  await assert.rejects((await sideInSessions({ dark: cleanup })).run(), { code: "SESSION_CLEANUP_FAILED" });
  await assert.rejects((await sideInSessions({ light: new CiError({ ...DARK_FAILURE, code: "CAPTURE_INSTALL_FAILED" }), dark: cleanup })).run(), { code: "SESSION_CLEANUP_FAILED" },
    "the leaked session is reported before the light session's own failure");
  const handoff = new CiError({ code: "SESSION_HANDOFF_UNVERIFIED", stage: "session", message: "EAS did not provide an exact verifiable simulator session.",
    nextAction: "Verify a session's exact ID and ownership before cleanup." });
  await assert.rejects((await sideInSessions({ dark: handoff })).run(), { code: "SESSION_HANDOFF_UNVERIFIED" });
  const unverified = new CiError({ code: "SIMULATOR_START_FAILED", stage: "session", message: "EAS simulator:start failed before a session identity could be verified.",
    nextAction: "Verify a session's exact ID and ownership before cleanup.", details: { allocation: "unknown" } });
  await assert.rejects((await sideInSessions({ dark: unverified })).run(), { code: "SIMULATOR_START_FAILED" });
  // A worker that died before its capture's own cleanup ran: it exited, or failed with a raw error.
  const exited = new CiError({ code: "CAPTURE_WORKER_EXITED", stage: "capture-head", message: "The capture worker for the head side exited with code 1 before it reported a result.",
    nextAction: "Inspect the job log for the worker's failure, then rerun Explore." });
  await assert.rejects((await sideInSessions({ dark: exited })).run(), { code: "CAPTURE_WORKER_EXITED" });
  await assert.rejects((await sideInSessions({ dark: new Error("Worker terminated due to reaching memory limit: JS heap out of memory") })).run(), /memory limit/);
  // Any failure that left the session's file behind: the session was never confirmed stopped.
  await assert.rejects((await sideInSessions({ dark: new CiError({ ...DARK_FAILURE }), leftSessionFile: true })).run(), { code: "CAPTURE_SESSION_FAILED" });
});

test("a dark session whose checkout changed, whose evidence failed its checks, or whose review was stopped fails the side", async () => {
  for (const code of ["SOURCE_CHECKOUT_CHANGED", "CHECKOUT_MODIFIED", "CAPTURE_INCOMPLETE", "CAPTURE_IMAGE_BINDING_INVALID", "EXPLORE_FAILED"]) {
    await assert.rejects((await sideInSessions({ dark: new CiError({ ...DARK_FAILURE, code }) })).run(), { code }, code);
  }
  const stop = new AbortController(); stop.abort(new CiError({ code: "LOCAL_REVIEW_INTERRUPTED", stage: "capture", message: "Interrupted.", nextAction: "Rerun." }));
  await assert.rejects((await sideInSessions({ dark: new CiError({ ...DARK_FAILURE }), signal: stop.signal })).run(), { code: "CAPTURE_SESSION_FAILED" });
});
