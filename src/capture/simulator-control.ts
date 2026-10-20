import { isRecord } from "./common.js";

/** Runs the pinned EAS CLI with these arguments; throws when it exits non-zero unless `allowFailure` is set. */
export type EasCommand = (args: string[], options?: { timeoutMs?: number; allowFailure?: boolean }) => { stdout: string; stderr?: string };

/**
 * The host actions an EAS Simulator iOS session offers through `eas simulator:control` (serve-sim's actions, 0.10.0 and
 * later for the ones Explore uses): an empty set when the session or the EAS CLI offers none, so a caller falls back to
 * what it did before them. The session is always named by id, never taken from a `.env.eas-simulator` beside it.
 *
 * These are a fallback: what the session's controller can do itself (agent-device or Argent: fold, appearance, a
 * reader reset) goes through the controller. Explore uses an action here only for what neither controller offers —
 * approving a link scheme, restarting SpringBoard, and Argent's appearance (software-mansion/argent#1509).
 */
export function simulatorControlActions(eas: EasCommand, sessionId: string): Set<string> {
  try {
    const listed = eas(["simulator:control", "--list", "--id", sessionId, "--json", "--non-interactive"], { timeoutMs: 2 * 60_000, allowFailure: true });
    const actions = JSON.parse(listed.stdout) as unknown;
    return new Set(isRecord(actions) ? Object.keys(actions) : []);
  } catch { return new Set(); }
}

/**
 * Pauses before each resend of a failed action. Every action Explore runs is idempotent, and the session's host can fail
 * one once: in brentvatne/euxy's baseline run 39348933440, `app.approveUrlScheme` failed in its `simctl spawn … defaults
 * write`, which failed the dark-appearance session and with it the target's whole baseline.
 */
const SIMULATOR_CONTROL_RETRY_DELAYS_MS = [3_000, 6_000] as const;

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
