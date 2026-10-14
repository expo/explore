import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ExploreError, ExploreStore, getCoverage, validateMap } from "./store.js";
import {
  type BuildCatalog,
  type BuildCatalogBuild,
  type BuildCatalogComparison,
  type BuildComparison,
  type BuildComparisonEntry,
  type BuildWorkspacePayload,
  type Coverage,
  type ExploreMap,
  type Observation,
} from "../types.js";

const catalogSchemaPath = fileURLToPath(
  new URL("../../schema/build-catalog.v1.schema.json", import.meta.url),
);
const comparisonSchemaPath = fileURLToPath(
  new URL("../../schema/build-comparison.v1.schema.json", import.meta.url),
);

let catalogValidator: ValidateFunction | undefined;
let comparisonValidator: ValidateFunction | undefined;

export type LoadedBuildWorkspaceBuild = {
  descriptor: BuildCatalogBuild;
  root: string;
  store: ExploreStore;
  map: ExploreMap;
  coverage: Coverage;
};

export type LoadedBuildWorkspace = {
  catalogPath: string;
  catalog: BuildCatalog;
  builds: Map<string, LoadedBuildWorkspaceBuild>;
  comparison: BuildComparison;
  comparisonPath: string;
};

function schemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
}

async function schemaValidator(
  path: string,
  cached: ValidateFunction | undefined,
): Promise<ValidateFunction> {
  if (cached) return cached;
  const schema = JSON.parse(await readFile(path, "utf8")) as object;
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
}

async function getCatalogValidator(): Promise<ValidateFunction> {
  catalogValidator = await schemaValidator(catalogSchemaPath, catalogValidator);
  return catalogValidator;
}

async function getComparisonValidator(): Promise<ValidateFunction> {
  comparisonValidator = await schemaValidator(comparisonSchemaPath, comparisonValidator);
  return comparisonValidator;
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new ExploreError(`Could not read ${label} at ${path}: ${String(error)}`);
  }
}

function isWithinOrSame(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertNoSymlinkComponents(
  root: string,
  candidate: string,
  label: string,
): Promise<void> {
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new ExploreError(`${label} must not traverse symbolic links: ${cursor}`);
    }
  }
}

async function canonicalFile(path: string, label: string): Promise<string> {
  const declared = resolve(path);
  let canonical: string;
  try {
    const declaredInfo = await lstat(declared);
    if (!declaredInfo.isFile() || declaredInfo.isSymbolicLink()) {
      throw new ExploreError(`${label} is not a regular file: ${declared}`);
    }
    canonical = await realpath(declared);
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ExploreError(`${label} is not a regular file: ${canonical}`);
    }
  } catch (error) {
    if (error instanceof ExploreError) throw error;
    throw new ExploreError(`Could not open ${label} at ${declared}: ${String(error)}`);
  }
  return canonical;
}

async function resolveCatalogPath(
  root: string,
  declaredPath: string,
  label: string,
  kind: "file" | "directory",
): Promise<string> {
  if (isAbsolute(declaredPath)) {
    throw new ExploreError(`${label} must be relative to the build catalog: ${declaredPath}`);
  }
  const candidate = resolve(root, declaredPath);
  if (!isWithinOrSame(root, candidate)) {
    throw new ExploreError(`${label} escapes the build catalog directory: ${declaredPath}`);
  }
  let canonical: string;
  try {
    await assertNoSymlinkComponents(root, candidate, label);
    const declaredInfo = await lstat(candidate);
    const validDeclaredKind = kind === "file"
      ? declaredInfo.isFile()
      : declaredInfo.isDirectory();
    if (!validDeclaredKind || declaredInfo.isSymbolicLink()) {
      throw new ExploreError(`${label} is not a ${kind}: ${candidate}`);
    }
    canonical = await realpath(candidate);
    const info = await lstat(canonical);
    const validKind = kind === "file" ? info.isFile() : info.isDirectory();
    if (!validKind || info.isSymbolicLink()) {
      throw new ExploreError(`${label} is not a ${kind}: ${canonical}`);
    }
  } catch (error) {
    if (error instanceof ExploreError) throw error;
    throw new ExploreError(`Could not open ${label} at ${candidate}: ${String(error)}`);
  }
  if (!isWithinOrSame(root, canonical)) {
    throw new ExploreError(`${label} resolves outside the build catalog directory: ${declaredPath}`);
  }
  return canonical;
}

