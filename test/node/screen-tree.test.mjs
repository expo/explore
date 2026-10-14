import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { indexMap } = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);
const { screenTree } = await tsImport("../../viewer/src/utils/screen-tree.ts", import.meta.url);

const at = (second) => `2026-10-13T00:00:${String(second).padStart(2, "0")}.000Z`;
function screen(id, title, depth, extra = {}) {
  return {
    id, title, depth, start: depth === 0, terminal: false, firstSeenAt: at(0), lastSeenAt: at(0), visits: 1,
    variantIds: [], observationIds: [], elementIds: [], ...extra,
  };
}
function map({ screens, transitions = [], elements = [], exploration }) {
  return {
    run: { id: "run", name: "app", platform: "ios", environment: {}, ...(exploration ? { exploration } : {}) },
    screens, transitions, elements, variants: [], observations: [], artifacts: [], actionAttempts: [], gaps: [], journeys: [], frontier: [],
  };
}
function transition(id, from, to, second, elementId) {
  return { id, fromScreenId: from, toScreenId: to, actionKind: "press", firstObservedAt: at(second), lastObservedAt: at(second), attemptIds: [], ...(elementId ? { elementId } : {}) };
}

test("with route files, sections follow the app directory and the tabs lead", () => {
  const screens = [
    screen("launch:splash", "Launch", 0),
    screen("home", "Home", 0, { route: "/" }),
    screen("patterns", "Patterns", 1, { route: "/patterns" }),
    screen("detail", "Detail", 2, { route: "/p/[d]" }),
    screen("tempo", "Tempo", 1, { route: "/tempo" }),
  ];
  const routeFiles = new Map([
    ["home", "src/app/(tabs)/(sequencer)/index.tsx"],
    ["patterns", "src/app/(tabs)/(patterns)/patterns.tsx"],
    ["detail", "src/app/(tabs)/(patterns)/p/[d].tsx"],
    ["tempo", "src/app/tempo.tsx"],
  ]);
  const tree = screenTree(screens, indexMap(map({ screens })), routeFiles);
  assert.equal(tree.mode, "source");
  assert.deepEqual(tree.sections.map((section) => [section.title, section.screenIds]), [
    ["Launch", ["launch:splash"]],
    ["app/(tabs)/(sequencer)", ["home"]],
    ["app/(tabs)/(patterns)", ["patterns"]],
    ["app/(tabs)/(patterns)/p", ["detail"]],
    ["app", ["tempo"]],
  ]);
  const folders = tree.tree.filter((node) => node.kind === "folder").map((node) => node.label);
  assert.deepEqual(folders, ["(tabs)/"]);
});

test("a black-box exploration groups by the tab each screen was opened from", () => {
  const screens = [
    screen("seq", "Sequencer", 0),
    screen("new", "New Pattern", 1),
    screen("rename", "Rename Pattern", 2),
    screen("pat", "Patterns", 1),
    screen("added", "Added to Library", 2),
    screen("lost", "Somewhere", 3),
  ];
  const elements = [
    { id: "tab-patterns", screenId: "seq", role: "tab", label: "Patterns", observationIds: [] },
    { id: "plus", screenId: "seq", role: "button", label: "New pattern", observationIds: [] },
    { id: "rename-item", screenId: "new", role: "menu-item", label: "Rename…", observationIds: [] },
  ];
  const transitions = [
    transition("t1", "seq", "new", 1, "plus"),
    transition("t2", "new", "rename", 2, "rename-item"),
    transition("t3", "seq", "pat", 3, "tab-patterns"),
    transition("t4", "pat", "added", 4),
  ];
  const tree = screenTree(screens, indexMap(map({ screens, transitions, elements, exploration: "black-box" })));
  assert.equal(tree.mode, "observed");
  assert.deepEqual(tree.sections.map((section) => [section.title, section.subtitle, section.screenIds]), [
    ["Sequencer", "first screen · 2 opened from here", ["seq", "new", "rename"]],
    ["Patterns", "tab · 1 opened from here", ["pat", "added"]],
    ["Not reached from a tab", undefined, ["lost"]],
  ]);
  assert.equal(tree.via.get("rename"), "Rename…");
  const patterns = tree.tree.find((node) => node.kind === "screen" && node.screenId === "pat");
  assert.equal(patterns.tab, true);
});

test("route files are ignored for a black-box exploration", () => {
  const screens = [screen("a", "A", 0, { route: "/" })];
  const tree = screenTree(screens, indexMap(map({ screens, exploration: "black-box" })), new Map([["a", "app/index.tsx"]]));
  assert.equal(tree.mode, "observed");
});

test("a removed screen keeps the route folder of the surface it was in the baseline", () => {
  const screens = [
    screen("home", "Home", 0, { route: "/" }),
    screen("removed:base-build:screen:old-settings", "Settings", 1, { route: "/settings" }),
    screen("baseline-context:base-build:screen:about", "About", 1, { route: "/about" }),
  ];
  const routeFiles = new Map([
    ["home", "src/app/(tabs)/index.tsx"],
    ["old-settings", "src/app/(tabs)/settings.tsx"],
    ["about", "src/app/about.tsx"],
  ]);
  const tree = screenTree(screens, indexMap(map({ screens })), routeFiles);
  assert.deepEqual(tree.sections.map((section) => [section.title, section.screenIds]), [
    ["app/(tabs)", ["home", "removed:base-build:screen:old-settings"]],
    ["app", ["baseline-context:base-build:screen:about"]],
  ]);
});

