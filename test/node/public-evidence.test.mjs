import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG as PngImage } from "pngjs";

import { assessPublicEvidence, presenceDescription, ignoreStatusBar, ignoreSystemBands, readExportedMap } from "../../dist/review/evidence-assessment.js";
import { STATUS_BAR_BAND_PERCENT } from "../../dist/shared/png-evidence.js";
import { homeIndicatorBandPercent, statusBarBandPercent } from "../../dist/contracts/capture.js";
import { AGENT_DEVICE_VERSION } from "../../dist/capture/run.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const EXECUTION = {
  provider: "eas-simulator", controller: "agent-device", controllerPackageVersion: AGENT_DEVICE_VERSION, easCliVersion: "25.2.0",
  platform: "ios", deviceModel: "iPhone 17", osVersion: "26.0", locale: "en-US", orientation: "portrait",
  colorScheme: "light", sessionLifecycle: "stopped",
};

function screen(id, options = {}) {
  return {
    id, kind: "screen", route: `/${id}`, routeFile: `src/app/${id}.tsx`, sourceFiles: [`src/screens/${id}.tsx`],
    path: `/${id}`, provider: "expo-router", logicalPath: id, variant: "default", ...options,
  };
}

const changed = screen("changed");
const manifests = {
  base: { surfaces: [changed, screen("stable"), screen("removed"), screen("pixels")] },
  head: { surfaces: [changed, screen("stable"), screen("added"), screen("pixels")] },
};
function plan(mode = "all", overrides = {}) {
  const base = new Map(manifests.base.surfaces.map(route => [route.id, route]));
  const head = new Map(manifests.head.surfaces.map(route => [route.id, route]));
  const surfaces = [...new Set([...base.keys(), ...head.keys()])].sort().map(id => {
    const baseSurface = base.get(id) ?? null, headSurface = head.get(id) ?? null;
    const status = overrides[id]?.status ?? (!baseSurface ? "added" : !headSurface ? "removed" : id === "stable" ? "unchanged" : "modified");
    const reasons = overrides[id]?.reasons ?? (status === "modified" ? [`Source changed: app/${id}.tsx`] : []);
    return { id, status, baseSurface, headSurface, reasons,
      baseCapture: Boolean(baseSurface && (mode === "all" || status !== "unchanged")),
      headCapture: Boolean(headSurface && (mode === "all" || status !== "unchanged")) };
  });
  return { contract: "explore.plan", baseSha: BASE_SHA, headSha: HEAD_SHA, mode, conservative: false,
    unresolved: [], diagnostics: { base: [], head: [] }, surfaces,
    inventorySurfaceIds: surfaces.map(surface => surface.id),
    baseCaptureSurfaceIds: surfaces.filter(surface => surface.baseCapture).map(surface => surface.id),
    headCaptureSurfaceIds: surfaces.filter(surface => surface.headCapture).map(surface => surface.id) };
}

