import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { toCiError, serializeCiError, CiError } from "../shared/ci-errors.js";
import { isRecord, parseJson, baseEnvironment, AGENT_DEVICE_VERSION, CONTROLLER_SESSION, EAS_CLI_VERSION } from "./common.js";
import { ARGENT_VERSION } from "../shared/argent-version.js";
import { SIMULATOR_PREVIEW_HOST, framedSimulatorPreviewServer } from "../shared/simulator-preview.js";
import { lstatIfExists } from "./fs-safety.js";
import { defaultRunner, openedSimulatorDevice, controllerData } from "./controller.js";
import type { RepackProfile } from "./eas-build.js";
import type { SimulatorRuntimeMetadata, CiMapOptions } from "./run.js";
import type { Platform } from "../types.js";

/**
 * How Explore reaches a session's device controller. For agent-device (no `controller`) these are the daemon's URL and
 * token; for Argent they are the tool-server's `ARGENT_TOOLS_URL` and `ARGENT_AUTH_TOKEN`, whose token may be empty.
 */
export type SimulatorConnection = { sessionId: string; daemonBaseUrl: string; daemonAuthToken: string; controller?: "argent" };

/** The controller a connection reaches: the session `--type` EAS started. */
export function connectionController(connection: Pick<SimulatorConnection, "controller">): "agent-device" | "argent" {
  return connection.controller ?? "agent-device";
}

/** The controller's pinned version: what EAS installs on the session (`--package-version`) and what runs here. */
export function controllerVersion(controller: "agent-device" | "argent"): string {
  return controller === "argent" ? ARGENT_VERSION : AGENT_DEVICE_VERSION;
}
export type ActiveSimulatorRuntime = Omit<SimulatorRuntimeMetadata, "sessionLifecycle"> & { controllerDeviceId: string };
const SIMULATOR_SESSION_NAME_MAX_CHARACTERS = 50;
const SIMULATOR_SESSION_DIGEST_CHARACTERS = 20;
export const SIMULATOR_DOTENV_FILE_NAME = ".env.eas-simulator";
const SIMULATOR_DOTENV_MAX_BYTES = 32 * 1024;
export const SIMULATOR_DOTENV_HEADER = "# Do not commit this file.\n"
  + "# Do not modify these values manually. They are managed by eas-cli.\n"
  + "# It holds configuration only for the current simulator session.\n\n";

export function simulatorSessionName(options: {
  mapName: string;
  mapId: string;
  gitCommit: string;
  easBuildId: string;
  runIdentity: string;
}): string {
  const prefix = "Explore map: ";
  const digest = createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      mapName: options.mapName,
      mapId: options.mapId,
      gitCommit: options.gitCommit,
      easBuildId: options.easBuildId,
      runIdentity: options.runIdentity,
    }))
    .digest("base64url")
    .slice(0, SIMULATOR_SESSION_DIGEST_CHARACTERS);
  const suffix = ` [${digest}]`;
  const normalizedName = options.mapName.trim().replace(/\s+/gu, " ");
  const availableCharacters = SIMULATOR_SESSION_NAME_MAX_CHARACTERS
    - Array.from(prefix).length
    - Array.from(suffix).length;
  const boundedName = Array.from(normalizedName)
    .slice(0, availableCharacters)
    .join("")
    .trimEnd();
  return `${prefix}${boundedName}${suffix}`;
}

function simulatorSessionId(value: unknown, command = "eas simulator:start"): string {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error(`${command} did not return a session id`);
  }
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(value.id)) {
    throw new Error(`${command} returned an unsafe session id`);
  }
  return value.id;
}

function simulatorConnection(
  sessionId: string,
  daemonBaseUrl: unknown,
  daemonAuthToken: unknown,
  controller: "agent-device" | "argent" = "agent-device",
): SimulatorConnection {
  // An Argent tool-server may run without a token (ARGENT_AUTH_TOKEN is only set when it needs one).
  if (controller === "argent" && daemonAuthToken === undefined) daemonAuthToken = "";
  if (
    typeof daemonBaseUrl !== "string"
    || typeof daemonAuthToken !== "string"
    || !daemonBaseUrl
    || (!daemonAuthToken && controller !== "argent")
    || daemonBaseUrl.length > 2_048
    || daemonAuthToken.length > 8_192
    || /[\u0000-\u001f\u007f]/.test(daemonBaseUrl)
    || /[\u0000-\u001f\u007f]/.test(daemonAuthToken)
  ) {
    throw new Error(`eas simulator:start returned an unsafe ${controller} connection`);
  }
  remoteDaemonDomain(daemonBaseUrl, controller);
  return {
    sessionId,
    daemonBaseUrl,
    daemonAuthToken,
    ...(controller === "argent" ? { controller } : {}),
  };
}

