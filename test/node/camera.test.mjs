import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const camera = await tsImport(
  "../../viewer/src/components/canvas/camera.ts",
  import.meta.url,
);

test("normalizes a persisted viewport without changing valid camera coordinates", () => {
  assert.deepEqual(
    camera.normalizeCanvasViewport({ x: -420.5, y: 81, zoom: 0.64 }, 0.1, 2),
    { x: -420.5, y: 81, zoom: 0.64 },
  );
  assert.deepEqual(
    camera.normalizeCanvasViewport({ x: 20, y: 30, zoom: 9 }, 0.1, 2),
    { x: 20, y: 30, zoom: 2 },
  );
  assert.equal(
    camera.normalizeCanvasViewport({ x: Number.NaN, y: 30, zoom: 1 }, 0.1, 2),
    undefined,
  );
  assert.equal(
    camera.normalizeCanvasViewport({ x: 20, y: 30, zoom: 0 }, 0.1, 2),
    undefined,
  );
});

test("restore identity distinguishes history generations at identical coordinates", () => {
  const viewport = { x: -120, y: 48, zoom: 0.75 };
  assert.equal(
    camera.canvasViewportRestoreToken(viewport, "entry-a"),
    "string:entry-a:viewport:-120:48:0.75",
  );
  assert.equal(
    camera.canvasViewportRestoreToken(viewport, "entry-b"),
    "string:entry-b:viewport:-120:48:0.75",
  );
  assert.equal(
    camera.canvasViewportRestoreToken(viewport, undefined),
    "viewport:-120:48:0.75",
  );
  assert.notEqual(
    camera.canvasViewportRestoreToken(viewport, "entry-a"),
    camera.canvasViewportRestoreToken({ ...viewport, x: -121 }, "entry-a"),
  );
});

test("viewport events are directly serializable and retain the world-space centre", () => {
  assert.deepEqual(
    camera.canvasViewportChangeEvent(
      { x: -300, y: -100, zoom: 2 },
      1000,
      600,
      "gesture",
      "end",
    ),
    {
      x: -300,
      y: -100,
      zoom: 2,
      center: { x: 400, y: 200 },
      source: "gesture",
      phase: "end",
    },
  );
  assert.equal(
    camera.canvasViewportChangeEvent(
      { x: 0, y: 0, zoom: 1 },
      0,
      600,
      "programmatic",
      "continuous",
    ),
    undefined,
  );
  assert.deepEqual(
    camera.canvasViewportChangeEvent(
      { x: 100, y: 50, zoom: 2 },
      1000,
      700,
      "programmatic",
      "end",
      { x: 200, y: 100, width: 600, height: 400, revision: 3 },
    )?.center,
    { x: 200, y: 125 },
  );
});

test("visible frames are normalized to the canvas and reject invalid geometry", () => {
  assert.deepEqual(
    camera.normalizeCanvasVisibleFrame(
      { x: -20, y: 100, width: 500, height: 900, revision: 4 },
      1000,
      600,
    ),
    { x: 0, y: 100, width: 480, height: 500, revision: 4 },
  );
  assert.deepEqual(
    camera.normalizeCanvasVisibleFrame(undefined, 1000, 600),
    { x: 0, y: 0, width: 1000, height: 600, revision: 0 },
  );
  assert.equal(
    camera.normalizeCanvasVisibleFrame(
      { x: 1100, y: 0, width: 100, height: 100, revision: 1 },
      1000,
      600,
    ),
    undefined,
  );
  assert.equal(
    camera.normalizeCanvasVisibleFrame(
      { x: 0, y: 0, width: Number.NaN, height: 100, revision: 1 },
      1000,
      600,
    ),
    undefined,
  );
});

