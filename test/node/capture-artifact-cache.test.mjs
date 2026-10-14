import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { tsImport } from "tsx/esm/api";
import { AGENT_DEVICE_VERSION, EAS_CLI_VERSION } from "../../dist/capture/run.js";
import { readExportedMap } from "../../dist/review/evidence-assessment.js";
import { ExploreStore, recordObservation } from "../../dist/map/store.js";

const { captureRecipeConfig, restoreCaptureArtifactCache, writeCaptureArtifactCache } = await tsImport("../../src/ci/artifact-cache.ts", import.meta.url);
const { readCaptureBundle } = await tsImport("../../src/review/capture-review.ts", import.meta.url);
const { CAPTURE_OBSERVER_HASH } = await tsImport("../../src/capture/observer.ts", import.meta.url);
const { AGENT_ACCEPTANCE_POLICY } = await tsImport("../../src/contracts/capture.ts", import.meta.url);

const COMMIT = "a".repeat(40);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const RUNTIME = { deviceModel: "iPhone 17", osVersion: "26.0", locale: "en_US", orientation: "portrait", colorScheme: "light" };
const EXECUTION = {
  provider: "eas-simulator", controller: "agent-device", controllerPackageVersion: AGENT_DEVICE_VERSION,
  easCliVersion: EAS_CLI_VERSION, platform: "ios", ...RUNTIME, sessionLifecycle: "stopped",
};
const RECIPE = {
  inventory: ["home", "settings"].map(id => ({
    id, kind: "screen", route: `/${id}`, routeFile: `src/app/${id}.tsx`, sourceFiles: [],
    provider: "expo-router", logicalPath: id, path: `/${id}`, variant: "default",
  })),
  profile: "explore:bundle", config: '{"capture":{"samples":3}}', toolsCommit: "c".repeat(40),
};
const AGENT_RECIPE = { ...RECIPE, config: JSON.stringify({ mode: "agent", agent: { acceptancePolicy: "agent-inspected-frame.v1" } }) };

function acceptedFrames(bundle) {
  return { policy: AGENT_ACCEPTANCE_POLICY, frames: Object.fromEntries(Object.entries(bundle.images).map(([id, image]) => [id, {
    frameId: `inspected-${id}`, imageSha256: image.sha256, capturedAt: image.capturedAt,
  }])) };
}

