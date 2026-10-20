import type { CaptureBundle, CaptureOutcome } from "../contracts/capture.js";
import { bundleColorSchemes, failedPassOutcome, routeIdOfScreen, schemeScreenId } from "./appearance.js";
import { CiError } from "../shared/ci-errors.js";

type CaptureSide = CaptureBundle["side"];
export type CaptureHealthIssue = {
  side: CaptureSide;
  surfaceId: string;
  code: string;
  message: string;
  nextAction: string;
};
export type CaptureHealthInput = { bundle: CaptureBundle; selectedIds: readonly string[]; side?: CaptureSide };

/** Evidence is reusable only when the observed destination and exact screenshot are both bound to this outcome. */
const hasVerifiedOutcome = (outcome: CaptureOutcome | undefined) => outcome?.status === "captured" && outcome.landing === "verified";

/** The health issue for a captured frame whose destination was not attributed: what the app showed instead, when known. */
export function unattributedIssue(outcome: CaptureOutcome): { code: string; message: string; nextAction: string } {
  const observed = outcome.observed;
  if (observed?.reason === "landing-mismatch") {
    return { code: "ROUTE_LANDING_MISMATCH", message: outcome.reason ?? "The app showed another screen for this route's link. The frame is in the report as unattributed evidence.",
      nextAction: "Check the app's handling of this route's link (the frame shows what it opened instead), then rerun capture." };
  }
  if (observed?.reason === "observer-not-ready") {
    return { code: "CAPTURE_OBSERVER_NOT_READY", message: outcome.reason ?? "The route observer answered earlier in this session but reported nothing for this route. The frame is in the report as unattributed evidence.",
      nextAction: "Check what the app does when this link opens (a remount or redirect at load hides the observer), then rerun capture." };
  }
  return { code: "CAPTURE_DESTINATION_UNVERIFIED", message: "A screenshot was taken without verifying its destination route.",
    nextAction: "Install the route observer in both revisions and correct any prerequisite navigation or redirects before recapturing." };
}

export function hasVerifiedCapture(bundle: CaptureBundle, id: string): boolean {
  const outcome = bundle.outcomes[id];
  const image = bundle.images[id];
  return Boolean(outcome?.status === "captured" && outcome.landing === "verified" && image
    && /^[a-f0-9]{64}$/.test(image.sha256) && outcome.screenshotSha256 === image.sha256
    && image.sourceCommit === bundle.gitCommit);
}

