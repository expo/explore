import assert from "node:assert/strict";
import test from "node:test";

// The viewer is bundled by Vite, not compiled into dist, so the routing module is loaded
// straight from source through tsx (already a devDependency). It is DOM-free by design.
const { tsImport } = await import("tsx/esm/api");
const nav = await tsImport("../../viewer/src/utils/navigation.ts", import.meta.url);

const ctx = {
  defaultBaseline: "build-1.0.0",
  baselines: ["build-1.0.0"],
  screenRoutes: nav.screenRoutesOf([
    { id: "settings-root", route: "/" },
    { id: "apps", route: "/(tabs)/settings/apps" },
    { id: "apps-logged-out", route: "(tabs)/settings/apps/" },
    { id: "item", route: "/items/[id]" },
    { id: "accessibility" },
  ]),
  screenVariants: nav.screenVariantsOf([
    { id: "settings-root", variantIds: ["settings-top", "settings-lower"] },
    { id: "apps", variantIds: ["apps-default"] },
    { id: "apps-logged-out", variantIds: ["apps-logged-out-default"] },
    { id: "item", variantIds: ["item-default"] },
    { id: "accessibility", variantIds: ["accessibility-data"] },
  ]),
  screenRouteAliases: new Map([
    ["/legacy/settings/lower", { screenId: "settings-root", variantId: "settings-lower" }],
  ]),
};

const base = {
  canvas: "map",
  inspect: "session",
  direction: "out",
  baseline: "build-1.0.0",
  focus: [],
  expandedGroups: [],
};

function parse(url) {
  return nav.parseLocation(new URL(url, "http://127.0.0.1"), ctx);
}

test("the default view formats as the bare canvas path", () => {
  assert.equal(nav.formatRoute(base, ctx), "/map");
  assert.deepEqual(parse("/"), base);
  assert.deepEqual(parse("/nope/what"), base);
  assert.deepEqual(parse("/map/"), base);
});

test("every parameter round-trips and defaults are left out", () => {
  const route = {
    ...base,
    canvas: "screens",
    screen: "accessibility",
    inspect: "diff",
    direction: "in",
    evidence: "data",
    variant: "accessibility-data",
    baseline: "build-1.0.0",
    focus: ["added", "removed"],
      expandedGroups: [],
  };
  const url = nav.formatRoute(route, ctx);
  assert.equal(
    url,
    "/screens?screen=accessibility&inspect=diff&dir=in&evidence=data&variant=accessibility-data&focus=added,removed",
  );
  assert.deepEqual(parse(url), route);
});

test("viewer sanitization drops Diff without a baseline", () => {
  assert.deepEqual(nav.sanitizeViewerRoute({
    ...base,
    inspect: "review",
    baseline: "",
  }), { ...base, baseline: "" });

  const visible = { ...base, canvas: "screens", screen: "accessibility" };
  assert.equal(nav.sanitizeViewerRoute(visible), visible);
});

test("links into the removed Comments and Insights surfaces open the default view", () => {
  assert.deepEqual(parse("/#insights"), base);
  assert.deepEqual(parse("/#comments"), base);
  assert.deepEqual(
    parse("/screens?panel=comments&inspect=comments&comment=thread-42&scope=screen"),
    { ...base, canvas: "screens" },
  );
  assert.equal(nav.formatRoute(parse("/map?panel=insights&comment=thread-42"), ctx), "/map");
});

test("links into the removed Live panel open the default view", () => {
  assert.deepEqual(parse("/map?panel=live"), base);
  assert.equal(nav.formatRoute(parse("/map?panel=live"), ctx), "/map");
});

test("a valid screen variant round-trips and an invalid one is discarded", () => {
  const route = { ...base, screen: "settings-root", variant: "settings-lower" };
  assert.equal(nav.formatRoute(route, ctx), "/map?screen=settings-root&variant=settings-lower");
  assert.deepEqual(parse(nav.formatRoute(route, ctx)), route);
  assert.deepEqual(parse("/map?screen=settings-root&variant=not-a-variant"), {
    ...base,
    screen: "settings-root",
  });
  assert.deepEqual(parse("/map?variant=settings-lower"), base);
});

test("a historical capture route resolves to its canonical screen and exact variant", () => {
  const parsed = parse("/map/legacy/settings/lower?evidence=ui");
  assert.deepEqual(parsed, {
    ...base,
    screen: "settings-root",
    evidence: "ui",
    variant: "settings-lower",
  });
  assert.equal(
    nav.formatRoute(parsed, ctx),
    "/map?screen=settings-root&evidence=ui&variant=settings-lower",
  );
});