function runtimeMap(side, manifest) {
  const sha = side === "base" ? BASE_SHA : HEAD_SHA;
  const artifacts = []; const screens = []; const variants = []; const observations = []; const elements = [];
  for (const surface of manifest.surfaces) {
    const variantId = `${surface.id}-default`;
    const observationId = `${side}-${surface.id}-observation`;
    const element = surface.id === "changed"
      ? { elementId: `${observationId}-primary-cta`, identifier: "primary-cta", role: "button", label: side === "base" ? "Share" : "Share Example", occurrence: 1, controller: "agent-device", actions: ["press"], risk: "safe", actionable: true }
      : { elementId: `${observationId}-title`, identifier: `${surface.id}-title`, role: "text", label: surface.id, occurrence: 1, controller: "agent-device", actions: [], risk: "safe", actionable: false };
    observations.push({
      id: observationId, screenId: surface.id, variantId,
      fingerprints: { combined: `${side}-${surface.id}`, visual: `${side}-${surface.id}-visual`, accessibility: `${surface.id}-${element.label.replaceAll(" ", "-").toLowerCase()}` },
      capturedAt: "2026-09-01T00:00:00Z", surfaceScope: "app", elementIds: [element.elementId], elements: [element],
      screenshotArtifactId: `${observationId}-screenshot`, accessibilityArtifactId: `${observationId}-accessibility`,
    });
    artifacts.push(
      { id: `${observationId}-screenshot`, kind: "screenshot", path: `artifacts/screenshots/${surface.id}.png`, sha256: "1".repeat(64), bytes: PNG.length, mimeType: "image/png", width: 1179, height: 2556, createdAt: "2026-09-01T00:00:00Z" },
      { id: `${observationId}-accessibility`, kind: "accessibility", path: `artifacts/accessibility/${surface.id}.json`, sha256: "2".repeat(64), bytes: 10, mimeType: "application/json", createdAt: "2026-09-01T00:00:00Z" },
    );
    screens.push({
      id: surface.id, title: surface.id, route: surface.route, state: "default", start: screens.length === 0, terminal: false, depth: 0,
      firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:10Z", visits: 1, variantIds: [variantId], observationIds: [observationId], elementIds: [element.elementId],
    });
    variants.push({ id: variantId, screenId: surface.id, key: "default", name: "default", firstSeenAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:10Z", observationIds: [observationId] });
    elements.push({
      id: element.elementId, screenId: surface.id, identifier: element.identifier, role: element.role, label: element.label,
      occurrence: 1, controller: "agent-device", actions: element.actions, risk: "safe", actionable: element.actionable,
      firstSeenObservationId: observationId, lastSeenObservationId: observationId, observationIds: [observationId],
    });
  }
  return {
    contract: "expo.explore.local-map.v1", revision: 1,
    run: {
      id: `${side}-run`, name: "Example", platform: "ios", controller: "agent-device", bundleId: "com.example.app", status: "complete",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:10Z", completedAt: "2026-09-01T00:00:10Z",
      build: { id: `${side}-build`, version: sha.slice(0, 8), gitCommit: sha, source: "eas" },
      environment: { deviceModel: "iPhone 17", osVersion: "26.0", locale: "en-US", orientation: "portrait", colorScheme: "light", authState: "logged-out" },
      limits: { maxScreens: 120, maxActions: 500, maxDurationMinutes: 30 },
    },
    artifacts, screens, variants, observations, elements, actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [],
  };
}

/** Give a side a dark pass the way the capture records one: `<id>@dark` frames and map screens cloned from the primary pass. */
async function addDarkAppearance(current, manifest) {
  for (const surface of manifest.surfaces) {
    await writeFile(join(current.directory, `${surface.id}@dark.png`), PNG);
    current.bundle.images[`${surface.id}@dark`] = { ...current.bundle.images[surface.id], path: `${surface.id}@dark.png` };
    const map = current.map;
    const screen = map.screens.find(entry => entry.id === surface.id);
    if (!screen) continue;
    const dark = id => `${id}@dark`;
    const [observationId] = screen.observationIds;
    const observation = map.observations.find(entry => entry.id === observationId);
    map.screens.push({ ...screen, id: dark(surface.id), start: false, colorScheme: "dark", variantIds: screen.variantIds.map(dark),
      observationIds: [dark(observationId)], elementIds: screen.elementIds.map(dark) });
    map.variants.push(...map.variants.filter(entry => entry.screenId === surface.id).map(entry => ({ ...entry, id: dark(entry.id), screenId: dark(surface.id), observationIds: entry.observationIds.map(dark) })));
    map.observations.push({ ...observation, id: dark(observationId), screenId: dark(surface.id), variantId: dark(observation.variantId),
      fingerprints: { ...observation.fingerprints, combined: `${observation.fingerprints.combined}-dark`, visual: `${observation.fingerprints.visual}-dark` },
      elementIds: observation.elementIds.map(dark), elements: observation.elements.map(element => ({ ...element, elementId: dark(element.elementId) })),
      screenshotArtifactId: dark(observation.screenshotArtifactId), accessibilityArtifactId: dark(observation.accessibilityArtifactId) });
    map.artifacts.push(...map.artifacts.filter(entry => entry.id === observation.screenshotArtifactId || entry.id === observation.accessibilityArtifactId)
      .map(entry => ({ ...entry, id: dark(entry.id) })));
    map.elements.push(...map.elements.filter(entry => entry.screenId === surface.id).map(entry => ({ ...entry, id: dark(entry.id), screenId: dark(surface.id),
      firstSeenObservationId: dark(entry.firstSeenObservationId), lastSeenObservationId: dark(entry.lastSeenObservationId), observationIds: entry.observationIds.map(dark) })));
  }
}

async function side(root, name, manifest, options = {}) {
  const directory = join(root, `${name}-export`);
  await mkdir(directory, { recursive: true });
  const images = {};
  for (const surface of manifest.surfaces) {
    await writeFile(join(directory, `${surface.id}.png`), PNG);
    images[surface.id] = { path: `${surface.id}.png`, sha256: "1".repeat(64), width: 1, height: 1, capturedAt: "2026-09-01T00:00:00Z", sourceCommit: name === "base" ? BASE_SHA : HEAD_SHA, buildId: "build" };
  }
  const bundle = { contract: "explore.bundle", side: name, gitCommit: name === "base" ? BASE_SHA : HEAD_SHA, easBuildId: "build", easProjectId: "project", profile: "explore:bundle", runtimeProfile: null, selectedSurfaceIds: Object.keys(images), images, outcomes: Object.fromEntries(Object.keys(images).map(id => [id, { status: "captured", attempts: 1, landing: "verified" }])) };
  return { directory, bundle, ...(options.withMap === false ? {} : { map: runtimeMap(name, manifest), execution: EXECUTION }) };
}

function measurer(mismatchFor) {
  return async (baselinePath, currentPath) => {
    const id = baselinePath.split("/").pop().replace(".png", "");
    const mismatch = mismatchFor[id] ?? 0;
    return {
      baselinePath, currentPath, totalPixels: 1000, differentPixels: mismatch * 10, mismatchPercentage: mismatch, match: mismatch === 0,
      regions: mismatch === 0 ? [] : [{ index: 0, rect: { x: 0, y: 400, width: 10, height: 10 }, normalizedRect: { x: 0, y: 45, width: 2.5, height: 1.1 }, differentPixels: mismatch * 10, shareOfDiffPercentage: 100, densityPercentage: 50, shape: "wide", size: "small", location: "top", dominantChange: "text" }],
    };
  };
}

test("derives evidence-based review statuses from pixels and accessibility snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: measurer({ changed: 3.2, pixels: 1.5 }),
  });
  assert.deepEqual(result.summary.accessibility?.errors, [], JSON.stringify(result.summary));
  assert.equal(result.surfaces.added.review.status, "added");
  assert.equal(result.surfaces.added.review.description, "Added /added screen.");
  assert.equal(result.surfaces.added.visual, undefined);
  assert.equal(result.surfaces.removed.review.status, "removed");
  assert.equal(result.surfaces.removed.review.description, "Removed /removed screen.");
  assert.equal(result.surfaces.changed.review.status, "modified");
  assert.match(result.surfaces.changed.review.description, /Share/);
  assert.match(result.surfaces.changed.review.description, /Share Example/);
  assert.ok(result.surfaces.changed.review.facts.length >= 1);
  assert.equal(result.surfaces.changed.review.facts[0].bullet, result.surfaces.changed.review.description);
  assert.equal(typeof result.surfaces.changed.review.facts[0].category, "string");
  assert.equal(result.surfaces.changed.visual.verdict, "modified");
  assert.equal(result.surfaces.changed.visual.mismatchPercentage, 3.2);
  assert.equal(result.surfaces.changed.visual.regions[0].location, "top");
  assert.equal(result.surfaces.changed.visual.tool, `agent-device@${AGENT_DEVICE_VERSION}`);
  // Source-affected with a pixel change but identical accessibility trees: the comparator's visual fact.
  assert.equal(result.surfaces.pixels.review.status, "modified");
  assert.match(result.surfaces.pixels.review.description, /Updated visual styling/);
  // Unaffected and identical on both signals.
  assert.equal(result.surfaces.stable.review.status, "unchanged");
  assert.equal(result.surfaces.stable.review.description, "No visible change");
  assert.equal(result.surfaces.stable.visual.verdict, "unchanged");
  assert.deepEqual(result.summary.visual, { compared: 3, modified: 2, unchanged: 1, needsReview: 0, failed: 0, errors: [], threshold: 0.1, tool: `agent-device@${AGENT_DEVICE_VERSION}` });
  assert.deepEqual(result.summary.accessibility, { compared: 3, described: 2, failed: 0, skipped: 0, errors: [] });
  assert.deepEqual(result.summary.review, { modified: 2, needsReview: 0, variants: 0, unchanged: 1 });
  assert.deepEqual(result.summary.comparison, { planned: 3, eligible: 3, skipped: 0 });
  assert.deepEqual(result.summary.capture, {
    base: { planned: 4, captured: 4, verified: 4, unverified: 0, unavailable: 0 },
    head: { planned: 4, captured: 4, verified: 4, unverified: 0, unavailable: 0 },
  });
  assert.deepEqual(result.summary.diagnostics, []);
});

