import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_EVIDENCE_COMPARISON_CONTRACT,
  RUNTIME_EVIDENCE_CONTRACT,
  RUNTIME_EVIDENCE_GROUP_ORDER,
  projectRuntimeEvidence,
  projectRuntimeEvidenceComparison,
  serializeRuntimeEvidence,
} from "../../dist/review/runtime-evidence.js";

function evidence(side = "base", overrides = {}) {
  const observationId = overrides.observationId ?? `${side}-observation`;
  const variantId = overrides.variantId ?? "signed-in";
  return {
    context: {
      kind: "configured-capture-context",
      side,
      logicalBuild: `${side}-sha`,
      profile: "iphone-17-review",
      surfaceId: "settings-profile",
      route: "/settings/profile",
      state: "ready",
      variantId,
      observationId,
      expectedSampleCount: 3,
      fixturePersona: "local-pro",
    },
    runtime: {
      kind: "eas-agent-device-raw",
      observation: {
        id: observationId,
        variantId,
        capturedAt: "2026-09-01T01:00:00Z",
        surfaceScope: "app",
        accessibility: {
          truncated: false,
          elements: [
            { id: "z-heading", role: "text", label: "Profile", actionable: false, landmark: true },
            { id: "a-save", role: "button", label: "Save", actionable: true, landmark: false },
            { id: "b-cancel", role: "button", label: "Cancel", actionable: true, landmark: false },
          ],
        },
      },
      interactions: [
        {
          id: "second",
          observationId,
          action: "back",
          label: "Back",
          outcome: "same-screen",
          startedAt: "2026-09-01T01:00:03Z",
          completedAt: "2026-09-01T01:00:03.100Z",
          durationMs: 100,
        },
        {
          id: "first",
          observationId,
          action: "press",
          label: "Save",
          outcome: "transition",
          startedAt: "2026-09-01T01:00:01Z",
          completedAt: "2026-09-01T01:00:01.250Z",
          durationMs: 250,
          target: { surfaceId: "settings-root", route: "/settings" },
        },
      ],
      captures: [
        {
          id: "sample-2",
          observationId,
          variantId,
          capturedAt: "2026-09-01T01:00:02Z",
          widthPixels: 1179,
          heightPixels: 2556,
          pixelDensity: 3,
          fingerprints: { combined: "same", visual: "visual", accessibility: "a11y" },
        },
        {
          id: "sample-1",
          observationId,
          variantId,
          capturedAt: "2026-09-01T01:00:01Z",
          widthPixels: 1179,
          heightPixels: 2556,
          pixelDensity: 3,
          fingerprints: { combined: "same", visual: "visual", accessibility: "a11y" },
        },
      ],
      environment: {
        provider: "eas-simulator",
        controller: "agent-device",
        platform: "ios",
        deviceModel: side === "base" ? "iPhone 16" : "iPhone 17",
        osVersion: side === "base" ? "26.4" : "26.5",
        locale: "en-US",
        orientation: "portrait",
        colorScheme: "light",
        sessionLifecycle: "stopped",
      },
    },
  };
}

