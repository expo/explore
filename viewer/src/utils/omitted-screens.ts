import type { BuildDiff, DiffStatus, ScreenDiff } from "./build-diff";
import { isLaunchScreen, type ExploreMap, type Screen } from "./model";

/**
 * The routes a public report keeps in its source inventory but deliberately never captured: a redirect declaration, a
 * route named in `exploration.exclude`, or one outside the capture context in changes mode. An accepted capture gap marks
 * each, and with no screenshot of its own none is one of the report's screens, so the Map, Screens, Compare, the Changes
 * list and search all leave them out. The index keeps them: the report's navigation still names them, and a link to one
 * opens it in the Inspector, which says why it has no screenshot.
 *
 * A screen with a screenshot stays, whatever else its gaps say: a route that was a redirect in the baseline and is a
 * captured screen now, or a captured route whose excluded variant joined it on one card. The app launch is not a route:
 * its accepted "no splash observed" gap keeps it where the app starts. A local map leaves nothing out.
 */
export function omittedScreenIds(map: Pick<ExploreMap, "run" | "gaps" | "screens">): ReadonlySet<string> {
  const omitted = new Set<string>();
  if (!map.run.id.startsWith("public:")) return omitted;
  const accepted = new Set(map.gaps.flatMap(gap => (gap.status === "accepted" && gap.screenId ? [gap.screenId] : [])));
  for (const screen of map.screens) {
    if (accepted.has(screen.id) && screen.observationIds.length === 0 && !isLaunchScreen(screen)) omitted.add(screen.id);
  }
  return omitted;
}

/** The report's screens: every screen the map knows but the ones it deliberately never captured. */
export function reportScreens(map: Pick<ExploreMap, "run" | "gaps" | "screens">): Screen[] {
  const omitted = omittedScreenIds(map);
  return omitted.size ? map.screens.filter(screen => !omitted.has(screen.id)) : map.screens;
}

/**
 * The comparison without the screens its map leaves out, so no count, Changes row, Compare step or Changed filter names
 * a route that was never captured. Its map and index keep them, for a link to one.
 */
export function withoutOmittedScreens(diff: BuildDiff): BuildDiff {
  const omitted = omittedScreenIds(diff.map);
  if (![...diff.screens.keys()].some(id => omitted.has(id))) return diff;
  const screens = new Map<string, ScreenDiff>();
  const counts: Record<DiffStatus, number> = { ...diff.counts };
  for (const [id, screen] of diff.screens) {
    if (omitted.has(id)) counts[screen.status] -= 1;
    else screens.set(id, screen);
  }
  return { ...diff, screens, counts };
}
