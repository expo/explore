import { deflateRawSync, inflateRawSync } from "node:zlib";
import { isTargetId } from "../config/explore-config.js";

/**
 * The sticky PR comment is rendered from compact per-target records that every writer embeds as hidden
 * HTML comment lines, so the capture, report, deploy and failure jobs of one run (and the runs that follow
 * it) each rewrite the whole comment from the same data without needing the other jobs' files:
 *
 *   <!-- expo-explore-record:<target>:<base64url(deflate(json))> -->   one per target of the current run
 *   <!-- expo-explore-history:<base64url(deflate(json))> -->           earlier runs on this PR
 *
 * A config without targets has one target per platform whose id is the platform (`ios`, `android`); its records
 * carry neither `target` nor `label` nor `order`, so they are byte-identical to the per-platform records of
 * versions before targets, and those still parse.
 *
 * Records read back from GitHub are untrusted: anything that does not match the schema is dropped and the
 * comment renders without it.
 */
export type CommentPlatform = "ios" | "android";
/** A target id (`ios`, `android`, or an id from config.yaml's targets); it keys records and history entries. */
export type CommentTarget = string;
/** A config has at most 8 targets; a comment never holds more records than that. */
export const MAX_COMMENT_TARGETS = 8;
const PLATFORM_LABELS: Record<CommentPlatform, string> = { ios: "iOS", android: "Android" };
const LEGACY_ORDER: CommentPlatform[] = ["ios", "android"];

/** The label a target shows without a `label` of its own: iOS and Android for the per-platform ids, else the id. */
export function defaultTargetLabel(id: CommentTarget): string {
  return id === "ios" || id === "android" ? PLATFORM_LABELS[id] : id;
}
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
/**
 * The group of a screen that changed on several targets. Accessibility only says the screenshots match, so it
 * yields to any other group; otherwise the first target's group stands, as it always has.
 */
export function strongerGroup(first: ChangeGroup, other: ChangeGroup): ChangeGroup {
  return first === "accessibility-only" ? other : first;
}

export function changeCountText(groups: readonly ChangeGroup[]): string {
  const accessibility = groups.filter(group => group === "accessibility-only").length;
  const visual = groups.length - accessibility;
  if (!accessibility) return `${visual} change${visual === 1 ? "" : "s"}`;
  return [visual ? `${visual} visual change${visual === 1 ? "" : "s"}` : undefined, `${accessibility} accessibility only`].filter(Boolean).join(" · ");
}

export type NavigationGroup = "added" | "modified" | "removed";
export type NavigationKind = "push" | "replace" | "navigate" | "redirect" | "tab" | "dismissTo";
const NAVIGATION_GROUPS: NavigationGroup[] = ["added", "modified", "removed"];
const NAVIGATION_KINDS: NavigationKind[] = ["push", "replace", "navigate", "redirect", "tab", "dismissTo"];
export const MAX_NAVIGATION_NODES = 30;
export const MAX_NAVIGATION_EDGES = 80;

/**
 * The comment's map: one node per route that was added, removed or changed visually, and per route one step before
 * one of them; edges index `nodes`. `tab` marks a route a tab switch shows, `base` an edge into a removed route, which
 * only the base revision's navigation has.
 */
export type CommentNavigation = {
  nodes: { route: string; group?: NavigationGroup; tab?: true }[];
  edges: { from: number; to: number; kinds: NavigationKind[]; base?: true }[];
};

export type SideHealth = { planned: number; captured: number; verified: number; unverified: number; unavailable: number };

export type PlatformRecord = {
  v: 1;
  /** The target's platform. A failure record of a target it never saw before guesses ios; nothing renders it. */
  platform: CommentPlatform;
  /** The target id, when it is not the platform. */
  target?: CommentTarget;
  /** What the comment calls the target, when that is not defaultTargetLabel(id). */
  label?: string;
  /** The target's position in config.yaml, when the run's targets are not the per-platform ios, android. */
  order?: number;
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
  /** Screens whose source changed and whose captures were verified, but that got no verdict: the comparison did not run or failed. */
  notCompared?: number;
  /**
   * Screens whose own source changed but whose compared captures show nothing of it, neither in the accessibility tree
   * nor in the pixels: the change can be there and out of sight, so another target's row says "not visible" here.
   */
  notVisible?: string[];
  /** Differences stated once rather than per screen (variants, app-wide source changes). */
  context?: string[];
  navigation?: CommentNavigation;
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
  /** Keyed by target id (the platform for configs without targets; the key keeps its old name so old entries parse). */
  platforms: Partial<Record<CommentTarget, HistoryItem>>;
};
export type HistoryItem = { phase: RecordPhase; summary: string; run: string; report?: string; download?: string; superseded?: boolean; label?: string; order?: number };

