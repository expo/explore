import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExploreError, ExploreStore, fingerprintState, recordObservation } from "../../dist/map/store.js";

function fixture() {
  const timestamp = "2026-09-24T00:00:00.000Z";
  const map = {
    contract: "expo.explore.local-map.v1", revision: 0,
    run: {
      id: "capture-time-run", name: "Capture time", platform: "ios", controller: "agent-device", status: "draft",
      createdAt: timestamp, updatedAt: timestamp,
      build: { id: "build", gitCommit: "a".repeat(40), source: "eas" },
      environment: { deviceModel: "iPhone 17", osVersion: "26.0", locale: "en_US", orientation: "portrait", colorScheme: "light", authState: "logged-out" },
      limits: { maxScreens: 10, maxActions: 20, maxDurationMinutes: 5 },
    },
    screens: [], variants: [], observations: [], elements: [], artifacts: [],
    actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [],
  };
  return {
    store: new ExploreStore(join(tmpdir(), "explore-store-capture-time")),
    map, title: "Home", screenId: "home", explicitFingerprint: "home", elements: [],
  };
}

test("recordObservation preserves an earlier capture time across screen, variant and observation", async () => {
  const options = fixture();
  const capturedAt = "2026-09-23T08:15:30.12Z";
  const first = await recordObservation({ ...options, capturedAt });

  assert.equal(first.screen.firstSeenAt, capturedAt);
  assert.equal(first.screen.lastSeenAt, capturedAt);
  assert.equal(first.variant.firstSeenAt, capturedAt);
  assert.equal(first.variant.lastSeenAt, capturedAt);
  assert.equal(first.observation.capturedAt, capturedAt);

  const nextCapture = "2026-09-23T08:16:00Z";
  const next = await recordObservation({ ...options, capturedAt: nextCapture });
  assert.equal(next.createdScreen, false);
  assert.equal(next.createdVariant, false);
  assert.equal(next.screen.firstSeenAt, capturedAt);
  assert.equal(next.variant.firstSeenAt, capturedAt);
  assert.equal(next.screen.lastSeenAt, nextCapture);
  assert.equal(next.variant.lastSeenAt, nextCapture);
  assert.equal(next.observation.capturedAt, nextCapture);
  assert.equal(first.observation.capturedAt, capturedAt);
});

test("recordObservation defaults to the current recording time", async () => {
  const startedAt = Date.now();
  const result = await recordObservation(fixture());
  const capturedAt = Date.parse(result.observation.capturedAt);

  assert.ok(capturedAt >= startedAt && capturedAt <= Date.now());
  assert.equal(result.screen.firstSeenAt, result.observation.capturedAt);
  assert.equal(result.variant.firstSeenAt, result.observation.capturedAt);
});

test("invalid capture timestamps reject before modifying an existing map", async () => {
  const options = fixture();
  await recordObservation({ ...options, capturedAt: "2026-09-23T08:15:30.000Z" });
  options.map.run.status = "complete";
  options.map.run.completedAt = "2026-09-24T00:00:00.000Z";
  const original = structuredClone(options.map);

  for (const capturedAt of ["not-a-date", "2026-09-23", "2026-02-30T08:15:30.000Z", "2026-09-23T24:00:00Z", "", null, 0]) {
    await assert.rejects(
      recordObservation({ ...options, capturedAt, start: true, route: "/changed", screenshotPath: "/missing-image.png" }),
      error => error instanceof ExploreError && /capturedAt/.test(error.message),
    );
    assert.deepEqual(options.map, original);
  }
});

test("an identifier that recurs on one screen yields distinct, stable element ids", async () => {
  const options = fixture();
  const row = (label, y) => ({ role: "other", label, identifier: "lane-row", bounds: { x: 0, y, width: 300, height: 40 } });
  const elements = [row("Kick", 0), row("Snare", 50), row("Hat", 100)];
  const first = await recordObservation({ ...options, elements });
  assert.deepEqual(first.observation.elementIds, ["element-home-lane-row", "element-home-lane-row-2", "element-home-lane-row-3"]);
  assert.equal(new Set(first.observation.elementIds).size, 3);
  const next = await recordObservation({ ...options, elements });
  assert.deepEqual(next.observation.elementIds, first.observation.elementIds);
  assert.equal(options.map.elements.filter(element => element.identifier === "lane-row").length, 3);
});

test("accessibility fingerprints ignore Android system UI nodes", async () => {
  const snapshot = (signal, title) => JSON.stringify({ success: true, data: { nodes: [
    { index: 0, type: "android.widget.FrameLayout", bundleId: "com.android.systemui", label: signal, rect: { x: 600, y: 10, width: 40, height: 30 } },
    { index: 1, type: "android.widget.TextView", bundleId: "dev.brent.euxy", label: title, rect: { x: 100, y: 200, width: 200, height: 40 } },
  ] } });
  const base = await fingerprintState({ snapshotText: snapshot("Phone signal full.", "Activity Log") });
  const sameApp = await fingerprintState({ snapshotText: snapshot("Phone three bars.", "Activity Log") });
  const changedApp = await fingerprintState({ snapshotText: snapshot("Phone signal full.", "Activity log") });
  assert.equal(sameApp.accessibility, base.accessibility);
  assert.notEqual(changedApp.accessibility, base.accessibility);
});

test("accessibility fingerprints are versioned, and leave out the system keyboard and which field has the focus", async () => {
  const snapshot = (focused, keyboard) => JSON.stringify({ success: true, data: { nodes: [
    { index: 0, type: "Application", label: "euxy", rect: { x: 0, y: 0, width: 402, height: 874 } },
    { index: 1, parentIndex: 0, type: "TextField", label: "Pattern name", ...(focused ? { focused: true } : {}), rect: { x: 23, y: 386, width: 355, height: 50 } },
    ...(keyboard ? [{ index: 2, parentIndex: 0, type: "Keyboard", rect: { x: 0, y: 583, width: 402, height: 233 } },
      { index: 3, parentIndex: 2, type: "Key", label: "Q", rect: { x: 5, y: 590, width: 39, height: 54 } }] : []),
  ] } });
  const resting = await fingerprintState({ snapshotText: snapshot(false, false) });
  assert.match(resting.accessibility, /^a2:[0-9a-f]{64}$/);
  assert.equal((await fingerprintState({ snapshotText: snapshot(true, false) })).accessibility, resting.accessibility, "focus alone does not change the tree");
  assert.equal((await fingerprintState({ snapshotText: snapshot(true, true) })).accessibility, resting.accessibility, "nor does the keyboard");
});
