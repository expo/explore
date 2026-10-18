import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { ImageOff, PanelRight } from "lucide-react";
import { diffClass, type DiffStatus } from "../../utils/build-diff";
import { ScreenPathText } from "../shared/screen-path-text";
import { Tooltip } from "../shared/tooltip";
import { DEFAULT_SCREENSHOT_SIZE, ScreenshotImage } from "../shared/screenshot-image";
import { CanvasActiveFrame } from "./active-frame";
import { DiffFrame } from "./diff-frame";

export type ScreenScreenshotCardProps = {
  title: string;
  path: string;
  /** Head the card with the title itself: a black-box screen has no route to copy as a deep link. */
  plainTitle?: boolean;
  screenshot?: string;
  /** Shown in place of the image when the run recorded why there is none. */
  missingReason?: string;
  diff?: DiffStatus;
  /** A modified screen whose screenshots match: the label says only what assistive technology reads changed. */
  accessibilityOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  selected?: boolean;
  highlighted?: boolean;
  ariaLabel?: string;
  ariaPressed?: boolean;
  imageWidth?: number;
  imageHeight?: number;
  /** The frame of a screen without a screenshot: its run's screenshots, so it lines up beside them. */
  placeholderSize?: { width: number; height: number };
  loading?: "eager" | "lazy";
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Short lines about the screen, inside the card after its screenshot (Screens: how it was reached, where else it changed). */
  note?: ReactNode;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
};

/**
 * The shared visual for a captured screen on every canvas. Canvas-specific node adapters own
 * geometry and handles; this component owns the router-path heading, diff frame, and screenshot.
 */
export function ScreenScreenshotCard(props: ScreenScreenshotCardProps) {
  // The placeholder takes the frame of the image it stands in for: a failed screenshot keeps the
  // frame it waited in, and a screen without one is framed like a phone screenshot beside it.
  const frame = props.screenshot && props.imageWidth && props.imageHeight
    ? { width: props.imageWidth, height: props.imageHeight }
    : props.placeholderSize ?? DEFAULT_SCREENSHOT_SIZE;
  const missing = (
    <span
      className="image-placeholder"
      style={{ "--screenshot-width": frame.width, "--screenshot-height": frame.height } as CSSProperties}>
      <ImageOff aria-hidden="true" size={20} />
      No screenshot
      {props.missingReason ? <small className="image-placeholder-reason">{props.missingReason}</small> : null}
    </span>
  );
  const className = [
    "screen-screenshot-card",
    props.className,
    // The status class carries the frame colour to the card, so its handles can share it.
    props.diff ? diffClass({ status: props.diff, ...(props.accessibilityOnly ? { accessibilityOnly: true as const } : {}) }) : undefined,
    props.selected ? "selected" : undefined,
    props.highlighted ? "highlighted" : undefined,
  ].filter(Boolean).join(" ");

  return (
    <CanvasActiveFrame as="div" selected={props.selected} highlighted={props.highlighted}>
      <div
        className={className}
        style={props.style}
        onMouseEnter={props.onMouseEnter}
        onMouseLeave={props.onMouseLeave}>
        <span className="screen-node-heading">
          {props.plainTitle ? (
            <span className="screen-path-text screen-node-title" title={props.title}>{props.title}</span>
          ) : (
            <ScreenPathText
              path={props.path}
              screenTitle={props.title}
              className="screen-node-title"
              asButton
            />
          )}
        </span>
        {/* Connection handles anchor to the screenshot slot, so edges meet the screen border
            rather than the route heading above it. The slot is positioned; the button stays
            free of block children. */}
        <span className="screen-screenshot-slot">
          {props.leading}
          {/* With a pointer, what a click does is said once, zoom-independent, in the shared tooltip
              after its usual delay; the selected screen is already in the Inspector. */}
          <Tooltip label="Open in Inspector" placement="top" disabled={Boolean(props.selected)}>
          <button
            type="button"
            className="screen-screenshot-target"
            title={props.plainTitle ? props.title : props.path}
            aria-label={props.ariaLabel ?? `Open ${props.plainTitle ? props.title : props.path}`}
            {...(props.ariaPressed !== undefined ? { "aria-pressed": props.ariaPressed } : {})}
            onClick={props.onClick}>
            <DiffFrame status={props.diff} accessibilityOnly={props.accessibilityOnly}>
              <span className={`screen-node-image${props.screenshot ? " has-screenshot" : " is-missing"}`}>
                {props.screenshot ? (
                  <ScreenshotImage
                    src={props.screenshot}
                    alt={`Screenshot of ${props.title}`}
                    {...(props.imageWidth ? { width: props.imageWidth } : {})}
                    {...(props.imageHeight ? { height: props.imageHeight } : {})}
                    draggable={false}
                    decoding="async"
                    loading={props.loading ?? "lazy"}
                    fallback={missing}
                  />
                ) : missing}
                {/* On a phone's map, says what the second tap on the selected screen does. */}
                <span className="screen-open-hint" aria-hidden="true">
                  <PanelRight />
                  <span>Open</span>
                </span>
              </span>
            </DiffFrame>
          </button>
          </Tooltip>
          {props.trailing}
        </span>
        {props.note ? <span className="screen-node-note">{props.note}</span> : null}
      </div>
    </CanvasActiveFrame>
  );
}
