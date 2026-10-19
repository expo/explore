import type { RunTarget } from "../types.js";
import { appearancePairs, bundleColorSchemes, routeIdOfScreen } from "../capture/appearance.js";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertDecodedPng } from "../shared/png-evidence.js";
import { assertAgentAcceptance, validateCapturePlan, type AppIconImage, type BundleLaunchCapture, type CaptureBundle, type CaptureOutcome, type CapturedImage, type LaunchFilmstrip, type LaunchFrame, type PublicFlowEvidence, type PublicFlowSide, type PublicLaunchSide, type PublicReview, flowSurfaceId, homeIndicatorBandPercent, launchSurfaceId, statusBarBandPercent } from "../contracts/capture.js";
import { COLOR_SCHEMES } from "../capture/appearance.js";
import { launchDirectory } from "../capture/launch-capture.js";
import { APP_ICON_FILE, APP_ICON_MAX_SIZE } from "../capture/app-icon.js";
import { readExportedMap, type PublicSurfaceAssessment } from "./evidence-assessment.js";
import { surfaceSourceScope, type SourceCapturePlan } from "../source/capture-plan.js";
import { projectReviewPresentation } from "../contracts/review.js";

/** A captured scene's window origin: two finite point coordinates, nothing else. */
function validPresentation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "sceneOrigin") return false;
  const origin = (value as { sceneOrigin: unknown }).sceneOrigin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin) || Object.keys(origin).sort().join() !== "x,y") return false;
  const { x, y } = origin as { x: unknown; y: unknown };
  return typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 100_000 && typeof y === "number" && Number.isFinite(y) && Math.abs(y) <= 100_000;
}
import { sourceImpactKinds, type SourceImpactKind } from "../contracts/source-change.js";
import type { RuntimeExecutionContext } from "./runtime-adapter.js";
import type { ExploreMap } from "../types.js";
import { CiError } from "../shared/ci-errors.js";

