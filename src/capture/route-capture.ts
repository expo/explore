import { schemeScreenId, type ColorScheme } from "./appearance.js";
import { statusBarBandPercent } from "../contracts/capture.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, lstat, readFile, rm, mkdir, appendFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { assertDecodedPng, frameChangedForTap, type DecodedFrame } from "../shared/png-evidence.js";
import type { AgentAcceptedFrame, CaptureBundle } from "../contracts/capture.js";
import type { ExploreMap } from "../types.js";
import { ExploreStore, recordObservation } from "../map/store.js";
import { parseControllerOutput } from "./controller-output.js";
import type { SourceRoute } from "../contracts/source-route.js";
import { CiError, serializeCiError, toCiError } from "../shared/ci-errors.js";
import { type CaptureSetupSnapshot, credentialSavePromptDecline, describeSetupAction, executeCaptureSetup, isUnreadableSystemSurface, setupReadinessHolds } from "./setup-actions.js";
import { silentProgress } from "../shared/progress.js";
import { silentTimings, type Timings } from "../shared/timings.js";
import type { CaptureSetupReady } from "../config/explore-config.js";
import { READINESS_POLL_MS, defaultReadinessSeconds } from "./readiness.js";
import { KEYBOARD_POLL_MS, keyboardSettle, type KeyboardRead, type KeyboardSettle } from "./keyboard.js";
import { CAPTURE_OBSERVER_IDENTIFIER, captureObserverMarkers, parseCaptureDestination, captureDestinationMatches } from "./observer.js";
import { type CiAgentRuntimeOptions, runCiAgentNavigation, assertAgentCaptureContext } from "./agent/runtime.js";
import { createExplorationInputs } from "../config/exploration-inputs.js";
import { isRecord, captureError, CONTROLLER_SESSION, parseJson } from "./common.js";
import { MAX_ACCESSIBILITY_EVIDENCE_BYTES, adbDeviceOffline, remoteDaemonUnavailable, controllerData, defaultRunner, type ControllerReadRecovery, type RemoteDaemonRetry, runControllerRead, controllerCommandFailure, runControllerReadAsync, runAgentControllerCommand, wedgedControllerReadFailure, openedSimulatorDevice, alertWatchdogFailure } from "./controller.js";
import type { ActiveSimulatorRuntime, SimulatorConnection } from "./simulator.js";
import { androidTools } from "./local-simulator.js";
import type { CiMapOptions, CommandResult } from "./run.js";

/** iOS commands name the simulator; an EAS Android session has exactly one emulator, selected by the session. */
export function deviceArgs(runtime: Pick<ActiveSimulatorRuntime, "platform" | "deviceModel"> & Partial<Pick<ActiveSimulatorRuntime, "provider" | "controllerDeviceId">>): string[] {
  // A local simulator is picked by its UDID, a local emulator by its adb serial: this machine may run others of the same model.
  if (runtime.provider === "local-simulator" && runtime.controllerDeviceId) return [runtime.platform === "android" ? "--serial" : "--udid", runtime.controllerDeviceId];
  return runtime.platform === "android" ? [] : ["--device", runtime.deviceModel];
}

/** agent-device defers its XCTest snapshot tiers for 120 s; wait a little longer, polling every 5 s. */
const UNREADABLE_SURFACE_WAIT_MS = 130_000;
const UNREADABLE_SURFACE_POLL_MS = 5_000;

export function appScheme(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(candidate)
    || /^(?:https?|file|data|javascript|ftp|ws|wss)$/i.test(candidate)) {
    throw new CiError({ code: "INVALID_APP_SCHEME", stage: "configuration", message: "Capture requires an app-owned custom URL scheme.",
      nextAction: "Set app.scheme to the custom scheme registered by the application." });
  }
  return candidate;
}

export function captureDeepLink(scheme: string | undefined, route: SourceRoute): string | null {
  if (!scheme || !hasConcreteRoutePath(route)) return null;
  return `${appScheme(scheme)}://${route.path!.replace(/^\//, "")}`;
}

export function hasConcreteRoutePath(route: SourceRoute): boolean {
  return route.path !== null && !/\[[^\]]+\]|:[A-Za-z_]/.test(route.path);
}

export function unavailableRoute(route: SourceRoute): { status: "missing-params" | "unsupported-link"; reason: string } {
  const dynamic = /\[[^\]]+\]|:[A-Za-z_]/.test(route.path ?? route.route);
  return dynamic
    ? { status: "missing-params", reason: "Dynamic route parameters could not be resolved from source and config.parameters." }
    : { status: "unsupported-link", reason: "The route has no source-resolved app link or the application has no registered custom URL scheme." };
}

function assertIdentity(data: Record<string, unknown>, bundleId: string, deviceId?: string): void {
  const identifiers = isRecord(data.identifiers) ? data.identifiers : {};
  const device = isRecord(data.device) ? data.device : {};
  const verify = (values: unknown[], expected: string, name: string, required: boolean) => {
    const present = values.filter(value => value !== undefined);
    if ((required && !present.length) || present.some(value => value !== expected)) {
      throw captureError("CONTROLLER_IDENTITY_MISMATCH", `Controller returned a different or missing ${name}.`);
    }
  };
  // Android appstate names the foreground app as `package`; the other commands use the shared identifiers.
  verify([data.appBundleId, identifiers.appBundleId, identifiers.appId, data.package], bundleId, "app identity", true);
  verify([data.session, identifiers.session], CONTROLLER_SESSION, "controller session", false);
  if (deviceId) verify([device.id, data.id, data.device_udid, identifiers.deviceId], deviceId, "device identity", false);
}

function snapshotNodes(raw: string): Record<string, unknown>[] {
  if (Buffer.byteLength(raw) > MAX_ACCESSIBILITY_EVIDENCE_BYTES) throw captureError("INVALID_ACCESSIBILITY_EVIDENCE", "The accessibility response exceeds the evidence limit.");
  const data = controllerData(raw, "snapshot");
  if (data.truncated !== false || !Array.isArray(data.nodes) || data.nodes.length === 0
    || data.nodes.length > 20_000 || !data.nodes.every(isRecord)) {
    // Shape only: node text can hold user input.
    const error = captureError("INVALID_ACCESSIBILITY_EVIDENCE", "The controller did not return a complete accessibility snapshot.", true);
    throw new CiError({ code: error.code, stage: error.stage, message: error.message, nextAction: error.nextAction, retryable: true,
      details: { truncated: typeof data.truncated === "boolean" ? data.truncated : typeof data.truncated, nodes: Array.isArray(data.nodes) ? data.nodes.length : null } });
  }
  return data.nodes;
}

/** Whether the controller says a keyboard shows: Argent does, and its Android tree has no input method window to show it. */
function keyboardVisibility(data: Record<string, unknown>): { keyboardVisible?: boolean } {
  return typeof data.keyboardVisible === "boolean" ? { keyboardVisible: data.keyboardVisible } : {};
}

/** The visible element each required label matched, so an image assessor can find icon-only controls. */
export function verifiedCaptureLabels(nodes: readonly Record<string, unknown>[], requiredLabels: readonly string[],
  /** The screen's portrait height, when the screenshot is that screen turned a quarter clockwise (an opened iPhone Duo). */
  turned?: { height: number }) {
  return requiredLabels.flatMap(value => nodes.filter(node => node.visible !== false && (node.label === value || node.identifier === value)).slice(0, 3).map(node => {
    const rect = isRecord(node.rect) && ["x", "y", "width", "height"].every(key => Number.isFinite((node.rect as Record<string, unknown>)[key]))
      ? node.rect as { x: number; y: number; width: number; height: number } : undefined;
    // The bounds are given on the image's axes: turned a quarter clockwise, the portrait point (x, y) is at (H - y, x).
    const shown = rect && turned ? { x: turned.height - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width } : rect;
    return { value, matchedField: node.label === value ? "label" as const : "identifier" as const,
      ...(typeof node.type === "string" ? { type: node.type } : {}), ...(shown ? { rect: { x: shown.x, y: shown.y, width: shown.width, height: shown.height } } : {}) };
  }));
}

/**
 * The full-screen logical space a screenshot shows: the one Application node at the origin whose aspect is the image's,
 * at any pixel density. Failing that, the one whose aspect is the image's transpose (`transposed`): the image is then the
 * screen turned a quarter. A square screen matches both ways and is read upright. `slack` is how many image pixels the
 * root, scaled to the image, may miss it by; capture asks for an exact match.
 */
export function screenSpace(nodes: readonly Record<string, unknown>[], image: { width: number; height: number }, slack = 0): { width: number; height: number; transposed: boolean } | undefined {
  const roots = (transposed: boolean) => nodes.filter(node => node.type === "Application" && isRecord(node.rect)
    && node.rect.x === 0 && node.rect.y === 0 && typeof node.rect.width === "number" && typeof node.rect.height === "number"
    && Number.isFinite(node.rect.width) && Number.isFinite(node.rect.height) && node.rect.width > 0 && node.rect.height > 0
    && Math.abs(transposed ? node.rect.width * image.width - node.rect.height * image.height : node.rect.width * image.height - node.rect.height * image.width) <= slack * node.rect.height);
  const upright = roots(false), turned = upright.length ? [] : roots(true);
  const matched = upright.length ? upright : turned;
  if (matched.length !== 1) return undefined;
  const rect = matched[0]!.rect as { width: number; height: number };
  return { width: rect.width, height: rect.height, transposed: turned.length === 1 };
}

/**
 * A swipe that closes a presented sheet, or undefined when the snapshot does not prove a sheet.
 * The route observer is drawn at the focused scene's top-left corner. A sheet's scene starts below
 * the top of the window; a navigation bar above the scene explains the same offset for a pushed screen.
 */
export function sheetDismissGesture(nodes: readonly Record<string, unknown>[]): [number, number, number, number] | undefined {
  const markers = captureObserverMarkers(nodes);
  const roots = nodes.filter(node => node.type === "Application" && isRecord(node.rect) && node.rect.x === 0 && node.rect.y === 0
    && typeof node.rect.width === "number" && typeof node.rect.height === "number" && node.rect.width > 0 && node.rect.height > 0);
  if (markers.length !== 1 || roots.length !== 1 || !isRecord(markers[0]!.rect)) return;
  const origin = markers[0]!.rect.y, { width, height } = roots[0]!.rect as { width: number; height: number };
  if (typeof origin !== "number" || !Number.isFinite(origin) || origin < 20 || origin >= height / 2) return;
  if (nodes.some(node => node.type === "NavigationBar" && node.visible !== false && isRecord(node.rect)
    && typeof node.rect.y === "number" && typeof node.rect.height === "number" && node.rect.y + node.rect.height <= origin + 2)) return;
  return [Math.round(width / 2), Math.round(origin + 12), Math.round(width / 2), Math.round(height * 0.9)];
}

