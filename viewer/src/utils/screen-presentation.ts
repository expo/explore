import type { ExploreMap, Screen } from "../../../src/types";
import type { BuildDiff, DiffStatus, ScreenDiff } from "./build-diff";
import type { CaptureNotes, ReviewVisualDiff } from "./review-model";
import { indexMap, type MapIndex } from "./model";
import {
  normalizeRoute,
  type ScreenRouteAlias,
} from "./navigation";
import { displayPathForScreen } from "./screen-path";
import { projectSourceNavigation } from "./source-navigation";

export type ScreenFamily = {
  path: string;
  representative: Screen;
  members: readonly Screen[];
};

export type ScreenPresentation = {
  map: ExploreMap;
  index: MapIndex;
  families: readonly ScreenFamily[];
  familyByRepresentativeId: ReadonlyMap<string, ScreenFamily>;
  representativeIdByScreenId: ReadonlyMap<string, string>;
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function familyPath(screen: Screen): string {
  return normalizeRoute(displayPathForScreen(screen));
}

function earliest(values: readonly string[], fallback: string): string {
  return [...values].sort()[0] ?? fallback;
}

function latest(values: readonly string[], fallback: string): string {
  return [...values].sort().at(-1) ?? fallback;
}

function isBaselineOnlyScreen(screen: Screen): boolean {
  return screen.id.startsWith("removed:") || screen.id.startsWith("baseline-context:");
}

function mergedScreen(representative: Screen, members: readonly Screen[]): Screen {
  return {
    ...representative,
    start: members.some((screen) => screen.start),
    terminal: members.every((screen) => screen.terminal),
    depth: Math.min(...members.map((screen) => screen.depth)),
    firstSeenAt: earliest(members.map((screen) => screen.firstSeenAt), representative.firstSeenAt),
    lastSeenAt: latest(members.map((screen) => screen.lastSeenAt), representative.lastSeenAt),
    visits: members.reduce((total, screen) => total + screen.visits, 0),
    variantIds: unique(members.flatMap((screen) => screen.variantIds)),
    observationIds: unique(members.flatMap((screen) => screen.observationIds)),
    elementIds: unique(members.flatMap((screen) => screen.elementIds)),
  };
}

/**
 * Builds the viewer's route-level screen model without mutating the recorded map contract.
 *
 * Runtime explorers may record several canonical screens for state changes on one router path.
 * The viewer presents those records as one screen whose authored variants remain individually
 * addressable in the Inspector.
 */
export function presentScreensByPath(source: ExploreMap): ScreenPresentation {
  const membersByPath = new Map<string, Screen[]>();
  for (const screen of source.screens) {
    const path = familyPath(screen);
    const members = membersByPath.get(path) ?? [];
    members.push(screen);
    membersByPath.set(path, members);
  }

  const representativeIdByScreenId = new Map<string, string>();
  const presentedSourceScreenIds = new Set<string>();
  const familyMembers = [...membersByPath].map(([path, members]) => {
    const currentMembers = members.filter((screen) => !isBaselineOnlyScreen(screen));
    const visibleMembers = currentMembers.length > 0 ? currentMembers : members;
    for (const screen of visibleMembers) presentedSourceScreenIds.add(screen.id);
    const representative = visibleMembers[0]!;
    for (const screen of members) representativeIdByScreenId.set(screen.id, representative.id);
    return { path, representative: mergedScreen(representative, visibleMembers), members };
  });
  const familyByRepresentativeId = new Map(
    familyMembers.map((family) => [family.representative.id, family] as const),
  );
  const representativeId = (screenId: string) => (
    representativeIdByScreenId.get(screenId) ?? screenId
  );

  const map: ExploreMap = {
    ...source,
    screens: familyMembers.map((family) => family.representative),
    variants: source.variants
      .filter((variant) => presentedSourceScreenIds.has(variant.screenId))
      .map((variant) => ({
        ...variant,
        screenId: representativeId(variant.screenId),
      })),
    observations: source.observations
      .filter((observation) => presentedSourceScreenIds.has(observation.screenId))
      .map((observation) => ({
        ...observation,
        screenId: representativeId(observation.screenId),
      })),
    elements: source.elements
      .filter((element) => presentedSourceScreenIds.has(element.screenId))
      .map((element) => ({
        ...element,
        screenId: representativeId(element.screenId),
      })),
    actionAttempts: source.actionAttempts.map((attempt) => {
      const sourceScreenId = representativeId(attempt.sourceScreenId);
      const targetScreenId = attempt.targetScreenId
        ? representativeId(attempt.targetScreenId)
        : undefined;
      return {
        ...attempt,
        sourceScreenId,
        ...(targetScreenId ? { targetScreenId } : {}),
        ...(attempt.outcome === "transition" && targetScreenId === sourceScreenId
          ? { outcome: "same-screen" as const }
          : {}),
      };
    }),
    transitions: source.transitions.map((transition) => ({
      ...transition,
      fromScreenId: representativeId(transition.fromScreenId),
      toScreenId: representativeId(transition.toScreenId),
    })),
    ...(source.sourceNavigation ? { sourceNavigation: projectSourceNavigation(source.sourceNavigation, representativeId) } : {}),
    ...(source.baselineSourceNavigation ? { baselineSourceNavigation: projectSourceNavigation(source.baselineSourceNavigation, representativeId) } : {}),
    journeys: source.journeys.map((journey) => ({
      ...journey,
      screenIds: journey.screenIds.map(representativeId),
    })),
    frontier: source.frontier.map((item) => ({
      ...item,
      screenId: representativeId(item.screenId),
    })),
    gaps: source.gaps.map((gap) => ({
      ...gap,
      ...(gap.screenId ? { screenId: representativeId(gap.screenId) } : {}),
    })),
  };

  return {
    map,
    index: indexMap(map),
    families: familyMembers,
    familyByRepresentativeId,
    representativeIdByScreenId,
  };
}

/** Restores old ids and source-capture routes after their screens join a displayed family. */
export function screenAliasesForPresentation(
  source: ExploreMap,
  presentation: ScreenPresentation,
  existingRouteAliases: ReadonlyMap<string, ScreenRouteAlias> = new Map(),
): {
  screenIdAliases: ReadonlyMap<string, string>;
  screenIdAliasVariants: ReadonlyMap<string, string>;
  screenRouteAliases: ReadonlyMap<string, ScreenRouteAlias>;
} {
  const presentedRoutes = new Set(
    presentation.map.screens.flatMap((screen) => (
      screen.route ? [normalizeRoute(screen.route)] : []
    )),
  );
  const presentedVariantIds = new Set(presentation.map.variants.map((variant) => variant.id));
  const screenIdAliasVariants = new Map<string, string>();
  const screenRouteAliases = new Map<string, ScreenRouteAlias>();

  for (const screen of source.screens) {
    const representativeId = presentation.representativeIdByScreenId.get(screen.id) ?? screen.id;
    if (representativeId === screen.id) continue;
    const variantId = screen.variantIds.find((id) => presentedVariantIds.has(id));
    if (variantId) screenIdAliasVariants.set(screen.id, variantId);
    if (!screen.route) continue;
    const route = normalizeRoute(screen.route);
    if (presentedRoutes.has(route)) continue;
    screenRouteAliases.set(route, {
      screenId: representativeId,
      ...(variantId ? { variantId } : {}),
    });
  }

  for (const [route, alias] of existingRouteAliases) {
    screenRouteAliases.set(route, {
      ...alias,
      screenId: presentation.representativeIdByScreenId.get(alias.screenId) ?? alias.screenId,
    });
  }

  return {
    screenIdAliases: presentation.representativeIdByScreenId,
    screenIdAliasVariants,
    screenRouteAliases,
  };
}

function aggregateStatus(statuses: readonly DiffStatus[]): DiffStatus {
  if (statuses.length && statuses.every(status => status === statuses[0])) return statuses[0]!;
  if (statuses.includes("needs-review")) return "needs-review";
  if (statuses.includes("modified")) return "modified";
  if (statuses.includes("source-affected")) return "source-affected";
  // A runtime-state variant is not a change, but it outranks screens that were not compared.
  if (statuses.includes("variant")) return "variant";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("not-compared")) return "not-compared";
  if (statuses.every((status) => status === "unchanged")) return "unchanged";
  if (statuses.every((status) => status === "added")) return "added";
  if (statuses.every((status) => status === "removed")) return "removed";
  return "modified";
}

