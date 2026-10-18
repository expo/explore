import type {
  Artifact,
  BuildCatalog,
  BuildCatalogBuild,
  BuildComparison,
  BuildWorkspacePayload,
  ExploreMap,
  Observation,
  Screen,
} from "../../../src/types";
import {
  projectComparisonScreens,
  REMOVED_SCREEN_PREFIX,
  removedScreenId,
} from "../../../src/contracts/comparison-projection";
import {
  artifactUrl,
  indexMap,
  screenshotForScreen,
  type MapIndex,
} from "./model";
import {
  reviewSurfaceFor,
  type ReviewerChangeFact,
  type CaptureNotes,
  type ReviewVisualDiff,
  type ViewerReviewProjection,
} from "./review-model";
import { projectSourceNavigation } from "./source-navigation";

export type ViewerBuild = BuildCatalogBuild;
export type ViewerWorkspace = BuildWorkspacePayload;
/** `variant`: a source-unchanged screen captured in another runtime UI state; not a change. */
export type DiffStatus = "added" | "modified" | "removed" | "unchanged" | "needs-review" | "source-affected" | "not-compared" | "unavailable" | "variant";

export const DIFF_LABELS: Record<DiffStatus, string> = {
  added: "Added",
  modified: "Modified",
  removed: "Removed",
  unchanged: "Unchanged",
  "needs-review": "No visible change",
  "source-affected": "Source-affected",
  "not-compared": "Not compared",
  unavailable: "Unavailable",
  variant: "Screen variant",
};

export type ScreenDiff = {
  status: DiffStatus;
  changeSummary: string;
  /** Optional explanation shown in the existing What changed slot. */
  note?: string;
  beforeScreenshot?: string;
  afterScreenshot?: string;
  /** The compared screenshot's recorded width over its height (After's when it has one), so a frame takes its shape before it loads. */
  screenshotAspect?: number;
  /** The CI pixel comparison of the two screenshots, when both captures were verified. */
  visual?: ReviewVisualDiff;
  /** Why a side that exists in its revision has no screenshot. */
  captureNotes?: CaptureNotes;
  /** Set when the screenshots belong to the route this redirect declares, not to the redirect. */
  redirectTo?: string;
  /** Every route a redirect declaration can reach; set only when it renders no screen itself. */
  redirectTargets?: string[];
  baselineScreenId?: string;
  currentScreenId?: string;
  baselineObservationId?: string;
  currentObservationId?: string;
  reviewerChanges: ReviewerChangeFact[];
  runtimeEvidenceRefs: string[];
  noVisibleChange: boolean;
  /**
   * Modified only in what assistive technology reads (the accessibility tree): the screenshots match, so there is
   * nothing to outline. Screen readers and voice control still see the change, so it is reviewed like any other.
   */
  accessibilityOnly?: true;
};

/** Why Highlight changes is off for an accessibility-only change. */
export const ACCESSIBILITY_ONLY_HIGHLIGHT = "Nothing to highlight: only what assistive technology reads changed";

/** A screen's status as the Viewer names it: a modified screen whose screenshots match changed for assistive technology only. */
export function diffLabel(diff: Pick<ScreenDiff, "status" | "accessibilityOnly">): string {
  return isAccessibilityOnly(diff) ? "Accessibility only" : DIFF_LABELS[diff.status];
}

export function isAccessibilityOnly(diff: Pick<ScreenDiff, "status" | "accessibilityOnly"> | undefined): boolean {
  return diff?.status === "modified" && Boolean(diff.accessibilityOnly);
}

/** The class that colours a screen's status: an accessibility-only change keeps Modified's frame in its own colour. */
export function diffClass(diff: Pick<ScreenDiff, "status" | "accessibilityOnly">): string {
  return isAccessibilityOnly(diff) ? "diff-modified diff-accessibility-only" : `diff-${diff.status}`;
}

export type BuildDiff = {
  baselineId: string;
  screens: Map<string, ScreenDiff>;
  /** Current-build content plus namespaced, real screens that exist only in the baseline. */
  map: ExploreMap;
  index: MapIndex;
  counts: Record<DiffStatus, number>;
};

