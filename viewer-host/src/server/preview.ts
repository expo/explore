/**
 * One hosted preview deployment per review. `ci:deploy` writes the report as static files of the deployment under the
 * link's token: each target's manifest at `/p/<token>/targets/<target>.json` and every screenshot at
 * `/p/<token>/assets/<sha256>.<ext>`. EAS Hosting serves those files directly; nothing encrypts them, and what keeps
 * them private is the 160-bit token in their path. This Worker answers the rest of `/p/<token>`: the Viewer shell,
 * the manifest the Viewer asks for by target, the target list, and the agent API. The Viewer bundle under /viewer/ is
 * public and identical to the central host's.
 */
import { AGENT_API_VERSION, agentApiReply, agentIndexHtml, agentIndexMarkdown, prefersHtml, type AgentContext, type LoadedReport } from "../../../src/report/agent-api";
import { MAX_ASSET_BYTES, MAX_MANIFEST_BYTES, reportFromManifest } from "../../../src/report/preview-manifest";

export type PreviewEnvironment = {
  /** Lowercase base32 path token the review comment links to. */
  EXPLORE_PREVIEW_TOKEN?: string | undefined;
  /** Path of the report's manifest inside this deployment, `/p/<token>/targets/report.json` (single-report deployments). */
  EXPLORE_PREVIEW_REPORT?: string | undefined;
  /**
   * JSON, one entry per capture target in config order:
   * `[{"target":"duo-open","platform":"ios","label":"iPhone Duo (open)","path":"/p/<token>/targets/duo-open.json","changes":3,"device":"iPhone Duo 26.0"}]`.
   * Deployments from before targets list `{"platform":"ios","path":"/p/<token>/targets/ios.json",…}`: the target is the platform.
   * Set instead of EXPLORE_PREVIEW_REPORT by deployments that serve several reports (or one that is not iOS).
   */
  EXPLORE_PREVIEW_REPORTS?: string | undefined;
};

export type PreviewPlatform = "ios" | "android";
/** `target` names the report (and its manifest, `targets/<target>.json`); `platform` is the device's. */
export type PreviewReport = { target: string; platform: PreviewPlatform; label?: string; path: string; changes?: number; device?: string };
export type PreviewConfig = { token: string; reports: PreviewReport[] };

export const PREVIEW_TOKEN = /^[a-z2-7]{32}$/;
/** A capture target id, as the CLI's isTargetId accepts it: the Worker does not bundle the config reader. */
const TARGET_ID = /^[a-z][a-z0-9-]{0,31}$/;
export function isPreviewTargetId(value: unknown): value is string {
  return typeof value === "string" && TARGET_ID.test(value) && !["base", "head", "report"].includes(value) && !value.startsWith("install-");
}
const REPORT_PATH = /^\/p\/([a-z2-7]{32})\/targets\/(report|[a-z][a-z0-9-]{0,31})\.json$/;
const PLATFORMS: readonly PreviewPlatform[] = ["ios", "android"];
/** As many targets as a config may name. */
export const MAX_PREVIEW_REPORTS = 8;
const PLAIN_TEXT = /[\u0000-\u001f\u007f<>[\]]/;

/** The target a manifest path names, when it is a manifest of this token's deployment. */
function pathTarget(path: unknown, token: string): string | undefined {
  const match = typeof path === "string" ? REPORT_PATH.exec(path) : null;
  return match && match[1] === token ? match[2] : undefined;
}

/**
 * The report list, strictly shaped: an unknown platform, an invalid or repeated target, a path that is not this token's
 * `targets/<target>.json`, an odd label or device, or extra keys reject the whole configuration.
 */
