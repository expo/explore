import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GitCompareArrows, LayoutGrid, Map as MapIcon, Waypoints, X } from "lucide-react";
import { CANVAS_LABELS, type CanvasView } from "../../utils/navigation";
import "./phone.css";

const VIEW_ICONS: Record<CanvasView, ReactNode> = {
  map: <MapIcon />,
  screens: <LayoutGrid />,
  compare: <GitCompareArrows />,
  flows: <Waypoints />,
};

/**
 * The phone layout's view switcher: the floating toolbar's views as a tab bar with labels, on
 * every view. Search sits in the pill and the keyboard shortcuts button is left out.
 */
export function PhoneTabBar(props: {
  canvas: CanvasView;
  /** The views this report has, in the toolbar's order; Flows only with a flow review. */
  views: readonly CanvasView[];
  compareCount: number;
  onSelectCanvas: (canvas: CanvasView) => void;
}) {
  return (
    <nav className="phone-tab-bar" aria-label="Views">
      {props.views.map((id) => {
        return (
          <button key={id} type="button" className="phone-tab"
            aria-current={props.canvas === id ? "page" : undefined}
            onClick={() => props.onSelectCanvas(id)}>
            <span className="phone-tab-icon" aria-hidden="true">
              {VIEW_ICONS[id]}
              {id === "compare" && props.compareCount > 0 ? <span className="phone-tab-badge">{props.compareCount}</span> : null}
            </span>
            <span>{CANVAS_LABELS[id]}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** How far down a sheet's grabber must be dragged before the sheet closes. */
const DISMISS_DISTANCE = 80;

/**
 * Handlers for a sheet's grabber or header: a pointer drag moves the sheet (the closest element
 * marked `data-drag-sheet`) down, and past a threshold closes it. Taps on buttons still work.
 */
export function useDragToDismiss(onDismiss: () => void) {
  const drag = useRef<{ id: number; y: number; sheet: HTMLElement } | undefined>(undefined);
  const release = (offset: number) => {
    const current = drag.current;
    drag.current = undefined;
    if (!current) return;
    current.sheet.style.transition = "";
    current.sheet.style.transform = "";
    if (offset > DISMISS_DISTANCE) onDismiss();
  };
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, select")) return;
      const sheet = event.currentTarget.closest<HTMLElement>("[data-drag-sheet]");
      if (!sheet) return;
      drag.current = { id: event.pointerId, y: event.clientY, sheet };
      event.currentTarget.setPointerCapture(event.pointerId);
      sheet.style.transition = "none";
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (current?.id !== event.pointerId) return;
      current.sheet.style.transform = `translateY(${Math.max(0, event.clientY - current.y)}px)`;
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag.current?.id !== event.pointerId) return;
      release(event.clientY - drag.current.y);
    },
    onPointerCancel: () => release(0),
  };
}

/**
 * A half-height sheet from the bottom of the window, over a dimmed scrim. Esc, a tap on the scrim,
 * a drag down and the X close it. It renders into the body: the pill and the tab bar stay on every
 * view, and the scrim has to cover them too.
 */
/** `fullScreen` takes the whole screen, as the Inspector does on a phone, for content that wants the room. */
export function PhoneSheet(props: { title: string; open: boolean; onClose: () => void; fullScreen?: boolean; children: ReactNode }) {
  const drag = useDragToDismiss(props.onClose);
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);
  if (!open) return null;
  return createPortal(
    <div className="phone-sheet-scrim" onClick={onClose}>
      <div className={`phone-sheet${props.fullScreen ? " full-screen" : ""}`} data-drag-sheet role="dialog" aria-modal="true" aria-label={props.title}
        onClick={(event) => event.stopPropagation()}>
        <header className="phone-sheet-head" {...drag}>
          <span className="phone-sheet-grabber" aria-hidden="true" />
          <strong>{props.title}</strong>
          <button type="button" className="phone-sheet-close" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="phone-sheet-body">{props.children}</div>
      </div>
    </div>,
    document.body,
  );
}
