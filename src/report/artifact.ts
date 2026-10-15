import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertPublicReview, projectPublicReviewForReport } from "../contracts/review-validation.js";
import { createHash } from "node:crypto";
import type { ArtifactReport } from "../contracts/artifact-report.js";
import { projectReviewPresentation } from "../contracts/review.js";
import { renderPublicComment, platformSectionMerge, type PublicCommentState } from "./pr-comment-body.js";
import type { ExplorePlatform } from "../config/explore-config.js";
import { upsertStickyComment } from "./pr-comment.js";
import { previewLinks, viewerLinks } from "./viewer-links.js";
import type { PublicReview } from "../contracts/capture.js";
import { CiError, toCiError } from "../shared/ci-errors.js";

const CONTRACT = "explore.report-input";
/** The reviewed config's hosted-preview request, carried to the credentialed deploy job. */
export type CiPreviewRequest = { hosting: "eas"; expiresAfterDays: number | null; owner?: string; project?: string };
export type CiReportInput = {
  contract: typeof CONTRACT;
  publicReview: PublicReview;
  assets: Array<{ sha256: string; path: string }>;
  commentState: PublicCommentState;
  preview?: CiPreviewRequest;
};

/** The app's directory relative to its Git repository root, "." at the root. */
export async function readAppDirectory(project: string): Promise<string> {
  const result = spawnSync("git", ["-C", project, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot resolve the app's repository directory");
  const root = await realpath(result.stdout.trim());
  return relative(root, await realpath(project)).split(sep).join("/") || ".";
}

export async function writeCiReportInput(input: Omit<CiReportInput, "contract"> & { inputPath: string }): Promise<void> {
  const directory = dirname(resolve(input.inputPath));
  const assets = input.assets.map(asset => {
    const path = relative(directory, asset.path).split(sep).join("/");
    if (!path || path.startsWith("../") || isAbsolute(path)) throw new Error("Report images must be inside the capture output directory");
    return { sha256: asset.sha256, path };
  });
  const publicReview = projectPublicReviewForReport(input.publicReview);
  const commentState = { ...input.commentState,
    ...(input.commentState.review ? { review: projectPublicReviewForReport(input.commentState.review) } : {}) };
  await writeFile(input.inputPath, JSON.stringify({ contract: CONTRACT, publicReview,
    assets, commentState, ...(input.preview ? { preview: input.preview } : {}) }), { flag: "wx" });
}

export async function readCiReportInput(inputPath: string): Promise<CiReportInput> { return readInput(inputPath); }

async function readInput(inputPath: string): Promise<CiReportInput> {
  try { return await readInputUnchecked(inputPath); }
  catch (error) { throw toCiError(error, { code: "REPORT_INPUT_INVALID", stage: "export",
    nextAction: "Use the report-input.json and matching image files produced by this capture job. Rerun capture if the input is missing, malformed, or inconsistent." }); }
}

async function readInputUnchecked(inputPath: string): Promise<CiReportInput> {
  const raw = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(raw) > 50 * 1024 * 1024) throw new Error("Report input exceeds its size limit");
  const input = JSON.parse(raw) as CiReportInput;
  if (input.contract !== CONTRACT || !Array.isArray(input.assets)) throw new Error("Invalid CI report input");
  assertPublicReview(input.publicReview);
  if (JSON.stringify(projectReviewPresentation(input.commentState.pullRequest)) !== JSON.stringify(input.publicReview.pullRequest)) {
    throw new Error("Comment state does not match the captured pull request");
  }
  if (input.preview !== undefined) {
    const preview = input.preview;
    if (preview.hosting !== "eas" || (preview.expiresAfterDays !== null && (!Number.isInteger(preview.expiresAfterDays) || preview.expiresAfterDays < 1 || preview.expiresAfterDays > 365))
      || (preview.project !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(preview.project))
      || (preview.owner !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(preview.owner))) {
      throw new Error("Invalid hosted preview request");
    }
  }
  return input;
}

export async function exportCiReport(options: { inputPath: string; outputPath: string }) {
  try { return await exportCiReportUnchecked(options); }
  catch (error) { throw toCiError(error, { code: "REPORT_EXPORT_FAILED", stage: "export",
    nextAction: "Use a new output directory and the complete capture artifact. Rerun capture if image files are missing, corrupt, or outside the artifact directory." }); }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function exportCiReportUnchecked(options: { inputPath: string; outputPath: string }) {
  const input = await readInput(options.inputPath);
  const directory = await realpath(dirname(resolve(options.inputPath)));
  const assets = await Promise.all(input.assets.map(async asset => {
    if (!asset.path || isAbsolute(asset.path) || asset.path.includes("\\")
      || asset.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid report asset path");
    const path = resolve(directory, asset.path); const rel = relative(directory, path);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel) || await realpath(path) !== path || !(await lstat(path)).isFile()) {
      throw new Error("Report asset must be a regular file inside the downloaded evidence artifact");
    }
    return { sha256: asset.sha256, path };
  }));
  const outputDirectory = resolve(options.outputPath);
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(join(outputDirectory, "assets"), { recursive: true });
  const report: ArtifactReport = { kind: "explore.report", review: input.publicReview, assets: [] };
  for (const asset of assets.sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new CiError({ code: "REPORT_ASSET_INVALID", stage: "export",
      message: "Invalid report image hash", nextAction: "Rerun capture to regenerate the report input and image hashes." });
    const bytes = await readFile(asset.path);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new CiError({ code: "REPORT_ASSET_HASH_MISMATCH", stage: "export",
      message: "Report image hash mismatch", nextAction: "Download the complete capture artifact again or rerun capture; do not publish modified image bytes." });
    // Launch recordings travel next to the screenshots; the Viewer reads the type from the extension.
    const path = `assets/${asset.sha256}.${bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? "png" : "mp4"}`;
    await copyFile(asset.path, join(outputDirectory, path));
    report.assets.push({ sha256: asset.sha256, path });
  }
  await writeFile(join(outputDirectory, "review.json"), JSON.stringify(report), { flag: "wx" });
  return { outputPath: outputDirectory, imageCount: report.assets.length };

}

/** Finalize only an uploaded artifact from this run while the captured PR is still current. */
export async function publishCiReportComment(options: {
  inputPath: string; artifactUrl: string; environment?: NodeJS.ProcessEnv; transport?: typeof fetch;
  /** Set by the matrix workflows: the artifact carries the platform suffix and the comment gets one section per platform. */
  platform?: ExplorePlatform;
  /** A verified hosted preview from `ci:deploy`; the comment then links to it as Explore report. */
  preview?: { url: string; expiresAt: number | null };
  /** Set by `ci:deploy` when the hosted preview failed: the comment falls back to the central Viewer and the ZIP. */
  previewFailed?: boolean;
}) {
  const environment = options.environment ?? process.env; const transport = options.transport ?? fetch;
  const input = await readInput(options.inputPath); const review = input.publicReview; const pr = review.pullRequest;
  if (pr.origin === "compare") return publishCompareSummary(input, options, environment);
  if (!environment.GITHUB_TOKEN?.trim()) throw new CiError({ code: "GITHUB_TOKEN_MISSING", stage: "preflight",
    message: "GITHUB_TOKEN is required to publish the PR report comment",
    nextAction: "Pass GITHUB_TOKEN to the publish job with Actions read and PR comment write permissions." });
  if (review.runId !== environment.GITHUB_RUN_ID || review.runAttempt !== environment.GITHUB_RUN_ATTEMPT
    || (environment.GITHUB_REPOSITORY && environment.GITHUB_REPOSITORY !== pr.repository)) {
    throw new CiError({ code: "REPORT_RUN_MISMATCH", stage: "publication",
      message: "Report input is not from the current repository run and attempt",
      nextAction: "Publish the report-input.json produced by this repository's current workflow run and attempt." });
  }
  if (pr.origin === "local") throw new Error("Local reports cannot be published as GitHub PR comments");
  const links = viewerLinks({ repository: pr.repository, headSha: pr.head.sha, runId: review.runId,
    runAttempt: review.runAttempt, configPath: input.commentState.configPath, artifactUrl: options.artifactUrl,
    ...(options.platform ? { platform: options.platform } : {}) });
  if (options.preview) links.preview = previewLinks(options.preview.url, options.preview.expiresAt, options.platform);
  else if (input.preview && !options.previewFailed) links.deploying = true;
  const api = async (path: string) => {
    let response: Response;
    try {
      response = await transport(`https://api.github.com/repos/${pr.repository}/${path}`, {
        headers: { authorization: `Bearer ${environment.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new CiError({ code: "GITHUB_NETWORK_FAILED", stage: "publication",
        message: "Report publication could not reach GitHub.", retryable: true,
        nextAction: "Check GitHub availability and runner connectivity, then rerun the publication job.", cause: error });
    }
    if (!response.ok) {
      const limited = response.status === 429 || response.status === 403
        && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
      const code = limited ? "GITHUB_RATE_LIMITED" : response.status === 401 ? "GITHUB_TOKEN_INVALID"
        : response.status === 403 ? "GITHUB_PERMISSION_DENIED" : response.status === 404 ? "GITHUB_RESOURCE_NOT_FOUND" : "GITHUB_REQUEST_FAILED";
      const nextAction = limited ? "Wait for GitHub's rate limit to reset, then rerun the publication job."
        : response.status === 401 ? "Use a valid GitHub token. Replace GITHUB_TOKEN and pass it to the publish job."
        : response.status === 403 ? "Grant this job Actions read and PR comment write permissions for the report repository."
        : response.status === 404 ? "Check the repository, run, artifact ID, and token repository access; rerun capture if the artifact was deleted."
        : "Check GitHub service status and rerun the publication job after the request failure is resolved.";
      throw new CiError({ code, stage: "publication", message: `Report publication GitHub check failed (${response.status})`,
        nextAction, retryable: limited || response.status >= 500,
        details: { status: response.status, repository: pr.repository, operation: path } });
    }
    try { return await response.json() as Record<string, any>; }
    catch (error) { throw new CiError({ code: "GITHUB_RESPONSE_INVALID", stage: "publication",
      message: "GitHub returned invalid report metadata.", nextAction: "Rerun publication; if the response remains invalid, inspect the GitHub metadata request.", cause: error }); }
  };
  const artifact = await api(`actions/artifacts/${new URL(options.artifactUrl).pathname.split("/").at(-1)}`);
  if (artifact.expired || artifact.name !== `explore-review-${review.runId}-${review.runAttempt}${options.platform ? `-${options.platform}` : ""}` || String(artifact.workflow_run?.id) !== review.runId) {
    throw new CiError({ code: artifact.expired ? "REPORT_ARTIFACT_EXPIRED" : "REPORT_ARTIFACT_MISMATCH", stage: "publication",
      message: "The uploaded report artifact is unavailable or belongs to another run",
      nextAction: artifact.expired ? "Rerun Explore to upload a fresh report artifact." : "Pass the final report artifact from this workflow run and attempt." });
  }
  const attempt = await api(`actions/runs/${review.runId}/attempts/${review.runAttempt}`);
  if (String(attempt.id) !== review.runId || String(attempt.run_attempt) !== review.runAttempt) throw new CiError({ code: "REPORT_RUN_MISMATCH", stage: "publication",
    message: "Report run attempt mismatch", nextAction: "Publish the artifact and report input from the same current workflow attempt." });
  const current = await api(`pulls/${pr.number}`);
  if (current.state !== "open" || current.head?.repo?.full_name !== pr.repository || current.head?.ref !== pr.head.ref) {
    throw new CiError({ code: "PR_CHANGED", stage: "publication", message: "PR closed or changed branches before the report artifact was ready",
      nextAction: "Run Explore for the current PR head and base before publishing a ready report." });
  }
  // The PR moved while the run worked: the report still publishes, listed under previous runs.
  const superseded = current.head?.sha !== pr.head.sha || current.base?.sha !== pr.base.sha;
  const state: PublicCommentState = { ...input.commentState, phase: "ready", updatedAt: Date.now(),
    review, links, artifactOnly: true, ...(superseded ? { superseded: true } : {}) };
  const body = renderPublicComment(state);
  let previousBody: string | undefined;
  try { previousBody = (await upsertStickyComment({ repository: pr.repository, issueNumber: pr.number, body, ...platformSectionMerge(state, options.platform),
    token: environment.GITHUB_TOKEN, fetchImpl: transport })).previousBody; }
  catch (error) { throw toCiError(error, { code: "COMMENT_PUBLICATION_FAILED", stage: "publication",
    nextAction: "Grant the GitHub token PR comment write permission and retry publication for the current PR head." }); }
  return { artifactUrl: links.viewer!.open, headSha: pr.head.sha, ...(links.preview ? { previewUrl: links.preview.open } : {}),
    ...(previousBody !== undefined ? { previousBody } : {}) };
}

/**
 * A comparison has no pull request to comment on: `ci:publish` links its report from the run summary instead,
 * with the same Open (central Viewer) and zip links a PR comment carries for this platform.
 */
async function publishCompareSummary(input: CiReportInput, options: { artifactUrl: string; platform?: ExplorePlatform }, environment: NodeJS.ProcessEnv) {
  const review = input.publicReview; const comparison = review.pullRequest;
  if (review.runId !== environment.GITHUB_RUN_ID || review.runAttempt !== environment.GITHUB_RUN_ATTEMPT
    || (environment.GITHUB_REPOSITORY && environment.GITHUB_REPOSITORY !== comparison.repository)) {
    throw new CiError({ code: "REPORT_RUN_MISMATCH", stage: "publication",
      message: "Report input is not from the current repository run and attempt",
      nextAction: "Publish the report-input.json produced by this repository's current workflow run and attempt." });
  }
  const links = viewerLinks({ repository: comparison.repository, headSha: comparison.head.sha, runId: review.runId,
    runAttempt: review.runAttempt, configPath: input.commentState.configPath, artifactUrl: options.artifactUrl,
    ...(options.platform ? { platform: options.platform } : {}) });
  const changes = input.commentState.review ?? review;
  const count = changes.surfaces.filter(surface => surface.review ? surface.review.status !== "unchanged" && surface.review.status !== "variant" : surface.status !== "unchanged").length;
  const platform = (options.platform ?? review.runtime.platform) === "android" ? "Android" : "iOS";
  if (environment.GITHUB_STEP_SUMMARY) {
    await appendFile(environment.GITHUB_STEP_SUMMARY, `- ${platform} report of ${comparison.title}: [Open](${links.viewer!.open}) · [zip](${links.download!}) · ${count} ${count === 1 ? "change" : "changes"}\n`);
  }
  return { artifactUrl: links.viewer!.open, headSha: comparison.head.sha };
}