type SimulatorDotenvHandoff = {
  sessionId?: string;
  connection?: SimulatorConnection;
  validationError?: Error;
};

/** Preserve actionable start errors, never a command's private handoff or connection output. */
export function simulatorStartFailure(error: unknown, secrets: readonly string[]) {
  const source = toCiError(error, { code: "EAS_SIMULATOR_START_COMMAND_FAILED", stage: "session" });
  // CLI failures can quote a JSON error inside another JSON string. Normalize only
  // escaped delimiters before redaction; never deserialize arbitrary error objects.
  const failure = serializeCiError(new CiError({ code: source.code, stage: "session",
    message: source.message.replace(/\\+(["'/])/g, "$1"),
    nextAction: "Inspect the EAS simulator start failure." }), { secrets });
  const message = failure.message
    .replace(/\b(?:AGENT_DEVICE_[A-Z_]+|ARGENT_[A-Z_]+|EAS_SIMULATOR_[A-Z_]+|EXPO_TOKEN|agentDeviceRemoteSession(?:Token|Url)|toolsUrl|toolsAuthToken|webPreviewUrl|previewApiUrl)["']?\s*[:=][^\r\n]*/g, "[REDACTED_HANDOFF]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g, "[REDACTED_URL]")
    .slice(0, 1600);
  return { code: failure.code, stage: "session", message,
    nextAction: "Inspect the EAS start rejection and verify session ownership before cleanup or another capture attempt.", retryable: false };
}

const EGRESS_ASSIGNMENTS = new Set([
  "EAS_SIMULATOR_EGRESS_URL",
  "EAS_SIMULATOR_EGRESS_TOKEN",
  "EAS_SIMULATOR_EGRESS_FINGERPRINT",
  "EAS_SIMULATOR_EGRESS_PORT",
  "EAS_SIMULATOR_EGRESS_ALLOW",
  "EAS_SIMULATOR_EGRESS_PLATFORM",
]);

export async function readSimulatorDotenvHandoff(path: string): Promise<SimulatorDotenvHandoff> {
  const info = await lstatIfExists(path);
  if (!info) return {};
  if (info.isSymbolicLink() || !info.isFile() || info.size > SIMULATOR_DOTENV_MAX_BYTES) {
    return { validationError: new Error("EAS Simulator dotenv handoff is not a safe regular file") };
  }
  if (
    typeof process.getuid === "function"
    && info.uid !== process.getuid()
  ) {
    return { validationError: new Error("EAS Simulator dotenv handoff has an unexpected owner") };
  }
  const contents = await readFile(path, "utf8");
  if (!contents.startsWith(SIMULATOR_DOTENV_HEADER)) {
    return { validationError: new Error("EAS Simulator dotenv handoff has an invalid header") };
  }
  const assignments: Record<string, string> = Object.create(null);
  const seenAssignments = new Set<string>();
  let validationError: Error | undefined;
  for (const line of contents.slice(SIMULATOR_DOTENV_HEADER.length).split("\n")) {
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)='([^'\r\n]*)'$/.exec(line);
    if (!match) {
      validationError ??= new Error("EAS Simulator dotenv handoff contains a malformed assignment");
      continue;
    }
    const name = match[1]!;
    // `--egress local` adds the egress client's settings; they belong to `eas simulator:egress`, not to Explore.
    if (EGRESS_ASSIGNMENTS.has(name)) continue;
    if (![
      "EAS_SIMULATOR_SESSION_ID",
      "AGENT_DEVICE_DAEMON_BASE_URL",
      "AGENT_DEVICE_DAEMON_AUTH_TOKEN",
      "ARGENT_TOOLS_URL",
      "ARGENT_AUTH_TOKEN",
    ].includes(name)) {
      validationError ??= new Error("EAS Simulator dotenv handoff contains an unexpected assignment");
      continue;
    }
    if (seenAssignments.has(name)) {
      validationError ??= new Error("EAS Simulator dotenv handoff contains a duplicate assignment");
      if (name === "EAS_SIMULATOR_SESSION_ID") {
        delete assignments.EAS_SIMULATOR_SESSION_ID;
      }
      continue;
    }
    seenAssignments.add(name);
    assignments[name] = match[2]!;
  }
  let sessionId: string | undefined;
  if (assignments.EAS_SIMULATOR_SESSION_ID !== undefined) {
    try {
      sessionId = simulatorSessionId(
        { id: assignments.EAS_SIMULATOR_SESSION_ID },
        "eas simulator:start dotenv handoff",
      );
    } catch (error) {
      validationError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  let connection: SimulatorConnection | undefined;
  if (sessionId) {
    try {
      // An `argent` session writes the Argent tool-server's variables instead of agent-device's.
      connection = assignments.ARGENT_TOOLS_URL !== undefined
        ? simulatorConnection(sessionId, assignments.ARGENT_TOOLS_URL, assignments.ARGENT_AUTH_TOKEN, "argent")
        : simulatorConnection(
          sessionId,
          assignments.AGENT_DEVICE_DAEMON_BASE_URL,
          assignments.AGENT_DEVICE_DAEMON_AUTH_TOKEN,
        );
    } catch (error) {
      validationError ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(connection ? { connection } : {}),
    ...(validationError ? { validationError } : {}),
  };
}

export function assertSimulatorSessionIdentity(
  stdout: string,
  expectedSessionId: string,
  expectedSessionName: string,
  expectedProject: RepackProfile["projectIdentity"],
  expectedConnection?: SimulatorConnection,
  expectedPlatform: Platform = "ios",
): void {
  const value = parseJson(stdout, "eas simulator:get");
  const sessionId = simulatorSessionId(value, "eas simulator:get");
  if (
    sessionId !== expectedSessionId
    || !isRecord(value)
    || value.name !== expectedSessionName
    || value.type !== (expectedConnection ? connectionController(expectedConnection) : "agent-device")
    || value.platform !== expectedPlatform.toUpperCase()
    || value.status !== "IN_PROGRESS"
  ) {
    throw new Error("eas simulator:get did not prove the exact expected simulator session");
  }
  if (!sessionProjectProven(value, expectedSessionId, expectedProject)) {
    throw new Error("eas simulator:get did not prove the exact expected simulator session");
  }
  if (expectedConnection && !remoteConfigMatches(value.remoteConfig, expectedConnection)) {
    throw new Error(`eas simulator:get returned a different ${connectionController(expectedConnection)} connection`);
  }
}

/**
 * eas-cli 22.4.0 omits the `app` record; its `deviceRunSessionUrl` still binds the session to one exact owner and
 * slug, so either proof is accepted but never neither.
 */
function sessionProjectProven(value: Record<string, unknown>, sessionId: string, project: RepackProfile["projectIdentity"]): boolean {
  const expectedSessionUrl = `https://expo.dev/accounts/${project.owner}/projects/${project.slug}/simulator-sessions/${sessionId}`;
  return isRecord(value.app)
    ? value.app.id === project.projectId && value.app.slug === project.slug && isRecord(value.app.ownerAccount) && value.app.ownerAccount.name === project.owner
    : value.deviceRunSessionUrl === expectedSessionUrl;
}

/**
 * The status (ERRORED or STOPPED) of a session `eas simulator:get` shows EAS ended before Explore could use it, when it
 * is provably this capture's own: the exact id, name, type, platform and project. Only such a session is replaced by a
 * new one; anything less certain (undefined here) stays a handoff failure.
 */
export function endedOwnSimulatorSession(stdout: string, expected: { sessionId: string; sessionName: string; project: RepackProfile["projectIdentity"];
  type: "agent-device" | "argent"; platform: Platform }): "ERRORED" | "STOPPED" | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  return isRecord(value) && value.id === expected.sessionId && value.name === expected.sessionName && value.type === expected.type
    && value.platform === expected.platform.toUpperCase() && (value.status === "ERRORED" || value.status === "STOPPED")
    && sessionProjectProven(value, expected.sessionId, expected.project) ? value.status : undefined;
}

/**
 * This project's sessions with exactly this name that EAS may still be starting or running, from
 * `eas simulator:list --json`: their ids when every one is provably this project's, or undefined when the listing
 * cannot be read or a session by that name cannot be proven Explore's, so a caller never assumes none exist.
 */
export function liveSimulatorSessionsNamed(stdout: string, sessionName: string, project: RepackProfile["projectIdentity"]): string[] | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!isRecord(value) || !Array.isArray(value.sessions)) return undefined;
  const live = new Set(["NEW", "QUEUED", "STARTING", "IN_PROGRESS"]);
  const named = value.sessions.filter((session): session is Record<string, unknown> => isRecord(session) && session.name === sessionName && live.has(String(session.status)));
  if (named.some(session => typeof session.id !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(session.id) || !sessionProjectProven(session, session.id, project))) return undefined;
  return named.map(session => session.id as string);
}

/** The session's published controller endpoint is the one Explore holds: agent-device's daemon, or Argent's tool-server. */
function remoteConfigMatches(remoteConfig: unknown, connection: SimulatorConnection): boolean {
  if (!isRecord(remoteConfig)) return false;
  return connectionController(connection) === "argent"
    ? remoteConfig.toolsUrl === connection.daemonBaseUrl && (remoteConfig.toolsAuthToken ?? "") === connection.daemonAuthToken
    : remoteConfig.agentDeviceRemoteSessionUrl === connection.daemonBaseUrl && remoteConfig.agentDeviceRemoteSessionToken === connection.daemonAuthToken;
}

/**
 * A session Explore did not start: the connection comes from `eas simulator:start --out-config-type dotenv`
 * (`.env.eas-simulator`) or from the `EAS_SIMULATOR_SESSION_ID` / `AGENT_DEVICE_DAEMON_*` variables that
 * `eas simulator:exec` exports. Explore never stops such a session.
 */
export async function resolveAttachedSimulatorSession(
  environment: NodeJS.ProcessEnv,
  dotenvPath: string | undefined,
  requestedSessionId?: string,
): Promise<SimulatorConnection> {
  if (dotenvPath !== undefined) {
    const handoff = await readSimulatorDotenvHandoff(dotenvPath);
    if (handoff.validationError) throw handoff.validationError;
    if (!handoff.connection) throw new Error(`${dotenvPath} does not describe an EAS Simulator session`);
    if (requestedSessionId && handoff.connection.sessionId !== requestedSessionId) {
      throw new Error(`${dotenvPath} describes session ${handoff.connection.sessionId}, not ${requestedSessionId}`);
    }
    return handoff.connection;
  }
  const sessionId = simulatorSessionId(
    { id: requestedSessionId ?? environment.EAS_SIMULATOR_SESSION_ID },
    "EAS_SIMULATOR_SESSION_ID",
  );
  if (requestedSessionId && environment.EAS_SIMULATOR_SESSION_ID && environment.EAS_SIMULATOR_SESSION_ID !== requestedSessionId) {
    throw new Error(`EAS_SIMULATOR_SESSION_ID is ${environment.EAS_SIMULATOR_SESSION_ID}, not ${requestedSessionId}`);
  }
  return environment.ARGENT_TOOLS_URL !== undefined && environment.AGENT_DEVICE_DAEMON_BASE_URL === undefined
    ? simulatorConnection(sessionId, environment.ARGENT_TOOLS_URL, environment.ARGENT_AUTH_TOKEN, "argent")
    : simulatorConnection(sessionId, environment.AGENT_DEVICE_DAEMON_BASE_URL, environment.AGENT_DEVICE_DAEMON_AUTH_TOKEN);
}

/** Proves an attached session is live, agent-device typed, and served by the connection we hold; returns its platform. */
export function assertAttachedSimulatorSession(
  stdout: string,
  connection: SimulatorConnection,
  expectedPlatform?: Platform,
): { platform: Platform; name: string; deviceRunSessionUrl?: string } {
  const value = parseJson(stdout, "eas simulator:get");
  const sessionId = simulatorSessionId(value, "eas simulator:get");
  if (sessionId !== connection.sessionId || !isRecord(value) || value.type !== connectionController(connection)) {
    throw new Error(`eas simulator:get did not describe the attached ${connectionController(connection)} session`);
  }
  if (value.status !== "IN_PROGRESS") {
    throw new Error(`EAS Simulator session ${sessionId} is ${String(value.status).toLowerCase()}, not in progress`);
  }
  const platform = value.platform === "IOS" ? "ios" : value.platform === "ANDROID" ? "android" : undefined;
  if (!platform || (expectedPlatform && platform !== expectedPlatform)) {
    throw new Error(`EAS Simulator session ${sessionId} is ${String(value.platform).toLowerCase()}${expectedPlatform ? `, not ${expectedPlatform}` : ""}`);
  }
  if (!remoteConfigMatches(value.remoteConfig, connection)) {
    throw new Error(`eas simulator:get returned a different ${connectionController(connection)} connection than the one provided`);
  }
  return {
    platform,
    name: typeof value.name === "string" ? value.name : sessionId,
    ...(typeof value.deviceRunSessionUrl === "string" ? { deviceRunSessionUrl: value.deviceRunSessionUrl } : {}),
  };
}

export function assertSimulatorStopped(stdout: string, expectedSessionId: string): void {
  const value = parseJson(stdout, "eas simulator:stop");
  const stoppedSessionId = simulatorSessionId(value, "eas simulator:stop");
  if (stoppedSessionId !== expectedSessionId) {
    throw new Error("eas simulator:stop returned a different session id");
  }
  if (!isRecord(value) || value.status !== "STOPPED") {
    throw new Error("eas simulator:stop did not report a stopped session");
  }
}

function remoteDaemonDomain(value: string, controller: "agent-device" | "argent" = "agent-device"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`eas simulator returned an invalid ${controller} URL`);
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !url.hostname
  ) {
    throw new Error(`eas simulator returned an unsafe ${controller} URL`);
  }
  return url.hostname;
}

