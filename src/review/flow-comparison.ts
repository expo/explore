import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { isFoldable, systemRegions } from "../contracts/capture.js";
import {
  FLOW_COMPARISON_KIND, conditionDifferences, pairCheckpoints, runConditions,
  type ChangedRegion, type CheckpointPair, type CheckpointVerdict, type RunConditionDifference, type RunConditions,
} from "../contracts/flow-comparison.js";
import type { ExplorationReport } from "../contracts/standalone-report.js";
import { ignoreSystemRegions, systemBandFrameLoader } from "./evidence-assessment.js";
import type { ScreenshotDiffMeasurement } from "./visual-evidence.js";

export type { CheckpointVerdict } from "../contracts/flow-comparison.js";
export type ComparedCheckpoint = CheckpointPair & {
  verdict: CheckpointVerdict;
  /** Share of the screenshot that differs once the status bar and home indicator are set aside. */
  mismatchPercentage?: number;
  regions?: ChangedRegion[];
};

export type FlowComparison = {
  kind: typeof FLOW_COMPARISON_KIND;
  before: RunConditions & { report: string };
  after: RunConditions & { report: string };
  /** How the runs were captured differently; a checkpoint that changed may owe its change to these. */
  conditions: RunConditionDifference[];
  notes: string[];
  counts: Record<CheckpointVerdict, number>;
  checkpoints: ComparedCheckpoint[];
};

export type FlowRun = { report: ExplorationReport; directory: string };
export type MeasureScreenshots = (beforePath: string, afterPath: string) => Promise<ScreenshotDiffMeasurement>;

/** A PNG's pixel size, from its header. */
async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(24);
    await file.read(header, 0, 24, 0);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally { await file.close(); }
}

/**
 * Compares two runs of the same flows file checkpoint by checkpoint, with the review's screenshot diff and the
 * status-bar and home-indicator regions it sets aside. `measure` is only called for pairs with a screenshot on both
 * sides of the same size.
 */
export async function compareFlowRuns(before: FlowRun, after: FlowRun, measure: MeasureScreenshots, threshold = 0.1): Promise<FlowComparison> {
  const was = runConditions(before.report), now = runConditions(after.report);
  const notes: string[] = [];
  // A Duo's status bar sits on whichever panel was in use, and a run does not record the pose.
  const foldable = isFoldable(before.report.exploration.app.platform, was.device);
  if (foldable) notes.push("The status bar is not set aside: the run does not record which panel of the foldable was in use.");
  const system = foldable ? [] : systemRegions({ platform: before.report.exploration.app.platform, device: was.device });
  const checkpoints: ComparedCheckpoint[] = [];
  for (const pair of pairCheckpoints(before.report, after.report)) {
    if (!pair.before) { checkpoints.push({ ...pair, verdict: "added" }); continue; }
    if (!pair.after) { checkpoints.push({ ...pair, verdict: "removed" }); continue; }
    if (!("screenshot" in pair.before) || !("screenshot" in pair.after)) { checkpoints.push({ ...pair, verdict: "missing" }); continue; }
    const beforePath = resolve(before.directory, pair.before.screenshot), afterPath = resolve(after.directory, pair.after.screenshot);
    const [a, b] = await Promise.all([pngSize(beforePath), pngSize(afterPath)]);
    if (a.width !== b.width || a.height !== b.height) { checkpoints.push({ ...pair, verdict: "different-size" }); continue; }
    const raw = await measure(beforePath, afterPath);
    const { measurement } = ignoreSystemRegions(raw, system, systemBandFrameLoader(raw, threshold));
    const different = measurement.regions.reduce((sum, region) => sum + region.differentPixels, 0);
    const mismatchPercentage = raw.totalPixels ? Math.round((different / raw.totalPixels) * 10000) / 100 : 0;
    // As in a review, a mismatch that rounds to 0.00% is rendering noise.
    const changed = measurement.regions.length > 0 && mismatchPercentage > 0;
    checkpoints.push({ ...pair, verdict: changed ? "changed" : "unchanged", mismatchPercentage,
      ...(changed ? { regions: measurement.regions.map(region => region.normalizedRect) } : {}) });
  }
  const counts = { unchanged: 0, changed: 0, "different-size": 0, missing: 0, added: 0, removed: 0 };
  for (const item of checkpoints) counts[item.verdict] += 1;
  return { kind: FLOW_COMPARISON_KIND, before: { ...was, report: before.directory }, after: { ...now, report: after.directory },
    conditions: conditionDifferences(was, now), notes, counts, checkpoints };
}
