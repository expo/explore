import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const keyHold = await tsImport("../../viewer/src/utils/key-hold.ts", import.meta.url);
const { HOLD_INITIAL_DELAY_MS, HOLD_FIRST_INTERVAL_MS, HOLD_FLOOR_INTERVAL_MS, holdIntervalMs, holdSchedule } = keyHold;
const await_import_cache = { keyHold };

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
  const { createKeyHold } = await_import_cache.keyHold;
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
  const { createKeyHold } = await_import_cache.keyHold;
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
