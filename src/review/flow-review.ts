import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CheckpointSide, FlowReview, FlowReviewRun, FlowReviewSide } from "../contracts/flow-comparison.js";
import type { ExplorationFlow, ExplorationReport } from "../contracts/standalone-report.js";
import type { FlowComparison, FlowRun } from "./flow-comparison.js";

const keyOf = (name: string) => name.trim().toLowerCase();

/**
 * The text a screen showed, in tree order and once each: every label and value its accessibility tree kept. A run's
 * artifacts sit beside its report directory; a report copied on its own has none, and its checkpoints carry no text.
 */
async function screenText(run: FlowRun, observationId: string): Promise<string[] | undefined> {
  const observation = run.report.map.observations.find(item => item.id === observationId);
  const artifact = observation?.accessibilityArtifactId ? run.report.map.artifacts.find(item => item.id === observation.accessibilityArtifactId) : undefined;
  if (!artifact) return undefined;
  const roots = basename(run.directory) === "report" ? [dirname(run.directory), run.directory] : [run.directory];
  for (const root of roots) {
    let tree: { nodes?: Array<{ label?: unknown; value?: unknown }> };
    try { tree = JSON.parse(await readFile(resolve(root, artifact.path), "utf8")) as typeof tree; } catch { continue; }
    const text = new Set<string>();
    for (const node of tree.nodes ?? []) for (const value of [node.label, node.value]) {
      if (typeof value === "string" && value.trim()) text.add(value.trim());
    }
    return [...text];
  }
  return undefined;
}

async function reviewSide(run: FlowRun, side: CheckpointSide | undefined): Promise<FlowReviewSide | undefined> {
  if (!side) return undefined;
  if ("missing" in side) return { missing: side.missing };
  const text = await screenText(run, side.observationId);
  return { screenshot: side.screenshot, ...(text ? { text } : {}) };
}

function reviewRun(report: ExplorationReport, name: string): FlowReviewRun | undefined {
  const flow: ExplorationFlow | undefined = report.exploration.flows?.find(item => keyOf(item.name) === keyOf(name));
  if (!flow) return undefined;
  return { status: flow.status, ...(flow.reason ? { reason: flow.reason } : {}), ...(flow.steps ? { steps: flow.steps } : {}),
    ...(flow.failedStep !== undefined ? { failedStep: flow.failedStep } : {}) };
}

/** The comparison as the Viewer reads it: flows in the comparison's order, each with both runs' outcome and steps. */
export async function flowReview(comparison: FlowComparison, before: FlowRun, after: FlowRun): Promise<FlowReview> {
  const flows: FlowReview["flows"] = [];
  for (const item of comparison.checkpoints) {
    let flow = flows.at(-1);
    if (!flow || flow.name !== item.flow) {
      const was = reviewRun(before.report, item.flow), now = reviewRun(after.report, item.flow);
      flows.push(flow = { name: item.flow, ...(was ? { before: was } : {}), ...(now ? { after: now } : {}), checkpoints: [] });
    }
    const [was, now] = await Promise.all([reviewSide(before, item.before), reviewSide(after, item.after)]);
    flow.checkpoints.push({ name: item.checkpoint, verdict: item.verdict, ...(was ? { before: was } : {}), ...(now ? { after: now } : {}),
      ...(item.regions ? { regions: item.regions } : {}) });
  }
  const { report: _before, ...was } = comparison.before, { report: _after, ...now } = comparison.after;
  return { before: was, after: now, conditions: comparison.conditions, notes: comparison.notes, flows };
}

/**
 * Writes a report the Viewer opens: the after run's exploration report with the review beside it, and every asset it
 * names, the before run's checkpoint screenshots included. Assets are named by their SHA-256, so the two runs share one
 * folder without clashing.
 */
export async function writeFlowReviewReport(comparison: FlowComparison, before: FlowRun, after: FlowRun, directory: string): Promise<string> {
  const target = resolve(directory);
  if ([before.directory, after.directory].some(source => resolve(source) === target)) throw new Error("The review report needs its own folder, not one of the runs' reports.");
  const review = await flowReview(comparison, before, after);
  await mkdir(join(target, "assets"), { recursive: true });
  const assets = [...after.report.assets];
  for (const asset of after.report.assets) await copyFile(resolve(after.directory, asset.path), join(target, asset.path));
  const known = new Set(assets.map(asset => asset.path));
  for (const asset of before.report.assets) {
    const used = comparison.checkpoints.some(item => item.before && "screenshot" in item.before && item.before.screenshot === asset.path);
    if (!used || known.has(asset.path)) continue;
    await copyFile(resolve(before.directory, asset.path), join(target, asset.path));
    assets.push(asset); known.add(asset.path);
  }
  const report: ExplorationReport = { ...after.report, assets, flowReview: review };
  await writeFile(join(target, "exploration.json"), JSON.stringify(report));
  return target;
}
