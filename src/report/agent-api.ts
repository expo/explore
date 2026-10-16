/**
 * The agent-facing view of one hosted report: `/p/<token>/api/v1/...` JSON resources, the Markdown
 * index agents get when they fetch the token page without asking for HTML, and the block the Viewer
 * shell carries for fetchers that convert HTML to text. It reads the decrypted archive directly, so
 * it only picks the fields it publishes from the report JSON and treats everything else as untrusted.
 */
import { readZipDirectory, readZipEntry, type ZipEntry } from "./zip-reader.js";

export const AGENT_API_VERSION = "v1";
/** The largest review.json or exploration.json a hosted report reads. */
export const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;

type Json = Record<string, unknown>;
export type LoadedReport = {
  kind: "pr-review" | "exploration";
  file: "review.json" | "exploration.json";
  raw: Uint8Array;
  json: Json;
  zip: Uint8Array;
  entries: Map<string, ZipEntry>;
};

const rec = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const strings = (value: unknown): string[] => arr(value).filter((item): item is string => typeof item === "string");
const defined = <T extends Json>(object: T): T => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;

/** Parses the decrypted archive; undefined when it is not a report this API knows how to read. */
export async function loadReport(zip: Uint8Array): Promise<LoadedReport | undefined> {
  const entries = readZipDirectory(zip);
  if (!entries) return undefined;
  const file = entries.has("review.json") ? "review.json" : entries.has("exploration.json") ? "exploration.json" : undefined;
  if (!file) return undefined;
  const raw = await readZipEntry(zip, entries.get(file)!, MAX_METADATA_BYTES);
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(raw)); } catch { return undefined; }
  const root = rec(parsed);
  if (file === "review.json") {
    const review = rec(root.review);
    if (review.contract !== "explore.review" || !Array.isArray(review.surfaces)) return undefined;
    return { kind: "pr-review", file, raw, json: review, zip, entries };
  }
  const report = root.kind === "explore.exploration-report" ? root : rec(root.report);
  if (report.kind !== "explore.exploration-report" || typeof report.map !== "object") return undefined;
  return { kind: "exploration", file, raw, json: report, zip, entries };
}

export type AgentContext = {
  /** `https://<deployment>/p/<token>` */
  pageUrl: string;
  /** This report's platform when the deployment serves several, so links keep `?platform=`. */
  platform?: string | undefined;
  platforms: string[];
  expiresAt: string | null;
};

const apiUrl = (context: AgentContext, path = "") => `${context.pageUrl}/api/${AGENT_API_VERSION}${path}`;
function viewerUrl(context: AgentContext, params: Record<string, string> = {}): string {
  const url = new URL(context.pageUrl);
  if (context.platform && context.platforms.length > 1) url.searchParams.set("platform", context.platform);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}
const withPlatform = (context: AgentContext, url: string) => (context.platform && context.platforms.length > 1 ? `${url}${url.includes("?") ? "&" : "?"}platform=${context.platform}` : url);

type Page<T> = { items: T[]; total: number; count: number; hasMore: boolean; nextCursor?: string };
function page<T>(items: T[], params: URLSearchParams): Page<T> | undefined {
  const limitRaw = params.get("limit"), cursorRaw = params.get("cursor");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  const offset = cursorRaw === null ? 0 : Number(cursorRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isInteger(offset) || offset < 0) return undefined;
  const slice = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return { items: slice, total: items.length, count: slice.length, hasMore, ...(hasMore ? { nextCursor: String(offset + limit) } : {}) };
}

// PR review projections ---------------------------------------------------------------------------

