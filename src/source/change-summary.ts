import { spawnSync } from "node:child_process";
import ts from "typescript";
import { parseTwoDotNameStatus, type SourceChange } from "./git-diff.js";
import type { SourceCapturePlan } from "./capture-plan.js";
import { DEFAULT_GLOBAL_IMPACT_PATHS } from "./impact.js";
import { sourceImpactKinds, sourceImpactSentences } from "../contracts/source-change.js";

export type SourceLineRange = { start: number; end: number };
export type SourceChangeFact = {
  kind: "entry-added" | "entry-removed" | "jsx-added" | "jsx-removed" | "property-changed" | "import-added" | "import-removed"
    | "export-added" | "export-removed" | "code";
  summary: string;
  before?: string;
  after?: string;
  baseLines?: SourceLineRange;
  headLines?: SourceLineRange;
};
export type SourceFileChangeSummary = {
  path: string;
  previousPath?: string;
  status: SourceChange["status"];
  relation: "route" | "declared-source" | "dependency" | "global";
  baseBlobSha?: string;
  headBlobSha?: string;
  hunks: Array<{ baseStart: number; baseLines: number; headStart: number; headLines: number }>;
  /** Accepted in older evidence records; new capture summaries never retain raw patches. */
  patch?: string;
  patchTruncated?: boolean;
  facts: SourceChangeFact[];
  truncated: boolean;
};
export type SourceChangeSummary = {
  contract: "expo.explore.source-change-summary.v1";
  baseSha: string;
  headSha: string;
  impact: "direct" | "dependency" | "global" | "route" | "none";
  summary: string;
  files: SourceFileChangeSummary[];
  truncated: boolean;
};

export const SOURCE_CHANGE_SUMMARY_LIMITS = {
  changedFiles: 1000,
  filesPerSurface: 8,
  sourceBytesPerFile: 512 * 1024,
  totalSourceBytes: 8 * 1024 * 1024,
  patchBytesPerFile: 256 * 1024,
  factsPerFile: 6,
  hunksPerFile: 8,
  valueCharacters: 180,
  summaryCharacters: 1000,
} as const;

type Surface = SourceCapturePlan["surfaces"][number];
type GitResult = { stdout: string; truncated: boolean };
type BlobSource = { sha?: string; source?: string; truncated: boolean };
type SourceValue = { source: string; display: string; string: boolean; lines: SourceLineRange };
type PropertyValue = SourceValue & { property: string; subject?: string };
type EntryValue = { identity: string; container: string; lines: SourceLineRange };
type JsxValue = { identity: string; tag: string; text?: string; onPress?: string; lines: SourceLineRange };
type ModuleBinding = { kind: "import" | "export"; module: string; binding: string; lines: SourceLineRange };
type SourceStructure = {
  properties: Map<string, PropertyValue>;
  entries: Map<string, EntryValue>;
  bindings: Map<string, ModuleBinding>;
  jsx: Map<string, JsxValue>;
  ambiguous: Set<string>;
  valid: boolean;
};

function limited(value: string, length: number = SOURCE_CHANGE_SUMMARY_LIMITS.valueCharacters): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function quote(value: string): string {
  return `“${limited(value.replace(/\s+/g, " ").trim())}”`;
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Source summary requires safe repository-relative paths");
  }
  return path;
}

