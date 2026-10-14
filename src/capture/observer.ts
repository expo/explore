import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SourceRoute } from "../contracts/source-route.js";
import { appRoute } from "../contracts/source-validation.js";

export const CAPTURE_OBSERVER_IDENTIFIER = "expo-explore-observer";
export type CaptureDestination = {
  provider: SourceRoute["provider"];
  pathname?: string;
  segments: string[];
  parameters: Record<string, string | string[]>;
};

/** This function is also emitted into the disposable bundle. It never changes state. */
export function observedNavigationState(state: unknown, parameterKeys: readonly string[] = []): { segments: string[]; parameters: Record<string, unknown> } | null {
  const segments: string[] = [];
  const parameters: Record<string, unknown> = Object.create(null);
  const requested = new Set(parameterKeys);
  const visited = new Set<unknown>();
  let current = state;
  for (let depth = 0; current !== undefined && current !== null; depth++) {
    if (depth >= 64 || typeof current !== "object" || visited.has(current)) return null;
    visited.add(current);
    const node = current as { routes?: unknown; index?: unknown };
    if (!Array.isArray(node.routes) || !node.routes.length) return null;
    const index = node.index ?? (node.routes.length === 1 ? 0 : undefined);
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= node.routes.length) return null;
    const route = node.routes[index] as { name?: unknown; params?: unknown; state?: unknown } | undefined;
    if (!route || typeof route.name !== "string" || !route.name || route.name.length > 1024) return null;
    segments.push(route.name);
    if (route.params && typeof route.params === "object" && !Array.isArray(route.params)) {
      if (!observedParametersComplete(route.params, parameterKeys)) return null;
      for (const [key, value] of Object.entries(route.params)) {
        if (requested.has(key) && Object.hasOwn(parameters, key) && JSON.stringify(parameters[key]) !== JSON.stringify(value)) return null;
        parameters[key] = value;
      }
    }
    current = route.state;
  }
  return segments.length ? { segments, parameters } : null;
}

/** Only statically requested parameter names may enter accessibility diagnostics. */
export function observedParameters(value: unknown, keys: readonly string[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const key of [...new Set(keys)].sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (typeof item === "string" && item.length <= 2048) result[key] = item;
    else if (typeof item === "number" && Number.isFinite(item) || typeof item === "boolean") result[key] = String(item);
    else if (Array.isArray(item) && item.length <= 64 && item.every(part => typeof part === "string" && part.length <= 2048)) result[key] = [...item];
  }
  return result;
}

/** Requested values that cannot be published must not masquerade as absent optional parameters. */
export function observedParametersComplete(value: unknown, keys: readonly string[]): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const parameters = observedParameters(value, keys);
  return keys.every(key => !Object.hasOwn(value, key) || Object.hasOwn(parameters, key));
}

/**
 * The route observers a snapshot exposes. agent-device 0.21.x can serve a snapshot from its host
 * Simulator AX bridge, which reports the same observer element twice with the same label and
 * rect. Those copies are one element. Observers with a different label or rect stay separate,
 * so two active destinations remain ambiguous.
 */
