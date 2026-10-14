import { spawnSync } from "node:child_process";
import { discoverRoutes } from "../source/route-inventory.js";
import { readSourceSnapshot } from "../source/dependency-graph.js";
import { hasConcreteRoutePath } from "../capture/route-capture.js";
import type { ExploreConfig } from "../config/explore-config.js";
import { sourceRouteNames, type SourceRoute } from "../contracts/source-route.js";
import type { NavigationGraph } from "../contracts/navigation-graph.js";
import { projectPrefix } from "./verified-plan.js";

/**
 * How deterministic capture can enter a route, from source alone:
 * - ready: the app link is complete;
 * - needs-parameters: a dynamic segment has no configured value;
 * - no-link: the app has no custom scheme, or source declares no link path for the screen;
 * - redirect: the route forwards to another screen and has no screenshot of its own.
 */
export type RouteEntryStatus = "ready" | "needs-parameters" | "no-link" | "redirect";

/** A source redirect that can send this route elsewhere, such as a layout guard. */
export type RouteGuard = { to: string; sourceFile: string };

export type RouteEntry = {
  id: string;
  logicalPath: string;
  routeFile: string;
  path: string | null;
  status: RouteEntryStatus;
  /** The `parameters` key setup writes for this route. */
  parameterKey: string;
  missingParameters: string[];
  guards: RouteGuard[];
  /**
   * Search (query) parameters the screen reads: names that config does not set yet, and whether it
   * also reads parameters whose names are not visible in the route file (a named type or a rest binding).
   */
  searchParameters: { unset: string[]; opaque: boolean };
  /** A setup `open` action opens this route's link, or a setup action names it in requiresRoute. */
  openedBySetup: boolean;
  /** exploration.exclude names this route, so capture never opens it. */
  excluded: boolean;
};

export type RouteEntryReport = {
  commit: string;
  provider: SourceRoute["provider"] | null;
  routes: RouteEntry[];
  diagnostics: string[];
  unusedParameterKeys: string[];
  unknownSetupRoutes: string[];
  unknownExcludedRoutes: string[];
};

type RouteEntryInput = Pick<ExploreConfig, "navigation" | "app" | "parameters" | "setup"> & { exploration?: Pick<ExploreConfig["exploration"], "exclude"> };

const LAYOUT_FILE = /(?:^|\/)_layout\.[cm]?[jt]sx?$/;

function expoPattern(logicalPath: string): string {
  const segments = logicalPath.split("/").filter(Boolean).filter(segment => !/^\(.*\)$/.test(segment));
  if (segments.at(-1) === "index") segments.pop();
  return `/${segments.join("/")}`;
}