function git(project: string, args: string[], maxBuffer: number, allowTruncation = false): GitResult {
  const result = spawnSync("/usr/bin/git", ["--literal-pathspecs", "-C", project,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8", maxBuffer, timeout: 15_000,
    env: { PATH: process.env.PATH, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (allowTruncation && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    return { stdout: "", truncated: true };
  }
  if (result.error || result.status !== 0) {
    throw new Error("Could not read immutable Git evidence for source summary", { cause: result.error });
  }
  return { stdout: result.stdout, truncated: false };
}

function assertCommit(project: string, sha: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha)
    || git(project, ["rev-parse", "--verify", `${sha}^{commit}`], 1024).stdout.trim() !== sha) {
    throw new Error("Source summary requires the exact full base and head commit SHAs");
  }
}

function readBlob(project: string, sha: string, path: string, budget: { remaining: number }): BlobSource {
  const tree = git(project, ["ls-tree", "-z", sha, "--", safePath(path)], 16 * 1024).stdout;
  if (!tree) return { truncated: false };
  const match = /^(\d+) blob ([a-f0-9]{40})\t/.exec(tree);
  if (!match) return { truncated: true };
  const blobSha = match[2]!;
  const bytes = Number(git(project, ["cat-file", "-s", blobSha], 1024).stdout.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid Git source blob size");
  if (match[1] === "120000" || bytes > SOURCE_CHANGE_SUMMARY_LIMITS.sourceBytesPerFile || bytes > budget.remaining) {
    return { sha: blobSha, truncated: true };
  }
  budget.remaining -= bytes;
  const source = git(project, ["cat-file", "blob", blobSha], SOURCE_CHANGE_SUMMARY_LIMITS.sourceBytesPerFile + 1).stdout;
  return source.includes("\0") ? { sha: blobSha, truncated: true } : { sha: blobSha, source, truncated: false };
}

function lineRange(source: ts.SourceFile, node: ts.Node): SourceLineRange {
  return {
    start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    end: source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1,
  };
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text : undefined;
}

function scalar(source: ts.SourceFile, node: ts.Expression): SourceValue | undefined {
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
    || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return undefined;
  const text = node.getText(source);
  if (text.length > SOURCE_CHANGE_SUMMARY_LIMITS.valueCharacters || /[\r\n]/.test(text)) return undefined;
  const string = ts.isStringLiteralLike(node);
  return {
    source: text,
    display: string ? quote(node.text) : text,
    string,
    lines: lineRange(source, node),
  };
}

function objectIdentity(source: ts.SourceFile, node: ts.ObjectLiteralExpression): string | undefined {
  // Only stable identity keys align array entries. Labels/titles can themselves change.
  for (const key of ["id", "key", "slug", "route", "path", "href"]) {
    const property = node.properties.find((entry): entry is ts.PropertyAssignment => (
      ts.isPropertyAssignment(entry) && propertyName(entry.name) === key
    ));
    if (!property) continue;
    const value = scalar(source, property.initializer);
    if (value && (ts.isStringLiteralLike(property.initializer) || ts.isNumericLiteral(property.initializer)
      || ts.isIdentifier(property.initializer) || ts.isPropertyAccessExpression(property.initializer))) {
      return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : value.source;
    }
  }
  return undefined;
}

function jsxValue(source: ts.SourceFile, node: ts.JsxElement | ts.JsxSelfClosingElement): JsxValue | undefined {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const attributes = opening.attributes.properties.filter(ts.isJsxAttribute);
  const literal = (attribute: ts.JsxAttribute | undefined): string | undefined => {
    const initializer = attribute?.initializer;
    if (initializer && ts.isStringLiteralLike(initializer)) return initializer.text;
    if (initializer && ts.isJsxExpression(initializer) && initializer.expression
      && ts.isStringLiteralLike(initializer.expression)) return initializer.expression.text;
    return undefined;
  };
  const identity = ["nativeID", "testID", "key", "id"]
    .map((name) => literal(attributes.find((attribute) => attribute.name.getText(source) === name)))
    .find((value) => value && value.length <= SOURCE_CHANGE_SUMMARY_LIMITS.valueCharacters);
  if (!identity) return undefined;
  const texts: string[] = [];
  const visibleText = (child: ts.JsxChild): void => {
    if (ts.isJsxText(child)) {
      const text = child.text.replace(/\s+/g, " ").trim();
      if (text) texts.push(text);
    } else if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteralLike(child.expression)) {
      texts.push(child.expression.text);
    } else if (ts.isJsxElement(child) || ts.isJsxFragment(child)) child.children.forEach(visibleText);
  };
  if (ts.isJsxElement(node)) node.children.forEach(visibleText);
  const text = texts.length ? limited(texts.join(" ")) : undefined;
  const onPress = attributes.find((attribute) => attribute.name.getText(source) === "onPress")?.initializer;
  const calls: string[] = [];
  const findRouterCall = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
      && ts.isIdentifier(child.expression.expression) && child.expression.expression.text === "router"
      && child.expression.name.text === "push" && child.arguments.length === 1
      && child.arguments[0] && ts.isStringLiteralLike(child.arguments[0])) {
      const call = child.getText(source);
      if (call.length <= SOURCE_CHANGE_SUMMARY_LIMITS.valueCharacters) calls.push(call);
    }
    ts.forEachChild(child, findRouterCall);
  };
  if (onPress && ts.isJsxExpression(onPress) && onPress.expression) findRouterCall(onPress.expression);
  return {
    identity, tag: limited(opening.tagName.getText(source)), lines: lineRange(source, node),
    ...(text ? { text } : {}), ...(calls.length === 1 ? { onPress: calls[0]! } : {}),
  };
}

