import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { HOLD_INITIAL_DELAY_MS, HOLD_FIRST_INTERVAL_MS, HOLD_FLOOR_INTERVAL_MS, holdIntervalMs, holdSchedule } =
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