/** Validate every planned target, even when a side silently omitted it from its own selected IDs. */
export function captureHealthIssues(bundle: CaptureBundle, expectedIds: readonly string[], side: CaptureSide = bundle.side): CaptureHealthIssue[] {
  const issues: CaptureHealthIssue[] = [];
  const add = (surfaceId: string, code: string, message: string, nextAction: string) => {
    issues.push({ side, surfaceId, code, message, nextAction });
  };
  const inventoryAction = "Regenerate the capture bundle from the exact source plan; do not omit failed targets from the selected inventory.";
  if (bundle.side !== side) add("*", "CAPTURE_SIDE_MISMATCH", `Expected ${side} evidence, received ${bundle.side}.`, inventoryAction);
  if (!/^[a-f0-9]{40}$/.test(bundle.gitCommit)) add("*", "CAPTURE_COMMIT_INVALID", "Capture evidence has no valid source commit.", inventoryAction);
  const expected = new Set(expectedIds);
  const selected = new Set(bundle.selectedSurfaceIds);
  if (expected.size !== expectedIds.length || selected.size !== bundle.selectedSurfaceIds.length) {
    add("*", "CAPTURE_SELECTION_DUPLICATE", "The planned or captured inventory contains duplicate targets.", inventoryAction);
  }
  // A dark+light capture carries each secondary scheme's frame as `<target>@<scheme>`: expected evidence, keyed off the route's outcome.
  const secondarySchemes = bundleColorSchemes(bundle).slice(1);
  const expectedSecondary = new Set([...expected].flatMap(id => secondarySchemes.map(scheme => schemeScreenId(id, scheme))));
  const extras = new Set([...bundle.selectedSurfaceIds, ...Object.keys(bundle.images), ...Object.keys(bundle.outcomes)]);
  for (const id of [...extras].sort()) {
    // A secondary frame is expected evidence; its own outcome is the failure of that appearance pass, or its verified
    // frame when the primary pass has none (the route is then published from this appearance alone).
    // A pass that failed as a whole (sessionFailures) records its failure under every route's `<target>@<scheme>`.
    const primaryCaptured = bundle.outcomes[routeIdOfScreen(id).routeId]?.status === "captured";
    if (!expected.has(id) && !(expectedSecondary.has(id) && !selected.has(id)
      && (hasVerifiedOutcome(bundle.outcomes[id]) !== primaryCaptured || failedPassOutcome(bundle, id)))) {
      add(id, "CAPTURE_TARGET_UNEXPECTED", "Capture evidence contains a target absent from the source plan.", inventoryAction);
    }
  }
  const provenanceValid = (image: CaptureBundle["images"][string]) => image.sourceCommit === bundle.gitCommit && image.path && image.buildId
    && Number.isSafeInteger(image.width) && image.width >= 1 && Number.isSafeInteger(image.height) && image.height >= 1
    && Number.isFinite(Date.parse(image.capturedAt));
  for (const id of [...expectedSecondary].sort()) {
    const { routeId } = routeIdOfScreen(id);
    const image = bundle.images[id];
    const own = bundle.outcomes[id];
    if (!selected.has(routeId) || (bundle.outcomes[routeId]?.status !== "captured" && !hasVerifiedOutcome(own))) continue;
    if (own && own.status !== "captured") {
      add(id, own.error?.code ?? `CAPTURE_${own.status.replaceAll("-", "_").toUpperCase()}`,
        own.reason ?? own.error?.message ?? `Capture ended with status ${own.status}.`,
        own.error?.nextAction ?? "Inspect this appearance pass's setup and capture diagnostics, correct the failed prerequisite, and rerun capture.");
    } else if (own && own.landing !== "verified") {
      const issue = unattributedIssue(own);
      add(id, issue.code, issue.message, issue.nextAction);
    } else if (!image) add(id, "CAPTURE_IMAGE_MISSING", "The secondary appearance of a captured target has no screenshot.", "Rerun capture so every scheme of capture.appearance captures this target.");
    else if (!/^[a-f0-9]{64}$/.test(image.sha256) || !provenanceValid(image)) {
      add(id, "CAPTURE_IMAGE_PROVENANCE_INVALID", "The screenshot metadata does not identify valid evidence for this source revision.", "Recapture this exact source revision and preserve its build, timestamp, dimensions, and hash through export.");
    }
  }
  for (const id of [...expected].sort()) {
    if (!selected.has(id)) {
      add(id, "CAPTURE_TARGET_MISSING", "A planned target is absent from the capture inventory.", inventoryAction);
      continue;
    }
    const outcome = bundle.outcomes[id];
    const image = bundle.images[id];
    if (!outcome) {
      add(id, "CAPTURE_OUTCOME_MISSING", "A planned target has no recorded capture outcome.", "Inspect the capture logs and rerun the missing target; every planned target must have a verified screenshot.");
    } else if (outcome.status !== "captured") {
      add(id, outcome.error?.code ?? `CAPTURE_${outcome.status.replaceAll("-", "_").toUpperCase()}`,
        outcome.reason ?? outcome.error?.message ?? `Capture ended with status ${outcome.status}.`,
        outcome.error?.nextAction ?? (outcome.status === "missing-params"
          ? "Resolve this route's parameters from source or config.parameters, then rerun capture."
          : outcome.status === "budget-exhausted"
            ? "Increase the capture action or time budget enough to finish the planned targets, then rerun capture."
            : "Inspect the observed destination and setup diagnostics, correct the failed navigation prerequisite, and rerun capture."));
    } else if (outcome.landing !== "verified") {
      const issue = unattributedIssue(outcome);
      add(id, issue.code, issue.message, issue.nextAction);
    } else if (!image) {
      add(id, "CAPTURE_IMAGE_MISSING", "The capture outcome has no screenshot.", "Inspect screenshot export and retained capture artifacts, then recapture this target.");
    } else if (!/^[a-f0-9]{64}$/.test(image.sha256) || outcome.screenshotSha256 !== image.sha256) {
      add(id, "CAPTURE_IMAGE_BINDING_INVALID", "The verified capture outcome is not bound to the exported screenshot hash.", "Recapture this target and preserve the screenshot hash from verification through export; do not reuse this evidence.");
    } else if (image.sourceCommit !== bundle.gitCommit || !image.path || !image.buildId
      || !Number.isSafeInteger(image.width) || image.width < 1 || !Number.isSafeInteger(image.height) || image.height < 1
      || !Number.isFinite(Date.parse(image.capturedAt))) {
      add(id, "CAPTURE_IMAGE_PROVENANCE_INVALID", "The screenshot metadata does not identify valid evidence for this source revision.", "Recapture this exact source revision and preserve its build, timestamp, dimensions, and artifact provenance.");
    }
  }
  return issues;
}

/** Issue codes that mean the evidence itself cannot be trusted, as opposed to a screen the run could not reach. */
const INTEGRITY_CODES = new Set(["CAPTURE_SIDE_MISMATCH", "CAPTURE_COMMIT_INVALID", "CAPTURE_SELECTION_DUPLICATE", "CAPTURE_TARGET_UNEXPECTED",
  "CAPTURE_TARGET_MISSING", "CAPTURE_OUTCOME_MISSING", "CAPTURE_IMAGE_BINDING_INVALID", "CAPTURE_IMAGE_PROVENANCE_INVALID"]);

/**
 * Whether a failure casts doubt on everything a capture took, so its other appearances cannot be kept as a partial
 * report: a checkout that changed under it, or evidence that failed its integrity checks.
 */
