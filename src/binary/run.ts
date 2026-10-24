import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiAgentSession, CiAgentSessionConfig } from "../capture/agent/session.js";
import type { CiAgentProviderName } from "../capture/agent/provider.js";
import type { ReplayPlan } from "./replay.js";
import type { FlowPlan } from "./flows.js";
import { assertAppUrl } from "./app-url.js";
import { chooseStrategy, startStrategy, strategyInputs, turnBudget, type ExplorationStrategy, type ModelAuth } from "./strategy.js";
import { CONTROLLER_SESSION, baseEnvironment, isRecord } from "../capture/common.js";
import { controllerData, defaultRunner, openedSimulatorDevice } from "../capture/controller.js";
import type { CommandRequest, CommandResult } from "../capture/run.js";
import { executeCaptureSetup } from "../capture/setup-actions.js";
import { SIMULATOR_DOTENV_FILE_NAME, SIMULATOR_DOTENV_HEADER, assertSimulatorSessionIdentity, assertSimulatorStopped, readSimulatorDotenvHandoff,
  assertAttachedSimulatorSession, connectionController, controllerVersion, resolveAttachedSimulatorSession, simulatorOsVersion, simulatorStartFailure, type ActiveSimulatorRuntime, type SimulatorConnection } from "../capture/simulator.js";
import { argentControllerInvocation } from "../capture/controller-invocation.js";
import { agentDeviceLauncher, ensureArgentToolServer, ensureController } from "../shared/controller-cache.js";
import { agentDeviceClaims, approveLinkScheme, createLocalSimulator, deleteLocalEmulator, deleteLocalSimulator, hostEmulatorAbi, installOnLocalEmulator, installOnLocalSimulator, startLocalArgentServer,
  startLocalEmulator, stopLocalAgentDevice, stopLocalArgentServer, waitForLocalEmulator, waitForLocalSimulator, type LocalArgentServer } from "../capture/local-simulator.js";
import { openLocalCaptureRecord, sweepLocalCaptures } from "../capture/local-registry.js";
import { screenSpace } from "../capture/route-capture.js";
import { approveSessionUrlSchemes, simulatorControlActions, type EasCommand } from "../capture/simulator-control.js";
import { DEFAULT_ANDROID_DEVICE } from "../config/explore-config.js";
import { DUO_PANELS } from "../contracts/capture.js";
import type { createExplorationInputs } from "../config/exploration-inputs.js";
import { ExploreStore, getCoverage } from "../map/store.js";
import { whoamiAccounts } from "../report/preview-deploy.js";
import { CiError, serializeCiError, toCiError } from "../shared/ci-errors.js";
import { packageBin } from "../shared/package-paths.js";
import { assertDecodedPng, solidColour } from "../shared/png-evidence.js";
import { CONTRACT, type ExploreMap, type Platform } from "../types.js";
import { archiveKind, assertEmulatorCompatible, extractIosBundle, inspectArchive, type ArchiveKind, type InspectedArchive, readArchiveIcon } from "./archive.js";
import { runBlackBoxExploration, type BlackBoxExplorerResult, type BlackBoxFrame, SYSTEM_DIALOG_PACKAGES } from "./explorer.js";

export const DEFAULT_IOS_DEVICE = "iPhone 17 Pro";
export const DEFAULT_BINARY_PROJECT = "expo-explore";
export const BINARY_LIMITS = { maxDurationMinutes: 15, maxScreens: 40, maxActions: 150 } as const;

export type BinaryExploreOptions = {
  archive: string;
  output: string;
  platform?: Platform;
  device?: string;
  bundleId?: string;
  launchUrl?: string;
  hints?: string;
  allowDestructive?: readonly string[];
  maxDurationMinutes?: number;
  maxScreens?: number;
  maxActions?: number;
  provider?: CiAgentProviderName;
  model?: string;
  /** EAS account that owns the simulator session (and the hosted report); defaults to the token's primary account. */
  owner?: string;
  /** EAS project slug the sessions run under; created on first use. */
  project?: string;
  /** The session's device controller; agent-device unless Argent is chosen. explore:session takes it from the session. */
  controller?: "agent-device" | "argent";
  /** Where the app runs: an EAS Simulator session (the default), or a simulator or emulator this run starts on this machine, with no EAS login. */
  simulator?: "eas" | "local";
  environment?: NodeJS.ProcessEnv;
  runner?: typeof defaultRunner;
  /** Fixed steps to take instead of a model's; no model access is needed. */
  replay?: ReplayPlan;
  /** Named flows to take, each from a relaunched app, with named checkpoints; a model is used only for steps described in words. */
  flows?: FlowPlan;
  createSession?: (config: CiAgentSessionConfig, options: { env: NodeJS.ProcessEnv; auth: ModelAuth }) => CiAgentSession;
  progress?: (message: string) => void;
  now?: () => number;
};

export type BinaryExploreResult = {
  outputDirectory: string;
  mapPath: string;
  archive: Omit<InspectedArchive, "path"> & { path: string };
  session: { id: string; platform: Platform; device: string; owner: string; project: string };
  runtime: ActiveSimulatorRuntime;
  model: Pick<ExplorationStrategy, "provider" | "model" | "auth">;
  exploration: BlackBoxExplorerResult;
  durationMs: number;
};

/** The command and environment that reach a session's controller: agent-device's CLI with its daemon, or the Argent bridge. */
type ControllerInvocation = { command: string; environment: NodeJS.ProcessEnv };

async function argentInvocation(connection: SimulatorConnection, work: string, platform: Platform, environment: NodeJS.ProcessEnv, bundleId?: string, device?: string): Promise<ControllerInvocation> {
  return argentControllerInvocation({ directory: work, connection, platform, environment: baseEnvironment(environment), sourceEnvironment: environment, ...(bundleId ? { bundleId } : {}), ...(device ? { device } : {}) });
}

/** The daemon refuses a second session on a busy device; the caller's own `agent-device` session (from install/open) is reused instead. */
function daemonSessions(runner: typeof defaultRunner, connection: SimulatorConnection, work: string, platform: Platform, environment: NodeJS.ProcessEnv): { name: string; device: string }[] {
  // Argent has no named sessions to share; its tool-server serves every caller.
  if (connectionController(connection) === "argent") return [];
  try {
    const result = runner({ command: agentDeviceLauncher(environment), args: ["session", "list", "--json"], cwd: work, timeoutMs: 60_000,
      environment: { ...baseEnvironment(environment), AGENT_DEVICE_DAEMON_BASE_URL: connection.daemonBaseUrl, AGENT_DEVICE_DAEMON_AUTH_TOKEN: connection.daemonAuthToken } });
    const data = controllerData(result.stdout, "session list");
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return sessions.flatMap(item => isRecord(item) && item.platform === platform && typeof item.name === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(item.name)
      ? [{ name: item.name, device: typeof item.device === "string" ? item.device : "" }] : []);
  } catch { return []; }
}

const SYSTEM_APP_PREFIXES = ["com.apple.", "com.android.", "com.google.android.", "android"];
const appIdPattern = /^[A-Za-z0-9._-]{1,256}$/;
const appIdOf = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const id = (/\(([^()]+)\)\s*$/.exec(value.trim())?.[1] ?? value).trim();
  return appIdPattern.test(id) && !SYSTEM_APP_PREFIXES.some(prefix => id === prefix || id.startsWith(prefix)) ? id : undefined;
};

/** `agent-device appstate` says the app under test is no longer in front: another app (the launcher is a system app, so the id is compared as reported, not through `appIdOf`) or a non-app surface. */
/** What `agent-device appstate` reported in front of the app under test, for a launch-blocked report: "com.foo.bar is in front" or "the device shows its home surface". */
export function describeForeground(state: Record<string, unknown>): string {
  const raw = state.appBundleId ?? state.packageName ?? state.package ?? state.appId;
  const foreground = typeof raw === "string" ? (/\(([^()]+)\)\s*$/.exec(raw.trim())?.[1] ?? raw).trim() : undefined;
  const surface = typeof state.surface === "string" && state.surface !== "app" ? state.surface : undefined;
  if (surface) return foreground ? `the device shows its ${surface} surface (appstate names ${foreground})` : `the device shows its ${surface} surface`;
  return foreground ? `${foreground} is in front` : "the snapshot shows another app";
}