test("bounds fit and recenter target the visible frame instead of the raw canvas", () => {
  const bounds = { x: 100, y: 50, width: 200, height: 100 };
  const visibleFrame = { x: 200, y: 100, width: 600, height: 400, revision: 2 };
  assert.deepEqual(
    camera.canvasBoundsViewport(bounds, {
      canvasWidth: 1000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      visibleFrame,
    }),
    { zoom: 2, x: 100, y: 100 },
  );
  assert.deepEqual(
    camera.canvasBoundsViewport(bounds, {
      canvasWidth: 1000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      topInset: 64,
      visibleFrame,
    }),
    { zoom: 2, x: 100, y: 64 },
  );
  assert.deepEqual(
    camera.canvasBoundsViewport(bounds, {
      canvasWidth: 1000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      leftInset: 2,
      topInset: 64,
      visibleFrame,
    }),
    { zoom: 2, x: 2, y: 64 },
  );
  assert.deepEqual(
    camera.canvasBoundsViewport(bounds, {
      canvasWidth: 1000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      leftInset: 2,
      topInset: 10,
      visibleFrame: { ...visibleFrame, x: 0, width: 800 },
    }),
    { zoom: 2, x: 0, y: 10 },
  );
  assert.deepEqual(
    camera.canvasRecenterViewport(bounds, 0.75, {
      canvasWidth: 1000,
      canvasHeight: 800,
      visibleFrame,
    }),
    { zoom: 0.75, x: 350, y: 225 },
  );
});

test("width fit centres an inventory horizontally and anchors it to the visible frame top", () => {
  const bounds = { x: 100, y: 50, width: 400, height: 1_000 };
  const visibleFrame = { x: 200, y: 100, width: 600, height: 400, revision: 2 };
  assert.deepEqual(
    camera.canvasWidthViewport(bounds, {
      canvasWidth: 1_000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      visibleFrame,
    }),
    { zoom: 1.2, x: 140, y: 80 },
  );

  const narrowedFrame = { x: 300, y: 20, width: 400, height: 700, revision: 3 };
  assert.deepEqual(
    camera.canvasWidthViewport(bounds, {
      canvasWidth: 1_000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      visibleFrame: narrowedFrame,
    }),
    { zoom: 0.8, x: 260, y: 50 },
  );
  assert.deepEqual(
    camera.canvasWidthViewport(bounds, {
      canvasWidth: 1_000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      topInset: 64,
      visibleFrame,
    }),
    { zoom: 1.2, x: 140, y: 104 },
  );
  assert.deepEqual(
    camera.canvasWidthViewport(bounds, {
      canvasWidth: 1_000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      padding: 0.1,
      topInset: 10,
      visibleFrame,
    }),
    { zoom: 1.2, x: 140, y: 50 },
  );
});

test("bounds fitting clamps both zoom limits and rejects invalid inputs", () => {
  assert.deepEqual(
    camera.canvasBoundsViewport(
      { x: 0, y: 0, width: 10_000, height: 10_000 },
      { canvasWidth: 1000, canvasHeight: 800, minZoom: 0.1, maxZoom: 2, padding: 0.1 },
    ),
    { zoom: 0.1, x: 0, y: -100 },
  );
  assert.deepEqual(
    camera.canvasBoundsViewport(
      { x: 0, y: 0, width: 10, height: 10 },
      { canvasWidth: 1000, canvasHeight: 800, minZoom: 0.1, maxZoom: 1.5, padding: 0 },
    ),
    { zoom: 1.5, x: 492.5, y: 392.5 },
  );
  assert.equal(
    camera.canvasBoundsViewport(
      { x: 0, y: 0, width: 0, height: 100 },
      { canvasWidth: 1000, canvasHeight: 800, minZoom: 0.1, maxZoom: 2 },
    ),
    undefined,
  );
  assert.equal(
    camera.canvasBoundsViewport(
      { x: 0, y: 0, width: 100, height: 100 },
      { canvasWidth: 1000, canvasHeight: 800, minZoom: 2, maxZoom: 1 },
    ),
    undefined,
  );
  assert.equal(
    camera.canvasRecenterViewport(
      { x: 0, y: 0, width: 100, height: 100 },
      Number.NaN,
      { canvasWidth: 1000, canvasHeight: 800 },
    ),
    undefined,
  );
});