export function capturedEvidenceInDoubt(code: string): boolean {
  return /^(?:SOURCE|CHECKOUT)_/.test(code) || code === "CAPTURE_INCOMPLETE" || INTEGRITY_CODES.has(code);
}

export function sortedCaptureHealthIssues(inputs: readonly CaptureHealthInput[]): CaptureHealthIssue[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return inputs.flatMap(({ bundle, selectedIds, side }) => captureHealthIssues(bundle, selectedIds, side))
    .sort((a, b) => compare(a.side, b.side) || compare(a.surfaceId, b.surfaceId) || compare(a.code, b.code));
}

/**
 * Split health issues into those that invalidate the evidence (the run must fail) and those that only leave screens
 * unavailable (the report still publishes and names them).
 */
export function partitionCaptureHealthIssues(issues: readonly CaptureHealthIssue[]): { integrity: CaptureHealthIssue[]; unavailable: CaptureHealthIssue[] } {
  return { integrity: issues.filter(issue => INTEGRITY_CODES.has(issue.code)), unavailable: issues.filter(issue => !INTEGRITY_CODES.has(issue.code)) };
}

/** One GitHub warning annotation per unavailable screen, so the run's summary names them without failing. */
function renderWarningAnnotation(title: string, body: string): string {
  const escape = (value: string) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const property = (value: string) => escape(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
  return `::warning title=${property(title)}::${escape(body)}`;
}

export function renderCaptureIssueAnnotation(issue: CaptureHealthIssue): string {
  return renderWarningAnnotation(`Explore ${issue.side} capture unavailable (${issue.surfaceId})`,
    `${issue.code}: ${issue.message}\nNext action: ${issue.nextAction}`);
}

export function renderComparisonDiagnosticAnnotation(diagnostic: { surfaceId: string; code: string; message: string; nextAction: string }): string {
  return renderWarningAnnotation(`Explore comparison failed (${diagnostic.surfaceId})`,
    `${diagnostic.code}: ${diagnostic.message}\nNext action: ${diagnostic.nextAction}`);
}

export function renderNotesUnavailableAnnotation(error: { code: string; message: string; nextAction: string }): string {
  return renderWarningAnnotation("Explore change notes unavailable",
    `${error.code}: ${error.message}\nThe report publishes with its deterministic verdicts and without notes.\nNext action: ${error.nextAction}`);
}

export function renderReviewGapAnnotation(gap: { surfaceId?: string; section?: string; dropped: string; message: string }): string {
  const where = gap.surfaceId ?? gap.section ?? "report";
  const effect = gap.dropped === "verdict" ? "its verdict is omitted and the screen reads as needing review"
    : gap.dropped === "surface" ? "the screen is omitted from this report" : "this section is omitted from this report";
  return renderWarningAnnotation(`Explore review contract (${where})`,
    `REVIEW_CONTRACT_GAP: ${gap.message}; ${effect}.\nNext action: report this at https://github.com/expo/explore/issues with the diagnostics artifact; the rest of the report is unaffected.`);
}

/** Run after exporting diagnostic artifacts. An incomplete side must never result in successful CI. */
export function assertCompleteCaptures(inputs: readonly CaptureHealthInput[]): void {
  assertNoCaptureHealthIssues(sortedCaptureHealthIssues(inputs));
}

export function assertNoCaptureHealthIssues(issues: readonly CaptureHealthIssue[]): void {
  if (!issues.length) return;
  // Name the codes and the first surfaces in the message itself: the CI log is often all a reader has, the
  // per-issue diagnostics live in an artifact.
  const summary = (["base", "head"] as const).flatMap(side => {
    const sideIssues = issues.filter(issue => issue.side === side);
    const affected = new Set(sideIssues.map(issue => issue.surfaceId));
    if (!affected.size) return [];
    const byCode = new Map<string, string[]>();
    for (const issue of sideIssues) byCode.set(issue.code, [...(byCode.get(issue.code) ?? []), issue.surfaceId]);
    const codes = [...byCode].map(([code, surfaces]) => {
      const unique = [...new Set(surfaces)];
      const shown = unique.slice(0, 3).join(", ") + (unique.length > 3 ? `, +${unique.length - 3} more` : "");
      return `${code} ×${unique.length}: ${shown}`;
    }).join("; ");
    return [`${side}: ${affected.size} incomplete target${affected.size === 1 ? "" : "s"} — ${codes}`];
  }).join("; ");
  throw new CiError({ code: "CAPTURE_INCOMPLETE", stage: "capture-validation",
    message: `Capture verification failed (${summary}). Every planned target requires a screenshot of its verified destination.`,
    nextAction: "Inspect the per-target capture diagnostics for both revisions, fix the reported capture prerequisites, and rerun Explore. Incomplete screenshots cannot be reported as PR review findings.",
    details: { issues },
  });
}

export function assertCompleteCapture(bundle: CaptureBundle, expectedIds: readonly string[], side: CaptureSide = bundle.side): void {
  assertCompleteCaptures([{ bundle, selectedIds: expectedIds, side }]);
}