export function captureObserverMarkers<Node extends Record<string, unknown>>(nodes: readonly Node[]): Node[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    if (node.identifier !== CAPTURE_OBSERVER_IDENTIFIER) return false;
    const rect = node.rect !== null && typeof node.rect === "object" ? node.rect as Record<string, unknown> : {};
    const key = JSON.stringify([node.label, rect.x, rect.y, rect.width, rect.height]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseCaptureDestination(label: unknown): CaptureDestination | null {
  if (typeof label !== "string" || label.length > 32_768) return null;
  let value: unknown;
  try { value = JSON.parse(label); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["provider", "pathname", "segments", "parameters"].includes(key))
    || item.provider !== "expo-router" && item.provider !== "react-navigation"
    || !Array.isArray(item.segments) || item.segments.length > 64
    || item.segments.some(segment => typeof segment !== "string" || !segment || segment.length > 1024)
    || !item.parameters || typeof item.parameters !== "object" || Array.isArray(item.parameters)) return null;
  if (item.provider === "expo-router" && (typeof item.pathname !== "string" || !item.pathname.startsWith("/") || item.pathname.length > 8192)) return null;
  if (item.provider === "react-navigation" && (item.pathname !== undefined || item.segments.length === 0)) return null;
  const parameters = observedParameters(item.parameters, Object.keys(item.parameters));
  if (JSON.stringify(Object.entries(parameters).sort()) !== JSON.stringify(Object.entries(item.parameters).sort())) return null;
  return { provider: item.provider, segments: [...item.segments] as string[], parameters,
    ...(typeof item.pathname === "string" ? { pathname: item.pathname } : {}) };
}

export function captureObserverParameterKeys(routes: readonly SourceRoute[]): string[] {
  return [...new Set(routes.flatMap(route => [
    ...Object.keys(route.parameters ?? {}),
    ...Object.keys(route.pathParameters ?? {}),
    ...[...(route.path ? new URL(route.path, "https://explore.invalid").searchParams.keys() : [])],
    ...[...route.logicalPath.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map(match => match[1]!),
  ]))].sort();
}

/** Bind Expo path placeholders to observed values without changing configured query parameters. */
export function captureDestinationPath(destination: CaptureDestination, route: SourceRoute): string | null {
  if (route.provider !== "expo-router") return route.path;
  let path = route.path;
  if (path === null) {
    const segments = route.logicalPath.split("/").filter(segment => segment && !/^\(.*\)$/.test(segment));
    if (segments.at(-1) === "index") segments.pop();
    path = `/${segments.join("/")}`;
  }
  const queryAt = path.indexOf("?");
  const query = queryAt === -1 ? "" : path.slice(queryAt);
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  let missing = false;
  try {
    const resolved = pathname.replace(/\[(\.\.\.)?([^\]]+)\]/g, (token, catchAll: string | undefined, name: string) => {
      const value = destination.parameters[name];
      const parts = catchAll ? (Array.isArray(value) ? value : typeof value === "string" ? value.split("/") : [])
        : typeof value === "string" ? [value] : [];
      if (!parts.length || parts.some(part => !part || part === "." || part === "..")) { missing = true; return token; }
      return parts.map(encodeURIComponent).join("/");
    });
    if (missing || resolved !== destination.pathname && decodeURIComponent(resolved) !== destination.pathname) return null;
    return appRoute(resolved + query, "observed capture path");
  } catch { return null; }
}

/** Requires an actual destination and exactly one compatible source route. */
export function captureDestinationMatches(destination: CaptureDestination, target: SourceRoute, routes: readonly SourceRoute[], options: { allowNavigationOnly?: boolean } = {}): boolean {
  const navigationChain = (route: SourceRoute): string | null => {
    // Inventory roots are '<source-file>#<navigator-binding>'; neither is an active screen.
    const root = route.logicalPath.lastIndexOf("#");
    const start = root === -1 ? -1 : route.logicalPath.indexOf("/", root);
    return start === -1 ? null : route.logicalPath.slice(start);
  };
  const expectedParameters = (route: SourceRoute): Record<string, string | string[]> => {
    const values: Record<string, string | string[]> = Object.assign(Object.create(null), route.parameters);
    if (route.path) {
      const query = new URL(route.path, "https://explore.invalid").searchParams;
      for (const key of query.keys()) { const all = query.getAll(key); values[key] = all.length === 1 ? all[0]! : all; }
    }
    return values;
  };
  const matches = (route: SourceRoute): boolean => {
    if (route.provider !== destination.provider || route.path === null && !options.allowNavigationOnly) return false;
    if (route.provider === "expo-router") {
      const segments = route.logicalPath.split("/").filter(Boolean);
      if (segments.at(-1) === "index") segments.pop();
      if (JSON.stringify(segments) !== JSON.stringify(destination.segments)) return false;
      if (!options.allowNavigationOnly && /\[[^\]]+\]/.test(route.path!.split("?")[0]!)) return false;
      if (captureDestinationPath(destination, route) === null) return false;
    } else {
      const suffix = "/" + destination.segments.map(segment => encodeURIComponent(segment)).join("/");
      if (navigationChain(route) !== suffix) return false;
      // A root navigator identity is not available at runtime. Never guess between roots.
      if (routes.filter(candidate => candidate.provider === "react-navigation" && navigationChain(candidate) === suffix).length !== 1) return false;
    }
    for (const [name, requirement] of Object.entries(route.pathParameters ?? {})) {
      if (requirement === "required" && (typeof destination.parameters[name] !== "string" || !destination.parameters[name])) return false;
    }
    for (const [key, expected] of Object.entries(expectedParameters(route))) {
      const actual = destination.parameters[key];
      if (typeof expected === "string" && Array.isArray(actual) && route.logicalPath.includes(`[...${key}]`)) {
        if (actual.join("/") !== expected) return false;
      } else if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
    }
    return true;
  };
  return matches(target) && routes.filter(matches).length === 1;
}

