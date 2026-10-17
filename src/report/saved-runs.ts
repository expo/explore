import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isTargetId, type ExplorePlatform } from "../config/explore-config.js";
import type { RunTarget } from "../types.js";
import type { ArtifactReport } from "../contracts/artifact-report.js";
import { EXPLORATION_REPORT_KIND, type ExplorationReport } from "../contracts/standalone-report.js";
import { exploreCacheRoot } from "../shared/cache-root.js";
import { MAX_METADATA_BYTES } from "./agent-api.js";
import { normalizePublicReviewForReading } from "../contracts/review-validation.js";
import { reviewChanges, reviewDevice } from "./pr-comment-body.js";
import { strongerGroup, type ChangeGroup } from "./pr-comment-record.js";
import { readZipDirectory, readZipEntry } from "./zip-reader.js";

/**
 * Every report a run produces on this machine is kept under `<cache>/reports/<id>/`: one `<target>.zip` per target
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
  /** The run's targets, in order; their ids name its ZIPs. Absent in runs saved before targets, whose ZIPs are named for `platforms`. */
  targets?: RunTarget[];
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
/** One report of a run. Without a target, it is the target named for its platform, as runs saved before targets were. */
export type SavedReport = { platform: ExplorePlatform; target?: RunTarget; zip: Uint8Array; changes?: number; device?: string };

const PLATFORM_LABELS: Record<ExplorePlatform, string> = { ios: "iOS", android: "Android" };

/** A report's target: its own, else the one named for its platform. */
export function reportTarget(report: Pick<SavedReport, "platform" | "target">): RunTarget {
  return report.target ?? { id: report.platform, platform: report.platform, label: PLATFORM_LABELS[report.platform] };
}

export const SAVED_RUN_LIMITS = { maxAgeDays: 30, maxBytes: 2 * 1024 * 1024 * 1024 } as const;
const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;

export function savedRunsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(exploreCacheRoot(environment), "reports");
}

const slug = (value: string, max: number) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max).replace(/[-.]+$/, "") || "run";

/** Text from a report or a commit, as a terminal may print it: no control characters (C0, DEL, C1), so no escape sequences. */
export function plainText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** A run with every string a report or a commit supplied made plain, including runs saved before this was enforced. */
export function cleanRun(run: SavedRun): SavedRun {
  const commit = (side?: SavedCommit) => side && { ...side, ref: plainText(side.ref), ...(side.subject === undefined ? {} : { subject: plainText(side.subject) }) };
  return { ...run, title: plainText(run.title), ...(run.repository === undefined ? {} : { repository: plainText(run.repository) }),
    ...(run.head ? { head: commit(run.head)! } : {}), ...(run.base ? { base: commit(run.base)! } : {}), ...(run.device === undefined ? {} : { device: plainText(run.device) }),
    ...(run.explored ? { explored: { ...run.explored, app: plainText(run.explored.app), ...(run.explored.version ? { version: plainText(run.explored.version) } : {}),
      ...(run.explored.buildNumber ? { buildNumber: plainText(run.explored.buildNumber) } : {}) } } : {}) };
}

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
  const platforms = [...new Set(parsed.map(entry => entry.report.platform))];
  // Targets named for their platforms describe a run saved the old way, which older versions can still read.
  const targets = reports.map(reportTarget);
  const named = targets.some(target => target.id !== target.platform) ? { targets } : {};
  if (first.file === "exploration.json") {
    const report = first.json as Partial<ExplorationReport>;
    if (report.kind !== EXPLORATION_REPORT_KIND || !report.exploration || !report.map) throw new Error("Not an Explore exploration report");
    const { app, device } = report.exploration;
    const zipHash = createHash("sha256").update(reports[0]!.zip).digest("hex").slice(0, 10);
    return { id: `explore-${slug(app.name, 40)}-${zipHash}`, kind: "exploration", title: `${app.name}${app.version ? ` ${app.version}` : ""}${app.buildNumber ? ` (${app.buildNumber})` : ""} on ${device.model}`,
      platforms, ...named, device: `${device.model} ${device.osVersion}`.trim(),
      explored: { app: app.name, ...(app.version ? { version: app.version } : {}), ...(app.buildNumber ? { buildNumber: app.buildNumber } : {}),
        screens: report.map.screens.length, unexplored: report.coverage?.frontier.pending ?? 0 },
      createdAt: report.exploration.completedAt ?? createdAt };
  }
  const reviews = parsed.map(entry => (entry.content?.json as Partial<ArtifactReport> | undefined)?.review);
  const review = reviews[0];
  const pr = review?.pullRequest;
  if (!review || !pr) throw new Error("Not an Explore review report");
  // One surface changed on two platforms is one change, under the group the PR comment lists it in (strongerGroup).
  const merged = new Map<string, ChangeGroup>();
  for (const each of reviews) if (each) for (const [id, group] of reviewChanges(normalizePublicReviewForReading(each))) {
    const first = merged.get(id);
    merged.set(id, first ? strongerGroup(first, group) : group);
  }
  const changes: Partial<Record<ChangeGroup, number>> = {};
  for (const group of merged.values()) changes[group] = (changes[group] ?? 0) + 1;
  const devices = [...new Set(reviews.map(each => each ? reviewDevice({ runtime: { deviceModel: each.runtime?.device?.model ?? "", osVersion: each.runtime?.device?.osVersion ?? "",
    ...(each.runtime?.colorSchemes ? { colorSchemes: each.runtime.colorSchemes } : {}) } }) : "").filter(Boolean))];
  const kind = pr.origin === "local" ? "local" : pr.origin === "compare" ? "compare" : "pull-request";
  const number = "number" in pr && typeof pr.number === "number" ? pr.number : undefined;
  // The run's own id and attempt are never cut short: two runs of one repository must not share a folder.
  const id = kind === "local" ? slug(review.runId, 100)
    : `${kind === "compare" ? "compare" : `pr-${number}`}-${slug(pr.repository.split("/").at(-1) ?? "", 40)}-${slug(review.runId, 40)}-${slug(String(review.runAttempt), 8)}`;
  const commit = (side: "head" | "base"): SavedCommit => ({ ref: pr[side].ref, sha: pr[side].sha, ...(extra.subjects?.[side] ? { subject: extra.subjects[side] } : {}) });
  return { id, kind, title: pr.title, repository: pr.repository, ...(number === undefined ? {} : { number }), head: commit("head"), base: commit("base"),
    ...(extra.uncommittedFiles ? { uncommittedFiles: extra.uncommittedFiles } : {}), platforms, ...named, ...(devices.length ? { device: devices.join(", ") } : {}),
    changes, createdAt: review.createdAt ?? createdAt };
}

