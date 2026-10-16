import type { PublicReview } from "../contracts/capture.js";
import type { SimulatorRuntimeMetadata } from "../capture/run.js";
import { CI_COMMENT_MARKER } from "./pr-comment.js";
import { CHANGE_GROUPS, changeCountText, foldRecord, historyLine, readCommentRecords, recordLine, recordSummary, type ChangeGroup, type CommentPlatform, type CommentRecords, type HistoryEntry, type PlatformRecord } from "./pr-comment-record.js";
import { isAccessibilityOnlyChange } from "../contracts/review-validation.js";
import type { PublicCaptureHealth, PublicEvidenceSummary } from "../review/evidence-assessment.js";
import type { ReviewPresentation } from "../contracts/review.js";
import type { ViewerLinks } from "./viewer-links.js";

const MAX_ROUTE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 160;
/** Stop adding grid cells before GitHub's 65,536-character limit; the sticky-comment writer enforces the hard cap. */
export const PUBLIC_COMMENT_BODY_BUDGET = 60_000;

export type PublicCommentPhase = "pending" | "capturing" | "ready" | "failed";

export type PublicCommentState = {
  phase: PublicCommentPhase;
  pullRequest: ReviewPresentation;
  mode: "all" | "changes";
  executionMode: "deterministic" | "agent";
  /** Repository-relative path of the reviewed configuration file. */
  configPath: string;
  links: ViewerLinks;
  /** Epoch milliseconds. */
  startedAt: number;
  updatedAt: number;
  build?: {
    appName?: string;
    appVersion?: string;
    appBuildNumber?: string;
    platform: "ios" | "android";
    easProfile: string;
    easBuildId?: string;
    reusedEasBuild?: boolean;
  };
  runtime?: SimulatorRuntimeMetadata;
  capture?: {
    planned: { base: number; head: number };
    done: { base: number; head: number };
    baseFromCache: boolean;
    /** Which side is being captured right now, while `capturing`. */
    current?: "base" | "head";
  };
  review?: PublicReview;
  evidence?: PublicEvidenceSummary;
  inventory?: { routes: number };
  warnings?: string[];
  failure?: { step: string; message: string };
  /** Screenshots and per-surface navigation live inside the hosted report. */
  artifactOnly?: boolean;
  /** The PR moved while this run worked; the comment keeps its report under previous runs. */
  superseded?: boolean;
};

type ReviewGroup = ChangeGroup;

const GROUP_ORDER: ReviewGroup[] = CHANGE_GROUPS;
const GROUP_LABEL: Record<ReviewGroup, string> = {
  added: "🟩 Added",
  modified: "🟧 Modified",
  removed: "🟥 Removed",
  "accessibility-only": "🟦 Accessibility only",
  "needs-review": "🟨 Needs review",
};

/** The body is HTML, so no blank lines are needed and the block keeps its natural spacing. */
function details(summary: string, content: string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, ...content, "</details>", ""];
}

function redactCredentials(value: string): string {
  return value
    .replace(/\b(?:github_pat_|gh[pousr]_|sk_(?:live|test)_|sk-proj-|vercel_blob_rw_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]");
}

function plainText(value: string | undefined, maximum: number): string {
  const normalized = typeof value === "string"
    ? redactCredentials(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim()
    : "";
  const characters = Array.from(normalized);
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : normalized;
}

/** Markdown-safe inline text: redacted, bounded, and escaped so it renders literally. */
export function inlineText(value: string | undefined, maximum: number): string {
  return plainText(value, maximum)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~:-]/g, "\\$&")
    .replace(/@/g, "&#64;");
}

function link(label: string, destination: string): string {
  const url = new URL(destination);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
    || /[\u0000-\u0020\u007f]/.test(destination)) {
    throw new Error("Public review links must be HTTP URLs without credentials or whitespace");
  }
  const safeDestination = url.href.replace(/[<>\\]/g, encodeURIComponent);
  return `[${label}](<${safeDestination}>)`;
}

const SUPERSEDED_NOTE = "The pull request moved while this run worked; its report is kept here until the current run replaces it.";

