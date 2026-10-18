import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readSourceSnapshot } from "../source/dependency-graph.js";
import { readTwoDotSourceChanges, type SourceChange } from "../source/git-diff.js";
import type { SourceCapturePlan } from "../source/capture-plan.js";
import type { ExploreConfig } from "../config/explore-config.js";
import { CiError } from "../shared/ci-errors.js";

type PlanDifference = { path: string; kind: "added" | "removed" | "changed"; first?: unknown; second?: unknown };

/** Keep verification failures reviewable even when the full plan contains thousands of routes. */
export async function assertPlanConsistency(first: string, second: string, output: string): Promise<void> {
  if (first === second) return;
  const differences: PlanDifference[] = [];
  let truncated = false;
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (Object.is(left, right)) return;
    if (differences.length >= 100) { truncated = true; return; }
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index++) visit(left[index], right[index], `${path}/${index}`);
      return;
    }
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) visit(a[key], b[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
      return;
    }
    differences.push({ path: path || "/", kind: left === undefined ? "added" : right === undefined ? "removed" : "changed",
      ...(left === undefined ? {} : { first: left }), ...(right === undefined ? {} : { second: right }) });
  };
  visit(JSON.parse(first), JSON.parse(second), "");
  const details = { first: "plan-first.json", second: "plan-second.json", difference: "plan-diff.json", differences: differences.length, truncated };
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(join(output, details.first), first), writeFile(join(output, details.second), second),
    writeFile(join(output, details.difference), JSON.stringify({ differences, truncated }, null, 2)),
  ]);
  throw new CiError({ code: "PLAN_NOT_DETERMINISTIC", stage: "verify", message: "Identical inputs produced different plans.",
    nextAction: "Inspect plan-diff.json for changed fields; plan-first.json and plan-second.json contain the full analyzer outputs.", details });
}

export function projectPrefix(project: string): string {
  const result = spawnSync("git", ["-C", project, "rev-parse", "--show-prefix"], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw new CiError({ code: "SOURCE_ANALYSIS_FAILED", stage: "plan", message: "Could not locate the application within its Git checkout.", nextAction: "Use an application directory inside the base/head Git checkouts.", cause: result.error });
  return result.stdout.trim();
}

/** Preserve whole-workspace invalidation while keeping every app source path app-relative. */
export function scopeSourceChanges(changes: readonly SourceChange[], prefix: string): { internal: SourceChange[]; external: SourceChange[] } {
  if (!prefix) return { internal: [...changes], external: [] };
  const internal: SourceChange[] = [];
  const external: SourceChange[] = [];
  for (const change of changes) {
    const targetInside = change.path.startsWith(prefix);
    const oldPath = "previousPath" in change ? change.previousPath : undefined;
    const originInside = oldPath?.startsWith(prefix) ?? false;
    if (targetInside && (!oldPath || originInside)) {
      internal.push(oldPath ? { ...change, path: change.path.slice(prefix.length), previousPath: oldPath.slice(prefix.length) } as SourceChange : { ...change, path: change.path.slice(prefix.length) });
    } else if (targetInside) {
      internal.push({ status: "added", path: change.path.slice(prefix.length) });
      external.push(change);
    } else {
      if (originInside && change.status === "renamed") internal.push({ status: "removed", path: oldPath!.slice(prefix.length) });
      external.push(change);
    }
  }
  return { internal, external };
}

export async function buildVerifiedPlan(options: {
  baseProject: string; headProject: string; baseSha: string; headSha: string;
  config: ExploreConfig; output: string; scope?: "all" | "changes";
}): Promise<SourceCapturePlan> {
  const { config } = options;
  const basePrefix = projectPrefix(options.baseProject);
  const headPrefix = projectPrefix(options.headProject);
  const scopedSnapshot = (project: string, sha: string, prefix: string) => new Map([...readSourceSnapshot(project, sha)]
    .filter(([path]) => path.startsWith(prefix)).map(([path, source]) => [path.slice(prefix.length), source]));
  const baseFiles = scopedSnapshot(options.baseProject, options.baseSha, basePrefix);
  const headFiles = scopedSnapshot(options.headProject, options.headSha, headPrefix);
  const sourceChanges = options.baseSha === options.headSha ? [] : readTwoDotSourceChanges({
    cwd: options.headProject, baseSha: options.baseSha, headSha: options.headSha, relativeToProject: false,
  });
  const { internal, external } = scopeSourceChanges(sourceChanges, headPrefix);
  const input = {
    baseSha: options.baseSha, headSha: options.headSha,
    baseFiles: [...baseFiles], headFiles: [...headFiles],
    changedFiles: internal,
    externalChanges: external,
    mode: options.scope ?? config.exploration.scope,
    // Flows mode keeps the route inventory for the map and the navigation context, and captures none of it.
    ...(config.mode === "flows" ? { captureRoutes: false } : {}),
    ...(config.exploration.exclude ? { exclude: config.exploration.exclude } : {}),
    provider: config.navigation.provider,
    ...(config.navigation.entry ? { entry: config.navigation.entry } : {}),
    ...(config.app.scheme ? { scheme: config.app.scheme } : {}),
    ...(config.parameters ? { parameters: config.parameters } : {}),
    platform: config.app.platform,
  };
  const source = new URL(import.meta.url).pathname.endsWith(".ts");
  const worker = fileURLToPath(new URL(source ? "../source/plan-worker.ts" : "../source/plan-worker.js", import.meta.url));
  const run = (value: typeof input): { plan: SourceCapturePlan; canonical: string } => {
    const result = spawnSync(process.execPath, [...(source ? ["--import", import.meta.resolve("tsx")] : []), worker], {
      input: JSON.stringify(value), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    });
    if (result.error || result.status !== 0) {
      let diagnostic: unknown;
      try { diagnostic = JSON.parse(result.stderr); } catch { /* A terminated worker may not emit a diagnostic. */ }
      if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) {
        const value = diagnostic as Record<string, unknown>;
        if (typeof value.code === "string" && typeof value.stage === "string" && typeof value.message === "string"
          && typeof value.nextAction === "string" && typeof value.retryable === "boolean") {
          throw new CiError({ code: value.code, stage: value.stage, message: value.message,
            nextAction: value.nextAction, retryable: value.retryable,
            ...(value.details && typeof value.details === "object" && !Array.isArray(value.details)
              ? { details: value.details as Record<string, unknown> } : {}) });
        }
      }
      throw new CiError({ code: "SOURCE_ANALYSIS_FAILED", stage: "plan",
        message: "Source analysis did not finish or returned an invalid diagnostic.",
        nextAction: "Check the navigation provider and entry in config.yaml, and inspect the source analysis worker exit status.",
        details: { exitCode: result.status, signal: result.signal }, cause: result.error });
    }
    return JSON.parse(result.stdout);
  };
  const first = run(input);
  const second = run({ ...input, baseFiles: [...input.baseFiles].reverse(), headFiles: [...input.headFiles].reverse(),
    changedFiles: [...input.changedFiles].reverse() });
  await mkdir(options.output, { recursive: true });
  await assertPlanConsistency(first.canonical, second.canonical, options.output);
  await writeFile(join(options.output, "plan.json"), first.canonical);
  await writeFile(join(options.output, "execution-plan.json"), JSON.stringify(first.plan));
  await writeFile(join(options.output, "consistency.json"), JSON.stringify({ verified: true, processes: 2,
    sha256: createHash("sha256").update(first.canonical).digest("hex") }));
  return first.plan;
}
