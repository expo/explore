/**
 * Reads what an e2e run (the `e2e` package's `report.json`) says about each flow: its status, its steps, and the
 * frames `app.screenshot(label)` took. Nothing here touches a device; the worker produces the report and the host
 * turns these summaries into bundle evidence.
 */
import type { FlowStatus, FlowStepStatus } from "../../contracts/capture.js";

export type FlowFrameSummary = { key: string; label: string; path: string; stepIndex: number; capturedAt: string };
export type FlowStepSummary = { api: string; label: string; status: FlowStepStatus; durationMs: number; frame?: string; error?: { code: string; message: string };
  /** The line of the test file the step was called from, when e2e recorded one. */
  line?: number };
export type FlowTestSummary = {
  id: string; file: string; title: string; status: FlowStatus; durationMs: number;
  error?: { code: string; message: string };
  /** The line of the test file the test is declared on, when e2e recorded one. */
  line?: number;
  steps: FlowStepSummary[];
  frames: FlowFrameSummary[];
};

const FLOW_STATUSES: readonly FlowStatus[] = ["passed", "failed", "skipped", "flaky", "timed-out", "interrupted", "blocked"];
const STEP_STATUSES: readonly FlowStepStatus[] = ["passed", "failed", "blocked", "timed-out", "cancelled"];

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/** A path segment from free text: lower case, `-` between words, at most 64 characters, never empty. */
export function flowSlug(value: string): string {
  const slug = value.toLowerCase().replace(/\.e2e\.[cm]?[jt]sx?$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
  return slug || "flow";
}

/** The flow's identity across revisions: its file (without `tests/` and the extension) and its title, both slugged. */
export function flowId(file: string, titlePath: readonly string[]): string {
  const stem = file.replace(/\\/g, "/").replace(/^(\.\/)?(tests?|e2e|flows)\//, "");
  return `${flowSlug(stem)}/${flowSlug(titlePath.join(" "))}`;
}

function serializedError(value: unknown): { code: string; message: string } | undefined {
  if (!isRecord(value)) return undefined;
  return { code: text(value.code, "ERROR").slice(0, 64), message: text(value.message).slice(0, 2_000) };
}

/** Every selected test of the report, with the attempt the run counted (the last one). */
/** A frame the worker took after a step ended, when the capture asks for a frame per step. */
export type StepFrameFile = { stepIndex: number; path: string; capturedAt: string };

export function summarizeFlowReport(report: unknown, stepFrames?: ReadonlyMap<string, readonly StepFrameFile[]>): FlowTestSummary[] {
  if (!isRecord(report) || !isRecord(report.run) || !Array.isArray(report.run.results)) throw new Error("The e2e report has no run results");
  const artifacts = new Map<string, Record<string, unknown>>();
  const summaries: FlowTestSummary[] = [];
  for (const result of report.run.results) {
    if (!isRecord(result) || result.selected === false) continue;
    const file = text(result.file);
    const titlePath = Array.isArray(result.titlePath) ? result.titlePath.filter((part): part is string => typeof part === "string") : [];
    const attempts = Array.isArray(result.attempts) ? result.attempts.filter(isRecord) : [];
    const attempt = attempts.at(-1);
    for (const artifact of Array.isArray(attempt?.artifacts) ? attempt.artifacts : []) if (isRecord(artifact) && typeof artifact.id === "string") artifacts.set(artifact.id, artifact);
    const status = FLOW_STATUSES.includes(result.status as FlowStatus) ? result.status as FlowStatus : "failed";
    const steps: FlowStepSummary[] = [];
    const frames: FlowFrameSummary[] = [];
    const keys = new Map<string, number>();
    for (const step of Array.isArray(attempt?.steps) ? attempt.steps.filter(isRecord) : []) {
      const summary: FlowStepSummary = { api: text(step.api, "step").slice(0, 64), label: text(step.label).slice(0, 256),
        status: STEP_STATUSES.includes(step.status as FlowStepStatus) ? step.status as FlowStepStatus : "failed", durationMs: count(step.durationMs) };
      const error = serializedError(step.error);
      if (error) summary.error = error;
      if (isRecord(step.source) && step.source.file === file && Number.isSafeInteger(step.source.line) && (step.source.line as number) > 0) summary.line = step.source.line as number;
      if (summary.api === "app.screenshot" && summary.status === "passed" && Array.isArray(step.artifacts) && step.artifacts.length === 1) {
        const artifact = artifacts.get(String(step.artifacts[0]));
        if (artifact?.kind === "screenshot" && typeof artifact.path === "string") {
          const base = flowSlug(summary.label || "screenshot");
          const seen = (keys.get(base) ?? 0) + 1;
          keys.set(base, seen);
          const key = seen === 1 ? base : `${base}-${seen}`;
          summary.frame = key;
          frames.push({ key, label: summary.label, path: artifact.path, stepIndex: steps.length, capturedAt: text(step.startedAt) });
        }
      }
      steps.push(summary);
    }
    // Per-step frames fill in the steps that took no frame of their own, in the step's place.
    for (const file of stepFrames?.get(text(result.testId) || text(result.id)) ?? []) {
      const step = steps[file.stepIndex];
      if (!step || step.frame !== undefined) continue;
      const base = `step-${file.stepIndex + 1}`;
      const seen = (keys.get(base) ?? 0) + 1;
      keys.set(base, seen);
      const key = seen === 1 ? base : `${base}-${seen}`;
      step.frame = key;
      frames.push({ key, label: `${file.stepIndex + 1}. ${step.label || step.api}`.slice(0, 80), path: file.path, stepIndex: file.stepIndex, capturedAt: file.capturedAt });
    }
    frames.sort((a, b) => a.stepIndex - b.stepIndex);
    const summaryError = serializedError(attempt?.error);
    const line = isRecord(result.source) && result.source.file === file && Number.isSafeInteger(result.source.line) && (result.source.line as number) > 0 ? result.source.line as number : undefined;
    summaries.push({ id: flowId(file, titlePath), file, title: titlePath.join(" › "), status, durationMs: count(attempt?.durationMs),
      ...(summaryError ? { error: summaryError } : {}), ...(line ? { line } : {}), steps, frames });
  }
  return summaries;
}
