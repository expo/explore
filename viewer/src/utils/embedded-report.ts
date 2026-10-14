import { activeArtifactReport, type ScreenshotPriority } from "./artifact-report";

const referencePattern = /^expo-explore-asset:([a-f0-9]{64})\.(png|jpg|mp4)$/;

/** Planning a canvas or ZIP only reads this small index; it never decodes image bytes. */
export function embeddedArtifactUrl(sha256: string): string | undefined {
  return activeArtifactReport?.reference(sha256);
}

export function isEmbeddedArtifactUrl(value: string): boolean {
  return referencePattern.test(value);
}

/**
 * Resolve only visible screenshots or an explicit download; cached promises share exact bytes.
 * Eager requests (an Inspector preview, a download) are decoded before lazy canvas images.
 */
export function resolveEmbeddedArtifactUrl(reference: string, priority: ScreenshotPriority = "lazy"): Promise<string> {
  if (activeArtifactReport) return activeArtifactReport.resolve(reference, priority);
  if (referencePattern.test(reference)) return Promise.reject(new Error(`Report screenshot is unavailable: ${reference}`));
  return Promise.resolve(reference);
}

/** Artifact screenshots release their Blob URL when no visible image or download uses it; the report keeps a few for a quick return. */
export function releaseEmbeddedArtifactUrl(reference: string): boolean {
  if (!activeArtifactReport) return false;
  activeArtifactReport.release(reference);
  return true;
}

export function viewerLocation(): Pick<Location, "pathname" | "search" | "hash"> {
  if (!activeArtifactReport) return window.location;
  // A report link opens on the Map, or in Compare when it names one changed screen (`view=compare`).
  const view = new URLSearchParams(window.location.search).get("view") === "compare" ? "/compare" : "/map";
  const url = new URL(window.location.hash.slice(1) || `${view}${window.location.search}`, "https://report.invalid");
  return { pathname: url.pathname, search: url.search, hash: "" };
}

/** Browser settings and private windows can deny storage. */
export const optionalStorage = {
  getItem(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  setItem(key: string, value: string): void { try { window.localStorage.setItem(key, value); } catch { /* Keep the in-memory preference. */ } },
  removeItem(key: string): void { try { window.localStorage.removeItem(key); } catch { /* Optional storage. */ } },
};
