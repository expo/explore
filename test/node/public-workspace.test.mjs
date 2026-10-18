import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { publicReviewToWorkspace, publicReviewProjection } = await tsImport(
  "../../viewer/src/public/public-workspace.ts", import.meta.url,
);
const { buildDiff } = await tsImport("../../viewer/src/utils/build-diff.ts", import.meta.url);
const { removedScreenId } = await tsImport("../../src/contracts/comparison-projection.ts", import.meta.url);
const { presentScreensByPath, presentBuildDiff } = await tsImport(
  "../../viewer/src/utils/screen-presentation.ts", import.meta.url,
);
const { artifactUrl, indexMap } = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);
const { primaryScreenshotForScreen } = await tsImport("../../viewer/src/utils/screen-images.ts", import.meta.url);
const { buildObservedGraph, buildViewerGraph, projectFullGraph } = await tsImport("../../viewer/src/utils/graph-model.ts", import.meta.url);

function entry(id, route, variant = "default", extra = {}) {
  return {
    id, route, routeFile: `src/app/${id}.tsx`, sourceFiles: [],
    provider: "expo-router", logicalPath: route, path: route,
    variant, kind: "screen", ...extra,
  };
}

function fixture(mode = "all") {
  const review = {
    contract: "explore.review",
    pullRequest: {
      repositoryId: "123", repository: "expo/example", number: 8,
      title: "Update games and add care guide", url: "https://github.com/expo/example/pull/8",
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "feature/care", sha: "b".repeat(40) },
    },
    mode, createdAt: "2026-09-08T12:00:00.000Z", runId: "5678", runAttempt: "2",
    runtime: { projectId: "eas-project", buildId: "eas-head", gitCommit: "b".repeat(40) },
    surfaces: [
      { id: "games-free", status: "modified", base: entry("games-free", "/games", "free"), head: entry("games-free", "/games", "free") },
      { id: "games-pro", status: "unchanged", base: entry("games-pro", "/games", "pro"), head: entry("games-pro", "/games", "pro") },
      { id: "care-guide", status: "added", base: null, head: entry("care-guide", "/cats/care-guide") },
      { id: "sweet-bee", status: "removed", base: entry("sweet-bee", "/games/sweet-bee"), head: null },
      { id: "scan-mood", status: "unchanged", base: entry("scan-mood", "/scan/instruction?action=mood", "mood"), head: entry("scan-mood", "/scan/instruction?action=mood", "mood") },
      { id: "scan-breed", status: "unchanged", base: entry("scan-breed", "/scan/instruction?action=breed", "breed"), head: entry("scan-breed", "/scan/instruction?action=breed", "breed") },
      { id: "home", status: "unchanged", base: entry("home", "/", "fresh", { kind: "redirect", redirectTo: "/games" }), head: entry("home", "/", "fresh", { kind: "redirect", redirectTo: "/games" }) },
      { id: "camera-alias", status: "unchanged", base: entry("camera-alias", "/scan/camera?action=mood", "mood", { kind: "screen" }), head: entry("camera-alias", "/scan/camera?action=mood", "mood", { kind: "screen" }) },
    ],
  };
  for (const surface of review.surfaces) {
    for (const side of ["base", "head"]) {
      if (!surface[side] || surface[side].kind === "redirect"
        || (mode === "changes" && surface.status === "unchanged")) continue;
      surface[`${side}Image`] = {
        url: `https://evidence-test-123.convex.cloud/api/storage/${side}5678000000000000000000000${surface.id}`,
        // Updated surfaces deliberately have identical hashes; unchanged surfaces differ.
        sha256: (surface.status === "modified" ? "c" : side === "base" ? "d" : "e").repeat(64),
        width: 402, height: 874,
        capturedAt: side === "base" ? "2026-09-08T10:00:00.000Z" : "2026-09-08T11:00:00.000Z",
        sourceCommit: review.pullRequest[side].sha, buildId: `eas-${side}`,
      };
    }
  }
  return review;
}

function verifyImages(review) {
  for (const surface of review.surfaces) for (const side of ["base", "head"]) {
    if (surface[`${side}Image`]) surface[`${side}Outcome`] = { status: "captured", attempts: 1, landing: "verified" };
  }
  return review;
}

function workspaceSides(workspace) {
  return {
    baseline: workspace.builds[workspace.catalog.defaultBaselineBuildId],
    current: workspace.builds[workspace.catalog.currentBuildId],
  };
}