function validateCatalog(catalog: BuildCatalog): void {
  const errors: string[] = [];
  const buildIds = new Set<string>();
  for (const build of catalog.builds) {
    if (buildIds.has(build.id)) errors.push(`build id must be unique: ${build.id}`);
    buildIds.add(build.id);
  }
  if (!buildIds.has(catalog.currentBuildId)) {
    errors.push(`currentBuildId does not resolve to a catalog build: ${catalog.currentBuildId}`);
  }
  if (!buildIds.has(catalog.defaultBaselineBuildId)) {
    errors.push(
      `defaultBaselineBuildId does not resolve to a catalog build: ${catalog.defaultBaselineBuildId}`,
    );
  }
  if (catalog.currentBuildId === catalog.defaultBaselineBuildId) {
    errors.push("currentBuildId and defaultBaselineBuildId must be different builds");
  }

  const comparisonPairs = new Set<string>();
  const comparisonPaths = new Set<string>();
  for (const comparison of catalog.comparisons) {
    if (!buildIds.has(comparison.baselineBuildId)) {
      errors.push(`comparison baseline build is unknown: ${comparison.baselineBuildId}`);
    }
    if (!buildIds.has(comparison.currentBuildId)) {
      errors.push(`comparison current build is unknown: ${comparison.currentBuildId}`);
    }
    if (comparison.baselineBuildId === comparison.currentBuildId) {
      errors.push(`comparison must use two different builds: ${comparison.currentBuildId}`);
    }
    const pair = `${comparison.currentBuildId}\0${comparison.baselineBuildId}`;
    if (comparisonPairs.has(pair)) {
      errors.push(
        `comparison pair must be unique: ${comparison.currentBuildId} vs ${comparison.baselineBuildId}`,
      );
    }
    comparisonPairs.add(pair);
    if (comparisonPaths.has(comparison.path)) {
      errors.push(`comparison path must be unique: ${comparison.path}`);
    }
    comparisonPaths.add(comparison.path);
  }
  const defaultPair = `${catalog.currentBuildId}\0${catalog.defaultBaselineBuildId}`;
  if (!comparisonPairs.has(defaultPair)) {
    errors.push(
      `no comparison resolves current ${catalog.currentBuildId} against default baseline ${catalog.defaultBaselineBuildId}`,
    );
  }
  if (errors.length > 0) {
    throw new ExploreError(`Invalid build catalog: ${errors.join("; ")}`);
  }
}

async function loadBuild(
  root: string,
  descriptor: BuildCatalogBuild,
): Promise<LoadedBuildWorkspaceBuild> {
  const buildRoot = await resolveCatalogPath(
    root,
    descriptor.mapDir,
    `mapDir for build ${descriptor.id}`,
    "directory",
  );
  const store = new ExploreStore(buildRoot);
  const map = await store.read();
  const errors = await validateMap(map, store);
  if (errors.length > 0) {
    throw new ExploreError(`Invalid map for build ${descriptor.id}: ${errors.join("; ")}`);
  }
  if (map.run.build.id !== descriptor.id) {
    throw new ExploreError(
      `Invalid map for build ${descriptor.id}: run.build.id ${map.run.build.id ?? "is missing"} does not match the catalog descriptor`,
    );
  }
  if (map.run.build.version !== descriptor.version) {
    throw new ExploreError(
      `Invalid map for build ${descriptor.id}: run.build.version ${map.run.build.version ?? "is missing"} does not match catalog version ${descriptor.version}`,
    );
  }
  return { descriptor, root: buildRoot, store, map, coverage: getCoverage(map) };
}

