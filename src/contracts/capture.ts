import type { RunTarget } from "../types.js";
import { validateSourceRoutes, type SourceRoute } from "./source-route.js";
import type { SourceCapturePlan, SurfaceSourceScope } from "../source/capture-plan.js";
import type { ReviewPresentation } from "./review.js";
import type { SourceChangeSummary } from "../source/change-summary.js";
import { validateSourceChangeSummary, type SourceImpactKind } from "./source-change.js";
import { navigationCaptureContext, validateNavigationGraph, type NavigationGraph } from "./navigation-graph.js";
import type { ExploreMap } from "../types.js";

export const AGENT_ACCEPTANCE_POLICY = "agent-inspected-frame.v1";
export type AgentAcceptedFrame = {
  frameId: string;
  imageSha256: string;
  capturedAt: string;
};

export type CapturedImage = {
  url: string; sha256: string; width: number; height: number; capturedAt: string;
  sourceCommit: string; buildId: string;
};
/** The app's own icon, shrunk for the Viewer header. Stored and verified like a screenshot. */
export type AppIconImage = { url: string; sha256: string; width: number; height: number };
export type CaptureOutcome = {
  status: "captured" | "missing-params" | "unsupported-link" | "failed" | "budget-exhausted";
  attempts: number;
  landing: "verified" | "unverified";
  reason?: string;
  /**
   * Set on a `captured`/`unverified` outcome whose frame is the screen the app showed instead of the planned route
   * (unattributed evidence): why the destination was not attributed, the route the observer reported if it did, and
   * how many link attempts were made. Absent from bundles captured before unattributed frames were published.
   */
  observed?: { reason: "landing-mismatch" | "observer-not-ready"; route?: string; attempts: number };
  screenshotSha256?: string;
  error?: { code: string; stage: string; message: string; nextAction: string; retryable: boolean };
};
/** A launch recording kept with the bundle when `capture.launch: video` is set. */
export type LaunchVideo = { path: string; sha256: string; bytes: number; mimeType: "video/mp4"; durationMs?: number };
export type LaunchFrame = Omit<CapturedImage, "url" | "sourceCommit" | "buildId"> & { path: string };
/**
 * The app's launch in one appearance: the splash frame while it was still visible, the first settled frame after it,
 * and how the frames were observed. `splash` is absent when the launch was faster than the capture could observe.
 */
export type BundleLaunchCapture = {
  status: "observed" | "not-observed";
  /** `recording`: frames decoded from a launch recording; `screenshot`: a burst of screenshots after the relaunch. */
  source: "recording" | "screenshot";
  splash?: LaunchFrame;
  settled: LaunchFrame;
  relaunchedAt: string;
  /**
   * How long the splash stayed on screen as it appeared, in milliseconds: from a recording, until the first visible
   * change to it or its crossfade; from screenshots, at least this long.
   */
  splashVisibleMs?: number;
  /** From the system launch transition to the first visible change of the splash (a native launch screen handing over to an app-drawn one, an animation starting), in milliseconds; absent when it left unchanged. Recording only. */
  splashChangedMs?: number;
  /** From the system launch transition to the first settled frame, in milliseconds; recording only. */
  firstScreenMs?: number;
  /** One row of the distinct launch frames (before the launch, transition, splash, its first change, crossfade, first screen), labelled with their time. */
  filmstrip?: LaunchFilmstrip;
  video?: LaunchVideo;
};

export type LaunchFilmstrip = LaunchFrame & {
  /** When each tile was on screen, in milliseconds from the launch transition (negative before it). */
  frameTimesMs: number[];
};
export type CaptureBundle = {
  contract: "explore.bundle";
  side: "base" | "head"; gitCommit: string; easBuildId: string | null; easProjectId: string | null;
  /** Absent in bundles captured before Android support: iOS. */
  platform?: "ios" | "android";
  /** Execution completion time, recorded even when no routes require screenshots. */
  completedAt?: string;
  appName?: string;
  /** The device controller that drove the capture; absent for agent-device, the default. */
  controller?: "argent";
  /** The icon the app config declares, shrunk to at most 128 pixels; absent when unavailable. */
  appIcon?: Omit<AppIconImage, "url"> & { path: string };
  profile: string; selectedSurfaceIds: string[];
  runtimeProfile?: { deviceModel: string; osVersion: string; locale: string; orientation: string; colorScheme: string; colorSchemes?: string } | null;
  images: Record<string, Omit<CapturedImage, "url"> & { path: string }>;
  outcomes: Record<string, CaptureOutcome>;
  /** Launch evidence per appearance (`light`/`dark`), when the capture observed the app launch. */
  launch?: Record<string, BundleLaunchCapture>;
  /** How route frames were produced; absent in bundles from before `capture.reset` existed (root-link was not applied). */
  procedure?: { reset: "root-link" | "none"; readinessSeconds?: number };
  /** Committed destination goals used for this capture, including cached evidence. */
  captureContexts?: Record<string, {
    description: string; parameters: Record<string, string | string[]>; requiredLabels: string[];
    presentation?: { sceneOrigin: { x: number; y: number } };
  }>;
  /** The exact observed frames explicitly accepted by the agent, never replacement screenshots. */
  agentAcceptance?: { policy: typeof AGENT_ACCEPTANCE_POLICY; frames: Record<string, AgentAcceptedFrame> };
};

