import { useEffect, useId, useRef } from "react";
import { ChevronLeft, ChevronRight, List } from "lucide-react";
import { ChangesMenu } from "../panels/changes-menu";
import { StatusGlyph } from "../shared/status-icon";
import { Tooltip } from "../shared/tooltip";
import { DIFF_LABELS, type DiffStatus } from "../../utils/build-diff";
import { formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { KeyHint } from "../shared/key-hint";
import { setMeasurementsShown, useMeasurementsShown } from "../../utils/measurements-setting";

/** A screen whose every changed area only moved: how far, per direction, and whether no other finding remains. */
export type LayoutShift = { lines: string[]; nothingElse: boolean };
import type { ComparePicker } from "./compare-section";

/**
 * Compare's screen navigation, on a phone and on a wider window: one capsule whose picker names
 * the screen by its route (led by the mark its row has in the Changes list) and opens that list,
 * and whose steps move to the changed screen before or after, with the position between them.
 * Both step with ‹ ›; a keyboard window matches them to ← and → and names the keys.
 */
export function CompareNav(props: {
  status: DiffStatus;
  /** Modified only in what assistive technology reads: the mark takes that status's colour and shape. */
  accessibilityOnly?: boolean | undefined;
  route: string;
  title: string;
  /** Zero-based; below zero when the screen is not in the order. */
  position: number;
  count: number;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  picker: ComparePicker;
  variant: "phone" | "desktop";
  /** The status as the Viewer names it (diffLabel); the status's own name otherwise. */
  statusLabel?: string;
  /** The phone puts the steps at the header's trailing edge itself (CompareSteps), after its icon buttons. */
  stepsApart?: boolean;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const { picker } = props;
  const desktop = props.variant === "desktop";
  return (
    <>
      <div ref={navRef} className="compare-nav">
        <Tooltip label="Changed screens" shortcut={formatShortcut(SHORTCUTS.app.changes)} placement="bottom"
          disabled={!desktop || picker.open}>
          <button type="button" className="compare-nav-picker" aria-haspopup="true"
            aria-expanded={picker.open} onClick={() => picker.onOpenChange(!picker.open)}>
            <StatusGlyph status={props.status} accessibilityOnly={props.accessibilityOnly} label={props.statusLabel ?? DIFF_LABELS[props.status]} />
            {/* A route that does not fit loses its start, not the end that names the screen. */}
            <code className="compare-nav-route" title={props.title}><bdi>{props.route}</bdi></code>
            <KeyHint shortcut={SHORTCUTS.app.changes} />
          </button>
        </Tooltip>
        {props.stepsApart ? null : <CompareSteps {...props} />}
      </div>
      <ChangesMenu {...picker} open={picker.open} anchorRef={navRef} align="center"
        onDismiss={() => picker.onOpenChange(false)} />
    </>
  );
}

/** ‹ 3 of 6 ›: the previous and next changed screen. Nothing when there is only one. */
export function CompareSteps(props: {
  position: number;
  count: number;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  variant: "phone" | "desktop";
}) {
  if (props.count <= 1) return null;
  const desktop = props.variant === "desktop";
  return (
    <div className="compare-nav-steps" role="group" aria-label="Step through changed screens">
      <Tooltip label="Previous changed screen" shortcut={formatShortcut(SHORTCUTS.compare.previousScreen)}
        placement="bottom" disabled={!desktop}>
        <button type="button" aria-label="Previous changed screen" disabled={!props.onPrevious}
          onClick={props.onPrevious}>
          <ChevronLeft aria-hidden="true" />
        </button>
      </Tooltip>
      {props.position >= 0 ? (
        <span className="compare-nav-position">{props.position + 1} of {props.count}</span>
      ) : null}
      <Tooltip label="Next changed screen" shortcut={formatShortcut(SHORTCUTS.compare.nextScreen)}
        placement="bottom" disabled={!desktop}>
        <button type="button" aria-label="Next changed screen" disabled={!props.onNext}
          onClick={props.onNext}>
          <ChevronRight aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * What changed on a screen, as the phone's sheet and the desktop popover both list it: CI's
 * findings as bullets, then what changed for assistive technology under its own heading, then the
 * notes about the comparison under a hairline.
 */
export function WhatChangedContent(props: {
  facts: string[];
  assistive?: string[];
  accessibilityOnly?: boolean | undefined;
  /** Set when every changed area only moved: a line per direction (layoutShiftSummary), and whether nothing else changed. */
  layoutShift?: LayoutShift | undefined;
  /** Some outlined area moved, so its outline can be labelled with how far. */
  measurable?: boolean | undefined;
  notes: string[];
}) {
  const assistive = props.assistive ?? [];
  const assistiveTitle = useId();
  const measurements = useMeasurementsShown();
  return (
    <div className="what-changed-content" role="region" aria-label="What changed on this screen">
      {props.layoutShift ? (
        <div className="what-changed-shift">
          <p>{props.layoutShift.nothingElse ? "Layout shifted. Nothing on this screen changed content." : "Layout shifted."}</p>
          <ul className="what-changed-content-list">
            {props.layoutShift.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : null}
      {props.facts.length > 0 ? (
        <ul className="what-changed-content-list">
          {props.facts.map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
      ) : null}
      {assistive.length > 0 ? (
        <section className="what-changed-assistive" aria-labelledby={assistiveTitle}>
          <h4 id={assistiveTitle} className="what-changed-assistive-title">
            <span className="status-glyph-dot diff-accessibility-only" aria-hidden="true" />
            For assistive technology
          </h4>
          <p className="what-changed-assistive-context">
            {props.accessibilityOnly
              ? "Before and After look the same. Only what screen readers and voice control read changed."
              : "Read by screen readers and voice control, not shown in the screenshot."}
          </p>
          <ul className="what-changed-content-list">
            {assistive.map((fact) => <li key={fact}>{fact}</li>)}
          </ul>
        </section>
      ) : null}
      {props.notes.length > 0 ? (
        <div className="what-changed-content-notes">
          {props.notes.map((note) => <p key={note}>{note}</p>)}
        </div>
      ) : null}
      {props.measurable ? (
        <label className="what-changed-measurements">
          <span className="what-changed-measurements-text">
            <span>Show measurements</span>
            <small>How far each outlined area moved</small>
          </span>
          <input type="checkbox" role="switch" className="what-changed-switch" checked={measurements}
            onChange={(event) => setMeasurementsShown(event.target.checked)} />
        </label>
      ) : null}
    </div>
  );
}

/**
 * What changed on a keyboard window: a button in Compare's command bar, made like the bottom
 * toolbar's, that opens the findings and notes in a popover under it. A click outside it or Esc
 * closes it.
 */
export function WhatChangedPopover(props: {
  facts: string[];
  assistive?: string[];
  accessibilityOnly?: boolean | undefined;
  layoutShift?: LayoutShift | undefined;
  measurable?: boolean | undefined;
  notes: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { open, onOpenChange } = props;
  const empty = props.facts.length === 0 && !props.assistive?.length && !props.layoutShift && props.notes.length === 0;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="compare-what-changed-anchor">
      <Tooltip label={empty ? "CI found nothing to list for this screen" : "What changed"}
        {...(empty ? {} : { shortcut: formatShortcut(SHORTCUTS.compare.whatChanged) })}
        placement="bottom" disabled={open}>
        <button type="button" className={`toolbar-button${open ? " active" : ""}`} aria-label="What changed"
          aria-haspopup="dialog" aria-expanded={open} disabled={empty} onClick={() => onOpenChange(!open)}>
          <List aria-hidden="true" />
        </button>
      </Tooltip>
      {open ? (
        <div className="compare-what-changed-popover" role="dialog" aria-modal="false" aria-label="What changed">
          {/* A screen that changed only for assistive technology has nothing else to title. */}
          {props.facts.length > 0 || props.notes.length > 0 || props.layoutShift
            ? <strong className="compare-what-changed-popover-title">What changed</strong> : null}
          <WhatChangedContent facts={props.facts} {...(props.assistive ? { assistive: props.assistive } : {})}
            accessibilityOnly={props.accessibilityOnly} layoutShift={props.layoutShift} measurable={props.measurable} notes={props.notes} />
        </div>
      ) : null}
    </div>
  );
}
