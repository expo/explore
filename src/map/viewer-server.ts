import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkspacePayload,
  loadBuildWorkspace,
  type LoadedBuildWorkspace,
} from "./build-workspace.js";
import { ExploreError, ExploreStore, getCoverage, validateMap } from "./store.js";
import type { Artifact, BuildWorkspacePayload, Coverage, ExploreMap } from "../types.js";

const DEFAULT_PORT = 4310;
const DEFAULT_HOST = "127.0.0.1";
const ARTIFACT_PREFIX = "/api/artifacts/";
const SESSION_COOKIE_PREFIX = "expo_explore_session_";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export type ViewerServer = {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type ViewerServerOptions = {
  root: string;
  catalog?: string;
  port?: number;
  viewerRoot?: string;
};

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headOnly = false,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": MIME_TYPES[".json"],
    ...headers,
  });
  response.end(headOnly ? undefined : body);
}

async function sendFile(
  response: ServerResponse,
  path: string,
  cacheControl: string,
  headOnly: boolean,
  headers: Record<string, string> = {},
): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new ExploreError(`Viewer asset is not a file: ${path}`);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Cache-Control": cacheControl,
    "Content-Length": info.size,
    "Content-Type": MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    ...headers,
  });
  response.end(headOnly ? undefined : await readFile(path));
}

