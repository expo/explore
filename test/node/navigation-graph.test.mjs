import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { NAVIGATION_GRAPH_CONTRACT, validateNavigationGraph, navigationContext, navigationCaptureContext } =
  await tsImport("../../src/contracts/navigation-graph.ts", import.meta.url);

const edge = (from, to, extra = {}) => ({
  from, to, kind: "push", sourceFile: "src/screens/home.tsx", provenance: "source", ...extra,
});
const graph = (edges = [], extra = {}) => ({
  contract: NAVIGATION_GRAPH_CONTRACT, edges, modalSurfaceIds: [], unresolved: [], ...extra,
});

test("validates all source navigation kinds and returns an independent projection", () => {
  const input = graph(["push", "replace", "navigate", "redirect", "tab", "dismissTo"]
    .map((kind) => edge("home", "settings", { kind })), {
    modalSurfaceIds: ["settings"], unresolved: ["src/screens/home.tsx: dynamic destination"],
  });
  const result = validateNavigationGraph(input, ["home", "settings"]);
  assert.deepEqual(result, input);
  input.edges[0].to = "other";
  input.modalSurfaceIds.push("other");
  input.unresolved.push("other");
  assert.equal(result.edges[0].to, "settings");
  assert.deepEqual(result.modalSurfaceIds, ["settings"]);
  assert.equal(result.unresolved.length, 1);
});

test("requires every graph and edge field and rejects unsupported fields", () => {
  for (const field of ["contract", "edges", "modalSurfaceIds", "unresolved"]) {
    const input = graph();
    delete input[field];
    assert.throws(() => validateNavigationGraph(input));
  }
  for (const field of ["from", "to", "kind", "sourceFile", "provenance"]) {
    const input = edge("home", "settings");
    delete input[field];
    assert.throws(() => validateNavigationGraph(graph([input])));
  }
  assert.throws(() => validateNavigationGraph({ ...graph(), observed: true }), /unsupported fields/);
  assert.throws(() => validateNavigationGraph(graph([edge("home", "settings", { action: "tap" })])), /unsupported fields/);
  assert.throws(() => validateNavigationGraph(graph([], { contract: "unrecognized" })), /contract/);
  for (const value of [null, [], "graph"]) assert.throws(() => validateNavigationGraph(value), /object/);
  assert.throws(() => validateNavigationGraph(Object.create(graph())), /missing/);
  assert.throws(() => validateNavigationGraph(graph(Array(1))), /object/);
});

test("rejects unsafe identifiers and source paths, and never accepts inferred back edges", () => {
  for (const id of ["", "../secret", "home/other", "home\n", "x".repeat(513)]) {
    assert.throws(() => validateNavigationGraph(graph([edge(id, "settings")])));
    assert.throws(() => validateNavigationGraph(graph([], { modalSurfaceIds: [id] })));
  }
  for (const sourceFile of ["", "/etc/passwd", "../outside.ts", "src/../outside.ts", "src//home.ts", "src/./home.ts",
    "src\\home.ts", "C:/home.ts", "https://example.com/home.ts", "src/home\u0000.ts", "x".repeat(4_097)]) {
    assert.throws(() => validateNavigationGraph(graph([edge("home", "settings", { sourceFile })])), /safe repository-relative/);
  }
  for (const kind of ["back", "dismiss", "openURL", null]) {
    assert.throws(() => validateNavigationGraph(graph([edge("home", "settings", { kind })])), /kind/);
  }
  assert.throws(() => validateNavigationGraph(graph([edge("home", "settings", { provenance: "observed" })])), /provenance/);
});

test("checks edge and modal references against the supplied side inventory", () => {
  const input = graph([edge("home", "removed")]);
  assert.deepEqual(validateNavigationGraph(input, ["home", "removed"]), input);
  assert.throws(() => validateNavigationGraph(input, ["home", "added"]), /unknown surface removed/);
  assert.throws(() => validateNavigationGraph(graph([], { modalSurfaceIds: ["settings"] }), []), /unknown surface/);
  assert.throws(() => validateNavigationGraph(graph([edge("home", "settings"), edge("home", "settings")])), /repeats a navigation edge/);
  assert.throws(() => validateNavigationGraph(graph([], { modalSurfaceIds: ["home", "home"] })), /repeats surface/);
});

test("bounds graph size, inventory size, and unresolved diagnostics", () => {
  assert.throws(() => validateNavigationGraph(graph(Array(50_001).fill(edge("a", "b")))), /at most 50000/);
  assert.throws(() => validateNavigationGraph(graph(Array.from({ length: 5_000 }, (_, index) => edge("home", `node-${index}`)))), /at most 5000 nodes/);
  assert.throws(() => validateNavigationGraph(graph(), Array.from({ length: 5_001 }, (_, index) => `node-${index}`)), /at most 5000 identifiers/);
  assert.throws(() => validateNavigationGraph(graph([], { modalSurfaceIds: Array(5_001).fill("home") })), /at most 5000/);
  assert.throws(() => validateNavigationGraph(graph([], { unresolved: Array(5_001).fill("unresolved route") })), /at most 5000/);
  for (const message of ["", "   ", "unsafe\nmessage", "x".repeat(1_025), null]) {
    assert.throws(() => validateNavigationGraph(graph([], { unresolved: [message] })), /non-empty message/);
  }
});

