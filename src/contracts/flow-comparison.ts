import type { ExplorationReport } from "./standalone-report.js";

export const FLOW_COMPARISON_KIND = "explore.flow-comparison" as const;

/** One run's side of a checkpoint: its screenshot (a path inside that run's report directory), or why it has none. */
export type CheckpointSide = { observationId: string; screenshot: string } | { missing: string };

/**
 * A checkpoint of one flow in two runs, paired by flow name and checkpoint name. `before` or `after` is absent when
 * that run's flows file has no such flow or checkpoint.
 */
export type CheckpointPair = { flow: string; checkpoint: string; before?: CheckpointSide; after?: CheckpointSide };

/** What a run was captured on: two runs that differ here can still be compared, but a difference may come from it. */
export type RunConditions = { app: string; platform: string; device: string; osVersion?: string; locale?: string; orientation?: string; colorScheme?: string };
export type RunConditionDifference = { field: keyof RunConditions; before: string; after: string };

export function runConditions(report: ExplorationReport): RunConditions {
  const environment = report.map.run.environment ?? {};
  return { app: report.exploration.app.bundleId, platform: report.exploration.app.platform, device: report.exploration.device.model,
    ...(report.exploration.device.osVersion ? { osVersion: report.exploration.device.osVersion } : {}),
    ...(environment.locale ? { locale: environment.locale } : {}), ...(environment.orientation ? { orientation: environment.orientation } : {}),
    ...(environment.colorScheme ? { colorScheme: environment.colorScheme } : {}) };
}

export function conditionDifferences(before: RunConditions, after: RunConditions): RunConditionDifference[] {
  const fields = ["app", "platform", "device", "osVersion", "locale", "orientation", "colorScheme"] as const;
  return fields.flatMap(field => (before[field] ?? "unknown") === (after[field] ?? "unknown") ? []
    : [{ field, before: before[field] ?? "unknown", after: after[field] ?? "unknown" }]);
}

const keyOf = (name: string) => name.trim().toLowerCase();

function side(report: ExplorationReport, checkpoint: NonNullable<ExplorationReport["exploration"]["flows"]>[number]["checkpoints"][number]): CheckpointSide {
  if (checkpoint.observationId === undefined) return { missing: checkpoint.missing };
  const observation = report.map.observations.find(item => item.id === checkpoint.observationId);
  const artifact = observation?.screenshotArtifactId ? report.map.artifacts.find(item => item.id === observation.screenshotArtifactId) : undefined;
  const asset = artifact ? report.assets.find(item => item.sha256 === artifact.sha256) : undefined;
  return asset ? { observationId: checkpoint.observationId, screenshot: asset.path } : { missing: "The report has no screenshot for this checkpoint." };
}

/**
 * Pairs the checkpoints of two runs of a flows file: the after run's flows and checkpoints in its order, then those only
 * the before run has. Names match as the flows file compares them, ignoring case and surrounding space.
 */
export function pairCheckpoints(before: ExplorationReport, after: ExplorationReport): CheckpointPair[] {
  const beforeFlows = before.exploration.flows ?? [], afterFlows = after.exploration.flows ?? [];
  const flowNames = [...afterFlows, ...beforeFlows.filter(flow => !afterFlows.some(other => keyOf(other.name) === keyOf(flow.name)))].map(flow => flow.name);
  return flowNames.flatMap(name => {
    const was = beforeFlows.find(flow => keyOf(flow.name) === keyOf(name)), now = afterFlows.find(flow => keyOf(flow.name) === keyOf(name));
    const wasPoints = was?.checkpoints ?? [], nowPoints = now?.checkpoints ?? [];
    const names = [...nowPoints, ...wasPoints.filter(point => !nowPoints.some(other => keyOf(other.name) === keyOf(point.name)))].map(point => point.name);
    return names.map(checkpoint => {
      const old = wasPoints.find(point => keyOf(point.name) === keyOf(checkpoint)), current = nowPoints.find(point => keyOf(point.name) === keyOf(checkpoint));
      return { flow: name, checkpoint, ...(old ? { before: side(before, old) } : {}), ...(current ? { after: side(after, current) } : {}) };
    });
  });
}