async function sendVerifiedArtifact(
  response: ServerResponse,
  artifact: Artifact,
  validated: ValidatedArtifact,
  headOnly: boolean,
  cacheControl: string,
): Promise<void> {
  // Open the exact canonical path that validation bound to this artifact, then compare the
  // descriptor identity with that validation result. O_NOFOLLOW protects the final component;
  // the identity check also catches an intermediate directory being replaced by a symlink
  // between validation and open, even when the replacement contains byte-identical evidence.
  const handle = await open(validated.resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(validated.identity, before)) {
      throw new ExploreError(`Artifact is no longer the validated file: ${artifact.path}`);
    }
    const bytes = await handle.readFile();
    const after = fileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after)) {
      throw new ExploreError(`Artifact changed while it was being served: ${artifact.path}`);
    }
    if (bytes.length !== artifact.bytes) {
      throw new ExploreError(`Artifact byte length does not match the map: ${artifact.path}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) {
      throw new ExploreError(`Artifact hash does not match the map: ${artifact.path}`);
    }
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Cache-Control": cacheControl,
      "Content-Length": bytes.length,
      "Content-Type": artifact.mimeType || MIME_TYPES[extname(validated.resolvedPath).toLowerCase()]
        || "application/octet-stream",
    });
    response.end(headOnly ? undefined : bytes);
  } finally {
    await handle.close();
  }
}

function artifactCacheControl(
  requestUrl: URL,
  artifact: Artifact,
): { ok: true; value: string } | { ok: false; error: string } {
  const hashes = requestUrl.searchParams.getAll("sha256");
  if (hashes.length === 0) return { ok: true, value: "private, no-cache" };
  if (hashes.length !== 1 || hashes[0] !== artifact.sha256) {
    return { ok: false, error: "Artifact content hash does not match the current map" };
  }
  return { ok: true, value: "private, max-age=31536000, immutable" };
}

function decodeRequestPath(path: string): string {
  try {
    return decodeURIComponent(path).replaceAll("\\", "/");
  } catch {
    throw new ExploreError("Malformed request path");
  }
}

type ViewerSnapshot = {
  map: ExploreMap;
  coverage: Coverage;
  etag: string;
  identity: FileIdentity;
  artifacts: ReadonlyMap<string, ValidatedArtifact>;
};

type FileIdentity = {
  device: bigint;
  inode: bigint;
  bytes: bigint;
  modifiedNs: bigint;
  changedNs: bigint;
};

type ValidatedArtifact = {
  identity: FileIdentity;
  resolvedPath: string;
  sha256: string;
  bytes: number;
};

function snapshotEtag(map: ExploreMap): string {
  return `"${map.run.id}:${map.revision}"`;
}

function fileIdentity(info: BigIntStats): FileIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    bytes: info.size,
    modifiedNs: info.mtimeNs,
    changedNs: info.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.bytes === right.bytes &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs;
}

async function pathIdentity(path: string): Promise<FileIdentity> {
  return fileIdentity(await stat(path, { bigint: true }));
}

async function readStableMap(store: ExploreStore): Promise<{ map: ExploreMap; identity: FileIdentity }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await pathIdentity(store.mapPath);
    const map = await store.read();
    const after = await pathIdentity(store.mapPath);
    if (sameFileIdentity(before, after)) return { map, identity: after };
  }
  throw new ExploreError("Map changed repeatedly while the viewer was reading it; retry the request");
}

async function validateViewerArtifacts(
  map: ExploreMap,
  store: ExploreStore,
  previous: Map<string, ValidatedArtifact>,
): Promise<Map<string, ValidatedArtifact>> {
  const artifactsRoot = await realpath(store.artifactsDir);
  const next = new Map<string, ValidatedArtifact>();
  for (const artifact of map.artifacts) {
    const artifactPath = resolve(store.root, artifact.path);
    if (!isWithin(store.artifactsDir, artifactPath)) {
      throw new ExploreError(`artifact ${artifact.id} is outside the artifact directory`);
    }
    const info = await lstat(artifactPath, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ExploreError(`artifact ${artifact.id} is not a regular file`);
    }
    const identity = fileIdentity(info);
    const resolvedPath = await realpath(artifactPath);
    if (!isWithin(artifactsRoot, resolvedPath)) {
      throw new ExploreError(`artifact ${artifact.id} resolves outside the artifact directory`);
    }
    const cached = previous.get(artifact.path);
    if (
      cached &&
      cached.sha256 === artifact.sha256 &&
      cached.bytes === artifact.bytes &&
      cached.resolvedPath === resolvedPath &&
      sameFileIdentity(cached.identity, identity)
    ) {
      next.set(artifact.path, cached);
      continue;
    }
    const bytes = await readFile(artifactPath);
    const after = fileIdentity(await lstat(artifactPath, { bigint: true }));
    if (!sameFileIdentity(identity, after)) {
      throw new ExploreError(`artifact ${artifact.id} changed while it was being validated`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== artifact.bytes || sha256 !== artifact.sha256) {
      throw new ExploreError(`artifact ${artifact.id} failed integrity validation`);
    }
    next.set(artifact.path, {
      identity: after,
      resolvedPath,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
  }
  return next;
}

function createSnapshotReader(store: ExploreStore) {
  let snapshotPromise: Promise<ViewerSnapshot> | undefined;
  let cached: ViewerSnapshot | undefined;
  let validatedArtifacts = new Map<string, ValidatedArtifact>();

  const refresh = async (): Promise<ViewerSnapshot> => {
    const observedIdentity = await pathIdentity(store.mapPath);
    if (cached && sameFileIdentity(cached.identity, observedIdentity)) {
      validatedArtifacts = await validateViewerArtifacts(cached.map, store, validatedArtifacts);
      return cached;
    }
    const { map, identity } = await readStableMap(store);
    const validationErrors = await validateMap(map, store, { checkArtifacts: false });
    if (validationErrors.length > 0) {
      throw new ExploreError(`Cannot refresh invalid map: ${validationErrors.join("; ")}`);
    }
    validatedArtifacts = await validateViewerArtifacts(map, store, validatedArtifacts);
    cached = {
      map,
      coverage: getCoverage(map),
      etag: snapshotEtag(map),
      identity,
      artifacts: validatedArtifacts,
    };
    return cached;
  };

  return async (): Promise<ViewerSnapshot> => {
    snapshotPromise ??= refresh().finally(() => {
      snapshotPromise = undefined;
    });
    const snapshot = await snapshotPromise;
    // Duration-based coverage can change without a map revision. Recompute this
    // small derived object while keeping the parsed map and graph identity stable.
    return {
      ...snapshot,
      coverage: getCoverage(snapshot.map),
      artifacts: validatedArtifacts,
    };
  };
}

type WorkspaceSnapshot = {
  workspace: LoadedBuildWorkspace;
  payload: BuildWorkspacePayload;
  etag: string;
  identities: Map<string, FileIdentity>;
  artifacts: ReadonlyMap<string, ReadonlyMap<string, ValidatedArtifact>>;
};

async function workspacePaths(workspace: LoadedBuildWorkspace): Promise<string[]> {
  const catalogRoot = dirname(workspace.catalogPath);
  const comparisonPaths = await Promise.all(workspace.catalog.comparisons.map(async (comparison) => (
    await realpath(resolve(catalogRoot, comparison.path))
  )));
  return [...new Set([
    workspace.catalogPath,
    ...comparisonPaths,
    ...[...workspace.builds.values()].map((build) => build.store.mapPath),
  ])];
}

async function identitiesFor(paths: readonly string[]): Promise<Map<string, FileIdentity>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await pathIdentity(path)] as const)));
}

function sameIdentities(
  left: ReadonlyMap<string, FileIdentity>,
  right: ReadonlyMap<string, FileIdentity>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, identity] of left) {
    const candidate = right.get(path);
    if (!candidate || !sameFileIdentity(identity, candidate)) return false;
  }
  return true;
}

async function workspaceEtag(
  workspace: LoadedBuildWorkspace,
  trackedPaths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  const mapPaths = new Set([...workspace.builds.values()].map((build) => build.store.mapPath));
  for (const path of [...trackedPaths].sort()) {
    if (path === workspace.catalogPath) continue;
    if (mapPaths.has(path)) {
      hash.update(`\0map-file\0${relative(dirname(workspace.catalogPath), path)}\0`);
      hash.update(await readFile(path));
      continue;
    }
    hash.update(`\0comparison\0${relative(dirname(workspace.catalogPath), path)}\0`);
    hash.update(await readFile(path));
  }
  hash.update("\0catalog\0");
  hash.update(await readFile(workspace.catalogPath));
  for (const [buildId, build] of [...workspace.builds.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    hash.update(`\0build\0${buildId}\0${build.map.run.id}\0${build.map.revision}`);
  }
  return `"workspace-${hash.digest("hex")}"`;
}

const workspacePayload = buildWorkspacePayload;

function createWorkspaceSnapshotReader(catalogPath: string) {
  let snapshotPromise: Promise<WorkspaceSnapshot> | undefined;
  let cached: WorkspaceSnapshot | undefined;
  const validatedArtifacts = new Map<string, Map<string, ValidatedArtifact>>();

  const validateArtifacts = async (workspace: LoadedBuildWorkspace): Promise<void> => {
    await Promise.all([...workspace.builds].map(async ([buildId, build]) => {
      const next = await validateViewerArtifacts(
        build.map,
        build.store,
        validatedArtifacts.get(buildId) ?? new Map(),
      );
      validatedArtifacts.set(buildId, next);
    }));
  };

  const reload = async (): Promise<WorkspaceSnapshot> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const discovered = await loadBuildWorkspace(catalogPath);
      const discoveredPaths = await workspacePaths(discovered);
      const before = await identitiesFor(discoveredPaths);
      const workspace = await loadBuildWorkspace(catalogPath);
      const paths = await workspacePaths(workspace);
      if (paths.length !== discoveredPaths.length
        || paths.some((path, index) => path !== discoveredPaths[index])) {
        continue;
      }
      const etag = await workspaceEtag(workspace, paths);
      const after = await identitiesFor(paths);
      if (!sameIdentities(before, after)) continue;
      await validateArtifacts(workspace);
      cached = {
        workspace,
        payload: workspacePayload(workspace),
        etag,
        identities: after,
        artifacts: new Map(validatedArtifacts),
      };
      return cached;
    }
    throw new ExploreError(
      "Build workspace changed repeatedly while the viewer was reading it; retry the request",
    );
  };

  const refresh = async (): Promise<WorkspaceSnapshot> => {
    if (!cached) return await reload();
    const observed = await identitiesFor([...cached.identities.keys()]);
    if (!sameIdentities(cached.identities, observed)) return await reload();
    await validateArtifacts(cached.workspace);
    return {
      ...cached,
      payload: workspacePayload(cached.workspace),
      artifacts: new Map(validatedArtifacts),
    };
  };

  return async (): Promise<WorkspaceSnapshot> => {
    snapshotPromise ??= refresh().finally(() => {
      snapshotPromise = undefined;
    });
    return await snapshotPromise;
  };
}

function isTrustedRequest(request: IncomingMessage): boolean {
  const localPort = request.socket.localPort;
  if (!localPort) return false;
  const host = request.headers.host?.toLowerCase();
  if (!host) return false;
  const allowedHosts = new Set([
    `${DEFAULT_HOST}:${localPort}`,
    `localhost:${localPort}`,
  ]);
  if (!allowedHosts.has(host)) return false;
  const requestOrigin = request.headers.origin?.toLowerCase();
  if (requestOrigin && !allowedHosts.has(requestOrigin.replace(/^http:\/\//, ""))) {
    return false;
  }
  return request.headers["sec-fetch-site"] !== "cross-site";
}

function hasViewerSession(
  request: IncomingMessage,
  sessionCookie: string,
  sessionToken: string,
): boolean {
  return (request.headers.cookie ?? "")
    .split(";")
    .some((entry) => entry.trim() === `${sessionCookie}=${sessionToken}`);
}

type ViewerSource =
  | {
    mode: "map";
    store: ExploreStore;
    readSnapshot: () => Promise<ViewerSnapshot>;
  }
  | {
    mode: "workspace";
    readSnapshot: () => Promise<WorkspaceSnapshot>;
  };

function createRequestHandler(
  source: ViewerSource,
  viewerRoot: string,
  sessionCookie: string,
  sessionToken: string,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const headOnly = request.method === "HEAD";
      const requestUrl = new URL(request.url ?? "/", `http://${DEFAULT_HOST}`);
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { ok: false, error: "Untrusted viewer request" }, headOnly);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { ok: false, error: "Method not allowed" }, headOnly);
        return;
      }

      if (requestUrl.pathname === "/api/health") {
        sendJson(response, 200, { ok: true }, headOnly);
        return;
      }

      if (
        requestUrl.pathname.startsWith("/api/") &&
        !hasViewerSession(request, sessionCookie, sessionToken)
      ) {
        sendJson(response, 401, { ok: false, error: "Viewer session required" }, headOnly);
        return;
      }

      if (requestUrl.pathname === "/api/status" && source.mode === "map") {
        const snapshot = await source.readSnapshot();
        sendJson(response, 200, {
          runId: snapshot.map.run.id,
          revision: snapshot.map.revision,
          coverage: snapshot.coverage,
        }, headOnly, { ETag: snapshot.etag, "Cache-Control": "private, no-cache" });
        return;
      }

      if (requestUrl.pathname === "/api/map" && source.mode === "map") {
        const snapshot = await source.readSnapshot();
        if (request.headers["if-none-match"] === snapshot.etag) {
          response.writeHead(304, {
            ...SECURITY_HEADERS,
            "Cache-Control": "private, no-cache",
            ETag: snapshot.etag,
          });
          response.end();
          return;
        }
        sendJson(
          response,
          200,
          { map: snapshot.map, coverage: snapshot.coverage },
          headOnly,
          { ETag: snapshot.etag, "Cache-Control": "private, no-cache" },
        );
        return;
      }

      if (requestUrl.pathname.startsWith(ARTIFACT_PREFIX) && source.mode === "map") {
        const artifactPath = decodeRequestPath(requestUrl.pathname.slice(ARTIFACT_PREFIX.length));
        const snapshot = await source.readSnapshot();
        const artifact = snapshot.map.artifacts.find((candidate) => candidate.path === artifactPath);
        if (!artifact) {
          sendJson(response, 404, { ok: false, error: "Artifact not found" }, headOnly);
          return;
        }
        const cache = artifactCacheControl(requestUrl, artifact);
        if (!cache.ok) {
          sendJson(response, 409, { ok: false, error: cache.error }, headOnly, {
            "Cache-Control": "private, no-store",
          });
          return;
        }
        const absolutePath = resolve(source.store.root, artifact.path);
        if (!isWithin(source.store.artifactsDir, absolutePath)) {
          sendJson(response, 403, { ok: false, error: "Artifact is outside the map directory" }, headOnly);
          return;
        }
        const validated = snapshot.artifacts.get(artifact.path);
        if (!validated) {
          throw new ExploreError(`Artifact was not validated: ${artifact.path}`);
        }
        await sendVerifiedArtifact(
          response,
          artifact,
          validated,
          headOnly,
          cache.value,
        );
        return;
      }

      if (requestUrl.pathname === "/api/workspace" && source.mode === "workspace") {
        const snapshot = await source.readSnapshot();
        if (request.headers["if-none-match"] === snapshot.etag) {
          response.writeHead(304, {
            ...SECURITY_HEADERS,
            "Cache-Control": "private, no-cache",
            ETag: snapshot.etag,
          });
          response.end();
          return;
        }
        sendJson(response, 200, snapshot.payload, headOnly, {
          ETag: snapshot.etag,
          "Cache-Control": "private, no-cache",
        });
        return;
      }

      if (requestUrl.pathname === "/api/workspace/status" && source.mode === "workspace") {
        const snapshot = await source.readSnapshot();
        sendJson(response, 200, {
          currentBuildId: snapshot.workspace.catalog.currentBuildId,
          defaultBaselineBuildId: snapshot.workspace.catalog.defaultBaselineBuildId,
          builds: Object.fromEntries([...snapshot.workspace.builds].map(([buildId, build]) => [
            buildId,
            {
              runId: build.map.run.id,
              revision: build.map.revision,
              coverage: getCoverage(build.map),
            },
          ])),
          comparison: {
            baselineBuildId: snapshot.workspace.comparison.baselineBuildId,
            currentBuildId: snapshot.workspace.comparison.currentBuildId,
            baselineRevision: snapshot.workspace.comparison.baselineRevision,
            currentRevision: snapshot.workspace.comparison.currentRevision,
          },
        }, headOnly, { ETag: snapshot.etag, "Cache-Control": "private, no-cache" });
        return;
      }

      const buildArtifactMatch = source.mode === "workspace"
        ? /^\/api\/builds\/([^/]+)\/artifacts\/(.+)$/.exec(requestUrl.pathname)
        : null;
      if (buildArtifactMatch && source.mode === "workspace") {
        const buildId = decodeRequestPath(buildArtifactMatch[1]!);
        const artifactPath = decodeRequestPath(buildArtifactMatch[2]!);
        const snapshot = await source.readSnapshot();
        const build = snapshot.workspace.builds.get(buildId);
        if (!build) {
          sendJson(response, 404, { ok: false, error: "Build not found" }, headOnly);
          return;
        }
        const artifact = build.map.artifacts.find((candidate) => candidate.path === artifactPath);
        if (!artifact) {
          sendJson(response, 404, { ok: false, error: "Artifact not found" }, headOnly);
          return;
        }
        const cache = artifactCacheControl(requestUrl, artifact);
        if (!cache.ok) {
          sendJson(response, 409, { ok: false, error: cache.error }, headOnly, {
            "Cache-Control": "private, no-store",
          });
          return;
        }
        const absolutePath = resolve(build.store.root, artifact.path);
        if (!isWithin(build.store.artifactsDir, absolutePath)) {
          sendJson(response, 403, { ok: false, error: "Artifact is outside the build map" }, headOnly);
          return;
        }
        const validated = snapshot.artifacts.get(buildId)?.get(artifact.path);
        if (!validated) {
          throw new ExploreError(`Artifact was not validated for ${buildId}: ${artifact.path}`);
        }
        await sendVerifiedArtifact(
          response,
          artifact,
          validated,
          headOnly,
          cache.value,
        );
        return;
      }

      // Nothing else lives under /api; the app shell must never answer for a missing endpoint.
      if (requestUrl.pathname.startsWith("/api/")) {
        sendJson(response, 404, { ok: false, error: "Not found" }, headOnly);
        return;
      }

      // The viewer session rides on index.html, so every way of reaching the app sets it.
      const sendIndex = () => sendFile(
        response,
        resolve(viewerRoot, "index.html"),
        "no-store",
        headOnly,
        { "Set-Cookie": `${sessionCookie}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/` },
      );

      const decodedPath = decodeRequestPath(requestUrl.pathname);
      const relativePath = decodedPath.slice(1);
      if (decodedPath === "/" || relativePath === "index.html") {
        await sendIndex();
        return;
      }
      const candidate = resolve(viewerRoot, relativePath);
      if (!isWithin(viewerRoot, candidate)) {
        sendJson(response, 403, { ok: false, error: "Viewer asset is outside the bundle" }, headOnly);
        return;
      }
      try {
        await sendFile(response, candidate, "public, max-age=31536000, immutable", headOnly);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // The viewer routes in the path (`/map/(tabs)/settings`), so a page request for a path
        // that is not a bundled file is the app itself. Assets keep their 404 so a broken
        // script or image link stays loud.
        const pageRequest = extname(relativePath) === ""
          || (request.headers.accept ?? "").includes("text/html");
        if (pageRequest) {
          await sendIndex();
          return;
        }
        sendJson(response, 404, { ok: false, error: "Not found" }, headOnly);
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: message }, request.method === "HEAD");
    }
  };
}

