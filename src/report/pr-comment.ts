/** Marks the single PR comment that Explore creates and later updates in place. */
export const CI_COMMENT_MARKER = "<!-- expo-explore-ci -->";

export type StickyCommentResult = {
  operation: "created" | "updated";
  commentId: number;
  url?: string;
  /** The sticky comment's body before this write, when one existed. */
  previousBody?: string;
};

export type StickyCommentOptions = {
  repository: string;
  issueNumber: number;
  body: string;
  /** Derives the body to write from the existing sticky comment (undefined when none): platform sections. */
  merge?: (existingBody: string | undefined) => string;
  token: string;
  authorLogin?: string;
  apiUrl?: string;
  trustedApiOrigin?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type ExistingComment = {
  id: number;
  body: string;
  authorLogin?: string;
  url?: string;
};

type JsonRequestResult = {
  response: Response;
  value?: unknown;
};

type RequestAttempt =
  | { kind: "success"; response: Response; value: unknown }
  | { kind: "http-error"; response: Response }
  | { kind: "invalid-json" }
  | { kind: "network-error" }
  | { kind: "timeout" };

const PUBLIC_GITHUB_API_ORIGIN = "https://api.github.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_TRANSIENT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryPath(value: string): string {
  const segments = value.split("/");
  if (
    segments.length !== 2
    || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "." || segment === "..")
  ) {
    throw new Error("repository must use the owner/name form");
  }
  return segments.map(encodeURIComponent).join("/");
}

function trustedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("trustedApiOrigin must be a valid absolute URL origin");
  }
  if (url.protocol !== "https:") {
    throw new Error("trustedApiOrigin must use https");
  }
  if (url.username || url.password) {
    throw new Error("trustedApiOrigin must not contain URL credentials");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("trustedApiOrigin must contain only an HTTPS origin");
  }
  return url.origin;
}

function apiBase(value: string, explicitTrustedOrigin?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("apiUrl must be a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("apiUrl must use https");
  }
  if (url.username || url.password) {
    throw new Error("apiUrl must not contain URL credentials");
  }
  if (url.search || url.hash) {
    throw new Error("apiUrl must not contain a query string or fragment");
  }
  if (explicitTrustedOrigin !== undefined) {
    if (url.origin !== trustedOrigin(explicitTrustedOrigin)) {
      throw new Error("apiUrl origin must match trustedApiOrigin");
    }
  } else if (url.origin !== PUBLIC_GITHUB_API_ORIGIN) {
    throw new Error("custom apiUrl requires an explicit matching trustedApiOrigin");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  return timeout;
}

function parseComment(value: unknown, label: string): ExistingComment {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.body !== "string") {
    throw new Error(`GitHub returned an invalid ${label}`);
  }
  const authorLogin = isRecord(value.user) && typeof value.user.login === "string"
    ? value.user.login
    : undefined;
  const url = typeof value.html_url === "string" ? value.html_url : undefined;
  return {
    id: Number(value.id),
    body: value.body,
    ...(authorLogin ? { authorLogin } : {}),
    ...(url ? { url } : {}),
  };
}

function parseCommentPage(value: unknown): ExistingComment[] {
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid comment list");
  return value.map((comment) => parseComment(comment, "comment list entry"));
}

function parseMutationComment(value: unknown): { id: number; url?: string } {
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) {
    throw new Error("GitHub returned an invalid comment response");
  }
  const url = typeof value.html_url === "string" ? value.html_url : undefined;
  return { id: Number(value.id), ...(url ? { url } : {}) };
}

function responseError(response: Response): Error {
  return new Error(`GitHub comment request failed with HTTP ${response.status}`);
}

