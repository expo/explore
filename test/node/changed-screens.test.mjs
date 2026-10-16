import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { isCapturedChange } = await tsImport("../../viewer/src/utils/changed-screens.ts", import.meta.url);

test("only a change the captures show counts for Compare and Screens' Changed filter", () => {
  assert.equal(isCapturedChange({ status: "added" }), true);
  assert.equal(isCapturedChange({ status: "removed" }), true);
  assert.equal(isCapturedChange({ status: "modified" }), true);
  // The screenshots match but the accessibility tree changed: screen readers see it, so it is reviewed.
  assert.equal(isCapturedChange({ status: "modified", accessibilityOnly: true }), true);
  // The source changed but the captures show nothing different.
  assert.equal(isCapturedChange({ status: "needs-review" }), false);
  assert.equal(isCapturedChange({ status: "source-affected" }), false);
  assert.equal(isCapturedChange({ status: "unchanged" }), false);
  assert.equal(isCapturedChange(undefined), false);
});

const { splitForAssistiveTechnology } = await tsImport("../../viewer/src/utils/presented-changes.ts", import.meta.url);

test("What changed lists what assistive technology reads under its own heading", () => {
  const change = (id, category) => ({ id, copy: id, fact: { id, category, templateId: `${category}.x`, priority: 0, evidenceRefs: [] } });
  const changes = [change("Added button “Play”.", "element"), change("Changed accessibility label.", "accessibility")];
  const ids = ({ visible, assistive }) => [visible.map(entry => entry.id), assistive.map(entry => entry.id)];
  // Pixels differ: an added element may be visible, a label is not.
  assert.deepEqual(ids(splitForAssistiveTechnology(changes, { status: "modified" })), [["Added button “Play”."], ["Changed accessibility label."]]);
  // The screenshots match: nothing on the screen looks different, so every finding is for assistive technology.
  assert.deepEqual(ids(splitForAssistiveTechnology(changes, { status: "modified", accessibilityOnly: true })), [[], ["Added button “Play”.", "Changed accessibility label."]]);
  // A reviewer note is not a finding about the accessibility tree.
  assert.deepEqual(ids(splitForAssistiveTechnology([{ id: "review-note", copy: "Note" }], { status: "modified", accessibilityOnly: true })), [["review-note"], []]);
});

const { focusCounts, focusStatusOf } = await tsImport("../../viewer/src/utils/changed-screens.ts", import.meta.url);

test("the Changes filter counts Accessibility only apart from Modified", () => {
  const screens = new Map([
    ["a", { status: "modified" }], ["b", { status: "modified", accessibilityOnly: true }], ["c", { status: "modified", accessibilityOnly: true }],
    ["d", { status: "added" }], ["e", { status: "not-compared" }], ["f", { status: "unchanged" }],
  ]);
  assert.deepEqual(focusCounts({ screens }), { added: 1, modified: 1, "accessibility-only": 2, removed: 0, "needs-review": 0, "source-affected": 0 });
  assert.equal(focusStatusOf({ status: "modified", accessibilityOnly: true }), "accessibility-only");
  assert.equal(focusStatusOf({ status: "modified" }), "modified");
  assert.equal(focusStatusOf(undefined), undefined);
});
