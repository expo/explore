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

/**
 * Resolve, with a release bound to the report that resolved it: for a caller that may let go after a hosted preview has
 * switched to another target's report, whose screenshots it must not release. `release` says whether there was a report
 * to release to; `current` whether that report is still the one shown.
 */
export function leaseEmbeddedArtifactUrl(reference: string, priority: ScreenshotPriority = "lazy"): { url: Promise<string>; release: () => boolean; current: () => boolean } {
  const archive = activeArtifactReport;
  const current = () => activeArtifactReport === archive;
  if (!archive) return { url: resolveEmbeddedArtifactUrl(reference, priority), release: () => false, current };
  return { url: archive.resolve(reference, priority), release: () => { archive.release(reference); return true; }, current };
}

/** Artifact screenshots release their Blob URL when no visible image or download uses it; the report keeps a few for a quick return. */
export function releaseEmbeddedArtifactUrl(reference: string): boolean {
  if (!activeArtifactReport) return false;
  activeArtifactReport.release(reference);
  return true;
}

export function viewerLocation(): Pick<Location, "pathname" | "search" | "hash"> {
  if (!activeArtifactReport) return window.location;
  // A report link opens on the Map, on Flows for a flow review, or in Compare when it names one changed screen (`view=compare`).
  const view = new URLSearchParams(window.location.search).get("view") === "compare" ? "/compare"
    : activeArtifactReport.data.exploration?.flowReview ? "/flows" : "/map";
  const url = new URL(window.location.hash.slice(1) || `${view}${window.location.search}`, "https://report.invalid");
  return { pathname: url.pathname, search: url.search, hash: "" };
}

/** Browser settings and private windows can deny storage. */
export const optionalStorage = {
  getItem(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } },
  setItem(key: string, value: string): void { try { window.localStorage.setItem(key, value); } catch { /* Keep the in-memory preference. */ } },
  removeItem(key: string): void { try { window.localStorage.removeItem(key); } catch { /* Optional storage. */ } },
};