test("pixel differences on a source-unchanged screen are a screen variant, and diff failures never abort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: async (baselinePath, currentPath) => {
      if (baselinePath.endsWith("changed.png")) throw new Error("diff crashed");
      return (await measurer({ stable: 0.4 })(baselinePath, currentPath));
    },
  });
  assert.equal(result.surfaces.changed, undefined, "operational failures produce no app-change verdict");
  assert.equal(result.summary.diagnostics[0].code, "VISUAL_COMPARISON_FAILED");
  assert.match(result.summary.diagnostics[0].nextAction, /agent-device/);
  // The pixel verdict is a measurement; the source plan decides it is not a change.
  assert.equal(result.surfaces.stable.visual.verdict, "modified");
  assert.equal(result.surfaces.stable.review.status, "variant");
  assert.equal(result.surfaces.stable.review.description, "Runtime state differs: 0.4% · top");
  assert.equal(result.summary.visual.failed, 1);
  assert.equal(result.summary.visual.needsReview, 0);
  assert.equal(result.summary.review.variants, 1);
});

test("the verdict table: source scope decides whether a screen is a review target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  const assess = (overrides, mismatches = {}) => assessPublicEvidence({ plan: plan("all", overrides), base, head,
    profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", measure: measurer(mismatches) });
  // Screen-specific source change, identical evidence: not a visible change, so Unchanged and not counted.
  let result = await assess({});
  assert.deepEqual(result.surfaces.pixels.review, { status: "unchanged", description: "No visible change" });
  assert.equal(result.surfaces.changed.review.status, "modified", "an accessibility fact is a visible difference");
  // Only app-wide inputs changed: no visible difference is Unchanged; a difference is Modified.
  result = await assess({ pixels: { status: "modified", reasons: ["App configuration changed: package.json"] },
    changed: { status: "modified", reasons: ["App configuration changed: package.json"] } });
  assert.deepEqual(result.surfaces.pixels.review, { status: "unchanged", description: "No visible change" });
  assert.equal(result.surfaces.changed.review.status, "modified");
  // Source unchanged: an accessibility difference is a runtime-state variant with its facts kept.
  result = await assess({ changed: { status: "unchanged", reasons: [] } });
  assert.equal(result.surfaces.changed.review.status, "variant");
  assert.match(result.surfaces.changed.review.description, /^Runtime state differs: .*Share/);
  assert.ok(result.surfaces.changed.review.facts.length >= 1);
});

