import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyMap } from "./map-store-fixture.mjs";

const timestamp = "2026-04-01T12:00:00.000Z";
export const AREA_COUNT = 4;
export const SCREENS_PER_AREA = 8;
export const SCREEN_COUNT = AREA_COUNT * SCREENS_PER_AREA;
export const fixtureImage = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="#5b8def"/></svg>';

// Small generated evidence for API, layout and carousel tests. No app capture inventory.
export function viewerMapFixture({ denseFlows = true } = {}) {
  const map = emptyMap("Viewer fixture");
  map.revision = 1;
  map.run.id = "viewer-fixture";
  map.run.limits.maxScreens = SCREEN_COUNT;
  const topics = ["Onboarding", "Home", "Account profile", "Security privacy"];
  topics.forEach((topic, area) => {
    const ids = [];
        for (let position = 0; position < SCREENS_PER_AREA; position += 1) {
      const id = area === 2 && position === 0 ? "settings-root"
        : area === 2 && position === 1 ? "general"
        : area === 2 && position === 2 ? "action-button" : `area-${area}-screen-${position}`;
      ids.push(id);
      const title = id === "settings-root" ? "Settings" : id === "general" ? "General"
        : id === "action-button" ? "Action button" : `${topic} step ${position + 1}`;
      const screen = { id, title, start: position === 0, terminal: position === SCREENS_PER_AREA - 1,
        depth: position, firstSeenAt: timestamp, lastSeenAt: timestamp, visits: 1,
        variantIds: [], observationIds: [], elementIds: [] };
      for (let variant = 0; variant < (id === "settings-root" || id === "general" ? 2 : 1); variant += 1) {
        const observationId = `observation-${id}-${variant}`;
        const variantId = `variant-${id}-${variant}`;
        const artifactId = `artifact-${id}-${variant}`;
        const bytes = Buffer.from(fixtureImage.replace('#5b8def', variant ? '#7c3aed' : '#5b8def'));
        map.artifacts.push({ id: artifactId, kind: "screenshot", path: `artifacts/${id}-${variant}.svg`,
          sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
          mimeType: "image/svg+xml", width: 390, height: 844, createdAt: timestamp });
        map.variants.push({ id: variantId, screenId: id, key: `state-${variant}`, firstSeenAt: timestamp,
          lastSeenAt: timestamp, observationIds: [observationId] });
        map.observations.push({ id: observationId, screenId: id, variantId, capturedAt: timestamp,
          surfaceScope: "app", elementIds: [], elements: [], fingerprints: { combined: observationId },
          screenshotArtifactId: artifactId });
        screen.variantIds.push(variantId);
        screen.observationIds.push(observationId);
      }
      map.screens.push(screen);
      if (position > 0) {
        const transitionId = `transition-${area}-${position}`;
        map.transitions.push({ id: transitionId, fromScreenId: ids[position - 1], toScreenId: id,
          actionKind: "press", firstObservedAt: timestamp, lastObservedAt: timestamp, attemptIds: [`attempt-${area}-${position}`] });
        map.actionAttempts.push({ id: `attempt-${area}-${position}`, sourceScreenId: ids[position - 1],
          sourceObservationId: `observation-${ids[position - 1]}-0`, targetScreenId: id,
          targetObservationId: `observation-${id}-0`, action: { kind: "press", label: `Open ${title}` },
          outcome: "transition", risk: "safe", startedAt: timestamp, completedAt: timestamp });
      }
    }
    const segments = denseFlows
      ? [ids, ...Array.from({ length: 5 }, (_, index) => ids.slice(0, index + 3))]
      : Array.from({ length: 6 }, (_, index) => ids.slice(index, index + 3));
    segments.forEach((screenIds, segment) => {
      const transitions = map.transitions.filter(entry => screenIds.includes(entry.fromScreenId) && screenIds.includes(entry.toScreenId));
      map.journeys.push({ id: `journey-${area}-${segment}`, title: `${topic} / Path ${segment + 1}`,
        screenIds, transitionIds: transitions.map(entry => entry.id),
        attemptIds: transitions.flatMap(entry => entry.attemptIds) });
    });
  });
  // A branching hub keeps transition inspection and its scroll container under test.
  const source = map.screens.find(screen => screen.id === "settings-root");
  for (const target of map.screens.slice(2 * SCREENS_PER_AREA + 2, 3 * SCREENS_PER_AREA)) {
    const attemptId = `attempt-settings-${target.id}`;
    map.actionAttempts.push({ id: attemptId, sourceScreenId: source.id,
      sourceObservationId: source.observationIds[0], targetScreenId: target.id,
      targetObservationId: target.observationIds[0], action: { kind: "press", label: `Open ${target.title}` },
      outcome: "transition", risk: "safe", startedAt: timestamp, completedAt: timestamp });
    map.transitions.push({ id: `transition-settings-${target.id}`, fromScreenId: source.id,
      toScreenId: target.id, actionKind: "press", firstObservedAt: timestamp,
      lastObservedAt: timestamp, attemptIds: [attemptId] });
  }
  return map;
}

