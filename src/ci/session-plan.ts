import type { ColorScheme } from "../capture/appearance.js";

/** One route capture on a remote session, with the bridge thread (observed ~5 s; 9.4 s before it). */
export const ROUTE_SECONDS = 5;
/** Observing the app launch once per appearance. */
export const LAUNCH_SECONDS = 28;
/** A pass moves to its own session only when that shortens the side by at least this much. */
export const SPLIT_MIN_SAVING_SECONDS = 60;
/**
 * `capture.maxSessions` when the config sets none: the simulators a typical EAS plan runs at once. A starter plan runs
 * one per platform, so its config sets the ceiling lower (2 for an iOS and an Android target).
 */
export const DEFAULT_MAX_SESSIONS = 5;

export type SessionShareInput = {
  /** `capture.maxSessions`: the review-wide ceiling; absent means DEFAULT_MAX_SESSIONS. */
  maxSessions: number | undefined;
  /** The review's target ids in config order, and the one this job captures. */
  targets: readonly string[];
  target: string;
  /** Targets a split pays off most for take the sessions that do not divide evenly: foldables and large screens first. */
  prefer?: (target: string) => number;
};

/**
 * This job's share of the review's session ceiling: the ceiling divided over the targets, the remainder going to the
 * preferred targets (foldables) in config order, and unused when there are none. Never below 1 (a side then captures after the other): under a ceiling below the
 * number of targets, at most that many target jobs run at once (maxParallelTargets).
 */
export function sessionShare(input: SessionShareInput): number {
  const count = Math.max(1, input.targets.length);
  const ceiling = input.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const base = Math.floor(ceiling / count);
  let remainder = ceiling - base * count;
  // A session left over goes to a preferred target only; without one it stays unused (two targets of five: two each).
  const ranked = input.targets.filter(id => (input.prefer?.(id) ?? 0) > 0)
    .sort((a, b) => input.prefer!(b) - input.prefer!(a) || input.targets.indexOf(a) - input.targets.indexOf(b));
  const extra = new Set<string>();
  for (const id of ranked) { if (remainder <= 0) break; extra.add(id); remainder -= 1; }
  return Math.max(1, base + (extra.has(input.target) ? 1 : 0));
}

/** How many target jobs one review runs at once: each needs a session, so never more than the ceiling. */
export function maxParallelTargets(maxSessions: number | undefined, targets: number): number {
  return Math.max(1, Math.min(targets, maxSessions ?? DEFAULT_MAX_SESSIONS));
}

export type SidePlan = {
  /** Whether head and base capture at the same time. */
  concurrentSides: boolean;
  /** The appearance passes of one side, each on its own session; one entry means the side keeps a single session. */
  passes: readonly (readonly ColorScheme[])[];
};

/**
 * How one target's job spends its share of sessions: both sides at once when it has two, and a side's appearance passes
 * in separate sessions only when the pass moved out shortens the side by at least a minute (a session costs its fixed
 * boot and install time, so a few routes are not worth one). Sessions the work cannot fill stay unused: the ceiling is
 * a limit, not a target.
 */
export function planSideSessions(input: { share: number; sides: 1 | 2; routes: number; schemes: readonly ColorScheme[];
  minSavingSeconds?: number; routeSeconds?: number; launchSeconds?: number }): SidePlan {
  const minSaving = input.minSavingSeconds ?? SPLIT_MIN_SAVING_SECONDS, perRoute = input.routeSeconds ?? ROUTE_SECONDS, launch = input.launchSeconds ?? LAUNCH_SECONDS;
  const concurrentSides = input.sides === 1 || input.share >= 2;
  const perSide = Math.floor(input.share / (concurrentSides ? input.sides : 1));
  const schemes = [...input.schemes];
  const passSeconds = input.routes * perRoute + launch;
  const splitAppearances = schemes.length > 1 && perSide >= schemes.length && passSeconds >= minSaving;
  return { concurrentSides, passes: splitAppearances ? schemes.map(scheme => [scheme]) : [schemes] };
}