function sourceStructure(path: string, text: string): SourceStructure {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result: SourceStructure = { properties: new Map(), entries: new Map(), bindings: new Map(), jsx: new Map(), ambiguous: new Set(), valid: true };
  if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) {
    result.valid = false;
    return result;
  }
  const addBinding = (kind: ModuleBinding["kind"], module: string, binding: string, node: ts.Node) => {
    result.bindings.set(`${kind}:${module}:${binding}`, { kind, module, binding, lines: lineRange(source, node) });
  };
  const visit = (node: ts.Node, context: string, container: string, subject?: string, uncertainArray = false): void => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && !uncertainArray) {
      const value = jsxValue(source, node);
      if (value) {
        const key = `${context}/jsx:${JSON.stringify(value.identity)}`;
        if (result.jsx.has(key) || result.ambiguous.has(key)) {
          result.ambiguous.add(key);
          result.jsx.delete(key);
        } else result.jsx.set(key, value);
        ts.forEachChild(node, (child) => visit(child, key, container, subject, uncertainArray));
        return;
      }
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) addBinding("import", module, "side effect", node);
      if (clause?.name) addBinding("import", module, `default as ${clause.name.text}`, node);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        addBinding("import", module, `* as ${clause.namedBindings.name.text}`, node);
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) addBinding("import", module, binding.getText(source), binding);
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const module = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : "this module";
      if (!node.exportClause) addBinding("export", module, "*", node);
      else if (ts.isNamedExports(node.exportClause)) {
        for (const binding of node.exportClause.elements) addBinding("export", module, binding.getText(source), binding);
      } else addBinding("export", module, `* as ${node.exportClause.name.text}`, node);
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (node.body) visit(node.body, `${context}/function:${node.name.text}`, node.name.text);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      visit(node.initializer, `${context}/variable:${node.name.text}`, node.name.text, subject, uncertainArray);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const identities = node.elements.map((entry) => ts.isObjectLiteralExpression(entry) ? objectIdentity(source, entry) : undefined);
      const duplicate = new Set(identities.filter((identity, index) => identity && identities.indexOf(identity) !== index));
      for (const [index, entry] of node.elements.entries()) {
        const identity = identities[index];
        if (identity && !duplicate.has(identity) && !uncertainArray) {
          const key = `${context}/entry:${JSON.stringify(identity)}`;
          if (result.entries.has(key) || result.ambiguous.has(key)) {
            result.ambiguous.add(key);
            result.entries.delete(key);
          } else result.entries.set(key, { identity, container, lines: lineRange(source, entry) });
          visit(entry, key, container, identity, false);
        } else {
          if (identity) result.ambiguous.add(`${context}/entry:${JSON.stringify(identity)}`);
          // Positional pairing cannot establish that shifted anonymous objects are the same item.
          visit(entry, `${context}/index:${index}`, container, subject, true);
        }
      }
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (!name) return;
      const key = `${context}/property:${name}`;
      const value = scalar(source, node.initializer);
      if (value && !uncertainArray) {
        if (result.properties.has(key) || result.ambiguous.has(key)) {
          result.ambiguous.add(key);
          result.properties.delete(key);
        } else result.properties.set(key, { ...value, property: name, ...(subject ? { subject } : {}) });
      }
      visit(node.initializer, key, name, subject, uncertainArray);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, context, container, subject, uncertainArray));
  };
  visit(source, "source", "source");
  return result;
}