function surfaceRoute(surface: Json): Json {
  return rec(surface.head ?? surface.base);
}
function imageUrl(context: AgentContext, image: unknown): string | undefined {
  const sha = str(rec(image).sha256);
  return sha && SHA256.test(sha) ? withPlatform(context, apiUrl(context, `/assets/${sha}`)) : undefined;
}
function reviewSurfaceItem(context: AgentContext, surface: Json): Json {
  const route = surfaceRoute(surface);
  const visual = rec(surface.visual), review = rec(surface.review);
  const id = str(surface.id) ?? "";
  return defined({
    id, route: str(route.route), kind: str(route.kind), routeFile: str(route.routeFile), status: verdictOf(surface),
    sourceStatus: verdictOf(surface) === str(surface.status) ? undefined : str(surface.status), colorScheme: str(surface.colorScheme),
    review: surface.review === undefined ? undefined : defined({ status: str(review.status), description: str(review.description), facts: arr(review.facts).map(fact => str(rec(fact).bullet)).filter(Boolean) }),
    visual: surface.visual === undefined ? undefined : defined({ verdict: str(visual.verdict), reason: str(visual.reason), mismatchPercentage: num(visual.mismatchPercentage), threshold: num(visual.threshold) }),
    note: str(rec(surface.note).text),
    headImage: imageUrl(context, surface.headImage), baseImage: imageUrl(context, surface.baseImage),
    viewerUrl: ID.test(id) ? viewerUrl(context, { view: "compare", screen: id }) : undefined,
  });
}
function reviewSurfaceDetail(context: AgentContext, review: Json, surface: Json): Json {
  const id = str(surface.id);
  const edges = (side: "head" | "base") => arr(rec(rec(review.navigation)[side]).edges).map(rec);
  const side = (value: unknown) => { const s = rec(value); return value === undefined ? undefined : defined({ route: str(s.route), kind: str(s.kind), routeFile: str(s.routeFile), sourceFiles: strings(s.sourceFiles) }); };
  const outcome = (value: unknown) => { const o = rec(value); return value === undefined ? undefined : defined({ status: str(o.status), landing: str(o.landing), attempts: num(o.attempts), reason: str(o.reason) }); };
  return defined({
    ...reviewSurfaceItem(context, surface),
    head: side(surface.head), base: side(surface.base), headOutcome: outcome(surface.headOutcome), baseOutcome: outcome(surface.baseOutcome),
    sourceImpact: strings(surface.sourceImpact), sourceScope: str(surface.sourceScope),
    navigation: { out: edges("head").filter(edge => edge.from === id).map(edgeItem), in: edges("head").filter(edge => edge.to === id).map(edgeItem) },
  });
}
const edgeItem = (edge: Json): Json => defined({ from: str(edge.from), to: str(edge.to), kind: str(edge.kind), sourceFile: str(edge.sourceFile), provenance: str(edge.provenance) });

/**
 * A screen's status as the Viewer and the PR comment show it: the review's verdict where there is one, so `modified`
 * means a visible change. A screen whose source changed but whose captures match is unchanged, including in reports
 * from before 0.19.1, which called it "needs review". A modified screen whose screenshots match changed only in what
 * assistive technology reads: `accessibility-only`. A screen whose source changed but that has no verdict was not
 * compared: `not-compared`.
 */
/** Both sides captured at their verified destination route, as a verdict requires (isAccessibilityOnlyChange in the contract). */
function verifiedPair(surface: Json): boolean {
  return (["base", "head"] as const).every(side => str(rec(surface[side]).kind) === "screen" && Boolean(surface[`${side}Image`])
    && str(rec(surface[`${side}Outcome`]).status) === "captured" && str(rec(surface[`${side}Outcome`]).landing) === "verified");
}

function verdictOf(surface: Json): string | undefined {
  const review = rec(surface.review);
  const status = str(review.status);
  if (status === "needs-review" && str(review.description) === "Source changed; no visible difference was captured.") return "unchanged";
  if (status === "modified" && str(rec(surface.visual).verdict) === "unchanged" && verifiedPair(surface)) return "accessibility-only";
  // A source change nobody compared is not a change Explore saw.
  if (status === undefined && str(surface.status) === "modified") return "not-compared";
  return status ?? str(surface.status);
}

