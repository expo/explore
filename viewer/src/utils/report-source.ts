import type { EmbeddedReport } from "../../../src/contracts/standalone-report";
import {
  ArtifactReportArchive, artifactIdentity, checkReportFile, isReportPage, isReportTargetId, openCachedReport, openReportFile, previewAssetUrl,
  previewManifestUrl, previewReportUrl, previewReportsUrl, previewToken, reportDownloadUrl, reportFileName, reportTarget, ReportFileError,
  showArchive, workflowRunUrl, type ArtifactIdentity, type ArtifactLoadProgress, type ReportFileErrorCode,
} from "./artifact-report";

export type ReportSourceStatus = "checking-cache" | "downloading" | "awaiting-file" | "opening" | "ready" | "failed";
export type ReportSourceSnapshot = {
  status: ReportSourceStatus;
  progress: ArtifactLoadProgress;
  /** The run the link names, or the run a dropped report turned out to belong to. */
  identity?: ArtifactIdentity;
  error?: string;
  errorCode?: ReportFileErrorCode;
  fileName?: string;
  /** Counts the reports this page has shown; a hosted preview switching targets starts a fresh Viewer per report. */
  reportKey: number;
};

/**
 * How a hosted preview's report reaches the browser: its manifest (metadata now, each screenshot when first shown)
 * or the whole ZIP (every byte before the first paint, as before). Built with VITE_EXPLORE_PREVIEW_TRANSPORT=zip for the latter.
 */
const PREVIEW_TRANSPORT: "manifest" | "zip" = import.meta.env?.VITE_EXPLORE_PREVIEW_TRANSPORT === "zip" ? "zip" : "manifest";
/** After the shown report is ready, the deployment's other targets are fetched so a switch needs no download. */
const PREFETCH_DELAY = 1500;

type PreviewPage = { token: string; target?: string };

/**
 * Reports never pass through a server: the report page asks the reviewer for the ZIP GitHub gave them, keeps
 * it in this browser, and opens it here. A hosted preview downloads its report from the deployment's Worker
 * instead, keeps every target it has opened, and switches between them without leaving the page.
 */
export class ReportSource {
  data: EmbeddedReport | undefined;
  /** The hosted report page (the root, or `/r`) that opens a report ZIP for a linked run or any run. */
  readonly reportPage: boolean;
  /** A hosted preview's report URL; the page downloads it instead of asking for a file. */
  readonly previewUrl?: string;
  private readonly preview?: PreviewPage;
  private readonly linkIdentity?: ArtifactIdentity;
  private readonly linkError?: string;
  private snapshot: ReportSourceSnapshot;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  /** Opened preview reports by the target key that selected them ("" for the link's default). */
  private readonly archives = new Map<string, ArtifactReportArchive>();
  private readonly loading = new Map<string, Promise<ArtifactReportArchive>>();
  private current: string | undefined;
  private generation = 0;
  private prefetched = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ReportSourceSnapshot => this.snapshot;

  constructor(page?: URL) {
    const token = page ? previewToken(page) : undefined;
    let linkError: string | undefined;
    if (token) {
      try {
        const target = reportTarget(page!);
        this.preview = { token, ...(target ? { target } : {}) };
        const previewUrl = previewReportUrl(page!);
        if (previewUrl) this.previewUrl = previewUrl;
      } catch (error) { linkError = error instanceof Error ? error.message : "Invalid report link."; }
    }
    this.reportPage = Boolean(page) && (isReportPage(page!) || Boolean(token));
    if (this.reportPage && !token) {
      try { const identity = artifactIdentity(page!); if (identity) this.linkIdentity = identity; }
      catch (error) { linkError = error instanceof Error ? error.message : "Invalid report link."; }
    }
    if (linkError) this.linkError = linkError;
    this.snapshot = {
      status: !this.reportPage ? "ready" : this.linkError ? "failed" : this.preview ? "downloading" : this.linkIdentity ? "checking-cache" : "awaiting-file",
      progress: this.preview ? { phase: "downloading" } : { phase: "cache" },
      ...(this.linkIdentity ? { identity: this.linkIdentity } : {}),
      ...(this.linkError ? { error: this.linkError, errorCode: "invalid" as const } : {}),
      reportKey: 0,
    };
    if (this.preview && typeof window !== "undefined") window.addEventListener("popstate", this.onPopState);
  }

  get ready(): boolean { return this.snapshot.status === "ready"; }
  get identity(): ArtifactIdentity | undefined { return this.snapshot.identity; }
  get progress(): ArtifactLoadProgress { return this.snapshot.progress; }
  /** A wrong file can be replaced by another drop; an invalid link or a hosted preview cannot. */
  get canRetry(): boolean { return this.reportPage && !this.linkError && !this.preview; }
  get expectedFileName(): string | undefined { return this.linkIdentity ? reportFileName(this.linkIdentity) : undefined; }
  get downloadUrl(): string | undefined { return this.linkIdentity ? reportDownloadUrl(this.linkIdentity) : undefined; }
  get workflowUrl(): string | undefined { return this.identity ? workflowRunUrl(this.identity) : undefined; }

