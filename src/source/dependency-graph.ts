import { posix } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import type { SourceChange } from "./git-diff.js";
import { validateSourceRoutes, type SourceRoute } from "../contracts/source-route.js";
import { readTsconfigAlias, resolveTsconfigAlias } from "../shared/tsconfig-alias.js";

/** Repository path → file text at one exact commit. Non-source files carry an empty string. */
export type SourceSnapshot = ReadonlyMap<string, string>;

/** Read every tracked file name at an exact commit, plus the text of TypeScript/JavaScript sources and tsconfig files. */
export function readSourceSnapshot(repository: string, commit: string): SourceSnapshot {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full commit SHA is required");
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Could not read the exact source snapshot", { cause: result.error });
    return result.stdout;
  };
  const entries = git(["ls-tree", "--full-tree", "-r", "-z", commit]).split("\0").filter(Boolean);
  if (entries.length > 50_000) throw new Error("Source snapshot exceeds 50,000 files");
  const snapshot = new Map<string, string>();
  for (const entry of entries) {
    const match = /^\d{6} (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Could not read a source snapshot tree entry");
    const blob = match[1]!; const path = match[2]!;
    if (/(?:^|\/)(?:node_modules|\.git)\//.test(path) || /(?:^|\/)surfaces?\.json$/.test(path)) continue;
    snapshot.set(path, /\.[cm]?[jt]sx?$/.test(path) || /\.json$/.test(path)
      ? git(["show", blob]) : "");
  }
  return snapshot;
}

/** True when any changed path can affect the running app (not docs, tests, scripts, or CI). */
export function hasRuntimeChange(changes: readonly SourceChange[]): boolean {
  return changes.some((change) => {
    const paths = [change.path, ...("previousPath" in change ? [change.previousPath] : [])];
    return paths.some((path) => !/(?:^|\/)surfaces?\.json$/.test(path)
      && !/^(?:\.github\/|docs\/|tests?\/|scripts\/)|(?:\.md$|\.(?:test|spec)\.[jt]sx?$)/.test(path));
  });
}

/** Resolve only bounded, static imports. Unknown resolution expands capture, never narrows it. */
export function surfaceDependencies(routes: readonly SourceRoute[], files: SourceSnapshot, platform: "ios" | "android" | "web" = "ios"): {
  routes: SourceRoute[];
  unresolved: string[];
} {
  routes = validateSourceRoutes(routes);
  const unresolved = new Set<string>();
  const alias = readTsconfigAlias(files.get("tsconfig.json"));
  if (alias.unsupported) unresolved.add("Custom TypeScript module resolution requires conservative capture");
  const cache = new Map<string, string[]>();
  const resolveModule = (importer: string, specifier: string): string | undefined => {
    const base = resolveTsconfigAlias(alias, specifier)
      ?? (specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(importer), specifier))
        : undefined);
    if (!base) return undefined;
    const extensions = ["tsx", "ts", "jsx", "js"].flatMap(ext => [`.${platform}.${ext}`, ...(platform === "web" ? [] : [`.native.${ext}`]), `.${ext}`]).concat([".mjs", ".cjs", ".json"]);
    return [...extensions.map((ext) => base + ext), base,
      ...extensions.map((ext) => `${base}/index${ext}`)].find((candidate) => !/(?:^|\/)surfaces?\.json$/.test(candidate) && files.has(candidate));
  };
  const imports = (path: string): string[] => {
    const cached = cache.get(path);
    if (cached) return cached;
    const dependencies: string[] = [];
    cache.set(path, dependencies);
    if (!/\.[cm]?[jt]sx?$/.test(path)) return dependencies;
    const source = files.get(path);
    if (source === undefined) { unresolved.add(`Missing runtime source: ${path}`); return dependencies; }
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    if ((ast as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
      unresolved.add(`Runtime source could not be parsed completely: ${path}`);
    }
    const add = (node: ts.Expression | undefined) => {
      if (!node || !ts.isStringLiteralLike(node)) {
        unresolved.add(`Dynamic runtime import: ${path}`);
        return;
      }
      const specifier = node.text;
      const resolved = resolveModule(path, specifier);
      if (resolved) dependencies.push(resolved);
      else if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~")) {
        unresolved.add(`Unresolved runtime import: ${path} -> ${specifier}`);
      }
      // Bare npm packages are covered by lockfile/package changes.
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (!node.isTypeOnly) add(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        add(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return dependencies;
  };
  return {
    routes: routes.map((surface) => {
        const visited = new Set<string>();
        const pending = [surface.routeFile, ...surface.sourceFiles];
        let directory = posix.dirname(surface.routeFile);
        while (directory !== "." && directory !== "/") {
          const suffixes = ["tsx", "ts", "jsx", "js"].flatMap(extension => [`.${platform}.${extension}`, ...(platform === "web" ? [] : [`.native.${extension}`]), `.${extension}`]);
          const layout = suffixes.map(suffix => `${directory}/_layout${suffix}`).find(path => files.has(path));
          if (layout) pending.push(layout);
          directory = posix.dirname(directory);
        }
        while (pending.length) {
          const path = pending.pop()!;
          if (visited.has(path)) continue;
          visited.add(path);
          pending.push(...imports(path));
        }
        return { ...surface, sourceFiles: [...visited].sort() };
      }),
    unresolved: [...unresolved].sort(),
  };
}