test("a screen with a unique route is named by its route alone", () => {
  assert.equal(nav.formatRoute({ ...base, screen: "item" }, ctx), "/map/items/[id]");
  const parsed = parse("/map/items/[id]");
  assert.equal(parsed.screenRoute, "/items/[id]");
  assert.equal(parsed.screen, undefined);
  assert.equal(nav.resolveScreenId(parsed, ctx), "item");
  // Escaped segments read the same.
  assert.equal(nav.resolveScreenId(parse("/map/items/%5Bid%5D"), ctx), "item");
});

test("a shared route names its first screen; the others keep their id", () => {
  assert.equal(nav.formatRoute({ ...base, screen: "apps" }, ctx), "/map/(tabs)/settings/apps");
  assert.equal(
    nav.formatRoute({ ...base, screen: "apps-logged-out" }, ctx),
    "/map/(tabs)/settings/apps?screen=apps-logged-out",
  );
  const parsed = parse("/map/(tabs)/settings/apps?screen=apps-logged-out");
  assert.equal(parsed.screen, "apps-logged-out");
  assert.equal(parsed.screenRoute, undefined);
  // Without the id the first screen recorded under the route answers.
  assert.equal(nav.resolveScreenId(parse("/map/(tabs)/settings/apps"), ctx), "apps");
  assert.equal(nav.formatRoute({ ...base, screen: "settings-root" }, ctx), "/map?screen=settings-root");
});

test("a screen family canonicalizes historical ids while preserving an exact variant", () => {
  const familyCtx = {
    ...ctx,
    screenIdAliases: new Map([["apps-logged-out", "apps"]]),
    screenIdAliasVariants: new Map([["apps-logged-out", "apps-logged-out-default"]]),
    screenVariants: nav.screenVariantsOf([
      { id: "settings-root", variantIds: ["settings-top", "settings-lower"] },
      { id: "apps", variantIds: ["apps-default", "apps-logged-out-default"] },
      { id: "item", variantIds: ["item-default"] },
      { id: "accessibility", variantIds: ["accessibility-data"] },
    ]),
  };
  const parsed = nav.parseLocation(
    new URL(
      "/screens?screen=apps-logged-out&variant=apps-logged-out-default",
      "http://127.0.0.1",
    ),
    familyCtx,
  );

  assert.equal(parsed.screen, "apps");
  assert.equal(parsed.variant, "apps-logged-out-default");
  assert.equal(nav.resolveScreenId(parsed, familyCtx), "apps");
  assert.equal(
    nav.formatRoute(parsed, familyCtx),
    "/screens/(tabs)/settings/apps?variant=apps-logged-out-default",
  );

  const defaulted = nav.parseLocation(
    new URL("/screens?screen=apps-logged-out", "http://127.0.0.1"),
    familyCtx,
  );
  assert.equal(defaulted.screen, "apps");
  assert.equal(defaulted.variant, "apps-logged-out-default");
  assert.equal(
    nav.formatRoute(defaulted, familyCtx),
    "/screens/(tabs)/settings/apps?variant=apps-logged-out-default",
  );
});

test("a screen without a route, or one the map does not know yet, travels as an id", () => {
  assert.equal(nav.formatRoute({ ...base, screen: "accessibility" }, ctx), "/map?screen=accessibility");
  assert.equal(nav.formatRoute({ ...base, screen: "not-yet" }, ctx), "/map?screen=not-yet");
  // An unresolved route is preserved verbatim so it can resolve once the screen is recorded.
  const pending = parse("/screens/(tabs)/later");
  assert.equal(nav.resolveScreenId(pending, ctx), undefined);
  assert.equal(nav.formatRoute(pending, ctx), "/screens/(tabs)/later");
});

test("legacy hashes still parse", () => {
  assert.deepEqual(parse("/#workspace"), base);
  assert.deepEqual(parse("/#workspace/screens"), { ...base, canvas: "screens" });
  // Flows was retired; its links land on the map.
  assert.deepEqual(parse("/#workspace/flows"), base);
  assert.deepEqual(parse("/flows?flow=derived-apps"), base);
  assert.deepEqual(parse("/#workspace/graph"), base);
  assert.deepEqual(parse("/map?panel=workspace"), base);
  assert.equal(nav.formatRoute(parse("/map?panel=workspace"), ctx), "/map");
  assert.deepEqual(parse("/#screens"), { ...base, canvas: "screens" });
  assert.deepEqual(parse("/#garbage"), base);
});