function duration(startedAt: number, updatedAt: number): string {
  const total = Math.max(0, Math.round((updatedAt - startedAt) / 1000));
  if (startedAt <= 0 || total > 24 * 3600) return "";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type Surface = PublicReview["surfaces"][number];

/**
 * The group a surface is listed under, from the run's verdicts. A screen without one (its source changed but no
 * screenshots were compared) is not listed: Explore reports what the captures show. A capture that failed is counted as
 * unavailable in the result and named under Validation instead.
 */
function groupOf(surface: Surface, evidenceBased: boolean): ReviewGroup | "unlisted" {
  if (surface.status === "added" || surface.status === "removed") return surface.status;
  const verified = (["base", "head"] as const).every(side => surface[`${side}Image`]
    && surface[`${side}Outcome`]?.status === "captured" && surface[`${side}Outcome`]?.landing === "verified");
  if (evidenceBased && verified && surface.review && surface.visual?.reason !== "diff-failed") {
    const status = surface.review.status;
    if (status === "unchanged" || status === "variant") return "unlisted";
    return isAccessibilityOnlyChange(surface) ? "accessibility-only" : status;
  }
  return "unlisted";
}

function routeOf(surface: Surface): string {
  return plainText(surface.head?.route || surface.base?.route || surface.id, MAX_ROUTE_LENGTH);
}

function descriptionOf(surface: Surface, group: ReviewGroup): string {
  if (surface.note) return plainText(surface.note.text, MAX_DESCRIPTION_LENGTH);
  const route = routeOf(surface);
  if (group === "added") return `Added ${route} screen`;
  if (group === "removed") return `Removed ${route} screen`;
  // A group's own label already says added or removed; the route makes the line readable alone.
  if (surface.review) return plainText(surface.review.description, MAX_DESCRIPTION_LENGTH);
  return "No visible change";
}

function captureHealth(state: PublicCommentState): PublicEvidenceSummary["capture"] | undefined {
  if (state.evidence?.capture) return state.evidence.capture;
  if (!state.review) return undefined;
  const sideHealth = (side: "base" | "head"): PublicCaptureHealth => {
    const requested = state.review!.surfaces.filter(surface => surface[`${side}Outcome`] || surface[`${side}Image`]);
    const captured = requested.filter(surface => Boolean(surface[`${side}Image`])).length;
    const verified = requested.filter(surface => surface[`${side}Image`]
      && surface[`${side}Outcome`]?.status === "captured" && surface[`${side}Outcome`]?.landing === "verified").length;
    // Without the evidence summary, the capture counters know frames the review does not list (unchanged ones).
    const planned = Math.max(state.capture?.planned[side] ?? 0, requested.length);
    const known = Math.max(state.capture?.done[side] ?? 0, captured);
    return { planned, captured: known, verified, unverified: captured - verified, unavailable: planned - known };
  };
  return { base: sideHealth("base"), head: sideHealth("head") };
}

function previewExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + " (UTC)";
}

/**
 * Differences that are not review targets, stated once instead of per screen: screen variants
 * (source-unchanged screens captured in another runtime state) and app-wide source changes that
 * left some screens without a visible difference.
 */
/** "Launch: splash unchanged for 3.1 s" — the app launch per appearance, kept apart from the screen rows. */
function launchLine(review: PublicReview): string | undefined {
  const launch = review.launch ?? [];
  if (!launch.length) return undefined;
  const parts = launch.map(entry => {
    const label = entry.colorScheme ? `${entry.colorScheme}: ` : "";
    const { head, base } = entry;
    if (!head) return `${label}not observed on this branch`;
    const firstScreen = head.firstScreenMs !== undefined ? `, first screen after ${(head.firstScreenMs / 1000).toFixed(1)} s` : "";
    if (head.status !== "observed") {
      return head.source === "recording" ? `${label}no splash observed (the launch finished before one was shown${firstScreen})`
        : `${label}no splash observed in screenshots (install ffmpeg on the runner to observe short splashes from a recording)`;
    }
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    // How long the splash stayed as it appeared, and when it first changed (a native launch screen handing over, an animation starting).
    const shown = head.splashVisibleMs === undefined ? "" : head.splashChangedMs !== undefined ? `, steady for ${seconds(head.splashVisibleMs)} and first changed at ${seconds(head.splashChangedMs)}`
      : head.source === "recording" ? `, steady for ${seconds(head.splashVisibleMs)}` : `, on screen for at least ${seconds(head.splashVisibleMs)}`;
    const verdict = entry.visual ? { unchanged: "unchanged", modified: "changed", "needs-review": "needs review" }[entry.visual.verdict]
      : base?.status === "observed" ? "not compared" : base ? "not compared (no splash observed on the base build)" : "new (no base launch to compare)";
    return `${label}splash ${verdict}${shown}${firstScreen}${head.video ? ", recording in the report" : ""}`;
  });
  return `Launch: ${parts.join("; ")}.`;
}

