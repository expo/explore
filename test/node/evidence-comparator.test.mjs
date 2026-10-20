import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSurfaceEvidence } from "../../dist/review/evidence-comparator.js";
import { snapshotBackend } from "../../dist/review/evidence-assessment.js";
import { summarizeReviewerChanges } from "../../dist/review/reviewer-changes.js";
import { projectRuntimeEvidence } from "../../dist/review/runtime-evidence.js";

function element(options = {}) {
  return {
    elementId: options.elementId ?? "primary-cta",
    ...(options.identifier === undefined ? {} : { identifier: options.identifier }),
    role: options.role ?? "button",
    label: options.label ?? "Continue",
    ...(options.visible === undefined ? { visible: true } : { visible: options.visible }),
    ...(options.selector === undefined ? {} : { selector: options.selector }),
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    occurrence: options.occurrence ?? 0,
    controller: "agent-device",
    actions: options.actions ?? ["press"],
    risk: options.risk ?? "safe",
    actionable: options.actionable ?? true,
  };
}

function screen(id, title, route, observationIds = []) {
  return {
    id,
    title,
    route,
    start: id === "profile",
    terminal: false,
    depth: id === "profile" ? 0 : 1,
    firstSeenAt: "2026-09-01T01:00:00.000Z",
    lastSeenAt: "2026-09-01T01:00:00.000Z",
    visits: observationIds.length,
    variantIds: id === "profile" ? ["ready"] : [],
    observationIds,
    elementIds: [],
  };
}

function actionAttempt(side, sourceObservationId, sourceElement, target) {
  return {
    id: `${side}-attempt-${target.id}`,
    sourceScreenId: "profile",
    sourceObservationId,
    targetScreenId: target.id,
    action: {
      kind: "press",
      label: sourceElement.label,
      elementId: sourceElement.elementId,
    },
    outcome: "transition",
    risk: "safe",
    startedAt: "2026-09-01T01:00:01.000Z",
    completedAt: "2026-09-01T01:00:01.100Z",
    durationMs: 100,
  };
}