export const REMOVED_PREFIX = REMOVED_SCREEN_PREFIX;

export function routeContextForCatalog(catalog: BuildCatalog | undefined): {
  defaultBaseline: string;
  baselines: string[];
} {
  if (!catalog) return { defaultBaseline: "", baselines: [] };
  const hasDefaultBaseline = catalog.defaultBaselineBuildId !== catalog.currentBuildId
    && catalog.builds.some((build) => build.id === catalog.defaultBaselineBuildId);
  return {
    defaultBaseline: hasDefaultBaseline ? catalog.defaultBaselineBuildId : "",
    baselines: hasDefaultBaseline ? [catalog.defaultBaselineBuildId] : [],
  };
}

export function comparisonFor(
  workspace: ViewerWorkspace,
  currentBuildId: string,
  baselineBuildId: string,
): BuildComparison | undefined {
  return workspace.comparison.currentBuildId === currentBuildId
    && workspace.comparison.baselineBuildId === baselineBuildId
    ? workspace.comparison
    : undefined;
}

type BuildScopedArtifact = Artifact & { viewerBuildId?: string };

function withBuildScope(artifact: Artifact, buildId: string): BuildScopedArtifact {
  return { ...artifact, viewerBuildId: buildId };
}

/**
 * Workspace artifacts are served from a build-qualified endpoint. The local-map fallback keeps
 * using the legacy endpoint, so scope is added only to maps loaded through `/api/workspace`.
 */
export function scopeMapArtifacts(map: ExploreMap, buildId: string): ExploreMap {
  return { ...map, artifacts: map.artifacts.map((artifact) => withBuildScope(artifact, buildId)) };
}

function namespacedId(buildId: string, kind: string, id: string, prefix = REMOVED_PREFIX): string {
  return `${prefix}${buildId}:${kind}:${id}`;
}

export function baselineContextScreenId(buildId: string, id: string): string {
  return namespacedId(buildId, "screen", id, "baseline-context:");
}

const BASELINE_SCREEN_ID = /^(?:removed|baseline-context):.+?:screen:(.+)$/;

/** The id a baseline-only screen (removed, or shown for context) has in its own build and review; others are unchanged. */
export function sourceScreenId(id: string): string {
  return BASELINE_SCREEN_ID.exec(id)?.[1] ?? id;
}