test("a screenshot mismatch that rounds to 0.00% is noise, not a difference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: async (baselinePath, currentPath) => ({ ...(await measurer({})(baselinePath, currentPath)), differentPixels: 3, mismatchPercentage: 0.004, match: false }),
  });
  assert.equal(result.surfaces.stable.visual.verdict, "unchanged");
  assert.equal(result.surfaces.stable.review.status, "unchanged");
});

test("a restored side without a runtime map is compared visually only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base, { withMap: false });
  const head = await side(root, "head", manifests.head);
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: measurer({ changed: 2 }),
  });
  assert.equal(result.summary.accessibility, null);
  assert.equal(result.surfaces.changed.review.status, "modified");
  assert.match(result.surfaces.changed.review.description, /^Visual change · 2% · top$/);
  assert.equal(result.surfaces.stable.review.status, "unchanged");
});

test("unverified landing never reaches either comparator and capture failures preserve source additions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  head.bundle.outcomes.stable.landing = "unverified";
  head.bundle.outcomes.added = { status: "missing-params", attempts: 0, landing: "unverified", reason: "A route parameter is required" };
  delete head.bundle.images.added;
  const measured = [];
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", measure: async (basePath, headPath) => {
      measured.push(basePath.split('/').pop());
      return measurer({})(basePath, headPath);
    },
  });
  assert.deepEqual(measured, ['changed.png', 'pixels.png']);
  assert.equal(result.surfaces.stable, undefined);
  assert.equal(result.surfaces.added.review.status, "added");
  assert.equal(result.summary.visual.compared, 2);
  assert.equal(result.summary.accessibility.compared, 2);
  assert.equal(result.summary.visual.needsReview, 0);
  assert.deepEqual(result.summary.comparison, { planned: 3, eligible: 2, skipped: 1 });
  assert.deepEqual(result.summary.capture.head, { planned: 4, captured: 3, verified: 2, unverified: 1, unavailable: 1 });
  assert.deepEqual(result.summary.diagnostics.map(({ surfaceId, side, code }) => ({ surfaceId, side, code })), [
    { surfaceId: 'added', side: 'head', code: 'CAPTURE_PARAMETERS_MISSING' },
    { surfaceId: 'stable', side: 'head', code: 'CAPTURE_LANDING_UNVERIFIED' },
  ]);
});