function mapFor(side, elements, options = {}) {
  const observationId = `${side}-observation`;
  const targets = options.targets ?? [];
  const attempts = options.actionTarget === undefined
    ? []
    : [actionAttempt(side, observationId, elements[0], options.actionTarget)];
  const observation = {
    id: observationId,
    screenId: "profile",
    variantId: "ready",
    fingerprints: { combined: `${side}-combined`, accessibility: `${side}-a11y` },
    capturedAt: "2026-09-01T01:00:00.000Z",
    surfaceScope: "app",
    elementIds: elements.map((candidate) => candidate.elementId),
    elements,
  };
  return {
    contract: "expo.explore.local-map.v1",
    revision: 1,
    run: {
      id: `${side}-run`,
      name: `${side} run`,
      platform: "ios",
      controller: "agent-device",
      status: "complete",
      createdAt: "2026-09-01T01:00:00.000Z",
      updatedAt: "2026-09-01T01:01:00.000Z",
      completedAt: "2026-09-01T01:01:00.000Z",
      build: { id: `${side}-build`, source: "eas" },
      environment: {
        deviceModel: "iPhone 17",
        osVersion: "26.5",
        locale: "en-US",
        orientation: "portrait",
        colorScheme: "light",
      },
      limits: { maxScreens: 120, maxActions: 500, maxDurationMinutes: 120 },
    },
    artifacts: [],
    screens: [
      screen("profile", options.title ?? "Profile", "/profile", [observationId]),
      ...targets.map((target) => screen(target.id, target.title, target.route)),
    ],
    variants: [],
    observations: [observation],
    elements: [],
    actionAttempts: attempts,
    transitions: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
}

function runtimeFor(side, map, expectedSamples = 3, capturedSamples = expectedSamples) {
  const observation = map.observations[0];
  const screens = new Map(map.screens.map((candidate) => [candidate.id, candidate]));
  return projectRuntimeEvidence({
    context: {
      kind: "configured-capture-context",
      side,
      logicalBuild: `${side}-build`,
      profile: "iphone-17-review",
      surfaceId: "profile",
      route: "/profile",
      variantId: "ready",
      observationId: observation.id,
      expectedSampleCount: expectedSamples,
      controllerPackageVersion: "0.20.2",
      easCliVersion: "25.2.0",
    },
    runtime: {
      kind: "eas-agent-device-raw",
      observation: {
        id: observation.id,
        variantId: observation.variantId,
        capturedAt: observation.capturedAt,
        surfaceScope: observation.surfaceScope,
        accessibility: {
          truncated: false,
          elements: observation.elements.map((candidate) => ({
            id: candidate.elementId,
            role: candidate.role,
            label: candidate.label,
            actionable: candidate.actionable,
            landmark: candidate.role === "text" && candidate.label.includes("playfield"),
          })),
        },
      },
      interactions: map.actionAttempts
        .filter((attempt) => attempt.sourceObservationId === observation.id)
        .map((attempt) => {
          const target = attempt.targetScreenId === undefined
            ? undefined
            : screens.get(attempt.targetScreenId);
          return {
            id: attempt.id,
            observationId: observation.id,
            action: attempt.action.kind,
            label: attempt.action.label,
            outcome: attempt.outcome,
            startedAt: attempt.startedAt,
            completedAt: attempt.completedAt,
            durationMs: attempt.durationMs,
            ...(target === undefined ? {} : {
              target: { surfaceId: target.id, route: target.route },
            }),
          };
        }),
      captures: Array.from({ length: capturedSamples }, (_, index) => ({
        id: `${side}-sample-${index + 1}`,
        observationId: observation.id,
        variantId: observation.variantId,
        capturedAt: `2026-09-01T01:00:0${index + 1}.000Z`,
        widthPixels: 1179,
        heightPixels: 2556,
        fingerprints: {
          combined: `${side}-stable`,
          visual: `${side}-visual`,
          accessibility: `${side}-a11y`,
        },
      })),
      environment: {
        provider: "eas-simulator",
        controller: "agent-device",
        platform: "ios",
        deviceModel: "iPhone 17",
        osVersion: "26.5",
        locale: "en-US",
        orientation: "portrait",
        colorScheme: "light",
        sessionLifecycle: "stopped",
      },
    },
  });
}

function side(sideName, elements, options = {}) {
  const map = mapFor(sideName, elements, options);
  return {
    map,
    observationId: `${sideName}-observation`,
    runtimeEvidence: runtimeFor(
      sideName,
      map,
      options.expectedSamples ?? 3,
      options.capturedSamples ?? options.expectedSamples ?? 3,
    ),
    ...(options.annotations === undefined
      ? {}
      : { reviewerAnnotations: options.annotations }),
  };
}

function impact(options = {}) {
  const presence = options.presence ?? "both";
  const samples = options.samples ?? 3;
  return {
    id: "profile",
    route: "/profile",
    presence,
    reasons: options.reasons ?? ["source:src/screens/profile.tsx"],
    baseSamples: presence === "head-only" ? 0 : samples,
    headSamples: presence === "base-only" ? 0 : samples,
  };
}

function visual(status = "unchanged", options = {}) {
  return {
    status,
    reason: options.reason ?? (
      status === "modified" ? "repeated-cross-build-delta"
        : status === "needs-review" ? "insufficient-samples"
          : "matched"
    ),
    baselineSamples: options.baselineSamples ?? 3,
    currentSamples: options.currentSamples ?? 3,
    requiredSamples: options.requiredSamples ?? 3,
    withinSideNoisePercentage: 0,
    ...(status === "modified" ? { crossBuildMismatchPercentage: 8.4 } : {}),
  };
}

function supportedChanges(result) {
  return result.reviewerChanges
    .filter((change) => change.assessment === "supported")
    .map((change) => change.change);
}

test("observer payload changes do not become UI changes or invalidate runtime projections", () => {
  const base = side('base', [element({ identifier: 'primary-cta', label: 'Continue' })]);
  const head = side('head', [element({ identifier: 'primary-cta', label: 'Continue' })]);
  // Runtime UI projections contain app elements only; raw observations also retain metadata.
  for (const [name, evidence] of [['base', base], ['head', head]]) {
    for (const identifier of ['expo-explore-route', 'expo-explore-observer']) {
      evidence.map.observations[0].elements.push(element({ elementId: `${name}-${identifier}`, identifier,
        role: 'text', actions: [], actionable: false,
        label: JSON.stringify({ pathname: '/profile', parameters: { diagnostic: `${name}-session` } }) }));
    }
  }
  const result = compareSurfaceEvidence({ impact: impact(), base, head, visualAssessment: visual('unchanged') });
  assert.equal(result.status, 'unchanged');
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.reviewReasons, []);
  assert.deepEqual(supportedChanges(result).map(change => change.kind), ['no-visible-change']);
  assert.doesNotMatch(JSON.stringify(result.reviewerChanges), /expo-explore|diagnostic|pathname/);
});

test("turns an annotated CTA label delta into a visible button-title reviewer fact", () => {
  const baseElement = element({ identifier: "primary-cta", label: "A" });
  const headElement = element({ identifier: "primary-cta", label: "B" });
  const annotation = [{
    identifier: "primary-cta",
    role: "button",
    textSource: "visible-title",
    subjectLabel: "Primary CTA",
  }];
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [baseElement], { annotations: annotation }),
    head: side("head", [headElement], { annotations: annotation }),
    visualAssessment: visual("modified"),
  });

  assert.equal(result.status, "modified");
  assert.equal(result.needsReview, false);
  assert.ok(supportedChanges(result).some((change) => (
    change.kind === "visible-text-changed"
    && change.textKind === "title"
    && change.before === "A"
    && change.after === "B"
  )));
  assert.equal(
    supportedChanges(result).some((change) => change.kind === "accessibility-label-changed"),
    false,
  );
  const summary = summarizeReviewerChanges({ changes: result.reviewerChanges });
  assert.ok(summary.facts.some((fact) => fact.bullet === "Changed button title from “A” to “B”."));
});

