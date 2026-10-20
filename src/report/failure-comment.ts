import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CiError } from "../shared/ci-errors.js";
import { renderPublicComment, platformSectionMerge, type PublicCommentState } from "./pr-comment-body.js";
import { upsertStickyComment } from "./pr-comment.js";
import { viewerLinks } from "./viewer-links.js";
import { isTargetId, type ExplorePlatform } from "../config/explore-config.js";

export type FailureCommentOptions = {
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  runId: string;
  runAttempt: string;
  /** The directory the failure job downloaded diagnostics artifacts into (`<stage>/<artifact>/…/error.json`). */
  diagnosticsPath?: string;
  /** The failed target's id; otherwise every target the diagnostics artifacts name. */
  target?: string;
  /** What callers from before targets pass: a platform is the id of its default target. */
  platform?: ExplorePlatform;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
};

type Diagnostic = { code: string; stage: string; message: string; nextAction: string };
/** A failed target's diagnostic. `target` is absent when neither the artifact's name nor the file names one. */
export type LocatedFailure = { diagnostic?: Diagnostic; target?: string; platform?: ExplorePlatform };
const SHA = /^[0-9a-f]{40}$/;
// `explore-<kind>-<run>-<attempt>-<target>`: the kind has no digits, so the first number is the run and the rest is the target id.
const ARTIFACT_DIR = /^explore-[a-z-]+-\d+-\d+-([a-z][a-z0-9-]{0,31})$/;
const artifactTarget = (name: string): string | undefined => { const id = ARTIFACT_DIR.exec(name)?.[1]; return isTargetId(id) ? id : undefined; };

const MAX_DIAGNOSTIC_BYTES = 32_768;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STAGE = /^[a-z][a-z0-9-]{0,63}$/;

function parseJson(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

function parseDiagnostic(value: Record<string, unknown> | undefined, stage: string): Diagnostic | undefined {
  if (!value) return undefined;
  const field = (name: string, max: number) => typeof value[name] === "string" && (value[name] as string).trim() && (value[name] as string).length <= max ? value[name] as string : undefined;
  const code = field("code", 64), message = field("message", 4000), nextAction = field("nextAction", 4000), stageName = field("stage", 64) ?? stage;
  if (!code || !CODE.test(code) || !message || !nextAction || !STAGE.test(stageName)) return undefined;
  if ("retryable" in value && typeof value.retryable !== "boolean") return undefined;
  return { code, stage: stageName, message, nextAction };
}

/** Reads one error.json; `named` is the target its artifact directory names, else the one the file records. */
async function readFailure(path: string, stage: string, named: string | undefined): Promise<LocatedFailure | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return undefined;
  const located = (target: string | undefined): LocatedFailure => ({ ...(target ? { target } : {}), ...(target === "ios" || target === "android" ? { platform: target as ExplorePlatform } : {}) });
  if (!info.isFile() || info.size > MAX_DIAGNOSTIC_BYTES) return located(named);
  const value = parseJson(await readFile(path, "utf8"));
  const target = named ?? (isTargetId(value?.target) ? value.target : undefined);
  const diagnostic = parseDiagnostic(value, stage);
  return diagnostic ? { diagnostic, ...located(target) } : located(target);
}

/**
 * Every failed target's error.json and the target it belongs to (`ios` or `android` for a config without targets, and
 * for artifacts of versions before targets). actions/download-artifact puts each artifact a pattern matches in a
 * directory named after it, except when the pattern matches exactly one: that one lands in the stage's directory
 * itself, and the file names its target. A report failure's diagnostic takes precedence over its target's capture
 * diagnostic; a present but unreadable file yields the generic failure rather than an earlier stage's error, and only
 * regular files count (never symlinks out of the artifact). `platform` is set when the target id is a platform's.
 */
