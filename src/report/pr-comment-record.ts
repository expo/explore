import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * The sticky PR comment is rendered from compact per-platform records that every writer embeds as hidden
 * HTML comment lines, so the capture, report, deploy and failure jobs of one run (and the runs that follow
 * it) each rewrite the whole comment from the same data without needing the other jobs' files:
 *
 *   <!-- expo-explore-record:<platform>:<base64url(deflate(json))> -->   one per platform of the current run
 *   <!-- expo-explore-history:<base64url(deflate(json))> -->             earlier runs on this PR
 *
 * Records read back from GitHub are untrusted: anything that does not match the schema is dropped and the
 * comment renders without it.
 */
export type CommentPlatform = "ios" | "android";
export type RecordPhase = "pending" | "capturing" | "ready" | "failed";
/**
 * `accessibility-only`: modified, but the screenshots match; only what assistive technology reads changed. A screen
 * whose source changed but that was not compared is no group: Explore reports what the captures show, not what the code
 * might do.
 */
export type ChangeGroup = "added" | "modified" | "removed" | "accessibility-only" | "needs-review";
export const CHANGE_GROUPS: ChangeGroup[] = ["added", "removed", "modified", "accessibility-only", "needs-review"];

/**
 * "12 changes", or "3 visual changes · 12 accessibility only" when some changed only for assistive technology: those
 * are changes too (screen readers and voice control see them), but not ones a screenshot shows.
 */
export function changeCountText(groups: readonly ChangeGroup[]): string {
  const accessibility = groups.filter(group => group === "accessibility-only").length;
  const visual = groups.length - accessibility;
  if (!accessibility) return `${visual} change${visual === 1 ? "" : "s"}`;
  return [visual ? `${visual} visual change${visual === 1 ? "" : "s"}` : undefined, `${accessibility} accessibility only`].filter(Boolean).join(" · ");
}

export type SideHealth = { planned: number; captured: number; verified: number; unverified: number; unavailable: number };

export type PlatformRecord = {
  v: 1;
  platform: CommentPlatform;
  runId: string;
  runAttempt: string;
  headSha: string;
  baseSha: string;
  startedAt: number;
  updatedAt: number;
  phase: RecordPhase;
  /** "iPhone 17 26.5 · light + dark" */
  device?: string;
  app?: { name?: string; version?: string; build?: string };
  links: { run: string; report?: string; download?: string; artifacts: string; config: string; expiresAt?: number | null; deploying?: true };
  capture?: { planned: { base: number; head: number }; done: { base: number; head: number }; baseFromCache: boolean; current?: "base" | "head" };
  health?: { base: SideHealth; head: SideHealth };
  validation?: {
    visual?: { compared: number; threshold: number; eligible?: number; skipped?: number; failed: number };
    accessibility?: { compared: number; described: number; failed: number };
    routes?: number;
  };
  /** The review's changed surfaces, one per surface; `scheme` for a secondary appearance (`<route>@<scheme>`). */
  changes?: { id: string; route: string; group: ChangeGroup; description: string; scheme?: string }[];
  /** Differences stated once rather than per screen (variants, app-wide source changes). */
  context?: string[];
  diagnostics?: { side?: "base" | "head"; route: string; code: string; message: string; nextAction: string }[];
  diagnosticCount?: number;
  failure?: { step: string; message: string };
  /** The PR moved while this run worked; its report stays reachable but it is not the current review. */
  superseded?: boolean;
};

export type HistoryEntry = {
  headSha: string;
  baseSha: string;
  runId: string;
  startedAt: number;
  platforms: Partial<Record<CommentPlatform, { phase: RecordPhase; summary: string; run: string; report?: string; download?: string; superseded?: boolean }>>;
};

export type CommentRecords = { current: Partial<Record<CommentPlatform, PlatformRecord>>; history: HistoryEntry[] };

export const HISTORY_LIMIT = 5;
const RECORD_LINE = /^<!-- expo-explore-record:(ios|android):([A-Za-z0-9_-]+) -->$/gm;
const HISTORY_LINE = /^<!-- expo-explore-history:([A-Za-z0-9_-]+) -->$/m;
const MAX_ENCODED = 24_000;
const MAX_DECODED = 256_000;
const SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function encodeRecordPayload(value: unknown): string {
  return deflateRawSync(Buffer.from(JSON.stringify(value), "utf8"), { level: 9 }).toString("base64url");
}

