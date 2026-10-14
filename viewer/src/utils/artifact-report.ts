import { BlobReader, ZipReader, type FileEntry } from "@zip.js/zip.js";
import type { ArtifactReport } from "../../../src/contracts/artifact-report";
import { normalizePublicReviewForReading } from "../../../src/contracts/review-validation";
import { reportContractGap } from "../public/public-workspace";
import type { EmbeddedReport, EmbeddedScreenshot, ExplorationReport } from "../../../src/contracts/standalone-report";
import { EMBEDDED_ASSET_PREFIX, EXPLORATION_REPORT_KIND, STANDALONE_REPORT_CONTRACT } from "../../../src/contracts/standalone-report";
import { deleteCachedArtifact, getCachedArtifact, putCachedArtifact } from "./artifact-cache";

export const ARTIFACT_LIMITS = {
  compressed: 256 * 1024 * 1024,
  expanded: 1024 * 1024 * 1024,
  metadata: 8 * 1024 * 1024,
  image: 32 * 1024 * 1024,
  entries: 10_000,
} as const;

/** The workflow run attempt a report belongs to; `artifact` is GitHub's id of its ZIP when a link carries it. */
export type ReportPlatform = "ios" | "android";
export const REPORT_PLATFORMS: readonly ReportPlatform[] = ["ios", "android"];
/** `platform` names the matrix job's report artifact (explore-review-<run>-<attempt>-<platform>); absent for single-platform runs. */
export type ArtifactIdentity = { origin?: "local"; repo: string; run: string; attempt: string; artifact?: string; platform?: ReportPlatform };
export type ArtifactLoadProgress = { phase: "cache" | "downloading" | "verifying" | "opening"; cached?: boolean; loaded?: number; total?: number };
export type ReportFileErrorCode = "not-zip" | "not-report" | "mismatch" | "too-large" | "invalid";

/** Why a supplied file is not the report this page can open; the message names what to drop instead. */
export class ReportFileError extends Error {
  constructor(readonly code: ReportFileErrorCode, message: string) {
    super(message);
    this.name = "ReportFileError";
  }
}

const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const IDENTIFIER = /^[1-9][0-9]{0,19}$/;
const IDENTITY_KEYS = ["repo", "run", "attempt", "artifact"] as const;
const IMAGE_REFERENCE = /^expo-explore-asset:([a-f0-9]{64})\.(png|jpg|mp4)$/;
const CACHE_AGE = 7 * 24 * 60 * 60 * 1000;
const GENERIC_FILE_NAME = "explore-review-<id>.zip";

/** The hosted Viewer is built under /viewer/ and opens reports at its root; the CLI's is not. */
const HOSTED_VIEWER = import.meta.env?.BASE_URL === "/viewer/";

/** The report page: the hosted root, or `/r`, its address in earlier pull-request comments. */
export function isReportPage(page: URL): boolean {
  return page.pathname === "/r" || page.pathname === "/r/" || (HOSTED_VIEWER && page.pathname === "/");
}

const PREVIEW_PATH = /^\/p\/([a-z2-7]{32})\/?$/;

/** A hosted preview's page: `/p/<token>`. */
export function isPreviewPath(pathname: string): boolean {
  return PREVIEW_PATH.test(pathname);
}

/**
 * A hosted preview: one EAS Hosting deployment per review whose Worker serves this Viewer at
 * `/p/<token>` and the decrypted report at `/p/<token>/report.zip`, for as long as the link is valid.
 */
export function previewReportUrl(page: URL): string | undefined {
  const match = PREVIEW_PATH.exec(page.pathname);
  if (!match) return undefined;
  const platform = reportPlatform(page);
  return `/p/${match[1]}/report.zip${platform ? `?platform=${platform}` : ""}`;
}

/** The hosted preview's list of the platforms it serves (`/p/<token>/reports.json`). */
export function previewReportsUrl(page: URL): string | undefined {
  const match = PREVIEW_PATH.exec(page.pathname);
  return match ? `/p/${match[1]}/reports.json` : undefined;
}

/** The `platform` query value when it is one platform Explore captures; throws on other values. */
export function reportPlatform(page: URL): ReportPlatform | undefined {
  const values = page.searchParams.getAll("platform");
  if (values.length === 0) return undefined;
  if (values.length > 1 || !REPORT_PLATFORMS.includes(values[0] as ReportPlatform)) throw new Error("This report link needs one platform: ios or android.");
  return values[0] as ReportPlatform;
}

