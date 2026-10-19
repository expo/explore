import type { BuildDiff, DiffStatus, ScreenDiff } from "./build-diff";
import { isLaunchScreen, type ExploreMap, type Screen } from "./model";
import type { ScreenPresentation } from "./screen-presentation";

const NONE: ReadonlySet<string> = new Set();

/**
 * The screens of a public report's map, before path grouping, that the run never captured on purpose: a redirect
 * declaration, a route named in `exploration.exclude`, or one outside the capture context in changes mode. Each has an
 * accepted capture gap, no open one, and no screenshot of its own on either side. A screenshot a redirect borrows from
 * the route it declares is not its own: build-diff names a side's own capture by its observation id. An open gap, such
 * as a failed capture, keeps the screen: its failure is part of the report. The app launch is not a route, and a local
 * map leaves nothing out.
 *
 * This is the map's view of `neverCapturedSurfaceIds` (src/contracts/surface-capture.ts), which the PR comment uses.
 */
export function omittedSourceScreenIds(
  source: Pick<ExploreMap, "run" | "gaps" | "screens">,
  diff?: Pick<BuildDiff, "screens">,
): ReadonlySet<string> {
  if (!source.run.id.startsWith("public:")) return NONE;
  const accepted = new Set<string>();
  const open = new Set<string>();
  for (const gap of source.gaps) {
    if (gap.screenId && gap.status === "accepted") accepted.add(gap.screenId);
    if (gap.screenId && gap.status === "open") open.add(gap.screenId);
  }
  const omitted = new Set<string>();
  for (const screen of source.screens) {
    if (!accepted.has(screen.id) || open.has(screen.id) || isLaunchScreen(screen) || screen.observationIds.length > 0) continue;
    const compared = diff?.screens.get(screen.id);
    if (compared?.baselineObservationId || compared?.currentObservationId) continue;
    omitted.add(screen.id);
  }
  return omitted;
}

/**
 * The screens none of the report's views list: the Map, Screens, search, Compare, the Changes list and their counts all
 * take this one set. With a path presentation, a card leaves only when every screen it stands for does, a removed one
 * included, so a card whose current route is a redirect still shows the screenshot of the screen it replaced. The map's
 * index keeps them all: a link to one opens it in the Inspector, which says why it has no screenshot.
 */
export function omittedScreenIds(
  source: Pick<ExploreMap, "run" | "gaps" | "screens">,
  options: { diff?: Pick<BuildDiff, "screens"> | undefined; presentation?: Pick<ScreenPresentation, "families"> | undefined } = {},
): ReadonlySet<string> {
  const members = omittedSourceScreenIds(source, options.diff);
  if (!options.presentation || members.size === 0) return members;
  return new Set(options.presentation.families
    .filter((family) => family.members.every((member) => members.has(member.id)))
    .map((family) => family.representative.id));
}

/** The report's screens: the map's screens but the omitted ones. */
export function reportScreens<T extends Pick<Screen, "id">>(screens: readonly T[], omitted: ReadonlySet<string>): readonly T[] {
  return omitted.size ? screens.filter((screen) => !omitted.has(screen.id)) : screens;
}

/**
 * The comparison without the omitted screens, so no count, Changes row, Compare step or Changed filter names a route
 * that was never captured. Its map and index keep them, for a link to one.
 */
export function withoutOmittedScreens(diff: BuildDiff, omitted: ReadonlySet<string>): BuildDiff {
  if (![...diff.screens.keys()].some((id) => omitted.has(id))) return diff;
  const screens = new Map<string, ScreenDiff>();
  const counts: Record<DiffStatus, number> = { ...diff.counts };
  for (const [id, screen] of diff.screens) {
    if (omitted.has(id)) counts[screen.status] -= 1;
    else screens.set(id, screen);
  }
  return { ...diff, screens, counts };
}
