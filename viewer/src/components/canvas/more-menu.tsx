import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Ellipsis, Keyboard, Maximize, Minimize, Monitor, Moon, PanelRight, Sun } from "lucide-react";
import { Menu } from "../shared/menu";
import { Tooltip } from "../shared/tooltip";
import { formatShortcut, SHORTCUTS } from "../../utils/shortcuts";
import type { ThemePreference } from "../../utils/navigation";

const THEME_OPTIONS: { id: ThemePreference; label: string; title: string; icon: ReactNode }[] = [
  { id: "system", label: "Auto", title: "Auto (system)", icon: <Monitor /> },
  { id: "light", label: "Light", title: "Light", icon: <Sun /> },
  { id: "dark", label: "Dark", title: "Dark", icon: <Moon /> },
];

export type MoreMenuProps = {
  themePreference: ThemePreference;
  onChangeTheme: (theme: ThemePreference) => void;
  /** Full screen's state and toggle; left out where the browser has no full screen. */
  fullscreen?: { active: boolean; onToggle: () => void } | undefined;
  /** The Inspector's state and toggle; left out where there is no Inspector (Compare). */
  inspector?: { open: boolean; onToggle: () => void } | undefined;
  onOpenShortcuts: () => void;
};

/**
 * The bottom bar's last button: the page-wide settings that have no place on a canvas. Every row
 * reads the same way, icon, label, control and key: the Viewer's theme (Auto, Light, Dark; T
 * flips light and dark), full screen (F), the Inspector (I) and the keyboard shortcuts (?).
 */
export function MoreMenu(props: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The menu opens on the current theme, as a choice menu opens on its current choice.
  const currentThemeRef = useRef<HTMLButtonElement>(null);
  const themeLabelId = useId();
  const close = useCallback(() => setOpen(false), []);

  // ↑ and ↓ move between rows (the theme row's stop is its current choice), ← and → between the
  // three themes. Tab leaves the menu, as it does a native one. The menu's keys are its own: Esc
  // and the arrows are marked used, so a canvas behind it (Compare's screens and areas) leaves them.
  // ? opens the shortcuts as the row does, so the dialog hands focus back to More.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) return;
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      close();
      props.onOpenShortcuts();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const radios = [...list.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      const at = active ? radios.indexOf(active) : -1;
      if (at < 0) return;
      radios[(at + (event.key === "ArrowRight" ? 1 : -1) + radios.length) % radios.length]?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = [...list.querySelectorAll<HTMLElement>("[data-more-row]")];
    if (rows.length === 0) return;
    const at = rows.findIndex((row) => active && row.contains(active));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
        : (Math.max(at, event.key === "ArrowDown" ? -1 : 0) + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    const row = rows[next];
    const stop = row?.matches('[role="menuitem"], [role="menuitemcheckbox"]') ? row
      : row?.querySelector<HTMLElement>('[aria-checked="true"]') ?? row?.querySelector<HTMLElement>('[role="menuitemradio"]');
    stop?.focus();
  };

  return (
    <>
      <Tooltip label="More" placement="top" disabled={open}>
        <button
          ref={buttonRef}
          type="button"
          className={`toolbar-button${open ? " active" : ""}`}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}>
          <Ellipsis />
        </button>
      </Tooltip>
      <Menu open={open} anchorRef={buttonRef} initialFocusRef={currentThemeRef} align="end" className="more-menu" onDismiss={close}>
        <div ref={listRef} className="more-menu-list" role="menu" aria-label="More" onKeyDown={onKeyDown}>
          <div className="more-menu-row" role="group" aria-labelledby={themeLabelId} data-more-row>
            <span className="more-menu-icon" aria-hidden="true"><Moon /></span>
            <span className="more-menu-label" id={themeLabelId}>Theme</span>
            <span className="more-theme-switch">
              {THEME_OPTIONS.map((option) => {
                const checked = props.themePreference === option.id;
                return (
                  <button
                    key={option.id}
                    ref={checked ? currentThemeRef : undefined}
                    type="button"
                    className="more-theme-option"
                    role="menuitemradio"
                    aria-checked={checked}
                    aria-label={option.label}
                    title={option.title}
                    tabIndex={-1}
                    onClick={() => props.onChangeTheme(option.id)}>
                    {option.icon}
                  </button>
                );
              })}
            </span>
            <kbd className="more-menu-key" aria-hidden="true">{formatShortcut(SHORTCUTS.appearance.theme)}</kbd>
          </div>
          {props.fullscreen ? (
            <button
              type="button"
              className="more-menu-row more-menu-item"
              role="menuitem"
              tabIndex={-1}
              aria-keyshortcuts={SHORTCUTS.view.fullscreen.key}
              data-more-row
              onClick={() => {
                props.fullscreen?.onToggle();
                close();
              }}>
              <span className="more-menu-icon" aria-hidden="true">{props.fullscreen.active ? <Minimize /> : <Maximize />}</span>
              <span className="more-menu-label">{props.fullscreen.active ? "Exit full screen" : "Full screen"}</span>
              <kbd className="more-menu-key" aria-hidden="true">{formatShortcut(SHORTCUTS.view.fullscreen)}</kbd>
            </button>
          ) : null}
          {props.inspector ? (
            <button
              type="button"
              className="more-menu-row more-menu-item"
              role="menuitemcheckbox"
              aria-checked={props.inspector.open}
              tabIndex={-1}
              aria-keyshortcuts={SHORTCUTS.panel.right.key}
              data-more-row
              onClick={() => {
                props.inspector?.onToggle();
                close();
              }}>
              <span className="more-menu-icon" aria-hidden="true"><PanelRight /></span>
              <span className="more-menu-label">Inspector</span>
              {props.inspector.open ? <span className="more-menu-check" aria-hidden="true"><Check /></span> : null}
              <kbd className="more-menu-key" aria-hidden="true">{formatShortcut(SHORTCUTS.panel.right)}</kbd>
            </button>
          ) : null}
          <button
            type="button"
            className="more-menu-row more-menu-item"
            role="menuitem"
            tabIndex={-1}
            aria-haspopup="dialog"
            aria-keyshortcuts="?"
            data-more-row
            onClick={() => {
              close();
              props.onOpenShortcuts();
            }}>
            <span className="more-menu-icon" aria-hidden="true"><Keyboard /></span>
            <span className="more-menu-label">Keyboard shortcuts</span>
            <kbd className="more-menu-key" aria-hidden="true">?</kbd>
          </button>
        </div>
      </Menu>
    </>
  );
}
