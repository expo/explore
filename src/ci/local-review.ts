import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runCiReview } from "./pipeline.js";
import { resolveCommit } from "./workflow-steps.js";
import { ciLayout, installCommand, type PackageManager } from "./workflow-install.js";
import { configPlatforms, readExploreConfig, resolvePlatformConfig, withRunOverrides, DEFAULT_EXPLORE_CONFIG_PATH, type ExploreConfig, type ExplorePlatform } from "../config/explore-config.js";
import { AGENT_PROVIDERS } from "../config/setup.js";
import type { PrepareCiExplorationOptions } from "../capture/agent/exploration.js";
import type { CommandRunner } from "../capture/run.js";
import type { LocalReviewPresentation, PullRequestSidePresentation } from "../contracts/review.js";
import { exportCiReport, readCiReportInput } from "../report/artifact.js";
import { reviewChangeCount, reviewDevice, type PublicCommentState } from "../report/pr-comment-body.js";
import { zipReportDirectory } from "../report/preview-deploy.js";
import { CiError } from "../shared/ci-errors.js";
import { packageBin } from "../shared/package-paths.js";
import { silentProgress, type Progress } from "../shared/progress.js";

/**
 * `capture:review --base REF [--head REF]` on a laptop: the same review CI runs (`runCiReview`), on two commits of the
 * current repository, with your own `eas login` and your local Claude or Codex login when no token or key is set.
 * Each commit is checked out as a detached worktree in a private temporary directory, its dependencies installed
 * without credentials in the environment, and both are removed afterwards. The report is packaged per platform.
 */
export type LocalReviewOptions = {
  project: string;
  base?: string | undefined;
  head?: string | undefined;
  /** Review uncommitted changes to tracked files as the head (the working tree, not a commit). */
  uncommitted?: boolean | undefined;
  /** With `uncommitted`: also include untracked files that are not ignored. */
  untracked?: boolean | undefined;
  platform?: ExplorePlatform | undefined;
  scope?: string | undefined;
  expiresIn?: string | undefined;
  /** Reuse and keep captures in the local capture cache (default true). */
  cache?: boolean | undefined;
  configPath?: string | undefined;
  environment?: NodeJS.ProcessEnv;
  progress?: Progress;
  /** Tests: replace the dependency install and the capture process. */
  install?: (checkout: string, side: "base" | "head") => Promise<void>;
  runner?: CommandRunner; now?: () => number; sleep?: (milliseconds: number) => void;
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"];
};

export type LocalReviewReport = { platform: ExplorePlatform; directory: string; zip: string; changes?: number; device?: string };
export type LocalReviewResult = {
  runId: string; base: PullRequestSidePresentation; head: PullRequestSidePresentation & { uncommitted?: string[] };
  work: string; reports: LocalReviewReport[]; config: ExploreConfig; repository: string;
};

