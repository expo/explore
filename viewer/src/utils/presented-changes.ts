import type { DiffStatus, ScreenDiff } from "./build-diff";
import { formatReviewerChange, sortReviewerChanges, type CaptureNotes, type ReviewerChangeFact } from "./review-model";

/** One line of "What changed": a reviewer note, a CI finding, or the legacy summary. */
export type PresentedChange = {
  id: string;
  copy: string;
  fact?: ReviewerChangeFact;
};

export function presentedChanges(diff: ScreenDiff | undefined): PresentedChange[] {
  if (!diff) return [];
  const note = diff.note?.trim();
  if (note) return [{ id: "review-note", copy: note }];
  const seen = new Set<string>();
  const reviewed = sortReviewerChanges(diff.reviewerChanges).flatMap((fact) => {
    const copy = formatReviewerChange(fact);
    if (!copy || seen.has(copy)) return [];
    seen.add(copy);
    return [{ id: fact.id, copy, fact }];
  });
  if (reviewed.length > 0) return reviewed;
  if (diff.noVisibleChange || diff.status === "unchanged" || diff.status === "not-compared" || diff.status === "unavailable") return [];
  const legacy = diff.changeSummary.trim();
  return legacy ? [{ id: "legacy-summary", copy: legacy }] : [];
}

/** What a missing side of a comparison shows instead of a screenshot. */
export function placeholderFor(side: "before" | "after", status: DiffStatus, notes?: CaptureNotes): string {
  if (side === "before" && status === "added") return "Not in baseline";
  if (side === "after" && status === "removed") return "Not in current build";
  // The report says why a screen that exists on this side was not captured.
  return notes?.[side] ?? "No screenshot";
}
