import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CiError } from "../shared/ci-errors.js";
import { renderPublicComment, platformSectionMerge, type PublicCommentState } from "./pr-comment-body.js";
import { upsertStickyComment } from "./pr-comment.js";
import { viewerLinks } from "./viewer-links.js";
import type { ExplorePlatform } from "../config/explore-config.js";

export type FailureCommentOptions = {
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  runId: string;
  runAttempt: string;
  /** The directory the failure job downloaded diagnostics artifacts into (`<stage>/<artifact>/…/error.json`). */
  diagnosticsPath?: string;
  platform?: ExplorePlatform;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
};

type Diagnostic = { code: string; stage: string; message: string; nextAction: string };
const SHA = /^[0-9a-f]{40}$/;
const ARTIFACT_DIR = /^explore-[a-z-]+-\d+-\d+-(ios|android)$/;

const MAX_DIAGNOSTIC_BYTES = 32_768;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STAGE = /^[a-z][a-z0-9-]{0,63}$/;

function parseDiagnostic(text: string, stage: string): Diagnostic | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const field = (name: string, max: number) => typeof value[name] === "string" && (value[name] as string).trim() && (value[name] as string).length <= max ? value[name] as string : undefined;
  const code = field("code", 64), message = field("message", 4000), nextAction = field("nextAction", 4000), stageName = field("stage", 64) ?? stage;
  if (!code || !CODE.test(code) || !message || !nextAction || !STAGE.test(stageName)) return undefined;
  if ("retryable" in value && typeof value.retryable !== "boolean") return undefined;
  return { code, stage: stageName, message, nextAction };
}

/**
 * The error.json a failed job left behind and the platform its artifact name carries. A report failure's
 * diagnostic takes precedence over capture's; a present but unreadable file yields the generic failure
 * rather than an earlier stage's error, and only regular files count (never symlinks out of the artifact).
 */
export async function locateFailureDiagnostic(root: string): Promise<{ diagnostic?: Diagnostic; platform: ExplorePlatform } | undefined> {
  for (const [stage, file] of [["report", "error.json"], ["capture", join("explore-diagnostics", "error.json")]] as const) {
    const entries = await readdir(join(root, stage), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(entry => entry.isDirectory() && ARTIFACT_DIR.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(root, stage, entry.name, file);
      const info = await lstat(path).catch(() => undefined);
      if (!info) continue;
      const platform = ARTIFACT_DIR.exec(entry.name)![1] as ExplorePlatform;
      if (!info.isFile() || info.size > MAX_DIAGNOSTIC_BYTES) return { platform };
      const diagnostic = parseDiagnostic(await readFile(path, "utf8"), stage);
      return diagnostic ? { diagnostic, platform } : { platform };
    }
  }
  return undefined;
}

/**
 * The failure job's comment: a job died outside Explore's own progress comments (install, checkout, a crash
 * before the pipeline posted), so the sticky comment gets a failed record for that platform from the same
 * renderer every other writer uses. Nothing is posted when the PR is closed; a PR that moved on is marked
 * superseded so the failure lands under previous runs.
 */
export async function publishFailureComment(options: FailureCommentOptions): Promise<{ posted: boolean; reason?: string; superseded?: boolean }> {
  const environment = options.environment ?? process.env;
  const transport = options.transport ?? fetch;
  const token = environment.GITHUB_TOKEN?.trim();
  if (!token) throw new CiError({ code: "GITHUB_TOKEN_MISSING", stage: "publication", message: "GITHUB_TOKEN is required to post the failure comment",
    nextAction: "Pass GITHUB_TOKEN to the failure job with PR comment write permission." });
  if (!SHA.test(options.headSha) || !SHA.test(options.baseSha)) return { posted: false, reason: "The capture job did not record the PR head and base." };
  const response = await transport(`https://api.github.com/repos/${options.repository}/pulls/${options.pullNumber}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new CiError({ code: "GITHUB_REQUEST_FAILED", stage: "publication", message: `GitHub PR lookup failed (${response.status})`,
    nextAction: "Check the token's pull request read permission and GitHub availability, then rerun the failure job.", retryable: response.status >= 500 });
  const pr = await response.json() as Record<string, any>;
  if (pr.state !== "open" || pr.draft || pr.head?.repo?.full_name !== options.repository || pr.base?.repo?.full_name !== options.repository) {
    return { posted: false, reason: "The PR is no longer an open same-repository PR." };
  }
  const superseded = pr.head?.sha !== options.headSha || pr.base?.sha !== options.baseSha;
  const located = options.diagnosticsPath ? await locateFailureDiagnostic(options.diagnosticsPath) : undefined;
  const platform = options.platform ?? located?.platform;
  const configPath = options.configPath ?? ".expo-explore/config.yaml";
  const now = Date.now();
  const diagnostic = located?.diagnostic;
  const state: PublicCommentState = {
    phase: "failed", mode: "changes", executionMode: "deterministic", configPath,
    pullRequest: { repositoryId: String(pr.base?.repo?.id ?? ""), repository: options.repository, number: options.pullNumber, title: String(pr.title ?? ""), url: String(pr.html_url ?? ""),
      base: { ref: String(pr.base?.ref ?? ""), sha: options.baseSha }, head: { ref: String(pr.head?.ref ?? ""), sha: options.headSha } },
    links: viewerLinks({ repository: options.repository, headSha: options.headSha, runId: options.runId, runAttempt: options.runAttempt, configPath, ...(platform ? { platform } : {}) }),
    startedAt: now, updatedAt: now, artifactOnly: true,
    ...(platform ? { build: { platform, easProfile: "" } } : {}),
    failure: { step: diagnostic?.stage ?? "workflow", message: diagnostic
      ? `${diagnostic.code}: ${diagnostic.message} Next action: ${diagnostic.nextAction}`
      : "Explore could not finish this review. See the run for the error code, cause, and next action. Fix the reported issue and rerun Explore." },
    ...(superseded ? { superseded: true } : {}),
  };
  await upsertStickyComment({ repository: options.repository, issueNumber: options.pullNumber, body: renderPublicComment(state),
    ...platformSectionMerge(state, platform), token, fetchImpl: transport });
  return { posted: true, ...(superseded ? { superseded: true } : {}) };
}