export async function writeViewerMapFixture(root) {
  const map = viewerMapFixture({ denseFlows: false });
  await mkdir(join(root, "artifacts"), { recursive: true });
  for (const artifact of map.artifacts) {
    const bytes = fixtureImage.replace('#5b8def', artifact.id.endsWith('-1') ? '#7c3aed' : '#5b8def');
    await writeFile(join(root, artifact.path), bytes);
  }
  await writeFile(join(root, "screen-map.json"), JSON.stringify(map));
  return map;
}

// Numeric source routes are intentionally grouped: capture 2 is a second state of capture 1;
// capture 3 is a distinct raw screen in the same displayed route family.
export function captureAliasFixture() {
  const map = emptyMap("Capture aliases");
  const definitions = [
    { id: "intro", title: "Onboarding", route: "/mobbin/screens/0", captures: [0] },
    { id: "home", title: "Home — Empty", route: "/mobbin/screens/1", captures: [1, 2] },
    { id: "home-loaded", title: "Home — Loaded", route: "/mobbin/screens/3", captures: [3] },
    { id: "profile", title: "Account profile", route: "/mobbin/screens/4", captures: [4] },
  ];
  for (const [position, { captures, ...definition }] of definitions.entries()) {
    const screen = { ...definition, start: position === 0, terminal: false, depth: position,
      firstSeenAt: timestamp, lastSeenAt: timestamp, visits: 1,
      variantIds: [], observationIds: [], elementIds: [] };
    for (const capture of captures) {
      const observationId = `observation-capture-${capture}`;
      const variantId = `variant-capture-${capture}`;
      screen.variantIds.push(variantId); screen.observationIds.push(observationId);
      map.variants.push({ id: variantId, screenId: screen.id, key: String(capture),
        firstSeenAt: timestamp, lastSeenAt: timestamp, observationIds: [observationId] });
      map.observations.push({ id: observationId, screenId: screen.id, variantId,
        capturedAt: new Date(Date.parse(timestamp) + capture * 1000).toISOString(),
        surfaceScope: "app", elements: [], elementIds: [], fingerprints: { combined: observationId } });
    }
    map.screens.push(screen);
  }
  for (const [from, to, sourceCapture, targetCapture] of [
    ["home", "home-loaded", 1, 3], ["home-loaded", "profile", 3, 4],
  ]) {
    const id = `${from}-${to}`;
    map.actionAttempts.push({ id: `attempt-${id}`, sourceScreenId: from,
      sourceObservationId: `observation-capture-${sourceCapture}`, targetScreenId: to,
      targetObservationId: `observation-capture-${targetCapture}`, action: { kind: "press", label: `Open ${to}` },
      outcome: "transition", risk: "safe", startedAt: timestamp, completedAt: timestamp });
    map.transitions.push({ id: `transition-${id}`, fromScreenId: from, toScreenId: to,
      actionKind: "press", firstObservedAt: timestamp, lastObservedAt: timestamp, attemptIds: [`attempt-${id}`] });
  }
  return map;
}

export function viewerWorkspaceFixture() {
  const currentMap = viewerMapFixture();
  const baselineMap = viewerMapFixture();
  baselineMap.run.id = "baseline-fixture";
  currentMap.run.id = "current-fixture";
  const entries = currentMap.screens.map((screen, index) => ({
    id: `comparison-${index}`, relationship: "one-to-one", status: index === 0 ? "unchanged" : "modified",
    baselineScreenIds: [screen.id], currentScreenIds: [screen.id],
    baselineRepresentativeObservationIds: [screen.observationIds[0]],
    currentRepresentativeObservationIds: [screen.observationIds[0]],
    representativePairs: [{ baselineObservationId: screen.observationIds[0],
      currentObservationId: screen.observationIds[0], confidence: 1, rationale: "Synthetic correspondence" }],
    confidence: 1, changeSummary: "Updated fixture screen.", rationale: "Synthetic decision",
  }));
  return {
    catalog: { contract: "expo.explore.build-catalog.v1", name: "Viewer comparison fixture",
      currentBuildId: "build-2.0.0", defaultBaselineBuildId: "build-1.0.0",
      builds: [{ id: "build-1.0.0", kind: "build", version: "1.0.0", mapDir: "baseline" },
        { id: "build-2.0.0", kind: "build", version: "2.0.0", mapDir: "current" }],
      comparisons: [{ baselineBuildId: "build-1.0.0", currentBuildId: "build-2.0.0", path: "comparison.json" }] },
    baselineMap, currentMap,
    comparison: { contract: "expo.explore.build-comparison.v1", baselineBuildId: "build-1.0.0",
      currentBuildId: "build-2.0.0", baselineRunId: baselineMap.run.id, currentRunId: currentMap.run.id,
      baselineRevision: baselineMap.revision, currentRevision: currentMap.revision, entries },
  };
}