test("legacy Review links canonicalize to Diff while Diff and focus still need a baseline", () => {
  assert.deepEqual(parse("/map?inspect=review&focus=added&baseline=none"), { ...base, baseline: "" });
  assert.equal(nav.formatRoute(parse("/map?inspect=review"), ctx), "/map?inspect=diff");
  assert.equal(nav.formatRoute({ ...base, inspect: "review" }, ctx), "/map?inspect=diff");
  assert.equal(nav.formatRoute({ ...base, inspect: "diff" }, ctx), "/map?inspect=diff");
  assert.equal(
    nav.formatRoute({ ...base, inspect: "diff", baseline: "" }, ctx),
    "/map?baseline=none",
  );
  assert.equal(nav.formatRoute({ ...base, baseline: "" }, ctx), "/map?baseline=none");
  assert.deepEqual(parse("/map?baseline=pr-999"), base);
  assert.deepEqual(parse("/map?baseline=pr-999&inspect=diff"), { ...base, inspect: "diff" });
  assert.deepEqual(parse("/map?baseline=build-1.0.0&inspect=review"), {
    ...base,
    inspect: "diff",
  });
});

test("focus is deduplicated and kept in a fixed order", () => {
  assert.deepEqual(parse("/map?focus=removed,added,removed,bogus").focus, ["added", "removed"]);
  assert.equal(nav.formatRoute({ ...base, focus: ["removed", "added"] }, ctx), "/map?focus=added,removed");
});

test("legacy Graph URLs canonicalize to Map without reviving removed Graph scope", () => {
  assert.deepEqual(parse("/graph"), base);
  assert.equal(nav.formatRoute(parse("/graph"), ctx), "/map");

  const selected = parse(
    "/graph/items/[id]?inspect=review&flow=derived-apps&expand=chain%3Aa&detail=branch&area=area-a&branch=branch-a",
  );
  assert.deepEqual(selected, {
    ...base,
    screenRoute: "/items/[id]",
    inspect: "diff",
  });
  assert.equal(
    nav.formatRoute(selected, ctx),
    "/map/items/[id]?inspect=diff",
  );

  assert.equal(nav.formatRoute({ ...base, canvas: "graph" }, ctx), "/map");
});

test("semantic Map scope is discarded by non-Map canvases", () => {
  for (const canvas of ["screens", "compare"]) {
    const parsed = parse(`/${canvas}?detail=branch&area=area-a&branch=branch-a`);
    assert.deepEqual(parsed, { ...base, canvas });
    assert.equal(nav.formatRoute(parsed, ctx), `/${canvas}`);
  }
});

test("Screens' filmstrip layout round-trips, and other canvases and unknown layouts drop it", () => {
  const route = { ...base, canvas: "screens", screen: "accessibility", layout: "filmstrip" };
  assert.equal(nav.formatRoute(route, ctx), "/screens?screen=accessibility&layout=filmstrip");
  assert.deepEqual(parse("/screens?screen=accessibility&layout=filmstrip"), route);
  // The grid is the default, so it is never written.
  assert.equal(nav.formatRoute({ ...base, canvas: "screens", layout: "grid" }, ctx), "/screens");
  assert.deepEqual(parse("/screens?layout=grid"), { ...base, canvas: "screens" });
  assert.deepEqual(parse("/screens?layout=nope"), { ...base, canvas: "screens" });
  for (const canvas of ["map", "compare"]) {
    assert.equal(nav.formatRoute({ ...base, canvas, layout: "filmstrip" }, ctx), `/${canvas}`);
    assert.deepEqual(parse(`/${canvas}?layout=filmstrip`), { ...base, canvas });
  }
});

test("ids with reserved characters survive the query", () => {
  const route = { ...base, screen: "removed:a+b%c" };
  assert.deepEqual(parse(nav.formatRoute(route, ctx)), route);
});

test("unknown values fall back without disturbing the rest", () => {
  assert.deepEqual(
    parse("/screens?panel=nope&inspect=nope&dir=nope&scope=nope&screen=%20"),
    { ...base, canvas: "screens" },
  );
});

test("another target's report opens at the same canvas and route, keeping only what means the same there", () => {
  assert.equal(nav.placeForAnotherTarget("#/compare/settings/profile?screen=s-12&variant=v2&baseline=build-0.9&inspect=diff&focus=modified,added&dir=in&expand=g1&evidence=logs"),
    "#/compare/settings/profile?inspect=diff&dir=in&focus=modified,added");
  assert.equal(nav.placeForAnotherTarget("#/map/home"), "#/map/home");
  assert.equal(nav.placeForAnotherTarget("#/screens?screen=s-3"), "#/screens");
  assert.equal(nav.placeForAnotherTarget("#/screens?screen=s-3&layout=filmstrip"), "#/screens?layout=filmstrip");
  // No place, or a hash from before routes: the other report opens where a link to it would.
  assert.equal(nav.placeForAnotherTarget(""), "");
  assert.equal(nav.placeForAnotherTarget("#map"), "");
});
