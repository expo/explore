import { projectReviewPresentation } from "./review.js";
import { LAUNCH_SURFACE_ID, launchSurfaceId, type PublicLaunchSide, type PublicReview, type PublicVisualVerdict } from "./capture.js";
import { SOURCE_IMPACT_KINDS, validateSourceChangeSummary } from "./source-change.js";
import { validateNavigationGraph } from "./navigation-graph.js";
import { validateSourceRoute } from "./source-route.js";
type Surface = PublicReview["surfaces"][number];
const REVIEW_STATUSES = new Set(["added", "modified", "removed", "unchanged", "needs-review", "variant"]);
const SOURCE_SCOPES = new Set(["screen", "app-wide", "none"]);
/** Verdicts each source scope allows: only a source change makes a screen a review target. */
const SCOPE_VERDICTS: Record<string, readonly string[]> = {
  screen: ["modified", "needs-review", "unchanged"],
  "app-wide": ["modified", "needs-review", "unchanged"],
  none: ["unchanged", "variant"],
};
const VISUAL_VERDICTS = new Set(["unchanged", "modified", "needs-review"]);
const MAX_REVIEW_DESCRIPTION = 160;
const LEGACY_NO_VISIBLE_DIFFERENCE = "Source changed; no visible difference was captured.";

/** Source analysis belongs to capture planning; delivered reports contain runtime review evidence. */
/** Capture shrinks the app icon to at most this many pixels on a side. */
const APP_ICON_MAX_EDGE = 128;

export function projectPublicReviewForReport(review: PublicReview): PublicReview {
  assertPublicReview(review);
  // Git hunks stay in capture planning; the reason categories travel with the report.
  return { ...review, surfaces: review.surfaces.map(({ sourceChange: _sourceChange, ...surface }) => surface) };
}

function hasVerifiedPair(surface: Surface): boolean {
  return (["base", "head"] as const).every(side => surface[side]?.kind === "screen"
    && surface[`${side}Image`] && surface[`${side}Outcome`]?.status === "captured"
    && surface[`${side}Outcome`]?.landing === "verified");
}

/**
 * A modified screen whose verified screenshots match: only what assistive technology reads (its accessibility tree)
 * changed. Screen readers and voice control see it, so it is a change to review, listed apart from the visual ones.
 */
export function isAccessibilityOnlyChange(surface: Surface): boolean {
  return surface.review?.status === "modified" && surface.visual?.verdict === "unchanged" && hasVerifiedPair(surface);
}

function assertReviewFields(surface: Surface, enforceComparisonEvidence: boolean): void {
  const assertVerifiedPair = () => {
    if (enforceComparisonEvidence && !hasVerifiedPair(surface)) {
      throw new Error("Public review verdict requires captures of both verified destination routes");
    }
  };
  const review = surface.review;
  if (review !== undefined) {
    if (!review || typeof review !== "object" || !REVIEW_STATUSES.has(review.status)
      || typeof review.description !== "string" || !review.description.trim()
      || review.description.length > MAX_REVIEW_DESCRIPTION
      || /[\u0000-\u001f\u007f]/.test(review.description)
      || (review.status === "added" && (surface.base !== null || surface.head === null))
      || (review.status === "removed" && (surface.head !== null || surface.base === null))
      || (["modified", "unchanged", "variant"].includes(review.status) && (!surface.base || !surface.head))
      || (surface.sourceScope !== undefined && !["added", "removed"].includes(review.status)
        && !SCOPE_VERDICTS[surface.sourceScope]?.includes(review.status))
      || (review.offScreen !== undefined && (review.offScreen !== true || review.status !== "modified" || surface.visual?.verdict !== "unchanged"))
      || (review.facts !== undefined && (!Array.isArray(review.facts) || review.facts.length > 100
        || review.facts.some((fact) => !fact || typeof fact.category !== "string" || typeof fact.templateId !== "string"
          || typeof fact.bullet !== "string" || !fact.bullet.trim() || fact.bullet.length > MAX_REVIEW_DESCRIPTION)))) {
      throw new Error("Public review verdict is inconsistent");
    }
    if (["modified", "unchanged", "needs-review", "variant"].includes(review.status)) assertVerifiedPair();
  }
  if (surface.sourceScope !== undefined && (!SOURCE_SCOPES.has(surface.sourceScope)
    || (surface.sourceScope === "none") !== (surface.status === "unchanged")
    || surface.status === "added" || surface.status === "removed")) {
    throw new Error("Public review source scope is inconsistent");
  }
  if (surface.visual !== undefined) {
    assertVisualVerdict(surface.visual, enforceComparisonEvidence, Boolean(surface.base && surface.head));
    assertVerifiedPair();
  }
}