export function collectRuntime(options: CiMapOptions & { platform: NonNullable<CiMapOptions["platform"]> }, environment: NodeJS.ProcessEnv,
  /** The local simulator (UDID) or emulator (adb serial) Explore started; absent for an EAS session. */
  local?: { id: string }): ActiveSimulatorRuntime {
  const runner = options.runner ?? defaultRunner;
  const controller = options.controller ?? "agent-device";
  const version = runner({ command: options.agentDeviceCommand, args: ["--version"], cwd: options.project,
    environment: controller === "argent" ? environment : baseEnvironment(options.environment ?? process.env), timeoutMs: 30_000 }).stdout.trim();
  if (version !== controllerVersion(controller)) throw new Error(`${controller} version must be ${controllerVersion(controller)}`);
  const opened = runner({ command: options.agentDeviceCommand,
    args: ["open", options.bundleId, "--session", CONTROLLER_SESSION,
      ...(local ? [options.platform === "ios" ? "--udid" : "--serial", local.id] : options.platform === "ios" ? ["--device", options.device] : []),
      "--platform", options.platform, "--level", "full", "--json"], cwd: options.project, environment,
    // Argent's first call can wait for a tool-server that is still starting, then relaunch the app until it is readable.
    // A local simulator's first open also builds agent-device's XCTest runner, once per agent-device release.
    timeoutMs: controller === "argent" ? 180_000 : local ? 15 * 60_000 : 60_000 });
  const device = openedSimulatorDevice(opened.stdout, options.bundleId, "initial app open", options.platform);
  if (local && device.deviceId !== local.id) throw new CiError({ code: "DEVICE_MISMATCH", stage: "runtime",
    message: `agent-device opened ${device.deviceId} instead of the device Explore started (${local.id}).`,
    nextAction: "Rerun capture; if it happens again, check xcrun simctl list devices for leftover Explore simulators." });
  // A local simulator is named for Explore; its model is the configured device it was created as.
  if (!local && options.platform === "ios" && device.deviceModel !== options.device) throw new CiError({ code: "DEVICE_MISMATCH", stage: "runtime",
    message: `EAS opened ${device.deviceModel} instead of the configured ${options.device}.`,
    nextAction: "Select an available exact device name in config.yaml and rerun capture." });
  const data = controllerData(opened.stdout, "initial app open");
  const deviceData = isRecord(data.device) ? data.device : {};
  const observed = (key: string): string => {
    const value = deviceData[key] ?? data[key];
    return typeof value === "string" && value.trim() ? value : "unknown";
  };
  return { provider: local ? "local-simulator" : "eas-simulator", controller, controllerPackageVersion: controllerVersion(controller),
    easCliVersion: EAS_CLI_VERSION, platform: options.platform, controllerDeviceId: device.deviceId, deviceModel: local ? options.device : device.deviceModel,
    osVersion: observed("osVersion"), locale: observed("locale"),
    orientation: observed("orientation") === "landscape" ? "landscape" : "portrait",
    colorScheme: observed("colorScheme") === "light" ? "light" : observed("colorScheme") === "dark" ? "dark" : "system" };
}

