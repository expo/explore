import { GitCompareArrows, Keyboard, LayoutGrid, Map, Search } from "lucide-react";
import { type CSSProperties } from "react";
import { Tooltip } from "../shared/tooltip";
import { useCanvasVisibleFrame } from "./visible-frame-provider";
import { CANVAS_NUMBER_KEYS, formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { KeyHint } from "../shared/key-hint";
import {
  CANVAS_DESCRIPTIONS,
  CANVAS_LABELS,
  type CanvasView,
} from "../../utils/navigation";
import { CANVAS_VIEW_ORDER } from "../../utils/canvas-view-transition";

const VIEW_ICONS: Record<CanvasView, React.ReactNode> = {
  map: <Map />,
  screens: <LayoutGrid />,
  compare: <GitCompareArrows />,
};

const TOOLBAR_MINIMUM_FRAME_WIDTH = 220;

type CanvasToolbarProps = {
  canvas: CanvasView;
  searchOpen: boolean;
  /** How many changed screens Compare holds, shown as a badge on its button. Compare's own header
      steps through them. */
  compareCount?: number;
  /** Page-wide actions beside Search (Hand off to AI). */
  actions?: React.ReactNode;
  onSelectCanvas: (canvas: CanvasView) => void;
  onOpenSearch: () => void;
  onOpenShortcuts: () => void;
};

export function CanvasToolbar(props: CanvasToolbarProps) {
  const { visibleFrame } = useCanvasVisibleFrame();
  // When responsive panels leave less room than the toolbar itself, hiding it is the only
  // collision-free layout. It returns as soon as either panel is collapsed.
  if (visibleFrame && visibleFrame.width < TOOLBAR_MINIMUM_FRAME_WIDTH) return null;
  // The toolbar is the canvas' persistent mode switcher. Panel geometry may raise it to avoid
  // bottom chrome, but must not pull it away from the window's stable horizontal centre.
  const style = visibleFrame ? ({
    "--canvas-visible-bottom-inset": `calc(100% - ${visibleFrame.y + visibleFrame.height}px)`,
  } as CSSProperties) : undefined;
  const views = CANVAS_VIEW_ORDER;

  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools" style={style}>
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
                <span className="toolbar-corner">
                  {CANVAS_NUMBER_KEYS ? <KeyHint shortcut={SHORTCUTS.canvasByNumber[id]} /> : null}
                  {id === "compare" && props.compareCount ? (
                    <span className="toolbar-badge" aria-hidden="true">{props.compareCount}</span>
                  ) : null}
                </span>
              </button>
            </Tooltip>
          );
        })}
      </div>


      <span className="toolbar-divider" aria-hidden="true" />
      <Tooltip label="Keyboard shortcuts" shortcut="?" placement="top">
        <button type="button" className="toolbar-button" aria-label="Keyboard shortcuts"
          aria-haspopup="dialog" onClick={props.onOpenShortcuts}>
          <Keyboard />
        </button>
      </Tooltip>
      </div>
    </div>
  );
}
