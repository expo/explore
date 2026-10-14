import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const model = await tsImport("../../viewer/src/utils/model.ts", import.meta.url);
const screenImages = await tsImport("../../viewer/src/utils/screen-images.ts", import.meta.url);

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

test("primary screenshots stay owned by their canonical screen and authored variant order", () => {
  const source = {
    id: "screen-source",
    variantIds: ["variant-primary", "variant-newer"],
    observationIds: ["observation-primary", "observation-newer"],
  };
  const mixed = {
    id: "screen-mixed",
    variantIds: [],
    observationIds: ["observation-mixed", "observation-primary"],
  };
  const index = model.indexMap(mapWith({
    screens: [source, mixed],
    variants: [
      {
        id: "variant-primary",
        screenId: source.id,
        observationIds: ["observation-primary"],
      },
      {
        id: "variant-newer",
        screenId: source.id,
        observationIds: ["observation-newer"],
      },
    ],
    observations: [
      {
        id: "observation-primary",
        screenId: source.id,
        variantId: "variant-primary",
        capturedAt: "2026-01-01T00:00:00.000Z",
        screenshotArtifactId: "artifact-primary",
      },
      {
        id: "observation-newer",
        screenId: source.id,
        variantId: "variant-newer",
        capturedAt: "2026-01-02T00:00:00.000Z",
        screenshotArtifactId: "artifact-newer",
      },
      {
        id: "observation-mixed",
        screenId: mixed.id,
        variantId: "variant-mixed",
        capturedAt: "2026-01-03T00:00:00.000Z",
      },
    ],
    artifacts: [
      { id: "artifact-primary" },
      { id: "artifact-newer" },
    ],
  }));

  // A later observation on a secondary state must not replace the canonical
  // screen's explicitly authored primary screenshot.
  assert.equal(screenImages.primaryScreenshotForScreen(source, index)?.id, "artifact-primary");
  // A malformed current screen with evidence from two owners cannot borrow the
  // foreign screenshot just because its id appears in observationIds.
  assert.equal(screenImages.primaryScreenshotForScreen(mixed, index), undefined);
});

test("reviewable variants skip states observed without a screenshot, unless none has one", () => {
  const screen = {
    id: "screen",
    variantIds: ["variant-tree-only", "variant-scrolled"],
    observationIds: ["observation-tree-only", "observation-scrolled"],
  };
  const artifacts = [{ id: "artifact-scrolled", kind: "screenshot", path: "artifacts/screenshots/a.png", sha256: "a" }];
  const observations = (withScreenshot) => [
    { id: "observation-tree-only", screenId: screen.id, variantId: "variant-tree-only", capturedAt: "2026-01-01T00:00:00.000Z" },
    { id: "observation-scrolled", screenId: screen.id, variantId: "variant-scrolled", capturedAt: "2026-01-01T00:00:05.000Z",
      ...(withScreenshot ? { screenshotArtifactId: "artifact-scrolled" } : {}) },
  ];
  const variants = [
    { id: "variant-tree-only", screenId: screen.id, key: "default", observationIds: ["observation-tree-only"] },
    { id: "variant-scrolled", screenId: screen.id, key: "scrolled", observationIds: ["observation-scrolled"] },
  ];

  const index = model.indexMap(mapWith({ screens: [screen], variants, observations: observations(true), artifacts }));
  assert.deepEqual(model.reviewableVariantsForScreen(screen, index).map((variant) => variant.id), ["variant-scrolled"]);

  const bare = model.indexMap(mapWith({ screens: [screen], variants, observations: observations(false), artifacts }));
  assert.deepEqual(model.reviewableVariantsForScreen(screen, bare).map((variant) => variant.id), ["variant-tree-only", "variant-scrolled"]);
});
