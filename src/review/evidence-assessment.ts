import { unattributedIssue } from "../capture/health.js";
import { appearancePairs, bundleColorSchemes } from "../capture/appearance.js";
import { homeIndicatorBandPercent, launchSurfaceId, statusBarBandPercent } from "../contracts/capture.js";
import { readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CaptureBundle, PublicSurfaceReview, PublicVisualVerdict } from "../contracts/capture.js";
import { serializeCiError, toCiError } from "../shared/ci-errors.js";
import {
  compareSurfaceEvidence,
  type ComparatorSurfaceImpact,
  type MatchedSurfaceSide,
} from "./evidence-comparator.js";
import { summarizeReviewerChanges, type WhatChangedSummary } from "./reviewer-changes.js";
import { runtimeEvidenceInputFromMap, type RuntimeExecutionContext } from "./runtime-adapter.js";
import { projectRuntimeEvidence } from "./runtime-evidence.js";
import { surfaceSourceScope, type SourceCapturePlan, type SurfaceSourceScope } from "../source/capture-plan.js";
import { ExploreStore, validateMap } from "../map/store.js";
import type { SourceRoute } from "../contracts/source-route.js";
import type { ExploreMap } from "../types.js";
import {
  assessVisualMeasurements,
  diffScreenshots,
  type ScreenshotDiffMeasurement,
  type VisualDiffRegion,
  type VisualEvidenceAssessment,
} from "./visual-evidence.js";
import { AGENT_DEVICE_VERSION } from "../shared/agent-device-version.js";
import { STATUS_BAR_BAND_PERCENT, decodePng, differentPixelsInRect, maxColorDistance, type DecodedFrame } from "../shared/png-evidence.js";
import { measureRegionShifts } from "./region-shift.js";

export const DEFAULT_VISUAL_THRESHOLD = 0.1;
export const DEFAULT_EVIDENCE_TIME_BUDGET_MS = 10 * 60_000;
const MAX_DESCRIPTION_LENGTH = 160;
const MAX_REGIONS = 8;
const VISUAL_TOOL = `agent-device@${AGENT_DEVICE_VERSION}`;

/** One captured side of the public review: its export directory, bundle, and optional runtime map. */
export type PublicEvidenceSide = {
  directory: string;
  bundle: CaptureBundle;
  /** The exported `screen-map.json`; absent when only cached screenshots were restored. */
  map?: ExploreMap;
  /** The EAS Simulator execution context recorded for that capture. */
  execution?: RuntimeExecutionContext;
  /** Why `execution` is absent although the export shipped an `execution.json`. */
  executionIssue?: string;
};

export type PublicSurfaceAssessment = {
  visual?: PublicVisualVerdict;
  review?: PublicSurfaceReview;
};

export type PublicCaptureHealth = {
  planned: number; captured: number; verified: number; unverified: number; unavailable: number;
};

export type PublicEvidenceDiagnostic = {
  surfaceId: string;
  side?: "base" | "head";
  code: string; stage: string; message: string; nextAction: string; retryable: boolean;
};

export type PublicEvidenceSummary = {
  /** Null when the diff tool was unavailable, so the comment falls back to source status. */
  visual: {
    compared: number; modified: number; unchanged: number; needsReview: number; failed: number;
    threshold: number; tool: string;
    /** First few failure messages, for the run log. Never shown to reviewers. */
    errors: string[];
  } | null;
  accessibility: { compared: number; described: number; failed: number; skipped: number; errors: string[] } | null;
  /** Final verdicts of compared surfaces; variants are runtime-state differences, not review targets. */
  review?: { modified: number; needsReview: number; variants: number; unchanged: number };
  capture: { base: PublicCaptureHealth; head: PublicCaptureHealth };
  comparison: { planned: number; eligible: number; skipped: number };
  /** Every unavailable or unverified requested side, plus operational comparison errors. */
  diagnostics: PublicEvidenceDiagnostic[];
};

const MAX_SUMMARY_ERRORS = 5;

function recordError(errors: string[], surfaceId: string, error: unknown): void {
  if (errors.length >= MAX_SUMMARY_ERRORS) return;
  const message = error instanceof Error ? error.message : String(error);
  errors.push(truncate(`${surfaceId}: ${message}`));
}

