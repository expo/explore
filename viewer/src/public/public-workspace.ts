import type { CapturedImage, PublicLaunchEvidence, PublicReview } from "../../../src/contracts/capture";
import type {
  Artifact,
  BuildComparisonEntry,
  BuildComparisonStatus,
  BuildWorkspacePayload,
  Coverage,
  ExploreMap,
} from "../../../src/types";
import {
  captureNotes,
  visualDiff,
  type RegionMove,
  type ReviewerChangeCategory,
  type ReviewRuntimeEvidence,
  type ViewerReviewProjection,
} from "../utils/review-model";
import { normalizePublicReviewForReading, type ReviewContractGap } from "../../../src/contracts/review-validation";

/** The Viewer opens what the contract accepts and says what it left out, instead of refusing the whole report. */
export function reportContractGap(gap: ReviewContractGap): void {
  const where = gap.surfaceId ?? gap.section ?? "report";
  console.warn(`Explore report: ${where} failed the review contract (${gap.message}); ${gap.dropped} omitted.`);
}
import { sourceImpactSentences } from "../../../src/contracts/source-change";
import { navigationCaptureContext } from "../../../src/contracts/navigation-graph";
import { projectSourceNavigation } from "../utils/source-navigation";

type Side = "base" | "head";
type Surface = PublicReview["surfaces"][number];

const REVIEWER_CATEGORIES: ReadonlySet<string> = new Set<ReviewerChangeCategory>([
  "screen", "element", "text", "visible-text", "interaction", "accessibility", "visual",
]);

function isReviewerCategory(value: string): value is ReviewerChangeCategory {
  return REVIEWER_CATEGORIES.has(value);
}

/**
 * The status a reviewer filters on. Publications that carry evidence-based review verdicts
 * (pixel and accessibility comparison) use them; source impact alone is not a visual verdict.
 */
function comparisonStatus(surface: Surface): BuildComparisonEntry["status"] {
  // A screen the run could not capture is reported as unavailable, not as a change or as unchanged.
  // An unattributed frame (the app showed another screen) is not this route's evidence either; a legacy unverified
  // capture without an `observed` record keeps its source-derived status.
  const unattributed = (side: Side) => unattributedCapture(surface, side) && Boolean((side === "base" ? surface.baseOutcome : surface.headOutcome)?.observed);
  if (surface.status !== "removed" && (captureUnavailable(surface, "head") || unattributed("head"))) return "unavailable";
  if (surface.status === "unchanged" || surface.status === "modified") {
    if (captureUnavailable(surface, "base") || unattributed("base")) return "unavailable";
  }
  if (surface.status === "added" || surface.status === "removed") return surface.status;
  // A source change with no comparison is not a change the captures show: not compared, whatever the source did.
  return comparisonReview(surface)?.status ?? "not-compared";
}

/**
 * A region's move in percent of the image, from its pixel shift and the image size its rect implies. iOS
 * screenshots are one pixel per point; Android's are in the screenshot's own pixels, since the report does not
 * know the screen's density.
 */
function regionMove(region: NonNullable<NonNullable<Surface["visual"]>["regions"]>[number], platform: "ios" | "android" | undefined): RegionMove | undefined {
  const { shift, rect, normalizedRect } = region;
  if (!shift || !(normalizedRect.width > 0) || !(normalizedRect.height > 0)) return undefined;
  const imageWidth = (rect.width * 100) / normalizedRect.width;
  const imageHeight = (rect.height * 100) / normalizedRect.height;
  return { x: (shift.x * 100) / imageWidth, y: (shift.y * 100) / imageHeight, amount: { x: shift.x, y: shift.y }, unit: platform === "android" ? "px" : "pt" };
}

/** The side's route exists and was planned, but its capture ended without a screenshot. */
function captureUnavailable(surface: Surface, side: Side): boolean {
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  return surface[side]?.kind === "screen" && !imageFor(surface, side) && outcome !== undefined && outcome.status !== "captured";
}

/** A captured frame of the screen the app showed instead of the planned route. */
function unattributedCapture(surface: Surface, side: Side): boolean {
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  return Boolean(surface[side]?.kind === "screen" && imageFor(surface, side) && outcome?.status === "captured" && outcome.landing !== "verified");
}