/** Bind acceptance receipts to captured images and, when supplied, their exported observations. */
export function assertAgentAcceptance(bundle: CaptureBundle,
  map?: Pick<ExploreMap, "observations" | "artifacts">, options: { required?: boolean } = {}): void {
  const acceptance = bundle.agentAcceptance;
  if (acceptance === undefined) {
    if (options.required) throw new Error("Agent acceptance receipts are required for inspected frames");
    return;
  }
  if (!acceptance || typeof acceptance !== "object" || Array.isArray(acceptance)
    || Object.keys(acceptance).some(key => !["policy", "frames"].includes(key))
    || acceptance.policy !== AGENT_ACCEPTANCE_POLICY
    || !acceptance.frames || typeof acceptance.frames !== "object" || Array.isArray(acceptance.frames)
    || Object.keys(acceptance.frames).length !== Object.keys(bundle.images).length
    || Object.keys(acceptance.frames).some(id => !Object.hasOwn(bundle.images, id))) {
    throw new Error("Agent acceptance receipts do not match the captured inventory or policy");
  }
  const frameIds = new Set<string>();
  for (const [id, image] of Object.entries(bundle.images)) {
    const frame = acceptance.frames[id];
    const routeId = id.replace(/@(light|dark)$/, "");
    // A verified secondary-appearance frame has no outcome of its own: its route's verified outcome vouches for it
    // (an unverified secondary pass records a scheme outcome and never an image).
    const outcome = bundle.outcomes[id] ?? (routeId !== id ? bundle.outcomes[routeId] : undefined);
    if (!frame || typeof frame !== "object" || Array.isArray(frame)
      || Object.keys(frame).some(key => !["frameId", "imageSha256", "capturedAt"].includes(key))
      || typeof frame.frameId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(frame.frameId)
      || frameIds.has(frame.frameId) || !bundle.selectedSurfaceIds.includes(routeId)
      || typeof frame.imageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(frame.imageSha256)
      || frame.imageSha256 !== image.sha256
      || typeof frame.capturedAt !== "string" || !Number.isFinite(Date.parse(frame.capturedAt))
      || frame.capturedAt !== image.capturedAt || image.sourceCommit !== bundle.gitCommit
      || outcome?.status !== "captured" || outcome.landing !== "verified"
      || (routeId === id && outcome.screenshotSha256 !== frame.imageSha256)) {
      throw new Error(`Agent acceptance receipt does not match captured image ${id}`);
    }
    frameIds.add(frame.frameId);
    if (map && !map.observations.some(observation => {
      if (observation.screenId !== id || observation.capturedAt !== frame.capturedAt
        || !observation.accessibilityArtifactId) return false;
      const artifact = map.artifacts.find(candidate => candidate.id === observation.screenshotArtifactId);
      return artifact?.kind === "screenshot" && artifact.path === image.path && artifact.sha256 === frame.imageSha256;
    })) throw new Error(`Agent acceptance receipt has no matching captured observation for ${id}`);
  }
}
/**
 * The iOS status bar (clock, signal, battery) occupies the top ~54 points of an 874-point portrait
 * capture, and the Android emulator's clock and indicators sit inside the same fraction of a
 * Pixel frame. Its glyphs differ between sessions even after `--normalize-status-bar`, and within one
 * session whenever the clock or an indicator redraws, so evidence never treats a difference that
 * lies entirely inside this band as an app change; a difference that crosses its edge counts only for
 * its pixels below it. The Viewer marks the same band. Android: the glyphs of `sdk_gphone64` on Android 15
 * (720x1600) reach 6.4 % of the frame, measured on euxy #164, so its band is 7.
 */
