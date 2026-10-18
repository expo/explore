// Where the viewer is, as a URL. Everything a reader would call "navigation" lives in one
// `Route` — which canvas, which screen is selected, which inspector tab —
// and the URL is that route written out, Figma-style: a path for the place and a query for the
// selection. This module is DOM-free on purpose so the grammar can be tested in plain node.
/** Map and Screens are canvases; Compare is the Before/After review of one changed screen. */
export type CanvasView = "map" | "screens" | "compare" | "flows";
export type ThemePreference = "light" | "dark" | "system";
export type MapDirection = "TB" | "LR";
/** The explicitly selected amount of Map hierarchy, independent from camera zoom. */
/** The diff states the canvas can single out. An empty selection is "All": nothing drops back. */
/** `accessibility-only`: a modified screen whose screenshots match, filtered apart from the visible changes. */
export type FocusStatus = "added" | "modified" | "accessibility-only" | "removed" | "needs-review" | "source-affected";
/** The right panel shows Session and Diff. */
export type InspectView = "session" | "diff";
/** Which way the inspector's transition list reads: into the screen, or out of it. */
export type TransitionDirection = "in" | "out";

export type Route = {
  canvas: CanvasView;
  /** Selected screen id. Authoritative whenever it is present. */
  screen?: string | undefined;
  /**
   * The expo-router path the URL named instead of an id. Kept until a screen resolves for it,
   * so a link into a live exploration still lands once that screen is recorded.
   */
  screenRoute?: string | undefined;
  inspect: InspectView;
  direction: TransitionDirection;
  /** Runtime evidence tab; unset means the first group. */
  evidence?: string | undefined;
  /** Selected state capture within the current screen; unset means its first variant. */
  variant?: string | undefined;
  /** Baseline build id; the empty string is "No baseline". */
  baseline: string;
  focus: FocusStatus[];
  /** Progressive Map groups the reader explicitly expanded, in stable URL order. */
  expandedGroups: string[];
};

/** What the grammar needs from the app: which baselines exist, and which screens record a route. */
export type RouteContext = {
  defaultBaseline: string;
  baselines: readonly string[];
  /** Screen id → normalised expo-router route, for the screens that record one. */
  screenRoutes: ReadonlyMap<string, string>;
  /** Screen id → authored variant ids. Absent while the map is still loading. */
  screenVariants?: ReadonlyMap<string, readonly string[]>;
  /** Recorded screen id → the route-level representative rendered by the viewer. */
  screenIdAliases?: ReadonlyMap<string, string>;
  /** Hidden recorded screen id → its default variant on the rendered representative. */
  screenIdAliasVariants?: ReadonlyMap<string, string>;
  /**
   * Historical route → canonical screen/variant. The viewer derives these aliases only when
   * ordered import evidence proves the mapping, so grouped capture links continue to resolve.
   */
  screenRouteAliases?: ReadonlyMap<string, ScreenRouteAlias>;
};

export type ScreenRouteAlias = {
  screenId: string;
  variantId?: string | undefined;
};

export type LocationLike = { pathname: string; search: string; hash: string };

/** How a canvas brings something into view: a camera flight, or a straight cut. */
export type FocusBehavior = "fly" | "cut";
/**
 * A one-shot ask for the canvas to show a screen — what a deep link, a history step or
 * a side-panel row means by "go there". The key tells repeats of the same target apart.
 */
export type FocusRequest = {
  target: "screen";
  id: string;
  key: number;
  behavior: FocusBehavior;
  /**
   * Browser history already chose the Map projection represented by the restored URL. The
   * canvas may focus the target when it is visible, but must not infer and open another scope.
   */
  preserveMapContent?: boolean;
};

const CANVASES: CanvasView[] = ["map", "screens", "compare", "flows"];
const INSPECTS: InspectView[] = ["session", "diff"];
const DIRECTIONS: TransitionDirection[] = ["in", "out"];
const FOCUSES: FocusStatus[] = ["added", "modified", "accessibility-only", "removed", "needs-review", "source-affected"];

function isCanvas(value: string | null | undefined): value is CanvasView {
  return CANVASES.includes(value as CanvasView);
}

function isInspect(value: string | null | undefined): value is InspectView {
  return INSPECTS.includes(value as InspectView);
}

/** Review was the original name for Diff. Keep old links and runtime callers readable. */
function parseInspect(value: string | null | undefined): InspectView | undefined {
  if (value === "review") return "diff";
  return isInspect(value) ? value : undefined;
}