export function leftForeground(state: Record<string, unknown>, bundleId: string): boolean {
  const raw = state.appBundleId ?? state.packageName ?? state.package ?? state.appId;
  const foreground = typeof raw === "string" ? (/\(([^()]+)\)\s*$/.exec(raw.trim())?.[1] ?? raw).trim() : undefined;
  if (foreground && SYSTEM_DIALOG_PACKAGES.has(foreground)) return false;
  return (typeof state.surface === "string" && state.surface !== "app") || (!!foreground && foreground !== bundleId);
}

/** Android draws runtime-permission prompts from its own package; the app under test is still running underneath, and the prompt's buttons are in the snapshot for the model. */

/** `agent-device apps` lists "Name (bundle.id)" strings or objects; the display name labels the report when no archive carries one. */
function listInstalled(run: (args: string[]) => Record<string, unknown> | undefined, controllerSession: string | undefined): { bundleId: string | undefined; name: string | undefined }[] {
  const listed = run(["apps", ...(controllerSession ? ["--session", controllerSession] : [])]);
  return (Array.isArray(listed?.apps) ? listed.apps : []).map((item: unknown) => {
    const raw = isRecord(item) ? item.id ?? item.bundleId ?? item.packageName : item;
    const label = isRecord(item) ? item.name ?? item.label : typeof item === "string" ? /^(.*\S)\s*\([^()]+\)\s*$/.exec(item.trim())?.[1] : undefined;
    return { bundleId: appIdOf(raw), name: typeof label === "string" && label.trim() ? label.trim() : undefined };
  });
}

const named = (apps: { bundleId: string | undefined; name: string | undefined }[], bundleId: string) => {
  const name = apps.find(app => app.bundleId === bundleId)?.name;
  return name ? { name } : {};
};

/** Finds the app to explore when the caller named none: the one the session has in the foreground, else the only user-installed app. */
export function resolveSessionApp(runner: typeof defaultRunner, connection: SimulatorConnection, work: string, platform: Platform, device: string, controllerSession: string | undefined, environment: NodeJS.ProcessEnv, invocation?: ControllerInvocation): { bundleId: string; name?: string } {
  const run = (args: string[]): Record<string, unknown> | undefined => {
    try {
      const result = runner({ command: invocation?.command ?? agentDeviceLauncher(environment), args: [...args, ...(platform === "ios" ? ["--device", device] : []), "--platform", platform, "--json"], cwd: work, timeoutMs: 60_000,
        environment: invocation?.environment ?? { ...baseEnvironment(environment), AGENT_DEVICE_DAEMON_BASE_URL: connection.daemonBaseUrl, AGENT_DEVICE_DAEMON_AUTH_TOKEN: connection.daemonAuthToken } });
      return controllerData(result.stdout, args[0]!);
    } catch { return undefined; }
  };
  if (controllerSession) {
    const state = run(["appstate", "--session", controllerSession]);
    const foreground = state && (state.state === undefined || state.state === "runningForeground") && (state.surface === undefined || state.surface === "app")
      ? appIdOf(state.appBundleId ?? state.packageName ?? state.package ?? state.appId) : undefined;
    if (foreground) return { bundleId: foreground, ...named(listInstalled(run, controllerSession), foreground) };
  }
  const apps = listInstalled(run, controllerSession);
  const installed = [...new Set(apps.flatMap(app => app.bundleId ?? []))];
  if (installed.length === 1) return { bundleId: installed[0]!, ...named(apps, installed[0]!) };
  throw binaryError("BUNDLE_ID_REQUIRED", installed.length ? `Several apps are installed on the session (${installed.join(", ")}) and none is open.` : "No app is open on the session and the installed apps could not be listed.",
    "Pass --bundle-id with the app's bundle identifier (iOS) or package name (Android).", { installed });
}

function validatedLimits(options: Pick<BinaryExploreOptions, "maxDurationMinutes" | "maxScreens" | "maxActions">) {
  const limits = { maxDurationMinutes: options.maxDurationMinutes ?? BINARY_LIMITS.maxDurationMinutes, maxScreens: options.maxScreens ?? BINARY_LIMITS.maxScreens, maxActions: options.maxActions ?? BINARY_LIMITS.maxActions };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw binaryError("EXPLORE_LIMIT_INVALID", `${name} must be an integer between 1 and 1000.`, "Correct the budget flag and rerun.");
  return limits;
}

function binaryError(code: string, message: string, nextAction: string, details?: Record<string, unknown>): CiError {
  return new CiError({ code, stage: "session", message, nextAction, ...(details ? { details } : {}) });
}

export type SessionExploreOptions = Omit<BinaryExploreOptions, "archive" | "bundleId" | "owner" | "project"> & {
  /** App to explore; defaults to the app in the foreground, else the only user-installed app. */
  bundleId?: string;
  /** EAS Simulator session id; defaults to EAS_SIMULATOR_SESSION_ID (or the dotenv file's). */
  session?: string;
  /** `.env.eas-simulator` written by `eas simulator:start --out-config-type dotenv`; otherwise the AGENT_DEVICE_DAEMON_* variables are used. */
  envFile?: string;
  appName?: string;
  version?: string;
};

export type SessionExploreResult = Omit<BinaryExploreResult, "archive" | "session"> & {
  app: { name: string; bundleId: string; platform: Platform; version?: string };
  session: { id: string; platform: Platform; device: string; name: string; url?: string };
};

export type ConnectedSessionExploration = {
  connection: SimulatorConnection;
  platform: Platform;
  device: string;
  bundleId: string;
  app: { name: string; version?: string };
  /** Omitted when the app is already on the device (explore:session). */
  install?: { path: string; kind: ArchiveKind };
  work: string;
  runner: typeof defaultRunner;
  environment: NodeJS.ProcessEnv;
  secrets: readonly string[];
  inputs: ReturnType<typeof createExplorationInputs>;
  say: (message: string) => void;
  now: () => number;
  limits: { maxDurationMinutes: number; maxScreens: number; maxActions: number };
  store: ExploreStore;
  map: ExploreMap;
  strategy: ExplorationStrategy;
  /** `eas simulator:get --json` for the attached session; descriptive (OS version) only. */
  sessionJson: () => string;
  /** agent-device session name on the daemon; explore:session reuses the caller's session so the device is not "in use" by another. */
  controllerSession?: string;
  launchUrl?: string;
  hints?: string;
  allowDestructive?: readonly string[];
  /** URL schemes the app registers; `open` is confined to them when known (iOS archives), otherwise to any custom scheme. */
  urlSchemes?: readonly string[];
  /** The app's icon from the archive for the Viewer header. */
  appIcon?: Buffer;
  /**
   * A simulator or emulator on this machine instead of an EAS session: the controller drives it by its UDID or adb
   * serial (agent-device with a daemon of its own in `stateDirectory`, or a local Argent tool-server pinned to it).
   */
  local?: { deviceId: string; osVersion: string; stateDirectory: string };
  /** Runs once the app is installed and before anything opens it, as an EAS session's link approval must. */
  afterInstall?: () => void;
};