function landing(nodes: readonly Record<string, unknown>[], route: SourceRoute, inventory: readonly SourceRoute[], allowNavigationOnly = false): "verified" {
  // Never publish an alert as route evidence, including a late alert after the image was read.
  if (nodes.some(node => node.type === "Alert")) throw captureError("CAPTURE_BLOCKED_BY_ALERT", "An unresolved alert is covering the application.");
  const markers = captureObserverMarkers(nodes);
  if (!markers.length) throw captureError("CAPTURE_OBSERVER_MISSING", "The capture build has not exposed its active navigation destination.", true);
  if (markers.length !== 1) throw captureError("CAPTURE_OBSERVER_AMBIGUOUS", "More than one capture route observer is active.");
  const destination = parseCaptureDestination(markers[0]!.label);
  if (!destination) throw captureError("CAPTURE_OBSERVER_INVALID", "The capture observer returned an invalid navigation destination.");
  if (!captureDestinationMatches(destination, route, inventory, { allowNavigationOnly })) {
    throw new CiError({ code: "ROUTE_LANDING_MISMATCH", stage: "capture", retryable: true,
      message: `Expected ${route.route}; observed ${destination.pathname ?? destination.segments.join(" / ")}.`,
      nextAction: "Complete this route's UI prerequisites in the same running app, then capture its verified destination.",
      details: { expected: { provider: route.provider, route: route.route, path: route.path }, observed: destination } });
  }
  return "verified";
}