function isDirection(value: string | null | undefined): value is TransitionDirection {
  return DIRECTIONS.includes(value as TransitionDirection);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A route as recorded on a screen or read off a URL: decoded, one leading slash, no trailing one. */
export function normalizeRoute(raw: string): string {
  const segments = raw.split("/").map(safeDecode).filter(Boolean);
  return `/${segments.join("/")}`;
}

/**
 * A route as it goes into the path. Each segment is escaped, then the characters expo-router
 * leans on — `(group)`, `[param]`, `:` and `@` — are put back so the address bar stays readable.
 */
export function encodeRoutePath(route: string): string {
  return route
    .split("/")
    .map((segment) => encodeURIComponent(segment)
      .replace(/%5B/gi, "[")
      .replace(/%5D/gi, "]")
      .replace(/%3A/gi, ":")
      .replace(/%40/gi, "@"))
    .join("/");
}

/** The routes the loaded screens record, keyed by id, in map order. */
export function screenRoutesOf(screens: readonly { id: string; route?: string | undefined }[]): Map<string, string> {
  const routes = new Map<string, string>();
  for (const screen of screens) {
    if (screen.route) routes.set(screen.id, normalizeRoute(screen.route));
  }
  return routes;
}

export function screenVariantsOf(
  screens: readonly { id: string; variantIds: readonly string[] }[],
): Map<string, readonly string[]> {
  return new Map(screens.map((screen) => [screen.id, screen.variantIds]));
}

/** Plain route aliases as a normalised lookup for the URL grammar. */
function routeOwners(ctx: RouteContext, route: string): string[] {
  const owners: string[] = [];
  for (const [id, candidate] of ctx.screenRoutes) {
    if (candidate === route) owners.push(id);
  }
  return owners;
}

/** The index route cannot be told apart from "no route" in the path, so it travels as an id. */
function routeFitsPath(route: string | undefined): route is string {
  return route !== undefined && route !== "/";
}

/** `#workspace/<canvas>` and the bare `#screens` predate path routing and are still linked; an unknown canvas lands on the map. */
function parseLegacyHash(hash: string): CanvasView | undefined {
  const [first, second] = hash.replace(/^#/, "").split("/");
  if (first === "screens" && !second) return "screens";
  // "workspace" was the original name of the Changes panel, which once named the hash's panel.
  if (first !== "workspace" && first !== "changes") return undefined;
  // The hash era had a "flows" canvas that was retired; those links land on the map.
  if (second === "graph" || second === "flows") return "map";
  return isCanvas(second) ? second : "map";
}

/** Settles the states the URL cannot express together, and drops what the context does not know. */
export function canonicalRoute(route: Route, ctx: RouteContext): Route {
  // Graph was removed as a destination. Runtime history or callers compiled against an older
  // route type can still hand us that value, so settle it to Map before deriving scope or URLs.
  const legacyGraph = (route.canvas as string) === "graph";
  const canvas = isCanvas(route.canvas) ? route.canvas : "map";
  const baseline = route.baseline === "" || ctx.baselines.includes(route.baseline)
    ? route.baseline
    : ctx.defaultBaseline;
  const compared = baseline !== "";
  const requestedScreen = route.screen?.trim() || undefined;
  const screen = requestedScreen
    ? ctx.screenIdAliases?.get(requestedScreen) ?? requestedScreen
    : undefined;
  const evidence = route.evidence?.trim() || undefined;
  const routeAlias = !screen && route.screenRoute
    ? ctx.screenRouteAliases?.get(normalizeRoute(route.screenRoute))
    : undefined;
  const resolvedScreen = screen ?? (routeAlias
    ? ctx.screenIdAliases?.get(routeAlias.screenId) ?? routeAlias.screenId
    : undefined);
  const requestedVariant = route.variant?.trim()
    || routeAlias?.variantId?.trim()
    || (requestedScreen ? ctx.screenIdAliasVariants?.get(requestedScreen) : undefined);
  const expandedGroups = legacyGraph
    ? []
    : [...new Set((route.expandedGroups ?? []).map((id) => id.trim()).filter(Boolean))].sort();
  const selectedScreen = resolvedScreen
    || (route.screenRoute ? routeOwners(ctx, route.screenRoute)[0] : undefined);
  const variant = requestedVariant && (
    !ctx.screenVariants
    || (selectedScreen && ctx.screenVariants.get(selectedScreen)?.includes(requestedVariant))
  ) ? requestedVariant : undefined;
  const requestedInspect = parseInspect(route.inspect) ?? "session";
  return {
    canvas,
    ...(resolvedScreen ? { screen: resolvedScreen } : {}),
    // An id says exactly which screen; a route only narrows it down, so it yields to one.
    ...(!resolvedScreen && route.screenRoute ? { screenRoute: route.screenRoute } : {}),
    // Diff compares against a baseline. Legacy Review links resolve to Diff through parseInspect.
    inspect: requestedInspect === "diff" && !compared ? "session" : requestedInspect,
    direction: route.direction,
    ...(evidence ? { evidence } : {}),
    ...(variant ? { variant } : {}),
    baseline,
    focus: compared ? FOCUSES.filter((status) => route.focus.includes(status)) : [],
    expandedGroups,
  };
}

/** Normalizes a route at the app boundary: Diff needs a baseline. */
export function sanitizeViewerRoute(route: Route): Route {
  const requestedInspect = parseInspect(route.inspect) ?? "session";
  const inspect = requestedInspect === "diff" && route.baseline === ""
    ? "session"
    : requestedInspect;
  return inspect === route.inspect ? route : { ...route, inspect };
}

export function parseLocation(location: LocationLike, ctx: RouteContext): Route {
  const params = new URLSearchParams(location.search);
  let canvas: CanvasView = "map";
  let legacyGraph = false;
  let screenRoute: string | undefined;

  const legacy = parseLegacyHash(location.hash);
  if (legacy) {
    canvas = legacy;
    legacyGraph = location.hash.replace(/^#/, "").split("/")[1] === "graph";
  } else {
    const segments = location.pathname.split("/").filter(Boolean);
    const first = safeDecode(segments[0] ?? "");
    if (first === "graph" || isCanvas(first)) {
      legacyGraph = first === "graph";
      canvas = first === "graph" ? "map" : first;
      const rest = segments.slice(1);
      if (rest.length > 0) screenRoute = normalizeRoute(rest.join("/"));
    }
  }

  const inspect = params.get("inspect");
  const direction = params.get("dir");
  const baseline = params.get("baseline");
  const focus = (params.get("focus") ?? "")
    .split(",")
    .filter((status): status is FocusStatus => FOCUSES.includes(status as FocusStatus));

  return canonicalRoute({
    canvas,
    screen: params.get("screen") ?? undefined,
    screenRoute,
    inspect: parseInspect(inspect) ?? "session",
    direction: isDirection(direction) ? direction : "out",
    evidence: params.get("evidence") ?? undefined,
    variant: params.get("variant") ?? undefined,
    baseline: baseline === null ? ctx.defaultBaseline : baseline === "none" ? "" : baseline,
    focus,
    expandedGroups: legacyGraph ? [] : params.getAll("expand"),
  }, ctx);
}

/** The route as `pathname?search`. Defaults are left out so the same view always formats the same. */
export function formatRoute(route: Route, ctx: RouteContext): string {
  const next = canonicalRoute(route, ctx);
  const params = new URLSearchParams();
  let suffix = "";

  if (next.screen) {
    const screenRoute = ctx.screenRoutes.get(next.screen);
    if (routeFitsPath(screenRoute)) suffix = encodeRoutePath(screenRoute);
    // On its own the route names the first screen recorded under it — the one `resolveScreenId`
    // answers with — so only the others that share it need their id spelled out.
    if (!routeFitsPath(screenRoute) || routeOwners(ctx, screenRoute)[0] !== next.screen) {
      params.set("screen", next.screen);
    }
  } else if (routeFitsPath(next.screenRoute)) {
    suffix = encodeRoutePath(next.screenRoute);
  }
  if (next.inspect !== "session") params.set("inspect", next.inspect);
  if (next.direction !== "out") params.set("dir", next.direction);
  if (next.evidence) params.set("evidence", next.evidence);
  if (next.variant) params.set("variant", next.variant);
  if (next.baseline !== ctx.defaultBaseline) {
    params.set("baseline", next.baseline === "" ? "none" : next.baseline);
  }
  if (next.focus.length > 0) params.set("focus", next.focus.join(","));

  const search = params.toString().replace(/%2C/gi, ",");
  return `/${next.canvas}${suffix}${search ? `?${search}` : ""}`;
}

/** The screen the route points at: its id, or the first screen recorded under its route. */
export function resolveScreenId(route: Route, ctx: RouteContext): string | undefined {
  if (route.screen) return ctx.screenIdAliases?.get(route.screen) ?? route.screen;
  if (!route.screenRoute) return undefined;
  const alias = ctx.screenRouteAliases?.get(normalizeRoute(route.screenRoute));
  if (alias) return ctx.screenIdAliases?.get(alias.screenId) ?? alias.screenId;
  return routeOwners(ctx, route.screenRoute)[0];
}

export const CANVAS_LABELS: Record<CanvasView, string> = {
  map: "Map",
  screens: "Screens",
  compare: "Compare",
  flows: "Flows",
};

/** One line each, shown under the canvas name on hover, so the views are easy to tell apart. */
export const CANVAS_DESCRIPTIONS: Record<CanvasView, string> = {
  map: "How screens connect",
  screens: "Every screen in one grid",
  compare: "Before and After of each changed screen",
  flows: "Each e2e flow: its steps and the frames it took, Before and After",
};

export const FOCUS_LABELS: Record<FocusStatus, string> = {
  added: "Added",
  modified: "Modified",
  "accessibility-only": "Accessibility only",
  removed: "Removed",
  "needs-review": "No visible change",
  "source-affected": "Source-affected",
};

/** Direction is a Highlights reading preference; the other Map scopes use one stable layout. */
