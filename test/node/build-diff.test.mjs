import assert from "node:assert/strict";
import test from "node:test";

import { createBuildWorkspaceFixture } from "../helpers/build-workspace-fixture.mjs";

const { tsImport } = await import("tsx/esm/api");
const diffModel = await tsImport("../../viewer/src/utils/build-diff.ts", import.meta.url);
const { removedScreenId } = await tsImport("../../src/contracts/comparison-projection.ts", import.meta.url);

test("reviewed build diff preserves exact cross-build evidence and split/merge status", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const currentBuild = fixture.catalog.builds.find((build) => build.id === "build-2.0.0");
  const baselineBuild = fixture.catalog.builds.find((build) => build.id === "build-1.0.0");
  assert.ok(currentBuild);
  assert.ok(baselineBuild);
  const updatedEntry = fixture.comparison.entries.find((entry) => entry.id === "updated-profile");
  assert.ok(updatedEntry);
  updatedEntry.changeSummary = "The profile layout now emphasizes account controls.";
  for (const id of ["removed-legacy", "added-card", "split-settings"]) {
    const legacyEntry = fixture.comparison.entries.find((entry) => entry.id === id);
    assert.ok(legacyEntry);
    delete legacyEntry.changeSummary;
  }

  const diff = diffModel.buildDiff({
    currentBuild,
    currentMap: fixture.currentMap,
    baselineBuild,
    baselineMap: fixture.baselineMap,
    comparison: fixture.comparison,
  });

  assert.deepEqual(diff.counts, { added: 1, modified: 4, removed: 1, unchanged: 1, "needs-review": 0, "source-affected": 0, "not-compared": 0, unavailable: 0, variant: 0 });
  assert.equal(diff.map.screens.length, fixture.currentMap.screens.length + 1);
  assert.equal(diff.screens.get("shared-home")?.status, "unchanged");
  assert.equal(diff.screens.get("current-profile")?.status, "modified");
  assert.equal(diff.screens.get("current-added")?.status, "added");
  assert.equal(diff.screens.get("current-split-a")?.status, "modified");
  assert.equal(diff.screens.get("current-split-b")?.status, "modified");
  assert.equal(diff.screens.get("current-merged")?.status, "modified");

  // The reviewed secondary observation, not the screen's primary/latest fallback,
  // supplies the current side of this comparison.
  const updated = diff.screens.get("current-profile");
  assert.equal(updated?.changeSummary, updatedEntry.changeSummary);
  assert.notEqual(updated?.changeSummary, updatedEntry.rationale);
  assert.match(
    updated?.beforeScreenshot,
    /^\/api\/builds\/build-1\.0\.0\/artifacts\/artifacts\/screenshots\/baseline-profile-primary\.svg\?sha256=[a-f0-9]{64}$/,
  );
  assert.match(
    updated?.afterScreenshot,
    /^\/api\/builds\/build-2\.0\.0\/artifacts\/artifacts\/screenshots\/current-profile-reviewed\.svg\?sha256=[a-f0-9]{64}$/,
  );

  // Both builds intentionally use this relative path. Build qualification is what keeps
  // visually distinct evidence from colliding or borrowing across maps.
  const unchanged = diff.screens.get("shared-home");
  assert.equal(unchanged?.changeSummary, "“shared home” is unchanged.");
  assert.match(
    unchanged?.beforeScreenshot,
    /^\/api\/builds\/build-1\.0\.0\/artifacts\/artifacts\/screenshots\/shared-screen\.svg\?sha256=[a-f0-9]{64}$/,
  );
  assert.match(
    unchanged?.afterScreenshot,
    /^\/api\/builds\/build-2\.0\.0\/artifacts\/artifacts\/screenshots\/shared-screen\.svg\?sha256=[a-f0-9]{64}$/,
  );
  assert.notEqual(unchanged?.beforeScreenshot, unchanged?.afterScreenshot);

  const removedId = removedScreenId("build-1.0.0", "baseline-legacy");
  const removed = diff.screens.get(removedId);
  assert.equal(removed?.status, "removed");
  assert.equal(removed?.changeSummary, "Removed “baseline legacy”.");
  assert.match(
    removed?.beforeScreenshot,
    /^\/api\/builds\/build-1\.0\.0\/artifacts\/artifacts\/screenshots\/baseline-legacy-primary\.svg\?sha256=[a-f0-9]{64}$/,
  );
  assert.equal(removed?.afterScreenshot, undefined);
  assert.ok(diff.index.screens.has(removedId));
  assert.equal(diff.index.screens.has("baseline-split"), false);
  assert.equal(diff.index.screens.has("baseline-merge-a"), false);
  assert.equal(diff.index.screens.has("baseline-merge-b"), false);

  const added = diff.screens.get("current-added");
  assert.equal(added?.beforeScreenshot, undefined);
  assert.equal(added?.changeSummary, "Added “current added”.");
  assert.match(
    added?.afterScreenshot,
    /^\/api\/builds\/build-2\.0\.0\/artifacts\/artifacts\/screenshots\/current-added-primary\.svg\?sha256=[a-f0-9]{64}$/,
  );
  assert.equal(
    diff.screens.get("current-split-a")?.changeSummary,
    "Changed “baseline split” to “current split a”.",
  );
});

