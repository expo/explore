import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  clampInspectorWidth, inspectorWidthBounds, INSPECTOR_WIDTH_STEP, setInspectorWidth, useInspectorWidth,
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
  return typeof window !== "undefined" && window.matchMedia("(max-width: 1180px)").matches ? 320 : 400;
}

type Drag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  scale: number;
  bounds: InspectorWidthBounds;
  last: number;
};

/**
 * Makes the Inspector's left edge a splitter. A drag moves the edge live (the width is written to
 * the panel's `--inspector-width` directly, so nothing re-renders per pointer move) and is kept
 * when the pointer lifts; arrow keys move it a step; Home and End take it to its narrowest and
 * widest; a double-click returns it to the default.
 */
export function useInspectorResize(panelRef: RefObject<HTMLElement | null>) {
  const width = useInspectorWidth();
  const drag = useRef<Drag | null>(null);

  useEffect(() => () => document.documentElement.classList.remove(RESIZING_CLASS), []);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (event.button !== 0 || !panel) return;
    const scale = uiScale();
    const startWidth = panelWidth(panel);
    drag.current = {
      pointerId: event.pointerId, startX: event.clientX, startWidth, scale,
      bounds: inspectorWidthBounds(window.innerWidth, scale), last: startWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add(RESIZING_CLASS);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || state.pointerId !== event.pointerId || !panel) return;
    // The edge is on the left: moving the pointer left widens the panel.
    const next = clampInspectorWidth(state.startWidth + (state.startX - event.clientX) / state.scale, state.bounds);
    if (next === state.last) return;
    state.last = next;
    panel.style.setProperty("--inspector-width", `${next}px`);
  };

  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    document.documentElement.classList.remove(RESIZING_CLASS);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.last !== state.startWidth) setInspectorWidth(state.last);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const bounds = inspectorWidthBounds(window.innerWidth, uiScale());
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
    setInspectorWidth(clampInspectorWidth(next, bounds));
  };

  const bounds = typeof window === "undefined" ? undefined : inspectorWidthBounds(window.innerWidth, uiScale());
  const style = (width === undefined ? undefined : { "--inspector-width": `${width}px` }) as CSSProperties | undefined;
  const handleProps = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize inspector",
    "aria-valuemin": bounds?.min,
    "aria-valuemax": bounds?.max,
    "aria-valuenow": width === undefined ? defaultWidth() : bounds ? clampInspectorWidth(width, bounds) : width,
    title: "Drag to resize. Double-click to reset.",
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onKeyDown,
    onDoubleClick: () => setInspectorWidth(undefined),
  } as const;
  return { style, handleProps };
}