async function fixture(t, { missingAccessibility = false, partial = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-capture-artifact-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ExploreStore(join(root, "active"));
  const timestamp = new Date().toISOString();
  const map = {
    contract: "expo.explore.local-map.v1", revision: 0,
    run: {
      id: "capture-run", name: "Cache evidence", platform: "ios", controller: "agent-device", status: "draft",
      createdAt: timestamp, updatedAt: timestamp,
      build: { id: "eas-build", gitCommit: COMMIT, source: "eas" },
      environment: { ...RUNTIME, authState: "logged-out" },
      limits: { maxScreens: 20, maxActions: 100, maxDurationMinutes: 60 },
    },
    screens: [], variants: [], observations: [], elements: [], artifacts: [],
    actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [],
  };
  await store.initialize(map, false);
  const screenshotPath = join(root, "sample.png");
  const snapshotPath = join(root, "sample.json");
  await writeFile(screenshotPath, PNG);
  const images = {};
  for (const id of ["home", "settings"]) {
    const snapshotText = JSON.stringify({ nodes: [{ type: "text", label: id }] });
    await writeFile(snapshotPath, snapshotText);
    const result = await recordObservation({
      store, map, title: id, screenId: id, route: `/${id}`, variantName: "default", start: id === "home",
      screenshotPath, snapshotText, ...(missingAccessibility ? {} : { snapshotPath }),
      elements: [{ identifier: `${id}-title`, role: "text", label: id, actions: [], actionable: false, risk: "safe" }],
    });
    await store.write(map, result.preparedArtifacts);
    const image = result.preparedArtifacts.find(entry => entry.artifact.kind === "screenshot").artifact;
    images[id] = {
      path: image.path, sha256: image.sha256, width: image.width, height: image.height,
      capturedAt: result.observation.capturedAt, sourceCommit: COMMIT, buildId: "eas-build",
    };
  }
  map.run.status = partial ? "partial" : "complete";
  if (partial) map.run.stopReason = "Capture interrupted";
  map.run.completedAt = new Date().toISOString();
  await store.write(map);
  const sourceDirectory = join(root, "export");
  await store.exportTo(sourceDirectory, map);
  const bundle = {
    contract: "explore.bundle", side: "head", gitCommit: COMMIT,
    easBuildId: "eas-build", easProjectId: "eas-project", profile: RECIPE.profile, runtimeProfile: RUNTIME,
    selectedSurfaceIds: ["home", "settings"], images,
    outcomes: Object.fromEntries(Object.entries(images).map(([id, image]) => [id, { status: "captured", attempts: 1, landing: "verified", screenshotSha256: image.sha256 }])),
  };
  await writeFile(join(sourceDirectory, "bundle.json"), JSON.stringify(bundle));
  await writeFile(join(sourceDirectory, "execution.json"), JSON.stringify(EXECUTION));
  // Construct actual exported, validated evidence; this fixture cannot pass with stub JSON maps.
  assert.equal((await readExportedMap(sourceDirectory)).observations.length, 2);
  const options = { ...RECIPE, sourceDirectory, directory: join(root, "restored"), commit: COMMIT, selectedIds: ["home", "settings"], runtimeProfile: RUNTIME };
  return { root, sourceDirectory, map, bundle, options };
}

test("restores full accessibility and screenshot evidence with base provenance", async t => {
  const f = await fixture(t);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  assert.equal(await restoreCaptureArtifactCache(f.options), true);
  const restored = await readExportedMap(f.options.directory);
  assert.deepEqual(restored, f.map);
  assert.deepEqual(JSON.parse(await readFile(join(f.options.directory, "execution.json"), "utf8")), EXECUTION);
  for (const artifact of restored.artifacts) {
    assert.deepEqual(await readFile(join(f.options.directory, artifact.path)), await readFile(join(f.sourceDirectory, artifact.path)));
  }
  assert.equal(restored.artifacts.filter(artifact => artifact.kind === "accessibility").length, 2);
  assert.deepEqual(await readCaptureBundle(f.options.directory), { ...f.bundle, side: "base" });
});

test("CI recipes reuse evidence regardless of object construction order", async t => {
  const f = await fixture(t);
  // capture:review adds each side's inventory after the shared recipe fields.
  const { inventory, ...sharedRecipe } = RECIPE;
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, { ...sharedRecipe, inventory }), true);
  assert.equal(await restoreCaptureArtifactCache(f.options), true);
  assert.deepEqual(await readCaptureBundle(f.options.directory), { ...f.bundle, side: "base" });
});

test("nested recipe keys, JSON config keys and runtime profile order do not invalidate evidence", async t => {
  const f = await fixture(t);
  const config = { device: { name: "iPhone", locale: "en_US" }, parameters: { "/profile/[id]": { id: "demo", mode: "preview" } } };
  const first = { ...RECIPE, config: JSON.stringify(config) };
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, first), true);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, inventory: reverse(RECIPE.inventory), config: JSON.stringify(reverse(config)), runtimeProfile: reverse(RUNTIME) }), true);
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, directory: join(f.root,"different-params"), config: JSON.stringify({ ...config, parameters: { "/profile/[id]": { id:"other",mode:"preview" } } }) }), false);
});

test("capture recipes exclude display settings but bind agent instructions and capture inputs", () => {
  const config = { mode: "deterministic", app: { name:"Display name", platform:"ios",bundleId:"example.app",easProfile:"simulator",scheme:"example" },
    navigation: {provider:"auto"},device:{name:"iPhone"},exploration:{scope:"changes"},capture:{maxMinutes:10,maxActions:20},
    setup:[{action:"tap",label:"Next"},{action:"wait",milliseconds:100}],parameters:{"/users/[id]":{id:"demo"}} };
  const key=captureRecipeConfig(config);
  assert.equal(JSON.parse(key).observer, CAPTURE_OBSERVER_HASH);
  assert.match(JSON.parse(key).observer, /^[a-f0-9]{64}$/);
  assert.equal(key,captureRecipeConfig({...config,app:{...config.app,name:"Renamed display"}}));
  const agent = {...config,mode:"agent",agent:{provider:"openai",model:"another-model",instructions:".expo-explore/instructions.md"}};
  assert.notEqual(key,captureRecipeConfig(agent,"a".repeat(64)));
  assert.equal(JSON.parse(captureRecipeConfig(agent,"a".repeat(64))).agent.acceptancePolicy, AGENT_ACCEPTANCE_POLICY);
  assert.equal(JSON.parse(key).agent, undefined, "Deterministic recipes do not acquire an agent policy");
  assert.notEqual(captureRecipeConfig(agent,"a".repeat(64)),captureRecipeConfig(agent,"b".repeat(64)));
  assert.notEqual(key,captureRecipeConfig({...config,setup:[...config.setup].reverse()}));
  assert.notEqual(key,captureRecipeConfig({...config,app:{...config.app,scheme:"other"}}));
  assert.notEqual(key,captureRecipeConfig({...config,parameters:{"/users/[id]":{id:"different"}}}));
});