test("keeps an unannotated label delta in the accessibility category", () => {
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({ identifier: "save", label: "Submit form" })]),
    head: side("head", [element({ identifier: "save", label: "Save profile" })]),
    visualAssessment: visual(),
  });

  assert.ok(supportedChanges(result).some((change) => (
    change.kind === "accessibility-label-changed"
    && change.before === "Submit form"
    && change.after === "Save profile"
  )));
  assert.equal(
    supportedChanges(result).some((change) => change.kind === "visible-text-changed"),
    false,
  );
});

test("a label that varies within both builds, in the words that differ between them, is runtime state", () => {
  const stamp = (label) => [element({ elementId: "stamp", identifier: "stamp", role: "text", label, actions: [], actionable: false })];
  const sibling = (base, head) => ({ base: side("base", base), head: side("head", head) });
  const input = {
    impact: impact(),
    base: side("base", stamp("edited 2m ago")),
    head: side("head", stamp("edited 3m ago")),
    visualAssessment: visual(),
  };
  const plain = supportedChanges(compareSurfaceEvidence(input));
  assert.ok(plain.some((change) => change.kind === "accessibility-label-changed"), "without a sibling capture the label difference is a change");

  const result = compareSurfaceEvidence({ ...input, siblings: [sibling(stamp("edited 1m ago"), stamp("edited 4m ago"))] });
  const changes = supportedChanges(result);
  assert.deepEqual(changes.map((change) => change.kind), ["unstable-text"]);
  assert.deepEqual(changes[0], { kind: "unstable-text", subjectRole: "text", before: "edited 2m ago", after: "edited 3m ago", within: "edited 4m ago" });
  const summary = summarizeReviewerChanges({ changes: result.reviewerChanges });
  assert.deepEqual(summary.facts.map((fact) => [fact.templateId, fact.bullet]),
    [["visible-text.unstable-within-build", "Text varies between captures of the same build: \u201cedited 2m ago\u201d / \u201cedited 4m ago\u201d / \u201cedited 3m ago\u201d."]]);
  assert.equal(summary.needsReview, false);

  // A stable label beside it is still a change.
  const save = (label) => element({ identifier: "save", label });
  const mixed = compareSurfaceEvidence({
    ...input,
    base: side("base", [...stamp("edited 2m ago"), save("Submit")]),
    head: side("head", [...stamp("edited 3m ago"), save("Save")]),
    siblings: [sibling([...stamp("edited 1m ago"), save("Submit")], [...stamp("edited 4m ago"), save("Save")])],
  });
  assert.deepEqual(supportedChanges(mixed).map((change) => change.kind).sort(), ["accessibility-label-changed", "unstable-text"]);
  // Pixels that only an unstable label explains still get the generic styling line.
  const pixels = compareSurfaceEvidence({ ...input, visualAssessment: visual("modified"), siblings: [sibling(stamp("edited 1m ago"), stamp("edited 4m ago"))] });
  assert.deepEqual(supportedChanges(pixels).map((change) => change.kind), ["unstable-text", "visual-changed"]);
});

test("a label that follows the appearance, or changed in a word that does not vary, is still a change", () => {
  const label = (text) => [element({ identifier: "toggle", label: text })];
  const compare = ([baseLight, baseDark], [headLight, headDark], options = {}) => supportedChanges(compareSurfaceEvidence({
    impact: impact(),
    base: side("base", label(baseLight), options.base),
    head: side("head", label(headLight), options.head),
    visualAssessment: visual(),
    siblings: [{ base: side("base", label(baseDark)), head: side("head", label(headDark), options.headSibling) }],
  })).map((change) => change.kind);
  // The theme toggle's label follows the appearance; the head broke it in light only.
  assert.deepEqual(compare(["Switch to dark mode", "Switch to light mode"], ["Switch to light mode", "Switch to light mode"]), ["accessibility-label-changed"]);
  assert.deepEqual(compare(["Switch to dark mode", "Switch to light mode"], ["Enable dark mode", "Switch to light mode"]), ["accessibility-label-changed"]);
  // The base varies, the head does not.
  assert.deepEqual(compare(["Save", "Save draft"], ["Submit", "Submit"]), ["accessibility-label-changed"]);
  // The time varies; the name beside it changed.
  assert.deepEqual(compare(["Posted by Alice · 2m", "Posted by Alice · 3m"], ["Posted by Bob · 4m", "Posted by Bob · 5m"]), ["accessibility-label-changed"]);
  // A sibling capture that did not resolve cleanly is no evidence.
  assert.deepEqual(compare(["Saved 2m ago", "Saved 3m ago"], ["Saved 4m ago", "Saved 5m ago"], { headSibling: { capturedSamples: 1 } }), ["accessibility-label-changed"]);
  assert.deepEqual(compare(["Saved 2m ago", "Saved 3m ago"], ["Saved 4m ago", "Saved 5m ago"]), ["unstable-text"]);

  // Provenance on one side only stays inconclusive.
  const annotation = [{ identifier: "toggle", role: "button", textSource: "visible-title" }];
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", label("Saved 2m ago"), { annotations: annotation }),
    head: side("head", label("Saved 4m ago")),
    visualAssessment: visual(),
    siblings: [{ base: side("base", label("Saved 3m ago"), { annotations: annotation }), head: side("head", label("Saved 5m ago")) }],
  });
  assert.equal(result.needsReview, true);
  assert.ok(result.reviewReasons.some((reason) => /provenance.*one side/i.test(reason)));
  assert.equal(supportedChanges(result).some((change) => change.kind === "unstable-text"), false);
});

