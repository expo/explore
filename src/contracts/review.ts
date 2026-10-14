import type { WhatChangedSummary } from "../review/reviewer-changes.js";
import type { RuntimeEvidenceComparison } from "../review/runtime-evidence.js";

export const REVIEW_WORKSPACE_CONTRACT = "expo.explore.review-workspace.v0" as const;
export const REVIEW_PUBLICATION_CONTRACT = "expo.explore.review-publication.v0" as const;

export type PullRequestSidePresentation = {
  ref: string;
  sha: string;
};

export type PullRequestPresentation = {
  origin?: "github";
  repositoryId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  base: PullRequestSidePresentation;
  head: PullRequestSidePresentation;
};

/** A local comparison has source revisions, but no GitHub PR or repository id. */
export type LocalReviewPresentation = {
  origin: "local";
  repository: string;
  runId: string;
  title: string;
  base: PullRequestSidePresentation;
  head: PullRequestSidePresentation;
  repositoryId?: never;
  number?: never;
  url?: never;
};
export type ReviewPresentation = PullRequestPresentation | LocalReviewPresentation;

export function projectReviewPresentation(value: unknown): ReviewPresentation {
  const candidate = record(value, "Review presentation");
  if (candidate.origin !== "local") return projectPullRequestPresentation(value);
  exactKeys(candidate, ["origin", "repository", "runId", "title", "base", "head"], [], "Local review");
  const runId = text(candidate.runId, "Local run", 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(runId)) throw new Error("Invalid local run id");
  return { origin: "local", repository: repository(candidate.repository), runId,
    title: text(candidate.title, "Local review title"),
    base: pullRequestSide(candidate.base, "base"), head: pullRequestSide(candidate.head, "head") };
}

export type SanitizedSourceImpact = {
  kind: "none" | "direct" | "global";
  changedFileCount: number;
};

export type ReviewSurfaceProjection = {
  id: string;
  sourceScreenId: string;
  comparisonEntryId?: string;
  status: "added" | "removed" | "modified" | "unchanged" | "needs-review" | "source-affected" | "not-compared";
  whatChanged: WhatChangedSummary;
  runtimeEvidenceRef: string;
  sourceImpact: SanitizedSourceImpact;
  needsReview: boolean;
};

export type ReviewWorkspaceProjection = {
  contract: typeof REVIEW_WORKSPACE_CONTRACT;
  pullRequest: PullRequestPresentation;
  surfaces: Record<string, ReviewSurfaceProjection>;
  runtimeEvidence: Record<string, RuntimeEvidenceComparison>;
};

export type ReviewArtifactInventoryEntry = {
  path: string;
  sha256: string;
  bytes: number;
  mimeType: "application/json" | "image/png" | "image/jpeg" | "video/mp4";
};

export type ReviewPublication = {
  contract: typeof REVIEW_PUBLICATION_CONTRACT;
  reviewId: string;
  repositoryId: string;
  repository: string;
  pullRequest: PullRequestPresentation;
  createdAt: string;
  workspacePath: string;
  inventory: ReviewArtifactInventoryEntry[];
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  }
}

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function repository(value: unknown): string {
  const candidate = text(value, "repository", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) {
    throw new Error("repository must use owner/name form");
  }
  return candidate;
}

function repositoryId(value: unknown): string {
  const candidate = text(value, "repositoryId", 32);
  if (!/^[1-9][0-9]*$/.test(candidate)) throw new Error("repositoryId must be a decimal GitHub id");
  return candidate;
}

function fullSha(value: unknown, label: string): string {
  const candidate = text(value, label, 40);
  if (!/^[0-9a-f]{40}$/i.test(candidate)) throw new Error(`${label} must be a full Git SHA`);
  return candidate.toLowerCase();
}

function branchRef(value: unknown, label: string): string {
  const candidate = text(value, label, 255);
  if (
    candidate.startsWith("/")
    || candidate.endsWith("/")
    || candidate.includes("..")
    || candidate.includes("\\")
    || candidate.includes("@{")
  ) {
    throw new Error(`${label} is not a safe branch ref`);
  }
  return candidate;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function pullRequestSide(value: unknown, label: string): PullRequestSidePresentation {
  const candidate = record(value, label);
  exactKeys(candidate, ["ref", "sha"], [], label);
  return {
    ref: branchRef(candidate.ref, `${label}.ref`),
    sha: fullSha(candidate.sha, `${label}.sha`),
  };
}

/** Strictly project live GitHub PR metadata before it enters a published workspace. */
export function projectPullRequestPresentation(value: unknown): PullRequestPresentation {
  const candidate = record(value, "Pull request presentation");
  exactKeys(
    candidate,
    ["repositoryId", "repository", "number", "title", "url", "base", "head"],
    [],
    "Pull request presentation",
  );
  const repo = repository(candidate.repository);
  const number = positiveInteger(candidate.number, "pull request number");
  const urlValue = text(candidate.url, "pull request URL", 500);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("pull request URL must be absolute");
  }
  const expectedPath = `/${repo}/pull/${number}`;
  if (
    url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname.replace(/\/$/, "") !== expectedPath
  ) {
    throw new Error("pull request URL must be the canonical github.com PR URL");
  }
  const base = pullRequestSide(candidate.base, "base");
  const head = pullRequestSide(candidate.head, "head");
  if (base.sha === head.sha) throw new Error("pull request base and head SHAs must differ");
  return {
    repositoryId: repositoryId(candidate.repositoryId),
    repository: repo,
    number,
    title: text(candidate.title, "pull request title", 512),
    url: url.href,
    base,
    head,
  };
}
