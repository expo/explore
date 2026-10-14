/**
 * Touch pan inertia: a finger lifted mid-flick keeps the map moving, decelerating like Apple Maps.
 * The math is UIScrollView's: velocity decays by its deceleration rate (0.998) every millisecond,
 * an exponential with a ~500ms time constant, so the remaining travel is velocity x TIME_CONSTANT.
 */

export type PanInertiaSample = { at: number; x: number; y: number; zoom: number };
export type PanVelocity = { x: number; y: number };

/** Only the last stretch of the gesture decides the release velocity; earlier motion is history. */
export const PAN_INERTIA_SAMPLE_WINDOW_MS = 100;
/** Below this release speed (px/ms) the finger had stopped before lifting: no glide. */
export const PAN_INERTIA_MIN_SPEED = 0.05;
/** Faster flicks than this (px/ms) would throw the map off screen; cap them. */
export const PAN_INERTIA_MAX_SPEED = 8;
/** The glide is over once it moves slower than this (px/ms): well under a pixel a frame. */
export const PAN_INERTIA_STOP_SPEED = 0.01;
/** UIScrollView's normal deceleration rate, 0.998 per ms, as a time constant: -1 / ln(0.998). */
export const PAN_INERTIA_TIME_CONSTANT_MS = 500;

export function recordPanSample(
  samples: PanInertiaSample[],
  sample: PanInertiaSample,
  windowMs = PAN_INERTIA_SAMPLE_WINDOW_MS,
): PanInertiaSample[] {
  // Keep one sample older than the window so a sparse gesture still has a baseline to measure from.
  const next = [...samples, sample];
  let keepFrom = 0;
  while (keepFrom + 1 < next.length && next[keepFrom + 1]!.at <= sample.at - windowMs) keepFrom += 1;
  return keepFrom > 0 ? next.slice(keepFrom) : next;
}

/**
 * The velocity the finger left the map with, or undefined when the release should stop dead:
 * too few samples, a pinch (zoom changed), a finger that paused before lifting, or a release so
 * late after the last move that the finger had already stopped.
 */
export function panReleaseVelocity(
  samples: readonly PanInertiaSample[],
  releasedAt: number,
  options: {
    windowMs?: number;
    minSpeed?: number;
    maxSpeed?: number;
  } = {},
): PanVelocity | undefined {
  const windowMs = options.windowMs ?? PAN_INERTIA_SAMPLE_WINDOW_MS;
  const minSpeed = options.minSpeed ?? PAN_INERTIA_MIN_SPEED;
  const maxSpeed = options.maxSpeed ?? PAN_INERTIA_MAX_SPEED;
  if (samples.length < 2) return undefined;
  const last = samples[samples.length - 1]!;
  // A finger that rested before lifting has no recent samples: the move stream went quiet.
  if (releasedAt - last.at > windowMs) return undefined;
  const recent = samples.filter((sample) => sample.at >= last.at - windowMs);
  const first = recent.length >= 2 ? recent[0]! : samples[samples.length - 2]!;
  if (recent.some((sample) => sample.zoom !== last.zoom) || first.zoom !== last.zoom) return undefined;
  const elapsed = last.at - first.at;
  if (!(elapsed > 0)) return undefined;
  const velocity = { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed };
  const speed = Math.hypot(velocity.x, velocity.y);
  if (!Number.isFinite(speed) || speed < minSpeed) return undefined;
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    return { x: velocity.x * scale, y: velocity.y * scale };
  }
  return velocity;
}

/** How far the glide has carried the map `elapsedMs` after release. */
export function panGlideOffset(
  velocity: PanVelocity,
  elapsedMs: number,
  timeConstantMs = PAN_INERTIA_TIME_CONSTANT_MS,
): PanVelocity {
  const travelled = timeConstantMs * (1 - Math.exp(-Math.max(0, elapsedMs) / timeConstantMs));
  return { x: velocity.x * travelled, y: velocity.y * travelled };
}

/** Milliseconds until the glide slows below `stopSpeed`. */
export function panGlideDuration(
  velocity: PanVelocity,
  timeConstantMs = PAN_INERTIA_TIME_CONSTANT_MS,
  stopSpeed = PAN_INERTIA_STOP_SPEED,
): number {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (!(speed > stopSpeed)) return 0;
  return timeConstantMs * Math.log(speed / stopSpeed);
}

/** d3-zoom hands React Flow the browser event behind a move; a touch gesture arrives as a TouchEvent. */
export function isTouchPanEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && "changedTouches" in event;
}