test("text without an identifier that varies within both builds is matched by its place, not its label", () => {
  const bounds = { x: 0, y: 120, width: 390, height: 64 };
  // A pattern row: a pressable with one accessibility label and no testID, exposed again by its container on iOS.
  const row = (label) => [
    element({ elementId: "row", role: "button", label, selector: `label=${label}`, bounds }),
    element({ elementId: "row-cell", role: "other", label, selector: `label=${label}`, bounds, actions: [], actionable: false }),
  ];
  const compare = (baseLabels, headLabels) => compareSurfaceEvidence({
    impact: impact(),
    base: side("base", row(baseLabels[0])),
    head: side("head", row(headLabels[0])),
    visualAssessment: visual(),
    ...(baseLabels[1] ? { siblings: [{ base: side("base", row(baseLabels[1])), head: side("head", row(headLabels[1])) }] } : {}),
  });
  assert.deepEqual(supportedChanges(compare(["Velvet Tresillo, 4 lanes, edited 2m ago"], ["Velvet Tresillo, 4 lanes, edited 4m ago"])).map((change) => change.kind).sort(),
    ["element-added", "element-removed"], "without a sibling capture the row left and arrived");

  const result = compare(["Velvet Tresillo, 4 lanes, edited 2m ago", "Velvet Tresillo, 4 lanes, edited 3m ago"],
    ["Velvet Tresillo, 4 lanes, edited 4m ago", "Velvet Tresillo, 4 lanes, edited 5m ago"]);
  assert.deepEqual(supportedChanges(result), [{ kind: "unstable-text", subjectRole: "button",
    before: "Velvet Tresillo, 4 lanes, edited 2m ago", after: "Velvet Tresillo, 4 lanes, edited 4m ago", within: "Velvet Tresillo, 4 lanes, edited 5m ago" }]);
  assert.equal(result.needsReview, false);
  // A random name is runtime state the same way.
  assert.deepEqual(supportedChanges(compare(["Velvet Tresillo", "Copper Pulse"], ["Hollow Echo", "Ghost Relay"])).map((change) => change.kind), ["unstable-text"]);
  // A real change in the same row is still a change.
  assert.deepEqual(supportedChanges(compare(["Velvet Tresillo, 4 lanes, edited 2m ago", "Velvet Tresillo, 4 lanes, edited 3m ago"],
    ["Velvet Tresillo, 5 lanes, edited 4m ago", "Velvet Tresillo, 5 lanes, edited 5m ago"])).map((change) => change.kind).sort(), ["element-added", "element-removed"]);
});

test("fails closed when visible-title provenance exists on only one side", () => {
  const annotation = [{
    identifier: "primary-cta",
    role: "button",
    textSource: "visible-title",
  }];
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({ identifier: "primary-cta", label: "A" })], {
      annotations: annotation,
    }),
    head: side("head", [element({ identifier: "primary-cta", label: "B" })]),
    visualAssessment: visual("modified"),
  });

  assert.equal(result.needsReview, true);
  assert.ok(result.reviewReasons.some((reason) => /provenance.*one side/i.test(reason)));
  assert.equal(supportedChanges(result).some((change) => (
    change.kind === "visible-text-changed" || change.kind === "accessibility-label-changed"
  )), false);
});

test("matches by selector and occurrence after identifier matching and detects role changes", () => {
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({
      elementId: "base-continue",
      identifier: undefined,
      selector: "app/profile/continue",
      occurrence: 0,
      role: "link",
      label: "Continue",
    })]),
    head: side("head", [element({
      elementId: "head-continue",
      identifier: undefined,
      selector: "app/profile/continue",
      occurrence: 0,
      role: "button",
      label: "Continue",
    })]),
    visualAssessment: visual(),
  });

  assert.deepEqual(supportedChanges(result), [{
    kind: "accessibility-role-changed",
    subjectLabel: "Continue",
    beforeRole: "link",
    afterRole: "button",
  }]);
});

