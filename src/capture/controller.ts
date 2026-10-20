import { spawnSync, spawn } from "node:child_process";
import { CiError } from "../shared/ci-errors.js";
import { CONTROLLER_SESSION, isRecord, captureError, parseJson } from "./common.js";
import type { CommandRequest, CommandResult } from "./run.js";

export const MAX_ACCESSIBILITY_EVIDENCE_BYTES = 5 * 1024 * 1024;

export function defaultRunner(request: CommandRequest): CommandResult {
  const result = spawnSync(request.command, request.args, {
    cwd: request.cwd,
    env: request.environment,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
  });
  // A command that timed out or could not run keeps what it printed on its error: a hosted repack's start names its run there.
  if (result.error) throw Object.assign(result.error, { stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  return commandOutcome(request, { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

/** A finished command's output, or the error its exit status and output describe. */
export function commandOutcome(request: CommandRequest, result: { status: number | null; stdout: string; stderr: string }): CommandResult {
  if (result.status !== 0 && !request.allowFailure) {
    const sessionIndex = request.args.indexOf("--session");
    // Our own session or a caller's session attached by explore:session: both answer --json failures with a structured error.
    const structuredFailure = (sessionIndex >= 0 && request.args[sessionIndex + 1] === CONTROLLER_SESSION) || request.args.includes("--json")
      ? controllerCommandFailure(result.stdout, request.args[0] ?? "command") : undefined;
    if (structuredFailure) throw structuredFailure;
    const subcommand = typeof request.args[0] === "string" ? ` ${request.args[0]}` : "";
    const detail = failureDetail(`${result.stderr}\n${result.stdout}`);
    throw new Error(
      `${request.command}${subcommand} exited with status ${result.status ?? "unknown"}`
        + (detail ? `: ${detail}` : ""),
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Keep the CLI tool host responsive while a remote controller request is in flight. */
export async function runAgentControllerCommand(request: CommandRequest, signal: AbortSignal): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, { cwd: request.cwd, env: request.environment, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, failure: unknown, kill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: unknown) => {
      failure ??= error;
      child.kill("SIGTERM");
      kill ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const abort = () => stop(signal.reason ?? new Error("Agent controller request was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    const timeout = request.timeoutMs === undefined ? undefined : setTimeout(() => stop(new CiError({
      code: "CONTROLLER_REQUEST_TIMEOUT", stage: "controller", message: "The controller request exceeded its remaining time budget.",
      nextAction: "Observe the app again before choosing another action; an interrupted mutation must not be replayed automatically." })), request.timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 50 * 1024 * 1024) stop(new Error("The controller response exceeded its output limit."));
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.once("error", error => { failure ??= error; });
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (timeout) clearTimeout(timeout);
      if (kill) clearTimeout(kill);
      if (failure !== undefined) { reject(failure); return; }
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code !== 0 && !request.allowFailure) {
        reject(controllerCommandFailure(result.stdout, request.args[0] ?? "command")
          ?? new Error(`Controller ${request.args[0] ?? "command"} exited with status ${code ?? "unknown"}: ${failureDetail(result.stderr)}`));
      } else resolve(result);
    });
    if (signal.aborted) abort();
  });
}

// Native payloads are private classification evidence, never serialized into CI artifacts.
const nativeControllerFailures = new WeakMap<CiError, Record<string, unknown>>();
const RUNNER_BUSY_MESSAGE = "The iOS runner is still finishing a previous command that exceeded its execution watchdog (usually an accessibility capture on a heavy or animating screen).";
// agent-device 0.21.15 (as 0.20.2) keeps abandoned XCTest work busy for up to
// mainThreadWedgeThreshold (120 s). Work is not cancellable and need not drain in this window.
const CONTROLLER_BUSY_WINDOW_MS = 120_000;
const CONTROLLER_BUSY_MAX_ATTEMPTS = 32;
export type ControllerReadRecovery = {
  busyDeadlineMs?: number; busyAttempts: number; thresholdProbeUsed?: boolean;
  recycleUsed?: boolean; needsVerification?: boolean; terminalFailure?: unknown;
};

/** Keep the meaningful CLI error, rather than the trailing braces of pretty-printed JSON. */
export function controllerCommandFailure(stdout: string, command: string): CiError | undefined {
  if (Buffer.byteLength(stdout) > MAX_ACCESSIBILITY_EVIDENCE_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!isRecord(value) || value.success !== false || !isRecord(value.error)) return undefined;
  const native = value.error;
  if (typeof native.code !== "string" || !/^[A-Z][A-Z0-9_]{0,95}$/.test(native.code)
    || typeof native.message !== "string" || !native.message.trim()) return undefined;
  const details = isRecord(native.details) ? native.details : {};
  const hint = typeof details.hint === "string" ? details.hint : typeof native.hint === "string" ? native.hint : undefined;
  const failure = new CiError({ code: native.code, stage: "controller", message: `${command}: ${native.message.slice(0, 2000)}`,
    nextAction: hint?.slice(0, 1000) ?? "Inspect the current application state and the failed control before rerunning this operation.",
    // A mutation may have run despite its transport failure. Only explicit read retries below are safe.
    retryable: false });
  nativeControllerFailures.set(failure, native);
  return failure;
}

function busyControllerReadFailure(error: unknown): boolean {
  if (!(error instanceof CiError)) return false;
  const native = nativeControllerFailures.get(error);
  if (!native || native.code !== "COMMAND_FAILED" && native.code !== "RUNNER_BUSY") return false;
  const details = isRecord(native.details) ? native.details : {};
  if (details.runnerErrorCode === "RUNNER_WEDGED" || details.runnerFailureReason === "runner_main_thread_wedged") return false;
  if (native.code === "RUNNER_BUSY" || details.runnerErrorCode === "RUNNER_BUSY") return true;
  // agent-device 0.21.x also types its watchdog expiry as MAIN_THREAD_TIMEOUT; 0.20.2 is identified by the derived reason.
  if (details.runnerErrorCode === "MAIN_THREAD_TIMEOUT" || details.runnerFailureReason === "runner_main_thread_execution_timeout") return true;
  // agent-device 0.20.2's lifecycle recovery can drop runnerErrorCode. Accept only its
  // exact retained terminal-failure shape and pinned busy/watchdog messages, not arbitrary timeouts.
  return details.recovery === "runner_reported_failure" && details.lifecycleState === "failed"
    && (native.message === RUNNER_BUSY_MESSAGE || details.transportError === RUNNER_BUSY_MESSAGE
      || native.message === "main thread execution timed out");
}

/**
 * agent-device sends iOS `alert get` to its runner with a fixed 10 s budget and abandons the
 * query when that watchdog expires. Another query on the same screen queues more abandoned work,
 * so a watchdog answer means "unknown", never "no alert".
 */
export function alertWatchdogFailure(error: unknown): boolean {
  if (!(error instanceof CiError)) return false;
  const native = nativeControllerFailures.get(error);
  if (!native) return false;
  const details = isRecord(native.details) ? native.details : {};
  return native.code === "MAIN_THREAD_TIMEOUT" || details.runnerErrorCode === "MAIN_THREAD_TIMEOUT"
    || details.runnerFailureReason === "runner_main_thread_execution_timeout" || native.message === "main thread execution timed out";
}

function responsiveAccessibilityRead(args: readonly string[], result: CommandResult): boolean {
  if (Buffer.byteLength(result.stdout) > MAX_ACCESSIBILITY_EVIDENCE_BYTES) return false;
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { return false; }
  if (!isRecord(value)) return false;
  if (args[0] === "alert" && args[1] === "get") {
    if (value.success === false && isRecord(value.error)) {
      return value.error.code === "COMMAND_FAILED" && value.error.message === "alert not found";
    }
    return value.success === true && isRecord(value.data) && typeof value.data.message === "string"
      && Array.isArray(value.data.items) && value.data.items.length > 0 && value.data.items.every(item => typeof item === "string");
  }
  if (args[0] !== "snapshot" || value.success !== true || !isRecord(value.data) || !Array.isArray(value.data.nodes)) return false;
  const quality = value.data.snapshotQuality;
  // Cached appstate and private-AX snapshots can succeed while XCTest is still occupied.
  // A resolved system modal or a completed XCTest-backed capture establishes responsiveness.
  return value.data.nodes.some(node => isRecord(node) && node.type === "Alert")
    || isRecord(quality) && (quality.state === "healthy" || quality.state === "recovered")
      && (quality.backend === "tree" || quality.backend === "queries");
}

/**
 * agent-device checks the remote daemon's /health, with a 3 s timeout, before it sends a command,
 * and fails with this error when the check gets no answer or a 5xx. The command itself was never
 * sent, so sending it again cannot repeat anything, even a UI action.
 */
export function remoteDaemonUnavailable(error: unknown): boolean {
  if (!(error instanceof CiError)) return false;
  const native = nativeControllerFailures.get(error);
  return !!native && native.code === "COMMAND_FAILED" && native.message === "Remote daemon is unavailable";
}

/**
 * The Android emulator's adb transport drops briefly after boot and while the system settles
 * (`adb: device offline`), and can lose the device for a few seconds mid-run
 * (`adb: device 'emulator-5554' not found`, seen when the snapshot helper is installed);
 * agent-device reports both as retriable. Only observations are resent, because a dropped
 * action may still have reached the device.
 */
export function adbDeviceOffline(error: unknown): boolean {
  if (!(error instanceof CiError)) return false;
  const native = nativeControllerFailures.get(error);
  if (!native || native.code !== "COMMAND_FAILED") return false;
  const details = isRecord(native.details) ? native.details : {};
  return [native.message, details.transportError, details.stderr, details.reason]
    .some(value => typeof value === "string" && /device offline|device_offline|device(?: '[^']*')? not found/.test(value));
}

const ADB_OFFLINE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;
/**
 * How long one observation keeps waiting for the emulator's adb transport to come back. The
 * outage seen on EAS Simulator lasted about 30 s (euxy #156, Android base); the fixed 17 s of
 * resends before this budget gave up in the middle of it and failed the setup it was serving.
 */
export const ADB_OFFLINE_BUDGET_MS = 60_000;
/** The pause before the next resend of an observation that found the device offline, within the budget. */
function adbOfflineDelayMs(retries: number, firstOfflineAt: number | undefined, now: number): number | undefined {
  const delay = ADB_OFFLINE_RETRY_DELAYS_MS[Math.min(retries, ADB_OFFLINE_RETRY_DELAYS_MS.length - 1)]!;
  if (firstOfflineAt !== undefined && now - firstOfflineAt + delay > ADB_OFFLINE_BUDGET_MS) return undefined;
  return delay;
}

/** Waits before each resend of a command whose daemon check failed; a longer outage still fails. */
const REMOTE_DAEMON_RETRY_DELAYS_MS = [2_000, 5_000] as const;
export type RemoteDaemonRetry = { command: string; attempt: number; delayMs: number };

export function wedgedControllerReadFailure(error: unknown): boolean {
  if (!(error instanceof CiError)) return false;
  const native = nativeControllerFailures.get(error);
  return !!native && (native.code === "RUNNER_WEDGED" || native.code === "COMMAND_FAILED"
    && isRecord(native.details) && native.details.runnerErrorCode === "RUNNER_WEDGED");
}

/** Retry only explicit transient observation failures; never replay an uncertain UI mutation. */
export function runControllerRead(options: {
  args: readonly string[];
  run: (timeoutMs: number) => CommandResult;
  deadlineMs: number;
  timeoutMs: number;
  recovery?: ControllerReadRecovery;
  now?: () => number;
  sleep?: (milliseconds: number) => void;
  onRemoteDaemonRetry?: (retry: RemoteDaemonRetry) => void;
}): CommandResult {
  const now = options.now ?? Date.now;
  const readOnly = options.args[0] === "snapshot" || options.args[0] === "appstate"
    || options.args[0] === "alert" && options.args[1] === "get";
  const accessibilityRead = readOnly && options.args[0] !== "appstate";
  const recovery = options.recovery ?? { busyAttempts: 0 };
  const sleep = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  const exhausted = () => new CiError({ code: "CONTROLLER_READ_BUSY", stage: "capture",
    message: "The iOS runner did not establish accessibility responsiveness within its bounded recovery window.",
    nextAction: "Rerun capture on a fresh simulator. If this screen repeatedly stalls accessibility inspection, inspect its animations and the iOS runner diagnostic." });
  let recoveryRead = false, daemonRetries = 0, offlineRetries = 0, firstOfflineAt: number | undefined;
  const terminal = (error: unknown): never => { recovery.terminalFailure = error; throw error; };
  for (;;) {
    if (recovery.terminalFailure !== undefined) throw recovery.terminalFailure;
    const remaining = options.deadlineMs - now();
    if (remaining <= 0) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget was exhausted while observing the application.");
    let recoveryRemaining = readOnly && recovery.busyDeadlineMs !== undefined ? recovery.busyDeadlineMs - now() : Infinity;
    let thresholdProbe = false;
    if (readOnly && recovery.busyAttempts >= CONTROLLER_BUSY_MAX_ATTEMPTS) return terminal(exhausted());
    if (recoveryRemaining <= 0) {
      if (!accessibilityRead || recovery.thresholdProbeUsed || recovery.recycleUsed) return terminal(exhausted());
      // Native RUNNER_WEDGED uses strict >120 s. One observation after that boundary
      // lets the supported daemon invalidate its helper; it is not a reset command.
      const marginMs = Math.max(0, recovery.busyDeadlineMs! + 1 - now());
      if (options.deadlineMs - now() <= marginMs) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget cannot accommodate the final controller observation.");
      if (marginMs > 0) sleep(marginMs);
      recovery.thresholdProbeUsed = true;
      thresholdProbe = true;
      recoveryRemaining = Infinity;
    }
    let result: CommandResult | undefined;
    let failure: unknown;
    try {
      result = options.run(Math.min(options.timeoutMs, options.deadlineMs - now(), recoveryRemaining));
      failure = controllerCommandFailure(result.stdout, options.args[0] ?? "command");
    } catch (error) { failure = error; }
    // The command was never sent (see remoteDaemonUnavailable), so it is sent again after a pause.
    const daemonDelayMs = !thresholdProbe && remoteDaemonUnavailable(failure) ? REMOTE_DAEMON_RETRY_DELAYS_MS[daemonRetries] : undefined;
    if (daemonDelayMs !== undefined && options.deadlineMs - now() > daemonDelayMs) {
      daemonRetries += 1;
      options.onRemoteDaemonRetry?.({ command: options.args[0] ?? "command", attempt: daemonRetries, delayMs: daemonDelayMs });
      sleep(daemonDelayMs);
      continue;
    }
    if (readOnly && !thresholdProbe && adbDeviceOffline(failure)) firstOfflineAt ??= now();
    const offlineDelayMs = readOnly && !thresholdProbe && adbDeviceOffline(failure) ? adbOfflineDelayMs(offlineRetries, firstOfflineAt, now()) : undefined;
    if (offlineDelayMs !== undefined && options.deadlineMs - now() > offlineDelayMs) {
      offlineRetries += 1;
      options.onRemoteDaemonRetry?.({ command: options.args[0] ?? "command", attempt: offlineRetries, delayMs: offlineDelayMs });
      sleep(offlineDelayMs);
      continue;
    }
    const responsive = result !== undefined && responsiveAccessibilityRead(options.args, result);
    const busy = readOnly && busyControllerReadFailure(failure);
    if (recovery.recycleUsed && wedgedControllerReadFailure(failure)) return terminal(failure);
    if (accessibilityRead && recovery.busyDeadlineMs !== undefined && !recovery.recycleUsed && wedgedControllerReadFailure(failure)) {
      // Pinned runner-session.ts awaits helper-only invalidation before returning WEDGED.
      // The next ordinary read starts a fresh helper; no app open/close or action is replayed.
      recovery.recycleUsed = true;
      recovery.needsVerification = true;
      delete recovery.busyDeadlineMs;
      recovery.busyAttempts = 0;
      recoveryRead = true;
      continue;
    }
    // An ineligible WEDGED still invalidates the helper in the daemon. Preserve its
    // response, but prevent a later action from implicitly creating an unverified helper.
    if (wedgedControllerReadFailure(failure)) recovery.terminalFailure = failure;
    // The caller treats this answer as unknown and checks the accessibility snapshot instead.
    if (result && options.args[0] === "alert" && options.args[1] === "get" && !thresholdProbe && !recoveryRead
      && alertWatchdogFailure(failure)) return result;
    if ((thresholdProbe || recoveryRead) && !responsive) return terminal(busy ? exhausted() : failure ?? exhausted());
    // Preserve terminal native failures (including RUNNER_WEDGED). A late successful
    // response must still not extend either budget or clear an exhausted recovery window.
    if (readOnly && (!failure || responsive || busy)) {
      if (now() >= options.deadlineMs) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget was exhausted while observing the application.");
      if (!thresholdProbe && recovery.busyDeadlineMs !== undefined && now() >= recovery.busyDeadlineMs) return terminal(exhausted());
    }
    if (!busy) {
      if (result) {
        if (responsive) {
          delete recovery.busyDeadlineMs;
          recovery.busyAttempts = 0;
        }
        return result;
      }
      throw failure;
    }
    if (thresholdProbe || recovery.recycleUsed) return terminal(exhausted());
    recovery.busyDeadlineMs ??= now() + CONTROLLER_BUSY_WINDOW_MS;
    recovery.busyAttempts += 1;
    if (recovery.busyAttempts >= CONTROLLER_BUSY_MAX_ATTEMPTS || now() >= recovery.busyDeadlineMs) throw exhausted();
    const delayMs = Math.min(1000 * 2 ** Math.min(recovery.busyAttempts - 1, 3), 5000, recovery.busyDeadlineMs - now());
    if (options.deadlineMs - now() <= delayMs) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget cannot accommodate another observation retry.");
    // Host backoff lets abandoned XCTest work drain; issuing controller wait would queue more work.
    sleep(delayMs);
  }
}


/** Async equivalent for the CLI-owned agent tool host; deterministic execution stays synchronous. */
export async function runControllerReadAsync(options: {
  args: readonly string[];
  run: (timeoutMs: number) => Promise<CommandResult>;
  deadlineMs: number;
  timeoutMs: number;
  recovery?: ControllerReadRecovery;
  now?: () => number;
  signal: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  onRemoteDaemonRetry?: (retry: RemoteDaemonRetry) => void;
}): Promise<CommandResult> {
  const now = options.now ?? Date.now;
  const readOnly = options.args[0] === "snapshot" || options.args[0] === "appstate"
    || options.args[0] === "alert" && options.args[1] === "get";
  const accessibilityRead = readOnly && options.args[0] !== "appstate";
  const recovery = options.recovery ?? { busyAttempts: 0 };
  const sleep = options.sleep ?? (milliseconds => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
    const timer = setTimeout(() => { options.signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  }));
  const exhausted = () => new CiError({ code: "CONTROLLER_READ_BUSY", stage: "capture",
    message: "The iOS runner did not establish accessibility responsiveness within its bounded recovery window.",
    nextAction: "Rerun capture on a fresh simulator. If this screen repeatedly stalls accessibility inspection, inspect its animations and the iOS runner diagnostic." });
  let recoveryRead = false, daemonRetries = 0, offlineRetries = 0, firstOfflineAt: number | undefined;
  const terminal = (error: unknown): never => { recovery.terminalFailure = error; throw error; };
  for (;;) {
    options.signal.throwIfAborted();
    if (recovery.terminalFailure !== undefined) throw recovery.terminalFailure;
    const remaining = options.deadlineMs - now();
    if (remaining <= 0) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget was exhausted while observing the application.");
    let recoveryRemaining = readOnly && recovery.busyDeadlineMs !== undefined ? recovery.busyDeadlineMs - now() : Infinity;
    let thresholdProbe = false;
    if (readOnly && recovery.busyAttempts >= CONTROLLER_BUSY_MAX_ATTEMPTS) return terminal(exhausted());
    if (recoveryRemaining <= 0) {
      if (!accessibilityRead || recovery.thresholdProbeUsed || recovery.recycleUsed) return terminal(exhausted());
      // Native RUNNER_WEDGED uses strict >120 s. One observation after that boundary
      // lets the supported daemon invalidate its helper; it is not a reset command.
      const marginMs = Math.max(0, recovery.busyDeadlineMs! + 1 - now());
      if (options.deadlineMs - now() <= marginMs) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget cannot accommodate the final controller observation.");
      if (marginMs > 0) await sleep(marginMs);
      recovery.thresholdProbeUsed = true;
      thresholdProbe = true;
      recoveryRemaining = Infinity;
    }
    let result: CommandResult | undefined;
    let failure: unknown;
    try {
      result = await options.run(Math.min(options.timeoutMs, options.deadlineMs - now(), recoveryRemaining));
      failure = controllerCommandFailure(result.stdout, options.args[0] ?? "command");
    } catch (error) { failure = error; }
    // The command was never sent (see remoteDaemonUnavailable), so it is sent again after a pause.
    const daemonDelayMs = !thresholdProbe && remoteDaemonUnavailable(failure) ? REMOTE_DAEMON_RETRY_DELAYS_MS[daemonRetries] : undefined;
    if (daemonDelayMs !== undefined && options.deadlineMs - now() > daemonDelayMs) {
      daemonRetries += 1;
      options.onRemoteDaemonRetry?.({ command: options.args[0] ?? "command", attempt: daemonRetries, delayMs: daemonDelayMs });
      await sleep(daemonDelayMs);
      continue;
    }
    if (readOnly && !thresholdProbe && adbDeviceOffline(failure)) firstOfflineAt ??= now();
    const offlineDelayMs = readOnly && !thresholdProbe && adbDeviceOffline(failure) ? adbOfflineDelayMs(offlineRetries, firstOfflineAt, now()) : undefined;
    if (offlineDelayMs !== undefined && options.deadlineMs - now() > offlineDelayMs) {
      offlineRetries += 1;
      options.onRemoteDaemonRetry?.({ command: options.args[0] ?? "command", attempt: offlineRetries, delayMs: offlineDelayMs });
      await sleep(offlineDelayMs);
      continue;
    }
    const responsive = result !== undefined && responsiveAccessibilityRead(options.args, result);
    const busy = readOnly && busyControllerReadFailure(failure);
    if (recovery.recycleUsed && wedgedControllerReadFailure(failure)) return terminal(failure);
    if (accessibilityRead && recovery.busyDeadlineMs !== undefined && !recovery.recycleUsed && wedgedControllerReadFailure(failure)) {
      // Pinned runner-session.ts awaits helper-only invalidation before returning WEDGED.
      // The next ordinary read starts a fresh helper; no app open/close or action is replayed.
      recovery.recycleUsed = true;
      recovery.needsVerification = true;
      delete recovery.busyDeadlineMs;
      recovery.busyAttempts = 0;
      recoveryRead = true;
      continue;
    }
    // An ineligible WEDGED still invalidates the helper in the daemon. Preserve its
    // response, but prevent a later action from implicitly creating an unverified helper.
    if (wedgedControllerReadFailure(failure)) recovery.terminalFailure = failure;
    // The caller treats this answer as unknown and checks the accessibility snapshot instead.
    if (result && options.args[0] === "alert" && options.args[1] === "get" && !thresholdProbe && !recoveryRead
      && alertWatchdogFailure(failure)) return result;
    if ((thresholdProbe || recoveryRead) && !responsive) return terminal(busy ? exhausted() : failure ?? exhausted());
    // Preserve terminal native failures (including RUNNER_WEDGED). A late successful
    // response must still not extend either budget or clear an exhausted recovery window.
    if (readOnly && (!failure || responsive || busy)) {
      if (now() >= options.deadlineMs) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget was exhausted while observing the application.");
      if (!thresholdProbe && recovery.busyDeadlineMs !== undefined && now() >= recovery.busyDeadlineMs) return terminal(exhausted());
    }
    if (!busy) {
      if (result) {
        if (responsive) {
          delete recovery.busyDeadlineMs;
          recovery.busyAttempts = 0;
        }
        return result;
      }
      throw failure;
    }
    if (thresholdProbe || recovery.recycleUsed) return terminal(exhausted());
    recovery.busyDeadlineMs ??= now() + CONTROLLER_BUSY_WINDOW_MS;
    recovery.busyAttempts += 1;
    if (recovery.busyAttempts >= CONTROLLER_BUSY_MAX_ATTEMPTS || now() >= recovery.busyDeadlineMs) throw exhausted();
    const delayMs = Math.min(1000 * 2 ** Math.min(recovery.busyAttempts - 1, 3), 5000, recovery.busyDeadlineMs - now());
    if (options.deadlineMs - now() <= delayMs) throw captureError("CAPTURE_BUDGET_EXHAUSTED", "The capture time budget cannot accommodate another observation retry.");
    // Host backoff lets abandoned XCTest work drain; issuing controller wait would queue more work.
    await sleep(delayMs);
  }
}


function failureDetail(output: string): string {
  const cleaned = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^★|^To upgrade|^npm install -g|^Proceeding with outdated/.test(line));
  return cleaned.slice(-6).join(" | ").slice(-600);
}

function runtimeText(value: unknown, name: string, maximum = 128): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || !value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export function controllerData(stdout: string, command: string): Record<string, unknown> {
  const value = parseJson(stdout, command);
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) {
    const failure = controllerCommandFailure(stdout, command);
    if (failure) throw failure;
    throw new Error(`${command} did not return a successful agent-device JSON envelope`);
  }
  return value.data;
}

