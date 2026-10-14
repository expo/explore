import { createHash } from "node:crypto";
import { canonicalizeSourceChanges, type SourceChange } from "./git-diff.js";
import type { SourceChangeSummary } from "./change-summary.js";
import { hasRuntimeChange, readSourceSnapshot, surfaceDependencies, type SourceSnapshot } from "./dependency-graph.js";
import { discoverRoutes, type DiscoverRouteOptions } from "./route-inventory.js";
import { sourceRouteNames, validateSourceRoutes, type SourceRoute } from "../contracts/source-route.js";
import { navigationCaptureContext, type NavigationGraph } from "../contracts/navigation-graph.js";
import { canonicalJson as canonicalJSON } from "../shared/canonical-json.js";
import { CiError } from "../shared/ci-errors.js";

export { readSourceSnapshot, surfaceDependencies };
export type { SourceSnapshot };
export type CaptureMode = "all" | "changes";
export type CapturePlanOptions = DiscoverRouteOptions & {
  baseSha: string;
  headSha: string;
  baseFiles: SourceSnapshot;
  headFiles: SourceSnapshot;
  baseRoutes?: SourceRoute[];
  headRoutes?: SourceRoute[];
  changedFiles: SourceChange[];
  externalChanges?: SourceChange[];
  mode?: CaptureMode;
  /** Routes named in exploration.exclude: kept in the map and its navigation context, never captured. */
  exclude?: string[];
  navigation?: Pick<DiscoverRouteOptions, "provider" | "entry">;
  navigationGraphs?: { base: NavigationGraph; head: NavigationGraph };
};
export type SourceCapturePlan = {
  contract: "explore.plan";
  baseSha: string;
  headSha: string;
  mode: CaptureMode;
  conservative: boolean;
  unresolved: string[];
  diagnostics: { base: string[]; head: string[] };
  navigation: { base: NavigationGraph; head: NavigationGraph };
  surfaces: Array<{ id: string; status: "added" | "removed" | "modified" | "unchanged"; baseSurface: SourceRoute | null; headSurface: SourceRoute | null; reasons: string[]; baseCapture: boolean; headCapture: boolean; sourceChange?: SourceChangeSummary }>;
  inventorySurfaceIds: string[];
  baseCaptureSurfaceIds: string[];
  headCaptureSurfaceIds: string[];
  /** Present only when config excludes routes, so plans without exclusions keep their digest. */
  excludedSurfaceIds?: string[];
};

// App-wide inputs that no route imports: package/lock files, Expo and bundler config, the EAS
// build profile, bundled environment files, and style tooling config.
const globalFiles = /^(?:package\.json|(?:package-lock|npm-shrinkwrap)\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|app\.json|app\.config\.[cm]?[jt]s|(?:babel|metro|tailwind|postcss)\.config\.[cm]?[jt]s|react-native\.config\.[cm]?js|eas\.json|\.env(?:\.[^/]+)?|tsconfig[^/]*\.json)$/;
// npm runs these during install; EAS Build runs its eas-build-* hooks.
const buildScripts = /^(?:(?:pre|post)?(?:install|prepare)|prepublish|eas-build-.+)$/;

