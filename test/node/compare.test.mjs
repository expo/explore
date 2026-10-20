import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CompareError, generateComparison } from "../../dist/map/compare.js";
import { getCoverage } from "../../dist/map/store.js";
import { loadBuildWorkspace, validateComparisonDocument } from "../../dist/map/build-workspace.js";
import { createBuildWorkspaceFixture } from "../helpers/build-workspace-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");
const CAPTURED_AT = "2026-08-25T09:00:00.000Z";

/**
 * In-memory maps for the matcher matrix. Artifacts exist only as map records, which
 * is all validateComparisonDocument inspects; the CLI end-to-end case below uses the
 * on-disk workspace fixture for full artifact validation.
 */
function makeMap(buildId, screens, { version = "sha-" + buildId } = {}) {
  const artifacts = [];
  const observations = [];
  const variants = [];
  const screenRecords = [];
  for (const [position, input] of screens.entries()) {
    const captures = input.captures ?? [{ suffix: "primary", acc: input.acc }];
    const observationIds = [];
    for (const capture of captures) {
      const observationId = `observation-${buildId}-${input.id}-${capture.suffix}`;
      const variantId = `variant-${observationId}`;
      const artifactId = `artifact-${observationId}`;
      artifacts.push({
        id: artifactId,
        kind: "screenshot",
        path: `artifacts/screenshots/${input.id}-${capture.suffix}.png`,
        sha256: "0".repeat(64),
        bytes: 1,
        mimeType: "image/png",
        createdAt: CAPTURED_AT,
      });
      variants.push({
        id: variantId,
        screenId: input.id,
        key: observationId,
        firstSeenAt: CAPTURED_AT,
        lastSeenAt: CAPTURED_AT,
        observationIds: [observationId],
      });
      observations.push({
        id: observationId,
        screenId: input.id,
        variantId,
        fingerprints: {
          combined: `combined-${observationId}`,
          ...(capture.acc ? { accessibility: capture.acc } : {}),
          visual: `visual-${observationId}`,
        },
        capturedAt: CAPTURED_AT,
        surfaceScope: "app",
        elementIds: [],
        elements: [],
        ...(input.screenshot === false ? {} : { screenshotArtifactId: artifactId }),
      });
      observationIds.push(observationId);
    }
    screenRecords.push({
      id: input.id,
      title: input.title ?? input.id.replaceAll("-", " "),
      ...(input.route ? { route: input.route } : {}),
      start: position === 0,
      terminal: false,
      depth: position,
      firstSeenAt: CAPTURED_AT,
      lastSeenAt: CAPTURED_AT,
      visits: 1,
      variantIds: observationIds.map((id) => `variant-${id}`),
      observationIds,
      elementIds: [],
    });
  }
  return {
    contract: "expo.explore.local-map.v1",
    revision: 5,
    run: {
      id: `run-${buildId}`,
      name: `Compare fixture ${buildId}`,
      platform: "ios",
      controller: "agent-device",
      status: "complete",
      createdAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT,
      build: { id: buildId, version, source: "local" },
      environment: { orientation: "portrait", colorScheme: "light" },
      limits: { maxScreens: 20, maxActions: 20, maxDurationMinutes: 5 },
    },
    artifacts,
    screens: screenRecords,
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

function entryById(comparison, id) {
  const entry = comparison.entries.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing entry ${id}: ${comparison.entries.map((e) => e.id).join(", ")}`);
  return entry;
}

test("matches screens by route, then id, then accessibility, then unique title", async () => {
  const baseline = makeMap("main-1111111", [
    { id: "home", route: "/", acc: "acc-home-v1" },
    { id: "settings-legacy", route: "/settings", acc: "acc-settings" },
    { id: "profile", acc: "acc-profile" },
    { id: "misc-a", title: "Payment methods", acc: "acc-pay-v1" },
    { id: "gone", title: "Legacy screen", acc: "acc-gone" },
  ]);
  const current = makeMap("pr-42-2222222", [
    { id: "home", route: "/", acc: "acc-home-v2" },
    { id: "settings", route: "/settings", acc: "acc-settings" },
    { id: "profile", acc: "acc-profile-v2" },
    { id: "misc-b", title: "Payment methods", acc: "acc-pay-v2" },
    { id: "fresh", title: "Brand new screen", acc: "acc-fresh" },
  ]);
  const { comparison, review, summary } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);

  const home = entryById(comparison, "match-home");
  assert.deepEqual(home.baselineScreenIds, ["home"]);
  assert.equal(home.status, "modified");
  assert.equal(home.confidence, 0.95);

  const settings = entryById(comparison, "match-settings");
  assert.deepEqual(settings.baselineScreenIds, ["settings-legacy"]);
  assert.equal(settings.status, "unchanged");

  const profile = entryById(comparison, "match-profile");
  assert.equal(profile.status, "modified");
  assert.equal(profile.confidence, 0.85);

  const pay = entryById(comparison, "match-misc-b");
  assert.deepEqual(pay.baselineScreenIds, ["misc-a"]);
  assert.equal(pay.confidence, 0.65);
  const payReview = review.entries.find((entry) => entry.entryId === "match-misc-b");
  assert.equal(payReview.needsReview, true);
  assert.deepEqual(payReview.matchedBy, ["title"]);

  entryById(comparison, "removed-gone");
  entryById(comparison, "added-fresh");
  assert.deepEqual(summary, {
    entries: 6,
    added: 1,
    removed: 1,
    modified: 3,
    unchanged: 1,
    needsReview: 1,
  });
});

test("matching representative accessibility fingerprints mark a route match unchanged", async () => {
  const baseline = makeMap("main-aaaaaaa", [
    { id: "home", route: "/", acc: "same-tree" },
  ]);
  const current = makeMap("pr-1-bbbbbbb", [
    {
      id: "home",
      route: "/",
      captures: [
        { suffix: "primary", acc: "same-tree" },
        { suffix: "revisit", acc: "other-tree" },
      ],
    },
  ]);
  const { comparison } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);
  assert.equal(entryById(comparison, "match-home").status, "unchanged");
});

test("unmatched screens with plausible counterparts carry review candidates", () => {
  const baseline = makeMap("main-ccccccc", [
    { id: "home", route: "/", acc: "acc-home" },
    { id: "plans", route: "/plans", title: "Plans", acc: "acc-plans" },
  ]);
  const current = makeMap("pr-2-ddddddd", [
    { id: "home", route: "/", acc: "acc-home" },
    { id: "plans-monthly", route: "/plans/monthly", title: "Plans monthly", acc: "acc-a" },
    { id: "plans-yearly", route: "/plans/yearly", title: "Plans yearly", acc: "acc-b" },
  ]);
  const { review } = generateComparison(baseline, current);
  const removedPlans = review.entries.find((entry) => entry.entryId === "removed-plans");
  assert.equal(removedPlans.needsReview, true);
  const candidateIds = (removedPlans.candidates ?? []).map((candidate) => candidate.screenId);
  assert.deepEqual(candidateIds.sort(), ["plans-monthly", "plans-yearly"]);
});

test("a claimed duplicate no longer blocks the remaining unambiguous title match", async () => {
  const baseline = makeMap("main-t111111", [
    { id: "x", route: "/a", title: "T", acc: "ax" },
    { id: "y", title: "T", acc: "ay" },
  ]);
  const current = makeMap("pr-7-t222222", [
    { id: "w", route: "/a", title: "T", acc: "aw" },
    { id: "z", title: "T", acc: "az" },
  ]);
  const { comparison, summary } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);
  assert.deepEqual(entryById(comparison, "match-w").baselineScreenIds, ["x"]);
  assert.deepEqual(entryById(comparison, "match-z").baselineScreenIds, ["y"]);
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 0);
});

test("a shared variant fingerprint does not hide a changed primary capture", async () => {
  const baseline = makeMap("main-v111111", [
    {
      id: "home",
      route: "/",
      captures: [
        { suffix: "primary", acc: "main-v1" },
        { suffix: "skeleton", acc: "shared-skeleton" },
      ],
    },
  ]);
  const current = makeMap("pr-5-v222222", [
    {
      id: "home",
      route: "/",
      captures: [
        { suffix: "primary", acc: "main-v2" },
        { suffix: "skeleton", acc: "shared-skeleton" },
      ],
    },
  ]);
  const { comparison } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);
  assert.equal(entryById(comparison, "match-home").status, "modified");
});

test("missing accessibility fingerprints report updated with a review flag, not a changed-tree claim", async () => {
  const baseline = makeMap("main-u111111", [{ id: "home", route: "/" }]);
  const current = makeMap("pr-6-u222222", [{ id: "home", route: "/" }]);
  const { comparison, review } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);
  const entry = entryById(comparison, "match-home");
  assert.equal(entry.status, "modified");
  assert.match(entry.rationale, /could not be verified/);
  const reviewEntry = review.entries.find((candidate) => candidate.entryId === "match-home");
  assert.equal(reviewEntry.needsReview, true);
});

test("a terminal run's duration limit uses its recorded lifetime, not file age", () => {
  const map = makeMap("main-d111111", [{ id: "home", route: "/" }]);
  map.run.limits.maxDurationMinutes = 5;
  assert.equal(getCoverage(map).limitReached, undefined);
  map.run.status = "exploring";
  assert.equal(getCoverage(map).limitReached, "duration");
});

test("route duplicated on one side falls through to id matching", async () => {
  const baseline = makeMap("main-eeeeeee", [
    { id: "sheet", route: "/items", acc: "acc-sheet" },
    { id: "items", route: "/items", acc: "acc-items" },
  ]);
  const current = makeMap("pr-3-fffffff", [
    { id: "items", route: "/items", acc: "acc-items-v2" },
    { id: "sheet", route: "/items", acc: "acc-sheet" },
  ]);
  const { comparison } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);
  assert.deepEqual(entryById(comparison, "match-items").baselineScreenIds, ["items"]);
  assert.deepEqual(entryById(comparison, "match-sheet").baselineScreenIds, ["sheet"]);
});

test("refuses maps without build ids, identical build ids, and screens without screenshots", () => {
  const noBuild = makeMap("main-2222222", [{ id: "home", route: "/" }]);
  delete noBuild.run.build.id;
  assert.throws(
    () => generateComparison(noBuild, makeMap("pr-9-3333333", [{ id: "home" }])),
    CompareError,
  );
  assert.throws(
    () => generateComparison(
      makeMap("same-id", [{ id: "home" }]),
      makeMap("same-id", [{ id: "home" }]),
    ),
    /same run\.build\.id/,
  );
  const noShot = makeMap("main-4444444", [{ id: "home", screenshot: false }]);
  assert.throws(
    () => generateComparison(noShot, makeMap("pr-8-5555555", [{ id: "home" }])),
    /no observation with a screenshot/,
  );
});

test("compare CLI emits a comparison, review, and catalog that reload as a workspace", async () => {
  const fixture = await createBuildWorkspaceFixture();
  // The catalog loader refuses mapDir paths that escape the catalog directory,
  // so generated outputs live in the workspace root next to the map bundles.
  const out = fixture.root;
  const result = spawnSync(process.execPath, [
    cli,
    "compare",
    "--baseline", join(fixture.root, "baseline"),
    "--current", join(fixture.root, "current"),
    "--output", join(out, "auto-comparison.json"),
    "--review-output", join(out, "auto-review.json"),
    "--catalog-output", join(out, "auto-builds.json"),
    "--catalog-name", "Compare fixture",
    "--json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.baselineBuildId, "build-1.0.0");
  assert.equal(payload.currentBuildId, "build-2.0.0");
  assert.equal(
    payload.summary.entries,
    payload.summary.added + payload.summary.removed
      + payload.summary.modified + payload.summary.unchanged,
  );

  const workspace = await loadBuildWorkspace(join(out, "auto-builds.json"));
  assert.deepEqual([...workspace.builds.keys()].sort(), ["build-1.0.0", "build-2.0.0"]);
  const shared = workspace.comparison.entries.find((entry) => (
    entry.currentScreenIds.includes("shared-home")
  ));
  assert.deepEqual(shared.baselineScreenIds, ["shared-home"]);
});

test("fingerprints from different Explore versions are not comparable: the match needs review instead of reading as changed", async () => {
  // A map saved by Explore 0.20.x hashes the tree with the keyboard and the focus in it, unprefixed; a2 hashes leave them out.
  const baseline = makeMap("main-eeeeeee", [{ id: "home", route: "/", acc: "0".repeat(64) }]);
  const current = makeMap("pr-3-fffffff", [{ id: "home", route: "/", acc: `a2:${"1".repeat(64)}` }]);
  const { comparison, review } = generateComparison(baseline, current);
  await validateComparisonDocument(comparison, baseline, current);
  const home = review.entries.find((entry) => entry.entryId === "match-home");
  assert.equal(home.needsReview, true);
  assert.match(entryById(comparison, "match-home").rationale, /different Explore versions/);
  assert.ok(home.notes.some((note) => /compare the screenshots/.test(note)));
});
