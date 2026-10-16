import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { groupVisualRegions, formatMove, layoutShiftSummary } = await tsImport("../../viewer/src/utils/visual-diff.ts", import.meta.url);

const move = (y, x = 0, unit = "pt") => ({ x: x / 4, y: y / 8, amount: { x, y }, unit });
const region = (y, height, shift, x = 10, width = 60) => ({ x, y, width, height, share: 10, ...(shift === undefined ? {} : { move: shift }) });

test("areas that moved by the same amount read as one, across a gap that keeps changed areas apart", () => {
  // A sheet's title, button and footer moved up about 4pt (measured 3.8–4.3 across its parts), 5% of the height apart.
  const sheet = groupVisualRegions([region(60, 5, move(-4)), region(70, 5, move(-4.33)), region(80, 3, move(-3.83)), region(86, 3, move(-4.17))]);
  assert.equal(sheet.length, 1);
  assert.equal(formatMove(sheet[0]), "↑4.1pt", "one number: the parts' average, to a tenth");
  // The same areas with changed content stay apart, as before.
  assert.equal(groupVisualRegions([region(60, 5), region(70, 5), region(80, 3)]).length, 3);
  // A moved area and a changed one that touch are not merged, and up and down did not move together.
  assert.equal(groupVisualRegions([region(60, 5, move(-4)), region(65, 5)]).length, 2);
  assert.equal(groupVisualRegions([region(30, 5, move(1)), region(36, 5, move(-1))]).length, 2);
});

test("rows that drifted by different amounts keep their own outlines and numbers", () => {
  // List rows a device pixel and more apart: 1, 1.5 and 2pt, as the rows behind euxy's sheet.
  const rows = groupVisualRegions([region(40, 5, move(1)), region(46, 5, move(1.5)), region(52, 5, move(2))]);
  assert.deepEqual(rows.map(row => formatMove(row)), ["↓1pt", "↓1.5pt", "↓2pt"]);
  // Two-thirds of a point apart is a different move too, as on euxy's channel-surf sheet (1.3 and 2pt).
  assert.equal(groupVisualRegions([region(40, 5, move(1.33)), region(46, 5, move(2))]).length, 2);
});

test("a moved outline never grows around a changed area", () => {
  const changes = groupVisualRegions([region(10, 4, move(1)), region(15, 4), region(20, 4, move(1))]);
  assert.deepEqual(changes.map(change => `${change.move ? "moved" : "changed"} ${change.y}`), ["moved 10", "changed 15", "moved 20"]);
});

test("labels are one number, never empty or zero", () => {
  assert.equal(formatMove({ move: move(1, 2, "px") }), "→2 ↓1px", "a sideways move is named too, in Android's screenshot pixels");
  assert.equal(formatMove({ move: move(1.33) }), "↓1.3pt");
  // Two nudges a third of a pixel apart, one sideways and one down, average under a quarter on both axes.
  assert.equal(formatMove({ move: move(0.17, 0.16) }), "↓0.2pt");
});

test("What changed summarizes a screen whose every area moved, per direction, and nothing when any content changed", () => {
  const moved = groupVisualRegions([region(20, 5, move(1)), region(40, 5, move(2)), region(70, 5, move(-4.17))]);
  assert.deepEqual(layoutShiftSummary(moved), ["2 areas moved down 1–2pt.", "1 area moved up 4.2pt."]);
  assert.equal(layoutShiftSummary([...moved, ...groupVisualRegions([region(90, 3)])]), undefined);
  assert.equal(layoutShiftSummary([]), undefined);
});