/**
 * The farthest a region may move between the screenshots, in screenshot pixels: within the largest screenshot a
 * device takes (an element recentred on a wide display moves hundreds of pixels), not an unbounded number.
 */
const MAX_SHIFT = 8192;

/** A region's move between the screenshots: finite, and within a screenshot. */
function validShift(shift: unknown): boolean {
  if (!shift || typeof shift !== "object") return false;
  const { x, y } = shift as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= MAX_SHIFT && Math.abs(y) <= MAX_SHIFT;
}

function assertVisualVerdict(visual: PublicVisualVerdict, enforceComparisonEvidence: boolean, paired: boolean): void {
  if (!visual || typeof visual !== "object" || !VISUAL_VERDICTS.has(visual.verdict)
    || typeof visual.reason !== "string" || (enforceComparisonEvidence && visual.reason === "diff-failed") || typeof visual.tool !== "string"
    || typeof visual.threshold !== "number" || !Number.isFinite(visual.threshold)
    || (visual.mismatchPercentage !== undefined
      && (typeof visual.mismatchPercentage !== "number" || !Number.isFinite(visual.mismatchPercentage) || visual.mismatchPercentage < 0))
    || (visual.regions !== undefined && (!Array.isArray(visual.regions) || visual.regions.length > 64
      || visual.regions.some(region => region?.shift !== undefined && !validShift(region.shift))))
    || (visual.allRegionsMoved !== undefined && (visual.allRegionsMoved !== true || !visual.regions?.length
      || visual.regions.some(region => region.shift === undefined)))
    || !paired) {
    throw new Error("Public visual verdict is inconsistent");
  }
}

const LAUNCH_SIDE_KEYS = new Set(["status", "source", "splash", "settled", "relaunchedAt", "splashVisibleMs", "splashChangedMs", "firstScreenMs", "filmstrip", "video"]);
function validLaunchFrame(frame: unknown): boolean {
  const value = frame as PublicLaunchSide["settled"];
  return Boolean(value) && typeof value === "object" && Object.keys(value).sort().join() === "capturedAt,height,sha256,url,width"
    && typeof value.url === "string" && /^https:\/\//.test(value.url) && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0
    && Number.isFinite(Date.parse(value.capturedAt));
}
const validFrameTimes = (times: unknown) => Array.isArray(times) && times.length > 0 && times.length <= 8
  && times.every(time => Number.isSafeInteger(time) && Math.abs(time as number) <= 600_000);