function relationshipErrors(entry: BuildComparisonEntry): string[] {
  const baseline = entry.baselineScreenIds.length;
  const current = entry.currentScreenIds.length;
  switch (entry.relationship) {
    case "one-to-one":
      return baseline === 1 && current === 1 && ["modified", "unchanged", "needs-review", "source-affected", "not-compared"].includes(entry.status)
        ? []
        : ["one-to-one requires one screen per side and a paired comparison status"];
    case "split":
      return baseline === 1 && current >= 2 && ["modified", "needs-review", "source-affected", "not-compared"].includes(entry.status)
        ? []
        : ["split requires one baseline, at least two current screens, and status modified, needs-review, or source-affected"];
    case "merge":
      return baseline >= 2 && current === 1 && ["modified", "needs-review", "source-affected", "not-compared"].includes(entry.status)
        ? []
        : ["merge requires at least two baseline screens, one current screen, and status modified, needs-review, or source-affected"];
    case "added":
      return baseline === 0 && current >= 1 && ["added", "needs-review", "source-affected", "not-compared"].includes(entry.status)
        ? []
        : ["added requires no baseline screens, at least one current screen, and status added or an uncertain capture status"];
    case "removed":
      return baseline >= 1 && current === 0 && ["removed", "needs-review", "source-affected", "not-compared"].includes(entry.status)
        ? []
        : ["removed requires at least one baseline screen, no current screens, and status removed or an uncertain capture status"];
  }
}

type SideIndex = {
  map: ExploreMap;
  screens: Map<string, ExploreMap["screens"][number]>;
  observations: Map<string, Observation>;
  artifacts: Map<string, ExploreMap["artifacts"][number]>;
};

function sideIndex(map: ExploreMap): SideIndex {
  return {
    map,
    screens: new Map(map.screens.map((screen) => [screen.id, screen])),
    observations: new Map(map.observations.map((observation) => [observation.id, observation])),
    artifacts: new Map(map.artifacts.map((artifact) => [artifact.id, artifact])),
  };
}

function validateRepresentativeObservations(options: {
  entry: BuildComparisonEntry;
  side: "baseline" | "current";
  screenIds: string[];
  observationIds: string[];
  index: SideIndex;
}): { observations: Map<string, Observation>; errors: string[] } {
  const { entry, side, screenIds, observationIds, index } = options;
  const allowedScreens = new Set(screenIds);
  const representedScreens = new Set<string>();
  const observations = new Map<string, Observation>();
  const errors: string[] = [];
  for (const observationId of observationIds) {
    const observation = index.observations.get(observationId);
    if (!observation) {
      errors.push(`${side} representative observation is unknown: ${observationId}`);
      continue;
    }
    observations.set(observationId, observation);
    if (!allowedScreens.has(observation.screenId)) {
      errors.push(
        `${side} representative observation ${observationId} does not belong to an entry screen`,
      );
      continue;
    }
    representedScreens.add(observation.screenId);
    if (!observation.screenshotArtifactId) {
      errors.push(`${side} representative observation has no screenshot: ${observationId}`);
      continue;
    }
    const artifact = index.artifacts.get(observation.screenshotArtifactId);
    if (!artifact || artifact.kind !== "screenshot") {
      errors.push(
        `${side} representative observation has no valid screenshot artifact: ${observationId}`,
      );
    }
  }
  for (const screenId of allowedScreens) {
    if (!representedScreens.has(screenId) && !["needs-review", "source-affected", "not-compared"].includes(entry.status)) {
      errors.push(`${side} screen has no representative observation in entry ${entry.id}: ${screenId}`);
    }
  }
  return { observations, errors };
}

