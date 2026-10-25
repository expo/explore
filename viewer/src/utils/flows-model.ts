import type { FlowReview, FlowReviewCheckpoint, FlowReviewFlow, FlowReviewSide } from "../../../src/contracts/flow-comparison";
import type { ExplorationFlowStep } from "../../../src/contracts/standalone-report";

/** Each kind of checkpoint and flow the Flows view tells apart, by an icon of its own shape and a word. */
export type FlowMark = "changed" | "unchanged" | "stopped" | "not-reached" | "added" | "removed" | "not-comparable";

export const FLOW_MARK_LABELS: Record<FlowMark, string> = {
  changed: "Changed",
  unchanged: "Unchanged",
  stopped: "Stopped",
  "not-reached": "Not reached",
  added: "Added",
  removed: "Removed",
  "not-comparable": "Different size",
};

export type FlowFilter = "changed" | "all";
export type FlowSide = "before" | "after";

const hasPicture = (side: FlowReviewSide | undefined): side is { screenshot: string; text?: string[] } => side !== undefined && "screenshot" in side;

/** A checkpoint's mark: what the comparison found, and for a missing picture, which build never reached it. */
export function checkpointMark(checkpoint: FlowReviewCheckpoint): FlowMark {
  switch (checkpoint.verdict) {
    case "changed": return "changed";
    case "unchanged": return "unchanged";
    case "added": return "added";
    case "removed": return "removed";
    case "different-size": return "not-comparable";
    case "missing": return "not-reached";
  }
}

/** The word under a checkpoint: a missing picture says which build has none. */
export function checkpointLabel(checkpoint: FlowReviewCheckpoint): string {
  if (checkpoint.verdict !== "missing") return FLOW_MARK_LABELS[checkpointMark(checkpoint)];
  return hasPicture(checkpoint.after) ? "Not reached before" : "Not reached";
}

/** A run that ended the flow early: it failed at a step, or the run stopped during or before it. */
export function stoppedEarly(flow: FlowReviewFlow): boolean {
  return flow.after !== undefined && flow.after.status !== "completed";
}

/** Whether the Changed filter keeps a flow: any checkpoint the captures do not show unchanged, or a run that stopped. */
export function flowNeedsReview(flow: FlowReviewFlow): boolean {
  return stoppedEarly(flow) || flow.checkpoints.some(checkpoint => checkpoint.verdict !== "unchanged");
}

/** A flow's mark: a stop first, then a flow only one run has, then its most pressing checkpoint. */
export function flowMark(flow: FlowReviewFlow): FlowMark {
  if (stoppedEarly(flow)) return "stopped";
  if (!flow.after) return "removed";
  if (!flow.before) return "added";
  const marks = new Set(flow.checkpoints.map(checkpointMark));
  if (marks.has("changed") || marks.has("not-comparable")) return "changed";
  return (["not-reached", "added", "removed"] as const).find(mark => marks.has(mark)) ?? "unchanged";
}

/** One line under a flow's name: whether it stopped, then how many checkpoints of each kind, the most pressing first. */
export function flowStatusLine(flow: FlowReviewFlow): string {
  const counts = new Map<FlowMark, number>();
  for (const checkpoint of flow.checkpoints) {
    const mark = checkpointMark(checkpoint);
    counts.set(mark, (counts.get(mark) ?? 0) + 1);
  }
  const parts = (["not-reached", "changed", "not-comparable", "added", "removed"] as const)
    .filter(mark => counts.get(mark))
    .map(mark => `${counts.get(mark)} ${FLOW_MARK_LABELS[mark].toLowerCase()}`);
  if (stoppedEarly(flow)) return ["Stopped", ...parts].join(" · ");
  return parts.length ? parts.join(" · ") : "Unchanged";
}

export function visibleFlows(review: FlowReview, filter: FlowFilter): FlowReviewFlow[] {
  return filter === "all" ? review.flows : review.flows.filter(flowNeedsReview);
}

/** A flow's problems: every checkpoint the captures do not show unchanged, in the flow's order. */
export function problemIndexes(flow: FlowReviewFlow): number[] {
  return flow.checkpoints.flatMap((checkpoint, index) => checkpoint.verdict === "unchanged" ? [] : [index]);
}