function reviewSummary(context: AgentContext, review: Json): Json {
  const surfaces = arr(review.surfaces).map(rec);
  const counts: Record<string, number> = {};
  for (const surface of surfaces) { const status = verdictOf(surface) ?? "unknown"; counts[status] = (counts[status] ?? 0) + 1; }
  const pr = rec(review.pullRequest), runtime = rec(review.runtime);
  return defined({
    kind: "pr-review", api: AGENT_API_VERSION, contract: str(review.contract),
    pullRequest: defined({ origin: str(pr.origin), repository: str(pr.repository), number: num(pr.number), title: str(pr.title), url: str(pr.url), head: str(rec(pr.head).sha), base: str(rec(pr.base).sha) }),
    app: defined({ name: str(runtime.appName), version: str(runtime.appVersion), build: str(runtime.appBuildNumber), platform: str(runtime.platform) ?? context.platform, device: rec(runtime.device).model === undefined ? undefined : `${str(rec(runtime.device).model)} ${str(rec(runtime.device).osVersion) ?? ""}`.trim() }),
    createdAt: str(review.createdAt), mode: str(review.mode), platforms: context.platforms, expiresAt: context.expiresAt,
    screens: { total: surfaces.length, ...counts },
    links: {
      screens: withPlatform(context, apiUrl(context, "/screens")), changed: withPlatform(context, apiUrl(context, "/screens?status=modified,accessibility-only,added,removed")),
      transitions: withPlatform(context, apiUrl(context, "/transitions")), raw: withPlatform(context, apiUrl(context, "/raw")),
      viewer: viewerUrl(context), viewerChanges: viewerUrl(context, { focus: "modified", inspect: "diff" }), markdown: `${context.pageUrl}/llms.txt`,
    },
  });
}

// Exploration projections -------------------------------------------------------------------------

function explorationScreenItem(context: AgentContext, map: Json, screen: Json): Json {
  const id = str(screen.id) ?? "";
  const transitions = arr(map.transitions).map(rec);
  return defined({
    id, title: str(screen.title), route: str(screen.route), state: str(screen.state), colorScheme: str(screen.colorScheme),
    start: bool(screen.start), terminal: bool(screen.terminal), depth: num(screen.depth), visits: num(screen.visits),
    variants: strings(screen.variantIds).length, elements: strings(screen.elementIds).length,
    transitionsOut: transitions.filter(t => t.fromScreenId === id).length, transitionsIn: transitions.filter(t => t.toScreenId === id).length,
    screenshot: screenshotUrl(context, map, screen),
    viewerUrl: ID.test(id) ? viewerUrl(context, { screen: id }) : undefined,
  });
}
function screenshotUrl(context: AgentContext, map: Json, screen: Json): string | undefined {
  const observationId = strings(screen.observationIds).at(-1);
  const observation = arr(map.observations).map(rec).find(o => o.id === observationId);
  const artifact = arr(map.artifacts).map(rec).find(a => a.id === observation?.screenshotArtifactId);
  const sha = str(artifact?.sha256);
  return sha && SHA256.test(sha) ? withPlatform(context, apiUrl(context, `/assets/${sha}`)) : undefined;
}
const elementItem = (element: Json): Json => defined({
  id: str(element.id ?? element.elementId), label: str(element.label), role: str(element.role), value: str(element.value), identifier: str(element.identifier),
  bounds: element.bounds === undefined ? undefined : rec(element.bounds), actions: strings(element.actions), risk: str(element.risk), actionable: bool(element.actionable), enabled: bool(element.enabled), visible: bool(element.visible),
});
const transitionItem = (transition: Json): Json => defined({
  id: str(transition.id), from: str(transition.fromScreenId), to: str(transition.toScreenId), actionKind: str(transition.actionKind), elementId: str(transition.elementId), attempts: strings(transition.attemptIds).length,
});
function explorationScreenDetail(context: AgentContext, map: Json, screen: Json): Json {
  const id = str(screen.id);
  const transitions = arr(map.transitions).map(rec);
  const elements = arr(map.elements).map(rec).filter(element => element.screenId === id).map(elementItem);
  const variants = arr(map.variants).map(rec).filter(variant => variant.screenId === id).map(variant => defined({ id: str(variant.id), key: str(variant.key), name: str(variant.name), observations: strings(variant.observationIds).length }));
  const gaps = arr(map.gaps).map(rec).filter(gap => gap.screenId === id).map(gapItem);
  return defined({
    ...explorationScreenItem(context, map, screen), elements, variants, gaps,
    transitions: { out: transitions.filter(t => t.fromScreenId === id).map(transitionItem), in: transitions.filter(t => t.toScreenId === id).map(transitionItem) },
  });
}
const gapItem = (gap: Json): Json => defined({ id: str(gap.id), kind: str(gap.kind), status: str(gap.status), message: str(gap.message), screenId: str(gap.screenId), reason: str(gap.reason) });
const frontierItem = (item: Json): Json => defined({ id: str(item.id), screenId: str(item.screenId), elementId: str(item.elementId), label: str(item.label), actionKind: str(item.actionKind), risk: str(item.risk), status: str(item.status), priority: num(item.priority), reason: str(item.reason) });
const journeyItem = (journey: Json): Json => defined({ id: str(journey.id), title: str(journey.title), screenIds: strings(journey.screenIds), transitionIds: strings(journey.transitionIds) });