test("catalog route context contains only the two real builds", async () => {
  const fixture = await createBuildWorkspaceFixture();
  assert.deepEqual(diffModel.routeContextForCatalog(fixture.catalog), {
    defaultBaseline: "build-1.0.0",
    baselines: ["build-1.0.0"],
  });

  const catalogWithUnrelatedEntries = {
    ...fixture.catalog,
    builds: [
      ...fixture.catalog.builds,
      { id: "placeholder-update", kind: "build", version: "EAS Update", mapDir: "unused" },
      { id: "placeholder-pr", kind: "build", version: "PR 482", mapDir: "unused" },
    ],
  };
  assert.deepEqual(diffModel.routeContextForCatalog(catalogWithUnrelatedEntries), {
    defaultBaseline: "build-1.0.0",
    baselines: ["build-1.0.0"],
  });
});

test("baseline gaps survive the diff projection and cannot certify an unreviewed screen as unchanged", async () => {
  const fixture = await createBuildWorkspaceFixture();
  const currentBuild = fixture.catalog.builds.find(build => build.id === "build-2.0.0");
  const baselineBuild = fixture.catalog.builds.find(build => build.id === "build-1.0.0");
  const removed = fixture.baselineMap.screens.find(screen => screen.id === "baseline-legacy");
  const removedObservation = fixture.baselineMap.observations.find(observation => observation.screenId === removed.id);
  fixture.baselineMap.gaps.push({ id: "unverified-legacy", kind: "coverage", status: "open", screenId: removed.id,
    observationId: removedObservation.id, message: "Captured; destination unverified", createdAt: "2026-08-25T09:00:00.000Z" });
  const entry = fixture.comparison.entries.find(entry => entry.id === "updated-profile");
  entry.status = "source-affected";
  const diff = diffModel.buildDiff({ currentBuild, baselineBuild, currentMap: fixture.currentMap,
    baselineMap: fixture.baselineMap, comparison: fixture.comparison,
    review: { surfaces: { "current-profile": { reviewerChanges: [], runtimeEvidenceRefs: [], noVisibleChange: true } }, runtimeEvidence: {} },
  });
  const removedId = removedScreenId(baselineBuild.id, removed.id);
  const gap = diff.map.gaps.find(gap => gap.screenId === removedId);
  assert.ok(gap);
  assert.equal(gap.status, "open");
  assert.match(gap.message, /^Baseline: Captured; destination unverified$/);
  assert.ok(diff.index.observations.has(gap.observationId), "baseline gap observations use their imported namespace");
  assert.equal(diff.map.run.status, "partial");
  assert.equal(diff.screens.get(removedId).status, "removed");
  assert.equal(diff.screens.get("current-profile").status, "source-affected");
  assert.equal(diff.screens.get("current-profile").noVisibleChange, false);
});

test("baseline-only namespacing refuses collisions with current evidence", async (t) => {
  const fixture = await createBuildWorkspaceFixture();
  const currentBuild = fixture.catalog.builds.find((build) => build.id === "build-2.0.0");
  const baselineBuild = fixture.catalog.builds.find((build) => build.id === "build-1.0.0");
  assert.ok(currentBuild);
  assert.ok(baselineBuild);
  const removedScreen = fixture.baselineMap.screens.find((screen) => screen.id === "baseline-legacy");
  assert.ok(removedScreen);
  const removedObservation = fixture.baselineMap.observations.find(
    (observation) => observation.screenId === removedScreen.id,
  );
  assert.ok(removedObservation);
  const removedArtifact = fixture.baselineMap.artifacts.find(
    (artifact) => artifact.id === removedObservation.screenshotArtifactId,
  );
  assert.ok(removedArtifact);

  const build = (currentMap) => diffModel.buildDiff({
    currentBuild,
    currentMap,
    baselineBuild,
    baselineMap: fixture.baselineMap,
    comparison: fixture.comparison,
  });
  const clone = () => structuredClone(fixture.currentMap);

  await t.test("screen id", () => {
    const currentMap = clone();
    currentMap.screens[0].id = removedScreenId(baselineBuild.id, removedScreen.id);
    assert.throws(() => build(currentMap), /Baseline-only screen id collides/);
  });

  await t.test("observation id", () => {
    const currentMap = clone();
    currentMap.observations[0].id = `removed:${baselineBuild.id}:observation:${removedObservation.id}`;
    assert.throws(() => build(currentMap), /Baseline-only observation id collides/);
  });

  await t.test("artifact id", () => {
    const currentMap = clone();
    currentMap.artifacts[0].id = `removed:${baselineBuild.id}:artifact:${removedArtifact.id}`;
    assert.throws(() => build(currentMap), /Baseline-only artifact id collides/);
  });
});