function contextLines(review: PublicReview): string[] {
  const variants = review.surfaces.filter(surface => surface.review?.status === "variant").length;
  const appWide = review.surfaces.filter(surface => surface.sourceScope === "app-wide");
  const files = [...new Set(appWide.flatMap(surface => surface.sourceChange?.files.filter(file => file.relation === "global").map(file => file.path) ?? []))].sort();
  const lines: string[] = [];
  const launch = launchLine(review);
  if (launch) lines.push(launch);
  if (variants > 0) lines.push(`${plural(variants, "screen")} ${variants === 1 ? "differs" : "differ"} only in runtime state (screen variants); no source change reaches ${variants === 1 ? "it" : "them"}.`);
  if (appWide.length > 0) {
    const named = files.length ? ` (${files.slice(0, 5).map(path => `\`${plainText(path, 120).replace(/`/g, "")}\``).join(", ")}${files.length > 5 ? ", …" : ""})` : "";
    lines.push(`App-wide source changes${named} reach every screen; screens without a visible difference are not listed.`);
  }
  return lines.length ? [...lines, ""] : [];
}

const PLATFORM_LABELS: Record<CommentPlatform, string> = { ios: "iOS", android: "Android" };
const PLATFORM_ORDER: CommentPlatform[] = ["ios", "android"];
const SURFACE_ID = /^[A-Za-z0-9._-]{1,200}(@(light|dark))?$/;
const MAX_ROWS_PER_GROUP = 200;

/** The run id and attempt the run link names (`…/actions/runs/<id>/attempts/<n>`). */
function runIdentity(run: string): { runId: string; runAttempt: string } {
  const match = /\/actions\/runs\/([^/]+)\/attempts\/([^/?#]+)/.exec(run);
  return { runId: match ? decodeURIComponent(match[1]!) : "0", runAttempt: match ? decodeURIComponent(match[2]!) : "1" };
}

function schemeOf(id: string): string | undefined {
  return /@(light|dark)$/.exec(id)?.[1];
}

/** This writer's state as the compact record the comment is rendered from. */
export function platformRecordOf(state: PublicCommentState, platform?: CommentPlatform): PlatformRecord {
  const pr = state.pullRequest;
  const { runId, runAttempt } = runIdentity(state.links.run);
  // While the hosted preview is deploying the central Viewer's download-and-drop page would read as the report, so no link.
  const deploying = state.phase === "ready" && !state.links.preview && state.links.deploying === true;
  const report = state.phase === "ready" ? (state.links.preview?.open ?? (deploying ? undefined : state.links.viewer?.open)) : undefined;
  // A republished review keeps the duration of the run that produced it.
  const reviewedAt = state.phase === "ready" && state.review ? Date.parse(state.review.createdAt) : NaN;
  const record: PlatformRecord = {
    v: 1, platform: platform ?? state.build?.platform ?? "ios", runId, runAttempt, headSha: pr.head.sha, baseSha: pr.base.sha,
    startedAt: state.startedAt, updatedAt: Number.isFinite(reviewedAt) ? reviewedAt : state.updatedAt, phase: state.phase,
    links: { run: state.links.run, artifacts: state.links.artifacts, config: state.links.config, ...(report ? { report } : {}),
      ...(state.phase === "ready" && state.links.download ? { download: state.links.download } : {}),
      ...(state.phase === "ready" && state.links.preview ? { expiresAt: state.links.preview.expiresAt } : {}),
      ...(deploying ? { deploying: true } : {}) },
  };
  const device = reviewDevice(state);
  if (device) record.device = device;
  if (state.build?.appName || state.build?.appVersion || state.build?.appBuildNumber) {
    record.app = { ...(state.build.appName ? { name: state.build.appName } : {}), ...(state.build.appVersion ? { version: state.build.appVersion } : {}),
      ...(state.build.appBuildNumber ? { build: state.build.appBuildNumber } : {}) };
  }
  if (state.capture) record.capture = { planned: { ...state.capture.planned }, done: { ...state.capture.done }, baseFromCache: state.capture.baseFromCache, ...(state.capture.current ? { current: state.capture.current } : {}) };
  const health = captureHealth(state);
  if (health && (state.phase === "ready" || state.phase === "failed")) record.health = { base: { ...health.base }, head: { ...health.head } };
  if (state.phase === "ready") {
    const validation: NonNullable<PlatformRecord["validation"]> = {};
    const evidence = state.evidence;
    if (evidence?.visual) validation.visual = { compared: evidence.visual.compared, threshold: evidence.visual.threshold, failed: evidence.visual.failed,
      ...(evidence.comparison ? { eligible: evidence.comparison.eligible, skipped: evidence.comparison.skipped } : {}) };
    if (evidence?.accessibility) validation.accessibility = { compared: evidence.accessibility.compared, described: evidence.accessibility.described, failed: evidence.accessibility.failed };
    if (state.inventory) validation.routes = state.inventory.routes;
    record.validation = validation;
  }
  if (state.review) {
    const evidenceBased = state.review.surfaces.some(surface => surface.review);
    record.changes = [];
    for (const surface of state.review.surfaces) {
      if ((surface.head ?? surface.base)?.kind === "redirect") continue;
      const group = groupOf(surface, evidenceBased);
      if (group === "unlisted") continue;
      const scheme = schemeOf(surface.id);
      record.changes.push({ id: surface.id, route: routeOf(surface), group, description: descriptionOf(surface, group), ...(scheme ? { scheme } : {}) });
    }
    record.context = contextLines(state.review).filter(line => line.length);
    const diagnostics = [...(state.evidence?.diagnostics ?? [])];
    for (const surface of state.review.surfaces) {
      for (const side of ["base", "head"] as const) {
        const outcome = surface[`${side}Outcome`];
        if (!outcome || (outcome.status === "captured" && outcome.landing === "verified") || diagnostics.some(item => item.surfaceId === surface.id && item.side === side)) continue;
        diagnostics.push({ surfaceId: surface.id, side, code: outcome.error?.code ?? (outcome.status === "captured" ? "CAPTURE_LANDING_UNVERIFIED" : "CAPTURE_UNAVAILABLE"),
          stage: outcome.error?.stage ?? "capture", message: outcome.error?.message ?? outcome.reason ?? (outcome.status === "captured" ? "Destination route was not verified." : `Capture ${outcome.status}.`),
          nextAction: outcome.error?.nextAction ?? "Check this side's capture diagnostics, correct the route configuration or capture failure, and rerun capture.", retryable: outcome.error?.retryable ?? false });
      }
    }
    if (diagnostics.length) {
      record.diagnostics = diagnostics.slice(0, 20).map(diagnostic => {
        const surface = state.review!.surfaces.find(surface => surface.id === diagnostic.surfaceId);
        return { ...(diagnostic.side ? { side: diagnostic.side } : {}), route: surface ? routeOf(surface) : diagnostic.surfaceId, code: diagnostic.code, message: diagnostic.message, nextAction: diagnostic.nextAction };
      });
      record.diagnosticCount = diagnostics.length;
    }
  }
  if (state.failure) record.failure = { step: state.failure.step, message: state.failure.message };
  if (state.superseded) record.superseded = true;
  return record;
}

const commitLink = (repository: string, sha: string) => link(inlineText(sha.slice(0, 8), 8), `https://github.com/${repository.split("/").map(encodeURIComponent).join("/")}/commit/${encodeURIComponent(sha)}`);

