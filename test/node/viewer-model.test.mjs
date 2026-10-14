import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const model = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);

function mapWith(overrides = {}) {
  return {
    screens: [],
    variants: [],
    observations: [],
    artifacts: [],
    elements: [],
    actionAttempts: [],
    transitions: [],
    ...overrides,
  };
}

test("variant helpers preserve authored order and select the latest screenshot observation", () => {
  const screen = { id: "screen-a", variantIds: ["variant-b", "variant-a"] };
  const variantA = {
    id: "variant-a",
    screenId: screen.id,
    observationIds: ["observation-old", "observation-new"],
  };
  const variantB = { id: "variant-b", screenId: screen.id, observationIds: ["observation-b"] };
  const index = model.indexMap(mapWith({
    screens: [screen],
    variants: [variantA, variantB],
    observations: [
      { id: "observation-old", capturedAt: "2026-01-01T00:00:00.000Z", screenshotArtifactId: "old" },
      { id: "observation-new", capturedAt: "2026-01-02T00:00:00.000Z", screenshotArtifactId: "new" },
      { id: "observation-b", capturedAt: "2026-01-03T00:00:00.000Z", screenshotArtifactId: "b" },
    ],
    artifacts: [{ id: "old" }, { id: "new" }, { id: "b" }],
  }));

  assert.deepEqual(model.variantsForScreen(screen, index).map((variant) => variant.id), [
    "variant-b",
    "variant-a",
  ]);
  assert.equal(model.screenshotForVariant(variantA, index)?.id, "new");
});

test("self-loop transitions stay addressable without appearing as screen navigation", () => {
  const loop = { id: "loop", fromScreenId: "screen-a", toScreenId: "screen-a" };
  const next = { id: "next", fromScreenId: "screen-a", toScreenId: "screen-b" };
  const index = model.indexMap(mapWith({ transitions: [loop, next] }));

  assert.equal(index.transitions.get("loop"), loop);
  assert.deepEqual(index.outgoing.get("screen-a"), [next]);
  assert.deepEqual(index.incoming.get("screen-a"), undefined);
  assert.deepEqual(index.incoming.get("screen-b"), [next]);
});
