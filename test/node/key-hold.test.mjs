import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { HOLD_INITIAL_DELAY_MS, HOLD_FIRST_INTERVAL_MS, HOLD_FLOOR_INTERVAL_MS, createKeyHold, glideRate, glideWhileHeld, holdIntervalMs, holdSchedule } =
  await tsImport("../../viewer/src/utils/key-hold.ts", import.meta.url);

test("a held paging key waits, then steps sooner and sooner down to a floor", () => {
  assert.equal(holdIntervalMs(1), HOLD_FIRST_INTERVAL_MS);
  const intervals = Array.from({ length: 20 }, (_, index) => holdIntervalMs(index + 1));
  for (let index = 1; index < intervals.length; index += 1) assert.ok(intervals[index] <= intervals[index - 1], `step ${index + 1} is not slower than step ${index}`);
  assert.equal(intervals.at(-1), HOLD_FLOOR_INTERVAL_MS, "the rate settles at the floor");
  assert.ok(intervals.findIndex((interval) => interval === HOLD_FLOOR_INTERVAL_MS) >= 4, "the floor is reached gradually, not on the second step");
  const schedule = holdSchedule(6);
  assert.equal(schedule[0], HOLD_INITIAL_DELAY_MS, "the first held step waits for the initial delay");
  assert.ok(schedule.at(-1) < 2000, "six held steps fit in two seconds");
  assert.ok(HOLD_INITIAL_DELAY_MS > HOLD_FIRST_INTERVAL_MS, "the hold begins slower than it repeats");
});

test("a held key steps on the schedule from its first step, and ends when a step finds nothing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createKeyHold();
  let steps = 0;
  hold.begin("ArrowRight", () => (steps += 1) < 3);
  assert.ok(hold.holding("ArrowRight"));
  assert.ok(!hold.holding("ArrowLeft"));
  t.mock.timers.tick(HOLD_INITIAL_DELAY_MS - 1);
  assert.equal(steps, 0, "nothing before the initial delay");
  t.mock.timers.tick(1);
  assert.equal(steps, 1, "the second step lands after the initial delay");
  t.mock.timers.tick(holdIntervalMs(1));
  assert.equal(steps, 2);
  t.mock.timers.tick(holdIntervalMs(2));
  assert.equal(steps, 3, "the third attempt finds nothing");
  assert.ok(!hold.holding("ArrowRight"), "and the hold ends by itself");
  t.mock.timers.tick(10_000);
  assert.equal(steps, 3, "no further steps");
});

test("ending a hold, or beginning another key, stops the first", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hold = createKeyHold();
  let right = 0;
  let left = 0;
  hold.begin("ArrowRight", () => { right += 1; return true; });
  t.mock.timers.tick(HOLD_INITIAL_DELAY_MS);
  assert.equal(right, 1);
  hold.begin("ArrowLeft", () => { left += 1; return true; });
  assert.ok(!hold.holding("ArrowRight"));
  assert.ok(hold.holding("ArrowLeft"));
  // Mock timers run one scheduled round per tick; a hold schedules the next step from each step.
  t.mock.timers.tick(HOLD_INITIAL_DELAY_MS);
  t.mock.timers.tick(holdIntervalMs(1));
  assert.equal(right, 1, "the first key stopped stepping");
  assert.equal(left, 2);
  hold.end();
  assert.ok(!hold.holding("ArrowLeft"));
  t.mock.timers.tick(holdIntervalMs(2));
  t.mock.timers.tick(1000);
  assert.equal(left, 2);
});

test("another key ends a hold, as the OS's own repeat stops; its own repeats and a modifier do not", () => {
  const key = (code, key = code, repeat = false) => ({ code, key, repeat });
  const hold = createKeyHold();
  hold.begin("ArrowDown", () => true);
  hold.interrupt(key("ArrowDown", "ArrowDown", true));
  hold.interrupt(key("ShiftLeft", "Shift"));
  hold.interrupt(key("MetaLeft", "Meta"));
  assert.ok(hold.holding("ArrowDown"), "its own repeat and a modifier leave it held");
  hold.interrupt(key("Escape"));
  assert.ok(!hold.holding("ArrowDown"), "Esc ends it");
  hold.begin("ArrowDown", () => true);
  hold.interrupt(key("KeyK", "k"));
  assert.ok(!hold.holding("ArrowDown"), "so does the K of ⌘K");
  hold.end();
});

test("a glide moves at its start speed from the key down, then eases up to its top speed", () => {
  const profile = { startRate: 8, topRate: 20, rampMs: 700 };
  assert.equal(glideRate(0, profile), 8, "no pause: it moves at full start speed on the first frame");
  for (let at = 10; at <= 1200; at += 10) assert.ok(glideRate(at, profile) >= glideRate(at - 10, profile), `never slows, at ${at}ms`);
  assert.equal(glideRate(700, profile), 20, "at the end of the ramp, the top speed");
  assert.equal(glideRate(5000, profile), 20, "and no faster");
});

