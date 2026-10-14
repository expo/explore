import { useEffect, useState } from "react";
import { Maximize, Minimize, Moon, Sun, SunMoon } from "lucide-react";
import { Tooltip } from "../shared/tooltip";
import type { ThemePreference } from "../../utils/navigation";

export type ShellTheme = "light" | "dark";

export type ShellActionsProps = {
  /** The theme on screen: the preference, or the system's when that is Auto. */
  theme: ShellTheme;
  themePreference: ThemePreference;
  /** Steps Auto → Dark → Light → Auto. */
  onToggleTheme: () => void;
  /** The host toolbar's button class, so the actions match their neighbours. */
  className?: string;
};

function fullscreenActive(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement !== null;
}

/** Tracks the page-level fullscreen state, including exits triggered by the browser itself. */
export function useFullscreen(): [boolean, () => void] {
  const [active, setActive] = useState(fullscreenActive);

  useEffect(() => {
    const sync = () => setActive(fullscreenActive());
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (typeof document.documentElement.requestFullscreen !== "function") return;
    void document.documentElement.requestFullscreen().catch(() => {});
  };

  return [active, toggle];
}

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "Theme: Auto (system)",
  dark: "Theme: Dark",
  light: "Theme: Light",
};

/** The theme button shows the current preference; a press steps Auto → Dark → Light. */
export function ThemeToggleButton(props: ShellActionsProps) {
  const Icon = props.themePreference === "system" ? SunMoon : props.themePreference === "dark" ? Moon : Sun;
  return (
    <Tooltip label={THEME_LABELS[props.themePreference]} placement="bottom">
      <button
        type="button"
        className={props.className ?? "icon-button"}
        aria-label="Toggle theme"
        data-theme-preference={props.themePreference}
        onClick={props.onToggleTheme}>
        <Icon aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export function FullscreenToggleButton(props: Pick<ShellActionsProps, "className">) {
  const [active, toggle] = useFullscreen();
  const label = active ? "Exit full screen" : "Enter full screen";
  return (
    <Tooltip label={label} placement="bottom">
      <button
        type="button"
        className={props.className ?? "icon-button"}
        aria-label={label}
        aria-pressed={active}
        onClick={toggle}>
        {active ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
      </button>
    </Tooltip>
  );
}