export type CommentRecords = {
  current: Partial<Record<CommentTarget, PlatformRecord>>;
  /** The last finished run's records, shown while the current run has no finished record of its own. */
  previous?: Partial<Record<CommentTarget, PlatformRecord>>;
  history: HistoryEntry[];
};

/** The id a record is keyed by. */
export function recordTarget(record: Pick<PlatformRecord, "platform" | "target">): CommentTarget {
  return record.target ?? record.platform;
}

export function recordLabel(record: Pick<PlatformRecord, "platform" | "target" | "label">): string {
  return record.label ?? defaultTargetLabel(recordTarget(record));
}

/** Config order where the run recorded one, else iOS before Android, then by id. */
export function compareTargets(a: { id: CommentTarget; order?: number | undefined }, b: { id: CommentTarget; order?: number | undefined }): number {
  const rank = (item: { id: CommentTarget; order?: number | undefined }) => item.order ?? (LEGACY_ORDER.includes(item.id as CommentPlatform) ? LEGACY_ORDER.indexOf(item.id as CommentPlatform) : MAX_COMMENT_TARGETS);
  return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The current records in display order. */
export function orderedRecords(records: CommentRecords): PlatformRecord[] {
  return ordered(records.current);
}

/** The previous run's records in display order. */
export function orderedPrevious(records: CommentRecords): PlatformRecord[] {
  return ordered(records.previous ?? {});
}

function ordered(records: Partial<Record<CommentTarget, PlatformRecord>>): PlatformRecord[] {
  return Object.values(records).filter((record): record is PlatformRecord => Boolean(record))
    .sort((a, b) => compareTargets({ id: recordTarget(a), order: a.order }, { id: recordTarget(b), order: b.order }));
}

export const HISTORY_LIMIT = 5;
const RECORD_LINE = /^<!-- expo-explore-record:([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_-]+) -->$/gm;
const PREVIOUS_LINE = /^<!-- expo-explore-previous:([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_-]+) -->$/gm;
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
  return `<!-- expo-explore-record:${recordTarget(record)}:${encodeRecordPayload(record)} -->`;
}

export function previousLine(record: PlatformRecord): string {
  return `<!-- expo-explore-previous:${recordTarget(record)}:${encodeRecordPayload(record)} -->`;
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
const isLabel = (value: unknown): value is string => isString(value, 80) && value.trim().length > 0;
const isOrder = (value: unknown): value is number => isCount(value) && value < MAX_COMMENT_TARGETS;
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
    || !(value.links.deploying === undefined || value.links.deploying === true)
    || !optional(value.target, isTargetId) || !optional(value.label, isLabel) || !optional(value.order, isOrder)) return undefined;
  const record: PlatformRecord = {
    v: 1, platform: value.platform, ...(value.target !== undefined && value.target !== value.platform ? { target: value.target } : {}),
    ...(value.label !== undefined ? { label: value.label } : {}), ...(value.order !== undefined ? { order: value.order } : {}), runId: value.runId, runAttempt: value.runAttempt, headSha: value.headSha, baseSha: value.baseSha,
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
  const navigation = parseNavigation(value.navigation);
  if (navigation) record.navigation = navigation;
  if (Array.isArray(value.context)) record.context = value.context.filter((entry): entry is string => isString(entry, 2000)).slice(0, 10);
  if (Array.isArray(value.diagnostics)) {
    record.diagnostics = value.diagnostics.flatMap((entry): NonNullable<PlatformRecord["diagnostics"]> => isRecord(entry) && isString(entry.route, 2000) && isString(entry.code, 200)
      && isString(entry.message) && isString(entry.nextAction)
      ? [{ ...(isSide(entry.side) ? { side: entry.side } : {}), route: entry.route, code: entry.code, message: entry.message, nextAction: entry.nextAction }] : []).slice(0, 20);
  }
  if (isCount(value.notCompared) && value.notCompared > 0) record.notCompared = value.notCompared;
  if (Array.isArray(value.notVisible)) {
    const ids = value.notVisible.filter((entry): entry is string => isString(entry, 220));
    if (ids.length && ids.length <= 2000) record.notVisible = ids;
  }
  if (isCount(value.diagnosticCount)) record.diagnosticCount = value.diagnosticCount;
  if (isRecord(value.failure) && isString(value.failure.step, 200) && isString(value.failure.message)) record.failure = { step: value.failure.step, message: value.failure.message };
  if (value.superseded === true) record.superseded = true;
  return record;
}