function diffFor(review) {
  const workspace = publicReviewToWorkspace(review);
  const { baseline, current } = workspaceSides(workspace);
  return buildDiff({
    currentBuild: workspace.catalog.builds.find((build) => build.id === workspace.catalog.currentBuildId),
    baselineBuild: workspace.catalog.builds.find((build) => build.id === workspace.catalog.defaultBaselineBuildId),
    currentMap: current.map, baselineMap: baseline.map,
    comparison: workspace.comparison, review: publicReviewProjection(review),
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function navigationReview() {
  const review = fixture();
  review.mode = "changes";
  review.surfaces = review.surfaces.filter(surface => surface.base && surface.head);
  for (const surface of review.surfaces) {
    surface.status = surface.id === "games-free" ? "modified" : "unchanged";
    if (surface.id.startsWith("scan-")) for (const side of ["base", "head"]) {
      surface[side].routeFile = "src/app/scan/instruction.tsx";
    }
  }
  const edge = (from, to, kind = "push") => ({ from, to, kind, sourceFile: "src/screens/navigation.tsx", provenance: "source" });
  const graph = {
    contract: "explore.navigation",
    edges: [edge("home", "games-free", "redirect"), edge("home", "games-pro"), edge("games-free", "scan-mood"), edge("scan-mood", "games-free")],
    modalSurfaceIds: ["scan-mood", "scan-breed"], unresolved: [],
  };
  review.navigation = { base: structuredClone(graph), head: structuredClone(graph) };
  return review;
}

test("source navigation projects directional context and route variants without inventing observed evidence", () => {
  const review = deepFreeze(navigationReview());
  const { baseline, current } = workspaceSides(publicReviewToWorkspace(review));
  for (const payload of [baseline, current]) {
    assert.deepEqual(payload.map.screens.map(screen => screen.id).sort(), ["camera-alias", "games-free", "games-pro", "home", "scan-breed", "scan-mood"]);
    assert.equal(payload.map.screens.some(screen => screen.id === "games-pro"), true, "routes outside the selected capture context remain in the inventory");
    assert.equal(payload.map.screens.find(screen => screen.id === "home").start, true);
    assert.equal(payload.map.screens.find(screen => screen.id === "games-free").depth, 1);
    assert.equal(payload.map.screens.find(screen => screen.id === "scan-mood").terminal, false, "cycles never manufacture an end");
    assert.equal(payload.coverage.transitions, 0);
    for (const collection of ["transitions", "actionAttempts", "journeys"]) assert.deepEqual(payload.map[collection], []);
    assert.equal(buildObservedGraph(payload.map, indexMap(payload.map)).groups.length, 0);
    const viewerGraph = buildViewerGraph(payload.map, indexMap(payload.map));
    assert.deepEqual(viewerGraph.screens.map(screen => screen.id).sort(), ["camera-alias", "games-free", "games-pro", "scan-breed", "scan-mood"]);
    assert.equal(viewerGraph.groups.length, 2);
    assert.ok(viewerGraph.groups.every(group => group.transitionIds.length === 0 && group.sourceEdges.length > 0));
    const presentation = presentScreensByPath(payload.map);
    const scan = presentation.map.screens.find(screen => screen.route === "/scan/instruction");
    assert.equal(scan.variantIds.length, 2);
    assert.ok(presentation.map.sourceNavigation.modalSurfaceIds.includes(scan.id));
    assert.ok(presentation.map.sourceNavigation.edges.every(edge => presentation.index.screens.has(edge.from) && presentation.index.screens.has(edge.to)));
  }
});

test("public map omits redirects and unselected changes routes while retaining selected failures", () => {
  const review = verifyImages(fixture("changes"));
  const current = workspaceSides(publicReviewToWorkspace(review)).current;
  const graph = buildViewerGraph(current.map, indexMap(current.map));
  assert.deepEqual(graph.screens.map(screen => screen.id).sort(), ["care-guide", "games-free"]);
  assert.equal(current.map.screens.length, 7, "the published source inventory remains available");

  const failed = navigationReview();
  delete failed.surfaces.find(surface => surface.id === "scan-mood").headImage;
  failed.surfaces.find(surface => surface.id === "scan-mood").headOutcome = {
    status: "failed", attempts: 1, landing: "unverified", reason: "Capture failed",
  };
  const failedMap = workspaceSides(publicReviewToWorkspace(failed)).current.map;
  const failedGraph = buildViewerGraph(failedMap, indexMap(failedMap));
  assert.equal(failedGraph.screens.some(screen => screen.id === "scan-mood"), true);
  assert.equal(failedGraph.screens.some(screen => screen.id === "home"), false);
});

test("all mode keeps the full source inventory even when no surfaces changed", () => {
  const review = navigationReview();
  review.mode = "all";
  review.surfaces.forEach(surface => { surface.status = "unchanged"; });
  for (const payload of Object.values(workspaceSides(publicReviewToWorkspace(review)))) {
    assert.equal(payload.map.screens.length, review.surfaces.length);
    assert.equal(payload.map.sourceNavigation.edges.length, 4);
  }
});

test("unresolved runtime destinations retain all capture context without definitive source end flags", () => {
  const review = navigationReview();
  review.navigation.head.unresolved = ["Unresolved navigation: dynamic destination in src/screens/navigation.tsx"];
  const { current } = workspaceSides(publicReviewToWorkspace(review));
  assert.equal(current.map.screens.length, review.surfaces.length);
  assert.ok(current.map.screens.every(screen => screen.terminal === false));
});

test("a missing selected context capture is a real gap in changes mode", () => {
  const review = navigationReview();
  delete review.surfaces.find(surface => surface.id === "scan-mood").headImage;
  const { current } = workspaceSides(publicReviewToWorkspace(review));
  assert.equal(current.map.gaps.find(gap => gap.screenId === "scan-mood").status, "open");
  assert.equal(current.map.run.status, "partial");
});

test("comparison retains prior-only navigation between the full surviving source inventory", () => {
  const review = navigationReview();
  review.navigation.head.edges = review.navigation.head.edges.filter(edge => !edge.from.startsWith("scan-") && !edge.to.startsWith("scan-"));
  publicReviewToWorkspace(review);
  const diff = diffFor(review);
  const previousScan = "scan-mood";
  assert.ok(diff.index.screens.has(previousScan));
  assert.equal(diff.screens.get(previousScan).status, "not-compared", "a surviving route outside current capture context was not deleted or visually compared");
  const captured = review.surfaces.find(surface => surface.id === "scan-mood").baseImage;
  assert.equal(artifactUrl(primaryScreenshotForScreen(diff.index.screens.get(previousScan), diff.index)), review.surfaces.find(surface => surface.id === "scan-mood").headImage.url);
  assert.equal(diff.screens.get(previousScan).beforeScreenshot, captured.url);
  assert.ok(diff.map.baselineSourceNavigation.edges.some(edge => edge.from === "games-free" && edge.to === previousScan));
  const graph = buildViewerGraph(diff.map, diff.index);
  assert.equal(graph.groups.filter(group => group.sourceRevision === "baseline").length, 2);
  assert.ok(graph.groups.every(group => group.transitionIds.length === 0));
  const projected = projectFullGraph(graph);
  assert.ok(projected.groups.some(group => group.sourceRevision === "baseline" && group.sourceEdges.length > 0));

  review.mode = "all";
  const fullDiff = diffFor(review);
  const fullGraph = buildViewerGraph(fullDiff.map, fullDiff.index);
  assert.ok(fullGraph.groups.some(group => group.sourceRevision === "baseline" && group.from === "games-free" && group.to === "scan-mood"));
  assert.ok(fullDiff.map.screens.every(screen => !screen.id.startsWith("baseline-context:")), "surviving current screens remain the shared endpoints");
});

test("public inventory preserves source classification while unverified images stay outside visual change verdicts", () => {
  const review = deepFreeze(fixture());
  const before = structuredClone(review);
  const workspace = publicReviewToWorkspace(review);
  const { baseline, current } = workspaceSides(workspace);
  assert.deepEqual(workspace.comparison.entries.map(({ id, status }) => ({ id, status })), [
    { id: "games-free", status: "not-compared" }, { id: "games-pro", status: "not-compared" },
    { id: "care-guide", status: "added" }, { id: "sweet-bee", status: "removed" },
    { id: "scan-mood", status: "not-compared" }, { id: "scan-breed", status: "not-compared" },
    { id: "home", status: "not-compared" }, { id: "camera-alias", status: "not-compared" },
  ]);
  assert.deepEqual(baseline.map.screens.map(({ id }) => id), review.surfaces.filter((surface) => surface.base).map(({ id }) => id));
  assert.deepEqual(current.map.screens.map(({ id }) => id), review.surfaces.filter((surface) => surface.head).map(({ id }) => id));
  assert.equal(baseline.map.screens.length, 7);
  assert.equal(current.map.screens.length, 7);
  assert.equal(baseline.map.screens.some((screen) => screen.id === "care-guide"), false);
  assert.equal(current.map.screens.some((screen) => screen.id === "sweet-bee"), false);
  for (const payload of [baseline, current]) {
    assert.equal(payload.coverage.screens, 7);
    assert.equal(payload.coverage.observations, 6);
    for (const key of ["elements", "actionAttempts", "transitions", "journeys", "frontier"]) {
      assert.deepEqual(payload.map[key], [], `No invented ${key}`);
    }
    assert.ok(payload.map.screens.every((screen) => !screen.start && !screen.terminal));
  }
  const diff = diffFor(review);
  assert.equal(diff.screens.get("games-free").status, "not-compared", "Equal PNG hashes cannot prove verified destinations");
  assert.equal(diff.screens.get("games-pro").status, "not-compared", "Different PNG hashes cannot prove a route modification");
  assert.deepEqual(diff.counts, { added: 1, modified: 0, removed: 1, unchanged: 0, "needs-review": 0, "source-affected": 0, "not-compared": 6, unavailable: 0, variant: 0 });
  assert.equal(workspace.review, undefined, "The adapter must not fabricate semantic review evidence");
  assert.deepEqual(review, before, "The source publication remains immutable");
});

test("original image resolver and removed-screen projection retain exact public capture provenance", () => {
  const review = fixture();
  const workspace = publicReviewToWorkspace(review);
  const { baseline, current } = workspaceSides(workspace);
  for (const [side, payload] of [["base", baseline], ["head", current]]) {
    assert.equal(payload.map.run.build.id, `eas-${side}`);
    assert.equal(payload.map.run.build.gitCommit, review.pullRequest[side].sha);
    assert.deepEqual(payload.map.run.environment, {}, "Unknown device and environment data stays absent");
    for (const surface of review.surfaces) {
      const image = surface[`${side}Image`];
      if (!image) continue;
      const screen = payload.map.screens.find(({ id }) => id === surface.id);
      const observation = payload.map.observations.find(({ id }) => id === screen.observationIds[0]);
      const artifact = payload.map.artifacts.find(({ id }) => id === observation.screenshotArtifactId);
      assert.equal(artifactUrl(artifact, payload.map.run.build.id), image.url);
      assert.equal(artifact.sha256, image.sha256);
      assert.equal(artifact.width, image.width);
      assert.equal(artifact.height, image.height);
      assert.equal(artifact.createdAt, image.capturedAt);
      assert.equal(observation.capturedAt, image.capturedAt);
      assert.equal(Object.hasOwn(artifact, "bytes"), false, "Publication does not include byte length");
    }
  }
  const diff = diffFor(review);
  const removedId = removedScreenId(workspace.catalog.defaultBaselineBuildId, "sweet-bee");
  const removed = diff.screens.get(removedId);
  assert.equal(removed.status, "removed");
  assert.equal(removed.beforeScreenshot, review.surfaces.find(({ id }) => id === "sweet-bee").baseImage.url);
  assert.equal(removed.afterScreenshot, undefined);
  assert.equal(artifactUrl(primaryScreenshotForScreen(diff.index.screens.get(removedId), diff.index)), removed.beforeScreenshot);
  assert.equal(diff.screens.get("care-guide").beforeScreenshot, undefined);
});

test("existing route-family presentation groups query variants without losing their source routes", () => {
  const review = fixture();
  const diff = diffFor(review);
  const presentation = presentScreensByPath(diff.map);
  const scan = presentation.map.screens.find((screen) => screen.route === "/scan/instruction");
  assert.ok(scan);
  assert.equal(scan.variantIds.length, 2);
  assert.equal(scan.observationIds.length, 2);
  assert.deepEqual(scan.variantIds.map((id) => presentation.index.variants.get(id).name), ["mood", "breed"]);
  const displayed = presentBuildDiff(diff, presentation);
  assert.deepEqual(displayed.counts, { added: 1, modified: 0, removed: 1, unchanged: 0, "needs-review": 0, "source-affected": 0, "not-compared": 4, unavailable: 0, variant: 0 });
  assert.equal(presentation.map.screens.length, 6);
  assert.equal(scan.title, "Scan — Instruction");
  const graph = buildObservedGraph(presentation.map, presentation.index);
  assert.equal(graph.groups.length, 0, "Route-area labels must not create navigation edges");
  const projection = publicReviewProjection(review);
  for (const id of ["scan-mood", "scan-breed"]) {
    const source = review.surfaces.find((surface) => surface.id === id);
    const evidence = projection.runtimeEvidence[`public:${id}`].current;
    assert.equal(evidence.groups.screen.find((row) => row.label === "Route").value, source.head.route);
    assert.equal(evidence.groups.screen.some((row) => row.label === "Fixture"), false, "source routes do not imply runtime fixtures");
    assert.equal(evidence.groups.environment.find((row) => row.label === "EAS build").value, source.headImage.buildId);
  }
  assert.deepEqual(projection.surfaces["games-free"].reviewerChanges, []);
  assert.equal(projection.surfaces["games-pro"].noVisibleChange, false);
  assert.equal(projection.runtimeEvidence["public:sweet-bee"].current, undefined);
  assert.equal(projection.runtimeEvidence["public:care-guide"].baseline, undefined);
});

test("changes mode keeps uncaptured inventory visible without borrowing another variant's image", () => {
  const review = verifyImages(fixture("changes"));
  const workspace = publicReviewToWorkspace(review);
  const { baseline, current } = workspaceSides(workspace);
  assert.equal(workspace.comparison.entries.length, 8);
  for (const payload of [baseline, current]) {
    assert.equal(payload.map.screens.length, 7);
    assert.equal(payload.map.observations.length, 2);
    assert.equal(payload.map.artifacts.length, 2);
    assert.equal(payload.coverage.gaps.accepted, 5);
    assert.equal(payload.coverage.gaps.open, 0);
    assert.equal(payload.map.run.status, "complete");
    const uncaptured = payload.map.screens.find(({ id }) => id === "games-pro");
    assert.deepEqual(uncaptured.observationIds, []);
    assert.equal(primaryScreenshotForScreen(uncaptured, indexMap(payload.map)), undefined);
  }
  const diff = diffFor(review);
  assert.equal(diff.screens.get("games-pro").status, "not-compared");
  assert.equal(diff.screens.get("games-pro").beforeScreenshot, undefined);
  assert.equal(diff.screens.get("games-pro").afterScreenshot, undefined);
  const projection = publicReviewProjection(review);
  const omitted = projection.runtimeEvidence["public:games-pro"].current;
  assert.equal(omitted.observationId, undefined);
  assert.equal(omitted.groups.capture.find((row) => row.label === "Capture").value, "Not selected in changes mode");
  const redirect = projection.runtimeEvidence["public:home"].current;
  assert.equal(redirect.groups.capture.find((row) => row.label === "Capture").value, "Redirect declaration; no screenshot selected");
});

test("a published report says why a screen was selected, and names added or removed routes", () => {
  const review = verifyImages(fixture());
  for (const surface of review.surfaces) delete surface.sourceChange;
  const selected = review.surfaces.find((entry) => entry.id === "games-free");
  selected.sourceImpact = ["imported", "shared"];
  const diff = diffFor(review);
  const summaries = new Map([...diff.screens].map(([id, entry]) => [id, entry.changeSummary]));
  // Git hunks stay in planning; the published categories still explain the selection.
  assert.equal(summaries.get("games-free"), "Something it imports changed. Shared app source changed.");
  assert.equal(summaries.get("care-guide"), "Added /cats/care-guide screen.");
  assert.equal([...summaries.values()].some((summary) => summary === "Removed /games/sweet-bee screen."), true,
    `expected a named removal, saw ${[...summaries.values()].join(" | ")}`);
});

test("a redirect shows the route it declares, and never guesses between several", () => {
  // Two screens answer /games in this fixture, so the single-destination rule must not pick one.
  const ambiguous = diffFor(verifyImages(fixture())).screens.get("home");
  assert.equal(ambiguous.beforeScreenshot, undefined);
  assert.equal(ambiguous.afterScreenshot, undefined);
  assert.equal(ambiguous.redirectTo, undefined);
  assert.deepEqual(ambiguous.redirectTargets, ["/games"]);

  // With one screen on that route, the redirect borrows its captures and says whose they are.
  const review = verifyImages(fixture());
  review.surfaces = review.surfaces.filter((surface) => surface.id !== "games-pro");
  const resolved = diffFor(review).screens.get("home");
  const destination = diffFor(review).screens.get("games-free");
  assert.equal(resolved.redirectTo, "/games");
  assert.equal(resolved.beforeScreenshot, destination.beforeScreenshot);
  assert.equal(resolved.afterScreenshot, destination.afterScreenshot);
  assert.deepEqual(resolved.redirectTargets, ["/games"]);

  // A branching declaration names every route it can reach and borrows nothing.
  const branching = verifyImages(fixture());
  branching.surfaces = branching.surfaces.filter((surface) => surface.id !== "games-pro");
  for (const side of ["base", "head"]) {
    branching.surfaces.find((surface) => surface.id === "home")[side] = {
      ...branching.surfaces.find((surface) => surface.id === "home")[side],
      redirectTo: undefined, redirectTargets: ["/games", "/scan/instruction?action=mood"],
    };
    delete branching.surfaces.find((surface) => surface.id === "home")[side].redirectTo;
  }
  const branched = diffFor(branching).screens.get("home");
  assert.equal(branched.beforeScreenshot, undefined);
  assert.deepEqual(branched.redirectTargets, ["/games", "/scan/instruction?action=mood"]);
});

test("a missing selected image remains an explicit gap without changing source classification", () => {
  const review = verifyImages(fixture());
  delete review.surfaces[0].headImage;
  review.surfaces[0].headOutcome = { status: "failed", attempts: 1, landing: "unverified" };
  const { current } = workspaceSides(publicReviewToWorkspace(review));
  assert.equal(current.map.run.status, "partial");
  assert.equal(current.coverage.completion.eligible, false);
  assert.equal(current.coverage.gaps.open, 1);
  const screen = current.map.screens.find(({ id }) => id === "games-free");
  assert.deepEqual(screen.observationIds, []);
  const diff = diffFor(review).screens.get("games-free");
  assert.equal(diff.status, "unavailable", "a failed capture is reported as unavailable, not as a visual verdict");
  assert.equal(diff.afterScreenshot, undefined);
  assert.equal(diff.beforeScreenshot, review.surfaces[0].baseImage.url);
});

test("changes-only reviews without baseline captures do not invent a baseline EAS build", () => {
  const review = fixture("changes");
  review.surfaces = review.surfaces.filter(({ status }) => status === "unchanged");
  const workspace = publicReviewToWorkspace(review);
  const { baseline, current } = workspaceSides(workspace);
  assert.equal(baseline.map.screens.length, 5);
  assert.equal(baseline.map.observations.length, 0);
  assert.equal(baseline.map.run.build.id, undefined);
  assert.equal(baseline.map.run.build.gitCommit, review.pullRequest.base.sha);
  assert.equal(current.map.run.build.id, review.runtime.buildId);
  assert.notEqual(workspace.catalog.defaultBaselineBuildId, workspace.catalog.currentBuildId);
});

/** The Viewer opens what the contract accepts: the offending part is omitted and named on the console, never rendered. */
function opensWithGap(t, review, error, omittedSurfaceId) {
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(String(message)));
  const workspace = publicReviewToWorkspace(review);
  const projection = publicReviewProjection(review);
  assert.ok(warnings.some(message => error.test(message) && /omitted/.test(message)), warnings.join("\n") || "no contract gap was reported");
  if (omittedSurfaceId !== undefined) {
    assert.ok(!Object.keys(projection.runtimeEvidence).some(key => key === `public:${omittedSurfaceId}`), `${omittedSurfaceId} is not rendered`);
  }
  return { workspace, projection };
}

test("source presence, capture provenance, and image URLs fail closed when inconsistent", async (t) => {
  const cases = [
    ["duplicate inventory", (review) => review.surfaces.push(review.surfaces[0]), /presence or status/],
    ["wrong added presence", (review) => { review.surfaces[0].status = "added"; }, /presence or status/],
    ["image for absent side", (review) => { review.surfaces[2].baseImage = review.surfaces[0].baseImage; }, /capture provenance/],
    ["source commit mismatch", (review) => { review.surfaces[0].headImage.sourceCommit = "f".repeat(40); }, /capture provenance/],
    ["head build mismatch", (review) => { for (const surface of review.surfaces) if (surface.headImage) surface.headImage.buildId = "other"; }, /build provenance/],
    ["redirect with invented capture", (review) => { review.surfaces[6].headImage = review.surfaces[0].headImage; }, /capture provenance/],
    ["non-HTTPS image", (review) => { review.surfaces[0].headImage.url = "file:///tmp/image.png"; }, /HTTPS/],
    ["credentialed image URL", (review) => { review.surfaces[0].headImage.url = "https://user:secret@example.com/image.png"; }, /HTTPS/],
  ];
  for (const [name, mutate, error] of cases) {
    await t.test(name, (tt) => {
      const review = fixture();
      mutate(review);
      if (name === "head build mismatch") {
        assert.throws(() => publicReviewToWorkspace(review), error);
        assert.throws(() => publicReviewProjection(review), error);
        return;
      }
      const offending = name === "image for absent side" ? review.surfaces[2].id : name === "redirect with invented capture" ? review.surfaces[6].id : review.surfaces[0].id;
      const { projection } = opensWithGap(tt, review, error, offending);
      assert.ok(Object.keys(projection.runtimeEvidence).length > 0, "the rest of the report renders");
    });
  }
});

test("What changed uses commit-bound Git summaries without changing screenshot identity or source status", (t) => {
  const review = fixture();
  const summary = {
    contract: "expo.explore.source-change-summary.v1",
    baseSha: review.pullRequest.base.sha, headSha: review.pullRequest.head.sha,
    impact: "dependency", summary: "Removed the sweet-bee entry from gamesCatalog. This route and its declared source files are unchanged; shared dependencies triggered recapture.",
    files: [], truncated: false,
  };
  review.surfaces[0].sourceChange = summary;
  const diff = diffFor(review).screens.get("games-free");
  assert.equal(diff.changeSummary, summary.summary);
  assert.equal(diff.status, "not-compared");
  assert.equal(diff.beforeScreenshot, review.surfaces[0].baseImage.url);
  assert.equal(diff.afterScreenshot, review.surfaces[0].headImage.url);
  assert.doesNotMatch(diff.changeSummary, /Visual changes have not been classified/);
  review.surfaces[0].sourceChange.headSha = "f".repeat(40);
  opensWithGap(t, review, /reviewed commits/, review.surfaces[0].id);
});

test("public headers use app metadata and support older immutable reviews", () => {
  const review = fixture();
  review.runtime.appName = "  My App  ";
  const workspace = publicReviewToWorkspace(review);
  assert.equal(workspace.catalog.name, "My App");
  assert.equal(workspaceSides(workspace).current.map.run.name, "My App");
  delete review.runtime.appName;
  review.runtime.projectId = "unknown-project";
  assert.equal(publicReviewToWorkspace(review).catalog.name, "App");
});

test("evidence-based review verdicts drive the comparison status, summary, and reviewer facts", (t) => {
  const review = fixture();
  const games = review.surfaces.find((surface) => surface.id === "games-free");
  const pro = review.surfaces.find((surface) => surface.id === "games-pro");
  const care = review.surfaces.find((surface) => surface.id === "care-guide");
  const bee = review.surfaces.find((surface) => surface.id === "sweet-bee");
  for (const surface of [games, pro]) for (const side of ["base", "head"]) surface[`${side}Outcome`] = { status: "captured", attempts: 1, landing: "verified" };
  // Source-affected but identical on both signals: no longer counted as updated.
  games.review = { status: "unchanged", description: "No visible change" };
  games.visual = { verdict: "unchanged", reason: "matched", mismatchPercentage: 0, threshold: 0.1, tool: "agent-device@0.20.2" };
  // Source-unaffected in this fixture but the run saw a difference: a legacy report reads it as a
  // runtime-state variant, because only a source change makes a screen a review target.
  pro.review = {
    status: "modified", description: "Changed button title from “Share” to “Share Example”.",
    facts: [{ category: "visible-text", templateId: "visible-text.changed", bullet: "Changed button title from “Share” to “Share Example”." }],
  };
  pro.visual = { verdict: "modified", reason: "repeated-cross-build-delta", mismatchPercentage: 3.2, threshold: 0.1, tool: "agent-device@0.20.2", regions: [] };
  care.review = { status: "added", description: "Added" };
  bee.review = { status: "removed", description: "Removed" };
  const workspace = publicReviewToWorkspace(review);
  const statuses = Object.fromEntries(workspace.comparison.entries.map(({ id, status }) => [id, status]));
  assert.equal(statuses["games-free"], "unchanged");
  assert.equal(statuses["games-pro"], "variant");
  assert.equal(statuses["care-guide"], "added");
  assert.equal(statuses["sweet-bee"], "removed");
  assert.equal(statuses["scan-mood"], "not-compared", "unverified captures without a verdict cannot prove no change");
  const proEntry = workspace.comparison.entries.find((entry) => entry.id === "games-pro");
  assert.equal(proEntry.changeSummary, `Runtime state differs: ${pro.review.description}`);
  assert.match(proEntry.rationale, /evidence-based/);
  const projection = publicReviewProjection(review);
  assert.equal(projection.surfaces["games-pro"].reviewerChanges.length, 1);
  assert.equal(projection.surfaces["games-pro"].reviewerChanges[0].category, "visible-text");
  assert.equal(projection.surfaces["games-pro"].reviewerChanges[0].bullet, pro.review.facts[0].bullet);
  assert.equal(projection.surfaces["games-free"].noVisibleChange, true);
  assert.equal(projection.surfaces["games-pro"].noVisibleChange, false);
  const capture = projection.runtimeEvidence["public:games-pro"].current.groups.capture;
  assert.match(capture.find((row) => row.label === "Visual comparison").value, /modified \(repeated-cross-build-delta\) · 3\.2% of pixels/);
  assert.equal(capture.find((row) => row.label === "Review status").value, `variant — Runtime state differs: ${pro.review.description}`);
  assert.equal(projection.runtimeEvidence["public:games-pro"].current.groups.ui[0].label, "Accessibility comparison");
  for (const [mutate, error] of [
    [(r) => { r.surfaces[0].review = { status: "modified", description: "" }; }, /review verdict/],
    [(r) => { r.surfaces[0].review = { status: "added", description: "Added" }; }, /review verdict/],
    [(r) => { r.surfaces[0].review = { status: "modified", description: "x".repeat(161) }; }, /review verdict/],
    [(r) => { r.surfaces[0].visual = { verdict: "modified", reason: "matched", threshold: "0.1", tool: "t" }; }, /visual verdict/],
    [(r) => { r.surfaces[2].visual = { verdict: "modified", reason: "matched", threshold: 0.1, tool: "t" }; }, /visual verdict/],
  ]) {
    const broken = fixture(); mutate(broken);
    const verdictless = opensWithGap(t, broken, error);
    const screen = verdictless.projection.runtimeEvidence[`public:${broken.surfaces[0].id}`] ?? verdictless.projection.runtimeEvidence[`public:${broken.surfaces[2].id}`];
    assert.ok(screen, "the screen keeps its captures without the malformed verdict");
  }
});


test("exact-commit baseline evidence can retain different build IDs after partial cache reuse", (t) => {
  const review = fixture();
  review.surfaces[0].baseImage.buildId = "earlier-compatible-base-build";
  const workspace = publicReviewToWorkspace(review);
  assert.ok(workspace.comparison.entries.length > 0);
  const evidence = publicReviewProjection(review).runtimeEvidence["public:games-free"].baseline;
  assert.equal(evidence.groups.environment.find(row => row.label === "EAS build").value, "earlier-compatible-base-build");
  review.surfaces[0].baseImage.sourceCommit = "f".repeat(40);
  opensWithGap(t, review, /capture provenance/, review.surfaces[0].id);
});

test("public notes survive viewer projection without changing deterministic verdicts or evidence", () => {
  const review = verifyImages(fixture());
  const changed = review.surfaces.find(surface => surface.id === "games-free");
  const unchanged = review.surfaces.find(surface => surface.id === "games-pro");
  changed.review = { status: "modified", description: "Changed the primary action label.", facts: [
    { category: "visible-text", templateId: "visible-text.changed", bullet: "Changed button title from “Play” to “Start playing”." },
  ] };
  unchanged.review = { status: "unchanged", description: "No visible change" };
  const deterministicWorkspace = publicReviewToWorkspace(review);
  const deterministicProjection = publicReviewProjection(review);
  const notes = [
    [changed, "The primary action now says “Start playing”, clarifying how to launch the game."],
    [unchanged, "No visible change."],
  ];
  for (const [surface, text] of notes) {
    surface.note = {
      text, evidenceDigest: "f".repeat(64),
      evidence: ["base", "head"].map(side => ({
        side, sourceCommit: review.pullRequest[side].sha, imageSha256: surface[`${side}Image`].sha256,
      })),
    };
  }
  deepFreeze(review);
  const workspace = publicReviewToWorkspace(review);
  const projection = publicReviewProjection(review);
  assert.deepEqual(workspace.comparison, deterministicWorkspace.comparison);
  assert.deepEqual(projection.runtimeEvidence, deterministicProjection.runtimeEvidence);
  const diff = diffFor(review);
  for (const [surface, text] of notes) {
    assert.equal(projection.surfaces[surface.id].note, text);
    assert.equal(diff.screens.get(surface.id).note, text);
    assert.equal(diff.screens.get(surface.id).status, surface.review.status);
    assert.equal(diff.screens.get(surface.id).changeSummary, surface.review.description);
    assert.deepEqual(projection.surfaces[surface.id].reviewerChanges, deterministicProjection.surfaces[surface.id].reviewerChanges);
  }
  assert.equal(diff.screens.get(unchanged.id).noVisibleChange, true);
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.counts.unchanged, 1);
  const presented = presentBuildDiff(diff, presentScreensByPath(diff.map));
  assert.equal(presented.screens.get(changed.id).note, changed.note.text, "route-family presentation keeps the displayed screenshot's note");
  assert.equal(projection.surfaces["care-guide"].note, undefined, "older publications keep their deterministic fallback");
});


test("a source change without a comparison is not compared, as untouched uncaptured inventory is: it is no change the captures show", () => {
  const review = fixture("changes");
  delete review.surfaces[0].baseImage;
  delete review.surfaces[0].headImage;
  const diff = diffFor(review);
  assert.equal(diff.screens.get("games-free").status, "not-compared");
  assert.equal(diff.screens.get("games-pro").status, "not-compared");
  assert.equal(diff.counts.modified, 0);
  assert.equal(diff.counts.unchanged, 0);
  assert.equal(diff.counts["source-affected"], 0);
  assert.equal(review.surfaces[0].status, "modified", "source classification is retained without inventing a visual verdict");
});

test("failed Added and Removed route captures retain source presence without borrowing opposite-side evidence", () => {
  const review = fixture();
  const added = review.surfaces.find(surface => surface.status === "added");
  const removed = review.surfaces.find(surface => surface.status === "removed");
  delete added.headImage;
  delete removed.baseImage;
  for (const [surface, side] of [[added, "head"], [removed, "base"]]) {
    surface[`${side}Outcome`] = { status: "failed", attempts: 1, landing: "unverified" };
  }
  const workspace = publicReviewToWorkspace(review);
  const diff = diffFor(review);
  const removedId = removedScreenId(workspace.catalog.defaultBaselineBuildId, removed.id);
  assert.equal(diff.screens.get(added.id).status, "unavailable", "an added route whose capture failed has nothing to show");
  assert.equal(diff.screens.get(removedId).status, "removed");
  assert.ok(diff.index.screens.has(removedId));
  const { baseline, current } = workspaceSides(workspace);
  assert.ok(baseline.map.gaps.some(gap => gap.screenId === removed.id && gap.status === "open"));
  assert.ok(current.map.gaps.some(gap => gap.screenId === added.id && gap.status === "open"));
  assert.equal(current.map.gaps.some(gap => gap.screenId === removed.id), false, "the intentionally absent revision is not a capture failure");
  assert.equal(baseline.map.gaps.some(gap => gap.screenId === added.id), false);
  assert.ok(diff.map.gaps.some(gap => gap.screenId === removedId && gap.status === "open"), "the Changes map retains the baseline capture gap");
  for (const id of [added.id, removedId]) {
    assert.equal(diff.screens.get(id).beforeScreenshot, undefined);
    assert.equal(diff.screens.get(id).afterScreenshot, undefined);
  }
});

test("an unattributed frame (the app showed another screen) is shown, named, and never compared", async t => {
  for (const side of ["base", "head"]) await t.test(side, () => {
    const review = verifyImages(fixture());
    const surface = review.surfaces[0];
    surface[`${side}Outcome`] = { status: "captured", attempts: 2, landing: "unverified", reason: "Expected /games; the app showed /login on both attempts.",
      observed: { reason: "landing-mismatch", route: "/login", attempts: 2 } };
    const workspace = publicReviewToWorkspace(review);
    const sides = workspaceSides(workspace);
    const affected = side === "base" ? sides.baseline : sides.current;
    assert.equal(affected.coverage.observations, 6, "the unattributed frame is retained as evidence");
    assert.match(affected.map.gaps.find(gap => gap.screenId === surface.id).message, /not attributed — expected \/games, the app showed \/login/);
    const diff = diffFor(review);
    assert.equal(diff.screens.get(surface.id).status, "unavailable");
    const entry = workspace.comparison.entries.find(candidate => candidate.id === surface.id);
    assert.match(entry.changeSummary, /^Unattributed frame( in the base)? — Expected \/games, the app showed \/login\. Not compared\.$/);
  });
});

test("unverified captures on either side remain diagnostics and cannot become app-change verdicts", async t => {
  for (const side of ["base", "head"]) await t.test(side, () => {
    const review = verifyImages(fixture());
    const surface = review.surfaces[0];
    surface[`${side}Outcome`] = { status: "captured", attempts: 2, landing: "unverified", reason: "The observed route was /login instead of /games" };
    assert.equal(surface.review, undefined, "an unverified capture has diagnostics without a comparison verdict");
    const workspace = publicReviewToWorkspace(review);
    const sides = workspaceSides(workspace);
    const affected = side === "base" ? sides.baseline : sides.current;
    const other = side === "base" ? sides.current : sides.baseline;
    assert.equal(affected.coverage.gaps.open, 1);
    assert.equal(other.coverage.gaps.open, 0);
    assert.equal(affected.coverage.completion.eligible, false);
    assert.equal(affected.coverage.observations, 6, "an unverified image is retained as diagnostic evidence");
    assert.match(affected.map.gaps.find(gap => gap.screenId === surface.id).message, /destination unverified/);
    const diff = diffFor(review);
    assert.equal(diff.screens.get(surface.id).status, "not-compared");
    assert.equal(diff.screens.get(surface.id).noVisibleChange, false);
    assert.deepEqual(diff.screens.get(surface.id).reviewerChanges, []);
    assert.equal(diff.counts["needs-review"], 0);
    assert.ok(diff.map.gaps.some(gap => gap.screenId === surface.id && gap.status === "open"));
    const evidence = publicReviewProjection(review).runtimeEvidence[`public:${surface.id}`][side === "base" ? "baseline" : "current"];
    const capture = new Map(evidence.groups.capture.map(row => [row.label, row.value]));
    assert.equal(capture.get("Landing"), "Unverified");
    assert.equal(capture.get("Capture attempts"), "2");
    assert.equal(capture.get("Capture reason"), surface[`${side}Outcome`].reason);
    assert.equal(capture.has("Review status"), false);
  });
});

test("capture failure kinds stay in coverage and inspector diagnostics for existing routes", async t => {
  for (const status of ["missing-params", "unsupported-link", "failed", "budget-exhausted"]) await t.test(status, () => {
    const review = verifyImages(fixture());
    const surface = review.surfaces.find(surface => surface.id === "games-pro");
    delete surface.headImage;
    surface.headOutcome = { status, attempts: status === "failed" ? 1 : 0, landing: "unverified", reason: `Capture stopped: ${status}` };
    const workspace = publicReviewToWorkspace(review);
    const { current } = workspaceSides(workspace);
    assert.equal(current.map.screens.length, 7);
    assert.equal(current.coverage.gaps.open, 1);
    assert.equal(workspace.comparison.entries.find(entry => entry.id === surface.id).status, "unavailable");
    const capture = publicReviewProjection(review).runtimeEvidence[`public:${surface.id}`].current.groups.capture;
    assert.equal(capture.find(row => row.label === "Capture reason").value, `Capture stopped: ${status}`);
    assert.equal(capture.some(row => row.label === "Review status"), false);
  });
});

test("Needs review remains available for a comparison between verified destination captures", () => {
  const review = verifyImages(fixture());
  const surface = review.surfaces[0];
  surface.review = { status: "needs-review", description: "Repeated verified captures contained unstable content" };
  const diff = diffFor(review);
  assert.equal(diff.screens.get(surface.id).status, "needs-review");
  assert.equal(diff.screens.get(surface.id).noVisibleChange, false);
  assert.equal(diff.counts["needs-review"], 1);
});

test("direct reads of existing operational verdicts preserve diagnostics without repeating false changes", () => {
  const input = verifyImages(fixture());
  const surface = input.surfaces[0];
  surface.headOutcome.landing = "unverified";
  surface.headOutcome.reason = "Observed /login instead of /games";
  surface.review = { status: "needs-review", description: "Destination was not verified", facts: [
    { category: "text", templateId: "old", bullet: "Untrusted old screen text" },
  ] };
  surface.visual = { verdict: "unchanged", reason: "matched", threshold: 0.1, tool: "agent-device" };
  deepFreeze(input);
  publicReviewToWorkspace(input);
  const diff = diffFor(input);
  assert.equal(diff.screens.get(surface.id).status, "not-compared");
  assert.equal(diff.counts["needs-review"], 0);
  assert.deepEqual(diff.screens.get(surface.id).reviewerChanges, []);
  assert.equal(surface.review.status, "needs-review", "the original report is not mutated by reading");
});

test("a planned screen whose capture failed is unavailable, with the report's reason, and is not a change", () => {
  const review = navigationReview();
  const surface = review.surfaces.find(surface => surface.id === "scan-mood");
  delete surface.headImage;
  delete surface.review;
  surface.headOutcome = { status: "failed", attempts: 1, landing: "unverified", reason: "Configured UI prerequisites did not complete." };
  const diff = diffFor(review);
  const screen = diff.screens.get("scan-mood");
  assert.equal(screen.status, "unavailable");
  assert.equal(screen.captureNotes.after, "Capture failed: Configured UI prerequisites did not complete");
  assert.equal(screen.beforeScreenshot, surface.baseImage.url, "the baseline frame stays visible");
  assert.equal(screen.afterScreenshot, undefined);
  assert.equal(presentBuildDiff(diff, presentScreensByPath(diff.map)).counts.unavailable, 1);
  const { isChangedStatus } = { isChangedStatus: (status) => status !== "unchanged" && status !== "not-compared" && status !== "unavailable" && status !== "variant" };
  assert.equal(isChangedStatus(screen.status), false);
});

test("source navigation names routes, so a route whose only base frame is a secondary appearance stays known on base", () => {
  const review = navigationReview();
  const scan = review.surfaces.find(surface => surface.id === "scan-mood");
  // The first light+dark head against a dark-only base: the light frame is the route surface
  // (added, no base), the dark frame is `scan-mood@dark` (modified, present on both sides).
  const image = (side, id) => ({ ...scan[`${side}Image`], url: `${scan[`${side}Image`].url}-${id}`, sha256: "c".repeat(64) });
  review.surfaces.push({
    id: "scan-mood@dark", status: "modified", colorScheme: "dark",
    base: entry("scan-mood@dark", scan.base.route, "mood"), head: entry("scan-mood@dark", scan.head.route, "mood"),
    baseImage: image("base", "dark"), headImage: image("head", "dark"),
  });
  scan.status = "added";
  scan.colorScheme = "light";
  delete scan.base;
  delete scan.baseImage;
  const { baseline, current } = workspaceSides(publicReviewToWorkspace(deepFreeze(review)));
  assert.deepEqual(baseline.map.screens.filter(screen => screen.id.startsWith("scan-mood")).map(screen => screen.id), ["scan-mood@dark"]);
  assert.deepEqual(current.map.screens.filter(screen => screen.id.startsWith("scan-mood")).map(screen => screen.id).sort(), ["scan-mood", "scan-mood@dark"]);
  for (const payload of [baseline, current]) {
    for (const screen of payload.map.screens.filter(screen => screen.id.startsWith("scan-mood"))) {
      assert.equal(screen.start, false, `${screen.id} is reached from games-free`);
      assert.equal(screen.depth, 2, `${screen.id} sits two pushes from the start`);
      assert.equal(screen.terminal, false, "cycles never manufacture an end");
    }
    assert.equal(payload.map.screens.find(screen => screen.id === "games-free").depth, 1);
  }
});

test("launch evidence projects as a Launch screen per appearance with a splash comparison and no route semantics", () => {
  const review = fixture();
  review.runtime.colorSchemes = ["light", "dark"];
  const frame = (side, name) => ({ url: `https://evidence-test-123.convex.cloud/api/storage/${side}-${name}`, sha256: (side === "base" ? "1" : "2").repeat(64), width: 402, height: 874, capturedAt: "2026-09-08T11:00:00.000Z" });
  review.launch = [
    { id: "launch:splash", colorScheme: "light",
      base: { status: "observed", source: "screenshot", splash: frame("base", "splash"), settled: frame("base", "settled"), relaunchedAt: "2026-09-08T10:59:50.000Z", splashVisibleMs: 3100 },
      head: { status: "observed", source: "recording", splash: frame("head", "splash"), settled: frame("head", "settled"), relaunchedAt: "2026-09-08T10:59:50.000Z", splashVisibleMs: 2900,
        filmstrip: { url: "https://evidence-test-123.convex.cloud/api/storage/head-filmstrip", sha256: "4".repeat(64), width: 1104, height: 480, capturedAt: "2025-01-01T00:00:00.000Z", frameTimesMs: [-1200, 0, 500, 3600, 3700] },
        video: { url: "https://evidence-test-123.convex.cloud/api/storage/head-launch", sha256: "3".repeat(64), bytes: 1_600_000, mimeType: "video/mp4", durationMs: 7000 } },
      visual: { verdict: "modified", reason: "pixel-diff", threshold: 0.1, tool: "agent-device", mismatchPercentage: 12.5, regions: [] } },
    { id: "launch:splash@dark", colorScheme: "dark",
      head: { status: "not-observed", source: "screenshot", settled: frame("head", "settled-dark"), relaunchedAt: "2026-09-08T10:59:50.000Z" } },
  ];
  const workspace = publicReviewToWorkspace(deepFreeze(review));
  const { baseline, current } = workspaceSides(workspace);
  const base = baseline.map, head = current.map;
  const headLaunch = head.screens.find(screen => screen.id === "launch:splash");
  assert.equal(headLaunch.title, "Launch");
  assert.equal(headLaunch.route, "launch");
  assert.equal(headLaunch.state, "splash");
  assert.equal(headLaunch.colorScheme, "light");
  assert.equal(head.artifacts.find(artifact => artifact.id === "image:head:launch:splash").sha256, "2".repeat(64), "the head splash frame is the launch screen's image");
  assert.equal(head.artifacts.find(artifact => artifact.id === "video:head:launch:splash").mimeType, "video/mp4");
  const filmstrip = head.artifacts.find(artifact => artifact.id === "filmstrip:head:launch:splash");
  assert.deepEqual([filmstrip.kind, filmstrip.width, filmstrip.publicUrl], ["screenshot", 1104, "https://evidence-test-123.convex.cloud/api/storage/head-filmstrip"]);
  assert.equal(base.artifacts.some(artifact => artifact.kind === "video"), false);
  assert.equal(head.screens.find(screen => screen.id === "launch:splash@dark").state, "first frame");
  assert.equal(head.gaps.filter(gap => gap.screenId === "launch:splash@dark" && gap.status === "accepted").length, 1, "an unobserved splash is noted, not an open gap");
  assert.equal(base.screens.some(screen => screen.id === "launch:splash@dark"), false);
  const comparison = workspace.comparison.entries.find(entry => entry.id === "launch:splash");
  assert.equal(comparison.status, "modified");
  assert.match(comparison.changeSummary, /Splash changed; splash observed, steady for 2\.9 s/);
  assert.equal(workspace.comparison.entries.find(entry => entry.id === "launch:splash@dark").status, "added");
  assert.ok(head.screens.every(screen => !screen.id.startsWith("launch:") || screen.transitionIds === undefined), "launch screens join no navigation");
  const surface = publicReviewProjection(review).surfaces["launch:splash"];
  assert.equal(surface.visual.mismatchPercentage, 12.5);
  assert.equal(surface.noVisibleChange, false);
});

test("a target's review carries its target and the run's targets into the map; a review from before targets carries neither", () => {
  const targets = [
    { id: "iphone", platform: "ios", label: "iPhone 17" },
    { id: "duo-open", platform: "ios", label: "iPhone Duo (open)" },
    { id: "android", platform: "android", label: "Android" },
  ];
  const review = fixture();
  review.runtime = { ...review.runtime, platform: "ios", platforms: ["ios", "android"], target: targets[1], targets };
  const workspace = publicReviewToWorkspace(review);
  const { baseline, current } = workspaceSides(workspace);
  for (const map of [baseline.map, current.map]) {
    assert.deepEqual(map.run.target, targets[1]);
    assert.deepEqual(map.run.targets, targets);
    assert.deepEqual(map.run.platforms, ["ios", "android"]);
  }
  const old = workspaceSides(publicReviewToWorkspace(fixture())).current.map.run;
  assert.equal(old.target, undefined);
  assert.equal(old.targets, undefined);
  const odd = fixture();
  odd.runtime = { ...odd.runtime, target: { id: "Not An Id", platform: "ios", label: "x" }, targets: [targets[0], { id: "x", platform: "web" }] };
  const oddRun = workspaceSides(publicReviewToWorkspace(odd)).current.map.run;
  assert.equal(oddRun.target, undefined, "a malformed target is dropped, and the report reads as its platform's");
  assert.equal(oddRun.targets, undefined);
});

test("an excluded route leaves the map with an accepted gap, like a redirect", () => {
  const review = navigationReview();
  const excluded = review.surfaces.find(surface => surface.id === "games-pro");
  excluded.status = "modified";
  excluded.excluded = true;
  for (const side of ["base", "head"]) { delete excluded[`${side}Image`]; delete excluded[`${side}Outcome`]; }
  const { current } = workspaceSides(publicReviewToWorkspace(review));
  const graph = buildViewerGraph(current.map, indexMap(current.map));
  assert.equal(graph.screens.some(screen => screen.id === "games-pro"), false, "never captured, so not a card on the map");
  assert.ok(current.map.screens.some(screen => screen.id === "games-pro"), "the inventory still knows the route");
  const gap = current.map.gaps.find(gap => gap.screenId === "games-pro");
  assert.equal(gap.status, "accepted");
  assert.equal(gap.message, "Excluded by exploration.exclude; never captured");
  assert.equal(
    indexMap(current.map).screenNotes.get("games-pro"),
    "Excluded by exploration.exclude; never captured",
    "the inspector's placeholder says why there is no screenshot",
  );
  const projection = publicReviewProjection(review);
  assert.equal(projection.runtimeEvidence["public:games-pro"].current.groups.capture.find((row) => row.label === "Capture").value,
    "Excluded by exploration.exclude; never captured");
});