const OBSERVER_RUNTIME = String.raw`
const React = require('react');
const { View } = require('react-native');
const Original = require(SCENE_FILE);
const { NavigationContainerRefContext } = require(CONTEXT_FILE);
function DestinationObserver() {
  // SceneView is loaded while the navigation barrel is still initializing. Expo
  // Router's barrel creates navigators immediately, so load its hooks only during
  // render, after those navigation exports are ready.
  const Router = PROVIDER === 'expo-router' ? require('expo-router') : null;
  const navigation = React.useContext(NavigationContainerRefContext);
  const subscribe = React.useCallback((listener) => {
    if (!navigation) return () => {};
    const removers = ['ready', 'state'].map(event => navigation.addListener(event, listener));
    return () => removers.forEach(remove => remove());
  }, [navigation]);
  const snapshot = React.useCallback(() => {
    if (!navigation || !navigation.isReady()) return '';
    const state = observedNavigationState(navigation.getRootState(), PARAMETER_KEYS);
    return state ? JSON.stringify({ segments: state.segments, parameters: observedParameters(state.parameters, PARAMETER_KEYS) }) : '';
  }, [navigation]);
  const stateText = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  // Provider is fixed for the lifetime of this generated module, so hook order is fixed.
  const pathname = Router ? Router.usePathname() : undefined;
  const segments = Router ? Router.useSegments() : undefined;
  const parameters = Router ? Router.useGlobalSearchParams() : undefined;
  if (!stateText) return null;
  if (Router && !observedParametersComplete(parameters, PARAMETER_KEYS)) return null;
  const state = JSON.parse(stateText);
  const destination = Router
    ? { provider: PROVIDER, pathname, segments, parameters: observedParameters(parameters, PARAMETER_KEYS) }
    : { provider: PROVIDER, segments: state.segments, parameters: state.parameters };
  const label = JSON.stringify(destination);
  if (label.length > 32768) return null;
  return React.createElement(View, {
    accessible: true, accessibilityLabel: label, accessibilityRole: 'text', collapsable: false,
    nativeID: MARKER_IDENTIFIER, testID: MARKER_IDENTIFIER, pointerEvents: 'none',
    // Android reports a view under the status-bar inset as not visible to the user, so the marker sits mid-height.
    style: { position: 'absolute', left: 0, top: '50%', width: 1, height: 1 }
  });
}
function useFocusedLeaf(navigation, routeState) {
  const subscribe = React.useCallback((listener) => {
    if (!navigation || typeof navigation.addListener !== 'function') return () => {};
    const removers = ['focus', 'blur'].map(event => navigation.addListener(event, listener));
    return () => removers.forEach(remove => { if (typeof remove === 'function') remove(); });
  }, [navigation]);
  const isFocused = React.useCallback(() => !!navigation && typeof navigation.isFocused === 'function' && navigation.isFocused() === true, [navigation]);
  const focused = React.useSyncExternalStore(subscribe, isFocused, isFocused);
  // A route hosting a nested navigator is never the visible destination itself.
  return focused && routeState === undefined;
}
const Scene = Original.SceneView || Original.default;
if (typeof Scene !== 'function' || !NavigationContainerRefContext) throw new Error('Explore capture observer cannot load the navigation scene.');
function ExploreObservedScene(props) {
  // The marker lives inside the focused screen itself, so native modals and sheets expose it too.
  const leaf = useFocusedLeaf(props.navigation, props.routeState);
  return React.createElement(React.Fragment, null,
    React.createElement(Scene, props),
    leaf ? React.createElement(DestinationObserver) : null);
}
const descriptors = Object.getOwnPropertyDescriptors(Original);
if (descriptors.SceneView) descriptors.SceneView = { enumerable: true, value: ExploreObservedScene };
if (descriptors.default) descriptors.default = { enumerable: true, value: ExploreObservedScene };
Object.defineProperties(exports, descriptors);
`;