export function openedSimulatorDevice(
  stdout: string,
  bundleId: string,
  command: string,
  platform: "ios" | "android" = "ios",
  expectedSession: string = CONTROLLER_SESSION,
): { deviceId: string; deviceModel: string } {
  const data = controllerData(stdout, command);
  if (data.session !== expectedSession) {
    throw new Error(`${command} did not return the fixed controller session`);
  }
  if (data.appBundleId !== bundleId) {
    throw new Error(`${command} did not open the requested ${platform === "ios" ? "iOS" : "Android"} app`);
  }
  if (isRecord(data.device)) {
    if (
      data.device.platform !== platform
      || data.device.target !== "mobile"
      || !isRecord(data.identifiers)
      || data.identifiers.session !== expectedSession
      || data.identifiers.appBundleId !== bundleId
    ) {
      throw new Error(`${command} did not return the expected full ${platform} device shape`);
    }
    const deviceModel = runtimeText(data.device.name, `${command} device model`);
    const deviceId = runtimeText(data.device.id, `${command} device id`, 256);
    if (data.identifiers.deviceName !== deviceModel) {
      throw new Error(`${command} returned inconsistent device model identifiers`);
    }
    if (data.identifiers.deviceId !== deviceId) {
      throw new Error(`${command} returned inconsistent device identifiers`);
    }
    return { deviceId, deviceModel };
  }
  if (
    data.platform !== platform
    || data.target !== "mobile"
    || typeof data.device !== "string"
  ) {
    throw new Error(`${command} did not return the expected compact ${platform} device shape`);
  }
  const deviceId = runtimeText(data.id, `${command} device id`, 256);
  if (data.device_udid !== deviceId) {
    throw new Error(`${command} returned inconsistent compact device identifiers`);
  }
  return {
    deviceId,
    deviceModel: runtimeText(data.device, `${command} device model`),
  };
}