export const STATUS_BAR_BAND_PERCENT = 6.5;
/** The top band of a portrait screenshot that holds the system status bar, per platform. */
export const STATUS_BAR_BAND_PERCENT_BY_PLATFORM: Record<"ios" | "android", number> = { ios: STATUS_BAR_BAND_PERCENT, android: 7 };
export function statusBarBandPercent(platform: "ios" | "android" | undefined): number {
  return STATUS_BAR_BAND_PERCENT_BY_PLATFORM[platform ?? "ios"];
}
/**
 * The iOS home indicator is drawn by the system over the bottom ~13 points of an 874-point portrait
 * capture (the bar itself is 5 points high, 8 above the edge) and inverts with whatever the app paints
 * under it, so it differs between captures just as the status bar does. Android's gesture pill is
 * left to the app for now: the emulator frames show no system-drawn band there.
 */
export const HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM: Record<"ios" | "android", number> = { ios: 3, android: 0 };
/** The bottom band of a portrait screenshot that holds the system home indicator, per platform; 0 when there is none. */
export function homeIndicatorBandPercent(platform: "ios" | "android" | undefined): number {
  return HOME_INDICATOR_BAND_PERCENT_BY_PLATFORM[platform ?? "ios"];
}

/**
 * An area of a screenshot the system draws, in percent of the screenshot's width and height. A difference that
 * lies entirely inside one is never an app change; the verdict leaves it out and the Viewer blurs it.
 */
export type SystemRegion = { kind: "status-bar" | "home-indicator"; x: number; y: number; width: number; height: number };

/**
 * iPhone Duo (iOS 27) has no status bar across the top: its clock and Wi-Fi indicator stack in one pill in the
 * right-hand rail, 28 points from the edge, lower on the outer (closed) panel than on the inner one. Measured on
 * EAS Simulator captures of both panels; the pill is the same 40×64 points on each, only its top differs. The app's own
 * rail controls start about 3% of the height below it on the outer panel, so the padding stays small.
 */
const DUO_PANELS = {
  outer: { width: 466, height: 678, statusBar: { x: 398, y: 87, width: 40, height: 64 } },
  inner: { width: 951, height: 669, statusBar: { x: 883, y: 34, width: 40, height: 64 } },
} as const;
const DUO_STATUS_BAR_PADDING_POINTS = 4;
const isFoldable = (platform: "ios" | "android" | undefined, device: string | undefined) => platform !== "android" && /\bduo\b/i.test(device ?? "");

/**
 * The areas the verdict leaves out for a capture: the platform's status-bar band and, on iOS, its home-indicator
 * band; on an iPhone foldable, the lit panel's status-bar pill instead of a top band. `pose` is the capture's device pose
 * (closed lights the outer panel; open and half-open the inner one); a foldable with none boots closed.
 */
export function systemRegions(options: { platform?: "ios" | "android" | undefined; device?: string | undefined; pose?: string | undefined }): SystemRegion[] {
  const regions: SystemRegion[] = [];
  if (isFoldable(options.platform, options.device)) {
    const panel = options.pose === "open" || options.pose === "half-open" ? DUO_PANELS.inner : DUO_PANELS.outer;
    const pad = DUO_STATUS_BAR_PADDING_POINTS;
    const percent = (value: number, of: number) => Math.round((value / of) * 10000) / 100;
    regions.push({ kind: "status-bar",
      x: percent(panel.statusBar.x - pad, panel.width), y: percent(panel.statusBar.y - pad, panel.height),
      width: percent(panel.statusBar.width + 2 * pad, panel.width), height: percent(panel.statusBar.height + 2 * pad, panel.height) });
  } else {
    regions.push({ kind: "status-bar", x: 0, y: 0, width: 100, height: statusBarBandPercent(options.platform) });
  }
  const home = homeIndicatorBandPercent(options.platform);
  if (home > 0) regions.push({ kind: "home-indicator", x: 0, y: 100 - home, width: 100, height: home });
  return regions;
}

