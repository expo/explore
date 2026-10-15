import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AlertCircle, ArrowUpRight, FileArchive, FolderOpen, RotateCw } from "lucide-react";
import type { ArtifactIdentity, ArtifactLoadProgress } from "../../utils/artifact-report";
import { ExpoLogo } from "./expo-logo";
import "./report-loading-shell.css";

type LoadingStatus = "loading" | "awaiting" | "failed";

export type ReportLoadingShellProps = {
  progress: ArtifactLoadProgress;
  identity?: ArtifactIdentity;
  error?: string;
  /** The page is waiting for the reviewer to drop or choose the report ZIP. */
  awaiting?: boolean;
  workflowUrl?: string;
  downloadUrl?: string;
  expectedFileName?: string;
  /** Present while a dropped or chosen file can be opened; also enables page-wide drops. */
  onOpenFile?: (file: File) => void;
  onRetry?: () => void;
};

const REPORT_ACCEPT = ".zip,application/zip,application/x-zip-compressed";
const GENERIC_FILE_NAME = "explore-review-<id>.zip";

function progressLabel(progress: ArtifactLoadProgress): string {
  switch (progress.phase) {
    case "cache": return "Checking saved report";
    case "downloading": return progress.total && progress.loaded !== undefined
      ? `Downloading report · ${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%` : "Downloading report";
    case "verifying": return progress.cached ? "Checking saved report" : "Verifying report";
    case "opening": return progress.cached ? "Opening saved report" : "Opening report";
  }
}

function LoadingStep({ title }: { title: string }) {
  const [step, setStep] = useState<{ title: string; previous?: string }>({ title });
  if (step.title !== title) setStep({ title, previous: step.title });

  // Only a step change replaces the animated element. Byte updates leave its shine running.
  return <div className="report-loading-status" role="status" aria-label="Report loading" aria-atomic="false">
    {step.previous ? <span key={`previous-${step.previous}`} className="report-loading-step is-leaving" aria-hidden="true"
      onAnimationEnd={() => setStep(current => current.previous === step.previous ? { title: current.title } : current)}>
      <span className="report-loading-shimmer">{step.previous}</span>
    </span> : null}
    <span key={title} className="report-loading-step is-current">
      <span className="report-loading-shimmer">{title}</span>
    </span>
  </div>;
}

type DropState = { dragging: boolean; message?: string; choose: (files: FileList | null | undefined) => void };

/**
 * The whole page is the drop target while a file can be opened: reviewers drag the ZIP GitHub
 * saved onto whatever they see. A depth counter keeps the highlight steady across child elements.
 */
function useReportDrop(onOpenFile: ((file: File) => void) | undefined): DropState {
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>();
  const open = useRef(onOpenFile);
  open.current = onOpenFile;
  const choose = (files: FileList | null | undefined, directory = false) => {
    if (!open.current) return;
    if (directory) { setMessage("Drop the .zip file itself, not an extracted folder."); return; }
    const file = files?.[0];
    if (!file) { setMessage("Nothing to open was dropped. Drop the report .zip file."); return; }
    if (files!.length > 1) { setMessage("Drop one report ZIP at a time."); return; }
    setMessage(undefined);
    open.current(file);
  };
  const enabled = Boolean(onOpenFile);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const carriesFiles = (event: DragEvent) => Boolean(event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files"));
    const enter = (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); depth += 1; setDragging(true); };
    const over = (event: DragEvent) => { if (!carriesFiles(event)) return; event.preventDefault(); event.dataTransfer!.dropEffect = "copy"; };
    const leave = (event: DragEvent) => { if (!carriesFiles(event)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const item = event.dataTransfer!.items[0];
      const entry = item && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      choose(event.dataTransfer!.files, Boolean(entry?.isDirectory));
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
      setDragging(false);
    };
  }, [enabled]);
  return { dragging, ...(message ? { message } : {}), choose };
}

type ReportDropScreenProps = Omit<ReportLoadingShellProps, "progress" | "awaiting"> & {
  status: "awaiting" | "failed";
  drop: DropState;
};

/**
 * The framed drop target, built like the Viewer's page states: an icon, the title, the three steps
 * that open a report, and the file picker. The file name downloads the ZIP from GitHub; the page
 * opens it here, and nothing leaves the browser.
 */