test("reports added and removed elements after deterministic semantic matching", () => {
  const commonBase = element({ elementId: "common-base", identifier: "common", label: "Common" });
  const commonHead = element({ elementId: "common-head", identifier: "common", label: "Common" });
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [commonBase, element({
      elementId: "old",
      identifier: "old",
      role: "image",
      label: "Old avatar",
    })]),
    head: side("head", [commonHead, element({
      elementId: "new",
      identifier: "new",
      role: "button",
      label: "Upload avatar",
    })]),
    visualAssessment: visual("modified"),
  });

  assert.ok(supportedChanges(result).some((change) => (
    change.kind === "element-removed" && change.elementLabel === "Old avatar"
  )));
  assert.ok(supportedChanges(result).some((change) => (
    change.kind === "element-added" && change.elementLabel === "Upload avatar"
  )));
});

test("compares only safe action transitions with canonical target routes", () => {
  const baseTarget = { id: "old-target", title: "Cat details", route: "/cats/details" };
  const headTarget = { id: "new-target", title: "Cat Care Guide", route: "/cats/care-guide" };
  const baseElement = element({ identifier: "care-guide", label: "Care guide" });
  const headElement = element({ identifier: "care-guide", label: "Care guide" });
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [baseElement], { targets: [baseTarget], actionTarget: baseTarget }),
    head: side("head", [headElement], { targets: [headTarget], actionTarget: headTarget }),
    visualAssessment: visual(),
  });

  assert.ok(supportedChanges(result).some((change) => (
    change.kind === "action-target-changed"
    && change.beforeTarget === "Cat details"
    && change.afterTarget === "Cat Care Guide"
  )));
});

test("equal-sized duplicate groups pair in capture order instead of failing closed", () => {
  const duplicated = (prefix, count) => Array.from({ length: count }, (_, index) => (
    element({ elementId: `${prefix}-${index}`, identifier: undefined, label: "Done", selector: undefined, occurrence: index })
  ));
  // Repeated label-less controls are common (image grids, form fields); the trees differ elsewhere,
  // so this exercises the pairing rather than the identical-tree shortcut.
  const extra = element({ elementId: "extra", identifier: "extra", label: "Extra" });
  const paired = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", duplicated("base", 2)),
    head: side("head", [...duplicated("head", 2).reverse(), extra]),
    visualAssessment: visual(),
  });
  assert.equal(paired.needsReview, false);
  assert.ok(!paired.reviewReasons.some((reason) => /ambiguous/i.test(reason)));
  assert.ok(supportedChanges(paired).some((change) => change.kind === "element-added"));
  assert.ok(!supportedChanges(paired).some((change) => change.kind === "element-removed"));

  // Different counts still fail closed: no guess about which duplicate appeared or vanished.
  const unequal = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", duplicated("base", 2)),
    head: side("head", duplicated("head", 3)),
    visualAssessment: visual(),
  });
  assert.equal(unequal.needsReview, true);
  assert.ok(unequal.reviewReasons.some((reason) => /role-label.*ambiguous/i.test(reason)));
  assert.equal(supportedChanges(unequal).length, 0);
});

test("one label appearing or leaving is one fact, reported through its most specific role", () => {
  // iOS exposes a control, its container and its text under the same label.
  const layers = prefix => [
    element({ elementId: `${prefix}-wrapper`, identifier: undefined, role: "other", label: "Care guide", selector: undefined, actionable: false, actions: [] }),
    element({ elementId: `${prefix}-text`, identifier: undefined, role: "text", label: "Care guide", selector: undefined, actionable: false, actions: [] }),
    element({ elementId: `${prefix}-button`, identifier: undefined, role: "button", label: "Care guide", selector: undefined }),
  ];
  const added = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({ elementId: "keep", identifier: "keep", label: "Keep" })]),
    head: side("head", [element({ elementId: "keep", identifier: "keep", label: "Keep" }), ...layers("head")]),
    visualAssessment: visual(),
  });
  assert.deepEqual(supportedChanges(added).map(change => [change.kind, change.elementRole, change.elementLabel]),
    [["element-added", "button", "Care guide"]]);

  const removed = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({ elementId: "keep", identifier: "keep", label: "Keep" }), ...layers("base")]),
    head: side("head", [element({ elementId: "keep", identifier: "keep", label: "Keep" })]),
    visualAssessment: visual(),
  });
  assert.deepEqual(supportedChanges(removed).map(change => [change.kind, change.elementRole, change.elementLabel]),
    [["element-removed", "button", "Care guide"]]);
});

test("a label that survives on the other revision is not reported as coming or going", () => {
  // A list that shifts up re-exposes its rows: the same label appears under a different role.
  const base = side("base", [
    element({ elementId: "sweet", identifier: undefined, label: "SWEET BEE", selector: undefined }),
    element({ elementId: "butterfly-text", identifier: undefined, role: "text", label: "BUTTERFLY", selector: undefined, actionable: false, actions: [] }),
    element({ elementId: "butterfly-other", identifier: undefined, role: "other", label: "BUTTERFLY", selector: undefined, actionable: false, actions: [] }),
  ]);
  const head = side("head", [
    element({ elementId: "butterfly-other", identifier: undefined, role: "other", label: "BUTTERFLY", selector: undefined, actionable: false, actions: [] }),
  ]);
  const result = compareSurfaceEvidence({ impact: impact(), base, head, visualAssessment: visual("modified") });
  assert.deepEqual(supportedChanges(result).map(change => [change.kind, change.elementLabel]),
    [["element-removed", "SWEET BEE"]]);
  assert.equal(result.needsReview, false);
});