  private set(snapshot: ReportSourceSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private progressed = (progress: ArtifactLoadProgress): void => { this.set({ ...this.snapshot, progress }); };

  /** Reopen the copy this browser kept of the linked report; otherwise wait for the file. */
  load(): Promise<void> {
    if (this.snapshot.status === "downloading" && this.preview) return this.pending ??= this.show(this.preview.target, this.generation).finally(() => { this.pending = undefined; });
    if (this.snapshot.status !== "checking-cache") return Promise.resolve();
    const identity = this.linkIdentity!;
    this.pending ??= openCachedReport(identity, this.progressed).then(archive => {
      if (archive) {
        this.data = archive.data;
        this.set({ ...this.snapshot, status: "ready", identity: archive.identity });
      } else this.set({ ...this.snapshot, status: "awaiting-file", progress: { phase: "cache" }, identity });
    }, () => this.set({ ...this.snapshot, status: "awaiting-file", progress: { phase: "cache" }, identity }))
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /**
   * Show another target of this hosted preview without leaving the page: the URL changes as a link to it would, and
   * a report this page already opened appears at once. False on any other page, which navigates instead.
   */
  switchTarget(target: string, url: string): boolean {
    if (!this.preview || typeof window === "undefined") return false;
    window.history.pushState(null, "", url);
    this.activateTarget(target);
    return true;
  }

  private onPopState = (): void => {
    let target: string | undefined;
    try { target = reportTarget(new URL(window.location.href)); } catch { return; }
    this.activateTarget(target);
  };

  private activateTarget(target: string | undefined): void {
    const key = target ?? "";
    const archive = this.archives.get(key);
    if (this.current !== undefined && archive && archive === this.archives.get(this.current)) {
      this.current = key;
      return;
    }
    const generation = ++this.generation;
    this.pending = undefined;
    if (archive) {
      this.set({ ...this.snapshot, reportKey: this.snapshot.reportKey + 1 });
      this.adopt(key, archive);
      return;
    }
    this.data = undefined;
    this.set({ status: "downloading", progress: { phase: "downloading" }, reportKey: this.snapshot.reportKey + 1 });
    this.pending = this.show(target, generation).finally(() => { if (generation === this.generation) this.pending = undefined; });
  }

  /** Download (or take from this page's opened reports) one target's report and make it the shown one. */
  private async show(target: string | undefined, generation: number): Promise<void> {
    const key = target ?? "";
    try {
      const archive = this.archives.get(key) ?? await this.loadTarget(target, this.progressed);
      if (generation !== this.generation) return;
      this.adopt(key, archive);
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ ...this.snapshot, status: "failed",
        error: error instanceof Error && error.message ? error.message : "The report could not be downloaded.",
        errorCode: error instanceof ReportFileError ? error.code : "invalid" });
    }
  }

  private adopt(key: string, archive: ArtifactReportArchive): void {
    this.remember(key, archive);
    showArchive(archive);
    this.data = archive.data;
    this.current = key;
    this.set({ ...this.snapshot, status: "ready", identity: archive.identity });
    this.schedulePrefetch();
  }

  /** An opened report is known by the key that selected it and by the target it says it is. */
  private remember(key: string, archive: ArtifactReportArchive): void {
    this.archives.set(key, archive);
    const own = archiveTarget(archive);
    if (own && !this.archives.has(own)) this.archives.set(own, archive);
  }

  /** One download per target, shared between a switch and the prefetch. */
  private loadTarget(target: string | undefined, onProgress?: (progress: ArtifactLoadProgress) => void): Promise<ArtifactReportArchive> {
    const key = target ?? "";
    let pending = this.loading.get(key);
    if (!pending) {
      pending = this.fetchTarget(target, onProgress).finally(() => { this.loading.delete(key); });
      this.loading.set(key, pending);
    }
    return pending;
  }

  private async fetchTarget(target: string | undefined, onProgress?: (progress: ArtifactLoadProgress) => void): Promise<ArtifactReportArchive> {
    const { token } = this.preview!;
    if (PREVIEW_TRANSPORT === "manifest") {
      const chunks = await this.download(previewManifestUrl(token, target), onProgress);
      onProgress?.({ phase: "opening" });
      let manifest: unknown;
      try { manifest = JSON.parse(await new Blob(chunks).text()); }
      catch { throw new ReportFileError("invalid", "The hosted report manifest is not valid JSON."); }
      return ArtifactReportArchive.openManifest(manifest, path => previewAssetUrl(token, path, target));
    }
    const chunks = await this.download(previewReportUrlFor(token, target), onProgress);
    const blob = new Blob(chunks, { type: "application/zip" });
    onProgress?.({ phase: "verifying" });
    await checkReportFile(blob, "report.zip");
    onProgress?.({ phase: "opening" });
    return ArtifactReportArchive.open(blob, undefined, "report.zip");
  }

