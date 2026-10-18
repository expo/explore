import type { ElementRole } from "../types.js";

export const DEFAULT_VISIBLE_REVIEWER_CHANGE_LIMIT = 5;
export const DEFAULT_SHORT_VISIBLE_TEXT_LIMIT = 80;
export const NO_VISIBLE_CHANGE_MESSAGE =
  "No user-visible changes observed in the captured states.";

export type ReviewerSubjectRole =
  | ElementRole
  | "screen"
  | "heading"
  | "card"
  | "landmark"
  | "content";

export type ReviewerChangeCategory =
  | "screen"
  | "element"
  | "visible-text"
  | "interaction"
  | "accessibility"
  | "visual";

export type ReviewerChangeTemplateId =
  | "screen.added"
  | "screen.removed"
  | "element.added"
  | "element.removed"
  | "visible-text.changed-short"
  | "visible-text.changed-long"
  | "visible-text.unstable-within-build"
  | "interaction.target-changed"
  | "accessibility.label-changed"
  | "accessibility.role-changed"
  | "visual.landmark-changed"
  | "visual.main-content-changed";

export type ReviewerChangeFact = {
  category: ReviewerChangeCategory;
  templateId: ReviewerChangeTemplateId;
  /** A complete, deterministic bullet intended for a pull-request reviewer. */
  bullet: string;
  subjectRole: ReviewerSubjectRole;
  subjectLabel: string;
  before?: string;
  after?: string;
  /** Full copy is kept out of a long bullet and can be revealed on demand. */
  expandedPayload?: {
    before: string;
    after: string;
  };
  /** Lower values appear first. */
  priority: number;
  /** References into runtime evidence; never source locations or prose claims. */
  evidenceRefs: string[];
};

export type ReviewerChangeIssueKind =
  | "inconclusive"
  | "unsupported"
  | "missing-evidence"
  | "invalid-change"
  | "missing-assessment";

export type ReviewerChangeIssue = {
  kind: ReviewerChangeIssueKind;
  reason: string;
  evidenceRefs: string[];
};

export type ScreenReviewerChange =
  | { kind: "screen-added"; screenTitle: string }
  | { kind: "screen-removed"; screenTitle: string };

export type ElementReviewerChange =
  | {
    kind: "element-added";
    elementRole: ReviewerSubjectRole;
    elementLabel: string;
  }
  | {
    kind: "element-removed";
    elementRole: ReviewerSubjectRole;
    elementLabel: string;
  };

export type VisibleTextKind = "title" | "heading" | "label" | "body";

export type VisibleTextReviewerChange = {
  kind: "visible-text-changed";
  subjectRole: ReviewerSubjectRole;
  /** Stable reviewer-facing name used when long copy is collapsed. */
  subjectLabel: string;
  textKind: VisibleTextKind;
  before: string;
  after: string;
};

/**
 * A label that differs between the two builds but also between two captures of the same build (its light and dark
 * appearances): a clock, a relative time, a random name. Runtime state, not a change.
 */
export type UnstableTextReviewerChange = {
  kind: "unstable-text";
  subjectRole: ReviewerSubjectRole;
  before: string;
  after: string;
  /** What the same build showed in its other capture. */
  within: string;
};

export type InteractionReviewerChange = {
  kind: "action-target-changed";
  subjectRole: ReviewerSubjectRole;
  subjectLabel: string;
  beforeTarget: string;
  afterTarget: string;
};

export type AccessibilityReviewerChange =
  | {
    kind: "accessibility-label-changed";
    subjectRole: ReviewerSubjectRole;
    before: string;
    after: string;
  }
  | {
    kind: "accessibility-role-changed";
    subjectLabel: string;
    beforeRole: ReviewerSubjectRole;
    afterRole: ReviewerSubjectRole;
  };

export type VisualReviewerChange = {
  kind: "visual-changed";
  scope:
    | { kind: "landmark"; label: string }
    | { kind: "main-content"; near?: "top" | "bottom" };
};

/**
 * A conclusive assertion that a complete capture comparison found no reviewer-visible delta.
 * An empty input is deliberately not equivalent: absence of evidence must not become a claim.
 */
export type NoVisibleReviewerChange = { kind: "no-visible-change" };