const METRO_RUNTIME = String.raw`
const path = require('node:path');
const { createRequire } = require('node:module');
const { realpathSync } = require('node:fs');
// Paths are relative to this file so the generated directory can travel with a staged copy of the checkout.
const PROJECT = path.resolve(__dirname, PROJECT_RELATIVE);
const GENERATED_ROOT = __dirname;
const proxyByScene = {};
for (const [scene, proxy] of Object.entries(PROXIES)) {
  let key = path.resolve(PROJECT, scene);
  try { key = realpathSync(key); } catch {}
  proxyByScene[key] = path.resolve(__dirname, proxy);
}
const appRequire = createRequire(PROJECT + '/package.json');
const expoRequire = createRequire(appRequire.resolve('expo/package.json'));
const { loadUserConfig } = appRequire('expo/metro-config');
const { getMetroServerRoot } = expoRequire('@expo/config/paths');
module.exports = (async () => {
  // Deliberately omit overrideConfigPath: load the real application's config, not this file.
  const original = await loadUserConfig({ projectRoot: PROJECT, serverRoot: getMetroServerRoot(PROJECT) });
  const previous = original.resolver.resolveRequest;
  const proxies = new Set(Object.values(proxyByScene));
  return {
    ...original,
    cacheVersion: (original.cacheVersion || '') + '-explore-observer-' + RECIPE_HASH,
    watchFolders: [...new Set([...(original.watchFolders || []), GENERATED_ROOT])],
    resolver: {
      ...original.resolver,
      resolveRequest(context, moduleName, platform) {
        const generated = proxies.has(context.originModulePath);
        // Bare imports from a proxy resolve as the application would; its relative imports keep their origin.
        const adjusted = generated && !moduleName.startsWith('.') && !path.isAbsolute(moduleName)
          ? { ...context, originModulePath: PROJECT + '/package.json' } : context;
        const result = previous ? previous(adjusted, moduleName, platform) : context.resolveRequest(adjusted, moduleName, platform);
        if (result.type !== 'sourceFile' || generated) return result;
        const scenePath = /[/\\]SceneView\.[cm]?[jt]sx?$/.test(result.filePath) ? realpathSync(result.filePath) : result.filePath;
        return proxyByScene[scenePath] ? { ...result, filePath: proxyByScene[scenePath] } : result;
      }
    }
  };
})();
`;

export const CAPTURE_OBSERVER_HASH = createHash("sha256")
  .update(CAPTURE_OBSERVER_IDENTIFIER).update(observedNavigationState.toString()).update(observedParameters.toString())
  .update(observedParametersComplete.toString())
  .update(parseCaptureDestination.toString()).update(captureObserverParameterKeys.toString()).update(captureDestinationMatches.toString())
  .update(captureDestinationPath.toString())
  .update(OBSERVER_RUNTIME).update(METRO_RUNTIME).digest("hex");

