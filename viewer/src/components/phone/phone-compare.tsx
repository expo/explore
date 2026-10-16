import { useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { List, ScanSearch } from "lucide-react";
import { ToggleGroup } from "../shared/toggle-group";
import { ChangeOutlines, HomeIndicatorBand, StatusBarBand } from "../panels/visual-diff";
import { CompareNav, CompareSteps, WhatChangedContent } from "../compare/compare-header";
import {
  CompareStage,
  compareNotes,
  useCompareController,
  type CompareControllerOptions,
  type CompareMode,
  type ComparePicker,
} from "../compare/compare-section";
import { PhoneSheet } from "./phone-chrome";
import { diffLabel } from "../../utils/build-diff";

/** The share of the stage's width at each side where a tap steps to the previous or next screen. */
const STEP_EDGE = 0.15;

/**
 * Compare on a phone: above the tab bar like every view, but without the pill, so the screen
 * picker is the header and the frame gets the height back. The header holds every control: the
 * picker, the stepper through changed screens, Outlines and What changed. Flip is first, so one
 * screenshot takes the whole width.
 */
export function PhoneCompare(props: CompareControllerOptions & {
  picker: ComparePicker;
  /** Page-wide actions at the header's trailing edge (Hand off to AI): the pill is hidden here. */
  headerAction?: ReactNode;
}) {
  const compare = useCompareController(props);
  const { screen, screenDiff, route, areas, activeArea, mode } = compare;
  const pressed = useRef<{ x: number; y: number }>(undefined);
  if (!screen || !screenDiff) {
    return (
      <section className="phone-compare phone-compare-empty" aria-label="Compare">
        <p>No changed screens to compare.</p>
      </section>
    );
  }
  const overlay = compare.shownOutlines ? (
    <>
      <ChangeOutlines changes={areas} activeIndex={activeArea} />
      {compare.statusBarIgnored ? <StatusBarBand /> : null}
        {compare.homeIndicatorIgnored ? <HomeIndicatorBand /> : null}
    </>
  ) : null;
  const facts = compare.split.visible.map((fact) => fact.copy);
  const assistive = compare.split.assistive.map((fact) => fact.copy);
  const notes = compareNotes(screenDiff, compare.facts.length, compare.statusBarIgnored, compare.homeIndicatorIgnored);
  const previous = compare.previous ? () => props.onSelectScreen(compare.previous!.id) : undefined;
  const next = compare.next ? () => props.onSelectScreen(compare.next!.id) : undefined;
  // A tap near either side of the stage steps through the screens, like the stepper in the header. It runs
  // before the stage's own handlers, so it is not also a Flip; drags and the Swipe divider are left alone.
  const stepFromEdge = (event: MouseEvent<HTMLDivElement>) => {
    const start = pressed.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    if ((event.target as Element).closest(".compare-swipe, .compare-flip-side")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const at = (event.clientX - bounds.left) / bounds.width;
    const step = at < STEP_EDGE ? previous : at > 1 - STEP_EDGE ? next : undefined;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    step();
  };

  return (
    <section className="phone-compare" aria-label={`Compare ${route}`}>
      <header className="phone-compare-head">
        <CompareNav variant="phone" status={screenDiff.status} accessibilityOnly={screenDiff.accessibilityOnly} statusLabel={diffLabel(screenDiff)} route={route} title={screen.title}
          position={compare.position} count={props.order.length} picker={props.picker} stepsApart />
        <button type="button" className="phone-icon-button" aria-label="Outlines" aria-pressed={compare.outlines}
          disabled={areas.length === 0} onClick={compare.toggleOutlines}>
          <ScanSearch aria-hidden="true" />
        </button>
        <button type="button" className="phone-icon-button" aria-label="What changed" aria-haspopup="dialog"
          disabled={compare.facts.length === 0 && notes.length === 0} onClick={() => compare.setFactsOpen(true)}>
          <List aria-hidden="true" />
        </button>
        {props.headerAction}
        {/* The steps hold the trailing edge, where a thumb reaches them. */}
        <CompareSteps variant="phone" position={compare.position} count={props.order.length}
          onPrevious={previous} onNext={next} />
      </header>

      <div className="phone-compare-modes">
        <ToggleGroup<CompareMode>
          value={compare.chosenMode}
          disabled={compare.modesDisabled}
          options={compare.modeOptions}
          onChange={compare.chooseMode}
          ariaLabel="Comparison mode"
          arrowKeys={false}
        />
      </div>

      <div className={`compare-stage phone-compare-stage mode-${mode}`}
        style={{ "--compare-aspect": compare.aspect } as CSSProperties}
        onPointerDownCapture={(event) => { pressed.current = { x: event.clientX, y: event.clientY }; }}
        onClickCapture={stepFromEdge}>
        {/* Every mode names Before and After in a row above the screenshots. */}
        <CompareStage
          mode={mode}
          labels="above"
          swipeLabels="above"
          diff={screenDiff}
          title={screen.title}
          areas={areas}
          activeArea={activeArea}
          showOutlines={compare.shownOutlines}
          statusBarIgnored={compare.statusBarIgnored}
          homeIndicatorIgnored={compare.homeIndicatorIgnored}
          overlay={overlay}
          flipSide={compare.flipSide}
          onFlip={compare.flip}
          swipePosition={compare.swipePosition}
          onSwipePosition={compare.setSwipePosition}
          aspect={compare.aspect}
          onAspect={compare.setAspect}
        />
      </div>

      <PhoneSheet title="What changed" open={compare.factsOpen} onClose={() => compare.setFactsOpen(false)}>
        <WhatChangedContent facts={facts} assistive={assistive} accessibilityOnly={screenDiff.accessibilityOnly} notes={notes} />
      </PhoneSheet>
    </section>
  );
}