export type PublicEvidenceResult = {
  surfaces: Record<string, PublicSurfaceAssessment>;
  summary: PublicEvidenceSummary;
};

type PlanSurface = SourceCapturePlan["surfaces"][number];

/** Read an exported map from a side directory and check it structurally and semantically. */
export async function readExportedMap(
  directory: string,
  options: { checkArtifacts?: boolean } = {},
): Promise<ExploreMap> {
  const store = new ExploreStore(directory);
  const map = await store.read();
  const errors = await validateMap(map, store, { checkArtifacts: options.checkArtifacts ?? true });
  if (errors.length > 0) throw new Error(`Exported map is invalid: ${errors.join("; ")}`);
  return map;
}

function truncate(text: string): string {
  const compact = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return compact.length > MAX_DESCRIPTION_LENGTH ? `${compact.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : compact;
}

function percentage(value: number | undefined): string {
  return value === undefined ? "?" : `${(Math.round(value * 100) / 100).toString()}%`;
}

function visualVerdict(assessment: VisualEvidenceAssessment, threshold: number): PublicVisualVerdict {
  const representative = assessment.representative;
  const regions = representative
    ? [...representative.regions]
        .sort((left, right) => right.shareOfDiffPercentage - left.shareOfDiffPercentage)
        .slice(0, MAX_REGIONS)
        .map((region) => ({
          rect: region.rect,
          normalizedRect: region.normalizedRect,
          differentPixels: region.differentPixels,
          shareOfDiffPercentage: region.shareOfDiffPercentage,
          dominantChange: region.dominantChange,
          location: region.location,
        }))
    : undefined;
  return {
    verdict: assessment.status,
    reason: assessment.reason,
    ...(assessment.crossBuildMismatchPercentage === undefined
      ? {}
      : { mismatchPercentage: assessment.crossBuildMismatchPercentage }),
    threshold,
    ...(regions && regions.length > 0 ? { regions } : {}),
    tool: VISUAL_TOOL,
  };
}

/**
 * The published regions with how far their content moved, where a move explains it: a layout that shifted by a
 * device pixel reads as moved, not as changed. Every region the comparison found is measured, not only the ones
 * published, so `allRegionsMoved` can say nothing else on the screen changed. A measurement that fails leaves the
 * regions as they were.
 */
async function withRegionShifts(basePath: string, headPath: string, all: readonly VisualDiffRegion[], published: NonNullable<PublicVisualVerdict["regions"]>):
  Promise<Pick<PublicVisualVerdict, "regions" | "allRegionsMoved">> {
  try {
    const shifts = await measureRegionShifts(basePath, headPath, all.map(region => region.rect));
    const shiftOf = new Map(all.map((region, index) => [region.rect, shifts[index]] as const));
    return {
      regions: published.map(region => {
        const shift = shiftOf.get(region.rect);
        return shift ? { ...region, shift } : region;
      }),
      ...(all.length > 0 && shifts.every(Boolean) ? { allRegionsMoved: true as const } : {}),
    };
  } catch {
    return { regions: published };
  }
}

/** Remove status-bar-only diff regions from a measurement and recompute its verdict inputs. */
export function ignoreStatusBar(measurement: ScreenshotDiffMeasurement, bandPercent: number = STATUS_BAR_BAND_PERCENT): { measurement: ScreenshotDiffMeasurement; ignored: number } {
  const bands = ignoreSystemBands(measurement, { top: bandPercent, bottom: 0 });
  return { measurement: bands.measurement, ignored: bands.ignoredTop };
}

/** Both frames a measurement compared, decoded on demand: only a region that crosses a band's edge needs them. */
export type SystemBandFrames = { baseline: DecodedFrame; current: DecodedFrame; distance: number };
export type SystemBandFrameLoader = () => SystemBandFrames | undefined;

/** Reads the measurement's two screenshots when a band's edge has to be resolved pixel by pixel. */
export function systemBandFrameLoader(measurement: ScreenshotDiffMeasurement, threshold: number): SystemBandFrameLoader {
  return () => {
    try {
      const baseline = decodePng(readFileSync(measurement.baselinePath)); const current = decodePng(readFileSync(measurement.currentPath));
      if (!baseline || !current || baseline.width !== current.width || baseline.height !== current.height) return undefined;
      return { baseline, current, distance: maxColorDistance(threshold) };
    } catch { return undefined; }
  };
}

/**
 * Leaves out of a measurement every diff region that lies inside the system's bands: the status bar at the top and,
 * on iOS, the home indicator at the bottom. Both are drawn by the OS and differ between captures without the app
 * having changed. A region that crosses a band's edge is clipped to the part below (above) it when the frames can be
 * read: its pixels inside the band are counted and dropped, and it stays only for what differs in the app's area.
 * Without frames such a region is kept whole, as before. (A region's pixel count is its own cluster's, so the pixels
 * counted inside the band are clamped to it.)
 */
export function ignoreSystemBands(measurement: ScreenshotDiffMeasurement, bands: { top: number; bottom: number }, frames?: SystemBandFrameLoader):
{ measurement: ScreenshotDiffMeasurement; ignoredTop: number; ignoredBottom: number } {
  if (measurement.match || measurement.regions.length === 0) return { measurement, ignoredTop: 0, ignoredBottom: 0 };
  const inTop = (region: VisualDiffRegion) => bands.top > 0 && region.normalizedRect.y + region.normalizedRect.height <= bands.top;
  const inBottom = (region: VisualDiffRegion) => bands.bottom > 0 && region.normalizedRect.y >= 100 - bands.bottom;
  const crossesTop = (region: VisualDiffRegion) => bands.top > 0 && !inTop(region) && region.normalizedRect.y < bands.top;
  const crossesBottom = (region: VisualDiffRegion) => bands.bottom > 0 && !inBottom(region) && region.normalizedRect.y + region.normalizedRect.height > 100 - bands.bottom;
  let loaded: SystemBandFrames | undefined | null = null;
  const load = () => { if (loaded === null) loaded = frames?.() ?? undefined; return loaded; };
  let ignoredTop = 0; let ignoredBottom = 0; let ignoredPixels = 0;
  const remaining: VisualDiffRegion[] = [];
  for (const region of measurement.regions) {
    if (inTop(region)) { ignoredTop += 1; ignoredPixels += region.differentPixels; continue; }
    if (inBottom(region)) { ignoredBottom += 1; ignoredPixels += region.differentPixels; continue; }
    const top = crossesTop(region); const bottom = crossesBottom(region);
    const decoded = top || bottom ? load() : undefined;
    if (!decoded) { remaining.push(region); continue; }
    const { height, width } = decoded.baseline;
    const bandRows = Math.floor((height * bands.top) / 100); const indicatorStart = height - Math.floor((height * bands.bottom) / 100);
    const rect = { ...region.rect };
    let inside = 0;
    if (top) {
      const rows = Math.min(rect.y + rect.height, bandRows) - rect.y;
      inside += differentPixelsInRect(decoded.baseline, decoded.current, { ...rect, height: rows }, decoded.distance);
      rect.y = bandRows; rect.height -= rows;
    }
    if (bottom) {
      const start = Math.max(rect.y, indicatorStart);
      inside += differentPixelsInRect(decoded.baseline, decoded.current, { ...rect, y: start, height: rect.y + rect.height - start }, decoded.distance);
      rect.height = start - rect.y;
    }
    inside = Math.min(inside, region.differentPixels);
    const differentPixels = region.differentPixels - inside;
    if (differentPixels === 0 || rect.height <= 0) {
      if (top) ignoredTop += 1; else ignoredBottom += 1;
      ignoredPixels += region.differentPixels;
      continue;
    }
    ignoredPixels += inside;
    const round = (value: number) => Math.round(value * 100) / 100;
    remaining.push({ ...region, rect, differentPixels,
      normalizedRect: { x: round((rect.x / width) * 100), y: round((rect.y / height) * 100), width: round((rect.width / width) * 100), height: round((rect.height / height) * 100) } });
  }
  if (ignoredPixels === 0) return { measurement, ignoredTop: 0, ignoredBottom: 0 };
  const differentPixels = Math.max(0, measurement.differentPixels - ignoredPixels);
  const regions = remaining.map((region) => ({ ...region,
    shareOfDiffPercentage: differentPixels > 0 ? Math.round((region.differentPixels / differentPixels) * 10000) / 100 : 0 }));
  return {
    ignoredTop,
    ignoredBottom,
    measurement: {
      ...measurement,
      differentPixels,
      mismatchPercentage: measurement.totalPixels > 0 ? Math.round((differentPixels / measurement.totalPixels) * 10000) / 100 : 0,
      match: differentPixels === 0 || regions.length === 0,
      regions,
    },
  };
}

function visualDescription(visual: PublicVisualVerdict): string {
  const location = visual.regions?.[0]?.location;
  return truncate(`Visual change · ${percentage(visual.mismatchPercentage)}${location ? ` · ${location}` : ""}`);
}

function visualReasonText(visual: PublicVisualVerdict): string {
  switch (visual.reason) {
    case "diff-failed": return "Visual comparison failed";
    case "insufficient-samples": return "Not enough capture samples";
    case "within-side-instability": return "Capture samples are unstable";
    case "inconsistent-cross-build-delta": return "Screenshot difference is inconsistent";
    default: return "Needs review";
  }
}

/**
 * The backend that served a capture's accessibility snapshot, read from its saved controller
 * response: agent-device reports `snapshotQuality.backend` for XCTest-family snapshots, and host
 * AX bridge nodes carry `pid` and `subrole`. Undefined when the response is unavailable.
 */
export function snapshotBackend(directory: string, map: ExploreMap, observationId: string): string | undefined {
  const observation = map.observations.find((entry) => entry.id === observationId);
  const artifact = map.artifacts.find((entry) => entry.id === observation?.accessibilityArtifactId && entry.kind === "accessibility");
  if (!artifact || isAbsolute(artifact.path)) return undefined;
  const path = resolve(directory, artifact.path);
  if (!path.startsWith(resolve(directory))) return undefined;
  try {
    if (statSync(path).size > 32 * 1024 * 1024) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as { data?: { snapshotQuality?: { backend?: unknown }; nodes?: unknown } };
    const nodes = Array.isArray(value.data?.nodes) ? value.data.nodes as Record<string, unknown>[] : undefined;
    if (!nodes) return undefined;
    if (nodes.some((node) => node !== null && typeof node === "object" && ("pid" in node || "subrole" in node))) return "ax-bridge";
    const backend = value.data?.snapshotQuality?.backend;
    return typeof backend === "string" && /^[a-z-]{1,32}$/.test(backend) ? backend : undefined;
  } catch {
    return undefined;
  }
}

/** The review contract caps a description at 160 characters; a long route (an encoded share link) is clipped, never the verdict. */
export const MAX_PRESENCE_DESCRIPTION = 160;
export function presenceDescription(prefix: string, route: string, suffix: string): string {
  const room = MAX_PRESENCE_DESCRIPTION - prefix.length - suffix.length;
  const shown = route.length <= room ? route : `${route.slice(0, Math.max(room - 1, 1))}\u2026`;
  return `${prefix}${shown}${suffix}`;
}

function matchedSide(
  side: "base" | "head",
  evidence: PublicEvidenceSide,
  surface: SourceRoute,
  profile: string,
): MatchedSurfaceSide {
  const map = evidence.map;
  const execution = evidence.execution;
  if (!map || !execution) throw new Error(`${side} runtime map or execution context is unavailable`);
  const screen = map.screens.find((entry) => entry.id === surface.id);
  if (!screen) throw new Error(`${side} runtime map is missing ${surface.id}`);
  const observationId = screen.observationIds[0];
  if (!observationId || screen.observationIds.length !== 1) {
    throw new Error(`${side} surface ${surface.id} must have exactly one capture sample`);
  }
  const runtimeEvidence = projectRuntimeEvidence(runtimeEvidenceInputFromMap({
    side,
    map,
    screenId: surface.id,
    representativeObservationId: observationId,
    sampleObservationIds: [observationId],
    expectedSampleCount: 1,
    profile,
    execution,
  }));
  const backend = snapshotBackend(evidence.directory, map, observationId);
  return { map, observationId, runtimeEvidence, ...(backend ? { snapshotBackend: backend } : {}) };
}

function impactFor(surface: PlanSurface, presence: ComparatorSurfaceImpact["presence"]): ComparatorSurfaceImpact {
  const route = (surface.headSurface ?? surface.baseSurface)?.route;
  if (!route) throw new Error(`Surface ${surface.id} has no route`);
  return {
    id: surface.id,
    route,
    presence,
    reasons: [...surface.reasons],
    baseSamples: presence === "head-only" ? 0 : 1,
    headSamples: presence === "base-only" ? 0 : 1,
  };
}

function localImagePath(side: PublicEvidenceSide, id: string): string | undefined {
  const frame = side.bundle.images[id];
  return frame ? localEvidencePath(side, frame.path) : undefined;
}
function localEvidencePath(side: PublicEvidenceSide, relativePath: string): string | undefined {
  if (isAbsolute(relativePath)) return undefined;
  const path = resolve(side.directory, relativePath);
  return path.startsWith(resolve(side.directory)) ? path : undefined;
}

/**
 * The verdict combines the source scope with the evidence. Only a source change makes a surface a
 * review target: a changed screen is Modified when its evidence differs, Needs review when the
 * comparison could not tell, and Unchanged when both captures show the same thing. Explore reports
 * visual changes, so a source change nobody can see is not one. A source-unchanged screen is never a
 * review target: a difference there is the same screen captured in another runtime state (a screen
 * variant), not a change. The PR comment names an app-wide change once.
 */
export function decideReview(scope: SurfaceSourceScope, visual: PublicVisualVerdict, summary?: WhatChangedSummary): PublicSurfaceReview {
  const facts = summary?.facts.map((fact) => ({ category: fact.category, templateId: fact.templateId, bullet: truncate(fact.bullet) })) ?? [];
  const differs = visual.verdict === "modified" || facts.length > 0;
  const inconclusive = !differs && (visual.verdict === "needs-review" || Boolean(summary?.needsReview));
  const issue = summary?.reviewIssues[0]?.reason;
  const evidenceText = facts[0]?.bullet ?? visualDescription(visual);
  if (scope === "none") {
    if (!differs) return { status: "unchanged", description: "No visible change" };
    // The comparator's generic visual fact reads as a styling change; a variant names what differs.
    const state = facts.find((fact) => fact.category !== "visual")?.bullet
      ?? `${percentage(visual.mismatchPercentage)}${visual.regions?.[0]?.location ? ` · ${visual.regions[0].location}` : ""}`;
    return { status: "variant", description: truncate(`Runtime state differs: ${state}`), ...(facts.length ? { facts } : {}) };
  }
  if (differs) {
    const description = !facts.length && issue ? `${visualDescription(visual)} · ${issue}` : evidenceText;
    return { status: "modified", description: truncate(description), ...(facts.length ? { facts } : {}) };
  }
  if (inconclusive) {
    return { status: "needs-review", description: truncate(visual.verdict === "needs-review" ? visualReasonText(visual) : issue ?? "Needs review") };
  }
  return { status: "unchanged", description: "No visible change" };
}

function captureDiagnostic(surface: PlanSurface, side: "base" | "head", evidence: PublicEvidenceSide, surfaceId: string = surface.id): PublicEvidenceDiagnostic | undefined {
  // A secondary appearance (`<id>@<scheme>`) has an outcome of its own only when that pass did not verify it.
  const outcome = evidence.bundle.outcomes[surfaceId] ?? evidence.bundle.outcomes[surface.id];
  const captured = outcome?.status === "captured" && Boolean(localImagePath(evidence, surfaceId));
  if (captured && outcome?.landing === "verified") return undefined;
  const status = outcome?.status;
  const fallback = captured
    ? (outcome?.observed ? { code: unattributedIssue(outcome).code, message: unattributedIssue(outcome).message, nextAction: unattributedIssue(outcome).nextAction }
      : { code: "CAPTURE_LANDING_UNVERIFIED", message: "Screenshot captured, but the destination route was not verified.",
        nextAction: "Check route navigation and the app's route marker, then rerun capture." })
    : status === "missing-params"
      ? { code: "CAPTURE_PARAMETERS_MISSING", message: "The route requires parameter values before it can be captured.",
        nextAction: "Add the missing route parameters to config.yaml, then rerun capture." }
      : status === "unsupported-link"
        ? { code: "CAPTURE_LINK_UNSUPPORTED", message: "The route has no supported navigation link.",
          nextAction: "Configure the app's linking path and scheme for this route, then rerun capture." }
        : status === "budget-exhausted"
          ? { code: "CAPTURE_BUDGET_EXHAUSTED", message: "The capture budget was exhausted before this route completed.",
            nextAction: "Increase capture.maxMinutes or capture.maxActions in config.yaml, then rerun capture." }
          : status === "failed"
            ? { code: "CAPTURE_FAILED", message: "The requested capture failed before producing a screenshot.",
              nextAction: "Inspect this side's capture diagnostics, fix the reported failure, then rerun capture." }
            : { code: "CAPTURE_EVIDENCE_MISSING", message: "The requested capture did not produce a screenshot and capture outcome.",
              nextAction: "Inspect this side's capture diagnostics, fix the reported failure, then rerun capture." };
  const diagnostic = serializeCiError(toCiError(undefined, {
    ...fallback, stage: "capture", retryable: status === "failed" || status === "budget-exhausted", ...outcome?.error,
    message: outcome?.error?.message ?? outcome?.reason ?? fallback.message,
  }));
  return { surfaceId, side, ...diagnostic };
}

/**
 * Compare every captured surface of a public review deterministically: pixels through the pinned
 * agent-device diff and accessibility snapshots through the same comparator the private lane
 * uses. No model is involved; every description is a templated fact backed by runtime evidence.
 */
export async function assessPublicEvidence(options: {
  /** The captured platform; its status bar band is left out of the visual verdict. Absent: iOS. */
  platform?: "ios" | "android";
  plan: SourceCapturePlan;
  base: PublicEvidenceSide;
  head: PublicEvidenceSide;
  agentDeviceCommand: string;
  profile: string;
  threshold?: number;
  timeBudgetMs?: number;
  now?: () => number;
  measure?: (baselinePath: string, currentPath: string) => Promise<ScreenshotDiffMeasurement>;
}): Promise<PublicEvidenceResult> {
  const threshold = options.threshold ?? DEFAULT_VISUAL_THRESHOLD;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeBudgetMs ?? DEFAULT_EVIDENCE_TIME_BUDGET_MS);
  const surfaces: Record<string, PublicSurfaceAssessment> = {};
  let visualAvailable = true;
  if (!options.measure) {
    try {
      // `stat` follows the npm `.bin` symlink; `lstat` would report the link itself and skip every comparison.
      visualAvailable = isAbsolute(options.agentDeviceCommand) && (await stat(options.agentDeviceCommand)).isFile();
    } catch {
      visualAvailable = false;
    }
  }
  const measure = options.measure ?? (async (baselinePath: string, currentPath: string) => (
    await diffScreenshots({ baselinePath, currentPath, command: options.agentDeviceCommand, threshold })
  ));
  const visualCounts = { compared: 0, modified: 0, unchanged: 0, needsReview: 0, failed: 0, errors: [] as string[] };
  const accessibilityCounts = { compared: 0, described: 0, failed: 0, skipped: 0, errors: [] as string[] };
  const reviewCounts = { modified: 0, needsReview: 0, variants: 0, unchanged: 0 };
  const accessibilityAvailable = Boolean(options.base.map && options.base.execution && options.head.map && options.head.execution);
  const health = (): PublicCaptureHealth => ({ planned: 0, captured: 0, verified: 0, unverified: 0, unavailable: 0 });
  const capture = { base: health(), head: health() };
  const comparison = { planned: 0, eligible: 0, skipped: 0 };
  const diagnostics: PublicEvidenceDiagnostic[] = [];
  const comparisonError = (surfaceId: string, error: unknown, fallback: Parameters<typeof toCiError>[1]) => {
    const diagnostic = serializeCiError(toCiError(error, fallback));
    diagnostics.push({ surfaceId, ...diagnostic });
    return diagnostic;
  };

  const colorSchemes = bundleColorSchemes(options.head.bundle);
  const baseColorSchemes = bundleColorSchemes(options.base.bundle);
  for (const surface of options.plan.surfaces) {
    for (const side of ["base", "head"] as const) {
      if (!surface[`${side}Capture`] || surface[`${side}Surface`]?.kind !== "screen") continue;
      const evidence = options[side];
      const counts = capture[side];
      counts.planned += 1;
      const outcome = evidence.bundle.outcomes[surface.id];
      if (outcome?.status === "captured" && localImagePath(evidence, surface.id)) {
        counts.captured += 1;
        if (outcome.landing === "verified") counts.verified += 1;
        else counts.unverified += 1;
      } else counts.unavailable += 1;
      const diagnostic = captureDiagnostic(surface, side, evidence);
      if (diagnostic) diagnostics.push(diagnostic);
    }
    if (!surface.baseSurface && surface.headSurface) {
      if (surface.headSurface.kind === "redirect") continue;
      surfaces[surface.id] = { review: { status: "added", description: presenceDescription("Added ", surface.headSurface.route, " screen.") } };
      continue;
    }
    if (surface.baseSurface && !surface.headSurface) {
      if (surface.baseSurface.kind === "redirect") continue;
      surfaces[surface.id] = { review: { status: "removed", description: presenceDescription("Removed ", surface.baseSurface.route, " screen.") } };
      continue;
    }
    if (surface.baseSurface?.kind !== "screen" || surface.headSurface?.kind !== "screen"
      || (!surface.baseCapture && !surface.headCapture)) continue;
    // Every appearance the capture rendered is compared like-for-like: `<id>@<scheme>` frames against each other.
    for (const { id, scheme, baseId } of appearancePairs(surface.id, colorSchemes, baseColorSchemes)) {
      // An appearance the base never rendered has nothing to compare against: the head frame is new evidence.
      if (baseId === null) {
        if (localImagePath(options.head, id)) {
          surfaces[id] = { review: { status: "added", description: presenceDescription(`Added the ${scheme} appearance of `, surface.headSurface.route, ".") } };
        }
        continue;
      }
      comparison.planned += 1;
      const basePath = localImagePath(options.base, baseId);
      const headPath = localImagePath(options.head, id);
      // Pixels and accessibility are meaningful only after both intended destinations are proven.
      if (!basePath || !headPath || captureDiagnostic(surface, "base", options.base, baseId)
        || captureDiagnostic(surface, "head", options.head, id)) {
        comparison.skipped += 1;
        continue;
      }
      comparison.eligible += 1;
      if (!visualAvailable) {
        comparisonError(id, undefined, { code: "VISUAL_COMPARISON_UNAVAILABLE", stage: "compare",
          message: "The screenshot comparison tool is unavailable.",
          nextAction: "Install the pinned agent-device version and pass its absolute executable path, then rerun comparison." });
        continue;
      }

      let visual: PublicVisualVerdict;
      let assessment: VisualEvidenceAssessment | undefined;
      if (now() > deadline) {
        visualCounts.failed += 1;
        const diagnostic = comparisonError(id, undefined, { code: "VISUAL_COMPARISON_BUDGET_EXHAUSTED", stage: "compare",
          message: "The time budget expired before screenshot comparison.",
          nextAction: "Increase the evidence comparison time budget or reduce the number of selected routes, then rerun comparison.", retryable: true });
        recordError(visualCounts.errors, id, diagnostic.message);
        continue;
      } else {
        try {
          const raw = await measure(basePath, headPath);
          const { measurement, ignoredTop, ignoredBottom } = ignoreSystemBands(raw, { top: statusBarBandPercent(options.platform), bottom: homeIndicatorBandPercent(options.platform) }, systemBandFrameLoader(raw, threshold));
          assessment = assessVisualMeasurements({
            baselineSamples: 1,
            currentSamples: 1,
            requiredSamples: 1,
            baselineWithin: [],
            currentWithin: [],
            crossBuild: [measurement],
            representative: measurement,
          });
          visual = visualVerdict(assessment, threshold);
          // Measuring moves is extra: once the comparison budget is spent, regions go out unmeasured.
          if (visual.verdict === "modified" && visual.regions?.length && now() <= deadline) {
            Object.assign(visual, await withRegionShifts(basePath, headPath, measurement.regions, visual.regions));
          }
          if (ignoredTop > 0) visual.ignoredStatusBarRegions = ignoredTop;
          if (ignoredBottom > 0) visual.ignoredHomeIndicatorRegions = ignoredBottom;
          visualCounts.compared += 1;
          if (visual.verdict === "modified") visualCounts.modified += 1;
          else if (visual.verdict === "unchanged") visualCounts.unchanged += 1;
          else visualCounts.needsReview += 1;
        } catch (error) {
          visualCounts.failed += 1;
          const diagnostic = comparisonError(id, error, { code: "VISUAL_COMPARISON_FAILED", stage: "compare",
            message: "Screenshot comparison failed.", nextAction: "Check the screenshot files and the agent-device comparison diagnostics, then rerun comparison.", retryable: true });
          recordError(visualCounts.errors, id, diagnostic.message);
          continue;
        }
      }

      const scope = surfaceSourceScope(surface) ?? "none";
      let review: PublicSurfaceReview | undefined;
      if (assessment && accessibilityAvailable) {
        try {
          const result = compareSurfaceEvidence({
            impact: { ...impactFor(surface, "both"), id, presence: "both" },
            base: matchedSide("base", options.base, { ...surface.baseSurface, id: baseId }, options.profile),
            head: matchedSide("head", options.head, { ...surface.headSurface, id }, options.profile),
            visualAssessment: assessment,
          });
          const summary = summarizeReviewerChanges({ changes: result.reviewerChanges });
          accessibilityCounts.compared += 1;
          review = decideReview(scope, visual, summary);
          if (review.facts?.length) accessibilityCounts.described += 1;
        } catch (error) {
          accessibilityCounts.failed += 1;
          const diagnostic = comparisonError(id, error, { code: "ACCESSIBILITY_COMPARISON_FAILED", stage: "compare",
            message: "Accessibility comparison failed.", nextAction: "Check both sides' runtime maps and capture diagnostics, then rerun capture and comparison.", retryable: true });
          recordError(accessibilityCounts.errors, id, diagnostic.message);
        }
      } else if (assessment) {
        accessibilityCounts.skipped += 1;
      }
      review ??= decideReview(scope, visual);
      reviewCounts[review.status === "needs-review" ? "needsReview" : review.status === "variant" ? "variants"
        : review.status === "modified" ? "modified" : "unchanged"] += 1;
      surfaces[id] = { visual, review };
    }
  }

  // The app launch per appearance: splash frames compare like screens when both sides observed one.
  for (const [index, scheme] of colorSchemes.entries()) {
    const baseLaunch = options.base.bundle.launch?.[scheme]; const headLaunch = options.head.bundle.launch?.[scheme];
    if (!baseLaunch?.splash || !headLaunch?.splash || !visualAvailable || now() > deadline) continue;
    const id = launchSurfaceId(scheme, index === 0);
    const basePath = localEvidencePath(options.base, baseLaunch.splash.path); const headPath = localEvidencePath(options.head, headLaunch.splash.path);
    if (!basePath || !headPath) continue;
    try {
      const raw = await measure(basePath, headPath);
      const { measurement, ignoredTop, ignoredBottom } = ignoreSystemBands(raw, { top: statusBarBandPercent(options.platform), bottom: homeIndicatorBandPercent(options.platform) }, systemBandFrameLoader(raw, threshold));
      const visual = visualVerdict(assessVisualMeasurements({ baselineSamples: 1, currentSamples: 1, requiredSamples: 1,
        baselineWithin: [], currentWithin: [], crossBuild: [measurement], representative: measurement }), threshold);
      if (ignoredTop > 0) visual.ignoredStatusBarRegions = ignoredTop;
      if (ignoredBottom > 0) visual.ignoredHomeIndicatorRegions = ignoredBottom;
      surfaces[id] = { visual };
    } catch (error) {
      comparisonError(id, error, { code: "VISUAL_COMPARISON_FAILED", stage: "compare",
        message: "Launch screenshot comparison failed.", nextAction: "Check the launch frames and the agent-device comparison diagnostics, then rerun comparison.", retryable: true });
    }
  }

  return {
    surfaces,
    summary: {
      visual: visualAvailable ? { ...visualCounts, threshold, tool: VISUAL_TOOL } : null,
      accessibility: accessibilityAvailable ? accessibilityCounts : null,
      review: reviewCounts,
      capture, comparison, diagnostics,
    },
  };
}
