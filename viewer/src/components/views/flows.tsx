import { useState } from "react";
import type { PublicFlowEvidence, PublicFlowSide, PublicReview } from "../../../../src/contracts/capture";
import { artifactUrl, type Artifact } from "../../utils/model";
import { flowSourceHref } from "../../utils/flow-source";
import { ScreenshotImage } from "../shared/screenshot-image";
import { ToggleGroup } from "../shared/toggle-group";
import "./flows.css";

type Side = "base" | "head";
const SIDE_LABEL: Record<Side, string> = { base: "Before", head: "After" };

/** The step a side stopped at, when it did not pass. */
function stoppedAt(flow: PublicFlowSide): { index: number; step: PublicFlowSide["steps"][number] } | undefined {
  if (flow.status === "passed") return undefined;
  const index = flow.steps.findIndex(step => step.status !== "passed");
  return index < 0 ? undefined : { index, step: flow.steps[index]! };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function sideSummary(entry: PublicFlowEvidence, side: Side): string {
  const flow = entry[side];
  if (!flow) return "not run";
  const stop = stoppedAt(flow);
  return stop ? `${flow.status} at step ${stop.index + 1}` : flow.status;
}

function verdictLabel(entry: PublicFlowEvidence["frames"][number], base: PublicFlowSide | undefined, head: PublicFlowSide | undefined): { text: string; tone: string } {
  const inBase = Boolean(base?.frames[entry.key]); const inHead = Boolean(head?.frames[entry.key]);
  if (inBase && inHead) {
    if (!entry.visual) return { text: "Not compared", tone: "muted" };
    return entry.visual.verdict === "unchanged" ? { text: "Unchanged", tone: "unchanged" }
      : entry.visual.verdict === "modified" ? { text: entry.visual.mismatchPercentage !== undefined ? `Changed · ${entry.visual.mismatchPercentage.toFixed(1)}%` : "Changed", tone: "modified" }
      : { text: "Needs review", tone: "needs-review" };
  }
  if (inHead) return { text: base ? "Not reached before" : "New", tone: "added" };
  if (inBase) return { text: head ? "Not reached after" : "Removed", tone: "removed" };
  return { text: "Not taken", tone: "muted" };
}

/** The same resolution the Screens grid uses: embedded bytes in a report, the published URL otherwise. */
function frameSrc(entry: PublicFlowEvidence, side: Side, key: string, taken: NonNullable<PublicFlowSide["frames"][string]>): string | undefined {
  const artifact: Artifact = { id: `flow:${side}:${entry.id}/${key}`, kind: "screenshot", path: `${side}/flows/${entry.id}/${key}.png`,
    publicUrl: taken.url, sha256: taken.sha256, mimeType: "image/png", width: taken.width, height: taken.height, createdAt: taken.capturedAt };
  return artifactUrl(artifact);
}

function Frame(props: {
  entry: PublicFlowEvidence;
  frame: PublicFlowEvidence["frames"][number];
  side: Side;
  /** Labels of the step frames after this one that left the screen unchanged, folded into this frame. */
  same: string[];
  onOpen?: (surfaceId: string) => void;
}) {
  const { entry, frame, side } = props;
  const verdict = verdictLabel(frame, entry.base, entry.head);
  const taken = entry[side]?.frames[frame.key];
  const flow = entry[side];
  const stop = flow && !taken ? stoppedAt(flow) : undefined;
  const src = taken ? frameSrc(entry, side, frame.key, taken) : undefined;
  return (
    <li className={`flow-frame tone-${verdict.tone}`} data-side={side}>
      <figure className="flow-frame-face">
        {taken && src ? (
          <button
            type="button"
            className="flow-frame-button"
            onClick={props.onOpen ? () => props.onOpen!(frame.id) : undefined}
            aria-label={`Open ${frame.label} (${SIDE_LABEL[side]}) in Compare`}
          >
            <ScreenshotImage
              className="flow-frame-image"
              src={src}
              alt={`${entry.title} › ${frame.label}, ${SIDE_LABEL[side]}`}
              width={taken.width}
              height={taken.height}
            />
          </button>
        ) : (
          <div className="flow-frame-missing" role="note">
            {!flow
              ? "Flow not run"
              : stop
                ? (
                  <>
                    Not reached
                    <small>
                      the flow {flow.status} at step {stop.index + 1}
                    </small>
                  </>
                )
                : "Not taken"}
          </div>
        )}
      </figure>
      <div className="flow-frame-caption">
        <strong title={frame.label}>{frame.label}</strong>
        <span className="flow-frame-tags">
          <span className={`flow-verdict tone-${verdict.tone}`}>
            {verdict.text}
          </span>
          {props.same.length ? (
            <small className="flow-frame-same" title={`Unchanged after:\n${props.same.join("\n")}`}>+{props.same.length}</small>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/** A step frame whose picture (outside the system bands, when the capture hashed that) equals the previous shown frame's on every side that took both adds nothing: it folds into that frame. Checkpoints always show. */
function visibleFrames(entry: PublicFlowEvidence): { frame: PublicFlowEvidence["frames"][number]; same: string[] }[] {
  const sameOnEverySide = (a: string, b: string) => (["head", "base"] as const).every(side => {
    const frames = entry[side]?.frames;
    if (!frames) return true;
    const x = frames[a]; const y = frames[b];
    return Boolean(x && y && (x.contentSha256 ?? x.sha256) === (y.contentSha256 ?? y.sha256));
  });
  const shown: { frame: PublicFlowEvidence["frames"][number]; same: string[] }[] = [];
  for (const frame of entry.frames.filter(frame => !frame.colorScheme)) {
    const previous = shown.at(-1);
    if (previous && /^step-\d+$/.test(frame.key) && sameOnEverySide(previous.frame.key, frame.key)) { previous.same.push(frame.label); continue; }
    shown.push({ frame, same: [] });
  }
  return shown;
}

function FlowCard(props: { entry: PublicFlowEvidence; review: PublicReview; onOpenFrame?: (surfaceId: string) => void }) {
  const { entry, review } = props;
  const head = entry.head; const base = entry.base;
  const [side, setSide] = useState<Side>(head ? "head" : "base");
  const shownSide: Side = head && base ? side : head ? "head" : "base";
  const headStop = head ? stoppedAt(head) : undefined;
  const tone = !head ? "muted" : head.status === "passed" ? "passed" : "failed";
  const sourceHref = flowSourceHref(review, entry.file, entry.head?.line ?? entry.base?.line);
  return (
    <section className={`flow-card tone-${tone}`} aria-labelledby={`flow-${entry.id}`}>
      <header className="flow-header">
        <div>
          <h2 id={`flow-${entry.id}`}>{entry.title}</h2>
          <p className="flow-file">{sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer noopener">{entry.file}</a> : entry.file}</p>
          {(head ?? base) ? <p className="flow-meta">{(head ?? base)!.steps.length} steps · {formatDuration((head ?? base)!.steps.reduce((sum, step) => sum + step.durationMs, 0))}</p> : null}
        </div>
        <div className="flow-header-side">
          <div className="flow-outcomes">
            <span className="flow-outcome"><span className="flow-outcome-side">After</span><span className={`flow-status tone-${tone}`}>{sideSummary(entry, "head")}</span></span>
            <span className="flow-outcome"><span className="flow-outcome-side">Before</span><span className={`flow-status tone-${!base ? "muted" : base.status === "passed" ? "passed" : "failed"}`}>{sideSummary(entry, "base")}</span></span>
          </div>
          {head && base ? (
            <div className="flow-side-toggle">
              <ToggleGroup<Side> value={shownSide} onChange={setSide} ariaLabel="Frames shown" variant="flat"
                options={[{ id: "head", label: "After" }, { id: "base", label: "Before" }]} />
            </div>
          ) : null}
        </div>
      </header>
      {headStop?.step.error ? (
        <p className="flow-failure" role="note">
          Stopped at step {headStop.index + 1} — <code>{headStop.step.api} {headStop.step.label}</code>: {headStop.step.error.message}
        </p>
      ) : null}
      <div className="flow-body">
        <ol className="flow-filmstrip" aria-label={`Frames (${SIDE_LABEL[shownSide]})`}>
          {visibleFrames(entry).map(({ frame, same }) => <Frame key={frame.key} entry={entry} frame={frame} side={shownSide} same={same} {...(props.onOpenFrame ? { onOpen: props.onOpenFrame } : {})} />)}
        </ol>
        <Steps entry={entry} review={review} />
      </div>
    </section>
  );
}

function Steps(props: { entry: PublicFlowEvidence; review: PublicReview }) {
  // The steps as head ran them; base's are shown when head did not run at all.
  const side: Side = props.entry.head ? "head" : "base";
  const flow = props.entry[side];
  if (!flow) return null;
  const stop = stoppedAt(flow);
  return (
    <ol className="flow-steps" aria-label={`Steps (${SIDE_LABEL[side]})`}>
      {flow.steps.map((step, index) => {
        const failed = stop?.index === index;
        const after = stop !== undefined && index > stop.index;
        return (
          <li key={index} className={`flow-step${failed ? " failed" : ""}${after ? " skipped" : ""}${step.frame ? " frame" : ""}`}>
            <span className="flow-step-number">{index + 1}</span>
            {flowSourceHref(props.review, props.entry.file, step.line) ? (
              <a className="flow-step-source" href={flowSourceHref(props.review, props.entry.file, step.line)} target="_blank" rel="noreferrer" title={`${props.entry.file}:${step.line}`}>
                <span className="flow-step-api">{step.api}</span> <span className="flow-step-label">{step.label}</span>
              </a>
            ) : <><span className="flow-step-api">{step.api}</span> <span className="flow-step-label">{step.label}</span></>}
            <span className="flow-step-duration">{formatDuration(step.durationMs)}</span>
            {step.frame ? <span className="flow-step-frame">frame · {step.frame}</span> : null}
            {failed && step.error ? <span className="flow-step-error">{step.error.message}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function FlowsView(props: { review: PublicReview; phone?: boolean; onOpenFrame?: (surfaceId: string) => void }) {
  const flows = Array.isArray(props.review.flows) ? props.review.flows : [];
  return (
    <main className={`flows-page${props.phone ? " phone" : ""}`} aria-label="Flows">
      {(["head", "base"] as const).filter(side => props.review.flowsFailure?.[side]).map(side => (
        <section key={side} className="flow-card tone-failed flows-not-run" role="alert">
          <header className="flow-header"><div><h2>The flows did not run</h2></div><div className="flow-outcomes"><span className="flow-outcome"><span className="flow-outcome-side">{SIDE_LABEL[side]}</span><span className="flow-status tone-failed">{props.review.flowsFailure![side]!.code}</span></span></div></header>
          <p className="flow-failure">{props.review.flowsFailure![side]!.message}</p>
        </section>
      ))}
      {flows.length === 0 && !props.review.flowsFailure ? <p className="flows-empty">This review ran no flows.</p> : null}
      {flows.map(entry => <FlowCard key={entry.id} entry={entry} review={props.review} {...(props.onOpenFrame ? { onOpenFrame: props.onOpenFrame } : {})} />)}
    </main>
  );
}
