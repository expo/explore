import type { EmbeddedReport } from "../../../src/contracts/standalone-report";
import {
  artifactIdentity, isReportPage, openCachedReport, openReportBlob, openReportFile, previewReportUrl, reportDownloadUrl,
  reportFileName, ReportFileError, workflowRunUrl, type ArtifactIdentity, type ArtifactLoadProgress, type ReportFileErrorCode,
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
};

/**
 * Reports never pass through a server: the report page asks the reviewer for the ZIP GitHub gave them, keeps
 * it in this browser, and opens it here.
 */
export class ReportSource {
  data: EmbeddedReport | undefined;
  /** The hosted report page (the root, or `/r`) that opens a report ZIP for a linked run or any run. */
  readonly reportPage: boolean;
  /** A hosted preview's report URL; the page downloads it instead of asking for a file. */
  readonly previewUrl?: string;
  private readonly linkIdentity?: ArtifactIdentity;
  private readonly linkError?: string;
  private snapshot: ReportSourceSnapshot;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ReportSourceSnapshot => this.snapshot;

  constructor(page?: URL) {
    const previewUrl = page ? previewReportUrl(page) : undefined;
    if (previewUrl) this.previewUrl = previewUrl;
    this.reportPage = Boolean(page) && (isReportPage(page!) || Boolean(previewUrl));
    if (this.reportPage && !previewUrl) {
      try { const identity = artifactIdentity(page!); if (identity) this.linkIdentity = identity; }
      catch (error) { this.linkError = error instanceof Error ? error.message : "Invalid report link."; }
    }
    this.snapshot = {
      status: !this.reportPage ? "ready" : this.previewUrl ? "downloading" : this.linkError ? "failed" : this.linkIdentity ? "checking-cache" : "awaiting-file",
      progress: this.previewUrl ? { phase: "downloading" } : { phase: "cache" },
      ...(this.linkIdentity ? { identity: this.linkIdentity } : {}),
      ...(this.linkError ? { error: this.linkError, errorCode: "invalid" as const } : {}),
    };
  }

  get ready(): boolean { return this.snapshot.status === "ready"; }
  get identity(): ArtifactIdentity | undefined { return this.snapshot.identity; }
  get progress(): ArtifactLoadProgress { return this.snapshot.progress; }
  /** A wrong file can be replaced by another drop; an invalid link or a hosted preview cannot. */
  get canRetry(): boolean { return this.reportPage && !this.linkError && !this.previewUrl; }
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
    if (this.snapshot.status === "downloading" && this.previewUrl) return this.pending ??= this.download(this.previewUrl).finally(() => { this.pending = undefined; });
    if (this.snapshot.status !== "checking-cache") return Promise.resolve();
    const identity = this.linkIdentity!;
    this.pending ??= openCachedReport(identity, this.progressed).then(archive => {
      if (archive) {
        this.data = archive.data;
        this.set({ status: "ready", progress: this.snapshot.progress, identity: archive.identity });
      } else this.set({ status: "awaiting-file", progress: { phase: "cache" }, identity });
    }, () => this.set({ status: "awaiting-file", progress: { phase: "cache" }, identity }))
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }

  /**
   * Download the report the preview deployment decrypts for this link, then open it like a dropped
   * file: the same ZIP, hash, and identity checks apply, and the browser keeps the same cached copy.
   */
  private async download(url: string): Promise<void> {
    try {
      const response = await fetch(url, { credentials: "omit", cache: "no-store" });
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
        this.progressed({ phase: "downloading", loaded, ...(total ? { total } : {}) });
      }
      this.set({ ...this.snapshot, status: "opening", progress: { phase: "verifying" } });
      const archive = await openReportBlob(new Blob(chunks, { type: "application/zip" }), undefined, { fileName: "report.zip", onProgress: this.progressed });
      this.data = archive.data;
      this.set({ status: "ready", progress: this.snapshot.progress, identity: archive.identity });
    } catch (error) {
      this.set({ status: "failed", progress: this.snapshot.progress,
        error: error instanceof Error && error.message ? error.message : "The report could not be downloaded.",
        errorCode: error instanceof ReportFileError ? error.code : "invalid" });
    }
  }

  /** Open the ZIP the reviewer dropped or chose; it must be the linked run's report when there is one. */
  async openFile(file: File): Promise<void> {
    if (!this.canRetry || this.snapshot.status === "opening" || this.snapshot.status === "ready" || this.pending) return;
    const identity = this.linkIdentity;
    const linked = identity ? { identity } : {};
    this.set({ status: "opening", progress: { phase: "verifying" }, ...linked, fileName: file.name });
    try {
      const archive = await openReportFile(file, identity, this.progressed);
      this.data = archive.data;
      this.set({ status: "ready", progress: this.snapshot.progress, identity: archive.identity, fileName: file.name });
    } catch (error) {
      this.set({ status: "failed", progress: this.snapshot.progress, ...linked, fileName: file.name,
        error: error instanceof Error && error.message ? error.message : "The report could not be opened.",
        errorCode: error instanceof ReportFileError ? error.code : "invalid" });
    }
  }

  /** Clear a failed drop so another file can be chosen. */
  retry(): void {
    if (this.snapshot.status !== "failed" || !this.canRetry) return;
    this.set({ status: "awaiting-file", progress: { phase: "cache" }, ...(this.linkIdentity ? { identity: this.linkIdentity } : {}) });
  }
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