test("restores a selected subset while retaining the complete runtime map and evidence", async t => {
  const f = await fixture(t);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, selectedIds: ["settings"] }), true);
  const bundle = await readCaptureBundle(f.options.directory);
  assert.deepEqual(bundle.selectedSurfaceIds, ["settings"]);
  assert.deepEqual(Object.keys(bundle.images), ["settings"]);
  assert.deepEqual(await readExportedMap(f.options.directory), f.map);
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, directory: join(f.root, "missing-selection"), selectedIds: ["uncaptured"] }), false);
});

test("agent cache restores only captures matching the established review context", async t => {
  const f = await fixture(t);
  const context = { description: "Review account", parameters: { id: "reviewer" }, requiredLabels: ["account-title"] };
  f.bundle.captureContexts = { home: context, settings: context };
  f.bundle.agentAcceptance = acceptedFrames(f.bundle);
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, AGENT_RECIPE), true);
  const captureContexts = { home: context, settings: { ...context, parameters: { id: "another" } } };
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, ...AGENT_RECIPE, captureContexts }), true);
  const restored = await readCaptureBundle(f.options.directory);
  assert.deepEqual(restored.selectedSurfaceIds, ["home"]);
  assert.deepEqual(restored.captureContexts, { home: context });
  assert.deepEqual(restored.agentAcceptance, { policy: AGENT_ACCEPTANCE_POLICY, frames: { home: f.bundle.agentAcceptance.frames.home } });
  assert.equal(await writeCaptureArtifactCache(f.options.directory, AGENT_RECIPE), true, "Restored subsets retain revalidatable acceptance receipts");
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, ...AGENT_RECIPE, directory: join(f.root, "no-context"), captureContexts: {} }), false);
});

test("agent caches require inspected-frame receipts even when older evidence is otherwise verified", async t => {
  const f = await fixture(t);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, AGENT_RECIPE), false);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true, "Legacy deterministic evidence remains cacheable");
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, captureContexts: {} }), false, "Agent reuse cannot adopt a deterministic cache without receipts");
  f.bundle.agentAcceptance = acceptedFrames(f.bundle);
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, AGENT_RECIPE), true);
  const metadataPath = join(f.sourceDirectory, "cache-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  delete f.bundle.agentAcceptance;
  const bytes = Buffer.from(JSON.stringify(f.bundle));
  await writeFile(join(f.sourceDirectory, "bundle.json"), bytes);
  const { createHash } = await import("node:crypto");
  Object.assign(metadata.files.find(file => file.path === "bundle.json"), {
    bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, ...AGENT_RECIPE }), false, "Even matching checksums cannot promote pre-policy evidence");
});

test("agent acceptance cannot be detached from its exact exported frame or observation", async t => {
  for (const mutation of ["policy", "missing-receipt", "extra-receipt", "duplicate-frame", "hash", "time", "observation-time", "image-bytes"]) {
    await t.test(mutation, async t => {
      const f = await fixture(t);
      f.bundle.agentAcceptance = acceptedFrames(f.bundle);
      const frame = f.bundle.agentAcceptance.frames.home;
      if (mutation === "policy") f.bundle.agentAcceptance.policy = "agent-inspected-frame.v0";
      if (mutation === "missing-receipt") delete f.bundle.agentAcceptance.frames.home;
      if (mutation === "extra-receipt") f.bundle.agentAcceptance.frames.foreign = { ...frame, frameId: "foreign" };
      if (mutation === "duplicate-frame") f.bundle.agentAcceptance.frames.settings.frameId = frame.frameId;
      if (mutation === "hash") frame.imageSha256 = "0".repeat(64);
      if (mutation === "time") frame.capturedAt = "2020-01-01T00:00:00.000Z";
      if (mutation === "observation-time") {
        // Receipt and image agree, but neither may claim a timestamp absent from the actual map.
        frame.capturedAt = "2020-01-01T00:00:00.000Z";
        f.bundle.images.home.capturedAt = frame.capturedAt;
      }
      if (mutation === "image-bytes") await writeFile(join(f.sourceDirectory, f.bundle.images.home.path), "replacement frame");
      await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
      await assert.rejects(readCaptureBundle(f.sourceDirectory));
      assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, AGENT_RECIPE), false);
      assert.equal(await restoreCaptureArtifactCache({ ...f.options, ...AGENT_RECIPE }), false);
    });
  }
});