/**
 * Keeps a run's reports, then prunes. A review's platforms saved one at a time join the run already kept for the same
 * review (same repository, run, attempt and commits); anything else under that id is replaced. Written beside and
 * renamed into place.
 */
export async function saveRun(reports: SavedReport[], extra: Parameters<typeof describeReports>[1] = {}, environment: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<SavedRun> {
  let described = await describeReports(reports, extra);
  if (!ID.test(described.id)) throw new Error(`Cannot keep a run named ${described.id}`);
  const root = savedRunsDirectory(environment);
  await mkdir(root, { recursive: true });
  const target = join(root, described.id);
  const kept = await findSavedRun(described.id, environment);
  if (kept && described.kind !== "exploration" && kept.kind === described.kind && kept.repository === described.repository
    && kept.head?.sha === described.head?.sha && kept.base?.sha === described.base?.sha) {
    const others = (await readSavedReports(kept, environment).catch(() => [] as SavedReport[])).filter(report => !reports.some(each => reportTarget(each).id === reportTarget(report).id));
    if (others.length) {
      // The targets' own order when the reports name it; iOS before Android for reports from before targets.
      const order = (await Promise.all([...reports, ...others].map(async report => ((await reportJson(report.zip))?.json as Partial<ArtifactReport> | undefined)?.review?.runtime?.targets)))
        .find(list => Array.isArray(list))?.map(target => target.id) ?? ["ios", "android"];
      const rank = (report: SavedReport) => { const index = order.indexOf(reportTarget(report).id); return index < 0 ? order.length : index; };
      reports = [...reports, ...others].sort((a, b) => rank(a) - rank(b));
      const subjects = { ...(kept.head?.subject ? { head: kept.head.subject } : {}), ...(kept.base?.subject ? { base: kept.base.subject } : {}), ...extra.subjects };
      described = await describeReports(reports, { ...extra, subjects, ...(kept.uncommittedFiles && !extra.uncommittedFiles ? { uncommittedFiles: kept.uncommittedFiles } : {}) });
    }
  }
  const staged = join(root, `.${described.id}.${randomBytes(4).toString("hex")}.tmp`);
  const run = cleanRun({ version: 1, ...described, savedAt: new Date(now).toISOString(), bytes: reports.reduce((total, report) => total + report.zip.byteLength, 0) });
  try {
    await mkdir(staged);
    for (const report of reports) await writeFile(join(staged, `${reportTarget(report).id}.zip`), report.zip);
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
  if (!run || run.version !== 1 || run.id !== id || typeof run.title !== "string" || typeof run.bytes !== "number") return undefined;
  // Targets (else platforms) name the ZIP files read back, so only valid ids.
  if (!Array.isArray(run.platforms) || !run.platforms.length || run.platforms.some(platform => platform !== "ios" && platform !== "android")) return undefined;
  if (run.targets !== undefined && (!Array.isArray(run.targets) || !run.targets.length || run.targets.some(target => !target || !isTargetId(target.id)
    || (target.platform !== "ios" && target.platform !== "android") || typeof target.label !== "string")
    || new Set(run.targets.map(target => target.id)).size !== run.targets.length)) return undefined;
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
      if (run) runs.push(cleanRun(run));
    } catch { /* a run being written, or not a run */ }
  }
  return runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** A saved run by id, or `latest`. */
export async function findSavedRun(idOrLatest: string, environment: NodeJS.ProcessEnv = process.env): Promise<SavedRun | undefined> {
  const runs = await listSavedRuns(environment);
  return idOrLatest === "latest" ? runs[0] : runs.find(run => run.id === idOrLatest);
}

/** A saved run's reports, in the order the run lists its targets, labelled for a Viewer's target switch. */
export async function readSavedReports(run: SavedRun, environment: NodeJS.ProcessEnv = process.env): Promise<SavedReport[]> {
  const root = join(savedRunsDirectory(environment), run.id);
  const targets = run.targets ?? run.platforms.map(platform => reportTarget({ platform }));
  return Promise.all(targets.map(async target => ({ platform: target.platform, target, zip: new Uint8Array(await readFile(join(root, `${target.id}.zip`))) })));
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
