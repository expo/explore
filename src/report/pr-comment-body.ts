import type { PublicReview } from "../contracts/capture.js";
import type { RunTarget } from "../types.js";
import type { SimulatorRuntimeMetadata } from "../capture/run.js";
import { CI_COMMENT_MARKER } from "./pr-comment.js";
import { CHANGE_GROUPS, MAX_COMMENT_TARGETS, MAX_NAVIGATION_EDGES, MAX_NAVIGATION_NODES, changeCountText, compareTargets, defaultTargetLabel, foldRecord, strongerGroup, historyLine, orderedRecords, readCommentRecords, recordLabel, recordLine, recordSummary, recordTarget,
  type ChangeGroup, type CommentNavigation, type CommentTarget, type CommentRecords, type HistoryEntry, type NavigationGroup, type NavigationKind, type PlatformRecord } from "./pr-comment-record.js";
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
  /** The target this run captures; absent in states from before targets (then the target is build.platform). */
  target?: RunTarget;
  /** Every target the config captures, in config order, when more than one. */
  targets?: RunTarget[];
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
  /** report.comment.map: draw the map of the changed screens. */
  map?: true;
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

/**
 * A screen whose source changed and whose captures were both verified, but that has no verdict: the comparison did
 * not run or failed. Not a change, but not a screen that looks the same either, so the result says how many.
 */