test("projects deterministic, origin-tagged Screen/UI/Interaction/Capture/Environment groups", () => {
  const input = evidence();
  const projected = projectRuntimeEvidence(input);

  assert.equal(projected.contract, RUNTIME_EVIDENCE_CONTRACT);
  assert.deepEqual(Object.keys(projected.groups), RUNTIME_EVIDENCE_GROUP_ORDER);
  assert.deepEqual(projected.groups.screen.side, { origin: "capture-context", value: "base" });
  assert.deepEqual(projected.groups.screen.observationId, {
    origin: "eas-agent-device",
    value: "base-observation",
  });
  assert.deepEqual(projected.groups.ui.roleCounts, {
    origin: "derived",
    value: [
      { role: "button", count: 2 },
      { role: "text", count: 1 },
    ],
  });
  assert.deepEqual(projected.groups.ui.landmarks.value, [
    { id: "z-heading", role: "text", label: "Profile" },
  ]);
  assert.equal(projected.groups.ui.snapshotQuality.value, "complete");
  assert.deepEqual(
    projected.groups.interaction.attempts.value.map((attempt) => attempt.id),
    ["first", "second"],
  );
  assert.equal(projected.groups.interaction.transitionCount.value, 1);
  assert.deepEqual(projected.groups.interaction.outcomeCounts.value, {
    transition: 1,
    "same-screen": 1,
    "no-change": 0,
    failed: 0,
    blocked: 0,
    external: 0,
  });
  assert.deepEqual(
    projected.groups.capture.samples.value.map((sample) => sample.id),
    ["sample-1", "sample-2"],
  );
  assert.equal(projected.groups.capture.stability.value, "stable");
  assert.deepEqual(projected.groups.capture.coverage.value, {
    expected: 3,
    captured: 2,
    ratio: 0.666667,
    complete: false,
  });
  assert.deepEqual(projected.groups.environment.profile, {
    origin: "capture-context",
    value: "iphone-17-review",
  });
  assert.deepEqual(projected.groups.environment.deviceModel, {
    origin: "eas-agent-device",
    value: "iPhone 16",
  });

  assert.deepEqual(projectRuntimeEvidence(structuredClone(input)), projected);
  assert.equal(serializeRuntimeEvidence(input), `${JSON.stringify(projected)}\n`);
  assert.deepEqual(JSON.parse(serializeRuntimeEvidence(input)), projected);
});

test("judges sample stability on the accessibility tree, not on pixel-identical screenshots", () => {
  const input = evidence();
  input.runtime.captures[1].fingerprints.combined = "different-pixels";
  input.runtime.captures[1].fingerprints.visual = "different-pixels";
  assert.equal(projectRuntimeEvidence(input).groups.capture.stability.value, "stable");
  input.runtime.captures[1].fingerprints.accessibility = "different-tree";
  assert.equal(projectRuntimeEvidence(input).groups.capture.stability.value, "unstable");
});

test("projects a deterministic non-empty allowlisted Diagnostics group", () => {
  const input = evidence();
  input.runtime.captures[1].fingerprints.combined = "different";
  input.runtime.captures[1].fingerprints.accessibility = "different-tree";
  input.diagnostics = {
    kind: "diagnostics-extension",
    entries: [
      {
        code: "capture.stability-unstable",
        title: "Capture stability anomaly",
        value: "unstable",
        origin: "derived",
      },
      {
        code: "capture.sample-shortfall",
        title: "Capture sample anomaly",
        value: "shortfall",
        origin: "derived",
      },
      {
        code: "capture.sample-plan",
        title: "Capture sample plan",
        value: "triple",
        origin: "capture-context",
      },
    ],
  };

  const projected = projectRuntimeEvidence(input);
  assert.deepEqual(Object.keys(projected.groups), [
    ...RUNTIME_EVIDENCE_GROUP_ORDER,
    "diagnostics",
  ]);
  assert.deepEqual(projected.groups.diagnostics, {
    id: "diagnostics",
    entries: [
      {
        code: "capture.sample-plan",
        title: "Capture sample plan",
        value: "triple",
        origin: "capture-context",
      },
      {
        code: "capture.sample-shortfall",
        title: "Capture sample anomaly",
        value: "shortfall",
        origin: "derived",
      },
      {
        code: "capture.stability-unstable",
        title: "Capture stability anomaly",
        value: "unstable",
        origin: "derived",
      },
    ],
  });
  assert.deepEqual(projectRuntimeEvidence(structuredClone(input)), projected);

  const controllerDiagnostic = evidence();
  controllerDiagnostic.runtime.observation.accessibility.truncated = true;
  controllerDiagnostic.diagnostics = {
    kind: "diagnostics-extension",
    entries: [{
      code: "ui.accessibility-truncated",
      title: "Accessibility snapshot truncated",
      value: "truncated",
      origin: "eas-agent-device",
    }],
  };
  assert.deepEqual(
    projectRuntimeEvidence(controllerDiagnostic).groups.diagnostics.entries[0],
    controllerDiagnostic.diagnostics.entries[0],
  );
});

test("does not fabricate pixel density when the runtime controller omits it", () => {
  const input = evidence();
  delete input.runtime.captures[0].pixelDensity;
  delete input.runtime.captures[1].pixelDensity;
  const projected = projectRuntimeEvidence(input);
  assert.deepEqual(projected.groups.capture.pixelDensities.value, []);
  assert.equal("pixelDensity" in projected.groups.capture.samples.value[0], false);
});