test("adds routes one navigation step before or after a seed, not their ancestors or descendants", () => {
  const input = graph([
    edge("root", "parent"), edge("parent", "changed"), edge("parent", "sibling"),
    edge("changed", "child"), edge("child", "leaf"), edge("other-parent", "child"),
  ]);
  const inventory = ["root", "parent", "changed", "sibling", "child", "leaf", "other-parent", "unrelated"];
  assert.deepEqual(navigationContext(input, ["changed"], inventory), ["changed", "child", "parent"]);
});

test("handles cycles, deduplicates seeds, and retains isolated affected surfaces", () => {
  const input = graph([edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "a")]);
  assert.deepEqual(navigationContext(input, ["b", "b", "isolated"], ["a", "b", "c", "isolated"]), ["a", "b", "c", "isolated"]);
  assert.deepEqual(navigationContext(input, ["a"], ["a", "b", "c", "d"]), ["a", "b", "c"]);
  assert.deepEqual(navigationContext(input, [], ["a", "b", "c"]), []);
  assert.deepEqual(navigationContext(input, ["head-only"], ["a", "b", "c"]), []);
});

test("computes separate base and head context for added and removed destinations", () => {
  const seeds = ["added", "removed"];
  assert.deepEqual(navigationContext(graph([edge("games", "removed")]), seeds, ["games", "removed"]), ["games", "removed"]);
  assert.deepEqual(navigationContext(graph([edge("cats", "added")]), seeds, ["cats", "added"]), ["added", "cats"]);
  assert.throws(() => navigationContext(graph([edge("games", "removed")]), seeds, ["games", "added"]), /unknown surface removed/);
});

test("stays bounded on a maximum-size route chain", () => {
  const ids = Array.from({ length: 5_000 }, (_, index) => `node-${index}`);
  const input = graph(ids.slice(1).map((id, index) => edge(ids[index], id)));
  assert.deepEqual(navigationContext(input, ["node-2500"], ids), ["node-2499", "node-2500", "node-2501"]);
});

test("a guarded, strongly connected app selects a strict subset: redirects are not steps", () => {
  // Every signed-in screen redirects to sign-in through its group layout, sign-in's layout sends a
  // signed-in visit Home, and the tabs connect everything else: one strongly connected component.
  const signedIn = ["home", "activity", "settings", "paywall", "receipt"];
  const entries = [
    { id: "start", routeFile: "src/app/index.tsx" },
    { id: "sign-in", routeFile: "src/app/auth/sign-in.tsx" },
    { id: "forgot", routeFile: "src/app/auth/forgot.tsx" },
    ...signedIn.map((id) => ({ id, routeFile: `src/app/(app)/${id}.tsx` })),
  ];
  const input = graph([
    ...signedIn.map((id) => edge(id, "sign-in", { kind: "redirect", sourceFile: "src/app/(app)/_layout.tsx" })),
    edge("sign-in", "home", { kind: "redirect", sourceFile: "src/app/auth/_layout.tsx" }),
    edge("start", "sign-in", { kind: "replace", sourceFile: "src/app/index.tsx" }),
    edge("sign-in", "forgot", { sourceFile: "src/app/auth/sign-in.tsx" }),
    edge("home", "activity", { kind: "tab", sourceFile: "src/app/(app)/_layout.tsx" }),
    edge("activity", "home", { kind: "tab", sourceFile: "src/app/(app)/_layout.tsx" }),
    edge("home", "settings", { kind: "tab", sourceFile: "src/app/(app)/_layout.tsx" }),
    edge("settings", "home", { kind: "tab", sourceFile: "src/app/(app)/_layout.tsx" }),
    edge("home", "paywall", { sourceFile: "src/app/(app)/home.tsx" }),
    edge("activity", "receipt", { sourceFile: "src/app/(app)/activity.tsx" }),
  ]);
  const all = entries.map((entry) => entry.id).sort();
  assert.deepEqual(navigationCaptureContext(input, ["sign-in"], entries), ["forgot", "sign-in", "start"]);
  assert.deepEqual(navigationCaptureContext(input, ["paywall"], entries), ["home", "paywall"]);
  // A guard written inside a screen is still a guard, not a step.
  const screenGuard = graph([edge("receipt", "sign-in", { kind: "redirect", sourceFile: "src/app/(app)/receipt.tsx" })]);
  assert.deepEqual(navigationCaptureContext(screenGuard, ["sign-in"], entries), ["sign-in"]);
  assert.notDeepEqual(navigationCaptureContext(input, ["sign-in", "paywall"], entries), all);
});