/** Git, without the user's hooks or fsmonitor, and never with a terminal prompt. */
function git(cwd: string, args: string[], environment: NodeJS.ProcessEnv = process.env, input?: string) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
    { encoding: "utf8", env: { ...environment, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  return { ok: result.status === 0, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}

function must(result: ReturnType<typeof git>, message: string, nextAction: string): string {
  if (!result.ok) throw new CiError({ code: "LOCAL_REVIEW_GIT_FAILED", stage: "preflight", message: `${message}: ${result.stderr || "git failed"}`, nextAction });
  return result.stdout;
}

const UNTRACKED_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * The working tree as a commit on top of HEAD, without touching the user's index, files or refs: a temporary
 * index seeded from the real one, `git add`, `write-tree`, `commit-tree`. Tracked changes only, unless `untracked`.
 * Undefined when nothing changed.
 */
export async function snapshotWorkingTree(root: string, options: { untracked?: boolean | undefined; work: string }):
  Promise<{ sha: string; changed: string[]; untracked: string[] } | undefined> {
  const index = join(options.work, "snapshot-index");
  const real = resolve(root, must(git(root, ["rev-parse", "--git-path", "index"]), "Cannot find the repository index", "Run this inside a git repository."));
  try { await copyFile(real, index); } catch { /* A repository without an index starts empty. */ }
  const environment = { ...process.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" };
  const untracked = options.untracked ? must(git(root, ["ls-files", "-z", "--others", "--exclude-standard"]), "Cannot list untracked files", "Check the repository.")
    .split("\0").filter(Boolean) : [];
  let bytes = 0;
  for (const file of untracked) bytes += (await stat(join(root, file)).catch(() => ({ size: 0 }))).size;
  if (bytes > UNTRACKED_LIMIT_BYTES) throw new CiError({ code: "LOCAL_REVIEW_UNTRACKED_TOO_LARGE", stage: "preflight",
    message: `The untracked files add up to ${Math.round(bytes / 1024 / 1024)} MB; they would be uploaded with the EAS build.`,
    nextAction: "Ignore or commit the large files, or leave out --include-untracked." });
  must(git(root, ["add", options.untracked ? "-A" : "-u", "--", "."], environment), "Cannot stage the working tree", "Check the repository's state.");
  const tree = must(git(root, ["write-tree"], environment), "Cannot write the working tree", "Check the repository's state.");
  await rm(index, { force: true });
  if (tree === must(git(root, ["rev-parse", "HEAD^{tree}"]), "The repository has no commit", "Commit once, then rerun.")) return undefined;
  const changed = must(git(root, ["diff", "--name-only", "-z", "HEAD", tree]), "Cannot list the changes", "Check the repository.").split("\0").filter(Boolean);
  const sha = must(git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "Expo Explore: uncommitted changes"],
    { ...process.env, GIT_AUTHOR_NAME: "Expo Explore", GIT_AUTHOR_EMAIL: "explore@localhost", GIT_COMMITTER_NAME: "Expo Explore", GIT_COMMITTER_EMAIL: "explore@localhost" }),
  "Cannot record the uncommitted changes", "Check the repository's state.");
  return { sha, changed, untracked: untracked.filter(file => changed.includes(file)) };
}

/** The base when none is given: where HEAD's branch left the default branch (what it would merge), named after it. */
export function defaultBase(root: string, headSha: string): PullRequestSidePresentation {
  const remote = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const branch = remote.ok ? remote.stdout.replace(/^origin\//, "")
    : ["main", "master"].find(name => git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok);
  if (!branch) throw new CiError({ code: "LOCAL_REVIEW_BASE_REQUIRED", stage: "preflight", message: "This repository has no default branch to compare with.",
    nextAction: "Pass --base with a branch, tag or commit SHA." });
  const tip = resolveCommit(root, branch, "base");
  const mergeBase = must(git(root, ["merge-base", tip, headSha]), `${branch} and the head share no history`, "Pass --base with a commit the head descends from.");
  return { ref: mergeBase === tip ? branch : `${branch} (merge base)`, sha: mergeBase };
}

/** owner/name from a github.com `origin`, or a local name; the report shows it and the hosted project is named after it. */
function repositoryName(root: string, config: ExploreConfig): string {
  const remote = git(root, ["remote", "get-url", "origin"]).stdout;
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  return match ? `${match[1]}/${match[2]}` : `local/${(config.app.name ?? "app").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "app"}`;
}

/**
 * The environment of app installs: without Explore's credentials (EAS, GitHub, model providers). Package-registry
 * tokens stay, since a private registry needs them, and installs run with --ignore-scripts.
 */
export function appEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(EXPO_TOKEN|EXPO_SESSION_SECRET|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_.*|OPENAI_.*|.*_API_KEY)$/i.test(key)));
}

/** The frozen-lockfile install setup derives for CI, without `corepack enable` (that changes your Node install). */
export function localInstallCommand(manager: PackageManager, directory: string): string {
  return installCommand(manager, directory).replace(/^corepack enable && /, "");
}

async function installDependencies(checkout: string, logFile: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const layout = await ciLayout(checkout);
  if (!layout.manager) throw new CiError({ code: "LOCAL_REVIEW_LOCKFILE_MISSING", stage: "preflight", message: "The app has no lockfile at this commit.",
    nextAction: "Commit the app's lockfile, then rerun." });
  const command = localInstallCommand(layout.manager, layout.installDir);
  const result = spawnSync("sh", ["-c", command], { cwd: layout.root, env: appEnvironment(environment), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  await writeFile(logFile, `$ ${command}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) throw new CiError({ code: "LOCAL_REVIEW_INSTALL_FAILED", stage: "preflight", message: `Installing the app's dependencies failed: ${command}`,
    nextAction: `Read ${logFile}; ${layout.manager === "npm" ? "" : `make sure ${layout.manager.replace("-classic", "")} is installed, and `}check the lockfile at that commit.` });
}

/** `~/.cache/expo-explore/captures/<platform>/<sha>`: one capture per commit and platform, reused while its recipe matches. */
export function captureCacheDirectory(environment: NodeJS.ProcessEnv, platform: ExplorePlatform, sha: string): string {
  const root = environment.EXPLORE_CACHE_DIR || join(environment.XDG_CACHE_HOME || join(environment.HOME || homedir(), ".cache"), "expo-explore");
  return join(root, "captures", platform, sha);
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }

/** Stop the EAS Simulator sessions a capture recorded and did not stop itself (an interrupted run), with the local login. */
export async function stopRecordedSessions(outputs: string[], environment: NodeJS.ProcessEnv, runner: (args: string[]) => { status: number | null } =
  args => spawnSync(packageBin("eas-cli", "eas"), args, { env: environment, encoding: "utf8", timeout: 120_000 })): Promise<string[]> {
  const stopped: string[] = [];
  for (const output of outputs) for (const name of ["head-session", "base-session"]) {
    const file = join(output, name);
    const id = (await readFile(file, "utf8").catch(() => "")).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) continue;
    if (runner(["simulator:stop", "--id", id, "--json", "--non-interactive"]).status === 0) { stopped.push(id); await rm(file, { force: true }); }
    else process.stderr.write(`Could not stop EAS Simulator session ${id}; stop it with: eas simulator:stop --id ${id}\n`);
  }
  return stopped;
}