function unattributedSummary(surface: Surface, side: Side): string {
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  const expected = surface[side]?.kind === "screen" ? surface[side].route : surface.id;
  if (outcome?.observed?.reason === "landing-mismatch") return `expected ${expected}, the app showed ${outcome.observed.route ?? "another screen"}`;
  if (outcome?.observed?.reason === "observer-not-ready") return `expected ${expected}, the route observer reported nothing`;
  return "destination unverified";
}

function verifiedCapture(surface: Surface, side: Side): boolean {
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  return Boolean(surface[side]?.kind === "screen" && imageFor(surface, side)
    && outcome?.status === "captured" && outcome.landing === "verified");
}

function comparisonReview(surface: Surface): Surface["review"] {
  if (surface.status === "added" || surface.status === "removed") {
    return surface.review?.status === surface.status ? surface.review : undefined;
  }
  return verifiedCapture(surface, "base") && verifiedCapture(surface, "head") ? surface.review : undefined;
}

/** The Compare line for a surface whose frame on either side is unattributed: it is shown, never compared. */
function unattributedChangeSummary(surface: Surface): string | undefined {
  const side = (["head", "base"] as const).find(candidate => unattributedCapture(surface, candidate));
  if (!side) return undefined;
  const summary = unattributedSummary(surface, side);
  return `Unattributed frame${side === "base" ? " in the base" : ""} — ${summary.charAt(0).toUpperCase()}${summary.slice(1)}. Not compared.`;
}

function buildKey(review: PublicReview, side: Side): string {
  // These are viewer keys, not EAS build IDs. A changes-only baseline can have no build.
  return `public-${side}:${review.pullRequest[side].sha}`;
}

function observationId(side: Side, surfaceId: string): string {
  return `capture:${side}:${surfaceId}`;
}

function variantId(surfaceId: string): string {
  return `surface:${surfaceId}`;
}

