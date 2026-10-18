import { appearanceArgs, argentColorSchemes, bundleColorSchemes, mergeSchemeOutcomes, resolveColorSchemes, routeIdOfScreen, type AppearanceSetting, type ColorScheme } from "./appearance.js";
import { assertNoCaptureHealthIssues, captureHealthIssues, partitionCaptureHealthIssues } from "./health.js";
import { type RouteResetSetting } from "./route-reset.js";
import { defaultReadinessSeconds } from "./readiness.js";
import { captureLaunch, ffmpegRecordingTools, launchDirectory, type LaunchSetting, type RecordingTools } from "./launch-capture.js";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertDecodedPng } from "../shared/png-evidence.js";
import { AGENT_ACCEPTANCE_POLICY, assertAgentAcceptance, validateCapturePlan, type AgentAcceptedFrame, type BundleLaunchCapture, type CaptureBundle } from "../contracts/capture.js";
import { sourceRouteNames } from "../contracts/source-route.js";
import type { SourceCapturePlan } from "../source/capture-plan.js";
import { CONTRACT, type ExploreMap, type Platform, type RunStatus } from "../types.js";
import { ExploreStore, validateMap } from "../map/store.js";
import { CiError, serializeCiError, toCiError } from "../shared/ci-errors.js";
import type { CaptureSetupAction, DevicePose } from "../config/explore-config.js";
import { type CiAgentRuntimeOptions } from "./agent/runtime.js";
import { EAS_CLI_VERSION, CONTROLLER_SESSION, isRecord, parseJson, baseEnvironment, nonEmpty } from "./common.js";
import { lstatIfExists, isWithin, temporaryCaptureDirectory, absoluteContractFile, readContractJson, assertNoSymlinkAncestors } from "./fs-safety.js";
import { loadAppIcon, loadCachedAppIcon, storeAppIcon } from "./app-icon.js";
import { defaultRunner, runAgentControllerCommand } from "./controller.js";
import { silentProgress, type Progress } from "../shared/progress.js";
import { assertCaptureEasProfile, assertSimulatorAvailable, fingerprintFrom, hasEasEnvironmentFetchFailure, nativeBuildFrom, existingBuild, repackProfileFrom, prepareExactSourceBuild, type RepackMode } from "./eas-build.js";
import { SIMULATOR_DOTENV_FILE_NAME, SIMULATOR_DOTENV_HEADER, endedOwnSimulatorSession, liveSimulatorSessionsNamed, simulatorSessionName, simulatorStartFailure, readSimulatorDotenvHandoff, assertSimulatorSessionIdentity, assertSimulatorStopped, collectRuntime, controllerVersion, simulatorOsVersion, type ActiveSimulatorRuntime, type SimulatorConnection } from "./simulator.js";
import { argentControllerInvocation } from "./controller-invocation.js";
import { sharedBuild } from "./shared-build.js";
import { LOCAL_EMULATOR_STATE_PREFIX, LOCAL_SIMULATOR_STATE_PREFIX, agentDeviceClaims, assertLocalEmulatorCompatible, createLocalSimulator, startLocalEmulator, waitForLocalEmulator, waitForLocalSimulator, deleteLocalEmulator,
  deleteLocalSimulator, hostEmulatorAbi, installOnLocalEmulator, installOnLocalSimulator, approveLinkScheme, localPoseShown,
  pngSize, setLocalEmulatorAppearance, setLocalSimulatorAppearance, startLocalArgentServer, stopLocalAgentDevice, stopLocalArgentServer, type LocalArgentServer } from "./local-simulator.js";
import { ensureArgentToolServer } from "../shared/controller-cache.js";
import { openLocalCaptureRecord } from "./local-registry.js";
import { approveSessionUrlSchemes, simulatorControl, simulatorControlActions, type EasCommand } from "./simulator-control.js";
import { solidColour } from "../shared/png-evidence.js";
import { type UnattributedSetting } from "./unattributed.js";
import { appScheme, hasConcreteRoutePath, unavailableRoute, capturePlannedRoutes, deviceArgs } from "./route-capture.js";

export { assertDecodedPng } from "../shared/png-evidence.js";
export { EAS_CLI_VERSION, AGENT_DEVICE_VERSION } from "./common.js";
export { runAgentControllerCommand, controllerCommandFailure, runControllerRead, runControllerReadAsync } from "./controller.js";
export type { ControllerReadRecovery } from "./controller.js";
export { captureDeepLink, capturePlannedRoutes } from "./route-capture.js";

export type CommandRequest = { command: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; timeoutMs?: number; allowFailure?: boolean };
export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (request: CommandRequest) => CommandResult;
export type CaptureSetupStep = CaptureSetupAction;
export type CiMapOptions = {
  /** A frame of the screen the app showed instead of a planned route: published as unattributed evidence (default) or discarded. */
  unattributed?: UnattributedSetting;
  useLocalEasSession?: boolean;
  project: string; mapDirectory: string; outputDirectory: string;
  name: string; buildId: string; buildVersion: string; gitCommit: string;
  platform: Platform; bundleId: string; scheme?: string; device: string; easProfile: string; expoToken: string;
  planPath: string; side?: "base" | "head"; setup?: readonly CaptureSetupStep[]; reuseDirectory?: string;
  agent?: CiAgentRuntimeOptions;
  maxScreens: number; maxActions: number; maxDurationMinutes: number; forceFreshBuild: boolean;
  confirmExternalRun: boolean; confirmTrustedSource: boolean; sessionStatePath?: string;
  environment?: NodeJS.ProcessEnv; runner?: CommandRunner; now?: () => number; fetch?: typeof fetch;
  /** Host-side pause used while a controller read is resent; tests pair it with `now` so recovery waits are not real time. */
  sleep?: (milliseconds: number) => void;
  easCommand: string; repackCommand: string; agentDeviceCommand: string;
  /** The device controller EAS starts on the session; agent-device unless the config chose Argent. */
  controller?: "agent-device" | "argent";
  /** A foldable's pose (device.pose), set with the controller's `fold` before anything is captured. */
  devicePose?: DevicePose;
  /** Where the app runs: an EAS Simulator session (default), or a simulator created on this Mac for the capture. */
  simulator?: "eas" | "local";
  /** Where the route observer is bundled into the app: a hosted EAS repack job (default) or repack-app on this machine. */
  repack?: RepackMode;
  /** A folder the review's captures share builds through: targets of one platform, profile and commit build and repack once. */
  buildShare?: string;
  /** Which appearances to capture; `auto` (default) follows the app's `userInterfaceStyle`. */
  appearance?: AppearanceSetting;
  /** Whether to observe the app launch (splash screen) per appearance; `video` also keeps the recording. Defaults to `off`. */
  launch?: LaunchSetting;
  /** Decodes launch recordings; defaults to ffmpeg when installed. */
  recordingTools?: RecordingTools | null;
  /** What puts the app in a known state before each route's app link: its root link (default) or nothing. */
  reset?: RouteResetSetting;
  /** Seconds a route link gets to show its destination after `open` returns (default 8 on iOS, 10 on Android). */
  readinessSeconds?: number;
  /** Reports each step as it starts; capture output stays in the map and bundle. */
  progress?: Progress;
  /** Stops the capture between steps (before the build, the session and each route); a session it started is still stopped. */
  signal?: AbortSignal;
};
export type SimulatorRuntimeMetadata = {
  provider: "eas-simulator" | "local-simulator"; controller: "agent-device" | "argent"; controllerPackageVersion: string;
  easCliVersion: string; platform: Platform; deviceModel: string; osVersion: string; locale: string;
  orientation: "portrait" | "landscape"; colorScheme: "light" | "dark" | "system"; colorSchemes?: ColorScheme[];
  sessionLifecycle: "stopped";
};
export type CiMapResult = {
  buildId: string; buildFingerprint: string | null; nativeEasBuildId: string | null;
  easBuildId: string | null; reusedEasBuild: boolean; simulatorSessionId: string | null;
  simulatorRuntime: SimulatorRuntimeMetadata | null; mapDirectory: string; outputDirectory: string;
  runStatus: RunStatus; app: { name: string; version?: string; buildNumber?: string };
  outcomes: CaptureBundle["outcomes"];
};


/** New EAS sessions a capture starts in place of one EAS failed to start (ERRORED while booting, or never named). */
const SESSION_START_RETRIES = 5;
/**
 * The most time, from the first failed start, that replacement sessions may take, waits included. It keeps a review
 * inside its CI job (90 minutes for a baseline) with a native build, a repack and both captures still to run.
 */
const SESSION_RETRY_BUDGET_MS = 30 * 60_000;
/** How long one `eas simulator:start` may take: eas-cli waits up to 15 minutes for a session, not counting the queue. */
const SESSION_START_TIMEOUT_MS = 20 * 60_000;
/** The wait before each of them: 10 s, doubling, at most 2 minutes. */
export function sessionRetryDelayMs(retry: number): number {
  return Math.min(10_000 * 2 ** (retry - 1), 120_000);
}

/**
 * Minutes an EAS session is asked for beyond the capture's own budget. The session starts beside the repack, and the
 * capture deadline only starts once the app is installed, so the session also has to outlast a slow or queued hosted
 * repack, the app's upload and its install; 20 minutes covers a typical repack with room for a queue.
 */
const SESSION_PREPARATION_MINUTES = 20;
/**
 * EAS refuses (before allocating anything) a session longer than the plan allows, naming that maximum. Only that exact
 * rejection is recognized; any other start failure is kept as it is.
 */
function sessionDurationLimit(error: unknown): number | undefined {
  const match = /max duration must not exceed (\d+(?:\.\d+)?) minutes/i.exec(error instanceof Error ? error.message : String(error));
  return match ? Math.floor(Number(match[1])) : undefined;
}

/**
 * A start failure EAS may not repeat on the next try: a failed request, a dropped connection, a timeout, or no capacity
 * right now. An account's quota, plan or permissions are not, and fail at once rather than after every retry.
 */