export type SupportedReviewerChange =
  | ScreenReviewerChange
  | ElementReviewerChange
  | VisibleTextReviewerChange
  | UnstableTextReviewerChange
  | InteractionReviewerChange
  | AccessibilityReviewerChange
  | VisualReviewerChange
  | NoVisibleReviewerChange;

export type ReviewerChangeInput =
  | {
    assessment: "supported";
    change: SupportedReviewerChange;
    evidenceRefs: readonly string[];
  }
  | {
    assessment: "inconclusive" | "unsupported";
    reason: string;
    evidenceRefs?: readonly string[];
  };

type WhatChangedFacts = {
  /** All deterministic facts, after semantic de-duplication and priority sorting. */
  facts: ReviewerChangeFact[];
  /** The first five facts shown before reviewer expansion. */
  visibleFacts: ReviewerChangeFact[];
  collapsedCount: number;
};

export type WhatChangedSummary =
  | (WhatChangedFacts & {
    status: "ready";
    needsReview: false;
    noVisibleChange: false;
    reviewIssues: [];
  })
  | (WhatChangedFacts & {
    status: "ready";
    needsReview: false;
    noVisibleChange: true;
    emptyState: typeof NO_VISIBLE_CHANGE_MESSAGE;
    emptyStateEvidenceRefs: string[];
    reviewIssues: [];
  })
  | (WhatChangedFacts & {
    status: "needs-review";
    needsReview: true;
    noVisibleChange: false;
    reviewIssues: [ReviewerChangeIssue, ...ReviewerChangeIssue[]];
  });

type CandidateResult =
  | { kind: "fact"; fact: ReviewerChangeFact }
  | { kind: "no-visible-change"; evidenceRefs: string[] }
  | { kind: "issue"; issue: ReviewerChangeIssue };

const PRIORITY: Record<ReviewerChangeCategory, number> = {
  screen: 10,
  element: 20,
  "visible-text": 30,
  interaction: 40,
  accessibility: 50,
  visual: 60,
};

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function fullCopy(value: string): string {
  return value.trim();
}

function quote(value: string): string {
  return `“${value}”`;
}

function displayRole(role: ReviewerSubjectRole): string {
  return role.replaceAll("-", " ");
}

function roleWithArticle(role: ReviewerSubjectRole): string {
  const displayed = displayRole(role);
  const article = /^[aeiou]/.test(displayed) ? "an" : "a";
  return `${article} ${displayed}`;
}

function normalizeEvidenceRefs(refs: readonly string[] | undefined): string[] {
  return [...new Set((refs ?? []).map(compact).filter(Boolean))].sort(compareText);
}

function invalidChange(reason: string, evidenceRefs: string[]): CandidateResult {
  return {
    kind: "issue",
    issue: { kind: "invalid-change", reason, evidenceRefs },
  };
}

