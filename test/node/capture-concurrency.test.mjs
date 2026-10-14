import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSidesConcurrently } from "../../dist/ci/pipeline.js";
import { captureArtifactCacheMayMatch, writeCaptureArtifactCache } from "../../dist/ci/artifact-cache.js";
import { runCiMapOnWorker } from "../../dist/ci/capture-worker.js";

const plan = { headCaptureSurfaceIds: ["a"], baseCaptureSurfaceIds: ["a"] };

test("head and base capture concurrently only when nothing ties the sides together", () => {
  assert.equal(captureSidesConcurrently({ plan, agent: false, injectedRunner: false, baselineMayExist: false }), true);
  assert.equal(captureSidesConcurrently({ plan, agent: true, injectedRunner: false, baselineMayExist: false }), false);
  assert.equal(captureSidesConcurrently({ plan, agent: false, injectedRunner: true, baselineMayExist: false }), false);
  assert.equal(captureSidesConcurrently({ plan, agent: false, injectedRunner: false, baselineMayExist: true }), false);
  assert.equal(captureSidesConcurrently({ plan: { ...plan, baseCaptureSurfaceIds: [] }, agent: false, injectedRunner: false, baselineMayExist: false }), false);
  assert.equal(captureSidesConcurrently({ plan: { ...plan, headCaptureSurfaceIds: [] }, agent: false, injectedRunner: false, baselineMayExist: false }), false);
});

test("a cache directory is a plausible baseline only for its own commit and recipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "explore-cache-peek-"));
  try {
    const recipe = { inventory: [{ id: "a" }], profile: "explore:com.example.app", config: "{}", toolsCommit: "@expo/explore@0.0.0" };
    assert.equal(await captureArtifactCacheMayMatch({ ...recipe, sourceDirectory: directory, commit: "c".repeat(40) }), false);
    assert.equal(await captureArtifactCacheMayMatch({ ...recipe, commit: "c".repeat(40) }), false);
    // An incomplete capture never writes metadata, so a directory without evidence is a miss.
    assert.equal(await writeCaptureArtifactCache(directory, recipe), false);
    const { createHash } = await import("node:crypto");
    const { canonicalJson } = await import("../../dist/shared/canonical-json.js");
    const key = createHash("sha256").update(canonicalJson({ inventory: recipe.inventory, profile: recipe.profile, config: {}, toolsCommit: recipe.toolsCommit })).digest("hex");
    await writeFile(join(directory, "cache-metadata.json"), JSON.stringify({ contract: "explore.capture-cache", recipe: key, commit: "c".repeat(40), files: [] }));
    assert.equal(await captureArtifactCacheMayMatch({ ...recipe, sourceDirectory: directory, commit: "c".repeat(40) }), true);
    assert.equal(await captureArtifactCacheMayMatch({ ...recipe, sourceDirectory: directory, commit: "d".repeat(40) }), false);
    assert.equal(await captureArtifactCacheMayMatch({ ...recipe, toolsCommit: "other", sourceDirectory: directory, commit: "c".repeat(40) }), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a capture worker relays its side's failure as a CiError with the progress it reported", async () => {
  const directory = await mkdtemp(join(tmpdir(), "explore-worker-"));
  try {
    const messages = [];
    await assert.rejects(runCiMapOnWorker({ project: join(directory, "missing"), mapDirectory: join(directory, "map"), outputDirectory: join(directory, "out"),
      name: "App", buildId: "b", buildVersion: "v", gitCommit: "a".repeat(40), bundleId: "com.example.app", device: "iPhone 17", easProfile: "explore",
      expoToken: "secret-token", planPath: join(directory, "plan.json"), side: "head", maxScreens: 1, maxActions: 1, maxDurationMinutes: 1,
      forceFreshBuild: false, confirmExternalRun: true, confirmTrustedSource: true, easCommand: "eas", repackCommand: "repack", agentDeviceCommand: "agent-device",
      environment: { PATH: process.env.PATH ?? "" } }, message => messages.push(message)),
      error => error.name === "CiError" && error.code === "CAPTURE_PREFLIGHT_FAILED" && !JSON.stringify(error).includes("secret-token"));
    assert.deepEqual(messages, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