function parseNavigation(value: unknown): CommentNavigation | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > MAX_NAVIGATION_NODES
    || value.edges.length > MAX_NAVIGATION_EDGES) return undefined;
  const nodes: CommentNavigation["nodes"] = [];
  for (const node of value.nodes) {
    if (!isRecord(node) || !isString(node.route, 200) || !optional(node.group, (group): group is NavigationGroup => NAVIGATION_GROUPS.includes(group as NavigationGroup))
      || !(node.tab === undefined || node.tab === true)) return undefined;
    nodes.push({ route: node.route, ...(node.group ? { group: node.group } : {}), ...(node.tab ? { tab: true } : {}) });
  }
  const edges: CommentNavigation["edges"] = [];
  const isNode = (index: unknown): index is number => isCount(index) && index < nodes.length;
  for (const edge of value.edges) {
    if (!isRecord(edge) || !isNode(edge.from) || !isNode(edge.to) || !Array.isArray(edge.kinds) || !edge.kinds.length
      || !edge.kinds.every(kind => NAVIGATION_KINDS.includes(kind as NavigationKind)) || !(edge.base === undefined || edge.base === true)) return undefined;
    edges.push({ from: edge.from, to: edge.to, kinds: [...new Set(edge.kinds as NavigationKind[])], ...(edge.base ? { base: true } : {}) });
  }
  return nodes.length && edges.length ? { nodes, edges } : undefined;
}

export function parseHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: HistoryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isString(entry.headSha) || !SHA.test(entry.headSha) || !isString(entry.baseSha) || !SHA.test(entry.baseSha)
      || !isString(entry.runId, 200) || !SAFE_ID.test(entry.runId) || !isTime(entry.startedAt) || !isRecord(entry.platforms)) continue;
    const platforms: HistoryEntry["platforms"] = {};
    for (const target of Object.keys(entry.platforms).filter(isTargetId).slice(0, MAX_COMMENT_TARGETS)) {
      const item = entry.platforms[target];
      if (!isRecord(item) || !isPhase(item.phase) || !isString(item.summary, 400) || !isUrl(item.run)
        || !optional(item.report, isUrl) || !optional(item.download, isUrl) || !optional(item.label, isLabel) || !optional(item.order, isOrder)) continue;
      platforms[target] = { phase: item.phase, summary: item.summary, run: item.run, ...(item.report ? { report: item.report } : {}), ...(item.download ? { download: item.download } : {}),
        ...(item.superseded === true ? { superseded: true } : {}), ...(item.label !== undefined ? { label: item.label } : {}), ...(item.order !== undefined ? { order: item.order } : {}) };
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
  const read = (pattern: RegExp, into: Partial<Record<CommentTarget, PlatformRecord>>) => {
    for (const match of body.matchAll(pattern)) {
      const record = parsePlatformRecord(decodePayload(match[2]!));
      const target = record && recordTarget(record);
      if (!record || target !== match[1] || !isTargetId(target)) continue;
      if (into[target] || Object.keys(into).length < MAX_COMMENT_TARGETS) into[target] = record;
    }
  };
  read(RECORD_LINE, records.current);
  const previous: Partial<Record<CommentTarget, PlatformRecord>> = {};
  read(PREVIOUS_LINE, previous);
  if (Object.keys(previous).length) records.previous = previous;
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
      const icon = unavailable > 0 || (record.validation?.visual?.failed ?? 0) > 0 || record.notCompared ? "🟨" : "🟩";
      return `${icon} ${changeCountText(record.changes?.map(change => change.group) ?? [])}${unavailable > 0 ? ` · ${unavailable} unavailable` : ""}${record.notCompared ? ` · ${record.notCompared} not compared` : ""}`;
    }
    default: return "⏳ did not finish";
  }
}

function historyEntryOf(records: PlatformRecord[]): HistoryEntry | undefined {
  const first = records[0];
  if (!first) return undefined;
  const entry: HistoryEntry = { headSha: first.headSha, baseSha: first.baseSha, runId: first.runId, startedAt: Math.min(...records.map(record => record.startedAt)), platforms: {} };
  for (const record of records) {
    entry.platforms[recordTarget(record)] = { phase: record.phase, summary: recordSummary(record), run: record.links.run,
      ...(record.links.report ? { report: record.links.report } : {}), ...(record.links.download ? { download: record.links.download } : {}),
      ...(record.superseded ? { superseded: true } : {}), ...(record.label !== undefined ? { label: record.label } : {}),
      ...(record.order !== undefined ? { order: record.order } : {}) };
  }
  return entry;
}