function validFilmstrip(filmstrip: unknown): boolean {
  if (!filmstrip || typeof filmstrip !== "object") return false;
  const { frameTimesMs, ...frame } = filmstrip as NonNullable<PublicLaunchSide["filmstrip"]>;
  return validLaunchFrame(frame) && validFrameTimes(frameTimesMs);
}
function validLaunchSide(side: unknown): boolean {
  const value = side as PublicLaunchSide;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !LAUNCH_SIDE_KEYS.has(key))) return false;
  const video = value.video;
  return ["observed", "not-observed"].includes(value.status) && ["recording", "screenshot"].includes(value.source)
    && (value.status === "observed") === (value.splash !== undefined) && (value.splash === undefined || validLaunchFrame(value.splash))
    && validLaunchFrame(value.settled) && Number.isFinite(Date.parse(value.relaunchedAt))
    && (value.splashVisibleMs === undefined || (Number.isSafeInteger(value.splashVisibleMs) && value.splashVisibleMs >= 0))
    && (value.firstScreenMs === undefined || (Number.isSafeInteger(value.firstScreenMs) && value.firstScreenMs >= 0))
    && (value.splashChangedMs === undefined || (Number.isSafeInteger(value.splashChangedMs) && value.splashChangedMs >= 0))
    && (value.filmstrip === undefined || validFilmstrip(value.filmstrip))
    && (video === undefined || (Boolean(video) && typeof video === "object" && typeof video.url === "string" && /^https:\/\//.test(video.url)
      && /^[a-f0-9]{64}$/.test(video.sha256) && Number.isSafeInteger(video.bytes) && video.bytes > 0 && video.mimeType === "video/mp4"
      && (video.durationMs === undefined || (Number.isSafeInteger(video.durationMs) && video.durationMs >= 0))));
}
/** Launch evidence is one entry per captured appearance, with a verdict only when both sides observed a splash. */
function assertLaunchEvidence(review: PublicReview, enforceComparisonEvidence: boolean): void {
  const launch = review.launch;
  if (launch === undefined) return;
  const schemes = review.runtime.colorSchemes;
  if (!Array.isArray(launch) || launch.length === 0 || launch.length > 2) throw new Error("Public launch evidence is invalid");
  const ids = new Set<string>();
  for (const entry of launch) {
    const expected = entry?.colorScheme === undefined ? LAUNCH_SURFACE_ID : launchSurfaceId(entry.colorScheme, entry.colorScheme === schemes?.[0]);
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["id", "colorScheme", "base", "head", "visual"].includes(key))
      || entry.id !== expected || ids.has(entry.id) || (entry.colorScheme !== undefined) !== (schemes !== undefined)
      || (entry.colorScheme !== undefined && !schemes!.includes(entry.colorScheme))
      || (!entry.base && !entry.head) || (entry.base !== undefined && !validLaunchSide(entry.base)) || (entry.head !== undefined && !validLaunchSide(entry.head))) {
      throw new Error("Public launch evidence is invalid");
    }
    ids.add(entry.id);
    if (entry.visual !== undefined) assertVisualVerdict(entry.visual, enforceComparisonEvidence, Boolean(entry.base?.splash && entry.head?.splash));
  }
}

function assertChangeNote(surface: Surface, review: PublicReview): void {
  const note = surface.note;
  if (note === undefined) return;
  const invalid = () => { throw new Error("Public review change note is inconsistent with its evidence"); };
  if (!note || typeof note !== "object" || Array.isArray(note)
    || Object.keys(note).some(key => !["text", "evidenceDigest", "evidence"].includes(key))
    || typeof note.text !== "string" || !note.text.trim() || note.text !== note.text.trim()
    || note.text.length > MAX_REVIEW_DESCRIPTION || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(note.text)
    || typeof note.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(note.evidenceDigest)
    || !Array.isArray(note.evidence) || note.evidence.length < 1 || note.evidence.length > 2
    || !(surface.baseOutcome || surface.headOutcome || surface.baseImage || surface.headImage)) invalid();
  const sides = (["base", "head"] as const).filter(side => surface[side]);
  if (note.evidence.length !== sides.length) invalid();
  for (const [index, side] of sides.entries()) {
    const reference = note.evidence[index];
    if (!reference || Object.keys(reference).some(key => !["side", "sourceCommit", "imageSha256"].includes(key))
      || reference.side !== side || reference.sourceCommit !== review.pullRequest[side].sha
      || reference.imageSha256 !== surface[`${side}Image`]?.sha256) invalid();
  }
  if (surface.review?.status === "unchanged" && note.text !== "No visible change.") invalid();
}


/** The header icon: a small PNG referenced like a screenshot, by HTTPS URL and content hash. */
function assertAppIcon(icon: unknown): void {
  const value = icon as NonNullable<PublicReview["runtime"]["appIcon"]>;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== "height,sha256,url,width"
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.width) || value.width <= 0 || value.width > APP_ICON_MAX_EDGE
    || !Number.isSafeInteger(value.height) || value.height <= 0 || value.height > APP_ICON_MAX_EDGE
    || typeof value.url !== "string") {
    throw new Error("Public review app icon is invalid");
  }
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error("Invalid public app icon URL"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Public app icon URL must use HTTPS without credentials");
  }
}

