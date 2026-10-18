import { useState } from "react";
import type { PublicFlowEvidence, PublicFlowSide, PublicReview } from "../../../../src/contracts/capture";
import { artifactUrl, type Artifact } from "../../utils/model";
import { flowSourceHref } from "../../utils/flow-source";
import { ScreenshotImage } from "../shared/screenshot-image";
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
  onOpen?: (surfaceId: string) => void;
}) {
  const { entry, frame } = props;
  const verdict = verdictLabel(frame, entry.base, entry.head);
  const [flipped, setFlipped] = useState(false);
  const canFlip = Boolean(entry.base && entry.head);
  const side: "base" | "head" = canFlip && flipped ? "base" : entry.head ? "head" : "base";
  const taken = entry[side]?.frames[frame.key];
  const flow = entry[side];
  const stop = flow && !taken ? stoppedAt(flow) : undefined;
  const src = taken ? frameSrc(entry, side, frame.key, taken) : undefined;
  return (
    <li className={`flow-frame tone-${verdict.tone}`} data-side={side}>
      <figure className="flow-frame-face">
        {canFlip ? (
          <button
            type="button"
            className="flow-frame-flip"
            onClick={() => setFlipped(value => !value)}
            aria-pressed={side === "base"}
            aria-label={`Show ${side === "base" ? "After" : "Before"} for ${frame.label}`}
          >
            {SIDE_LABEL[side]}
          </button>
        ) : (
          <span className="flow-frame-flip is-static">{SIDE_LABEL[side]}</span>
        )}
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
        <strong>{frame.label}</strong>
        <span className={`flow-verdict tone-${verdict.tone}`}>
          {verdict.text}
        </span>
      </div>
    </li>
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
      {flows.map(entry => {
        const head = entry.head; const base = entry.base;
        const headStop = head ? stoppedAt(head) : undefined;
        const tone = !head ? "muted" : head.status === "passed" ? "passed" : "failed";
        return (
          <section key={entry.id} className={`flow-card tone-${tone}`} aria-labelledby={`flow-${entry.id}`}>
            <header className="flow-header">
              <div>
                <h2 id={`flow-${entry.id}`}>{entry.title}</h2>
                <p className="flow-file">{flowSourceHref(props.review, entry.file, entry.head?.line ?? entry.base?.line) ? <a href={flowSourceHref(props.review, entry.file, entry.head?.line ?? entry.base?.line)} target="_blank" rel="noreferrer">{entry.file}</a> : entry.file}</p>
                {(head ?? base) ? <p className="flow-meta">{(head ?? base)!.steps.length} steps · {formatDuration((head ?? base)!.steps.reduce((sum, step) => sum + step.durationMs, 0))}</p> : null}
              </div>
              <div className="flow-outcomes">
                <span className="flow-outcome"><span className="flow-outcome-side">After</span><span className={`flow-status tone-${tone}`}>{sideSummary(entry, "head")}</span></span>
                <span className="flow-outcome"><span className="flow-outcome-side">Before</span><span className={`flow-status tone-${!base ? "muted" : base.status === "passed" ? "passed" : "failed"}`}>{sideSummary(entry, "base")}</span></span>
              </div>
            </header>
            {headStop?.step.error ? (
              <p className="flow-failure" role="note">
                Stopped at step {headStop.index + 1} — <code>{headStop.step.api} {headStop.step.label}</code>: {headStop.step.error.message}
              </p>
            ) : null}
            <div className="flow-body">
              <ol className="flow-filmstrip" aria-label="Frames">
                {entry.frames.filter(frame => !frame.colorScheme).map(frame => <Frame key={frame.key} entry={entry} frame={frame} {...(props.onOpenFrame ? { onOpen: props.onOpenFrame } : {})} />)}
              </ol>
              <Steps entry={entry} review={props.review} />
            </div>
          </section>
        );
      })}
    </main>
  );
}