const FACT_PRIORITY: Record<SourceChangeFact["kind"], number> = {
  "entry-removed": 0, "jsx-removed": 0, "property-changed": 1, "jsx-added": 1, "entry-added": 2,
  "export-removed": 3, "export-added": 4, "import-removed": 5, "import-added": 6, code: 7,
};

function compareFacts(left: SourceChangeFact, right: SourceChangeFact): number {
  return FACT_PRIORITY[left.kind] - FACT_PRIORITY[right.kind]
    || (left.headLines?.start ?? left.baseLines?.start ?? 0) - (right.headLines?.start ?? right.baseLines?.start ?? 0)
    || left.summary.localeCompare(right.summary);
}

function codeFacts(path: string, base: string, head: string): SourceChangeFact[] | undefined {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return undefined;
  const before = sourceStructure(path, base);
  const after = sourceStructure(path, head);
  if (!before.valid || !after.valid) return undefined;
  const facts: SourceChangeFact[] = [];
  const unpairedEntries = new Set<string>();
  const ambiguous = [...before.ambiguous, ...after.ambiguous];
  const isAmbiguous = (key: string) => ambiguous.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));
  for (const [change, left, right] of [["removed", before.jsx, after.jsx], ["added", after.jsx, before.jsx]] as const) {
    for (const [key, value] of left) {
      if (right.has(key) || isAmbiguous(key)) continue;
      unpairedEntries.add(key);
      facts.push({
        kind: `jsx-${change}`,
        summary: `${change === "added" ? "Added" : "Removed"} ${value.tag} ${quote(value.identity)}${value.text ? ` with text ${quote(value.text)}` : ""}${value.onPress ? `; onPress contains ${value.onPress}` : ""}.`,
        ...(change === "added" ? { after: value.text ?? value.identity, headLines: value.lines }
          : { before: value.text ?? value.identity, baseLines: value.lines }),
      });
    }
  }
  for (const [key, entry] of before.entries) {
    if (after.entries.has(key) || isAmbiguous(key)) continue;
    unpairedEntries.add(key);
    facts.push({ kind: "entry-removed", summary: `Removed entry ${quote(entry.identity)} from ${entry.container}.`, before: entry.identity, baseLines: entry.lines });
  }
  for (const [key, entry] of after.entries) {
    if (before.entries.has(key) || isAmbiguous(key)) continue;
    unpairedEntries.add(key);
    facts.push({ kind: "entry-added", summary: `Added entry ${quote(entry.identity)} to ${entry.container}.`, after: entry.identity, headLines: entry.lines });
  }
  for (const [key, value] of before.properties) {
    const next = after.properties.get(key);
    if (!next || isAmbiguous(key) || next.source === value.source || (!value.string && !next.string)
      || [...unpairedEntries].some((entry) => key.startsWith(`${entry}/`))) continue;
    facts.push({
      kind: "property-changed",
      summary: `Changed ${value.property}${value.subject ? ` for ${quote(value.subject)}` : ""} from ${value.display} to ${next.display}.`,
      before: value.source, after: next.source, baseLines: value.lines, headLines: next.lines,
    });
  }
  for (const [key, value] of before.bindings) {
    if (after.bindings.has(key)) continue;
    facts.push({
      kind: `${value.kind}-removed`,
      summary: `Removed ${value.kind === "export" && value.binding === "*" ? "re-export" : `${value.kind} ${quote(value.binding)}`} from ${quote(value.module)}.`,
      before: value.binding, baseLines: value.lines,
    });
  }
  for (const [key, value] of after.bindings) {
    if (before.bindings.has(key)) continue;
    facts.push({
      kind: `${value.kind}-added`,
      summary: `Added ${value.kind === "export" && value.binding === "*" ? "re-export" : `${value.kind} ${quote(value.binding)}`} from ${quote(value.module)}.`,
      after: value.binding, headLines: value.lines,
    });
  }
  return facts.sort(compareFacts);
}

function changedPaths(change: SourceChange): string[] {
  return [change.path, ...("previousPath" in change ? [change.previousPath] : [])];
}