function validIdentity(values: ArtifactIdentity): boolean {
  return REPOSITORY.test(values.repo) && !values.repo.split("/").some(part => part === "." || part === "..")
    && (values.origin === "local" ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(values.run) && values.attempt === "1" && values.artifact === undefined : [values.run, values.attempt, values.artifact].every(value => value === undefined || IDENTIFIER.test(value)));
}

/** The run a report link expects, or undefined for a bare `/r` that opens any report. */
export function artifactIdentity(page: URL): ArtifactIdentity | undefined {
  if (!isReportPage(page) || !IDENTITY_KEYS.some(key => page.searchParams.has(key))) return undefined;
  const values: Record<string, string> = {};
  for (const key of ["repo", "run", "attempt"] as const) {
    const candidates = page.searchParams.getAll(key);
    if (candidates.length !== 1 || !candidates[0]) throw new Error(`This report link needs one ${key} value.`);
    values[key] = candidates[0];
  }
  const artifacts = page.searchParams.getAll("artifact");
  if (artifacts.length > 1 || artifacts[0] === "") throw new Error("This report link needs one artifact value.");
  if (artifacts[0]) values.artifact = artifacts[0];
  const platform = reportPlatform(page);
  if (platform) values.platform = platform;
  if (page.searchParams.has("origin")) {
    if (page.searchParams.getAll("origin").length !== 1 || page.searchParams.get("origin") !== "local") throw new Error("Invalid report origin");
    values.origin = "local";
  }
  const identity = values as ArtifactIdentity;
  if (!validIdentity(identity)) throw new Error("This report link has an invalid repository, run, attempt, or artifact.");
  return identity;
}

export function reportFileName(identity: Pick<ArtifactIdentity, "run" | "attempt" | "platform">): string {
  return `explore-review-${identity.run}-${identity.attempt}${identity.platform ? `-${identity.platform}` : ""}.zip`;
}

export function workflowRunUrl(identity: ArtifactIdentity): string | undefined {
  if (identity.origin === "local") return undefined;
  return `https://github.com/${identity.repo}/actions/runs/${identity.run}`;
}

/** GitHub's own download page for the report; GitHub asks for sign-in and repository read access. */
export function reportDownloadUrl(identity: ArtifactIdentity): string | undefined {
  if (identity.origin === "local") return undefined;
  return identity.artifact ? `${workflowRunUrl(identity)}/artifacts/${identity.artifact}` : `${workflowRunUrl(identity)}#artifacts`;
}

function describe(fileName: string | undefined): string {
  return fileName ? `“${fileName}”` : "This file";
}

/** Cheap refusals before any hashing or unpacking: nothing, a folder, a non-ZIP, or an oversized file. */
export async function checkReportFile(blob: Blob, fileName?: string): Promise<void> {
  if (blob.size === 0) throw new ReportFileError("not-zip", `${describe(fileName)} is empty. Drop the .zip file itself, not an extracted folder.`);
  if (blob.size > ARTIFACT_LIMITS.compressed) throw new ReportFileError("too-large", `${describe(fileName)} is larger than the 256 MiB this browser can open.`);
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(head[2]!)) {
    throw new ReportFileError("not-zip", `${describe(fileName)} is not a ZIP file. Download the report artifact from GitHub Actions and drop that .zip.`);
  }
}

function safePath(path: string, directory = false): boolean {
  const name = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  return name.length > 0 && name.length <= 1024 && !/[\\\x00-\x1f\x7f:?#%]/.test(name)
    && name.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Bound actual decompressed bytes too; central-directory sizes are untrusted claims. */
async function readEntry(entry: FileEntry, limit: number, mimeType: string): Promise<Blob> {
  let size = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await entry.getData(new WritableStream<Uint8Array>({
    write(chunk) {
      size += chunk.byteLength;
      if (size > limit || size > entry.uncompressedSize) throw new Error(`Archive entry is too large: ${entry.filename}`);
      chunks.push(Uint8Array.from(chunk));
    },
  }), { checkSignature: true, checkOverlappingEntry: true, strictness: "strict", useWebWorkers: false });
  if (size !== entry.uncompressedSize) throw new Error(`Archive entry size does not match: ${entry.filename}`);
  return new Blob(chunks, { type: mimeType });
}

/** An exploration report names no repository or workflow run; its identity is the app and the Explore run id. */
export function explorationIdentity(report: Pick<ExplorationReport, "map" | "exploration">): ArtifactIdentity {
  const slug = report.exploration.app.bundleId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100) || "app";
  return { origin: "local", repo: `explore/${slug}`, run: report.map.run.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 160), attempt: "1" };
}

