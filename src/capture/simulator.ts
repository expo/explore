import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { toCiError, serializeCiError, CiError } from "../shared/ci-errors.js";
import { isRecord, parseJson, baseEnvironment, AGENT_DEVICE_VERSION, CONTROLLER_SESSION, EAS_CLI_VERSION } from "./common.js";
import { SIMULATOR_PREVIEW_HOST, framedSimulatorPreviewServer } from "../shared/simulator-preview.js";
import { lstatIfExists } from "./fs-safety.js";
import { defaultRunner, openedSimulatorDevice, controllerData } from "./controller.js";
import type { RepackProfile } from "./eas-build.js";
import type { SimulatorRuntimeMetadata, CiMapOptions } from "./run.js";
import type { Platform } from "../types.js";

export type SimulatorConnection = { sessionId: string; daemonBaseUrl: string; daemonAuthToken: string };
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
): SimulatorConnection {
  if (
    typeof daemonBaseUrl !== "string"
    || typeof daemonAuthToken !== "string"
    || !daemonBaseUrl
    || !daemonAuthToken
    || daemonBaseUrl.length > 2_048
    || daemonAuthToken.length > 8_192
    || /[\u0000-\u001f\u007f]/.test(daemonBaseUrl)
    || /[\u0000-\u001f\u007f]/.test(daemonAuthToken)
  ) {
    throw new Error("eas simulator:start returned an unsafe agent-device connection");
  }
  remoteDaemonDomain(daemonBaseUrl);
  return {
    sessionId,
    daemonBaseUrl,
    daemonAuthToken,
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
    .replace(/\b(?:AGENT_DEVICE_[A-Z_]+|EAS_SIMULATOR_[A-Z_]+|EXPO_TOKEN|agentDeviceRemoteSession(?:Token|Url)|webPreviewUrl|previewApiUrl)["']?\s*[:=][^\r\n]*/g, "[REDACTED_HANDOFF]")
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
      connection = simulatorConnection(
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
    || value.type !== "agent-device"
    || value.platform !== expectedPlatform.toUpperCase()
    || value.status !== "IN_PROGRESS"
  ) {
    throw new Error("eas simulator:get did not prove the exact expected simulator session");
  }
  // eas-cli 22.4.0 omits the `app` record; its `deviceRunSessionUrl` still binds the session
  // to one exact owner and slug, so accept either proof but never neither.
  const expectedSessionUrl = `https://expo.dev/accounts/${expectedProject.owner}`
    + `/projects/${expectedProject.slug}/simulator-sessions/${expectedSessionId}`;
  const projectProven = isRecord(value.app)
    ? value.app.id === expectedProject.projectId
      && value.app.slug === expectedProject.slug
      && isRecord(value.app.ownerAccount)
      && value.app.ownerAccount.name === expectedProject.owner
    : value.deviceRunSessionUrl === expectedSessionUrl;
  if (!projectProven) {
    throw new Error("eas simulator:get did not prove the exact expected simulator session");
  }
  if (expectedConnection) {
    if (
      !isRecord(value.remoteConfig)
      || value.remoteConfig.agentDeviceRemoteSessionUrl !== expectedConnection.daemonBaseUrl
      || value.remoteConfig.agentDeviceRemoteSessionToken !== expectedConnection.daemonAuthToken
    ) {
      throw new Error("eas simulator:get returned a different agent-device connection");
    }
  }
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
  return simulatorConnection(sessionId, environment.AGENT_DEVICE_DAEMON_BASE_URL, environment.AGENT_DEVICE_DAEMON_AUTH_TOKEN);
}

/** Proves an attached session is live, agent-device typed, and served by the connection we hold; returns its platform. */
export function assertAttachedSimulatorSession(
  stdout: string,
  connection: SimulatorConnection,
  expectedPlatform?: Platform,
): { platform: Platform; name: string; deviceRunSessionUrl?: string } {
  const value = parseJson(stdout, "eas simulator:get");
  const sessionId = simulatorSessionId(value, "eas simulator:get");
  if (sessionId !== connection.sessionId || !isRecord(value) || value.type !== "agent-device") {
    throw new Error("eas simulator:get did not describe the attached agent-device session");
  }
  if (value.status !== "IN_PROGRESS") {
    throw new Error(`EAS Simulator session ${sessionId} is ${String(value.status).toLowerCase()}, not in progress`);
  }
  const platform = value.platform === "IOS" ? "ios" : value.platform === "ANDROID" ? "android" : undefined;
  if (!platform || (expectedPlatform && platform !== expectedPlatform)) {
    throw new Error(`EAS Simulator session ${sessionId} is ${String(value.platform).toLowerCase()}${expectedPlatform ? `, not ${expectedPlatform}` : ""}`);
  }
  if (
    !isRecord(value.remoteConfig)
    || value.remoteConfig.agentDeviceRemoteSessionUrl !== connection.daemonBaseUrl
    || value.remoteConfig.agentDeviceRemoteSessionToken !== connection.daemonAuthToken
  ) {
    throw new Error("eas simulator:get returned a different agent-device connection than the one provided");
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

function remoteDaemonDomain(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("eas simulator returned an invalid agent-device URL");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !url.hostname
  ) {
    throw new Error("eas simulator returned an unsafe agent-device URL");
  }
  return url.hostname;
}

export function collectRuntime(options: CiMapOptions & { platform: NonNullable<CiMapOptions["platform"]> }, environment: NodeJS.ProcessEnv): ActiveSimulatorRuntime {
  const runner = options.runner ?? defaultRunner;
  const version = runner({ command: options.agentDeviceCommand, args: ["--version"], cwd: options.project,
    environment: baseEnvironment(options.environment ?? process.env), timeoutMs: 30_000 }).stdout.trim();
  if (version !== AGENT_DEVICE_VERSION) throw new Error(`agent-device version must be ${AGENT_DEVICE_VERSION}`);
  const opened = runner({ command: options.agentDeviceCommand,
    args: ["open", options.bundleId, "--session", CONTROLLER_SESSION, ...(options.platform === "ios" ? ["--device", options.device] : []),
      "--platform", options.platform, "--level", "full", "--json"], cwd: options.project, environment, timeoutMs: 60_000 });
  const device = openedSimulatorDevice(opened.stdout, options.bundleId, "initial app open", options.platform);
  if (options.platform === "ios" && device.deviceModel !== options.device) throw new CiError({ code: "DEVICE_MISMATCH", stage: "runtime",
    message: `EAS opened ${device.deviceModel} instead of the configured ${options.device}.`,
    nextAction: "Select an available exact device name in config.yaml and rerun capture." });
  const data = controllerData(opened.stdout, "initial app open");
  const deviceData = isRecord(data.device) ? data.device : {};
  const observed = (key: string): string => {
    const value = deviceData[key] ?? data[key];
    return typeof value === "string" && value.trim() ? value : "unknown";
  };
  return { provider: "eas-simulator", controller: "agent-device", controllerPackageVersion: AGENT_DEVICE_VERSION,
    easCliVersion: EAS_CLI_VERSION, platform: options.platform, controllerDeviceId: device.deviceId, deviceModel: device.deviceModel,
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
