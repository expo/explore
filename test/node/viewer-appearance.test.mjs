import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { appearanceOptions, filterMapAppearance } = await tsImport("../../viewer/src/utils/appearance.ts", import.meta.url);

const screen = (id, colorScheme) => ({ id, title: id, variantIds: [], ...(colorScheme ? { colorScheme } : {}) });
const map = {
  run: { environment: { colorSchemes: ["dark", "light"] } },
  screens: [screen("home", "dark"), screen("home@light", "light"), screen("about", "dark"), screen("about@light", "light")],
  variants: [{ id: "v1", screenId: "home" }, { id: "v2", screenId: "home@light" }],
  observations: [{ id: "o1", screenId: "home" }, { id: "o2", screenId: "home@light" }],
  elements: [{ id: "e1", observationIds: ["o1", "o2"] }, { id: "e2", observationIds: ["o2"] }],
  transitions: [{ id: "t1", fromScreenId: "home", toScreenId: "about" }, { id: "t2", fromScreenId: "home@light", toScreenId: "about" }],
  journeys: [], frontier: [], gaps: [],
};

test("appearance options come from the run, primary first, and from the screens", () => {
  assert.deepEqual(appearanceOptions(map), ["dark", "light"]);
  assert.deepEqual(appearanceOptions({ ...map, run: { environment: {} } }), ["dark", "light"]);
  assert.deepEqual(appearanceOptions({ ...map, run: { environment: {} }, screens: [screen("home")] }), []);
  assert.deepEqual(appearanceOptions(undefined), []);
});

test("filtering keeps one appearance's screens under their route ids, and what references them", () => {
  const light = filterMapAppearance(map, "light");
  assert.deepEqual(light.screens.map(s => [s.id, s.colorScheme]), [["home", "light"], ["about", "light"]]);
  assert.deepEqual(light.variants, [{ id: "v2", screenId: "home" }]);
  assert.deepEqual(light.observations, [{ id: "o2", screenId: "home" }]);
  assert.deepEqual(light.elements, [{ id: "e1", observationIds: ["o2"] }, { id: "e2", observationIds: ["o2"] }]);
  assert.deepEqual(light.transitions.map(t => [t.id, t.fromScreenId, t.toScreenId]), [["t1", "home", "about"], ["t2", "home", "about"]]);
  const dark = filterMapAppearance(map, "dark");
  assert.deepEqual(dark.screens.map(s => s.id), ["home", "about"]);
  assert.deepEqual(dark.observations, [{ id: "o1", screenId: "home" }]);
  assert.deepEqual(dark.elements, [{ id: "e1", observationIds: ["o1"] }]);
  assert.deepEqual(dark.transitions.map(t => t.id), ["t1", "t2"]);
});

test("a single-appearance report is returned as is", () => {
  const single = { ...map, screens: [screen("home"), screen("about")] };
  assert.equal(filterMapAppearance(single, "light"), single);
  assert.equal(filterMapAppearance(map, undefined), map);
});

const { appearanceScope, filterComparisonAppearance, filterReviewAppearance } = await tsImport("../../viewer/src/utils/appearance.ts", import.meta.url);

test("the comparison and the review follow the appearance filter, keyed by route", () => {
  const scope = appearanceScope([map, undefined], "light");
  const comparison = { entries: [
    { id: "home", status: "unchanged", baselineScreenIds: ["home"], currentScreenIds: ["home"] },
    { id: "home@light", status: "unavailable", baselineScreenIds: [], currentScreenIds: ["home@light"] },
    { id: "about", status: "modified", baselineScreenIds: ["about"], currentScreenIds: ["about"] },
    { id: "about@light", status: "added", baselineScreenIds: [], currentScreenIds: ["about@light"] },
  ] };
  assert.deepEqual(filterComparisonAppearance(comparison, scope).entries.map(e => [e.id, e.status, e.currentScreenIds]),
    [["home", "unavailable", ["home"]], ["about", "added", ["about"]]]);
  const review = { surfaces: { home: { note: "dark" }, "home@light": { note: "light" }, about: {} }, runtimeEvidence: { "public:home@light": { facts: 1 } } };
  const light = filterReviewAppearance(review, scope);
  assert.deepEqual(light.surfaces, { home: { note: "light" } });
  assert.equal(light.runtimeEvidence, review.runtimeEvidence, "evidence keeps the keys the surfaces reference");
  assert.equal(filterReviewAppearance(review, undefined), review);
  assert.equal(appearanceScope([{ ...map, screens: [screen("home")] }], "light"), undefined);
});

test("filtering renames journeys, frontier and gaps to the route id", () => {
  const light = filterMapAppearance({
    ...map,
    journeys: [{ id: "j", screenIds: ["home", "about"] }],
    frontier: [{ screenId: "home@light" }, { screenId: "home" }],
    gaps: [{ id: "g1", screenId: "home@light", status: "open" }, { id: "g2", screenId: "home", status: "open" }, { id: "g3", status: "open" }],
  }, "light");
  assert.deepEqual(light.journeys, [{ id: "j", screenIds: ["home", "about"] }]);
  assert.deepEqual(light.frontier, [{ screenId: "home" }]);
  assert.deepEqual(light.gaps.map(gap => [gap.id, gap.screenId]), [["g1", "home"], ["g3", undefined]]);
});