export async function runLocalReview(options: LocalReviewOptions): Promise<LocalReviewResult> {
  const environment = { ...(options.environment ?? process.env) };
  const progress = options.progress ?? silentProgress;
  const project = await realpath(options.project);
  const root = await realpath(must(git(project, ["rev-parse", "--show-toplevel"]), "Not a git repository", "Run this inside the app's git repository."));
  const appDirectory = relative(root, project) || ".";
  const runId = `local-${new Date((options.now ?? Date.now)()).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const work = await realpath(await mkdtemp(join(tmpdir(), "expo-explore-review-")));
  const worktrees: string[] = [];
  const outputs: string[] = [];
  const interrupt = () => {
    process.stderr.write("\nStopping: ending the EAS Simulator sessions this review started…\n");
    void stopRecordedSessions(outputs, environment).finally(() => {
      for (const tree of worktrees) git(root, ["worktree", "remove", "--force", tree]);
      process.exit(130);
    });
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    // The commits.
    const headRef = options.head ?? "HEAD";
    let head: LocalReviewResult["head"];
    if (options.uncommitted) {
      if (options.head && options.head !== "HEAD") throw new CiError({ code: "LOCAL_REVIEW_UNCOMMITTED_HEAD", stage: "preflight",
        message: "--uncommitted reviews the working tree, which is on top of HEAD.", nextAction: "Leave out --head, or leave out --uncommitted." });
      const snapshot = await snapshotWorkingTree(root, { untracked: options.untracked, work });
      head = snapshot ? { ref: "uncommitted changes", sha: snapshot.sha, uncommitted: snapshot.changed } : { ref: "HEAD", sha: resolveCommit(root, "HEAD", "head") };
      if (snapshot) progress(`head: your uncommitted changes to ${snapshot.changed.length} file${snapshot.changed.length === 1 ? "" : "s"}`
        + (snapshot.untracked.length ? ` (untracked, uploaded with the build: ${snapshot.untracked.join(", ")})` : ""));
      else progress("head: no uncommitted changes, reviewing HEAD");
    } else head = { ref: headRef, sha: resolveCommit(root, headRef, "head") };
    const base = options.base ? { ref: options.base, sha: resolveCommit(root, options.base, "base") } : defaultBase(root, head.sha);
    if (base.sha === head.sha) throw new CiError({ code: "COMPARE_SAME_COMMIT", stage: "preflight", message: `${base.ref} and ${head.ref} are the same commit (${head.sha.slice(0, 8)}).`,
      nextAction: "Pass --base with an earlier commit, or --uncommitted to review your uncommitted changes." });
    progress(`comparing ${head.ref} (${head.sha.slice(0, 8)}) with ${base.ref} (${base.sha.slice(0, 8)})`);

    // The checkouts, and the config at head.
    const checkouts = { base: join(work, "base"), head: join(work, "head") };
    for (const side of ["base", "head"] as const) {
      must(git(root, ["worktree", "add", "--detach", "--quiet", checkouts[side], side === "base" ? base.sha : head.sha]),
        `Cannot check out the ${side} commit`, "Check the repository's state, then rerun.");
      worktrees.push(checkouts[side]);
    }
    const projects = { base: join(checkouts.base, appDirectory), head: join(checkouts.head, appDirectory) };
    const configPath = options.configPath ?? DEFAULT_EXPLORE_CONFIG_PATH;
    const rawConfig = await readExploreConfig(projects.head, configPath);
    const platforms = options.platform ? [options.platform] : configPlatforms(rawConfig);
    const repository = repositoryName(root, rawConfig);

    // Credentials: tokens and keys when set, otherwise your own logins.
    const useLocalEasSession = !environment.EXPO_TOKEN?.trim();
    if (useLocalEasSession && !options.runner) {
      const whoami = spawnSync(packageBin("eas-cli", "eas"), ["whoami"], { cwd: projects.head, env: environment, encoding: "utf8", timeout: 60_000 });
      if (whoami.status !== 0) throw new CiError({ code: "EXPO_LOGIN_REQUIRED", stage: "preflight", message: "You are not logged in to EAS.",
        nextAction: "Run eas login (or set EXPO_TOKEN), then rerun." });
    }
    const subscription = rawConfig.mode === "agent" && rawConfig.agent !== undefined && !environment[AGENT_PROVIDERS[rawConfig.agent.provider].secret]?.trim();
    if (subscription) progress(`model: your local ${rawConfig.agent!.provider === "anthropic" ? "claude" : "codex"} login (no ${AGENT_PROVIDERS[rawConfig.agent!.provider].secret} set)`);

    let installed = false;
    const install = options.install ?? (async (checkout: string, side: "base" | "head") => {
      progress(`installing the ${side} commit's dependencies`);
      await installDependencies(checkout, join(work, `install-${side}.log`), environment);
    });
    const reports: LocalReviewReport[] = [];
    for (const platform of platforms) {
      const config = withRunOverrides(resolvePlatformConfig(rawConfig, platform), { scope: options.scope, expiresIn: options.expiresIn });
      const output = join(work, platform); await mkdir(output);
      outputs.push(output);
      const platformEnvironment = { ...environment };
      delete platformEnvironment.EXPLORE_CAPTURE_CACHE;
      const cachedBase = captureCacheDirectory(environment, platform, base.sha);
      if (options.cache !== false && await exists(join(cachedBase, "bundle.json"))) platformEnvironment.EXPLORE_CAPTURE_CACHE = cachedBase;
      const presentation: LocalReviewPresentation = { origin: "local", repository, runId, title: `${head.ref} vs ${base.ref}`,
        base: { ref: base.ref, sha: base.sha }, head: { ref: head.ref, sha: head.sha } };
      const state: PublicCommentState = { phase: "pending", pullRequest: presentation, mode: config.exploration.scope, executionMode: config.mode,
        configPath: appDirectory === "." ? configPath : `${appDirectory}/${configPath}`,
        links: { viewer: null, download: null, run: "", config: "", artifacts: "" }, startedAt: Date.now(), updatedAt: Date.now(),
        build: { platform: config.app.platform, easProfile: config.app.easProfile }, artifactOnly: true };
      progress(`${platform}: reviewing`);
      const result = await runCiReview({ projects, output, config, presentation, runId, runAttempt: "1", state, environment: platformEnvironment,
        ...(platforms.length > 1 ? { platforms } : {}), subscription, useLocalEasSession, progress: message => progress(`${platform}: ${message}`),
        ...(options.runner ? { runner: options.runner } : {}), ...(options.now ? { now: options.now } : {}), ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.agentSessionFactory ? { agentSessionFactory: options.agentSessionFactory } : {}),
        prepareCapture: async () => {
          if (installed) return;
          for (const side of ["head", "base"] as const) await install(checkouts[side], side);
          installed = true;
        },
        assertCurrentHead: async () => {
          for (const side of ["base", "head"] as const) {
            if (git(projects[side], ["rev-parse", "HEAD"]).stdout !== (side === "base" ? base.sha : head.sha)
              || git(checkouts[side], ["status", "--porcelain", "--untracked-files=normal"]).stdout) {
              throw new CiError({ code: "CHECKOUT_MODIFIED", stage: "capture", message: `The ${side} checkout changed during capture.`,
                nextAction: "Keep generated files outside the app's source, then rerun." });
            }
          }
        },
        postComment: async () => {} });
      const directory = join(output, "report");
      await exportCiReport({ inputPath: result.inputPath, outputPath: directory });
      const zip = join(output, "report.zip");
      await writeFile(zip, await zipReportDirectory(directory));
      const input = await readCiReportInput(result.inputPath);
      const changes = reviewChangeCount(input.commentState); const device = reviewDevice(input.commentState);
      reports.push({ platform, directory, zip, ...(changes === undefined ? {} : { changes }), ...(device ? { device } : {}) });
      // Keep both sides' captures for later reviews of these commits; a working-tree snapshot is never reviewed again.
      if (options.cache !== false) for (const side of ["base", "head"] as const) {
        const sha = side === "base" ? base.sha : head.sha;
        if (side === "head" && head.uncommitted) continue;
        const exported = join(output, `${side}-export`);
        if (!await exists(join(exported, "bundle.json"))) continue;
        const target = captureCacheDirectory(environment, platform, sha);
        if (target === platformEnvironment.EXPLORE_CAPTURE_CACHE) continue;
        await rm(target, { recursive: true, force: true }); await mkdir(resolve(target, ".."), { recursive: true });
        await cp(exported, target, { recursive: true });
      }
    }
    return { runId, base, head, work, reports, config: rawConfig, repository };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    // A capture stops its own sessions; this catches one that ended before it could. Tests inject their own runner.
    if (!options.runner) await stopRecordedSessions(outputs, environment).catch(() => []);
    for (const tree of worktrees) git(root, ["worktree", "remove", "--force", tree]);
    git(root, ["worktree", "prune"]);
  }
}
