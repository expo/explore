import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const search = await tsImport("../../viewer/src/utils/search.ts", import.meta.url);

const screens = [
  { id: "screen-home", title: "Home", route: "/(tabs)/home", depth: 0, variantIds: [], observationIds: [] },
  { id: "screen-transfer", title: "Transfer money", route: "/transfer", depth: 1, variantIds: [], observationIds: [] },
  { id: "screen-profile", title: "Profile", depth: 1, variantIds: [], observationIds: [] },
];

const items = search.buildSearchItems({ screens });

test("builds stable router-path search items: no flow or area items", () => {
  assert.deepEqual(items.map((item) => item.kind), ["screen", "screen", "screen"]);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.deepEqual(
    items.filter((item) => item.kind === "screen").map((item) => item.title),
    ["/(tabs)/home", "/transfer", "/profile"],
  );
});

test("searches screens by router path only", () => {
  assert.deepEqual(search.searchItems(items, "Transfer money"), []);
  assert.deepEqual(
    search.searchItems(items, "/(tabs)/home").map((item) => item.id),
    ["screen:screen-home"],
  );
  assert.deepEqual(search.searchItems(items, "money"), []);
});

test("converts Mobbin capture URLs to router paths without indexing source metadata", () => {
  const mobbinItems = search.buildSearchItems({
    screens: [{
      id: "screen-deals",
      title: "Deals — Chime+ premium offers unlocked",
      route: "/mobbin/screens/279",
      depth: 0,
      variantIds: [],
      observationIds: [],
    }],
  });
  const routeItem = mobbinItems.find((item) => item.id === "screen:screen-deals");

  assert.equal(routeItem?.title, "/deals");
  assert.equal(routeItem?.route, undefined);
  assert.doesNotMatch(JSON.stringify(routeItem), /mobbin\/screens|premium offers/i);
  assert.deepEqual(search.searchItems(mobbinItems, "/deals").map((item) => item.id), ["screen:screen-deals"]);
  assert.deepEqual(search.searchItems(mobbinItems, "/mobbin/screens/279"), []);
  assert.deepEqual(search.searchItems(mobbinItems, "premium offers"), []);
});

test("suggestions put the active context first and stay within the result cap", () => {
  const suggestions = search.suggestedSearchItems(items, { screenId: "screen-transfer" }, 2);
  assert.deepEqual(suggestions.map((item) => item.id), [
    "screen:screen-transfer",
    "screen:screen-home",
  ]);
  assert.equal(new Set(suggestions.map((item) => item.id)).size, suggestions.length);
});

test("empty queries and non-positive limits do not return an unbounded inventory", () => {
  assert.deepEqual(search.searchItems(items, ""), []);
  assert.deepEqual(search.searchItems(items, "money", 0), []);
  assert.deepEqual(search.suggestedSearchItems(items, {}, 0), []);
});