/**
 * agent-device drops the simulator runtime from its device record, so `open` never names the iOS version.
 * The session's preview server lists each simulator with its runtime (`iOS-26-5`), keyed by the same UDID.
 * EAS publishes that server either directly or as an expo.dev page that frames it
 * (see framedSimulatorPreviewServer).
 */
export async function simulatorOsVersion(session: string, deviceId: string, transport: typeof fetch, platform: "ios" | "android" = "ios"): Promise<string> {
  const value = parseJson(session, "eas simulator:get");
  const remote = isRecord(value) && isRecord(value.remoteConfig) ? value.remoteConfig : {};
  // eas-cli 25 publishes the preview server itself as previewApiUrl, with the token in its query, but only for a
  // session started with --public-link; its webPreviewUrl is then an expo.dev page with the token in the fragment.
  // Earlier versions folded the token into webPreviewUrl's query. A private session's output has no token at all.
  const published = typeof remote.previewApiUrl === "string" ? remote.previewApiUrl : remote.webPreviewUrl;
  if (typeof published !== "string") throw new Error("EAS did not publish the simulator preview URL");
  const preview = new URL(published);
  if (preview.protocol !== "https:" || preview.username || preview.password) throw new Error("The simulator preview URL is not HTTPS");
  // The catalog takes the preview token as a bearer credential.
  const token = preview.searchParams.get("token") ?? new URLSearchParams(preview.hash.slice(1)).get("token");
  const catalog = new URL(framedSimulatorPreviewServer(preview) ?? preview.origin);
  if (!SIMULATOR_PREVIEW_HOST.test(catalog.hostname)) throw new Error(`The simulator preview URL names no preview server: ${preview.origin}${preview.pathname}`);
  // The iOS preview server lists simulators at /grid/api; the Android one has no grid and lists
  // its emulators at /api/devices as { emulators: [{ id, version: "Android 15.0" }] }.
  if (platform === "android") catalog.pathname = "/api/devices";
  else { catalog.pathname = "/grid/api"; catalog.searchParams.set("limit", "1000"); }
  const response = await transport(catalog, { headers: token ? { authorization: `Bearer ${token}` } : {},
    redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The simulator catalog failed (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error("The simulator catalog is too large");
  const data = parseJson(text, "simulator catalog");
  const device = platform === "android"
    ? isRecord(data) && Array.isArray(data.emulators)
      ? data.emulators.find(item => isRecord(item) && item.id === deviceId) : undefined
    : isRecord(data) && Array.isArray(data.devices)
      ? data.devices.find(item => isRecord(item) && item.device === deviceId) : undefined;
  const version = isRecord(device)
    ? platform === "android" ? androidVersion(device.version) : runtimeVersion(device.runtime) : undefined;
  if (!version) throw new Error("The simulator catalog did not name the device's OS runtime");
  return version;
}

/** "Android 15.0" → "15.0"; undefined for anything else. */
function androidVersion(version: unknown): string | undefined {
  const match = typeof version === "string" ? /^Android (\d+(?:\.\d+){0,2})$/.exec(version.trim()) : null;
  return match?.[1];
}

/** "iOS-26-5" → "26.5", "Android-16" / "android-36" → "16" / "36"; undefined for anything else. */
function runtimeVersion(runtime: unknown): string | undefined {
  const parts = typeof runtime === "string" ? /^(?:iOS|[Aa]ndroid)-(\d+(?:-\d+)*)$/.exec(runtime)?.[1]?.split("-") : undefined;
  return parts && parts.length <= 3 ? parts.join(".") : undefined;
}
