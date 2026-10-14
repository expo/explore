import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type VisualDiffRegion = {
  index: number;
  rect: { x: number; y: number; width: number; height: number };
  normalizedRect: { x: number; y: number; width: number; height: number };
  differentPixels: number;
  shareOfDiffPercentage: number;
  densityPercentage: number;
  shape: string;
  size: string;
  location: string;
  dominantChange: string;
};

export type ScreenshotDiffMeasurement = {
  baselinePath: string;
  currentPath: string;
  totalPixels: number;
  differentPixels: number;
  mismatchPercentage: number;
  match: boolean;
  regions: VisualDiffRegion[];
};

export type VisualEvidenceAssessment = {
  status: "unchanged" | "modified" | "needs-review";
  reason:
    | "matched"
    | "repeated-cross-build-delta"
    | "insufficient-samples"
    | "within-side-instability"
    | "inconsistent-cross-build-delta";
  baselineSamples: number;
  currentSamples: number;
  requiredSamples: 1 | 3;
  withinSideNoisePercentage: number;
  crossBuildMismatchPercentage?: number;
  representative?: ScreenshotDiffMeasurement;
};

type AgentDeviceDiffPayload = {
  success: true;
  data: {
    regions?: VisualDiffRegion[];
    totalPixels: number;
    differentPixels: number;
    mismatchPercentage: number;
    match: boolean;
  };
};

function finiteNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`agent-device screenshot diff returned invalid ${name}`);
  }
  return value;
}

function parseMeasurement(
  stdout: string,
  baselinePath: string,
  currentPath: string,
): ScreenshotDiffMeasurement {
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("agent-device screenshot diff did not return JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || !("success" in value)
    || value.success !== true
    || !("data" in value)
    || typeof value.data !== "object"
    || value.data === null
  ) {
    throw new Error("agent-device screenshot diff returned an invalid response");
  }
  const data = (value as AgentDeviceDiffPayload).data;
  if (
    typeof data.match !== "boolean"
    || (data.regions !== undefined && !Array.isArray(data.regions))
  ) {
    throw new Error("agent-device screenshot diff returned invalid evidence");
  }
  return {
    baselinePath,
    currentPath,
    totalPixels: finiteNonNegative(data.totalPixels, "totalPixels"),
    differentPixels: finiteNonNegative(data.differentPixels, "differentPixels"),
    mismatchPercentage: finiteNonNegative(data.mismatchPercentage, "mismatchPercentage"),
    match: data.match,
    regions: data.regions ?? [],
  };
}

async function canonicalPng(path: string): Promise<string> {
  const declared = await lstat(path);
  if (!declared.isFile() || declared.isSymbolicLink()) {
    throw new Error(`Screenshot must be a regular file: ${path}`);
  }
  const canonical = await realpath(path);
  const bytes = await readFile(canonical);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < pngSignature.length || !bytes.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`Screenshot must be a PNG: ${path}`);
  }
  return canonical;
}

export async function diffScreenshots(options: {
  baselinePath: string;
  currentPath: string;
  threshold?: number;
  timeoutMs?: number;
  command: string;
}): Promise<ScreenshotDiffMeasurement> {
  const threshold = options.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Screenshot diff threshold must be between 0 and 1");
  }
  const [baselinePath, currentPath] = await Promise.all([
    canonicalPng(options.baselinePath),
    canonicalPng(options.currentPath),
  ]);
  if (
    !options.command
    || !isAbsolute(options.command)
    || /[\u0000-\u001f\u007f]/.test(options.command)
  ) throw new Error("agent-device command must be an absolute path");
  const result = spawnSync(
    options.command,
    [
      "--json",
      "diff",
      "screenshot",
      "--baseline",
      baselinePath,
      currentPath,
      "--threshold",
      String(threshold),
    ],
    {
      encoding: "utf8",
      shell: false,
      timeout: options.timeoutMs ?? 60_000,
      env: {
        PATH: process.env.PATH,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw new Error(`Could not run screenshot diff: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim().slice(0, 500);
    throw new Error(`Screenshot diff failed: ${detail}`);
  }
  return parseMeasurement(result.stdout, baselinePath, currentPath);
}

function maxMismatch(values: readonly ScreenshotDiffMeasurement[]): number {
  return values.reduce((maximum, value) => Math.max(maximum, value.mismatchPercentage), 0);
}

export function assessVisualMeasurements(options: {
  baselineSamples: number;
  currentSamples: number;
  requiredSamples: 1 | 3;
  baselineWithin: readonly ScreenshotDiffMeasurement[];
  currentWithin: readonly ScreenshotDiffMeasurement[];
  crossBuild: readonly ScreenshotDiffMeasurement[];
  representative?: ScreenshotDiffMeasurement;
}): VisualEvidenceAssessment {
  const base = {
    baselineSamples: options.baselineSamples,
    currentSamples: options.currentSamples,
    requiredSamples: options.requiredSamples,
  } as const;
  const withinSideNoisePercentage = Math.max(
    maxMismatch(options.baselineWithin),
    maxMismatch(options.currentWithin),
  );
  if (
    options.baselineSamples < options.requiredSamples
    || options.currentSamples < options.requiredSamples
  ) {
    return {
      ...base,
      status: "needs-review",
      reason: "insufficient-samples",
      withinSideNoisePercentage,
    };
  }
  if (
    options.baselineWithin.some((measurement) => !measurement.match)
    || options.currentWithin.some((measurement) => !measurement.match)
  ) {
    return {
      ...base,
      status: "needs-review",
      reason: "within-side-instability",
      withinSideNoisePercentage,
    };
  }
  if (options.crossBuild.length === 0) {
    return {
      ...base,
      status: "needs-review",
      reason: "inconsistent-cross-build-delta",
      withinSideNoisePercentage,
    };
  }
  // A mismatch that rounds to 0.00% is rendering noise, not a difference a reviewer can see.
  const differs = (measurement: ScreenshotDiffMeasurement) => !measurement.match
    && Math.round(measurement.mismatchPercentage * 100) / 100 > 0;
  if (options.crossBuild.every((measurement) => !differs(measurement))) {
    return {
      ...base,
      status: "unchanged",
      reason: "matched",
      withinSideNoisePercentage,
      crossBuildMismatchPercentage: maxMismatch(options.crossBuild),
      ...(options.representative ? { representative: options.representative } : {}),
    };
  }
  // This is a measurement only. Whether a difference is a code change or a runtime state is
  // decided with the source plan (evidence-assessment.ts `decideReview`).
  const repeated = options.crossBuild.every((measurement) => (
    differs(measurement) && measurement.mismatchPercentage > withinSideNoisePercentage
  ));
  if (!repeated) {
    return {
      ...base,
      status: "needs-review",
      reason: "inconsistent-cross-build-delta",
      withinSideNoisePercentage,
      crossBuildMismatchPercentage: maxMismatch(options.crossBuild),
      ...(options.representative ? { representative: options.representative } : {}),
    };
  }
  return {
    ...base,
    status: "modified",
    reason: "repeated-cross-build-delta",
    withinSideNoisePercentage,
    crossBuildMismatchPercentage: options.representative?.mismatchPercentage
      ?? maxMismatch(options.crossBuild),
    ...(options.representative ? { representative: options.representative } : {}),
  };
}
