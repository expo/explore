import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExplorePlatform } from "../config/explore-config.js";
import type { ArtifactReport } from "../contracts/artifact-report.js";
import { EXPLORATION_REPORT_KIND, type ExplorationReport } from "../contracts/standalone-report.js";
import { exploreCacheRoot } from "../shared/cache-root.js";
import { MAX_METADATA_BYTES } from "./agent-api.js";
import { reviewChanges, reviewDevice } from "./pr-comment-body.js";
import type { ChangeGroup } from "./pr-comment-record.js";
import { readZipDirectory, readZipEntry } from "./zip-reader.js";

/**
 * Every report a run produces on this machine is kept under `<cache>/reports/<id>/`: one `<platform>.zip` per platform
 * (the same ZIP a hosted or local Viewer serves) and `run.json`, what `expo-explore reports` lists. Local reviews,
 * explorations and uploaded reports land here, so a past run can be reopened or hosted without capturing it again.
 * Runs older than 30 days, and the oldest beyond 2 GB, are pruned whenever a run is saved.
 */
export type SavedCommit = { ref: string; sha: string; subject?: string };
export type SavedRun = {
  version: 1;
  id: string;
  kind: "local" | "pull-request" | "compare" | "exploration";
  title: string;
  repository?: string;
  number?: number;
  head?: SavedCommit;
  base?: SavedCommit;
  /** A local review of uncommitted changes: how many files differed from HEAD. */
  uncommittedFiles?: number;
  platforms: ExplorePlatform[];
  device?: string;
  /** Changed surfaces by group across the platforms, as the PR comment counts them. */
  changes?: Partial<Record<ChangeGroup, number>>;
  explored?: { app: string; version?: string; buildNumber?: string; screens: number; unexplored: number };
  /** When the run happened, from its report. */
  createdAt: string;
  /** When it was kept here; pruning goes by this, so an old report saved today stays for the full period. */
  savedAt: string;
  bytes: number;
};
export type SavedReport = { platform: ExplorePlatform; zip: Uint8Array; changes?: number; device?: string };

export const SAVED_RUN_LIMITS = { maxAgeDays: 30, maxBytes: 2 * 1024 * 1024 * 1024 } as const;
const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;

export function savedRunsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(exploreCacheRoot(environment), "reports");
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "run";

async function reportJson(zip: Uint8Array): Promise<{ file: "review.json" | "exploration.json"; json: unknown } | undefined> {
  const entries = readZipDirectory(zip);
  const file = entries?.has("review.json") ? "review.json" : entries?.has("exploration.json") ? "exploration.json" : undefined;
  if (!entries || !file) return undefined;
  const bytes = await readZipEntry(zip, entries.get(file)!, MAX_METADATA_BYTES);
  if (!bytes) return undefined;
  try { return { file, json: JSON.parse(new TextDecoder().decode(bytes)) }; } catch { return undefined; }
}

/**
 * What a run's report ZIPs say about it: its kind, title, commits, platforms and changes. Commit subjects are not in
 * the reports; the caller adds them when it has the repository (`subjects`).
 */
export async function describeReports(reports: SavedReport[], extra: { subjects?: { head?: string; base?: string }; uncommittedFiles?: number; createdAt?: string } = {}):
  Promise<Omit<SavedRun, "version" | "bytes" | "savedAt">> {
  const parsed = await Promise.all(reports.map(async report => ({ report, content: await reportJson(report.zip) })));
  const first = parsed[0]?.content;
  if (!first) throw new Error("Not an Explore report ZIP");
  const createdAt = extra.createdAt ?? new Date().toISOString();
  const platforms = parsed.map(entry => entry.report.platform);
  if (first.file === "exploration.json") {
    const report = first.json as Partial<ExplorationReport>;
    if (report.kind !== EXPLORATION_REPORT_KIND || !report.exploration || !report.map) throw new Error("Not an Explore exploration report");
    const { app, device } = report.exploration;
    const zipHash = createHash("sha256").update(reports[0]!.zip).digest("hex").slice(0, 10);
    return { id: `explore-${slug(app.name)}-${zipHash}`, kind: "exploration", title: `${app.name}${app.version ? ` ${app.version}` : ""}${app.buildNumber ? ` (${app.buildNumber})` : ""} on ${device.model}`,
      platforms, device: `${device.model} ${device.osVersion}`.trim(),
      explored: { app: app.name, ...(app.version ? { version: app.version } : {}), ...(app.buildNumber ? { buildNumber: app.buildNumber } : {}),
        screens: report.map.screens.length, unexplored: report.coverage?.frontier.pending ?? 0 },
      createdAt: report.exploration.completedAt ?? createdAt };
  }
  const reviews = parsed.map(entry => (entry.content?.json as Partial<ArtifactReport> | undefined)?.review);
  const review = reviews[0];
  const pr = review?.pullRequest;
  if (!review || !pr) throw new Error("Not an Explore review report");
  // One surface changed on two platforms is one change, under the first platform's group, as the PR comment lists it.
  const merged = new Map<string, ChangeGroup>();
  for (const each of reviews) if (each) for (const [id, group] of reviewChanges(each)) if (!merged.has(id)) merged.set(id, group);
  const changes: Partial<Record<ChangeGroup, number>> = {};
  for (const group of merged.values()) changes[group] = (changes[group] ?? 0) + 1;
  const devices = [...new Set(reviews.map(each => each ? reviewDevice({ runtime: { deviceModel: each.runtime?.device?.model ?? "", osVersion: each.runtime?.device?.osVersion ?? "",
    ...(each.runtime?.colorSchemes ? { colorSchemes: each.runtime.colorSchemes } : {}) } }) : "").filter(Boolean))];
  const kind = pr.origin === "local" ? "local" : pr.origin === "compare" ? "compare" : "pull-request";
  const number = "number" in pr && typeof pr.number === "number" ? pr.number : undefined;
  const id = kind === "local" ? slug(review.runId) : slug(`${kind === "compare" ? "compare" : `pr-${number}`}-${pr.repository.split("/").at(-1)}-${review.runId}-${review.runAttempt}`);
  const commit = (side: "head" | "base"): SavedCommit => ({ ref: pr[side].ref, sha: pr[side].sha, ...(extra.subjects?.[side] ? { subject: extra.subjects[side] } : {}) });
  return { id, kind, title: pr.title, repository: pr.repository, ...(number === undefined ? {} : { number }), head: commit("head"), base: commit("base"),
    ...(extra.uncommittedFiles ? { uncommittedFiles: extra.uncommittedFiles } : {}), platforms, ...(devices.length ? { device: devices.join(", ") } : {}),
    changes, createdAt: review.createdAt ?? createdAt };
}