function missingParameters(route: SourceRoute): string[] {
  if (route.provider === "expo-router") {
    return [...(route.path ?? route.route).matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map(match => match[1]!);
  }
  return Object.entries(route.pathParameters ?? {})
    .filter(([name, kind]) => kind === "required" && route.parameters?.[name] === undefined).map(([name]) => name);
}

const SEARCH_HOOK = /\b(?:useLocalSearchParams|useGlobalSearchParams|useSearchParams)\s*(<[^>]*>)?\s*\(/g;

/** Names a screen reads from its search parameters, as far as its own file shows them. */
export function readSearchParameters(source: string): { names: string[]; opaque: boolean } | undefined {
  const names = new Set<string>();
  let found = false; let opaque = false;
  for (const match of source.matchAll(SEARCH_HOOK)) {
    found = true;
    const generic = match[1] ?? "";
    for (const literal of generic.matchAll(/\{([^{}]*)\}/g)) for (const key of literal[1]!.matchAll(/([A-Za-z_$][\w$]*)\??\s*:/g)) names.add(key[1]!);
    if (/<\s*[A-Z]\w*/.test(generic) || /&\s*[A-Z]\w*/.test(generic)) opaque = true;
    const before = source.slice(Math.max(0, match.index! - 200), match.index!);
    const binding = /(?:const|let|var)\s+(\{[^{}]*\}|[A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)?.[1];
    if (binding?.startsWith("{")) {
      for (const part of binding.slice(1, -1).split(",").map(item => item.trim()).filter(Boolean)) {
        if (part.startsWith("...")) { opaque = true; continue; }
        names.add(part.split(/[:=]/)[0]!.trim());
      }
    } else if (!generic.includes("{")) opaque = true;
  }
  for (const match of source.matchAll(/\broute\.params\??\.([A-Za-z_$][\w$]*)/g)) { found = true; names.add(match[1]!); }
  return found ? { names: [...names].sort(), opaque } : undefined;
}

function linkPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `/${[parsed.host, ...parsed.pathname.split("/")].filter(Boolean).join("/")}`;
  } catch { return undefined; }
}

/** Summarize discovered routes for setup. Everything here comes from source and config, never from the app at runtime. */
export function summarizeRouteEntry(routes: readonly SourceRoute[], navigation: NavigationGraph, config: RouteEntryInput,
  files: ReadonlyMap<string, string> = new Map()): Omit<RouteEntryReport, "commit" | "diagnostics"> {
  const byId = new Map(routes.map(route => [route.id, route]));
  const setup = config.setup ?? [];
  const opened = new Set(setup.flatMap(action => action.action === "open" ? [linkPath(action.url)].filter((path): path is string => !!path) : []));
  const required = new Set(setup.flatMap(action => action.requiresRoute ? [action.requiresRoute] : []));
  const exclude = new Set(config.exploration?.exclude ?? []);
  const known = new Set(routes.flatMap(sourceRouteNames));
  const keys = new Set<string>();
  const entries = routes.map((route): RouteEntry => {
    const pattern = route.provider === "expo-router" ? expoPattern(route.logicalPath) : route.logicalPath;
    for (const key of [route.id, route.logicalPath, pattern, ...(route.provider === "react-navigation" ? [route.route] : [])]) keys.add(key);
    const missing = missingParameters(route);
    const status: RouteEntryStatus = route.kind === "redirect" ? "redirect"
      : hasConcreteRoutePath(route) && config.app.scheme ? "ready"
      : missing.length ? "needs-parameters" : "no-link";
    const guards = navigation.edges
      .filter(edge => edge.from === route.id && (edge.kind === "redirect" || edge.kind === "replace" && LAYOUT_FILE.test(edge.sourceFile)))
      .map(edge => ({ to: byId.get(edge.to)?.logicalPath ?? edge.to, sourceFile: edge.sourceFile }));
    const path = route.path?.split("?")[0];
    const search = readSearchParameters(files.get(route.routeFile) ?? "");
    const pathNames = new Set([...(route.provider === "expo-router" ? [...route.logicalPath.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map(match => match[1]!) : []),
      ...Object.keys(route.pathParameters ?? {})]);
    const configured = new Set(Object.keys(route.parameters ?? {}));
    return { id: route.id, logicalPath: route.logicalPath, routeFile: route.routeFile, path: route.path, status,
      parameterKey: pattern, missingParameters: missing, guards: [...new Map(guards.map(guard => [JSON.stringify(guard), guard])).values()],
      searchParameters: { unset: (search?.names ?? []).filter(name => !pathNames.has(name) && !configured.has(name)),
        opaque: !!search?.opaque && ![...configured].some(name => !pathNames.has(name)) },
      openedBySetup: sourceRouteNames(route).some(name => required.has(name)) || !!path && opened.has(path),
      excluded: sourceRouteNames(route).some(name => exclude.has(name)) };
  });
  return {
    provider: routes[0]?.provider ?? null,
    routes: entries,
    // React Navigation also accepts linking patterns (such as items/:id) that discovery does not keep.
    unusedParameterKeys: Object.keys(config.parameters ?? {}).filter(key => !keys.has(key) && !key.includes(":")).sort(),
    unknownSetupRoutes: [...required].filter(name => !known.has(name)).sort(),
    unknownExcludedRoutes: [...exclude].filter(name => !known.has(name)).sort(),
  };
}

/** Analyze the app's committed source at HEAD, the same snapshot CI reads for a pushed commit. */
export function readRouteEntry(project: string, config: RouteEntryInput): RouteEntryReport {
  const head = spawnSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 });
  if (head.error || head.status !== 0) throw new Error("Route analysis reads committed source. Commit the app to Git, then rerun.");
  const commit = head.stdout.trim();
  const prefix = projectPrefix(project);
  const files = new Map([...readSourceSnapshot(project, commit)]
    .filter(([path]) => path.startsWith(prefix)).map(([path, source]) => [path.slice(prefix.length), source]));
  const inventory = discoverRoutes(files, {
    provider: config.navigation.provider,
    ...(config.navigation.entry ? { entry: config.navigation.entry } : {}),
    ...(config.app.scheme ? { scheme: config.app.scheme } : {}),
    ...(config.parameters ? { parameters: config.parameters } : {}),
    platform: config.app.platform,
  });
  return { commit, diagnostics: inventory.diagnostics, ...summarizeRouteEntry(inventory.routes, inventory.navigation, config, files) };
}
