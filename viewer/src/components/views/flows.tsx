import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { FlowReview, FlowReviewCheckpoint, FlowReviewFlow } from "../../../../src/contracts/flow-comparison";
import { embeddedArtifactUrl } from "../../utils/embedded-report";
import {
  checkpointLabel, checkpointMark, firstProblem, flowMark, flowNeedsReview, flowStatusLine, sidePicture, stepsBefore, stoppedEarly,
  textChangeLine, visibleFlows, type FlowFilter, type FlowMark, type FlowSide,
} from "../../utils/flows-model";
import { normalizeSearchText } from "../../utils/search";
import { FLOWS_KEYS, formatShortcut, matchesShortcut, shortcutsLive } from "../../utils/shortcuts";
import { useCanvasVisibleFrame } from "../canvas/visible-frame-provider";
import { Filmstrip } from "../shared/filmstrip";
import { PanelSearch } from "../shared/panel-search";
import { DEFAULT_SCREENSHOT_RATIO, ScreenshotImage } from "../shared/screenshot-image";
import { ToggleGroup } from "../shared/toggle-group";
import "./screens.css";
import "./flows.css";

/** A neighbour's outline in the strip, in its status colour, as Screens' filmstrip outlines a changed neighbour. */
const FRAME_CLASS: Partial<Record<FlowMark, string>> = { changed: "diff-modified", added: "diff-added", removed: "diff-removed" };

/** A status by the shape of its icon as well as its colour, so no state depends on colour alone. */
export function FlowMarkIcon(props: { mark: FlowMark; size?: number }) {
  const size = props.size ?? 14, c = size / 2, r = size / 2 - 1.5;
  const body: Record<FlowMark, ReactNode> = {
    changed: <><circle cx={c} cy={c} r={r} fill="none" stroke="var(--modified)" strokeWidth="1.5" /><circle cx={c} cy={c} r={r - 2.6} fill="var(--modified)" /></>,
    unchanged: <><circle cx={c} cy={c} r={r} fill="none" stroke="var(--border)" strokeWidth="1.5" /><path d={`M${c - 2.4} ${c}l1.7 1.7 3.1-3.3`} fill="none" stroke="var(--tertiary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>,
    "not-reached": <circle cx={c} cy={c} r={r} fill="none" stroke="var(--tertiary)" strokeWidth="1.5" strokeDasharray="2 2.2" />,
    stopped: <><circle cx={c} cy={c} r={r + 0.5} fill="var(--warning-soft)" stroke="var(--warning)" strokeWidth="1.2" /><path d={`M${c - 2.1} ${c - 2.1}l4.2 4.2M${c + 2.1} ${c - 2.1}l-4.2 4.2`} stroke="var(--warning)" strokeWidth="1.5" strokeLinecap="round" /></>,
    added: <><circle cx={c} cy={c} r={r + 0.75} fill="var(--success)" /><path d={`M${c} ${c - 2.6}v5.2M${c - 2.6} ${c}h5.2`} stroke="var(--screen)" strokeWidth="1.5" strokeLinecap="round" /></>,
    removed: <><circle cx={c} cy={c} r={r + 0.75} fill="var(--danger)" /><path d={`M${c - 2.6} ${c}h5.2`} stroke="var(--screen)" strokeWidth="1.5" strokeLinecap="round" /></>,
    "not-comparable": <><path d={`M${c} 1.5 ${size - 1.5} ${size - 2} H1.5Z`} fill="var(--warning-soft)" stroke="var(--warning)" strokeWidth="1.2" strokeLinejoin="round" /><path d={`M${c} ${c - 1.5}v2.6`} stroke="var(--warning)" strokeWidth="1.4" strokeLinecap="round" /></>,
  };
  return <svg className="flows-mark" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">{body[props.mark]}</svg>;
}

/** One checkpoint's picture on one side, with its changed areas outlined, or why it has none. */
function CheckpointPicture(props: { checkpoint: FlowReviewCheckpoint; side: FlowSide; areas: boolean; area?: number | undefined; eager: boolean }) {
  const picture = sidePicture(props.side === "after" ? props.checkpoint.after : props.checkpoint.before);
  if (!picture || "missing" in picture) {
    const why = !picture ? (props.side === "after" ? "Not in this build's flows file" : "Not in the earlier build's flows file") : "Not reached";
    return (
      <span className="flows-shot missing">
        <FlowMarkIcon mark="not-reached" size={20} />
        <span>{why}</span>
      </span>
    );
  }
  return (
    <span className="flows-shot">
      <ScreenshotImage src={embeddedArtifactUrl(picture.sha256)} alt="" draggable={false} decoding="async" loading={props.eager ? "eager" : "lazy"} />
      {props.areas ? (props.checkpoint.regions ?? []).map((region, place) => (
        <span key={place} className={`flows-area${props.area === place ? " current" : ""}`} aria-hidden="true"
          style={{ left: `${region.x}%`, top: `${region.y}%`, width: `${region.width}%`, height: `${region.height}%` }} />
      )) : null}
    </span>
  );
}

