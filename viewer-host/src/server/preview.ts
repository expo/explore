/**
 * One hosted preview deployment per review: the Worker gates everything under `/p/<token>` with
 * a token and an expiry sealed into the deployment's environment at deploy time, fetches the
 * AES-256-GCM encrypted report from its own static files, decrypts it with a key that exists
 * only in that environment, and streams it. Static files on the CDN are ciphertext; the Viewer
 * bundle under /viewer/ is public and identical to the central host's.
 */
import { AGENT_API_VERSION, agentApiReply, agentIndexHtml, agentIndexMarkdown, loadReport, prefersHtml, type AgentContext, type LoadedReport } from "../../../src/report/agent-api";

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
  /** Decrypted and parsed reports by path, kept for the life of the isolate; defaults to a module-level cache. */
  cache?: Map<string, Promise<LoadedReport | undefined>>;
};

const ROUTE = /^\/p\/([a-z2-7]{32})(?:\/|\/(report\.zip|reports\.json|llms\.txt)|(\/api\/v1(?:\/[A-Za-z0-9._:@-]{1,200}){0,2}\/?))?$/;
const reportCache = new Map<string, Promise<LoadedReport | undefined>>();

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
  const route = match[2] ?? (match[3] ? "api" : undefined);
  const expired = config.expiresAt !== null && (options.now ?? Date.now)() >= config.expiresAt;
  const pageUrl = `${url.origin}/p/${config.token}`;
  const linkHeader = `<${pageUrl}/api/${AGENT_API_VERSION}>; rel="alternate"; type="application/json", <${pageUrl}/llms.txt>; rel="alternate"; type="text/markdown"`;
  const accept = request.headers.get("accept");
  if (route === undefined && prefersHtml(accept)) {
    const headers = baseHeaders("text/html; charset=utf-8");
    headers.set("Link", linkHeader);
    headers.set("Vary", "Accept");
    if (expired) return new Response(options.indexHtml, { headers });
    const loaded = await loadedReport(url.origin, selectReport(config, url), config, options);
    return new Response(loaded ? shellWithIndex(options.indexHtml, agentIndexHtml(agentContext(pageUrl, config, loaded.report), loaded.loaded)) : options.indexHtml, { headers });
  }
  if (expired) return previewExpired(config.expiresAt!);
  if (route === "reports.json") {
    const body = JSON.stringify(config.reports.map(({ path: _path, ...report }) => report));
    return new Response(body, { headers: baseHeaders("application/json; charset=utf-8") });
  }
  const report = selectReport(config, url);
  if (!report) return previewNotFound();
  if (route === "report.zip") return decryptedReport(url.origin, report.path, config, options);
  const loaded = await loadedReport(url.origin, report, config, options);
  if (!loaded) {
    if (route !== undefined) return previewNotFound();
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

/** The agent index as the shell's initial `#root` content; the Viewer replaces it when it renders. */
export function shellWithIndex(indexHtml: string, indexBlock: string): string {
  const root = '<div id="root"></div>';
  if (indexHtml.includes(root)) return indexHtml.replace(root, `<div id="root">${indexBlock}</div>`);
  const body = indexHtml.lastIndexOf("</body>");
  return body === -1 ? indexHtml : `${indexHtml.slice(0, body)}${indexBlock}${indexHtml.slice(body)}`;
}

async function loadedReport(origin: string, report: PreviewReport | undefined, config: PreviewConfig, options: PreviewRequestOptions): Promise<{ report: PreviewReport; loaded: LoadedReport } | undefined> {
  if (!report) return undefined;
  const cache = options.cache ?? reportCache;
  const key = `${origin}${report.path}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = decryptedBytes(origin, report.path, config, options).then(bytes => (bytes ? loadReport(bytes) : undefined));
    cache.set(key, pending);
    pending.then(loaded => { if (!loaded) cache.delete(key); }, () => cache.delete(key));
  }
  const loaded = await pending;
  return loaded ? { report, loaded } : undefined;
}

async function decryptedBytes(origin: string, reportPath: string, config: PreviewConfig, options: PreviewRequestOptions): Promise<Uint8Array | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const subtle = options.subtle ?? crypto.subtle;
  const upstream = await fetchImpl(new URL(reportPath, origin).href, { headers: { accept: "application/octet-stream" } });
  if (upstream.status !== 200 || !upstream.body) return undefined;
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (declared > MAX_REPORT_BYTES + PREVIEW_CIPHER.ivBytes + 16) return undefined;
  const sealed = new Uint8Array(await upstream.arrayBuffer());
  if (sealed.byteLength <= PREVIEW_CIPHER.ivBytes + 16 || sealed.byteLength > MAX_REPORT_BYTES + PREVIEW_CIPHER.ivBytes + 16) return undefined;
  try {
    const key = await subtle.importKey("raw", config.key, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt(
      { name: "AES-GCM", iv: sealed.subarray(0, PREVIEW_CIPHER.ivBytes), additionalData: new TextEncoder().encode(PREVIEW_CIPHER.aad) },
      key, sealed.subarray(PREVIEW_CIPHER.ivBytes)));
  } catch { return undefined; }
}

async function decryptedReport(origin: string, reportPath: string, config: PreviewConfig, options: PreviewRequestOptions): Promise<Response> {
  const plain = await decryptedBytes(origin, reportPath, config, options);
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
