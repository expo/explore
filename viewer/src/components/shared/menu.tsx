import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { AutoHideScrollArea } from "./auto-hide-scroll-area";

export type MenuItem =
  | { kind: "separator" }
  | { kind: "action"; label: string; icon?: ReactNode; tone?: "danger"; disabled?: boolean; shortcut?: string; onSelect: () => void }
  | { kind: "submenu"; label: string; items: MenuItem[] }
  | {
    kind: "item";
    label: string;
    icon?: ReactNode;
    description?: ReactNode;
    checked?: boolean;
    disabled?: boolean;
    /** Rendered right-aligned; the caller owns the key handling. */
    shortcut?: string;
    /** Separate checkbox control; toggling it keeps the menu and selection intact. */
    trailingToggle?: { label: string; checked: boolean; icon: ReactNode; onSelect: () => void };
    onSelect: () => void;
  }
  | {
    kind: "checkbox";
    label: string;
    checked: boolean;
    disabled?: boolean;
    /** Filters can stay open while several independent options are toggled. */
    closeOnSelect?: boolean;
    /** Rendered right-aligned; the caller owns the key handling. */
    shortcut?: string;
    onSelect: () => void;
  };

type MenuListProps = {
  items: MenuItem[];
  /** Accessible name for the root popup; nested submenus are labelled by their trigger. */
  ariaLabel?: string;
  /** Close just this level — Escape and ArrowLeft inside a submenu. */
  onCloseLevel: () => void;
  /** Close the whole popover — choosing a leaf item. */
  onCloseRoot: () => void;
  /** Nested lists open to the right of their parent row instead of below the anchor. */
  nested?: boolean;
};