/** Execute source-owned targets in order. Live content never changes the source inventory. */
export async function capturePlannedRoutes(options: {
  capture: CiMapOptions; routes: readonly SourceRoute[]; scheme: string | undefined; appName: string;
  runtime: ActiveSimulatorRuntime;
  /** The EAS session's controller connection; a local simulator has none. */
  connection?: SimulatorConnection | undefined; environment: NodeJS.ProcessEnv;
  store: ExploreStore; map: ExploreMap;
  inventory?: readonly SourceRoute[];
  acceptedFrames?: Record<string, AgentAcceptedFrame>;
  outcomes?: CaptureBundle["outcomes"];
  /** Set when the review captures several appearances: the primary scheme keeps the route's screen id. */
  appearance?: { scheme: ColorScheme; primary: boolean };
  /** Records each route's span, from its first open to its outcome. */
  timings?: Timings;
}): Promise<NonNullable<CaptureBundle["outcomes"]>> {
  const screenIdFor = (routeId: string) => schemeScreenId(routeId, options.appearance && !options.appearance.primary ? options.appearance.scheme : undefined);
  const colorScheme = options.appearance?.scheme;
  const { capture, runtime, store, map } = options;
  const say = capture.progress ?? silentProgress;
  const inventory = options.inventory ?? options.routes;
  const runner = capture.runner ?? defaultRunner;
  const clock = capture.now ?? Date.now;
  const deadline = clock() + capture.maxDurationMinutes * 60_000;
  const inputs = createExplorationInputs({ ...(capture.agent ? { instructions: capture.agent.instructions } : {}),
    ...(capture.setup ? { setup: capture.setup } : {}), environment: capture.environment ?? process.env });
  let actions = 0;
  /** The app's own root link, opened before each route link when `capture.reset` is `root-link` (the default). */
  const rootLink = (capture.reset ?? "root-link") === "root-link" && options.scheme ? `${appScheme(options.scheme)}://` : undefined;
  const readRecovery: ControllerReadRecovery = { busyAttempts: 0 };
  // Time the controller spent recovering itself (busy backoff, daemon or adb retries); the app is not charged for it.
  let recoveryWaitedMs = 0;
  const pause = (milliseconds: number) => { if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };
  const recoverySleep = (milliseconds: number) => { recoveryWaitedMs += milliseconds; (capture.sleep ?? pause)(milliseconds); };
  // Each resend after a failed remote daemon check, so a run shows how often the connection dropped.
  const recordDaemonRetry = (retry: RemoteDaemonRetry) => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    appendFileSync(join(diagnostics, "controller-retries.jsonl"), `${JSON.stringify({ ...retry, reason: "remote-daemon-unavailable",
      at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
  };
  // Each wait for a system surface the controller cannot read yet, so a slow setup shows why.
  const recordSurfaceWait = (attempt: number, waitedMs: number) => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    appendFileSync(join(diagnostics, "controller-retries.jsonl"), `${JSON.stringify({ command: "snapshot", attempt, waitedMs,
      reason: "unreadable-system-surface", at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
  };
  let verifyingRecovery = false;
  const outcomes: NonNullable<CaptureBundle["outcomes"]> = options.outcomes ?? {};
  let timingPhase = "setup";
  // Every controller round trip with its duration, so a slow route shows which waits it spent.
  const recordControllerTiming = (args: string[], startedAt: number, status: "ok" | "failed") => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    const command = args[0] === "wait" || args[0] === "alert" ? `${args[0]} ${args[1] ?? ""}`.trim() : args[0] ?? "command";
    appendFileSync(join(diagnostics, "controller-timing.jsonl"), `${JSON.stringify({ phase: timingPhase, command, ms: clock() - startedAt, status,
      at: new Date(startedAt).toISOString() })}\n`, { mode: 0o600 });
  };
  const controller = (args: string[], allowMissingAlert = false, timeoutMs = 60_000): CommandResult => {
    const remaining = deadline - clock();
    // Waiting for the screen to settle observes; it neither drives the app nor spends its budget.
    // Nor does returning the app to its home before a route link: that is capture hygiene, not navigation.
    const settling = (args[0] === "wait" && args[1] === "stable") || (args[0] === "open" && rootLink !== undefined && args[2] === rootLink);
    const mutates = !settling
      && (["open", "press", "fill", "type", "scroll", "swipe", "wait", "back", "keyboard"].includes(args[0]!) || (args[0] === "alert" && args[1] === "accept"));
    if (remaining <= 0 || (mutates && actions >= capture.maxActions)) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture action or time budget was exhausted.");
    if (mutates) actions += 1;
    const readOnly = args[0] === "snapshot" || args[0] === "appstate" || args[0] === "alert" && args[1] === "get";
    const startedAt = clock();
    let result: CommandResult;
    try {
      result = runControllerRead({ args, deadlineMs: deadline, timeoutMs, now: clock, recovery: readRecovery, onRemoteDaemonRetry: recordDaemonRetry, sleep: recoverySleep,
        run: boundedTimeoutMs => runner({ command: capture.agentDeviceCommand,
          args: [...args, "--session", CONTROLLER_SESSION, ...deviceArgs(runtime), "--platform", runtime.platform],
          cwd: store.root, environment: options.environment, timeoutMs: boundedTimeoutMs,
          ...(allowMissingAlert || readOnly ? { allowFailure: true } : {}) }) });
    } catch (error) {
      recordControllerTiming(args, startedAt, "failed");
      throw error;
    }
    recordControllerTiming(args, startedAt, "ok");
    if (!allowMissingAlert) controllerData(result.stdout, args[0]!);
    if (readRecovery.needsVerification && !verifyingRecovery) {
      verifyingRecovery = true;
      try {
        controllerApp();
        const fresh = args[0] === "snapshot" ? snapshotNodes(result.stdout) : snapshot().nodes;
        const markers = captureObserverMarkers(fresh);
        if (markers.length !== 1 || !parseCaptureDestination(markers[0]!.label)) {
          throw captureError("CONTROLLER_RECOVERY_UNVERIFIED", "The restarted controller could not verify the application's current route.");
        }
        // Helper disposal does not reset the target app in the pinned implementation, but
        // OS state is not guaranteed. Expected landing/readiness/context remain caller gates.
        readRecovery.needsVerification = false;
      } catch (error) { readRecovery.terminalFailure = error; throw error; }
      finally { verifyingRecovery = false; }
    }
    return result;
  };
  // On iOS this response describes the controller session, not independent OS foreground proof.
  const controllerApp = () => assertIdentity(controllerData(controller(["appstate", "--level", "full", "--json"]).stdout, "appstate"), capture.bundleId, runtime.controllerDeviceId);
  const readAlert = (): { message: string; items: string[] } | null | "unknown" => {
    try {
      // The pinned iOS controller reports absence as an error, unlike its Android backend.
      // Preserve that structured response rather than swallowing arbitrary command failures.
      const response = parseJson(controller(["alert", "get", "--level", "full", "--json"], true).stdout, "alert get");
      if (isRecord(response) && response.success === false && isRecord(response.error)
        && response.error.code === "COMMAND_FAILED" && response.error.message === "alert not found") return null;
      if (alertWatchdogFailure(controllerCommandFailure(JSON.stringify(response), "alert get"))) return "unknown";
      if (isRecord(response) && response.success === true && isRecord(response.data) && response.data.platform === "android") {
        // The Android backend answers absence with `alert: null` and presence with the dialog's title, message and buttons.
        if (response.data.alert === null) return null;
        const dialog = response.data.alert;
        if (isRecord(dialog) && Array.isArray(dialog.buttons) && dialog.buttons.length > 0 && dialog.buttons.every(item => typeof item === "string")) {
          const text = [dialog.title, dialog.message].filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" ");
          if (parseCaptureDestination(text)) return null;
          return { message: text, items: dialog.buttons as string[] };
        }
      }
      if (isRecord(response) && response.success === true && isRecord(response.data)
        && typeof response.data.message === "string" && Array.isArray(response.data.items)
        && response.data.items.length > 0 && response.data.items.every(item => typeof item === "string")) {
        // The controller also reports a window with a "dismiss popup" element, which iOS adds behind
        // every dimmed form sheet, and titles it with the first text inside: the route observer, which
        // only renders in the app's own screens. Such a match is the screen under capture, not an alert.
        if (parseCaptureDestination(response.data.message)) return null;
        return { message: response.data.message, items: response.data.items as string[] };
      }
      const failure = controllerCommandFailure(JSON.stringify(response), "alert get");
      throw new CiError({ code: "ALERT_INSPECTION_FAILED", stage: "capture",
        message: failure ? `Could not inspect system alerts (${failure.code}): ${failure.message}`
          : "The controller did not establish whether a system alert is blocking the application.",
        nextAction: failure?.nextAction ?? "Inspect the controller diagnostic and rerun capture after the controller can read the current screen." });
    } catch (error) {
      if (error instanceof CiError) throw error;
      throw captureError("ALERT_INSPECTION_FAILED", "The controller could not inspect system alerts before capture.", true);
    }
  };
  const blockingAlert = (alert: { message: string; items: string[] }, message: string): CiError =>
    new CiError({ code: "CAPTURE_BLOCKED_BY_ALERT", stage: "capture", message: `${message} Alert: ${JSON.stringify(alert.message)} with buttons ${alert.items.map(item => JSON.stringify(item)).join(", ")}.`,
      nextAction: "Dismiss this alert with an explicit setup tap on one of its buttons, or stop the app from raising it in the capture build, and rerun Explore.",
      details: { alert } });
  type SeenScreen = { route: SourceRoute; nodes: readonly Record<string, unknown>[] };
  const noteAlertInspection = (entry: Record<string, unknown>) => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    appendFileSync(join(diagnostics, "alert-inspection.jsonl"), `${JSON.stringify({ ...entry, at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
  };
  /**
   * A snapshot already in hand that shows the expected destination with no Alert node proves the
   * app is in front and unblocked, so the native query (which waits out its watchdog when no alert
   * exists) is skipped. Otherwise the native query runs; when it times out without an answer, the
   * snapshot decides: an Alert node blocks capture, and its absence is recorded as unknown, never as
   * confirmed absence.
   */
  const alertInspection = (phase: string, seen?: SeenScreen): { message: string; items: string[] } | null => {
    if (seen && !seen.nodes.some(item => item.type === "Alert")) {
      let landed = false;
      try { landing(seen.nodes, seen.route, inventory); landed = true; } catch { landed = false; }
      if (landed) {
        noteAlertInspection({ phase, nativeAnswer: "skipped", snapshotAlert: false });
        return null;
      }
    }
    const alert = readAlert();
    if (alert !== "unknown") return alert;
    const node = snapshot().nodes.find(item => item.type === "Alert");
    noteAlertInspection({ phase, nativeAnswer: "unknown", snapshotAlert: !!node });
    if (node) throw new CiError({ code: "CAPTURE_BLOCKED_BY_ALERT", stage: "capture",
      message: `The native alert query timed out, and the accessibility snapshot shows an alert: ${JSON.stringify(redact(String(node.label ?? "")))}.`,
      nextAction: "Dismiss this alert with an explicit setup tap on one of its buttons, or stop the app from raising it in the capture build, and rerun Explore." });
    return null;
  };
  const assertNoAlert = (seen?: SeenScreen) => {
    const alert = alertInspection("capture", seen);
    if (alert) throw blockingAlert(alert, "An unresolved system alert is covering the application.");
  };
  const resolveDeepLinkConfirmation = (allowExplicitSetupAlert = false) => {
    const alert = alertInspection("deep-link");
    if (!alert) return;
    const title = alert.message.normalize("NFC").trim();
    const appName = options.appName.normalize("NFC");
    const expectedTitles = [`Open in “${appName}”?`, `Open in "${appName}"?`, `Open in '${appName}'?`, `Open in ‘${appName}’?`];
    if (!expectedTitles.includes(title) || alert.items.length !== 2
      || !alert.items.includes("Open") || !alert.items.includes("Cancel")) {
      if (allowExplicitSetupAlert) return;
      throw blockingAlert(alert, "A system alert is not the configured application's Open confirmation; it needs explicit setup, or its app name differs from the resolved Expo app name.");
    }
    try {
      // alert accept targets the inspected modal, never an application button named Open.
      // The pinned controller recognizes Open and verifies that the modal disappears.
      // alert has no --timeout flag in agent-device 0.21.15; bound the process instead.
      controller(["alert", "accept", "--level", "full", "--json"], false, 15_000);
    } catch (error) {
      if (error instanceof CiError && error.code === "CAPTURE_BUDGET_EXHAUSTED") throw error;
      throw new CiError({ code: "DEEP_LINK_CONFIRMATION_FAILED", stage: "capture",
        message: "The Open confirmation did not complete within its capture budget.",
        nextAction: "Inspect the controller diagnostic and verify that the pinned controller can dismiss the configured app's Open confirmation.",
        details: { controller: serializeCiError(toCiError(error, { code: "CONTROLLER_ALERT_FAILED", stage: "capture" }),
          { secrets: [capture.expoToken, ...(options.connection ? [options.connection.daemonAuthToken] : [])] }) } });
    }
    const remainingAlert = alertInspection("deep-link-confirmed");
    if (remainingAlert && (!allowExplicitSetupAlert || expectedTitles.includes(remainingAlert.message.normalize("NFC").trim()))) {
      throw captureError("DEEP_LINK_CONFIRMATION_FAILED", "A system alert remained after the app's Open confirmation.");
    }
    controllerApp();
    controller(["wait", "500", "--level", "full", "--json"]);
  };
  const secrets = [capture.expoToken, ...(options.connection ? [options.connection.daemonAuthToken] : []), ...inputs.values, ...(capture.agent?.secretValues ?? [])];
  const redact = (text: string): string => secrets.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])
    .sort((a, b) => b.length - a.length).reduce((result, value) => result.split(value).join("[REDACTED]"), inputs.redact(text));
  const redactValue = <T>(value: T): T => {
    if (typeof value === "string") return redact(value) as T;
    if (Array.isArray(value)) return value.map(item => redactValue(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)])) as T;
    return value;
  };
  const assertSafeScreenshot = (nodes: readonly Record<string, unknown>[]) => {
    inputs.assertSafeSnapshot(nodes);
    const serialized = JSON.stringify(nodes);
    if (JSON.stringify(redactValue(nodes)) !== serialized) throw new CiError({ code: "CAPTURE_SENSITIVE_INPUT", stage: "capture",
      message: "A sensitive input is visible in the current screen.", nextAction: "Submit or clear the sensitive input before capturing this screen." });
  };
  /** A declined credential prompt is retained evidence, not silent state. */
  const recordDeclinedPrompt = (mode: "deterministic" | "agent") => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    appendFileSync(join(diagnostics, "system-prompts.jsonl"), `${JSON.stringify({ mode, prompt: "credential-save", action: "Not Now",
      at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
  };
  let lastSnapshot: string | undefined;
  const snapshot = (): CaptureSetupSnapshot => {
    for (let declined = 0; ; declined++) {
      const raw = controller(["snapshot", "--force-full", "--level", "full", "--json"]).stdout;
      const nodes = snapshotNodes(raw);
      const data = controllerData(raw, "snapshot");
      lastSnapshot = raw;
      const generation = typeof data.refsGeneration === "number" ? data.refsGeneration : undefined;
      const decline = declined < 2 && generation ? credentialSavePromptDecline(nodes) : undefined;
      if (!decline) return { nodes, truncated: false, ...(generation ? { refsGeneration: generation } : {}), ...keyboardVisibility(data) };
      controller(["press", `@${String(decline.ref).replace(/^@/, "")}~s${generation}`, "--level", "full", "--json"]);
      recordDeclinedPrompt("deterministic");
      controller(["wait", "500", "--level", "full", "--json"]);
    }
  };
  /**
   * A system surface such as the iOS Save Password prompt can return an incomplete tree while it
   * appears (observed after a sign-up form submits). Setup reads again briefly.
   */
  const setupSnapshot = (): CaptureSetupSnapshot => {
    let surfaceWaitStarted: number | undefined;
    for (let attempt = 1; ; attempt++) {
      try { return snapshot(); }
      catch (error) {
        // A system surface the controller cannot read yet (the Save Password prompt while
        // agent-device defers its XCTest tiers): wait it out, then decline it as usual.
        if (isUnreadableSystemSurface(error)) {
          surfaceWaitStarted ??= clock();
          const waited = clock() - surfaceWaitStarted;
          if (waited >= UNREADABLE_SURFACE_WAIT_MS) {
            throw new CiError({ code: "SETUP_SYSTEM_SURFACE_BLOCKING", stage: "setup",
              message: `A system surface stayed in front of the app for ${Math.round(waited / 1000)} s and could not be read: ${(error as CiError).message}`,
              nextAction: "iOS showed its own prompt (such as Save Password) over the app during setup. Rerun capture; if it repeats, "
                + "check which setup step submits a form and whether the app can avoid the prompt.",
              retryable: true, cause: error });
          }
          recordSurfaceWait(attempt, waited);
          controller(["wait", String(UNREADABLE_SURFACE_POLL_MS), "--level", "full", "--json"]);
          continue;
        }
        if (attempt >= 8 || !(error instanceof CiError) || error.code !== "INVALID_ACCESSIBILITY_EVIDENCE" || !error.retryable) throw error;
        controller(["wait", "1000", "--level", "full", "--json"]);
      }
    }
  };
  /** The readiness clock of the route link being captured: started when its `open` returned, so the budget covers
      settling, polling and any link confirmation together. */
  let readiness: { startedAt: number; budgetMs: number; attempt: number } | undefined;
  const readinessBudgetMs = (attempt: number) => (capture.readinessSeconds ?? defaultReadinessSeconds(runtime.platform)) * 1000 * (attempt > 1 ? 1.5 : 1);
  /**
   * Polls until the expected destination is in front, within a wall-clock budget measured from the link's `open`
   * (or from this call): at least three snapshots, extended while consecutive trees still differ up to twice the
   * budget, controller recovery time excluded. With `confirmDeepLink`, an Alert node (or a budget that runs out
   * without the destination, since a system alert can hide from the snapshot) hands the screen to the native
   * alert flow once, then polling restarts after the controller settles again.
   */
  /** Whether the route observer has answered yet in this run: once it has, the build is known to expose one. */
  let observerSeen = false;
  /** The last tree of a route given up on, offered to the unattributed-evidence path. */
  let lastMiss: { route: SourceRoute; nodes: readonly Record<string, unknown>[]; error: CiError } | undefined;
  const waitForDestination = (route: SourceRoute, confirmDeepLink?: () => void): readonly Record<string, unknown>[] => {
    const { startedAt, budgetMs, attempt } = readiness ?? { startedAt: clock(), budgetMs: readinessBudgetMs(1), attempt: 1 };
    readiness = undefined;
    const recoveryAtStart = recoveryWaitedMs;
    // A snapshot counts for at least one poll interval, so a clock that stands still (a fake controller) still expires.
    const elapsed = () => Math.max(clock() - startedAt - (recoveryWaitedMs - recoveryAtStart), polls * READINESS_POLL_MS);
    const record = (outcome: string) => {
      const diagnostics = join(store.root, "capture-diagnostics");
      mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
      appendFileSync(join(diagnostics, "readiness.jsonl"), `${JSON.stringify({ route: route.id, attempt, budgetMs, elapsedMs: elapsed(), polls, extended,
        recoveryMs: recoveryWaitedMs - recoveryAtStart, outcome, at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
    };
    let unconfirmed = confirmDeepLink;
    let polls = 0, pollsSinceRestart = 0, extended = false, changing = false;
    let lastIdentity: string | undefined;
    for (;;) {
      const pollStartedAt = clock();
      const current = snapshot();
      polls += 1; pollsSinceRestart += 1;
      const identity = exposedIdentity(current.nodes);
      changing = lastIdentity !== undefined && identity !== lastIdentity;
      lastIdentity = identity;
      const over = elapsed() >= budgetMs;
      const capped = elapsed() >= budgetMs * 2;
      if (over && changing && !capped) extended = true;
      const expired = pollsSinceRestart >= 3 && (capped || (over && !changing));
      if (unconfirmed && (current.nodes.some(node => node.type === "Alert") || expired)) {
        const confirm = unconfirmed;
        unconfirmed = undefined;
        confirm();
        settle();
        pollsSinceRestart = 0;
        lastIdentity = undefined;
        continue;
      }
      if (captureObserverMarkers(current.nodes).length) observerSeen = true;
      try { landing(current.nodes, route, capture.agent ? inventory.map(item => item.id === route.id ? route : item) : inventory, !!capture.agent); record("landed"); return current.nodes; }
      catch (error) {
        if (!(error instanceof CiError) || !error.retryable || expired) {
          if (error instanceof CiError) {
            // A tree still changing when the budget ran out is a screen that never settled, not a wrong or missing
            // destination. An observer that answered earlier in this process and reports nothing now is not ready (a
            // remount or redirect at load), which is a different finding from a build that never exposed one.
            const classified = expired && changing
              ? captureError("CAPTURE_NOT_SETTLED", `The screen kept changing for ${Math.round(elapsed() / 1000)} s after the link opened; its destination was not read.`, true)
              : error.code === "CAPTURE_OBSERVER_MISSING" && observerSeen
                ? new CiError({ code: "CAPTURE_OBSERVER_NOT_READY", stage: "capture", retryable: true,
                  message: `The route observer answered earlier in this session but reported nothing for ${route.route}.`,
                  nextAction: "Check what the app does when this link opens (a remount or redirect at load hides the observer), then rerun capture.",
                  cause: error })
                : error;
            recordDestinationMiss(route, current.nodes, classified); record(classified.code);
            lastMiss = { route, nodes: current.nodes, error: classified };
            throw classified;
          }
          throw error;
        }
        (capture.sleep ?? pause)(READINESS_POLL_MS - (clock() - pollStartedAt));
      }
    }
  };
  /** The last accessibility tree seen before a destination was given up on, so a missing or
      mismatched observer can be read from the run's diagnostics instead of only its error code. */
  const recordDestinationMiss = (route: SourceRoute, nodes: readonly Record<string, unknown>[], error: CiError) => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    const summary = nodes.slice(0, 400).map(node => redactValue({ type: node.type, identifier: node.identifier, label: typeof node.label === "string" ? node.label.slice(0, 200) : undefined,
      rect: node.rect, enabled: node.enabled }));
    appendFileSync(join(diagnostics, "destination-misses.jsonl"), `${JSON.stringify({ route: route.id, path: route.path, code: error.code, message: error.message,
      nodeCount: nodes.length, nodes: summary, at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
  };
  /** Which elements a screen exposes, ignoring the text they carry: a clock or a counter may
      keep ticking, but a screen that is still building exposes a different set of elements. */
  const exposedIdentity = (nodes: readonly Record<string, unknown>[]): string => JSON.stringify(nodes
    .filter(node => node.identifier !== CAPTURE_OBSERVER_IDENTIFIER)
    .map(node => `${node.type ?? ""}\u0000${node.identifier ?? ""}\u0000${node.enabled === false ? 0 : 1}`)
    .sort());
  /** The controller's own quiescence gate; a timeout is reported by the snapshot comparison below. */
  const settle = () => { controller(["wait", "stable", "500", "8000", "--level", "full", "--json"], true); };
  /**
   * A screen that focused a text field shows the keyboard that field raises, as its users see it. The keyboard rises
   * after the screen has settled, so the controller's quiescence gate can pass in between: in brentvatne/euxy#172
   * (review run 39362642343) the rename sheet's base was captured with its cursor showing and no keyboard, its head with
   * the keyboard up, and the 48% mismatch was the keyboard. The screen is read again until the keyboard is in the same
   * place twice running (see keyboardSettle); a keyboard that never comes is not waited for long, and none is dismissed.
   */
  const awaitKeyboard = (route: SourceRoute, first: KeyboardRead): readonly Record<string, unknown>[] => {
    const settle = keyboardSettle(first);
    if (!settle) return first.nodes;
    const startedAt = clock();
    let current = first, pollStartedAt = startedAt;
    // A read counts for at least one poll interval, so a clock that stands still (a fake controller) still expires.
    const elapsed = () => Math.max(clock() - startedAt, settle.reads * KEYBOARD_POLL_MS);
    while (settle.more(elapsed())) {
      (capture.sleep ?? pause)(KEYBOARD_POLL_MS - (clock() - pollStartedAt));
      pollStartedAt = clock();
      current = snapshot();
      settle.read(current);
    }
    recordKeyboardWait(route.id, settle, elapsed());
    return current.nodes;
  };
  const recordKeyboardWait = (route: string | undefined, settle: KeyboardSettle, elapsedMs: number) => {
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    appendFileSync(join(diagnostics, "keyboard.jsonl"), `${JSON.stringify({ ...(route ? { route } : { phase: "agent-observe" }), outcome: settle.outcome,
      reads: settle.reads, elapsedMs, at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
  };
  const attempted = new Set<string>();
  const captureCurrent = async (route: SourceRoute, attempt: number, before?: readonly Record<string, unknown>[],
    unattributed?: NonNullable<CaptureBundle["outcomes"][string]["observed"]> & { message: string }) => {
    if (!attempted.has(route.id) && attempted.size >= capture.maxScreens) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture screen budget was exhausted.");
    attempted.add(route.id);
    const temporary = await mkdtemp(join(store.root, ".capture-"));
    try {
      const arrived = before ?? waitForDestination(route, () => resolveDeepLinkConfirmation());
      if (unattributed) assertNoAlert({ route, nodes: arrived });
      else landing(arrived, route, inventory);
      const accepted = unattributed ? arrived : awaitKeyboard(route, { nodes: arrived });
      if (accepted !== arrived) landing(accepted, route, inventory);
      assertSafeScreenshot(accepted);
      const screenshot = join(temporary, "screen.png");
      await writeFile(screenshot, "", { flag: "wx", mode: 0o600 });
      const recycledBeforeScreenshot = readRecovery.recycleUsed === true;
      controller(["screenshot", screenshot, "--level", "full", "--json"]);
      const imageInfo = await lstat(screenshot);
      if (!imageInfo.isFile() || imageInfo.isSymbolicLink() || imageInfo.nlink !== 1 || imageInfo.size > 30 * 1024 * 1024) throw captureError("INVALID_SCREENSHOT", "Capture did not produce a bounded regular PNG file.");
      const png = await readFile(screenshot);
      assertDecodedPng(png, "Capture screenshot");
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      runtime.orientation = width > height ? "landscape" : "portrait";
      map.run.environment.orientation = runtime.orientation;
      const raw = controller(["snapshot", "--force-full", "--level", "full", "--json"]).stdout;
      const confirmed = snapshotNodes(raw);
      // The snapshot after the screenshot names the app in front, which saves an `appstate` call per route; a
      // controller whose snapshot does not name it is asked.
      const read = controllerData(raw, "snapshot");
      if (read.appBundleId !== undefined || isRecord(read.identifiers)) assertIdentity(read, capture.bundleId, runtime.controllerDeviceId);
      else controllerApp();
      assertNoAlert({ route, nodes: confirmed });
      const verifiedLanding: "verified" | "unverified" = unattributed ? "unverified" : landing(confirmed, route, inventory);
      assertSafeScreenshot(confirmed);
      if (recycledBeforeScreenshot !== (readRecovery.recycleUsed === true)) {
        throw captureError("CAPTURE_NOT_SETTLED", "The controller restarted during screenshot verification; capture a fresh frame.", true);
      }
      // Evidence that still moves is not evidence: the same screen must expose the same elements
      // before and after its screenshot, or this capture is repeated rather than published.
      if (exposedIdentity(accepted) !== exposedIdentity(confirmed)) {
        throw captureError("CAPTURE_NOT_SETTLED", "The screen kept changing while it was captured.", true);
      }
      const accessibility = join(temporary, "accessibility.json");
      const safeRaw = JSON.stringify(redactValue(JSON.parse(raw)));
      await writeFile(accessibility, safeRaw, { flag: "wx", mode: 0o600 });
      const parsed = parseControllerOutput("agent-device", safeRaw);
      const transaction = structuredClone(map);
      const recorded = await recordObservation({ store, map: transaction, title: route.title ?? route.route, screenId: screenIdFor(route.id), ...(colorScheme ? { colorScheme } : {}),
        route: route.path ?? route.route, variantName: route.variant, start: transaction.screens.length === 0, depth: 0,
        screenshotPath: screenshot, snapshotPath: accessibility, snapshotText: safeRaw,
        elements: parsed.elements, parseWarnings: parsed.warnings, surfaceScope: "app" });
      transaction.frontier = [];
      await store.write(transaction, recorded.preparedArtifacts);
      Object.assign(map, transaction);
      outcomes[route.id] = { status: "captured", attempts: attempt, landing: verifiedLanding,
        ...(unattributed ? { reason: unattributed.message, observed: { reason: unattributed.reason, ...(unattributed.route ? { route: unattributed.route } : {}), attempts: unattributed.attempts } } : {}),
        screenshotSha256: createHash("sha256").update(png).digest("hex") };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  };
  /**
   * The screen the app showed instead of the planned route is evidence of what the link did: publish it as an
   * unattributed frame (captured, destination unverified, never compared or cached) when the miss was a wrong
   * landing or an observer that had answered before. The frame passes the same app-identity, alert and secret
   * gates as a verified one; when any fails, the route stays failed without a frame.
   */
  const captureUnattributed = async (route: SourceRoute, attempt: number, error: unknown) => {
    if ((capture.unattributed ?? "publish") === "discard" || !(error instanceof CiError) || lastMiss?.route.id !== route.id) return;
    const miss = lastMiss;
    lastMiss = undefined;
    const observedRoute = isRecord(miss.error.details?.observed) && typeof miss.error.details.observed.pathname === "string" ? miss.error.details.observed.pathname : undefined;
    const observed = miss.error.code === "ROUTE_LANDING_MISMATCH"
      ? { reason: "landing-mismatch" as const, ...(observedRoute ? { route: observedRoute } : {}), attempts: attempt,
        message: `Expected ${route.route}; the app showed ${observedRoute ?? "another screen"} on ${attempt === 1 ? "the only attempt" : `both attempts`}.` }
      : miss.error.code === "CAPTURE_OBSERVER_NOT_READY"
        ? { reason: "observer-not-ready" as const, attempts: attempt,
          message: `The route observer answered earlier in this session but reported nothing for ${route.route} after ${attempt} ${attempt === 1 ? "attempt" : "attempts"}.` }
        : undefined;
    if (!observed) return;
    try {
      controllerApp();
      await captureCurrent(route, attempt, miss.nodes, observed);
      say(`route ${route.route}: the frame is published as unattributed evidence (${observed.message})`);
    } catch (publishError) {
      say(`route ${route.route}: the unattributed frame was not published (${(publishError as Error).message})`);
    }
  };
  const failedOutcome = (error: unknown, attempts: number): CaptureBundle["outcomes"][string] => {
    const failure = toCiError(error, { code: "ROUTE_CAPTURE_FAILED", stage: "capture", retryable: true,
      nextAction: "Inspect the observed destination and UI setup diagnostic, then correct the failed navigation prerequisite." });
    return { status: failure.code === "CAPTURE_BUDGET_EXHAUSTED" ? "budget-exhausted" : "failed", attempts, landing: "unverified",
      error: serializeCiError(failure, { secrets }) };
  };
  if (capture.agent) {
    const agent = capture.agent;
    say(`agent navigation: ${options.routes.length} ${options.routes.length === 1 ? "route" : "routes"} to capture`);
    const tracePath = join(store.root, "capture-diagnostics", "agent-navigation.jsonl");
    await mkdir(dirname(tracePath), { recursive: true, mode: 0o700 });
    const acceptedFrames = options.acceptedFrames ?? {};
    const signalController = new AbortController();
    const expiration = setTimeout(() => signalController.abort(captureError("CAPTURE_BUDGET_EXHAUSTED", "Agent exploration exhausted its time budget.")), Math.max(1, deadline - clock()));
    type Candidate = { id: string; directory: string; screenshot: string; png: Buffer; imageSha256: string; capturedAt: string;
      before: CaptureSetupSnapshot; snapshot: CaptureSetupSnapshot; raw: string; width: number; height: number };
    let candidate: Candidate | undefined;
    const rejectedReadiness = new Map<string, Awaited<ReturnType<NonNullable<CiAgentRuntimeOptions["assessCapture"]>>>>();
    const discard = async () => { const previous = candidate; candidate = undefined; if (previous) await rm(previous.directory, { recursive: true, force: true }); };
    const liveSignal = (signal: AbortSignal) => AbortSignal.any([signalController.signal, signal]);
    const command = async (args: string[], signal: AbortSignal, allowFailure = false): Promise<CommandResult> => {
      const activeSignal = liveSignal(signal);
      activeSignal.throwIfAborted();
      const remaining = deadline - clock();
      const mutates = ["open", "press", "fill", "type", "scroll", "swipe", "wait", "back", "keyboard"].includes(args[0]!);
      if (remaining <= 0 || mutates && actions >= capture.maxActions) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture action or time budget was exhausted.");
      if (mutates) actions += 1;
      let result: CommandResult;
      try {
        result = await runControllerReadAsync({ args, deadlineMs: deadline, timeoutMs: remaining, now: clock,
        recovery: readRecovery, signal: activeSignal, onRemoteDaemonRetry: recordDaemonRetry, run: async timeoutMs => {
          const request = { command: capture.agentDeviceCommand,
            args: [...args, "--session", CONTROLLER_SESSION, ...deviceArgs(runtime), "--platform", runtime.platform],
            cwd: store.root, environment: options.environment, timeoutMs, allowFailure: true };
          const value = capture.runner ? capture.runner(request) : await runAgentControllerCommand(request, activeSignal);
          activeSignal.throwIfAborted();
          return value;
        } });
        if (!allowFailure) controllerData(result.stdout, args[0]!);
      } catch (error) {
        if (wedgedControllerReadFailure(error)) {
          const terminal = new CiError({ code: "CONTROLLER_RUNNER_WEDGED", stage: "controller",
            message: "The iOS controller reported a terminal native runner failure.",
            nextAction: "Start a fresh capture session; no subsequent UI action is authorized by this runner failure.", cause: error });
          readRecovery.terminalFailure = terminal;
          throw terminal;
        }
        throw error;
      }
      if (readRecovery.needsVerification && !verifyingRecovery) {
        verifyingRecovery = true;
        try {
          await appIdentity(activeSignal);
          const fresh = args[0] === "snapshot" ? snapshotNodes(result.stdout) : (await readSnapshot(activeSignal)).snapshot.nodes;
          const markers = captureObserverMarkers(fresh);
          if (markers.length !== 1 || !parseCaptureDestination(markers[0]!.label)) throw captureError("CONTROLLER_RECOVERY_UNVERIFIED", "The restarted controller could not verify the application's current route.");
          readRecovery.needsVerification = false;
        } catch (error) { readRecovery.terminalFailure = error; throw error; }
        finally { verifyingRecovery = false; }
      }
      return result;
    };
    const appIdentity = async (signal: AbortSignal) => assertIdentity(controllerData((await command(["appstate", "--level", "full", "--json"], signal)).stdout, "appstate"), capture.bundleId, runtime.controllerDeviceId);
    const readSnapshot = async (signal: AbortSignal) => {
      for (let declined = 0; ; declined++) {
        const raw = (await command(["snapshot", "--force-full", "--level", "full", "--json"], signal)).stdout;
        const nodes = snapshotNodes(raw), data = controllerData(raw, "snapshot");
        lastSnapshot = raw;
        const generation = typeof data.refsGeneration === "number" ? data.refsGeneration : undefined;
        const decline = declined < 2 && generation ? credentialSavePromptDecline(nodes) : undefined;
        if (!decline) {
          const snapshot: CaptureSetupSnapshot = { nodes, truncated: false, ...(generation ? { refsGeneration: generation } : {}), ...keyboardVisibility(data) };
          return { snapshot, raw };
        }
        await command(["press", `@${String(decline.ref).replace(/^@/, "")}~s${generation}`, "--level", "full", "--json"], signal);
        recordDeclinedPrompt("agent");
        await command(["wait", "500", "--level", "full", "--json"], signal);
      }
    };
    const open = async (urlText: string, signal: AbortSignal) => {
      const url = new URL(urlText);
      if (!options.scheme || url.protocol !== `${options.scheme}:` || url.username || url.password) throw captureError("AGENT_LINK_OUTSIDE_APP", "An agent URL does not belong to the configured application.");
      const data = controllerData((await command(["open", capture.bundleId, urlText, "--level", "full", "--json"], signal)).stdout, "agent open");
      assertIdentity(data, capture.bundleId, runtime.controllerDeviceId);
      // The agent observes and handles any OS confirmation through the ordinary UI.
    };
    const observerIdentity = (nodes: readonly Record<string, unknown>[]) => JSON.stringify(captureObserverMarkers(nodes).map(node => node.label));
    const coordinateIdentity = (snapshot: CaptureSetupSnapshot) => JSON.stringify(snapshot.nodes.map(node => ({
      type: node.type, identifier: node.identifier, label: node.label, value: node.value,
      // Swift's JSON encoder can reorder rectangle keys without changing geometry.
      enabled: node.enabled, visible: node.visible,
      rect: isRecord(node.rect) ? Object.fromEntries(Object.entries(node.rect).sort(([left], [right]) => left.localeCompare(right))) : node.rect,
      parentIndex: node.parentIndex,
    })));
    /**
     * The logical coordinate space a frame's normalized taps map into. On a panel whose native axes are portrait but
     * whose UI is landscape (an opened iPhone Duo under Argent), the screenshot is taken upright: the portrait screen
     * turned a quarter clockwise, while the accessibility tree and taps stay on the panel's portrait axes. Its root is
     * then the transpose of the frame, and a tap is turned back (see `toLogical`).
     */
    const bounds = (frame: Candidate) => {
      // The official iOS screenshot is full-screen. Its default is 1x, but a proven
      // uniform pixel density must still map to XCTest points rather than raw pixels.
      const space = screenSpace(frame.snapshot.nodes, frame);
      if (!space) throw captureError("AGENT_COORDINATE_BOUNDS_UNVERIFIED", "The screenshot does not identify one matching full-screen logical coordinate space.");
      return space;
    };
    /**
     * A normalized point (x, y) in the screenshot, in the tree's logical points. Upright, it scales by the root. Turned:
     * a portrait screen W wide and H tall, turned a quarter clockwise, is an image H wide and W tall in which the portrait
     * point (px, py) lands at (u, v) = (H - py, px); so the image point (u, v) is the portrait point (v, H - u). With
     * u = x * H and v = y * W, that is (y * W, (1 - x) * H). (A 2x3 portrait pixel at (0, 0), centre (0.5, 0.5), sits at
     * column 2 of the turned 3x2 image, centre (2.5, 0.5), which maps back to (0.5, 3 - 2.5).)
     */
    /** The portrait screen a turned (upright landscape) frame shows, or undefined for a frame on the screen's own axes. */
    const turnedSpace = (frame: Candidate): { height: number } | undefined => {
      try { const space = bounds(frame); return space.transposed ? { height: space.height } : undefined; } catch { return undefined; }
    };
    const toLogical = (space: { width: number; height: number; transposed: boolean }, x: number, y: number): [number, number] =>
      space.transposed ? [y * space.width, (1 - x) * space.height] : [x * space.width, y * space.height];
    /**
     * agent-device's in-app back taps a navigation control and cannot leave a sheet without one.
     * Swipe such a sheet down, then require the observed destination to change.
     */
    const back = async (signal: AbortSignal): Promise<{ via: string } | undefined> => {
      try { await command(["back", "--level", "full", "--json"], signal); return; }
      catch (error) {
        if (!(error instanceof CiError) || !/in-app back control is not available/.test(error.message)) throw error;
        const before = (await readSnapshot(signal)).snapshot.nodes;
        let gesture = sheetDismissGesture(before);
        if (!gesture) throw error;
        const gestures: [number, number, number, number][] = [];
        let after = before;
        // A first drag can move a sheet without closing it (observed on EAS: y 72 -> 62). One more
        // drag from the sheet's new top closes it; each drag still requires sheet evidence.
        for (let swipe = 0; swipe < 2 && gesture; swipe++) {
          gestures.push(gesture);
          await command(["swipe", ...gesture.map(String), "--level", "full", "--json"], signal);
          for (let attempt = 0; attempt < 4; attempt++) {
            await sleep(500, undefined, { signal: liveSignal(signal) });
            after = (await readSnapshot(signal)).snapshot.nodes;
            if (observerIdentity(after) !== observerIdentity(before)) return { via: "sheet-swipe" };
          }
          gesture = sheetDismissGesture(after);
        }
        throw new CiError({ code: "AGENT_SHEET_DISMISS_FAILED", stage: "capture",
          message: "The screen has no in-app back control, and swiping down did not close its sheet.",
          nextAction: "Inspect the returned accessibility and use an observed close or cancel control. Do not open an app URL over the sheet.",
          details: { back: serializeCiError(error, { secrets }), gestures, destinationBefore: observerIdentity(before), destinationAfter: observerIdentity(after) } });
      }
    };
    /**
     * agent-device 0.21.x routes a snapshot to a system surface such as the SafariViewService
     * password prompt. While its XCTest tiers are deferred after slow accessibility work, no backend
     * can read that surface and the snapshot is refused (observed for about 40 s in r10). Wait for
     * the deferral to end rather than hand the agent a frame without accessibility.
     */
    const readSnapshotThroughDeferral = async (signal: AbortSignal) => {
      const started = clock();
      const delays = [3_000, 5_000, 8_000, 10_000, 12_000, 12_000];
      for (let attempt = 0; ; attempt++) {
        try { return { ...(await readSnapshot(signal)), retries: attempt, deferredMs: clock() - started }; }
        catch (error) {
          const delayMs = delays[attempt];
          if (!(error instanceof CiError) || !/requires a (?:valid|positive finite) viewport/.test(error.message)
            || delayMs === undefined || deadline - clock() <= delayMs) throw error;
          await sleep(delayMs, undefined, { signal: liveSignal(signal) });
        }
      }
    };
    /** The same wait for a focused field's keyboard as a route link's capture, before an observation's screenshot. */
    const awaitKeyboardAsync = async (first: CaptureSetupSnapshot, signal: AbortSignal): Promise<CaptureSetupSnapshot> => {
      const settle = keyboardSettle(first);
      if (!settle) return first;
      const startedAt = clock();
      let current = first;
      const elapsed = () => Math.max(clock() - startedAt, settle.reads * KEYBOARD_POLL_MS);
      while (settle.more(elapsed())) {
        await sleep(KEYBOARD_POLL_MS, undefined, { signal: liveSignal(signal) });
        current = (await readSnapshot(signal)).snapshot;
        settle.read(current);
      }
      recordKeyboardWait(undefined, settle, elapsed());
      return current;
    };
    const observe = async (signal: AbortSignal, options?: { includeImage: boolean }) => {
      await discard();
      await appIdentity(signal);
      const first = await readSnapshotThroughDeferral(signal);
      let before = first.snapshot;
      if (first.retries > 0) {
        await appendFile(join(dirname(tracePath), "accessibility-deferral.jsonl"), `${JSON.stringify({ retries: first.retries, waitedMs: first.deferredMs,
          at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
      }
      if (options?.includeImage === false) return { snapshot: before };
      before = await awaitKeyboardAsync(before, signal);
      try { assertSafeScreenshot(before.nodes); }
      catch (error) {
        if (error instanceof CiError && error.code === "CAPTURE_SENSITIVE_INPUT") return { snapshot: before, imageUnavailable: { code: error.code, message: error.message } };
        throw error;
      }
      const directory = await mkdtemp(join(store.root, ".agent-observation-"));
      let retained = false, screenshotReady = false;
      try {
        const path = join(directory, "screen.png");
        await writeFile(path, "", { flag: "wx", mode: 0o600 });
        const recycled = readRecovery.recycleUsed === true;
        await command(["screenshot", path, "--normalize-status-bar", "--level", "full", "--json"], signal);
        const capturedAt = new Date(clock()).toISOString();
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 10 * 1024 * 1024) throw captureError("INVALID_SCREENSHOT", "The agent observation did not produce a bounded regular image.");
        const png = await readFile(path); assertDecodedPng(png, "Agent observation screenshot");
        screenshotReady = true;
        await appIdentity(signal);
        const after = await readSnapshot(signal);
        try { assertSafeScreenshot(after.snapshot.nodes); }
        catch (error) {
          if (error instanceof CiError && error.code === "CAPTURE_SENSITIVE_INPUT") return { snapshot: after.snapshot, imageUnavailable: { code: error.code, message: error.message } };
          throw error;
        }
        if (recycled !== (readRecovery.recycleUsed === true) || exposedIdentity(before.nodes) !== exposedIdentity(after.snapshot.nodes)
          || observerIdentity(before.nodes) !== observerIdentity(after.snapshot.nodes)) {
          return { snapshot: after.snapshot, imageUnavailable: { code: "CAPTURE_NOT_SETTLED", message: "The screen changed during observation. Observe again before capture." } };
        }
        const imageSha256 = createHash("sha256").update(png).digest("hex"), id = randomUUID();
        candidate = { id, directory, screenshot: path, png, imageSha256, capturedAt, before: structuredClone(before),
          snapshot: structuredClone(after.snapshot), raw: JSON.stringify(redactValue(JSON.parse(after.raw))), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        retained = true;
        return { snapshot: after.snapshot, frameId: id, image: png.toString("base64"), imageSha256, capturedAt };
      } catch (error) {
        if (screenshotReady || signal.aborted || signalController.signal.aborted || error instanceof CiError
          && ["CAPTURE_BUDGET_EXHAUSTED", "CONTROLLER_READ_BUSY", "RUNNER_WEDGED", "CONTROLLER_RUNNER_WEDGED", "CONTROLLER_RECOVERY_UNVERIFIED", "CONTROLLER_IDENTITY_MISMATCH"].includes(error.code)) throw error;
        // AX remains useful for navigation even when no screenshot can be accepted.
        const failure = serializeCiError(error, { secrets });
        return { snapshot: before, imageUnavailable: { code: failure.code, message: failure.message } };
      } finally { if (!retained) await rm(directory, { recursive: true, force: true }); }
    };
    const takeCandidate = (frameId: string) => {
      if (!candidate || candidate.id !== frameId) throw captureError("AGENT_FRAME_STALE", "This frame is unavailable or was invalidated. Observe the current screen before choosing a frame.", true);
      return candidate;
    };
    let setupFailure: unknown;
    try {
      try {
        await executeCaptureSetup((capture.setup ?? []).map(action => action.action === "fill" || action.action === "type" ? { ...action, text: inputs.resolve(action.text) } : action), {
          command: async args => { await appIdentity(signalController.signal); return command(args, signalController.signal); },
          open: url => open(url, signalController.signal), snapshot: async () => (await readSnapshot(signalController.signal)).snapshot,
        });
      } catch (error) { setupFailure = error; }
      await runCiAgentNavigation({
        agent: { ...agent, resolveInput: agent.resolveInput ?? inputs.resolve, secretValues: secrets },
        project: capture.project, routes: options.routes, inventory, ...(options.scheme ? { scheme: options.scheme } : {}),
        deadlineMs: deadline, maxTurns: capture.maxActions + options.routes.length * 4 + 10, now: clock,
        redact, redactValue, observe,
        act: async (action, signal) => {
          if (action.action === "tap" && "frameId" in action) {
            const previous = takeCandidate(action.frameId); candidate = undefined;
            try {
              if (![action.x, action.y].every(value => Number.isFinite(value) && value >= 0 && value < 1)) throw captureError("AGENT_COORDINATE_INVALID", "Normalized tap coordinates must be finite numbers from zero up to, but excluding, one.");
              const oldBounds = bounds(previous);
              await observe(signal);
              const fresh = candidate as Candidate | undefined;
              if (!fresh) throw captureError("AGENT_FRAME_STALE", "A fresh safe screenshot is required before a coordinate tap.", true);
              const currentBounds = bounds(fresh);
              const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame } } };
              const changes = {
                boundsChanged: JSON.stringify(oldBounds) !== JSON.stringify(currentBounds),
                accessibilityChanged: coordinateIdentity(previous.snapshot) !== coordinateIdentity(fresh.snapshot),
                // The status bar redraws on its own (clock, simulator indicators); below it only app pixels make a frame stale.
                pixelsChanged: frameChangedForTap(PNG.sync.read(previous.png, { checkCRC: true }), PNG.sync.read(fresh.png, { checkCRC: true }), action.y, statusBarBandPercent(runtime.platform)),
              };
              if (Object.values(changes).some(Boolean)) {
                throw new CiError({ code: "AGENT_FRAME_STALE", stage: "capture",
                  message: "The inspected pixels or UI geometry changed. Observe again before tapping coordinates.",
                  nextAction: "Inspect the changed frame properties in details and observe again before choosing an exact selector or coordinate tap.",
                  retryable: true, details: changes });
              }
              await discard();
              await command(["press", ...toLogical(oldBounds, action.x, action.y).map(String), "--level", "full", "--json"], signal);
            } finally { await discard(); await rm(previous.directory, { recursive: true, force: true }); }
            return;
          }
          await discard();
          await appIdentity(signal);
          if (action.action === "back") return await back(signal);
          else if (action.action === "dismiss-keyboard") await command(["keyboard", "dismiss", "--level", "full", "--json"], signal);
          else if (action.action === "type") await command(["type", action.text, "--level", "full", "--json"], signal);
          else await executeCaptureSetup([action], { command: async args => { await appIdentity(signal); return command(args, signal); },
            open: url => open(url, signal), snapshot: async () => (await readSnapshot(signal)).snapshot,
            readinessAttempts: 3, postActionObservation: "caller" });
        },
        capture: async (route, context, frameId, signal) => {
          liveSignal(signal).throwIfAborted();
          if (clock() >= deadline) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget was exhausted.");
          const frame = takeCandidate(frameId);
          try {
            if (!attempted.has(route.id) && attempted.size >= capture.maxScreens) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture screen budget was exhausted.");
            attempted.add(route.id);
            const captureInventory = inventory.map(item => item.id === route.id ? route : item);
            for (const snapshot of [frame.before, frame.snapshot]) {
              landing(snapshot.nodes, route, captureInventory, true); assertSafeScreenshot(snapshot.nodes); assertAgentCaptureContext(snapshot.nodes, context);
            }
            const info = await lstat(frame.screenshot);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== frame.png.length
              || createHash("sha256").update(await readFile(frame.screenshot)).digest("hex") !== frame.imageSha256) throw captureError("INVALID_SCREENSHOT", "The inspected screenshot changed before acceptance.");
            if (agent.assessCapture) {
              const diagnostics = join(store.root, "capture-diagnostics", "readiness");
              await mkdir(diagnostics, { recursive: true });
              const stem = `${route.id}-${frame.imageSha256}`;
              await writeFile(join(diagnostics, `${stem}.png`), frame.png, { mode: 0o600 });
              const key = `${route.id}:${frame.imageSha256}`;
              let assessment;
              try {
                assessment = rejectedReadiness.get(key) ?? await agent.assessCapture({ image: frame.png, route: route.route, context,
                  instructions: agent.instructions, verifiedLabels: verifiedCaptureLabels(frame.snapshot.nodes, context.requiredLabels, turnedSpace(frame)),
                  deadlineMs: deadline, signal: liveSignal(signal) });
                if (assessment.imageSha256 !== frame.imageSha256) throw new Error("Readiness assessment belongs to another frame");
                await writeFile(join(diagnostics, `${stem}.json`), JSON.stringify(redactValue({ route: route.route, context, ...assessment })), { mode: 0o600 });
              } catch (error) {
                await writeFile(join(diagnostics, `${stem}.json`), JSON.stringify(redactValue({ route: route.route,
                  imageSha256: frame.imageSha256, error: serializeCiError(error, { secrets }) })), { mode: 0o600 });
                throw error;
              }
              if (!assessment.ready) {
                rejectedReadiness.set(key, assessment);
                throw new CiError({ code: "AGENT_CAPTURE_NOT_READY", stage: "capture", message: "The independent image assessment rejected this frame.",
                  nextAction: "Restore the required visible state and observe a new frame. For persistent broken content, stop_blocked; do not submit the same image with a different description.",
                  details: { imageSha256: frame.imageSha256, reason: assessment.reason } });
              }
            }
            const accessibility = join(frame.directory, "accessibility.json");
            await writeFile(accessibility, frame.raw, { flag: "wx", mode: 0o600 });
            const parsed = parseControllerOutput("agent-device", frame.raw), transaction = structuredClone(map);
            runtime.orientation = frame.width > frame.height ? "landscape" : "portrait";
            transaction.run.environment.orientation = runtime.orientation;
            const recorded = await recordObservation({ store, map: transaction, title: route.title ?? route.route, screenId: screenIdFor(route.id), ...(colorScheme ? { colorScheme } : {}),
              route: route.path ?? route.route, variantName: route.variant, start: transaction.screens.length === 0, depth: 0,
              screenshotPath: frame.screenshot, snapshotPath: accessibility, snapshotText: frame.raw, capturedAt: frame.capturedAt,
              elements: parsed.elements, parseWarnings: parsed.warnings, surfaceScope: "app" });
            transaction.frontier = [];
            await store.write(transaction, recorded.preparedArtifacts);
            Object.assign(map, transaction);
            outcomes[route.id] = { status: "captured", attempts: 1, landing: "verified", screenshotSha256: frame.imageSha256 };
            say(`${route.route}: captured by the agent`);
            acceptedFrames[screenIdFor(route.id)] = { frameId: frame.id, imageSha256: frame.imageSha256, capturedAt: frame.capturedAt };
          } finally { await discard(); }
        },
        trace: async event => { await appendFile(tracePath, `${JSON.stringify(redactValue(event))}\n`, { mode: 0o600 }); },
        ...(setupFailure ? { setupFailure } : {}),
      });
      return outcomes;
    } finally { clearTimeout(expiration); signalController.abort(); await discard(); }
  }
  // Targets a setup action reached. A bare app link cannot recreate the state that setup prepared.
  const prepared = new Set<string>();
  /** Observe the prepared target again without repeating the setup action that created it. */
  const observePreparedTarget = (route: SourceRoute, ready: CaptureSetupReady | undefined): readonly Record<string, unknown>[] => {
    settle();
    const nodes = waitForDestination(route);
    if (ready && !setupReadinessHolds({ nodes }, ready)) {
      throw captureError("SETUP_STATE_LOST", "The setup readiness condition no longer holds on the prepared target.");
    }
    return nodes;
  };
  const capturePreparedTarget = async (route: SourceRoute, ready: CaptureSetupReady | undefined, nodes: readonly Record<string, unknown>[]) => {
    // A later setup action can recover this target, but the first unresolved failure stays its reported cause.
    const earlier = prepared.has(route.id) ? outcomes[route.id] : undefined;
    prepared.add(route.id);
    let first: NonNullable<CaptureBundle["outcomes"]>[string] | undefined;
    let attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      attempts = attempt;
      try {
        await captureCurrent(route, attempt, attempt === 1 ? nodes : observePreparedTarget(route, ready));
        return;
      } catch (error) {
        const failure = failedOutcome(error, attempt);
        first ??= failure;
        if (failure.status === "budget-exhausted" || !failure.error?.retryable) break;
      }
    }
    const original = earlier?.error ? earlier : first!;
    outcomes[route.id] = { ...original, attempts: (earlier?.error ? earlier.attempts : 0) + attempts };
  };
  // Outcome errors are already serialized with secrets redacted.
  const reportOutcome = (route: SourceRoute, via: string) => {
    const outcome = outcomes[route.id];
    if (!outcome) return;
    if (outcome.status === "captured") say(`${route.route}: captured ${via}${outcome.attempts > 1 ? ` on attempt ${outcome.attempts}` : ""}`);
    else say(`${route.route}: ${outcome.status}${outcome.error ? ` (${outcome.error.code}: ${outcome.error.message})` : outcome.reason ? ` (${outcome.reason})` : ""}`);
  };
  const setupActions = capture.setup ?? [];
  if (setupActions.length) say(`running ${setupActions.length} setup ${setupActions.length === 1 ? "step" : "steps"}`);
  let setupFailure: unknown;
  /**
   * A setup step that died because the emulator's adb transport dropped or the controller daemon
   * was unreachable says nothing about the app or the configured steps. Once the device answers
   * again, the app is relaunched and the steps run once more from the start; a second fault is
   * reported as the failure it is. Only steps up to the fault have run, so no later state exists.
   */
  const transientControllerFault = (error: unknown) => adbDeviceOffline(error) || remoteDaemonUnavailable(error);
  /**
   * A controller that stopped answering on one screen (its runner wedged on an accessibility capture or a covered
   * control, or its reads stayed busy past their recovery window) fails every later read the same way. That costs the
   * step or route it happened on, not the capture: the app is stopped (from the host on a local device, which a wedged
   * runner cannot block) and started again, the read recovery starts over, and the controller must answer before the
   * next route. Each recovery is recorded in capture-diagnostics/controller-recoveries.jsonl.
   */
  const controllerWedged = (error: unknown): boolean => {
    if (wedgedControllerReadFailure(error)) return true;
    const failure = toCiError(error);
    // An accessibility read that never completes (or never returns a whole tree) is the controller's failure, not the app's.
    return ["CONTROLLER_READ_BUSY", "RUNNER_WEDGED", "CONTROLLER_RUNNER_WEDGED", "INVALID_ACCESSIBILITY_EVIDENCE", "SETUP_SYSTEM_SURFACE_BLOCKING"].includes(failure.code)
      || /execution watchdog|accessibility responsiveness|requires a valid viewport/.test(failure.message);
  };
  /**
   * A setup step that left another app in front (a tap that landed on a system control drawn over the app, as iPhone
   * Duo's status pill over a sheet's Done button) is recovered the same way: the app is started again.
   */
  const appLeft = (error: unknown): boolean => toCiError(error).code === "CONTROLLER_IDENTITY_MISMATCH";
  let recoveries = 0;
  /** `next` records what the capture did once the app restarted: `setup-rerun` or `setup-incomplete` after a setup step. */
  const recoverController = (where: string, error: unknown, next?: "setup-rerun" | "setup-incomplete"): boolean => {
    const reported = serializeCiError(toCiError(error), { secrets });
    const record = (recovered: boolean) => {
      const diagnostics = join(store.root, "capture-diagnostics");
      mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
      appendFileSync(join(diagnostics, "controller-recoveries.jsonl"), `${JSON.stringify({ where, code: reported.code, message: reported.message, recovered,
        ...(recovered && next ? { next } : {}), at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
    };
    if (recoveries >= 3 || deadline - clock() < 60_000) { record(false); return false; }
    recoveries += 1;
    say(`${appLeft(error) ? "the app was no longer in front" : "the device controller stopped answering"} on ${where} (${reported.code}); restarting the app before going on`);
    try {
      if (runtime.provider === "local-simulator") runner(runtime.platform === "ios"
        ? { command: "xcrun", args: ["simctl", "terminate", runtime.controllerDeviceId, capture.bundleId], cwd: store.root, environment: options.environment, timeoutMs: 60_000, allowFailure: true }
        : { command: androidTools(options.environment).adb, args: ["-s", runtime.controllerDeviceId, "shell", "am", "force-stop", capture.bundleId],
          cwd: store.root, environment: options.environment, timeoutMs: 60_000, allowFailure: true });
      for (const key of Object.keys(readRecovery)) delete (readRecovery as Record<string, unknown>)[key];
      readRecovery.busyAttempts = 0;
      controller(["open", capture.bundleId, "--relaunch", "--level", "full", "--json"]);
      settle();
      snapshot();
    } catch { record(false); return false; }
    record(true);
    return true;
  };
  const recoverFromControllerFault = (error: unknown): boolean => {
    if (!transientControllerFault(error) || deadline - clock() < 30_000) return false;
    const reported = serializeCiError(toCiError(error), { secrets });
    say(`setup interrupted by the device controller (${reported.code}: ${reported.message}); waiting for the device, then running setup again`);
    try {
      controllerApp();
      controller(["open", capture.bundleId, "--relaunch", "--level", "full", "--json"]);
      settle();
      controllerApp();
    } catch { return false; }
    const diagnostics = join(store.root, "capture-diagnostics");
    mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
    appendFileSync(join(diagnostics, "controller-retries.jsonl"), `${JSON.stringify({ command: "setup", attempt: 1, delayMs: 0, reason: "setup-rerun-after-controller-fault",
      fault: reported.message, at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
    return true;
  };
  /**
   * A setup step that wedged the controller or left the app has not run, nor have the steps after it (a login, seeded
   * data, a permission), so routes opened by app link may show the wrong state. Once the app is restarted, setup runs
   * again from the start, once. When it stops the same way again, the routes go on by app link (so one covered control
   * does not fail the whole capture), and each route captured afterwards says in its outcome that setup did not complete.
   */
  let setupRerunAfterRecovery = false;
  let setupIncomplete: string | undefined;
  for (let setupAttempt = 0; ; setupAttempt += 1) try {
    await executeCaptureSetup((capture.setup ?? []).map(action => action.action === "fill" || action.action === "type" ? { ...action, text: inputs.resolve(action.text) } : action), {
      command: args => { controllerApp(); return controller(args); },
      open: urlText => {
        const url = new URL(urlText);
        if (!options.scheme || url.protocol !== `${options.scheme}:` || url.username || url.password) throw captureError("SETUP_LINK_OUTSIDE_APP", "A setup URL does not belong to the configured application.");
        const data = controllerData(controller(["open", capture.bundleId, urlText, "--level", "full", "--json"]).stdout, "setup open");
        assertIdentity(data, capture.bundleId, runtime.controllerDeviceId);
        resolveDeepLinkConfirmation(true);
      },
      snapshot: setupSnapshot,
      beforeAction: ({ index, action }) => say(`setup ${index + 1}/${setupActions.length}: ${describeSetupAction(action)}`),
      afterAction: async ({ index, action, snapshot: current }) => {
        // Capture reached source targets before further actions destroy their transient state.
        // A modal is handled by explicit setup actions; it is never captured as the destination.
        if (current.nodes.some(node => node.type === "Alert")) return;
        const markers = captureObserverMarkers(current.nodes);
        const destination = markers.length === 1 ? parseCaptureDestination(markers[0]!.label) : null;
        if (!destination) return;
        const route = options.routes.find(route => outcomes[route.id]?.status !== "captured"
          && captureDestinationMatches(destination, route, inventory));
        if (!route) return;
        const endRoute = (options.timings ?? silentTimings).span("route", { route: route.route, via: "setup" });
        try { await capturePreparedTarget(route, action.ready, current.nodes); }
        finally { endRoute(outcomes[route.id]?.status === "captured" ? "ok" : "failed", { status: outcomes[route.id]?.status ?? "none" }); }
        reportOutcome(route, `after setup step ${index + 1}`);
      },
    });
    // A dialog left open by the last setup step would block every later app link.
    assertNoAlert();
    break;
  } catch (error) {
    if (setupAttempt === 0 && recoverFromControllerFault(error)) continue;
    // A wedged controller says nothing about the app's state: the routes the steps before it prepared are captured or
    // failed on their own. Once the controller answers again, setup runs again from the start, once.
    if ((controllerWedged(error) || appLeft(error)) && recoverController("a setup step", error, setupRerunAfterRecovery ? "setup-incomplete" : "setup-rerun")) {
      const reported = serializeCiError(toCiError(error), { secrets });
      if (!setupRerunAfterRecovery) {
        setupRerunAfterRecovery = true;
        say(`setup stopped (${reported.code}); running setup again from the start`);
        continue;
      }
      setupIncomplete = `Setup did not complete: a setup step stopped twice (${reported.code}), so this route was opened by app link without the state the remaining setup steps prepare.`;
      say(`setup stopped again (${reported.code}); setup did not complete, and the routes it had not reached go on by app link marked as such`);
      break;
    }
    const failure = toCiError(error, { code: "SETUP_FAILED", stage: "setup" });
    const diagnostics: Record<string, string> = {};
    const directory = join(store.root, "capture-diagnostics");
    // Diagnostic frames are deliberately outside the map: an unknown destination
    // must never become a screenshot assigned to a planned source route.
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (lastSnapshot) {
        const redacted = serializeCiError(new CiError({ code: failure.code, stage: "setup", message: failure.message,
          nextAction: failure.nextAction, details: { snapshot: JSON.parse(lastSnapshot) } }), { secrets });
        await writeFile(join(directory, "setup-accessibility.json"), JSON.stringify(redacted.details!.snapshot), { flag: "wx", mode: 0o600 });
        diagnostics.accessibility = "capture-diagnostics/setup-accessibility.json";
      }
      const screenshot = join(directory, "setup-screen.png");
      assertSafeScreenshot(snapshot().nodes);
      await writeFile(screenshot, "", { flag: "wx", mode: 0o600 });
      controller(["screenshot", screenshot, "--level", "full", "--json"]);
      const info = await lstat(screenshot);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 30 * 1024 * 1024) throw new Error("Invalid setup diagnostic image");
      assertDecodedPng(await readFile(screenshot), "Setup diagnostic screenshot");
      diagnostics.screenshot = "capture-diagnostics/setup-screen.png";
      // The app's own log says why a step left the app in an unexpected state (a crash, a rejected link); best effort.
      try {
        const listed = JSON.parse(controller(["logs", "path", "--json"], true).stdout) as unknown;
        const candidates = new Set<string>();
        const collect = (value: unknown): void => {
          if (typeof value === "string") { if (value.startsWith("/") && /\.(log|txt|ndjson)$/.test(value)) candidates.add(value); }
          else if (value && typeof value === "object") Object.values(value).forEach(collect);
        };
        collect(listed);
        for (const candidate of candidates) {
          const logInfo = await lstat(candidate).catch(() => undefined);
          if (!logInfo?.isFile() || logInfo.size === 0) continue;
          const text = await readFile(candidate, "utf8");
          await writeFile(join(directory, "setup-app.log"), redact(text.slice(-512 * 1024)), { flag: "wx", mode: 0o600 });
          diagnostics.appLog = "capture-diagnostics/setup-app.log";
          break;
        }
      } catch (logError) {
        diagnostics.appLogError = serializeCiError(logError, { secrets }).message;
      }
    } catch (diagnosticError) {
      await rm(join(directory, "setup-screen.png"), { force: true });
      diagnostics.captureError = serializeCiError(diagnosticError, { secrets }).message;
    }
    setupFailure = new CiError({ code: failure.code, stage: failure.stage, message: failure.message,
      nextAction: failure.nextAction, retryable: failure.retryable,
      details: { ...failure.details, diagnostics }, cause: error });
    const reported = serializeCiError(failure, { secrets });
    say(`setup failed (${reported.code}: ${reported.message}); routes that need app links will not be captured`);
    break;
  }
  const linked = options.routes.filter(route => !(outcomes[route.id]?.status === "captured" && !setupFailure) && !(prepared.has(route.id) && outcomes[route.id]?.status !== "captured"));
  let opened = 0;
  /**
   * Opens the app's root link, so the route link that follows starts from the app's home rather than from the sheet,
   * modal or list the previous link left on screen. The first attempt only opens it: the route's own readiness poll
   * checks where its link landed and answers a confirmation the OS asks for. A route that landed wrong is retried
   * after a full reset, which lets the root settle and answers the root link's own confirmation first.
   */
  const resetToRoot = (full: boolean) => {
    controller(["open", capture.bundleId, rootLink!, "--level", "full", "--json"]);
    // The root link closes what the last route presented; the next link waits until that has finished. A link that lands
    // while a sheet is still being dismissed can leave the app unable to present another sheet until it is relaunched
    // (seen on iOS: euxy's share link, opened right after its share sheet, never showed its own).
    settle();
    if (!full) return;
    if (snapshot().nodes.some(node => node.type === "Alert")) {
      resolveDeepLinkConfirmation();
      settle();
    }
  };
  if (rootLink) say(`reset: opening ${rootLink} before each route link (capture.reset: root-link)`);
  for (const route of options.routes) {
    capture.signal?.throwIfAborted();
    if (outcomes[route.id]?.status === "captured" && !setupFailure) continue;
    // The default app link would show this route without the prepared state. Keep the setup capture failure.
    if (prepared.has(route.id) && outcomes[route.id]?.status !== "captured") continue;
    const deepLink = captureDeepLink(options.scheme, route);
    if (!deepLink) {
      outcomes[route.id] = { ...unavailableRoute(route), attempts: 0, landing: "unverified" };
      reportOutcome(route, "by app link");
      continue;
    }
    if (setupFailure) {
      outcomes[route.id] = { status: "failed", reason: "Configured UI prerequisites did not complete.", attempts: 0, landing: "unverified",
        error: serializeCiError(toCiError(setupFailure, { code: "SETUP_FAILED", stage: "setup", nextAction: "Correct the configured UI input and setup steps and rerun capture." }), { secrets }) };
      continue;
    }
    if ((!attempted.has(route.id) && attempted.size >= capture.maxScreens) || actions >= capture.maxActions || clock() >= deadline) {
      outcomes[route.id] = { status: "budget-exhausted", attempts: 0, landing: "unverified", reason: "The screen, action, or time budget was exhausted." };
      reportOutcome(route, "by app link");
      continue;
    }
    attempted.add(route.id);
    const endRoute = (options.timings ?? silentTimings).span("route", { route: route.route });
    timingPhase = `route ${route.route}`;
    say(`route ${++opened}/${linked.length} ${route.route}: opening by app link`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Every route link starts from the app's home, not from what the previous link left on
        // screen; the app keeps running, since relaunching invalidates photo and translation prerequisites.
        if (rootLink && deepLink !== rootLink) resetToRoot(attempt > 1);
        const opened = controller(["open", capture.bundleId, deepLink, "--level", "full", "--json"]);
        const device = openedSimulatorDevice(opened.stdout, capture.bundleId, "capture open", runtime.platform);
        // A local simulator is named for Explore and recorded as the model it was created as; its UDID identifies it.
        if (device.deviceId !== runtime.controllerDeviceId
          || (runtime.provider !== "local-simulator" && device.deviceModel !== runtime.deviceModel)) throw captureError("CONTROLLER_IDENTITY_MISMATCH", "The controller changed the selected device.");
        // The open response already proved the controller's device and app; the capture asserts the
        // session again after its screenshot, and resolves a link confirmation only if the snapshot calls for it.
        readiness = { startedAt: clock(), budgetMs: readinessBudgetMs(attempt), attempt };
        settle();
        await captureCurrent(route, attempt);
        break;
      } catch (error) {
        // The emulator's adb connection dropped (a local one does once, early, under load) or the daemon was unreachable:
        // that says nothing about this route. Once the device answers again, the route opens again from the app's root.
        if (attempt === 1 && transientControllerFault(error) && deadline - clock() > 30_000) {
          let answered = true;
          try { controllerApp(); } catch { answered = false; }
          if (answered) {
            const diagnostics = join(store.root, "capture-diagnostics");
            mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
            appendFileSync(join(diagnostics, "controller-retries.jsonl"), `${JSON.stringify({ command: "open", route: route.route, reason: "route-reopened-after-device-lost",
              fault: serializeCiError(toCiError(error), { secrets }).message, at: new Date(clock()).toISOString() })}\n`, { mode: 0o600 });
            continue;
          }
        }
        const failure = failedOutcome(error, attempt);
        // A wedged controller costs this route only: once its retries are spent, the next route starts on a restarted app.
        if (controllerWedged(error) && (attempt === 2 || !failure.error?.retryable)) {
          outcomes[route.id] = { ...failure, reason: "The device controller stopped answering on this screen; Explore restarted the app and went on with the next route." };
          recoverController(route.route, error);
          break;
        }
        if (failure.status === "budget-exhausted" || !failure.error?.retryable || attempt === 2) {
          outcomes[route.id] = failure;
          if (attempt === 2) await captureUnattributed(route, attempt, error);
          break;
        }
      }
    }
    const outcome = outcomes[route.id];
    if (setupIncomplete && outcome?.status === "captured") outcomes[route.id] = { ...outcome, reason: outcome.reason ? `${outcome.reason} ${setupIncomplete}` : setupIncomplete };
    endRoute(outcome?.status === "captured" ? "ok" : "failed", { status: outcome?.status ?? "none" });
    reportOutcome(route, "by app link");
  }
  return outcomes;
}
