import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const zoom = await tsImport("../../viewer/src/utils/canvas-zoom.ts", import.meta.url);

test("recenter is a first-class camera command", () => {
  const calls = [];
  zoom.registerZoomApi({
    zoomIn: () => calls.push("in"),
    zoomOut: () => calls.push("out"),
    zoomTo: (level) => calls.push(`zoom:${level}`),
    zoomToFit: () => calls.push("fit"),
    recenter: () => calls.push("recenter"),
    zoomToSelection: () => calls.push("selection"),
    hasSelection: () => false,
  });

  zoom.runCanvasZoomCommand("recenter");
  assert.deepEqual(calls, ["recenter"]);
  zoom.registerZoomApi(undefined);
});
