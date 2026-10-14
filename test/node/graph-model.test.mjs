import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const graphModel = await tsImport("../../viewer/src/utils/graph-model.ts", import.meta.url);
const model = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);

function screen(id, options = {}) {
  return {
    id,
    title: id,
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

function fixture(screenDefs, links) {
  const map = {
    screens: screenDefs,
    transitions: links.map(([from, to], index) => transition(from, to, index)),
    variants: [],
    observations: [],
    artifacts: [],
    elements: [],
    actionAttempts: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
  return graphModel.buildObservedGraph(map, model.indexMap(map));
}

test("buildObservedGraph preserves topology, cycles, and disconnected screens", () => {
  const graph = fixture(
    ["root", "branch", "left", "right", "merge", "cycle-a", "cycle-b", "leaf", "orphan"].map((id) => screen(id, {
      start: id === "root",
      terminal: id === "leaf",
    })),
    [
      ["root", "branch"],
      ["branch", "left"],
      ["branch", "right"],
      ["left", "merge"],
      ["right", "merge"],
      ["merge", "cycle-a"],
      ["cycle-a", "cycle-b"],
      ["cycle-b", "cycle-a"],
      ["cycle-b", "leaf"],
    ],
  );

  assert.deepEqual(graph.outgoing.get("branch").map((group) => group.to).sort(), ["left", "right"]);
  assert.deepEqual(graph.incoming.get("merge").map((group) => group.from).sort(), ["left", "right"]);
  assert.deepEqual([...graph.cyclicScreenIds].sort(), ["cycle-a", "cycle-b"]);
  assert.deepEqual(graph.disconnectedScreenIds, ["orphan"]);
  assert.equal(graph.groups.length, 9);
});
