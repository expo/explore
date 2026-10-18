/**
 * One hosted preview deployment per review: the Worker gates everything under `/p/<token>` with
 * a token and an expiry sealed into the deployment's environment at deploy time, fetches the
 * AES-256-GCM encrypted report from its own static files, decrypts it with a key that exists
 * only in that environment, and streams it. Static files on the CDN are ciphertext; the Viewer
 * bundle under /viewer/ is public and identical to the central host's.
 */
import { AGENT_API_VERSION, agentApiReply, agentIndexHtml, agentIndexMarkdown, loadReport, prefersHtml, type AgentContext, type LoadedReport } from "../../../src/report/agent-api";
import { manifestBody, previewAsset } from "../../../src/report/preview-manifest";

export type PreviewEnvironment = {
  /** Lowercase base32 path token the review comment links to. */
  EXPLORE_PREVIEW_TOKEN?: string | undefined;
  /** Base64 32-byte AES-GCM key. */
  EXPLORE_PREVIEW_KEY?: string | undefined;
  /** ISO 8601 instant after which the report routes answer 410 and the token page says the link expired; unset: never. */
  EXPLORE_PREVIEW_EXPIRES_AT?: string | undefined;
  /** Absolute path of the encrypted report inside this deployment, e.g. /_report/<id>/report.zip.enc (single-report deployments). */
  EXPLORE_PREVIEW_REPORT?: string | undefined;
  /**
   * JSON, one entry per capture target in config order:
   * `[{"target":"duo-open","platform":"ios","label":"iPhone Duo (open)","path":"/_report/<id>/duo-open.zip.enc","changes":3,"device":"iPhone Duo 26.0"}]`.
   * Deployments from before targets list `{"platform":"ios","path":"/_report/<id>/ios.zip.enc",…}`: the target is the platform.
   * Set instead of EXPLORE_PREVIEW_REPORT by deployments that serve several reports (or one that is not iOS).
   */
  EXPLORE_PREVIEW_REPORTS?: string | undefined;
};

export type PreviewPlatform = "ios" | "android";
/** `target` names the report (and its file, `<target>.zip.enc`); `platform` is the device's. */
export type PreviewReport = { target: string; platform: PreviewPlatform; label?: string; path: string; changes?: number; device?: string };
export type PreviewConfig = { token: string; key: Uint8Array<ArrayBuffer>; expiresAt: number | null; reports: PreviewReport[] };

export const PREVIEW_TOKEN = /^[a-z2-7]{32}$/;
/** A capture target id, as the CLI's isTargetId accepts it: the Worker does not bundle the config reader. */
const TARGET_ID = /^[a-z][a-z0-9-]{0,31}$/;
export function isPreviewTargetId(value: unknown): value is string {
  return typeof value === "string" && TARGET_ID.test(value) && !["base", "head", "report"].includes(value) && !value.startsWith("install-");
}
const REPORT_PATH = /^\/_report\/[a-z2-7]{16,64}\/(report|[a-z][a-z0-9-]{0,31})\.zip\.enc$/;
const PLATFORMS: readonly PreviewPlatform[] = ["ios", "android"];
/** As many targets as a config may name. */
export const MAX_PREVIEW_REPORTS = 8;
const PLAIN_TEXT = /[\u0000-\u001f\u007f<>[\]]/;

/**
 * The report list, strictly shaped: an unknown platform, an invalid or repeated target, a path that is not
 * `<target>.zip.enc`, an odd label or device, or extra keys reject the whole configuration.
 */
function parseReports(env: PreviewEnvironment): PreviewReport[] | undefined {
  if (env.EXPLORE_PREVIEW_REPORTS === undefined) {
    const reportPath = env.EXPLORE_PREVIEW_REPORT ?? "";
    return REPORT_PATH.test(reportPath) ? [{ target: "ios", platform: "ios", path: reportPath }] : undefined;
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
    if (typeof path !== "string" || REPORT_PATH.exec(path)?.[1] !== target) return undefined;
    if (changes !== undefined && (typeof changes !== "number" || !Number.isInteger(changes) || changes < 0 || changes > 100_000)) return undefined;
    if (device !== undefined && (typeof device !== "string" || device.length > 120 || PLAIN_TEXT.test(device))) return undefined;
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 80 || PLAIN_TEXT.test(label))) return undefined;
    if (reports.some(report => report.target === target)) return undefined;
    reports.push({ target, platform: platform as PreviewPlatform, ...(label === undefined ? {} : { label }), path,
      ...(changes === undefined ? {} : { changes }), ...(device === undefined ? {} : { device }) });
  }
  return reports;
}
/** 12-byte IV followed by the AES-GCM ciphertext and tag; `aad` binds the bytes to this format. */
export const PREVIEW_CIPHER = { ivBytes: 12, aad: "expo-explore-preview/1" } as const;
const MAX_REPORT_BYTES = 256 * 1024 * 1024;

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch { return undefined; }
}