/** Drives an agent-device daemon we already hold a connection to: optional install, open, then the model-led exploration. */
export async function exploreConnectedSession(ctx: ConnectedSessionExploration): Promise<{ runtime: ActiveSimulatorRuntime; exploration: BlackBoxExplorerResult }> {
  const { connection, platform, device, bundleId, app, install, work, runner, environment, secrets, inputs, say, now, limits, store, map, strategy, sessionJson, launchUrl, hints, allowDestructive, local } = ctx;
  const controllerSession = ctx.controllerSession ?? CONTROLLER_SESSION;
  const controllerKind = connectionController(connection);
  const controllerName = controllerKind === "argent" ? "Argent" : "agent-device";
  if (controllerKind === "argent") await ensureController("argent", { environment, progress: say });
  let agentDevice: string;
  let controllerEnvironment: NodeJS.ProcessEnv;
  if (controllerKind === "argent") {
    ({ command: agentDevice, environment: controllerEnvironment } = await argentInvocation(connection, work, platform, environment, bundleId, local?.deviceId));
  } else {
    const controllerConfig = join(work, "agent-device.json");
    await writeFile(controllerConfig, "{}\n", { flag: "wx", mode: 0o400 });
    // A local device has no EAS daemon: agent-device runs its own, in a state directory of this run's.
    controllerEnvironment = { ...baseEnvironment(environment), AGENT_DEVICE_CONFIG: controllerConfig,
      ...(local ? { AGENT_DEVICE_STATE_DIR: local.stateDirectory } : { AGENT_DEVICE_DAEMON_BASE_URL: connection.daemonBaseUrl, AGENT_DEVICE_DAEMON_AUTH_TOKEN: connection.daemonAuthToken }),
      AGENT_DEVICE_SESSION: controllerSession, AGENT_DEVICE_SESSION_LOCK: "reject", AGENT_DEVICE_PLATFORM: platform };
    agentDevice = agentDeviceLauncher(environment);
  }
  // A local device is named for Explore, so it is picked by its UDID or serial rather than its model name.
  const deviceArgs = local ? [platform === "ios" ? "--udid" : "--serial", local.deviceId] : platform === "ios" ? ["--device", device] : [];
  const controller = (args: string[], timeoutMs = 90_000): CommandResult => {
    // Session flags go before a `--` separator so model-chosen text (`type -h`, a URL, a label) is never read as a flag.
    const separator = args.indexOf("--");
    const flags = separator === -1 ? args : args.slice(0, separator), positionals = separator === -1 ? [] : args.slice(separator);
    const request: CommandRequest = { command: agentDevice, args: [...flags, "--session", controllerSession, ...deviceArgs, "--platform", platform, ...positionals], cwd: work, environment: controllerEnvironment, timeoutMs };
    return retryWhileBusy(() => runner(request), sleepSync);
  };
  const failureText = (error: unknown): string => lastLine(redactSecrets(error instanceof Error ? error.message : String(error), secrets)).slice(0, 400);
  const version = runner({ command: agentDevice, args: ["--version"], cwd: work, environment: controllerEnvironment, timeoutMs: 30_000 }).stdout.trim();
  if (version !== controllerVersion(controllerKind)) throw binaryError("EXPLORE_TOOLS_MISSING", `${controllerName} ${controllerVersion(controllerKind)} is required (found ${version || "none"}).`, "Reinstall @expo/explore.");

  if (install) {
    say(`installing ${install.kind === "android-apk" ? "the APK" : "the app"} on session ${connection.sessionId}`);
    try { controller(["install", install.path, "--json"], 15 * 60_000); }
    catch (error) { throw binaryError("APP_INSTALL_FAILED", `${controllerName} could not install the app: ${failureText(error)}`, "Check that the archive is a simulator build for this platform and under the size limit, then rerun.", { sessionId: connection.sessionId }); }
  }
  ctx.afterInstall?.();
  // On a local device, the first open also builds agent-device's iOS runner.
  // Flows start from the app's first screen: an app already running on an attached session is relaunched, not brought forward.
  const opened = controller(["open", bundleId, ...(strategy.flows ? ["--relaunch"] : []), "--level", "full", "--json"], local ? 15 * 60_000 : 2 * 60_000);
  const openedDevice = openedSimulatorDevice(opened.stdout, bundleId, "initial app open", platform, controllerSession);
  const data = controllerData(opened.stdout, "initial app open");
  const deviceData = data.device && typeof data.device === "object" ? data.device as Record<string, unknown> : {};
  const observed = (key: string): string => { const value = deviceData[key] ?? data[key]; return typeof value === "string" && value.trim() ? value : "unknown"; };
  const runtime = { provider: local ? "local-simulator" : "eas-simulator", controller: controllerKind, controllerPackageVersion: controllerVersion(controllerKind), easCliVersion: "unknown", platform, controllerDeviceId: openedDevice.deviceId,
    deviceModel: local ? device : openedDevice.deviceModel, osVersion: local ? local.osVersion : observed("osVersion"), locale: observed("locale"), orientation: observed("orientation") === "landscape" ? "landscape" : "portrait",
    colorScheme: observed("colorScheme") === "dark" ? "dark" : "light" } as ActiveSimulatorRuntime;
  // Argent's `open` reports the OS version itself (list-devices); agent-device's comes from the session's preview.
  if (!local && (runtime.osVersion === "unknown" || controllerKind !== "argent")) try { runtime.osVersion = await simulatorOsVersion(sessionJson(), runtime.controllerDeviceId, fetch, platform); } catch { /* descriptive only */ }
  map.run.deviceId = runtime.controllerDeviceId;
  map.run.environment = { deviceModel: runtime.deviceModel, osVersion: runtime.osVersion, locale: runtime.locale, orientation: runtime.orientation, colorScheme: runtime.colorScheme };
  map.run.status = "exploring";
  await store.initialize(map, false);
  say(`app is open on ${runtime.deviceModel} (${platform === "ios" ? "iOS" : "Android"} ${runtime.osVersion}); exploring`);

  const deadlineMs = now() + limits.maxDurationMinutes * 60_000;
  let frames = 0;
  const snapshotData = (): { nodes: Record<string, unknown>[]; refsGeneration?: number } => {
    let result: CommandResult;
    try { result = controller(["snapshot", "--force-full", "--level", "full", "--json"], 120_000); }
    catch (error) { throw binaryError("OBSERVATION_FAILED", `The accessibility snapshot failed: ${failureText(error)}`, "The app may have left the foreground; Explore reopens it."); }
    const value = controllerData(result.stdout, "snapshot");
    if (!Array.isArray(value.nodes) || value.nodes.length > 20_000) throw binaryError("OBSERVATION_FAILED", "The controller did not return an accessibility snapshot.", "Retry the observation.");
    // Android snapshots include the status bar (com.android.systemui's clock, battery, …): not part of the app, and a clock tick is not a new screen.
    const nodes = value.nodes.filter((node): node is Record<string, unknown> => !!node && typeof node === "object" && !foreignNode(node, bundleId));
    return { nodes, ...(typeof value.refsGeneration === "number" ? { refsGeneration: value.refsGeneration } : {}) };
  };
  const snapshot = (): Record<string, unknown>[] => snapshotData().nodes;
  // A tree read mid-transition (a sheet half presented, a screen still sliding in) hashes to a screen that never
  // exists at rest; wait until two consecutive reads agree before the caller identifies the destination.
  const settled = async (): Promise<Record<string, unknown>[] | undefined> => {
    try {
      let previous = snapshot();
      let previousKey = JSON.stringify(previous);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const next = snapshot();
        const nextKey = JSON.stringify(next);
        if (nextKey === previousKey) return next;
        previous = next;
        previousKey = nextKey;
      }
      return previous;
    } catch { return undefined; /* observe() reports a lost foreground app itself. */ }
  };
  const reopen = (): void => { controller(["open", bundleId, "--level", "full", "--json"], 2 * 60_000); };
  /** A flow starts from the app's first screen: the process is ended and launched again (the app's data stays). */
  const restart = async (): Promise<void> => {
    try {
      controller(["open", bundleId, "--relaunch", "--level", "full", "--json"], 2 * 60_000);
      if (launchUrl) await setupOptions.open(launchUrl);
    } catch (error) { throw binaryError("APP_RELAUNCH_FAILED", `${controllerName} could not relaunch the app${launchUrl ? ` at ${launchUrl}` : ""}: ${failureText(error)}`, "Check that the app still launches, then rerun the flows."); }
    await new Promise(resolve => setTimeout(resolve, 2500));
    await settled();
  };
  // iOS refuses a snapshot once the app is gone; Android happily returns the launcher's tree, so the foreground app is asked for.
  const foregroundState = (): Record<string, unknown> | undefined => {
    try { return controllerData(controller(["appstate", "--json"], 60_000).stdout, "appstate"); }
    catch { return undefined; }
  };
  const foregroundElsewhere = (): boolean => { const state = foregroundState(); return state ? leftForeground(state, bundleId) : false; };
  let unmatchedPanel = false;
  /** Whether the frame is an opened Duo's, to be stored turned upright; the run then records the landscape it shows. */
  const landscapeOnPortrait = (nodes: readonly Record<string, unknown>[], png: Buffer): boolean => {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    const turn = duoScreenshotTurn({ platform, deviceModel: runtime.deviceModel, nodes, width, height });
    if (turn === "unmatched" && !unmatchedPanel) {
      unmatchedPanel = true;
      const root = nodes.find(node => node.type === "Application")?.rect as { width?: unknown; height?: unknown } | undefined;
      say(`an iPhone Duo frame (${width}×${height} px, root ${root ? `${String(root.width)}×${String(root.height)} pt` : "missing"}) shows neither of its panels; its screenshot is stored as taken, which may be sideways`);
    }
    if (turn !== "turn") return false;
    if (runtime.orientation !== "landscape") { runtime.orientation = "landscape"; if (map.run.environment) map.run.environment.orientation = "landscape"; }
    return true;
  };
  const observe = async (includeImage: boolean): Promise<BlackBoxFrame> => {
    let nodes: Record<string, unknown>[];
    let leftApp = false;
    try { nodes = snapshot(); }
    catch {
      // A transient controller failure (adb "device offline" mid-animation on EAS Android) is retried once before Explore assumes the app left the foreground.
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { nodes = snapshot(); } catch { reopen(); leftApp = true; nodes = snapshot(); }
    }
    if (!leftApp && foregroundElsewhere()) {
      reopen();
      leftApp = true;
      // The tree right after a relaunch is the splash or an empty root; give the first screen a moment to render.
      await new Promise(resolve => setTimeout(resolve, 2500));
      nodes = snapshot();
    }
    let capturedAt = new Date(now()).toISOString();
    if (!includeImage) return { nodes, capturedAt, ...(leftApp ? { leftApp } : {}) };
    const path = join(work, `frame-${++frames}.png`);
    try {
      // The tree is read before the screenshot. When the app moves between the two (Keeper's modal mounts its button a beat
      // after its text; its dismissed biometric prompt navigates a second later), the pair would describe two states and the
      // card a screen that never exists at rest: re-read after the shot, and when the tree changed, settle and shoot again.
      for (let round = 0; ; round += 1) {
        try { controller(["screenshot", path, "--normalize-status-bar", "--level", "full", "--json"], 120_000); }
        catch (error) { return { nodes, capturedAt, imageUnavailable: { code: "SCREENSHOT_FAILED", message: failureText(error).slice(0, 300) } }; }
        if (round === 2) break;
        let after: Record<string, unknown>[];
        try { after = snapshot(); } catch { break; }
        if (JSON.stringify(after) === JSON.stringify(nodes)) break;
        nodes = (await settled()) ?? after;
        capturedAt = new Date(now()).toISOString();
      }
      const png = await readFile(path);
      assertDecodedPng(png, "Exploration screenshot");
      if (png.length > 10 * 1024 * 1024) return { nodes, capturedAt, imageUnavailable: { code: "SCREENSHOT_TOO_LARGE", message: "The screenshot exceeded 10 MB." } };
      if (solidColour(png)) return { nodes, capturedAt, imageUnavailable: { code: "SCREENSHOT_BLANK", message: BLANK_SCREENSHOT_MESSAGE }, ...(leftApp ? { leftApp } : {}) };
      return { nodes, capturedAt, frameId: randomUUID(), png, imageSha256: createHash("sha256").update(png).digest("hex"), width: png.readUInt32BE(16), height: png.readUInt32BE(20), ...(landscapeOnPortrait(nodes, png) ? { landscape: true } : {}), ...(leftApp ? { leftApp } : {}) };
    } finally { await rm(path, { force: true }); }
  };
  const setupOptions = { command: async (args: string[]) => { const result = controller(guardPositionals([...args, "--json"]), 120_000); return controllerData(result.stdout, args[0] ?? "command"); },
    open: async (url: string) => { assertAppUrl(url, ctx.urlSchemes); const result = controller(["open", "--json", "--", url], 120_000); return controllerData(result.stdout, "open"); },
    snapshot: async () => ({ truncated: false, ...snapshotData() }), readinessAttempts: 3, postActionObservation: "caller" as const };
  if (launchUrl) {
    say(`opening ${launchUrl}`);
    // A controller error is shown and recorded; it must not carry the daemon token.
    try { await setupOptions.open(launchUrl); }
    catch (error) { throw error instanceof CiError ? error : binaryError("LAUNCH_URL_FAILED", `${controllerName} could not open ${launchUrl}: ${failureText(error)}`, "Check that the app handles the launch URL, or drop --launch-url."); }
  }
  // A build that crashes on launch is reported as such instead of costing the model a round of "app is not running" errors.
  // iOS appstate keeps naming the session's app after it dies, so the snapshot (which refuses a dead app) is the test.
  let blockedAtLaunch: BlackBoxExplorerResult | undefined;
  let goneReason = "";
  // One appstate read decides and describes the foreground, so the reason names what was actually in front (the app relaunching in a crash loop answers differently a second later).
  const gone = (): boolean => {
    try { snapshot(); } catch (error) { goneReason = `the snapshot failed: ${(error as Error).message}`; return true; }
    const state = foregroundState();
    goneReason = state && leftForeground(state, bundleId) ? describeForeground(state) : "";
    return goneReason !== "";
  };
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 4000));
  await settle();
  if (gone()) {
    say(`the app is not in the foreground a few seconds after it was opened (${goneReason}); opening it again`);
    reopen();
    await settle();
    if (gone()) {
      const reason = `${app.name} exited within seconds of being opened, twice in a row, so nothing could be explored: this build does not stay running on ${runtime.deviceModel} (${runtime.osVersion}); ${goneReason}.`;
      map.gaps.push({ id: `gap_${randomUUID().slice(0, 8)}`, kind: "coverage", status: "open", message: reason, createdAt: new Date(now()).toISOString() });
      say("exploration blocked: the app does not stay running");
      blockedAtLaunch = { stopReason: "blocked", summary: reason, screens: 0, observations: 0, actions: 0, turns: 0,
        ...(strategy.flows ? { flows: strategy.flows().map(({ flow, checkpoints }) => ({ name: flow, status: "failed" as const, reason, checkpoints: checkpoints.map(name => ({ name, missing: "The app did not stay open." })) })) } : {}) };
    }
  }
  const exploration = blockedAtLaunch ?? await runBlackBoxExploration({ session: strategy.session, store, map, app: { name: app.name, bundleId, platform, ...(app.version ? { version: app.version } : {}) },
    inputs, ...(hints ? { hints: hints } : {}), ...(launchUrl ? { launchUrl: launchUrl } : {}), ...(allowDestructive ? { allowDestructive: allowDestructive } : {}), ...(ctx.appIcon ? { appIcon: ctx.appIcon } : {}),
    ...(strategy.budgetNote ? { budgetNote: strategy.budgetNote } : {}), ...(strategy.flows ? { flows: { restart, notReached: strategy.flows } } : {}),
    deadlineMs, maxScreens: limits.maxScreens, maxActions: limits.maxActions, maxTurns: turnBudget(limits), now, observe, progress: say,
    act: async action => {
      const perform = async () => {
        if (action.action === "tap" && "frameId" in action) {
          const frame = await observe(false);
          const bounds = frameBounds(frame.nodes);
          controller(["press", String(Math.round(action.x * bounds.width)), String(Math.round(action.y * bounds.height)), "--level", "full", "--json"], 120_000);
        } else if (action.action === "back") {
          // Onboarding steps, tabs and sheets have no back control; the platform gesture (iOS edge swipe, Android back) still works.
          try { controller(["back", "--in-app", "--level", "full", "--json"], 120_000); }
          catch (error) {
            if (!(error instanceof Error) || !/in-app back control is not available/.test(error.message)) throw error;
            controller(["back", "--system", "--level", "full", "--json"], 120_000);
          }
        }
        else if (action.action === "dismiss-keyboard") await dismissKeyboard();
        else if (action.action === "type") controller(["type", "--level", "full", "--json", "--", action.text], 120_000);
        else await executeCaptureSetup([action], setupOptions);
        if (action.action !== "wait") await settled();
      };
      const dismissKeyboard = async () => {
        try { controller(["keyboard", "dismiss", "--level", "full", "--json"], 120_000); return; }
        catch (error) { if (!(error instanceof Error) || !/Unable to dismiss the iOS keyboard/.test(error.message)) throw error; }
        // The iOS keyboard has no dismiss key and agent-device never taps the background; its return key (next/done/go) closes it without touching the app.
        const nodes = (await observe(false)).nodes;
        // In a multi-line editor the return key inserts a newline instead of ending editing.
        const multiline = nodes.some(node => /text-?view/i.test(String(node.type ?? "")));
        const key = multiline ? undefined : nodes.find(node => /key$/i.test(String(node.type ?? "")) && KEYBOARD_RETURN_KEY.test(String(node.label ?? "")));
        const rect = key?.rect as { x: number; y: number; width: number; height: number } | undefined;
        if (!rect) throw binaryError("KEYBOARD_DISMISS_UNAVAILABLE", multiline ? "The keyboard cannot be dismissed from a multi-line editor: its return key inserts a newline." : "The keyboard cannot be dismissed: it has neither a dismiss nor a return key.", "Tap one of the app's own controls that is not behind the keyboard (Cancel, Done, Close), or go back.");
        controller(["press", String(Math.round(rect.x + rect.width / 2)), String(Math.round(rect.y + rect.height / 2)), "--level", "full", "--json"], 120_000);
      };
      try {
        try { await perform(); }
        catch (error) {
          // A control under the keyboard: close the keyboard and tap once more.
          if (!(error instanceof Error) || !/behind the visible keyboard/.test(error.message)) throw error;
          await dismissKeyboard(); await settled(); await perform();
        }
      } catch (error) {
        // The message is recorded in the map and shown to the model; it must not carry the daemon token.
        if (error instanceof CiError) throw error;
        throw new Error(failureText(error));
      }
    } });
  // "complete" is reserved for a run with no pending frontier or open gaps; a model that finishes early is "partial".
  // The map schema allows stopReason only on partial/failed runs.
  map.run.status = exploration.stopReason === "model-error" ? "failed"
    : exploration.stopReason === "finished" && getCoverage(map).completion.eligible ? "complete" : "partial";
  if (map.run.status === "complete") delete map.run.stopReason; else map.run.stopReason = exploration.stopReason;
  map.run.completedAt = new Date(now()).toISOString();
  await store.write(map);
  if (exploration.stopReason === "model-error") throw toCiError(exploration.error, { code: "EXPLORATION_FAILED", stage: "exploration", nextAction: "Inspect the model error and rerun." });
  return { runtime, exploration };
}

