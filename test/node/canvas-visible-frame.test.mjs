import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { calculateCanvasVisibleFrame, canvasVisibleFrameContracts } = await tsImport(
  "../../viewer/src/components/canvas/visible-frame.ts",
  import.meta.url,
);

function rect(left, top, width, height) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

test("keeps the full local frame when desktop flex panels sit outside the canvas", () => {
  assert.deepEqual(
    calculateCanvasVisibleFrame(rect(328, 0, 900, 700), [
      { side: "left", rect: rect(0, 0, 328, 700) },
      { side: "right", rect: rect(1228, 0, 360, 700) },
    ]),
    { x: 0, y: 0, width: 900, height: 700 },
  );
});

test("subtracts responsive fixed side panels only where they overlap the root", () => {
  assert.deepEqual(
    calculateCanvasVisibleFrame(rect(0, 0, 1000, 700), [
      { side: "left", rect: rect(0, 0, 284, 700) },
      { side: "right", rect: rect(680, 0, 320, 700) },
    ]),
    { x: 284, y: 0, width: 396, height: 700 },
  );
});

test("treats an inset left panel and its chrome gap as a left hard occluder", () => {
  assert.deepEqual(
    calculateCanvasVisibleFrame(rect(100, 40, 1000, 700), [
      { side: "left", rect: rect(112, 100, 300, 460) },
    ]),
    { x: 312, y: 0, width: 688, height: 700 },
  );
});

test("ignores non-intersecting and invalid occluders and rejects full occlusion", () => {
  const root = rect(0, 0, 1000, 700);
  assert.deepEqual(
    calculateCanvasVisibleFrame(root, [
      { side: "left", rect: rect(-200, 900, 300, 100) },
      { side: "right", rect: rect(900, 0, Number.NaN, 100) },
    ]),
    { x: 0, y: 0, width: 1000, height: 700 },
  );
  assert.equal(
    calculateCanvasVisibleFrame(root, [{ side: "left", rect: rect(0, 0, 1000, 700) }]),
    undefined,
  );
});

test("distinguishes covering frame contractions from safe outward expansion", () => {
  const full = { x: 0, y: 0, width: 1000, height: 700 };
  assert.equal(
    canvasVisibleFrameContracts(full, { x: 0, y: 0, width: 600, height: 700 }),
    true,
  );
  assert.equal(
    canvasVisibleFrameContracts(full, { x: 284, y: 0, width: 716, height: 700 }),
    true,
  );
  assert.equal(
    canvasVisibleFrameContracts(
      { x: 284, y: 0, width: 396, height: 700 },
      { x: 0, y: 0, width: 1000, height: 700 },
    ),
    false,
  );
  assert.equal(
    canvasVisibleFrameContracts(full, { x: 0.005, y: 0, width: 999.995, height: 700 }),
    false,
  );
  assert.equal(
    canvasVisibleFrameContracts(
      { x: 364, y: 0, width: 1236, height: 700 },
      { x: 328, y: 0, width: 1272, height: 700 },
    ),
    false,
    "removing an occluder while the canvas root shifts left is an absolute expansion",
  );
});
