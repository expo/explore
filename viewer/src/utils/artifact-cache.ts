/** Optional, origin-local storage for report ZIPs the reviewer dropped on this browser. */
type ArtifactIdentity = { origin?: "local"; repo: string; run: string; attempt: string; target?: string };
export type CachedArtifact = { blob: Blob; digest: string; expiresAt: number };

const CACHE_NAME = "explore-reports";
const CACHE_PATH = "/.explore/report-cache/v1";
/** Reports the retired download proxy stored; removed once so no stale copy lingers. */
const LEGACY_CACHE_NAME = "explore-artifacts-public";
const MAX_ENTRIES = 4;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const STORAGE_TIMEOUT = 1200;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
// One run attempt produces exactly one report, so the artifact id adds nothing to the key.
const IDENTITY_KEYS = ["repo", "run", "attempt"] as const;
const HEADER = {
  digest: "X-Explore-Cache-Digest", bytes: "X-Explore-Cache-Bytes",
  storedAt: "X-Explore-Cache-Stored-At", expiresAt: "X-Explore-Cache-Expires-At",
  accessedAt: "X-Explore-Cache-Accessed-At",
} as const;

type Metadata = { digest: string; bytes: number; storedAt: number; expiresAt: number; accessedAt: number };
let localQueue: Promise<unknown> = Promise.resolve();
let legacyRemoved = false;

function cacheKey(identity: ArtifactIdentity): string | undefined {
  if (!identity || typeof identity.repo !== "string"
    || !/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(identity.repo)
    || identity.repo.split("/").some(part => part === "." || part === "..")
    || (identity.origin === "local" ? !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(identity.run) || identity.attempt !== "1"
      : [identity.run, identity.attempt].some(value => typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)))) return undefined;
  const origin = globalThis.location?.origin;
  if (!origin || !/^https?:\/\//.test(origin)) return undefined;
  const url = new URL(CACHE_PATH, origin);
  if (identity.target !== undefined && !targetId(identity.target)) return undefined;
  // A target named after its platform keeps the `platform` key reports were saved under before targets.
  url.search = new URLSearchParams({ ...(identity.origin ? { origin: identity.origin } : {}), repo: identity.repo.toLowerCase(), run: identity.run, attempt: identity.attempt,
    ...(identity.target ? { [identity.target === "ios" || identity.target === "android" ? "platform" : "target"]: identity.target } : {}) }).toString();
  return url.href;
}

/** The capture target grammar (isReportTargetId in artifact-report, which imports this module). */
function targetId(value: unknown): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value) && !["base", "head", "report"].includes(value) && !value.startsWith("install-");
}

function validKey(request: Request): boolean {
  if (request.method !== "GET") return false;
  try {
    const url = new URL(request.url);
    const local = url.searchParams.get("origin") === "local";
    const target = [...url.searchParams.getAll("platform"), ...url.searchParams.getAll("target")];
    if (target.length > 1 || (target[0] !== undefined && !targetId(target[0]))) return false;
    if ([...url.searchParams].length !== IDENTITY_KEYS.length + (local ? 1 : 0) + target.length) return false;
    const identity: ArtifactIdentity = { ...(local ? { origin: "local" } : {}), ...(target[0] ? { target: target[0] } : {}) } as ArtifactIdentity;
    for (const key of IDENTITY_KEYS) {
      const values = url.searchParams.getAll(key);
      if (values.length !== 1) return false;
      identity[key] = values[0]!;
    }
    return cacheKey(identity) === request.url;
  } catch { return false; }
}

function metadata(response: Response, now: number): Metadata | undefined {
  const digest = response.headers.get(HEADER.digest);
  if (response.status !== 200 || !digest || !DIGEST.test(digest)) return undefined;
  const values = {} as Omit<Metadata, "digest">;
  for (const key of ["bytes", "storedAt", "expiresAt", "accessedAt"] as const) {
    const raw = response.headers.get(HEADER[key]);
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return undefined;
    values[key] = value;
  }
  if (values.bytes > MAX_BYTES || values.storedAt > now || values.accessedAt < values.storedAt
    || values.accessedAt > now || values.expiresAt <= now || values.expiresAt > values.storedAt + MAX_AGE) return undefined;
  return { ...values, digest };
}

function responseFor(blob: Blob, value: Metadata): Response {
  const headers = new Headers({ "Content-Type": "application/zip" });
  for (const key of Object.keys(HEADER) as Array<keyof typeof HEADER>) headers.set(HEADER[key], String(value[key]));
  return new Response(blob, { headers });
}