  /** The Worker's answer for this link: the bytes, or why there are none. */
  private async download(url: string, onProgress?: (progress: ArtifactLoadProgress) => void): Promise<BlobPart[]> {
    const response = await fetch(url, { credentials: "same-origin" });
    if (response.status === 410) throw new ReportFileError("invalid", `This preview link expired${await expiredOn(response)}. Download the report from the pull request or workflow run instead, or rerun Explore for a fresh link.`);
    if (response.status === 404) throw new ReportFileError("invalid", "This preview link is not valid, or its deployment was deleted. Ask for a new review, or download the report from the pull request or workflow run.");
    if (!response.ok || !response.body) throw new ReportFileError("invalid", `The report could not be downloaded (HTTP ${response.status}).`);
    const total = Number(response.headers.get("content-length")) || undefined;
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ phase: "downloading", loaded, ...(total ? { total } : {}) });
    }
    return chunks;
  }

  /** Once the shown report is ready, fetch the deployment's other targets so switching needs no download. */
  private schedulePrefetch(): void {
    if (this.prefetched || !this.preview || typeof window === "undefined") return;
    this.prefetched = true;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;
    window.setTimeout(() => { void this.prefetch(); }, PREFETCH_DELAY);
  }

  private async prefetch(): Promise<void> {
    const url = previewReportsUrl(new URL(window.location.href));
    if (!url) return;
    let targets: string[];
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      const list: unknown = response.ok ? await response.json() : undefined;
      targets = Array.isArray(list)
        ? list.map(entry => (entry && typeof entry === "object" ? (entry as { target?: unknown; platform?: unknown }).target ?? (entry as { platform?: unknown }).platform : undefined)).filter(isReportTargetId)
        : [];
    } catch { return; }
    for (const target of targets) {
      if (this.archives.has(target)) continue;
      try {
        const archive = await this.loadTarget(target);
        if (this.archives.has(target)) archive.dispose();
        else this.remember(target, archive);
      } catch { /* A switch downloads it then. */ }
    }
  }

  /** Open the ZIP the reviewer dropped or chose; it must be the linked run's report when there is one. */
  async openFile(file: File): Promise<void> {
    if (!this.canRetry || this.snapshot.status === "opening" || this.snapshot.status === "ready" || this.pending) return;
    const identity = this.linkIdentity;
    const linked = identity ? { identity } : {};
    this.set({ ...this.snapshot, status: "opening", progress: { phase: "verifying" }, ...linked, fileName: file.name });
    try {
      const archive = await openReportFile(file, identity, this.progressed);
      this.data = archive.data;
      this.set({ ...this.snapshot, status: "ready", identity: archive.identity, fileName: file.name });
    } catch (error) {
      this.set({ ...this.snapshot, status: "failed", ...linked, fileName: file.name,
        error: error instanceof Error && error.message ? error.message : "The report could not be opened.",
        errorCode: error instanceof ReportFileError ? error.code : "invalid" });
    }
  }

  /** Clear a failed drop so another file can be chosen. */
  retry(): void {
    if (this.snapshot.status !== "failed" || !this.canRetry) return;
    this.set({ status: "awaiting-file", progress: { phase: "cache" }, reportKey: this.snapshot.reportKey, ...(this.linkIdentity ? { identity: this.linkIdentity } : {}) });
  }
}

/** `/p/<token>/report.zip`, with the target's query. */
function previewReportUrlFor(token: string, target: string | undefined): string {
  return previewManifestUrl(token, target).replace("/manifest.json", "/report.zip");
}

/** The target an opened report says it is: its run's target id, or the platform of a report from before targets. */
function archiveTarget(archive: ArtifactReportArchive): string | undefined {
  const run = archive.data.exploration?.map.run as { target?: { id?: unknown }; platform?: unknown } | undefined;
  const runtime = (archive.data.publicReview as { runtime?: { target?: { id?: unknown }; platform?: unknown } } | undefined)?.runtime;
  const id = run?.target?.id ?? run?.platform ?? runtime?.target?.id ?? runtime?.platform;
  return isReportTargetId(id) ? id : undefined;
}

export const REPORT_SOURCE = new ReportSource(typeof window === "undefined" ? undefined : new URL(window.location.href));

/** " on Oct 10, 2026" from the 410 body's `expiredAt`, or "" when it is missing or malformed. */
async function expiredOn(response: Response): Promise<string> {
  try {
    const body = await response.json() as { expiredAt?: unknown };
    const at = typeof body.expiredAt === "string" ? Date.parse(body.expiredAt) : Number.NaN;
    return Number.isFinite(at) ? ` on ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : "";
  } catch { return ""; }
}
