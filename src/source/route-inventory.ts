import { discoverExpoRoutes, detectAppDir } from "./route-providers/expo-router.js";
import { discoverReactNavigation } from "./route-providers/react-navigation.js";
import { validateSourceRoutes, type SourceRoute } from "../contracts/source-route.js";
import { extractSourceNavigation } from "./navigation.js";
import { validateNavigationGraph, type NavigationGraph } from "../contracts/navigation-graph.js";
import type { SourceSnapshot } from "./dependency-graph.js";

export type DiscoverRouteOptions = {
  provider?: "auto" | "expo-router" | "react-navigation";
  entry?: string;
  scheme?: string;
  parameters?: Record<string, Record<string, string>>;
  platform?: "ios" | "android" | "web";
};
export type RouteInventory = { routes: SourceRoute[]; navigation: NavigationGraph; diagnostics: string[] };

/** The only discovery inputs are source files and explicit analysis/runtime settings. */
export function discoverRoutes(input: SourceSnapshot | Record<string, string>, options: DiscoverRouteOptions = {}): RouteInventory {
  const entries = input instanceof Map ? [...input] : Object.entries(input);
  const files = new Map(entries.filter(([file]) => !/(?:^|\/)surfaces?\.json$/.test(file) && !/(?:^|\/)(?:node_modules|\.git|dist|build|\.expo-explore|\.screenmap)\//.test(file)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (files.size > 50_000) throw new Error("Route inventory exceeds 50,000 source files");
  let provider = options.provider ?? "auto";
  if (provider === "auto") {
    let deps: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(files.get("package.json") ?? "{}");
      deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    } catch { /* Source evidence remains available when package metadata is absent. */ }
    const appDir = detectAppDir(files, options.entry);
    const hasFileRoutes = [...files.keys()].some(path => path.startsWith(`${appDir}/`) && /\.[jt]sx?$/.test(path));
    const hasRegistrations = [...files].some(([path, source]) => /\.[jt]sx?$/.test(path) && /create(?:NativeStack|Stack|BottomTab|MaterialTopTab|Drawer|MaterialBottomTab)Navigator|<[A-Za-z_$][\w$]*\.Screen\b/.test(source));
    if (deps["expo-router"] && hasFileRoutes) provider = "expo-router";
    else if (hasRegistrations) provider = "react-navigation";
    else if (hasFileRoutes) provider = "expo-router";
    else throw new Error("No supported navigation source found: expected Expo Router files or React Navigation registrations");
  }
  if (provider === "expo-router") {
    const discovered = discoverExpoRoutes(files, options);
    const routes = validateSourceRoutes(discovered.routes);
    const navigation = extractSourceNavigation(routes, files, options);
    return { routes, navigation, diagnostics: [...new Set([...discovered.diagnostics, ...navigation.unresolved])].sort() };
  }
  const discovered = discoverReactNavigation(Object.fromEntries(files), options);
  const routes = validateSourceRoutes(discovered.routes);
  const edgeMap = new Map(discovered.edges.map(edge => {
    const normalized = { from: edge.from, to: edge.to, kind: edge.kind, sourceFile: edge.sourceFile, provenance: "source" as const };
    return [JSON.stringify(normalized), normalized];
  }));
  const navigation = validateNavigationGraph({ contract: "explore.navigation",
    edges: [...edgeMap].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, edge]) => edge),
    modalSurfaceIds: [], unresolved: [...new Set(discovered.diagnostics)].sort(),
  }, routes.map(route => route.id));
  return { routes, navigation, diagnostics: [...new Set(discovered.diagnostics)].sort() };
}