test("keeps base and head evidence independently scoped", () => {
  const result = projectRuntimeEvidenceComparison({
    status: "modified",
    base: evidence("base"),
    head: evidence("head"),
  });

  assert.equal(result.contract, RUNTIME_EVIDENCE_COMPARISON_CONTRACT);
  assert.equal(result.status, "modified");
  assert.equal(result.base.groups.screen.side.value, "base");
  assert.equal(result.head.groups.screen.side.value, "head");
  assert.equal(result.base.groups.screen.observationId.value, "base-observation");
  assert.equal(result.head.groups.screen.observationId.value, "head-observation");
  assert.equal(result.base.groups.environment.deviceModel.value, "iPhone 16");
  assert.equal(result.head.groups.environment.deviceModel.value, "iPhone 17");
});

test("models added as head-only and removed as base-only without environment borrowing", () => {
  const added = projectRuntimeEvidenceComparison({ status: "added", head: evidence("head") });
  assert.equal(added.status, "added");
  assert.equal("base" in added, false);

  const removed = projectRuntimeEvidenceComparison({ status: "removed", base: evidence("base") });
  assert.equal(removed.status, "removed");
  assert.equal("head" in removed, false);
  assert.equal(removed.base.groups.environment.deviceModel.value, "iPhone 16");

  assert.throws(
    () => projectRuntimeEvidenceComparison({
      status: "removed",
      base: evidence("base"),
      head: evidence("head"),
    }),
    /unsupported fields/,
  );
  assert.throws(
    () => projectRuntimeEvidenceComparison({ status: "removed", base: evidence("head") }),
    /wrong side scope/,
  );
  assert.throws(
    () => projectRuntimeEvidenceComparison({ status: "modified", base: evidence("base") }),
    /incomplete/,
  );
});

test("enforces representative observation and variant scope while allowing repeated observation samples", () => {
  const wrongObservation = evidence();
  wrongObservation.context.observationId = "another-observation";
  assert.throws(() => projectRuntimeEvidence(wrongObservation), /observation scope/);

  const wrongVariant = evidence();
  wrongVariant.runtime.captures[0].variantId = "logged-out";
  assert.throws(() => projectRuntimeEvidence(wrongVariant), /variant scope/);

  const wrongCaptureObservation = evidence();
  wrongCaptureObservation.runtime.captures[0].observationId = "another-observation";
  assert.deepEqual(
    projectRuntimeEvidence(wrongCaptureObservation).groups.capture.samples.value
      .map((sample) => sample.observationId),
    ["base-observation", "another-observation"],
  );

  const wrongInteractionObservation = evidence();
  wrongInteractionObservation.runtime.interactions[0].observationId = "another-observation";
  assert.throws(() => projectRuntimeEvidence(wrongInteractionObservation), /observation scope/);

  const duplicate = evidence();
  duplicate.runtime.interactions.push(structuredClone(duplicate.runtime.interactions[0]));
  assert.throws(() => projectRuntimeEvidence(duplicate), /duplicate ids/);
});

test("rejects fabricated mock fields and private diagnostics", () => {
  const forbiddenFields = [
    "server",
    "hydration",
    "tokenExpiry",
    "formValidity",
    "apiKey",
    "rawLogs",
    "networkTrace",
    "performanceTrace",
    "video",
    "sourcePath",
  ];
  for (const field of forbiddenFields) {
    const input = evidence();
    input.runtime.environment[field] = "do-not-publish-this-value";
    assert.throws(
      () => projectRuntimeEvidence(input),
      (error) => {
        assert.match(error.message, /forbidden/);
        assert.doesNotMatch(error.message, /do-not-publish/);
        return true;
      },
      field,
    );
  }

  const unknown = evidence();
  unknown.runtime.environment.permissionState = "granted";
  assert.throws(() => projectRuntimeEvidence(unknown), /unsupported fields/);

  for (const entry of [
    { kind: "log", value: "private" },
    { rawLogs: ["private"] },
    { networkTrace: "private" },
    { sourcePath: "/private/source.tsx" },
    { apiKey: "private" },
    { url: "https://example.test/private" },
  ]) {
    const diagnostics = evidence();
    diagnostics.diagnostics = { kind: "diagnostics-extension", entries: [entry] };
    assert.throws(
      () => projectRuntimeEvidence(diagnostics),
      /forbidden|unsupported fields|Diagnostics code/,
    );
  }
});