function decodePayload(encoded: string): unknown {
  if (encoded.length > MAX_ENCODED) return undefined;
  try {
    const bytes = inflateRawSync(Buffer.from(encoded, "base64url"), { maxOutputLength: MAX_DECODED });
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function recordLine(record: PlatformRecord): string {
  return `<!-- expo-explore-record:${record.platform}:${encodeRecordPayload(record)} -->`;
}

export function historyLine(history: HistoryEntry[]): string | undefined {
  return history.length ? `<!-- expo-explore-history:${encodeRecordPayload(history)} -->` : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown, maximum = 4000): value is string => typeof value === "string" && value.length <= maximum;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const isPhase = (value: unknown): value is RecordPhase => value === "pending" || value === "capturing" || value === "ready" || value === "failed";
const isPlatform = (value: unknown): value is CommentPlatform => value === "ios" || value === "android";
const isSide = (value: unknown): value is "base" | "head" => value === "base" || value === "head";
const isUrl = (value: unknown): value is string => {
  if (!isString(value, 4000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !/[\u0000-\u0020\u007f]/.test(value);
  } catch { return false; }
};
const optional = <T>(value: unknown, check: (value: unknown) => value is T): value is T | undefined => value === undefined || check(value);
const health = (value: unknown): value is SideHealth => isRecord(value) && isCount(value.planned) && isCount(value.captured)
  && isCount(value.verified) && isCount(value.unverified) && isCount(value.unavailable);
const pair = (value: unknown): value is { base: number; head: number } => isRecord(value) && isCount(value.base) && isCount(value.head);

/** A record exactly as this module writes it, or undefined. Unknown keys are dropped. */
export function parsePlatformRecord(value: unknown): PlatformRecord | undefined {
  if (!isRecord(value) || value.v !== 1 || !isPlatform(value.platform) || !isString(value.runId, 200) || !SAFE_ID.test(value.runId)
    || !isString(value.runAttempt, 200) || !SAFE_ID.test(value.runAttempt) || !isString(value.headSha) || !SHA.test(value.headSha)
    || !isString(value.baseSha) || !SHA.test(value.baseSha) || !isTime(value.startedAt) || !isTime(value.updatedAt) || !isPhase(value.phase)
    || !isRecord(value.links) || !isUrl(value.links.run) || !isUrl(value.links.artifacts) || !isUrl(value.links.config)
    || !optional(value.links.report, isUrl) || !optional(value.links.download, isUrl)
    || !(value.links.expiresAt === undefined || value.links.expiresAt === null || isTime(value.links.expiresAt))
    || !(value.links.deploying === undefined || value.links.deploying === true)) return undefined;
  const record: PlatformRecord = {
    v: 1, platform: value.platform, runId: value.runId, runAttempt: value.runAttempt, headSha: value.headSha, baseSha: value.baseSha,
    startedAt: value.startedAt, updatedAt: value.updatedAt, phase: value.phase,
    links: { run: value.links.run, artifacts: value.links.artifacts, config: value.links.config,
      ...(value.links.report ? { report: value.links.report } : {}), ...(value.links.download ? { download: value.links.download } : {}),
      ...(value.links.expiresAt !== undefined ? { expiresAt: value.links.expiresAt } : {}),
      ...(value.links.deploying ? { deploying: true } : {}) },
  };
  if (isString(value.device, 200)) record.device = value.device;
  if (isRecord(value.app)) {
    const app = { ...(isString(value.app.name, 200) ? { name: value.app.name } : {}), ...(isString(value.app.version, 200) ? { version: value.app.version } : {}),
      ...(isString(value.app.build, 200) ? { build: value.app.build } : {}) };
    if (Object.keys(app).length) record.app = app;
  }
  if (isRecord(value.capture) && pair(value.capture.planned) && pair(value.capture.done) && typeof value.capture.baseFromCache === "boolean") {
    record.capture = { planned: { base: value.capture.planned.base, head: value.capture.planned.head }, done: { base: value.capture.done.base, head: value.capture.done.head },
      baseFromCache: value.capture.baseFromCache, ...(isSide(value.capture.current) ? { current: value.capture.current } : {}) };
  }
  if (isRecord(value.health) && health(value.health.base) && health(value.health.head)) {
    const pick = (side: SideHealth): SideHealth => ({ planned: side.planned, captured: side.captured, verified: side.verified, unverified: side.unverified, unavailable: side.unavailable });
    record.health = { base: pick(value.health.base), head: pick(value.health.head) };
  }
  if (isRecord(value.validation)) {
    const validation: NonNullable<PlatformRecord["validation"]> = {};
    const visual = value.validation.visual;
    if (isRecord(visual) && isCount(visual.compared) && typeof visual.threshold === "number" && Number.isFinite(visual.threshold) && isCount(visual.failed)) {
      validation.visual = { compared: visual.compared, threshold: visual.threshold, failed: visual.failed,
        ...(isCount(visual.eligible) ? { eligible: visual.eligible } : {}), ...(isCount(visual.skipped) ? { skipped: visual.skipped } : {}) };
    }
    const accessibility = value.validation.accessibility;
    if (isRecord(accessibility) && isCount(accessibility.compared) && isCount(accessibility.described) && isCount(accessibility.failed)) {
      validation.accessibility = { compared: accessibility.compared, described: accessibility.described, failed: accessibility.failed };
    }
    if (isCount(value.validation.routes)) validation.routes = value.validation.routes;
    if (Object.keys(validation).length) record.validation = validation;
  }
  if (Array.isArray(value.changes)) {
    const changes = value.changes.flatMap((entry): NonNullable<PlatformRecord["changes"]> => isRecord(entry) && isString(entry.id, 220) && isString(entry.route, 2000)
      && CHANGE_GROUPS.includes(entry.group as ChangeGroup) && isString(entry.description, 2000)
      ? [{ id: entry.id, route: entry.route, group: entry.group as ChangeGroup, description: entry.description, ...(isString(entry.scheme, 20) ? { scheme: entry.scheme } : {}) }] : []);
    if (changes.length <= 2000) record.changes = changes;
  }
  if (Array.isArray(value.context)) record.context = value.context.filter((entry): entry is string => isString(entry, 2000)).slice(0, 10);
  if (Array.isArray(value.diagnostics)) {
    record.diagnostics = value.diagnostics.flatMap((entry): NonNullable<PlatformRecord["diagnostics"]> => isRecord(entry) && isString(entry.route, 2000) && isString(entry.code, 200)
      && isString(entry.message) && isString(entry.nextAction)
      ? [{ ...(isSide(entry.side) ? { side: entry.side } : {}), route: entry.route, code: entry.code, message: entry.message, nextAction: entry.nextAction }] : []).slice(0, 20);
  }
  if (isCount(value.diagnosticCount)) record.diagnosticCount = value.diagnosticCount;
  if (isRecord(value.failure) && isString(value.failure.step, 200) && isString(value.failure.message)) record.failure = { step: value.failure.step, message: value.failure.message };
  if (value.superseded === true) record.superseded = true;
  return record;
}

export function parseHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: HistoryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isString(entry.headSha) || !SHA.test(entry.headSha) || !isString(entry.baseSha) || !SHA.test(entry.baseSha)
      || !isString(entry.runId, 200) || !SAFE_ID.test(entry.runId) || !isTime(entry.startedAt) || !isRecord(entry.platforms)) continue;
    const platforms: HistoryEntry["platforms"] = {};
    for (const platform of ["ios", "android"] as const) {
      const item = entry.platforms[platform];
      if (!isRecord(item) || !isPhase(item.phase) || !isString(item.summary, 400) || !isUrl(item.run)
        || !optional(item.report, isUrl) || !optional(item.download, isUrl)) continue;
      platforms[platform] = { phase: item.phase, summary: item.summary, run: item.run, ...(item.report ? { report: item.report } : {}), ...(item.download ? { download: item.download } : {}),
        ...(item.superseded === true ? { superseded: true } : {}) };
    }
    if (Object.keys(platforms).length) entries.push({ headSha: entry.headSha, baseSha: entry.baseSha, runId: entry.runId, startedAt: entry.startedAt, platforms });
    if (entries.length === HISTORY_LIMIT) break;
  }
  return entries;
}