test("partial agent captures retain receipts only for their successfully accepted frames", async t => {
  const f = await fixture(t, { partial: true });
  delete f.bundle.images.settings;
  f.bundle.outcomes.settings = { status: "failed", attempts: 1, landing: "unverified", reason: "No accepted frame" };
  f.bundle.captureContexts = { home: { description: "Home ready.", parameters: {}, requiredLabels: ["home"] } };
  f.bundle.agentAcceptance = acceptedFrames(f.bundle);
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, AGENT_RECIPE), true);
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, ...AGENT_RECIPE }), true);
  const restored = await readCaptureBundle(f.options.directory);
  assert.deepEqual(restored.selectedSurfaceIds, ["home"]);
  assert.deepEqual(restored.agentAcceptance, f.bundle.agentAcceptance);
});

test("first run and expired or incomplete artifacts are cache misses", async t => {
  for (const absent of [undefined, "missing", "cache-metadata.json", "screen-map.json", "execution.json"]) {
    await t.test(String(absent), async t => {
      const f = await fixture(t);
      if (absent !== "cache-metadata.json") assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
      if (["screen-map.json", "execution.json"].includes(absent)) await rm(join(f.sourceDirectory, absent));
      const sourceDirectory = absent === undefined ? undefined : absent === "missing" ? join(f.root, "expired") : f.sourceDirectory;
      assert.equal(await restoreCaptureArtifactCache({ ...f.options, sourceDirectory }), false);
      await assert.rejects(readFile(join(f.options.directory, "screen-map.json")), { code: "ENOENT" });
    });
  }
});

test("changed commit, inventory, config, tools, profile, or runtime cannot reuse evidence", async t => {
  const f = await fixture(t);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  for (const changed of [
    { commit: "b".repeat(40) }, { toolsCommit: "d".repeat(40) }, { config: "changed" },
    { inventory: RECIPE.inventory.slice(0, 1) },
    { profile: "other-profile" }, { runtimeProfile: { ...RUNTIME, osVersion: "26.1" } },
    { runtimeProfile: null },
  ]) assert.equal(await restoreCaptureArtifactCache({ ...f.options, ...changed }), false, JSON.stringify(changed));
});

test("tampered bytes, missing evidence files, and unlisted files are misses", async t => {
  for (const mutation of ["screenshot", "accessibility", "missing-artifact", "extra-file", "bundle"]) {
    await t.test(mutation, async t => {
      const f = await fixture(t);
      assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
      if (mutation === "missing-artifact") await rm(join(f.sourceDirectory, f.map.artifacts[0].path));
      else if (mutation === "extra-file") await writeFile(join(f.sourceDirectory, "unlisted.txt"), "extra");
      else if (mutation === "bundle") await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify({ ...f.bundle, gitCommit: "b".repeat(40) }));
      else await writeFile(join(f.sourceDirectory, f.map.artifacts.find(artifact => artifact.kind === mutation).path), "corrupt");
      assert.equal(await restoreCaptureArtifactCache(f.options), false);
    });
  }
});

test("partial captures reuse only the screens with complete successful evidence", async t => {
  const f = await fixture(t, { partial: true });
  delete f.bundle.images.settings;
  f.bundle.outcomes.settings = { status: "failed", attempts: 1, landing: "unverified", reason: "Interrupted before capture" };
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  assert.equal(await restoreCaptureArtifactCache(f.options), true);
  const restored = await readCaptureBundle(f.options.directory);
  assert.deepEqual(restored.selectedSurfaceIds, ["home"]);
  assert.deepEqual(Object.keys(restored.images), ["home"]);
  assert.deepEqual(Object.keys(restored.outcomes), ["home"]);
  assert.equal(restored.outcomes.home.status, "captured");
  assert.deepEqual(await readExportedMap(f.options.directory), f.map);
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, directory: join(f.root, "failed-only"), selectedIds: ["settings"] }), false);
});

