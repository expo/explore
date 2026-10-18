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

/** Runs one `eas simulator:control` action on the session; eas-cli fills in the device. Throws with EAS's reason. */
export function simulatorControl(eas: EasCommand, sessionId: string, action: string, values: readonly string[] = []): void {
  // Values follow `--` so one that starts with a dash is never read as a flag.
  eas(["simulator:control", action, "--id", sessionId, "--json", "--non-interactive", "--", ...values], { timeoutMs: 2 * 60_000 });
}

/**
 * Lets the app open its own links without iOS asking "Open in “App”?" first, like local captures do with simctl. A
 * session without the action keeps the controllers' prompt handling; http and https never prompt and are skipped.
 */
export function approveSessionUrlSchemes(eas: EasCommand, sessionId: string, actions: ReadonlySet<string>, bundleId: string, schemes: readonly string[]): string[] {
  if (!actions.has("app.approveUrlScheme")) return [];
  const approved: string[] = [];
  for (const scheme of new Set(schemes.map(value => value.toLowerCase()))) {
    if (scheme === "http" || scheme === "https" || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) continue;
    simulatorControl(eas, sessionId, "app.approveUrlScheme", [bundleId, scheme]);
    approved.push(scheme);
  }
  return approved;
}