function fileEvidence(options: {
  baseProject: string; headProject: string; baseSha: string; headSha: string;
  change: SourceChange; budget: { remaining: number };
}): Omit<SourceFileChangeSummary, "relation"> {
  const { change } = options;
  const previousPath = "previousPath" in change ? change.previousPath : undefined;
  const base = readBlob(options.baseProject, options.baseSha, previousPath ?? change.path, options.budget);
  const head = readBlob(options.headProject, options.headSha, change.path, options.budget);
  const patch = git(options.headProject, [
    "diff", "--relative", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", "--no-renames",
    options.baseSha, options.headSha, "--", ...changedPaths(change).map(safePath),
  ], SOURCE_CHANGE_SUMMARY_LIMITS.patchBytesPerFile, true);
  const rawHunks = [...patch.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    baseStart: Number(match[1]), baseLines: Number(match[2] ?? 1),
    headStart: Number(match[3]), headLines: Number(match[4] ?? 1),
  }));
  const extracted = base.truncated || head.truncated ? undefined : codeFacts(change.path, base.source ?? "", head.source ?? "");
  const facts = extracted?.length ? extracted : [{
    kind: "code" as const,
    summary: change.status === "added" ? `Added source file ${change.path}.`
      : change.status === "removed" ? `Removed source file ${change.path}.`
        : previousPath ? `${change.status === "copied" ? "Copied" : "Renamed"} ${previousPath} to ${change.path}.`
          : `Changed source in ${change.path}.`,
  }];
  return {
    path: change.path, status: change.status,
    ...(previousPath ? { previousPath } : {}),
    ...(base.sha ? { baseBlobSha: base.sha } : {}),
    ...(head.sha ? { headBlobSha: head.sha } : {}),
    hunks: rawHunks.slice(0, SOURCE_CHANGE_SUMMARY_LIMITS.hunksPerFile),
    facts: facts.slice(0, SOURCE_CHANGE_SUMMARY_LIMITS.factsPerFile),
    truncated: base.truncated || head.truncated || patch.truncated
      || rawHunks.length > SOURCE_CHANGE_SUMMARY_LIMITS.hunksPerFile
      || facts.length > SOURCE_CHANGE_SUMMARY_LIMITS.factsPerFile,
  };
}

function relation(surface: Surface, change: SourceChange): SourceFileChangeSummary["relation"] {
  const paths = changedPaths(change);
  const entries = [surface.baseSurface, surface.headSurface].filter((entry) => entry !== null);
  if (entries.some((entry) => paths.includes(entry.routeFile))) return "route";
  if (entries.some((entry) => entry.sourceFiles.some((path) => paths.includes(path)))) return "dependency";
  return "global";
}

function summaryText(surface: Surface, impact: SourceChangeSummary["impact"], files: SourceFileChangeSummary[]): string {
  const route = (surface.headSurface ?? surface.baseSurface)?.route;
  if (surface.status === "added") return route ? `Added ${route} screen.` : "Added";
  if (surface.status === "removed") return route ? `Removed ${route} screen.` : "Removed";
  const prefix = sourceImpactSentences(sourceImpactKinds(files.map((file) => file.relation)))
    ?? (impact === "none" ? "No source changes affect this surface." : "");
  const ranked = files.flatMap((file) => file.facts.map((fact) => ({ fact, direct: file.relation === "route" || file.relation === "declared-source" })))
    .sort((left, right) => Number(right.direct) - Number(left.direct) || compareFacts(left.fact, right.fact));
  // A directly edited screen should describe its own change. Facts from a shared barrel's
  // other screens remain in files, rather than appearing to be controls added to this screen.
  const scoped = impact === "direct" && ranked.some(({ direct }) => direct)
    ? ranked.filter(({ direct }) => direct) : ranked;
  const meaningful = scoped.filter(({ fact }) => fact.kind !== "import-added" && fact.kind !== "import-removed");
  const details = [...new Set((meaningful.length ? meaningful : scoped).map(({ fact }) => fact.summary))].slice(0, prefix ? 2 : 3);
  return limited([prefix, ...details].filter(Boolean).join(" ") || "Source changes affect this surface.", SOURCE_CHANGE_SUMMARY_LIMITS.summaryCharacters);
}

/**
 * Deterministic source explanations derived only from immutable commit blobs and Git hunks.
 * Project directories provide object databases; working-tree contents and executable code are
 * never read or run. The public CI caller separately enforces clean, exact capture checkouts.
 */