/** Navigation is route-level: a secondary-appearance surface (`<id>@<scheme>`) rides on its route's entry. */
const SCHEME_SUFFIX = /@(light|dark)$/;

/**
 * Source navigation names routes. A route is present on a side when any of its appearance surfaces is:
 * a dark-only base rendered `home` as dark, so a head whose light `home` has no base frame still has the route.
 */
function sideRouteIds(review: PublicReview, side: "base" | "head"): string[] {
  const ids = new Set<string>();
  for (const surface of review.surfaces) if (surface[side]) ids.add(surface.id.replace(SCHEME_SUFFIX, ""));
  return [...ids];
}

export function assertPublicReview(review: PublicReview): void {
  validatePublicReview(review, true);
}

/**
 * Read existing artifacts that encoded operational capture failures as comparison verdicts.
 * Validate every original field first; only unsupported review/visual evidence is discarded, then any part the
 * contract still rejects is quarantined (see quarantineReviewContract) and reported through `onGap`.
 * New report publication must continue to use assertPublicReview, never this reader.
 */
export function normalizePublicReviewForReading(review: PublicReview, onGap?: (gap: ReviewContractGap) => void): PublicReview {
  const accepted = quarantineReviewContract(review, false);
  for (const gap of accepted.gaps) onGap?.(gap);
  review = accepted.review;
  let changed = false;
  const surfaces = review.surfaces.map((surface): Surface => {
    // Reports before source scopes judged source-unchanged screens by evidence alone. A difference
    // there is a runtime-state variant, not a change; other legacy verdicts have no scope to re-judge.
    if (surface.sourceScope === undefined && surface.status === "unchanged" && hasVerifiedPair(surface)
      && (surface.review?.status === "modified" || surface.review?.status === "needs-review")) {
      changed = true;
      const description = `Runtime state differs: ${surface.review.description}`;
      surface = { ...surface, review: { ...surface.review, status: "variant",
        description: description.length > MAX_REVIEW_DESCRIPTION ? `${description.slice(0, MAX_REVIEW_DESCRIPTION - 1)}…` : description } };
    }
    // Reports before 0.19.1 called a screen whose source changed but whose captures matched "needs review". It has no
    // visible change, so it reads as unchanged and is not counted as a change.
    if (surface.review?.status === "needs-review" && surface.review.description === LEGACY_NO_VISIBLE_DIFFERENCE) {
      changed = true;
      surface = { ...surface, review: { ...surface.review, status: "unchanged", description: "No visible change" } };
    }
    const comparisonVerdict = surface.review && surface.review.status !== "added" && surface.review.status !== "removed";
    if (!((!hasVerifiedPair(surface) && (comparisonVerdict || surface.visual)) || surface.visual?.reason === "diff-failed")) return surface;
    changed = true;
    const { review: _review, visual: _visual, ...evidence } = surface;
    if (surface.status !== "added" && surface.status !== "removed") return evidence;
    const route = (surface.head ?? surface.base)?.route;
    const description = `${surface.status === "added" ? "Added" : "Removed"}${route ? ` ${route}` : ""} screen.`;
    return { ...evidence, review: { status: surface.status, description } };
  });
  const normalized = changed ? { ...review, surfaces } : review;
  // A reader quarantines what a (older or buggy) producer let through, so a report still opens with the gap named.
  const quarantined = quarantineReviewContract(normalized);
  for (const gap of quarantined.gaps) onGap?.(gap);
  return quarantined.review;
}

/** A contract violation that names the surface or section it comes from, so a producer can quarantine that part. */
export class ReviewContractError extends Error {
  readonly surfaceId?: string;
  readonly section?: "navigation";
  constructor(message: string, where: { surfaceId?: string; section?: "navigation" } = {}) {
    super(message);
    this.name = "ReviewContractError";
    if (where.surfaceId !== undefined) this.surfaceId = where.surfaceId;
    if (where.section !== undefined) this.section = where.section;
  }
}