test("the generic styling fact only speaks when no element change explains the pixels", () => {
  const withElement = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({ elementId: "keep", identifier: "keep", label: "Keep" })]),
    head: side("head", [element({ elementId: "keep", identifier: "keep", label: "Keep" }),
      element({ elementId: "added", identifier: "added", label: "Care guide" })]),
    visualAssessment: visual("modified"),
  });
  assert.deepEqual(supportedChanges(withElement).map(change => change.kind), ["element-added"]);

  // Restyling alone changes no element, so the visual fact is the only account of the difference.
  const stylingOnly = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [element({ elementId: "keep", identifier: "keep", label: "Keep" })]),
    head: side("head", [element({ elementId: "keep", identifier: "keep", label: "Keep" })]),
    visualAssessment: visual("modified"),
  });
  assert.deepEqual(supportedChanges(stylingOnly).map(change => change.kind), ["visual-changed"]);
});

test("a duplicate stable key present on one side only is reported as a removal or addition", () => {
  // iOS exposes a control and its wrapper under one label; renaming the control moves both to a new key.
  const labelled = (prefix, label) => [
    element({ elementId: `${prefix}-wrapper`, identifier: undefined, role: "other", label, selector: `label=${label}`, occurrence: 0, actionable: false, actions: [] }),
    element({ elementId: `${prefix}-button`, identifier: undefined, role: "button", label, selector: `label=${label}`, occurrence: 0 }),
  ];
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", labelled("base", "Share App")),
    head: side("head", labelled("head", "Share Example with friends")),
    visualAssessment: visual(),
  });
  assert.equal(result.needsReview, false);
  assert.ok(!result.reviewReasons.some((reason) => /ambiguous/i.test(reason)));
  const kinds = supportedChanges(result).map((change) => change.kind);
  assert.ok(kinds.includes("element-removed"));
  assert.ok(kinds.includes("element-added"));
});

test("is deterministic when map element and annotation order changes", () => {
  const baseElements = [
    element({ elementId: "one", identifier: "one", label: "One" }),
    element({ elementId: "two", identifier: "two", label: "Two" }),
  ];
  const headElements = [
    element({ elementId: "head-one", identifier: "one", label: "First" }),
    element({ elementId: "head-two", identifier: "two", label: "Second" }),
  ];
  const annotations = [
    { identifier: "one", role: "button", textSource: "visible-title" },
    { identifier: "two", role: "button", textSource: "visible-title" },
  ];
  const forward = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", baseElements, { annotations }),
    head: side("head", headElements, { annotations }),
    visualAssessment: visual("modified"),
  });
  const reversed = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [...baseElements].reverse(), { annotations: [...annotations].reverse() }),
    head: side("head", [...headElements].reverse(), { annotations: [...annotations].reverse() }),
    visualAssessment: visual("modified"),
  });

  assert.deepEqual(reversed, forward);
});

test("emits a supported no-visible-change assessment for source-only changes", () => {
  const unchanged = element({ identifier: "settings", label: "Settings" });
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [unchanged]),
    head: side("head", [structuredClone(unchanged)]),
    visualAssessment: visual(),
  });

  assert.equal(result.status, "unchanged");
  assert.equal(result.needsReview, false);
  assert.deepEqual(supportedChanges(result), [{ kind: "no-visible-change" }]);
  const summary = summarizeReviewerChanges({ changes: result.reviewerChanges });
  assert.equal(summary.status, "ready");
  assert.equal(summary.noVisibleChange, true);
});

test("reports a semantic runtime delta as a fact and leaves source provenance to the verdict", () => {
  const result = compareSurfaceEvidence({
    impact: impact({ samples: 1, reasons: [] }),
    base: side("base", [element({ identifier: "save", label: "Save" })], { expectedSamples: 1 }),
    head: side("head", [element({ identifier: "save", label: "Submit" })], { expectedSamples: 1 }),
    visualAssessment: visual("unchanged", {
      baselineSamples: 1,
      currentSamples: 1,
      requiredSamples: 1,
    }),
  });

  assert.equal(result.status, "modified");
  assert.equal(result.needsReview, false);
  assert.equal(result.reviewReasons.some((reason) => /provenance/i.test(reason)), false);
});