/** The deployment's sealed configuration, or undefined when any value is missing or malformed. */
export function previewConfig(env: PreviewEnvironment): PreviewConfig | undefined {
  const token = env.EXPLORE_PREVIEW_TOKEN ?? "";
  const key = decodeBase64(env.EXPLORE_PREVIEW_KEY ?? "");
  const expiresAt = env.EXPLORE_PREVIEW_EXPIRES_AT === undefined ? null : Date.parse(env.EXPLORE_PREVIEW_EXPIRES_AT);
  const reports = parseReports(env);
  if (!PREVIEW_TOKEN.test(token) || !key || key.byteLength !== 32 || (expiresAt !== null && !Number.isFinite(expiresAt)) || !reports) return undefined;
  return { token, key, expiresAt, reports };
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

/** After the sealed expiry the token page still opens, and the report routes say so instead of serving. */
export function previewExpired(expiredAt: number): Response {
  return new Response(JSON.stringify({ error: "expired", expiredAt: new Date(expiredAt).toISOString() }), { status: 410, headers: baseHeaders("application/json; charset=utf-8") });
}

/** Constant-time comparison of two equal-length ASCII tokens. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

export type PreviewRequestOptions = {
  env: PreviewEnvironment;
  indexHtml: string;
  now?: () => number;
  /** Same-deployment fetch of static files; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  subtle?: SubtleCrypto;
  /** Decrypted and parsed reports by path, least recently used first, within HELD_REPORT_BYTES; defaults to a module-level cache. */
  cache?: Map<string, LoadedReport>;
  /** Decrypts in flight by path, shared by the requests that wait for them; defaults to a module-level map. */
  loading?: Map<string, Promise<LoadResult>>;
  /** Reports too large to decrypt in this isolate, by path; defaults to a module-level set. */
  oversized?: Set<string>;
  /** Bytes of decrypted reports kept, and of kept reports plus one decrypt; default to HELD_REPORT_BYTES and DECRYPT_PEAK_BYTES. */
  budget?: { held: number; peak: number };
  /** Manifest bodies by path, kept for the life of the isolate; defaults to a module-level cache. */
  manifests?: Map<string, string>;
};

const ROUTE = /^\/p\/([a-z2-7]{32})(?:\/|\/(report\.zip|reports\.json|manifest\.json|llms\.txt)|(\/api\/v1(?:\/[A-Za-z0-9._:@-]{1,200}){0,2}\/?)|\/assets\/([a-f0-9]{64}\.(?:png|jpg|mp4)))?$/;
/**
 * Content-addressed and token-gated: this browser may keep an asset until the link expires, and for a week at most (as
 * long as the Viewer kept a whole report in Cache Storage before assets were served one by one); shared caches may not.
 */
const MAX_ASSET_AGE_SECONDS = 7 * 24 * 60 * 60;
function assetCacheControl(expiresAt: number | null, now: number): string {
  const untilExpiry = expiresAt === null ? MAX_ASSET_AGE_SECONDS : Math.floor((expiresAt - now) / 1000);
  return `private, max-age=${Math.max(0, Math.min(MAX_ASSET_AGE_SECONDS, untilExpiry))}, immutable`;
}
/**
 * An isolate has 128 MB. It keeps decrypted reports, least recently used first, within HELD_REPORT_BYTES, and every
 * target's manifest (a few MB each at most). Decrypting needs the ciphertext and the plaintext at once, so decrypts run
 * one at a time, and before each one older reports go until the two fit in DECRYPT_PEAK_BYTES with what is kept. A
 * report too large to keep is decrypted for each request; one too large to decrypt (about 45 MB) answers 413, and the
 * isolate remembers it so it does not fetch it again.
 */