function ReportDropScreen({ status, identity, error, workflowUrl, downloadUrl, expectedFileName, onOpenFile, onRetry, drop }: ReportDropScreenProps) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    drop.choose(event.currentTarget.files);
    event.currentTarget.value = "";
  };
  const failed = status === "failed";
  const fileName = <code>{expectedFileName ?? GENERIC_FILE_NAME}</code>;
  const retry = failed && onRetry
    ? <button type="button" className="button" onClick={onRetry}><RotateCw size={14} aria-hidden="true" />Try again</button>
    : null;
  return <div className="report-drop" data-drop-status={status}>
    <span className={`state-icon report-drop-icon${failed ? " state-icon-danger" : ""}`} aria-hidden="true">
      {failed ? <AlertCircle size={20} /> : <FileArchive size={20} />}
    </span>
    {failed ? <div className="report-loading-error" role="alert">
      <h1 className="report-drop-title">Couldn’t open this report</h1>
      <p className="report-drop-subtitle">{error}</p>
    </div> : <>
      <h1 className="report-drop-title">{identity ? "Open this report" : "Open a report"}</h1>
      <ol className="report-drop-steps" aria-label="How to open a report">
        <li>Open the Explore comment on your pull request, or the summary of the Explore workflow run</li>
        <li>Download {downloadUrl
          ? <a className="report-drop-file" href={downloadUrl} target="_blank" rel="noopener noreferrer" title="Download from GitHub">{fileName}</a>
          : fileName}</li>
        <li>Drop it on this page. It stays in this browser for 7 days.</li>
      </ol>
    </>}
    {onOpenFile || retry ? <div className="report-drop-actions">
      {onOpenFile ? <>
        <button type="button" className="button button-primary" onClick={() => input.current?.click()}>
          <FolderOpen size={14} aria-hidden="true" />Select a file
        </button>
        <input ref={input} className="report-drop-input" type="file" accept={REPORT_ACCEPT} aria-label="Choose the report ZIP" onChange={onChange} />
      </> : null}
      {retry}
    </div> : null}
    {drop.message ? <span className="report-drop-message" role="alert">{drop.message}</span> : null}
    {failed && (downloadUrl || workflowUrl) ? <div className="report-loading-actions">
      {downloadUrl ? <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
        Download report<ArrowUpRight size={13} aria-hidden="true" />
      </a> : null}
      {workflowUrl ? <a href={workflowUrl} target="_blank" rel="noopener noreferrer">
        Open workflow run<ArrowUpRight size={13} aria-hidden="true" />
      </a> : null}
    </div> : null}
  </div>;
}

function LoadingState({ status, drop, ...props }: ReportLoadingShellProps & { status: LoadingStatus; drop: DropState }) {
  if (status === "loading") return <div className="report-loading-state"><LoadingStep title={progressLabel(props.progress)} /></div>;
  const { progress: _progress, awaiting: _awaiting, ...rest } = props;
  return <div className={`report-loading-state is-drop${status === "failed" ? " is-error" : ""}`}>
    <ReportDropScreen {...rest} status={status} drop={drop} />
  </div>;
}

/**
 * ReportSource owns loading. This shell presents progress and takes the file, with the same
 * top-left pill the Viewer shows once the report is open.
 */
export function ReportLoadingShell(props: ReportLoadingShellProps) {
  const status: LoadingStatus = props.error ? "failed" : props.awaiting ? "awaiting" : "loading";
  const drop = useReportDrop(props.onOpenFile);

  return <div className={`report-loading-shell${drop.dragging ? " is-dragging" : ""}`} data-loading-status={status}>
    {/* Blurred layers become one melting shape once this alpha threshold cuts their soft edges. */}
    <svg className="report-loading-morph-defs" aria-hidden="true" focusable="false" width="0" height="0">
      <defs>
        <filter id="report-loading-morph" x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.3" result="soft" />
          <feColorMatrix in="soft" type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1.35 -0.12" />
        </filter>
      </defs>
    </svg>
    <header className="left-panel collapsed report-loading-pill" aria-label="Report">
      <div className="left-panel-collapsed-pill">
        <span className="panel-logo-mark"><ExpoLogo mark /></span>
        <span className="panel-logo-divider" aria-hidden="true" />
        <div className="collapsed-app-identity">
          <strong title={props.identity?.repo}>{props.identity?.repo ?? "Explore"}</strong>
        </div>
        {status === "loading" ? <span className="report-loading-skeleton report-loading-pill-skeleton" aria-hidden="true" /> : null}
      </div>
    </header>
    <div className="app-content">
      <main className="report-loading-canvas report-loading-changes" aria-label="Review" tabIndex={0}>
        <LoadingState {...props} status={status} drop={drop} />
      </main>
    </div>
  </div>;
}
