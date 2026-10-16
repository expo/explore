import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRuntimeExecutionContext,
  runtimeEvidenceInputFromMap,
} from "../../dist/review/runtime-adapter.js";
import { projectRuntimeEvidence } from "../../dist/review/runtime-evidence.js";
import { AGENT_DEVICE_VERSION } from "../../dist/capture/run.js";

const sha = "a".repeat(40);

function execution(overrides = {}) {
  return {
    provider: "eas-simulator",
    controller: "agent-device",
    controllerPackageVersion: AGENT_DEVICE_VERSION,
    easCliVersion: "25.0.0",
    platform: "ios",
    deviceModel: "iPhone 17",
    osVersion: "26.0",
    locale: "en-US",
    orientation: "portrait",
    colorScheme: "light",
    sessionLifecycle: "stopped",
    ...overrides,
  };
}

function map() {
  const observations = ["obs-1", "obs-2", "obs-3"].map((id, index) => ({
    id,
    screenId: "cats",
    variantId: "cats-ready",
    fingerprints: { combined: "same", visual: "visual", accessibility: "a11y" },
    capturedAt: `2026-09-01T00:00:0${index + 1}Z`,
    surfaceScope: "app",
    elementIds: ["care-guide"],
    elements: [
      {
        elementId: "care-guide",
        identifier: "cats-care-guide-cta",
        role: "button",
        label: "Care Guide",
        occurrence: 1,
        controller: "agent-device",
        actions: ["press"],
        risk: "safe",
        actionable: true,
      },
      {
        elementId: "surface-provenance",
        identifier: "expo-explore-route",
        role: "text",
        label: "internal capture provenance",
        occurrence: 1,
        controller: "agent-device",
        actions: [],
        risk: "safe",
        actionable: false,
      },
    ],
    screenshotArtifactId: `shot-${index + 1}`,
  }));
  return {
    contract: "expo.explore.local-map.v1",
    revision: 1,
    run: {
      id: "run",
      name: "Example",
      platform: "ios",
      controller: "agent-device",
      bundleId: "com.example.app",
      status: "complete",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:04Z",
      completedAt: "2026-09-01T00:00:04Z",
      build: { id: "head", version: sha, gitCommit: sha, source: "eas" },
      environment: {
        deviceModel: "iPhone 17",
        osVersion: "26.0",
        locale: "en-US",
        orientation: "portrait",
        colorScheme: "light",
        authState: "logged-out",
        authPersona: "local-fixture",
      },
      limits: { maxScreens: 120, maxActions: 500, maxDurationMinutes: 120 },
    },
    artifacts: observations.map((observation, index) => ({
      id: `shot-${index + 1}`,
      kind: "screenshot",
      path: `artifacts/shot-${index + 1}.png`,
      sha256: String(index + 1).repeat(64),
      bytes: 100,
      mimeType: "image/png",
      width: 1179,
      height: 2556,
      createdAt: observation.capturedAt,
    })),
    screens: [{
      id: "cats",
      title: "Cats",
      route: "/cats",
      state: "ready",
      start: true,
      terminal: false,
      depth: 0,
      firstSeenAt: "2026-09-01T00:00:01Z",
      lastSeenAt: "2026-09-01T00:00:03Z",
      visits: 3,
      variantIds: ["cats-ready"],
      observationIds: observations.map((value) => value.id),
      elementIds: ["care-guide"],
    }],
    variants: [{
      id: "cats-ready",
      screenId: "cats",
      key: "ready",
      firstSeenAt: "2026-09-01T00:00:01Z",
      lastSeenAt: "2026-09-01T00:00:03Z",
      observationIds: observations.map((value) => value.id),
    }],
    observations,
    elements: [],
    actionAttempts: [{
      id: "attempt-1",
      sourceScreenId: "cats",
      sourceObservationId: "obs-1",
      targetScreenId: "cats",
      targetObservationId: "obs-2",
      action: { kind: "press", label: "Open Care Guide" },
      outcome: "transition",
      risk: "safe",
      startedAt: "2026-09-01T00:00:01Z",
      completedAt: "2026-09-01T00:00:01.250Z",
    }],
    transitions: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
}

test("parses only the pinned, stopped, non-secret runtime context", () => {
  assert.deepEqual(parseRuntimeExecutionContext(execution()), execution());
  assert.throws(
    () => parseRuntimeExecutionContext(execution({ sessionId: "private-session" })),
    /unsupported field sessionId/,
  );
  assert.throws(
    () => parseRuntimeExecutionContext(execution({ sessionLifecycle: "capturing" })),
    /session lifecycle.*invalid/i,
  );
  assert.throws(
    () => parseRuntimeExecutionContext(execution({ easCliVersion: "latest" })),
    /EAS CLI version.*invalid/i,
  );
});

test("a dark+light capture's execution context lists its appearances", () => {
  const both = execution({ colorSchemes: ["light", "dark"] });
  assert.deepEqual(parseRuntimeExecutionContext(both), both);
  assert.throws(() => parseRuntimeExecutionContext(execution({ colorSchemes: [] })), /at least one appearance/);
  assert.throws(() => parseRuntimeExecutionContext(execution({ colorSchemes: ["light", "sepia"] })), /color schemes.*invalid/i);
});

test("projects one map surface into the five runtime evidence groups", () => {
  const input = runtimeEvidenceInputFromMap({
    side: "head",
    map: map(),
    screenId: "cats",
    representativeObservationId: "obs-1",
    sampleObservationIds: ["obs-1", "obs-2", "obs-3"],
    expectedSampleCount: 3,
    profile: "iphone-17-review",
    execution: parseRuntimeExecutionContext(execution()),
  });
  const result = projectRuntimeEvidence(input);
  assert.deepEqual(
    input.runtime.observation.accessibility.elements.map((element) => element.label),
    ["Care Guide"],
  );
  assert.equal(result.groups.screen.route.value, "/cats");
  assert.equal(result.groups.capture.sampleCount.value, 3);
  assert.equal(result.groups.capture.stability.value, "stable");
  assert.deepEqual(result.groups.capture.pixelDensities.value, []);
  assert.equal(result.groups.interaction.transitionCount.value, 1);
  assert.equal(result.groups.ui.landmarks.value.length, 0);
  assert.equal(result.groups.environment.controllerPackageVersion?.value, AGENT_DEVICE_VERSION);
  assert.equal(result.groups.environment.easCliVersion?.value, "25.0.0");
});

test("normalizes multi-line labels and treats only open parser gaps as truncation", () => {
  const fixture = map();
  for (const observation of fixture.observations) {
    observation.elements[0].label = "Get closer to\nyour cats.\tNow";
  }
  fixture.gaps = [
    { id: "gap-1", kind: "controller-parse", status: "accepted", message: "Collapsed 1 exact duplicate JSON element(s)", observationId: "obs-1", createdAt: "2026-09-01T00:00:00Z" },
  ];
  const build = () => runtimeEvidenceInputFromMap({
    side: "head",
    map: fixture,
    screenId: "cats",
    representativeObservationId: "obs-1",
    sampleObservationIds: ["obs-1", "obs-2", "obs-3"],
    expectedSampleCount: 3,
    profile: "iphone-17-review",
    execution: parseRuntimeExecutionContext(execution()),
  });
  const accepted = build();
  assert.deepEqual(
    accepted.runtime.observation.accessibility.elements.map((element) => element.label),
    ["Get closer to your cats. Now"],
  );
  assert.equal(accepted.runtime.observation.accessibility.truncated, false);
  assert.equal(projectRuntimeEvidence(accepted).groups.ui.snapshotQuality.value, "complete");

  fixture.gaps[0].status = "open";
  assert.equal(build().runtime.observation.accessibility.truncated, true);
});

test("route observers and legacy markers are verification metadata, not runtime UI evidence", () => {
  const fixture = map();
  for (const observation of fixture.observations) {
    observation.elements.push({ elementId: `${observation.id}-observer`, identifier: 'expo-explore-observer',
      role: 'text', label: JSON.stringify({ provider: 'expo-router', pathname: '/cats', parameters: { sample: observation.id } }),
      occurrence: 1, controller: 'agent-device', actions: [], risk: 'safe', actionable: false });
  }
  const input = runtimeEvidenceInputFromMap({ side: 'head', map: fixture, screenId: 'cats', representativeObservationId: 'obs-1',
    sampleObservationIds: ['obs-1', 'obs-2', 'obs-3'], expectedSampleCount: 3, profile: 'iphone-17-review', execution: execution() });
  assert.deepEqual(input.runtime.observation.accessibility.elements.map(element => element.id), ['care-guide']);
  assert.deepEqual(input.runtime.observation.accessibility.elements.map(element => element.label), ['Care Guide']);
  assert.doesNotMatch(JSON.stringify(projectRuntimeEvidence(input).groups.ui), /expo-explore|pathname|sample/);
  assert.equal(fixture.observations[0].elements.length, 3, 'the original capture retains diagnostic metadata');
});

test("a captured route in a partial run retains controller evidence without an app marker", () => {
  const fixture = map();
  fixture.run.status = "partial";
  for (const observation of fixture.observations) {
    observation.elements = observation.elements.filter(element => element.identifier !== "expo-explore-route");
  }
  const input = runtimeEvidenceInputFromMap({
    side: "head", map: fixture, screenId: "cats", representativeObservationId: "obs-1",
    sampleObservationIds: ["obs-1"], expectedSampleCount: 1, profile: "iphone-17-review",
    execution: parseRuntimeExecutionContext(execution()),
  });
  assert.equal(input.runtime.environment.controller, "agent-device");
  assert.equal(input.runtime.environment.sessionLifecycle, "stopped");
  assert.equal(input.runtime.observation.accessibility.elements[0].label, "Care Guide");
});

test("fails closed on provenance, environment, surface, and capture mismatches", () => {
  const base = {
    side: "base",
    map: map(),
    screenId: "cats",
    representativeObservationId: "obs-1",
    sampleObservationIds: ["obs-1"],
    expectedSampleCount: 1,
    profile: "iphone-17-review",
    execution: parseRuntimeExecutionContext(execution()),
  };
  const wrongEnvironment = map();
  wrongEnvironment.run.environment.deviceModel = "iPhone 16";
  assert.throws(
    () => runtimeEvidenceInputFromMap({ ...base, map: wrongEnvironment }),
    /does not match EAS Simulator context/,
  );
  assert.throws(
    () => runtimeEvidenceInputFromMap({ ...base, sampleObservationIds: ["missing"] }),
    /observation is missing/,
  );
  assert.throws(
    () => runtimeEvidenceInputFromMap({
      ...base,
      expectedSampleCount: 3,
      sampleObservationIds: ["obs-1"],
    }),
    /expected 3 capture samples, received 1/,
  );
  const noVisual = map();
  delete noVisual.observations[0].fingerprints.visual;
  assert.throws(
    () => runtimeEvidenceInputFromMap({ ...base, map: noVisual }),
    /visual fingerprint is missing/,
  );
});