test("a route captured as context on only one side is not declared visually unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  const selected = plan();
  selected.surfaces.find(surface => surface.id === "stable").baseCapture = false;
  delete base.bundle.images.stable;
  delete base.bundle.outcomes.stable;
  const result = await assessPublicEvidence({
    plan: selected, base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", measure: measurer({}),
  });
  assert.equal(result.surfaces.stable, undefined);
  assert.deepEqual(result.summary.comparison, { planned: 3, eligible: 2, skipped: 1 });
  assert.equal(result.summary.capture.base.unavailable, 0, "an unselected context side is not a failed capture");
});

test("every failed side is diagnosed and source removals survive missing captures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  for (const evidence of [base, head]) {
    evidence.bundle.outcomes.changed = { status: 'failed', attempts: 1, landing: 'unverified',
      error: { code: `${evidence.bundle.side.toUpperCase()}_SESSION_FAILED`, stage: 'session', message: 'Session disconnected.', nextAction: 'Restart this simulator session and rerun capture.', retryable: true } };
    delete evidence.bundle.images.changed;
  }
  base.bundle.outcomes.removed = { status: 'budget-exhausted', attempts: 0, landing: 'unverified' };
  delete base.bundle.images.removed;
  const result = await assessPublicEvidence({ plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", measure: measurer({}) });
  assert.equal(result.surfaces.changed, undefined);
  assert.deepEqual(result.surfaces.removed.review, { status: 'removed', description: 'Removed /removed screen.' });
  assert.deepEqual(result.summary.diagnostics.filter(item => item.surfaceId === 'changed').map(item => [item.side, item.code, item.nextAction]), [
    ['base', 'BASE_SESSION_FAILED', 'Restart this simulator session and rerun capture.'],
    ['head', 'HEAD_SESSION_FAILED', 'Restart this simulator session and rerun capture.'],
  ]);
  assert.equal(result.summary.capture.base.unavailable, 2);
  assert.equal(result.summary.capture.head.unavailable, 1);
  assert.equal(result.summary.visual.compared, 2);
  assert.equal(result.summary.accessibility.compared, 2);
  assert.equal(result.summary.visual.needsReview, 0);
});