function validateExplorationReport(value: unknown, expected?: ArtifactIdentity, fileName?: string): { report: ExplorationReport; identity: ArtifactIdentity } {
  const notReport = () => new ReportFileError("not-report", `${describe(fileName)} is not an Explore exploration report.`);
  if (!value || typeof value !== "object") throw notReport();
  const report = value as ExplorationReport;
  if (report.kind !== EXPLORATION_REPORT_KIND || !Array.isArray(report.assets) || report.assets.length > ARTIFACT_LIMITS.entries
    || !report.map || typeof report.map !== "object" || !report.map.run || typeof report.map.run.id !== "string" || !Array.isArray(report.map.screens)
    || !Array.isArray(report.map.artifacts) || !report.coverage || typeof report.coverage !== "object"
    || !report.exploration || typeof report.exploration !== "object" || !report.exploration.app || typeof report.exploration.app.bundleId !== "string") throw notReport();
  const own = explorationIdentity(report);
  if (!validIdentity(own)) throw new ReportFileError("invalid", "The exploration report names an invalid app or run.");
  if (expected && (own.origin !== expected.origin || own.repo.toLowerCase() !== expected.repo.toLowerCase() || own.run !== expected.run || own.attempt !== expected.attempt)) {
    throw new ReportFileError("mismatch", `This file is the exploration of ${report.exploration.app.name} (run ${own.run}); this link expects ${expected.repo} run ${expected.run}.`);
  }
  return { report, identity: expected ?? own };
}

function validateReport(value: unknown, expected?: ArtifactIdentity, fileName?: string): { report: ArtifactReport; identity: ArtifactIdentity } {
  const notReport = () => new ReportFileError("not-report", `${describe(fileName)} is not an Explore report. Download ${expected ? reportFileName(expected) : `the ${GENERIC_FILE_NAME} artifact`} from the workflow run.`);
  if (!value || typeof value !== "object") throw notReport();
  const report = value as ArtifactReport;
  if (report.kind !== "explore.report" || !Array.isArray(report.assets) || report.assets.length > ARTIFACT_LIMITS.entries) throw notReport();
  const review = normalizePublicReviewForReading(report.review, reportContractGap);
  const own: ArtifactIdentity = { ...(review.pullRequest.origin === "local" ? { origin: "local" } : {}), repo: report.review.pullRequest.repository, run: report.review.runId, attempt: report.review.runAttempt };
  if ([own.repo, own.run, own.attempt].some(field => typeof field !== "string") || !validIdentity(own)) {
    throw new ReportFileError("invalid", "The report metadata names an invalid repository or workflow run.");
  }
  if (expected && (own.origin !== expected.origin || own.repo.toLowerCase() !== expected.repo.toLowerCase() || own.run !== expected.run || own.attempt !== expected.attempt)) {
    throw new ReportFileError("mismatch", `This file is the report for ${own.repo} run ${own.run} attempt ${own.attempt}. `
      + `This link expects ${expected.repo} run ${expected.run} attempt ${expected.attempt} (${reportFileName(expected)}).`);
  }
  return { report: { ...report, review }, identity: expected ?? own };
}

type ImageEntry = { entry: FileEntry; metadata: EmbeddedScreenshot; extension: "png" | "jpg" | "mp4" };
/** Eager screenshots (the Inspector's) are decoded before lazy ones (canvas nodes and thumbnails). */
export type ScreenshotPriority = "eager" | "lazy";
type ImageLoad = {
  sha256: string;
  users: number;
  priority: ScreenshotPriority;
  pending: Promise<string>;
  url?: string;
  /** Set while the load waits for a decode slot. */
  waiting?: { start: () => void; drop: (reason: Error) => void };
};

const DECODE_SLOTS = 4;
/**
 * Released screenshots keep their Blob URL, up to this many and this many bytes in all, so panning
 * back needs no new decode.
 */
export const RETAINED_SCREENSHOTS = 32;
export const RETAINED_SCREENSHOT_BYTES = 128 * 1024 * 1024;