test("never derives landmark semantics from pixels and validates explicit landmark scopes", () => {
  const unchanged = element({ identifier: "game", label: "Game" });
  const generic = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [unchanged]),
    head: side("head", [structuredClone(unchanged)]),
    visualAssessment: visual("modified"),
  });
  assert.ok(supportedChanges(generic).some((change) => (
    change.kind === "visual-changed" && change.scope.kind === "main-content"
  )));

  const unsupportedLandmark = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [unchanged]),
    head: side("head", [structuredClone(unchanged)]),
    visualAssessment: visual("modified"),
    visualScope: { kind: "landmark", label: "Goldfish playfield" },
  });
  assert.equal(unsupportedLandmark.needsReview, true);
  assert.equal(
    supportedChanges(unsupportedLandmark).some((change) => change.kind === "visual-changed"),
    false,
  );
});

test("produces screen facts and one-sided RuntimeEvidenceComparison for added and removed surfaces", () => {
  const head = side("head", [element()], { title: "Cat Care Guide" });
  const added = compareSurfaceEvidence({
    impact: impact({ presence: "head-only" }),
    head,
  });
  assert.equal(added.status, "added");
  assert.equal(added.runtimeEvidence.status, "added");
  assert.equal("base" in added.runtimeEvidence, false);
  assert.deepEqual(supportedChanges(added), [{
    kind: "screen-added",
    screenTitle: "Cat Care Guide",
  }]);

  const base = side("base", [element()], { title: "Sweet Bee" });
  const removed = compareSurfaceEvidence({
    impact: impact({ presence: "base-only" }),
    base,
  });
  assert.equal(removed.status, "removed");
  assert.equal(removed.runtimeEvidence.status, "removed");
  assert.equal("head" in removed.runtimeEvidence, false);
  assert.deepEqual(supportedChanges(removed), [{
    kind: "screen-removed",
    screenTitle: "Sweet Bee",
  }]);
});

test("blocks publication for incomplete samples or inconclusive visual evidence", () => {
  const unchanged = element({ identifier: "settings", label: "Settings" });
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [unchanged], { expectedSamples: 3, capturedSamples: 1 }),
    head: side("head", [structuredClone(unchanged)], { expectedSamples: 3, capturedSamples: 1 }),
    visualAssessment: visual("needs-review", {
      baselineSamples: 1,
      currentSamples: 1,
      requiredSamples: 3,
    }),
  });

  assert.equal(result.needsReview, true);
  assert.ok(result.reviewReasons.some((reason) => /coverage is incomplete/i.test(reason)));
  assert.ok(result.reviewReasons.some((reason) => /visual evidence needs review/i.test(reason)));
  assert.equal(supportedChanges(result).some((change) => change.kind === "no-visible-change"), false);
});

test("the route observer's unidentified wrapper is capture metadata, not an added element", () => {
  const destination = JSON.stringify({ provider: "expo-router", pathname: "/profile", segments: ["profile"], parameters: {} });
  const content = (id) => element({ elementId: `${id}-continue`, identifier: "primary-cta", label: "Continue" });
  // XCTest exposes an Other wrapper that carries the observer's label without its identifier.
  const wrapper = element({ elementId: "head-wrapper", role: "other", label: destination, actions: [], actionable: false });
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: side("base", [content("base")]),
    head: side("head", [content("head"), wrapper]),
    visualAssessment: visual("unchanged"),
  });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(supportedChanges(result).map((change) => change.kind), ["no-visible-change"]);
});

test("snapshots from different controller backends compare content, not containers or roles", () => {
  const text = (id, label, role) => element({ elementId: id, label, role, selector: `app/games/${label}`, actions: [], actionable: false });
  // agent-device 0.21.x: the host AX bridge (base) and XCTest (head) describe the same text with
  // different roles and containers, and head exposes merged labels the bridge splits.
  const base = side("base", [text("b-score", "0", "text"), text("b-level", "Level 1", "text"), text("b-title", "Games", "text"),
    text("b-mood", "Check Mood", "text"), text("b-coins", "3", "text")]);
  const head = side("head", [text("h-score", "0", "other"), text("h-level", "Level 1", "other"), text("h-title", "Games", "other"),
    text("h-container", "Games, Level 1", "other"), element({ elementId: "h-mood", role: "button", label: "Check Mood, 3" }),
    element({ elementId: "h-account", identifier: "account-row", role: "button", label: "Account" })]);
  const result = compareSurfaceEvidence({
    impact: impact(),
    base: { ...base, snapshotBackend: "ax-bridge" },
    head: { ...head, snapshotBackend: "tree" },
    visualAssessment: visual("modified"),
  });
  assert.deepEqual(supportedChanges(result).filter((change) => change.kind !== "visual-styling-changed"), [{
    kind: "element-added", elementRole: "button", elementLabel: "Account",
  }]);
  // The same trees from one backend still report the role changes.
  const same = compareSurfaceEvidence({
    impact: impact(),
    base: { ...base, snapshotBackend: "tree" },
    head: { ...head, snapshotBackend: "tree" },
    visualAssessment: visual("modified"),
  });
  assert.ok(supportedChanges(same).some((change) => change.kind === "accessibility-role-changed"));
});

