import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const transition = await tsImport(
  "../../viewer/src/utils/canvas-view-transition.ts",
  import.meta.url,
);

test("canvas view direction follows the toolbar order", () => {
  assert.deepEqual(transition.CANVAS_VIEW_ORDER, ["map", "screens", "compare", "flows"]);
  assert.equal(transition.canvasViewTransitionDirection("compare", "flows"), "forward");
  assert.equal(transition.canvasViewTransitionDirection("screens", "compare"), "forward");
  assert.equal(transition.canvasViewTransitionDirection("map", "screens"), "forward");
  assert.equal(transition.canvasViewTransitionDirection("compare", "screens"), "backward");
  assert.equal(transition.canvasViewTransitionDirection("screens", "map"), "backward");
  assert.equal(transition.canvasViewTransitionDirection("screens", "screens"), undefined);
});
