import type {
  Artifact,
  BuildComparison,
  BuildComparisonEntry,
  BuildComparisonStatus,
  ExploreMap,
  Observation,
  Screen,
} from "../types.js";

export const REMOVED_SCREEN_PREFIX = "removed:";

export type ProjectedEvidence = {
  buildId: string;
  observationId?: string;
  artifact: Artifact;
};

export type ProjectedScreenChange = {
  id: string;
  sourceScreenId: string;
  status: BuildComparisonStatus;
  title: string;
  route?: string;
  /** The appearance this screen rendered in, when the review captured several. */
  colorScheme?: "light" | "dark";
  changeSummary: string;
  baselineScreenId?: string;
  currentScreenId?: string;
  before?: ProjectedEvidence;
  after?: ProjectedEvidence;
};

export type ComparisonProjection = {
  counts: Record<BuildComparisonStatus, number>;
  screens: ProjectedScreenChange[];
};

type MapIndex = {
  screens: Map<string, Screen>;
  observations: Map<string, Observation>;
  artifacts: Map<string, Artifact>;
};

function indexMap(map: ExploreMap): MapIndex {
  return {
    screens: new Map(map.screens.map((screen) => [screen.id, screen])),
    observations: new Map(map.observations.map((observation) => [observation.id, observation])),
    artifacts: new Map(map.artifacts.map((artifact) => [artifact.id, artifact])),
  };
}

export function removedScreenId(buildId: string, screenId: string): string {
  return `${REMOVED_SCREEN_PREFIX}${buildId}:screen:${screenId}`;
}

function observationBelongsTo(
  observationId: string,
  screenId: string,
  index: MapIndex,
): boolean {
  return index.observations.get(observationId)?.screenId === screenId;
}

function entryForScreen(
  entries: readonly BuildComparisonEntry[],
  side: "baseline" | "current",
  screenId: string,
): BuildComparisonEntry | undefined {
  return entries.find((entry) => (
    side === "baseline"
      ? entry.baselineScreenIds.includes(screenId)
      : entry.currentScreenIds.includes(screenId)
  ));
}

function pairedObservations(
  entry: BuildComparisonEntry,
  currentScreenId: string,
  currentIndex: MapIndex,
): { baseline?: string; current?: string } {
  const pair = entry.representativePairs.find((candidate) => (
    observationBelongsTo(candidate.currentObservationId, currentScreenId, currentIndex)
  ));
  return pair
    ? { baseline: pair.baselineObservationId, current: pair.currentObservationId }
    : {};
}

function representativeObservation(
  ids: readonly string[],
  screenId: string,
  index: MapIndex,
): string | undefined {
  return ids.find((id) => observationBelongsTo(id, screenId, index)) ?? ids[0];
}

function statusForCurrent(entry: BuildComparisonEntry | undefined): BuildComparisonStatus {
  if (!entry) return "added";
  if (entry.status === "needs-review" || entry.status === "source-affected" || entry.status === "not-compared" || entry.status === "unavailable" || entry.status === "variant") return entry.status;
  if (entry.relationship === "split" || entry.relationship === "merge") return "modified";
  if (entry.status === "removed") return entry.currentScreenIds.length > 0 ? "modified" : "added";
  return entry.status;
}

function fallbackChangeSummary(
  status: BuildComparisonStatus,
  beforeScreen: Screen | undefined,
  afterScreen: Screen | undefined,
): string {
  const beforeTitle = beforeScreen?.title.trim();
  const afterTitle = afterScreen?.title.trim();
  if (status === "added") return `Added “${afterTitle ?? beforeTitle ?? "screen"}”.`;
  if (status === "removed") return `Removed “${beforeTitle ?? afterTitle ?? "screen"}”.`;
  if (status === "not-compared") return `“${afterTitle ?? beforeTitle ?? "Screen"}” has not been compared.`;
  if (status === "unavailable") return `“${afterTitle ?? beforeTitle ?? "Screen"}” could not be captured; its screenshot is unavailable.`;
  if (status === "needs-review") return `“${afterTitle ?? beforeTitle ?? "Screen"}” needs review; comparison evidence is insufficient.`;
  if (status === "source-affected") return `Source affecting “${afterTitle ?? beforeTitle ?? "screen"}” changed without a confirmed runtime modification.`;
  if (status === "unchanged") {
    return `“${afterTitle ?? beforeTitle ?? "Screen"}” is unchanged.`;
  }
  if (beforeTitle && afterTitle && beforeTitle !== afterTitle) {
    return `Changed “${beforeTitle}” to “${afterTitle}”.`;
  }
  return `Changed “${afterTitle ?? beforeTitle ?? "screen"}”.`;
}

function changeSummaryFor(
  entry: BuildComparisonEntry | undefined,
  status: BuildComparisonStatus,
  beforeScreen: Screen | undefined,
  afterScreen: Screen | undefined,
): string {
  const authored = entry?.changeSummary?.trim();
  return authored || fallbackChangeSummary(status, beforeScreen, afterScreen);
}

