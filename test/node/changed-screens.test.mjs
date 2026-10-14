import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { isVisibleChange } = await tsImport("../../viewer/src/utils/changed-screens.ts", import.meta.url);

test("only a change the captures show counts for Compare and Screens' Changed filter", () => {
  assert.equal(isVisibleChange({ status: "added" }), true);
  assert.equal(isVisibleChange({ status: "removed" }), true);
  assert.equal(isVisibleChange({ status: "modified" }), true);
  // The source changed but the captures look the same.
  assert.equal(isVisibleChange({ status: "modified", notVisible: true }), false);
  assert.equal(isVisibleChange({ status: "needs-review" }), false);
  assert.equal(isVisibleChange({ status: "source-affected" }), false);
  assert.equal(isVisibleChange({ status: "unchanged" }), false);
  assert.equal(isVisibleChange(undefined), false);
});