const parseObject = (text: string | undefined): Record<string, unknown> | undefined => {
  try {
    const value: unknown = text ? JSON.parse(text) : undefined;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
};

/** Whether an EAS build profile runs a custom build, whose steps can call any package script. */
function customEasBuild(text: string | undefined): boolean {
  if (text === undefined) return false;
  const build = parseObject(text)?.build;
  if (build === undefined) return parseObject(text) === undefined;
  return !build || typeof build !== "object" || Object.values(build).some(profile => !profile || typeof profile !== "object" || "config" in profile);
}

/**
 * Whether a package.json edit touches only scripts that neither install nor the build runs.
 * Build hooks can run other scripts by name, and npm runs pre<name>/post<name> around each,
 * so every script reachable that way counts as part of the build.
 */
function scriptsOnlyChange(before: string | undefined, after: string | undefined, easConfigs: readonly (string | undefined)[]): boolean {
  const base = parseObject(before), head = parseObject(after);
  if (!base || !head || easConfigs.some(customEasBuild)) return false;
  const { scripts: baseScripts = {}, ...baseRest } = base;
  const { scripts: headScripts = {}, ...headRest } = head;
  if (canonicalJSON(baseRest) !== canonicalJSON(headRest)) return false;
  const scripts = [baseScripts, headScripts];
  if (!scripts.every(value => value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every(command => typeof command === "string"))) return false;
  const [old, current] = scripts as [Record<string, string>, Record<string, string>];
  const names = [...new Set([...Object.keys(old), ...Object.keys(current)])];
  const reachable = new Set(names.filter(name => buildScripts.test(name)));
  for (let grown = true; grown;) {
    grown = false;
    for (const name of [...reachable]) {
      const commands = [old[name], current[name]].filter((command): command is string => command !== undefined);
      // Substring matching over-approximates a script reference, which only widens capture.
      for (const other of names) {
        if (!reachable.has(other) && (commands.some(command => command.includes(other)) || other === `pre${name}` || other === `post${name}`)) {
          reachable.add(other); grown = true;
        }
      }
    }
  }
  return names.every(name => old[name] === current[name] || !reachable.has(name));
}

/** The package entry file, when package.json names a local one; it wraps every screen. */
function entryFile(text: string | undefined): string | undefined {
  const main = parseObject(text)?.main;
  if (typeof main !== "string" || !/^\.?\/?[\w@.-][\w@./-]*$/.test(main) || main.split("/").includes("..")) return undefined;
  return main.replace(/^\.\//, "");
}

export function createSourceCapturePlan(options: CapturePlanOptions): SourceCapturePlan {
  for (const [name, value] of [["baseSha", options.baseSha], ["headSha", options.headSha]]) if (!/^[a-f0-9]{40}$/.test(value!)) throw new Error(`${name} must be a full lowercase commit SHA`);
  const mode = options.mode ?? "changes";
  if (mode !== "all" && mode !== "changes") throw new Error("mode must be all or changes");
  const discoveryOptions = { ...options, ...options.navigation };
  const baseInventory = discoverRoutes(options.baseFiles, discoveryOptions);
  const headInventory = discoverRoutes(options.headFiles, discoveryOptions);
  const checkedRoutes = (supplied: SourceRoute[] | undefined, discovered: SourceRoute[], side: string): SourceRoute[] => {
    if (supplied && canonicalJSON(validateSourceRoutes(supplied)) !== canonicalJSON(discovered)) {
      throw new Error(`${side} routes must match the source-derived inventory; route overrides are not supported`);
    }
    return discovered;
  };
  const baseRoutes = checkedRoutes(options.baseRoutes, baseInventory.routes, "base");
  const headRoutes = checkedRoutes(options.headRoutes, headInventory.routes, "head");
  const base = surfaceDependencies(baseRoutes, options.baseFiles, options.platform);
  const head = surfaceDependencies(headRoutes, options.headFiles, options.platform);
  const changes = canonicalizeSourceChanges(options.changedFiles).filter(change => !/(?:^|\/)surfaces?\.json$/.test(change.path));
  const changedPaths = new Set(changes.flatMap(change => [change.path, ...("previousPath" in change ? [change.previousPath] : [])]));
  const externalRuntimeChange = hasRuntimeChange(options.externalChanges ?? []);
  const unresolved = [...new Set([...base.unresolved, ...head.unresolved,
    ...(externalRuntimeChange ? ["Workspace sources outside the app changed; capture every source route"] : [])])].sort();
  const conservative = externalRuntimeChange || hasRuntimeChange(changes) && unresolved.length > 0;
  const entries = new Set([entryFile(options.baseFiles.get("package.json")), entryFile(options.headFiles.get("package.json"))]
    .flatMap(main => main ? [main, ...["tsx", "ts", "jsx", "js"].map(ext => `${main}.${ext}`)] : []));
  const global = [...changedPaths].filter(path => (globalFiles.test(path) || entries.has(path))
    && !(path === "package.json" && scriptsOnlyChange(options.baseFiles.get(path), options.headFiles.get(path), [options.baseFiles.get("eas.json"), options.headFiles.get("eas.json")]))).sort();
  const baseById = new Map(base.routes.map(route => [route.id, route]));
  const headById = new Map(head.routes.map(route => [route.id, route]));
  const navigation = options.navigationGraphs ?? { base: baseInventory.navigation, head: headInventory.navigation };
  const definitions = [...new Set([...baseById.keys(), ...headById.keys()])].sort().map(id => {
    const baseSurface = baseById.get(id) ?? null;
    const headSurface = headById.get(id) ?? null;
    const dependencies = new Set([...(baseSurface?.sourceFiles ?? []), ...(headSurface?.sourceFiles ?? [])]);
    const touched = [...changedPaths].filter(path => dependencies.has(path)).sort();
    const sourceChanged = baseSurface && headSurface && [...dependencies].some(path => options.baseFiles.get(path) !== options.headFiles.get(path));
    const definitionChanged = baseSurface && headSurface && canonicalJSON(baseSurface) !== canonicalJSON(headSurface);
    // A redirect renders no interface: only its own declaration can change what it does, so
    // imported or app-wide edits cannot make it a reviewable difference.
    const forwardsOnly = baseSurface?.kind === "redirect" && headSurface?.kind === "redirect";
    const declarationChanged = baseSurface && headSurface
      && canonicalJSON({ ...baseSurface, sourceFiles: [] }) !== canonicalJSON({ ...headSurface, sourceFiles: [] });
    const changed = forwardsOnly
      ? Boolean(declarationChanged)
      : Boolean(touched.length || global.length || sourceChanged || definitionChanged || conservative);
    const status = !baseSurface ? "added" as const : !headSurface ? "removed" as const
      : changed ? "modified" as const : "unchanged" as const;
    const reasons = forwardsOnly
      ? (declarationChanged ? ["Source route definition changed"] : [])
      : [...touched.map(path => `Source changed: ${path}`), ...global.map(path => `App configuration changed: ${path}`),
        ...(definitionChanged ? ["Source route definition changed"] : []), ...(sourceChanged && !touched.length ? ["Source snapshot content changed"] : []), ...(conservative ? unresolved : [])].sort();
    return { id, status, baseSurface, headSurface, reasons };
  });
  const seeds = definitions.filter(route => route.status !== "unchanged").map(route => route.id);
  const selected = { base: new Set(navigationCaptureContext(navigation.base, seeds, baseRoutes)), head: new Set(navigationCaptureContext(navigation.head, seeds, headRoutes)) };
  const excluded = excludedSurfaceIds(definitions, options.exclude ?? []);
  const surfaces = definitions.map(route => ({ ...route,
    baseCapture: Boolean(route.baseSurface && route.baseSurface.kind !== "redirect" && !excluded.includes(route.id) && (mode === "all" || selected.base.has(route.id))),
    headCapture: Boolean(route.headSurface && route.headSurface.kind !== "redirect" && !excluded.includes(route.id) && (mode === "all" || selected.head.has(route.id))),
  }));
  return { contract: "explore.plan", baseSha: options.baseSha, headSha: options.headSha, mode, conservative, unresolved, surfaces, navigation,
    diagnostics: { base: baseInventory.diagnostics, head: headInventory.diagnostics },
    inventorySurfaceIds: surfaces.map(route => route.id), baseCaptureSurfaceIds: surfaces.filter(route => route.baseCapture).map(route => route.id), headCaptureSurfaceIds: surfaces.filter(route => route.headCapture).map(route => route.id),
    ...(excluded.length ? { excludedSurfaceIds: excluded } : {}),
  };
}

function excludedSurfaceIds(definitions: ReadonlyArray<{ id: string; baseSurface: SourceRoute | null; headSurface: SourceRoute | null }>, exclude: readonly string[]): string[] {
  const names = new Set(exclude);
  const matched = new Set<string>();
  const ids = definitions.filter(row => [row.baseSurface, row.headSurface].some(route => route && sourceRouteNames(route).some(name => {
    if (!names.has(name)) return false;
    matched.add(name);
    return true;
  }))).map(row => row.id);
  // A misspelled or deleted route would otherwise silently capture again.
  const unknown = exclude.filter(name => !matched.has(name));
  if (unknown.length) throw new CiError({ code: "EXCLUDE_ROUTE_UNKNOWN", stage: "plan",
    message: `exploration.exclude names routes that are not source routes at either compared revision: ${unknown.join(", ")}.`,
    nextAction: "Use a route id, route, logical path, or link path from the source plan (expo-explore doctor --json lists them), or remove the entry." });
  return ids;
}

/**
 * Which source change reaches a surface present at both revisions: `screen` when its own route,
 * declaration, or imported source changed; `app-wide` when only app-wide inputs changed (or the
 * plan is conservative); `none` when its source is unchanged. Added and removed surfaces have no
 * comparison scope.
 */
export type SurfaceSourceScope = "screen" | "app-wide" | "none";
export function surfaceSourceScope(surface: Pick<SourceCapturePlan["surfaces"][number], "status" | "reasons">): SurfaceSourceScope | undefined {
  if (surface.status === "added" || surface.status === "removed") return undefined;
  if (surface.status === "unchanged") return "none";
  return surface.reasons.some(reason => reason.startsWith("Source changed: ")
    || reason === "Source route definition changed" || reason === "Source snapshot content changed") ? "screen" : "app-wide";
}

/** Commit bindings belong to execution metadata, never the canonical source-analysis content. */
export function canonicalPlan(plan: SourceCapturePlan): string {
  const { baseSha: _baseSha, headSha: _headSha, ...content } = plan;
  return canonicalJSON({ ...content, surfaces: content.surfaces.map(({ sourceChange: _sourceChange, ...surface }) => surface) });
}

export function verifyDeterministicPlan(options: CapturePlanOptions): { deterministic: true; digest: string; plan: SourceCapturePlan } {
  const plan = createSourceCapturePlan(options);
  const repeat = createSourceCapturePlan({ ...options, baseFiles: new Map([...options.baseFiles].reverse()), headFiles: new Map([...options.headFiles].reverse()), changedFiles: [...options.changedFiles].reverse() });
  const canonical = canonicalPlan(plan);
  if (canonical !== canonicalPlan(repeat)) throw new Error("Source plan depends on input enumeration order");
  return { deterministic: true, digest: createHash("sha256").update(canonical).digest("hex"), plan };
}