function surfaceLink(report: string, id: string): string | undefined {
  if (!SURFACE_ID.test(id)) return undefined;
  const url = new URL(report);
  url.searchParams.set("view", "compare"); url.searchParams.set("screen", id);
  return url.href;
}

function resultCell(record: PlatformRecord): string {
  switch (record.phase) {
    case "pending": return "⏳ starting";
    case "capturing": {
      const capture = record.capture;
      if (!capture) return "⏳ capturing";
      const side = capture.current ?? (capture.done.head > 0 || capture.baseFromCache ? "head" : "base");
      return `⏳ capturing ${side} ${capture.done[side]}/${capture.planned[side]}${capture.baseFromCache && side === "head" ? " · base reused" : ""}`;
    }
    case "failed": return `🟥 failed · ${inlineText(record.failure?.step ?? "capture", 48)}`;
    case "ready": {
      const unavailable = record.health ? record.health.base.unavailable + record.health.head.unavailable : 0;
      const unverified = record.health ? record.health.base.unverified + record.health.head.unverified : 0;
      const failed = (record.validation?.visual?.failed ?? 0) + (record.validation?.accessibility?.failed ?? 0);
      const icon = unavailable || unverified || failed ? "🟨" : "🟩";
      return [`${icon} ${changeCountText(record.changes?.map(change => change.group) ?? [])}`, unavailable ? `${unavailable} unavailable` : undefined, unverified ? `${unverified} unattributed` : undefined,
        failed ? `${failed} comparison${failed === 1 ? "" : "s"} failed` : undefined, duration(record.startedAt, record.updatedAt)].filter(Boolean).join(" · ");
    }
  }
}

/** The report link alone; the workflow run and the report zip sit in the footer, where someone debugging looks for them. */
function reportCell(record: PlatformRecord): string {
  const run = link("run", record.links.run);
  if (record.phase === "failed") return `${run} · ${link("evidence", record.links.artifacts)}`;
  if (record.phase !== "ready") return run;
  return record.links.report ? link(record.links.report.includes(".expo.app/") ? "Open" : "Viewer", record.links.report) : record.links.deploying ? "deploying…" : run;
}

/** "Workflow iOS run · zip; Android run · zip" for the ready platforms, with the platform named only when there are several. */
function artifactLinks(records: PlatformRecord[]): string | undefined {
  const ready = records.filter(record => record.phase === "ready");
  if (!ready.length) return undefined;
  const parts = ready.map(record => {
    const links = [link("run", record.links.run), record.links.download ? link("zip", record.links.download) : undefined].filter(Boolean).join(" · ");
    return ready.length > 1 ? `${PLATFORM_LABELS[record.platform]} ${links}` : links;
  });
  return `Workflow ${parts.join("; ")}`;
}