function explorationSummary(context: AgentContext, report: Json): Json {
  const map = rec(report.map), exploration = rec(report.exploration), app = rec(exploration.app), device = rec(exploration.device), coverage = rec(report.coverage);
  const screens = arr(map.screens);
  return defined({
    kind: "exploration", api: AGENT_API_VERSION, contract: str(map.contract),
    app: defined({ name: str(app.name), bundleId: str(app.bundleId), platform: str(app.platform) ?? context.platform, version: str(app.version), build: str(app.buildNumber), device: device.model === undefined ? undefined : `${str(device.model)} ${str(device.osVersion) ?? ""}`.trim() }),
    startedAt: str(exploration.startedAt), completedAt: str(exploration.completedAt), stopReason: str(exploration.stopReason), summary: str(exploration.summary),
    model: str(rec(exploration.model).model), platforms: context.platforms, expiresAt: context.expiresAt,
    screens: { total: screens.length, coverage: Object.keys(coverage).length ? coverage : undefined },
    counts: { transitions: arr(map.transitions).length, elements: arr(map.elements).length, journeys: arr(map.journeys).length, gaps: arr(map.gaps).length, frontier: arr(map.frontier).length },
    links: {
      screens: withPlatform(context, apiUrl(context, "/screens")), transitions: withPlatform(context, apiUrl(context, "/transitions")), journeys: withPlatform(context, apiUrl(context, "/journeys")),
      gaps: withPlatform(context, apiUrl(context, "/gaps")), frontier: withPlatform(context, apiUrl(context, "/frontier")), raw: withPlatform(context, apiUrl(context, "/raw")),
      viewer: viewerUrl(context), markdown: `${context.pageUrl}/llms.txt`,
    },
  });
}

// Markdown ----------------------------------------------------------------------------------------

