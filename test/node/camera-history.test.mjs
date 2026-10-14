import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const camera = await tsImport("../../viewer/src/utils/camera-history.ts", import.meta.url);

const base = {
  canvas: "map",
  baseline: "",
};

test("camera keys separate canvas documents, baselines and Map directions", () => {
  const top = camera.cameraKeyForRoute(base, "build-2", "TB");
  assert.equal(top, camera.cameraKeyForRoute(base, "build-2", "TB"), "the key is stable");
  assert.notEqual(top, camera.cameraKeyForRoute(base, "build-2", "LR"), "each Map direction keeps its own camera");
  assert.notEqual(top, camera.cameraKeyForRoute({ ...base, canvas: "screens" }, "build-2", "TB"));
  assert.notEqual(top, camera.cameraKeyForRoute({ ...base, canvas: "screens" }, "build-2", "TB"));
  assert.notEqual(top, camera.cameraKeyForRoute(base, "build-1", "TB"));
  assert.notEqual(top, camera.cameraKeyForRoute({ ...base, baseline: "build-1" }, "build-2", "TB"));
  assert.equal(
    camera.cameraKeyForRoute({ ...base, canvas: "screens" }, "build-2", "TB"),
    camera.cameraKeyForRoute({ ...base, canvas: "screens" }, "build-2", "LR"),
    "only the Map has a direction",
  );
});

test("every canvas is a deterministic overview and uses the projection fit", () => {
  assert.equal(camera.routeUsesProjectionFitCamera({ canvas: "map" }), true);
  assert.equal(camera.routeUsesProjectionFitCamera({ canvas: "screens" }), true);
  assert.equal(camera.routeUsesProjectionFitCamera({ canvas: "screens" }), true);
  assert.equal(camera.routeUsesProjectionFitCamera({ canvas: "compare" }), false);
});

test("history camera state round-trips without discarding foreign state", () => {
  const entry = {
    version: 1,
    id: "entry-1",
    key: "map-overview",
    viewport: { x: 12, y: -4, zoom: 0.75, center: { x: 320, y: 180 } },
  };
  const state = camera.withCameraHistoryEntry({ router: { index: 2 } }, entry);
  assert.deepEqual(state.router, { index: 2 });
  assert.deepEqual(camera.cameraHistoryEntry(state), entry);

  state.__expoExploreCamera.viewport.x = 99;
  assert.equal(entry.viewport.x, 12, "history state receives its own viewport value");
  state.__expoExploreCamera.viewport.center.x = 99;
  assert.equal(entry.viewport.center.x, 320, "history state receives its own center value");
});

test("Back and Forward retain the entry identity but delegate camera ownership to centred Fit", () => {
  const previous = {
    version: 1,
    id: "entry-1",
    key: "screens",
    viewport: { x: -900, y: 420, zoom: 2.5, center: { x: 580, y: 90 } },
  };
  assert.deepEqual(camera.cameraHistoryFitEntry(previous, "screens"), {
    version: 1,
    id: "entry-1",
    key: "screens",
  });
  assert.equal(camera.cameraHistoryFitEntry(previous, "screens").viewport, undefined);
});

test("invalid or partial browser state never becomes a camera command", () => {
  assert.equal(camera.cameraHistoryEntry(null), undefined);
  assert.equal(camera.cameraHistoryEntry({ __expoExploreCamera: { version: 2 } }), undefined);
  assert.equal(camera.cameraHistoryEntry({
    __expoExploreCamera: {
      version: 1,
      id: "entry",
      key: "map",
      viewport: { x: 0, y: 0, zoom: 0 },
    },
  }), undefined);
  assert.equal(camera.cameraHistoryEntry({
    __expoExploreCamera: {
      version: 1,
      id: "entry",
      key: "map",
      viewport: { x: Number.NaN, y: 0, zoom: 1 },
    },
  }), undefined);
  assert.equal(camera.cameraHistoryEntry({
    __expoExploreCamera: {
      version: 1,
      id: "entry",
      key: "map",
      viewport: { x: 0, y: 0, zoom: 1, center: { x: Infinity, y: 0 } },
    },
  }), undefined);
});
