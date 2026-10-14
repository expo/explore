import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Builds local maps through the same store API that CI capture uses (src/capture/run.ts),
// now that the CLI no longer offers map-writing commands.
const root = resolve(import.meta.dirname, "../..");
const { ExploreStore, addGap, newId, now, recordObservation } = await import(join(root, "dist", "map", "store.js"));
const { parseControllerOutput } = await import(join(root, "dist", "capture", "controller-output.js"));
const { CONTRACT } = await import(join(root, "dist", "types.js"));

export function emptyMap(name) {
  const timestamp = now();
  return {
    contract: CONTRACT,
    revision: 0,
    run: {
      id: newId("run"),
      name,
      platform: "ios",
      controller: "agent-device",
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
      build: {},
      environment: {},
      limits: { maxScreens: 30, maxActions: 100, maxDurationMinutes: 30 },
    },
    artifacts: [],
    screens: [],
    variants: [],
    observations: [],
    elements: [],
    actionAttempts: [],
    transitions: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
}

/** Initializes `<cwd>/.explore` and returns its store. */
export async function createMapStore(cwd, name) {
  const store = new ExploreStore(join(cwd, ".explore"));
  await store.initialize(emptyMap(name), false);
  return store;
}

/** Records one observation, as a capture would, and writes it. */
export async function addScreen(store, { id, title, screenshotPath, snapshotPath, fingerprint, start = false }) {
  const map = await store.read();
  const snapshotText = snapshotPath ? await readFile(snapshotPath, "utf8") : undefined;
  const parsed = snapshotText
    ? parseControllerOutput(map.run.controller, snapshotText)
    : { elements: [], warnings: [] };
  const result = await recordObservation({
    store,
    map,
    title,
    screenId: id,
    elements: parsed.elements,
    parseWarnings: parsed.warnings,
    ...(screenshotPath ? { screenshotPath } : {}),
    ...(snapshotPath ? { snapshotPath, snapshotText } : {}),
    ...(fingerprint ? { explicitFingerprint: fingerprint } : {}),
    surfaceScope: "app",
    start,
    terminal: false,
    depth: start ? 0 : 1,
  });
  await store.write(map, result.preparedArtifacts);
  const { preparedArtifacts: _prepared, ...recorded } = result;
  return { ...recorded, revision: map.revision };
}

/** Adds an open coverage gap and writes it, which advances the map revision. */
export async function addCoverageGap(store, { kind = "coverage", message }) {
  const map = await store.read();
  const gap = addGap(map, { kind, message });
  await store.write(map);
  return { gap, revision: map.revision };
}
