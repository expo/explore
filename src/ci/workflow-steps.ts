import { spawnSync } from "node:child_process";
import { appendFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { isTargetId, parseTrustedAuthors, DEFAULT_EXPLORE_CONFIG_PATH } from "../config/explore-config.js";
import { compareTitle, compareUrl, projectComparePresentation, projectPullRequestPresentation,
  type CompareReviewPresentation, type PullRequestPresentation } from "../contracts/review.js";
import { CiError } from "../shared/ci-errors.js";
import { readCiReportInput } from "../report/artifact.js";
import { TOOL_ROOT, packageBin } from "../shared/package-paths.js";

/**
 * The work the GitHub workflows used to do in inline scripts: deciding which commits a run captures and whether it
 * may, finding a baseline to reuse, and cleaning up after capture. Each is one `expo-explore ci:*` command, so a
 * fix ships with the npm release instead of a regenerated workflow.
 */

type Environment = NodeJS.ProcessEnv;
const SHA = /^[0-9a-f]{40}$/;

/** `name=value` lines for later steps; a value never spans lines. */
export async function writeStepOutputs(environment: Environment, values: Record<string, string>): Promise<void> {
  if (!environment.GITHUB_OUTPUT) return;
  await appendFile(environment.GITHUB_OUTPUT, Object.entries(values).map(([name, value]) => `${name}=${value.replace(/[\r\n]+/g, " ")}\n`).join(""));
}

/** `capture:review`'s step output: `preview=eas` when the reviewed config hosts the report, which is what starts the deploy job. */
export async function writeCaptureOutputs(inputPath: string, environment: Environment = process.env): Promise<void> {
  await writeStepOutputs(environment, { preview: (await readCiReportInput(inputPath)).preview?.hosting ?? "" });
}

function githubContext(environment: Environment) {
  const repository = environment.GITHUB_REPOSITORY ?? "";
  const token = environment.GITHUB_TOKEN?.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new CiError({ code: "CI_RUN_IDENTITY_MISSING", stage: "preflight",
    message: "GITHUB_REPOSITORY is missing.", nextAction: "Run this command inside a GitHub Actions workflow." });
  if (!token) throw new CiError({ code: "GITHUB_TOKEN_MISSING", stage: "preflight", message: "GITHUB_TOKEN is missing.",
    nextAction: "Pass GitHub's automatic github.token to this step as GITHUB_TOKEN." });
  return { repository, token };
}

/** One GitHub REST read; 404 is an answer (undefined), every other failure stops the step with what to do. */
async function githubGet<T>(path: string, context: { token: string }, transport: typeof fetch): Promise<T | undefined> {
  let response: Response;
  try {
    response = await transport(`https://api.github.com/${path}`, { redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${context.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
  } catch (error) {
    throw new CiError({ code: "GITHUB_REQUEST_FAILED", stage: "preflight", message: `GitHub could not be reached (${path}).`,
      nextAction: "Check GitHub availability and rerun the workflow.", retryable: true, cause: error });
  }
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return undefined; }
  if (!response.ok) throw new CiError({ code: response.status === 401 ? "GITHUB_TOKEN_INVALID" : response.status === 403 ? "GITHUB_PERMISSION_DENIED" : "GITHUB_REQUEST_FAILED",
    stage: "preflight", message: `GitHub answered HTTP ${response.status} for ${path}.`, retryable: response.status >= 500,
    nextAction: response.status === 403 ? "Grant this job the permissions the workflow template gives it, then rerun." : "Rerun the workflow; check GitHub's status if it keeps failing." });
  return await response.json() as T;
}

type GithubPull = {
  number: number; state: string; draft?: boolean; title: string; html_url: string; user?: { login?: string };
  base: { ref: string; sha: string; repo: { id: number; full_name: string; default_branch: string } };
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
};

/**
 * `ci:pr`: the live pull request a review captures, refused unless it is open, not a draft, from this repository,
 * and written by someone with write access or listed in ci.trustedAuthors of the default branch's config.yaml.
 */
export async function resolvePullRequest(options: { number: number; appDirectory?: string; configPath?: string; environment?: Environment; transport?: typeof fetch }):
  Promise<{ presentation: PullRequestPresentation; author: string }> {
  const environment = options.environment ?? process.env; const transport = options.transport ?? fetch;
  const context = githubContext(environment);
  if (!Number.isSafeInteger(options.number) || options.number <= 0) throw new CiError({ code: "PR_NUMBER_INVALID", stage: "preflight",
    message: "The pull request number is invalid.", nextAction: "Provide an open pull request number." });
  const pr = await githubGet<GithubPull>(`repos/${context.repository}/pulls/${options.number}`, context, transport);
  if (!pr || pr.state !== "open" || pr.draft || pr.head.repo?.full_name !== context.repository) throw new CiError({ code: "SOURCE_NOT_TRUSTED", stage: "preflight",
    message: "Capture requires an open, non-draft same-repository pull request.", nextAction: "Run Explore for an open pull request from a branch of this repository." });
  const author = pr.user?.login ?? "";
  const permission = await githubGet<{ permission?: string }>(`repos/${context.repository}/collaborators/${encodeURIComponent(author)}/permission`, context, transport);
  if (!["admin", "maintain", "write"].includes(permission?.permission ?? "")) {
    const trusted = await trustedAuthors(context, transport, pr.base.repo.default_branch, options.appDirectory, options.configPath);
    if (!trusted.logins.includes(author.toLowerCase())) throw new CiError({ code: "SOURCE_NOT_TRUSTED", stage: "preflight",
      message: `${author || "The PR author"} has no write access to this repository and is not listed in ci.trustedAuthors.`
        + (trusted.invalid ? ` The default branch's ci.trustedAuthors was ignored: ${trusted.invalid}` : ""),
      nextAction: trusted.invalid ? "Fix ci.trustedAuthors in .expo-explore/config.yaml on the default branch, then rerun Explore."
        : "The PR author must have current repository write access, or be listed in ci.trustedAuthors of .expo-explore/config.yaml on the default branch." });
  }
  for (const side of [pr.base, pr.head]) if (!SHA.test(side.sha)) throw new CiError({ code: "PR_COMMIT_INVALID", stage: "preflight",
    message: "GitHub returned an invalid commit for the pull request.", nextAction: "Refresh the PR and rerun Explore." });
  return { author, presentation: projectPullRequestPresentation({ repositoryId: String(pr.base.repo.id), repository: pr.base.repo.full_name,
    number: pr.number, title: pr.title, url: pr.html_url, base: { ref: pr.base.ref, sha: pr.base.sha }, head: { ref: pr.head.ref, sha: pr.head.sha } }) };
}

/** ci.trustedAuthors from the default branch's config: a pull request cannot add its own author. An invalid list trusts no one, and says why. */
async function trustedAuthors(context: { repository: string; token: string }, transport: typeof fetch, branch: string, appDirectory = ".", configPath = DEFAULT_EXPLORE_CONFIG_PATH): Promise<{ logins: string[]; invalid?: string }> {
  const directory = appDirectory.replace(/^\.(\/|$)/, "").replace(/\/$/, "");
  const path = `${directory ? `${directory}/` : ""}${configPath}`;
  const file = await githubGet<{ content?: string }>(`repos/${context.repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, context, transport);
  if (!file?.content) return { logins: [] };
  try { return { logins: parseTrustedAuthors(Buffer.from(file.content, "base64").toString("utf8")).map(login => login.toLowerCase()) }; }
  catch (error) { return { logins: [], invalid: error instanceof Error ? error.message : String(error) }; }
}

type GithubArtifact = { id: number; expired: boolean; workflow_run?: { id?: number } };
type GithubRun = { conclusion: string | null; workflow_id: number; head_sha: string; head_branch: string; event: string; head_repository?: { full_name?: string } };

/**
 * `ci:find-baseline`: the newest successful baseline-workflow artifact of exactly this commit, uploaded from the
 * default branch of this repository. Its id and run go to the step outputs for actions/download-artifact.
 */
export async function findBaselineArtifact(options: { sha: string; target?: string;
  /** What callers from before targets pass: a platform is the id of its default target. */ platform?: string; environment?: Environment; transport?: typeof fetch }): Promise<{ id: number; run: number } | undefined> {
  const environment = options.environment ?? process.env; const transport = options.transport ?? fetch;
  const context = githubContext(environment);
  if (!SHA.test(options.sha)) throw new CiError({ code: "SHA_INVALID", stage: "preflight", message: "The base commit must be a full SHA.", nextAction: "Pass --sha with a 40-character commit SHA." });
  const target = options.target ?? options.platform ?? "ios";
  if (!isTargetId(target)) throw new CiError({ code: "TARGET_INVALID", stage: "preflight", message: `${target} is not a target id.`,
    nextAction: "Pass --target with an id from targets: in .expo-explore/config.yaml (ios or android without targets:)." });
  const repository = await githubGet<{ default_branch: string }>(`repos/${context.repository}`, context, transport);
  const workflow = await githubGet<{ id: number }>(`repos/${context.repository}/actions/workflows/explore-baseline.yml`, context, transport);
  if (!repository || !workflow) return undefined;
  // Baselines carry the target suffix; target ios also accepts the unsuffixed name older single-platform baseline workflows uploaded.
  const names = [`explore-baseline-${options.sha}-${target}`, ...(target === "ios" ? [`explore-baseline-${options.sha}`] : [])];
  const artifacts: GithubArtifact[] = [];
  for (const name of names) for (let page = 1; page <= 10; page++) {
    const listed = await githubGet<{ artifacts: GithubArtifact[] }>(`repos/${context.repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`, context, transport);
    artifacts.push(...listed?.artifacts ?? []);
    if ((listed?.artifacts.length ?? 0) < 100) break;
  }
  for (const artifact of artifacts.filter(candidate => !candidate.expired).sort((a, b) => b.id - a.id)) {
    if (!artifact.workflow_run?.id) continue;
    const run = await githubGet<GithubRun>(`repos/${context.repository}/actions/runs/${artifact.workflow_run.id}`, context, transport);
    if (!run || run.conclusion !== "success" || run.workflow_id !== workflow.id || run.head_sha !== options.sha
      || run.head_branch !== repository.default_branch || !["push", "workflow_dispatch"].includes(run.event)
      || run.head_repository?.full_name !== context.repository) continue;
    return { id: artifact.id, run: artifact.workflow_run.id };
  }
  return undefined;
}

/**
 * `ci:find-baseline` as the workflow runs it: a baseline is optional, so a lookup that fails (a GitHub 5xx, a rate
 * limit) is a warning and no baseline, never an error. A `ci:*` error would write explore-diagnostics/error.json,
 * which the failure comment would then report as the cause of an unrelated failure, possibly on another target.
 */
export async function findOptionalBaseline(options: Parameters<typeof findBaselineArtifact>[0]):
  Promise<{ baseline?: { id: number; run: number }; warning?: { code: string; message: string } }> {
  try {
    const baseline = await findBaselineArtifact(options);
    return baseline ? { baseline } : {};
  } catch (error) {
    return { warning: { code: error instanceof CiError ? error.code : "BASELINE_LOOKUP_FAILED",
      message: `No baseline is reused, so capture captures the base too: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

/**
 * The commit a ref names in a checkout. `HEAD` (and `HEAD~1`, `@`) is the checked-out commit, never `origin/HEAD`.
 * A name is tried as a tag, then a local branch, then a branch of `origin` (all CI has after a full checkout),
 * then as git spells it (a SHA, `origin/main`, `refs/heads/...`).
 */
export function resolveCommit(project: string, ref: string, side: "base" | "head"): string {
  if (!ref.trim() || ref.startsWith("-") || /[\s\u0000-\u001f]/.test(ref)) throw new CiError({ code: "COMPARE_REF_INVALID", stage: "preflight",
    message: `The ${side} '${ref}' is not a ref.`, nextAction: `Pass ${side} as a branch, tag or commit SHA.` });
  const relative = /^(?:HEAD|@)(?:[~^].*)?$/.test(ref);
  for (const candidate of relative ? [ref] : [`refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/origin/${ref}`, ref]) {
    const result = spawnSync("git", ["-C", project, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { encoding: "utf8" });
    if (result.status === 0 && SHA.test(result.stdout.trim())) return result.stdout.trim();
  }
  throw new CiError({ code: "COMPARE_REF_NOT_FOUND", stage: "preflight", message: `${ref} is not a branch, tag or commit of this repository.`,
    nextAction: "Check the ref's spelling, and that the checkout fetched every branch and tag (fetch-depth: 0)." });
}

/**
 * `ci:compare-refs`: the commits two refs (branch, tag or SHA) name in a full clone, as the comparison a
 * `capture:review --compare` run captures. A tag wins over a branch of the same name.
 */
export function resolveCompareRefs(options: { project: string; base: string; head: string; title?: string; environment?: Environment }): CompareReviewPresentation {
  const environment = options.environment ?? process.env;
  const repository = environment.GITHUB_REPOSITORY ?? "", repositoryId = environment.GITHUB_REPOSITORY_ID ?? "";
  const commit = (ref: string, side: "base" | "head") => resolveCommit(options.project, ref, side);
  const base = { ref: options.base, sha: commit(options.base, "base") }, head = { ref: options.head, sha: commit(options.head, "head") };
  if (base.sha === head.sha) throw new CiError({ code: "COMPARE_SAME_COMMIT", stage: "preflight",
    message: `${options.base} and ${options.head} are the same commit (${head.sha}).`, nextAction: "Compare two different commits; the baseline workflow captures a single one." });
  return projectComparePresentation({ origin: "compare", repositoryId, repository, base, head,
    title: options.title ?? compareTitle(base, head), url: compareUrl(repository, base, head) });
}

/**
 * `ci:after-capture`: after capture, success or not. Stops the EAS Simulator sessions the capture recorded in its output
 * directory, then checks that capture left each source checkout as it found it. Reports every problem, then fails.
 */
export async function cleanupAfterCapture(options: { output: string; checkouts: string[]; environment?: Environment }):
  Promise<{ stopped: string[]; failures: Array<{ code: string; message: string; nextAction: string }> }> {
  const environment = options.environment ?? process.env;
  const result: { stopped: string[]; failures: Array<{ code: string; message: string; nextAction: string }> } = { stopped: [], failures: [] };
  const sessionFiles: string[] = [];
  for (const name of ["head-session", "base-session", "baseline-session"]) {
    const path = resolve(options.output, name);
    try { await lstat(path); sessionFiles.push(path); } catch { /* That side never started a session. */ }
  }
  if (sessionFiles.length) {
    const script = await import(pathToFileURL(join(TOOL_ROOT, "scripts", "cleanup-ci-sessions.mjs")).href) as {
      cleanupCiSessions(input: { sessionFiles: string[]; easCommand: string; environment: Environment }): Promise<{ stopped: string[]; failures: Array<{ code: string; message: string; nextAction: string }> }> };
    const sessions = await script.cleanupCiSessions({ sessionFiles, easCommand: packageBin("eas-cli", "eas"), environment });
    result.stopped.push(...sessions.stopped); result.failures.push(...sessions.failures);
  }
  for (const directory of options.checkouts) {
    const checkout = resolve(directory);
    try { await lstat(join(checkout, ".git")); } catch { continue; }
    const status = spawnSync("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    if (status.status !== 0 || status.stdout.trim()) result.failures.push({ code: "CHECKOUT_MODIFIED", message: `Capture modified ${directory}.`,
      nextAction: "Keep generated files outside source checkouts." });
  }
  if (result.failures.length) {
    const diagnostics = join(environment.RUNNER_TEMP || tmpdir(), "explore-diagnostics");
    await mkdir(diagnostics, { recursive: true });
    await writeFile(join(diagnostics, "cleanup.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}
