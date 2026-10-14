import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CAPTURED_AT = "2026-08-25T09:00:00.000Z";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function screenshotBytes(label, color) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="60">`+
      `<rect width="30" height="60" fill="${color}"/>`+
      `<text x="2" y="30" font-size="4" fill="white">${label}</text>`+
    `</svg>`,
    "utf8",
  );
}

function screenRecord(id, position, observationIds) {
  const variantIds = observationIds.map((observationId) => `variant-${observationId}`);
  return {
    id,
    title: id.replaceAll("-", " "),
    start: position === 0,
    terminal: false,
    depth: position,
    firstSeenAt: CAPTURED_AT,
    lastSeenAt: CAPTURED_AT,
    visits: 1,
    variantIds,
    observationIds,
    elementIds: [],
  };
}

async function writeMap(root, input) {
  const artifacts = [];
  const screens = [];
  const variants = [];
  const observations = [];
  await mkdir(join(root, "artifacts", "screenshots"), { recursive: true });

  for (const [position, screenInput] of input.screens.entries()) {
    const captures = screenInput.captures ?? [{ suffix: "primary", color: screenInput.color }];
    const observationIds = [];
    for (const [capturePosition, capture] of captures.entries()) {
      const observationId = `observation-${input.id}-${screenInput.id}-${capture.suffix}`;
      const variantId = `variant-${observationId}`;
      const artifactId = `artifact-${observationId}`;
      // The unchanged screen deliberately has the same relative artifact path in both builds.
      const filename = screenInput.sharedPath
        ? "shared-screen.svg"
        : `${screenInput.id}-${capture.suffix}.svg`;
      const path = `artifacts/screenshots/${filename}`;
      const bytes = screenshotBytes(`${input.id}:${screenInput.id}:${capture.suffix}`, capture.color);
      await writeFile(join(root, path), bytes);
      artifacts.push({
        id: artifactId,
        kind: "screenshot",
        path,
        sha256: sha256(bytes),
        bytes: bytes.length,
        mimeType: "image/svg+xml",
        width: 30,
        height: 60,
        createdAt: CAPTURED_AT,
      });
      variants.push({
        id: variantId,
        screenId: screenInput.id,
        key: `key-${capturePosition}`,
        name: capture.suffix,
        firstSeenAt: CAPTURED_AT,
        lastSeenAt: CAPTURED_AT,
        observationIds: [observationId],
      });
      observations.push({
        id: observationId,
        screenId: screenInput.id,
        variantId,
        fingerprints: {
          combined: `${input.id}-${screenInput.id}-${capture.suffix}`,
          visual: sha256(bytes),
        },
        capturedAt: CAPTURED_AT,
        surfaceScope: "app",
        elementIds: [],
        elements: [],
        screenshotArtifactId: artifactId,
      });
      observationIds.push(observationId);
    }
    screens.push(screenRecord(screenInput.id, position, observationIds));
  }

  const map = {
    contract: "expo.explore.local-map.v1",
    revision: input.revision,
    run: {
      id: `run-${input.id}`,
      name: `Fixture ${input.id}`,
      platform: "ios",
      controller: "agent-device",
      status: "draft",
      createdAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT,
      build: {
        id: input.id,
        version: input.id === "build-1.0.0" ? "1.0.0" : "2.0.0",
        source: "local",
      },
      environment: { orientation: "portrait", colorScheme: "light" },
      limits: { maxScreens: 20, maxActions: 20, maxDurationMinutes: 5 },
    },
    artifacts,
    screens,
    variants,
    observations,
    elements: [],
    actionAttempts: [],
    transitions: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
  await writeFile(join(root, "screen-map.json"), `${JSON.stringify(map, null, 2)}\n`, "utf8");
  return map;
}

function observation(buildId, screenId, suffix = "primary") {
  return `observation-${buildId}-${screenId}-${suffix}`;
}

function pair(baselineScreenId, currentScreenId, currentSuffix = "primary") {
  return {
    baselineObservationId: observation("build-1.0.0", baselineScreenId),
    currentObservationId: observation("build-2.0.0", currentScreenId, currentSuffix),
    confidence: 1,
    rationale: "Reviewed fixture correspondence",
  };
}

function comparisonEntry(input) {
  const baselineRepresentativeObservationIds = input.baselineScreenIds.map((screenId) => (
    observation("build-1.0.0", screenId)
  ));
  const currentRepresentativeObservationIds = input.currentScreenIds.map((screenId) => (
    observation(
      "build-2.0.0",
      screenId,
      screenId === "current-profile" ? "reviewed" : "primary",
    )
  ));
  return {
    id: input.id,
    relationship: input.relationship,
    status: input.status,
    baselineScreenIds: input.baselineScreenIds,
    currentScreenIds: input.currentScreenIds,
    baselineRepresentativeObservationIds,
    currentRepresentativeObservationIds,
    representativePairs: input.pairs ?? [],
    confidence: 1,
    changeSummary: input.changeSummary,
    rationale: "Final reviewed fixture decision",
  };
}

export async function createBuildWorkspaceFixture(parent) {
  const root = parent ?? await mkdtemp(join(tmpdir(), "expo-explore-build-workspace-"));
  const baselineRoot = join(root, "baseline");
  const currentRoot = join(root, "current");
  await Promise.all([mkdir(baselineRoot, { recursive: true }), mkdir(currentRoot, { recursive: true })]);

  const baselineMap = await writeMap(baselineRoot, {
    id: "build-1.0.0",
    revision: 10,
    screens: [
      { id: "shared-home", color: "#164e63", sharedPath: true },
      { id: "baseline-profile", color: "#7c2d12" },
      { id: "baseline-legacy", color: "#7f1d1d" },
      { id: "baseline-split", color: "#365314" },
      { id: "baseline-merge-a", color: "#3f6212" },
      { id: "baseline-merge-b", color: "#4d7c0f" },
    ],
  });
  const currentMap = await writeMap(currentRoot, {
    id: "build-2.0.0",
    revision: 20,
    screens: [
      // Same visual state with build-qualified bytes/path ownership. The tiny fixture label is
      // provenance-only content that a reviewed unchanged decision intentionally normalizes.
      { id: "shared-home", color: "#164e63", sharedPath: true },
      {
        id: "current-profile",
        color: "#9a3412",
        captures: [
          { suffix: "primary", color: "#9a3412" },
          { suffix: "reviewed", color: "#c2410c" },
        ],
      },
      { id: "current-added", color: "#1d4ed8" },
      { id: "current-split-a", color: "#047857" },
      { id: "current-split-b", color: "#059669" },
      { id: "current-merged", color: "#65a30d" },
    ],
  });

  const comparison = {
    contract: "expo.explore.build-comparison.v1",
    baselineBuildId: "build-1.0.0",
    currentBuildId: "build-2.0.0",
    baselineRunId: baselineMap.run.id,
    currentRunId: currentMap.run.id,
    baselineRevision: baselineMap.revision,
    currentRevision: currentMap.revision,
    entries: [
      comparisonEntry({
        id: "unchanged-home",
        relationship: "one-to-one",
        status: "unchanged",
        baselineScreenIds: ["shared-home"],
        currentScreenIds: ["shared-home"],
        pairs: [pair("shared-home", "shared-home")],
      }),
      comparisonEntry({
        id: "updated-profile",
        relationship: "one-to-one",
        status: "modified",
        changeSummary: "The profile screen was redesigned and now uses the reviewed current-state capture.",
        baselineScreenIds: ["baseline-profile"],
        currentScreenIds: ["current-profile"],
        pairs: [pair("baseline-profile", "current-profile", "reviewed")],
      }),
      comparisonEntry({
        id: "removed-legacy",
        relationship: "removed",
        status: "removed",
        changeSummary: "The legacy screen was removed from the current build.",
        baselineScreenIds: ["baseline-legacy"],
        currentScreenIds: [],
      }),
      comparisonEntry({
        id: "added-card",
        relationship: "added",
        status: "added",
        changeSummary: "A new card screen was added to the current build.",
        baselineScreenIds: [],
        currentScreenIds: ["current-added"],
      }),
      comparisonEntry({
        id: "split-settings",
        relationship: "split",
        status: "modified",
        changeSummary: "The settings screen was split into two dedicated current screens.",
        baselineScreenIds: ["baseline-split"],
        currentScreenIds: ["current-split-a", "current-split-b"],
        pairs: [
          pair("baseline-split", "current-split-a"),
          pair("baseline-split", "current-split-b"),
        ],
      }),
      comparisonEntry({
        id: "merge-controls",
        relationship: "merge",
        status: "modified",
        changeSummary: "The two legacy control screens were combined into one current controls screen.",
        baselineScreenIds: ["baseline-merge-a", "baseline-merge-b"],
        currentScreenIds: ["current-merged"],
        pairs: [
          pair("baseline-merge-a", "current-merged"),
          pair("baseline-merge-b", "current-merged"),
        ],
      }),
    ],
  };
  const comparisonPath = join(root, "comparison.json");
  await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

  const catalog = {
    contract: "expo.explore.build-catalog.v1",
    name: "Chime iOS fixture",
    currentBuildId: "build-2.0.0",
    defaultBaselineBuildId: "build-1.0.0",
    builds: [
      { id: "build-1.0.0", kind: "build", version: "1.0.0", mapDir: "baseline" },
      { id: "build-2.0.0", kind: "build", version: "2.0.0", mapDir: "current" },
    ],
    comparisons: [{
      baselineBuildId: "build-1.0.0",
      currentBuildId: "build-2.0.0",
      path: "comparison.json",
    }],
  };
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  return {
    root,
    catalogPath,
    comparisonPath,
    baselineRoot,
    currentRoot,
    catalog,
    comparison,
    baselineMap,
    currentMap,
    readCatalog: async () => JSON.parse(await readFile(catalogPath, "utf8")),
    readComparison: async () => JSON.parse(await readFile(comparisonPath, "utf8")),
  };
}