function locate(error: unknown, where: { surfaceId?: string; section?: "navigation" }): never {
  if (error instanceof ReviewContractError) throw error;
  throw new ReviewContractError(error instanceof Error ? error.message : String(error), where);
}

export type ReviewContractGap = {
  surfaceId?: string; section?: "navigation";
  /** `verdict`: the surface stays as evidence without its review; `surface`: the surface is omitted; `section`: the section is omitted. */
  dropped: "verdict" | "surface" | "section";
  message: string;
};

/**
 * Publish what the contract accepts instead of failing the run on a part it rejects: a surface whose verdict
 * breaks the contract keeps its captures and loses the verdict; a surface whose evidence breaks it is omitted;
 * an invalid navigation graph or flow inventory is omitted. Anything that is not attributable to one surface or
 * section (identity, provenance across surfaces) still throws: there is no trustworthy report left to publish.
 */
export function quarantineReviewContract(review: PublicReview, enforceComparisonEvidence = true): { review: PublicReview; gaps: ReviewContractGap[] } {
  const gaps: ReviewContractGap[] = [];
  const strippedVerdicts = new Set<string>();
  let current = review;
  for (let attempt = 0; attempt <= review.surfaces.length * 2 + 2; attempt += 1) {
    try { validatePublicReview(current, enforceComparisonEvidence); return { review: current, gaps }; }
    catch (error) {
      if (!(error instanceof ReviewContractError)) throw error;
      if (error.section) {
        const { [error.section]: _dropped, ...rest } = current;
        current = rest as PublicReview;
        gaps.push({ section: error.section, dropped: "section", message: error.message });
        continue;
      }
      if (error.surfaceId === undefined) throw error;
      const id = error.surfaceId;
      if (strippedVerdicts.has(id)) {
        current = { ...current, surfaces: current.surfaces.filter(surface => surface?.id !== id) };
        gaps.push({ surfaceId: id, dropped: "surface", message: error.message });
        continue;
      }
      strippedVerdicts.add(id);
      current = { ...current, surfaces: current.surfaces.map((surface): Surface => {
        if (surface?.id !== id) return surface;
        const { review: _review, visual: _visual, note: _note, sourceScope: _scope, sourceImpact: _impact, ...evidence } = surface;
        if (surface.status !== "added" && surface.status !== "removed") return evidence;
        const route = (surface.head ?? surface.base)?.route;
        const description = `${surface.status === "added" ? "Added" : "Removed"}${route ? ` ${route}` : ""} screen.`;
        return { ...evidence, review: { status: surface.status, description } };
      }) };
      gaps.push({ surfaceId: id, dropped: "verdict", message: error.message });
    }
  }
  throw new ReviewContractError("Public review contract could not be satisfied");
}