function cloneRemovedEvidence(
  baseline: ExploreMap,
  baselineBuildId: string,
  removed: readonly Screen[],
  contextOnly = false,
): Pick<ExploreMap, "screens" | "variants" | "observations" | "elements" | "artifacts"> {
  const screenIds = new Set(removed.map((screen) => screen.id));
  const variants = baseline.variants.filter((variant) => screenIds.has(variant.screenId));
  const variantIds = new Set(variants.map((variant) => variant.id));
  const observations = baseline.observations.filter((observation) => (
    screenIds.has(observation.screenId) || variantIds.has(observation.variantId)
  ));
  const observationIds = new Set(observations.map((observation) => observation.id));
  const elements = baseline.elements.filter((element) => (
    screenIds.has(element.screenId)
      || element.observationIds.some((observationId) => observationIds.has(observationId))
  ));
  const elementIds = new Set(elements.map((element) => element.id));
  const artifactIds = new Set(observations.flatMap((observation) => [
    observation.screenshotArtifactId,
    observation.accessibilityArtifactId,
  ].filter((id): id is string => Boolean(id))));

  const screenId = (id: string) => contextOnly ? baselineContextScreenId(baselineBuildId, id) : removedScreenId(baselineBuildId, id);
  const prefix = contextOnly ? "baseline-context:" : REMOVED_PREFIX;
  const variantId = (id: string) => namespacedId(baselineBuildId, "variant", id, prefix);
  const observationId = (id: string) => namespacedId(baselineBuildId, "observation", id, prefix);
  const elementId = (id: string) => namespacedId(baselineBuildId, "element", id, prefix);
  const artifactId = (id: string) => namespacedId(baselineBuildId, "artifact", id, prefix);

  return {
    screens: removed.map((screen) => ({
      ...screen,
      id: screenId(screen.id),
      start: baseline.sourceNavigation ? screen.start : false,
      variantIds: screen.variantIds.filter((id) => variantIds.has(id)).map(variantId),
      observationIds: screen.observationIds
        .filter((id) => observationIds.has(id))
        .map(observationId),
      elementIds: screen.elementIds.filter((id) => elementIds.has(id)).map(elementId),
    })),
    variants: variants.map((variant) => ({
      ...variant,
      id: variantId(variant.id),
      screenId: screenId(variant.screenId),
      observationIds: variant.observationIds
        .filter((id) => observationIds.has(id))
        .map(observationId),
    })),
    observations: observations.map((observation): Observation => ({
      ...observation,
      id: observationId(observation.id),
      screenId: screenId(observation.screenId),
      variantId: variantId(observation.variantId),
      elementIds: observation.elementIds.filter((id) => elementIds.has(id)).map(elementId),
      elements: observation.elements.map((element) => ({
        ...element,
        elementId: elementId(element.elementId),
      })),
      ...(observation.screenshotArtifactId
        ? { screenshotArtifactId: artifactId(observation.screenshotArtifactId) }
        : {}),
      ...(observation.accessibilityArtifactId
        ? { accessibilityArtifactId: artifactId(observation.accessibilityArtifactId) }
        : {}),
    })),
    elements: elements.map((element) => ({
      ...element,
      id: elementId(element.id),
      screenId: screenId(element.screenId),
      firstSeenObservationId: observationId(element.firstSeenObservationId),
      lastSeenObservationId: observationId(element.lastSeenObservationId),
      observationIds: element.observationIds
        .filter((id) => observationIds.has(id))
        .map(observationId),
    })),
    artifacts: baseline.artifacts
      .filter((artifact) => artifactIds.has(artifact.id))
      .map((artifact) => withBuildScope({ ...artifact, id: artifactId(artifact.id) }, baselineBuildId)),
  };
}

function assertNoIdCollisions(
  collection: string,
  current: readonly { id: string }[],
  imported: readonly { id: string }[],
): void {
  const currentIds = new Set(current.map((entry) => entry.id));
  const collision = imported.find((entry) => currentIds.has(entry.id));
  if (collision) {
    throw new Error(`Baseline-only ${collection} id collides with the current map: ${collision.id}`);
  }
}