function parseReports(env: PreviewEnvironment, token: string): PreviewReport[] | undefined {
  if (env.EXPLORE_PREVIEW_REPORTS === undefined) {
    const reportPath = env.EXPLORE_PREVIEW_REPORT ?? "";
    return pathTarget(reportPath, token) === "report" ? [{ target: "ios", platform: "ios", path: reportPath }] : undefined;
  }
  if (env.EXPLORE_PREVIEW_REPORT !== undefined || env.EXPLORE_PREVIEW_REPORTS.length > 8192) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(env.EXPLORE_PREVIEW_REPORTS); } catch { return undefined; }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_PREVIEW_REPORTS) return undefined;
  const reports: PreviewReport[] = [];
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const { platform, path, changes, device, label, ...rest } = entry as Record<string, unknown>;
    // Listings from before targets name each report by its platform.
    const { target = platform, ...extra } = rest;
    if (Object.keys(extra).length || !PLATFORMS.includes(platform as PreviewPlatform) || !isPreviewTargetId(target)) return undefined;
    if (typeof path !== "string" || pathTarget(path, token) !== target) return undefined;
    if (changes !== undefined && (typeof changes !== "number" || !Number.isInteger(changes) || changes < 0 || changes > 100_000)) return undefined;
    if (device !== undefined && (typeof device !== "string" || device.length > 120 || PLAIN_TEXT.test(device))) return undefined;
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 80 || PLAIN_TEXT.test(label))) return undefined;
    if (reports.some(report => report.target === target)) return undefined;
    reports.push({ target, platform: platform as PreviewPlatform, ...(label === undefined ? {} : { label }), path,
      ...(changes === undefined ? {} : { changes }), ...(device === undefined ? {} : { device }) });
  }
  return reports;
}

/** The deployment's configuration, or undefined when any value is missing or malformed. */
export function previewConfig(env: PreviewEnvironment): PreviewConfig | undefined {
  const token = env.EXPLORE_PREVIEW_TOKEN ?? "";
  if (!PREVIEW_TOKEN.test(token)) return undefined;
  const reports = parseReports(env, token);
  return reports ? { token, reports } : undefined;
}

function baseHeaders(contentType: string): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": contentType,
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Access-Control-Allow-Origin": "https://cors.invalid",
  });
}

export function previewNotFound(): Response {
  return new Response("Not found", { status: 404, headers: baseHeaders("text/plain; charset=utf-8") });
}

/** A route whose static file could not be fetched this time; the same request works once it can, and the Viewer retries. */
function previewUnavailable(): Response {
  const headers = baseHeaders("text/plain; charset=utf-8");
  headers.set("Retry-After", "1");
  return new Response("Unavailable", { status: 503, headers });
}

/** Constant-time comparison of two equal-length ASCII tokens. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** A parsed manifest, kept so the shell and the agent API do not fetch and parse it on every request. */
type ParsedManifest = { bytes: Uint8Array; loaded: LoadedReport };
type ManifestResult = ParsedManifest | "unavailable" | undefined;

export type PreviewRequestOptions = {
  env: PreviewEnvironment;
  indexHtml: string;
  /** Same-deployment fetch of static files; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Parsed manifests by path, least recently used first, within MANIFEST_CACHE_BYTES; defaults to a module-level cache. */
  cache?: Map<string, ParsedManifest>;
  /** Manifest fetches in flight by path, shared by the requests waiting for them; defaults to a module-level map. */
  loading?: Map<string, Promise<ManifestResult>>;
};

const ROUTE = /^\/p\/([a-z2-7]{32})(?:\/|\/(reports\.json|manifest\.json|llms\.txt)|(\/api\/v1(?:\/[A-Za-z0-9._:@-]{1,200}){0,2}\/?))?$/;
/** Parsed manifests are kept within this much of the isolate's 128 MB. */
const MANIFEST_CACHE_BYTES = 32 * 1024 * 1024;
/** What a kept manifest holds: its bytes, and its parsed metadata at about 1.6 times their size. */
const heldBytes = (manifest: ParsedManifest) => 3 * manifest.bytes.byteLength;
const manifestCache = new Map<string, ParsedManifest>();
const manifestLoading = new Map<string, Promise<ManifestResult>>();

/**
 * `GET /p/<token>` serves the Viewer shell to browsers and the report's Markdown index to anything
 * that does not ask for HTML (agents fetch with `Accept: text/markdown` or `*​/*`); the shell itself
 * carries that index as text inside `#root` until the Viewer hydrates, and a `Link` header names the
 * JSON API. `GET /p/<token>/manifest.json` answers one target's manifest (`?target=`, or `?platform=` in older
 * links, selects one of several; the first listed otherwise), `GET /p/<token>/reports.json` lists the targets the
 * deployment serves, `GET /p/<token>/llms.txt` is the Markdown index, and `GET /p/<token>/api/v1/...`
 * answers the agent API (see agent-api.ts). Screenshots are static files the Worker never sees. Every other method,
 * path, or token is an identical 404, so the response never confirms that a deployment or token exists.
 */