const HELD_REPORT_BYTES = 60 * 1024 * 1024;
const DECRYPT_PEAK_BYTES = 90 * 1024 * 1024;
/** A decrypted report, or why there is none: "unavailable" this time (the Viewer retries), "too-large" for this isolate, undefined never. */
type LoadResult = LoadedReport | "unavailable" | "too-large" | undefined;
const reportCache = new Map<string, LoadedReport>();
const reportLoading = new Map<string, Promise<LoadResult>>();
const manifestCache = new Map<string, string>();
const oversizedReports = new Set<string>();
let decrypting: Promise<unknown> = Promise.resolve();

/**
 * `GET /p/<token>` serves the Viewer shell to browsers and the report's Markdown index to anything
 * that does not ask for HTML (agents fetch with `Accept: text/markdown` or `*​/*`); the shell itself
 * carries that index as text inside `#root` until the Viewer hydrates, and a `Link` header names the
 * JSON API. `GET /p/<token>/report.zip` streams the decrypted report (`?target=`, or `?platform=` in older
 * links, selects one of several; the first listed otherwise), `GET /p/<token>/reports.json` lists the targets the
 * deployment serves, `GET /p/<token>/llms.txt` is the Markdown index, and `GET /p/<token>/api/v1/...`
 * answers the agent API (see agent-api.ts). Every other method, path, or token is an identical 404,
 * so the response never confirms that a deployment or token exists. After the sealed expiry the exact
 * token still opens the Viewer shell, and the report routes answer 410 with the expiry instant, so the
 * Viewer can say the link expired rather than guess.
 */