function launchFileName(entry: PublicLaunchEvidence): string {
  return entry.id.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Launch comparison: pixel verdict when both sides observed a splash; otherwise what each side showed. */
export function launchStatus(entry: PublicLaunchEvidence): BuildComparisonStatus {
  if (!entry.base) return "added";
  if (!entry.head) return "removed";
  // Both launches were captured; without a splash on each side there is nothing to pixel-compare.
  return entry.visual ? entry.visual.verdict : "not-compared";
}

export function launchSummary(entry: PublicLaunchEvidence): string {
  const firstScreen = (side: NonNullable<PublicLaunchEvidence["head"]>) => side.firstScreenMs !== undefined ? `; first screen after ${(side.firstScreenMs / 1000).toFixed(1)} s` : "";
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const shown = (side: NonNullable<PublicLaunchEvidence["head"]>) => side.splashVisibleMs === undefined ? ""
    : side.splashChangedMs !== undefined ? `, steady for ${seconds(side.splashVisibleMs)}, first changed at ${seconds(side.splashChangedMs)}`
      : side.source === "recording" ? `, steady for ${seconds(side.splashVisibleMs)}` : ` for at least ${seconds(side.splashVisibleMs)}`;
  const describe = (side: NonNullable<PublicLaunchEvidence["head"]>) => side.status === "observed"
    ? `splash observed${shown(side)}${firstScreen(side)}`
    : side.source === "recording" ? `no splash observed (the launch finished before one was shown${firstScreen(side)})`
      : "no splash observed in screenshots (a launch recording, decoded with ffmpeg on the runner, is needed to see short splashes)";
  if (entry.visual) {
    const verdict = { unchanged: "Splash unchanged", modified: "Splash changed", "needs-review": "Splash needs review" }[entry.visual.verdict];
    return `${verdict}; ${describe(entry.head!)}.`;
  }
  return [entry.base ? `Before: ${describe(entry.base)}` : undefined, entry.head ? `After: ${describe(entry.head)}` : undefined].filter(Boolean).join(" ") + ".";
}

function imageFor(surface: Surface, side: Side): CapturedImage | undefined {
  return side === "base" ? surface.baseImage : surface.headImage;
}

function sourcePath(route: string): string {
  return route.split(/[?#]/, 1)[0] || "/";
}

function titleFor(entry: Pick<NonNullable<Surface["head"]>, "route">): string {
  const segments = sourcePath(entry.route).split("/").filter(Boolean);
  // The existing semantic map groups the first title segment. Keep the source route's
  // hierarchy here so, for example, Scan — Instruction stays in the Scan area.
  return segments.map((segment) => segment
    .replaceAll("-", " ").replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())).join(" — ") || "/";
}

function captureStatus(review: PublicReview, surface: Surface, side: Side): string {
  if (!surface[side]) return "Absent from this source revision";
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  if (imageFor(surface, side)) {
    if (verifiedCapture(surface, side)) return "Captured; destination verified";
    return outcome?.observed ? `Captured; not attributed — ${unattributedSummary(surface, side)}` : "Captured; destination unverified";
  }
  if (surface[side].kind === "redirect") return "Redirect declaration; no screenshot selected";
  if (outcome) {
    switch (outcome.status) {
      case "missing-params": return "Missing route parameters";
      case "unsupported-link": return "Route does not have a supported deep link";
      case "budget-exhausted": return "Capture budget exhausted";
      case "failed": return outcome.reason ? `Capture failed: ${outcome.reason.replace(/\.$/, "")}` : "Capture failed";
      case "captured": return "Selected screenshot is missing";
    }
  }
  if (!review.navigation && review.mode === "changes" && surface.status === "unchanged") {
    return "Not selected in changes mode";
  }
  return "Selected screenshot is missing";
}

function sourceSummary(surface: Surface): string {
  if (surface.sourceChange) return surface.sourceChange.summary;
  const route = (surface.head ?? surface.base)!.route;
  switch (surface.status) {
    case "added": return `Added ${route} screen.`;
    case "removed": return `Removed ${route} screen.`;
    // Published reports carry the reason categories even though Git details stay in planning.
    case "modified": return sourceImpactSentences(surface.sourceImpact) ?? `Source changes affect ${route}.`;
    case "unchanged": return `No source changes affect ${route}.`;
  }
}

const SCHEME_SUFFIX = /@(light|dark)$/;
const routeOf = (id: string): string => id.replace(SCHEME_SUFFIX, "");

function sidePayload(review: PublicReview, side: Side): { map: ExploreMap; coverage: Coverage } {
  const inventory = review.surfaces.filter((surface) => surface[side]);
  const navigation = review.navigation?.[side];
  // Navigation names routes; a route's appearance surfaces (`<route>@<scheme>`) all stand for it.
  const routes = new Map<string, NonNullable<PublicReview["surfaces"][number]["base"]>>();
  for (const surface of inventory) {
    const id = routeOf(surface.id);
    if (!routes.has(id)) routes.set(id, { ...surface[side]!, id });
  }
  const selectedRoutes = navigation ? new Set(review.mode === "all" ? [...routes.keys()] : navigationCaptureContext(navigation,
    inventory.filter(surface => surface.status !== "unchanged").map(surface => routeOf(surface.id)),
    [...routes.values()])) : undefined;
  const selected = selectedRoutes ? new Set(inventory.filter(surface => selectedRoutes.has(routeOf(surface.id))).map(surface => surface.id)) : undefined;
  // Planned structural groups describe the full inventory, including routes outside the
  // capture budget. Keep their placeholders available in every canvas.
  const declared = inventory;
  const incoming = new Set(navigation?.edges.map(edge => edge.to));
  const outgoing = new Set(navigation?.edges.map(edge => edge.from));
  const depths = new Map<string, number>();
  if (navigation) {
    const successors = new Map<string, string[]>();
    for (const edge of navigation.edges) successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
    const queue = [...routes.keys()].filter(id => !incoming.has(id));
    queue.forEach(id => depths.set(id, 0));
    for (let position = 0; position < queue.length; position++) {
      const from = queue[position]!;
      for (const to of successors.get(from) ?? []) {
        if (depths.has(to)) continue;
        depths.set(to, depths.get(from)! + 1);
        queue.push(to);
      }
    }
  }
  const images = declared.flatMap((surface) => {
    const image = imageFor(surface, side);
    return image ? [image] : [];
  });
  const times = images.map((image) => image.capturedAt).sort();
  const recordedBuildId = side === "head" ? review.runtime.buildId : images[0]?.buildId;
  const limits = { maxScreens: declared.length, maxActions: 0, maxDurationMinutes: 0 };
  const map: ExploreMap = {
    contract: "expo.explore.local-map.v1",
    revision: 1,
    run: {
      id: `public:${review.runId}:${review.runAttempt}:${side}`,
      name: typeof review.runtime.appName === "string" && review.runtime.appName.trim()
        ? review.runtime.appName.trim()
        // Older immutable publications predate app-name metadata.
        : "App",
      // Reports published before Android support carry no platform: they are iOS.
      platform: review.runtime.platform ?? "ios",
      ...(review.runtime.platforms && review.runtime.platforms.length > 1 ? { platforms: [...review.runtime.platforms] } : {}),
      controller: "agent-device",
      status: "complete",
      createdAt: times[0] ?? review.createdAt,
      updatedAt: review.createdAt,
      completedAt: times.at(-1) ?? review.createdAt,
      build: {
        gitCommit: review.pullRequest[side].sha,
        ...(recordedBuildId ? { id: recordedBuildId, source: "eas" as const } : {}),
      },
      environment: {
        ...(review.runtime.device ? { deviceModel: review.runtime.device.model, osVersion: review.runtime.device.osVersion } : {}),
        ...(review.runtime.colorSchemes ? { colorSchemes: [...review.runtime.colorSchemes] } : {}),
      },
      // This map projects an inventory, not an exploration session with action/time budgets.
      limits,
      // The head build names the app in the header; a baseline icon would be the old one.
      ...(side === "head" && review.runtime.appIcon ? {
        appIcon: {
          id: "image:app-icon",
          kind: "screenshot" as const,
          path: "head/app-icon.png",
          publicUrl: review.runtime.appIcon.url,
          sha256: review.runtime.appIcon.sha256,
          mimeType: "image/png",
          width: review.runtime.appIcon.width,
          height: review.runtime.appIcon.height,
          createdAt: review.createdAt,
        },
      } : {}),
    },
    screens: [], variants: [], observations: [], artifacts: [],
    elements: [], actionAttempts: [], transitions: [],
    journeys: [],
    frontier: [], gaps: [],
    ...(navigation ? { sourceNavigation: projectSourceNavigation(navigation, id => id) } : {}),
  };

  for (const surface of declared) {
    const entry = surface[side]!;
    const image = imageFor(surface, side);
    const capturedAt = image?.capturedAt ?? review.createdAt;
    const observations = image ? [observationId(side, surface.id)] : [];
    map.screens.push({
      id: surface.id,
      title: titleFor(entry),
      // Preserve route variants in the original viewer's existing route-family carousel.
      // The exact source route (including query) remains in the review evidence below.
      route: sourcePath(entry.route),
      state: entry.variant,
      start: Boolean(navigation && !incoming.has(routeOf(surface.id))),
      terminal: Boolean(navigation && !navigation.unresolved.some(message => message.startsWith("Unresolved navigation:")) && !outgoing.has(routeOf(surface.id))),
      depth: depths.get(routeOf(surface.id)) ?? 0,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      visits: image ? 1 : 0,
      variantIds: [variantId(surface.id)],
      observationIds: observations,
      elementIds: [],
      ...(surface.colorScheme ? { colorScheme: surface.colorScheme } : {}),
    });
    map.variants.push({
      id: variantId(surface.id), screenId: surface.id,
      key: entry.variant, name: entry.variant,
      firstSeenAt: capturedAt, lastSeenAt: capturedAt,
      observationIds: [...observations],
    });
    if (image) {
      const artifact: Artifact = {
        id: `image:${side}:${surface.id}`,
        kind: "screenshot",
        path: `${side}/${surface.id}.png`,
        publicUrl: image.url,
        sha256: image.sha256,
        mimeType: "image/png",
        width: image.width, height: image.height,
        createdAt: image.capturedAt,
      };
      map.artifacts.push(artifact);
      map.observations.push({
        id: observationId(side, surface.id),
        screenId: surface.id,
        variantId: variantId(surface.id),
        // The only content identity available is the recorded screenshot checksum.
        // It is never compared to infer source status or a semantic/visual change.
        fingerprints: { combined: image.sha256 },
        capturedAt: image.capturedAt,
        surfaceScope: "app",
        elementIds: [], elements: [],
        screenshotArtifactId: artifact.id,
      });
    }
    if (!verifiedCapture(surface, side)) {
      const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
      const outsideCaptureContext = review.mode === "changes" && selected !== undefined && !selected.has(surface.id);
      const deliberatelyOmitted = !image && !outcome && (entry.kind === "redirect" || outsideCaptureContext
        || (!navigation && review.mode === "changes" && surface.status === "unchanged"));
      map.gaps.push({
        id: `capture:${side}:${surface.id}`,
        screenId: surface.id,
        kind: "coverage",
        status: deliberatelyOmitted ? "accepted" : "open",
        message: deliberatelyOmitted && outsideCaptureContext && entry.kind !== "redirect"
          ? "Not compared; no capture was recorded" : captureStatus(review, surface, side),
        createdAt: review.createdAt,
      });
    }
  }
  // The app launch per appearance sits outside the route graph: its frame is the splash while it was visible,
  // or the first settled frame when the launch finished before a splash could be observed.
  for (const entry of review.launch ?? []) {
    const launch = entry[side];
    if (!launch) continue;
    const frame = launch.splash ?? launch.settled;
    const artifact: Artifact = {
      id: `image:${side}:${entry.id}`, kind: "screenshot", path: `${side}/${launchFileName(entry)}.png`,
      publicUrl: frame.url, sha256: frame.sha256, mimeType: "image/png", width: frame.width, height: frame.height, createdAt: frame.capturedAt,
    };
    map.artifacts.push(artifact);
    if (launch.filmstrip) {
      const strip = launch.filmstrip;
      map.artifacts.push({ id: `filmstrip:${side}:${entry.id}`, kind: "screenshot", path: `${side}/${launchFileName(entry)}-filmstrip.png`, publicUrl: strip.url,
        sha256: strip.sha256, mimeType: "image/png", width: strip.width, height: strip.height, createdAt: strip.capturedAt });
    }
    if (launch.video) {
      map.artifacts.push({ id: `video:${side}:${entry.id}`, kind: "video", path: `${side}/${launchFileName(entry)}.mp4`, publicUrl: launch.video.url,
        sha256: launch.video.sha256, bytes: launch.video.bytes, mimeType: "video/mp4", createdAt: launch.relaunchedAt });
    }
    map.screens.push({
      id: entry.id, title: "Launch", route: "launch", state: launch.status === "observed" ? "splash" : "first frame",
      start: false, terminal: false, depth: 0, firstSeenAt: frame.capturedAt, lastSeenAt: frame.capturedAt, visits: 1,
      variantIds: [variantId(entry.id)], observationIds: [observationId(side, entry.id)], elementIds: [],
      ...(entry.colorScheme ? { colorScheme: entry.colorScheme } : {}),
    });
    map.variants.push({ id: variantId(entry.id), screenId: entry.id, key: "launch", name: "launch", firstSeenAt: frame.capturedAt, lastSeenAt: frame.capturedAt, observationIds: [observationId(side, entry.id)] });
    map.observations.push({
      id: observationId(side, entry.id), screenId: entry.id, variantId: variantId(entry.id),
      fingerprints: { combined: frame.sha256 }, capturedAt: frame.capturedAt, surfaceScope: "app",
      elementIds: [], elements: [], screenshotArtifactId: artifact.id,
    });
    if (launch.status !== "observed") {
      map.gaps.push({ id: `launch:${side}:${entry.id}`, screenId: entry.id, kind: "coverage", status: "accepted",
        message: launch.source === "recording"
          ? "No splash screen was observed: the launch finished before one was shown. Shown is the first settled frame."
          : "No splash screen was observed in screenshots; a launch recording (ffmpeg on the runner) is needed to see short splashes. Shown is the first settled frame.", createdAt: review.createdAt });
    }
  }
  const openGaps = map.gaps.filter((gap) => gap.status === "open");
  if (openGaps.length > 0) map.run.status = "partial";
  return {
    map,
    coverage: {
      screens: map.screens.length, variants: map.variants.length,
      observations: map.observations.length,
      elements: 0, transitions: 0,
      actions: { attempted: 0, succeeded: 0, noChange: 0, failed: 0, blocked: 0 },
      frontier: { pending: 0, claimed: 0, done: 0, skipped: 0, blocked: 0 },
      gaps: { open: openGaps.length, accepted: map.gaps.length - openGaps.length, resolved: 0 },
      completion: { eligible: openGaps.length === 0, blockers: openGaps.map((gap) => gap.message) },
      limits,
    },
  };
}

/** Adapt published data into the existing viewer contract without changing its UI or evidence. */
export function publicReviewToWorkspace(review: PublicReview): BuildWorkspacePayload {
  review = normalizePublicReviewForReading(review, reportContractGap);
  const baselineBuildId = buildKey(review, "base");
  const currentBuildId = buildKey(review, "head");
  const base = sidePayload(review, "base");
  const head = sidePayload(review, "head");
  const entries = review.surfaces.map((surface): BuildComparisonEntry => ({
    id: surface.id,
    relationship: surface.status === "added" || surface.status === "removed"
      ? surface.status : "one-to-one",
    status: comparisonStatus(surface),
    changeSummary: comparisonReview(surface)?.description ?? unattributedChangeSummary(surface) ?? sourceSummary(surface),
    baselineScreenIds: surface.base ? [surface.id] : [],
    currentScreenIds: surface.head ? [surface.id] : [],
    baselineRepresentativeObservationIds: surface.baseImage ? [observationId("base", surface.id)] : [],
    currentRepresentativeObservationIds: surface.headImage ? [observationId("head", surface.id)] : [],
    // Stable source IDs establish correspondence, not a manually reviewed visual pairing.
    representativePairs: [],
    confidence: 1,
    rationale: comparisonReview(surface)
      ? "Declared source surface identity with an evidence-based review status from pixel and accessibility comparison."
      : "Declared source surface identity and published source status; no image comparison.",
  }));
  for (const entry of review.launch ?? []) {
    entries.push({
      id: entry.id, relationship: entry.base && entry.head ? "one-to-one" : entry.base ? "removed" : "added", status: launchStatus(entry),
      changeSummary: launchSummary(entry),
      baselineScreenIds: entry.base ? [entry.id] : [], currentScreenIds: entry.head ? [entry.id] : [],
      baselineRepresentativeObservationIds: entry.base ? [observationId("base", entry.id)] : [],
      currentRepresentativeObservationIds: entry.head ? [observationId("head", entry.id)] : [],
      representativePairs: [], confidence: 1,
      rationale: entry.visual ? "The app launch in this appearance, with a pixel comparison of the splash frames." : "The app launch in this appearance; no splash comparison.",
    });
  }
  return {
    catalog: {
      contract: "expo.explore.build-catalog.v1",
      name: head.map.run.name,
      currentBuildId,
      defaultBaselineBuildId: baselineBuildId,
      builds: (["base", "head"] as const).map((side) => ({
        id: buildKey(review, side), kind: "build", version: review.pullRequest[side].sha.slice(0, 7),
        mapDir: `public/${side}`,
      })),
      comparisons: [{ baselineBuildId, currentBuildId, path: "public/source-comparison" }],
    },
    builds: { [baselineBuildId]: base, [currentBuildId]: head },
    comparison: {
      contract: "expo.explore.build-comparison.v1",
      baselineBuildId, currentBuildId,
      baselineRunId: base.map.run.id, currentRunId: head.map.run.id,
      baselineRevision: base.map.revision, currentRevision: head.map.revision,
      entries,
    },
  };
}

function runtimeEvidence(review: PublicReview, surface: Surface, side: Side): ReviewRuntimeEvidence | undefined {
  const entry = surface[side];
  if (!entry) return undefined;
  const image = imageFor(surface, side);
  const outcome = side === "base" ? surface.baseOutcome : surface.headOutcome;
  const compared = comparisonReview(surface);
  const visual = verifiedCapture(surface, "base") && verifiedCapture(surface, "head") ? surface.visual : undefined;
  return {
    id: `public:${side}:${surface.id}`,
    buildId: buildKey(review, side),
    screenId: surface.id,
    variantId: variantId(surface.id),
    side: side === "base" ? "baseline" : "current",
    ...(image ? { observationId: observationId(side, surface.id) } : {}),
    groups: {
      screen: [
        { label: "Route", value: entry.route, copyable: true },
        { label: "Source surface", value: surface.id, copyable: true },
        { label: "Declaration", value: entry.kind },
        { label: "Variant", value: entry.variant },
        { label: "Navigation provider", value: entry.provider },
        ...(surface.sourceChange ? [
          { label: "Source impact", value: surface.sourceChange.impact },
          { label: "Git change summary", value: surface.sourceChange.summary },
          ...(surface.sourceChange.files.length ? [{
            label: "Changed source files", value: surface.sourceChange.files.map(file => file.path).join("\n"), copyable: true,
          }] : []),
        ] : []),
        ...(entry.kind === "redirect" && entry.redirectTo ? [{ label: "Declared redirect", value: entry.redirectTo }] : []),
      ],
      ui: [
        compared?.facts
          ? { label: "Accessibility comparison", value: `${compared.facts.length} deterministic fact${compared.facts.length === 1 ? "" : "s"}` }
          : { label: "Accessibility snapshot", value: "Not included in this publication" },
      ],
      interaction: [{ label: "Interaction evidence", value: "Not included in this publication" }],
      capture: [
        { label: "Capture", value: captureStatus(review, surface, side) },
        ...(image || outcome ? [{ label: "Landing", value: verifiedCapture(surface, side) ? "Verified" : unattributedCapture(surface, side) && outcome?.observed ? "Unattributed" : "Unverified",
          ...(!verifiedCapture(surface, side) ? { tone: "warning" as const } : {}) }] : []),
        ...(outcome ? [{ label: "Capture attempts", value: String(outcome.attempts) }] : []),
        ...(outcome?.reason ? [{ label: "Capture reason", value: outcome.reason, tone: "warning" as const }] : []),
        ...(outcome?.error ? [
          { label: "Capture error", value: `${outcome.error.code}: ${outcome.error.message}`, tone: "warning" as const },
          { label: "Next action", value: outcome.error.nextAction },
        ] : []),
        { label: "Capture mode", value: review.mode },
        { label: "Stability", value: image ? "Single sample; not assessed" : "Not assessed" },
        ...(compared ? [{
          label: "Review status", value: `${compared.status} — ${compared.description}`,
          ...(compared.status === "needs-review" ? { tone: "warning" as const } : {}),
        }] : []),
        ...(visual ? [{
          label: "Visual comparison",
          value: `${visual.verdict} (${visual.reason})`
            + (visual.mismatchPercentage === undefined ? "" : ` · ${visual.mismatchPercentage}% of pixels`)
            + ` · threshold ${visual.threshold} · ${visual.tool}`,
          ...(visual.verdict === "needs-review" ? { tone: "warning" as const } : {}),
        }] : []),
        ...(image ? [
          { label: "Captured", value: image.capturedAt },
          { label: "Image SHA-256", value: image.sha256, copyable: true },
          { label: "Combined fingerprint", value: "Screenshot SHA-256 only" },
          { label: "Dimensions", value: `${image.width} × ${image.height}px` },
        ] : []),
      ],
      environment: [
        { label: "Source commit", value: review.pullRequest[side].sha, copyable: true },
        { label: "Source ref", value: review.pullRequest[side].ref },
        { label: "Capture run", value: `${review.runId} / attempt ${review.runAttempt}`, copyable: true },
        // The legacy map needs time bounds, but PNG timestamps are not session start/end times.
        { label: "Session started", value: "Not included in this publication" },
        { label: "Session completed", value: "Not included in this publication" },
        ...(image ? [{ label: "EAS build", value: image.buildId, copyable: true }] : []),
      ],
    },
  };
}

/** Public captures carry source classification and provenance, but no semantic change facts. */
/** A redirect renders no screen of its own; its declaration names the routes it forwards to. */
function redirectDeclaration(surface: Surface): { redirectTo?: string; redirectTargets?: string[] } {
  const entry = surface.head ?? surface.base;
  if (entry?.kind !== "redirect") return {};
  const targets = entry.redirectTargets ?? (entry.redirectTo ? [entry.redirectTo] : []);
  return {
    ...(entry.redirectTo ? { redirectTo: entry.redirectTo } : {}),
    ...(targets.length ? { redirectTargets: [...targets] } : {}),
  };
}

export function publicReviewProjection(review: PublicReview): ViewerReviewProjection {
  review = normalizePublicReviewForReading(review, reportContractGap);
  const surfaces: ViewerReviewProjection["surfaces"] = {};
  const evidence: ViewerReviewProjection["runtimeEvidence"] = {};
  for (const surface of review.surfaces) {
    const ref = `public:${surface.id}`;
    const baseline = runtimeEvidence(review, surface, "base");
    const current = runtimeEvidence(review, surface, "head");
    const compared = comparisonReview(surface);
    const facts = compared?.facts ?? [];
    // Pixel regions only mean something when both captures landed on the verified screen.
    const visual = verifiedCapture(surface, "base") && verifiedCapture(surface, "head") && surface.visual?.verdict !== "unchanged"
      ? visualDiff({
        ...(surface.visual?.mismatchPercentage !== undefined ? { mismatchPercentage: surface.visual.mismatchPercentage } : {}),
        ...(surface.visual?.ignoredStatusBarRegions ? { ignoredStatusBarRegions: surface.visual.ignoredStatusBarRegions } : {}),
        ...(surface.visual?.ignoredHomeIndicatorRegions ? { ignoredHomeIndicatorRegions: surface.visual.ignoredHomeIndicatorRegions } : {}),
        regions: (surface.visual?.regions ?? []).map((region) => {
          const move = regionMove(region, review.runtime.platform);
          return { ...region.normalizedRect, share: region.shareOfDiffPercentage, ...(move ? { move } : {}) };
        }),
      })
      : undefined;
    // A side that exists in its revision but has no screenshot says why, in the report's words.
    const missing = (side: Side) => surface[side] && !imageFor(surface, side) ? captureStatus(review, surface, side) : undefined;
    const notes = captureNotes({ before: missing("base"), after: missing("head") });
    surfaces[surface.id] = {
      ...(surface.note ? { note: surface.note.text } : {}),
      ...(visual ? { visual } : {}),
      ...(notes ? { captureNotes: notes } : {}),
      // Deterministic accessibility facts from the capture run; the categories are the CLI's.
      reviewerChanges: facts.map((fact, index) => ({
        id: `${ref}:fact:${index}`,
        category: isReviewerCategory(fact.category) ? fact.category : "accessibility",
        templateId: fact.templateId,
        bullet: fact.bullet,
        priority: index,
        evidenceRefs: [ref],
      })),
      runtimeEvidenceRefs: [ref],
      noVisibleChange: compared?.status === "unchanged",
      ...(verifiedCapture(surface, "base") && verifiedCapture(surface, "head") && surface.visual?.verdict === "unchanged" ? { pixelsUnchanged: true as const } : {}),
      ...redirectDeclaration(surface),
      ...((surface.head ?? surface.base)?.routeFile ? { routeFile: (surface.head ?? surface.base)!.routeFile } : {}),
    };
    evidence[ref] = {
      ...(baseline ? { baseline } : {}),
      ...(current ? { current } : {}),
    };
  }
  for (const entry of review.launch ?? []) {
    const ref = `public:${entry.id}`;
    const visual = entry.visual && entry.visual.verdict !== "unchanged"
      ? visualDiff({
        ...(entry.visual.mismatchPercentage !== undefined ? { mismatchPercentage: entry.visual.mismatchPercentage } : {}),
        ...(entry.visual.ignoredStatusBarRegions ? { ignoredStatusBarRegions: entry.visual.ignoredStatusBarRegions } : {}),
        ...(entry.visual.ignoredHomeIndicatorRegions ? { ignoredHomeIndicatorRegions: entry.visual.ignoredHomeIndicatorRegions } : {}),
        regions: (entry.visual.regions ?? []).map((region) => ({ ...region.normalizedRect, share: region.shareOfDiffPercentage })),
      })
      : undefined;
    const missing = (side: Side) => entry[side] && entry[side]!.status !== "observed"
      ? `No splash screen was observed${entry[side]!.source === "recording" ? "" : " in screenshots"}; this is the first settled frame.` : undefined;
    const notes = captureNotes({ before: missing("base"), after: missing("head") });
    surfaces[entry.id] = { note: launchSummary(entry), ...(visual ? { visual } : {}), ...(notes ? { captureNotes: notes } : {}),
      reviewerChanges: [], runtimeEvidenceRefs: [ref], noVisibleChange: entry.visual?.verdict === "unchanged" };
    evidence[ref] = {};
  }
  return {
    pullRequest: {
      ...(review.pullRequest.origin === "local" || review.pullRequest.origin === "compare" ? { origin: review.pullRequest.origin } : {}),
      number: review.pullRequest.number, title: review.pullRequest.title, url: review.pullRequest.url,
      base: { ...review.pullRequest.base }, head: { ...review.pullRequest.head },
    },
    surfaces,
    runtimeEvidence: evidence,
  };
}