function deviceCell(record: PlatformRecord): string {
  const parts = [record.device ? inlineText(record.device, 80) : undefined,
    record.app?.version ? inlineText(`${record.app.name ? `${record.app.name} ` : ""}${record.app.version}${record.app.build ? ` (${record.app.build})` : ""}`, 80) : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

type ChangeRow = { id: string; route: string; scheme?: string; group: ReviewGroup; description: string; perPlatform: Partial<Record<CommentPlatform, { group: ReviewGroup; href?: string }>> };

function changeRows(records: PlatformRecord[]): Map<ReviewGroup, ChangeRow[]> {
  const rows = new Map<string, ChangeRow>();
  for (const record of records) {
    if (record.phase !== "ready") continue;
    for (const change of record.changes ?? []) {
      const href = record.links.report ? surfaceLink(record.links.report, change.id) : undefined;
      const row = rows.get(change.id) ?? { id: change.id, route: change.route, group: change.group, description: change.description, perPlatform: {}, ...(change.scheme ? { scheme: change.scheme } : {}) };
      row.perPlatform[record.platform] = { group: change.group, ...(href ? { href } : {}) };
      rows.set(change.id, row);
    }
  }
  const groups = new Map<ReviewGroup, ChangeRow[]>();
  for (const row of rows.values()) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  return groups;
}

function renderChangeRow(row: ChangeRow, platforms: CommentPlatform[]): string {
  const where = platforms.flatMap(platform => {
    const entry = row.perPlatform[platform];
    if (!entry) return [];
    const label = PLATFORM_LABELS[platform] + (entry.group !== row.group ? ` (${GROUP_LABEL[entry.group].replace(/^\S+ /, "").toLowerCase()})` : "");
    return [entry.href ? link(label, entry.href) : label];
  });
  const route = `\`${plainText(row.route, MAX_ROUTE_LENGTH).replace(/`/g, "")}\`${row.scheme ? ` (${inlineText(row.scheme, 20)})` : ""}`;
  return `- ${route} — ${inlineText(row.description, MAX_DESCRIPTION_LENGTH)}${where.length ? ` · ${where.join(" · ")}` : ""}`;
}

function changesSection(records: PlatformRecord[], platforms: CommentPlatform[], rowCap: number): string[] {
  const ready = records.filter(record => record.phase === "ready");
  if (!ready.length) return [];
  const groups = changeRows(ready);
  const lines: string[] = [];
  const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
  lines.push(`**Changes** · ${plural(total, "screen")}${platforms.length > 1 && ready.length > 1 ? " · a screen is listed once, with a link per platform" : ""}`, "");
  if (total === 0) lines.push("No screen changed on the reviewed platforms.", "");
  for (const group of GROUP_ORDER) {
    const rows = groups.get(group) ?? [];
    if (!rows.length) continue;
    const shown = rows.slice(0, rowCap);
    const content = ["", ...(group === "accessibility-only" ? ["Before and After look the same. What screen readers and voice control read changed.", ""] : []),
      ...shown.map(row => renderChangeRow(row, platforms))];
    if (rows.length > shown.length) {
      const report = ready.find(record => record.links.report)?.links.report;
      content.push(`- ${rows.length - shown.length} more${report ? ` — ${link("Explore report", report)}` : ""}`);
    }
    content.push("");
    lines.push(...details(`${GROUP_LABEL[group]} (${rows.length})`, content));
  }
  const seen = new Set<string>();
  for (const record of ready) for (const line of record.context ?? []) {
    if (seen.has(line)) continue;
    seen.add(line);
    const everywhere = ready.every(other => other.context?.includes(line));
    lines.push(everywhere ? line : `${PLATFORM_LABELS[record.platform]} · ${line}`, "");
  }
  return lines;
}

/**
 * The heading carries the report links: on a phone the table's last column is clipped, and the
 * commits it reviews are a subtitle under it. A platform still capturing adds its link when it is ready.
 */
function heading(records: PlatformRecord[]): string {
  const ready = records.filter(record => record.phase === "ready" && record.links.report);
  if (!ready.length) {
    return records.some(record => record.phase === "ready" && record.links.deploying) ? "### Explore review · report deploying, not ready yet" : "### Explore review";
  }
  const links = ready.length === 1 ? [link("Open report", ready[0]!.links.report!)]
    : ready.map(record => link(`${PLATFORM_LABELS[record.platform]} report`, record.links.report!));
  return `### Explore review · ${links.join(" · ")}`;
}