function transientSessionStartFailure(error: unknown): boolean {
  if (error instanceof CiError && error.code === "CONTROLLER_REQUEST_TIMEOUT") return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/not authori[sz]ed|unauthori[sz]ed|forbidden|permission|quota|billing|max duration/i.test(message)) return false;
  return /GraphQL request failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|\b50[234]\b|capacity/i.test(message);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function newCaptureMap(options: CiMapOptions, runtime?: ActiveSimulatorRuntime, fingerprint?: string): ExploreMap {
  const timestamp = new Date((options.now ?? Date.now)()).toISOString();
  return {
    contract: CONTRACT, revision: 0,
    run: { id: options.buildId, name: options.name, platform: options.platform, controller: options.controller ?? "agent-device", status: "draft",
      bundleId: options.bundleId, ...(runtime ? { deviceId: runtime.controllerDeviceId } : {}),
      createdAt: timestamp, updatedAt: timestamp,
      build: { id: options.buildId, version: options.buildVersion, gitCommit: options.gitCommit, source: "eas", ...(fingerprint ? { hash: fingerprint } : {}) },
      environment: runtime ? { deviceModel: runtime.deviceModel, osVersion: runtime.osVersion, locale: runtime.locale,
        orientation: runtime.orientation, colorScheme: runtime.colorScheme } : { deviceModel: options.device },
      limits: { maxScreens: options.maxScreens, maxActions: options.maxActions, maxDurationMinutes: options.maxDurationMinutes } },
    artifacts: [], screens: [], variants: [], observations: [], elements: [], actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [],
  };
}

/** Keep the setup actions whose required source route exists at this revision. */
export function revisionSetup(setup: readonly CaptureSetupStep[], plan: SourceCapturePlan, side: "base" | "head"): CaptureSetupStep[] {
  const routes = (surface: "baseSurface" | "headSurface") => new Set(plan.surfaces.flatMap(row => {
    const route = row[surface];
    return route ? sourceRouteNames(route) : [];
  }));
  const present = routes(`${side}Surface`), known = new Set([...routes("baseSurface"), ...routes("headSurface")]);
  return setup.filter((action, index) => {
    if (action.requiresRoute === undefined) return true;
    // A misspelled route would silently skip the action on both revisions.
    if (!known.has(action.requiresRoute)) throw new CiError({ code: "SETUP_ROUTE_UNKNOWN", stage: "setup",
      message: `setup[${index}].requiresRoute ${action.requiresRoute} is not a source route at either compared revision.`,
      nextAction: "Use a route id, route, logical path, or link path from the source plan and rerun Explore." });
    return present.has(action.requiresRoute);
  });
}

/** Source-plan capture. App state is observed as it runs; optional agents cannot change the inventory. */
export async function runCiMap(input: Omit<CiMapOptions, "platform"> & { platform?: Platform }): Promise<CiMapResult> {
  const options: CiMapOptions = { ...input, platform: input.platform ?? "ios" };
  let stage = "preflight";
  try { return await executeCiMap(options, value => { stage = value; }); }
  catch (error) {
    throw toCiError(error, { code: `CAPTURE_${stage.toUpperCase().replace(/-/g, "_")}_FAILED`, stage,
      nextAction: stage === "cleanup" ? "Stop the exact session identified in the session handoff, then retry."
        : "Inspect the capture diagnostic, correct the failing prerequisite, and rerun Explore." });
  }
}