function latestScreenshotObservation(
  screen: Screen | undefined,
  index: MapIndex,
): Observation | undefined {
  if (!screen) return undefined;
  const observations = screen.observationIds
    .map((id) => index.observations.get(id))
    .filter((observation): observation is Observation => Boolean(observation))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return observations.find((observation) => observation.screenshotArtifactId)
    ?? observations[0];
}

function evidenceForObservation(
  observationId: string | undefined,
  fallbackScreen: Screen | undefined,
  index: MapIndex,
  buildId: string,
): ProjectedEvidence | undefined {
  const selected = observationId
    ? index.observations.get(observationId)
    : undefined;
  const observation = selected?.screenshotArtifactId
    ? selected
    : latestScreenshotObservation(fallbackScreen, index);
  if (!observation?.screenshotArtifactId) return undefined;
  const artifact = index.artifacts.get(observation.screenshotArtifactId);
  return artifact
    ? { buildId, observationId: observation.id, artifact }
    : undefined;
}

function baselineWasRemoved(entry: BuildComparisonEntry | undefined): boolean {
  return !entry || entry.status === "removed" || entry.currentScreenIds.length === 0;
}

/**
 * Expand a reviewed comparison into the viewer's per-screen semantics. Split and
 * merge entries therefore count once per current screen, while baseline-only
 * screens receive the same stable namespaced id used by the viewer.
 */
export function projectComparisonScreens(options: {
  baselineBuildId: string;
  baselineMap: ExploreMap;
  currentBuildId: string;
  currentMap: ExploreMap;
  comparison: BuildComparison;
}): ComparisonProjection {
  const {
    baselineBuildId,
    baselineMap,
    currentBuildId,
    currentMap,
    comparison,
  } = options;
  const baselineIndex = indexMap(baselineMap);
  const currentIndex = indexMap(currentMap);
  const screens: ProjectedScreenChange[] = [];
  const counts: Record<BuildComparisonStatus, number> = {
    added: 0,
    modified: 0,
    removed: 0,
    unchanged: 0,
    "needs-review": 0,
    "source-affected": 0,
    "not-compared": 0,
    unavailable: 0,
    variant: 0,
  };

  for (const screen of currentMap.screens) {
    const entry = entryForScreen(comparison.entries, "current", screen.id);
    const status = statusForCurrent(entry);
    const pair = entry ? pairedObservations(entry, screen.id, currentIndex) : {};
    const currentObservationId = pair.current ?? (entry
      ? representativeObservation(
        entry.currentRepresentativeObservationIds,
        screen.id,
        currentIndex,
      )
      : undefined);
    const pairedBaselineScreen = pair.baseline
      ? baselineIndex.screens.get(baselineIndex.observations.get(pair.baseline)?.screenId ?? "")
      : undefined;
    const baselineScreen = pairedBaselineScreen ?? entry?.baselineScreenIds
      .map((id) => baselineIndex.screens.get(id))
      .find((candidate): candidate is Screen => Boolean(candidate));
    const baselineObservationId = pair.baseline ?? (entry && baselineScreen
      ? representativeObservation(
        entry.baselineRepresentativeObservationIds,
        baselineScreen.id,
        baselineIndex,
      )
      : undefined);
    const before = status === "added"
      ? undefined
      : evidenceForObservation(
        baselineObservationId,
        baselineScreen,
        baselineIndex,
        baselineBuildId,
      );
    const after = evidenceForObservation(
      currentObservationId,
      screen,
      currentIndex,
      currentBuildId,
    );
    counts[status] += 1;
    screens.push({
      id: screen.id,
      sourceScreenId: screen.id,
      status,
      title: screen.title,
      changeSummary: changeSummaryFor(entry, status, baselineScreen, screen),
      currentScreenId: screen.id,
      ...(screen.route ? { route: screen.route } : {}),
      ...(screen.colorScheme ? { colorScheme: screen.colorScheme } : {}),
      ...(baselineScreen ? { baselineScreenId: baselineScreen.id } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  }

  for (const screen of baselineMap.screens) {
    const entry = entryForScreen(comparison.entries, "baseline", screen.id);
    if (!baselineWasRemoved(entry)) continue;
    const observationId = entry
      ? representativeObservation(
        entry.baselineRepresentativeObservationIds,
        screen.id,
        baselineIndex,
      )
      : undefined;
    const before = evidenceForObservation(
      observationId,
      screen,
      baselineIndex,
      baselineBuildId,
    );
    const status = entry && ["needs-review", "source-affected", "not-compared", "unavailable"].includes(entry.status) ? entry.status : "removed";
    counts[status] += 1;
    screens.push({
      id: removedScreenId(baselineBuildId, screen.id),
      sourceScreenId: screen.id,
      status,
      title: screen.title,
      changeSummary: changeSummaryFor(entry, status, screen, undefined),
      baselineScreenId: screen.id,
      ...(screen.route ? { route: screen.route } : {}),
      ...(screen.colorScheme ? { colorScheme: screen.colorScheme } : {}),
      ...(before ? { before } : {}),
    });
  }

  return { counts, screens };
}