function isTransientResponse(response: Response): boolean {
  if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) return true;
  return response.status === 403 && (
    response.headers.has("retry-after")
    || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

function retryDelayMs(response: Response | undefined, retry: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1_000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(100 * (2 ** retry), MAX_RETRY_DELAY_MS);
}

async function wait(ms: number): Promise<void> {
  if (ms === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function requestAttempt(
  request: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<RequestAttempt> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RequestAttempt>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const operation = (async (): Promise<RequestAttempt> => {
    try {
      const response = await request(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return { kind: "http-error", response };
      try {
        return { kind: "success", response, value: await response.json() };
      } catch {
        return { kind: controller.signal.aborted ? "timeout" : "invalid-json" };
      }
    } catch {
      return { kind: controller.signal.aborted ? "timeout" : "network-error" };
    }
  })();
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function requestJson(
  request: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  retryable: boolean,
): Promise<JsonRequestResult> {
  const retries = retryable ? MAX_TRANSIENT_RETRIES : 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await requestAttempt(request, url, init, timeoutMs);
    if (result.kind === "success") {
      return { response: result.response, value: result.value };
    }
    if (result.kind === "invalid-json") {
      throw new Error("GitHub returned a non-JSON comment response");
    }
    if (result.kind === "http-error") {
      if (!isTransientResponse(result.response) || attempt === retries) {
        return { response: result.response };
      }
      await wait(retryDelayMs(result.response, attempt));
      continue;
    }
    if (attempt === retries) {
      if (result.kind === "timeout") {
        throw new Error(`GitHub comment request timed out after ${timeoutMs}ms`);
      }
      throw new Error("GitHub comment request failed after a network error");
    }
    await wait(retryDelayMs(undefined, attempt));
  }
  throw new Error("GitHub comment request exhausted its retry limit");
}

/** Upsert one marker-owned issue comment through GitHub's pull-request comment API. */
function assertCommentBody(body: string): void {
  if (body !== CI_COMMENT_MARKER && !body.startsWith(`${CI_COMMENT_MARKER}\n`)) {
    throw new Error(`body must begin with ${CI_COMMENT_MARKER}`);
  }
  if (body.length > 65_536) {
    throw new Error("body exceeds GitHub's 65,536-character comment limit");
  }
}

export async function upsertStickyComment(
  options: StickyCommentOptions,
): Promise<StickyCommentResult> {
  const repository = repositoryPath(options.repository);
  if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber <= 0) {
    throw new Error("issueNumber must be a positive integer");
  }
  assertCommentBody(options.body);
  if (!options.token || options.token.trim() !== options.token) {
    throw new Error("token must be a non-empty value without surrounding whitespace");
  }
  const authorLogin = options.authorLogin ?? "github-actions[bot]";
  if (!authorLogin.trim()) throw new Error("authorLogin must not be empty");
  const base = apiBase(
    options.apiUrl ?? `${PUBLIC_GITHUB_API_ORIGIN}/`,
    options.trustedApiOrigin,
  );
  const timeoutMs = requestTimeout(options.requestTimeoutMs);
  const request = options.fetchImpl ?? fetch;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  let existing: ExistingComment | undefined;
  for (let page = 1; page <= 100; page += 1) {
    const listUrl = new URL(`repos/${repository}/issues/${options.issueNumber}/comments`, base);
    listUrl.searchParams.set("per_page", "100");
    listUrl.searchParams.set("page", String(page));
    const result = await requestJson(request, listUrl, { method: "GET", headers }, timeoutMs, true);
    if (!result.response.ok) throw responseError(result.response);
    const comments = parseCommentPage(result.value);
    existing = comments.find((comment) => (
      comment.authorLogin === authorLogin
      && (
        comment.body === CI_COMMENT_MARKER
        || comment.body.startsWith(`${CI_COMMENT_MARKER}\n`)
      )
    ));
    const hasNextLink = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:\s*;|\s*,|$)/i.test(
      result.response.headers.get("link") ?? "",
    );
    if (existing || (!hasNextLink && comments.length < 100)) break;
  }

  const body = options.merge ? options.merge(existing?.body) : options.body;
  if (options.merge) assertCommentBody(body);
  const endpoint = existing
    ? new URL(`repos/${repository}/issues/comments/${existing.id}`, base)
    : new URL(`repos/${repository}/issues/${options.issueNumber}/comments`, base);
  const result = await requestJson(request, endpoint, {
    method: existing ? "PATCH" : "POST",
    headers,
    body: JSON.stringify({ body }),
  }, timeoutMs, existing !== undefined);
  if (!result.response.ok) throw responseError(result.response);
  const comment = parseMutationComment(result.value);
  return {
    operation: existing ? "updated" : "created",
    commentId: comment.id,
    ...(comment.url ? { url: comment.url } : {}),
    ...(existing ? { previousBody: existing.body } : {}),
  };
}

/** The current sticky comment's body for an issue, or undefined when Explore has not commented yet. */
export async function readStickyComment(options: Omit<StickyCommentOptions, "body" | "merge">): Promise<string | undefined> {
  const repository = repositoryPath(options.repository);
  if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber <= 0) throw new Error("issueNumber must be a positive integer");
  if (!options.token || options.token.trim() !== options.token) throw new Error("token must be a non-empty value without surrounding whitespace");
  const authorLogin = options.authorLogin ?? "github-actions[bot]";
  const base = apiBase(options.apiUrl ?? `${PUBLIC_GITHUB_API_ORIGIN}/`, options.trustedApiOrigin);
  const timeoutMs = requestTimeout(options.requestTimeoutMs);
  const request = options.fetchImpl ?? fetch;
  const headers = { accept: "application/vnd.github+json", authorization: `Bearer ${options.token}`, "x-github-api-version": "2022-11-28" };
  for (let page = 1; page <= 100; page += 1) {
    const listUrl = new URL(`repos/${repository}/issues/${options.issueNumber}/comments`, base);
    listUrl.searchParams.set("per_page", "100"); listUrl.searchParams.set("page", String(page));
    const result = await requestJson(request, listUrl, { method: "GET", headers }, timeoutMs, true);
    if (!result.response.ok) throw responseError(result.response);
    const comments = parseCommentPage(result.value);
    const existing = comments.find(comment => comment.authorLogin === authorLogin
      && (comment.body === CI_COMMENT_MARKER || comment.body.startsWith(`${CI_COMMENT_MARKER}\n`)));
    if (existing) return existing.body;
    const hasNextLink = /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:\s*;|\s*,|$)/i.test(result.response.headers.get("link") ?? "");
    if (!hasNextLink && comments.length < 100) return undefined;
  }
  return undefined;
}