test("pre-mount focus uses absolute child geometry and the same centred camera formula", () => {
  const nodes = [
    {
      id: "root",
      position: { x: 40, y: 20 },
      width: 900,
      height: 600,
    },
    {
      id: "group",
      parentId: "root",
      position: { x: 100, y: 50 },
      width: 700,
      height: 500,
    },
    {
      id: "screen",
      parentId: "group",
      position: { x: 20, y: 30 },
      width: 200,
      height: 400,
    },
  ];
  assert.deepEqual(
    camera.canvasFocusViewport(nodes, "screen", 1000, 800, 0.1, 0.9, 0.05),
    {
      zoom: 0.9,
      x: 266,
      y: 130,
    },
  );
  assert.deepEqual(
    camera.canvasFocusViewport(
      nodes,
      "screen",
      1000,
      800,
      0.1,
      0.9,
      0.05,
      { x: 250, y: 100, width: 700, height: 600, revision: 8 },
    ),
    { zoom: 0.9, x: 366, y: 130 },
  );
  assert.equal(
    camera.canvasFocusViewport(nodes, "missing", 1000, 800, 0.1, 0.9, 0.05),
    undefined,
  );
});

test("selection Fit shares one centred camera across manual and panel-driven commands", () => {
  const nodes = [
    {
      id: "root",
      position: { x: 40, y: 20 },
      width: 900,
      height: 600,
    },
    {
      id: "group",
      parentId: "root",
      position: { x: 100, y: 50 },
      width: 700,
      height: 500,
    },
    {
      id: "screen",
      parentId: "group",
      position: { x: 20, y: 30 },
      width: 200,
      height: 400,
    },
  ];
  const visibleFrame = { x: 250, y: 100, width: 700, height: 600, revision: 8 };

  assert.deepEqual(
    camera.canvasSelectionViewport(nodes, ["missing", "screen", "screen"], {
      canvasWidth: 1_000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      visibleFrame,
    }),
    { zoom: 0.75, x: 405, y: 175 },
  );
  assert.equal(
    camera.canvasSelectionViewport(nodes, ["missing"], {
      canvasWidth: 1_000,
      canvasHeight: 800,
      minZoom: 0.1,
      maxZoom: 2,
      visibleFrame,
    }),
    undefined,
  );
  assert.deepEqual(
    camera.canvasSelectionNodeIds([
      { ...nodes[2], selected: true },
      { id: "area", position: { x: 0, y: 0 }, selected: true },
      { id: "hidden", position: { x: 0, y: 0 }, selected: true, hidden: true },
    ], "screen"),
    ["screen"],
  );
  assert.deepEqual(
    camera.canvasSelectionNodeIds([
      { ...nodes[2], selected: false },
      { id: "area", position: { x: 0, y: 0 }, selected: true },
      { id: "hidden", position: { x: 0, y: 0 }, selected: true, hidden: true },
    ], "missing"),
    ["area"],
  );
});

test("priority prefix retains the highest-ranked nodes that fit at the readability floor", () => {
  const nodes = [
    { id: "one", position: { x: 0, y: 0 }, width: 100, height: 100 },
    { id: "two", position: { x: 150, y: 0 }, width: 100, height: 100 },
    { id: "three", position: { x: 800, y: 0 }, width: 100, height: 100 },
  ];
  assert.deepEqual(
    camera.canvasPriorityNodePrefix(nodes, ["missing", "one", "one", "two", "three"], {
      canvasWidth: 600,
      canvasHeight: 400,
      readableZoom: 1.5,
      padding: 0.1,
    }),
    {
      nodeIds: ["one", "two"],
      bounds: { x: 0, y: 0, width: 250, height: 100 },
      fitZoom: 1.92,
    },
  );
});