function validateComparison(
  comparison: BuildComparison,
  expected: { baselineBuildId: string; currentBuildId: string },
  baselineMap: ExploreMap,
  currentMap: ExploreMap,
): void {
  const errors: string[] = [];
  if (comparison.baselineBuildId !== expected.baselineBuildId) {
    errors.push(
      `baselineBuildId ${comparison.baselineBuildId} does not match catalog ${expected.baselineBuildId}`,
    );
  }
  if (comparison.currentBuildId !== expected.currentBuildId) {
    errors.push(
      `currentBuildId ${comparison.currentBuildId} does not match catalog ${expected.currentBuildId}`,
    );
  }
  if (comparison.baselineRunId !== baselineMap.run.id) {
    errors.push(
      `baselineRunId ${comparison.baselineRunId} does not match map ${baselineMap.run.id}`,
    );
  }
  if (comparison.currentRunId !== currentMap.run.id) {
    errors.push(`currentRunId ${comparison.currentRunId} does not match map ${currentMap.run.id}`);
  }
  if (comparison.baselineRevision !== baselineMap.revision) {
    errors.push(
      `baselineRevision ${comparison.baselineRevision} does not match map ${baselineMap.revision}`,
    );
  }
  if (comparison.currentRevision !== currentMap.revision) {
    errors.push(
      `currentRevision ${comparison.currentRevision} does not match map ${currentMap.revision}`,
    );
  }

  const baselineIndex = sideIndex(baselineMap);
  const currentIndex = sideIndex(currentMap);
  const entryIds = new Set<string>();
  const coveredBaselineScreens = new Map<string, string>();
  const coveredCurrentScreens = new Map<string, string>();

  for (const entry of comparison.entries) {
    if (entryIds.has(entry.id)) errors.push(`entry id must be unique: ${entry.id}`);
    entryIds.add(entry.id);
    errors.push(...relationshipErrors(entry).map((message) => `entry ${entry.id}: ${message}`));

    for (const screenId of entry.baselineScreenIds) {
      if (!baselineIndex.screens.has(screenId)) {
        errors.push(`entry ${entry.id} references unknown baseline screen: ${screenId}`);
      }
      const owner = coveredBaselineScreens.get(screenId);
      if (owner) {
        errors.push(`baseline screen ${screenId} appears in both entries ${owner} and ${entry.id}`);
      } else {
        coveredBaselineScreens.set(screenId, entry.id);
      }
    }
    for (const screenId of entry.currentScreenIds) {
      if (!currentIndex.screens.has(screenId)) {
        errors.push(`entry ${entry.id} references unknown current screen: ${screenId}`);
      }
      const owner = coveredCurrentScreens.get(screenId);
      if (owner) {
        errors.push(`current screen ${screenId} appears in both entries ${owner} and ${entry.id}`);
      } else {
        coveredCurrentScreens.set(screenId, entry.id);
      }
    }

    const baselineRepresentatives = validateRepresentativeObservations({
      entry,
      side: "baseline",
      screenIds: entry.baselineScreenIds,
      observationIds: entry.baselineRepresentativeObservationIds,
      index: baselineIndex,
    });
    const currentRepresentatives = validateRepresentativeObservations({
      entry,
      side: "current",
      screenIds: entry.currentScreenIds,
      observationIds: entry.currentRepresentativeObservationIds,
      index: currentIndex,
    });
    errors.push(...baselineRepresentatives.errors.map((message) => `entry ${entry.id}: ${message}`));
    errors.push(...currentRepresentatives.errors.map((message) => `entry ${entry.id}: ${message}`));

    const pairedBaselineScreens = new Set<string>();
    const pairedCurrentScreens = new Set<string>();
    for (const pair of entry.representativePairs) {
      const baselineObservation = baselineRepresentatives.observations.get(
        pair.baselineObservationId,
      );
      const currentObservation = currentRepresentatives.observations.get(pair.currentObservationId);
      if (!baselineObservation) {
        errors.push(
          `entry ${entry.id} pair references a non-representative baseline observation: ${pair.baselineObservationId}`,
        );
      } else {
        pairedBaselineScreens.add(baselineObservation.screenId);
      }
      if (!currentObservation) {
        errors.push(
          `entry ${entry.id} pair references a non-representative current observation: ${pair.currentObservationId}`,
        );
      } else {
        pairedCurrentScreens.add(currentObservation.screenId);
      }
    }
    if (!["added", "removed"].includes(entry.relationship) && !["needs-review", "source-affected", "not-compared"].includes(entry.status)) {
      for (const screenId of entry.baselineScreenIds) {
        if (!pairedBaselineScreens.has(screenId)) {
          errors.push(`entry ${entry.id} baseline screen is absent from representative pairs: ${screenId}`);
        }
      }
      for (const screenId of entry.currentScreenIds) {
        if (!pairedCurrentScreens.has(screenId)) {
          errors.push(`entry ${entry.id} current screen is absent from representative pairs: ${screenId}`);
        }
      }
    }
  }

  for (const screen of baselineMap.screens) {
    if (!coveredBaselineScreens.has(screen.id)) {
      errors.push(`baseline screen is not resolved by any comparison entry: ${screen.id}`);
    }
  }
  for (const screen of currentMap.screens) {
    if (!coveredCurrentScreens.has(screen.id)) {
      errors.push(`current screen is not resolved by any comparison entry: ${screen.id}`);
    }
  }
  if (errors.length > 0) {
    throw new ExploreError(`Invalid build comparison: ${errors.join("; ")}`);
  }
}