test("changed forwarding routes include their destinations without widening guard or screen context", () => {
  const entries = ["start", "alias", "home", "sign-in", "receipt", "next"].map(id => ({
    id, routeFile: `src/app/${id}.tsx`, kind: id === "start" || id === "alias" ? "redirect" : "screen",
  }));
  const input = graph([
    edge("start", "home", { kind: "redirect" }),
    edge("alias", "home", { kind: "redirect" }),
    edge("receipt", "sign-in", { kind: "redirect" }),
    edge("home", "next"),
  ]);
  assert.deepEqual(navigationCaptureContext(input, ["start"], entries), ["home", "start"]);
  assert.deepEqual(navigationCaptureContext(input, ["home"], entries), ["home", "next"]);
  assert.deepEqual(navigationCaptureContext(input, ["receipt"], entries), ["receipt"]);
  assert.deepEqual(navigationCaptureContext(input, ["sign-in"], entries), ["sign-in"]);
});

test("forwarding chains stop at screens and terminate cycles without widening navigation", () => {
  const entries = ["start", "alias", "home", "next", "sign-in"].map(id => ({
    id, routeFile: `src/app/${id}.tsx`, kind: id === "start" || id === "alias" ? "redirect" : "screen",
  }));
  const input = graph([
    edge("start", "alias", { kind: "redirect" }),
    edge("alias", "start", { kind: "redirect" }),
    edge("alias", "home", { kind: "replace" }),
    edge("home", "next"),
    edge("home", "sign-in", { kind: "redirect" }),
  ]);
  assert.deepEqual(navigationCaptureContext(input, ["start"], entries), ["alias", "home", "start"]);
  assert.deepEqual(navigationCaptureContext(graph(input.edges.slice(0, 2)), ["start"], entries), ["alias", "start"]);
});

test("capture context expands same-route variants after traversal without restarting graph expansion", () => {
  const input = graph([edge("root", "settings-pro"), edge("root", "sibling"), edge("settings-free", "paywall")]);
  const entries = [
    { id: "root", routeFile: "src/app/index.tsx" },
    { id: "settings-pro", routeFile: "src/app/settings.tsx" },
    { id: "settings-free", routeFile: "src/app/settings.tsx" },
    { id: "settings-language", routeFile: "src/app/settings.tsx" },
    { id: "sibling", routeFile: "src/app/other.tsx" },
    { id: "paywall", routeFile: "src/app/paywall.tsx" },
  ];
  assert.deepEqual(navigationCaptureContext(input, ["settings-pro"], entries), ["root", "settings-free", "settings-language", "settings-pro"]);
});

test("unresolved navigation requires full capture while history-dependent back actions do not", () => {
  const entries = ["a", "b", "c"].map((id) => ({ id, routeFile: `src/app/${id}.tsx` }));
  const edges = [edge("a", "b")];
  assert.deepEqual(navigationCaptureContext(graph(edges, {
    unresolved: ["Unresolved navigation: src/screens/a.tsx has a dynamic destination"],
  }), ["b"], entries), ["a", "b", "c"]);
  assert.deepEqual(navigationCaptureContext(graph(edges, {
    unresolved: ["History-dependent navigation: src/screens/a.tsx calls router.back()"],
  }), ["b"], entries), ["a", "b"]);
  assert.deepEqual(navigationCaptureContext(graph(edges), [], entries), []);
});

test("unresolved destinations do not schedule capture without a seed present on that side", () => {
  const input = graph([edge("home", "settings")], {
    unresolved: ["Unresolved navigation: src/screens/home.tsx has a dynamic destination"],
  });
  const entries = ["home", "settings"].map((id) => ({ id, routeFile: `src/app/${id}.tsx` }));
  assert.deepEqual(navigationCaptureContext(input, [], entries), []);
  assert.deepEqual(navigationCaptureContext(input, ["head-only"], entries), []);
  assert.deepEqual(navigationCaptureContext(input, ["head-only", "settings"], entries), ["home", "settings"]);
});

test("capture context validates bounded entries and graph references before falling back", () => {
  const entry = { id: "home", routeFile: "src/app/index.tsx" };
  assert.throws(() => navigationCaptureContext(graph(), [], [entry, entry]), /repeats surface/);
  assert.throws(() => navigationCaptureContext(graph(), [], [{ ...entry, routeFile: "../outside.tsx" }]), /safe repository-relative/);
  assert.throws(() => navigationCaptureContext(graph(), [], Array(5_001).fill(entry).map((value, index) => ({ ...value, id: `node-${index}` }))), /at most 5000/);
  assert.throws(() => navigationCaptureContext(graph([edge("home", "unknown")], {
    unresolved: ["Unresolved navigation: dynamic destination"],
  }), ["home"], [entry]), /unknown surface/);
});