export function buildDiff(options: {
  currentBuild: ViewerBuild;
  currentMap: ExploreMap;
  baselineBuild: ViewerBuild;
  baselineMap: ExploreMap;
  comparison: BuildComparison;
  review?: ViewerReviewProjection | undefined;
}): BuildDiff {
  const {
    currentBuild,
    currentMap,
    baselineBuild,
    baselineMap,
    comparison,
    review,
  } = options;
  const baselineIndex = indexMap(baselineMap);
  const projection = projectComparisonScreens({
    currentBuildId: currentBuild.id,
    currentMap,
    baselineBuildId: baselineBuild.id,
    baselineMap,
    comparison,
  });
  const removed = projection.screens
    .filter((screen) => !screen.currentScreenId)
    .map((screen) => baselineIndex.screens.get(screen.sourceScreenId))
    .filter((screen): screen is Screen => Boolean(screen));
  const removedEvidence = cloneRemovedEvidence(baselineMap, baselineBuild.id, removed);
  const removedIds = new Set(removed.map(screen => screen.id));
  const currentIds = new Set(currentMap.screens.map(screen => screen.id));
  const baselineContext = baselineMap.sourceNavigation ? baselineMap.screens.filter(screen => !removedIds.has(screen.id) && !currentIds.has(screen.id)) : [];
  const baselineContextIds = new Set(baselineContext.map(screen => screen.id));
  const contextEvidence = cloneRemovedEvidence(baselineMap, baselineBuild.id, baselineContext, true);
  const baselineId = (id: string) => currentIds.has(id) ? id : removedIds.has(id)
    ? removedScreenId(baselineBuild.id, id) : baselineContextIds.has(id)
      ? baselineContextScreenId(baselineBuild.id, id) : undefined;
  const baselineGaps = baselineMap.gaps.flatMap(gap => {
    const { observationId, ...details } = gap;
    const observation = observationId && gap.screenId
      ? removedIds.has(gap.screenId) ? namespacedId(baselineBuild.id, "observation", observationId)
        : baselineContextIds.has(gap.screenId) ? namespacedId(baselineBuild.id, "observation", observationId, "baseline-context:") : undefined
      : undefined;
    const targets = gap.screenId ? [...new Set([
      ...projection.screens.filter(screen => screen.baselineScreenId === gap.screenId).map(screen => screen.id),
      ...(baselineContextIds.has(gap.screenId) ? [baselineContextScreenId(baselineBuild.id, gap.screenId)] : []),
    ])] : [undefined];
    return targets.map(screenId => ({ ...details,
      id: `baseline:${baselineBuild.id}:gap:${gap.id}${screenId ? `:${screenId}` : ""}`,
      ...(screenId ? { screenId } : {}),
      ...(observation ? { observationId: observation } : {}),
      message: `Baseline: ${gap.message}`,
    }));
  });
  assertNoIdCollisions("screen", currentMap.screens, removedEvidence.screens);
  assertNoIdCollisions("variant", currentMap.variants, removedEvidence.variants);
  assertNoIdCollisions("observation", currentMap.observations, removedEvidence.observations);
  assertNoIdCollisions("element", currentMap.elements, removedEvidence.elements);
  assertNoIdCollisions("artifact", currentMap.artifacts, removedEvidence.artifacts);
  for (const collection of ["screens", "variants", "observations", "elements", "artifacts"] as const) {
    assertNoIdCollisions(collection, [...currentMap[collection], ...removedEvidence[collection]], contextEvidence[collection]);
  }
  const map: ExploreMap = {
    ...currentMap,
    run: baselineGaps.some(gap => gap.status === "open") ? { ...currentMap.run, status: "partial" } : currentMap.run,
    gaps: [...currentMap.gaps, ...baselineGaps],
    artifacts: [
      ...currentMap.artifacts.map((artifact) => withBuildScope(artifact, currentBuild.id)),
      ...removedEvidence.artifacts,
      ...contextEvidence.artifacts,
    ],
    screens: [...currentMap.screens, ...removedEvidence.screens, ...contextEvidence.screens],
    variants: [...currentMap.variants, ...removedEvidence.variants, ...contextEvidence.variants],
    observations: [...currentMap.observations, ...removedEvidence.observations, ...contextEvidence.observations],
    elements: [...currentMap.elements, ...removedEvidence.elements, ...contextEvidence.elements],
    ...(baselineMap.sourceNavigation ? { baselineSourceNavigation: projectSourceNavigation(baselineMap.sourceNavigation, baselineId) } : {}),
  };
  const index = indexMap(map);
  const screens = new Map<string, ScreenDiff>();
  for (const screen of projection.screens) {
    const before = screen.before
      ? artifactUrl(screen.before.artifact, screen.before.buildId)
      : undefined;
    const after = screen.after
      ? artifactUrl(screen.after.artifact, screen.after.buildId)
      : undefined;
    const recorded = recordedAspect(screen.after?.artifact) ?? recordedAspect(screen.before?.artifact);
    const reviewSurface = reviewSurfaceFor(review, [
      screen.id,
      screen.sourceScreenId,
      screen.currentScreenId,
      screen.baselineScreenId,
    ]);
    // A redirect never renders; showing the route it declares is the only way to see where it goes.
    const declared = !before && !after ? reviewSurface : undefined;
    const redirectTo = declared?.redirectTo;
    const redirectTargets = declared?.redirectTargets;
    // Each side resolves the declared route in its own revision, and only when it is unambiguous.
    const destinationIn = (candidates: MapIndex) => {
      const matches = redirectTo
        ? [...candidates.screens.values()].filter(candidate => candidate.route === redirectTo)
        : [];
      return matches.length === 1 ? matches[0] : undefined;
    };
    const baseDestination = destinationIn(baselineIndex);
    const headDestination = destinationIn(index);
    const borrowedArtifacts = {
      before: baseDestination ? screenshotForScreen(baseDestination, baselineIndex) : undefined,
      after: headDestination ? screenshotForScreen(headDestination, index) : undefined,
    };
    const borrowed = {
      before: baseDestination ? artifactUrl(borrowedArtifacts.before, baselineBuild.id) : undefined,
      after: headDestination ? artifactUrl(borrowedArtifacts.after) : undefined,
    };
    const screenshotAspect = recorded ?? recordedAspect(borrowedArtifacts.after) ?? recordedAspect(borrowedArtifacts.before);
    screens.set(screen.id, {
      status: screen.status,
      changeSummary: screen.changeSummary,
      ...(reviewSurface?.note ? { note: reviewSurface.note } : {}),
      ...(reviewSurface?.visual && !redirectTo ? { visual: reviewSurface.visual } : {}),
      ...(reviewSurface?.captureNotes ? { captureNotes: reviewSurface.captureNotes } : {}),
      reviewerChanges: reviewSurface?.reviewerChanges ?? [],
      runtimeEvidenceRefs: reviewSurface?.runtimeEvidenceRefs ?? [],
      noVisibleChange: screen.status === "unchanged" && (reviewSurface?.noVisibleChange ?? false),
      ...(screen.status === "modified" && reviewSurface?.pixelsUnchanged ? { accessibilityOnly: true as const } : {}),
      ...(before ?? borrowed.before ? { beforeScreenshot: (before ?? borrowed.before)! } : {}),
      ...(after ?? borrowed.after ? { afterScreenshot: (after ?? borrowed.after)! } : {}),
      ...(screenshotAspect ? { screenshotAspect } : {}),
      ...(redirectTo && (borrowed.before || borrowed.after) ? { redirectTo } : {}),
      ...(redirectTargets?.length ? { redirectTargets } : {}),
      ...(screen.baselineScreenId ? { baselineScreenId: screen.baselineScreenId } : {}),
      ...(screen.currentScreenId ? { currentScreenId: screen.currentScreenId } : {}),
      ...(screen.before?.observationId
        ? { baselineObservationId: screen.before.observationId }
        : {}),
      ...(screen.after?.observationId
        ? { currentObservationId: screen.after.observationId }
        : {}),
    });
  }

  for (const screen of baselineContext) {
    const artifact = screenshotForScreen(screen, baselineIndex);
    const before = artifactUrl(artifact, baselineBuild.id);
    const screenshotAspect = recordedAspect(artifact);
    const reviewSurface = reviewSurfaceFor(review, [screen.id]);
    screens.set(baselineContextScreenId(baselineBuild.id, screen.id), {
      status: "not-compared", changeSummary: "Captured as navigation context in the previous revision; not compared.",
      ...(reviewSurface?.note ? { note: reviewSurface.note } : {}),
      ...(before ? { beforeScreenshot: before } : {}), ...(screenshotAspect ? { screenshotAspect } : {}), baselineScreenId: screen.id,
      reviewerChanges: reviewSurface?.reviewerChanges ?? [], runtimeEvidenceRefs: reviewSurface?.runtimeEvidenceRefs ?? [],
      noVisibleChange: false,
    });
  }

  return { baselineId: baselineBuild.id, screens, map, index,
    counts: { ...projection.counts, "not-compared": projection.counts["not-compared"] + baselineContext.length } };
}

/** A screenshot's recorded width over its height, when the report recorded both. */
function recordedAspect(artifact: Pick<Artifact, "width" | "height"> | undefined): number | undefined {
  return artifact?.width && artifact.height && artifact.width > 0 && artifact.height > 0 ? artifact.width / artifact.height : undefined;
}