function validatePublicReview(review: PublicReview, enforceComparisonEvidence: boolean): void {
  if (review?.pullRequest?.origin === "local") {
    const origin = projectReviewPresentation(review.pullRequest);
    if (origin.origin !== "local" || origin.runId !== review.runId || review.runAttempt !== "1") throw new Error("Local report identity mismatch");
  }
  if (!review || review.contract !== "explore.review"
    || !["all", "changes"].includes(review.mode)
    || !Array.isArray(review.surfaces) || review.surfaces.length > 5000
    || !Number.isFinite(Date.parse(review.createdAt))
    || !review.pullRequest || !review.runtime
    || typeof review.runtime.buildId !== "string" || typeof review.runtime.projectId !== "string"
    || !/^[a-f0-9]{40}$/.test(review.pullRequest.base?.sha ?? "")
    || !/^[a-f0-9]{40}$/.test(review.pullRequest.head?.sha ?? "")
    || review.pullRequest.origin !== "local" && review.pullRequest.base.sha === review.pullRequest.head.sha
    || review.runtime.gitCommit !== review.pullRequest.head.sha) {
    throw new Error("Invalid public review workspace");
  }
  if (review.runtime.appIcon !== undefined) assertAppIcon(review.runtime.appIcon);
  assertLaunchEvidence(review, enforceComparisonEvidence);
  const ids = new Set<string>();
  const sideBuildIds = { base: new Set<string>(), head: new Set<string>() };
  for (const surface of review.surfaces) {
    try {
    if (!surface || !surface.id || ids.has(surface.id)
      || !["added", "modified", "removed", "unchanged"].includes(surface.status)
      || (!surface.base && !surface.head)
      || (surface.status === "added") !== !surface.base
      || (surface.status === "removed") !== !surface.head) {
      throw new Error("Public review source presence or status is inconsistent");
    }
    ids.add(surface.id);
    if (surface.excluded !== undefined && (surface.excluded !== true
      || surface.baseImage || surface.headImage || surface.baseOutcome || surface.headOutcome || surface.visual)) {
      throw new Error("Public review excluded surface carries capture evidence");
    }
    assertReviewFields(surface, enforceComparisonEvidence);
    assertChangeNote(surface, review);
    if (surface.sourceChange) {
      validateSourceChangeSummary(surface.sourceChange, review.pullRequest.base.sha, review.pullRequest.head.sha);
    }
    if (surface.sourceImpact !== undefined) {
      const kinds = surface.sourceImpact;
      if (!Array.isArray(kinds) || kinds.length > SOURCE_IMPACT_KINDS.length
        || new Set(kinds).size !== kinds.length
        || kinds.some((kind) => !SOURCE_IMPACT_KINDS.includes(kind))) {
        throw new Error("Public review source impact is invalid");
      }
    }
    for (const side of ["base", "head"] as const) {
      const entry = surface[side];
      const image = side === "base" ? surface.baseImage : surface.headImage;
      const outcome = surface[`${side}Outcome`];
      if (entry) {
        validateSourceRoute(entry);
        if (entry.id !== surface.id) throw new Error("Invalid public review source surface");
      }
      if (outcome !== undefined && (!entry || entry.kind === "redirect"
        || !["captured", "missing-params", "unsupported-link", "failed", "budget-exhausted"].includes(outcome.status)
        || !Number.isSafeInteger(outcome.attempts) || outcome.attempts < 0
        || !["verified", "unverified"].includes(outcome.landing)
        || (outcome.status === "captured") !== Boolean(image)
        || (outcome.landing === "verified" && outcome.status !== "captured")
        || (outcome.screenshotSha256 !== undefined && outcome.screenshotSha256 !== image?.sha256))) {
        throw new Error("Public review capture outcome is inconsistent");
      }
      if (!image) continue;
      if (!entry || entry.kind === "redirect"
        || image.sourceCommit !== review.pullRequest[side].sha
        || !image.buildId || !/^[a-f0-9]{64}$/.test(image.sha256)
        || !Number.isFinite(Date.parse(image.capturedAt))
        || !Number.isSafeInteger(image.width) || image.width <= 0
        || !Number.isSafeInteger(image.height) || image.height <= 0) {
        throw new Error("Public review capture provenance is inconsistent");
      }
      let url: URL;
      try { url = new URL(image.url); } catch { throw new Error("Invalid public image URL"); }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Public image URL must use HTTPS without credentials");
      }
      sideBuildIds[side].add(image.buildId);
    }
    } catch (error) { locate(error, surface && typeof surface.id === "string" ? { surfaceId: surface.id } : {}); }
  }
  if (sideBuildIds.head.size > 1
    || (sideBuildIds.head.size === 1 && (!review.runtime.projectId || !sideBuildIds.head.has(review.runtime.buildId)))) {
    throw new Error("Public review images disagree with their build provenance");
  }
  if (review.navigation !== undefined) try {
    if (!review.navigation || typeof review.navigation !== "object"
      || !review.navigation.base || !review.navigation.head) throw new Error("Invalid public review navigation");
    for (const side of ["base", "head"] as const) {
      validateNavigationGraph(review.navigation[side], sideRouteIds(review, side));
    }
  } catch (error) { locate(error, { section: "navigation" }); }
}
