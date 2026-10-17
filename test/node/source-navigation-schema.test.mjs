import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
const { tsImport } = await import("tsx/esm/api");
const { ExploreStore, validateMap } = await tsImport("../../src/map/store.ts", import.meta.url);

const schema = JSON.parse(await readFile(new URL("../../schema/screen-map.v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
const timestamp = "2026-09-15T00:00:00.000Z";
const graph = {
  contract: "explore.navigation",
  edges: [{ from: "start", to: "end", kind: "push", sourceFile: "src/app/index.tsx", provenance: "source" }],
  modalSurfaceIds: ["end"], unresolved: [],
};
const fixture = () => ({
  contract: "expo.explore.local-map.v1", revision: 1,
  run: { id: "run", name: "Source navigation", platform: "ios", controller: "agent-device", status: "draft",
    createdAt: timestamp, updatedAt: timestamp, build: {}, environment: {},
    limits: { maxScreens: 2, maxActions: 1, maxDurationMinutes: 1 } },
  artifacts: [], screens: [], variants: [], observations: [], elements: [],
  actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [],
});

test("map schema accepts optional independent current and baseline source graphs", () => {
  assert.equal(validate(fixture()), true, JSON.stringify(validate.errors));
  const map = { ...fixture(), sourceNavigation: structuredClone(graph), baselineSourceNavigation: structuredClone(graph) };
  assert.equal(validate(map), true, JSON.stringify(validate.errors));
  assert.deepEqual(map.transitions, []);
  assert.deepEqual(map.actionAttempts, []);
});

test("structural journeys validate source membership without claiming observed replay evidence", async () => {
  const map = fixture();
  map.screens = ["start", "end"].map(id => ({ id, title: id, start: false, terminal: false, depth: 0,
    firstSeenAt: timestamp, lastSeenAt: timestamp, visits: 0, variantIds: [], observationIds: [], elementIds: [] }));
  const source = { kind: "structural", flowId: "flow-feature", revision: "current" };
  map.journeys = [{ id: "flow-feature", title: "Feature", screenIds: ["start", "end"], transitionIds: [], attemptIds: [], source }];
  const store = new ExploreStore("/unused-structural-validation");
  assert.equal(validate(map), true, JSON.stringify(validate.errors));
  assert.deepEqual(await validateMap(map, store, { checkArtifacts: false }), []);
  for (const invalid of [{ ...source, kind: "observed" }, { ...source, flowId: "../secret" },
    { ...source, revision: "future" }, { ...source, confidence: 1 }]) {
    assert.equal(validate({ ...map, journeys: [{ ...map.journeys[0], source: invalid }] }), false);
  }
  const unknown = structuredClone(map); unknown.journeys[0].screenIds.push("missing");
  assert.ok((await validateMap(unknown, store, { checkArtifacts: false })).some(error => /unknown screen/.test(error)));
  const invented = structuredClone(map); invented.journeys[0].transitionIds.push("invented");
  assert.ok((await validateMap(invented, store, { checkArtifacts: false })).some(error => /cannot claim observed/.test(error)));
  const observed = structuredClone(map); delete observed.journeys[0].source;
  assert.ok((await validateMap(observed, store, { checkArtifacts: false })).some(error => /one transition per screen pair/.test(error)));
});

test("map schema rejects invented observed metadata and unsupported source links", async t => {
  for (const change of [
    value => { value.edges[0].provenance = "observed"; },
    value => { value.edges[0].attemptIds = ["fake-attempt"]; },
    value => { value.edges[0].kind = "back"; },
    value => { value.contract = "expo.explore.observed-navigation.v1"; },
    value => { delete value.modalSurfaceIds; },
  ]) await t.test(change.toString(), () => {
    const invalid = structuredClone(graph);
    change(invalid);
    assert.equal(validate({ ...fixture(), sourceNavigation: invalid }), false);
    assert.equal(validate({ ...fixture(), baselineSourceNavigation: invalid }), false);
  });
});

test("map semantic validation rejects dangling, unsafe, and duplicate source links on either revision", async t => {
  const map = fixture();
  map.screens = ["start", "end"].map(id => ({
    id, title: id, start: id === "start", terminal: id === "end", depth: 0,
    firstSeenAt: timestamp, lastSeenAt: timestamp, visits: 0,
    variantIds: [], observationIds: [], elementIds: [],
  }));
  const store = new ExploreStore("/unused-navigation-validation");
  assert.deepEqual(await validateMap({ ...map, sourceNavigation: graph, baselineSourceNavigation: graph }, store, { checkArtifacts: false }), []);
  for (const field of ["sourceNavigation", "baselineSourceNavigation"]) {
    for (const [name, change] of [
      ["dangling target", value => { value.edges[0].to = "missing-screen"; }],
      ["unsafe file", value => { value.edges[0].sourceFile = "../private-file.tsx"; }],
      ["duplicate edge", value => { value.edges.push({ ...value.edges[0] }); }],
      ["dangling modal", value => { value.modalSurfaceIds = ["missing-screen"]; }],
    ]) await t.test(`${field}: ${name}`, async () => {
      const invalid = structuredClone(graph);
      change(invalid);
      const errors = await validateMap({ ...map, [field]: invalid }, store, { checkArtifacts: false });
      assert.ok(errors.some(error => error.startsWith(`${field}:`)), errors.join("\n"));
    });
  }
});

test("map schema accepts a run's capture target and its sibling targets", () => {
  const map = fixture();
  const targets = [{ id: "iphone", platform: "ios", label: "iPhone 17" }, { id: "duo-open", platform: "ios", label: "iPhone Duo (open)" }];
  map.run = { ...map.run, target: targets[1], targets };
  assert.equal(validate(map), true, JSON.stringify(validate.errors));
  for (const target of [{ id: "Duo", platform: "ios", label: "x" }, { id: "duo", platform: "web", label: "x" }, { id: "duo", platform: "ios" }]) {
    assert.equal(validate({ ...map, run: { ...map.run, target } }), false, JSON.stringify(target));
  }
  assert.equal(validate({ ...map, run: { ...map.run, targets: [targets[0]] } }), false, "one target is no sibling");
});
