import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { outlineRect, type VisualChange } from "../../utils/visual-diff";
import { HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM, STATUS_BAR_BAND_PERCENT } from "../../../../src/contracts/capture";
import { ScreenshotImage } from "../shared/screenshot-image";
import "./visual-diff.css";

/**
 * Outlines over a screenshot, one per changed area. The same rectangles go on Before and After:
 * CI compares the two images pixel for pixel, so an area has one position, not one per side.
 * The parent must be positioned.
 */
export function ChangeOutlines(props: {
  changes: readonly VisualChange[];
  activeIndex?: number | undefined;
}) {
  return (
    <span
      className={`visual-change-outlines${props.activeIndex !== undefined ? " has-active" : ""}`}
      aria-hidden="true">
      {props.changes.map((change, index) => {
        const rect = outlineRect(change);
        return (
          <span
            key={index}
            className={`visual-change-outline${props.activeIndex === index ? " active" : ""}`}
            style={{
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.width}%`,
              height: `${rect.height}%`,
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * The band CI leaves out of the verdict, blurred out over the top of a screenshot. Shown only
 * when CI reports that it ignored differences there; hovering it says why the clocks disagree.
 * The parent must be positioned.
 */
export function StatusBarBand({ percent = STATUS_BAR_BAND_PERCENT }: { percent?: number }) {
  return (
    <span
      className="visual-status-bar-band"
      style={{ height: `${percent}%` }}
      role="img"
      aria-label="Status bar, not compared"
      title="The status bar (clock, signal, battery) differs between the captures. It is not counted as a change."
    />
  );
}

/**
 * The same for the iOS home indicator, over the bottom of the screenshot: the system draws it in
 * whichever shade contrasts with the app underneath, so it changes without the app changing.
 */
export function HomeIndicatorBand({ percent = HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM.ios }: { percent?: number }) {
  return (
    <span
      className="visual-status-bar-band visual-home-indicator-band"
      style={{ height: `${percent}%` }}
      role="img"
      aria-label="Home indicator, not compared"
      title="The home indicator at the bottom differs between the captures. It is not counted as a change."
    />
  );
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
  statusBarIgnored?: boolean;
  homeIndicatorIgnored?: boolean;
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
      {props.statusBarIgnored && props.showOutlines !== false ? <StatusBarBand /> : null}
      {props.homeIndicatorIgnored && props.showOutlines !== false ? <HomeIndicatorBand /> : null}
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