function check(signal: AbortSignal): void {
  signal.throwIfAborted();
}

/** CacheStorage is an optimization: denied, full, and stalled storage never blocks a report. */
async function optionalStorage<T>(fallback: T, operation: (cache: Cache, signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!globalThis.caches) return fallback;
    if (!legacyRemoved) {
      legacyRemoved = true;
      void globalThis.caches.delete(LEGACY_CACHE_NAME).catch(() => false);
    }
    const run = async () => {
      check(controller.signal);
      const cache = await globalThis.caches.open(CACHE_NAME);
      check(controller.signal);
      return operation(cache, controller.signal);
    };
    // Serialize mutations across tabs when available, and within this document otherwise.
    // Keep the lock until an outstanding storage call settles, even if the caller times out.
    const pending = globalThis.navigator?.locks
      ? navigator.locks.request(CACHE_NAME, { signal: controller.signal }, run)
      : localQueue.then(run);
    if (!globalThis.navigator?.locks) localQueue = pending.catch(() => undefined);
    return await Promise.race([pending, new Promise<T>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(fallback); }, STORAGE_TIMEOUT);
    })]);
  } catch { return fallback; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Archive digests and contents are verified by the report loader before use. */
export async function getCachedArtifact(identity: ArtifactIdentity): Promise<CachedArtifact | undefined> {
  const key = cacheKey(identity);
  if (!key) return undefined;
  return optionalStorage<CachedArtifact | undefined>(undefined, async (cache, signal) => {
    const response = await cache.match(key);
    check(signal);
    if (!response) return undefined;
    const value = metadata(response, Date.now());
    if (!value) { await cache.delete(key); return undefined; }
    const blob = await response.blob();
    check(signal);
    if (blob.size !== value.bytes || value.expiresAt <= Date.now()) { await cache.delete(key); return undefined; }
    // Updating usage must not turn a valid hit into a miss if the browser becomes full.
    try { await cache.put(key, responseFor(blob, { ...value, accessedAt: Date.now() })); }
    catch { /* Keep serving the already-read, validated entry. */ }
    check(signal);
    return { blob, digest: value.digest, expiresAt: value.expiresAt };
  });
}

/** Call only after the loader has opened the archive and confirmed its report identity. */
export async function putCachedArtifact(identity: ArtifactIdentity, artifact: CachedArtifact): Promise<void> {
  const key = cacheKey(identity);
  if (!key || !artifact || !(artifact.blob instanceof Blob) || artifact.blob.size <= 0
    || artifact.blob.size > MAX_BYTES || !DIGEST.test(artifact.digest)
    || !Number.isSafeInteger(artifact.expiresAt) || artifact.expiresAt <= Date.now()) return;
  await optionalStorage(undefined, async (cache, signal) => {
    const now = Date.now();
    if (artifact.expiresAt <= now) return undefined;
    const entries: Array<{ request: Request; value: Metadata }> = [];
    for (const request of await cache.keys()) {
      check(signal);
      const response = await cache.match(request);
      check(signal);
      const value = response && metadata(response, now);
      if (!validKey(request) || !value) { await cache.delete(request); continue; }
      if (request.url !== key) entries.push({ request, value });
    }
    entries.sort((a, b) => a.value.accessedAt - b.value.accessedAt
      || a.value.storedAt - b.value.storedAt || a.request.url.localeCompare(b.request.url));
    let bytes = entries.reduce((total, entry) => total + entry.value.bytes, 0);
    while (entries.length >= MAX_ENTRIES || bytes + artifact.blob.size > MAX_BYTES) {
      check(signal);
      const oldest = entries.shift();
      if (!oldest) break;
      await cache.delete(oldest.request);
      bytes -= oldest.value.bytes;
    }
    check(signal);
    await cache.put(key, responseFor(artifact.blob, { digest: artifact.digest, bytes: artifact.blob.size,
      storedAt: now, accessedAt: now, expiresAt: Math.min(artifact.expiresAt, now + MAX_AGE) }));
    return undefined;
  });
}

export async function deleteCachedArtifact(identity: ArtifactIdentity): Promise<void> {
  const key = cacheKey(identity);
  if (!key) return;
  await optionalStorage(undefined, async (cache, signal) => {
    check(signal);
    await cache.delete(key);
    return undefined;
  });
}