test("priority prefix always retains the first valid top-level node", () => {
  const nodes = [
    { id: "large", position: { x: 10, y: 20 }, width: 2000, height: 1000 },
    { id: "next", position: { x: 2200, y: 20 }, width: 100, height: 100 },
  ];
  assert.deepEqual(
    camera.canvasPriorityNodePrefix(nodes, ["large", "next"], {
      canvasWidth: 500,
      canvasHeight: 300,
      readableZoom: 0.8,
      padding: 0.1,
    }),
    {
      nodeIds: ["large"],
      bounds: { x: 10, y: 20, width: 2000, height: 1000 },
      fitZoom: 0.2,
    },
  );
});

test("a stable Flows priority shelf changes zoom when the Inspector narrows the frame", () => {
  const nodes = Array.from({ length: 5 }, (_, index) => ({
    id: `flow-${index + 1}`,
    position: { x: index * 220, y: 0 },
    width: 200,
    height: 400,
  }));
  const priorityNodeIds = nodes.map((node) => node.id);
  const wideFrame = { x: 312, y: 0, width: 1_000, height: 800, revision: 1 };
  const narrowFrame = { x: 312, y: 0, width: 700, height: 800, revision: 2 };
  const wideShelf = camera.canvasPriorityNodePrefix(nodes, priorityNodeIds, {
    canvasWidth: 1_544,
    canvasHeight: 800,
    readableZoom: 0.75,
    padding: 0.07,
    visibleFrame: wideFrame,
  });
  const adaptiveNarrowShelf = camera.canvasPriorityNodePrefix(nodes, priorityNodeIds, {
    canvasWidth: 1_144,
    canvasHeight: 800,
    readableZoom: 0.75,
    padding: 0.07,
    visibleFrame: narrowFrame,
  });
  assert.deepEqual(wideShelf?.nodeIds, priorityNodeIds);
  assert.deepEqual(adaptiveNarrowShelf?.nodeIds, priorityNodeIds.slice(0, 3));

  const wideTarget = camera.canvasBoundsViewport(wideShelf.bounds, {
    canvasWidth: 1_544,
    canvasHeight: 800,
    minZoom: 0.02,
    maxZoom: 0.75,
    padding: 0.07,
    leftInset: 0,
    visibleFrame: wideFrame,
  });
  const stableNarrowBounds = camera.canvasPriorityProjectionBounds(
    nodes,
    wideShelf.bounds,
    {
      canvasWidth: 1_144,
      canvasHeight: 800,
      padding: 0.07,
      priorityNodeIds,
      readableZoomFloor: 0.75,
      visibleFrame: narrowFrame,
      priorityFitReference: {
        canvasWidth: 1_544,
        canvasHeight: 800,
        visibleFrame: wideFrame,
      },
    },
  );
  assert.deepEqual(stableNarrowBounds, wideShelf.bounds);
  const stableNarrowTarget = camera.canvasBoundsViewport(stableNarrowBounds, {
    canvasWidth: 1_144,
    canvasHeight: 800,
    minZoom: 0.02,
    maxZoom: 0.75,
    padding: 0.07,
    leftInset: 0,
    visibleFrame: narrowFrame,
  });
  const adaptiveNarrowTarget = camera.canvasBoundsViewport(adaptiveNarrowShelf.bounds, {
    canvasWidth: 1_144,
    canvasHeight: 800,
    minZoom: 0.02,
    maxZoom: 0.75,
    padding: 0.07,
    leftInset: 0,
    visibleFrame: narrowFrame,
  });

  assert.equal(wideTarget.zoom, 0.75);
  assert.equal(adaptiveNarrowTarget.zoom, 0.75);
  assert.ok(stableNarrowTarget.zoom < 0.75);
  assert.notDeepEqual(stableNarrowTarget, wideTarget);
});