export function createSourceChangeSummaries(options: {
  baseProject: string;
  headProject: string;
  plan: SourceCapturePlan;
}): Record<string, SourceChangeSummary> {
  const { plan } = options;
  if (plan.contract !== "explore.plan" || plan.baseSha === plan.headSha
    || !Array.isArray(plan.surfaces) || plan.surfaces.length > 5000) throw new Error("Invalid source summary plan");
  assertCommit(options.baseProject, plan.baseSha);
  assertCommit(options.headProject, plan.headSha);
  // Git's two-dot diff also needs the base object in the head database, as the capture planner does.
  assertCommit(options.headProject, plan.baseSha);
  const changes = parseTwoDotNameStatus(Buffer.from(git(options.headProject, [
    "diff", "--relative", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames",
    plan.baseSha, plan.headSha, "--",
  ], 4 * 1024 * 1024).stdout));
  if (changes.length > SOURCE_CHANGE_SUMMARY_LIMITS.changedFiles) throw new Error("Source summary exceeds changed-file limit");
  const globals = new Set<string>([...DEFAULT_GLOBAL_IMPACT_PATHS.filter((path) => !path.endsWith("/")), "tsconfig.json"]);
  const cache = new Map<string, Omit<SourceFileChangeSummary, "relation">>();
  const budget = { remaining: SOURCE_CHANGE_SUMMARY_LIMITS.totalSourceBytes };
  const summaries: Record<string, SourceChangeSummary> = {};
  for (const surface of plan.surfaces) {
    if (!surface.id || Object.hasOwn(summaries, surface.id) || (!surface.baseSurface && !surface.headSurface)) {
      throw new Error("Invalid or duplicate surface in source summary plan");
    }
    const directPaths = new Set([surface.baseSurface, surface.headSurface].flatMap((entry) => entry ? [entry.routeFile] : []));
    const dependencyPaths = new Set([surface.baseSurface, surface.headSurface].flatMap(entry => entry?.sourceFiles ?? []));
    const globalImpact = surface.reasons.some(reason => reason.startsWith("App configuration changed: "));
    const relevant = surface.status === "unchanged" ? [] : changes.filter((change) => changedPaths(change).some((path) => (
      directPaths.has(path) || dependencyPaths.has(path) || (globalImpact && globals.has(path))
    )));
    // Unresolved runtime imports can conservatively recapture a surface without a resolved path.
    if (relevant.length === 0 && surface.status === "modified" && plan.conservative) {
      relevant.push(...changes.filter((change) => changedPaths(change).some((path) => (
        !/^(?:\.github\/|docs\/|tests?\/|scripts\/)|(?:\.md$|\.(?:test|spec)\.[jt]sx?$)/.test(path)
      ))));
    }
    const selected = relevant.sort((left, right) => {
      const rank = { route: 0, "declared-source": 1, dependency: 2, global: 3 };
      return rank[relation(surface, left)] - rank[relation(surface, right)] || left.path.localeCompare(right.path);
    }).slice(0, SOURCE_CHANGE_SUMMARY_LIMITS.filesPerSurface);
    const files = selected.map((change): SourceFileChangeSummary => {
      let evidence = cache.get(change.path);
      if (!evidence) {
        evidence = fileEvidence({ ...options, baseSha: plan.baseSha, headSha: plan.headSha, change, budget });
        cache.set(change.path, evidence);
      }
      return { ...evidence, relation: relation(surface, change) };
    });
    const impact: SourceChangeSummary["impact"] = files.some((file) => file.relation === "route" || file.relation === "declared-source")
      ? "direct" : files.some((file) => file.relation === "dependency") ? "dependency"
        : globalImpact || (surface.status === "modified" && plan.conservative) ? "global"
          : surface.status !== "unchanged" ? "route" : "none";
    summaries[surface.id] = {
      contract: "expo.explore.source-change-summary.v1",
      baseSha: plan.baseSha, headSha: plan.headSha, impact,
      summary: summaryText(surface, impact, files),
      files,
      truncated: relevant.length > selected.length || files.some((file) => file.truncated),
    };
  }
  return summaries;
}