/**
 * Above the strip: the steps that led to the checkpoint in the middle, then its name and status, as the Screens
 * filmstrip shows the path to its screen. One line under it says what the picture cannot: the text a small change
 * changed, or why the run stopped.
 */
function StripHeader(props: { flow: FlowReviewFlow; index: number }) {
  const checkpoint = props.flow.checkpoints[props.index]!;
  const mark = checkpointMark(checkpoint);
  const steps = stepsBefore(props.flow, props.index);
  const failed = steps.some(step => step.failed);
  const note = failed && props.flow.after?.reason ? props.flow.after.reason : textChangeLine(checkpoint);
  return (
    <div className="flows-strip-head">
      <div className="screens-strip-path">
        {steps.map(({ step, failed: stoppedHere, ran }, place) => {
          const text = "action" in step ? step.action : step.do;
          return (
            <span key={place} className={`screens-strip-crumb flows-step${"action" in step ? " exact" : ""}${stoppedHere ? " failed" : ""}${ran ? "" : " not-run"}`} title={text}>
              {stoppedHere ? <FlowMarkIcon mark="stopped" size={13} /> : null}
              <span className="screens-strip-crumb-label">{text}</span>
              <ChevronRight aria-hidden="true" />
            </span>
          );
        })}
        <span className="screens-strip-crumb current" title={checkpoint.name}>
          <FlowMarkIcon mark={mark} size={12} />
          <span className="screens-strip-crumb-label">{checkpoint.name}</span>
          {checkpoint.verdict === "unchanged" ? null : <span className={`flows-word ${mark}`}>{checkpointLabel(checkpoint)}</span>}
        </span>
      </div>
      {note ? <p className={`flows-strip-note${failed ? " stopped" : ""}`} title={note}>{note}</p> : null}
    </div>
  );
}

function matches(flow: FlowReviewFlow, query: string): boolean {
  if (!query) return true;
  const haystack = [flow.name, ...flow.checkpoints.map((checkpoint) => checkpoint.name)];
  return haystack.some((text) => normalizeSearchText(text).includes(query));
}

/**
 * The Flows view: a report that compares two runs of a flows file, one flow at a time, as a filmstrip of its
 * checkpoints in order. A flow opens at its first problem. Before | After (X) flips every picture to the other build in
 * place. Nothing is saved: the filter, the flow and the checkpoint are this page's state.
 */
