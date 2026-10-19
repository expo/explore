import type { PublicReview } from "./capture.js";
import { navigationCaptureContext } from "./navigation-graph.js";

type Surface = PublicReview["surfaces"][number];
type Side = "base" | "head";

/** Navigation is route-level: a secondary-appearance surface (`<id>@<scheme>`) rides on its route's entry. */
const SCHEME_SUFFIX = /@(light|dark)$/;
const routeOf = (id: string): string => id.replace(SCHEME_SUFFIX, "");

/**
 * The surfaces a side planned to capture: every route in `all` mode, the changed routes and their navigation context in
 * `changes` mode. Undefined without navigation, which leaves no route outside the context.
 */
export function captureContext(review: PublicReview, side: Side): ReadonlySet<string> | undefined {
  const navigation = review.navigation?.[side];
  if (!navigation) return undefined;
  const inventory = review.surfaces.filter((surface) => surface[side]);
  const routes = new Map<string, NonNullable<Surface[Side]>>();
  for (const surface of inventory) {
    const id = routeOf(surface.id);
    if (!routes.has(id)) routes.set(id, { ...surface[side]!, id });
  }
  const selected = new Set(review.mode === "all" ? [...routes.keys()] : navigationCaptureContext(navigation,
    inventory.filter((surface) => surface.status !== "unchanged").map((surface) => routeOf(surface.id)),
    [...routes.values()]));
  return new Set(inventory.filter((surface) => selected.has(routeOf(surface.id))).map((surface) => surface.id));
}

/** Both a screenshot of the planned route and a verified landing on it. */
export function verifiedCapture(surface: Surface, side: Side): boolean {
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  return Boolean(surface[side]?.kind === "screen" && (side === "base" ? surface.baseImage : surface.headImage)
    && outcome?.status === "captured" && outcome.landing === "verified");
}

/**
 * Why a side that exists in its revision has no verified capture, as the report's capture gap: `accepted` when the run
 * left it uncaptured on purpose (a redirect declaration, a route named in `exploration.exclude`, or a route outside the
 * capture context), `open` for anything else, such as a capture that failed. Undefined for a verified capture or an
 * absent side. `context` is the side's `captureContext`.
 */
export function captureGap(review: PublicReview, surface: Surface, side: Side,
  context: ReadonlySet<string> | undefined): "accepted" | "open" | undefined {
  const entry = surface[side];
  if (!entry || verifiedCapture(surface, side)) return undefined;
  const image = side === "base" ? surface.baseImage : surface.headImage;
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  const outsideCaptureContext = review.mode === "changes" && context !== undefined && !context.has(surface.id);
  const deliberate = !image && !outcome && (entry.kind === "redirect" || surface.excluded === true || outsideCaptureContext
    || (!review.navigation?.[side] && review.mode === "changes" && surface.status === "unchanged"));
  return deliberate ? "accepted" : "open";
}

/**
 * The surfaces the run never captured on purpose: no screenshot of their own on either side, and every side that exists
 * left uncaptured deliberately (`captureGap` is `accepted`). None is one of the report's screens. The Viewer leaves them
 * out (viewer/src/utils/omitted-screens.ts reaches the same set from the map's gaps), and the PR comment skips them.
 * A side with an open gap, such as a failed capture, keeps the surface: its failure is part of the report.
 */
export function neverCapturedSurfaceIds(review: PublicReview): ReadonlySet<string> {
  // The Viewer refuses a review whose navigation names a route its inventory lacks; the comment still renders one,
  // without a capture context, so no route counts as outside it.
  const contextOf = (side: Side) => { try { return captureContext(review, side); } catch { return undefined; } };
  const contexts = { base: contextOf("base"), head: contextOf("head") };
  const omitted = new Set<string>();
  for (const surface of review.surfaces) {
    if (surface.baseImage || surface.headImage) continue;
    const gaps = (["base", "head"] as const).map((side) => captureGap(review, surface, side, contexts[side]));
    if (gaps.includes("accepted") && !gaps.includes("open")) omitted.add(surface.id);
  }
  return omitted;
}
