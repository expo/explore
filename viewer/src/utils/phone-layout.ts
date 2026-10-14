import { useSyncExternalStore } from "react";

/**
 * The window width below which the Viewer uses its phone layout: lists instead of canvases, a
 * bottom sheet instead of the Inspector panel, and a tab bar instead of the floating toolbar.
 * It is a width, not a device: a narrow desktop window gets the same layout. 820px is the
 * narrowest window where desktop Compare's command bar clears the page actions on its row (an
 * iPad in portrait); anything narrower gets the phone layout. The same value is in phone.css.
 */
export const PHONE_MEDIA_QUERY = "(max-width: 819px)";

function query(): MediaQueryList | undefined {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined
    : window.matchMedia(PHONE_MEDIA_QUERY);
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return query()?.matches ?? false;
}

/** True while the window is narrower than the phone breakpoint. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