test("an observed screen sits under the screen it was first opened from, not the first one listed or the shallowest", () => {
  const screens = [
    screen("alpha", "Alpha", 0),
    screen("zulu", "Zulu", 0),
    screen("branch", "Branch", 1),
    screen("shared", "Shared", 1),
    screen("deep", "Deep", 2),
  ];
  const transitions = [
    transition("t1", "zulu", "shared", 1),
    transition("t2", "alpha", "shared", 2),
    transition("t3", "alpha", "branch", 3),
    transition("t4", "branch", "deep", 4),
    transition("t5", "alpha", "deep", 5),
  ];
  const tree = screenTree(screens, indexMap(map({ screens, transitions, exploration: "black-box" })));
  assert.deepEqual(tree.sections.map((section) => [section.title, section.screenIds]), [
    // Zulu opened Shared before Alpha did, though Alpha comes first in the list.
    ["Alpha", ["alpha", "branch", "deep"]],
    ["Zulu", ["zulu", "shared"]],
  ]);
  // Deep was opened from Branch before Alpha opened it directly.
  const alpha = tree.tree.find((node) => node.kind === "screen" && node.screenId === "alpha");
  assert.deepEqual(alpha.children.map((child) => [child.screenId, child.children.map((grandchild) => grandchild.screenId)]), [["branch", ["deep"]]]);
});

test("a route folder reads as words: route groups and dynamic segments lose their brackets", async () => {
  const { folderName } = await tsImport("../../viewer/src/utils/screen-tree.ts", import.meta.url);
  assert.equal(folderName("(tabs)/(settings)"), "Settings");
  assert.equal(folderName("(tabs)/(patterns)/p"), "P");
  assert.equal(folderName("lane-editor"), "Lane editor");
  assert.equal(folderName("c/[channel]"), "Channel");
  assert.equal(folderName("docs/[...slug]"), "Slug");
  assert.equal(folderName(""), "Top level");
});

test("a source section is named after its folder, with the parent in front when two names match", () => {
  const screens = [
    screen("settings", "Settings", 1, { route: "/settings" }),
    screen("a", "A", 1, { route: "/a/p" }),
    screen("b", "B", 1, { route: "/b/p" }),
    screen("tempo", "Tempo", 1, { route: "/tempo" }),
  ];
  const routeFiles = new Map([
    ["settings", "app/(tabs)/(settings)/settings.tsx"],
    ["a", "app/(alpha)/p/index.tsx"],
    ["b", "app/(beta)/p/index.tsx"],
    ["tempo", "app/tempo.tsx"],
  ]);
  const tree = screenTree(screens, indexMap(map({ screens })), routeFiles);
  assert.deepEqual(tree.sections.map((section) => [section.name, section.title]), [
    ["Alpha · P", "app/(alpha)/p"],
    ["Beta · P", "app/(beta)/p"],
    ["Settings", "app/(tabs)/(settings)"],
    ["Top level", "app"],
  ]);
});

test("the tree index lists foldable rows, the screens inside each, and the rows above each screen", async () => {
  const { treeIndex } = await tsImport("../../viewer/src/utils/screen-tree.ts", import.meta.url);
  const screens = [
    screen("home", "Home", 0, { route: "/" }),
    screen("patterns", "Patterns", 1, { route: "/patterns" }),
    screen("detail", "Detail", 2, { route: "/p/[d]" }),
    screen("tempo", "Tempo", 1, { route: "/tempo" }),
  ];
  const routeFiles = new Map([
    ["home", "app/(tabs)/(sequencer)/index.tsx"],
    ["patterns", "app/(tabs)/(patterns)/patterns.tsx"],
    ["detail", "app/(tabs)/(patterns)/p/[d].tsx"],
    ["tempo", "app/tempo.tsx"],
  ]);
  const shape = treeIndex(screenTree(screens, indexMap(map({ screens })), routeFiles).tree);
  assert.deepEqual(shape.keys, ["folder:(tabs)", "folder:(tabs)/(sequencer)", "folder:(tabs)/(patterns)", "folder:(tabs)/(patterns)/p"]);
  assert.deepEqual(shape.screensUnder.get("folder:(tabs)"), ["home", "patterns", "detail"]);
  assert.deepEqual(shape.ancestors.get("detail"), ["folder:(tabs)", "folder:(tabs)/(patterns)", "folder:(tabs)/(patterns)/p"]);
  assert.deepEqual(shape.ancestors.get("tempo"), []);
  assert.equal(shape.parents.get("folder:(tabs)/(patterns)/p"), "folder:(tabs)/(patterns)");
  assert.equal(shape.parents.has("folder:(tabs)"), false);
});

test("in a black-box tree, a screen with screens opened from it folds under its own key", async () => {
  const { treeIndex } = await tsImport("../../viewer/src/utils/screen-tree.ts", import.meta.url);
  const screens = [screen("seq", "Sequencer", 0), screen("new", "New Pattern", 1)];
  const transitions = [transition("t1", "seq", "new", 1)];
  const shape = treeIndex(screenTree(screens, indexMap(map({ screens, transitions }))).tree);
  assert.deepEqual(shape.keys, ["screen:seq"]);
  assert.deepEqual(shape.screensUnder.get("screen:seq"), ["new"]);
  assert.deepEqual(shape.ancestors.get("new"), ["screen:seq"]);
});