test("fully unverified screenshots never invoke the comparison tool or count as compared", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  for (const evidence of [base, head]) for (const outcome of Object.values(evidence.bundle.outcomes)) outcome.landing = 'unverified';
  const result = await assessPublicEvidence({ plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", measure: async () => { assert.fail('unverified captures cannot be compared'); } });
  assert.equal(result.summary.visual.compared, 0);
  assert.equal(result.summary.accessibility.compared, 0);
  assert.equal(result.summary.visual.needsReview, 0);
  assert.deepEqual(result.summary.comparison, { planned: 3, eligible: 0, skipped: 3 });
  assert.equal(result.summary.diagnostics.length, 8);
  assert.deepEqual(Object.keys(result.surfaces), ['added', 'removed']);
});

test("expired comparison budgets produce diagnostics rather than review verdicts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  let clock = 0;
  const result = await assessPublicEvidence({ plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", timeBudgetMs: 0, now: () => clock++, measure: async () => { assert.fail('expired comparisons do not run'); } });
  assert.equal(result.summary.visual.compared, 0);
  assert.equal(result.summary.visual.failed, 3);
  assert.equal(result.summary.visual.needsReview, 0);
  assert.equal(result.summary.diagnostics.length, 3);
  assert.ok(result.summary.diagnostics.every(item => item.code === 'VISUAL_COMPARISON_BUDGET_EXHAUSTED' && item.nextAction));
});

test("changes mode only assesses selected surfaces and an absent diff tool is explicit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const selected = plan("changes");
  const base = await side(root, "base", { surfaces: manifests.base.surfaces.filter((s) => selected.baseCaptureSurfaceIds.includes(s.id)) });
  const head = await side(root, "head", { surfaces: manifests.head.surfaces.filter((s) => selected.headCaptureSurfaceIds.includes(s.id)) });
  const result = await assessPublicEvidence({ plan: selected, base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device", measure: measurer({}) });
  assert.equal(result.surfaces.stable, undefined);
  assert.equal(result.surfaces.changed.review.status, "modified");
  assert.equal(result.surfaces.added.review.status, "added");
  const none = await assessPublicEvidence({ plan: selected, base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device" });
  assert.equal(none.summary.visual, null);
  assert.equal(none.surfaces.changed, undefined);
  assert.equal(none.summary.diagnostics[0].code, "VISUAL_COMPARISON_UNAVAILABLE");
  const relative = await assessPublicEvidence({ plan: selected, base, head, profile: "explore:bundle", agentDeviceCommand: "agent-device" });
  assert.equal(relative.summary.visual, null);
  assert.equal(relative.surfaces.changed, undefined);
  // npm exposes agent-device through a `.bin` symlink; the tool must be found through it.
  const binary = join(root, "agent-device.mjs");
  await writeFile(binary, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ success: true, data: { regions: [], totalPixels: 1, differentPixels: 0, mismatchPercentage: 0, match: true } }));\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  await mkdir(join(root, ".bin")); await symlink(binary, join(root, ".bin/agent-device"));
  const linked = await assessPublicEvidence({ plan: selected, base, head, profile: "explore:bundle", agentDeviceCommand: join(root, ".bin/agent-device") });
  assert.notEqual(linked.summary.visual, null);
  assert.equal(linked.summary.visual.compared, 2, "changed and pixels are the selected shared surfaces");
  assert.equal(linked.surfaces.changed.visual.verdict, "unchanged");
});

test("readExportedMap validates an exported map and can skip artifact hashes for restored sides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "export"); await mkdir(directory);
  await writeFile(join(directory, "screen-map.json"), JSON.stringify(runtimeMap("head", manifests.head)));
  const map = await readExportedMap(directory, { checkArtifacts: false });
  assert.equal(map.screens.length, 4);
  await assert.rejects(readExportedMap(directory), /Exported map is invalid/);
  await writeFile(join(directory, "screen-map.json"), JSON.stringify({ contract: "other" }));
  await assert.rejects(readExportedMap(directory, { checkArtifacts: false }), /contract/);
});

test("status-bar glyph differences never count as an app change", async (t) => {
  const region = (y, height, pixels, location) => ({ index: 0, rect: { x: 341, y, width: 21, height }, normalizedRect: { x: 84.8, y: (y / 874) * 100, width: 5.2, height: (height / 874) * 100 }, differentPixels: pixels, shareOfDiffPercentage: 100, densityPercentage: 50, shape: "wide", size: "small", location, dominantChange: "brighter" });
  const statusBarOnly = { baselinePath: "b", currentPath: "h", totalPixels: 351348, differentPixels: 111, mismatchPercentage: 0.03, match: false, regions: [region(28, 9, 111, "top-right")] };
  const cleaned = ignoreStatusBar(statusBarOnly);
  assert.equal(cleaned.ignored, 1);
  assert.equal(cleaned.measurement.match, true);
  assert.equal(cleaned.measurement.differentPixels, 0);
  assert.deepEqual(cleaned.measurement.regions, []);
  const mixed = { ...statusBarOnly, differentPixels: 363, mismatchPercentage: 0.1, regions: [region(28, 9, 111, "top-right"), region(104, 9, 252, "top-center")] };
  const kept = ignoreStatusBar(mixed);
  assert.equal(kept.ignored, 1);
  assert.equal(kept.measurement.match, false);
  assert.equal(kept.measurement.differentPixels, 252);
  assert.equal(kept.measurement.regions.length, 1);
  assert.equal(kept.measurement.regions[0].location, "top-center");
  assert.equal(kept.measurement.mismatchPercentage, 0.07);
  assert.ok(104 / 874 * 100 > STATUS_BAR_BAND_PERCENT, "a navigation title at 104pt sits below the band");
  const untouched = ignoreStatusBar({ ...statusBarOnly, match: true, differentPixels: 0, regions: [] });
  assert.equal(untouched.ignored, 0);

  // The iOS home indicator (5pt bar, 8pt above the bottom edge of an 874pt frame) is the system's, not the app's; a
  // tab bar ending above the band is the app's. Android has no bottom band, so the same bar counts there.
  const indicator = region(861, 5, 140, "bottom-center"); const tabBar = region(834, 18, 300, "bottom-center");
  const bands = ignoreSystemBands({ ...mixed, differentPixels: 551, regions: [region(28, 9, 111, "top-right"), indicator, tabBar] },
    { top: statusBarBandPercent("ios"), bottom: homeIndicatorBandPercent("ios") });
  assert.deepEqual([bands.ignoredTop, bands.ignoredBottom], [1, 1]);
  assert.equal(bands.measurement.differentPixels, 300);
  assert.deepEqual(bands.measurement.regions.map((entry) => entry.rect.y), [834]);
  const indicatorOnly = ignoreSystemBands({ ...statusBarOnly, differentPixels: 140, regions: [indicator] }, { top: statusBarBandPercent("ios"), bottom: homeIndicatorBandPercent("ios") });
  assert.equal(indicatorOnly.measurement.match, true);
  const android = ignoreSystemBands({ ...statusBarOnly, differentPixels: 140, regions: [indicator] }, { top: statusBarBandPercent("android"), bottom: homeIndicatorBandPercent("android") });
  assert.deepEqual([android.ignoredTop, android.ignoredBottom, android.measurement.match], [0, 0, false]);

  // A region that crosses the band's edge is clipped to its pixels below the band, read from the frames themselves:
  // in a 100x874 frame the iOS band is 56 rows, so a glyph drawn over rows 50-59 keeps only its 4 rows below.
  const frame = (paint) => { const png = new PngImage({ width: 100, height: 874 }); png.data.fill(255); paint?.(png); return png; };
  const paintRows = (from, to) => (png) => { for (let y = from; y < to; y += 1) for (let x = 10; x < 20; x += 1) png.data.fill(0, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3); };
  const frames = (to) => () => ({ baseline: frame(), current: frame(paintRows(50, to)), distance: 0.1 * Math.sqrt(3 * 255 ** 2) });
  const straddling = (height, pixels) => ({ index: 0, rect: { x: 10, y: 50, width: 10, height }, normalizedRect: { x: 10, y: 5.72, width: 10, height: (height / 874) * 100 }, differentPixels: pixels, shareOfDiffPercentage: 100, densityPercentage: 100, shape: "block", size: "small", location: "top-left", dominantChange: "darker" });
  const whole = { ...statusBarOnly, totalPixels: 87400, differentPixels: 100, mismatchPercentage: 0.11, regions: [straddling(10, 100)] };
  const clipped = ignoreSystemBands(whole, { top: statusBarBandPercent("ios"), bottom: 0 }, frames(60));
  assert.deepEqual([clipped.ignoredTop, clipped.measurement.match, clipped.measurement.differentPixels, clipped.measurement.mismatchPercentage], [0, false, 40, 0.05]);
  assert.deepEqual(clipped.measurement.regions.map((entry) => [entry.rect.y, entry.rect.height, entry.differentPixels, entry.shareOfDiffPercentage]), [[56, 4, 40, 100]]);
  assert.equal(clipped.measurement.regions[0].normalizedRect.y, 6.41);
  const glyph = ignoreSystemBands({ ...whole, differentPixels: 60, regions: [straddling(7, 60)] }, { top: statusBarBandPercent("ios"), bottom: 0 }, frames(56));
  assert.deepEqual([glyph.ignoredTop, glyph.measurement.match, glyph.measurement.regions], [1, true, []]);
  const unreadable = ignoreSystemBands(whole, { top: statusBarBandPercent("ios"), bottom: 0 }, () => undefined);
  assert.deepEqual([unreadable.ignoredTop, unreadable.measurement.differentPixels], [0, 100]);
  assert.equal(statusBarBandPercent("android"), 7, "Android 15 status glyphs on a 720x1600 emulator reach 6.4 %");

  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: async (baselinePath, currentPath) => baselinePath.endsWith("stable.png")
      ? { ...statusBarOnly, baselinePath, currentPath }
      : measurer({})(baselinePath, currentPath),
  });
  // An unaffected screen whose only difference is the status bar is unchanged, not needs-review.
  assert.equal(result.surfaces.stable.review.status, "unchanged");
  assert.equal(result.surfaces.stable.visual.verdict, "unchanged");
  assert.equal(result.surfaces.stable.visual.ignoredStatusBarRegions, 1);
  assert.equal(result.summary.visual.needsReview, 0);
});