const runOrder = (runId: string): number => Number.parseInt(runId, 10) || 0;

function pushHistory(history: HistoryEntry[], entry: HistoryEntry | undefined): HistoryEntry[] {
  if (!entry) return history;
  const merged = [entry, ...history.filter(item => item.runId !== entry.runId)];
  // One entry per run: a target that reaches history later joins the entry its sibling made.
  const existing = history.find(item => item.runId === entry.runId);
  if (existing) merged[0] = { ...existing, platforms: { ...existing.platforms, ...entry.platforms } };
  return merged.sort((a, b) => runOrder(b.runId) - runOrder(a.runId) || b.startedAt - a.startedAt).slice(0, HISTORY_LIMIT);
}

/**
 * Fold one writer's record into the comment's records. The same run replaces its own target; a newer run
 * moves the previous run into history; a run that finds a newer run already current (the PR moved while it
 * worked) is superseded and only adds itself to history, so its report stays linked without displacing the
 * current review.
 */
export function foldRecord(existing: CommentRecords, incoming: PlatformRecord): CommentRecords {
  const current = orderedRecords(existing);
  const record = withKnownTarget(incoming, existing);
  const target = recordTarget(record);
  const currentRun = current[0];
  const previous = existing.previous ?? {};
  if (!currentRun && record.superseded) return { current: {}, previous, history: pushHistory(existing.history, historyEntryOf([record])) };
  if (!currentRun || currentRun.runId === record.runId) {
    const next = { ...existing.current, [target]: record };
    // A rerun's new attempt replaces a ready record with one that is not; the ready one stays readable meanwhile.
    const replaced = existing.current[target];
    const rerun = replaced && isReady(replaced) && !isReady(record) && Number(record.runAttempt) > Number(replaced.runAttempt);
    return { current: next, previous: trimPrevious(rerun ? { ...ofRun(previous, record.runId), [target]: replaced } : previous, next), history: existing.history };
  }
  if (runOrder(currentRun.runId) > runOrder(record.runId) || record.superseded) {
    return { current: existing.current, previous, history: pushHistory(existing.history, historyEntryOf([{ ...record, superseded: true }])) };
  }
  // The review of the run being replaced stays readable until the new run has a ready target. It replaces older
  // previous records rather than joining them: what the comment shows as one review comes from one run. A run without a
  // ready target has no review, so the one before it stays.
  const kept = current.some(isReady) ? Object.fromEntries(current.filter(isFinished).map(item => [recordTarget(item), item])) : previous;
  const next = { [target]: record };
  return { current: next, previous: trimPrevious(kept, next), history: pushHistory(existing.history, historyEntryOf(current)) };
}

const isFinished = (record: PlatformRecord) => record.phase === "ready" || record.phase === "failed";
const isReady = (record: PlatformRecord) => record.phase === "ready";

function ofRun(records: Partial<Record<CommentTarget, PlatformRecord>>, runId: string): Partial<Record<CommentTarget, PlatformRecord>> {
  return Object.fromEntries(Object.entries(records).filter(([, record]) => record?.runId === runId));
}

/**
 * A target's previous record goes once its current one is ready; all of them go once every current record finished
 * and one is ready. A failure is no review: the previous one stays up beside it.
 */
function trimPrevious(previous: Partial<Record<CommentTarget, PlatformRecord>>, current: Partial<Record<CommentTarget, PlatformRecord>>): Partial<Record<CommentTarget, PlatformRecord>> {
  const records = Object.values(current).filter((record): record is PlatformRecord => Boolean(record));
  if (records.every(isFinished) && records.some(isReady)) return {};
  const trimmed = { ...previous };
  for (const record of records) if (isReady(record)) delete trimmed[recordTarget(record)];
  return trimmed;
}

/**
 * The failure job knows a target only by the id in an artifact name: its record takes the label, order and platform
 * the comment already holds for that id (from the capture job's progress record, or the newest run that had it).
 */
function withKnownTarget(record: PlatformRecord, existing: CommentRecords): PlatformRecord {
  const target = recordTarget(record);
  if (!record.target || record.label !== undefined || record.order !== undefined) return record;
  const known = existing.current[target] ?? existing.previous?.[target];
  if (known) return { ...record, platform: known.platform, ...(known.label !== undefined ? { label: known.label } : {}), ...(known.order !== undefined ? { order: known.order } : {}) };
  const item = existing.history.find(entry => entry.platforms[target])?.platforms[target];
  return item ? { ...record, ...(item.label !== undefined ? { label: item.label } : {}), ...(item.order !== undefined ? { order: item.order } : {}) } : record;
}
