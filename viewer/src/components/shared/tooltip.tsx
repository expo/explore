import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { usePhoneLayout } from "../../utils/phone-layout";

const OPEN_DELAY_MS = 350;
const SKIP_DELAY_GRACE_MS = 300;

type TooltipSession = {
  begin: () => boolean;
  opened: () => void;
  closed: () => void;
};

const TooltipSessionContext = createContext<TooltipSession | null>(null);

/** Shares the brief "tooltip browsing" session that makes consecutive tooltips instant. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  const instantRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current === null) return;
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const session = useMemo<TooltipSession>(() => ({
    begin() {
      clearResetTimer();
      return instantRef.current;
    },
    opened() {
      instantRef.current = true;
    },
    closed() {
      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        instantRef.current = false;
        resetTimerRef.current = null;
      }, SKIP_DELAY_GRACE_MS);
    },
  }), [clearResetTimer]);

  return (
    <TooltipSessionContext.Provider value={session}>
      {children}
    </TooltipSessionContext.Provider>
  );
}

type Placement = "right" | "left" | "top" | "bottom" | "bottom-end";

type TooltipProps = {
  label: string;
  /** The formatted key hint, printed after the label so the reader learns it in passing. */
  shortcut?: string | undefined;
  /** A short second line that says what the control does, for labels that are only names. */
  description?: string | undefined;
  placement?: Placement;
  /** Suppress while the trigger's own popover is open, so the two never overlap. */
  disabled?: boolean;
  children: React.ReactNode;
};

export function Tooltip({
  label,
  shortcut,
  description,
  placement = "right",
  disabled: disabledByCaller = false,
  children,
}: TooltipProps) {
  // A narrow window has no hover to explain controls with: a tap would leave the bubble open.
  const phone = usePhoneLayout();
  const disabled = disabledByCaller || phone;
  const session = useContext(TooltipSessionContext);
  const [presentation, setPresentation] = useState<"animated" | "instant" | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; side: Placement | "left"; arrow: number } | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const hide = useCallback(() => {
    clearOpenTimer();
    setPresentation(null);
    setPosition(null);
    session?.closed();
  }, [clearOpenTimer, session]);

  const show = useCallback(() => {
    if (disabled) return;
    clearOpenTimer();
    const instant = session?.begin() ?? false;
    if (instant) {
      setPresentation("instant");
      session?.opened();
      return;
    }
    openTimerRef.current = setTimeout(() => {
      setPresentation("animated");
      session?.opened();
      openTimerRef.current = null;
    }, OPEN_DELAY_MS);
  }, [clearOpenTimer, disabled, session]);

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useEffect(() => clearOpenTimer, [clearOpenTimer]);

  useLayoutEffect(() => {
    if (!presentation || disabled) return;
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const bubble = bubbleRef.current?.getBoundingClientRect();
      if (!anchor || !bubble) return;
      const margin = 8;
      const gap = 9;
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      let side: Placement | "left" = placement;
      if (side === "right" && anchor.right + gap + bubble.width > width - margin
        && anchor.left >= bubble.width + gap + margin) side = "left";
      if (side === "top" && anchor.top < bubble.height + gap + margin) side = "bottom";
      else if ((side === "bottom" || side === "bottom-end")
        && anchor.bottom + gap + bubble.height > height - margin
        && anchor.top >= bubble.height + gap + margin) side = "top";
      const horizontal = side === "right" || side === "left";
      const desiredLeft = side === "right" ? anchor.right + gap
        : side === "left" ? anchor.left - gap - bubble.width
        : side === "bottom-end" ? anchor.right - bubble.width
        : anchor.left + (anchor.width - bubble.width) / 2;
      const desiredTop = horizontal ? anchor.top + (anchor.height - bubble.height) / 2
        : side === "top" ? anchor.top - gap - bubble.height : anchor.bottom + gap;
      const left = Math.max(margin, Math.min(desiredLeft, width - bubble.width - margin));
      const top = Math.max(margin, Math.min(desiredTop, height - bubble.height - margin));
      const arrow = horizontal ? anchor.top + anchor.height / 2 - top : anchor.left + anchor.width / 2 - left;
      setPosition({ left, top, side, arrow: Math.max(12, Math.min(arrow, (horizontal ? bubble.height : bubble.width) - 12)) });
    };
    update();
    const observer = new ResizeObserver(update);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (bubbleRef.current) observer.observe(bubbleRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // A canvas pans and zooms its cards by transform, which neither observer reports: while open,
    // follow the anchor frame by frame so the bubble never stays behind over what it labels.
    let followed = "";
    let frame = requestAnimationFrame(function follow() {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const key = anchor ? `${anchor.left} ${anchor.top} ${anchor.width} ${anchor.height}` : "";
      if (followed && key !== followed) update();
      followed = key;
      frame = requestAnimationFrame(follow);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [presentation, disabled, placement, label, shortcut, description]);

  return (
    <span
      ref={anchorRef}
      className="tooltip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}>
      {children}
      {presentation && !disabled && createPortal(
        <span
          ref={bubbleRef}
          className={`tooltip tooltip-${position?.side ?? placement}`}
          style={{ left: position?.left ?? 0, top: position?.top ?? 0,
            visibility: position ? "visible" : "hidden", "--tooltip-arrow": `${position?.arrow ?? 12}px` } as CSSProperties}
          data-instant={presentation === "instant" ? "" : undefined}
          aria-hidden="true">
          {/* The contents grow with --ui-scale; the bubble keeps the place computed for it. */}
          <span className="tooltip-content">
            {label}
            {shortcut && <span className="tooltip-key">{shortcut}</span>}
            {description && <span className="tooltip-description">{description}</span>}
          </span>
        </span>, document.body
      )}
    </span>
  );
}