test("a dark+light capture compares each appearance like for like", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  for (const current of [base, head]) {
    current.bundle.runtimeProfile = { deviceModel: "iPhone 17", osVersion: "26.0", locale: "en-US", orientation: "portrait", colorScheme: "light", colorSchemes: "light,dark" };
    await addDarkAppearance(current, manifests[current.bundle.side]);
  }
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: measurer({ changed: 3.2, "stable@dark": 2 }),
  });
  assert.deepEqual(result.summary.diagnostics, []);
  assert.equal(result.surfaces.changed.visual.verdict, "modified");
  assert.equal(result.surfaces["changed@dark"].visual.verdict, "unchanged", "Dark frames are measured against dark frames");
  assert.equal(result.surfaces["changed@dark"].review.status, "modified", "A dark pair is compared under its own surface id, so its accessibility change is a fact, not an inconclusive scope");
  assert.ok(result.surfaces["changed@dark"].review.facts?.length, JSON.stringify(result.surfaces["changed@dark"].review));
  assert.equal(result.summary.accessibility.compared, 6);
  assert.deepEqual(result.summary.accessibility.errors, []);
  for (const [id, surface] of Object.entries(result.surfaces)) assert.doesNotMatch(surface.review?.description ?? "", /scoped to a different surface/, id);
  assert.equal(result.surfaces.stable.review.status, "unchanged");
  assert.equal(result.surfaces["stable@dark"].review.status, "variant", "A pixel change in one appearance only is a variant of that appearance");
  assert.equal(result.surfaces.added.visual, undefined);
  assert.equal(result.surfaces["added@dark"], undefined, "Added and removed routes stay one surface");
  assert.equal(result.summary.visual.compared, 6);
  assert.deepEqual(result.summary.comparison, { planned: 6, eligible: 6, skipped: 0 });
});