/** Deterministic pixel comparison of one surface's base and head screenshots. */
export type PublicVisualVerdict = {
  verdict: "unchanged" | "modified" | "needs-review";
  reason: "matched" | "repeated-cross-build-delta" | "insufficient-samples" | "within-side-instability"
    | "inconsistent-cross-build-delta" | "provenance-gap" | "diff-failed";
  mismatchPercentage?: number;
  threshold: number;
  regions?: Array<{
    rect: { x: number; y: number; width: number; height: number };
    normalizedRect: { x: number; y: number; width: number; height: number };
    differentPixels: number; shareOfDiffPercentage: number; dominantChange: string; location: string;
    /**
     * Set when the region's content is the same in both screenshots, only moved: how far, in screenshot pixels
     * (right and down are positive). Absent when the content itself changed.
     */
    shift?: { x: number; y: number };
  }>;
  tool: string;
  /**
   * Every region the comparison found (not only the published ones) only moved: nothing on the screen changed
   * content. Absent when any region changed, or moves were not measured.
   */
  allRegionsMoved?: true;
  /** Diff regions inside the status-bar band that were excluded from the verdict, or clipped to their part below it. */
  ignoredStatusBarRegions?: number;
  /** Diff regions that lay inside the home-indicator band and were left out of the verdict, or clipped to their part above it. */
  ignoredHomeIndicatorRegions?: number;
  /** The system-drawn areas the verdict left out, present when a difference inside one was ignored. */
  systemRegions?: SystemRegion[];
};
/**
 * Evidence-based reviewer status. `status` on the surface stays source-derived because capture
 * selection is contracted against it; this field is what a reviewer and the viewer filter read.
 */
