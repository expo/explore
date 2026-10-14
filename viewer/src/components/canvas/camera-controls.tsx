import { useState, type CSSProperties } from "react";
import { Fullscreen, LocateFixed } from "lucide-react";
import { runCanvasZoomCommand } from "../../utils/canvas-zoom";
import { useCanvasZoom } from "../../hooks/use-canvas-zoom";
import { formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import { Menu, type MenuItem } from "../shared/menu";
import { Tooltip } from "../shared/tooltip";
import { FullscreenToggleButton, ThemeToggleButton, type ShellActionsProps, type ShellTheme } from "../panels/shell-actions";
import { useCanvasVisibleFrame } from "./visible-frame-provider";
import { setFollowSelection, useFollowSelection } from "../../utils/follow-selection";

type CanvasCameraControlsProps = {
  /** Makes room for the collapsed inspector controls at the window edge. */
  inspectorCollapsed: boolean;
  theme: ShellTheme;
  themePreference: ShellActionsProps["themePreference"];
  onToggleTheme: () => void;
  /** Fit, center and zoom act on a canvas; a page (Screens) or Compare shows only the page actions. */
  camera?: boolean;
};

const CAMERA_CONTROLS_MINIMUM_FRAME_WIDTH = 240;

function ZoomControl() {
  const [open, setOpen] = useState(false);
  const { zoom, api: camera } = useCanvasZoom();
  const following = useFollowSelection();
  const items: MenuItem[] = [
    { kind: "item", label: "Zoom in", shortcut: formatShortcut(SHORTCUTS.camera.zoomIn), onSelect: () => runCanvasZoomCommand("in") },
    { kind: "item", label: "Zoom out", shortcut: formatShortcut(SHORTCUTS.camera.zoomOut), onSelect: () => runCanvasZoomCommand("out") },
    {
      kind: "item",
      label: "Zoom to 100%",
      shortcut: formatShortcut(SHORTCUTS.camera.zoom100),
      onSelect: () => runCanvasZoomCommand("100"),
    },
    {
      kind: "item",
      label: "Zoom to fit",
      shortcut: formatShortcut(SHORTCUTS.camera.fit),
      onSelect: () => runCanvasZoomCommand("fit"),
    },
    {
      kind: "item",
      label: "Zoom to selection",
      disabled: !camera?.hasSelection(),
      onSelect: () => runCanvasZoomCommand("selection"),
    },
    { kind: "separator" },
    // Off by default: the camera moves only to a selection that is out of view.
    { kind: "checkbox", label: "Follow selection", checked: following, onSelect: () => setFollowSelection(!following) },
  ];

  return (
    <div className="zoom-anchor">
      <Tooltip label="Zoom" placement="bottom-end" disabled={open}>
        <button
          type="button"
          className="zoom-button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Zoom — ${Math.round(zoom * 100)}%`}
          disabled={!camera}
          onClick={() => setOpen((current) => !current)}>
          <span>{Math.round(zoom * 100)}%</span>
        </button>
      </Tooltip>
      <Menu items={items} open={open} onDismiss={() => setOpen(false)} />
    </div>
  );
}

function FitControl() {
  const { api: camera } = useCanvasZoom();
  // The persistent top-level action follows the current context. The Zoom menu keeps its
  // explicit whole-canvas and selection commands separate for readers who need either one.
  return (
    <Tooltip
      label="Fit canvas"
      shortcut={formatShortcut(SHORTCUTS.camera.fit)}
      placement="bottom">
      <button
        type="button"
        className="camera-action-button"
        aria-label="Fit canvas"
        disabled={!camera}
        onClick={() => runCanvasZoomCommand(camera?.hasSelection() ? "selection" : "fit")}>
        <Fullscreen aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

function RecenterControl() {
  const { api: camera } = useCanvasZoom();
  return (
    <Tooltip
      label="Center canvas"
      shortcut={formatShortcut(SHORTCUTS.camera.center)}
      placement="bottom">
      <button
        type="button"
        className="camera-action-button"
        aria-label="Center canvas"
        disabled={!camera}
        onClick={() => runCanvasZoomCommand("recenter")}>
        <LocateFixed aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * Camera actions belong to the canvas, not to either inspector panel. The page-level theme and
 * full screen actions share the toolbar, so it stays in one place whether the inspector is open
 * or not.
 */
export function CanvasCameraControls({ inspectorCollapsed, theme, themePreference, onToggleTheme, camera = true }: CanvasCameraControlsProps) {
  const { visibleFrame } = useCanvasVisibleFrame();
  if (visibleFrame && visibleFrame.width < CAMERA_CONTROLS_MINIMUM_FRAME_WIDTH) return null;
  const style = visibleFrame ? ({
    "--canvas-visible-right-inset": `calc(100% - ${visibleFrame.x + visibleFrame.width}px)`,
  } as CSSProperties) : undefined;

  return (
    <div
      className={`canvas-camera-controls${inspectorCollapsed ? " inspector-collapsed" : ""}`}
      style={style}
      role="group"
      aria-label="Canvas camera controls">
      <div className="canvas-camera-controls-inner">
      {camera ? (
        <>
          <FitControl />
          <span className="camera-control-divider" aria-hidden="true" />
          <RecenterControl />
          <span className="camera-control-divider" aria-hidden="true" />
          <ZoomControl />
          <span className="camera-control-divider" aria-hidden="true" />
        </>
      ) : null}
      <ThemeToggleButton theme={theme} themePreference={themePreference} onToggleTheme={onToggleTheme} className="camera-action-button" />
      <FullscreenToggleButton className="camera-action-button" />
      </div>
    </div>
  );
}