/** The icon sits next to the bundle under a fixed name, at most 128 pixels on a side. */
function assertAppIconRecord(icon: unknown): asserts icon is NonNullable<CaptureBundle["appIcon"]> {
  const value = icon as NonNullable<CaptureBundle["appIcon"]>;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== "height,path,sha256,width"
    || value.path !== APP_ICON_FILE || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.width) || value.width <= 0 || value.width > APP_ICON_MAX_SIZE
    || !Number.isSafeInteger(value.height) || value.height <= 0 || value.height > APP_ICON_MAX_SIZE) {
    throw new Error("Capture bundle app icon is invalid");
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
function validLaunchFrame(frame: unknown, scheme: string, name: string): frame is LaunchFrame {
  const value = frame as LaunchFrame;
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === "capturedAt,height,path,sha256,width"
    && value.path === `${launchDirectory(scheme)}/${name}.png` && SHA256.test(value.sha256)
    && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0
    && Number.isFinite(Date.parse(value.capturedAt));
}
function validFilmstrip(filmstrip: unknown, scheme: string): boolean {
  if (!filmstrip || typeof filmstrip !== "object") return false;
  const { frameTimesMs, ...frame } = filmstrip as LaunchFilmstrip;
  return validLaunchFrame(frame, scheme, "filmstrip") && Array.isArray(frameTimesMs) && frameTimesMs.length > 0 && frameTimesMs.length <= 8
    && frameTimesMs.every(time => Number.isSafeInteger(time) && Math.abs(time) <= 600_000);
}
/** Launch evidence is keyed by appearance and holds bounded frames under its own directory. */
function assertLaunchRecords(launch: unknown): asserts launch is NonNullable<CaptureBundle["launch"]> {
  if (!launch || typeof launch !== "object" || Array.isArray(launch)) throw new Error("Capture bundle launch evidence is invalid");
  for (const [scheme, record] of Object.entries(launch as Record<string, BundleLaunchCapture>)) {
    if (!COLOR_SCHEMES.includes(scheme as "light") || !record || typeof record !== "object" || Array.isArray(record)
      || Object.keys(record).some(key => !["status", "source", "splash", "settled", "relaunchedAt", "splashVisibleMs", "splashChangedMs", "firstScreenMs", "filmstrip", "video"].includes(key))
      || !["observed", "not-observed"].includes(record.status) || !["recording", "screenshot"].includes(record.source)
      || (record.status === "observed") !== (record.splash !== undefined)
      || (record.splash !== undefined && !validLaunchFrame(record.splash, scheme, "splash")) || !validLaunchFrame(record.settled, scheme, "settled")
      || !Number.isFinite(Date.parse(record.relaunchedAt))
      || (record.firstScreenMs !== undefined && !(Number.isSafeInteger(record.firstScreenMs) && record.firstScreenMs >= 0))
      || (record.splashChangedMs !== undefined && !(Number.isSafeInteger(record.splashChangedMs) && record.splashChangedMs >= 0 && record.splashChangedMs <= 600_000))
      || (record.filmstrip !== undefined && !validFilmstrip(record.filmstrip, scheme))
      || (record.splashVisibleMs !== undefined && (!Number.isSafeInteger(record.splashVisibleMs) || record.splashVisibleMs < 0 || record.splashVisibleMs > 600_000))
      || (record.video !== undefined && (!record.video || typeof record.video !== "object"
        || Object.keys(record.video).some(key => !["path", "sha256", "bytes", "mimeType", "durationMs"].includes(key))
        || record.video.path !== `${launchDirectory(scheme)}/launch.mp4` || !SHA256.test(record.video.sha256) || record.video.mimeType !== "video/mp4"
        || !Number.isSafeInteger(record.video.bytes) || record.video.bytes <= 0 || record.video.bytes > 200 * 1024 * 1024
        || (record.video.durationMs !== undefined && (!Number.isSafeInteger(record.video.durationMs) || record.video.durationMs < 0))))) {
      throw new Error(`Capture bundle launch evidence for ${scheme} is invalid`);
    }
  }
}

/** Returns the URL recorded for each screenshot in the review. */
type ScreenshotStore = { put(path: string, bytes: Uint8Array, contentType: string): Promise<string> };

/** Runtime evidence stored next to a side's screenshots so a cached base can still be compared. */
export type CachedSideEvidence = { map?: ExploreMap; execution?: RuntimeExecutionContext };
function identifier(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("Invalid publication identifier");
  return value;
}
/** Validate inventory/outcome binding before any consumer uses a capture bundle. */
/**
 * `<route>@<scheme>` carries one secondary appearance pass's own outcome (mergeSchemeOutcomes): its failure when the
 * primary pass captured the route (the review marks that scheme unavailable), or its verified frame when the primary
 * pass did not (the review publishes the route from that scheme and marks the primary one unavailable).
 */
function secondaryPassOutcome(bundle: CaptureBundle, selected: ReadonlySet<string>, id: string): boolean {
  const { routeId, scheme } = routeIdOfScreen(id);
  const own = bundle.outcomes[id];
  const verified = own?.status === "captured" && own.landing === "verified";
  return scheme !== undefined && selected.has(routeId) && verified !== (bundle.outcomes[routeId]?.status === "captured");
}

export async function readCaptureBundle(directory: string): Promise<CaptureBundle> {
  const bundle = JSON.parse(await readFile(resolve(await realpath(directory), "bundle.json"), "utf8")) as CaptureBundle;
  if (!bundle || bundle.contract !== "explore.bundle" || typeof bundle.gitCommit !== "string"
    || !Array.isArray(bundle.selectedSurfaceIds) || !bundle.images || typeof bundle.images !== "object" || Array.isArray(bundle.images)
    || !bundle.outcomes || typeof bundle.outcomes !== "object" || Array.isArray(bundle.outcomes)
    || !/^[a-f0-9]{40}$/.test(bundle.gitCommit)) {
    throw new Error("Capture bundle is not a valid explore.bundle document");
  }
  if (bundle.completedAt !== undefined && (typeof bundle.completedAt !== "string" || !Number.isFinite(Date.parse(bundle.completedAt)))) {
    throw new Error("Capture bundle completion timestamp is invalid");
  }
  if (bundle.appIcon !== undefined) assertAppIconRecord(bundle.appIcon);
  if (bundle.launch !== undefined) assertLaunchRecords(bundle.launch);
  const selected = new Set(bundle.selectedSurfaceIds);
  if (selected.size !== bundle.selectedSurfaceIds.length
    || bundle.selectedSurfaceIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))
    || Object.keys(bundle.images).some(id => !selected.has(routeIdOfScreen(id).routeId))
    || Object.keys(bundle.outcomes).some(id => !selected.has(id) && !secondaryPassOutcome(bundle, selected, id))) throw new Error("Capture bundle inventory is inconsistent");
  for (const id of bundle.selectedSurfaceIds) {
    const outcome = bundle.outcomes[id]; const image = bundle.images[id];
    if (!outcome || !["captured", "missing-params", "unsupported-link", "failed", "budget-exhausted"].includes(outcome.status)
      || !["verified", "unverified"].includes(outcome.landing) || !Number.isSafeInteger(outcome.attempts) || outcome.attempts < 0
      || (outcome.status === "captured") !== Boolean(image)
      || image && outcome.screenshotSha256 !== undefined && outcome.screenshotSha256 !== image.sha256) {
      throw new Error(`Capture outcome and image disagree for ${id}`);
    }
  }
  if (bundle.captureContexts !== undefined) {
    const contexts = bundle.captureContexts;
    if (!contexts || typeof contexts !== "object" || Array.isArray(contexts)
      || Object.keys(contexts).some(id => !selected.has(id))
      || Object.keys(bundle.images).some(id => !Object.hasOwn(contexts, id.replace(/@(light|dark)$/, "")))) {
      // A secondary-appearance frame travels under its route's capture context.
      throw new Error("Capture contexts do not cover the captured inventory");
    }
    for (const context of Object.values(contexts)) {
      if (!context || typeof context !== "object" || Array.isArray(context)
        || Object.keys(context).some(key => !["description", "parameters", "requiredLabels", "presentation"].includes(key))
        || typeof context.description !== "string" || !context.description.trim() || context.description.length > 4000
        || !context.parameters || typeof context.parameters !== "object" || Array.isArray(context.parameters)
        || Object.keys(context.parameters).length > 100
        || Object.entries(context.parameters).some(([key, value]) => !key || key.length > 256
          || (typeof value !== "string" && (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== "string")))
          || (typeof value === "string" ? value.length > 4000 : value.some(item => item.length > 4000)))
        || !Array.isArray(context.requiredLabels) || context.requiredLabels.length > 100
        || context.requiredLabels.some(label => typeof label !== "string" || !label.trim() || label.length > 1000)
        || context.presentation !== undefined && !validPresentation(context.presentation)) {
        throw new Error("Capture context is invalid");
      }
    }
  }
  assertAgentAcceptance(bundle, undefined, { required: bundle.captureContexts !== undefined });
  if (bundle.agentAcceptance && Object.keys(bundle.images).length) {
    const map = await readExportedMap(directory, { checkArtifacts: true });
    if (map.run.build.gitCommit !== bundle.gitCommit) throw new Error("Agent acceptance map belongs to a different source commit");
    assertAgentAcceptance(bundle, map, { required: true });
  }
  return bundle;
}