function firstDiffWithScreenshot(
  diffs: readonly ScreenDiff[],
  side: "beforeScreenshot" | "afterScreenshot",
): ScreenDiff | undefined {
  return diffs.find((diff) => Boolean(diff[side]));
}

function familyEvidence(diffs: readonly ScreenDiff[]): {
  changeSummary: string;
  note?: string;
  beforeScreenshot?: string;
  afterScreenshot?: string;
  visual?: ReviewVisualDiff;
  captureNotes?: CaptureNotes;
  redirectTo?: string;
  redirectTargets?: string[];
  baselineScreenId?: string;
  currentScreenId?: string;
  baselineObservationId?: string;
  currentObservationId?: string;
  reviewerChanges: ScreenDiff["reviewerChanges"];
  runtimeEvidenceRefs: string[];
  noVisibleChange: boolean;
  accessibilityOnly?: true;
} {
  const first = diffs[0];
  if (!first) throw new Error("Cannot present an empty diff family");
  const paired = diffs.find((diff) => (
    diff.status === "modified" && diff.beforeScreenshot && diff.afterScreenshot
  )) ?? diffs.find((diff) => diff.beforeScreenshot && diff.afterScreenshot);
  const beforeDiff = firstDiffWithScreenshot(diffs, "beforeScreenshot");
  const afterDiff = firstDiffWithScreenshot(diffs, "afterScreenshot");
  const primary = paired ?? afterDiff ?? beforeDiff ?? first;
  const modified = diffs.filter((diff) => diff.status === "modified");
  const reviewerChanges = [...new Map(diffs
    .flatMap((diff) => diff.reviewerChanges ?? [])
    .map((change) => [change.id, change])).values()];
  const runtimeEvidenceRefs = [...new Set(
    diffs.flatMap((diff) => diff.runtimeEvidenceRefs ?? []),
  )];
  const metadata = {
    ...(primary.note ? { note: primary.note } : {}),
    reviewerChanges,
    runtimeEvidenceRefs,
    noVisibleChange: diffs.some((diff) => diff.noVisibleChange),
    // Not visible only when no modified member of the family shows a difference.
    ...(modified.length > 0 && modified.every((diff) => diff.accessibilityOnly) ? { accessibilityOnly: true as const } : {}),
    ...(primary.captureNotes ? { captureNotes: primary.captureNotes } : {}),
    // A redirect's screenshots belong to the route it declares; the panel must keep saying so.
    ...(primary.redirectTo ? { redirectTo: primary.redirectTo } : {}),
    ...(primary.redirectTargets?.length ? { redirectTargets: [...primary.redirectTargets] } : {}),
    ...(primary.baselineScreenId ? { baselineScreenId: primary.baselineScreenId } : {}),
    ...(primary.currentScreenId ? { currentScreenId: primary.currentScreenId } : {}),
    ...(primary.baselineObservationId
      ? { baselineObservationId: primary.baselineObservationId }
      : {}),
    ...(primary.currentObservationId
      ? { currentObservationId: primary.currentObservationId }
      : {}),
  };
  if (paired?.beforeScreenshot && paired.afterScreenshot) {
    return {
      changeSummary: paired.changeSummary,
      beforeScreenshot: paired.beforeScreenshot,
      afterScreenshot: paired.afterScreenshot,
      // The CI regions describe exactly this pair of screenshots, so they travel with it.
      ...(paired.visual ? { visual: paired.visual } : {}),
      ...metadata,
    };
  }
  const summaries = [beforeDiff, afterDiff].reduce<string[]>((result, diff) => {
    if (diff && !result.includes(diff.changeSummary)) result.push(diff.changeSummary);
    return result;
  }, []);
  return {
    changeSummary: summaries.join(" ") || first.changeSummary,
    ...(beforeDiff?.beforeScreenshot ? { beforeScreenshot: beforeDiff.beforeScreenshot } : {}),
    ...(afterDiff?.afterScreenshot ? { afterScreenshot: afterDiff.afterScreenshot } : {}),
    ...metadata,
  };
}

/** Aggregates raw capture changes into the same route-level families rendered by every canvas. */
export function presentBuildDiff(
  source: BuildDiff,
  presentation: ScreenPresentation,
): BuildDiff {
  const screens = new Map<string, ScreenDiff>();
  const counts: Record<DiffStatus, number> = {
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

  for (const family of presentation.families) {
    const memberDiffs = family.members
      .map((screen) => source.screens.get(screen.id))
      .filter((diff): diff is ScreenDiff => Boolean(diff));
    if (memberDiffs.length === 0) continue;
    const status = aggregateStatus(memberDiffs.map((diff) => diff.status));
    const evidence = familyEvidence(memberDiffs);
    screens.set(family.representative.id, {
      status,
      ...evidence,
    });
    counts[status] += 1;
  }

  return {
    ...source,
    map: presentation.map,
    index: presentation.index,
    screens,
    counts,
  };
}
