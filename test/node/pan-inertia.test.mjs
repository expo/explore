import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const inertia = await tsImport(
  "../../viewer/src/components/canvas/pan-inertia.ts",
  import.meta.url,
);

function flick(pxPerMs, { frames = 12, frameMs = 16, zoom = 0.6 } = {}) {
  let samples = [];
  for (let index = 0; index < frames; index += 1) {
    const at = 1000 + index * frameMs;
    samples = inertia.recordPanSample(samples, { at, x: 100 - pxPerMs * (at - 1000), y: 40, zoom });
  }
  return samples;
}

test("a flick released while still moving carries its velocity, capped for wild throws", () => {
  const samples = flick(1.5);
  const released = samples[samples.length - 1].at + 8;
  const velocity = inertia.panReleaseVelocity(samples, released);
  assert.ok(velocity);
  assert.ok(Math.abs(velocity.x + 1.5) < 1e-9, `x velocity ${velocity.x}`);
  assert.equal(velocity.y, 0);

  const wild = inertia.panReleaseVelocity(flick(40), released);
  assert.ok(wild);
  assert.ok(Math.abs(Math.hypot(wild.x, wild.y) - inertia.PAN_INERTIA_MAX_SPEED) < 1e-9);
});

test("only the last stretch of the gesture counts: a fast start followed by a slow finish barely glides", () => {
  let samples = flick(3, { frames: 20 });
  const lastFast = samples[samples.length - 1];
  for (let index = 1; index <= 8; index += 1) {
    const at = lastFast.at + index * 16;
    samples = inertia.recordPanSample(samples, { at, x: lastFast.x - 0.03 * index * 16, y: 40, zoom: 0.6 });
  }
  const velocity = inertia.panReleaseVelocity(samples, samples[samples.length - 1].at + 8);
  assert.equal(velocity, undefined, "a finish slower than the threshold stops dead");
  assert.ok(samples.length <= 9, `samples outside the window are dropped (${samples.length} kept)`);
});

test("a slow drag, a finger that paused before lifting, or a pinch release stop dead", () => {
  assert.equal(inertia.panReleaseVelocity(flick(0.02), 1200), undefined);
  const paused = flick(2);
  assert.equal(inertia.panReleaseVelocity(paused, paused[paused.length - 1].at + 250), undefined);
  const pinch = flick(2).map((sample, index) => ({ ...sample, zoom: 0.6 + index * 0.01 }));
  assert.equal(inertia.panReleaseVelocity(pinch, pinch[pinch.length - 1].at + 8), undefined);
  assert.equal(inertia.panReleaseVelocity([{ at: 0, x: 0, y: 0, zoom: 1 }], 10), undefined);
});

test("the glide decays exponentially and settles at velocity x time constant", () => {
  const velocity = { x: 2, y: -1 };
  const tau = inertia.PAN_INERTIA_TIME_CONSTANT_MS;
  assert.equal(tau, 500, "UIScrollView's normal deceleration rate (0.998/ms) is a 500ms time constant");
  assert.deepEqual(inertia.panGlideOffset(velocity, 0), { x: 0, y: -0 });
  const early = inertia.panGlideOffset(velocity, tau);
  assert.ok(Math.abs(early.x - 2 * tau * (1 - Math.exp(-1))) < 1e-9);
  const duration = inertia.panGlideDuration(velocity);
  const settled = inertia.panGlideOffset(velocity, duration);
  assert.ok(settled.x > 0.98 * 2 * tau && settled.x < 2 * tau, `settled x ${settled.x}`);
  assert.ok(settled.y < -0.98 * tau && settled.y > -tau, `settled y ${settled.y}`);
  // Faster flicks glide longer and further.
  assert.ok(inertia.panGlideDuration({ x: 4, y: 0 }) > duration);
  assert.equal(inertia.panGlideDuration({ x: 0.01, y: 0 }), 0);
});

test("a touch gesture is told apart from a mouse or wheel move by the event React Flow forwards", () => {
  assert.equal(inertia.isTouchPanEvent({ changedTouches: [] }), true);
  assert.equal(inertia.isTouchPanEvent({ clientX: 1, clientY: 2 }), false);
  assert.equal(inertia.isTouchPanEvent(null), false);
  assert.equal(inertia.isTouchPanEvent(undefined), false);
});
