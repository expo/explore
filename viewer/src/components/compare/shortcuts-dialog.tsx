import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { formatShortcut, SHORTCUTS, type Shortcut } from "../../utils/shortcuts";
import type { CanvasView } from "../../utils/navigation";
import { useModalDialog } from "../../hooks/use-modal-dialog";

type Row = { label: string; keys: (Shortcut | string)[] };
type Group = { title: string; rows: Row[] };

/** What the reader is looking at decides which keys apply. */
export type ShortcutContext = {
  canvas: CanvasView;
  /** A changed screen's review is open in the Inspector. */
  review: boolean;
  /** The report has changed screens, so Compare and the changes menu exist. */
  hasChanges: boolean;
  /** The report can be handed off to an agent (a hosted preview). */
  handoff?: boolean;
};

const COMPARE = SHORTCUTS.compare;

function reviewGroup(context: ShortcutContext): Group {
  return {
    title: context.canvas === "compare" ? "Compare" : "Changed screen",
    rows: [
      // The Inspector stays on the screen the reader picked; only Compare steps through the changes.
      ...(context.canvas === "compare"
        ? [{ label: "Previous or next changed screen", keys: [COMPARE.previousScreen, COMPARE.nextScreen] }]
        : []),
      { label: "Next or previous changed area", keys: [COMPARE.nextArea, COMPARE.previousArea] },
      {
        label: "Clear the selected area",
        keys: [SHORTCUTS.find.close],
      },
      { label: "Split, Swipe, Flip", keys: [COMPARE.split, COMPARE.swipe, COMPARE.flip] },
      { label: "Show Before or After (Flip)", keys: [COMPARE.flipSide] },
      { label: "Move the divider (Swipe)", keys: [COMPARE.dividerLeft, COMPARE.dividerRight] },
      { label: "Show or hide outlines", keys: [COMPARE.outlines] },
      ...(context.canvas === "compare" ? [{ label: "Show or hide what changed", keys: [COMPARE.whatChanged] }] : []),
    ],
  };
}

const CAMERA: Group = {
  title: "Canvas",
  rows: [
    { label: "Zoom in or out", keys: [SHORTCUTS.camera.zoomIn, SHORTCUTS.camera.zoomOut] },
    { label: "Zoom to 100%", keys: [SHORTCUTS.camera.zoom100] },
    { label: "Fit the canvas", keys: [SHORTCUTS.camera.fit] },
    { label: "Center the canvas", keys: [SHORTCUTS.camera.center] },
  ],
};

/** The groups for one context, in two columns: what this section does, then the app-wide keys. */
export function shortcutGroups(context: ShortcutContext): Group[][] {
  const sections: CanvasView[] = context.hasChanges ? ["map", "screens", "compare"] : ["map", "screens"];
  const goTo: Group = {
    title: "Go to",
    rows: [
      {
        label: context.hasChanges ? "Map, Screens, Compare" : "Map, Screens",
        keys: sections.map((section) => SHORTCUTS.canvas[section]),
      },
      { label: "The same, by their place in the toolbar", keys: sections.map((section) => SHORTCUTS.canvasByNumber[section]) },
      { label: "Search screens", keys: [SHORTCUTS.app.search] },
      ...(context.handoff ? [{ label: "Hand off to AI", keys: [SHORTCUTS.app.handoff] }] : []),
      ...(context.hasChanges ? [{ label: "Changed screens menu", keys: [SHORTCUTS.app.changes] }] : []),
    ],
  };
  const view: Group = {
    title: "View",
    rows: [
      ...(context.canvas === "compare" ? [] : [{ label: "Show or hide the inspector", keys: [SHORTCUTS.panel.right] }]),
      { label: "Show this list", keys: ["?"] },
    ],
  };
  const mapGroup: Group = {
    title: "Map",
    rows: [
      { label: "Walk the map from the selected screen", keys: ["↑", "↓", "←", "→", "H J K L"] },
      { label: "Undo or redo moving a card", keys: [SHORTCUTS.edit.undo, SHORTCUTS.edit.redo] },
      { label: "Close the inspector, then deselect", keys: ["Esc"] },
    ],
  };
  const here: Group[] = context.canvas === "compare"
    ? [reviewGroup(context)]
    : [...(context.review ? [reviewGroup(context)] : []), ...(context.canvas === "map" ? [mapGroup] : []), CAMERA];
  return [here, [goTo, view]];
}

/** The keyboard reference, opened with "?" or the button at the end of the bottom bar. */
export function ShortcutsDialog(props: { context: ShortcutContext; onClose: () => void }) {
  const dialogRef = useModalDialog(true, props.onClose);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(".shortcuts-close")?.focus();
  }, [dialogRef]);
  return createPortal(
    <div className="shortcuts-scrim" onPointerDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <div ref={dialogRef} className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <header className="shortcuts-header">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <kbd>?</kbd>
          <button type="button" className="shortcuts-close" aria-label="Close keyboard shortcuts" onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="shortcuts-columns">
          {shortcutGroups(props.context).map((column, columnIndex) => (
            <div key={columnIndex} className="shortcuts-column">
              {column.map((group) => (
                <section key={group.title} className="shortcuts-group" aria-label={group.title}>
                  <h3>{group.title}</h3>
                  <dl>
                    {group.rows.map((row) => (
                      <div key={row.label} className="shortcuts-row">
                        <dt>{row.label}</dt>
                        <dd>
                          {row.keys.map((key) => {
                            const printed = typeof key === "string" ? key : formatShortcut(key);
                            return <kbd key={printed}>{printed}</kbd>;
                          })}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
