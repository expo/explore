import type { BuildComparison, ExploreMap } from "../../../src/types";
import type { ViewerReviewProjection } from "./review-model";

export type Appearance = "light" | "dark";

const APPEARANCE_LABELS: Record<Appearance, string> = { light: "Light", dark: "Dark" };

/** An appearance as the app pill and the handoff prompt name it. */
export function appearanceLabel(appearance: Appearance): string {
  return APPEARANCE_LABELS[appearance];
}

/** The appearances a report captured, primary first; one or none means the report has no appearance switch. */
export function appearanceOptions(map: ExploreMap | undefined): Appearance[] {
  if (!map) return [];
  const declared = map.run.environment.colorSchemes ?? [];
  const seen = new Set<Appearance>(declared);
  for (const screen of map.screens) if (screen.colorScheme) seen.add(screen.colorScheme);
  return [...seen];
}

const SCHEME_SUFFIX = /@(light|dark)$/;

/**
 * The report as captured in one appearance. A secondary appearance's screens (`<route>@<scheme>`) take their
 * route's id, so navigation, links and the Compare view keep working by route in every appearance.
 */
export function filterMapAppearance<T extends ExploreMap>(map: T, appearance: Appearance | undefined): T {
  if (!appearance || !map.screens.some(screen => screen.colorScheme && screen.colorScheme !== appearance)) return map;
  const routeId = (id: string) => id.replace(SCHEME_SUFFIX, "");
  const screens = map.screens
    .filter(screen => !screen.colorScheme || screen.colorScheme === appearance)
    .map(screen => ({ ...screen, id: routeId(screen.id) }));
  const kept = new Set(map.screens.filter(screen => !screen.colorScheme || screen.colorScheme === appearance).map(screen => screen.id));
  const screenIds = new Set(screens.map(screen => screen.id));
  const observations = map.observations
    .filter(observation => kept.has(observation.screenId))
    .map(observation => ({ ...observation, screenId: routeId(observation.screenId) }));
  const observationIds = new Set(observations.map(observation => observation.id));
  return {
    ...map,
    screens,
    journeys: map.journeys.map(journey => ({ ...journey, screenIds: journey.screenIds.map(routeId) })),
    frontier: map.frontier.filter(item => kept.has(item.screenId)).map(item => ({ ...item, screenId: routeId(item.screenId) })),
    gaps: map.gaps
      .filter(gap => !gap.screenId || kept.has(gap.screenId))
      .map(gap => (gap.screenId ? { ...gap, screenId: routeId(gap.screenId) } : gap)),
    variants: map.variants.filter(variant => kept.has(variant.screenId)).map(variant => ({ ...variant, screenId: routeId(variant.screenId) })),
    observations,
    elements: map.elements.map(element => ({ ...element, observationIds: element.observationIds.filter(id => observationIds.has(id)) }))
      .filter(element => element.observationIds.length > 0),
    transitions: map.transitions
      .map(transition => ({ ...transition, fromScreenId: routeId(transition.fromScreenId), toScreenId: routeId(transition.toScreenId) }))
      .filter(transition => screenIds.has(transition.fromScreenId) && screenIds.has(transition.toScreenId)),
  };
}

/** Screen ids of the maps that belong to `appearance`, and the route id each one presents as. */
export function appearanceScope(maps: readonly (ExploreMap | undefined)[], appearance: Appearance | undefined): { kept: Set<string>; routeId: (id: string) => string } | undefined {
  const screens = maps.flatMap(map => map?.screens ?? []);
  if (!appearance || !screens.some(screen => screen.colorScheme && screen.colorScheme !== appearance)) return undefined;
  return {
    kept: new Set(screens.filter(screen => !screen.colorScheme || screen.colorScheme === appearance).map(screen => screen.id)),
    routeId: id => id.replace(SCHEME_SUFFIX, ""),
  };
}

/** The comparison entries of one appearance, keyed by route like the filtered maps. */
export function filterComparisonAppearance(comparison: BuildComparison, scope: ReturnType<typeof appearanceScope>): BuildComparison {
  if (!scope) return comparison;
  const { kept, routeId } = scope;
  const belongs = (entry: BuildComparison["entries"][number]) =>
    kept.has(entry.id) || [...entry.baselineScreenIds, ...entry.currentScreenIds].some(id => kept.has(id));
  return {
    ...comparison,
    entries: comparison.entries
      .filter(entry => belongs(entry) && [...entry.baselineScreenIds, ...entry.currentScreenIds].every(id => kept.has(id)))
      .map(entry => ({
        ...entry,
        id: routeId(entry.id),
        baselineScreenIds: entry.baselineScreenIds.map(routeId),
        currentScreenIds: entry.currentScreenIds.map(routeId),
      })),
  };
}

/**
 * The review surfaces of one appearance, keyed by route like the filtered maps. Runtime evidence keeps its own
 * keys: surfaces reference it by `runtimeEvidenceRefs`.
 */
export function filterReviewAppearance(review: ViewerReviewProjection, scope: ReturnType<typeof appearanceScope>): ViewerReviewProjection {
  if (!scope) return review;
  const { kept, routeId } = scope;
  const surfaces = Object.fromEntries(
    Object.entries(review.surfaces).filter(([id]) => kept.has(id)).map(([id, value]) => [routeId(id), value]),
  );
  return { ...review, surfaces };
}
