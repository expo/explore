import { useRef, type KeyboardEvent, type RefObject } from "react";
import { Maximize2 } from "lucide-react";
import { Menu } from "../shared/menu";
import { ChangesPanel } from "./changes";
import type { FocusStatus } from "../../utils/navigation";
import type { MapIndex } from "../../utils/model";
import type { BuildDiff } from "../../utils/build-diff";

/** What the Changes menu lists and how it reports a choice, wherever it is opened from. */
export type ChangesMenuData = {
  diff: BuildDiff;
  index: MapIndex;
  selectedScreenId?: string | undefined;
  focus: FocusStatus[];
  focusCounts: Record<FocusStatus, number>;
  onChangeFocus: (focus: FocusStatus[]) => void;
  onOpenChangedScreen: (screenId: string) => void;
  /** Leaves out the "Review all" row when it is omitted, as in Compare itself. */
  onReviewAll?: (() => void) | undefined;
};

/**
 * The whole Changes list in a popover: status filters, the changed screens and a way into
 * Compare. The pill opens it on the canvases; Compare's title opens it in Compare.
 */
export function ChangesMenu(props: ChangesMenuData & {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  align?: "start" | "center";
  onDismiss: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // ↑ and ↓ walk the changed screens in the open menu, like a native list.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(".changes-screen-row") ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLElement);
    const next = current < 0
      ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
      : Math.min(rows.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  };
  return (
    <Menu
      open={props.open}
      anchorRef={props.anchorRef}
      initialFocusRef={listRef}
      align={props.align ?? "start"}
      className="changes-menu"
      onDismiss={props.onDismiss}>
      <div ref={listRef} className="changes-menu-body" tabIndex={-1} role="group" aria-label="Changes menu"
        onKeyDown={onKeyDown}>
        <ChangesPanel
          diff={props.diff}
          index={props.index}
          active={props.focus}
          counts={props.focusCounts}
          {...(props.selectedScreenId ? { selectedScreenId: props.selectedScreenId } : {})}
          onChangeActive={props.onChangeFocus}
          onOpenScreen={(id) => {
            props.onDismiss();
            props.onOpenChangedScreen(id);
          }}
        />
        {props.onReviewAll ? (
          <button
            type="button"
            className="changes-menu-review"
            onClick={() => {
              props.onDismiss();
              props.onReviewAll?.();
            }}>
            <Maximize2 aria-hidden="true" />
            <span>Review all in compare view</span>
          </button>
        ) : null}
      </div>
    </Menu>
  );
}
