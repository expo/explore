import { type CSSProperties, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ToggleGroup } from "../shared/toggle-group";
import { ChangeOutlines, SystemRegionBands } from "../panels/visual-diff";
import { WhatChangedContent, type LayoutShift } from "./compare-header";
import {
  CompareStage,
  compareModeOptions,
  compareNotes,
  useCompareController,
  type CompareControllerOptions,
  type CompareMode,
} from "./compare-section";

/**
 * Split, Swipe, Flip centred over the screenshots, made like Compare's mode buttons in the bottom
 * toolbar: quiet text buttons with the current one on --element.
 */
function ReviewModes(props: {
  value: CompareMode;
  disabled: boolean;
  onChange: (mode: CompareMode) => void;
}) {
  return (
    <div className="sidebar-review-modes">
      <ToggleGroup<CompareMode>
        value={props.value}
        disabled={props.disabled}
        options={compareModeOptions()}
        onChange={props.onChange}
        ariaLabel="Comparison mode"
        // The arrow keys step through screens, never through modes. 1, 2 and 3 pick a mode.
        arrowKeys={false}
      />
    </div>
  );
}

/**
 * What changed as an accordion under the screenshots: a section heading with CI's count that
 * opens CI's findings and the comparison's notes in place, collapsed until asked for. It is
 * content, not a control over the screenshots, so it reads as the Inspector's other sections do.
 * Off with nothing to list, as on an unchanged screen.
 */
function WhatChangedAccordion(props: {
  facts: string[];
  assistive?: string[];
  accessibilityOnly?: boolean | undefined;
  layoutShift?: LayoutShift | undefined;
  measurable?: boolean | undefined;
  notes: string[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const count = props.facts.length + (props.assistive?.length ?? 0) + (props.layoutShift?.lines.length ?? 0);
  const empty = !props.onOpenChange || (count === 0 && props.notes.length === 0);
  const open = props.open && !empty;
  return (
    <section className="what-changed-accordion">
      {/* Headed as the Inspector's other sections are (Variants, Transition): the same title. */}
      <div className="section-title what-changed-heading">
        <h3>
          <button type="button" className="what-changed-toggle" aria-expanded={open}
            aria-controls="what-changed-accordion-content" disabled={empty}
            onClick={() => props.onOpenChange?.(!props.open)}>
            <span className="what-changed-toggle-title">
              What changed
              {count > 0 ? <span className="what-changed-toggle-count">{count}</span> : null}
            </span>
            <ChevronDown aria-hidden="true" />
          </button>
        </h3>
      </div>
      {open ? (
        <div className="what-changed-accordion-content" id="what-changed-accordion-content">
          <WhatChangedContent facts={props.facts} {...(props.assistive ? { assistive: props.assistive } : {})}
            accessibilityOnly={props.accessibilityOnly} layoutShift={props.layoutShift} measurable={props.measurable} notes={props.notes} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The review's shape on a screen with nothing to review (the build left it unchanged): the modes
 * over its screenshot and What changed under it, all off, so the Inspector keeps one shape from
 * screen to screen.
 */
export function SidebarReviewOff(props: { children: ReactNode }) {
  return (
    <section className="sidebar-review sidebar-review-off" aria-label="No changes to review">
      <ReviewModes value="split" disabled onChange={() => {}} />
      {props.children}
      <WhatChangedAccordion facts={[]} notes={[]} open={false} />
    </section>
  );
}

/**
 * A changed screen's Before and After in the Inspector, on every canvas. It is Compare at
 * sidebar size: the same modes, names over the frames, outlines and changed areas. The header
 * turns the outlines on and off and opens Compare, which steps through the changed screens; the
 * Inspector shows the screen the reader picked.
 */
export function SidebarReview(props: CompareControllerOptions) {
  const compare = useCompareController({ ...props, stepScreens: false });
  const { screen, screenDiff, route, areas, activeArea, mode } = compare;
  if (!screen || !screenDiff) return null;
  const overlay = compare.shownOutlines
    ? (
      <>
        <ChangeOutlines changes={areas} activeIndex={activeArea} />
        <SystemRegionBands regions={compare.systemRegions} />
      </>
    )
    : null;
  const facts = compare.split.visible.map((fact) => fact.copy);
  const assistive = compare.split.assistive.map((fact) => fact.copy);
  const notes = compareNotes(screenDiff, compare.facts.length, compare.statusBarIgnored, compare.homeIndicatorIgnored);

  return (
    <section className="sidebar-review" aria-label={`Changes in ${route}`}>
      <ReviewModes value={compare.chosenMode} disabled={compare.modesDisabled} onChange={compare.chooseMode} />

      <div className={`compare-stage sidebar-review-stage mode-${mode}`}
        style={{ "--compare-aspect": compare.aspect } as CSSProperties}>
        {/* Before and After are named above the frames in every mode, as in Compare. */}
        <CompareStage
          mode={mode}
          labels="above"
          swipeLabels="above"
          diff={screenDiff}
          title={screen.title}
          areas={areas}
          activeArea={activeArea}
          showOutlines={compare.shownOutlines}
          systemRegions={compare.systemRegions}
          overlay={overlay}
          flipSide={compare.flipSide}
          onFlip={compare.flip}
          swipePosition={compare.swipePosition}
          onSwipePosition={compare.setSwipePosition}
          aspect={compare.aspect}
          onAspect={compare.setAspect}
        />
      </div>

      <WhatChangedAccordion facts={facts} assistive={assistive} accessibilityOnly={screenDiff.accessibilityOnly}
        layoutShift={compare.layoutShift} measurable={compare.measurable} notes={notes}
        open={compare.factsOpen} onOpenChange={compare.setFactsOpen} />
    </section>
  );
}
