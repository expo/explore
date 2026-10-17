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
import { defaultRunner } from "./controller.js";
import { silentProgress, type Progress } from "../shared/progress.js";
import { assertCaptureEasProfile, assertSimulatorAvailable, fingerprintFrom, hasEasEnvironmentFetchFailure, nativeBuildFrom, existingBuild, repackProfileFrom, prepareExactSourceBuild, type RepackMode } from "./eas-build.js";
import { SIMULATOR_DOTENV_FILE_NAME, SIMULATOR_DOTENV_HEADER, simulatorSessionName, simulatorStartFailure, readSimulatorDotenvHandoff, assertSimulatorSessionIdentity, assertSimulatorStopped, collectRuntime, controllerVersion, simulatorOsVersion, type ActiveSimulatorRuntime } from "./simulator.js";
import { argentControllerInvocation } from "./controller-invocation.js";
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
  /** Where the route observer is bundled into the app: a hosted EAS repack job (default) or repack-app on this machine. */
  repack?: RepackMode;
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
  provider: "eas-simulator"; controller: "agent-device" | "argent"; controllerPackageVersion: string;
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
      runtime = { provider: "eas-simulator", controller, controllerPackageVersion: controllerVersion(controller),
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
    for (const name of ["setup-accessibility.json", "setup-screen.png", "agent-navigation.jsonl", "alert-inspection.jsonl", "accessibility-deferral.jsonl", "system-prompts.jsonl", "controller-retries.jsonl"]) {
      const source = join(mapDirectory, "capture-diagnostics", name);
      if (!(await lstatIfExists(source))) continue;
      await assertNoSymlinkAncestors(mapDirectory, source, "setup diagnostic");
      await mkdir(join(outputDirectory, "capture-diagnostics"), { recursive: true });
      await copyFile(source, join(outputDirectory, "capture-diagnostics", name));
    }
    const images: CaptureBundle["images"] = {};
    for (const observation of map.observations) {
      // A secondary-appearance screen (`<route>@<scheme>`) exports under its route's outcome, with its own frame, or
      // under its own outcome when the primary pass lost the route and this pass captured it.
      const { routeId, scheme } = routeIdOfScreen(observation.screenId);
      const owner = (scheme && outcomes[observation.screenId]) || outcomes[routeId];
      if (!selected.has(routeId) || owner?.status !== "captured") continue;
      const artifact = map.artifacts.find(value => value.id === observation.screenshotArtifactId);
      if (!artifact || (!easBuildId && !cachedImages[observation.screenId])) continue;
      const png = await readFile(join(outputDirectory, artifact.path));
      assertDecodedPng(png, "Exported capture image");
      const expectedSha256 = scheme ? artifact.sha256 : outcomes[routeId]?.screenshotSha256;
      if (createHash("sha256").update(png).digest("hex") !== expectedSha256) throw new Error("Exported screenshot does not match the captured frame");
      images[observation.screenId] = cachedImages[observation.screenId] ?? { path: artifact.path, sha256: artifact.sha256, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        capturedAt: observation.capturedAt, sourceCommit: options.gitCommit, buildId: easBuildId! };
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
    const bundle: CaptureBundle = { contract: "explore.bundle", side, gitCommit: options.gitCommit, easBuildId, completedAt: map.run.completedAt,
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
  const configResult = eas(["config", "--platform", options.platform, "--profile", options.easProfile, "--json", "--non-interactive"]);
  const profile = repackProfileFrom(configResult.stdout);
  const configValue = parseJson(configResult.stdout, "eas config") as { appConfig: Record<string, unknown>; buildProfile: Record<string, unknown> };
  scheme ??= appScheme(configValue.appConfig.scheme);
  colorSchemes = resolveColorSchemes(options.appearance ?? "auto", configValue.appConfig, options.platform);
  if (controller === "argent") {
    const single = argentColorSchemes(colorSchemes, configValue.appConfig, options.platform);
    if (single.skipped.length) say(`Argent cannot switch appearance yet (software-mansion/argent#1509); capturing ${single.schemes[0]} only, skipped ${single.skipped.join(", ")}`);
    colorSchemes = single.schemes;
  }
  app = { name: profile.projectIdentity.name, ...(profile.projectIdentity.version ? { version: profile.projectIdentity.version } : {}),
    ...(profile.projectIdentity.buildNumber ? { buildNumber: profile.projectIdentity.buildNumber } : {}) };
  projectId = profile.projectIdentity.projectId;
  appIcon = await loadAppIcon(project, configValue.appConfig, options.platform) ?? appIcon;
  if (!scheme && !options.agent) {
    for (const route of missingRoutes) outcomes[route.id] = { ...unavailableRoute(route), attempts: 0, landing: "unverified" };
    return finish();
  }
  assertCaptureEasProfile(configValue, options.bundleId, options.platform, { side, commit: options.gitCommit });
  assertSimulatorAvailable(eas(["simulator:availability", "--json", "--non-interactive"]).stdout);
  setStage("build");
  // Historical frames do not replace the fresh build needed for missing targets.
  easBuildId = null;
  options.signal?.throwIfAborted();
  say("computing the native fingerprint");
  const fingerprintResult = eas(["fingerprint:generate", "--platform", options.platform, "--build-profile", options.easProfile, "--json", "--non-interactive"]);
  fingerprint = fingerprintFrom(fingerprintResult.stdout);
  const reusable = options.forceFreshBuild || hasEasEnvironmentFetchFailure(configResult.stderr) || hasEasEnvironmentFetchFailure(fingerprintResult.stderr)
    ? undefined : existingBuild(eas(["build:list", "--platform", options.platform, "--status", "finished", "--build-profile", options.easProfile,
      "--fingerprint-hash", fingerprint, ...(options.platform === "ios" ? ["--simulator"] : []), "--limit", "1", "--json", "--non-interactive"]).stdout);
  if (reusable) {
    say(`reusing EAS build ${reusable.id} (fingerprint ${fingerprint.slice(0, 12)}); repacking it with this commit's JavaScript and the route observer`);
    const repacked = await prepareExactSourceBuild({ platform: options.platform, runner, easCommand: options.easCommand, repackCommand: options.repackCommand,
      project, nativeBuildId: reusable.id, fingerprint, repackProfile: profile, easEnvironment, repackEnvironment: restrictedEnvironment, routes: inventory, repack: options.repack, easProfile: options.easProfile });
    if (!repacked) throw new CiError({ code: "CAPTURE_OBSERVER_BUILD_UNSUPPORTED", stage: "instrumentation",
      message: "The build environment cannot be reproduced for automatic capture instrumentation.",
      nextAction: "Use a simulator build profile whose required bundle environment can be pulled for local repacking; an uninstrumented build cannot verify captures." });
    if (repacked) { nativeEasBuildId = reusable.id; easBuildId = repacked; reusedEasBuild = true; }
    if (!app.version && reusable.appVersion) app.version = reusable.appVersion;
    if (!app.buildNumber && reusable.appBuildVersion) app.buildNumber = reusable.appBuildVersion;
  }
  options.signal?.throwIfAborted();
  if (!easBuildId) {
    say(options.forceFreshBuild ? "building on EAS (a fresh build was requested); waiting for it to finish"
      : `no finished simulator build has fingerprint ${fingerprint.slice(0, 12)}; building on EAS and waiting for it to finish`);
    const built = nativeBuildFrom(eas(["build", "--platform", options.platform, "--profile", options.easProfile, "--wait", "--json", "--non-interactive"], 45 * 60_000).stdout);
    nativeEasBuildId = built.id; fingerprint = built.fingerprint;
    say(`EAS build ${built.id} finished; repacking it with the route observer`);
    const repacked = await prepareExactSourceBuild({ platform: options.platform, runner, easCommand: options.easCommand, repackCommand: options.repackCommand,
      project, nativeBuildId: built.id, fingerprint, repackProfile: profile, easEnvironment, repackEnvironment: restrictedEnvironment, routes: inventory, repack: options.repack, easProfile: options.easProfile });
    if (!repacked) throw new CiError({ code: "CAPTURE_OBSERVER_BUILD_UNSUPPORTED", stage: "instrumentation",
      message: "The fresh native build cannot be instrumented with the required route observer.",
      nextAction: "Use a simulator profile with a reproducible bundle environment so both revisions can be repacked with the same observer." });
    easBuildId = repacked;
    if (!app.version && built.appVersion) app.version = built.appVersion;
    if (!app.buildNumber && built.appBuildVersion) app.buildNumber = built.appBuildVersion;
  }
  options.signal?.throwIfAborted();
  const simulatorProject = await realpath(await mkdtemp(join(tmpdir(), "expo-explore-session-")));
  const dotenvPath = join(simulatorProject, SIMULATOR_DOTENV_FILE_NAME);
  const statePath = options.sessionStatePath ? absoluteContractFile(options.sessionStatePath, "sessionStatePath") : undefined;
  if (statePath && await lstatIfExists(statePath)) { await rm(simulatorProject, { recursive: true, force: true }); throw new Error("sessionStatePath already exists"); }
  await writeFile(join(simulatorProject, "app.json"), JSON.stringify({ expo: { name: profile.projectIdentity.name, slug: profile.projectIdentity.slug,
    owner: profile.projectIdentity.owner, extra: { eas: { projectId } } } }), { mode: 0o600 });
  await writeFile(join(simulatorProject, "package.json"), "{}\n", { mode: 0o600 });
  const sessionName = simulatorSessionName({ mapName: options.name, mapId: options.buildId, gitCommit: options.gitCommit, easBuildId,
    runIdentity: JSON.stringify({ mapDirectory, outputDirectory, run: sourceEnvironment.GITHUB_RUN_ID, attempt: sourceEnvironment.GITHUB_RUN_ATTEMPT }) });
  let primaryError: unknown;
  let runtimeStage = "session";
  try {
    setStage(runtimeStage);
    say(`starting an EAS Simulator session (${options.device}) with build ${easBuildId}`);
    await writeFile(dotenvPath, SIMULATOR_DOTENV_HEADER, { flag: "wx", mode: 0o600 });
    let startError: unknown;
    try { eas(["simulator:start", "--name", sessionName, "--platform", options.platform, "--device", options.device,
      "--type", controller, "--package-version", controllerVersion(controller), "--build-id", easBuildId, "--public-link",
      "--max-duration-minutes", String(options.maxDurationMinutes), "--out-config-type", "dotenv", "--non-interactive"], 20 * 60_000, simulatorProject); }
    catch (error) { startError = error; }
    const handoff = await readSimulatorDotenvHandoff(dotenvPath);
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
    await rm(dotenvPath, { force: true });
    const controllerConfig = join(simulatorProject, "agent-device.json");
    await writeFile(controllerConfig, "{}\n", { flag: "wx", mode: 0o400 });
    const argent = controller === "argent"
      ? await argentControllerInvocation({ directory: simulatorProject, connection: handoff.connection, platform: options.platform, environment: restrictedEnvironment, sourceEnvironment, bundleId: options.bundleId })
      : undefined;
    const controllerEnvironment = argent?.environment ?? { ...restrictedEnvironment, AGENT_DEVICE_CONFIG: controllerConfig,
      AGENT_DEVICE_DAEMON_BASE_URL: handoff.connection.daemonBaseUrl, AGENT_DEVICE_DAEMON_AUTH_TOKEN: handoff.connection.daemonAuthToken,
      AGENT_DEVICE_SESSION: CONTROLLER_SESSION, AGENT_DEVICE_SESSION_LOCK: "reject", AGENT_DEVICE_PLATFORM: options.platform };
    // Every controller call below goes to the session's controller; for Argent that is the bridge.
    const controllerCommand = argent?.command ?? options.agentDeviceCommand;
    runtimeStage = "runtime";
    setStage(runtimeStage);
    runtime = collectRuntime({ ...options, agentDeviceCommand: controllerCommand }, controllerEnvironment);
    runtime.colorScheme = colorSchemes[0]!;
    // The version is descriptive; a capture proceeds without it and records "unknown". Argent names it with the device;
    // agent-device's is always taken from the session, as before.
    if (runtime.osVersion === "unknown" || controller !== "argent") try {
      runtime.osVersion = await simulatorOsVersion(eas(["simulator:get", "--id", sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout,
        runtime.controllerDeviceId, options.fetch ?? fetch, options.platform);
    } catch (error) {
      process.stderr.write(`The EAS Simulator OS version is unavailable (${(error as Error).message}); the review records it as unknown.\n`);
    }
    if (options.devicePose) {
      // A fold relights the other panel and resizes the window, so it happens before any snapshot or screenshot.
      say(`folding ${runtime.deviceModel} ${options.devicePose}`);
      runner({ command: controllerCommand, args: ["fold", options.devicePose, "--session", CONTROLLER_SESSION, ...deviceArgs(runtime), "--platform", options.platform, "--json"],
        cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 2 * 60_000 });
    }
    if (await store.exists()) { map.run = newCaptureMap(options, runtime, fingerprint).run; await store.write(map); }
    else { map = newCaptureMap(options, runtime, fingerprint); await store.initialize(map, false); }
    if (colorSchemes.length > 1) { map.run.environment.colorSchemes = [...colorSchemes]; await store.write(map); }
    runtimeStage = "capture";
    setStage(runtimeStage);
    say(`simulator session ${sessionId} is ready (${runtime.deviceModel}, ${options.platform === "ios" ? "iOS" : "Android"} ${runtime.osVersion})`);
    // Every pass sets the appearance explicitly, so a capture does not inherit whatever the simulator last used.
    const passes: CaptureBundle["outcomes"][] = [];
    const recordingTools = launchSetting === "off" ? undefined : options.recordingTools === undefined ? ffmpegRecordingTools() : options.recordingTools ?? undefined;
    for (const [index, colorScheme] of colorSchemes.entries()) {
      // Argent cannot switch the appearance yet (software-mansion/argent#1509); its single pass runs as the device starts.
      if (controller !== "argent") runner({ command: controllerCommand, args: [...appearanceArgs(colorScheme), "--session", CONTROLLER_SESSION, ...deviceArgs(runtime), "--platform", options.platform],
        cwd: simulatorProject, environment: controllerEnvironment, timeoutMs: 60_000 });
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
        connection: handoff.connection, environment: controllerEnvironment, store, map, acceptedFrames, outcomes: index === 0 ? outcomes : {},
        ...(colorSchemes.length > 1 ? { appearance: { scheme: colorScheme, primary: index === 0 } } : {}) }));
    }
    runtime.colorScheme = colorSchemes[0]!;
    Object.assign(outcomes, mergeSchemeOutcomes(passes, colorSchemes));
  } catch (error) { primaryError = toCiError(error, { code: `CAPTURE_${runtimeStage.toUpperCase()}_FAILED`, stage: runtimeStage,
    nextAction: "Inspect the capture diagnostic, correct the failing prerequisite, and rerun Explore." }); }
  finally {
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