function buildFact(change: SupportedReviewerChange, evidenceRefs: string[]): CandidateResult {
  switch (change.kind) {
    case "screen-added": {
      const title = compact(change.screenTitle);
      if (!title) return invalidChange("An added screen is missing its reviewer-facing title.", evidenceRefs);
      return {
        kind: "fact",
        fact: {
          category: "screen",
          templateId: "screen.added",
          bullet: `Added screen ${quote(title)}.`,
          subjectRole: "screen",
          subjectLabel: title,
          priority: PRIORITY.screen,
          evidenceRefs,
        },
      };
    }
    case "screen-removed": {
      const title = compact(change.screenTitle);
      if (!title) return invalidChange("A removed screen is missing its reviewer-facing title.", evidenceRefs);
      return {
        kind: "fact",
        fact: {
          category: "screen",
          templateId: "screen.removed",
          bullet: `Removed screen ${quote(title)}.`,
          subjectRole: "screen",
          subjectLabel: title,
          priority: PRIORITY.screen,
          evidenceRefs,
        },
      };
    }
    case "element-added": {
      const label = compact(change.elementLabel);
      if (!label) return invalidChange("An added element is missing its reviewer-facing label.", evidenceRefs);
      return {
        kind: "fact",
        fact: {
          category: "element",
          templateId: "element.added",
          bullet: `Added ${displayRole(change.elementRole)} ${quote(label)}.`,
          subjectRole: change.elementRole,
          subjectLabel: label,
          priority: PRIORITY.element,
          evidenceRefs,
        },
      };
    }
    case "element-removed": {
      const label = compact(change.elementLabel);
      if (!label) return invalidChange("A removed element is missing its reviewer-facing label.", evidenceRefs);
      return {
        kind: "fact",
        fact: {
          category: "element",
          templateId: "element.removed",
          bullet: `Removed ${displayRole(change.elementRole)} ${quote(label)}.`,
          subjectRole: change.elementRole,
          subjectLabel: label,
          priority: PRIORITY.element,
          evidenceRefs,
        },
      };
    }
    case "visible-text-changed": {
      const subjectLabel = compact(change.subjectLabel);
      const before = fullCopy(change.before);
      const after = fullCopy(change.after);
      if (!subjectLabel) {
        return invalidChange("A visible-text change is missing its reviewer-facing subject.", evidenceRefs);
      }
      if (!before || !after) {
        return invalidChange("A visible-text change requires both before and after copy.", evidenceRefs);
      }
      if (compact(before) === compact(after)) {
        return invalidChange("A visible-text change has identical before and after copy.", evidenceRefs);
      }
      const shortCopy = !before.includes("\n")
        && !after.includes("\n")
        && compact(before).length <= DEFAULT_SHORT_VISIBLE_TEXT_LIMIT
        && compact(after).length <= DEFAULT_SHORT_VISIBLE_TEXT_LIMIT;
      if (shortCopy) {
        const beforeLabel = compact(before);
        const afterLabel = compact(after);
        const changedSubject = change.textKind === "heading"
          ? "heading"
          : change.textKind === "body"
            ? "body copy"
            : `${displayRole(change.subjectRole)} ${change.textKind}`;
        return {
          kind: "fact",
          fact: {
            category: "visible-text",
            templateId: "visible-text.changed-short",
            bullet: `Changed ${changedSubject} from ${quote(beforeLabel)} to ${quote(afterLabel)}.`,
            subjectRole: change.subjectRole,
            subjectLabel,
            before: beforeLabel,
            after: afterLabel,
            priority: PRIORITY["visible-text"],
            evidenceRefs,
          },
        };
      }
      const changedSubject = change.textKind === "body"
        ? "body copy"
        : `${displayRole(change.subjectRole)} ${change.textKind}`;
      return {
        kind: "fact",
        fact: {
          category: "visible-text",
          templateId: "visible-text.changed-long",
          bullet: `Updated ${changedSubject} in ${quote(subjectLabel)}.`,
          subjectRole: change.subjectRole,
          subjectLabel,
          before,
          after,
          expandedPayload: { before, after },
          priority: PRIORITY["visible-text"],
          evidenceRefs,
        },
      };
    }
    case "action-target-changed": {
      const subject = compact(change.subjectLabel);
      const before = compact(change.beforeTarget);
      const after = compact(change.afterTarget);
      if (!subject || !before || !after) {
        return invalidChange(
          "An action-target change requires a subject and both target labels.",
          evidenceRefs,
        );
      }
      if (before === after) {
        return invalidChange("An action-target change has identical targets.", evidenceRefs);
      }
      return {
        kind: "fact",
        fact: {
          category: "interaction",
          templateId: "interaction.target-changed",
          bullet: `Changed ${quote(subject)} action from ${quote(before)} to ${quote(after)}.`,
          subjectRole: change.subjectRole,
          subjectLabel: subject,
          before,
          after,
          priority: PRIORITY.interaction,
          evidenceRefs,
        },
      };
    }
    case "unstable-text": {
      const before = compact(change.before);
      const after = compact(change.after);
      const within = compact(change.within);
      if (!before || !after || !within) return invalidChange("An unstable-text change requires all three labels.", evidenceRefs);
      if (before === after) return invalidChange("An unstable-text change has identical labels.", evidenceRefs);
      const seen = [...new Set([before, within, after])];
      return {
        kind: "fact",
        fact: {
          category: "visible-text",
          templateId: "visible-text.unstable-within-build",
          bullet: `Text varies between captures of the same build: ${seen.map(quote).join(" / ")}.`,
          subjectRole: change.subjectRole,
          subjectLabel: after,
          before,
          after,
          priority: PRIORITY["visible-text"],
          evidenceRefs,
        },
      };
    }
    case "accessibility-label-changed": {
      const before = compact(change.before);
      const after = compact(change.after);
      if (!before || !after) {
        return invalidChange(
          "An accessibility-label change requires both labels.",
          evidenceRefs,
        );
      }
      if (before === after) {
        return invalidChange("An accessibility-label change has identical labels.", evidenceRefs);
      }
      return {
        kind: "fact",
        fact: {
          category: "accessibility",
          templateId: "accessibility.label-changed",
          bullet: `Changed accessibility label from ${quote(before)} to ${quote(after)}.`,
          subjectRole: change.subjectRole,
          subjectLabel: after,
          before,
          after,
          priority: PRIORITY.accessibility,
          evidenceRefs,
        },
      };
    }
    case "accessibility-role-changed": {
      const subject = compact(change.subjectLabel);
      if (!subject) {
        return invalidChange(
          "An accessibility-role change is missing its reviewer-facing subject.",
          evidenceRefs,
        );
      }
      if (change.beforeRole === change.afterRole) {
        return invalidChange("An accessibility-role change has identical roles.", evidenceRefs);
      }
      const before = displayRole(change.beforeRole);
      const after = displayRole(change.afterRole);
      return {
        kind: "fact",
        fact: {
          category: "accessibility",
          templateId: "accessibility.role-changed",
          bullet: `Changed ${quote(subject)} from ${roleWithArticle(change.beforeRole)} to ${roleWithArticle(change.afterRole)}.`,
          subjectRole: change.afterRole,
          subjectLabel: subject,
          before,
          after,
          priority: PRIORITY.accessibility,
          evidenceRefs,
        },
      };
    }
    case "visual-changed": {
      if (change.scope.kind === "landmark") {
        const label = compact(change.scope.label);
        if (!label) {
          return invalidChange("A visual landmark change is missing its label.", evidenceRefs);
        }
        return {
          kind: "fact",
          fact: {
            category: "visual",
            templateId: "visual.landmark-changed",
            bullet: `Updated the visual appearance of ${quote(label)}.`,
            subjectRole: "landmark",
            subjectLabel: label,
            priority: PRIORITY.visual,
            evidenceRefs,
          },
        };
      }
      return {
        kind: "fact",
        fact: {
          category: "visual",
          templateId: "visual.main-content-changed",
          bullet: change.scope.near ? `Updated visual styling near the ${change.scope.near} of the screen.` : "Updated visual styling in the main content area.",
          subjectRole: "content",
          subjectLabel: "Main content",
          priority: PRIORITY.visual,
          evidenceRefs,
        },
      };
    }
    case "no-visible-change":
      return { kind: "no-visible-change", evidenceRefs };
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/** One reviewer-facing change, whichever layer reported it: the role is how it is named, not
    what changed — except where the role itself is the finding. */
function factKey(fact: ReviewerChangeFact): string {
  const roleIsContent = fact.templateId === "accessibility.role-changed";
  return JSON.stringify([
    fact.templateId,
    roleIsContent ? fact.subjectRole : "",
    fact.subjectLabel,
    fact.before ?? "",
    fact.after ?? "",
    roleIsContent ? fact.bullet : "",
  ]);
}

// A control appearing or leaving is the headline; labels and containers that moved with it follow.
const SUBJECT_PROMINENCE: Partial<Record<ReviewerSubjectRole, number>> = {
  button: 0, link: 0, tab: 0, field: 0, toggle: 0, "menu-item": 0, heading: 1, image: 2, text: 3, other: 4,
};

function prominence(fact: ReviewerChangeFact): number {
  return SUBJECT_PROMINENCE[fact.subjectRole] ?? 2;
}

function compareFacts(left: ReviewerChangeFact, right: ReviewerChangeFact): number {
  return left.priority - right.priority
    || prominence(left) - prominence(right)
    || compareText(left.templateId, right.templateId)
    || compareText(left.subjectRole, right.subjectRole)
    || compareText(left.subjectLabel, right.subjectLabel)
    || compareText(left.before ?? "", right.before ?? "")
    || compareText(left.after ?? "", right.after ?? "")
    || compareText(left.bullet, right.bullet);
}

function deduplicateFacts(facts: readonly ReviewerChangeFact[]): ReviewerChangeFact[] {
  const byKey = new Map<string, ReviewerChangeFact>();
  for (const fact of facts) {
    const key = factKey(fact);
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, fact); continue; }
    // Keep the most specific naming of the change and carry every layer's evidence with it.
    const kept = prominence(fact) < prominence(existing) ? fact : existing;
    byKey.set(key, {
      ...kept,
      evidenceRefs: normalizeEvidenceRefs([...existing.evidenceRefs, ...fact.evidenceRefs]),
    });
  }
  return [...byKey.values()].sort(compareFacts);
}