/** Where a flow opens: its first problem, or its first checkpoint when nothing changed. */
export function firstProblem(flow: FlowReviewFlow): number {
  return problemIndexes(flow)[0] ?? 0;
}

/** The flow's steps as the after run took them, or the before run's when the after run has none recorded. */
export function flowSteps(flow: FlowReviewFlow): { steps: ExplorationFlowStep[]; failedStep?: number; side: FlowSide } | undefined {
  if (flow.after?.steps) return { steps: flow.after.steps, ...(flow.after.failedStep !== undefined ? { failedStep: flow.after.failedStep } : {}), side: "after" };
  if (flow.before?.steps) return { steps: flow.before.steps, side: "before" };
  return undefined;
}

export type StepBefore = { step: Exclude<ExplorationFlowStep, { checkpoint: string }>; failed: boolean; ran: boolean };

/**
 * The steps between the previous checkpoint and this one, as the flows file names them, with the one the after run
 * failed at and the ones it never ran. Checkpoints match by name, as the comparison pairs them.
 */
export function stepsBefore(flow: FlowReviewFlow, index: number): StepBefore[] {
  const recorded = flowSteps(flow);
  const checkpoint = flow.checkpoints[index];
  if (!recorded || !checkpoint) return [];
  const key = (name: string) => name.trim().toLowerCase();
  const at = recorded.steps.findIndex(step => "checkpoint" in step && key(step.checkpoint) === key(checkpoint.name));
  if (at < 0) return [];
  let start = at;
  while (start > 0 && !("checkpoint" in recorded.steps[start - 1]!)) start -= 1;
  const failed = recorded.side === "after" ? recorded.failedStep : undefined;
  return recorded.steps.slice(start, at).flatMap((step, offset) => "checkpoint" in step ? [] : [{
    step,
    failed: failed === start + offset + 1,
    ran: failed === undefined || start + offset + 1 <= failed,
  }]);
}

/**
 * What text the checkpoint's screen showed in one build and not the other, in each build's order. A screen without its
 * text recorded on either side has none to compare.
 */
export function textChanges(checkpoint: FlowReviewCheckpoint): { removed: string[]; added: string[] } | undefined {
  const before = hasPicture(checkpoint.before) ? checkpoint.before.text : undefined;
  const after = hasPicture(checkpoint.after) ? checkpoint.after.text : undefined;
  if (!before || !after) return undefined;
  const was = new Set(before), now = new Set(after);
  return { removed: before.filter(line => !now.has(line)), added: after.filter(line => !was.has(line)) };
}

/** A changed area no taller than a line or two of text, in percent of the screenshot's height. */
const TEXT_SIZED_AREA = 3;

/**
 * The text a checkpoint changed, in one line, where the picture cannot carry it: when every changed area is text-sized,
 * too small to read at the size the Viewer shows the screen. A larger change is read off the picture.
 */
export function textChangeLine(checkpoint: FlowReviewCheckpoint): string | undefined {
  const changes = textChanges(checkpoint);
  const regions = checkpoint.regions ?? [];
  if (!changes || !regions.length || regions.some(region => region.height > TEXT_SIZED_AREA)) return undefined;
  const { removed, added } = changes;
  const more = (lines: string[]) => lines.length > 1 ? ` and ${lines.length - 1} more` : "";
  if (removed.length === 1 && added.length === 1) return `“${added[0]}”, was “${removed[0]}”`;
  if (added.length && !removed.length) return `Adds “${added[0]}”${more(added)}`;
  if (removed.length && !added.length) return `Drops “${removed[0]}”${more(removed)}`;
  if (added.length) return `“${added[0]}”${more(added)}, was “${removed[0]}”${more(removed)}`;
  return undefined;
}

/** A side's screenshot, as the asset's SHA-256 the report keeps it under, or why it has none. */
export function sidePicture(side: FlowReviewSide | undefined): { sha256: string } | { missing: string } | undefined {
  if (!side) return undefined;
  if (!hasPicture(side)) return { missing: side.missing };
  const match = /([a-f0-9]{64})\.(png|jpg)$/.exec(side.screenshot);
  return match ? { sha256: match[1]! } : { missing: "The report has no screenshot for this checkpoint." };
}
