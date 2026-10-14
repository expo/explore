import type { SourceChange } from "./git-diff.js";

export type TwoDotSourceImpact = {
  schemaVersion: 1;
  mode: "two-dot";
  range: string;
  baseSha: string;
  headSha: string;
  changes: SourceChange[];
};

/** Conservative app-wide files and directories. Projects can model narrower shared
 * dependencies in each surface manifest entry; these rules protect correctness when
 * an app-wide runtime/configuration source changes. */
export const DEFAULT_GLOBAL_IMPACT_PATHS = [
  "app.json",
  "app.config.js",
  "app.config.ts",
  "app.config.mjs",
  "app.config.cjs",
  "babel.config.js",
  "babel.config.cjs",
  "metro.config.js",
  "metro.config.cjs",
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "src/app/_layout.tsx",
  "src/app/+html.tsx",
  "src/components/",
  "src/constants/",
  "src/lib/",
  "src/providers/",
  "src/styles/",
  "src/theme/",
] as const;

type UnknownRecord = Record<string, unknown>;

const fullShaPattern = /^[0-9a-f]{40}$/;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error(`${label} contains missing or unsupported fields`);
  }
}

function fullSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !fullShaPattern.test(value)) {
    throw new Error(`${label} must be a lowercase full 40-character Git SHA`);
  }
  return value;
}

function repoPath(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe repository-relative POSIX path`);
  }
  return value;
}

function parseChange(value: unknown, index: number): SourceChange {
  const label = `source impact changes[${index}]`;
  const change = record(value, label);
  const status = change.status;
  if (typeof status !== "string") throw new Error(`${label}.status must be a string`);
  if (status === "A" || status === "M" || status === "D" || status === "T") {
    exactKeys(change, ["status", "path"], label);
    const statusMap = {
      A: "added",
      M: "modified",
      D: "removed",
      T: "type-changed",
    } as const;
    return { status: statusMap[status], path: repoPath(change.path, `${label}.path`) };
  }
  const moved = /^([RC])(\d{1,3})$/.exec(status);
  if (!moved || Number(moved[2]) > 100) {
    throw new Error(`${label}.status is unsupported: ${status}`);
  }
  exactKeys(change, ["status", "path", "nextPath"], label);
  const previousPath = repoPath(change.path, `${label}.path`);
  const path = repoPath(change.nextPath, `${label}.nextPath`);
  if (previousPath === path) throw new Error(`${label} moves a path onto itself`);
  return {
    status: moved[1] === "R" ? "renamed" : "copied",
    previousPath,
    path,
  };
}

/** Validate the trusted, recomputed two-dot source diff before planning surfaces. */
export function parseTwoDotSourceImpact(value: unknown): TwoDotSourceImpact {
  const source = record(value, "source impact");
  exactKeys(
    source,
    ["schemaVersion", "mode", "range", "baseSha", "headSha", "changes"],
    "source impact",
  );
  if (source.schemaVersion !== 1) throw new Error("source impact schemaVersion must be 1");
  if (source.mode !== "two-dot") throw new Error("source impact mode must be two-dot");
  const baseSha = fullSha(source.baseSha, "source impact baseSha");
  const headSha = fullSha(source.headSha, "source impact headSha");
  if (baseSha === headSha) throw new Error("source impact baseSha and headSha must differ");
  if (source.range !== `${baseSha}..${headSha}`) {
    throw new Error("source impact range must exactly match baseSha..headSha");
  }
  if (!Array.isArray(source.changes)) throw new Error("source impact changes must be an array");
  const changes = source.changes.map(parseChange);
  const destinations = new Set<string>();
  for (const change of changes) {
    if (destinations.has(change.path)) {
      throw new Error(`source impact repeats destination path ${change.path}`);
    }
    destinations.add(change.path);
  }
  return {
    schemaVersion: 1,
    mode: "two-dot",
    range: `${baseSha}..${headSha}`,
    baseSha,
    headSha,
    changes,
  };
}
