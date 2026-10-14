import { posix } from "node:path";
import ts from "typescript";
import type { SourceRoute } from "../../contracts/source-route.js";
import { sourceRouteId } from "./route-id.js";
import { expoRedirectTargets } from "./expo-redirects.js";

export type ExpoRouteOptions = {
  entry?: string;
  platform?: "ios" | "android" | "web";
  parameters?: Record<string, Record<string, string>>;
};

export function routeGroupOf(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/, "").replace(/\.(?:ios|android|native|web)$/, "");
}

export function detectAppDir(files: ReadonlyMap<string, string>, entry?: string): string {
  if (entry) return entry.replace(/\/$/, "");
  return [...files.keys()].some(path => path.startsWith("src/app/")) ? "src/app" : "app";
}

/** Select exactly one module implementation for the requested runtime platform. */
export function platformPreference(path: string, platform: "ios" | "android" | "web" = "ios"): number {
  const match = /\.(ios|android|native|web)\.[cm]?[jt]sx?$/.exec(path);
  if (!match) return 2;
  if (match[1] === platform) return 0;
  return match[1] === "native" && platform !== "web" ? 1 : 100;
}

function groupVariants(parts: string[]): string[][] {
  let variants: string[][] = [[]];
  for (const part of parts) {
    const group = /^\(([^)]+)\)$/.exec(part);
    const choices = group && group[1]!.includes(",") ? group[1]!.split(",").map(name => `(${name.trim()})`).sort() : [part];
    variants = variants.flatMap(prefix => choices.map(choice => [...prefix, choice]));
    if (variants.length > 256) throw new Error("Expo Router shared route groups exceed 256 variants");
  }
  return variants;
}

/** Files create routes; no hand-authored route list participates in discovery. */
export function discoverExpoRoutes(files: ReadonlyMap<string, string>, options: ExpoRouteOptions = {}): { routes: SourceRoute[]; diagnostics: string[] } {
  const appDir = detectAppDir(files, options.entry);
  const candidates = new Map<string, string[]>();
  const diagnostics: string[] = [];
  for (const path of [...files.keys()].sort()) {
    if (!path.startsWith(`${appDir}/`) || !/\.[jt]sx?$/.test(path) || /(?:^|\/)(?:__tests__|__explore)(?:\/|$)|\.(?:test|spec|d)\.[jt]sx?$/.test(path)) continue;
    const group = routeGroupOf(path);
    const name = posix.basename(group);
    if (name.startsWith("_") || name.startsWith("+") || name.endsWith("+api")) continue;
    const variants = candidates.get(group) ?? [];
    variants.push(path); candidates.set(group, variants);
  }
  const routes: SourceRoute[] = [];
  for (const [group, candidatesForGroup] of [...candidates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const routeFile = candidatesForGroup.filter(path => platformPreference(path, options.platform) < 100)
      .sort((a, b) => platformPreference(a, options.platform) - platformPreference(b, options.platform) || (a < b ? -1 : a > b ? 1 : 0))[0];
    if (!routeFile) continue;
    const ast = ts.createSourceFile(routeFile, files.get(routeFile) ?? "", ts.ScriptTarget.Latest, true);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) diagnostics.push(`Route source could not be parsed completely: ${routeFile}`);
    const hasDefault = ast.statements.some(statement => ts.isExportAssignment(statement) && !statement.isExportEquals
      || ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
      || ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(element => element.name.text === "default"));
    if (!hasDefault) diagnostics.push(`Route has no statically resolved default export: ${routeFile}`);
    for (const segments of groupVariants(group.slice(appDir.length + 1).split("/"))) {
      const logicalPath = `/${segments.join("/")}`;
      const publicSegments = segments.filter(segment => !/^\(.*\)$/.test(segment));
      if (publicSegments.at(-1) === "index") publicSegments.pop();
      const pattern = `/${publicSegments.join("/")}`;
      const id = sourceRouteId("expo-router", logicalPath);
      const parameters = options.parameters?.[id] ?? options.parameters?.[pattern] ?? options.parameters?.[logicalPath];
      const segmentNames = new Set<string>();
      const pathname = pattern.replace(/\[(\.\.\.)?([^\]]+)\]/g, (match, catchAll: string | undefined, name: string) => {
        segmentNames.add(name);
        const value = parameters?.[name];
        if (value === undefined) { diagnostics.push(`Route requires parameter ${name}: ${logicalPath}`); return match; }
        return catchAll ? value.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(value);
      });
      // Configured parameters that name no dynamic segment travel as query parameters of the app link.
      const query = Object.entries(parameters ?? {}).filter(([name]) => !segmentNames.has(name))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
      const path = query ? `${pathname}?${query}` : pathname;
      routes.push({ id, kind: "screen", route: path, routeFile, sourceFiles: [routeFile], variant: "default", path,
        provider: "expo-router", logicalPath,
        ...(parameters ? { parameters: Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) } : {}),
      });
    }
  }
  const redirects = expoRedirectTargets(files, routes.map(route => route.routeFile), options.platform);
  return { routes: routes.map(route => {
    const redirectTargets = redirects.get(route.routeFile);
    return redirectTargets ? { ...route, kind: "redirect" as const, redirectTargets,
      ...(redirectTargets.length === 1 ? { redirectTo: redirectTargets[0]! } : {}) } : route;
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), diagnostics: [...new Set(diagnostics)].sort() };
}