test("a head that gained a light appearance compares its dark frames against the dark-only base and reports light as added", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-public-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const base = await side(root, "base", manifests.base);
  const head = await side(root, "head", manifests.head);
  base.bundle.runtimeProfile = { deviceModel: "iPhone 17", osVersion: "26.0", locale: "en-US", orientation: "portrait", colorScheme: "dark" };
  base.execution = { ...base.execution, colorScheme: "dark" };
  base.map.run.environment.colorScheme = "dark";
  head.bundle.runtimeProfile = { deviceModel: "iPhone 17", osVersion: "26.0", locale: "en-US", orientation: "portrait", colorScheme: "light", colorSchemes: "light,dark" };
  head.execution = { ...head.execution, colorSchemes: ["light", "dark"] };
  await addDarkAppearance(head, manifests.head);
  const result = await assessPublicEvidence({
    plan: plan(), base, head, profile: "explore:bundle", agentDeviceCommand: "/nonexistent/agent-device",
    measure: measurer({ changed: 3.2 }),
  });
  assert.deepEqual(result.summary.diagnostics, []);
  assert.deepEqual(result.summary.comparison, { planned: 3, eligible: 3, skipped: 0 }, "Each head dark frame pairs with the base's (primary) dark frame");
  assert.equal(result.summary.visual.compared, 3);
  assert.equal(result.summary.accessibility.compared, 3, "Accessibility still compares every eligible surface");
  assert.equal(result.summary.accessibility.failed, 0);
  assert.deepEqual(result.surfaces["changed"], { review: { status: "added", description: "Added the light appearance of /changed." } }, "The head's primary (light) frame is new");
  assert.equal(result.surfaces["changed@dark"].visual.verdict, "modified");
  assert.ok(result.surfaces["changed@dark"].review);
  assert.equal(result.surfaces["stable@dark"].visual.verdict, "unchanged");
});

test("a presence verdict for a long route (an encoded share link) stays within the review description cap", () => {
  const route = `/p/${"A".repeat(300)}`;
  for (const [prefix, suffix] of [["Added ", " screen."], ["Removed ", " screen."], ["Added the light appearance of ", "."]]) {
    const description = presenceDescription(prefix, route, suffix);
    assert.ok(description.length <= 160, description.length);
    assert.ok(description.startsWith(`${prefix}/p/AAA`) && description.endsWith(`\u2026${suffix}`));
  }
  assert.equal(presenceDescription("Added ", "/home", " screen."), "Added /home screen.");
});