test("a capture's snapshot backend is read from its saved controller response", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "explore-snapshot-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "artifacts/accessibility"), { recursive: true });
  const map = (path) => ({ observations: [{ id: "o", accessibilityArtifactId: "a" }], artifacts: [{ id: "a", kind: "accessibility", path }] });
  const write = (name, data) => writeFile(join(directory, "artifacts/accessibility", name), JSON.stringify({ success: true, data }));
  await write("xctest.json", { snapshotQuality: { state: "healthy", backend: "tree" }, nodes: [{ type: "Other", label: "Games" }] });
  await write("bridge.json", { nodes: [{ type: "Application", pid: 42, role: "UIApplication", subrole: "" }] });
  await write("plain.json", { nodes: [{ type: "Other" }] });
  assert.equal(snapshotBackend(directory, map("artifacts/accessibility/xctest.json"), "o"), "tree");
  assert.equal(snapshotBackend(directory, map("artifacts/accessibility/bridge.json"), "o"), "ax-bridge");
  assert.equal(snapshotBackend(directory, map("artifacts/accessibility/plain.json"), "o"), undefined);
  assert.equal(snapshotBackend(directory, map("artifacts/accessibility/missing.json"), "o"), undefined);
  assert.equal(snapshotBackend(directory, map("../outside.json"), "o"), undefined);
});

/**
 * Tempo on the closed iPhone Duo in brentvatne/euxy#172 (review run 39362642343): a 1398 × 2034 screenshot of a
 * 466 × 678 pt screen, and a footnote whose text changed below the fold of its scrolling sheet, so the screenshots match.
 * The review carries no accessibility tree; the footnote's bounds are placed from the screenshot, under the
 * Base Resolution row, running past the screen's bottom edge.
 */
function tempoSide(sideName, footnote, footnoteBounds, image = { width: 1398, height: 2034 }) {
  const evidence = side(sideName, [
    element({ elementId: "app", role: "other", label: "euxy", actions: [], actionable: false, bounds: { x: 0, y: 0, width: 466, height: 678, unit: "points" } }),
    element({ elementId: "title", role: "text", label: "Base Resolution", actions: [], actionable: false, bounds: { x: 26, y: 560, width: 300, height: 24, unit: "points" } }),
    element({ elementId: `${sideName}-footnote`, role: "text", label: footnote, actions: [], actionable: false, bounds: footnoteBounds }),
  ]);
  if (image) {
    evidence.map.artifacts.push({ id: `${sideName}-shot`, kind: "screenshot", path: `${sideName}.png`, sha256: "0".repeat(64), mimeType: "image/png", ...image, createdAt: "2026-09-01T01:00:00.000Z" });
    evidence.map.observations[0].screenshotArtifactId = `${sideName}-shot`;
  }
  return evidence;
}
const NEW_LANES = "Changes apply live while playing. Base resolution sets the step grid for new lanes.";
const ADD_NEXT = "Changes apply live while playing. Base resolution sets the step grid for lanes you add next.";
const belowFold = { x: 26, y: 652, width: 414, height: 40, unit: "points" };

test("matching screenshots of a change whose elements run past the screen's edge are off-screen (euxy#172, closed iPhone Duo)", () => {
  const result = compareSurfaceEvidence({ impact: impact(), base: tempoSide("base", NEW_LANES, belowFold), head: tempoSide("head", ADD_NEXT, belowFold), visualAssessment: visual("unchanged") });
  assert.ok(supportedChanges(result).length > 0);
  assert.equal(result.offScreen, true);
  // A turned frame (an opened iPhone Duo shown upright) keeps the tree on the portrait axes: the screen is still found.
  const turned = { width: 2034, height: 1398 };
  assert.equal(compareSurfaceEvidence({ impact: impact(), base: tempoSide("base", NEW_LANES, belowFold, turned), head: tempoSide("head", ADD_NEXT, belowFold, turned),
    visualAssessment: visual("unchanged") }).offScreen, true);
});

test("a change on the screen, one whose screenshots differ, or one with no screen to measure against is never off-screen", () => {
  const onScreen = { x: 26, y: 600, width: 414, height: 40, unit: "points" };
  const cases = {
    "an on-screen text change": [tempoSide("base", NEW_LANES, onScreen), tempoSide("head", ADD_NEXT, onScreen), visual("unchanged")],
    "screenshots that differ": [tempoSide("base", NEW_LANES, belowFold), tempoSide("head", ADD_NEXT, belowFold), visual("modified")],
    "no screenshot size": [tempoSide("base", NEW_LANES, belowFold, null), tempoSide("head", ADD_NEXT, belowFold, null), visual("unchanged")],
    "a changed element without bounds": [tempoSide("base", NEW_LANES, undefined), tempoSide("head", ADD_NEXT, undefined), visual("unchanged")],
  };
  for (const [name, [base, head, assessment]] of Object.entries(cases)) {
    assert.equal(compareSurfaceEvidence({ impact: impact(), base, head, visualAssessment: assessment }).offScreen, undefined, name);
  }
});
