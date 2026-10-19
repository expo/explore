import {
  useCallback, useRef, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject,
} from "react";
import {
  clampInspectorWidth, getToolbarRoom, inspectorWidthBounds, INSPECTOR_WIDTH_MAX, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_STEP,
  setInspectorWidth, subscribeToToolbarRoom, useInspectorWidth,
  type InspectorWidthBounds,
} from "../../utils/inspector-width";

/** On the root while the edge is dragged, so the whole page keeps the resize cursor and selects nothing. */
const RESIZING_CLASS = "inspector-resizing";

/** The chrome's zoom (`--ui-scale`): pointer distances are in window pixels, the panel's width in its own. */
function uiScale(): number {
  const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** The panel's width in its own pixels: the reader's, else the stylesheet's default for this window. */
function panelWidth(panel: HTMLElement): number {
  return parseFloat(getComputedStyle(panel).width) || 0;
}

function defaultWidth(): number {
  return window.matchMedia("(max-width: 1180px)").matches ? 320 : 400;
}

/** The panel's widest and default widths follow the window (and `--ui-scale`, which follows it too). */
function subscribeToWindow(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The widest the panel can be now: it follows the window, `--ui-scale` and the bottom bar's width. */
function currentBounds(): InspectorWidthBounds {
  return inspectorWidthBounds(window.innerWidth, uiScale(), getToolbarRoom());
}

function subscribeToBounds(onChange: () => void): () => void {
  const unsubscribeToolbar = subscribeToToolbarRoom(onChange);
  const unsubscribeWindow = subscribeToWindow(onChange);
  return () => {
    unsubscribeToolbar();
    unsubscribeWindow();
  };
}

function widestWidth(): number {
  return currentBounds().max;
}

type Drag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  scale: number;
  bounds: InspectorWidthBounds;
  last: number;
  /** The panel's own `--inspector-width` before the drag, put back when the drag changes nothing. */
  inline: string;
};

/**
 * Makes the Inspector's left edge a splitter. A drag moves the edge live (the width is written to
 * the panel's `--inspector-width` directly, so nothing re-renders per pointer move) and is kept
 * when the pointer lifts; arrow keys move it a step; Home and End take it to its narrowest and
 * widest; a double-click returns it to the default.
 */
export function useInspectorResize(panelRef: RefObject<HTMLElement | null>) {
  const width = useInspectorWidth();
  const widest = useSyncExternalStore(subscribeToBounds, widestWidth, () => INSPECTOR_WIDTH_MAX);
  const fallback = useSyncExternalStore(subscribeToWindow, defaultWidth, () => 400);
  const drag = useRef<Drag | null>(null);

  // Every way a drag can stop ends here, once: the pointer lifting, the browser taking the pointer
  // back, the window losing focus, or the edge itself going away (the Inspector closed mid-drag).
  const endDrag = useCallback(() => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    document.documentElement.classList.remove(RESIZING_CLASS);
    if (state.last !== state.startWidth) {
      setInspectorWidth(state.last);
      return;
    }
    // Nothing changed, so nothing re-renders to replace the width the drag wrote.
    const panel = panelRef.current;
    if (!panel) return;
    if (state.inline) panel.style.setProperty("--inspector-width", state.inline);
    else panel.style.removeProperty("--inspector-width");
  }, [panelRef]);

  const handleRef = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("blur", endDrag);
      endDrag();
    };
  }, [endDrag]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (event.button !== 0 || !panel) return;
    const scale = uiScale();
    const startWidth = panelWidth(panel);
    drag.current = {
      pointerId: event.pointerId, startX: event.clientX, startWidth, scale,
      bounds: currentBounds(), last: startWidth,
      inline: panel.style.getPropertyValue("--inspector-width"),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add(RESIZING_CLASS);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || state.pointerId !== event.pointerId || !panel) return;
    // A release the handle never heard about.
    if (event.buttons === 0) {
      endDrag();
      return;
    }
    // The edge is on the left: moving the pointer left widens the panel.
    const next = clampInspectorWidth(state.startWidth + (state.startX - event.clientX) / state.scale, state.bounds);
    if (next === state.last) return;
    state.last = next;
    panel.style.setProperty("--inspector-width", `${next}px`);
  };

  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    endDrag();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const bounds = currentBounds();
    const current = panelWidth(panel);
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = current + INSPECTOR_WIDTH_STEP; break;
      case "ArrowRight": next = current - INSPECTOR_WIDTH_STEP; break;
      case "Home": next = bounds.min; break;
      case "End": next = bounds.max; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    // A key that cannot move the edge (End at a smaller window's cap) keeps the saved width.
    next = clampInspectorWidth(next, bounds);
    if (next !== Math.round(current)) setInspectorWidth(next);
  };

  // The saved width is the reader's preference; the panel takes as much of it as this window allows.
  const bounds = { min: INSPECTOR_WIDTH_MIN, max: widest };
  const shown = width === undefined ? undefined : clampInspectorWidth(width, bounds);
  const style = (shown === undefined ? undefined : { "--inspector-width": `${shown}px` }) as CSSProperties | undefined;
  const handleProps = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize inspector",
    "aria-valuemin": bounds.min,
    "aria-valuemax": bounds.max,
    "aria-valuenow": shown ?? fallback,
    title: "Drag to resize. Double-click to reset.",
    tabIndex: 0,
    ref: handleRef,
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onLostPointerCapture: endDrag,
    onKeyDown,
    onDoubleClick: () => setInspectorWidth(undefined),
  } as const;
  return { style, handleProps };
}