/**
 * Compressed Blob + entry index. Screenshots are extracted when a caller asks for them; the last
 * few that callers released stay decoded until they are evicted or the report is closed.
 */
export class ArtifactReportArchive {
  readonly data: EmbeddedReport;
  /** Screenshots in use, waiting for a slot, or being decoded. */
  private readonly loads = new Map<string, ImageLoad>();
  /** Decoded screenshots nobody uses, least recently released first, and their total size. */
  private readonly retained = new Map<string, { url: string; bytes: number }>();
  private retainedBytes = 0;
  private readonly queues: Record<ScreenshotPriority, ImageLoad[]> = { eager: [], lazy: [] };
  private disposed = false;
  private running = 0;

  private constructor(private readonly reader: ZipReader<Blob>, report: ArtifactReport | ExplorationReport,
    private readonly images: Map<string, ImageEntry>, readonly identity: ArtifactIdentity) {
    const assets = Object.fromEntries([...images].map(([sha, value]) => [sha, value.metadata]));
    this.data = report.kind === EXPLORATION_REPORT_KIND ? { contract: STANDALONE_REPORT_CONTRACT, exploration: report, assets }
      : { contract: STANDALONE_REPORT_CONTRACT, publicReview: report.review, assets };
  }

  /** Bind the ZIP to the linked run when there is one; a bare page takes the run the report names. */
  static async open(blob: Blob, identity?: ArtifactIdentity, fileName?: string): Promise<ArtifactReportArchive> {
    await checkReportFile(blob, fileName);
    const reader = new ZipReader(new BlobReader(blob), { strictness: "strict", useWebWorkers: false });
    try {
      const files = new Map<string, FileEntry>();
      const paths = new Set<string>();
      let count = 0;
      let expanded = 0;
      for await (const entry of reader.getEntriesGenerator()) {
        if (++count > ARTIFACT_LIMITS.entries || !safePath(entry.filename, entry.directory)
          || paths.has(entry.filename) || entry.encrypted || entry.symlink
          || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
          || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
          || entry.compressedSize > blob.size || ![0, 8].includes(entry.compressionMethod)) {
          throw new Error("The report archive contains an invalid or unsupported entry.");
        }
        paths.add(entry.filename);
        expanded += entry.uncompressedSize;
        if (expanded > ARTIFACT_LIMITS.expanded || entry.uncompressedSize > ARTIFACT_LIMITS.image) {
          throw new Error("The report archive exceeds the browser extraction limit.");
        }
        if (!entry.directory) files.set(entry.filename, entry);
      }
      const indexImages = (assets: ArtifactReport["assets"]): Map<string, ImageEntry> => {
        const images = new Map<string, ImageEntry>();
        const imagePaths = new Set<string>();
        for (const asset of assets) {
          if (!asset || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
            || typeof asset.path !== "string" || !safePath(asset.path) || images.has(asset.sha256) || imagePaths.has(asset.path)) {
            throw new Error("The report image index is invalid.");
          }
          const extension = /\.(png|jpg|mp4)$/.exec(asset.path)?.[1] as "png" | "jpg" | "mp4" | undefined;
          const entry = files.get(asset.path);
          if (!extension || !entry || entry.uncompressedSize <= 0 || entry.uncompressedSize > ARTIFACT_LIMITS.image) {
            throw new Error("A report screenshot is missing or invalid.");
          }
          images.set(asset.sha256, { entry, extension,
            metadata: { mimeType: extension === "png" ? "image/png" : extension === "mp4" ? "video/mp4" : "image/jpeg", byteLength: entry.uncompressedSize } });
          imagePaths.add(asset.path);
        }
        return images;
      };
      const explorationEntry = files.get("exploration.json");
      if (explorationEntry && !files.has("review.json")) {
        if (explorationEntry.uncompressedSize > ARTIFACT_LIMITS.metadata) throw new ReportFileError("too-large", `${describe(fileName)} has an exploration index over the browser limit.`);
        let parsed: unknown;
        try { parsed = JSON.parse(await (await readEntry(explorationEntry, ARTIFACT_LIMITS.metadata, "application/json")).text()); }
        catch { throw new ReportFileError("not-report", `${describe(fileName)} is not an Explore report: its exploration.json is not valid JSON.`); }
        const { report, identity: bound } = validateExplorationReport(parsed, identity, fileName);
        const images = indexImages(report.assets);
        for (const artifact of report.map.artifacts) {
          if (artifact.kind === "screenshot" && !images.has(artifact.sha256)) throw new Error("A captured screenshot is missing from the report image index.");
        }
        return new ArtifactReportArchive(reader, report, images, bound);
      }
      const metadata = files.get("review.json");
      if (!metadata || metadata.uncompressedSize > ARTIFACT_LIMITS.metadata) {
        throw new ReportFileError("not-report", `${describe(fileName)} is not an Explore report: it has no review.json. Download ${identity ? reportFileName(identity) : `the ${GENERIC_FILE_NAME} artifact`} from the workflow run.`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(await (await readEntry(metadata, ARTIFACT_LIMITS.metadata, "application/json")).text()); }
      catch { throw new ReportFileError("not-report", `${describe(fileName)} is not an Explore report: its review.json is not valid JSON.`); }
      const { report, identity: bound } = validateReport(parsed, identity, fileName);
      const images = indexImages(report.assets);
      for (const surface of report.review.surfaces) {
        for (const image of [surface.baseImage, surface.headImage]) {
          if (image && !images.has(image.sha256)) throw new Error("A captured screenshot is missing from the report image index.");
        }
      }
      return new ArtifactReportArchive(reader, report, images, bound);
    } catch (error) {
      await reader.close();
      throw error;
    }
  }

  reference(sha256: string): string | undefined {
    const image = this.images.get(sha256);
    return image ? `${EMBEDDED_ASSET_PREFIX}${sha256}.${image.extension}` : undefined;
  }

  /**
   * A verified Blob URL for an embedded screenshot. Each call is one use until `release`. At most
   * four screenshots are read and hashed at once; eager requests wait ahead of lazy ones.
   */
  async resolve(reference: string, priority: ScreenshotPriority = "lazy"): Promise<string> {
    const sha256 = IMAGE_REFERENCE.exec(reference)?.[1];
    if (!sha256) return reference;
    if (this.disposed || !this.images.has(sha256)) throw new Error("This report screenshot is unavailable.");
    const existing = this.loads.get(sha256);
    if (existing) {
      existing.users++;
      if (priority === "eager" && existing.priority === "lazy") this.promote(existing);
      return existing.pending;
    }
    const kept = this.retained.get(sha256);
    if (kept) {
      this.retained.delete(sha256);
      this.retainedBytes -= kept.bytes;
      this.loads.set(sha256, { sha256, users: 1, priority, pending: Promise.resolve(kept.url), url: kept.url });
      return kept.url;
    }
    const load: ImageLoad = { sha256, users: 1, priority, pending: Promise.resolve("") };
    this.loads.set(sha256, load);
    load.pending = this.decode(load);
    return load.pending;
  }

  release(reference: string): void {
    const sha256 = IMAGE_REFERENCE.exec(reference)?.[1];
    const load = sha256 ? this.loads.get(sha256) : undefined;
    if (!load || load.users === 0) return;
    load.users--;
    // A load still waiting or decoding keeps its entry: a waiting one is skipped when its turn
    // comes, a decoding one is retained when it finishes, and either can be requested again.
    if (load.users === 0 && load.url) {
      this.loads.delete(load.sha256);
      this.retain(load.sha256, load.url);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const load of this.queues.eager.splice(0).concat(this.queues.lazy.splice(0))) {
      load.waiting?.drop(new Error("This report was closed."));
    }
    for (const load of this.loads.values()) if (load.url) URL.revokeObjectURL(load.url);
    for (const { url } of this.retained.values()) URL.revokeObjectURL(url);
    this.loads.clear();
    this.retained.clear();
    this.retainedBytes = 0;
    void this.reader.close();
  }

  private async decode(load: ImageLoad): Promise<string> {
    const image = this.images.get(load.sha256)!;
    await this.acquireSlot(load);
    try {
      if (this.disposed) throw new Error("This report was closed.");
      const blob = await readEntry(image.entry, ARTIFACT_LIMITS.image, image.metadata.mimeType);
      const bytes = await blob.arrayBuffer();
      const header = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
      const validImage = image.extension === "png"
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
        : image.extension === "mp4"
          // An MP4 container starts with a box whose type is `ftyp`.
          ? header[4] === 102 && header[5] === 116 && header[6] === 121 && header[7] === 112
          : header[0] === 255 && header[1] === 216 && header[2] === 255;
      if (!validImage) throw new Error("The screenshot is not a supported image.");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const actual = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== load.sha256) throw new Error("The screenshot checksum does not match the report.");
      if (this.disposed) throw new Error("This report was closed.");
      const url = URL.createObjectURL(blob);
      if (load.users > 0) load.url = url;
      else {
        // Everyone let go while it decoded; keep the finished work for a quick return.
        this.loads.delete(load.sha256);
        this.retain(load.sha256, url);
      }
      return url;
    } catch (error) {
      if (this.loads.get(load.sha256) === load) this.loads.delete(load.sha256);
      throw error;
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(load: ImageLoad): Promise<void> {
    if (this.running < DECODE_SLOTS) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((start, drop) => {
      load.waiting = { start, drop };
      this.queues[load.priority].push(load);
    });
  }

  /** Hand a finished decode's slot to the next waiting load that someone still uses. */
  private releaseSlot(): void {
    for (let load = this.nextWaiting(); load; load = this.nextWaiting()) {
      const waiting = load.waiting!;
      delete load.waiting;
      if (load.users > 0) {
        waiting.start();
        return;
      }
      // Released before its turn: skipped before any of its bytes are read.
      this.loads.delete(load.sha256);
      waiting.drop(new Error("This screenshot is no longer in use."));
    }
    this.running--;
  }

  private nextWaiting(): ImageLoad | undefined {
    return this.queues.eager.shift() ?? this.queues.lazy.shift();
  }

  private promote(load: ImageLoad): void {
    load.priority = "eager";
    const index = this.queues.lazy.indexOf(load);
    if (index < 0) return;
    this.queues.lazy.splice(index, 1);
    this.queues.eager.push(load);
  }

  /** Keep a released URL; beyond either limit the least recently released ones are revoked. */
  private retain(sha256: string, url: string): void {
    const bytes = this.images.get(sha256)!.metadata.byteLength;
    this.retained.set(sha256, { url, bytes });
    this.retainedBytes += bytes;
    for (const [oldest, old] of this.retained) {
      if (this.retained.size <= RETAINED_SCREENSHOTS && this.retainedBytes <= RETAINED_SCREENSHOT_BYTES) break;
      this.retained.delete(oldest);
      this.retainedBytes -= old.bytes;
      URL.revokeObjectURL(old.url);
    }
  }
}

export let activeArtifactReport: ArtifactReportArchive | undefined;

function activate(archive: ArtifactReportArchive): ArtifactReportArchive {
  activeArtifactReport?.dispose();
  activeArtifactReport = archive;
  return archive;
}

async function digestOf(blob: Blob): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type OpenReportOptions = { fileName?: string; onProgress?: (progress: ArtifactLoadProgress) => void };

/** Open a report ZIP the reviewer supplied, then keep it in this browser so reloads need no new drop. */
export async function openReportBlob(blob: Blob, identity?: ArtifactIdentity, options: OpenReportOptions = {}): Promise<ArtifactReportArchive> {
  options.onProgress?.({ phase: "verifying" });
  await checkReportFile(blob, options.fileName);
  const digest = await digestOf(blob);
  options.onProgress?.({ phase: "opening" });
  const archive = activate(await ArtifactReportArchive.open(blob, identity, options.fileName));
  await putCachedArtifact(archive.identity, { blob, digest, expiresAt: Date.now() + CACHE_AGE });
  return archive;
}

export function openReportFile(file: File, identity?: ArtifactIdentity,
  onProgress?: (progress: ArtifactLoadProgress) => void): Promise<ArtifactReportArchive> {
  return openReportBlob(file, identity, { fileName: file.name, ...(onProgress ? { onProgress } : {}) });
}

/** Reopen the copy this browser kept; a copy that fails verification is discarded without a message. */
export async function openCachedReport(identity: ArtifactIdentity,
  onProgress?: (progress: ArtifactLoadProgress) => void): Promise<ArtifactReportArchive | undefined> {
  onProgress?.({ phase: "cache" });
  const cached = await getCachedArtifact(identity);
  if (!cached) return undefined;
  try {
    onProgress?.({ phase: "verifying", cached: true });
    if (await digestOf(cached.blob) !== cached.digest) throw new Error("The saved report checksum does not match.");
    onProgress?.({ phase: "opening", cached: true });
    return activate(await ArtifactReportArchive.open(cached.blob, identity));
  } catch {
    await deleteCachedArtifact(identity);
    return undefined;
  }
}
