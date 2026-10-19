import { useCallback, useEffect, useState } from "react";

function fullscreenActive(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement !== null;
}

/** Whether this browser can put the page in full screen at all (iPhone Safari cannot). */
export function fullscreenSupported(): boolean {
  return typeof document !== "undefined" && typeof document.documentElement.requestFullscreen === "function";
}

/** Tracks the page-level fullscreen state, including exits triggered by the browser itself. */
export function useFullscreen(): [boolean, () => void] {
  const [active, setActive] = useState(fullscreenActive);

  useEffect(() => {
    const sync = () => setActive(fullscreenActive());
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    if (!fullscreenSupported()) return;
    void document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  return [active, toggle];
}