/** The serializable workspace shape served by the local viewer and static exports. */
export function buildWorkspacePayload(workspace: LoadedBuildWorkspace): BuildWorkspacePayload {
  return {
    catalog: workspace.catalog,
    builds: Object.fromEntries([...workspace.builds].map(([buildId, build]) => [
      buildId,
      { map: build.map, coverage: build.coverage },
    ])),
    comparison: workspace.comparison,
  };
}

/**
 * Validate a comparison document against its two source maps with exactly the
 * rules the workspace loader applies, including the JSON Schema. Used by the
 * compare generator so an emitted document can never fail a later load.
 */
export async function validateComparisonDocument(
  comparison: BuildComparison,
  baselineMap: ExploreMap,
  currentMap: ExploreMap,
): Promise<void> {
  const validate = await getComparisonValidator();
  if (!validate(comparison)) {
    throw new ExploreError(
      `Invalid build comparison schema: ${schemaErrors(validate.errors).join("; ")}`,
    );
  }
  validateComparison(
    comparison,
    { baselineBuildId: comparison.baselineBuildId, currentBuildId: comparison.currentBuildId },
    baselineMap,
    currentMap,
  );
}

async function loadComparison(
  root: string,
  descriptor: BuildCatalogComparison,
  builds: Map<string, LoadedBuildWorkspaceBuild>,
): Promise<{ comparison: BuildComparison; path: string }> {
  const path = await resolveCatalogPath(
    root,
    descriptor.path,
    `comparison ${descriptor.currentBuildId} vs ${descriptor.baselineBuildId}`,
    "file",
  );
  const value = await readJson(path, "build comparison");
  const validate = await getComparisonValidator();
  if (!validate(value)) {
    throw new ExploreError(
      `Invalid build comparison schema at ${path}: ${schemaErrors(validate.errors).join("; ")}`,
    );
  }
  const comparison = value as BuildComparison;
  const baseline = builds.get(descriptor.baselineBuildId);
  const current = builds.get(descriptor.currentBuildId);
  if (!baseline || !current) {
    throw new ExploreError(
      `Build comparison is unresolved: ${descriptor.currentBuildId} vs ${descriptor.baselineBuildId}`,
    );
  }
  validateComparison(comparison, descriptor, baseline.map, current.map);
  return { comparison, path };
}

/**
 * Load a build catalog and all referenced evidence, returning only after every map, artifact,
 * cross-build screen, and representative screenshot has passed structural and semantic checks.
 */
export async function loadBuildWorkspace(catalogPath: string): Promise<LoadedBuildWorkspace> {
  const canonicalCatalogPath = await canonicalFile(catalogPath, "build catalog");
  const root = await realpath(dirname(canonicalCatalogPath));
  const value = await readJson(canonicalCatalogPath, "build catalog");
  const validate = await getCatalogValidator();
  if (!validate(value)) {
    throw new ExploreError(
      `Invalid build catalog schema at ${canonicalCatalogPath}: ${schemaErrors(validate.errors).join("; ")}`,
    );
  }
  const catalog = value as BuildCatalog;
  validateCatalog(catalog);

  const loadedBuilds = await Promise.all(
    catalog.builds.map(async (descriptor) => await loadBuild(root, descriptor)),
  );
  const builds = new Map<string, LoadedBuildWorkspaceBuild>();
  const buildRoots = new Map<string, string>();
  for (const build of loadedBuilds) {
    const priorId = buildRoots.get(build.root);
    if (priorId) {
      throw new ExploreError(
        `Invalid build catalog: builds ${priorId} and ${build.descriptor.id} resolve to the same map directory`,
      );
    }
    buildRoots.set(build.root, build.descriptor.id);
    builds.set(build.descriptor.id, build);
  }

  let selected:
    | { comparison: BuildComparison; path: string }
    | undefined;
  for (const descriptor of catalog.comparisons) {
    const loaded = await loadComparison(root, descriptor, builds);
    if (
      descriptor.currentBuildId === catalog.currentBuildId
      && descriptor.baselineBuildId === catalog.defaultBaselineBuildId
    ) {
      selected = loaded;
    }
  }
  if (!selected) {
    throw new ExploreError(
      `Build catalog has no resolved default comparison for ${catalog.currentBuildId} vs ${catalog.defaultBaselineBuildId}`,
    );
  }
  return {
    catalogPath: canonicalCatalogPath,
    catalog,
    builds,
    comparison: selected.comparison,
    comparisonPath: selected.path,
  };
}
