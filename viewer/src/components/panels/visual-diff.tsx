import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { formatMove, outlineRect, type VisualChange } from "../../utils/visual-diff";
import { useMeasurementsShown } from "../../utils/measurements-setting";
import { HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM, STATUS_BAR_BAND_PERCENT } from "../../../../src/contracts/capture";
import type { ReviewVisualDiff, SystemRegion } from "../../utils/review-model";
import { ScreenshotImage } from "../shared/screenshot-image";
import "./visual-diff.css";

/**
 * Outlines over a screenshot, one per changed area. An area whose content changed has one position, the same
 * on Before and After. An area that only moved is dashed and drawn where its content is on each side, labelled
 * with how far it moved while measurements are shown. The parent must be positioned.
 */
export function ChangeOutlines(props: {
  changes: readonly VisualChange[];
  activeIndex?: number | undefined;
}) {
  const measurements = useMeasurementsShown();
  return (
    <span
      className={`visual-change-outlines${props.activeIndex !== undefined ? " has-active" : ""}`}
      aria-hidden="true">
      {props.changes.map((change, index) => {
        const rect = outlineRect(change);
        // A moved area sits where its content is on each side: the Before side (--outline-before: 1) draws it
        // back by the move, so the outline jumps by the amount on its label when the sides flip.
        const back = (offset: number, move: number | undefined) => (move ? `calc(${offset}% - var(--outline-before, 0) * ${move}%)` : `${offset}%`);
        return (
          <span
            key={index}
            className={`visual-change-outline${change.move ? " moved" : ""}${props.activeIndex === index ? " active" : ""}`}
            style={{
              left: back(rect.x, change.move?.x),
              top: back(rect.y, change.move?.y),
              width: `${rect.width}%`,
              height: `${rect.height}%`,
            }}>
            {change.move && measurements ? <span className="visual-change-measure">{formatMove(change)}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

const SYSTEM_REGION_COPY: Record<SystemRegion["kind"], { label: string; title: string }> = {
  "status-bar": { label: "Status bar, not compared",
    title: "The status bar (clock, signal, battery) differs between the captures. It is not counted as a change." },
  "home-indicator": { label: "Home indicator, not compared",
    title: "The home indicator at the bottom differs between the captures. It is not counted as a change." },
};

/**
 * The system-drawn areas CI left out of the verdict for a screen: the ones the report names, or, for a report
 * from before it named them, the platform's bands where CI says it ignored something. Empty when nothing was ignored.
 */
export function ignoredSystemRegions(visual: ReviewVisualDiff | undefined): SystemRegion[] {
  if (!visual) return [];
  const statusBar = (visual.ignoredStatusBarRegions ?? 0) > 0;
  const homeIndicator = (visual.ignoredHomeIndicatorRegions ?? 0) > 0;
  if (visual.systemRegions) return visual.systemRegions.filter((area) => (area.kind === "status-bar" ? statusBar : homeIndicator));
  return [
    ...(statusBar ? [{ kind: "status-bar" as const, x: 0, y: 0, width: 100, height: STATUS_BAR_BAND_PERCENT }] : []),
    ...(homeIndicator ? [{ kind: "home-indicator" as const, x: 0, y: 100 - HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM.ios, width: 100, height: HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM.ios }] : []),
  ];
}

/**
 * The areas CI leaves out of the verdict, blurred out over a screenshot: a status-bar band across the top of a
 * phone, the clock pill in a foldable's rail, the home indicator along the bottom. Shown only when CI reports
 * that it ignored differences there; hovering one says why. The parent must be positioned.
 */
export function SystemRegionBands({ regions }: { regions: readonly SystemRegion[] }) {
  return (
    <>
      {regions.map((area, index) => (
        <span
          key={`${area.kind}:${index}`}
          className={`visual-status-bar-band visual-system-region-${area.kind}`}
          style={{ left: `${area.x}%`, top: `${area.y}%`, width: `${area.width}%`, height: `${area.height}%` }}
          role="img"
          aria-label={SYSTEM_REGION_COPY[area.kind].label}
          title={SYSTEM_REGION_COPY[area.kind].title}
        />
      ))}
    </>
  );
}

/** The status-bar band of a phone, for callers without a report (fixtures, stories). */
export function StatusBarBand({ percent = STATUS_BAR_BAND_PERCENT }: { percent?: number }) {
  return <SystemRegionBands regions={[{ kind: "status-bar", x: 0, y: 0, width: 100, height: percent }]} />;
}

/** The iOS home indicator's band, for callers without a report. */
export function HomeIndicatorBand({ percent = HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM.ios }: { percent?: number }) {
  return <SystemRegionBands regions={[{ kind: "home-indicator", x: 0, y: 100 - percent, width: 100, height: percent }]} />;
}

export const SWIPE_STEP = 5;

/**
 * One frame with a divider: Before on the left of it, After on the right. Drag anywhere on the
 * frame, or focus the divider and use the arrow keys. A caller that has its own keys for the
 * divider passes the position in.
 */
export function SwipeCompare(props: {
  title: string;
  before: string;
  after: string;
  imageAspect: number;
  changes: readonly VisualChange[];
  activeIndex?: number | undefined;
  showOutlines?: boolean;
  /** The system-drawn areas CI left out, blurred over both frames with the outlines. */
  systemRegions?: readonly SystemRegion[];
  position?: number;
  onPositionChange?: (position: number) => void;
  /** Before and After in the frame's bottom corners; off where the caller names them above the frame. */
  labels?: boolean;
}) {
  const [ownPosition, setOwnPosition] = useState(50);
  const position = props.position ?? ownPosition;
  const setPosition = (next: number) => {
    const clamped = Math.min(100, Math.max(0, next));
    if (props.onPositionChange) props.onPositionChange(clamped);
    else setOwnPosition(clamped);
  };
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const moveTo = (clientX: number) => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setPosition(((clientX - box.left) / box.width) * 100);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) moveTo(event.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "ArrowLeft" ? position - SWIPE_STEP
      : event.key === "ArrowRight" ? position + SWIPE_STEP
        : event.key === "Home" ? 0
          : event.key === "End" ? 100
            : undefined;
    if (next === undefined) return;
    // The focused divider owns the arrows; the page-level screen keys check defaultPrevented.
    event.preventDefault();
    setPosition(next);
  };

  const style = {
    "--swipe-position": `${position}%`,
    "--swipe-aspect": props.imageAspect,
  } as CSSProperties;
  return (
    <div
      ref={frameRef}
      className="visual-swipe"
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}>
      <ScreenshotImage className="visual-swipe-after" src={props.after} alt={`${props.title}, after`}
        loading="eager" draggable={false} />
      <ScreenshotImage className="visual-swipe-before" src={props.before} alt={`${props.title}, before`}
        loading="eager" draggable={false} />
      {props.showOutlines === false ? null : <ChangeOutlines changes={props.changes} activeIndex={props.activeIndex} />}
      {props.systemRegions && props.showOutlines !== false ? <SystemRegionBands regions={props.systemRegions} /> : null}
      {props.labels === false ? null : (
        <>
          <span className="visual-swipe-label before" aria-hidden="true">Before</span>
          <span className="visual-swipe-label after" aria-hidden="true">After</span>
        </>
      )}
      <div
        className="visual-swipe-divider"
        role="slider"
        tabIndex={0}
        aria-label="Before and after divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)}% before`}
        onKeyDown={onKeyDown}>
        <span className="visual-swipe-handle" aria-hidden="true"><ChevronsLeftRight /></span>
      </div>
    </div>
  );
}
