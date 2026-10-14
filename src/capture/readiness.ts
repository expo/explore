import type { Platform } from "../types.js";

/** Seconds a route link gets to show its destination after `open` returns: a healthy route lands in ~2 s on either
    platform (audit E4), a sheet after a reset within ~6 s; Android snapshots are a third slower. */
export function defaultReadinessSeconds(platform: Platform): number {
  return platform === "android" ? 10 : 8;
}

/** One snapshot per poll at most this often; a snapshot itself takes 0.6-0.8 s on a device. */
export const READINESS_POLL_MS = 600;