function validationCell(record: PlatformRecord, check: "capture" | "routes" | "visual" | "accessibility" | "inventory"): string {
  if (record.phase === "pending" || record.phase === "capturing") return "⏳";
  if (record.phase === "failed") {
    if (check !== "capture") return "—";
    const capture = record.capture;
    return capture ? `🟥 ${capture.done.base + capture.done.head}/${capture.planned.base + capture.planned.head} surfaces` : "🟥 not started";
  }
  const health = record.health;
  switch (check) {
    case "capture": {
      const planned = health ? health.base.planned + health.head.planned : (record.capture?.planned.base ?? 0) + (record.capture?.planned.head ?? 0);
      const done = health ? health.base.captured + health.head.captured : (record.capture?.done.base ?? 0) + (record.capture?.done.head ?? 0);
      const cache = record.capture?.baseFromCache ? " · base cache reused" : "";
      return done < planned ? `🟨 ${done}/${planned} surfaces · ${planned - done} unavailable${cache}` : `🟩 ${done}/${planned} surfaces${cache}`;
    }
    case "routes": {
      if (!health) return "—";
      const verified = health.base.verified + health.head.verified, planned = health.base.planned + health.head.planned;
      const unverified = health.base.unverified + health.head.unverified, unavailable = health.base.unavailable + health.head.unavailable;
      return `${verified === planned ? "🟩" : "🟨"} ${verified}/${planned} verified${unverified ? ` · ${unverified} unattributed` : ""}${unavailable ? ` · ${unavailable} unavailable` : ""}`;
    }
    case "visual": {
      const v = record.validation?.visual;
      if (!v) return "🟨 not run";
      const mark = v.compared === 0 || v.failed > 0 || v.skipped ? "🟨" : "🟩";
      return `${mark} ${v.compared} compared · threshold ${v.threshold}${v.failed ? ` · ${v.failed} failed` : ""}${v.skipped ? ` · ${v.skipped} skipped` : ""}`;
    }
    case "accessibility": {
      const a = record.validation?.accessibility;
      if (!a) return "🟨 not run";
      return `${a.compared === 0 || a.failed > 0 ? "🟨" : "🟩"} ${a.compared} compared · ${plural(a.described, "description")}${a.failed ? ` · ${a.failed} failed` : ""}`;
    }
    case "inventory": return record.validation?.routes !== undefined ? `🟩 ${plural(record.validation.routes, "route")}` : "🟩 analyzed";
  }
}

function validationSummary(record: PlatformRecord): string {
  switch (record.phase) {
    case "failed": return "🟥 failed";
    case "ready": {
      const health = record.health;
      if (!health) return "🟩 reviewed";
      const captured = health.base.captured + health.head.captured, planned = health.base.planned + health.head.planned;
      return `${captured < planned ? "🟨" : "🟩"} ${captured}/${planned} captured`;
    }
    default: return "⏳ in progress";
  }
}

function validationSection(records: PlatformRecord[], platforms: CommentPlatform[]): string[] {
  if (!records.some(record => record.phase === "ready" || record.phase === "failed")) return [];
  const byPlatform = platforms.map(platform => records.find(record => record.platform === platform)!);
  const summary = `Validation · ${byPlatform.map(record => `${PLATFORM_LABELS[record.platform]} ${validationSummary(record)}`).join(" · ")}`;
  const header = platforms.length > 1 ? `| Check | ${byPlatform.map(record => PLATFORM_LABELS[record.platform]).join(" | ")} |` : `| Check | ${PLATFORM_LABELS[byPlatform[0]!.platform]} |`;
  const checks: [string, Parameters<typeof validationCell>[1]][] = [["Capture", "capture"], ["Route verification", "routes"], ["Visual comparison", "visual"], ["Accessibility comparison", "accessibility"], ["Source inventory", "inventory"]];
  const content = ["", header, `|---|${byPlatform.map(() => "---").join("|")}|`,
    ...checks.map(([label, check]) => `| ${label} | ${byPlatform.map(record => validationCell(record, check)).join(" | ")} |`), ""];
  for (const record of byPlatform) {
    if (record.phase === "failed" && record.failure) {
      content.push(`**${PLATFORM_LABELS[record.platform]} failed** — ${inlineText(record.failure.message, 1200)} ${link("Open the failed run", record.links.run)} · ${link("Evidence artifact", record.links.artifacts)}`, "");
    }
    if (record.phase !== "ready") continue;
    const health = record.health;
    const gaps = health ? health.base.unavailable + health.base.unverified + health.head.unavailable + health.head.unverified : 0;
    if (!gaps && !record.diagnostics?.length) continue;
    const sideLine = (side: "base" | "head") => { const h = health![side]; return `${side} ${h.verified}/${h.planned} verified${h.unverified ? ` · ${h.unverified} unattributed` : ""}${h.unavailable ? ` · ${h.unavailable} unavailable` : ""}`; };
    content.push(health ? `**${PLATFORM_LABELS[record.platform]}** · ${sideLine("base")} · ${sideLine("head")}` : `**${PLATFORM_LABELS[record.platform]}**`, "");
    for (const diagnostic of record.diagnostics ?? []) {
      content.push(`- ${diagnostic.side ? `${diagnostic.side === "base" ? "Base" : "Head"} · ` : ""}${inlineText(diagnostic.route, MAX_ROUTE_LENGTH)} · ${inlineText(diagnostic.code, 80)}: ${inlineText(diagnostic.message, 160)} Next action: ${inlineText(diagnostic.nextAction, 240)}`);
    }
    const more = (record.diagnosticCount ?? 0) - (record.diagnostics?.length ?? 0);
    if (more > 0) content.push(`- ${more} more — ${link("View run", record.links.run)}`);
    if (record.diagnostics?.length) content.push("");
  }
  return details(summary, content);
}