/** Frames on demand: `tick` advances the clock and runs the frame callbacks queued so far. */
function fakeFrames(t) {
  let clock = 0;
  let queue = [];
  t.mock.method(performance, "now", () => clock);
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { queue.push(callback); return queue.length; };
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  return {
    tick(ms) {
      clock += ms;
      const due = queue;
      queue = [];
      for (const callback of due) callback(clock);
    },
    get pending() { return queue.length; },
  };
}

test("a glide starts on the first frame after key down; a tap completes one step, a hold stops where it is released", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames = fakeFrames(t);
  const profile = { startRate: 10, topRate: 10, rampMs: 1 };
  const hold = createKeyHold();
  let moved = 0;
  const move = (steps) => { moved += steps; return true; };

  // A tap: released a third of the way into its step, it goes on to exactly one step at the same speed.
  glideWhileHeld(hold.begin("BracketRight", () => true), move, profile);
  frames.tick(0);
  frames.tick(16);
  assert.ok(Math.abs(moved - 0.16) < 1e-9, `moves on the first frame, with no initial delay (${moved})`);
  frames.tick(16);
  hold.release("BracketRight");
  for (let frame = 0; frame < 20 && frames.pending; frame += 1) frames.tick(16);
  assert.ok(Math.abs(moved - 1) < 1e-9, `a tap covers one step (${moved})`);
  assert.equal(frames.pending, 0, "and the glide is over");

  // A hold: a second in it is well past one step, and it stops on the frame the key is released.
  moved = 0;
  glideWhileHeld(hold.begin("BracketRight", () => true), move, profile);
  for (let frame = 0; frame < 61; frame += 1) frames.tick(16);
  assert.ok(moved > 9 && moved < 11, `ten steps a second (${moved})`);
  hold.release("BracketRight");
  const released = moved;
  for (let frame = 0; frame < 10 && frames.pending; frame += 1) frames.tick(16);
  assert.equal(moved, released, "nothing after release");
  assert.equal(frames.pending, 0);

  // A limit ends the hold.
  glideWhileHeld(hold.begin("BracketLeft", () => true), () => false, profile);
  frames.tick(16);
  assert.ok(!hold.holding("BracketLeft"), "a move that finds nothing ends the hold");
  assert.equal(frames.pending, 0);
});

test("each press glides on its own: a tap still finishing is not taken over by the next press, and an interruption stops it at once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const frames = fakeFrames(t);
  const profile = { startRate: 10, topRate: 10, rampMs: 1 };
  const hold = createKeyHold();
  const moved = { first: 0, second: 0 };
  const mover = (name) => (steps) => { moved[name] += steps; return true; };

  // Tap ], then hold ] again before the tap's step is done: the tap still ends at one step.
  glideWhileHeld(hold.begin("BracketRight", () => true), mover("first"), profile);
  frames.tick(0);
  frames.tick(16);
  hold.release("BracketRight");
  frames.tick(16);
  glideWhileHeld(hold.begin("BracketRight", () => true), mover("second"), profile);
  for (let frame = 0; frame < 61; frame += 1) frames.tick(16);
  assert.ok(Math.abs(moved.first - 1) < 1e-9, `the tap covers one step, not the hold after it (${moved.first})`);
  assert.ok(moved.second > 9 && moved.second < 11, `the hold glides on its own (${moved.second})`);
  hold.release("BracketRight");
  for (let frame = 0; frame < 10 && frames.pending; frame += 1) frames.tick(16);
  assert.equal(frames.pending, 0, "both glides are over");

  // An interruption (Esc, blur, a dialog) stops a glide on its next frame, short of a step.
  moved.first = 0;
  glideWhileHeld(hold.begin("Equal", () => true), mover("first"), profile);
  frames.tick(0);
  frames.tick(16);
  hold.interrupt({ code: "Escape", key: "Escape", repeat: false });
  for (let frame = 0; frame < 10 && frames.pending; frame += 1) frames.tick(16);
  assert.ok(Math.abs(moved.first - 0.16) < 1e-9, `no motion after the interruption (${moved.first})`);
  assert.equal(frames.pending, 0);

  // A finishing tap that reaches a limit leaves the newer hold alone.
  let calls = 0;
  glideWhileHeld(hold.begin("BracketRight", () => true), () => (calls += 1) < 2, profile);
  frames.tick(0);
  frames.tick(16);
  hold.release("BracketRight");
  glideWhileHeld(hold.begin("BracketLeft", () => true), () => true, profile);
  frames.tick(16);
  assert.ok(hold.holding("BracketLeft"), "[ is still held after ]'s tap hit 100%");
  hold.end();
});