/** Explores an app already installed on a session the caller started; the session is left running. */
export async function runSessionExploration(options: SessionExploreOptions): Promise<SessionExploreResult> {
  const startedAt = Date.now();
  const now = options.now ?? Date.now;
  const say = options.progress ?? (() => {});
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const limits = validatedLimits(options);
  const choice = chooseStrategy(options);
  // A flows run without --platform checks its secrets once the session reports its platform, before any device work, so a
  // secret that only another platform's steps type is not required.
  let inputs = choice.kind === "flows" && !options.platform ? undefined : strategyInputs(choice, options.hints, environment, options.platform);
  if (options.bundleId !== undefined && !appIdPattern.test(options.bundleId)) throw binaryError("BUNDLE_ID_INVALID", `${options.bundleId} is not a bundle or package id.`, "Pass --bundle-id with the app's bundle identifier (iOS) or package name (Android).");
  let connection: SimulatorConnection;
  try { connection = await resolveAttachedSimulatorSession(environment, options.envFile, options.session); }
  catch (error) {
    throw binaryError("SESSION_NOT_PROVIDED", `No EAS Simulator session connection was found: ${error instanceof Error ? error.message : String(error)}`,
      "Start one with `eas simulator:start --type agent-device --out-config-type dotenv` (or `--type argent`) and run explore:session in that directory (or pass --env-file / set EAS_SIMULATOR_SESSION_ID with AGENT_DEVICE_DAEMON_BASE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN, or ARGENT_TOOLS_URL).");
  }
  const sessionController = connectionController(connection);
  if (!options.runner) await ensureController(sessionController, { environment, progress: say });
  if (options.controller && options.controller !== sessionController) {
    throw binaryError("CONTROLLER_MISMATCH", `--controller ${options.controller} was passed, but the session is driven by ${sessionController}.`,
      `Drop --controller, or start a session with \`eas simulator:start --type ${options.controller}\`.`, { sessionId: connection.sessionId });
  }
  if (!environment.EXPO_TOKEN?.trim() && !environment.EXPO_SESSION_SECRET?.trim() && !(await easLoggedIn(runner, environment))) {
    throw binaryError("EXPO_LOGIN_REQUIRED", "No EAS login was found.", "Run `eas login` or set EXPO_TOKEN, then rerun explore:session.");
  }
  const work = await realpath(await mkdtemp(join(tmpdir(), "expo-explore-session-")));
  const easEnvironment = { ...baseEnvironment(environment), ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}), ...(environment.HOME ? { HOME: environment.HOME } : {}), CI: "1", EXPO_NO_TELEMETRY: "1" };
  const easBin = packageBin("eas-cli", "eas");
  await lstat(easBin).catch(() => { throw binaryError("EXPLORE_TOOLS_MISSING", "The EAS CLI that Explore pins is not installed.", "Reinstall @expo/explore with optional dependencies."); });
  // `eas simulator:get` insists on a project directory even though the session id is global; a placeholder is enough (no `eas init`).
  await writeFile(join(work, "package.json"), JSON.stringify({ name: DEFAULT_BINARY_PROJECT, version: "0.0.0", private: true }), { mode: 0o600 });
  await writeFile(join(work, "app.json"), JSON.stringify({ expo: { name: DEFAULT_BINARY_PROJECT, slug: DEFAULT_BINARY_PROJECT } }), { mode: 0o600 });
  const sessionJson = (): string => runner({ command: process.execPath, args: [easBin, "simulator:get", "--id", connection.sessionId, "--json", "--non-interactive"], cwd: work, environment: easEnvironment, timeoutMs: 2 * 60_000 }).stdout;
  let primaryError: unknown;
  let runtime: ActiveSimulatorRuntime | undefined;
  let exploration: BlackBoxExplorerResult | undefined;
  let session: SessionExploreResult["session"] | undefined;
  let platform: Platform = options.platform ?? "ios";
  let device = options.device ?? "";
  const app = { name: options.appName ?? options.bundleId ?? "app", bundleId: options.bundleId ?? "app", ...(options.version ? { version: options.version } : {}) };
  const secrets = [environment.EXPO_TOKEN ?? "", connection.daemonAuthToken, ...inputs?.values ?? []].filter(Boolean);
  const map: ExploreMap = { contract: CONTRACT, revision: 0, run: { id: randomUUID(), name: app.name, platform, controller: sessionController, exploration: "black-box", bundleId: app.bundleId, status: "draft",
    createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), build: { ...(app.version ? { version: app.version } : {}), source: "unknown" }, environment: {}, limits },
    artifacts: [], screens: [], variants: [], observations: [], elements: [], actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [] };
  try {
    say(`checking EAS Simulator session ${connection.sessionId}`);
    let info: ReturnType<typeof assertAttachedSimulatorSession>;
    try { info = assertAttachedSimulatorSession(sessionJson(), connection, options.platform); }
    catch (error) {
      throw binaryError("SESSION_UNAVAILABLE", `EAS Simulator session ${connection.sessionId} cannot be explored: ${lastLine(redactSecrets(error instanceof Error ? error.message : String(error), secrets))}`,
        `Check \`eas simulator:list\`; the session must be in progress, of type ${sessionController}, and match the connection you passed.`, { sessionId: connection.sessionId });
    }
    platform = info.platform;
    if (!inputs) {
      inputs = strategyInputs(choice, options.hints, environment, platform);
      secrets.push(...inputs.values);
    }
    const candidates = daemonSessions(runner, connection, work, platform, environment).filter(item => !device || item.device === device);
    const devices = new Set(candidates.map(item => item.device));
    if (devices.size > 1) throw binaryError("SESSION_DEVICE_AMBIGUOUS", `The session has agent-device sessions on several devices (${[...devices].join(", ")}).`, "Pass --device with the one the app is installed on.", { devices: [...devices] });
    const existing = candidates[0];
    if (existing) say(`reusing agent-device session "${existing.name}" on ${existing.device}`);
    device = device || existing?.device || (platform === "ios" ? DEFAULT_IOS_DEVICE : DEFAULT_ANDROID_DEVICE);
    if (!options.bundleId) {
      const resolved = resolveSessionApp(runner, connection, work, platform, device, existing?.name, environment,
        sessionController === "argent" ? await argentInvocation(connection, work, platform, environment) : undefined);
      app.bundleId = resolved.bundleId;
      if (!options.appName) app.name = resolved.name ?? app.bundleId;
      map.run.bundleId = app.bundleId;
      map.run.name = app.name;
      say(`exploring ${app.bundleId} (pass --bundle-id to choose another app)`);
    }
    map.run.platform = platform;
    map.run.environment = { deviceModel: device };
    session = { id: connection.sessionId, platform, device, name: info.name, ...(info.deviceRunSessionUrl ? { url: info.deviceRunSessionUrl } : {}) };

    const strategy = await startStrategy(choice, { platform, limits, options, environment, say, app });
    const outputDirectory = await realpath(await mkdir(options.output, { recursive: true }).then(() => options.output));
    const store = new ExploreStore(outputDirectory);
    if (await store.exists()) throw binaryError("OUTPUT_NOT_EMPTY", `${outputDirectory} already holds an Explore map.`, "Pass an empty --output directory.");

    ({ runtime, exploration } = await exploreConnectedSession({ connection, platform, device, bundleId: app.bundleId, app, work, runner, environment, secrets, inputs, say, now, limits, store, map, strategy, sessionJson,
      ...(existing ? { controllerSession: existing.name } : {}),
      ...(options.launchUrl ? { launchUrl: options.launchUrl } : {}), ...(options.hints ? { hints: options.hints } : {}), ...(options.allowDestructive ? { allowDestructive: options.allowDestructive } : {}) }));
    return { outputDirectory, mapPath: store.mapPath, app: { ...app, platform }, session, runtime, model: { provider: strategy.provider, model: strategy.model, auth: strategy.auth }, exploration, durationMs: Date.now() - startedAt };
  } catch (error) {
    primaryError = toCiError(error, { code: "EXPLORE_SESSION_FAILED", stage: "exploration", nextAction: "Inspect the diagnostic, correct the failing prerequisite, and rerun explore:session. The session was left running." });
    throw primaryError;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

type LocalDevice = NonNullable<ConnectedSessionExploration["local"]>;

/**
 * Starts a simulator or emulator on this machine for one run, installs the app, and hands the explorer a connection
 * to it; everything is stopped afterwards. They are the devices `capture --simulator local` starts, recorded the same
 * way, so the next local run stops what a run stopped hard left behind.
 */
async function withLocalDevice(options: { archive: InspectedArchive; installPath: string; platform: Platform; device: string; bundleId: string;
  controller: "agent-device" | "argent"; tag: string; work: string; runner: typeof defaultRunner; environment: NodeJS.ProcessEnv; secrets: readonly string[]; say: (message: string) => void; now?: () => number },
  explore: (connection: SimulatorConnection, local: LocalDevice) => Promise<void>): Promise<void> {
  const { archive, installPath, platform, device, bundleId, controller, tag, work, runner, say } = options;
  const environment = baseEnvironment(options.environment);
  const agentDevice = agentDeviceLauncher(options.environment);
  const stateDirectory = join(work, "agent-device-state");
  const record = await openLocalCaptureRecord(options.environment, work);
  let udid: string | undefined, serial: string | undefined, argent: LocalArgentServer | undefined;
  let primaryError: unknown;
  try {
    let osVersion: string;
    if (platform === "ios") {
      say(`starting a local ${device} simulator`);
      const created = await createLocalSimulator({ runner, device, name: `Explore ${device} (binary ${tag})`, cwd: work, environment,
        created: async id => { udid = id; await record.update({ udid: id }); } });
      osVersion = created.osVersion;
      waitForLocalSimulator({ runner, udid: created.udid, cwd: work, environment });
      // Links in the app's own schemes open without iOS asking first.
      for (const scheme of archive.urlSchemes) approveLinkScheme({ runner, udid: created.udid, scheme, bundleId, cwd: work, environment });
      say("installing the app");
      installOnLocalSimulator({ runner, udid: created.udid, app: installPath, cwd: work, environment });
    } else {
      say(`starting a local ${device} emulator`);
      const name = `explore-binary-${tag}`;
      const started = await startLocalEmulator({ runner, device, name, directory: work, cwd: work, environment,
        ...(controller === "agent-device" ? { claimed: (candidate: string) => agentDeviceClaims({ runner, agentDevice, serial: candidate, cwd: work, environment }) } : {}),
        started: async id => { serial = id; await record.update({ serial: id, avd: name }); } });
      osVersion = waitForLocalEmulator({ runner, serial: started.serial, device, apiLevel: started.apiLevel, directory: work, cwd: work, environment, ...(options.now ? { now: options.now } : {}) });
      say("installing the APK");
      installOnLocalEmulator({ runner, serial: started.serial, apk: installPath, cwd: work, environment });
    }
    const deviceId = (udid ?? serial)!;
    let connection: SimulatorConnection = { sessionId: `local-${deviceId}`, daemonBaseUrl: "", daemonAuthToken: "" };
    if (controller === "argent") {
      // Argent drives the device through a tool-server of this run's own.
      const cli = await ensureArgentToolServer({ environment: options.environment, progress: say });
      argent = await startLocalArgentServer({ runner, cli, directory: work, cwd: work, environment, ...(options.now ? { now: options.now } : {}) });
      await record.update({ argent: { pid: argent.pid, cli: argent.cli, home: argent.home } });
      connection = { ...connection, daemonBaseUrl: argent.url, daemonAuthToken: argent.token, controller: "argent" };
    }
    await explore(connection, { deviceId, osVersion, stateDirectory });
  } catch (error) { primaryError = error; throw error; }
  finally {
    try {
      if (argent) stopLocalArgentServer(argent);
      // Its own agent-device daemon lets go of the device before it goes.
      if (controller === "agent-device") runner({ command: agentDevice, args: ["close", "--session", CONTROLLER_SESSION, "--json"], cwd: work,
        environment: { ...environment, AGENT_DEVICE_STATE_DIR: stateDirectory }, timeoutMs: 60_000, allowFailure: true });
      await stopLocalAgentDevice(stateDirectory);
      if (serial) { say(`stopping the local emulator ${serial}`); await deleteLocalEmulator({ runner, serial, cwd: work, environment }); }
      if (udid) { say(`deleting the local simulator ${udid}`); deleteLocalSimulator({ runner, udid, cwd: work, environment }); }
      // Everything is stopped; a cleanup that threw leaves the record for the next run's sweep.
      await record.close();
    } catch (error) {
      throw new CiError({ code: "SESSION_CLEANUP_FAILED", stage: "cleanup", message: `The local ${serial ? "emulator" : "simulator"} Explore started could not be stopped.`,
        nextAction: serial ? `Stop it with: adb -s ${serial} emu kill` : udid ? `Delete it with: xcrun simctl delete ${udid}` : "Rerun explore:binary --simulator local; it stops what this run left.",
        details: { ...(serial ? { serial } : {}), ...(udid ? { udid } : {}), ...(primaryError ? { originalFailure: serializeCiError(primaryError, { secrets: options.secrets }) } : {}) }, cause: error });
    }
  }
}

export async function runBinaryExploration(options: BinaryExploreOptions): Promise<BinaryExploreResult> {
  const startedAt = Date.now();
  const now = options.now ?? Date.now;
  const say = options.progress ?? (() => {});
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const limits = validatedLimits(options);
  const choice = chooseStrategy(options);
  // The archive's name gives its platform before it is read (inspectArchive confirms it), so a secret only another platform's steps type is not required.
  const namedPlatform = options.platform ?? (() => { try { return archiveKind(options.archive) === "android-apk" ? "android" as const : "ios" as const; } catch { return undefined; } })();
  const inputs = strategyInputs(choice, options.hints, environment, namedPlatform);
  const local = options.simulator === "local";
  // A local emulator runs this Mac's ABI (arm64-v8a on Apple silicon); EAS's runs x86_64.
  const emulatorAbi = local ? hostEmulatorAbi() : "x86_64";
  say("inspecting the archive");
  const archive = await inspectArchive(options.archive);
  assertEmulatorCompatible(archive, [emulatorAbi]);
  if (options.platform && options.platform !== archive.platform) throw binaryError("ARCHIVE_PLATFORM_MISMATCH", `The archive is an ${archive.platform} build but --platform ${options.platform} was requested.`, "Drop --platform or pass a matching archive.");
  if (!local && !environment.EXPO_TOKEN?.trim() && !environment.EXPO_SESSION_SECRET?.trim() && !(await easLoggedIn(runner, environment))) {
    throw binaryError("EXPO_LOGIN_REQUIRED", "No EAS login was found.", "Run `eas login` or set EXPO_TOKEN, then rerun explore:binary.");
  }
  const platform = archive.platform;
  const bundleId = options.bundleId ?? archive.bundleId;
  const device = options.device ?? (platform === "ios" ? DEFAULT_IOS_DEVICE : DEFAULT_ANDROID_DEVICE);
  say(`${archive.appName} ${archive.version ?? ""} (${bundleId}, ${platform}, ${(archive.bytes / 1048576).toFixed(0)} MB, sha256 ${archive.sha256.slice(0, 12)})`);
  if (archive.missingLibs?.length && emulatorAbi === "x86_64") say(`warning: lib/x86_64 lacks ${archive.missingLibs.slice(0, 4).join(", ")}${archive.missingLibs.length > 4 ? ` and ${archive.missingLibs.length - 4} more` : ""} that another ABI ships; the app may stop with UnsatisfiedLinkError on the emulator`);

  const strategy = await startStrategy(choice, { platform, limits, options, environment, say, app: { name: archive.appName } });

  const outputDirectory = await realpath(await mkdir(options.output, { recursive: true }).then(() => options.output));
  const store = new ExploreStore(outputDirectory);
  if (await store.exists()) throw binaryError("OUTPUT_NOT_EMPTY", `${outputDirectory} already holds an Explore map.`, "Pass an empty --output directory.");
  const work = await realpath(await mkdtemp(join(tmpdir(), "expo-explore-binary-")));
  const easEnvironment = { ...baseEnvironment(environment), ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}), ...(environment.HOME ? { HOME: environment.HOME } : {}), CI: "1", EXPO_NO_TELEMETRY: "1" };
  const easBin = packageBin("eas-cli", "eas");
  if (!local) await lstat(easBin).catch(() => { throw binaryError("EXPLORE_TOOLS_MISSING", "The EAS CLI that Explore pins is not installed.", "Reinstall @expo/explore with optional dependencies."); });
  const eas = (args: string[], timeoutMs = 5 * 60_000): CommandResult & { status: number } => {
    try { return { ...runner({ command: process.execPath, args: [easBin, ...args], cwd: work, environment: easEnvironment, timeoutMs }), status: 0 }; }
    catch (error) { return { stdout: "", stderr: error instanceof Error ? error.message : String(error), status: 1 }; }
  };
  let sessionId: string | undefined;
  let primaryError: unknown;
  let runtime: ActiveSimulatorRuntime | undefined;
  let exploration: BlackBoxExplorerResult | undefined;
  let owner = options.owner ?? "";
  const project = options.project ?? DEFAULT_BINARY_PROJECT;
  const controller = options.controller ?? "agent-device";
  // Fetched before the paid session starts, so a blocked download costs nothing.
  if (!options.runner) await ensureController(controller, { environment, progress: say });
  if (local) {
    // What an earlier local run stopped hard left running (a simulator, an emulator, a daemon) goes first.
    const swept = await sweepLocalCaptures({ environment, runner, cwd: work }).catch(() => [] as string[]);
    if (swept.length) say(`stopped what an interrupted local run left running: ${swept.join(", ")}`);
  }
  const map: ExploreMap = { contract: CONTRACT, revision: 0, run: { id: randomUUID(), name: archive.appName, platform, controller, exploration: "black-box", bundleId, status: "draft",
    createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
    build: { ...(archive.version ? { version: archive.version } : {}), ...(archive.buildNumber ? { number: archive.buildNumber } : {}), hash: archive.sha256, source: "local" },
    environment: { deviceModel: device }, limits }, artifacts: [], screens: [], variants: [], observations: [], elements: [], actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [] };
  try {
    let installPath = archive.path;
    if (archive.kind === "ios-tgz" || archive.kind === "ios-ipa") { say("unpacking the iOS bundle"); installPath = await extractIosBundle(archive, join(work, "bundle")); }
    const appIcon = await readArchiveIcon(archive);
    const exploreOn = (connection: SimulatorConnection, sessionJson: () => string, localDevice?: LocalDevice, afterInstall?: () => void) => exploreConnectedSession({ connection, platform, device, bundleId,
      ...(afterInstall ? { afterInstall } : {}),
      ...(appIcon ? { appIcon } : {}), app: { name: archive.appName, ...(archive.version ? { version: archive.version } : {}) },
      // A local device has the app installed by simctl or adb before the controller starts.
      ...(localDevice ? { local: localDevice } : { install: { path: installPath, kind: archive.kind } }),
      work, runner, environment, secrets: [environment.EXPO_TOKEN ?? "", connection.daemonAuthToken, ...inputs.values].filter(Boolean), inputs, say, now, limits, store, map, strategy,
      urlSchemes: archive.urlSchemes, sessionJson,
      ...(options.launchUrl ? { launchUrl: options.launchUrl } : {}), ...(options.hints ? { hints: options.hints } : {}), ...(options.allowDestructive ? { allowDestructive: options.allowDestructive } : {}) });
    if (local) {
      const tag = map.run.id.replace(/-/g, "").slice(0, 8);
      await withLocalDevice({ archive, installPath, platform, device, bundleId, controller, tag, work, runner, environment, say, secrets: inputs.values, ...(options.now ? { now: options.now } : {}) },
        async (connection, localDevice) => {
          sessionId = connection.sessionId;
          ({ runtime, exploration } = await exploreOn(connection, () => "", localDevice));
        });
    } else {
      if (!owner) {
        const who = eas(["whoami"], 60_000);
        owner = who.status === 0 ? whoamiAccounts(who.stdout)[0] ?? "" : "";
        if (!owner) throw binaryError("EXPO_LOGIN_REQUIRED", "EAS did not report an account for this login.", "Run `eas login` (or set EXPO_TOKEN) and rerun, or pass --owner.");
      }
      await writeFile(join(work, "package.json"), JSON.stringify({ name: project, version: "0.0.0", private: true }), { mode: 0o600 });
      await writeFile(join(work, "app.json"), JSON.stringify({ expo: { name: project, slug: project, owner, web: { output: "server" } } }), { mode: 0o600 });
      const init = eas(["init", "--force", "--non-interactive", "--json"], 2 * 60_000);
      const appJson = JSON.parse(await readFile(join(work, "app.json"), "utf8")) as { expo?: { extra?: { eas?: { projectId?: string } } } };
      const projectId = appJson.expo?.extra?.eas?.projectId;
      if (init.status !== 0 || !projectId) throw binaryError("EXPLORE_PROJECT_FAILED", `EAS could not create or link @${owner}/${project}: ${lastLine(init.stderr || init.stdout)}`,
        "Give this login permission to create projects under the owner, or pass --project with an existing slug.", { owner, project });
      const projectIdentity = { name: project, slug: project, owner, projectId };

      say(`starting an EAS Simulator session (${device}, ${limits.maxDurationMinutes} min)`);
      const sessionName = `explore-binary-${createHash("sha256").update(`${archive.sha256}:${map.run.id}`).digest("hex").slice(0, 16)}`;
      const dotenvPath = join(work, SIMULATOR_DOTENV_FILE_NAME);
      await writeFile(dotenvPath, SIMULATOR_DOTENV_HEADER, { flag: "wx", mode: 0o600 });
      let startError: unknown;
      try {
        const started = eas(["simulator:start", "--name", sessionName, "--platform", platform, "--device", device, "--type", controller, "--package-version", controllerVersion(controller), "--public-link",
          "--max-duration-minutes", String(limits.maxDurationMinutes + 5), "--out-config-type", "dotenv", "--non-interactive"], 20 * 60_000);
        if (started.status !== 0) throw new Error(started.stderr || started.stdout || "eas simulator:start failed");
      } catch (error) { startError = error; }
      const handoff = await readSimulatorDotenvHandoff(dotenvPath);
      const secrets = [environment.EXPO_TOKEN ?? "", ...(handoff.connection ? [handoff.connection.daemonAuthToken] : []), ...inputs.values].filter(Boolean);
      const startFailure = startError ? simulatorStartFailure(startError, secrets) : undefined;
      if (handoff.sessionId) {
        try { assertSimulatorSessionIdentity(eas(["simulator:get", "--id", handoff.sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout, handoff.sessionId, sessionName, projectIdentity, handoff.connection, platform); }
        catch (error) { throw new CiError({ code: "SESSION_HANDOFF_UNVERIFIED", stage: "session", message: "The EAS handoff could not prove ownership of the exact simulator session. The private handoff was preserved.",
          nextAction: "Inspect the EAS session list; confirm ownership before stopping the reported session.", details: { handoffDirectory: work, reportedSessionId: handoff.sessionId, ...(startFailure ? { startFailure } : {}) }, cause: error }); }
        sessionId = handoff.sessionId;
      }
      if (!sessionId) throw new CiError({ code: startFailure ? "SIMULATOR_START_FAILED" : "SESSION_HANDOFF_UNVERIFIED", stage: "session",
        message: startFailure ? `EAS simulator:start failed: ${startFailure.message}` : "EAS did not provide a verifiable simulator session.",
        nextAction: "Inspect the EAS start failure and session list; verify a session's exact ID and ownership before cleanup.", details: { handoffDirectory: work, ...(startFailure ? { startFailure } : {}) }, cause: startError });
      if (startFailure) throw new CiError({ code: "SIMULATOR_START_FAILED", stage: "session", message: `EAS simulator:start failed after the session was verified: ${startFailure.message}`,
        nextAction: "Inspect the start failure; Explore stops the verified session before returning.", details: { sessionId, startFailure }, cause: startError });
      if (handoff.validationError) throw handoff.validationError;
      if (!handoff.connection) throw new Error("Simulator handoff is missing its controller connection");
      await rm(dotenvPath, { force: true });
      // The app's own links open without iOS asking first, when the session's host can approve them (serve-sim 0.10.0).
    const verifiedSession = sessionId;
    const sessionEas: EasCommand = (args, commandOptions) => {
      const result = eas(args, commandOptions?.timeoutMs);
      if (result.status !== 0 && !commandOptions?.allowFailure) throw new Error(lastLine(result.stderr || result.stdout) || `eas ${args[0]} failed`);
      return result;
    };
    const afterInstall = platform === "ios" && archive.urlSchemes.length ? () => {
      const approved = approveSessionUrlSchemes(sessionEas, verifiedSession, simulatorControlActions(sessionEas, verifiedSession), bundleId, archive.urlSchemes);
      if (approved.length) say(`approved ${approved.map(item => `${item}://`).join(", ")} links on the session`);
    } : undefined;
    ({ runtime, exploration } = await exploreOn(handoff.connection, () => eas(["simulator:get", "--id", handoff.connection!.sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout, undefined, afterInstall));
    }
  } catch (error) {
    primaryError = toCiError(error, { code: "EXPLORE_BINARY_FAILED", stage: "exploration", nextAction: "Inspect the diagnostic, correct the failing prerequisite, and rerun explore:binary." });
  } finally {
    // A local device is stopped by withLocalDevice; only the work directory is left.
    if (local) await rm(work, { recursive: true, force: true });
    else if (sessionId) {
      try {
        say(`stopping simulator session ${sessionId}`);
        assertSimulatorStopped(eas(["simulator:stop", "--id", sessionId, "--json", "--non-interactive"], 2 * 60_000).stdout, sessionId);
        await rm(work, { recursive: true, force: true });
      } catch (error) {
        throw new CiError({ code: "SESSION_CLEANUP_FAILED", stage: "cleanup", message: "The exact EAS session could not be confirmed stopped.", nextAction: `Stop EAS Simulator session ${sessionId} (eas simulator:stop --id ${sessionId}) and verify its status.`,
          details: { sessionId, ...(primaryError ? { originalFailure: serializeCiError(primaryError, { secrets: [environment.EXPO_TOKEN ?? "", ...inputs.values] }) } : {}) }, cause: error });
      }
    } else await rm(work, { recursive: true, force: true });
  }
  if (primaryError) throw primaryError;
  return { outputDirectory, mapPath: store.mapPath, archive, session: { id: sessionId!, platform, device, owner, project }, runtime: runtime!,
    model: { provider: strategy.provider, model: strategy.model, auth: strategy.auth }, exploration: exploration!, durationMs: Date.now() - startedAt };
}

function lastLine(text: string): string { return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""; }
function redactSecrets(text: string, secrets: readonly string[]): string { return secrets.reduce((value, secret) => secret ? value.split(secret).join("[REDACTED]") : value, text); }

async function easLoggedIn(runner: typeof defaultRunner, environment: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const bin = packageBin("eas-cli", "eas");
    await lstat(bin);
    runner({ command: process.execPath, args: [bin, "whoami"], cwd: tmpdir(), environment: { ...baseEnvironment(environment), ...(environment.HOME ? { HOME: environment.HOME } : {}), CI: "1", EXPO_NO_TELEMETRY: "1" }, timeoutMs: 60_000 });
    return true;
  } catch { return false; }
}

const RUNNER_BUSY = /still finishing a previous command/i;
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * After a command overruns its watchdog (an accessibility capture of a heavy animation, say) the iOS runner refuses
 * the next ones until it has wound down. That is a wait, not a failed action: retry until it answers or the budget ends.
 */
export function retryWhileBusy<T>(run: () => T, pause: (ms: number) => void, budgetMs = 90_000, stepMs = 5_000, clock: () => number = Date.now): T {
  const started = clock();
  for (;;) {
    try { return run(); }
    catch (error) {
      if (!RUNNER_BUSY.test(error instanceof Error ? error.message : String(error)) || clock() - started >= budgetMs) throw error;
      pause(stepMs);
    }
  }
}

export const BLANK_SCREENSHOT_MESSAGE = "The app blocks screen capture on this screen (Android FLAG_SECURE), so its screenshot came back blank.";

export { solidColour };

/** Setup commands whose last positional is free text (`fill <ref> <text>`, `type <text>`): move the flags ahead of a `--` separator. */
export function guardPositionals(args: readonly string[]): string[] {
  if (args[0] !== "fill" && args[0] !== "type") return [...args];
  const flags: string[] = [], positionals: string[] = [args[0]];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--level" || arg === "--settle") { flags.push(arg, args[++index] ?? ""); continue; }
    if (arg.startsWith("--") && positionals.length === 1 + (args[0] === "fill" ? 2 : 1)) { flags.push(arg); continue; }
    positionals.push(arg);
  }
  return [positionals[0]!, ...flags, "--", ...positionals.slice(1)];
}

const KEYBOARD_RETURN_KEY = /^(return|next|done|go|continue|join)$/i;

/**
 * How a frame's screenshot is stored. An opened (or half-open) iPhone Duo lights its inner panel, whose native axes are
 * portrait, and shows a landscape UI on it: the tree and taps stay on the portrait axes (a 669×951 pt root, the transpose
 * of `DUO_PANELS.inner`), and a screenshot on those axes is sideways to a person, so it is turned ("turn"). Local
 * agent-device runs returned exactly that (2007×2853 px). Capture's Argent screenshots on EAS, taken with Argent's
 * LandscapeRight rotation, came back upright (2853×2007); an image that is already the root's transpose is left as it is.
 * The root is the full-screen Application node capture takes its coordinate space from, matched to within a pixel and a
 * point. A Duo frame on neither panel is "unmatched": it is stored as taken, and the caller says so. An empty tree, read
 * mid-draw, has nothing to judge.
 */
export function duoScreenshotTurn(frame: { platform: Platform; deviceModel: string; nodes: readonly Record<string, unknown>[]; width: number; height: number }): "turn" | "keep" | "unmatched" {
  if (frame.platform !== "ios" || !/\bduo\b/i.test(frame.deviceModel) || !frame.nodes.length) return "keep";
  const space = screenSpace(frame.nodes, frame, 1);
  if (!space) return "unmatched";
  const near = (value: number, points: number) => Math.abs(value - points) < 1;
  const portraitAxes = near(space.width, DUO_PANELS.inner.height) && near(space.height, DUO_PANELS.inner.width);
  if (portraitAxes && !space.transposed && frame.width < frame.height) return "turn";
  const panel = Object.values(DUO_PANELS).some(({ width, height }) => (near(space.width, width) && near(space.height, height)) || (near(space.width, height) && near(space.height, width)));
  return panel ? "keep" : "unmatched";
}

/** A node that is not the app's UI: another package drew it (Android's system UI over the app), or it is Explore's own route marker, which an app
 * instrumented for PR runs renders as a 2x2 hidden text. */
export function foreignNode(node: Record<string, unknown>, bundleId: string): boolean {
  if (node.identifier === "expo-explore-observer") return true;
  if (typeof node.bundleId !== "string" || node.bundleId === "" || node.bundleId === bundleId) return false;
  // A runtime permission prompt ("Allow RoboSats to send you notifications?") is drawn by the permission controller over the
  // app, and the app's own window is not in the snapshot while it is up. Its nodes are the screen: without them the tree is
  // empty, a "Screen 1" with no controls is minted, and the model cannot see Allow / Don't allow.
  return !SYSTEM_DIALOG_PACKAGES.has(node.bundleId);
}

function frameBounds(nodes: readonly Record<string, unknown>[]): { width: number; height: number } {
  let width = 0, height = 0;
  for (const node of nodes) {
    const rect = node.rect && typeof node.rect === "object" ? node.rect as Record<string, unknown> : undefined;
    if (!rect || typeof rect.x !== "number" || typeof rect.width !== "number" || typeof rect.y !== "number" || typeof rect.height !== "number") continue;
    width = Math.max(width, rect.x + rect.width); height = Math.max(height, rect.y + rect.height);
  }
  if (!width || !height) throw binaryError("AGENT_COORDINATE_INVALID", "The screen size is unknown; use a labelled control instead of coordinates.", "Tap by label or identifier.");
  return { width, height };
}