function escapeMd(value: unknown): string { return String(value ?? "").replace(/[\r\n|`]/g, " ").slice(0, 200); }

/** The index agents read first: what this is, the headline numbers, and where each resource lives. */
export function agentIndexMarkdown(context: AgentContext, loaded: LoadedReport): string {
  const summary = loaded.kind === "pr-review" ? reviewSummary(context, loaded.json) : explorationSummary(context, loaded.json);
  const links = rec(summary.links) as Record<string, string>;
  const app = rec(summary.app), screens = rec(summary.screens);
  const lines: string[] = [];
  if (loaded.kind === "pr-review") {
    const pr = rec(summary.pullRequest);
    // A comparison of two commits has a title ("v1.4.0 vs v1.3.0") where a pull request has a number.
    // A comparison of two commits, or a local review on someone's machine, has no pull request: its title names both refs.
    const compared = pr.origin === "compare" || pr.origin === "local";
    lines.push(`# Expo Explore report: ${escapeMd(app.name ?? pr.repository)} ${compared ? escapeMd(pr.title) : `PR #${escapeMd(pr.number)}`}${app.platform ? ` (${escapeMd(app.platform)})` : ""}`, "",
      `> Visual review of ${compared ? `${escapeMd(pr.repository)} ${escapeMd(pr.title)}` : `pull request ${escapeMd(pr.repository)}#${escapeMd(pr.number)}`} by Expo Explore. ${screens.total} screens captured: ${screens.modified ?? 0} modified, ${screens["accessibility-only"] ? `${screens["accessibility-only"]} accessibility only (screenshots match, the accessibility tree does not), ` : ""}${screens.added ?? 0} added, ${screens.removed ?? 0} removed, ${screens.unchanged ?? 0} unchanged.${context.expiresAt ? ` This link stops serving the report after ${context.expiresAt}.` : ""}`, "",
      "This URL is the human Viewer. The same report is available as read-only JSON (no credentials beyond this URL):", "",
      `- [Summary](${links.summary ?? withPlatform(context, apiUrl(context))}): kind, counts by status, app and PR identity, links`,
      `- [Changed screens](${links.changed}): the modified, accessibility-only (screenshots match, the accessibility tree does not), added and removed screens with the review description, visual verdict and mismatch percentage; \`status=\` filters, \`limit=\`/\`cursor=\` page`,
      `- [All screens](${links.screens}): every captured screen; \`${links.screens}/{id}\` (the \`id\` field of a screen) adds source files and navigation in and out`,
      `- [Transitions](${links.transitions}): navigation edges between screens (\`?from=\`/\`?to=\` take a screen id or route)`,
      `- Screenshots: each screen's \`headImage\`/\`baseImage\` URL returns the PNG`,
      `- [Raw review.json](${links.raw}): the full report contract`, "",
      `Start with the changed screens. Every item carries a \`viewerUrl\` that opens that screen in the Viewer for a human; [${escapeMd(links.viewerChanges)}](${links.viewerChanges}) opens the list of changes.`);
  } else {
    const counts = rec(summary.counts);
    lines.push(`# Expo Explore exploration: ${escapeMd(app.name)}${app.platform ? ` (${escapeMd(app.platform)})` : ""}`, "",
      `> An agent explored ${escapeMd(app.name)} ${escapeMd(app.version ?? "")} on ${escapeMd(app.device ?? app.platform)} and mapped ${screens.total} screens, ${counts.transitions} transitions, ${counts.elements} elements; ${counts.gaps} coverage gaps. Stopped: ${escapeMd(summary.stopReason)}.${summary.summary ? ` ${escapeMd(summary.summary)}` : ""}${context.expiresAt ? ` This link stops serving the report after ${context.expiresAt}.` : ""}`, "",
      "This URL is the human Viewer. The same map is available as read-only JSON (no credentials beyond this URL):", "",
      `- [Summary](${withPlatform(context, apiUrl(context))}): app, device, model, stop reason, counts, links`,
      `- [Screens](${links.screens}): every screen with route, depth, visits, element and transition counts and a screenshot URL; \`${links.screens}/{id}\` (the \`id\` field of a screen) adds elements (label, role, bounds, actions, risk), variants, gaps, transitions in and out`,
      `- [Transitions](${links.transitions}): observed screen-to-screen transitions and the action that caused each (\`?from=\`/\`?to=\` take a screen id or route)`,
      `- [Journeys](${links.journeys}): named paths through the app`,
      `- [Gaps](${links.gaps}): what the exploration could not reach or understand`,
      `- [Frontier](${links.frontier}): actions not yet tried`,
      `- [Raw exploration.json](${links.raw}): the full map contract`, "",
      "Start with the screens list, then open the screens you care about. Every item carries a `viewerUrl` that opens it in the Viewer for a human.");
  }
  return lines.join("\n") + "\n";
}

/** The same index as HTML for the Viewer shell: real text in `#root`, replaced when the Viewer hydrates. */
export function agentIndexHtml(context: AgentContext, loaded: LoadedReport): string {
  const escape = (value: string) => value.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const inline = (line: string) => escape(line).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text: string, href: string) => (/^https:\/\//.test(href) ? `<a href="${href}">${text}</a>` : text));
  const items: string[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { items.push(`<ul>${list.join("")}</ul>`); list = []; } };
  for (const line of agentIndexMarkdown(context, loaded).split("\n")) {
    if (line.startsWith("- ")) { list.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    flush();
    if (line.startsWith("# ")) items.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("> ")) items.push(`<p>${inline(line.slice(2))}</p>`);
    else if (line.trim()) items.push(`<p>${inline(line)}</p>`);
  }
  flush();
  // Real DOM text for HTML-to-text readers, but visually hidden so a slow connection does not flash it before React replaces #root.
  return `<section data-explore-agent-index style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">${items.join("")}</section>`;
}

