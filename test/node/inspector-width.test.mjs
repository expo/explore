import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { clampInspectorWidth, inspectorWidthBounds, INSPECTOR_WIDTH_MAX, INSPECTOR_WIDTH_MIN } =
  await tsImport("../../viewer/src/utils/inspector-width.ts", import.meta.url);

test("the Inspector may take at most half the window, within its fixed range", () => {
  assert.deepEqual(inspectorWidthBounds(1440), { min: INSPECTOR_WIDTH_MIN, max: 720 });
  assert.deepEqual(inspectorWidthBounds(2560), { min: INSPECTOR_WIDTH_MIN, max: INSPECTOR_WIDTH_MAX });
  // A window narrower than two minimum panels still allows the minimum.
  assert.deepEqual(inspectorWidthBounds(500), { min: INSPECTOR_WIDTH_MIN, max: INSPECTOR_WIDTH_MIN });
});

test("the bounds are in the panel's own pixels when the chrome is zoomed", () => {
  assert.deepEqual(inspectorWidthBounds(1600, 1.25), { min: INSPECTOR_WIDTH_MIN, max: 640 });
  assert.deepEqual(inspectorWidthBounds(1600, 0), inspectorWidthBounds(1600, 1));
});

test("the Inspector stops where the canvas keeps the bottom bar's room, never below the minimum", () => {
  // 820 - 424 leaves 396, less than half of 820.
  assert.deepEqual(inspectorWidthBounds(820, 1, 424), { min: INSPECTOR_WIDTH_MIN, max: 396 });
  // In a wide window half of it is the tighter cap.
  assert.deepEqual(inspectorWidthBounds(1440, 1, 424), { min: INSPECTOR_WIDTH_MIN, max: 720 });
  // The room is in window pixels, the width in the panel's own: (1000 - 530) / 1.25 = 376.
  assert.deepEqual(inspectorWidthBounds(1000, 1.25, 530), { min: INSPECTOR_WIDTH_MIN, max: 376 });
  assert.deepEqual(inspectorWidthBounds(700, 1, 424), { min: INSPECTOR_WIDTH_MIN, max: INSPECTOR_WIDTH_MIN });
});

test("a width is clamped to the bounds and rounded to whole pixels", () => {
  const bounds = { min: 320, max: 720 };
  assert.equal(clampInspectorWidth(100, bounds), 320);
  assert.equal(clampInspectorWidth(1000, bounds), 720);
  assert.equal(clampInspectorWidth(455.6, bounds), 456);
});
