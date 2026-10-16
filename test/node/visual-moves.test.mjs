import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { groupVisualRegions, formatMove, layoutShiftSummary } = await tsImport("../../viewer/src/utils/visual-diff.ts", import.meta.url);

const move = (y, x = 0, unit = "pt") => ({ x: x / 4, y: y / 8, amount: { x, y }, unit });
const region = (y, height, shift, x = 10, width = 60) => ({ x, y, width, height, share: 10, ...(shift === undefined ? {} : { move: shift }) });

test("areas that moved by about the same amount read as one, across a gap that would keep changed areas apart", () => {
  // A sheet's title, button and footer moved up 4pt, 5% of the height apart.
  const sheet = groupVisualRegions([region(60, 5, move(-4)), region(70, 5, move(-4.33)), region(80, 3, move(-3.83))]);
  assert.equal(sheet.length, 1);
  assert.equal(formatMove(sheet[0]), "↑4pt", "half a point of spread is measurement noise");
  // The same areas with changed content stay apart, as before.
  assert.equal(groupVisualRegions([region(60, 5), region(70, 5), region(80, 3)]).length, 3);
  // A moved area and a changed one that touch are not merged, and neither are areas that moved by different amounts.
  assert.equal(groupVisualRegions([region(60, 5, move(-4)), region(65, 5)]).length, 2);
  assert.equal(groupVisualRegions([region(30, 5, move(1)), region(36, 5, move(4))]).length, 2);
  assert.equal(groupVisualRegions([region(30, 5, move(1)), region(36, 5, move(-1))]).length, 2, "up and down did not move together");
});

test("a merged area that moved by different amounts says so as a range", () => {
  const rows = groupVisualRegions([region(40, 5, move(1.5)), region(46, 5, move(2)), region(52, 5, move(2.33))]);
  assert.equal(rows.length, 1);
  assert.equal(formatMove(rows[0]), "↓1.5–2.5pt");
  assert.equal(formatMove({ move: move(1, 2, "px") }), "→2 ↓1px", "a sideways move is named too, in Android's screenshot pixels");
  assert.equal(formatMove({ move: move(0.6) }), "↓0.5pt");
});

test("What changed summarizes a screen whose every area moved, per direction, and nothing when any content changed", () => {
  const moved = groupVisualRegions([region(20, 5, move(1)), region(40, 5, move(2)), region(70, 5, move(-4))]);
  assert.deepEqual(layoutShiftSummary(moved), ["2 areas moved down 1–2pt.", "1 area moved up 4pt."]);
  assert.equal(layoutShiftSummary([...moved, ...groupVisualRegions([region(90, 3)])]), undefined);
  assert.equal(layoutShiftSummary([]), undefined);
});
