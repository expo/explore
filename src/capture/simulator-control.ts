import { CiError } from "../shared/ci-errors.js";
import { isRecord } from "./common.js";

/**
 * Runs the pinned EAS CLI with these arguments; throws when it exits non-zero unless `allowFailure` is set. A runner that
 * knows the exit status reports it as `status`.
 */
export type EasCommand = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => { stdout: string; stderr?: string; status?: number | null };

/**
 * Pauses before each resend of a failed action. Every action Explore runs is idempotent, and the session's host can fail
 * one once: in brentvatne/euxy's baseline run 39348933440, `app.approveUrlScheme` failed in its `simctl spawn … defaults
 * write`, which failed the dark-appearance session and with it the target's whole baseline.
 */
const SIMULATOR_CONTROL_RETRY_DELAYS_MS = [3_000, 6_000] as const;

/**
 * What eas-cli 25.2.0 says when the session's serve-sim predates the action list (it refuses `actions.describe`, or
 * answers it without a catalog), and what an EAS CLI without `simulator:control` says. Those sessions offer no actions,
 * and asking again would not change that.
 */
const NO_ACTION_LIST = /serve-sim version that does not support this action|did not return its list of actions|command simulator:control not found/;

/**
 * The host actions an EAS Simulator iOS session offers through `eas simulator:control` (serve-sim's actions, 0.10.0 and
 * later for the ones Explore uses): an empty set when the session's serve-sim or the EAS CLI predates the list, so a
 * caller falls back to what it did before them. The session is always named by id, never taken from a
 * `.env.eas-simulator` beside it.
 *
 * These are a fallback: what the session's controller can do itself (agent-device or Argent: fold, appearance, a
 * reader reset) goes through the controller. Explore uses an action here only for what neither controller offers —
 * approving a link scheme, restarting SpringBoard, and Argent's appearance (software-mansion/argent#1509).
 *
 * eas-cli prints the list as JSON on stdout only when it succeeds; a failure prints its reason on stderr. A list that
 * fails is asked for again after a pause, and one that still fails throws a retryable error rather than reading as "no
 * actions": in brentvatne/euxy's main baseline run 39487618529, one failed list made the dark-appearance session look as
 * if it offered none, so it dropped dark, approved no link scheme, and skipped the SpringBoard restart its fold needed,
 * which failed the target. A session whose host cannot answer three times in a row would fail those actions too, and
 * capturing on without them publishes a report that silently lacks an appearance; a new session is the way out.
 */
export function simulatorControlActions(eas: EasCommand, sessionId: string, options: SimulatorControlOptions = {}): Set<string> {
  const sleep = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  const args = ["simulator:control", "--list", "--id", sessionId, "--json", "--non-interactive"];
  for (let retry = 0; ; retry += 1) {
    let failure: string;
    try {
      const listed = eas(args, { timeoutMs: 2 * 60_000, allowFailure: true });
      const actions = (() => { try { return JSON.parse(listed.stdout) as unknown; } catch { return undefined; } })();
      if ((listed.status ?? 0) === 0 && isRecord(actions)) return new Set(Object.keys(actions));
      const output = `${listed.stderr ?? ""}\n${listed.stdout}`;
      if (NO_ACTION_LIST.test(output)) return new Set();
      // eas-cli ends a failure with "simulator:control command failed."; the line before it says why.
      failure = output.split("\n").map(line => line.trim()).filter(line => line && !/command failed\.?$/.test(line)).at(-1)?.slice(0, 300) || "it printed no list";
    } catch (error) {
      if (NO_ACTION_LIST.test(error instanceof Error ? error.message : String(error))) return new Set();
      failure = firstLine(error);
    }
    const delayMs = SIMULATOR_CONTROL_RETRY_DELAYS_MS[retry];
    if (delayMs === undefined) throw new CiError({ code: "SIMULATOR_CONTROL_UNAVAILABLE", stage: "session", retryable: true,
      message: `EAS could not list the simulator:control actions of session ${sessionId} after ${retry + 1} attempts: ${failure}`,
      nextAction: "Rerun the capture on a new session. Without the list, Explore cannot tell whether the session can switch appearance, approve the app's links, or restart SpringBoard.",
      details: { sessionId, attempts: retry + 1 } });
    // A list that succeeds on a later attempt would otherwise leave no trace of the failure in the job log.
    process.stderr.write(`simulator:control --list failed for session ${sessionId} (${failure}); asking again in ${delayMs / 1000} s\n`);
    sleep(delayMs);
  }
}

/** Lets a test replace the pause between resends of a failed action. */
export type SimulatorControlOptions = { sleep?: ((milliseconds: number) => void) | undefined };

/**
 * Runs one `eas simulator:control` action on the session; eas-cli fills in the device. A failed action is sent again
 * after a pause; one that still fails throws with EAS's reason.
 */
export function simulatorControl(eas: EasCommand, sessionId: string, action: string, values: readonly string[] = [], options: SimulatorControlOptions = {}): void {
  const sleep = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  // Values follow `--` so one that starts with a dash is never read as a flag.
  const args = ["simulator:control", action, "--id", sessionId, "--json", "--non-interactive", "--", ...values];
  for (let retry = 0; ; retry += 1) {
    try { eas(args, { timeoutMs: 2 * 60_000 }); return; }
    catch (error) {
      const delayMs = SIMULATOR_CONTROL_RETRY_DELAYS_MS[retry];
      if (delayMs === undefined) throw error;
      // A resend that succeeds would otherwise leave no trace of the failure in the job log.
      process.stderr.write(`simulator:control ${action} failed (${firstLine(error)}); sending it again in ${delayMs / 1000} s\n`);
      sleep(delayMs);
    }
  }
}

/**
 * Lets the app open its own links without iOS asking "Open in “App”?" first, like local captures do with simctl. A
 * session without the action keeps the controllers' prompt handling; http and https never prompt and are skipped.
 */
export function approveSessionUrlSchemes(eas: EasCommand, sessionId: string, actions: ReadonlySet<string>, bundleId: string, schemes: readonly string[],
  options: SimulatorControlOptions = {}): string[] {
  if (!actions.has("app.approveUrlScheme")) return [];
  const approved: string[] = [];
  for (const scheme of new Set(schemes.map(value => value.toLowerCase()))) {
    if (scheme === "http" || scheme === "https" || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) continue;
    simulatorControl(eas, sessionId, "app.approveUrlScheme", [bundleId, scheme], options);
    approved.push(scheme);
  }
  return approved;
}

/** The first line of a failure, for a log line. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]!.slice(0, 300);
}
