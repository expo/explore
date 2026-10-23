import type { ScreensLayout } from "./navigation";

function storageKey(runId: string): string {
  return `explore:screens-layout:${runId}`;
}

/** The layout Screens last showed for a report, so opening Screens again shows it; unavailable storage remembers nothing. */
export function readScreensLayout(runId: string | undefined): ScreensLayout | undefined {
  if (!runId) return undefined;
  try {
    return localStorage.getItem(storageKey(runId)) === "filmstrip" ? "filmstrip" : undefined;
  } catch { return undefined; }
}

export function writeScreensLayout(runId: string | undefined, layout: ScreensLayout): void {
  if (!runId) return;
  try {
    if (layout === "filmstrip") localStorage.setItem(storageKey(runId), layout);
    else localStorage.removeItem(storageKey(runId));
  } catch { /* The layout lasts for this visit only. */ }
}