export function MenuList({ items, ariaLabel, onCloseLevel, onCloseRoot, nested = false }: MenuListProps) {
  const [openIndex, setOpenIndex] = useState<number>();
  const listRef = useRef<HTMLDivElement>(null);
  const cascading = items.some((item) => item.kind === "submenu");

  const focusRow = (direction: 1 | -1, from: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>(":scope > * > .menu-row, :scope > .menu-row");
    if (!rows || rows.length === 0) return;
    let next = from;
    for (let step = 0; step < rows.length; step += 1) {
      next = (next + direction + rows.length) % rows.length;
      const row = rows[next];
      if (row && !row.hasAttribute("disabled")) {
        row.focus();
        return;
      }
    }
  };

  return (
    <AutoHideScrollArea
      ref={listRef}
      shellClassName={`menu-list${nested ? " menu-list-nested" : ""}${cascading ? " menu-list-cascade" : ""}`}
      className={`menu-list-scroll${cascading ? " menu-list-scroll-cascade" : ""}`}
      role="menu"
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCloseLevel();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(
          ":scope > * > .menu-row, :scope > .menu-row",
        ) ?? [])];
        const current = rows.indexOf(document.activeElement as HTMLElement);
        focusRow(event.key === "ArrowDown" ? 1 : -1, current < 0 ? (event.key === "ArrowDown" ? -1 : 0) : current);
      }}>
      {items.map((item, index) => {
        if (item.kind === "separator") {
          return <div key={`separator-${index}`} className="menu-separator" role="separator" />;
        }
        if (item.kind === "submenu") {
          const open = openIndex === index;
          return (
            <div
              key={item.label}
              className="menu-branch"
              onPointerEnter={() => setOpenIndex(index)}
              onPointerLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setOpenIndex((current) => (current === index ? undefined : current));
                }
              }}>
              <button
                type="button"
                className={`menu-row${open ? " menu-row-open" : ""}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                // Hover already opens it; a click must not toggle it back shut.
                onClick={() => setOpenIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setOpenIndex(index);
                  }
                  if (event.key === "ArrowLeft" && nested) {
                    event.preventDefault();
                    onCloseLevel();
                  }
                }}>
                <span className="menu-row-check" aria-hidden="true" />
                <span className="menu-row-label">{item.label}</span>
                <ChevronRight className="menu-row-chevron" />
              </button>
              {open && (
                <MenuList
                  items={item.items}
                  onCloseLevel={() => setOpenIndex(undefined)}
                  onCloseRoot={onCloseRoot}
                  nested
                />
              )}
            </div>
          );
        }
        const row = (
          <button
            key={item.label}
            type="button"
            className={`menu-row${item.kind === "action" && item.tone === "danger" ? " menu-row-danger" : ""}`}
            role={item.kind === "action" ? "menuitem" : item.kind === "checkbox" ? "menuitemcheckbox" : "menuitemradio"}
            aria-checked={item.kind === "action" ? undefined : Boolean(item.checked)}
            {...(item.disabled ? { disabled: true } : {})}
            onClick={() => {
              item.onSelect();
              if (item.kind !== "checkbox" || item.closeOnSelect !== false) onCloseRoot();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" && nested) {
                event.preventDefault();
                onCloseLevel();
              }
            }}>
            <span className="menu-row-check">
              {item.kind === "action" ? item.icon : item.checked ? <Check /> : null}
            </span>
            {item.kind === "item" && item.icon ? <span className="menu-row-icon" aria-hidden="true">{item.icon}</span> : null}
            <span className="menu-row-label">{item.label}{item.kind === "item" && item.description ? <span className="menu-row-description">{item.description}</span> : null}</span>
            {item.shortcut ? <span className="menu-row-shortcut">{item.shortcut}</span> : null}
          </button>
        );
        if (item.kind === "item" && item.trailingToggle) {
          const toggle = item.trailingToggle;
          return <div key={item.label} className="menu-row-with-toggle">
            {row}
            <button type="button" className="menu-row menu-row-toggle" role="menuitemcheckbox"
              aria-label={toggle.label} aria-checked={toggle.checked} title={toggle.label}
              onClick={toggle.onSelect}>{toggle.icon}</button>
          </div>;
        }
        return row;
      })}
    </AutoHideScrollArea>
  );
}

type MenuProps = {
  items?: MenuItem[];
  children?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  open: boolean;
  ariaLabel?: string;
  className?: string;
  onDismiss: () => void;
  /** Anchored menus escape panel clipping and keep trigger clicks from dismissing twice. */
  anchorRef?: RefObject<HTMLElement | null>;
  /**
   * Which part of the trigger the menu lines up with: "end" suits a right-aligned value such as
   * an inspector pop-up, "center" a centred title.
   */
  align?: "start" | "end" | "center";
};

/** Popover shell: handles outside clicks and Escape from outside the list. */
export function Menu({ items = [], children, initialFocusRef, open, ariaLabel, className, onDismiss, anchorRef, align = "start" }: MenuProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);

  useLayoutEffect(() => {
    if (!open) return;
    const opener = anchorRef?.current ?? document.activeElement;
    const popupElement = popoverRef.current;
    const place = () => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      const popup = popoverRef.current?.getBoundingClientRect();
      if (rect && popup) setPosition({
        top: Math.max(8, rect.bottom + 6 + popup.height <= window.innerHeight - 8 ? rect.bottom + 6 : rect.top - popup.height - 6),
        left: Math.max(8, Math.min(
          align === "end" ? rect.right - popup.width
            : align === "center" ? rect.left + rect.width / 2 - popup.width / 2
              : rect.left,
          window.innerWidth - popup.width - 8,
        )),
      });
    };
    place();
    // A choice menu opens on its current choice, as native pop-ups do.
    (initialFocusRef?.current
      ?? popoverRef.current?.querySelector<HTMLElement>('.menu-row[role="menuitemradio"][aria-checked="true"]:not(:disabled)')
      ?? popoverRef.current?.querySelector<HTMLElement>(".menu-row:not(:disabled)"))?.focus();
    // An anchored menu follows its trigger when a panel behind it scrolls; its own list may scroll freely.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      place();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!popoverRef.current?.contains(event.target) && !anchorRef?.current?.contains(event.target)) dismissRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismissRef.current(); }
      if (event.key === "Tab" && !initialFocusRef) dismissRef.current();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (initialFocusRef && event.target instanceof Node
        && !popoverRef.current?.contains(event.target) && !anchorRef?.current?.contains(event.target)) dismissRef.current();
    };
    // A trigger can also move with no scroll or resize, as the bottom bar does when the Inspector
    // opens beside it; an anchored menu checks where its trigger is once a frame while it is open.
    let frame = 0;
    let anchorAt = "";
    const follow = () => {
      const rect = anchorRef?.current?.getBoundingClientRect();
      const at = rect ? `${rect.left},${rect.top}` : "";
      if (at !== anchorAt) {
        if (anchorAt) place();
        anchorAt = at;
      }
      frame = requestAnimationFrame(follow);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", place);
    if (anchorRef) {
      window.addEventListener("scroll", onScroll, true);
      follow();
    }
    window.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("focusin", onFocusIn);
      if (opener instanceof HTMLElement && (document.activeElement === document.body || popupElement?.contains(document.activeElement))) opener.focus();
    };
  }, [open, anchorRef, initialFocusRef, align]);

  if (!open) return null;
  const menu = (
    <div ref={popoverRef} className={`menu-popover${className ? ` ${className}` : ""}`} style={anchorRef ? { position: "fixed", ...position, zIndex: 1200, maxHeight: "calc(100dvh - 16px)", overflowY: "auto" } : undefined}>
      {children ?? <MenuList
        items={items}
        {...(ariaLabel ? { ariaLabel } : {})}
        onCloseLevel={onDismiss}
        onCloseRoot={onDismiss}
      />}
    </div>
  );
  return anchorRef ? createPortal(menu, document.body) : menu;
}
