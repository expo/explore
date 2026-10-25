import { GitCompareArrows, LayoutGrid, Map, Search, Waypoints } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useState } from "react";
import { Tooltip } from "../shared/tooltip";
import { useCanvasVisibleFrame } from "./visible-frame-provider";
import { setToolbarRoom } from "../../utils/inspector-width";
import { CANVAS_NUMBER_KEYS, formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { KeyHint } from "../shared/key-hint";
import {
  CANVAS_DESCRIPTIONS,
  CANVAS_LABELS,
  type CanvasView,
} from "../../utils/navigation";

const VIEW_ICONS: Record<CanvasView, React.ReactNode> = {
  map: <Map />,
  screens: <LayoutGrid />,
  compare: <GitCompareArrows />,
  flows: <Waypoints />,
};

const TOOLBAR_MINIMUM_FRAME_WIDTH = 220;

type CanvasToolbarProps = {
  canvas: CanvasView;
  /** The views this report has, in the toolbar's order; Flows only with a flow review. */
  views: readonly CanvasView[];
  searchOpen: boolean;
  /** Page-wide actions beside Search (Hand off to AI). */
  actions?: React.ReactNode;
  onSelectCanvas: (canvas: CanvasView) => void;
  onOpenSearch: () => void;
  /** The bar's last button: the "More" menu with theme, full screen and keyboard shortcuts. */
  more: React.ReactNode;
};

/** Room kept between the toolbar and an Inspector wide enough to reach it. */
const TOOLBAR_PANEL_GAP = 12;

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { visibleFrame } = useCanvasVisibleFrame();
  // The bar as mounted now: it unmounts while hidden, and its last width is kept for deciding when
  // it fits again.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [ownWidth, setOwnWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setOwnWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  // The Inspector stops short of covering the bar: it may widen only as far as leaves the canvas
  // room for the bar and a gap either side.
  useLayoutEffect(() => {
    if (ownWidth > 0) setToolbarRoom(ownWidth + 2 * TOOLBAR_PANEL_GAP);
  }, [ownWidth]);
  // When responsive panels leave less room than the toolbar itself, hiding it is the only
  // collision-free layout. It returns as soon as either panel is collapsed. The Inspector's width is
  // capped to leave the bar its room, so this is a last resort: a desktop window (820px and up)
  // always fits the bar beside the narrowest Inspector.
  if (visibleFrame && visibleFrame.width < TOOLBAR_MINIMUM_FRAME_WIDTH) return null;
  // The toolbar is the canvas' persistent mode switcher. Panel geometry may raise it to avoid
  // bottom chrome, but must not pull it away from the window's stable horizontal centre. Only an
  // Inspector that would cover it (widened by the reader, or a narrow window's overlay) pushes it
  // left, and by just that much, never past the canvas' left edge: with no room left between the
  // two, it hides as it does above, which the Inspector's cap keeps from happening.
  let shift = 0;
  if (visibleFrame && typeof window !== "undefined") {
    const centredLeft = window.innerWidth / 2 - ownWidth / 2;
    const needed = centredLeft + ownWidth + TOOLBAR_PANEL_GAP - (visibleFrame.x + visibleFrame.width);
    const room = centredLeft - (visibleFrame.x + TOOLBAR_PANEL_GAP);
    if (needed > 0 && needed > room) return null;
    shift = Math.max(0, needed);
  }
  const style = visibleFrame ? ({
    "--canvas-visible-bottom-inset": `calc(100% - ${visibleFrame.y + visibleFrame.height}px)`,
    "--canvas-toolbar-shift": `${shift}px`,
  } as CSSProperties) : undefined;
  const views = props.views;

  return (
    <div ref={setElement} className="canvas-toolbar" role="toolbar" aria-label="Canvas tools" style={style}>
      {/* The contents grow with --ui-scale; the bar itself keeps its exact place. */}
      <div className="canvas-toolbar-inner">
      <div className="toolbar-group" role="group" aria-label="Canvas actions">
        <Tooltip
          label="Search"
          shortcut={formatShortcut(SHORTCUTS.app.search)}
          placement="top">
          <button
            type="button"
            className={`toolbar-button${props.searchOpen ? " active" : ""}`}
            aria-label="Search"
            aria-haspopup="dialog"
            aria-expanded={props.searchOpen}
            onClick={props.onOpenSearch}>
            <Search />
            <KeyHint shortcut={SHORTCUTS.app.search} />
          </button>
        </Tooltip>
        {props.actions}
      </div>

      <span className="toolbar-divider" aria-hidden="true" />

      <div className="toolbar-group" role="group" aria-label="Canvas view">
        {views.map((id) => {
          const active = props.canvas === id;
          // Every section is named, so the bar reads as the app's sections, not a row of icons.
          const labelled = true;
          return (
            <Tooltip
              key={id}
              label={CANVAS_LABELS[id]}
              description={CANVAS_DESCRIPTIONS[id]}
              shortcut={formatShortcut(SHORTCUTS.canvas[id])}
              placement="top"
              disabled={active}>
              <button
                type="button"
                className={`toolbar-button${active ? " active" : ""}${labelled ? " labelled" : ""}`}
                aria-label={CANVAS_LABELS[id]}
                aria-pressed={active}
                onClick={() => props.onSelectCanvas(id)}>
                {VIEW_ICONS[id]}
                <span className="toolbar-view-label" aria-hidden="true"><span>{CANVAS_LABELS[id]}</span></span>
                {CANVAS_NUMBER_KEYS ? <KeyHint shortcut={SHORTCUTS.canvasByNumber[id]} /> : null}
              </button>
            </Tooltip>
          );
        })}
      </div>


      <span className="toolbar-divider" aria-hidden="true" />
      {props.more}
      </div>
    </div>
  );
}