/** The installed packages the capture observer supports; throws a readable reason for anything else. */
const major = (version: string) => Number.parseInt(version, 10);

export async function captureCompatibility(project: string, provider: SourceRoute["provider"]): Promise<{ expoVersion: string; navigationPackage: string; navigationVersion: string }> {
  const appRequire = createRequire(join(project, "package.json"));
  const expoPackage = appRequire.resolve("expo/package.json");
  const expoVersion = JSON.parse(await readFile(expoPackage, "utf8")).version as string;
  if (!(major(expoVersion) >= 57)) throw new Error(`Automatic capture instrumentation requires Expo SDK 57 or newer; installed Expo is ${expoVersion}.`);
  const expoRequire = createRequire(expoPackage);
  const cliRoot = dirname(expoRequire.resolve("@expo/cli/package.json"));
  const metroLoader = await readFile(join(cliRoot, "build/src/start/server/metro/instantiateMetro.js"), "utf8");
  if (!metroLoader.includes("overrideConfigPath: _env.env.EXPO_OVERRIDE_METRO_CONFIG")) throw new Error("The installed Expo CLI does not support the capture Metro configuration override.");
  if (provider === "expo-router") {
    const navigationPackage = appRequire.resolve("expo-router/package.json");
    const navigationVersion = JSON.parse(await readFile(navigationPackage, "utf8")).version as string;
    if (!(major(navigationVersion) >= 57)) throw new Error(`Capture instrumentation requires Expo Router 57 or newer; installed version is ${navigationVersion}.`);
    return { expoVersion, navigationPackage, navigationVersion };
  }
  const navigationPackage = appRequire.resolve("@react-navigation/core/package.json");
  const navigationVersion = JSON.parse(await readFile(navigationPackage, "utf8")).version as string;
  if (!(major(navigationVersion) >= 6)) throw new Error(`Capture instrumentation requires React Navigation 6 or newer; installed core is ${navigationVersion}.`);
  return { expoVersion, navigationPackage, navigationVersion };
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { return join(await realpath(dirname(path)), basename(path)); }
}