/** Keeps a run's reports, replacing an earlier copy of the same run, then prunes. Written beside and renamed into place. */
export async function saveRun(reports: SavedReport[], extra: Parameters<typeof describeReports>[1] = {}, environment: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<SavedRun> {
  const described = await describeReports(reports, extra);
  if (!ID.test(described.id)) throw new Error(`Cannot keep a run named ${described.id}`);
  const root = savedRunsDirectory(environment);
  await mkdir(root, { recursive: true });
  const target = join(root, described.id);
  const staged = join(root, `.${described.id}.${randomBytes(4).toString("hex")}.tmp`);
  const run: SavedRun = { version: 1, ...described, savedAt: new Date(now).toISOString(), bytes: reports.reduce((total, report) => total + report.zip.byteLength, 0) };
  try {
    await mkdir(staged);
    for (const report of reports) await writeFile(join(staged, `${report.platform}.zip`), report.zip);
    await writeFile(join(staged, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  await pruneSavedRuns(environment, now, SAVED_RUN_LIMITS, run.id);
  return run;
}

function validRun(value: unknown, id: string): SavedRun | undefined {
  const run = value as Partial<SavedRun> | undefined;
  if (!run || run.version !== 1 || run.id !== id || typeof run.title !== "string" || !Array.isArray(run.platforms) || typeof run.bytes !== "number") return undefined;
  if (!["local", "pull-request", "compare", "exploration"].includes(run.kind ?? "") || Number.isNaN(Date.parse(run.createdAt ?? "")) || Number.isNaN(Date.parse(run.savedAt ?? ""))) return undefined;
  return run as SavedRun;
}

/** The saved runs, newest first; a folder without a readable run.json is skipped. */
export async function listSavedRuns(environment: NodeJS.ProcessEnv = process.env): Promise<SavedRun[]> {
  const root = savedRunsDirectory(environment);
  const names = await readdir(root).catch(() => [] as string[]);
  const runs: SavedRun[] = [];
  for (const name of names) {
    if (!ID.test(name)) continue;
    try {
      const run = validRun(JSON.parse(await readFile(join(root, name, "run.json"), "utf8")), name);
      if (run) runs.push(run);
    } catch { /* a run being written, or not a run */ }
  }
  return runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** A saved run by id, or `latest`. */
export async function findSavedRun(idOrLatest: string, environment: NodeJS.ProcessEnv = process.env): Promise<SavedRun | undefined> {
  const runs = await listSavedRuns(environment);
  return idOrLatest === "latest" ? runs[0] : runs.find(run => run.id === idOrLatest);
}

/** A saved run's reports, in the order the run lists its platforms, labelled for a Viewer's platform switch. */
export async function readSavedReports(run: SavedRun, environment: NodeJS.ProcessEnv = process.env): Promise<SavedReport[]> {
  const root = join(savedRunsDirectory(environment), run.id);
  return Promise.all(run.platforms.map(async platform => ({ platform, zip: new Uint8Array(await readFile(join(root, `${platform}.zip`))) })));
}

export async function removeSavedRun(id: string, environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!ID.test(id)) return false;
  const target = join(savedRunsDirectory(environment), id);
  if (!await lstat(target).then(() => true, () => false)) return false;
  await rm(target, { recursive: true, force: true });
  return true;
}

/** Drops runs kept longer than the age limit, then the longest kept until the rest fit the size limit; never `keep`. Returns what it removed. */
export async function pruneSavedRuns(environment: NodeJS.ProcessEnv = process.env, now = Date.now(), limits: { maxAgeDays: number; maxBytes: number } = SAVED_RUN_LIMITS,
  keep?: string): Promise<SavedRun[]> {
  const runs = (await listSavedRuns(environment)).sort((a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt));
  const removed: SavedRun[] = [];
  let total = runs.reduce((sum, run) => sum + run.bytes, 0);
  for (const run of runs) {
    if (run.id === keep) continue;
    const old = now - Date.parse(run.savedAt) > limits.maxAgeDays * 86_400_000;
    if (!old && total <= limits.maxBytes) continue;
    await removeSavedRun(run.id, environment);
    total -= run.bytes;
    removed.push(run);
  }
  return removed;
}