export async function previewResponse(request: Request, options: PreviewRequestOptions): Promise<Response> {
  const config = previewConfig(options.env);
  if (!config) return previewNotFound();
  if (request.method !== "GET") return previewNotFound();
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match || !sameToken(match[1]!, config.token)) return previewNotFound();
  const route = match[2] ?? (match[3] ? "api" : undefined);
  const pageUrl = `${url.origin}/p/${config.token}`;
  const linkHeader = `<${pageUrl}/api/${AGENT_API_VERSION}>; rel="alternate"; type="application/json", <${pageUrl}/llms.txt>; rel="alternate"; type="text/markdown"`;
  const accept = request.headers.get("accept");
  if (route === undefined && prefersHtml(accept)) {
    const headers = baseHeaders("text/html; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    const selected = selectReport(config, url);
    const manifest = selected ? await parsedManifest(url.origin, selected, options) : undefined;
    if (!selected || !manifest || manifest === "unavailable") return new Response(options.indexHtml, { headers });
    const shell = shellWithIndex(options.indexHtml, agentIndexHtml(agentContext(pageUrl, config, selected), manifest.loaded));
    // The same URL the Viewer will fetch for this page: its target's query when the link names one, none otherwise.
    const requested = url.searchParams.get("target") ?? url.searchParams.get("platform");
    return new Response(shellWithPreload(shell, `/p/${config.token}/manifest.json${requested ? `?${targetQuery(requested)}` : ""}`), { headers });
  }
  if (route === "reports.json") {
    const body = JSON.stringify(config.reports.map(({ path: _path, ...report }) => report));
    return new Response(body, { headers: baseHeaders("application/json; charset=utf-8") });
  }
  const report = selectReport(config, url);
  if (!report) return previewNotFound();
  if (route === "manifest.json") return manifestResponse(url.origin, report, options);
  const manifest = await parsedManifest(url.origin, report, options);
  if (!manifest || manifest === "unavailable") {
    if (route !== undefined) return manifest === "unavailable" ? previewUnavailable() : previewNotFound();
    const headers = baseHeaders("text/html; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    return new Response(options.indexHtml, { headers });
  }
  const context = agentContext(pageUrl, config, report);
  if (route === undefined || route === "llms.txt") {
    const headers = baseHeaders("text/markdown; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    return new Response(agentIndexMarkdown(context, manifest.loaded), { headers });
  }
  const reply = await agentApiReply(context, manifest.loaded, match[3]!.slice("/api/v1".length).replace(/\/$/, ""), url.searchParams, accept);
  const headers = baseHeaders(reply.contentType);
  headers.set("Vary", "Accept");
  for (const [key, value] of Object.entries(reply.headers ?? {})) headers.set(key, value);
  return new Response(reply.body, { status: reply.status, headers });
}

/**
 * `?target=` picks one of several reports by id; `?platform=` (links from before targets) picks the target named after
 * it, else the first of that platform; neither picks the first listed. Two values, both parameters, or no match: nothing.
 */
export function selectReport(config: PreviewConfig, url: URL): PreviewReport | undefined {
  const targets = url.searchParams.getAll("target"), platforms = url.searchParams.getAll("platform");
  if (targets.length + platforms.length > 1) return undefined;
  if (targets.length) return config.reports.find(report => report.target === targets[0]);
  if (platforms.length) return config.reports.find(report => report.target === platforms[0]) ?? config.reports.find(report => report.platform === platforms[0]);
  return config.reports[0];
}

function agentContext(pageUrl: string, config: PreviewConfig, report: PreviewReport): AgentContext {
  return { pageUrl, platform: report.platform, platforms: [...new Set(config.reports.map(entry => entry.platform))], target: report.target,
    targets: config.reports.map(entry => ({ id: entry.target, platform: entry.platform, label: entry.label ?? (entry.target === entry.platform ? PLATFORM_LABELS[entry.platform] : entry.target) })),
    // A hosted preview lasts as long as its EAS Hosting deployment; Explore sets no expiry of its own.
    expiresAt: null };
}
const PLATFORM_LABELS: Record<PreviewPlatform, string> = { ios: "iOS", android: "Android" };

/** `platform=<id>` for a target named after its platform (links from before targets), `target=<id>` otherwise. */
function targetQuery(target: string): string {
  return `${target === "ios" || target === "android" ? "platform" : "target"}=${target}`;
}

/**
 * Start the manifest download while the Viewer bundle is still loading: `crossorigin` makes the preload match
 * the Viewer's same-origin `fetch`, so the bytes arrive once.
 */
export function shellWithPreload(indexHtml: string, manifestPath: string): string {
  const link = `<link rel="preload" href="${manifestPath}" as="fetch" crossorigin>`;
  const at = indexHtml.indexOf("</head>") !== -1 ? indexHtml.indexOf("</head>") : indexHtml.indexOf("<script");
  return at === -1 ? indexHtml : `${indexHtml.slice(0, at)}${link}${indexHtml.slice(at)}`;
}

/** The agent index as the shell's initial `#root` content; the Viewer replaces it when it renders. */
export function shellWithIndex(indexHtml: string, indexBlock: string): string {
  const root = '<div id="root"></div>';
  if (indexHtml.includes(root)) return indexHtml.replace(root, `<div id="root">${indexBlock}</div>`);
  const body = indexHtml.lastIndexOf("</body>");
  return body === -1 ? indexHtml : `${indexHtml.slice(0, body)}${indexBlock}${indexHtml.slice(body)}`;
}

/**
 * One target's manifest for the Viewer. A kept one is answered from memory; otherwise the static file streams through
 * unparsed, so a prefetch of every target costs the isolate almost no CPU.
 */
async function manifestResponse(origin: string, report: PreviewReport, options: PreviewRequestOptions): Promise<Response> {
  const headers = baseHeaders("application/json; charset=utf-8");
  const kept = (options.cache ?? manifestCache).get(`${origin}${report.path}`);
  if (kept) return new Response(kept.bytes as BodyInit, { headers });
  const upstream = await staticFile(origin, report.path, options);
  if (upstream === "unavailable") return previewUnavailable();
  if (!upstream) return previewNotFound();
  return new Response(upstream.body, { headers });
}

/** A static file of this deployment: "unavailable" when it cannot be fetched now, undefined when it is not there. */
async function staticFile(origin: string, path: string, options: PreviewRequestOptions): Promise<Response | "unavailable" | undefined> {
  let upstream: Response;
  try { upstream = await (options.fetchImpl ?? fetch)(new URL(path, origin).href); }
  catch { return "unavailable"; }
  if (upstream.status >= 500) return "unavailable";
  if (upstream.status !== 200 || !upstream.body) {
    await upstream.body?.cancel();
    return undefined;
  }
  return upstream;
}

/** At most `limit` bytes of a response, or undefined when it has more. */
async function bodyBytes(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel();
    return undefined;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > limit ? undefined : bytes;
}

/** One target's manifest, parsed: from the isolate's cache, or fetched now (requests that arrive together share one fetch). */
async function parsedManifest(origin: string, report: PreviewReport, options: PreviewRequestOptions): Promise<ManifestResult> {
  const cache = options.cache ?? manifestCache;
  const loading = options.loading ?? manifestLoading;
  const key = `${origin}${report.path}`;
  const cached = cache.get(key);
  if (cached) {
    // Most recently used last, so the oldest is the first to go.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let pending = loading.get(key);
  if (!pending) {
    pending = fetchManifest(origin, report, options).catch(() => "unavailable" as const);
    loading.set(key, pending);
    void pending.finally(() => { if (loading.get(key) === pending) loading.delete(key); });
  }
  const parsed = await pending;
  if (parsed && parsed !== "unavailable" && !cache.has(key) && heldBytes(parsed) <= MANIFEST_CACHE_BYTES) {
    let held = heldBytes(parsed);
    for (const kept of cache.values()) held += heldBytes(kept);
    for (const [oldest, kept] of cache) {
      if (held <= MANIFEST_CACHE_BYTES) break;
      cache.delete(oldest);
      held -= heldBytes(kept);
    }
    cache.set(key, parsed);
  }
  return parsed;
}

async function fetchManifest(origin: string, report: PreviewReport, options: PreviewRequestOptions): Promise<ManifestResult> {
  const upstream = await staticFile(origin, report.path, options);
  if (!upstream || upstream === "unavailable") return upstream;
  const bytes = await bodyBytes(upstream, MAX_MANIFEST_BYTES);
  if (!bytes) return undefined;
  // The agent API reads screenshots from the same static files the Viewer does, next to the manifest's target directory.
  const base = new URL(report.path.replace(/\/targets\/[^/]+$/, "/"), origin);
  const loaded = reportFromManifest(bytes, async (name, limit) => {
    const asset = await staticFile(origin, new URL(name, base).pathname, options);
    if (asset === "unavailable") throw new Error(`${name} is unavailable`);
    return asset ? bodyBytes(asset, Math.min(limit, MAX_ASSET_BYTES)) : undefined;
  });
  return loaded ? { bytes, loaded } : undefined;
}

/** Requests the Viewer shell never issues; identical to the token-less answer. */
export function previewUnsupported(): Response {
  return previewNotFound();
}