function notComparedChange(surface: Surface): boolean {
  if (surface.status !== "modified" || (surface.head ?? surface.base)?.kind === "redirect") return false;
  const verified = (["base", "head"] as const).every(side => surface[`${side}Image`]
    && surface[`${side}Outcome`]?.status === "captured" && surface[`${side}Outcome`]?.landing === "verified");
  return verified && (!surface.review || surface.visual?.reason === "diff-failed");
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
  const appWide = review.surfaces.filter(surface => surface.sourceScope === "app-wide" && !surface.excluded);
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

/**
 * The position of a target in config.yaml, recorded only when the run's targets are not the per-platform ios and
 * android (in that order, with their default labels): those render in the order and with the labels they always had.
 */
function targetOrder(targets: PublicCommentState["targets"], id: CommentTarget): number | undefined {
  if (!targets?.length) return undefined;
  const ids = targets.map(target => target.id).join(",");
  const perPlatform = ["ios", "android", "ios,android"].includes(ids) && targets.every(target => target.id === target.platform && target.label === defaultTargetLabel(target.id));
  const index = targets.findIndex(target => target.id === id);
  return perPlatform || index < 0 || index >= MAX_COMMENT_TARGETS ? undefined : index;
}

/**
 * This writer's state as the compact record the comment is rendered from, keyed by its target: the state's own, else
 * `target` (a writer that knows only the id, such as the failure job), else the build's platform (states from before targets).
 */
export function platformRecordOf(state: PublicCommentState, target?: CommentTarget): PlatformRecord {
  const pr = state.pullRequest;
  const id = state.target?.id ?? target ?? state.build?.platform ?? "ios";
  const platform = state.target?.platform ?? state.build?.platform ?? (id === "android" ? "android" : "ios");
  const label = state.target?.label && state.target.label !== defaultTargetLabel(id) ? state.target.label : undefined;
  const order = targetOrder(state.targets, id);
  const { runId, runAttempt } = runIdentity(state.links.run);
  // While the hosted preview is deploying the central Viewer's download-and-drop page would read as the report, so no link.
  const deploying = state.phase === "ready" && !state.links.preview && state.links.deploying === true;
  const report = state.phase === "ready" ? (state.links.preview?.open ?? (deploying ? undefined : state.links.viewer?.open)) : undefined;
  // A republished review keeps the duration of the run that produced it.
  const reviewedAt = state.phase === "ready" && state.review ? Date.parse(state.review.createdAt) : NaN;
  const record: PlatformRecord = {
    v: 1, platform, ...(id !== platform ? { target: id } : {}), ...(label ? { label } : {}), ...(order !== undefined ? { order } : {}), runId, runAttempt, headSha: pr.head.sha, baseSha: pr.base.sha,
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
    const navigation = state.map ? navigationOf(state.review, new Map(record.changes.map(change => [change.id, change.group]))) : undefined;
    if (navigation) record.navigation = navigation;
    const notCompared = state.review.surfaces.filter(notComparedChange).length;
    if (notCompared) record.notCompared = notCompared;
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

const NAVIGATION_GROUPS: NavigationGroup[] = ["added", "removed", "modified"];
const NAVIGATION_KINDS: NavigationKind[] = ["push", "replace", "navigate", "dismissTo", "redirect"];

/** "/p/[d]" for the route file app/(tabs)/(patterns)/p/[d].tsx: the route without its groups, which a dynamic route's variants share. */
function routePattern(route: NonNullable<Surface["head"]>): string {
  const path = `/${route.logicalPath.replace(/^\/+/, "")}`.split("/").filter(segment => !/^\(.*\)$/.test(segment)).join("/");
  return plainText(path.replace(/\/index$/, ""), MAX_ROUTE_LENGTH) || "/";
}

/**
 * The map the comment draws: every route added, removed or changed visually (a screen whose source changed but looks
 * the same is not one), the routes one step before them, and the transitions among those. A route's appearances and
 * variants are one node. Switching tabs reaches every tab from every other, so tab transitions are not edges: the
 * routes a tab switch shows are grouped instead. Removed routes and the transitions into them come from the base.
 */
function navigationOf(review: PublicReview, groups: Map<string, ChangeGroup>): CommentNavigation | undefined {
  if (!review.navigation) return undefined;
  const keyOf = new Map<string, string>();
  const groupOf = new Map<string, NavigationGroup>();
  for (const surface of review.surfaces) {
    const route = surface.head ?? surface.base;
    if (!route || route.kind === "redirect") continue;
    const key = routePattern(route);
    keyOf.set(surface.id.replace(/@(light|dark)$/, ""), key);
    const group = groups.get(surface.id);
    if (group !== "added" && group !== "removed" && group !== "modified") continue;
    const current = groupOf.get(key);
    if (!current || NAVIGATION_GROUPS.indexOf(group) < NAVIGATION_GROUPS.indexOf(current)) groupOf.set(key, group);
  }
  if (!groupOf.size || groupOf.size > MAX_NAVIGATION_NODES) return undefined;
  const tabs = new Set<string>();
  const links = new Map<string, { from: string; to: string; kinds: Set<NavigationKind>; base: boolean }>();
  const add = (edge: NonNullable<PublicReview["navigation"]>["head"]["edges"][number], base: boolean) => {
    const from = keyOf.get(edge.from), to = keyOf.get(edge.to);
    if (!from || !to || from === to) return;
    if (edge.kind === "tab") { tabs.add(to); return; }
    const link = links.get(`${from}\n${to}`) ?? { from, to, kinds: new Set(), base };
    link.kinds.add(edge.kind);
    links.set(`${from}\n${to}`, link);
  };
  for (const edge of review.navigation.head.edges) add(edge, false);
  for (const edge of review.navigation.base.edges) if (groupOf.get(keyOf.get(edge.to) ?? "") === "removed") add(edge, true);
  // The routes that lead to the most changed ones first, while the map has room.
  const leads = new Map<string, number>();
  for (const link of links.values()) if (groupOf.has(link.to) && !groupOf.has(link.from)) leads.set(link.from, (leads.get(link.from) ?? 0) + 1);
  const before = [...leads].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : 1)).slice(0, MAX_NAVIGATION_NODES - groupOf.size).map(([key]) => key);
  const keys = [...groupOf.keys(), ...before].sort();
  const index = new Map(keys.map((key, position) => [key, position]));
  const edges = [...links.values()].filter(link => index.has(link.from) && index.has(link.to))
    .sort((a, b) => Number(groupOf.has(b.to)) - Number(groupOf.has(a.to)) || index.get(a.from)! - index.get(b.from)! || index.get(a.to)! - index.get(b.to)!)
    .slice(0, MAX_NAVIGATION_EDGES)
    .sort((a, b) => index.get(a.from)! - index.get(b.from)! || index.get(a.to)! - index.get(b.to)!)
    .map(link => ({ from: index.get(link.from)!, to: index.get(link.to)!, kinds: NAVIGATION_KINDS.filter(kind => link.kinds.has(kind)), ...(link.base ? { base: true as const } : {}) }));
  if (!edges.length) return undefined;
  return { nodes: keys.map(key => ({ route: key, ...(groupOf.has(key) ? { group: groupOf.get(key)! } : {}), ...(tabs.has(key) ? { tab: true as const } : {}) })), edges };
}

/** A route as a quoted Mermaid label, with Mermaid's entity codes for what would end the label, the line or the fence. */
function mermaidLabel(route: string): string {
  return `"${plainText(route, MAX_ROUTE_LENGTH).replace(/#/g, "#35;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/`/g, "#96;")}"`;
}