async function captureCompletion(bundle: CaptureBundle, directory: string): Promise<number[]> {
  if (bundle.completedAt !== undefined) return [Date.parse(bundle.completedAt)];
  // Existing internal evidence may predate the bundle timestamp. Its map records actual execution time.
  const path = resolve(directory, "screen-map.json");
  try {
    const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 50 * 1024 * 1024) {
      const map = JSON.parse(await readFile(path, "utf8")) as ExploreMap;
      const completedAt = map?.run?.completedAt;
      if (map?.run?.build?.gitCommit === bundle.gitCommit && typeof completedAt === "string" && Number.isFinite(Date.parse(completedAt))) {
        return [Date.parse(completedAt)];
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return Object.values(bundle.images).map(image => Date.parse(image.capturedAt)).filter(Number.isFinite);
}
async function uploadSide(store: ScreenshotStore, directory: string, expectedCommit: string, expectedIds: string[], prefix: string) {
  directory = await realpath(directory);
  const bundle = await readCaptureBundle(directory);
  if (bundle.gitCommit !== expectedCommit
    || JSON.stringify(bundle.selectedSurfaceIds) !== JSON.stringify(expectedIds)
    || Object.keys(bundle.images).some(id => !expectedIds.includes(routeIdOfScreen(id).routeId))) {
    throw new Error("Capture bundle does not match the exact source plan");
  }
  const images: Record<string, CapturedImage> = {};
  // A route's secondary-appearance frames (`<id>@<scheme>`) upload next to its primary one.
  const imageIds = expectedIds.flatMap(routeId => Object.keys(bundle.images).filter(id => routeIdOfScreen(id).routeId === routeId));
  for (const id of imageIds) {
    const frame = bundle.images[id]!;
    const path = resolve(directory, frame.path);
    const rel = relative(resolve(directory), path);
    if (isAbsolute(frame.path) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      || await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Invalid capture artifact path");
    const bytes = await readFile(path); assertDecodedPng(bytes, "Publication image");
    if (frame.sha256 !== createHash("sha256").update(bytes).digest("hex")
      || frame.width !== bytes.readUInt32BE(16) || frame.height !== bytes.readUInt32BE(20)
      || frame.sourceCommit !== expectedCommit
      || !Number.isFinite(Date.parse(frame.capturedAt))) throw new Error("Capture image provenance mismatch");
    const url = await store.put(`${prefix}/${identifier(id.replace(/@(light|dark)$/, "-$1"))}.png`, bytes, "image/png");
    const { path: _, ...metadata } = frame;
    images[id] = { ...metadata, url };
  }
  const launch: Record<string, PublicLaunchSide> = {};
  const evidenceFile = async (relativePath: string) => {
    const path = resolve(directory, relativePath);
    const rel = relative(resolve(directory), path);
    if (isAbsolute(relativePath) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)
      || await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Invalid capture artifact path");
    return readFile(path);
  };
  for (const [scheme, record] of Object.entries(bundle.launch ?? {})) {
    const frame = async (value: LaunchFrame, name: string) => {
      const bytes = await evidenceFile(value.path); assertDecodedPng(bytes, "Launch frame");
      if (value.sha256 !== createHash("sha256").update(bytes).digest("hex") || value.width !== bytes.readUInt32BE(16) || value.height !== bytes.readUInt32BE(20)) {
        throw new Error("Launch frame provenance mismatch");
      }
      const { path: _, ...metadata } = value;
      return { ...metadata, url: await store.put(`${prefix}/launch-${scheme}-${name}.png`, bytes, "image/png") };
    };
    const { splash, settled, video, filmstrip, ...rest } = record;
    let publicFilmstrip: PublicLaunchSide["filmstrip"];
    if (filmstrip) {
      const { frameTimesMs, ...strip } = filmstrip;
      publicFilmstrip = { ...await frame(strip, "filmstrip"), frameTimesMs };
    }
    let publicVideo: PublicLaunchSide["video"];
    if (video) {
      const bytes = await evidenceFile(video.path);
      if (video.sha256 !== createHash("sha256").update(bytes).digest("hex") || video.bytes !== bytes.length) throw new Error("Launch recording provenance mismatch");
      const { path: _, ...metadata } = video;
      publicVideo = { ...metadata, url: await store.put(`${prefix}/launch-${scheme}.mp4`, bytes, "video/mp4") };
    }
    launch[scheme] = { ...rest, ...(splash ? { splash: await frame(splash, "splash") } : {}), settled: await frame(settled, "settled"),
      ...(publicFilmstrip ? { filmstrip: publicFilmstrip } : {}), ...(publicVideo ? { video: publicVideo } : {}) };
  }
  const flows: Record<string, PublicFlowSide> = {};
  for (const [flowId, flow] of Object.entries(bundle.flows ?? {})) {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(flowId)) throw new Error("Capture bundle flow id is invalid");
    const frames: PublicFlowSide["frames"] = {};
    for (const [key, value] of Object.entries(flow.frames)) {
      if (!/^[a-z0-9-]+(?:@(?:light|dark))?$/.test(key)) throw new Error("Capture bundle flow frame key is invalid");
      const bytes = await evidenceFile(value.path); assertDecodedPng(bytes, "Flow frame");
      if (value.sha256 !== createHash("sha256").update(bytes).digest("hex") || value.width !== bytes.readUInt32BE(16) || value.height !== bytes.readUInt32BE(20)
        || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error("Flow frame provenance mismatch");
      const { path: _, ...metadata } = value;
      frames[key] = { ...metadata, url: await store.put(`${prefix}/flow-${flowId.replace("/", "-")}-${key}.png`, bytes, "image/png") };
    }
    const { frames: _frames, file: _file, title: _title, ...rest } = flow;
    flows[flowId] = { ...rest, frames };
  }
  let appIcon: AppIconImage | undefined;
  if (bundle.appIcon) {
    const iconPath = resolve(directory, bundle.appIcon.path);
    if (await realpath(iconPath) !== iconPath || !(await lstat(iconPath)).isFile()) throw new Error("Invalid capture app icon path");
    const bytes = await readFile(iconPath); assertDecodedPng(bytes, "App icon");
    if (bundle.appIcon.sha256 !== createHash("sha256").update(bytes).digest("hex")
      || bundle.appIcon.width !== bytes.readUInt32BE(16) || bundle.appIcon.height !== bytes.readUInt32BE(20)) {
      throw new Error("Capture app icon does not match its record");
    }
    const { path: _, ...metadata } = bundle.appIcon;
    appIcon = { ...metadata, url: await store.put(`${prefix}/${APP_ICON_FILE}`, bytes, "image/png") };
  }
  return { bundle, images, appIcon, launch, flows, ...(bundle.flowsFailure ? { flowsFailure: bundle.flowsFailure } : {}) };
}
/** Every flow either side ran, head's order first; a frame row for each key a side took, in head's step order. */
function publicFlows(base: { bundle: CaptureBundle; flows: Record<string, PublicFlowSide> }, head: { bundle: CaptureBundle; flows: Record<string, PublicFlowSide> },
  assessments: CaptureReviewOptions["assessments"]): PublicFlowEvidence[] {
  const ids = [...new Set([...Object.keys(head.flows), ...Object.keys(base.flows)])];
  const schemes = bundleColorSchemes(head.bundle);
  return ids.map(id => {
    const record = head.bundle.flows?.[id] ?? base.bundle.flows?.[id];
    const keys = [...new Set([...(head.bundle.flows?.[id]?.steps ?? []).flatMap(step => step.frame ? [step.frame] : []),
      ...(base.bundle.flows?.[id]?.steps ?? []).flatMap(step => step.frame ? [step.frame] : [])])];
    // A checkpoint frame is named by its `app.screenshot(label)`; a per-step frame by its step number and what the step did.
    const labelOf = (key: string) => {
      const steps = (head.bundle.flows?.[id] ?? base.bundle.flows?.[id])?.steps ?? [];
      const index = steps.findIndex(step => step.frame === key);
      const step = steps[index];
      if (!step) return key;
      return step.api === "app.screenshot" ? step.label || key : `${index + 1}. ${step.label || step.api}`.slice(0, 80);
    };
    return { id, title: record?.title ?? id, file: record?.file ?? "",
      ...(base.flows[id] ? { base: base.flows[id] } : {}), ...(head.flows[id] ? { head: head.flows[id] } : {}),
      frames: keys.flatMap(key => [key, ...schemes.slice(1).map(scheme => `${key}@${scheme}`)]
        .filter(frameKey => frameKey === key || head.flows[id]?.frames[frameKey] || base.flows[id]?.frames[frameKey])
        .map(frameKey => { const surface = flowSurfaceId(id, frameKey); const visual = assessments?.[surface]?.visual; const scheme = frameKey.slice(key.length + 1);
          return { key: frameKey, id: surface, label: labelOf(key), ...(visual ? { visual } : {}), ...(scheme ? { colorScheme: scheme as "light" | "dark" } : {}) }; })) };
  });
}
export type CaptureReviewOptions = {
  plan: unknown; pullRequest: unknown; baseDirectory: string; headDirectory: string;
  runId: string; runAttempt: string; assertCurrentHead: () => Promise<void>;
  /** Deterministic per-surface verdicts from assessPublicEvidence; merged as optional review fields. */
  assessments?: Record<string, PublicSurfaceAssessment>;
  /** Runtime maps and execution contexts to keep with each side's cache record. */
  sideEvidence?: { base?: CachedSideEvidence; head?: CachedSideEvidence };
  /** Resolved app identity for the reviewer header; recorded verbatim, never inferred. */
  app?: { version?: string; buildNumber?: string };
  /** The platforms config.yaml captures (this report's platform among them), when more than one. */
  platforms?: Array<"ios" | "android">;
  /** The target this report captures, and every target config.yaml captures (this one among them), when more than one. */
  target?: RunTarget;
  targets?: RunTarget[];
};

/** Build the validated review independently of where its metadata and images will be stored. */
async function constructCaptureReview(options: CaptureReviewOptions, store: ScreenshotStore) {
  const plan = validateCapturePlan(options.plan);
  const pr = projectReviewPresentation(options.pullRequest);
  if (pr.head.sha !== plan.headSha || pr.base.sha !== plan.baseSha) throw new Error("PR identity differs from capture plan");
  const run = `${identifier(options.runId)}-${identifier(options.runAttempt)}`;
  const prefix = pr.origin === "local" ? `local/${identifier(pr.runId)}/${run}`
    : pr.origin === "compare" ? `reviews/${identifier(pr.repositoryId)}/compare/${pr.base.sha}-${pr.head.sha}/${run}`
    : `reviews/${identifier(pr.repositoryId)}/pr-${pr.number}/${pr.head.sha}/${run}`;
  await options.assertCurrentHead();
  const base = await uploadSide(store, options.baseDirectory, plan.baseSha, plan.baseCaptureSurfaceIds, `${prefix}/base`);
  const head = await uploadSide(store, options.headDirectory, plan.headSha, plan.headCaptureSurfaceIds, `${prefix}/head`);
  const completionTimes = (await Promise.all([
    captureCompletion(base.bundle, options.baseDirectory), captureCompletion(head.bundle, options.headDirectory),
  ])).flat();
  if (!completionTimes.length) throw new CiError({ code: "CAPTURE_TIMESTAMP_MISSING", stage: "export",
    message: "Capture evidence has no recorded completion or screenshot time.",
    nextAction: "Rerun capture to produce a bundle with its actual completion timestamp." });
  const impactKinds = (surface: SourceCapturePlan["surfaces"][number]): SourceImpactKind[] => (
    surface.status === "modified" && surface.sourceChange
      ? sourceImpactKinds(surface.sourceChange.files.map((file) => file.relation))
      : []
  );
  // Each controller reads and drives the device its own way; a review compares captures made the same way.
  if ((head.bundle.controller ?? "agent-device") !== (base.bundle.controller ?? "agent-device")) {
    throw new Error(`The base was captured with ${base.bundle.controller ?? "agent-device"} and the head with ${head.bundle.controller ?? "agent-device"}; capture both sides with the same controller.`);
  }
  const colorSchemes = bundleColorSchemes(head.bundle);
  const baseColorSchemes = bundleColorSchemes(base.bundle);
  const review: PublicReview = {
    contract: "explore.review", pullRequest: pr, mode: plan.mode, createdAt: new Date(Math.max(...completionTimes)).toISOString(),
    runId: options.runId, runAttempt: options.runAttempt,
    ...(plan.navigation ? { navigation: plan.navigation } : {}),
    runtime: { projectId: head.bundle.easProjectId ?? "", buildId: head.bundle.easBuildId ?? "", gitCommit: plan.headSha,
      platform: head.bundle.platform ?? "ios", ...(head.bundle.controller === "argent" ? { controller: "argent" as const } : {}), statusBarBandPercent: statusBarBandPercent(head.bundle.platform),
      ...(homeIndicatorBandPercent(head.bundle.platform) > 0 ? { homeIndicatorBandPercent: homeIndicatorBandPercent(head.bundle.platform) } : {}),
      ...(options.platforms && options.platforms.length > 1 ? { platforms: [...options.platforms] } : {}),
      ...(options.target ? { target: { ...options.target } } : {}),
      ...(options.targets && options.targets.length > 1 ? { targets: options.targets.map(target => ({ ...target })) } : {}),
      ...(colorSchemes.length > 1 ? { colorSchemes: [...colorSchemes] } : {}),
      ...(head.bundle.runtimeProfile ? { device: { model: head.bundle.runtimeProfile.deviceModel, osVersion: head.bundle.runtimeProfile.osVersion } } : {}),
      ...(head.bundle.appName?.trim() ? { appName: head.bundle.appName.trim() } : {}),
      ...(head.appIcon ? { appIcon: head.appIcon } : {}),
      ...(options.app?.version?.trim() ? { appVersion: options.app.version.trim() } : {}),
      ...(options.app?.buildNumber?.trim() ? { appBuildNumber: options.app.buildNumber.trim() } : {}) },
    ...(Object.keys(head.launch).length || Object.keys(base.launch).length ? { launch: colorSchemes
      .filter(scheme => head.launch[scheme] || base.launch[scheme])
      .map((scheme, index) => {
        const id = launchSurfaceId(scheme, index === 0 && scheme === colorSchemes[0]);
        const assessment = options.assessments?.[id];
        return { id, ...(colorSchemes.length > 1 ? { colorScheme: scheme } : {}),
          ...(base.launch[scheme] ? { base: base.launch[scheme]! } : {}), ...(head.launch[scheme] ? { head: head.launch[scheme]! } : {}),
          ...(assessment?.visual ? { visual: assessment.visual } : {}) };
      }) } : {}),
    ...(Object.keys(head.flows).length || Object.keys(base.flows).length ? { flows: publicFlows(base, head, options.assessments) } : {}),
    ...(base.flowsFailure || head.flowsFailure ? { flowsFailure: { ...(base.flowsFailure ? { base: base.flowsFailure } : {}), ...(head.flowsFailure ? { head: head.flowsFailure } : {}) } } : {}),
    surfaces: plan.surfaces.flatMap(s => appearancePairs(s.id, colorSchemes, baseColorSchemes).map(({ id, scheme, baseId }) => {
      const assessment = options.assessments?.[id];
      // The bundle records one outcome per route; a secondary appearance's surface carries that outcome only when the
      // side rendered the appearance (its own frame, its own digest), so a single-appearance base just has no outcome there.
      const outcomeFor = (side: typeof base | typeof head, sideId: string): CaptureOutcome | undefined => {
        const own = side.bundle.outcomes[sideId];
        if (own && sideId !== s.id) return own;
        const outcome = side.bundle.outcomes[s.id]; const image = side.images[sideId];
        if (!outcome || sideId === s.id) return outcome;
        if (outcome.status !== "captured") return outcome;
        if (!image) return undefined;
        return outcome.screenshotSha256 === undefined ? outcome : { ...outcome, screenshotSha256: image.sha256 };
      };
      const baseOutcome = baseId === null ? undefined : outcomeFor(base, baseId); const headOutcome = outcomeFor(head, id);
      // An appearance the base never rendered is an added surface: no base route, no source scope.
      const headOnly = baseId === null && Boolean(s.headSurface);
      const status = headOnly ? "added" as const : s.status;
      // A secondary appearance is its own surface, so its source routes carry its `<id>@<scheme>` id too.
      const withId = <T extends { id: string } | null>(route: T): T => (route && route.id !== id ? { ...route, id } : route);
      return { id, status, base: headOnly ? null : withId(s.baseSurface), head: withId(s.headSurface),
        ...(colorSchemes.length > 1 ? { colorScheme: scheme } : {}),
        ...(s.sourceChange ? { sourceChange: s.sourceChange } : {}),
        ...(impactKinds(s).length ? { sourceImpact: impactKinds(s) } : {}),
        ...(!headOnly && surfaceSourceScope(s) ? { sourceScope: surfaceSourceScope(s)! } : {}),
        ...(baseOutcome ? { baseOutcome } : {}),
        ...(headOutcome ? { headOutcome } : {}),
        ...(baseId !== null && base.images[baseId] ? { baseImage: base.images[baseId]! } : {}), ...(head.images[id] ? { headImage: head.images[id]! } : {}),
        ...(assessment?.visual ? { visual: assessment.visual } : {}),
        ...(assessment?.review ? { review: assessment.review } : {}),
      };
    })),
  };
  return { plan, pr, run, prefix, base, head, review };
}

/** Prepare local report assets without contacting a publication service. */
export async function prepareCaptureReview(options: CaptureReviewOptions): Promise<{
  review: PublicReview; assets: Array<{ sha256: string; path: string }>;
}> {
  const { review } = await constructCaptureReview(options, {
    put: async (_path, bytes, contentType) => `https://embedded.expo-explore.invalid/${createHash("sha256").update(bytes).digest("hex")}.${contentType === "video/mp4" ? "mp4" : "png"}`,
  });
  const assets = new Map<string, { sha256: string; path: string }>();
  for (const directory of [options.baseDirectory, options.headDirectory]) {
    const bundle = await readCaptureBundle(directory);
    for (const image of Object.values(bundle.images)) {
      assets.set(image.sha256, { sha256: image.sha256, path: resolve(directory, image.path) });
    }
    for (const record of Object.values(bundle.launch ?? {})) {
      for (const file of [record.splash, record.settled, record.video]) if (file) assets.set(file.sha256, { sha256: file.sha256, path: resolve(directory, file.path) });
    }
    for (const flow of Object.values(bundle.flows ?? {})) {
      for (const frame of Object.values(flow.frames)) assets.set(frame.sha256, { sha256: frame.sha256, path: resolve(directory, frame.path) });
    }
  }
  // Only the head icon names the app in the review header.
  const icon = review.runtime.appIcon && (await readCaptureBundle(options.headDirectory)).appIcon;
  if (icon) assets.set(icon.sha256, { sha256: icon.sha256, path: resolve(options.headDirectory, icon.path) });
  return { review, assets: [...assets.values()].sort((a, b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) };
}
