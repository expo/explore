import assert from "node:assert/strict";
import { captureAliasFixture } from "../helpers/viewer-map-fixture.mjs";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const presentationModel = await tsImport(
  "../../viewer/src/utils/screen-presentation.ts",
  import.meta.url,
);
const { indexMap } = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);

function screen(id, title, route, variantIds, overrides = {}) {
  return {
    id,
    title,
    route,
    start: false,
    terminal: false,
    depth: 1,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z",
    visits: 1,
    variantIds,
    observationIds: variantIds.map((variantId) => `observation-${variantId}`),
    elementIds: [],
    ...overrides,
  };
}

function mapWith(screens) {
  const variants = screens.flatMap((entry) => entry.variantIds.map((variantId) => ({
    id: variantId,
    screenId: entry.id,
    key: variantId,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    observationIds: [`observation-${variantId}`],
  })));
  const observations = screens.flatMap((entry) => entry.variantIds.map((variantId) => ({
    id: `observation-${variantId}`,
    screenId: entry.id,
    variantId,
    capturedAt: entry.firstSeenAt,
    surfaceScope: "app",
    elements: [],
    elementIds: [],
    fingerprints: { combined: variantId },
  })));
  return {
    contract: "local-map/v1",
    revision: 1,
    run: { id: "run", name: "Fixture" },
    artifacts: [],
    screens,
    variants,
    observations,
    elements: [],
    actionAttempts: [],
    transitions: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
}

test("presents screens sharing a display router path as one screen with ordered variants", () => {
  const first = screen("screen-home-empty", "Home — Empty", "/mobbin/screens/1", ["variant-empty"]);
  const second = screen("screen-home-loaded", "Home — Loaded", "/mobbin/screens/2", ["variant-loaded"]);
  const settings = screen("screen-settings", "Settings", "/settings", ["variant-settings"]);
  const source = mapWith([first, second, settings]);
  source.transitions = [
    { id: "state", fromScreenId: first.id, toScreenId: second.id },
    { id: "next", fromScreenId: second.id, toScreenId: settings.id },
  ];
  source.actionAttempts = [{
    id: "state-attempt",
    sourceScreenId: first.id,
    targetScreenId: second.id,
    outcome: "transition",
  }];
  source.journeys = [{
    id: "journey",
    title: "Home to settings",
    screenIds: [first.id, second.id, settings.id],
    transitionIds: ["state", "next"],
    attemptIds: [],
  }];

  const presentation = presentationModel.presentScreensByPath(source);
  const home = presentation.map.screens[0];
  assert.equal(presentation.map.screens.length, 2);
  assert.equal(home.id, first.id);
  assert.deepEqual(home.variantIds, ["variant-empty", "variant-loaded"]);
  assert.equal(presentation.representativeIdByScreenId.get(second.id), first.id);
  assert.equal(presentation.index.variants.get("variant-loaded")?.screenId, first.id);
  assert.equal(presentation.index.observations.get("observation-variant-loaded")?.screenId, first.id);
  assert.deepEqual(presentation.map.journeys[0].screenIds, [first.id, first.id, settings.id]);
  assert.deepEqual(
    presentation.map.transitions.map((transition) => [transition.fromScreenId, transition.toScreenId]),
    [[first.id, first.id], [first.id, settings.id]],
  );
  assert.equal(presentation.map.actionAttempts[0].outcome, "same-screen");

  const aliases = presentationModel.screenAliasesForPresentation(source, presentation);
  assert.equal(aliases.screenIdAliasVariants.get(second.id), "variant-loaded");
  assert.deepEqual(aliases.screenRouteAliases.get("/mobbin/screens/2"), {
    screenId: first.id,
    variantId: "variant-loaded",
  });
});

test("prefers current evidence when a displayed path also contains a baseline-only screen", () => {
  const removed = screen(
    "removed:build-1:screen:home",
    "Home — Legacy",
    "/mobbin/screens/1",
    ["removed-variant"],
  );
  const current = screen("screen-home", "Home — Current", "/mobbin/screens/2", ["current-variant"]);
  const presentation = presentationModel.presentScreensByPath(mapWith([removed, current]));
  const home = presentation.map.screens[0];

  assert.equal(home.id, current.id);
  assert.deepEqual(home.variantIds, ["current-variant"]);
  assert.equal(presentation.representativeIdByScreenId.get(removed.id), current.id);
  assert.deepEqual(presentation.map.variants.map((variant) => variant.id), ["current-variant"]);
  assert.deepEqual(
    presentation.map.observations.map((observation) => observation.id),
    ["observation-current-variant"],
  );
});

test("normalizes equivalent router paths before grouping", () => {
  const first = screen("screen-details-a", "Details A", "/(tabs)//details/%5Bid%5D/", ["variant-a"]);
  const second = screen("screen-details-b", "Details B", "/(tabs)/details/[id]", ["variant-b"]);
  const presentation = presentationModel.presentScreensByPath(mapWith([first, second]));

  assert.equal(presentation.map.screens.length, 1);
  assert.equal(presentation.families[0].path, "/(tabs)/details/[id]");
  assert.deepEqual(presentation.map.screens[0].variantIds, ["variant-a", "variant-b"]);
});

test("aggregates mixed member changes as one changed router path", () => {
  const added = screen("screen-policy-added", "Account policies & terms — Added", "/mobbin/screens/1", ["variant-added"]);
  const updated = screen("screen-policy-updated", "Account policies & terms — Updated", "/mobbin/screens/2", ["variant-updated"]);
  const removed = screen("removed:build-1:screen:legacy", "Legacy", "/legacy", ["variant-removed"]);
  const sourceMap = mapWith([added, updated, removed]);
  const presentation = presentationModel.presentScreensByPath(sourceMap);
  const rawDiff = {
    baselineId: "build-1",
    map: sourceMap,
    index: indexMap(sourceMap),
    screens: new Map([
      [added.id, {
        status: "added",
        changeSummary: "Added policy details.",
        afterScreenshot: "added.png",
      }],
      [updated.id, {
        status: "modified",
        changeSummary: "Reorganized policy controls.",
        beforeScreenshot: "before.png",
        afterScreenshot: "after.png",
      }],
      [removed.id, {
        status: "removed",
        changeSummary: "Removed the legacy policy page.",
        beforeScreenshot: "removed.png",
      }],
    ]),
    counts: { added: 1, modified: 1, removed: 1, unchanged: 0 },
  };

  const presented = presentationModel.presentBuildDiff(rawDiff, presentation);
  assert.deepEqual(presented.counts, { added: 0, modified: 1, removed: 1, unchanged: 0,
    "needs-review": 0, "source-affected": 0, "not-compared": 0, unavailable: 0, variant: 0 });
  assert.equal(presented.screens.size, 2);
  assert.deepEqual(presented.screens.get(added.id), {
    status: "modified",
    changeSummary: "Reorganized policy controls.",
    beforeScreenshot: "before.png",
    afterScreenshot: "after.png",
    reviewerChanges: [],
    runtimeEvidenceRefs: [],
    noVisibleChange: false,
  });
});

test("route-family counts retain uncertainty and never turn uncaptured members into verified unchanged", () => {
  const cases = [
    { members: ["unchanged", "not-compared"], expected: "not-compared" },
    { members: ["unchanged", "source-affected"], expected: "source-affected" },
    { members: ["modified", "needs-review"], expected: "needs-review" },
    { members: ["source-affected", "needs-review"], expected: "needs-review" },
    { members: ["not-compared", "not-compared"], expected: "not-compared" },
    // A runtime-state variant is not a change, yet a family must not hide it behind unchanged members.
    { members: ["unchanged", "variant"], expected: "variant" },
    { members: ["variant", "modified"], expected: "modified" },
  ];
  for (const { members, expected } of cases) {
    const source = mapWith(members.map((status, index) => screen(
      `member-${index}`, `Home — ${index}`, "/home", [`variant-${index}`],
    )));
    const presentation = presentationModel.presentScreensByPath(source);
    const projected = presentationModel.presentBuildDiff({
      baselineId: "base", map: source, index: indexMap(source), counts: {},
      screens: new Map(source.screens.map((entry, index) => [entry.id, {
        status: members[index], changeSummary: members[index],
      }])),
    }, presentation);
    assert.equal(projected.screens.get("member-0").status, expected, members.join(" + "));
    assert.deepEqual(projected.counts, {
      added: 0, modified: 0, removed: 0, unchanged: 0,
      "needs-review": 0, "source-affected": 0, "not-compared": 0, unavailable: 0, variant: 0, [expected]: 1,
    });
  }
});

test("a redirect keeps the route its borrowed screenshots belong to", () => {
  const home = screen("screen-redirect", "Select photo", "/mobbin/screens/9", ["variant-current"]);
  const sourceMap = mapWith([home]);
  const presentation = presentationModel.presentScreensByPath(sourceMap);
  const presented = presentationModel.presentBuildDiff({
    baselineId: "build-1",
    map: sourceMap,
    index: indexMap(sourceMap),
    screens: new Map([[home.id, {
      status: "source-affected",
      changeSummary: "Source impact was recorded.",
      beforeScreenshot: "before.png",
      afterScreenshot: "after.png",
      redirectTo: "/scan/take-photo",
      redirectTargets: ["/scan/take-photo"],
    }]]),
    counts: { added: 0, modified: 0, removed: 0, unchanged: 0 },
  }, presentation);
  const diff = presented.screens.get(home.id);
  assert.equal(diff.redirectTo, "/scan/take-photo");
  assert.deepEqual(diff.redirectTargets, ["/scan/take-photo"]);
});

test("joins summaries in visual before-to-after order when a family has no paired diff", () => {
  const current = screen("screen-home", "Home — Current", "/mobbin/screens/2", ["variant-current"]);
  const removed = screen(
    "removed:build-1:screen:home",
    "Home — Legacy",
    "/mobbin/screens/1",
    ["variant-removed"],
  );
  // Current is deliberately first so member order cannot accidentally determine summary order.
  const sourceMap = mapWith([current, removed]);
  const presentation = presentationModel.presentScreensByPath(sourceMap);
  const rawDiff = {
    baselineId: "build-1",
    map: sourceMap,
    index: indexMap(sourceMap),
    screens: new Map([
      [current.id, {
        status: "added",
        changeSummary: "Added the current home state.",
        afterScreenshot: "after.png",
      }],
      [removed.id, {
        status: "removed",
        changeSummary: "Removed the legacy home state.",
        beforeScreenshot: "before.png",
      }],
    ]),
    counts: { added: 1, modified: 0, removed: 1, unchanged: 0 },
  };

  const presented = presentationModel.presentBuildDiff(rawDiff, presentation);
  assert.deepEqual(presented.screens.get(current.id), {
    status: "modified",
    changeSummary: "Removed the legacy home state. Added the current home state.",
    beforeScreenshot: "before.png",
    afterScreenshot: "after.png",
    reviewerChanges: [],
    runtimeEvidenceRefs: [],
    noVisibleChange: false,
  });

  rawDiff.screens.get(current.id).changeSummary = "Home state changed.";
  rawDiff.screens.get(removed.id).changeSummary = "Home state changed.";
  const deduplicated = presentationModel.presentBuildDiff(rawDiff, presentation);
  assert.equal(deduplicated.screens.get(current.id)?.changeSummary, "Home state changed.");
});

test("keeps source provenance while reducing the viewer to route-level screens", () => {
  const source = captureAliasFixture();
  const presentation = presentationModel.presentScreensByPath(source);

  assert.equal(source.screens.length, 4);
  assert.equal(source.variants.length, 5);
  assert.equal(presentation.map.screens.length, 3);
  assert.equal(presentation.map.variants.length, 5);
  const referencedVariantIds = new Set(
    presentation.map.screens.flatMap((screen) => screen.variantIds),
  );
  const referencedObservationIds = new Set(
    presentation.map.screens.flatMap((screen) => screen.observationIds),
  );
  assert.equal(
    presentation.map.variants.every((variant) => (
      referencedVariantIds.has(variant.id)
      && presentation.index.screens.get(variant.screenId)?.variantIds.includes(variant.id)
    )),
    true,
  );
  assert.equal(
    presentation.map.observations.every((observation) => (
      referencedObservationIds.has(observation.id)
      && presentation.index.screens.get(observation.screenId)?.observationIds.includes(observation.id)
    )),
    true,
  );
  assert.equal(source.actionAttempts[0].outcome, "transition");
  assert.equal(presentation.map.actionAttempts[0].outcome, "same-screen");
  assert.equal(presentation.map.actionAttempts[1].sourceScreenId, "home");
  assert.equal(presentation.map.transitions[1].fromScreenId, "home");
  assert.equal(presentation.map.transitions[1].toScreenId, "profile");
  assert.equal(
    presentation.map.actionAttempts.some((attempt) => (
      attempt.outcome === "transition"
      && attempt.targetScreenId === attempt.sourceScreenId
    )),
    false,
  );
});
