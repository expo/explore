import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VISIBLE_REVIEWER_CHANGE_LIMIT,
  NO_VISIBLE_CHANGE_MESSAGE,
  summarizeReviewerChanges,
} from "../../dist/review/reviewer-changes.js";

function supported(change, evidenceRefs = ["runtime:observation:1"]) {
  return { assessment: "supported", change, evidenceRefs };
}

test("renders a short CTA title change as a concise reviewer fact", () => {
  const summary = summarizeReviewerChanges({
    changes: [supported({
      kind: "visible-text-changed",
      subjectRole: "button",
      subjectLabel: "Primary CTA",
      textKind: "title",
      before: "A",
      after: "B",
    }, [" runtime:after:cta ", "runtime:before:cta"])],
  });

  assert.equal(summary.status, "ready");
  assert.equal(summary.noVisibleChange, false);
  assert.equal(summary.facts.length, 1);
  assert.deepEqual(summary.facts[0], {
    category: "visible-text",
    templateId: "visible-text.changed-short",
    bullet: "Changed button title from “A” to “B”.",
    subjectRole: "button",
    subjectLabel: "Primary CTA",
    before: "A",
    after: "B",
    priority: 30,
    evidenceRefs: ["runtime:after:cta", "runtime:before:cta"],
  });
});

test("keeps long copy out of the bullet and exposes the full before/after payload", () => {
  const before = "Before ".repeat(15).trim();
  const after = "After ".repeat(15).trim();
  const summary = summarizeReviewerChanges({
    changes: [supported({
      kind: "visible-text-changed",
      subjectRole: "text",
      subjectLabel: "Welcome message",
      textKind: "body",
      before,
      after,
    })],
  });

  assert.equal(summary.status, "ready");
  assert.equal(summary.facts[0]?.bullet, "Updated body copy in “Welcome message”.");
  assert.deepEqual(summary.facts[0]?.expandedPayload, { before, after });
  assert.doesNotMatch(summary.facts[0]?.bullet ?? "", /Before|After/);
});

test("renders supported screen, element, interaction, accessibility, and visual facts", () => {
  const summary = summarizeReviewerChanges({
    changes: [
      supported({ kind: "screen-added", screenTitle: "Cat Care Guide" }),
      supported({ kind: "screen-removed", screenTitle: "Sweet Bee" }),
      supported({ kind: "element-added", elementRole: "button", elementLabel: "Care guide" }),
      supported({ kind: "element-removed", elementRole: "card", elementLabel: "Sweet Bee" }),
      supported({
        kind: "action-target-changed",
        subjectRole: "button",
        subjectLabel: "Care guide",
        beforeTarget: "Cat details",
        afterTarget: "Cat Care Guide",
      }),
      supported({
        kind: "accessibility-label-changed",
        subjectRole: "button",
        before: "A",
        after: "B",
      }),
      supported({
        kind: "accessibility-role-changed",
        subjectLabel: "Continue",
        beforeRole: "link",
        afterRole: "button",
      }),
      supported({
        kind: "visual-changed",
        scope: { kind: "landmark", label: "Goldfish playfield" },
      }),
      supported({ kind: "visual-changed", scope: { kind: "main-content" } }),
    ],
  });

  assert.equal(summary.status, "ready");
  assert.deepEqual(summary.facts.map((fact) => fact.bullet), [
    "Added screen “Cat Care Guide”.",
    "Removed screen “Sweet Bee”.",
    "Added button “Care guide”.",
    "Removed card “Sweet Bee”.",
    "Changed “Care guide” action from “Cat details” to “Cat Care Guide”.",
    "Changed accessibility label from “A” to “B”.",
    "Changed “Continue” from a link to a button.",
    "Updated the visual appearance of “Goldfish playfield”.",
    "Updated visual styling in the main content area.",
  ]);
});

test("deduplicates repeated variants, sorts deterministically, and collapses after five facts", () => {
  const repeated = supported(
    { kind: "element-added", elementRole: "button", elementLabel: "Care guide" },
    ["runtime:variant:b", "runtime:variant:a"],
  );
  const duplicate = supported(
    { kind: "element-added", elementRole: "button", elementLabel: "Care guide" },
    ["runtime:variant:c", "runtime:variant:a"],
  );
  const changes = [
    supported({ kind: "visual-changed", scope: { kind: "main-content" } }),
    supported({
      kind: "action-target-changed",
      subjectRole: "button",
      subjectLabel: "Open",
      beforeTarget: "A",
      afterTarget: "B",
    }),
    supported({
      kind: "visible-text-changed",
      subjectRole: "heading",
      subjectLabel: "Page heading",
      textKind: "heading",
      before: "Old",
      after: "New",
    }),
    supported({ kind: "element-removed", elementRole: "card", elementLabel: "Old card" }),
    duplicate,
    supported({ kind: "screen-removed", screenTitle: "Old screen" }),
    supported({ kind: "screen-added", screenTitle: "New screen" }),
    repeated,
  ];

  const forward = summarizeReviewerChanges({ changes });
  const reversed = summarizeReviewerChanges({ changes: [...changes].reverse() });

  assert.deepEqual(forward, reversed);
  assert.equal(forward.facts.length, 7);
  assert.equal(forward.visibleFacts.length, DEFAULT_VISIBLE_REVIEWER_CHANGE_LIMIT);
  assert.equal(forward.collapsedCount, 2);
  assert.deepEqual(forward.facts.map((fact) => fact.category), [
    "screen",
    "screen",
    "element",
    "element",
    "visible-text",
    "interaction",
    "visual",
  ]);
  const careGuide = forward.facts.find((fact) => fact.subjectLabel === "Care guide");
  assert.deepEqual(careGuide?.evidenceRefs, [
    "runtime:variant:a",
    "runtime:variant:b",
    "runtime:variant:c",
  ]);
});