async function executeCiMap(options: CiMapOptions, setStage: (stage: string) => void): Promise<CiMapResult> {
  if (!options.confirmExternalRun || !options.confirmTrustedSource) throw new Error("EAS capture requires authorized external execution of the selected source commit.");
  positiveInteger(options.maxScreens, "maxScreens");
  positiveInteger(options.maxActions, "maxActions");
  positiveInteger(options.maxDurationMinutes, "maxDurationMinutes");
  if (!/^[a-f0-9]{40}$/.test(options.gitCommit)) throw new Error("gitCommit must be a full source commit SHA");
  for (const key of ["device", "bundleId", "easProfile", "name", "buildId", "buildVersion"] as const) nonEmpty(options[key], key);
  const project = await realpath(resolve(options.project));
  if (!(await lstat(project)).isDirectory()) throw new Error("project must be a directory");
  const mapDirectory = await temporaryCaptureDirectory(project, options.mapDirectory, "mapDirectory");
  const outputDirectory = await temporaryCaptureDirectory(project, options.outputDirectory, "outputDirectory");
  // Launch observation is opt-in for direct callers; the CLI config enables it by default.
  const launchSetting = options.launch ?? "off";
  if (isWithin(mapDirectory, outputDirectory) || isWithin(outputDirectory, mapDirectory)) throw new Error("Capture directories must not overlap");
  if (await lstatIfExists(mapDirectory) || await lstatIfExists(outputDirectory)) throw new Error("Capture directories must not already exist");
  const plan = validateCapturePlan(await readContractJson(absoluteContractFile(options.planPath, "planPath"), "source plan", true));
  const side = options.side ?? (options.gitCommit === plan.headSha ? "head" : options.gitCommit === plan.baseSha ? "base" : undefined);
  if (!side || plan[`${side}Sha`] !== options.gitCommit) throw new Error("Capture commit does not match the selected plan side");
  const selectedIds = plan[`${side}CaptureSurfaceIds`];
  if (selectedIds.length && !options.useLocalEasSession) nonEmpty(options.expoToken, "expoToken");
  const selected = new Set(selectedIds);
  const inventory = plan.surfaces.flatMap(row => {
    const route = row[`${side}Surface`];
    return route ? [route] : [];
  });
  const routes = inventory.filter(route => selected.has(route.id));
  const setup = revisionSetup(options.setup ?? [], plan, side);
  const runner = options.runner ?? defaultRunner;
  const sourceEnvironment = options.environment ?? process.env;
  const controller = options.controller ?? "agent-device";
  const local = options.simulator === "local";
  const restrictedEnvironment = baseEnvironment(sourceEnvironment);
  const easEnvironment = { ...restrictedEnvironment, ...(options.expoToken ? { EXPO_TOKEN: options.expoToken } : {}) };
  const assertCheckout = () => {
    const call = (args: string[]) => runner({ command: "git", args, cwd: project, environment: restrictedEnvironment, timeoutMs: 30_000 }).stdout.trim();
    if (call(["rev-parse", "HEAD"]) !== options.gitCommit || call(["status", "--porcelain", "--untracked-files=normal"])) {
      throw new CiError({ code: "SOURCE_CHECKOUT_CHANGED", stage: "source", message: "The application checkout differs from its recorded commit.",
        nextAction: "Use a clean checkout at the exact plan commit. Capture output must stay outside the application." });
    }
  };
  assertCheckout();
  const outcomes: NonNullable<CaptureBundle["outcomes"]> = {};
  let scheme = appScheme(options.scheme);
  let colorSchemes: ColorScheme[] = ["light"];
  let runtime: ActiveSimulatorRuntime | undefined;
  let easBuildId: string | null = null;
  let nativeEasBuildId: string | null = null;
  let projectId: string | null = null;
  let fingerprint: string | null = null;
  let reusedEasBuild = false;
  let app: CiMapResult["app"] = { name: options.name };
  let appIcon: Buffer | undefined;
  let sessionId: string | undefined;
  const store = new ExploreStore(mapDirectory);
  let map = newCaptureMap(options);
  const cachedImages: CaptureBundle["images"] = {};
  // Launch evidence waits in a work directory until the export directory exists.
  const launch: Record<string, { root: string; record: BundleLaunchCapture }> = {};
  const launchWorkDirectory = await mkdtemp(join(tmpdir(), "expo-explore-launch-"));
  const acceptedFrames: Record<string, AgentAcceptedFrame> = {};
  if (options.reuseDirectory) {
    const cacheRoot = await realpath(options.reuseDirectory);
    const cachedBundle = await readContractJson(join(cacheRoot, "bundle.json"), "cached bundle", false) as CaptureBundle;
    if (cachedBundle.contract !== "explore.bundle" || cachedBundle.gitCommit !== options.gitCommit
      || (options.platform === "ios" && cachedBundle.runtimeProfile?.deviceModel !== options.device)) throw new Error("Restored capture evidence does not match the source and device");
    const cachedStore = new ExploreStore(cacheRoot);
    if (launchSetting !== "off") for (const [scheme, record] of Object.entries(cachedBundle.launch ?? {})) launch[scheme] = { root: cacheRoot, record };
    const cachedMap = await cachedStore.read();
    const problems = await validateMap(cachedMap, cachedStore);
    if (problems.length) throw new Error(`Restored capture map is invalid: ${problems.join("; ")}`);
    if (cachedMap.run.build.gitCommit !== options.gitCommit) throw new Error("Restored map belongs to a different commit");
    let eligible = true;
    if (options.agent) {
      try { assertAgentAcceptance(cachedBundle, cachedMap, { required: true }); }
      catch { eligible = false; }
    }
    // Secondary-appearance frames (`<route>@<scheme>`) share the route's outcome; only the primary frame carries its hash.
    const cachedIds = eligible ? Object.keys(cachedBundle.images).filter(id => selectedIds.includes(routeIdOfScreen(id).routeId)) : [];
    for (const id of cachedIds) {
      const frame = cachedBundle.images[id];
      const { routeId, scheme: cachedScheme } = routeIdOfScreen(id);
      const outcome = cachedBundle.outcomes[routeId];
      if (!frame || outcome?.status !== "captured" || outcome.landing !== "verified"
        || (!cachedScheme && outcome.screenshotSha256 !== frame.sha256)) continue;
      if (options.agent) {
        const cachedContext = cachedBundle.captureContexts?.[id];
        const expectedContext = options.agent.contexts[id];
        // Captured pixels alone cannot establish which account/data/review state produced them.
        if (!cachedContext || typeof cachedContext.description !== "string" || !Array.isArray(cachedContext.requiredLabels)
          || !cachedContext.requiredLabels.length || !isRecord(cachedContext.parameters)
          || expectedContext && JSON.stringify(expectedContext) !== JSON.stringify(cachedContext)) continue;
        options.agent.contexts[id] = structuredClone(cachedContext);
        acceptedFrames[id] = structuredClone(cachedBundle.agentAcceptance!.frames[id]!);
      }
      const observation = cachedMap.observations.find(value => value.screenId === id
        && cachedMap.artifacts.some(artifact => artifact.id === value.screenshotArtifactId && artifact.path === frame.path && artifact.sha256 === frame.sha256));
      if (!observation || frame.sourceCommit !== options.gitCommit) throw new Error("Restored frame has no matching source-bound observation");
      cachedImages[id] = frame;
      if (!cachedScheme) outcomes[routeId] = { ...outcome, screenshotSha256: frame.sha256 };
    }
    if (Object.keys(cachedImages).length) {
      // Restore only the exact verified observations. A partial cache can also
      // contain failed/unverified frames that must disappear before recapture.
      const observations = Object.entries(cachedImages).map(([id, frame]) => cachedMap.observations.find(value => value.screenId === id
        && cachedMap.artifacts.some(artifact => artifact.id === value.screenshotArtifactId && artifact.path === frame.path && artifact.sha256 === frame.sha256))!);
      const observationIds = new Set(observations.map(value => value.id));
      const variantIds = new Set(observations.map(value => value.variantId));
      const elementIds = new Set(observations.flatMap(value => value.elementIds));
      const artifactIds = new Set(observations.flatMap(value => [value.screenshotArtifactId, value.accessibilityArtifactId]));
      map = newCaptureMap(options);
      map.observations = observations;
      map.artifacts = cachedMap.artifacts.filter(value => artifactIds.has(value.id));
      map.variants = cachedMap.variants.filter(value => variantIds.has(value.id)).map(value => ({
        ...value, observationIds: value.observationIds.filter(id => observationIds.has(id)),
      }));
      map.elements = cachedMap.elements.filter(value => elementIds.has(value.id)).map(value => {
        const retained = value.observationIds.filter(id => observationIds.has(id));
        return { ...value, observationIds: retained, firstSeenObservationId: retained[0]!, lastSeenObservationId: retained.at(-1)! };
      });
      map.screens = cachedMap.screens.filter(value => cachedImages[value.id]).map(value => ({
        ...value, observationIds: value.observationIds.filter(id => observationIds.has(id)),
        variantIds: value.variantIds.filter(id => variantIds.has(id)), elementIds: value.elementIds.filter(id => elementIds.has(id)), visits: 1,
      }));
      if (!map.screens.some(screen => screen.start)) map.screens[0]!.start = true;
      for (const artifact of map.artifacts) {
        const source = resolve(cacheRoot, artifact.path);
        if (!isWithin(cacheRoot, source) || source === cacheRoot) throw new Error("Restored artifact path escapes its cache");
        await assertNoSymlinkAncestors(cacheRoot, source, "restored artifact");
        const target = resolve(mapDirectory, artifact.path);
        if (!isWithin(mapDirectory, target) || target === mapDirectory) throw new Error("Restored artifact path escapes the map");
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      // The restored frames include every `<route>@<scheme>` the baseline captured, so the exported bundle must list
      // the same schemes: a fully reused light+dark baseline otherwise exports its dark frames as unexpected targets.
      colorSchemes = bundleColorSchemes(cachedBundle);
      const cachedDeviceId = cachedMap.run.deviceId;
      map.run = { ...newCaptureMap(options).run, environment: cachedMap.run.environment,
        ...(cachedDeviceId ? { deviceId: cachedDeviceId } : {}) };
      map.revision = 0;
      map.frontier = [];
      await store.initialize(map, false);
      easBuildId = cachedBundle.easBuildId;
      projectId = cachedBundle.easProjectId;
      app = { name: cachedBundle.appName ?? options.name };
      appIcon = await loadCachedAppIcon(cacheRoot, cachedBundle.appIcon);
      const cachedProfile = cachedBundle.runtimeProfile!;
      runtime = { provider: local ? "local-simulator" : "eas-simulator", controller, controllerPackageVersion: controllerVersion(controller),
        easCliVersion: EAS_CLI_VERSION, platform: options.platform, controllerDeviceId: cachedDeviceId ?? "cached",
        deviceModel: cachedProfile.deviceModel, osVersion: cachedProfile.osVersion, locale: cachedProfile.locale,
        orientation: cachedProfile.orientation === "landscape" ? "landscape" : "portrait",
        colorScheme: cachedProfile.colorScheme === "light" ? "light" : cachedProfile.colorScheme === "dark" ? "dark" : "system" };
    }
  }
  const missingRoutes = routes.filter(route => !cachedImages[route.id]);
  const say: Progress = message => (options.progress ?? silentProgress)(`${side} ${options.gitCommit.slice(0, 8)}: ${message}`);
  say(`${routes.length} ${routes.length === 1 ? "route" : "routes"} selected`
    + (routes.length - missingRoutes.length ? `, ${routes.length - missingRoutes.length} reused from the baseline` : "")
    + (missingRoutes.length ? `, ${missingRoutes.length} to capture` : ""));
  let captureFailure: unknown;
  const finish = async (): Promise<CiMapResult> => {
    if (!(await store.exists())) await store.initialize(map, false);
    const incomplete = captureFailure !== undefined || selectedIds.some(id => outcomes[id]?.status !== "captured" || outcomes[id]?.landing !== "verified")
      || map.gaps.some(gap => gap.status === "open");
    map.run.status = incomplete || map.screens.length === 0 ? "partial" : "complete";
    if (routes.length === 0) map.run.stopReason = "No source targets require capture.";
    else if (captureFailure) map.run.stopReason = "Agent exploration did not finish; see capture diagnostics and bundle outcomes.";
    else if (incomplete) map.run.stopReason = "Some source targets could not be captured; see bundle outcomes.";
    map.run.completedAt = new Date((options.now ?? Date.now)()).toISOString();
    await store.write(map);
    const errors = await validateMap(map, store);
    if (errors.length) throw new Error(`Captured map failed validation: ${errors.join("; ")}`);
    await store.exportTo(outputDirectory, map);
    for (const name of ["setup-accessibility.json", "setup-screen.png", "agent-navigation.jsonl", "alert-inspection.jsonl", "accessibility-deferral.jsonl", "system-prompts.jsonl", "controller-retries.jsonl", "controller-recoveries.jsonl"]) {
      const source = join(mapDirectory, "capture-diagnostics", name);
      if (!(await lstatIfExists(source))) continue;
      await assertNoSymlinkAncestors(mapDirectory, source, "setup diagnostic");
      await mkdir(join(outputDirectory, "capture-diagnostics"), { recursive: true });
      await copyFile(source, join(outputDirectory, "capture-diagnostics", name));
    }
    const images: CaptureBundle["images"] = {};
    // The build a frame came from: the repacked app's EAS build, or for a repack on this machine, which is never
    // uploaded, the native EAS build it repacked. The bundle names it too, as the review's build.
    const frameBuildId = easBuildId ?? nativeEasBuildId;
    for (const observation of map.observations) {
      // A secondary-appearance screen (`<route>@<scheme>`) exports under its route's outcome, with its own frame, or
      // under its own outcome when the primary pass lost the route and this pass captured it.
      const { routeId, scheme } = routeIdOfScreen(observation.screenId);
      const owner = (scheme && outcomes[observation.screenId]) || outcomes[routeId];
      if (!selected.has(routeId) || owner?.status !== "captured") continue;
      const artifact = map.artifacts.find(value => value.id === observation.screenshotArtifactId);
      if (!artifact || (!frameBuildId && !cachedImages[observation.screenId])) continue;
      const png = await readFile(join(outputDirectory, artifact.path));
      assertDecodedPng(png, "Exported capture image");
      const expectedSha256 = scheme ? artifact.sha256 : outcomes[routeId]?.screenshotSha256;
      if (createHash("sha256").update(png).digest("hex") !== expectedSha256) throw new Error("Exported screenshot does not match the captured frame");
      images[observation.screenId] = cachedImages[observation.screenId] ?? { path: artifact.path, sha256: artifact.sha256, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        capturedAt: observation.capturedAt, sourceCommit: options.gitCommit, buildId: frameBuildId! };
    }
    const metadata: SimulatorRuntimeMetadata | null = runtime ? { provider: runtime.provider, controller: runtime.controller,
      controllerPackageVersion: runtime.controllerPackageVersion, easCliVersion: runtime.easCliVersion, platform: runtime.platform,
      deviceModel: runtime.deviceModel, osVersion: runtime.osVersion, locale: runtime.locale, orientation: runtime.orientation,
      colorScheme: runtime.colorScheme, ...(colorSchemes.length > 1 ? { colorSchemes: [...colorSchemes] } : {}), sessionLifecycle: "stopped" } : null;
    const launchRecords: NonNullable<CaptureBundle["launch"]> = {};
    for (const [scheme, { root, record }] of Object.entries(launch)) {
      if (!colorSchemes.includes(scheme as ColorScheme)) continue;
      for (const file of [record.splash, record.settled, record.filmstrip, record.video]) {
        if (!file) continue;
        const source = join(root, file.path);
        await assertNoSymlinkAncestors(root, source, "launch evidence");
        await mkdir(join(outputDirectory, dirname(file.path)), { recursive: true });
        await copyFile(source, join(outputDirectory, file.path));
        const exported = await readFile(join(outputDirectory, file.path));
        if (createHash("sha256").update(exported).digest("hex") !== file.sha256) throw new Error(`Exported launch evidence ${file.path} does not match the captured file`);
      }
      launchRecords[scheme] = record;
    }
    await rm(launchWorkDirectory, { recursive: true, force: true });
    const storedIcon = appIcon ? await storeAppIcon(outputDirectory, appIcon) : undefined;
    const bundle: CaptureBundle = { contract: "explore.bundle", side, gitCommit: options.gitCommit, easBuildId: frameBuildId, completedAt: map.run.completedAt,
      easProjectId: projectId, platform: options.platform, profile: options.easProfile, appName: app.name, ...(controller === "argent" ? { controller } : {}), ...(storedIcon ? { appIcon: storedIcon } : {}),
      selectedSurfaceIds: selectedIds,
      runtimeProfile: metadata ? { deviceModel: metadata.deviceModel, osVersion: metadata.osVersion, locale: metadata.locale,
        orientation: metadata.orientation, colorScheme: metadata.colorScheme, ...(metadata.colorSchemes ? { colorSchemes: metadata.colorSchemes.join(",") } : {}) } : null, images, outcomes, procedure: { reset: options.reset ?? "root-link", readinessSeconds: options.readinessSeconds ?? defaultReadinessSeconds(options.platform) },
      ...(Object.keys(launchRecords).length ? { launch: launchRecords } : {}),
      ...(options.agent ? { captureContexts: Object.fromEntries(selectedIds.filter(id => outcomes[id]?.status === "captured" && options.agent!.contexts[id])
        .map(id => [id, options.agent!.contexts[id]!])), agentAcceptance: { policy: AGENT_ACCEPTANCE_POLICY,
          frames: Object.fromEntries(Object.keys(images).map(id => [id, acceptedFrames[id]!])) } } : {}) };
    if (options.agent) assertAgentAcceptance(bundle, map, { required: true });
    // The side that produces the evidence checks it the way the review will: an integrity defect fails here, naming
    // its codes, instead of on the consuming side after both captures. Unavailable screens are not defects.
    assertNoCaptureHealthIssues(partitionCaptureHealthIssues(captureHealthIssues(bundle, selectedIds)).integrity);
    await writeFile(join(outputDirectory, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
    if (metadata) await writeFile(join(outputDirectory, "execution.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
    assertCheckout();
    return { buildId: options.buildId, buildFingerprint: fingerprint, nativeEasBuildId, easBuildId, reusedEasBuild,
      simulatorSessionId: sessionId ?? null, simulatorRuntime: metadata, mapDirectory, outputDirectory,
      runStatus: routes.length === 0 ? "complete" : map.run.status, app, outcomes };
  };
  if (!missingRoutes.length || !options.agent && !missingRoutes.some(hasConcreteRoutePath)) {
    for (const route of missingRoutes) outcomes[route.id] = { ...unavailableRoute(route), attempts: 0, landing: "unverified" };
    return finish();
  }
  setStage("configuration");
  say(`reading EAS build profile ${options.easProfile}`);
  const eas = (args: string[], timeoutMs = 5 * 60_000, cwd = project) => runner({ command: options.easCommand, args,
    cwd, environment: easEnvironment, timeoutMs });
  // `eas simulator:control` names the session by id, from the session's own project directory.
  const sessionEas: EasCommand = (args, commandOptions) => runner({ command: options.easCommand, args, cwd: simulatorProject, environment: easEnvironment,
    timeoutMs: commandOptions?.timeoutMs ?? 5 * 60_000, ...(commandOptions?.allowFailure ? { allowFailure: true } : {}) });
  // What the EAS session's host can do through simulator:control (iOS sessions on serve-sim 0.10.0 or later).
  let controlActions = new Set<string>();
  const configResult = eas(["config", "--platform", options.platform, "--profile", options.easProfile, "--json", "--non-interactive"]);
  const profile = repackProfileFrom(configResult.stdout);
  const configValue = parseJson(configResult.stdout, "eas config") as { appConfig: Record<string, unknown>; buildProfile: Record<string, unknown> };
  scheme ??= appScheme(configValue.appConfig.scheme);
  colorSchemes = resolveColorSchemes(options.appearance ?? "auto", configValue.appConfig, options.platform);
  // Argent cannot switch the appearance itself. On a local device the host switches it (simctl, adb); on an EAS iOS
  // session serve-sim does (appearance.set), which is known once the session starts; otherwise one appearance is captured.
  let argentSchemes = controller === "argent" && !local ? argentColorSchemes(colorSchemes, configValue.appConfig, options.platform) : undefined;
  const narrowToArgentScheme = () => {
    if (!argentSchemes) return;
    if (argentSchemes.skipped.length) say(`Argent cannot switch appearance on this session; capturing ${argentSchemes.schemes[0]} only, skipped ${argentSchemes.skipped.join(", ")}`);
    colorSchemes = argentSchemes.schemes;
    argentSchemes = undefined;
  };
  if (options.platform !== "ios") narrowToArgentScheme();
  app = { name: profile.projectIdentity.name, ...(profile.projectIdentity.version ? { version: profile.projectIdentity.version } : {}),
    ...(profile.projectIdentity.buildNumber ? { buildNumber: profile.projectIdentity.buildNumber } : {}) };
  projectId = profile.projectIdentity.projectId;
  appIcon = await loadAppIcon(project, configValue.appConfig, options.platform) ?? appIcon;
  if (!scheme && !options.agent) {
    for (const route of missingRoutes) outcomes[route.id] = { ...unavailableRoute(route), attempts: 0, landing: "unverified" };
    return finish();
  }
  assertCaptureEasProfile(configValue, options.bundleId, options.platform, { side, commit: options.gitCommit });
  if (!local) assertSimulatorAvailable(eas(["simulator:availability", "--json", "--non-interactive"]).stdout);
  const simulatorProject = await realpath(await mkdtemp(join(tmpdir(), "expo-explore-session-")));
  const dotenvPath = join(simulatorProject, SIMULATOR_DOTENV_FILE_NAME);
  const statePath = options.sessionStatePath ? absoluteContractFile(options.sessionStatePath, "sessionStatePath") : undefined;
  if (statePath && await lstatIfExists(statePath)) { await rm(simulatorProject, { recursive: true, force: true }); throw new Error("sessionStatePath already exists"); }
  await writeFile(join(simulatorProject, "app.json"), JSON.stringify({ expo: { name: profile.projectIdentity.name, slug: profile.projectIdentity.slug,
    owner: profile.projectIdentity.owner, extra: { eas: { projectId } } } }), { mode: 0o600 });
  await writeFile(join(simulatorProject, "package.json"), "{}\n", { mode: 0o600 });
  // The local simulator's UDID (iOS) or emulator's adb serial (Android): what agent-device is pointed at.
  let localSimulator: string | undefined;
  let localEmulator: string | undefined;
  let localOsVersion: string | undefined;
  // Argent's tool-server on this machine, when Argent drives a local device.
  let localArgent: LocalArgentServer | undefined;
  const localDevice = () => localSimulator ?? localEmulator;
  // A local device starts booting now and finishes while the app is built and repacked; the session waits for it.
  let localEmulatorStart: Awaited<ReturnType<typeof startLocalEmulator>> | undefined;
  const localName = `Explore ${options.device} (${side} ${options.gitCommit.slice(0, 8)})`;
  // An EAS session's start, once begun (startSession): it resolves with the start command's failure, if any.
  let sessionStart: Promise<unknown> | undefined;
  const stopEarlyDevice = async () => {
    // An EAS session started beside a repack that then failed: stop the exact session its handoff names.
    if (sessionStart) {
      await sessionStart;
      const handoff = await readSimulatorDotenvHandoff(dotenvPath).catch(() => undefined);
      if (handoff?.sessionId) assertSimulatorStopped(eas(["simulator:stop", "--id", handoff.sessionId, "--json", "--non-interactive"], 2 * 60_000, simulatorProject).stdout, handoff.sessionId);
    }
    if (localSimulator) deleteLocalSimulator({ runner, udid: localSimulator, cwd: simulatorProject, environment: restrictedEnvironment });
    if (localEmulator) await deleteLocalEmulator({ runner, serial: localEmulator, cwd: simulatorProject, environment: restrictedEnvironment });
    if (statePath) await rm(statePath, { force: true });
    await rm(simulatorProject, { recursive: true, force: true });
    await localRecord?.close();
  };
  // What this side starts on this machine, so a later review cleans up after it if this process is stopped hard.
  const localRecord = local ? await openLocalCaptureRecord(sourceEnvironment, simulatorProject) : undefined;
  if (local) try {
    if (options.platform === "android") {
      say(`starting a local ${options.device} emulator`);
      localEmulatorStart = await startLocalEmulator({ runner, device: options.device, name: `explore-${side}-${options.gitCommit.slice(0, 8)}`, directory: simulatorProject,
        cwd: simulatorProject, environment: restrictedEnvironment,
        ...(controller === "agent-device" ? { claimed: (serial: string) => agentDeviceClaims({ runner, agentDevice: options.agentDeviceCommand, serial, cwd: simulatorProject, environment: restrictedEnvironment }) } : {}),
        // Recorded as soon as it starts, so an interrupted review stops it too.
        started: async serial => {
          localEmulator = serial;
          await localRecord?.update({ serial, avd: `explore-${side}-${options.gitCommit.slice(0, 8)}` });
          if (statePath) await writeFile(statePath, `${LOCAL_EMULATOR_STATE_PREFIX}${serial}\n`, { flag: "wx", mode: 0o600 });
        } });
    } else {
      say(`starting a local ${options.device} simulator`);
      const created = await createLocalSimulator({ runner, device: options.device, name: localName, cwd: simulatorProject, environment: restrictedEnvironment,
        // Recorded before it boots, so an interrupted review deletes it too.
        created: async udid => {
          localSimulator = udid;
          await localRecord?.update({ udid });
          if (statePath) await writeFile(statePath, `${LOCAL_SIMULATOR_STATE_PREFIX}${udid}\n`, { flag: "wx", mode: 0o600 });
        } });
      localOsVersion = created.osVersion;
    }
  } catch (error) { await stopEarlyDevice().catch(() => undefined); throw error; }
  // The session is named before its app exists: an EAS session starts while the app is repacked (startSession).
  // A session EAS failed to start is replaced once (see the session block), under a name of its own.
  const sessionNameFor = (retry: number) => simulatorSessionName({ mapName: options.name, mapId: options.buildId, gitCommit: options.gitCommit, easBuildId: local ? "local" : "installed",
    runIdentity: JSON.stringify({ mapDirectory, outputDirectory, run: sourceEnvironment.GITHUB_RUN_ID, attempt: sourceEnvironment.GITHUB_RUN_ATTEMPT, ...(retry ? { sessionRetry: retry } : {}) }) });
  let sessionRetries = 0;
  let sessionName = sessionNameFor(0);
  /**
   * Starts the EAS Simulator session in the background, empty, once the build to repack is known (not while a native
   * build runs, which can take most of an hour of session time). The app is installed through the controller when both
   * are ready. Resolves with the start command's failure, if any; the session block verifies what EAS handed over.
   */
  const startSession = (retry?: { timeoutMs: number }) => {
    if (local || sessionStart) return;
    if (!retry) say(`starting an EAS Simulator session (${options.device}) while the app is repacked`);
    const request = (minutes: number) => ({ command: options.easCommand, args: ["simulator:start", "--name", sessionName, "--platform", options.platform, "--device", options.device,
      "--type", controller, "--package-version", controllerVersion(controller), "--public-link",
      "--max-duration-minutes", String(minutes), "--out-config-type", "dotenv", "--non-interactive"], cwd: simulatorProject, environment: easEnvironment,
      timeoutMs: retry?.timeoutMs ?? SESSION_START_TIMEOUT_MS });
    // An injected runner (tests) answers synchronously; a real start runs beside the repack.
    const start = async (minutes: number) => options.runner ? options.runner(request(minutes)) : runAgentControllerCommand(request(minutes), options.signal ?? new AbortController().signal);
    sessionStart = writeFile(dotenvPath, SIMULATOR_DOTENV_HEADER, { flag: "wx", mode: 0o600 })
      .then(() => start(options.maxDurationMinutes + SESSION_PREPARATION_MINUTES).catch(async (error: unknown) => {
        // A plan that cannot give the allowance gets as much of it as the plan allows, and never less than the capture's own minutes.
        const limit = sessionDurationLimit(error);
        if (limit === undefined) throw error;
        say(`EAS allows ${limit}-minute sessions on this plan; starting the session again without the full repack allowance`);
        return start(Math.max(options.maxDurationMinutes, limit));
      }))
      .then(() => undefined, (error: unknown) => error);
  };
  setStage("build");
  // The instrumented app stays on this machine: a local device installs it, and an EAS session gets it through the
  // controller. It goes in this capture's own directory, or in the review's shared build folder when other targets use it.
  const appName = options.platform === "android" ? "app.apk" : "app.app";
  const appDirectory = !options.buildShare ? await realpath(await mkdtemp(join(tmpdir(), "expo-explore-app-"))) : undefined;
  let localApp: string | undefined;
  type BuiltApp = { fingerprint: string; nativeEasBuildId: string | null; easBuildId: string | null; app?: string; reused: boolean; version?: string; buildNumber?: string };
  const buildApp = async (keepApp: string): Promise<BuiltApp> => {
    options.signal?.throwIfAborted();
    say("computing the native fingerprint");
    const fingerprintResult = eas(["fingerprint:generate", "--platform", options.platform, "--build-profile", options.easProfile, "--json", "--non-interactive"]);
    const sourceFingerprint = fingerprintFrom(fingerprintResult.stdout);
    const reusable = options.forceFreshBuild || hasEasEnvironmentFetchFailure(configResult.stderr) || hasEasEnvironmentFetchFailure(fingerprintResult.stderr)
      ? undefined : existingBuild(eas(["build:list", "--platform", options.platform, "--status", "finished", "--build-profile", options.easProfile,
        "--fingerprint-hash", sourceFingerprint, ...(options.platform === "ios" ? ["--simulator"] : []), "--limit", "1", "--json", "--non-interactive"]).stdout);
    if (reusable) {
      say(`reusing EAS build ${reusable.id} (fingerprint ${sourceFingerprint.slice(0, 12)}); repacking it with this commit's JavaScript and the route observer`);
      startSession();
      const repacked = await prepareExactSourceBuild({ platform: options.platform, runner, easCommand: options.easCommand, repackCommand: options.repackCommand,
        project, nativeBuildId: reusable.id, fingerprint: sourceFingerprint, repackProfile: profile, easEnvironment, repackEnvironment: restrictedEnvironment, routes: inventory, repack: options.repack, easProfile: options.easProfile, keepApp });
      if (!repacked) throw new CiError({ code: "CAPTURE_OBSERVER_BUILD_UNSUPPORTED", stage: "instrumentation",
        message: "The build environment cannot be reproduced for automatic capture instrumentation.",
        nextAction: "Use a simulator build profile whose required bundle environment can be pulled for local repacking; an uninstrumented build cannot verify captures." });
      return { fingerprint: sourceFingerprint, nativeEasBuildId: reusable.id, easBuildId: repacked.buildId, ...(repacked.app ? { app: repacked.app } : {}), reused: true,
        ...(reusable.appVersion ? { version: reusable.appVersion } : {}), ...(reusable.appBuildVersion ? { buildNumber: reusable.appBuildVersion } : {}) };
    }
    options.signal?.throwIfAborted();
    say(options.forceFreshBuild ? "building on EAS (a fresh build was requested); waiting for it to finish"
      : `no finished simulator build has fingerprint ${sourceFingerprint.slice(0, 12)}; building on EAS and waiting for it to finish`);
    const built = nativeBuildFrom(eas(["build", "--platform", options.platform, "--profile", options.easProfile, "--wait", "--json", "--non-interactive"], 45 * 60_000).stdout);
    say(`EAS build ${built.id} finished; repacking it with the route observer`);
    startSession();
    const repacked = await prepareExactSourceBuild({ platform: options.platform, runner, easCommand: options.easCommand, repackCommand: options.repackCommand,
      project, nativeBuildId: built.id, fingerprint: built.fingerprint, repackProfile: profile, easEnvironment, repackEnvironment: restrictedEnvironment, routes: inventory, repack: options.repack, easProfile: options.easProfile, keepApp });
    if (!repacked) throw new CiError({ code: "CAPTURE_OBSERVER_BUILD_UNSUPPORTED", stage: "instrumentation",
      message: "The fresh native build cannot be instrumented with the required route observer.",
      nextAction: "Use a simulator profile with a reproducible bundle environment so both revisions can be repacked with the same observer." });
    return { fingerprint: built.fingerprint, nativeEasBuildId: built.id, easBuildId: repacked.buildId, ...(repacked.app ? { app: repacked.app } : {}), reused: false,
      ...(built.appVersion ? { version: built.appVersion } : {}), ...(built.appBuildVersion ? { buildNumber: built.appBuildVersion } : {}) };
  };
  try {
    // Historical frames do not replace the fresh build needed for missing targets.
    easBuildId = null;
    const built = options.buildShare
      ? await sharedBuild({ directory: options.buildShare, appName, ...(options.signal ? { signal: options.signal } : {}), build: buildApp, owner: options.outputDirectory,
        key: { platform: options.platform, easProfile: options.easProfile, bundleId: options.bundleId, gitCommit: options.gitCommit, repack: options.repack ?? "eas", local,
          routes: inventory.map(route => route.id) },
        waiting: () => say("using the build another target of this review is preparing for this commit") })
      : await buildApp(join(appDirectory!, appName));
    // A capture that used another target's build starts its session now.
    startSession();
    fingerprint = built.fingerprint; nativeEasBuildId = built.nativeEasBuildId; easBuildId = built.easBuildId; localApp = built.app; reusedEasBuild = built.reused;
    if (!app.version && built.version) app.version = built.version;
    if (!app.buildNumber && built.buildNumber) app.buildNumber = built.buildNumber;
    options.signal?.throwIfAborted();
  } catch (error) {
    // A build or repack that fails leaves nothing running: a device started for it goes, with the session's files and the app.
    await stopEarlyDevice().catch(() => undefined);
    if (appDirectory) await rm(appDirectory, { recursive: true, force: true });
    throw error;
  }
  let primaryError: unknown;
  let runtimeStage = "session";
  try {
    setStage(runtimeStage);
    let connection: SimulatorConnection | undefined;
    if (localApp && localEmulator && localEmulatorStart) {
      await assertLocalEmulatorCompatible(localApp, hostEmulatorAbi());
      localOsVersion = waitForLocalEmulator({ runner, serial: localEmulator, device: options.device, apiLevel: localEmulatorStart.apiLevel, directory: simulatorProject,
        cwd: simulatorProject, environment: restrictedEnvironment, ...(options.now ? { now: options.now } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
      say(`installing the app on ${localEmulator}`);
      installOnLocalEmulator({ runner, serial: localEmulator, apk: localApp, cwd: simulatorProject, environment: restrictedEnvironment });
    } else if (localApp && localSimulator) {
      waitForLocalSimulator({ runner, udid: localSimulator, cwd: simulatorProject, environment: restrictedEnvironment });
      if (scheme) approveLinkScheme({ runner, udid: localSimulator, scheme, bundleId: options.bundleId, cwd: simulatorProject, environment: restrictedEnvironment });
      say(`installing the app on ${localName}`);
      installOnLocalSimulator({ runner, udid: localSimulator, app: localApp, cwd: simulatorProject, environment: restrictedEnvironment });
    } else if (local) {
      throw new Error("The local device did not start before capture");
    } else {
      if (!localApp || !sessionStart) throw new Error("An EAS Simulator session needs the instrumented app on this machine");
      let startError = await sessionStart;
      let handoff = await readSimulatorDotenvHandoff(dotenvPath);
      // EAS sometimes fails to start a session: it errors while booting, or the start request fails before a session is
      // named. After every failed start, whatever it may have left running is accounted for; then, when the failure is
      // provably EAS's, a new session replaces it, up to SESSION_START_RETRIES times within SESSION_RETRY_BUDGET_MS, with
      // a growing wait. A session Explore cannot prove is its own is never replaced or stopped: that stays a handoff
      // failure below, as does a lookup that fails.
      const clock = options.now ?? Date.now;
      const endedSessions: string[] = [];
      let ended: { sessionId: string; status: string } | undefined;
      let retryDeadline: number | undefined;
      for (;;) {
        const easRead = (args: string[]) => {
          try { return runner({ command: options.easCommand, args, cwd: project, environment: easEnvironment, timeoutMs: 2 * 60_000, allowFailure: true }).stdout; }
          catch { return ""; }
        };
        let reason: string | undefined;
        ended = undefined;
        if (handoff.sessionId) {
          const status = endedOwnSimulatorSession(easRead(["simulator:get", "--id", handoff.sessionId, "--json", "--non-interactive"]),
            { sessionId: handoff.sessionId, sessionName, project: profile.projectIdentity, type: controller, platform: options.platform });
          if (status) {
            ended = { sessionId: handoff.sessionId, status };
            endedSessions.push(handoff.sessionId);
            reason = `EAS ended simulator session ${handoff.sessionId} (${status}) before it was ready`;
          }
        } else if (startError && transientSessionStartFailure(startError)) {
          // The failed request may still have created a session: any by this exact name is stopped, so none is left running.
          const live = liveSimulatorSessionsNamed(easRead(["simulator:list", "--name", sessionName, "--status", "new", "--status", "queued", "--status", "starting",
            "--status", "in-progress", "--limit", "100", "--json", "--non-interactive"]), sessionName, profile.projectIdentity);
          if (live) {
            for (const id of live) assertSimulatorStopped(eas(["simulator:stop", "--id", id, "--json", "--non-interactive"], 2 * 60_000).stdout, id);
            reason = `EAS could not start the simulator session (${simulatorStartFailure(startError, [options.expoToken]).message})`;
          }
        }
        if (!reason || sessionRetries >= SESSION_START_RETRIES) break;
        retryDeadline ??= clock() + SESSION_RETRY_BUDGET_MS;
        const delayMs = sessionRetryDelayMs(sessionRetries + 1);
        // A new start needs at least a minute of the budget after its wait; one started later could not finish in it.
        const startTimeoutMs = Math.min(SESSION_START_TIMEOUT_MS, retryDeadline - clock() - delayMs);
        if (startTimeoutMs < 60_000) break;
        sessionRetries += 1;
        say(`${reason}; starting a new EAS Simulator session in ${Math.round(delayMs / 1000)} s (${sessionRetries}/${SESSION_START_RETRIES})`);
        options.signal?.throwIfAborted();
        // Asynchronous and cancellable, so targets capturing beside this one keep running and Ctrl+C stops the wait.
        if (options.sleep) options.sleep(delayMs);
        else await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { options.signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
          const abort = () => { clearTimeout(timer); reject(options.signal!.reason); };
          options.signal?.addEventListener("abort", abort, { once: true });
        });
        options.signal?.throwIfAborted();
        await rm(dotenvPath, { force: true });
        sessionName = sessionNameFor(sessionRetries);
        sessionStart = undefined;
        startSession({ timeoutMs: startTimeoutMs });
        startError = await sessionStart;
        handoff = await readSimulatorDotenvHandoff(dotenvPath);
      }
      // Every session EAS ended is its own failure to start, never a question of ownership.
      if (ended) throw new CiError({ code: "SIMULATOR_START_FAILED", stage: "session",
        message: `EAS could not start a simulator session: ${endedSessions.length === 1 ? `session ${ended.sessionId} ended (${ended.status}) before it was ready`
          : `${endedSessions.length} sessions ended before they were ready (the last, ${ended.sessionId}, ${ended.status})`}.`,
        nextAction: "Rerun Explore. If sessions keep failing to start, check the EAS Simulator status and the sessions' logs on expo.dev.",
        retryable: true, details: { attempts: sessionRetries + 1, endedSessions, ...(startError ? { startFailure: simulatorStartFailure(startError, [options.expoToken]) } : {}) },
        ...(startError ? { cause: startError } : {}) });
      const startSecrets = [options.expoToken, ...(handoff.connection ? [handoff.connection.daemonAuthToken] : [])];
      const startFailure = startError ? simulatorStartFailure(startError, startSecrets) : undefined;
      if (handoff.sessionId) {
        try { assertSimulatorSessionIdentity(eas(["simulator:get", "--id", handoff.sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout,
          handoff.sessionId, sessionName, profile.projectIdentity, handoff.connection, options.platform); }
        catch (error) { throw new CiError({ code: "SESSION_HANDOFF_UNVERIFIED", stage: "session",
          message: "The EAS handoff could not prove ownership of the exact simulator session. The private handoff was preserved.",
          nextAction: "Inspect the EAS session logs and preserved handoff; confirm ownership before cleaning up the reported session.",
          details: { handoffDirectory: simulatorProject, reportedSessionId: handoff.sessionId,
            ...(startFailure ? { startFailure } : {}), verificationFailure: simulatorStartFailure(error, startSecrets) }, cause: error }); }
        sessionId = handoff.sessionId;
        if (statePath) await writeFile(statePath, `${sessionId}\n`, { flag: "wx", mode: 0o600 });
      }
      if (!sessionId) throw new CiError({ code: startFailure ? "SIMULATOR_START_FAILED" : "SESSION_HANDOFF_UNVERIFIED", stage: "session",
        message: startFailure ? `EAS simulator:start failed before a session identity could be verified: ${startFailure.message}`
          : "EAS did not provide an exact verifiable simulator session. The private handoff was preserved.",
        nextAction: "Inspect the recorded start failure and EAS session list. Allocation status is unknown; verify a session's exact ID and ownership before cleanup.",
        details: { handoffDirectory: simulatorProject, command: "eas simulator:start", startCommandStatus: startFailure ? "failed" : "completed", allocation: "unknown",
          ...(startFailure ? { startFailure } : {}),
          ...(handoff.validationError ? { handoffFailure: simulatorStartFailure(handoff.validationError, startSecrets) } : {}) },
        cause: startError ?? handoff.validationError });
      if (startFailure) throw new CiError({ code: "SIMULATOR_START_FAILED", stage: "session",
        message: `EAS simulator:start failed after the session identity was verified: ${startFailure.message}`,
        nextAction: "Inspect the recorded start failure; Explore will stop the exact verified session before returning this error.",
        details: { reportedSessionId: sessionId, command: "eas simulator:start", startCommandStatus: "failed", allocation: "verified", startFailure }, cause: startError });
      if (handoff.validationError) throw handoff.validationError;
      if (!handoff.connection) throw new Error("Simulator handoff is missing its controller connection");
      connection = handoff.connection;
      await rm(dotenvPath, { force: true });
      if (options.platform === "ios") controlActions = simulatorControlActions(sessionEas, sessionId);
      if (!controlActions.has("appearance.set")) narrowToArgentScheme();
    }
    const controllerConfig = join(simulatorProject, "agent-device.json");
    await writeFile(controllerConfig, "{}\n", { flag: "wx", mode: 0o400 });
    if (local && controller === "argent") {
      // Argent drives a local device through a tool-server of this capture's own, pointed at that device.
      const cli = await ensureArgentToolServer({ environment: sourceEnvironment, progress: say });
      localArgent = await startLocalArgentServer({ runner, cli, directory: simulatorProject, cwd: simulatorProject, environment: restrictedEnvironment,
        ...(options.now ? { now: options.now } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
      await localRecord?.update({ argent: { pid: localArgent.pid, cli: localArgent.cli, home: localArgent.home } });
      connection = { sessionId: `local-${localDevice()}`, daemonBaseUrl: localArgent.url, daemonAuthToken: localArgent.token, controller: "argent" };
    }
    const argent = controller === "argent" && connection
      ? await argentControllerInvocation({ directory: simulatorProject, connection, platform: options.platform, environment: restrictedEnvironment, sourceEnvironment, bundleId: options.bundleId,
        ...(localDevice() ? { device: localDevice()! } : {}), ...(options.devicePose ? { pose: options.devicePose } : {}) })
      : undefined;
    const controllerEnvironment = argent?.environment ?? { ...restrictedEnvironment, AGENT_DEVICE_CONFIG: controllerConfig,
      // Locally, agent-device runs its own daemon, one per capture, so head and base do not share sessions.
      ...(connection ? { AGENT_DEVICE_DAEMON_BASE_URL: connection.daemonBaseUrl, AGENT_DEVICE_DAEMON_AUTH_TOKEN: connection.daemonAuthToken }
        : { AGENT_DEVICE_STATE_DIR: join(simulatorProject, "agent-device-state") }),
      AGENT_DEVICE_SESSION: CONTROLLER_SESSION, AGENT_DEVICE_SESSION_LOCK: "reject", AGENT_DEVICE_PLATFORM: options.platform };
    // Every controller call below goes to the session's controller; for Argent that is the bridge.
    const controllerCommand = argent?.command ?? options.agentDeviceCommand;
    if (!local && localApp) {
      // The session started empty while the app was repacked; the controller installs it now.
      say(`installing the app on session ${sessionId}`);
      runner({ command: controllerCommand, args: ["install", localApp, "--session", CONTROLLER_SESSION, ...deviceArgs({ platform: options.platform, deviceModel: options.device }),
        "--platform", options.platform, "--json"], cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 15 * 60_000 });
      // Before any link opens, as a local capture does with simctl: the app's own links then open without the prompt.
      if (sessionId && scheme) {
        const approved = approveSessionUrlSchemes(sessionEas, sessionId, controlActions, options.bundleId, [scheme]);
        if (approved.length) say(`approved ${approved.map(item => `${item}://`).join(", ")} links on session ${sessionId}`);
      }
    }
    if (options.devicePose) {
      // A fold relights the other panel and resizes the window. It comes before the app is first opened or read, so the
      // controller's accessibility reader starts on the lit panel: Argent's, started on the outer panel, can stay there.
      say(`folding ${options.device} ${options.devicePose}`);
      const target = deviceArgs({ platform: options.platform, deviceModel: options.device, ...(localDevice() ? { provider: "local-simulator" as const, controllerDeviceId: localDevice()! } : {}) });
      // agent-device reads the hinge back after folding and fails to (locally and on EAS); its display is checked instead.
      const easAgentDevice = !!sessionId && controller === "agent-device";
      const fold = () => runner({ command: controllerCommand, args: ["fold", options.devicePose!, "--session", CONTROLLER_SESSION, ...target, "--platform", options.platform, "--json"],
        cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 2 * 60_000, ...(localSimulator || easAgentDevice ? { allowFailure: true } : {}) });
      const pause = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
      if (localSimulator && controller === "argent") {
        // Argent folds without a session and checks the fold against its own reader; this machine also checks the display.
        fold();
        if (!await localPoseShown({ runner, udid: localSimulator, pose: options.devicePose, directory: simulatorProject, cwd: simulatorProject, environment: restrictedEnvironment,
          ...(options.sleep ? { sleep: options.sleep } : {}) })) throw new CiError({ code: "CONTROLLER_FOLD_UNVERIFIED", stage: "session",
          message: `${options.device} did not show the ${options.devicePose} display after folding.`, nextAction: "Rerun; if it persists, check that this Xcode's simulator supports folding the device." });
      } else if (localSimulator) {
        // A local agent-device folds only inside a session, so the app opens first (its first open also builds the
        // runner). agent-device then reads the hinge back with a devicectl option Xcode 27.1 no longer has, so on this
        // machine the pose is checked by the lit display's shape instead of its answer.
        runner({ command: controllerCommand, args: ["open", options.bundleId, "--session", CONTROLLER_SESSION, ...target, "--platform", options.platform, "--json"],
          cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 15 * 60_000 });
        const folded = fold();
        if (!await localPoseShown({ runner, udid: localSimulator, pose: options.devicePose, directory: simulatorProject, cwd: simulatorProject, environment: restrictedEnvironment,
          ...(options.sleep ? { sleep: options.sleep } : {}) })) throw new CiError({ code: "CONTROLLER_FOLD_UNVERIFIED", stage: "session",
          message: `${options.device} did not show the ${options.devicePose} display after folding: ${(folded.stderr || folded.stdout).trim().split("\n").at(-1) ?? ""}`.trim(),
          nextAction: "Rerun; if it persists, check that this Xcode's simulator supports folding the device." });
      } else if (easAgentDevice && sessionId) {
        // On EAS, agent-device also folds only inside a session, so the app opens first. The first fold of a fresh session
        // can leave the panel it lights black, as it does for Argent: the controller then reads the old panel and a
        // relaunch draws nothing. The display is the check, through the controller's own screenshot: in the pose's shape
        // and drawn. If it is not, SpringBoard is restarted, the app reopened and the device folded again, once.
        const open = (relaunch: boolean) => runner({ command: controllerCommand, args: ["open", options.bundleId, ...(relaunch ? ["--relaunch"] : []), "--session", CONTROLLER_SESSION,
          ...target, "--platform", options.platform, "--json"], cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 15 * 60_000 });
        const shown = async () => {
          if (options.devicePose !== "open" && options.devicePose !== "closed") return true;
          const file = join(simulatorProject, "pose.png");
          // The display relights and resizes over a moment after the hinge moves.
          for (let attempt = 0; attempt < 10; attempt += 1) {
            if (attempt) pause(1_000);
            runner({ command: controllerCommand, args: ["screenshot", file, "--session", CONTROLLER_SESSION, ...target, "--platform", options.platform, "--json"],
              cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 2 * 60_000, allowFailure: true });
            const png = await readFile(file).catch(() => Buffer.alloc(0));
            await rm(file, { force: true });
            const size = pngSize(png);
            if (size && (options.devicePose === "open" ? size.width > size.height : size.height > size.width) && !solidColour(png)) return true;
          }
          return false;
        };
        open(false);
        fold();
        if (!await shown()) {
          if (!controlActions.has("springboard.restart")) throw new CiError({ code: "CONTROLLER_FOLD_UNVERIFIED", stage: "session",
            message: `${options.device} did not show the ${options.devicePose} display after folding.`, nextAction: "Rerun the capture on a new session." });
          say(`${options.device} did not draw the ${options.devicePose} display after the fold; restarting SpringBoard and folding ${options.devicePose} again`);
          simulatorControl(sessionEas, sessionId, "springboard.restart");
          pause(8_000);
          open(true);
          fold();
          if (!await shown()) throw new CiError({ code: "CONTROLLER_READER_STUCK", stage: "session",
            message: `${options.device} did not draw the ${options.devicePose} display after folding, nor after SpringBoard was restarted and it was folded again.`,
            nextAction: "Rerun the capture; if it keeps happening, report it to Explore with the session's link." });
        }
      } else if (controller === "argent" && sessionId && controlActions.has("springboard.restart")) {
        // The bridge has already reset Argent's device helpers once when its reader stayed on the dark panel. On EAS the
        // tool-server cannot be restarted, so the next step is SpringBoard, then the same fold and check again.
        try { fold(); }
        catch (error) {
          if (toCiError(error).code !== "CONTROLLER_FOLD_UNVERIFIED") throw error;
          say(`Argent kept reading the other panel after the fold; restarting SpringBoard and folding ${options.devicePose} again`);
          simulatorControl(sessionEas, sessionId, "springboard.restart");
          pause(8_000);
          try { fold(); }
          catch (retry) {
            if (toCiError(retry).code !== "CONTROLLER_FOLD_UNVERIFIED") throw retry;
            throw new CiError({ code: "CONTROLLER_READER_STUCK", stage: "session",
              message: `Argent's accessibility reader kept reading the panel the fold turned off, after its device helpers were reset and SpringBoard was restarted.`,
              nextAction: "Rerun the capture; if it keeps happening, report it to Explore: this session's Argent tool-server needs a restart that EAS cannot do yet.", cause: retry });
          }
        }
      } else fold();
    }
    runtimeStage = "runtime";
    setStage(runtimeStage);
    const localId = localDevice();
    const collect = () => collectRuntime({ ...options, agentDeviceCommand: controllerCommand }, controllerEnvironment, localId ? { id: localId } : undefined);
    // Argent's accessibility reader can stay on a foldable's dark outer panel after a fold and never read the app
    // (APP_NOT_READY). On this machine the capture runs that reader, so it recovers in two steps, each followed by one more
    // open: a fresh tool-server, whose reader starts on the lit panel; then, as XcodeBuildMCP#537 found for this panel,
    // SpringBoard restarted as well. The bridge's cached view of the device goes with the old server.
    // On EAS the tool-server is the session's and must never be stopped, so the recovery there resets Argent's device
    // helpers (reset-reader), then restarts SpringBoard as well, and then gives up with a reason rather than retrying.
    const easArgentRecovery = !local && controller === "argent" && !!sessionId && options.platform === "ios";
    for (let recovery = 0; ; recovery += 1) try { runtime = collect(); break; }
    catch (error) {
      if (toCiError(error).code !== "APP_NOT_READY") throw error;
      if (easArgentRecovery && sessionId) {
        if (recovery === 2 || recovery === 1 && !controlActions.has("springboard.restart")) throw new CiError({ code: "CONTROLLER_READER_STUCK", stage: "session",
          message: "Argent's accessibility reader kept reading the panel the fold turned off, after its device helpers were reset"
            + `${recovery === 2 ? " and SpringBoard was restarted" : ""}.`,
          nextAction: "Rerun the capture; if it keeps happening, report it to Explore: this session's Argent tool-server needs a restart that EAS cannot do yet.", cause: error });
        if (recovery === 1) {
          say("Argent still did not read the app; restarting SpringBoard, then resetting Argent's device helpers and opening the app again");
          simulatorControl(sessionEas, sessionId, "springboard.restart");
          // SpringBoard takes a moment to come back, and sends the app to the background; the next open brings it back.
          (options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }))(8_000);
        } else say("Argent did not read the app after starting it; resetting Argent's device helpers and opening the app again");
        runner({ command: controllerCommand, args: ["reset-reader", "--session", CONTROLLER_SESSION, "--platform", options.platform, "--json"],
          cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 2 * 60_000 });
        continue;
      }
      if (!localArgent || recovery === 2) throw error;
      say(recovery === 0 ? "Argent did not read the app after starting it; restarting Argent's tool-server and opening the app again"
        : "Argent still did not read the app; restarting SpringBoard and Argent's tool-server and opening the app again");
      stopLocalArgentServer(localArgent);
      if (recovery === 1 && localSimulator) {
        runner({ command: "xcrun", args: ["simctl", "spawn", localSimulator, "launchctl", "kickstart", "-k", "system/com.apple.SpringBoard"],
          cwd: simulatorProject, environment: restrictedEnvironment, timeoutMs: 60_000, allowFailure: true });
        // SpringBoard takes a moment to come back before an app can be opened over it.
        (options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }))(5_000);
      }
      localArgent = await startLocalArgentServer({ runner, cli: localArgent.cli, directory: simulatorProject, cwd: simulatorProject, environment: restrictedEnvironment,
        ...(options.now ? { now: options.now } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) });
      await localRecord?.update({ argent: { pid: localArgent.pid, cli: localArgent.cli, home: localArgent.home } });
      Object.assign(controllerEnvironment, { ARGENT_TOOLS_URL: localArgent.url, ARGENT_AUTH_TOKEN: localArgent.token });
      if (connection) Object.assign(connection, { daemonBaseUrl: localArgent.url, daemonAuthToken: localArgent.token });
      await rm(join(simulatorProject, "argent-state.json"), { force: true });
    }
    runtime.colorScheme = colorSchemes[0]!;
    // The version is descriptive; a capture proceeds without it and records "unknown". Argent names it with the device;
    // agent-device's is always taken from the session, as before.
    if (localOsVersion) runtime.osVersion = localOsVersion;
    else if (sessionId && (runtime.osVersion === "unknown" || controller !== "argent")) try {
      runtime.osVersion = await simulatorOsVersion(eas(["simulator:get", "--id", sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout,
        runtime.controllerDeviceId, options.fetch ?? fetch, options.platform);
    } catch (error) {
      process.stderr.write(`The EAS Simulator OS version is unavailable (${(error as Error).message}); the review records it as unknown.\n`);
    }
    if (await store.exists()) { map.run = newCaptureMap(options, runtime, fingerprint).run; await store.write(map); }
    else { map = newCaptureMap(options, runtime, fingerprint); await store.initialize(map, false); }
    if (colorSchemes.length > 1) { map.run.environment.colorSchemes = [...colorSchemes]; await store.write(map); }
    runtimeStage = "capture";
    setStage(runtimeStage);
    say(`${localSimulator ? "local simulator" : localEmulator ? "local emulator" : "simulator session"} ${localDevice() ?? sessionId} is ready (${runtime.deviceModel}, ${options.platform === "ios" ? "iOS" : "Android"} ${runtime.osVersion})`);
    // Every pass sets the appearance explicitly, so a capture does not inherit whatever the simulator last used.
    const passes: CaptureBundle["outcomes"][] = [];
    const recordingTools = launchSetting === "off" ? undefined : options.recordingTools === undefined ? ffmpegRecordingTools() : options.recordingTools ?? undefined;
    for (const [index, colorScheme] of colorSchemes.entries()) {
      // Argent cannot switch the appearance yet (software-mansion/argent#1509): the host does, simctl or adb on this
      // machine and serve-sim on an EAS iOS session; elsewhere its single pass runs as the device starts.
      if (controller !== "argent") runner({ command: controllerCommand, args: [...appearanceArgs(colorScheme), "--session", CONTROLLER_SESSION, ...deviceArgs(runtime), "--platform", options.platform],
        cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 60_000 });
      else if (sessionId && controlActions.has("appearance.set")) simulatorControl(sessionEas, sessionId, "appearance.set", [colorScheme]);
      else if (localSimulator) setLocalSimulatorAppearance({ runner, udid: localSimulator, scheme: colorScheme, cwd: simulatorProject, environment: restrictedEnvironment });
      else if (localEmulator) setLocalEmulatorAppearance({ runner, serial: localEmulator, scheme: colorScheme, cwd: simulatorProject, environment: restrictedEnvironment });
      // A scheme change recreates the Android activity in place, and the sheets it re-presents lose their inset; a
      // relaunch starts the app in the new scheme, the same way the first pass did.
      if (launchSetting !== "off") {
        // Observing the launch relaunches the app before setup runs, so no UI-created state is lost.
        say(`observing the app launch${colorSchemes.length > 1 ? ` (${colorScheme})` : ""}`);
        try {
          // A restored baseline's launch evidence is replaced only by a fresh observation.
          const record = await captureLaunch({ bundleId: options.bundleId, keepVideo: launchSetting === "video", platform: options.platform,
            directory: join(launchWorkDirectory, launchDirectory(colorScheme)), relativeDirectory: launchDirectory(colorScheme), ...(options.now ? { now: options.now } : {}),
            ...(recordingTools ? { recordingTools } : {}),
            controller: (args, controllerOptions) => runner({ command: controllerCommand, args: [...args, "--session", CONTROLLER_SESSION, ...deviceArgs(runtime!), "--platform", options.platform],
              cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: controllerOptions?.timeoutMs ?? 60_000, ...(controllerOptions?.allowFailure ? { allowFailure: true } : {}) }) });
          launch[colorScheme] = { root: launchWorkDirectory, record };
        } catch (error) {
          // The launch is supplementary evidence: a failure to observe it leaves the route capture intact.
          say(`the app launch could not be observed (${(error as Error).message}); the report has no launch evidence for ${colorScheme}`);
          await rm(join(launchWorkDirectory, launchDirectory(colorScheme)), { recursive: true, force: true });
        }
      } else if (index > 0) runner({ command: controllerCommand, args: ["open", options.bundleId, "--relaunch", "--session", CONTROLLER_SESSION,
        ...deviceArgs(runtime), "--platform", options.platform, "--level", "full", "--json"], cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 60_000 });
      runtime.colorScheme = colorScheme;
      if (colorSchemes.length > 1) say(`appearance ${colorScheme} (${index + 1}/${colorSchemes.length})`);
      passes.push(await capturePlannedRoutes({ capture: { ...options, agentDeviceCommand: controllerCommand, setup, progress: say }, routes: missingRoutes, inventory, scheme, appName: app.name, runtime,
        connection, environment: controllerEnvironment, store, map, acceptedFrames, outcomes: index === 0 ? outcomes : {},
        ...(colorSchemes.length > 1 ? { appearance: { scheme: colorScheme, primary: index === 0 } } : {}) }));
    }
    runtime.colorScheme = colorSchemes[0]!;
    Object.assign(outcomes, mergeSchemeOutcomes(passes, colorSchemes));
  } catch (error) { primaryError = toCiError(error, { code: `CAPTURE_${runtimeStage.toUpperCase()}_FAILED`, stage: runtimeStage,
    nextAction: "Inspect the capture diagnostic, correct the failing prerequisite, and rerun Explore." }); }
  finally {
    if (appDirectory) await rm(appDirectory, { recursive: true, force: true });
    if (localArgent) stopLocalArgentServer(localArgent);
    if (localEmulator) {
      try {
        setStage("cleanup");
        say(`stopping the local emulator ${localEmulator}`);
        runner({ command: options.agentDeviceCommand, args: ["close", "--session", CONTROLLER_SESSION, "--json"], cwd: simulatorProject,
          environment: { ...restrictedEnvironment, AGENT_DEVICE_STATE_DIR: join(simulatorProject, "agent-device-state") }, timeoutMs: 60_000, allowFailure: true });
        await stopLocalAgentDevice(join(simulatorProject, "agent-device-state"));
        await deleteLocalEmulator({ runner, serial: localEmulator, cwd: simulatorProject, environment: restrictedEnvironment });
        if (statePath) await rm(statePath, { force: true });
        // The AVD lives in the capture's directory, so it goes with it.
        await rm(simulatorProject, { recursive: true, force: true });
      } catch (error) { throw new CiError({ code: "SESSION_CLEANUP_FAILED", stage: "cleanup",
        message: "The local emulator Explore started could not be stopped.", nextAction: `Stop it with: adb -s ${localEmulator} emu kill`,
        details: { serial: localEmulator, ...(primaryError ? { originalFailure: serializeCiError(primaryError, { secrets: [options.expoToken] }) } : {}) }, cause: error }); }
    }
    if (localSimulator) {
      try {
        setStage("cleanup");
        say(`deleting the local simulator ${localSimulator}`);
        // Its own agent-device daemon lets go of the device before it goes.
        runner({ command: options.agentDeviceCommand, args: ["close", "--session", CONTROLLER_SESSION, "--json"], cwd: simulatorProject,
          environment: { ...restrictedEnvironment, AGENT_DEVICE_STATE_DIR: join(simulatorProject, "agent-device-state") }, timeoutMs: 60_000, allowFailure: true });
        await stopLocalAgentDevice(join(simulatorProject, "agent-device-state"));
        deleteLocalSimulator({ runner, udid: localSimulator, cwd: simulatorProject, environment: restrictedEnvironment });
        if (statePath) await rm(statePath, { force: true });
        await rm(simulatorProject, { recursive: true, force: true });
      } catch (error) { throw new CiError({ code: "SESSION_CLEANUP_FAILED", stage: "cleanup",
        message: "The local simulator Explore created could not be deleted.", nextAction: `Delete it with: xcrun simctl delete ${localSimulator}`,
        details: { udid: localSimulator, ...(primaryError ? { originalFailure: serializeCiError(primaryError, { secrets: [options.expoToken] }) } : {}) }, cause: error }); }
    }
    // Everything this side started on this machine is stopped; a cleanup that threw above leaves the record for a sweep.
    await localRecord?.close();
    if (sessionId) {
      try {
        setStage("cleanup");
        say(`stopping simulator session ${sessionId}`);
        assertSimulatorStopped(eas(["simulator:stop", "--id", sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout, sessionId);
        if (statePath) await rm(statePath, { force: true });
        await rm(simulatorProject, { recursive: true, force: true });
      } catch (error) { throw new CiError({ code: "SESSION_CLEANUP_FAILED", stage: "cleanup",
        message: "The exact EAS session could not be confirmed stopped.", nextAction: `Stop EAS Simulator session ${sessionId} and verify its status.`,
        details: { sessionId, ...(primaryError ? { originalFailure: serializeCiError(primaryError, { secrets: [options.expoToken] }) } : {}) }, cause: error }); }
    }
  }
  if (primaryError) {
    if (options.agent && runtime && runtimeStage === "capture") {
      captureFailure = primaryError;
      const error = serializeCiError(primaryError, { secrets: [options.expoToken, ...(options.agent.secretValues ?? [])] });
      for (const id of selectedIds) if (outcomes[id]?.status !== "captured") {
        outcomes[id] = { status: error.code === "CAPTURE_BUDGET_EXHAUSTED" ? "budget-exhausted" : "failed", attempts: outcomes[id]?.attempts ?? 0,
          landing: "unverified", reason: error.message, error };
      }
      try { await finish(); }
      catch (exportError) {
        const original = toCiError(primaryError);
        throw new CiError({ code: original.code, stage: original.stage, message: original.message, nextAction: original.nextAction,
          retryable: original.retryable, details: { ...original.details, partialExportError: serializeCiError(exportError, { secrets: [options.expoToken, ...(options.agent.secretValues ?? [])] }) }, cause: primaryError });
      }
    }
    throw primaryError;
  }
  setStage("export");
  const captured = selectedIds.filter(id => outcomes[id]?.status === "captured").length;
  say(`${captured} of ${selectedIds.length} ${selectedIds.length === 1 ? "route" : "routes"} captured`);
  return finish();
}