test("partial caches retain verified targets without restoring captured but unverified screenshots", async t => {
  const f = await fixture(t, { partial: true });
  f.bundle.outcomes.settings.landing = "unverified";
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  assert.equal(await restoreCaptureArtifactCache(f.options), true);
  const restored = await readCaptureBundle(f.options.directory);
  assert.deepEqual(restored.selectedSurfaceIds, ["home"]);
  assert.deepEqual(Object.keys(restored.images), ["home"]);
  assert.deepEqual(Object.keys(restored.outcomes), ["home"]);
  assert.equal(restored.outcomes.home.landing, "verified");
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, directory: join(f.root, "unverified-only"), selectedIds: ["settings"] }), false);
});

test("legacy captured evidence without screenshot hash binding is not reused", async t => {
  const f = await fixture(t);
  delete f.bundle.outcomes.settings.screenshotSha256;
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  assert.equal(await restoreCaptureArtifactCache(f.options), true);
  assert.deepEqual((await readCaptureBundle(f.options.directory)).selectedSurfaceIds, ["home"]);
  assert.equal(await restoreCaptureArtifactCache({ ...f.options, directory: join(f.root, "unbound-only"), selectedIds: ["settings"] }), false);
});

test("a cache containing only unverified screenshots cannot be written or restored", async t => {
  const f = await fixture(t);
  for (const outcome of Object.values(f.bundle.outcomes)) outcome.landing = "unverified";
  await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), false);
  assert.equal(await restoreCaptureArtifactCache(f.options), false);
});

test("old metadata does not turn unverified captures into valid cache hits", async t => {
  const f = await fixture(t);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  const metadataPath = join(f.sourceDirectory, "cache-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  for (const outcome of Object.values(f.bundle.outcomes)) outcome.landing = "unverified";
  const bytes = Buffer.from(JSON.stringify(f.bundle));
  await writeFile(join(f.sourceDirectory, "bundle.json"), bytes);
  // Simulate a correctly checksummed artifact written by the old status-only cache writer.
  const { createHash } = await import("node:crypto");
  const record = metadata.files.find(file => file.path === "bundle.json");
  record.bytes = bytes.length;
  record.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(metadataPath, JSON.stringify(metadata));
  assert.equal(await restoreCaptureArtifactCache(f.options), false);
  await assert.rejects(readFile(join(f.options.directory, "bundle.json")), { code: "ENOENT" });
});

test("inconsistent or incomplete runtime evidence is never offered as a cache entry", async t => {
  for (const condition of ["missingAccessibility", "missing-selected-image", "wrong-source-commit", "execution-mismatch", "missing-bundle-file"]) {
    await t.test(condition, async t => {
      const f = await fixture(t, { [condition]: true });
      if (condition === "missing-selected-image") {
        delete f.bundle.images.settings;
        await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
      } else if (condition === "wrong-source-commit") {
        f.bundle.images.home.sourceCommit = "b".repeat(40);
        await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
      } else if (condition === "execution-mismatch") {
        await writeFile(join(f.sourceDirectory, "execution.json"), JSON.stringify({ ...EXECUTION, osVersion: "26.1" }));
      } else if (condition === "missing-bundle-file") {
        f.bundle.images.home.path = "missing.png";
        await writeFile(join(f.sourceDirectory, "bundle.json"), JSON.stringify(f.bundle));
      }
      assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), false);
      assert.equal(await restoreCaptureArtifactCache(f.options), false);
    });
  }
});

test("restore preserves an unrelated staging directory and an existing destination", async t => {
  const f = await fixture(t);
  assert.equal(await writeCaptureArtifactCache(f.sourceDirectory, RECIPE), true);
  const unrelated = `${f.options.directory}.cache`;
  await mkdir(unrelated);
  await writeFile(join(unrelated, "owned-by-another-process"), "preserve");
  assert.equal(await restoreCaptureArtifactCache(f.options), true);
  assert.equal(await readFile(join(unrelated, "owned-by-another-process"), "utf8"), "preserve");
  await writeFile(join(f.options.directory, "screen-map.json"), "existing destination");
  assert.equal(await restoreCaptureArtifactCache(f.options), false);
  assert.equal(await readFile(join(f.options.directory, "screen-map.json"), "utf8"), "existing destination");
});