export function FlowsView(props: { review: FlowReview; phone: boolean }) {
  const { review } = props;
  const anyChanged = review.flows.some(flowNeedsReview);
  const [filter, setFilter] = useState<FlowFilter>(anyChanged ? "changed" : "all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = normalizeSearchText(query.trim());
    return visibleFlows(review, filter).filter((flow) => matches(flow, needle));
  }, [review, filter, query]);
  const [flowName, setFlowName] = useState(() => visibleFlows(review, anyChanged ? "changed" : "all")[0]?.name ?? review.flows[0]?.name);
  const flow = review.flows.find((item) => item.name === flowName) ?? shown[0] ?? review.flows[0];
  const [index, setIndex] = useState(() => (flow ? firstProblem(flow) : 0));
  const [side, setSide] = useState<FlowSide>("after");
  const [area, setArea] = useState<number | undefined>(undefined);
  const { visibleFrame } = useCanvasVisibleFrame();

  const openFlow = (next: FlowReviewFlow) => {
    setFlowName(next.name);
    setIndex(firstProblem(next));
    setArea(undefined);
  };
  const openCheckpoint = (place: number) => {
    setIndex(place);
    setArea(undefined);
  };

  // The arrows step the strip, J and K walk the changed areas of the checkpoint in the middle, X flips.
  const state = useRef({ flow, index, area });
  state.current = { flow, index, area };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shortcutsLive(event)) return;
      const { flow: current, index: place, area: shownArea } = state.current;
      if (!current) return;
      const regions = current.checkpoints[place]?.regions?.length ?? 0;
      if (matchesShortcut(event, FLOWS_KEYS.flip)) setSide((value) => (value === "after" ? "before" : "after"));
      else if (matchesShortcut(event, FLOWS_KEYS.next) || matchesShortcut(event, FLOWS_KEYS.previous)) {
        const next = place + (matchesShortcut(event, FLOWS_KEYS.next) ? 1 : -1);
        if (next < 0 || next >= current.checkpoints.length) return;
        setIndex(next); setArea(undefined);
      } else if (matchesShortcut(event, FLOWS_KEYS.nextArea) || matchesShortcut(event, FLOWS_KEYS.previousArea)) {
        if (!regions) return;
        const forward = matchesShortcut(event, FLOWS_KEYS.nextArea);
        setArea(shownArea === undefined ? (forward ? 0 : regions - 1) : (shownArea + (forward ? 1 : regions - 1)) % regions);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!flow) {
    return (
      <div className="graph-canvas canvas-empty">
        <div className="page-empty compact-empty map-empty"><h2>No flows</h2><p>The runs compared have no flows in common.</p></div>
      </div>
    );
  }
  const rightInset = visibleFrame ? `calc(100% - ${visibleFrame.x + visibleFrame.width}px)` : "0px";

  const sidebar = (
    <aside className="screens-side flows-side">
      <nav className="screens-tree" aria-label="Flows">
        {props.phone ? null : (
          <div className="screens-find flows-find">
            <PanelSearch value={query} placeholder="Search" ariaLabel="Find flows" clearLabel="Clear find query" name="flows-find"
              onEscape={() => setQuery("")} onChange={setQuery} />
          </div>
        )}
        {anyChanged ? (
          <div className="screens-filter" role="group" aria-label="Show">
            {(["changed", "all"] as const).map((value) => (
              <button key={value} type="button" className="screens-chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {value === "changed" ? "Changed" : "All"}
                <span className="screens-chip-count">{visibleFlows(review, value).length}</span>
              </button>
            ))}
          </div>
        ) : null}
        <ul className="flows-list">
          {shown.map((item) => {
            const open = item.name === flow.name;
            return (
              <li key={item.name}>
                <button type="button" className={`flows-row${open ? " open" : ""}`} aria-expanded={open} onClick={() => openFlow(item)}>
                  <FlowMarkIcon mark={flowMark(item)} />
                  <span className="flows-row-text">
                    <span className="flows-row-name">{item.name}</span>
                    <span className={`flows-row-status${stoppedEarly(item) ? " stopped" : ""}`}>{flowStatusLine(item)}</span>
                  </span>
                </button>
                {open ? (
                  <ul className="flows-checkpoints">
                    {item.checkpoints.map((entry, place) => (
                      <li key={entry.name}>
                        <button type="button" className="screens-tree-row flows-checkpoint" aria-current={place === index}
                          onClick={() => openCheckpoint(place)}>
                          <FlowMarkIcon mark={checkpointMark(entry)} size={12} />
                          <span className="screens-tree-label">{entry.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        {shown.length === 0 ? <p className="screens-find-empty" role="status">No flow matches</p> : null}
      </nav>
    </aside>
  );

  // The flow's name and the build its pictures show.
  const flowBar = (
    <div className="compare-top flows-top">
      <div className="compare-bar flows-bar" role="toolbar" aria-label="Flow">
        <FlowMarkIcon mark={flowMark(flow)} />
        <strong className="flows-bar-name">{flow.name}</strong>
        <ToggleGroup<FlowSide>
          ariaLabel="Build"
          value={side}
          arrowKeys={false}
          onChange={setSide}
          options={[
            { id: "before", label: "Before", shortcut: formatShortcut(FLOWS_KEYS.flip) },
            { id: "after", label: "After", shortcut: formatShortcut(FLOWS_KEYS.flip) },
          ]}
        />
      </div>
    </div>
  );

  const checkpoints = flow.checkpoints;
  const strip = (
    <Filmstrip
      key={flow.name}
      items={checkpoints.map((_, place) => ({ id: String(place), aspect: DEFAULT_SCREENSHOT_RATIO }))}
      focusedId={String(Math.min(index, checkpoints.length - 1))}
      header={<StripHeader flow={flow} index={Math.min(index, checkpoints.length - 1)} />}
      ariaLabel={`${flow.name}, in order`}
      phone={props.phone}
      frameClass={(id) => FRAME_CLASS[checkpointMark(checkpoints[Number(id)]!)]}
      label={(id) => checkpoints[Number(id)]!.name}
      onPick={(id) => openCheckpoint(Number(id))}
      content={(id, { middle, distance }) => (
        <CheckpointPicture checkpoint={checkpoints[Number(id)]!} side={side} areas={middle} {...(middle ? { area } : {})} eager={distance <= 1.5} />
      )}
    />
  );

  return (
    <main className={`flows-page${props.phone ? " phone" : ""}`} aria-label="Flows" style={{ "--flows-right-inset": rightInset } as React.CSSProperties}>
      {flowBar}
      <div className="flows-body">
        {sidebar}
        {strip}
      </div>
    </main>
  );
}
