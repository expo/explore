import assert from "node:assert/strict";
import { captureAliasFixture } from "../helpers/viewer-map-fixture.mjs";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { deriveCaptureRouteAliases } = await tsImport(
  "../../viewer/src/utils/route-aliases.ts",
  import.meta.url,
);

const map = captureAliasFixture();

test("ordered capture routes restore variants hidden by canonical grouping", () => {
  const aliases = deriveCaptureRouteAliases(map);
  assert.deepEqual(aliases.get("/mobbin/screens/2"), {
    screenId: "home",
    variantId: "variant-capture-2",
  });
  assert.equal(aliases.has("/mobbin/screens/1"), false);
  assert.ok(aliases.size > 0);
});

test("capture aliases are not inferred when source ordering is ambiguous", () => {
  const observations = map.observations.map((observation, index) => (
    index === 1
      ? { ...observation, capturedAt: map.observations[0].capturedAt }
      : observation
  ));
  assert.equal(deriveCaptureRouteAliases({ ...map, observations }).size, 0);
});