test("one change reported by a control and its container becomes a single fact", () => {
  // iOS reports the same label change on the row and on the button inside it.
  const layered = role => supported({
    kind: "accessibility-label-changed",
    subjectRole: role,
    subjectLabel: "Share",
    before: "Share App",
    after: "Share Example with friends",
  }, [`runtime:element:${role}`]);
  const summary = summarizeReviewerChanges({ changes: [layered("other"), layered("button")] });
  assert.equal(summary.facts.length, 1);
  assert.equal(summary.facts[0].subjectRole, "button");
  // The container's evidence survives on the surviving fact.
  assert.deepEqual(summary.facts[0].evidenceRefs, ["runtime:element:button", "runtime:element:other"]);

  // A role change is about the role, so two different roles stay two findings.
  const roles = summarizeReviewerChanges({ changes: [
    supported({ kind: "accessibility-role-changed", subjectLabel: "Share", beforeRole: "button", afterRole: "text" }, ["runtime:element:a"]),
    supported({ kind: "accessibility-role-changed", subjectLabel: "Share", beforeRole: "button", afterRole: "image" }, ["runtime:element:b"]),
  ] });
  assert.equal(roles.facts.length, 2);
});

test("a control that appeared or left leads over the labels that moved with it", () => {
  const summary = summarizeReviewerChanges({ changes: [
    supported({ kind: "element-added", elementRole: "text", elementLabel: "GOLDFISH" }),
    supported({ kind: "element-added", elementRole: "other", elementLabel: "BUTTERFLY" }),
    supported({ kind: "element-removed", elementRole: "button", elementLabel: "SWEET BEE" }),
  ] });
  assert.deepEqual(summary.facts.map((fact) => fact.bullet), [
    "Removed button “SWEET BEE”.",
    "Added text “GOLDFISH”.",
    "Added other “BUTTERFLY”.",
  ]);
});

test("requires a conclusive no-visible-change assessment before showing the empty state", () => {
  const complete = summarizeReviewerChanges({
    changes: [supported(
      { kind: "no-visible-change" },
      ["runtime:comparison:complete", "runtime:comparison:complete"],
    )],
  });

  assert.deepEqual(complete, {
    status: "ready",
    needsReview: false,
    noVisibleChange: true,
    emptyState: NO_VISIBLE_CHANGE_MESSAGE,
    emptyStateEvidenceRefs: ["runtime:comparison:complete"],
    facts: [],
    visibleFacts: [],
    collapsedCount: 0,
    reviewIssues: [],
  });

  const absent = summarizeReviewerChanges({ changes: [] });
  assert.equal(absent.status, "needs-review");
  assert.equal(absent.noVisibleChange, false);
  assert.equal(absent.reviewIssues[0]?.kind, "missing-assessment");
});

test("fails closed without fabricating bullets for inconclusive, unsupported, or invalid claims", () => {
  const summary = summarizeReviewerChanges({
    changes: [
      supported({ kind: "screen-added", screenTitle: "Cat Care Guide" }, ["runtime:screen:new"]),
      {
        assessment: "inconclusive",
        reason: "Accessibility pairing is ambiguous.",
        evidenceRefs: ["runtime:a11y:pair"],
      },
      {
        assessment: "unsupported",
        reason: "Pixel regions do not identify a semantic landmark.",
      },
      supported({
        kind: "visible-text-changed",
        subjectRole: "button",
        subjectLabel: "Continue",
        textKind: "title",
        before: "Same",
        after: " Same ",
      }, ["runtime:text:same"]),
      supported({ kind: "screen-removed", screenTitle: "No evidence" }, []),
    ],
  });

  assert.equal(summary.status, "needs-review");
  assert.equal(summary.needsReview, true);
  assert.deepEqual(summary.facts.map((fact) => fact.bullet), ["Added screen “Cat Care Guide”."]);
  assert.deepEqual(summary.reviewIssues.map((issue) => issue.kind), [
    "inconclusive",
    "invalid-change",
    "missing-evidence",
    "unsupported",
  ]);
  assert.ok(summary.reviewIssues.every((issue) => !issue.reason.includes("Added screen")));
});

test("does not present accessibility labels as visible button-title changes", () => {
  const summary = summarizeReviewerChanges({
    changes: [supported({
      kind: "accessibility-label-changed",
      subjectRole: "button",
      before: "Submit form",
      after: "Save profile",
    })],
  });

  assert.equal(
    summary.facts[0]?.bullet,
    "Changed accessibility label from “Submit form” to “Save profile”.",
  );
  assert.doesNotMatch(summary.facts[0]?.bullet ?? "", /button title/);
});