/** The records an existing comment carries; a legacy or hand-edited comment yields none. */
export function readCommentRecords(body: string | undefined): CommentRecords {
  const records: CommentRecords = { current: {}, history: [] };
  if (!body) return records;
  for (const match of body.matchAll(RECORD_LINE)) {
    const record = parsePlatformRecord(decodePayload(match[2]!));
    if (record && record.platform === match[1]) records.current[record.platform] = record;
  }
  const history = body.match(HISTORY_LINE);
  if (history) records.history = parseHistory(decodePayload(history[1]!));
  return records;
}

/** A short result for a run that is no longer current: "🟩 34 changes", "🟨 12 changes · 4 unavailable", "🟥 failed · capture". */
export function recordSummary(record: PlatformRecord): string {
  switch (record.phase) {
    case "failed": return `🟥 failed · ${record.failure?.step ?? "capture"}`;
    case "ready": {
      const unavailable = record.health ? record.health.base.unavailable + record.health.head.unavailable : 0;
      const icon = unavailable > 0 || (record.validation?.visual?.failed ?? 0) > 0 ? "🟨" : "🟩";
      return `${icon} ${changeCountText(record.changes?.map(change => change.group) ?? [])}${unavailable > 0 ? ` · ${unavailable} unavailable` : ""}`;
    }
    default: return "⏳ did not finish";
  }
}