function issueKey(issue: ReviewerChangeIssue): string {
  return JSON.stringify([issue.kind, issue.reason, issue.evidenceRefs]);
}

function compareIssues(left: ReviewerChangeIssue, right: ReviewerChangeIssue): number {
  return compareText(left.kind, right.kind)
    || compareText(left.reason, right.reason)
    || compareText(left.evidenceRefs.join("\0"), right.evidenceRefs.join("\0"));
}

function deduplicateIssues(issues: readonly ReviewerChangeIssue[]): ReviewerChangeIssue[] {
  const byKey = new Map(issues.map((issue) => [issueKey(issue), issue]));
  return [...byKey.values()].sort(compareIssues);
}

/**
 * Converts conclusive runtime deltas into concise reviewer bullets. It intentionally does not
 * inspect arbitrary page data, generate prose, or infer semantics from screenshot pixels.
 */
export function summarizeReviewerChanges(options: {
  changes: readonly ReviewerChangeInput[];
}): WhatChangedSummary {
  const facts: ReviewerChangeFact[] = [];
  const issues: ReviewerChangeIssue[] = [];
  const noVisibleChangeEvidenceRefs: string[] = [];

  for (const input of options.changes) {
    const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
    if (input.assessment !== "supported") {
      issues.push({
        kind: input.assessment,
        reason: compact(input.reason) || "Runtime evidence could not support a reviewer-facing claim.",
        evidenceRefs,
      });
      continue;
    }
    if (evidenceRefs.length === 0) {
      issues.push({
        kind: "missing-evidence",
        reason: `Supported reviewer change ${input.change.kind} has no runtime evidence references.`,
        evidenceRefs: [],
      });
      continue;
    }
    const result = buildFact(input.change, evidenceRefs);
    if (result.kind === "fact") {
      facts.push(result.fact);
    } else if (result.kind === "no-visible-change") {
      noVisibleChangeEvidenceRefs.push(...result.evidenceRefs);
    } else {
      issues.push(result.issue);
    }
  }

  const sortedFacts = deduplicateFacts(facts);
  if (issues.length === 0 && sortedFacts.length === 0 && noVisibleChangeEvidenceRefs.length === 0) {
    issues.push({
      kind: "missing-assessment",
      reason: "No conclusive runtime change assessment was provided.",
      evidenceRefs: [],
    });
  }
  const visibleFacts = sortedFacts.slice(0, DEFAULT_VISIBLE_REVIEWER_CHANGE_LIMIT);
  const collapsedCount = sortedFacts.length - visibleFacts.length;
  const sortedIssues = deduplicateIssues(issues);
  const firstIssue = sortedIssues[0];
  if (firstIssue) {
    return {
      status: "needs-review",
      needsReview: true,
      noVisibleChange: false,
      facts: sortedFacts,
      visibleFacts,
      collapsedCount,
      reviewIssues: [firstIssue, ...sortedIssues.slice(1)],
    };
  }
  if (sortedFacts.length === 0) {
    return {
      status: "ready",
      needsReview: false,
      noVisibleChange: true,
      emptyState: NO_VISIBLE_CHANGE_MESSAGE,
      emptyStateEvidenceRefs: normalizeEvidenceRefs(noVisibleChangeEvidenceRefs),
      facts: [],
      visibleFacts: [],
      collapsedCount: 0,
      reviewIssues: [],
    };
  }
  return {
    status: "ready",
    needsReview: false,
    noVisibleChange: false,
    facts: sortedFacts,
    visibleFacts,
    collapsedCount,
    reviewIssues: [],
  };
}