export async function previewResponse(request: Request, options: PreviewRequestOptions): Promise<Response> {
  const config = previewConfig(options.env);
  if (!config) return previewNotFound();
  if (request.method !== "GET") return previewNotFound();
  const url = new URL(request.url);
  const match = ROUTE.exec(url.pathname);
  if (!match || !sameToken(match[1]!, config.token)) return previewNotFound();
  const route = match[2] ?? (match[3] ? "api" : match[4] ? "asset" : undefined);
  const expired = config.expiresAt !== null && (options.now ?? Date.now)() >= config.expiresAt;
  const pageUrl = `${url.origin}/p/${config.token}`;
  const linkHeader = `<${pageUrl}/api/${AGENT_API_VERSION}>; rel="alternate"; type="application/json", <${pageUrl}/llms.txt>; rel="alternate"; type="text/markdown"`;
  const accept = request.headers.get("accept");
  if (route === undefined && prefersHtml(accept)) {
    const headers = baseHeaders("text/html; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    if (expired) return new Response(options.indexHtml, { headers });
    const selected = selectReport(config, url);
    const loaded = await loadedReport(url.origin, selected, config, options);
    if (!loaded || typeof loaded === "string") return new Response(options.indexHtml, { headers });
    const shell = shellWithIndex(options.indexHtml, agentIndexHtml(agentContext(pageUrl, config, loaded.report), loaded.loaded));
    // The same URL the Viewer will fetch for this page: its target's query when the link names one, none otherwise.
    const requested = url.searchParams.get("target") ?? url.searchParams.get("platform");
    return new Response(shellWithPreload(shell, `/p/${config.token}/manifest.json${requested ? `?${targetQuery(requested)}` : ""}`), { headers });
  }
  if (expired) return previewExpired(config.expiresAt!);
  if (route === "reports.json") {
    const body = JSON.stringify(config.reports.map(({ path: _path, ...report }) => report));
    return new Response(body, { headers: baseHeaders("application/json; charset=utf-8") });
  }
  const report = selectReport(config, url);
  if (!report) return previewNotFound();
  if (route === "report.zip") return decryptedReport(url.origin, report.path, config, options);
  if (route === "manifest.json") {
    const body = await manifestFor(url.origin, report, config, options);
    if (body === "unavailable") return previewUnavailable();
    if (body === "too-large") return previewTooLarge();
    return body === undefined ? previewNotFound() : new Response(body, { headers: baseHeaders("application/json; charset=utf-8") });
  }
  const found = await loadedReport(url.origin, report, config, options);
  // The token and the target are right, so a report that cannot be read this time is the Worker's failure, and the Viewer retries.
  if (found === "unavailable" && route === "asset") return previewUnavailable();
  if (found === "too-large" && route === "asset") return previewTooLarge();
  const loaded = typeof found === "string" ? undefined : found;
  if (!loaded) {
    if (route !== undefined) return previewNotFound();
    const headers = baseHeaders("text/html; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    return new Response(options.indexHtml, { headers });
  }
  if (route === "asset") return assetResponse(loaded.loaded, match[4]!, assetCacheControl(config.expiresAt, (options.now ?? Date.now)()));
  const context = agentContext(pageUrl, config, report);
  if (route === undefined || route === "llms.txt") {
    const headers = baseHeaders("text/markdown; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    return new Response(agentIndexMarkdown(context, loaded.loaded), { headers });
  }
  const reply = await agentApiReply(context, loaded.loaded, match[3]!.slice("/api/v1".length).replace(/\/$/, ""), url.searchParams, accept);
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
    expiresAt: config.expiresAt === null ? null : new Date(config.expiresAt).toISOString() };
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

/** The manifest of one target: kept once built, from the isolate's copy of the report or from one it decrypts and lets go. */
async function manifestFor(origin: string, report: PreviewReport, config: PreviewConfig, options: PreviewRequestOptions): Promise<string | "unavailable" | "too-large" | undefined> {
  const manifests = options.manifests ?? manifestCache;
  const key = `${origin}${report.path}`;
  const known = manifests.get(key);
  if (known !== undefined) return known;
  const loaded = await loadedReport(origin, report, config, options, { keep: false });
  if (!loaded || typeof loaded === "string") return loaded;
  const body = manifestBody(loaded.loaded);
  manifests.set(key, body);
  return body;
}

/** A report route that could not read the report this time; the same token and target work once it can. */
function previewUnavailable(): Response {
  const headers = baseHeaders("text/plain; charset=utf-8");
  headers.set("Retry-After", "1");
  return new Response("Unavailable", { status: 503, headers });
}

/** A report this Worker cannot decrypt in an isolate's memory; it never will, so the Viewer says so instead of retrying. */
function previewTooLarge(): Response {
  return new Response(JSON.stringify({ error: "too-large" }), { status: 413, headers: baseHeaders("application/json; charset=utf-8") });
}

/** One asset of the report, inflated from the decrypted ZIP the isolate holds. */
async function assetResponse(loaded: LoadedReport, file: string, cacheControl: string): Promise<Response> {
  const asset = await previewAsset(loaded, `assets/${file}`);
  if (!asset) return previewNotFound();
  const headers = baseHeaders(asset.type);
  headers.set("Cache-Control", cacheControl);
  headers.set("Content-Length", String(asset.bytes.byteLength));
  headers.set("ETag", `"${file.slice(0, 64)}"`);
  return new Response(asset.bytes as BodyInit, { headers });
}

/** The agent index as the shell's initial `#root` content; the Viewer replaces it when it renders. */
export function shellWithIndex(indexHtml: string, indexBlock: string): string {
  const root = '<div id="root"></div>';
  if (indexHtml.includes(root)) return indexHtml.replace(root, `<div id="root">${indexBlock}</div>`);
  const body = indexHtml.lastIndexOf("</body>");
  return body === -1 ? indexHtml : `${indexHtml.slice(0, body)}${indexBlock}${indexHtml.slice(body)}`;
}

/**
 * A report decrypted and parsed, from the isolate's cache or decrypted now; requests for one that is decrypting wait for
 * that decrypt. `keep: false` (a manifest) does not keep a report that is not cached already.
 */
async function loadedReport(origin: string, report: PreviewReport | undefined, config: PreviewConfig, options: PreviewRequestOptions,
  { keep = true }: { keep?: boolean } = {}): Promise<{ report: PreviewReport; loaded: LoadedReport } | "unavailable" | "too-large" | undefined> {
  if (!report) return undefined;
  const cache = options.cache ?? reportCache;
  const loading = options.loading ?? reportLoading;
  const key = `${origin}${report.path}`;
  const oversized = options.oversized ?? oversizedReports;
  if (oversized.has(key)) return "too-large";
  const cached = cache.get(key);
  if (cached) {
    // Most recently used last, so the oldest is the first to go.
    cache.delete(key);
    cache.set(key, cached);
    return { report, loaded: cached };
  }
  let pending = loading.get(key);
  if (!pending) {
    pending = oneAtATime(() => decryptedBytes(origin, report.path, config, options, sealed => makeRoom(cache, 2 * sealed, peak(options))))
      .then<LoadResult, LoadResult>(bytes => (bytes instanceof Uint8Array ? loadReport(bytes) : bytes), () => "unavailable");
    loading.set(key, pending);
    void pending.finally(() => { if (loading.get(key) === pending) loading.delete(key); });
  }
  const loaded = await pending;
  if (loaded === "too-large") oversized.add(key);
  if (!loaded || typeof loaded === "string") return loaded;
  const held = options.budget?.held ?? HELD_REPORT_BYTES;
  if (keep && !cache.has(key) && loaded.zip.byteLength <= held) {
    makeRoom(cache, loaded.zip.byteLength, held);
    cache.set(key, loaded);
  }
  return { report, loaded };
}

/** Lets the oldest kept reports go until `bytes` more fit beside the rest within `budget`; false when they never can. */
function makeRoom(cache: Map<string, LoadedReport>, bytes: number, budget: number): boolean {
  if (bytes > budget) return false;
  let held = 0;
  for (const loaded of cache.values()) held += loaded.zip.byteLength;
  for (const [oldest, loaded] of cache) {
    if (held + bytes <= budget) break;
    cache.delete(oldest);
    held -= loaded.zip.byteLength;
  }
  return true;
}

function peak(options: PreviewRequestOptions): number {
  return options.budget?.peak ?? DECRYPT_PEAK_BYTES;
}

/** Decrypts run one after another, so two of them never need their ciphertext and plaintext at once. */
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = decrypting.then(task, task);
  decrypting = run.catch(() => undefined);
  return run;
}

/**
 * The report's ZIP, decrypted: "unavailable" when its file cannot be fetched now, "too-large" when `reserve` cannot make
 * room to decrypt it, undefined when the file is missing or does not decrypt.
 */
async function decryptedBytes(origin: string, reportPath: string, config: PreviewConfig, options: PreviewRequestOptions,
  reserve: (sealedBytes: number) => boolean = () => true): Promise<Uint8Array | "unavailable" | "too-large" | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const subtle = options.subtle ?? crypto.subtle;
  let upstream: Response;
  try { upstream = await fetchImpl(new URL(reportPath, origin).href, { headers: { accept: "application/octet-stream" } }); }
  catch { return "unavailable"; }
  if (upstream.status >= 500) return "unavailable";
  if (upstream.status !== 200 || !upstream.body) return undefined;
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (declared > MAX_REPORT_BYTES + PREVIEW_CIPHER.ivBytes + 16) return undefined;
  if (declared && !reserve(declared)) {
    await upstream.body.cancel();
    return "too-large";
  }
  const sealed = new Uint8Array(await upstream.arrayBuffer());
  if (sealed.byteLength <= PREVIEW_CIPHER.ivBytes + 16 || sealed.byteLength > MAX_REPORT_BYTES + PREVIEW_CIPHER.ivBytes + 16) return undefined;
  if (!declared && !reserve(sealed.byteLength)) return "too-large";
  try {
    const key = await subtle.importKey("raw", config.key, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt(
      { name: "AES-GCM", iv: sealed.subarray(0, PREVIEW_CIPHER.ivBytes), additionalData: new TextEncoder().encode(PREVIEW_CIPHER.aad) },
      key, sealed.subarray(PREVIEW_CIPHER.ivBytes)));
  } catch { return undefined; }
}

/** The whole decrypted ZIP (downloads, older Viewers), decrypted in turn and within the same budget as every other decrypt. */
async function decryptedReport(origin: string, reportPath: string, config: PreviewConfig, options: PreviewRequestOptions): Promise<Response> {
  const cache = options.cache ?? reportCache;
  const plain = await oneAtATime(() => decryptedBytes(origin, reportPath, config, options, sealed => makeRoom(cache, 2 * sealed, peak(options))));
  if (plain === "unavailable") return previewUnavailable();
  if (plain === "too-large") return previewTooLarge();
  if (!plain) return previewNotFound();
  const headers = baseHeaders("application/zip");
  headers.set("Content-Length", String(plain.byteLength));
  headers.set("Content-Disposition", 'inline; filename="report.zip"');
  return new Response(plain as BodyInit, { headers });
}

/** Requests the Viewer shell never issues; identical to the token-less answer. */
export function previewUnsupported(): Response {
  return previewNotFound();
}