function screensMarkdown(loaded: LoadedReport, items: Json[], total: number): string {
  const header = loaded.kind === "pr-review" ? "| Screen | Status | Review | Visual | Viewer |\n|---|---|---|---|---|" : "| Screen | Title | Depth | Elements | Out/In | Viewer |\n|---|---|---|---|---|---|";
  const rows = items.map(item => loaded.kind === "pr-review"
    ? `| ${escapeMd(item.route ?? item.id)} | ${escapeMd(item.status)} | ${escapeMd(rec(item.review).description ?? "")} | ${escapeMd(rec(item.visual).verdict ?? "")}${rec(item.visual).mismatchPercentage !== undefined ? ` ${escapeMd(rec(item.visual).mismatchPercentage)}%` : ""} | ${escapeMd(item.viewerUrl)} |`
    : `| ${escapeMd(item.route ?? item.id)} | ${escapeMd(item.title)} | ${escapeMd(item.depth)} | ${escapeMd(item.elements)} | ${escapeMd(item.transitionsOut)}/${escapeMd(item.transitionsIn)} | ${escapeMd(item.viewerUrl)} |`);
  return `# Screens (${items.length} of ${total})\n\n${header}\n${rows.join("\n")}\n`;
}

// Routing -----------------------------------------------------------------------------------------