export async function locateFailureDiagnostics(root: string): Promise<LocatedFailure[]> {
  const failures: LocatedFailure[] = [];
  const seen = new Set<string>();
  for (const [stage, file] of [["report", "error.json"], ["capture", join("explore-diagnostics", "error.json")]] as const) {
    const entries = await readdir(join(root, stage), { withFileTypes: true }).catch(() => []);
    const candidates = [...entries.filter(entry => entry.isDirectory() && artifactTarget(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({ path: join(root, stage, entry.name, file), named: artifactTarget(entry.name) })), { path: join(root, stage, file), named: undefined }];
    for (const { path, named } of candidates) {
      const located = await readFailure(path, stage, named);
      if (!located || seen.has(located.target ?? "")) continue;
      seen.add(located.target ?? "");
      failures.push(located);
    }
  }
  return failures;
}

/** The first failure locateFailureDiagnostics finds: a report failure before a capture failure. */
export async function locateFailureDiagnostic(root: string): Promise<LocatedFailure | undefined> {
  return (await locateFailureDiagnostics(root))[0];
}

/**
 * The failure job's comment: a job died outside Explore's own progress comments (install, checkout, a crash
 * before the pipeline posted), so the sticky comment gets a failed record for each failed target from the same
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
  const requested = options.target ?? options.platform;
  if (requested !== undefined && !isTargetId(requested)) throw new CiError({ code: "TARGET_INVALID", stage: "publication", message: `${requested} is not a target id.`,
    nextAction: "Pass --target with an id from targets: in .expo-explore/config.yaml (ios or android without targets:)." });
  const response = await transport(`https://api.github.com/repos/${options.repository}/pulls/${options.pullNumber}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new CiError({ code: "GITHUB_REQUEST_FAILED", stage: "publication", message: `GitHub PR lookup failed (${response.status})`,
    nextAction: "Check the token's pull request read permission and GitHub availability, then rerun the failure job.", retryable: response.status >= 500 });
  const pr = await response.json() as Record<string, any>;
  if (pr.state !== "open" || pr.draft || pr.head?.repo?.full_name !== options.repository || pr.base?.repo?.full_name !== options.repository) {
    return { posted: false, reason: "The PR is no longer an open same-repository PR." };
  }
  const superseded = pr.head?.sha !== options.headSha || pr.base?.sha !== options.baseSha;
  const located = options.diagnosticsPath ? await locateFailureDiagnostics(options.diagnosticsPath) : [];
  // Each failed target gets its own failed record: since one target's failed capture no longer stops the others'
  // reports (brentvatne/euxy#172), several targets of one run can fail in different jobs.
  const failures: LocatedFailure[] = requested !== undefined ? [{ ...(located.find(failure => failure.target === requested) ?? located[0]), target: requested }]
    : located.length ? located : [{}];
  for (const { target, diagnostic } of failures) {
    // The failure job knows a target by its id alone; the comment's own record for that id supplies its label and platform.
    const platform: ExplorePlatform | undefined = target === "ios" || target === "android" ? target : undefined;
    const configPath = options.configPath ?? ".expo-explore/config.yaml";
    const now = Date.now();
    const state: PublicCommentState = {
      phase: "failed", mode: "changes", executionMode: "deterministic", configPath,
      pullRequest: { repositoryId: String(pr.base?.repo?.id ?? ""), repository: options.repository, number: options.pullNumber, title: String(pr.title ?? ""), url: String(pr.html_url ?? ""),
        base: { ref: String(pr.base?.ref ?? ""), sha: options.baseSha }, head: { ref: String(pr.head?.ref ?? ""), sha: options.headSha } },
      // No artifact URL, so no Viewer link: the target would only pick a report that this failure never uploaded.
      links: viewerLinks({ repository: options.repository, headSha: options.headSha, runId: options.runId, runAttempt: options.runAttempt, configPath }),
      startedAt: now, updatedAt: now, artifactOnly: true,
      ...(platform ? { build: { platform, easProfile: "" } } : {}),
      failure: { step: diagnostic?.stage ?? "workflow", message: diagnostic
        ? `${diagnostic.code}: ${diagnostic.message} Next action: ${diagnostic.nextAction}`
        : "Explore could not finish this review. See the run for the error code, cause, and next action. Fix the reported issue and rerun Explore." },
      ...(superseded ? { superseded: true } : {}),
    };
    await upsertStickyComment({ repository: options.repository, issueNumber: options.pullNumber, body: renderPublicComment(state, undefined, target),
      ...platformSectionMerge(state, target), token, fetchImpl: transport });
  }
  return { posted: true, ...(superseded ? { superseded: true } : {}) };
}
