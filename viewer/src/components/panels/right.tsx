import type { PublicReview } from "../../../../src/contracts/capture";
import { useEffect, useRef } from "react";
import { GitCompareArrows, PanelRight, ScanSearch, X } from "lucide-react";
import { Tooltip } from "../shared/tooltip";
import { formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { InspectorPanel } from "./inspector";
import type { ChangedScreen } from "../../utils/changed-screens";
import { diffLabel, ACCESSIBILITY_ONLY_HIGHLIGHT, type BuildDiff } from "../../utils/build-diff";
import type { MapIndex, Screen } from "../../utils/model";
import type { TransitionDirection } from "../../utils/navigation";
import { displayPathForScreen } from "../../utils/screen-path";
import { ScreenPathText } from "../shared/screen-path-text";
import { StatusGlyph } from "../shared/status-icon";
import { setOutlinesShown, useOutlinesShown } from "../compare/compare-section";
import { AutoHideScrollArea } from "../shared/auto-hide-scroll-area";
import { usePhoneLayout } from "../../utils/phone-layout";
import { useDragToDismiss } from "../phone/phone-chrome";

type RightPanelProps = {
  index: MapIndex;
  screen?: Screen | undefined;
  diff?: BuildDiff | undefined;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  direction: TransitionDirection;
  onChangeDirection: (direction: TransitionDirection) => void;
  selectedVariantId?: string | undefined;
  onSelectVariant: (variantId: string) => void;
  onSelectScreen: (id: string) => void;
  onOpenCompare?: (() => void) | undefined;
  /** The changed screens in review order, and how to step to one, for the sidebar review. */
  review?: { order: readonly ChangedScreen[]; onSelectScreen: (id: string) => void } | undefined;
  /** The public review, for a flow frame's flow (its steps and e2e source). */
  flowReview?: PublicReview | undefined;
};

export function RightPanel(props: RightPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // On a phone the panel is a bottom sheet; dragging its header down closes it.
  const phone = usePhoneLayout();
  const drag = useDragToDismiss(props.onToggleCollapsed);
  const selectedPath = props.screen ? displayPathForScreen(props.screen) : undefined;
  const screenDiff = props.screen ? props.diff?.screens.get(props.screen.id) : undefined;
  // Compare opens only a screen it reviews: a changed screen in the review order, not a state
  // variant or a redirect (the Inspector's sidebar review uses the same rule).
  const openable = Boolean(props.screen && screenDiff && props.onOpenCompare
    && screenDiff.status !== "variant" && !screenDiff.redirectTo
    && props.review?.order.some((entry) => entry.id === props.screen!.id));
  // Outlines need a Before and an After with pixel areas that differ.
  const outlinable = openable && Boolean(screenDiff?.beforeScreenshot && screenDiff.afterScreenshot
    && (screenDiff.visual?.regions.length ?? 0) > 0);
  const outlines = useOutlinesShown();

  // A new selection is a new subject: the panel starts at the top of it rather than keeping the
  // scroll position of the screen the reader just left.
  const screenId = props.screen?.id;
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [screenId]);

  // Collapsed, the panel icon brings the Inspector back; open, an X closes it.
  const panelButton = (
    <Tooltip
      label={props.collapsed ? "Expand inspector" : "Close inspector"}
      shortcut={formatShortcut(SHORTCUTS.panel.right)}
      placement="bottom-end">
      <button
        type="button"
        className="icon-button"
        aria-label={props.collapsed ? "Expand inspector" : "Close inspector"}
        aria-expanded={!props.collapsed}
        onClick={props.onToggleCollapsed}>
        {props.collapsed ? <PanelRight aria-hidden="true" /> : <X aria-hidden="true" />}
      </button>
    </Tooltip>
  );

  if (props.collapsed) {
    return (
      <div className="right-float" role="toolbar" aria-label="Canvas actions">
        {panelButton}
      </div>
    );
  }

  // One header row: the screen's status and path, then the close button. On a phone the close
  // button leads the row instead, away from the screen stepper's arrows. Theme and full screen
  // live in the canvas camera controls.
  return (
    <aside className="right-panel" data-drag-sheet aria-label="Inspector panel">
      <header className="right-head" {...(phone ? drag : {})}>
        {phone ? <span className="right-sheet-grabber" aria-hidden="true" /> : null}
        {phone ? panelButton : null}
        {props.screen && selectedPath ? (
          <div className="inspector-mode-copy">
            {/* The screen's status as Compare's header and the Changes list mark it: a dot (+ or −
                for added or removed) in the status colour, named for screen readers. */}
            {screenDiff ? (
              <StatusGlyph status={screenDiff.status} accessibilityOnly={screenDiff.accessibilityOnly} label={diffLabel(screenDiff)}
                className="inspector-diff-status" />
            ) : null}
            {props.index.plainTitles ? (
              <span className="screen-path-text inspector-screen-path" title={props.screen.title}>{props.screen.title}</span>
            ) : (
              <ScreenPathText
                path={selectedPath}
                screenTitle={props.screen.title}
                className="inspector-screen-path"
                asButton
              />
            )}
          </div>
        ) : <div className="right-head-group" />}
        <div className="right-head-group">
          {/* With a baseline, the header highlights the changed areas (on by default, shared with
              Compare) and opens the screen in Compare. A screen with no change to review keeps
              both in place, off. */}
          {props.screen && props.diff && props.onOpenCompare ? (
            <>
              <Tooltip label={screenDiff?.accessibilityOnly ? ACCESSIBILITY_ONLY_HIGHLIGHT : "Highlight changes"} shortcut={formatShortcut(SHORTCUTS.compare.outlines)} placement="bottom-end">
                <button type="button" className="icon-button inspector-highlight" aria-label="Highlight changes"
                  aria-pressed={outlinable ? outlines : false} disabled={!outlinable}
                  onClick={() => setOutlinesShown(!outlines)}>
                  <ScanSearch aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label="Open in Compare" shortcut={formatShortcut(SHORTCUTS.canvas.compare)} placement="bottom-end">
                <button type="button" className="icon-button" aria-label="Open in Compare"
                  disabled={!openable} onClick={props.onOpenCompare}>
                  <GitCompareArrows aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          ) : null}
          {phone ? null : panelButton}
        </div>
      </header>

      <AutoHideScrollArea
        ref={scrollRef}
        shellClassName="right-scroll-shell"
        className="panel-scroll right-scroll"
        id="right-panel-tab-content">
        <InspectorPanel
          index={props.index}
          screen={props.screen}
          diff={props.diff}
          direction={props.direction}
          onChangeDirection={props.onChangeDirection}
          selectedVariantId={props.selectedVariantId}
          onSelectVariant={props.onSelectVariant}
          onSelectScreen={props.onSelectScreen}
          onOpenCompare={props.onOpenCompare}
          review={props.review}
          flowReview={props.flowReview}
        />
      </AutoHideScrollArea>
    </aside>
  );
}