/** Outlines, not fills: GitHub draws Mermaid in the reader's theme, and a fixed fill is wrong in one of them. */
const MAP_CLASSES: Record<NavigationGroup, string> = {
  added: "stroke:#1a7f37,stroke-width:3px",
  modified: "stroke:#bc4c00,stroke-width:3px",
  removed: "stroke:#cf222e,stroke-width:2px,stroke-dasharray:5 4",
};

function mermaidMap(navigation: CommentNavigation): string[] {
  const node = (index: number) => `n${index}[${mermaidLabel(navigation.nodes[index]!.route)}]`;
  const tabs = navigation.nodes.flatMap((entry, index) => entry.tab ? [index] : []);
  const lines = ["```mermaid", "flowchart LR"];
  if (tabs.length) lines.push(`  subgraph tabs["Tabs"]`, ...tabs.map(index => `    ${node(index)}`), "  end");
  lines.push(...navigation.nodes.flatMap((entry, index) => entry.tab ? [] : [`  ${node(index)}`]));
  lines.push(...navigation.edges.map(edge => `  n${edge.from} ${edge.base ? "-.->" : "-->"}|${edge.kinds.join(", ")}| n${edge.to}`));
  for (const group of ["added", "modified", "removed"] as const) {
    const members = navigation.nodes.flatMap((entry, index) => entry.group === group ? [`n${index}`] : []);
    if (members.length) lines.push(`  classDef ${group} ${MAP_CLASSES[group]}`, `  class ${members.join(",")} ${group}`);
  }
  return [...lines, "```"];
}

