import assert from "node:assert/strict";
import { viewerMapFixture } from "../helpers/viewer-map-fixture.mjs";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const graphModel = await tsImport("../../viewer/src/utils/graph-model.ts", import.meta.url);
const model = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);

function screen(id, title, options = {}) {
  return {
    id,
    title,
    start: false,
    terminal: false,
    depth: 0,
    firstSeenAt: "2026-04-01T00:00:00.000Z",
    lastSeenAt: "2026-04-01T00:00:00.000Z",
    visits: 1,
    variantIds: [],
    observationIds: [],
    elementIds: [],
    ...options,
  };
}

function transition(from, to, index) {
  return {
    id: `t-${index}-${from}-${to}`,
    fromScreenId: from,
    toScreenId: to,
    actionKind: "other",
    firstObservedAt: "2026-04-01T00:00:00.000Z",
    lastObservedAt: "2026-04-01T00:00:00.000Z",
    attemptIds: [],
  };
}

function fixture(screenDefs, links, journeyDefs = []) {
  const transitions = links.map(([from, to], index) => transition(from, to, index));
  const map = {
    screens: screenDefs,
    transitions,
    variants: [],
    observations: [],
    artifacts: [],
    elements: [],
    actionAttempts: [],
    journeys: journeyDefs.map((journey, index) => ({
      id: journey.id ?? `journey-${index}`,
      title: journey.title,
      screenIds: journey.screenIds,
      transitionIds: transitions
        .filter((candidate) => journey.screenIds.includes(candidate.fromScreenId)
          && journey.screenIds.includes(candidate.toScreenId))
        .map((candidate) => candidate.id),
      attemptIds: [],
    })),
    frontier: [],
    gaps: [],
  };
  const graph = graphModel.buildObservedGraph(map, model.indexMap(map));
  return { map, graph };
}

function largeFixture() {
  const topics = [
    "Onboarding",
    "Home",
    "Direct deposit",
    "Transferring money",
    "Cards",
    "Credit score",
    "SpotMe benefits",
    "Creating a group",
    "Cash back offers",
    "Account profile",
  ];
  const screens = [];
  const links = [];
  const journeys = [];
  topics.forEach((title, topicIndex) => {
    const ids = [];
    for (let screenIndex = 0; screenIndex < 12; screenIndex += 1) {
      const id = `area-${topicIndex}-screen-${screenIndex}`;
      ids.push(id);
      screens.push(screen(id, `${title} — Screen ${screenIndex}`, {
        start: screenIndex === 0,
        terminal: screenIndex === 11,
        depth: screenIndex,
      }));
      if (screenIndex > 0) links.push([ids[screenIndex - 1], id]);
    }
    journeys.push({ title, screenIds: ids });
  });
  return fixture(screens, links, journeys);
}

function assertNoMissingEdgeEndpoints(projection) {
  const nodeIds = new Set(projection.nodes.map((node) => node.id));
  for (const group of projection.groups) {
    assert.equal(nodeIds.has(group.from), true, `missing projected source ${group.from}`);
    assert.equal(nodeIds.has(group.to), true, `missing projected target ${group.to}`);
  }
}

test("the map is one node per screen with every connection as an edge, for any report", () => {
  const map = viewerMapFixture();
  const index = model.indexMap(map);
  const graph = graphModel.buildViewerGraph(map, index);
  const projection = graphModel.projectFullGraph(graph);
  assert.equal(graphModel.isBlackBoxMap(map), false);
  assert.deepEqual(projection.nodes.map((node) => node.kind), map.screens.map(() => "screen"));
  assert.deepEqual([...projection.visibleScreenIds].sort(), map.screens.map((screen) => screen.id).sort());
  assert.equal(projection.groups.length, graph.groups.length);
  assertNoMissingEdgeEndpoints(projection);
  const again = graphModel.projectFullGraph(graphModel.buildViewerGraph(map, index));
  assert.deepEqual(again.nodes.map((node) => node.id), projection.nodes.map((node) => node.id), "node order is deterministic");
});

test("a black-box exploration is recognised by its run provenance only", () => {
  const { map } = fixture([
    screen("home", "Home", { start: true }),
    screen("settings", "Settings"),
  ], [["home", "settings"]]);
  assert.equal(graphModel.isBlackBoxMap(map), false, "missing journeys do not make a map black-box");
  assert.equal(graphModel.isBlackBoxMap({ ...map, run: { ...map.run, exploration: "black-box" } }), true);
});

test("a large report shows every screen; there is no structural budget", () => {
  const { map, graph } = largeFixture();
  const projection = graphModel.projectFullGraph(graph);
  assert.ok(map.screens.length > 80, `fixture has ${map.screens.length} screens`);
  assert.equal(projection.nodes.length, map.screens.length);
  assertNoMissingEdgeEndpoints(projection);
});

test("edges keep the label of the control that was tapped", () => {
  const { graph } = fixture([
    screen("home", "Home", { start: true }),
    screen("settings", "Settings"),
  ], [["home", "settings"]]);
  assert.equal(graph.groups.length, 1);
  assert.deepEqual(graph.groups[0].labels, [], "an unlabelled 'other' transition stays unlabelled rather than inventing a name");
});

test("the launch heads the map: one synthetic edge into each start screen, none when the report has no launch", () => {
  const launch = screen("launch:splash", "Launch", { route: "launch", state: "splash" });
  const home = screen("home", "Home", { start: true });
  const detail = screen("detail", "Detail", { depth: 1 });
  const run = { id: "run-launch", status: "completed" };
  const map = { ...fixture([launch, home, detail], [["home", "detail"]]).map, run };
  const graph = graphModel.buildViewerGraph(map, model.indexMap(map));
  assert.deepEqual(graph.screens.map((item) => item.id).sort(), ["detail", "home", "launch:splash"]);
  const launchEdges = graph.groups.filter((group) => group.from === "launch:splash");
  assert.deepEqual(launchEdges.map((group) => group.to), ["home"]);
  assert.ok(launchEdges.every((group) => group.synthetic && group.transitionIds.length === 0 && group.labels.includes("Launch")));
  assert.equal(graph.disconnectedScreenIds.includes("launch:splash"), false);
  assertNoMissingEdgeEndpoints(graphModel.projectFullGraph(graph));

  const noStart = { ...fixture([launch, screen("first", "First"), screen("second", "Second")], [["first", "second"]]).map, run };
  const fallback = graphModel.buildViewerGraph(noStart, model.indexMap(noStart));
  assert.deepEqual(fallback.groups.filter((group) => group.synthetic).map((group) => group.to), ["first"], "without a start screen the launch leads into the first route");

  const without = { ...fixture([home, detail], [["home", "detail"]]).map, run };
  assert.equal(graphModel.buildViewerGraph(without, model.indexMap(without)).groups.some((group) => group.synthetic), false);
});
