import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const model = await tsImport("../../viewer/src/utils/flows-model.ts", import.meta.url);

const shot = (sha, text) => ({ screenshot: `assets/${sha.padStart(64, "0")}.png`, ...(text ? { text } : {}) });
const steps = [{ action: 'tap "Settings"' }, { checkpoint: "Settings" }, { do: "Open the output picker" }, { checkpoint: "Output" }, { do: "Close it" }, { do: "Open the input picker" }, { checkpoint: "Input" }];

const completed = { name: "Connect", before: { status: "completed", steps }, after: { status: "completed", steps }, checkpoints: [
  { name: "Settings", verdict: "unchanged", before: shot("1"), after: shot("2") },
  { name: "Output", verdict: "changed", before: shot("3", ["Output", "No outputs over USB-C."]), after: shot("4", ["Output", "No outputs over USB-C or Bluetooth."]), regions: [{ x: 1, y: 2, width: 3, height: 4 }] },
  { name: "Input", verdict: "unchanged", before: shot("5"), after: shot("6") },
] };
const stopped = { name: "Share", before: { status: "completed", steps }, after: { status: "failed", reason: "The model used its 40 tool calls without finishing the step.", steps, failedStep: 3 }, checkpoints: [
  { name: "Settings", verdict: "changed", before: shot("7"), after: shot("8") },
  { name: "Output", verdict: "missing", before: shot("9"), after: { missing: "The flow did not reach it." } },
  { name: "Input", verdict: "missing", before: shot("a"), after: { missing: "The flow did not reach it." } },
] };
const quiet = { name: "Edit", before: { status: "completed" }, after: { status: "completed" }, checkpoints: [{ name: "Home", verdict: "unchanged", before: shot("b"), after: shot("c") }] };
const review = { before: {}, after: {}, conditions: [], notes: [], flows: [completed, stopped, quiet] };

test("Changed keeps every flow with a checkpoint that is not unchanged, and every run that stopped; All keeps every flow", () => {
  assert.deepEqual(model.visibleFlows(review, "changed").map(flow => flow.name), ["Connect", "Share"]);
  assert.deepEqual(model.visibleFlows(review, "all").map(flow => flow.name), ["Connect", "Share", "Edit"]);
  const stoppedWithoutChanges = { ...quiet, after: { status: "stopped" } };
  assert.equal(model.flowNeedsReview(stoppedWithoutChanges), true, "a stopped run is never hidden by the filter");
});

test("a flow's mark and status line say whether it stopped, then how many checkpoints of each kind", () => {
  assert.equal(model.flowMark(completed), "changed");
  assert.equal(model.flowStatusLine(completed), "1 changed");
  assert.equal(model.flowMark(stopped), "stopped");
  assert.equal(model.flowStatusLine(stopped), "Stopped · 2 not reached · 1 changed");
  assert.equal(model.flowMark(quiet), "unchanged");
  assert.equal(model.flowStatusLine(quiet), "Unchanged");
  assert.equal(model.flowMark({ ...quiet, before: undefined }), "added");
  assert.equal(model.flowMark({ ...quiet, after: undefined }), "removed");
});

test("a flow opens at its first problem", () => {
  assert.equal(model.firstProblem(completed), 1);
  assert.deepEqual(model.problemIndexes(stopped), [0, 1, 2]);
  assert.equal(model.firstProblem(quiet), 0, "a flow with nothing changed opens at its first checkpoint");
});

test("a missing picture says which build has none", () => {
  assert.equal(model.checkpointLabel(stopped.checkpoints[1]), "Not reached");
  const reachedOnlyAfter = { name: "Output", verdict: "missing", before: { missing: "The flow did not reach it." }, after: shot("d") };
  assert.equal(model.checkpointLabel(reachedOnlyAfter), "Not reached before");
  assert.equal(model.checkpointMark({ name: "Rotated", verdict: "different-size" }), "not-comparable");
});

test("the steps before a checkpoint are the ones since the previous checkpoint, with the failed one and those never run marked", () => {
  assert.deepEqual(model.stepsBefore(completed, 0), [{ step: { action: 'tap "Settings"' }, failed: false, ran: true }]);
  assert.deepEqual(model.stepsBefore(completed, 2).map(item => item.step), [{ do: "Close it" }, { do: "Open the input picker" }]);
  assert.deepEqual(model.stepsBefore(stopped, 1), [{ step: { do: "Open the output picker" }, failed: true, ran: true }]);
  assert.deepEqual(model.stepsBefore(stopped, 2).map(item => item.ran), [false, false]);
  assert.deepEqual(model.stepsBefore(quiet, 0), [], "a run from before steps were recorded has none to show");
});

test("text changes are the lines one build's screen showed and the other's did not", () => {
  assert.deepEqual(model.textChanges(completed.checkpoints[1]), { removed: ["No outputs over USB-C."], added: ["No outputs over USB-C or Bluetooth."] });
  assert.equal(model.textChanges(completed.checkpoints[0]), undefined, "without the text of both screens there is nothing to compare");
  assert.equal(model.textChanges(stopped.checkpoints[1]), undefined);
});

test("a picture is found by the SHA-256 its asset is named with", () => {
  assert.deepEqual(model.sidePicture(shot("4")), { sha256: "4".padStart(64, "0") });
  assert.deepEqual(model.sidePicture({ missing: "Blocked." }), { missing: "Blocked." });
  assert.equal(model.sidePicture(undefined), undefined);
});

test("a text-sized change is spelled out in one line; a larger one is read off the picture", () => {
  const changed = (before, after, height = 2) => ({ name: "Output", verdict: "changed", before: shot("3", before), after: shot("4", after), regions: [{ x: 0, y: 40, width: 50, height }] });
  assert.equal(model.textChangeLine(changed(["Output", "No outputs."], ["Output", "No outputs over USB-C."])), "“No outputs over USB-C.”, was “No outputs.”");
  assert.equal(model.textChangeLine(changed(["A"], ["A", "B", "C"])), "Adds “B” and 1 more");
  assert.equal(model.textChangeLine(changed(["A", "B"], ["A"])), "Drops “B”");
  assert.equal(model.textChangeLine(changed(["A"], ["B"], 12)), undefined, "a change taller than a line or two of text");
  assert.equal(model.textChangeLine(changed(["A"], ["A"])), undefined, "the same text, so the change is not in it");
  assert.equal(model.textChangeLine(stopped.checkpoints[0]), undefined, "without the text of both screens there is nothing to say");
});