function historyEntryOf(records: PlatformRecord[]): HistoryEntry | undefined {
  const first = records[0];
  if (!first) return undefined;
  const entry: HistoryEntry = { headSha: first.headSha, baseSha: first.baseSha, runId: first.runId, startedAt: Math.min(...records.map(record => record.startedAt)), platforms: {} };
  for (const record of records) {
    entry.platforms[record.platform] = { phase: record.phase, summary: recordSummary(record), run: record.links.run,
      ...(record.links.report ? { report: record.links.report } : {}), ...(record.links.download ? { download: record.links.download } : {}),
      ...(record.superseded ? { superseded: true } : {}) };
  }
  return entry;
}

const runOrder = (runId: string): number => Number.parseInt(runId, 10) || 0;

function pushHistory(history: HistoryEntry[], entry: HistoryEntry | undefined): HistoryEntry[] {
  if (!entry) return history;
  const merged = [entry, ...history.filter(item => item.runId !== entry.runId)];
  // One entry per run: a platform that reaches history later joins the entry its sibling made.
  const existing = history.find(item => item.runId === entry.runId);
  if (existing) merged[0] = { ...existing, platforms: { ...existing.platforms, ...entry.platforms } };
  return merged.sort((a, b) => runOrder(b.runId) - runOrder(a.runId) || b.startedAt - a.startedAt).slice(0, HISTORY_LIMIT);
}

/**
 * Fold one writer's record into the comment's records. The same run replaces its own platform; a newer run
 * moves the previous run into history; a run that finds a newer run already current (the PR moved while it
 * worked) is superseded and only adds itself to history, so its report stays linked without displacing the
 * current review.
 */
export function foldRecord(existing: CommentRecords, record: PlatformRecord): CommentRecords {
  const current = Object.values(existing.current).filter((item): item is PlatformRecord => Boolean(item));
  const currentRun = current[0];
  if (!currentRun && record.superseded) return { current: {}, history: pushHistory(existing.history, historyEntryOf([record])) };
  if (!currentRun || currentRun.runId === record.runId) {
    return { current: { ...existing.current, [record.platform]: record }, history: existing.history };
  }
  if (runOrder(currentRun.runId) > runOrder(record.runId) || record.superseded) {
    return { current: existing.current, history: pushHistory(existing.history, historyEntryOf([{ ...record, superseded: true }])) };
  }
  return { current: { [record.platform]: record }, history: pushHistory(existing.history, historyEntryOf(current)) };
}
