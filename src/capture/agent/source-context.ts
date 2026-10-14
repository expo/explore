import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { SourceCapturePlan } from "../../source/capture-plan.js";

export type AgentCaptureConstraint = {
  revisionLabels: string[];
  /**
   * Strings present on both revisions that contain revision-specific text: a label equal to one of
   * them is stable even though a revision string occurs inside it ("Go Premium" when head adds "Premium").
   */
  sharedLabels?: string[];
  sourceChange: string;
};

/** Revision-specific source literals cannot become shared UI prerequisites. */
export async function agentCaptureConstraints(plan: SourceCapturePlan, projects: { base: string; head: string }): Promise<Record<string, AgentCaptureConstraint>> {
  const roots = { base: await realpath(projects.base), head: await realpath(projects.head) };
  const cache = new Map<string, Promise<Set<string>>>();
  const literals = (side: "base" | "head", path: string) => {
    const key = `${side}:${path}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      const result = new Set<string>();
      if (!/\.(?:[cm]?[jt]sx?|json)$/.test(path)) return result;
      const file = await realpath(resolve(roots[side], path));
      const inside = relative(roots[side], file);
      if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) throw new Error("Capture context source escapes checkout");
      const info = await stat(file);
      if (!info.isFile() || info.size > 1_000_000) throw new Error("Capture context source exceeds its text limit");
      const source = ts.createSourceFile(path, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        // Template pieces count too: a label such as `${price} a month` is assembled at runtime, so its
        // fixed text is the only source evidence of wording a revision added or removed.
        if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const value = ts.isJsxText(node) ? node.text.trim() : node.text;
          if (value.trim() && value.length <= 256 && !value.includes("\0")) result.add(value);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return result;
    })());
    return cache.get(key)!;
  };
  const result: Record<string, AgentCaptureConstraint> = {};
  for (const surface of plan.surfaces) {
    if (!surface.baseSurface || !surface.headSurface) continue; // Added/removed routes have no shared state.
    const sides = { base: new Set<string>(), head: new Set<string>() };
    for (const side of ["base", "head"] as const) {
      const route = surface[`${side}Surface`]!;
      for (const path of new Set([route.routeFile, ...route.sourceFiles])) {
        for (const value of await literals(side, path)) sides[side].add(value);
      }
    }
    const revisionLabels = [...new Set([...sides.base].filter(v => !sides.head.has(v)).concat([...sides.head].filter(v => !sides.base.has(v))))].sort();
    const contained = containedRevisionText(revisionLabels);
    const sharedLabels = [...sides.base].filter(v => sides.head.has(v) && contained.some(text => v.includes(text))).sort();
    result[surface.id] = {
      revisionLabels,
      ...(sharedLabels.length ? { sharedLabels } : {}),
      sourceChange: surface.sourceChange?.summary ?? "No summarized source change.",
    };
  }
  return result;
}

/** Shorter revision strings only match whole labels or label parts; longer ones also match inside a label. */
const MIN_CONTAINED_REVISION_TEXT = 4;

const containedRevisionText = (revisionLabels: readonly string[]) =>
  revisionLabels.map(value => value.trim()).filter(value => value.length >= MIN_CONTAINED_REVISION_TEXT);

export function revisionSpecificLandmarks(labels: readonly string[], constraint?: AgentCaptureConstraint): string[] {
  const unstable = new Set(constraint?.revisionLabels ?? []);
  const shared = new Set(constraint?.sharedLabels ?? []);
  // A rendered label can join revision-specific text with runtime values ("$39.99 per year · $3.33 a month"),
  // so it never equals a source string; it still depends on the wording that string carries. Text that
  // equals a string both revisions have is stable, whatever it contains.
  const contained = containedRevisionText(constraint?.revisionLabels ?? []);
  const revisionSpecific = (label: string) => {
    if (shared.has(label)) return false;
    if (unstable.has(label)) return true;
    const separators = [...label.matchAll(/,\s*/g)];
    const starts = [0, ...separators.map(match => match.index + match[0].length)];
    const ends = [...separators.map(match => match.index), label.length];
    // A shared child label can itself contain commas. Preserve its complete span inside a merged
    // label, but never exempt changed text elsewhere or a changed phrase crossing its boundary.
    const sharedSpans = starts.flatMap(start => [...shared]
      .filter(value => label.startsWith(value, start) && ends.includes(start + value.length))
      .map(value => [start, start + value.length] as const));
    const isShared = (start: number, end: number) => sharedSpans.some(([from, to]) => from <= start && end <= to);
    return starts.some((start, index) => unstable.has(label.slice(start, ends[index]!)) && !isShared(start, ends[index]!))
      || contained.some(value => {
        for (let start = label.indexOf(value); start !== -1; start = label.indexOf(value, start + 1)) {
          if (!isShared(start, start + value.length)) return true;
        }
        return false;
      });
  };
  return labels.filter(revisionSpecific);
}
