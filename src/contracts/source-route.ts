import { appRoute, assertAllowedKeys, isRecord, requiredString, safeRepoPath, stableIdentifier } from "./source-validation.js";

/** A route discovered from committed application code. Runtime evidence is stored separately. */
export type SourceRoute = {
  id: string;
  kind: "screen" | "redirect";
  route: string;
  routeFile: string;
  sourceFiles: string[];
  variant: string;
  title?: string;
  path: string | null;
  parameters?: Record<string, string>;
  /** Source-declared linking parameters, including names without configured values. */
  pathParameters?: Record<string, "required" | "optional">;
  redirectTo?: string;
  /** Proven destination paths; state may select any member. Runtime query values are not inferred. */
  redirectTargets?: string[];
  provider: "expo-router" | "react-navigation";
  logicalPath: string;
};

/** Every name config can use for a route: its id, source route, logical path, or link path with or without its query. */
export function sourceRouteNames(route: SourceRoute): string[] {
  return [route.id, route.route, route.logicalPath, ...(route.path ? [route.path, route.path.split("?")[0]!] : [])];
}

export function validateSourceRoute(value: unknown, label = "source route"): SourceRoute {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, ["id", "kind", "route", "routeFile", "sourceFiles", "variant", "title", "path", "parameters", "pathParameters", "redirectTo", "redirectTargets", "provider", "logicalPath"], label);
  const id = stableIdentifier(value.id, `${label}.id`);
  if (value.kind !== "screen" && value.kind !== "redirect") throw new Error(`${label}.kind is invalid`);
  if (value.provider !== "expo-router" && value.provider !== "react-navigation") throw new Error(`${label}.provider is invalid`);
  const route = requiredString(value.route, `${label}.route`);
  if (!route.trim() || /[\u0000-\u001f\u007f]/.test(route)) throw new Error(`${label}.route must not contain control characters or be blank`);
  if (value.provider === "expo-router") appRoute(route, `${label}.route`);
  const routeFile = safeRepoPath(requiredString(value.routeFile, `${label}.routeFile`), `${label}.routeFile`);
  if (!Array.isArray(value.sourceFiles) || value.sourceFiles.length > 50_000) throw new Error(`${label}.sourceFiles must be an array`);
  const sourceFiles = [...new Set(value.sourceFiles.map((file, index) => safeRepoPath(requiredString(file, `${label}.sourceFiles[${index}]`), `${label}.sourceFiles[${index}]`)))].sort();
  const path = value.path === null ? null : appRoute(requiredString(value.path, `${label}.path`), `${label}.path`);
  const logicalPath = requiredString(value.logicalPath, `${label}.logicalPath`);
  if (!logicalPath.trim() || /[\u0000-\u001f\u007f]/.test(logicalPath)) throw new Error(`${label}.logicalPath must not contain control characters or be blank`);
  const parameters: Record<string, string> = {};
  if (value.parameters !== undefined) {
    if (!isRecord(value.parameters)) throw new Error(`${label}.parameters must be an object`);
    for (const key of Object.keys(value.parameters).sort()) parameters[key] = requiredString(value.parameters[key], `${label}.parameters.${key}`);
  }
  const result: SourceRoute = {
    id, kind: value.kind, route, routeFile, sourceFiles,
    variant: requiredString(value.variant, `${label}.variant`), path,
    provider: value.provider, logicalPath,
    ...(value.title === undefined ? {} : { title: requiredString(value.title, `${label}.title`) }),
    ...(value.parameters === undefined ? {} : { parameters }),
    ...(value.redirectTo === undefined ? {} : { redirectTo: requiredString(value.redirectTo, `${label}.redirectTo`) }),
  };
  if (value.pathParameters !== undefined) {
    const pathParameters = value.pathParameters;
    if (!isRecord(pathParameters) || Object.keys(pathParameters).length > 256) throw new Error(`${label}.pathParameters must be an object with at most 256 names`);
    result.pathParameters = Object.fromEntries(Object.keys(pathParameters).sort().map(name => {
      const requirement = pathParameters[name];
      if (!/^[A-Za-z0-9_]{1,256}$/.test(name) || requirement !== "required" && requirement !== "optional") {
        throw new Error(`${label}.pathParameters must contain valid parameter names with required or optional values`);
      }
      return [name, requirement];
    }));
  }
  if (value.redirectTargets !== undefined) {
    if (!Array.isArray(value.redirectTargets) || !value.redirectTargets.length || value.redirectTargets.length > 64) throw new Error(`${label}.redirectTargets must contain between 1 and 64 paths`);
    result.redirectTargets = [...new Set(value.redirectTargets.map((target, index) => appRoute(requiredString(target, `${label}.redirectTargets[${index}]`), `${label}.redirectTargets[${index}]`)))].sort();
    if (result.redirectTo && (result.redirectTargets.length !== 1 || result.redirectTargets[0] !== result.redirectTo)) throw new Error(`${label}.redirectTo must agree with the single redirect target`);
  }
  if (result.kind === "redirect" && !result.redirectTo && !result.redirectTargets) throw new Error(`${label} requires redirectTo or redirectTargets for redirects`);
  if (result.kind !== "redirect" && (result.redirectTo || result.redirectTargets)) throw new Error(`${label} cannot declare redirect targets for a screen`);
  return result;
}

export function validateSourceRoutes(value: unknown): SourceRoute[] {
  if (!Array.isArray(value) || value.length > 5_000) throw new Error("source routes must contain at most 5,000 entries");
  const routes = value.map((route, index) => validateSourceRoute(route, `source routes[${index}]`)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(routes.map(route => route.id)).size !== routes.length) throw new Error("source routes contain duplicate IDs");
  return routes;
}