export type AgentReply = { status: number; contentType: string; body: BodyInit; headers?: Record<string, string> };
const json = (body: unknown, status = 200): AgentReply => ({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
const markdown = (body: string): AgentReply => ({ status: 200, contentType: "text/markdown; charset=utf-8", body });
const notFound = (): AgentReply => json({ error: "not_found" }, 404);

/** True when the request would rather have Markdown than JSON (`Accept: text/markdown` ahead of JSON). */
/** Parses an Accept header into explicit media types with their quality; wildcards are dropped so a bare wildcard never prefers anything. */
function acceptedTypes(accept: string | null): Map<string, { q: number; order: number }> {
  const types = new Map<string, { q: number; order: number }>();
  (accept ?? "").split(",").forEach((entry, order) => {
    const [rawType, ...params] = entry.trim().split(";");
    const type = rawType!.trim().toLowerCase();
    if (!type || type.includes("*")) return;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map(part => part.trim().toLowerCase());
      if (key === "q" && value !== undefined) { const parsed = Number(value); q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0; }
    }
    if (!types.has(type)) types.set(type, { q, order });
  });
  return types;
}
/** Quality of the best match among `candidates`, with its position for tie-breaking; undefined when none is acceptable. */
function quality(types: Map<string, { q: number; order: number }>, candidates: string[]): { q: number; order: number } | undefined {
  let best: { q: number; order: number } | undefined;
  for (const candidate of candidates) {
    const found = types.get(candidate);
    if (found && found.q > 0 && (!best || found.q > best.q || (found.q === best.q && found.order < best.order))) best = found;
  }
  return best;
}
/** True when `a` is acceptable and not outranked by `b`: higher quality wins, then whichever was listed first. */
function outranks(a: { q: number; order: number } | undefined, b: { q: number; order: number } | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a.q > b.q || (a.q === b.q && a.order < b.order);
}
const HTML_TYPES = ["text/html", "application/xhtml+xml"];
/** True when Markdown is acceptable and not outranked by JSON (quality, then listing order). */
export function prefersMarkdown(accept: string | null): boolean {
  const types = acceptedTypes(accept);
  return outranks(quality(types, ["text/markdown"]), quality(types, ["application/json"]));
}
/** True when a browser asked for the page: HTML acceptable (q > 0) and not outranked by Markdown or JSON. Wildcards do not count, so a bare wildcard gets the Markdown index. */
export function prefersHtml(accept: string | null): boolean {
  const types = acceptedTypes(accept);
  const html = quality(types, HTML_TYPES);
  return outranks(html, quality(types, ["text/markdown"])) && outranks(html, quality(types, ["application/json"]));
}

/** Answers `/api/v1<path>`; `path` starts with "/" or is empty. */
export async function agentApiReply(context: AgentContext, loaded: LoadedReport, path: string, params: URLSearchParams, accept: string | null): Promise<AgentReply> {
  const segments = path.split("/").filter(Boolean);
  if (segments.length > 2) return notFound();
  const wantsMarkdown = prefersMarkdown(accept);
  const map = loaded.kind === "exploration" ? rec(loaded.json.map) : undefined;
  if (segments.length === 0) {
    if (wantsMarkdown) return markdown(agentIndexMarkdown(context, loaded));
    return json(loaded.kind === "pr-review" ? reviewSummary(context, loaded.json) : explorationSummary(context, loaded.json));
  }
  const [resource, id] = segments as [string, string | undefined];
  if (id !== undefined && !(resource === "assets" ? SHA256 : ID).test(id)) return notFound();
  switch (resource) {
    case "screens": {
      if (loaded.kind === "pr-review") {
        const surfaces = arr(loaded.json.surfaces).map(rec);
        if (id !== undefined) { const surface = surfaces.find(s => s.id === id); return surface ? json(reviewSurfaceDetail(context, loaded.json, surface)) : notFound(); }
        const statuses = params.get("status")?.split(",").filter(Boolean);
        const items = surfaces.filter(s => !statuses || statuses.includes(verdictOf(s) ?? "")).map(s => reviewSurfaceItem(context, s));
        const paged = page(items, params);
        if (!paged) return json({ error: "bad_request", message: `limit must be 1-${MAX_LIMIT} and cursor a non-negative integer` }, 400);
        return wantsMarkdown ? markdown(screensMarkdown(loaded, paged.items, paged.total)) : json(paged);
      }
      const screens = arr(map!.screens).map(rec);
      if (id !== undefined) { const screen = screens.find(s => s.id === id); return screen ? json(explorationScreenDetail(context, map!, screen)) : notFound(); }
      const paged = page(screens.map(s => explorationScreenItem(context, map!, s)), params);
      if (!paged) return json({ error: "bad_request", message: `limit must be 1-${MAX_LIMIT} and cursor a non-negative integer` }, 400);
      return wantsMarkdown ? markdown(screensMarkdown(loaded, paged.items, paged.total)) : json(paged);
    }
    case "transitions": {
      if (id !== undefined) return notFound();
      const from = params.get("from"), to = params.get("to");
      // Agents reach for routes as readily as ids, so a filter value matches either.
      const routes = new Map<string, string>();
      for (const screen of arr(loaded.kind === "pr-review" ? loaded.json.surfaces : map!.screens).map(rec)) {
        const id = str(screen.id), route = str(screen.route) ?? str(rec(screen.head).route) ?? str(rec(screen.base).route);
        if (id && route) routes.set(id, route);
      }
      const matches = (value: string | null, id: unknown) => !value || id === value || (typeof id === "string" && routes.get(id) === value);
      const items = loaded.kind === "pr-review"
        ? arr(rec(rec(loaded.json.navigation)[params.get("side") === "base" ? "base" : "head"]).edges).map(rec).filter(e => matches(from, e.from) && matches(to, e.to)).map(edgeItem)
        : arr(map!.transitions).map(rec).filter(t => matches(from, t.fromScreenId) && matches(to, t.toScreenId)).map(transitionItem);
      const paged = page(items, params);
      return paged ? json(paged) : json({ error: "bad_request" }, 400);
    }
    case "journeys": case "gaps": case "frontier": {
      if (id !== undefined) return notFound();
      const collection = loaded.kind === "pr-review"
        ? undefined
        : resource === "journeys" ? arr(map!.journeys).map(rec).map(journeyItem) : resource === "gaps" ? arr(map!.gaps).map(rec).map(gapItem) : resource === "frontier" ? arr(map!.frontier).map(rec).map(frontierItem) : undefined;
      if (!collection) return notFound();
      const paged = page(collection, params);
      return paged ? json(paged) : json({ error: "bad_request" }, 400);
    }
    case "assets": {
      if (id === undefined) return notFound();
      const entry = loaded.entries.get(`assets/${id}.png`);
      if (!entry) return notFound();
      const bytes = await readZipEntry(loaded.zip, entry, MAX_ASSET_BYTES);
      if (!bytes) return notFound();
      return { status: 200, contentType: "image/png", body: bytes as BodyInit, headers: { ETag: `"${id}"`, "Content-Length": String(bytes.byteLength) } };
    }
    case "raw": {
      if (id !== undefined) return notFound();
      if (loaded.raw.byteLength > MAX_RAW_BYTES) return json({ error: "too_large", bytes: loaded.raw.byteLength, message: `${loaded.file} exceeds ${MAX_RAW_BYTES} bytes; use the collection resources` }, 413);
      return { status: 200, contentType: "application/json; charset=utf-8", body: loaded.raw as BodyInit, headers: { "Content-Length": String(loaded.raw.byteLength) } };
    }
    default: return notFound();
  }
}
