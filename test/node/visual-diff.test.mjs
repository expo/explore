import assert from "node:assert/strict";
import test from "node:test";

// DOM-free helpers loaded from source through tsx, like the other viewer utility tests.
const { tsImport } = await import("tsx/esm/api");
const { groupVisualRegions, cropFor, outlineRect, formatPercent } = await tsImport("../../viewer/src/utils/visual-diff.ts", import.meta.url);
const { visualDiff } = await tsImport("../../viewer/src/utils/review-model.ts", import.meta.url);

// The Wallet example's /paywall regions, as CI reported them (normalizedRect + share).
const PAYWALL = [
  { x: 5.97, y: 48.63, width: 88.06, height: 4, share: 26.82 },
  { x: 5.97, y: 52.63, width: 88.06, height: 3.32, share: 20.48 },
  { x: 70.4, y: 49.43, width: 19.4, height: 2.63, share: 19.05 },
  { x: 19.9, y: 58.35, width: 24.88, height: 5.84, share: 17.57 },
  { x: 20.15, y: 66.59, width: 41.29, height: 3.2, share: 9.92 },
  { x: 12.69, y: 66.7, width: 18.91, height: 2.86, share: 5.25 },
  { x: 61.44, y: 66.59, width: 25.87, height: 3.2, share: 4.98 },
  { x: 46.77, y: 66.59, width: 26.37, height: 3.2, share: 4.88 },
];
const PHONE_ASPECT = 402 / 874;

test("touching CI regions merge into one change per visible area, top to bottom", () => {
  const changes = groupVisualRegions(PAYWALL);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map(change => change.regionCount), [3, 1, 4]);
  // The annual card, the monthly label it pushed down, and the renewal note.
  assert.ok(changes[0].y < changes[1].y && changes[1].y < changes[2].y);
  // CI's region shares overlap and add up to 108.95%; the changes' shares add up to 100%.
  assert.equal(Number(changes[0].share.toFixed(1)), 60.9);
  assert.equal(Number(changes[2].share.toFixed(1)), 23);
  const total = changes.reduce((sum, change) => sum + change.share, 0);
  assert.equal(Number(total.toFixed(6)), 100);
  assert.deepEqual(groupVisualRegions([]), []);
});

test("regions far apart stay separate changes", () => {
  const changes = groupVisualRegions([
    { x: 0, y: 10, width: 10, height: 2, share: 50 },
    { x: 80, y: 10, width: 10, height: 2, share: 50 },
  ]);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map(change => change.x), [0, 80]);
});

test("crops keep context, a readable width and stay inside the image", () => {
  for (const change of groupVisualRegions(PAYWALL)) {
    const crop = cropFor(change, PHONE_ASPECT);
    assert.ok(crop.x >= 0 && crop.y >= 0, JSON.stringify(crop));
    assert.ok(crop.x + crop.width <= 100.0001 && crop.y + crop.height <= 100.0001, JSON.stringify(crop));
    assert.ok(crop.width >= 60, "a small change is not enlarged into a blur");
    assert.ok(crop.x <= change.x && crop.x + crop.width >= change.x + change.width, "the change is fully shown");
    assert.ok(crop.y <= change.y && crop.y + crop.height >= change.y + change.height, "the change is fully shown");
    // Never wider than 4:1 in pixels.
    assert.ok((crop.width * PHONE_ASPECT) / crop.height <= 4.0001);
  }
  // A change at the top edge shifts the crop down instead of cutting the context away.
  const top = cropFor({ x: 40, y: 0, width: 20, height: 2 }, PHONE_ASPECT);
  assert.equal(top.y, 0);
  assert.ok(top.height > 2);
});

test("outlines get a little room and never leave the image", () => {
  assert.deepEqual(outlineRect({ x: 0, y: 0, width: 100, height: 100 }), { x: 0, y: 0, width: 100, height: 100 });
  const rect = outlineRect({ x: 10, y: 10, width: 20, height: 5 });
  assert.ok(rect.x < 10 && rect.y < 10 && rect.width > 20 && rect.height > 5);
});

test("visual diff data from a report is validated before the viewer draws it", () => {
  assert.equal(visualDiff(undefined), undefined);
  assert.equal(visualDiff({ regions: "nope" }), undefined);
  const parsed = visualDiff({
    mismatchPercentage: 2.31,
    regions: [
      PAYWALL[0],
      { x: -1, y: 0, width: 10, height: 10, share: 1 },
      { x: 95, y: 0, width: 10, height: 10, share: 1 },
      { x: 0, y: 0, width: 0, height: 10, share: 1 },
      { x: 0, y: 0, width: 10, height: 10, share: Number.NaN },
    ],
  });
  assert.deepEqual(parsed, { mismatchPercentage: 2.31, regions: [PAYWALL[0]] });
  assert.deepEqual(visualDiff({ regions: [], ignoredStatusBarRegions: 2 }), { regions: [], ignoredStatusBarRegions: 2 });
  assert.deepEqual(visualDiff({ regions: [], ignoredStatusBarRegions: 0 }), { regions: [] });
  assert.deepEqual(visualDiff({ regions: [], ignoredStatusBarRegions: "2" }), { regions: [] });
  const pill = { kind: "status-bar", x: 84.55, y: 12.24, width: 10.3, height: 10.62 };
  assert.deepEqual(visualDiff({ regions: [], ignoredStatusBarRegions: 1, systemRegions: [pill, { kind: "home-indicator", x: 0, y: 97, width: 100, height: 3 }] }),
    { regions: [], ignoredStatusBarRegions: 1, systemRegions: [pill, { kind: "home-indicator", x: 0, y: 97, width: 100, height: 3 }] });
  assert.deepEqual(visualDiff({ regions: [], systemRegions: [{ kind: "notch", x: 0, y: 0, width: 10, height: 10 }, { ...pill, width: 0 }, { ...pill, x: 101 }, "pill"] }), { regions: [] });
  assert.equal(visualDiff({ regions: Array.from({ length: 200 }, () => PAYWALL[0]) }).regions.length, 64);
});

test("percentages read as people say them", () => {
  assert.equal(formatPercent(2.31), "2.3%");
  assert.equal(formatPercent(25), "25%");
  assert.equal(formatPercent(0.04), "<0.1%");
  assert.equal(formatPercent(0), "0%");
});