function historySection(repository: string, history: HistoryEntry[]): string[] {
  if (!history.length) return [];
  const content = ["", ...history.map(entry => {
    const platforms = PLATFORM_ORDER.flatMap(platform => {
      const item = entry.platforms[platform];
      if (!item) return [];
      const links = [item.report ? link("report", item.report) : undefined, link("run", item.run)].filter(Boolean).join(" · ");
      return [`${PLATFORM_LABELS[platform]} ${inlineText(item.summary, 120)} (${links})`];
    });
    return `- ${commitLink(repository, entry.headSha)} · ${platforms.join(" · ")}`;
  }), ""];
  return details(`Previous runs (${history.length})`, content);
}

/** `<!-- expo-explore-deployments:a--1,b--2 -->`: every hosted preview the comment links, for anyone cleaning them up by hand. */
const DEPLOYMENT_MARKER = /^<!-- expo-explore-deployments:([a-z0-9-]+(?:,[a-z0-9-]+)*) -->$/m;
export function existingDeploymentMarker(body: string | undefined): string | undefined {
  return body?.match(DEPLOYMENT_MARKER)?.[0];
}
function deploymentOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const host = new URL(url).hostname;
  const deployment = host.endsWith(".expo.app") ? host.slice(0, -".expo.app".length) : "";
  return /^[a-z0-9-]+--[a-z0-9]{1,32}$/.test(deployment) ? deployment : undefined;
}
function deploymentMarkerOf(records: CommentRecords): string | undefined {
  const names = new Set<string>();
  for (const record of Object.values(records.current)) { const name = deploymentOf(record?.links.report); if (name) names.add(name); }
  for (const entry of records.history) for (const item of Object.values(entry.platforms)) { const name = deploymentOf(item?.report); if (name) names.add(name); }
  return names.size ? `<!-- expo-explore-deployments:${[...names].sort().join(",")} -->` : undefined;
}

/** The whole comment from its records: hidden lines first, then one review for every platform of the current run. */
export function renderCommentRecords(records: CommentRecords, existing?: string, budget = PUBLIC_COMMENT_BODY_BUDGET): string {
  const current = PLATFORM_ORDER.flatMap(platform => records.current[platform] ? [records.current[platform]!] : []);
  const platforms = current.map(record => record.platform);
  const hidden = [CI_COMMENT_MARKER, ...[deploymentMarkerOf(records)].filter((line): line is string => Boolean(line)),
    ...current.map(recordLine), ...[historyLine(records.history)].filter((line): line is string => Boolean(line))];
  if (!current.length) return [...hidden, "### Explore review", "", ...(records.history.some(entry => Object.values(entry.platforms).some(item => item?.superseded)) ? [SUPERSEDED_NOTE, ""] : []),
    ...historySection("", records.history)].join("\n");
  const first = current[0]!;
  const repository = repositoryOf(first.links.run);
  const render = (rowCap: number): string => {
    const lines: string[] = [...hidden, heading(current), "",
      `<sub>base ${commitLink(repository, first.baseSha)} → ${commitLink(repository, first.headSha)}</sub>`, ""];
    if (first.superseded) lines.push(SUPERSEDED_NOTE, "");
    lines.push(`| | Device | Result | Report |`, `|---|---|---|---|`,
      ...current.map(record => `| ${PLATFORM_LABELS[record.platform]} | ${deviceCell(record)} | ${resultCell(record)} | ${reportCell(record)} |`), "");
    lines.push(...changesSection(current, platforms, rowCap));
    lines.push(...validationSection(current, platforms));
    lines.push(...historySection(repository, records.history));
    const expiries = current.filter(record => record.phase === "ready" && record.links.expiresAt !== undefined).map(record => record.links.expiresAt);
    const footer: string[] = [];
    if (expiries.length) footer.push(expiries.some(at => at === null) ? "Preview links work for anyone who has them until the deployment is deleted."
      : `Preview links work until ${previewExpiry(Math.min(...expiries.filter((at): at is number => at !== null)))} for anyone who has them.`);
    footer.push(`Managed via ${link("`" + plainText(configPathOf(first.links.config), 120).replace(/`/g, "") + "`", first.links.config)}`);
    const artifacts = artifactLinks(current);
    if (artifacts) footer.push(artifacts);
    lines.push(footer.join(" · "));
    return lines.join("\n");
  };
  let rowCap = MAX_ROWS_PER_GROUP;
  let body = render(rowCap);
  while (body.length > budget && rowCap > 1) { rowCap = Math.max(1, Math.floor(rowCap / 2)); body = render(rowCap); }
  return body;
}