export async function prepareCaptureObserver(options: {
  project: string;
  outputDirectory: string;
  /** Where the application root will live when Metro runs the generated files (a staged copy of the checkout); defaults to `project`. */
  mountProject?: string;
  provider: SourceRoute["provider"];
  parameterKeys?: readonly string[];
}): Promise<{ environment: { EXPO_OVERRIDE_METRO_CONFIG: string }; recipeHash: string; files: string[] }> {
  const project = await realpath(options.project);
  const requestedDirectory = resolve(options.outputDirectory);
  const inside = relative(project, requestedDirectory);
  if (!inside || !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside)) throw new Error("Capture observer files must be outside the application checkout.");
  // Canonicalize the existing temporary parent before creating anything. A symlink
  // outside the checkout must not redirect generated files back into app sources.
  const outputDirectory = join(await realpath(dirname(requestedDirectory)), basename(requestedDirectory));
  const canonicalInside = relative(project, outputDirectory);
  if (!canonicalInside || !canonicalInside.startsWith(`..${sep}`) && canonicalInside !== ".." && !isAbsolute(canonicalInside)) throw new Error("Capture observer files must be outside the application checkout.");
  const { navigationPackage } = await captureCompatibility(project, options.provider);
  const parameterKeys = [...new Set(options.parameterKeys ?? [])].sort();
  if (parameterKeys.length > 256 || parameterKeys.some(key => !key || key.length > 256)) throw new Error("Capture observer parameter names exceed the supported limit.");
  let candidates: Array<{ scene: string; context: string }>;
  if (options.provider === "expo-router") {
    const core = join(dirname(navigationPackage), "build/react-navigation/core");
    candidates = [{ scene: join(core, "SceneView.js"), context: join(core, "NavigationContainerRefContext.js") }];
  } else {
    const core = dirname(navigationPackage);
    candidates = [
      { scene: join(core, "src/SceneView.tsx"), context: join(core, "src/NavigationContainerRefContext.tsx") },
      ...["lib/module", "lib/commonjs"].map(directory => ({ scene: join(core, directory, "SceneView.js"), context: join(core, directory, "NavigationContainerRefContext.js") })),
    ];
  }
  const available: typeof candidates = [];
  for (const candidate of candidates) {
    try { if ((await lstat(candidate.scene)).isFile() && (await lstat(candidate.context)).isFile()) available.push({ scene: await realpath(candidate.scene), context: await realpath(candidate.context) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!available.length) throw new Error("The installed navigation package has no supported capture observer entry point.");
  try { await mkdir(outputDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const outputInfo = await lstat(outputDirectory);
  if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) throw new Error("Capture observer output must be a regular temporary directory.");
  const files: string[] = [];
  const proxies: Record<string, string> = {};
  // Canonical like outputDirectory, or PROJECT_RELATIVE climbs through a symlinked temp dir (macOS /var -> /private/var) and misses on the EAS runner.
  const mountProject = options.mountProject ? await canonicalPath(resolve(options.mountProject)) : project;
  const relativeRequire = (from: string, target: string) => {
    const path = relative(from, target).split(sep).join("/");
    return path.startsWith("../") ? path : `./${path}`;
  };
  const recipeHash = createHash("sha256").update(CAPTURE_OBSERVER_HASH).update(JSON.stringify(parameterKeys)).digest("hex");
  for (const [index, candidate] of available.entries()) {
    const path = join(outputDirectory, `navigation-observer-${index}.js`);
    const sceneRelative = relative(project, candidate.scene);
    const sceneRequire = relativeRequire(outputDirectory, join(mountProject, sceneRelative));
    const contextRequire = relativeRequire(outputDirectory, join(mountProject, relative(project, candidate.context)));
    const bindings = `const SCENE_FILE = ${JSON.stringify(sceneRequire)};\nconst CONTEXT_FILE = ${JSON.stringify(contextRequire)};\nconst PROVIDER = ${JSON.stringify(options.provider)};\nconst PARAMETER_KEYS = ${JSON.stringify(parameterKeys)};\nconst MARKER_IDENTIFIER = ${JSON.stringify(CAPTURE_OBSERVER_IDENTIFIER)};\n`;
    // Literal relative requires let Metro statically discover the existing application's dependencies wherever the files are mounted.
    const runtime = OBSERVER_RUNTIME.replace("require(SCENE_FILE)", `require(${JSON.stringify(sceneRequire)})`)
      .replace("require(CONTEXT_FILE)", `require(${JSON.stringify(contextRequire)})`)
      .replace("PROVIDER === 'expo-router' ? require('expo-router') : null", options.provider === "expo-router" ? "require('expo-router')" : "null");
    await writeFile(path, bindings + observedNavigationState.toString() + "\n" + observedParameters.toString() + "\n" + observedParametersComplete.toString() + "\n" + runtime, { flag: "wx", mode: 0o600 });
    files.push(path); proxies[sceneRelative.split(sep).join("/")] = relative(outputDirectory, path).split(sep).join("/");
  }
  const metro = join(outputDirectory, "metro.config.cjs");
  await writeFile(metro, `const PROJECT_RELATIVE = ${JSON.stringify(relative(outputDirectory, mountProject).split(sep).join("/"))};\nconst PROXIES = ${JSON.stringify(proxies)};\nconst RECIPE_HASH = ${JSON.stringify(recipeHash)};\n` + METRO_RUNTIME, { flag: "wx", mode: 0o600 });
  files.push(metro);
  return { environment: { EXPO_OVERRIDE_METRO_CONFIG: metro }, recipeHash, files };
}
