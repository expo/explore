import type { PublicReview } from "./capture.js";

/** Portable report data. The hosted browser supplies rendering and asset URLs. */
export type ArtifactReport = {
  kind: "explore.report";
  review: PublicReview;
  assets: Array<{ sha256: string; path: string }>;
};