function repositoryOf(run: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\//.exec(run);
  return match ? `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}` : "";
}
function configPathOf(config: string): string {
  const match = /\/blob\/[0-9a-f]{40}\/(.+)$/.exec(config);
  return match ? decodeURIComponent(match[1]!) : "config";
}

/** Render the sticky pull-request comment for any phase of a public review run, folding this writer into the existing comment's records. */
export function renderPublicComment(state: PublicCommentState, existing?: string, platform?: CommentPlatform): string {
  const pr = state.pullRequest;
  if (pr.origin === "local") return renderLocalText(state);
  return renderCommentRecords(foldRecord(readCommentRecords(existing), platformRecordOf(state, platform)), existing);
}

/** The sticky-comment merge for a writer: every writer re-renders the whole comment from the records it carries plus its own. */
export function platformSectionMerge(state: PublicCommentState, platform: CommentPlatform | undefined): { merge: (existing: string | undefined) => string } {
  return { merge: existing => renderPublicComment(state, existing, platform) };
}

/** "iPhone 17 Pro 26.0 · light + dark": the device model and OS version the report's head capture ran on, and its appearances when it captured several. */
export function reviewDevice(state: { runtime?: Pick<SimulatorRuntimeMetadata, "deviceModel" | "osVersion" | "colorSchemes"> | undefined }): string {
  const device = [state.runtime?.deviceModel, state.runtime?.osVersion && state.runtime.osVersion !== "unknown" ? state.runtime.osVersion : undefined].filter(Boolean).join(" ");
  const schemes = state.runtime?.colorSchemes;
  return schemes && schemes.length > 1 ? [device, schemes.join(" + ")].filter(Boolean).join(" · ") : device;
}

/** Each changed surface's group, as the comment lists it: what a summary of the review counts. */
export function reviewChanges(review: PublicReview): Map<string, ChangeGroup> {
  const evidenceBased = review.surfaces.some(surface => surface.review);
  const changes = new Map<string, ChangeGroup>();
  for (const surface of review.surfaces) {
    if ((surface.head ?? surface.base)?.kind === "redirect") continue;
    const group = groupOf(surface, evidenceBased);
    if (group !== "unlisted") changes.set(surface.id, group);
  }
  return changes;
}

/** Surfaces the review calls changed: a verdict other than unchanged or variant. Undefined before the review exists. */
export function reviewChangeCount(state: Pick<PublicCommentState, "review">): number | undefined {
  return state.review?.surfaces.filter(surface => surface.review && surface.review.status !== "unchanged" && surface.review.status !== "variant").length;
}

export { recordSummary, readCommentRecords };

function renderLocalText(state: PublicCommentState): string {
  const pr = state.pullRequest as Extract<ReviewPresentation, { origin: "local" }>;
  const counts = state.capture;
  return ["# Local Explore CI review", "", `Run: ${pr.runId}`, `Status: ${state.phase}`,
    `Mode: ${state.executionMode} / ${state.mode}`, `Base: ${pr.base.ref} (${pr.base.sha})`,
    `Head: ${pr.head.ref} (${pr.head.sha})`, "",
    ...(counts ? [`Captures: base ${counts.done.base}/${counts.planned.base}; head ${counts.done.head}/${counts.planned.head}.`, ""] : []),
    ...(state.failure ? [inlineText(state.failure.message, 2000), ""] : []),
    ...(counts && counts.planned.base + counts.planned.head === 0 ? ["No captures selected; visual comparison was not required.", ""] : []),
    ...(state.review?.surfaces.filter(s => (s.status === "added" || s.status === "removed"
      || s.baseOutcome || s.headOutcome || s.review) && s.review?.status !== "unchanged" && s.review?.status !== "variant").map(s =>
      `- ${inlineText((s.head ?? s.base)?.route ?? s.id, 160)}: ${s.review?.status ?? (s.status === "added" || s.status === "removed" ? s.status : "not compared")}${s.note ? ` — ${inlineText(s.note.text, 500)}` : ""}`) ?? []),
    "", ...(state.review ? contextLines(state.review) : []), "Report: artifacts/report.zip", "Details: README.md, agent-mode-cost.md, issues.md", ""].join("\n");
}