export type PublicSurfaceReview = {
  /**
   * `modified`/`needs-review` only follow a source change. `variant` is a source-unchanged screen
   * whose captures differ in runtime UI state; it is not a review target.
   */
  status: "added" | "modified" | "removed" | "unchanged" | "needs-review" | "variant";
  /** One deterministic sentence, at most 160 characters. */
  description: string;
  /** Every deterministic accessibility fact for this surface, in reviewer priority order. */
  facts?: Array<{ category: string; templateId: string; bullet: string }>;
};
/** An evidence-bound explanation. It never changes a deterministic comparison verdict. */
export type PublicChangeNote = {
  text: string;
  evidenceDigest: string;
  evidence: Array<{ side: "base" | "head"; sourceCommit: string; imageSha256?: string }>;
};
/** The review id of one appearance's launch evidence: `launch:splash`, or `launch:splash@<scheme>` for a secondary appearance. */
export const LAUNCH_SURFACE_ID = "launch:splash";
export function launchSurfaceId(scheme: "light" | "dark", primary: boolean): string {
  return primary ? LAUNCH_SURFACE_ID : `${LAUNCH_SURFACE_ID}@${scheme}`;
}
/** One appearance's launch evidence in a published review; the splash frames are compared like screens. */
export type PublicLaunchFrame = Omit<CapturedImage, "sourceCommit" | "buildId">;
export type PublicLaunchSide = {
  status: "observed" | "not-observed"; source: "recording" | "screenshot";
  splash?: PublicLaunchFrame; settled: PublicLaunchFrame; relaunchedAt: string; splashVisibleMs?: number; splashChangedMs?: number; firstScreenMs?: number;
  filmstrip?: PublicLaunchFrame & { frameTimesMs: number[] };
  video?: { url: string; sha256: string; bytes: number; mimeType: "video/mp4"; durationMs?: number };
};
export type PublicLaunchEvidence = {
  /** `launch:splash` for the primary appearance, `launch:splash@<scheme>` for a secondary one. */
  id: string; colorScheme?: "light" | "dark";
  base?: PublicLaunchSide; head?: PublicLaunchSide;
  visual?: PublicVisualVerdict;
};
export type PublicReview = {
  contract: "explore.review";
  pullRequest: ReviewPresentation; mode: "all" | "changes"; createdAt: string;
  runId: string; runAttempt: string;
  runtime: {
    projectId: string; buildId: string; gitCommit: string; appName?: string; appVersion?: string; appBuildNumber?: string;
    appIcon?: AppIconImage;
    /** Absent in reports published before Android support: iOS. */
    platform?: "ios" | "android";
    /** The device controller that drove the head capture; absent for agent-device, the default. */
    controller?: "argent";
    device?: { model: string; osVersion: string };
    /** The share of each screenshot's height the verdict ignored as the status bar. */
    statusBarBandPercent?: number;
    /** The share of each screenshot's height, from the bottom, the verdict ignored as the home indicator. */
    homeIndicatorBandPercent?: number;
    /** Every system-drawn area the verdict leaves out of each screenshot; the bands above, or a foldable's rail pill. */
    systemRegions?: SystemRegion[];
    /** Every platform the config captures, so the Viewer can offer the sibling platform's report of the same run. */
    platforms?: Array<"ios" | "android">;
    /** The target this report captured; absent in reports from before targets, whose target is their platform. */
    target?: RunTarget;
    /** Every target the config captures, in config order, when more than one: the sibling reports of the same run. */
    targets?: RunTarget[];
    /** Every appearance the capture rendered, primary first, when it rendered several; surfaces then carry their `colorScheme`. */
    colorSchemes?: Array<"light" | "dark">;
  };
  /** Static navigation evidence, separate from actions observed on a simulator. */
  navigation?: { base: NavigationGraph; head: NavigationGraph };
  /** The app launch per appearance, kept apart from source routes: it has no route or navigation. */
  launch?: PublicLaunchEvidence[];
  surfaces: Array<{
    id: string; status: "added" | "modified" | "removed" | "unchanged";
    base: SourceRoute | null; head: SourceRoute | null;
    baseImage?: CapturedImage; headImage?: CapturedImage;
    sourceChange?: SourceChangeSummary;
    /** Why the surface was selected, kept when Git details are dropped from a published report. */
    sourceImpact?: SourceImpactKind[];
    /** Which source change reaches a surface present at both revisions (see surfaceSourceScope). */
    sourceScope?: SurfaceSourceScope;
    baseOutcome?: CaptureOutcome;
    headOutcome?: CaptureOutcome;
    visual?: PublicVisualVerdict;
    review?: PublicSurfaceReview;
    note?: PublicChangeNote;
    /** The appearance this surface rendered in; a secondary appearance is its own surface, `<id>@<scheme>`. */
    colorScheme?: "light" | "dark";
    /** Named in `exploration.exclude`: kept for its neighbors' navigation context, never captured on either side. */
    excluded?: true;
  }>;
};
export function validateCapturePlan(value: unknown): SourceCapturePlan {
  const p = value as SourceCapturePlan;
  if (!p || p.contract !== "explore.plan"
    || !/^[a-f0-9]{40}$/.test(p.baseSha) || !/^[a-f0-9]{40}$/.test(p.headSha)
    || !["all", "changes"].includes(p.mode)
    || !Array.isArray(p.surfaces) || p.surfaces.length > 5000) throw new Error("Invalid source capture plan");
  const ids = new Set<string>();
  for (const s of p.surfaces) {
    if (!s || ids.has(s.id) || !["added", "modified", "removed", "unchanged"].includes(s.status)
      || (!s.baseSurface && !s.headSurface)) throw new Error("Invalid capture surface");
    ids.add(s.id);
    if (s.sourceChange) validateSourceChangeSummary(s.sourceChange, p.baseSha, p.headSha);
    for (const entry of [s.baseSurface, s.headSurface]) {
      if (entry) {
        if (entry.id !== s.id) throw new Error("Capture surface id mismatch");
      }
    }
    if ((s.status === "added") !== !s.baseSurface || (s.status === "removed") !== !s.headSurface) {
      throw new Error("Capture surface presence mismatch");
    }
  }
  if (p.navigation !== undefined && (!p.navigation || typeof p.navigation !== "object"
    || !p.navigation.base || !p.navigation.head)) throw new Error("Invalid capture navigation");
  const seeds = p.surfaces.filter(surface => surface.status !== "unchanged").map(surface => surface.id);
  if (p.excludedSurfaceIds !== undefined && (!Array.isArray(p.excludedSurfaceIds) || !p.excludedSurfaceIds.length
    || p.excludedSurfaceIds.some((id, index) => typeof id !== "string" || !ids.has(id) || index > 0 && p.excludedSurfaceIds![index - 1]! >= id))) {
    throw new Error("Invalid excludedSurfaceIds");
  }
  const excluded = new Set(p.excludedSurfaceIds ?? []);
  for (const side of ["base", "head"] as const) {
    const routes = validateSourceRoutes(p.surfaces.map(s => s[`${side}Surface`]).filter(Boolean));
    const graph = p.navigation ? validateNavigationGraph(p.navigation[side], routes.map(entry => entry.id)) : undefined;
    const context = graph ? new Set(navigationCaptureContext(graph, seeds, routes)) : undefined;
    for (const surface of p.surfaces) {
      const entry = surface[`${side}Surface`];
      const selected = Boolean(entry && entry.kind !== "redirect" && !excluded.has(surface.id)
        && (p.mode === "all" || (context ? context.has(surface.id) : surface.status !== "unchanged")));
      if (surface[`${side}Capture`] !== selected) throw new Error("Capture selection disagrees with source and navigation context");
    }
  }
  for (const [key, expected] of [
    ["inventorySurfaceIds", p.surfaces.map(s => s.id)],
    ["baseCaptureSurfaceIds", p.surfaces.filter(s => s.baseCapture).map(s => s.id)],
    ["headCaptureSurfaceIds", p.surfaces.filter(s => s.headCapture).map(s => s.id)],
  ] as const) {
    if (JSON.stringify(p[key]) !== JSON.stringify(expected)) throw new Error(`Invalid ${key}`);
  }
  return p;
}
