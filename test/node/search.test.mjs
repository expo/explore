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

test("the palette ranks commands first for a word and screens first for a route, matching command keywords", () => {
  const items = [
    { id: "screen:a", kind: "screen", title: "/settings/dark-mode", keywords: ["/settings/dark-mode"], context: "", order: 0, screenId: "a" },
    { id: "command:theme", kind: "command", title: "Theme: Dark", keywords: ["theme", "appearance"], context: "View", order: 1, run() {} },
    { id: "command:fit", kind: "command", title: "Fit the canvas", keywords: ["zoom"], context: "Canvas", order: 2, run() {} },
  ];
  assert.deepEqual(search.searchItems(items, "dark").map((item) => item.id), ["command:theme", "screen:a"]);
  assert.deepEqual(search.searchItems(items, "/settings").map((item) => item.id), ["screen:a"]);
  const open = { id: "command:open", kind: "command", title: "Open /settings/dark-mode in Compare", keywords: [], context: "Changes", order: 3, run() {} };
  assert.deepEqual(search.searchItems([...items, open], "settings/dark").map((item) => item.id), ["screen:a", "command:open"]);
  assert.deepEqual(search.searchItems(items, "appearance").map((item) => item.id), ["command:theme"]);
  assert.deepEqual(search.searchItems(items, "zoom").map((item) => item.id), ["command:fit"]);

  // A word that is a screen's last segment opens that screen; part of one still leads with the command.
  const theme = { id: "screen:theme", kind: "screen", title: "/settings/theme", keywords: ["/settings/theme"], context: "", order: 3, screenId: "theme" };
  assert.deepEqual(search.searchItems([...items, theme], "theme").map((item) => item.id), ["screen:theme", "command:theme"]);
  assert.deepEqual(search.searchItems([...items, theme], "Theme ").map((item) => item.id), ["screen:theme", "command:theme"]);
  assert.deepEqual(search.searchItems([...items, theme], "them").map((item) => item.id), ["command:theme", "screen:theme"]);
});

test("the palette's commands follow the canvas: Compare steps changes with the arrows, the Map fits its camera, and suggestions lead with the next change", async () => {
  const { commandItems, suggestedCommands } = await tsImport("../../viewer/src/utils/commands.ts", import.meta.url);
  const calls = [];
  const actions = Object.fromEntries(["selectCanvas", "openFind", "openHandoff", "openShortcuts", "toggleChanges", "openChangedScreen", "setTheme", "chooseAppearance", "toggleInspector", "toggleFullscreen", "switchTarget", "zoom"]
    .map((name) => [name, (...args) => calls.push([name, ...args])]));
  const base = {
    phone: false, changed: [{ id: "a", route: "/a" }, { id: "b", route: "/b" }], selectedScreenId: "a", find: true, handoff: true,
    pullRequest: { number: 7, url: "https://github.com/expo/explore/pull/7" }, theme: "system", appearances: [], targets: [{ id: "android", label: "Pixel 8", platform: "android", place: 1, noun: "device" }], camera: true,
  };
  const map = commandItems({ ...base, canvas: "map", inspector: { open: false } }, actions);
  const ids = (items) => items.map((item) => item.id.replace(/^command:/, ""));
  assert.ok(ids(map).includes("camera:fit"));
  assert.ok(ids(map).includes("changes:open-selected"));
  assert.ok(ids(map).includes("link:repository"));
  assert.equal(map.find((item) => item.id === "command:changes:next").shortcut, undefined);
  assert.deepEqual(ids(suggestedCommands(map, "map")).slice(0, 3), ["changes:next", "changes:open-selected", "go:compare"]);
  map.find((item) => item.id === "command:changes:next").run();
  map.find((item) => item.id === "command:target:android").run();
  assert.deepEqual(calls, [["openChangedScreen", "b"], ["switchTarget", "android"]]);

  const compare = commandItems({ ...base, canvas: "compare", camera: false }, actions);
  assert.ok(!ids(compare).includes("camera:fit"));
  assert.ok(!ids(compare).includes("changes:open-selected"));
  assert.ok(compare.find((item) => item.id === "command:changes:next").shortcut);
  assert.ok(!ids(compare).includes("go:compare"));
  assert.ok(ids(compare).includes("go:map"));

  // A phone has no keyboard shortcuts to list.
  assert.ok(ids(map).includes("go:shortcuts"));
  assert.ok(!ids(commandItems({ ...base, canvas: "map", phone: true }, actions)).includes("go:shortcuts"));

  // Next and Previous stop at the ends of the review, as Compare's arrows do.
  const last = commandItems({ ...base, canvas: "compare", camera: false, selectedScreenId: "b" }, actions);
  assert.ok(!ids(last).includes("changes:next"));
  assert.ok(ids(last).includes("changes:previous"));
  assert.ok(!ids(compare).includes("changes:previous"));
  const none = commandItems({ ...base, canvas: "map", selectedScreenId: undefined }, actions);
  assert.ok(ids(none).includes("changes:next") && ids(none).includes("changes:previous"));

  // An app appearance is found by its own scheme, not the other one.
  const schemes = commandItems({ ...base, canvas: "map", appearances: [{ id: "light", label: "Light", current: true }, { id: "dark", label: "Dark", current: false }] }, actions);
  assert.deepEqual(search.searchItems(schemes, "dark").filter((item) => item.id.includes("appearance")).map((item) => item.id), ["command:view:appearance:dark"]);
});

test("the palette finds a device by its own platform only", async () => {
  const { commandItems } = await tsImport("../../viewer/src/utils/commands.ts", import.meta.url);
  const actions = new Proxy({}, { get: () => () => {} });
  const items = commandItems({
    canvas: "map", phone: false, changed: [], find: true, handoff: false, theme: "system", appearances: [], camera: false,
    targets: [{ id: "duo-open", label: "iPhone Duo open", platform: "ios", place: 1, noun: "device" }, { id: "pixel", label: "Pixel 8", platform: "android", place: 2, noun: "device" }],
  }, actions);
  assert.deepEqual(search.searchItems(items, "android").map((item) => item.id), ["command:target:pixel"]);
  assert.deepEqual(search.searchItems(items, "ios").map((item) => item.id), ["command:target:duo-open"]);
});