async function listen(server: Server, host: string, requestedPort: number | undefined): Promise<number> {
  const firstPort = requestedPort ?? DEFAULT_PORT;
  const attempts = requestedPort === undefined ? 10 : 1;
  let lastError: Error | undefined;

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = firstPort === 0 ? 0 : firstPort + offset;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          rejectListen(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new ExploreError("Could not determine viewer port");
      return address.port;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || requestedPort !== undefined) {
        break;
      }
    }
  }
  throw new ExploreError(
    `Could not start the viewer on ${host}:${firstPort}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export async function startViewerServer(options: ViewerServerOptions): Promise<ViewerServer> {
  let source: ViewerSource;
  try {
    if (options.catalog) {
      const readSnapshot = createWorkspaceSnapshotReader(options.catalog);
      await readSnapshot();
      source = { mode: "workspace", readSnapshot };
    } else {
      const store = new ExploreStore(options.root);
      const readSnapshot = createSnapshotReader(store);
      await readSnapshot();
      source = { mode: "map", store, readSnapshot };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExploreError(
      options.catalog
        ? `Cannot view invalid build workspace: ${message}`
        : `Cannot view invalid map: ${message}`,
    );
  }

  const viewerRoot = resolve(
    options.viewerRoot ?? fileURLToPath(new URL("../viewer/", import.meta.url)),
  );
  try {
    await stat(resolve(viewerRoot, "index.html"));
  } catch {
    throw new ExploreError(`Viewer bundle not found at ${viewerRoot}; run "npm run build" first`);
  }

  const sessionToken = randomBytes(24).toString("base64url");
  const sessionCookie = `${SESSION_COOKIE_PREFIX}${randomBytes(8).toString("hex")}`;
  const handler = createRequestHandler(
    source,
    viewerRoot,
    sessionCookie,
    sessionToken,
  );
  const server = createServer((request, response) => void handler(request, response));
  const host = DEFAULT_HOST;
  const port = await listen(server, host, options.port);
  const url = `http://${host}:${port}/`;
  let closePromise: Promise<void> | undefined;
  return {
    server,
    host,
    port,
    url,
    close: () => {
      closePromise ??= (async () => {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
        });
      })();
      return closePromise;
    },
  };
}

export function openViewerInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function waitForViewerShutdown(server: ViewerServer): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const shutdown = (): void => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolveShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await server.close();
}
