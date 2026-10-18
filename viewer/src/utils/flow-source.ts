import type { PublicFlowEvidence, PublicReview } from "../../../src/contracts/capture";

/** The flow a flow-frame screen belongs to, and the frame's key, from `flow:<flowId>/<key>` (with any side prefix). */
export function flowOfScreen(review: PublicReview | undefined, screenId: string): { flow: PublicFlowEvidence; key: string } | undefined {
  const match = /flow:([a-z0-9-]+\/[a-z0-9-]+)\/([a-z0-9-]+)$/.exec(screenId);
  if (!match || !Array.isArray(review?.flows)) return undefined;
  const flow = review.flows.find(entry => entry.id === match[1]);
  return flow ? { flow, key: match[2]! } : undefined;
}

/** The e2e file at the head commit on GitHub, at a line when known; undefined when the review names no GitHub repository. */
export function flowSourceHref(review: Pick<PublicReview, "pullRequest"> | undefined, file: string, line?: number): string | undefined {
  const presentation = review?.pullRequest as { repository?: string; head?: { sha?: string } } | undefined;
  const repository = presentation?.repository; const sha = presentation?.head?.sha;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !sha || !/^[0-9a-f]{40}$/i.test(sha)) return undefined;
  return `https://github.com/${repository}/blob/${sha}/${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
}