/** One collapsed map per distinct navigation: targets with the same routes share one, named when the targets' maps differ. */
function mapSection(ready: PlatformRecord[]): string[] {
  const maps = new Map<string, { navigation: CommentNavigation; records: PlatformRecord[] }>();
  for (const record of ready) {
    if (!record.navigation) continue;
    const key = JSON.stringify(record.navigation);
    maps.set(key, { navigation: record.navigation, records: [...(maps.get(key)?.records ?? []), record] });
  }
  return [...maps.values()].flatMap(({ navigation, records }) => {
    const named = maps.size > 1 || records.length < ready.length ? `${records.map(labelOf).join(" · ")} · ` : "";
    return details(`${named}Map (${plural(navigation.nodes.length, "screen")})`, ["", ...mermaidMap(navigation), "",
      "Outlined: green added, orange changed, red dashed removed; the others lead to them. Tabs groups the screens a tab switch shows.", ""]);
  });
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
      const notCompared = record.notCompared ?? 0;
      const icon = unavailable || unverified || failed || notCompared ? "🟨" : "🟩";
      return [`${icon} ${changeCountText(record.changes?.map(change => change.group) ?? [])}`, notCompared ? `${notCompared} not compared` : undefined, unavailable ? `${unavailable} unavailable` : undefined, unverified ? `${unverified} unattributed` : undefined,
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

/** A target's label as Markdown text. */
const labelOf = (record: PlatformRecord) => inlineText(recordLabel(record), 80);

/** "platform" for the per-platform targets of a config without targets, "device" once a config names its own. */
function targetNoun(records: PlatformRecord[]): "platform" | "device" {
  return records.every(record => !record.target && record.label === undefined) ? "platform" : "device";
}

/** "Workflow iOS run · zip; Android run · zip" for the ready targets, with the target named only when there are several. */
function artifactLinks(records: PlatformRecord[]): string | undefined {
  const ready = records.filter(record => record.phase === "ready");
  if (!ready.length) return undefined;
  const parts = ready.map(record => {
    const links = [link("run", record.links.run), record.links.download ? link("zip", record.links.download) : undefined].filter(Boolean).join(" · ");
    return ready.length > 1 ? `${labelOf(record)} ${links}` : links;
  });
  return `Workflow ${parts.join("; ")}`;
}

function deviceCell(record: PlatformRecord): string {
  const parts = [record.device ? inlineText(record.device, 80) : undefined,
    record.app?.version ? inlineText(`${record.app.name ? `${record.app.name} ` : ""}${record.app.version}${record.app.build ? ` (${record.app.build})` : ""}`, 80) : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

type ChangeRow = { id: string; route: string; scheme?: string; group: ReviewGroup; description: string; perTarget: Partial<Record<CommentTarget, { group: ReviewGroup; href?: string }>> };

function changeRows(records: PlatformRecord[]): Map<ReviewGroup, ChangeRow[]> {
  const rows = new Map<string, ChangeRow>();
  for (const record of records) {
    if (record.phase !== "ready") continue;
    for (const change of record.changes ?? []) {
      const href = record.links.report ? surfaceLink(record.links.report, change.id) : undefined;
      const row = rows.get(change.id) ?? { id: change.id, route: change.route, group: change.group, description: change.description, perTarget: {}, ...(change.scheme ? { scheme: change.scheme } : {}) };
      // A screen accessibility-only on one target and visibly changed on another is listed as the visible change.
      if (strongerGroup(row.group, change.group) !== row.group) Object.assign(row, { group: change.group, description: change.description });
      row.perTarget[recordTarget(record)] = { group: change.group, ...(href ? { href } : {}) };
      rows.set(change.id, row);
    }
  }
  const groups = new Map<ReviewGroup, ChangeRow[]>();
  for (const row of rows.values()) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  return groups;
}

function renderChangeRow(row: ChangeRow, records: PlatformRecord[]): string {
  const where = records.flatMap(record => {
    const entry = row.perTarget[recordTarget(record)];
    if (!entry) return [];
    const label = labelOf(record) + (entry.group !== row.group ? ` (${GROUP_LABEL[entry.group].replace(/^\S+ /, "").toLowerCase()})` : "");
    return [entry.href ? link(label, entry.href) : label];
  });
  const route = `\`${plainText(row.route, MAX_ROUTE_LENGTH).replace(/`/g, "")}\`${row.scheme ? ` (${inlineText(row.scheme, 20)})` : ""}`;
  return `- ${route} — ${inlineText(row.description, MAX_DESCRIPTION_LENGTH)}${where.length ? ` · ${where.join(" · ")}` : ""}`;
}

function changesSection(records: PlatformRecord[], rowCap: number, withMap: boolean): string[] {
  const ready = records.filter(record => record.phase === "ready");
  if (!ready.length) return [];
  const groups = changeRows(ready);
  const lines: string[] = [];
  const noun = targetNoun(records);
  const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
  lines.push(`**Changes** · ${plural(total, "screen")}${records.length > 1 && ready.length > 1 ? ` · a screen is listed once, with a link per ${noun}` : ""}`, "");
  // With screens left uncompared, nothing changed only among the ones compared.
  if (total === 0) lines.push(ready.some(record => record.notCompared) ? `No compared screen changed on the reviewed ${noun}s.` : `No screen changed on the reviewed ${noun}s.`, "");
  for (const group of GROUP_ORDER) {
    const rows = groups.get(group) ?? [];
    if (!rows.length) continue;
    const shown = rows.slice(0, rowCap);
    const content = ["", ...(group === "accessibility-only" ? ["Before and After look the same. What screen readers and voice control read changed.", ""] : []),
      ...shown.map(row => renderChangeRow(row, records))];
    if (rows.length > shown.length) {
      const report = ready.find(record => record.links.report)?.links.report;
      content.push(`- ${rows.length - shown.length} more${report ? ` — ${link("Explore report", report)}` : ""}`);
    }
    content.push("");
    lines.push(...details(`${GROUP_LABEL[group]} (${rows.length})`, content));
  }
  if (withMap) lines.push(...mapSection(ready));
  const seen = new Set<string>();
  for (const record of ready) for (const line of record.context ?? []) {
    if (seen.has(line)) continue;
    seen.add(line);
    const everywhere = ready.every(other => other.context?.includes(line));
    lines.push(everywhere ? line : `${labelOf(record)} · ${line}`, "");
  }
  return lines;
}

/**
 * The heading carries the report links: on a phone the table's last column is clipped, and the
 * commits it reviews are a subtitle under it. A target still capturing adds its link when it is ready.
 */
function heading(records: PlatformRecord[]): string {
  const ready = records.filter(record => record.phase === "ready" && record.links.report);
  if (!ready.length) {
    return records.some(record => record.phase === "ready" && record.links.deploying) ? "### Explore review · report deploying, not ready yet" : "### Explore review";
  }
  const links = ready.length === 1 ? [link("Open report", ready[0]!.links.report!)]
    : ready.map(record => link(`${labelOf(record)} report`, record.links.report!));
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

function validationSection(byTarget: PlatformRecord[]): string[] {
  if (!byTarget.some(record => record.phase === "ready" || record.phase === "failed")) return [];
  const summary = `Validation · ${byTarget.map(record => `${labelOf(record)} ${validationSummary(record)}`).join(" · ")}`;
  const header = `| Check | ${byTarget.map(labelOf).join(" | ")} |`;
  const checks: [string, Parameters<typeof validationCell>[1]][] = [["Capture", "capture"], ["Route verification", "routes"], ["Visual comparison", "visual"], ["Accessibility comparison", "accessibility"], ["Source inventory", "inventory"]];
  const content = ["", header, `|---|${byTarget.map(() => "---").join("|")}|`,
    ...checks.map(([label, check]) => `| ${label} | ${byTarget.map(record => validationCell(record, check)).join(" | ")} |`), ""];
  for (const record of byTarget) {
    if (record.phase === "failed" && record.failure) {
      content.push(`**${labelOf(record)} failed** — ${inlineText(record.failure.message, 1200)} ${link("Open the failed run", record.links.run)} · ${link("Evidence artifact", record.links.artifacts)}`, "");
    }
    if (record.phase !== "ready") continue;
    const health = record.health;
    const gaps = health ? health.base.unavailable + health.base.unverified + health.head.unavailable + health.head.unverified : 0;
    if (!gaps && !record.diagnostics?.length) continue;
    const sideLine = (side: "base" | "head") => { const h = health![side]; return `${side} ${h.verified}/${h.planned} verified${h.unverified ? ` · ${h.unverified} unattributed` : ""}${h.unavailable ? ` · ${h.unavailable} unavailable` : ""}`; };
    content.push(health ? `**${labelOf(record)}** · ${sideLine("base")} · ${sideLine("head")}` : `**${labelOf(record)}**`, "");
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
    const targets = Object.keys(entry.platforms).map(id => ({ id, item: entry.platforms[id]! })).filter(({ item }) => Boolean(item))
      .sort((a, b) => compareTargets({ id: a.id, order: a.item.order }, { id: b.id, order: b.item.order })).map(({ id, item }) => {
        const links = [item.report ? link("report", item.report) : undefined, link("run", item.run)].filter(Boolean).join(" · ");
        return `${inlineText(item.label ?? defaultTargetLabel(id), 80)} ${inlineText(item.summary, 120)} (${links})`;
      });
    return `- ${commitLink(repository, entry.headSha)} · ${targets.join(" · ")}`;
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

/** The whole comment from its records: hidden lines first, then one review for every target of the current run, in config order. */
export function renderCommentRecords(records: CommentRecords, existing?: string, budget = PUBLIC_COMMENT_BODY_BUDGET): string {
  const current = orderedRecords(records);
  const hidden = [CI_COMMENT_MARKER, ...[deploymentMarkerOf(records)].filter((line): line is string => Boolean(line)),
    ...current.map(recordLine), ...[historyLine(records.history)].filter((line): line is string => Boolean(line))];
  if (!current.length) return [...hidden, "### Explore review", "", ...(records.history.some(entry => Object.values(entry.platforms).some(item => item?.superseded)) ? [SUPERSEDED_NOTE, ""] : []),
    ...historySection("", records.history)].join("\n");
  const first = current[0]!;
  const repository = repositoryOf(first.links.run);
  const render = (rowCap: number, withMap: boolean): string => {
    const lines: string[] = [...hidden, heading(current), "",
      `<sub>base ${commitLink(repository, first.baseSha)} → ${commitLink(repository, first.headSha)}</sub>`, ""];
    if (first.superseded) lines.push(SUPERSEDED_NOTE, "");
    lines.push(`| | Device | Result | Report |`, `|---|---|---|---|`,
      ...current.map(record => `| ${labelOf(record)} | ${deviceCell(record)} | ${resultCell(record)} | ${reportCell(record)} |`), "");
    lines.push(...changesSection(current, rowCap, withMap));
    lines.push(...validationSection(current));
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
  // The map goes first when the body is over budget, then the change lists shrink.
  let rowCap = MAX_ROWS_PER_GROUP;
  let body = render(rowCap, true);
  if (body.length > budget) body = render(rowCap, false);
  while (body.length > budget && rowCap > 1) { rowCap = Math.max(1, Math.floor(rowCap / 2)); body = render(rowCap, false); }
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

/**
 * Render the sticky pull-request comment for any phase of a public review run, folding this writer into the existing
 * comment's records. `target` keys the record when the state names no target of its own (see platformRecordOf).
 */
export function renderPublicComment(state: PublicCommentState, existing?: string, target?: CommentTarget): string {
  const pr = state.pullRequest;
  if (pr.origin === "local") return renderLocalText(state);
  return renderCommentRecords(foldRecord(readCommentRecords(existing), platformRecordOf(state, target)), existing);
}

/** The sticky-comment merge for a writer: every writer re-renders the whole comment from the records it carries plus its own. */
export function platformSectionMerge(state: PublicCommentState, target: CommentTarget | undefined): { merge: (existing: string | undefined) => string } {
  return { merge: existing => renderPublicComment(state, existing, target) };
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

/** How many screens the comment lists as changed; undefined before the review exists. */
export function reviewChangeCount(state: Pick<PublicCommentState, "review">): number | undefined {
  return state.review ? reviewChanges(state.review).size : undefined;
}

export { recordSummary, readCommentRecords };

/** A surface's status in the local text summary, named as the comment groups it. */
function localStatus(surface: Surface): string {
  if (isAccessibilityOnlyChange(surface)) return "accessibility only";
  if (surface.review) return surface.review.status;
  if (surface.status === "added" || surface.status === "removed") return surface.status;
  const failed = (["base", "head"] as const).some(side => surface[side]?.kind === "screen" && !surface[`${side}Image`]
    && surface[`${side}Outcome`] && surface[`${side}Outcome`]?.status !== "captured");
  return failed ? "unavailable" : "not compared";
}

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
      `- ${inlineText((s.head ?? s.base)?.route ?? s.id, 160)}: ${localStatus(s)}${s.note ? ` — ${inlineText(s.note.text, 500)}` : ""}`) ?? []),
    "", ...(state.review ? contextLines(state.review) : []), "Report: artifacts/report.zip", "Details: README.md, agent-mode-cost.md, issues.md", ""].join("\n");
}