test("rejects empty, fabricated, duplicate, and runtime-unsupported diagnostics", () => {
  const diagnostics = evidence();
  diagnostics.diagnostics = { kind: "diagnostics-extension", entries: [] };
  assert.throws(() => projectRuntimeEvidence(diagnostics), /at least one safe entry/);

  const unsupportedFact = evidence();
  unsupportedFact.diagnostics = {
    kind: "diagnostics-extension",
    entries: [{
      code: "capture.stability-unstable",
      title: "Capture stability anomaly",
      value: "unstable",
      origin: "derived",
    }],
  };
  assert.throws(() => projectRuntimeEvidence(unsupportedFact), /not supported by runtime evidence/);

  for (const override of [
    { title: "https://example.test/private" },
    { value: "arbitrary reviewer prose" },
    { origin: "capture-context" },
  ]) {
    const fabricated = evidence();
    fabricated.diagnostics = {
      kind: "diagnostics-extension",
      entries: [{
        code: "capture.sample-shortfall",
        title: "Capture sample anomaly",
        value: "shortfall",
        origin: "derived",
        ...override,
      }],
    };
    assert.throws(() => projectRuntimeEvidence(fabricated), /Diagnostics .*invalid/);
  }

  const duplicate = evidence();
  const entry = {
    code: "capture.sample-shortfall",
    title: "Capture sample anomaly",
    value: "shortfall",
    origin: "derived",
  };
  duplicate.diagnostics = {
    kind: "diagnostics-extension",
    entries: [entry, structuredClone(entry)],
  };
  assert.throws(() => projectRuntimeEvidence(duplicate), /duplicate codes/);
});

test("rejects non-JSON numbers, unsafe routes, and inconsistent capture coverage", () => {
  const nonFinite = evidence();
  nonFinite.runtime.captures[0].pixelDensity = Number.NaN;
  assert.throws(() => projectRuntimeEvidence(nonFinite), /pixel density.*invalid/i);

  const unsafeRoute = evidence();
  unsafeRoute.context.route = "/settings?access_token=private";
  assert.throws(() => projectRuntimeEvidence(unsafeRoute), /Route is invalid/);

  const invalidCalendarDate = evidence();
  invalidCalendarDate.runtime.observation.capturedAt = "2026-02-30T01:00:00Z";
  assert.throws(() => projectRuntimeEvidence(invalidCalendarDate), /capture time.*invalid/i);

  const overflow = evidence();
  overflow.context.expectedSampleCount = 1;
  assert.throws(() => projectRuntimeEvidence(overflow), /exceed.*sample scope/);
});

test("preserves safe canonical app-route query variants", () => {
  const vocabulary = evidence();
  vocabulary.context.route = "/vocabulary?tab=human";
  assert.equal(
    projectRuntimeEvidence(vocabulary).groups.screen.route.value,
    "/vocabulary?tab=human",
  );

  const translation = evidence();
  translation.context.route = "/translation/record?mode=practice&locale=en-US";
  assert.equal(
    projectRuntimeEvidence(translation).groups.screen.route.value,
    "/translation/record?mode=practice&locale=en-US",
  );

  for (const route of [
    "https://example.test/profile",
    "//example.test/profile",
    "/profile#private",
    "/profile/../private",
    "/profile/%2e%2e/private",
    "/profile?api_key=private",
    "/profile?authorization=private",
    "/profile?tab=%00private",
  ]) {
    const unsafe = evidence();
    unsafe.context.route = route;
    assert.throws(() => projectRuntimeEvidence(unsafe), /Route is invalid/, route);
  }
});

test("does not serialize mock, credential, raw telemetry, or source-path fields", () => {
  const serialized = serializeRuntimeEvidence(evidence()).toLowerCase();
  for (const forbidden of [
    "hydration",
    "token",
    "formvalidity",
    "rawlogs",
    "networktrace",
    "performancetrace",
    "video",
    "sourcepath",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
