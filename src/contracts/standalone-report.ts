import type { PublicReview } from "./capture.js";
import type { FlowReview } from "./flow-comparison.js";
import type { BuildWorkspacePayload, Coverage, ExploreMap } from "../types.js";

export const STANDALONE_REPORT_CONTRACT = "expo.explore.standalone-report.v1" as const;
export const EMBEDDED_ASSET_PREFIX = "expo-explore-asset:";

/** Original screenshot bytes live after the Viewer bootstrap, outside the metadata JSON. */
export type EmbeddedScreenshot = {
  mimeType: "image/png" | "image/jpeg" | "video/mp4";
  byteLength: number;
};

export const EXPLORATION_REPORT_KIND = "explore.exploration-report" as const;

/**
 * One flow of a flows file, as a run took it. Its checkpoints keep the file's names and order, so two runs of the same
 * flow pair up step by step; a checkpoint the run has no picture of says why instead of naming an observation.
 */
export type ExplorationFlow = {
  name: string;
  /** `failed`: a step, the relaunch before it, or reading a checkpoint's screen failed. A checkpoint whose screen withheld its picture does not fail the flow. `stopped`: the run ended (a budget, an error) before or during the flow. */
  status: "completed" | "failed" | "stopped";
  reason?: string;
  /** The map's journeys for the flow: its walk from the screen it started on, in parts where the app moved without a transition. */
  journeyIds?: string[];
  checkpoints: Array<{ name: string; observationId: string; missing?: never } | { name: string; missing: string; observationId?: never }>;
  /** The flow's steps on this run's platform, as the flows file names them. */
  steps?: ExplorationFlowStep[];
  /** The step the flow failed at, counted from 1 in `steps`. */
  failedStep?: number;
};

/** An exact action (`tap "Settings"`), a step described in words for a model, or a checkpoint. */
export type ExplorationFlowStep = { action: string } | { do: string } | { checkpoint: string };

/** What `explore:binary` learned about one prebuilt app: provenance plus the map it explored, with no review or pull request. */
export type ExplorationReport = {
  kind: typeof EXPLORATION_REPORT_KIND;
  map: ExploreMap;
  coverage: Coverage;
  exploration: {
    app: { name: string; bundleId: string; platform: "ios" | "android"; version?: string; buildNumber?: string };
    /** Absent when the app was already installed on a session Explore attached to (explore:session). */
    archive?: { kind: string; sha256: string; bytes: number; fileName: string };
    device: { model: string; osVersion: string };
    model: { provider: string; model: string };
    budget: { maxDurationMinutes: number; maxScreens: number; maxActions: number };
    stopReason: string;
    summary?: string;
    /** Present when the run followed a flows file (`--flows`). */
    flows?: ExplorationFlow[];
    startedAt: string;
    completedAt: string;
    exploreVersion: string;
  };
  assets: Array<{ sha256: string; path: string }>;
  /** Present when compare:flows wrote this report: the run compared with an earlier run of the same flows file. */
  flowReview?: FlowReview;
};

export type EmbeddedReport = {
  contract: typeof STANDALONE_REPORT_CONTRACT;
  /** Strings support previously downloaded reports; new reports keep only a small image index here. */
  assets: Record<string, string | EmbeddedScreenshot>;
} & ({ publicReview: PublicReview; workspace?: never; exploration?: never } | {
  workspace: BuildWorkspacePayload;
  publicReview?: never;
  exploration?: never;
} | {
  exploration: ExplorationReport;
  publicReview?: never;
  workspace?: never;
});
