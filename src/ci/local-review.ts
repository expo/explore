import type { RunTarget } from "../types.js";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runCiReview } from "./pipeline.js";
import { resolveCommit } from "./workflow-steps.js";
import { ciLayout, installCommand, type PackageManager } from "./workflow-install.js";
import { configPlatforms, readExploreConfig, resolveTargetConfig, configTargets, withRunOverrides, DEFAULT_EXPLORE_CONFIG_PATH, type ExploreConfig, type ExplorePlatform } from "../config/explore-config.js";
import { AGENT_PROVIDERS, defaultExploreConfig } from "../config/setup.js";
import type { PrepareCiExplorationOptions } from "../capture/agent/exploration.js";
import { createCiAgentSession } from "../capture/agent/session.js";
import { createLocalCiAgentSession } from "../capture/agent/session-local.js";
import { androidTools, localEmulatorFromState, localSimulatorFromState } from "../capture/local-simulator.js";
import type { CommandRunner } from "../capture/run.js";
import { isSafeBranchRef, type LocalReviewPresentation, type PullRequestSidePresentation } from "../contracts/review.js";
import { exportCiReport, readCiReportInput } from "../report/artifact.js";
import { reviewChangeCount, reviewDevice, type PublicCommentState } from "../report/pr-comment-body.js";
import { zipReportDirectory } from "../report/preview-deploy.js";
import { CiError, serializeCiError, toCiError, type CiErrorData } from "../shared/ci-errors.js";
import { defaultRunner } from "../capture/controller.js";
import { sweepLocalCaptures } from "../capture/local-registry.js";
import { abandonSharedBuilds } from "../capture/shared-build.js";
import { exploreCacheRoot } from "../shared/cache-root.js";
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
  /** Review HEAD alone, leaving out the working tree's changes. */
  committed?: boolean | undefined;
  /** Review the working tree even when eas.json sets cli.requireCommit. Without --head this is the default. */
  uncommitted?: boolean | undefined;
  platform?: ExplorePlatform | undefined;
  /** `--target`: capture this config.yaml target alone; with `platform`, the targets of that platform. */
  target?: string | undefined;
  /** `--parallel`: how many targets capture at once (each runs a simulator or emulator per side); all of them by default. */
  parallel?: number | undefined;
  scope?: string | undefined;
  expiresIn?: string | undefined;
  /** e2e files or globs to run as the capture instead of the config's mode (`--flows`). */
  flows?: readonly string[] | undefined;
  /** `--controller`: the device controller for both sides, over the config's `capture.controller`. */
  controller?: string | undefined;
  /** `--simulator`: `local` runs both sides on simulators this Mac creates, over the config's `capture.simulator`. */
  simulator?: string | undefined;
  /** `--repack`: where the app is repacked with the route observer, over the config's `capture.repack`. */
  repack?: string | undefined;
  /** Reuse and keep captures in the local capture cache (default true). */
  cache?: boolean | undefined;
  configPath?: string | undefined;
  environment?: NodeJS.ProcessEnv;
  progress?: Progress;
  /** Behaves like Ctrl+C when aborted: for callers (and tests) that stop a review without a signal. */
  interrupt?: AbortSignal | undefined;
  /** Tests: replace the dependency install (given the app directory in that side's checkout) and the capture process. */
  install?: (project: string, side: "base" | "head") => Promise<void>;
  runner?: CommandRunner; now?: () => number; sleep?: (milliseconds: number) => void;
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"];
};

export type LocalReviewReport = { platform: ExplorePlatform; target: RunTarget; directory: string; zip: string; changes?: number; device?: string };
export type LocalReviewResult = {
  runId: string; base: PullRequestSidePresentation; head: PullRequestSidePresentation & { uncommitted?: string[] };
  work: string; reports: LocalReviewReport[]; config: ExploreConfig; repository: string;
  /** Targets whose review failed outright; the others' reports are kept and opened all the same. */
  failures: { target: RunTarget; error: CiErrorData }[];
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
    nextAction: "Ignore or commit the large files, or pass --committed to review HEAD alone." });
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

/**
 * The base when none is given: where HEAD left the default branch (what it would merge), named after it. Both the
 * local branch and origin's are considered, by exact ref (a tag of the same name never counts), and the newer fork
 * point wins, so neither a stale local `main` nor an unfetched `origin/main` adds other people's changes. On the
 * default branch itself, its unpushed commits are reviewed against origin's.
 */
export function defaultBase(root: string, headSha: string): PullRequestSidePresentation {
  const remote = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  for (const branch of remote.ok ? [remote.stdout.replace(/^origin\//, "")] : ["main", "master"]) {
    const tips = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]
      .map(ref => git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).filter(result => result.ok).map(result => result.stdout);
    if (!tips.length) continue;
    const forks = tips.map(tip => git(root, ["merge-base", tip, headSha])).filter(result => result.ok).map(result => result.stdout);
    if (!forks.length) throw new CiError({ code: "LOCAL_REVIEW_BASE_REQUIRED", stage: "preflight", message: `${branch} and the head share no history.`,
      nextAction: "Pass --base with a commit the head descends from." });
    // Each fork point is an ancestor of the other; the newer one is where the head actually branched off. A fork point
    // that is the head itself is the branch you are on (main with unpushed commits): the other one is what you would push onto.
    const candidates = forks.filter(fork => fork !== headSha);
    const fork = (candidates.length ? candidates : forks).reduce((older, newer) => git(root, ["merge-base", "--is-ancestor", older, newer]).ok ? newer : older);
    return { ref: tips.includes(fork) ? branch : `${branch} (merge base)`, sha: fork };
  }
  throw new CiError({ code: "LOCAL_REVIEW_BASE_REQUIRED", stage: "preflight", message: "This repository has no default branch to compare with.",
    nextAction: "Pass --base with a branch, tag or commit SHA." });
}

/**
 * The name a report gives a ref: as typed, unless the report's ref rules refuse it (`@{u}`, `@{-1}`, `HEAD@{1}`); then
 * the branch it names, or the commit's short SHA. Checked here, since the report itself is only written after capture.
 */
export function reportRef(root: string, ref: string, sha: string): string {
  if (isSafeBranchRef(ref)) return ref;
  const name = git(root, ["rev-parse", "--abbrev-ref", "--verify", "--quiet", ref]);
  return name.ok && name.stdout && name.stdout !== "HEAD" && isSafeBranchRef(name.stdout) ? name.stdout : sha.slice(0, 8);
}

/** owner/name from a github.com `origin`, or a local name; the report shows it and the hosted project is named after it. */
export function repositoryName(root: string, config: ExploreConfig): string {
  const remote = git(root, ["remote", "get-url", "origin"]).stdout;
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  return match ? `${match[1]}/${match[2]}` : `local/${(config.app.name ?? "app").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "app"}`;
}

/**
 * The environment of app installs: no variable named like a credential. A reviewed commit's .npmrc or .yarnrc.yml
 * could otherwise send `${NPM_TOKEN}` or `${CLAUDE_CODE_OAUTH_TOKEN}` to a registry it chooses, even with
 * --ignore-scripts. Proxy, certificate, cache and SSH-agent settings stay. This matches CI, whose install step
 * gets no secrets; registry auth in your own ~/.npmrc is scoped to its host and still applies. It is not a sandbox: a
 * commit's yarnPath, Yarn plugins or .pnpmfile.cjs still run as you, as its app config and bundling do later.
 */
export function appEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    key === "SSH_AUTH_SOCK" || !/(TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|SESSION|COOKIE)/i.test(key)));
}

/** The frozen-lockfile install setup derives for CI, without `corepack enable` (that changes your Node install). */
export function localInstallCommand(manager: PackageManager, directory: string): string {
  return installCommand(manager, directory).replace(/^corepack enable && /, "");
}

/** Install from the app directory: the lockfile is the nearest one at or above it, as `setup` finds it for CI. */
export async function installDependencies(project: string, logFile: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const layout = await ciLayout(project);
  if (!layout.manager) throw new CiError({ code: "LOCAL_REVIEW_LOCKFILE_MISSING", stage: "preflight", message: "The app has no lockfile at this commit.",
    nextAction: "Commit the app's lockfile, then rerun." });
  const command = localInstallCommand(layout.manager, layout.installDir);
  const result = spawnSync("sh", ["-c", command], { cwd: layout.root, env: appEnvironment(environment), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  await writeFile(logFile, `$ ${command}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) throw new CiError({ code: "LOCAL_REVIEW_INSTALL_FAILED", stage: "preflight", message: `Installing the app's dependencies failed: ${command}`,
    nextAction: `Read ${logFile}; ${layout.manager === "npm" ? "" : `make sure ${layout.manager.replace("-classic", "")} is installed, and `}check the lockfile at that commit. `
      + "Installs run without credential environment variables: a registry that needs ${NPM_TOKEN} in the project's .npmrc must be authenticated in your own ~/.npmrc instead." });
}

/** Runs `task` on every item, at most `limit` at once, in order; every task settles, as Promise.allSettled does. */
export async function settleLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await task(items[index]!) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * `~/.cache/expo-explore/captures/<target>/<sha>`: one capture per commit and target, reused while its recipe matches.
 * A config without targets names them for their platforms, so its captures stay where they were.
 */
export function captureCacheDirectory(environment: NodeJS.ProcessEnv, target: string, sha: string): string {
  return join(exploreCacheRoot(environment), "captures", target, sha);
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }

const CACHE_METADATA = "cache-metadata.json";

/**
 * Drops cached captures not used for 30 days, then the least recently used until the rest fit in 2 GB, as saved runs
 * are pruned. A capture counts as used when a review keeps or reuses it (its cache-metadata.json is touched then).
 */
export async function pruneCaptureCache(environment: NodeJS.ProcessEnv, now = Date.now(), limits = { maxAgeDays: 30, maxBytes: 2 * 1024 * 1024 * 1024 }): Promise<string[]> {
  const root = join(exploreCacheRoot(environment), "captures");
  const entries: Array<{ path: string; used: number; bytes: number }> = [];
  const size = async (path: string): Promise<number> => {
    const info = await lstat(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path)) total += await size(join(path, name));
    return total;
  };
  for (const platform of await readdir(root).catch(() => [] as string[])) {
    for (const sha of await readdir(join(root, platform)).catch(() => [] as string[])) {
      const path = join(root, platform, sha);
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      const used = await stat(join(path, CACHE_METADATA)).then(info => info.mtimeMs, () => 0);
      entries.push({ path, used, bytes: await size(path).catch(() => 0) });
    }
  }
  entries.sort((a, b) => a.used - b.used);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const removed: string[] = [];
  for (const entry of entries) {
    if (now - entry.used <= limits.maxAgeDays * 86_400_000 && total <= limits.maxBytes) continue;
    await rm(entry.path, { recursive: true, force: true });
    total -= entry.bytes;
    removed.push(entry.path);
  }
  return removed;
}
async function cacheRecipe(directory: string): Promise<{ recipe: string; images: number } | undefined> {
  try {
    const metadata = JSON.parse(await readFile(join(directory, CACHE_METADATA), "utf8")) as { recipe?: unknown };
    const bundle = JSON.parse(await readFile(join(directory, "bundle.json"), "utf8")) as { images?: Record<string, unknown> };
    return typeof metadata.recipe === "string" ? { recipe: metadata.recipe, images: Object.keys(bundle.images ?? {}).length } : undefined;
  } catch { return undefined; }
}

/**
 * Keep an export as a commit's cached capture. Only exports whose evidence validated carry cache metadata. An entry
 * from another recipe (an Explore upgrade, a config change) is replaced; one with the same recipe only by an export
 * with at least as many screens, so a partial capture never shrinks a fuller one.
 */
export async function keepCapture(exported: string, target: string): Promise<boolean> {
  const next = await cacheRecipe(exported);
  if (!next) return false;
  const current = await cacheRecipe(target);
  if (current && current.recipe === next.recipe && current.images > next.images) return false;
  // Copied beside the entry and renamed into place, so a review reading the cache (or another one writing it) never
  // sees a half-copied capture; when two write at once, the first rename wins and the other copy is dropped.
  await mkdir(resolve(target, ".."), { recursive: true });
  const staged = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await cp(exported, staged, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
    return true;
  } catch (error) {
    if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

function recordedSessionIds(outputs: string[]): string[] {
  return outputs.flatMap(output => ["head-session", "base-session"].flatMap(name => {
    try { const id = readFileSync(join(output, name), "utf8").trim(); return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) ? [id] : []; } catch { return []; }
  }));
}

/** How to stop a recorded session by hand: an EAS Simulator session, or a local simulator or emulator the capture started. */
function stopHint(id: string): string {
  const udid = localSimulatorFromState(id);
  const serial = localEmulatorFromState(id);
  return udid ? `xcrun simctl delete ${udid}` : serial ? `adb -s ${serial} emu kill` : `eas simulator:stop --id ${id}`;
}

/**
 * Stop the simulators a capture recorded and did not stop itself (an interrupted run): EAS Simulator sessions with the
 * local login, local simulators by deleting them, and local emulators by killing them.
 */
export async function stopRecordedSessions(outputs: string[], environment: NodeJS.ProcessEnv, runner: (args: string[]) => { status: number | null } =
  args => spawnSync(packageBin("eas-cli", "eas"), args, { env: environment, encoding: "utf8", timeout: 120_000 }), quiet = false,
  simctl: (args: string[]) => { status: number | null } = args => spawnSync("xcrun", ["simctl", ...args], { env: environment, encoding: "utf8", timeout: 120_000 }),
  adb: (args: string[]) => { status: number | null } = args => spawnSync(androidTools(environment).adb, args, { env: environment, encoding: "utf8", timeout: 60_000 })): Promise<string[]> {
  const stopped: string[] = [];
  for (const output of outputs) for (const name of ["head-session", "base-session"]) {
    const file = join(output, name);
    const id = (await readFile(file, "utf8").catch(() => "")).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) continue;
    const udid = localSimulatorFromState(id);
    const serial = localEmulatorFromState(id);
    if (udid) simctl(["shutdown", udid]);
    const stop = udid ? simctl(["delete", udid]) : serial ? adb(["-s", serial, "emu", "kill"]) : runner(["simulator:stop", "--id", id, "--json", "--non-interactive"]);
    if (stop.status === 0) { stopped.push(id); await rm(file, { force: true }); }
    // During an interrupt the capture may stop the same session first; only the final pass reports a failure.
    else if (!quiet) process.stderr.write(`Could not stop simulator ${id}; stop it with: ${stopHint(id)}\n`);
  }
  return stopped;
}

/**
 * What the head of a review without --head is: the working tree, as `eas build` uploads it (tracked and untracked
 * files, not ignored ones), unless the app's eas.json sets cli.requireCommit, which makes eas build refuse uncommitted
 * changes, or --committed asks for HEAD alone. --head names a commit, so the working tree is never part of it.
 */
export async function reviewHeadSource(options: Pick<LocalReviewOptions, "head" | "committed" | "uncommitted">, project: string):
  Promise<"working-tree" | "commit" | "require-commit"> {
  const namedHead = options.head !== undefined && options.head !== "HEAD";
  if (options.uncommitted && (namedHead || options.committed)) throw new CiError({ code: "LOCAL_REVIEW_UNCOMMITTED_HEAD", stage: "preflight",
    message: "--uncommitted reviews the working tree, which is on top of HEAD.", nextAction: `Leave out ${namedHead ? "--head" : "--committed"}, or leave out --uncommitted.` });
  if (namedHead || options.committed) return "commit";
  if (options.uncommitted) return "working-tree";
  let eas: unknown;
  try { eas = JSON.parse(await readFile(join(project, "eas.json"), "utf8")); } catch { return "working-tree"; }
  const cli = eas !== null && typeof eas === "object" ? (eas as { cli?: unknown }).cli : undefined;
  return cli !== null && typeof cli === "object" && (cli as { requireCommit?: unknown }).requireCommit === true ? "require-commit" : "working-tree";
}

/**
 * The config a local review runs with: the head commit's; else the one in your checkout, when setup has written it but
 * it is not committed yet; else the defaults setup would write, so an app can be reviewed before it is set up. A
 * config path passed with --config must be in the head commit.
 */
export async function localReviewConfig(options: { project: string; head: string; configPath: string; explicit: boolean;
  platform?: ExplorePlatform | undefined; progress?: Progress }): Promise<ExploreConfig> {
  const progress = options.progress ?? silentProgress;
  if (options.explicit || await exists(join(options.head, options.configPath))) return readExploreConfig(options.head, options.configPath);
  if (await exists(join(options.project, options.configPath))) {
    progress(`config: ${options.configPath} from your checkout (it is not in the head commit)`);
    return readExploreConfig(options.project, options.configPath);
  }
  let config: ExploreConfig;
  try { config = await defaultExploreConfig(options.project, options.platform); }
  catch (error) {
    throw new CiError({ code: "LOCAL_REVIEW_CONFIG_DEFAULTS", stage: "preflight",
      message: `There is no ${options.configPath}, so this review uses setup's defaults, which need this: ${(error as Error).message}`,
      nextAction: "Fix that and rerun (with several simulator profiles, the one named explore is used), or run expo-explore setup to write a config." });
  }
  progress(`config: none yet, so setup's defaults (${config.app.bundleId}, EAS profile ${config.app.easProfile}, ${config.device.name}); `
    + "expo-explore setup writes one you can change");
  return config;
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
  // The first Ctrl+C stops the captures between steps (deterministic or agent), aborts model requests and stops the
  // recorded simulator sessions, so the capture fails fast and unwinds through its own cleanup and the finally below. A second one quits now, naming any session left running.
  const abort = new AbortController();
  let interrupts = 0;
  const interrupt = () => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write("\nStopping the review and its simulators… (Ctrl+C again to quit now)\n");
      abort.abort(new CiError({ code: "LOCAL_REVIEW_INTERRUPTED", stage: "capture", message: "The review was interrupted.", nextAction: "Rerun it when you are ready." }));
      if (!options.runner) void stopRecordedSessions(outputs, environment, undefined, true);
      return;
    }
    for (const tree of worktrees) git(root, ["worktree", "remove", "--force", tree]);
    for (const id of recordedSessionIds(outputs)) process.stderr.write(`Still running: stop it with ${stopHint(id)}\n`);
    process.exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  options.interrupt?.addEventListener("abort", interrupt, { once: true });
  const factory = options.agentSessionFactory;
  let failed = false;
  try {
    // The commits.
    const headRef = options.head ?? "HEAD";
    let head: LocalReviewResult["head"];
    const source = await reviewHeadSource(options, project);
    if (source === "require-commit") progress("head: HEAD; eas.json sets cli.requireCommit, so uncommitted changes are left out as eas build leaves them out (--uncommitted includes them)");
    if (source === "working-tree") {
      const snapshot = await snapshotWorkingTree(root, { untracked: true, work });
      head = snapshot ? { ref: "uncommitted changes", sha: snapshot.sha, uncommitted: snapshot.changed } : { ref: "HEAD", sha: resolveCommit(root, "HEAD", "head") };
      if (snapshot) progress(`head: HEAD with your uncommitted changes to ${snapshot.changed.length} file${snapshot.changed.length === 1 ? "" : "s"}, as eas build would upload them`
        + (snapshot.untracked.length ? ` (untracked, kept in .git/objects until git gc: ${snapshot.untracked.join(", ")})` : "") + "; --committed leaves them out");
      else progress("head: HEAD (no uncommitted changes)");
    } else {
      const sha = resolveCommit(root, headRef, "head");
      head = { ref: reportRef(root, headRef, sha), sha };
    }
    const baseSha = options.base ? resolveCommit(root, options.base, "base") : undefined;
    const base = options.base && baseSha ? { ref: reportRef(root, options.base, baseSha), sha: baseSha } : defaultBase(root, head.sha);
    if (base.sha === head.sha) throw new CiError({ code: "COMPARE_SAME_COMMIT", stage: "preflight", message: `${base.ref} and ${head.ref} are the same commit (${head.sha.slice(0, 8)}).`,
      nextAction: "Change something to review it, or pass --base with an earlier commit." });
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
    const rawConfig = await localReviewConfig({ project, head: projects.head, configPath, explicit: options.configPath !== undefined,
      platform: options.platform, progress });
    const allTargets = configTargets(rawConfig);
    if (options.target !== undefined && !allTargets.some(target => target.id === options.target)) throw new CiError({ code: "TARGET_NOT_CONFIGURED", stage: "preflight",
      message: `The config has no target ${options.target}.`, nextAction: `Pass one of: ${allTargets.map(target => target.id).join(", ")}.` });
    const targets = allTargets.filter(target => (options.target === undefined || target.id === options.target) && (options.platform === undefined || target.platform === options.platform));
    if (!targets.length) throw new CiError({ code: "PLATFORM_NOT_CONFIGURED", stage: "preflight", message: `The config has no ${options.platform} target.`,
      nextAction: `Pass one of: ${allTargets.map(target => target.id).join(", ")}.` });
    // The reports link to each other's targets (the Viewer's target switch), so they name only the targets this review
    // captures: `--target phone` or `--platform ios` makes no report for the others, and a link to one would find nothing.
    const platforms = configPlatforms(rawConfig).filter(platform => targets.some(target => target.platform === platform));
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

    // Every target's capture waits on one install of both commits' dependencies.
    let installed: Promise<void> | undefined;
    const install = options.install ?? (async (project: string, side: "base" | "head") => {
      progress(`installing the ${side} commit's dependencies`);
      await installDependencies(project, join(work, `install-${side}.log`), environment);
    });
    // The targets run at once, as CI runs them in parallel jobs: each on its own simulators, with its own output.
    const captureTarget = async (target: RunTarget): Promise<LocalReviewReport> => {
      const config = withRunOverrides(resolveTargetConfig(rawConfig, { target: target.id }), { scope: options.scope, expiresIn: options.expiresIn, flows: options.flows, controller: options.controller, simulator: options.simulator, repack: options.repack });
      const platform = target.platform;
      const output = join(work, target.id); await mkdir(output);
      outputs.push(output);
      const platformEnvironment = { ...environment };
      delete platformEnvironment.EXPLORE_CAPTURE_CACHE;
      const cachedBase = captureCacheDirectory(environment, target.id, base.sha);
      if (options.cache !== false && await exists(join(cachedBase, CACHE_METADATA))) {
        platformEnvironment.EXPLORE_CAPTURE_CACHE = cachedBase;
        // Reusing a capture counts as using it, so pruning keeps the bases reviews come back to.
        await utimes(join(cachedBase, CACHE_METADATA), new Date(), new Date()).catch(() => undefined);
      }
      const presentation: LocalReviewPresentation = { origin: "local", repository, runId, title: `${head.ref} vs ${base.ref}`,
        base: { ref: base.ref, sha: base.sha }, head: { ref: head.ref, sha: head.sha } };
      const state: PublicCommentState = { phase: "pending", pullRequest: presentation, mode: config.exploration.scope, executionMode: config.mode,
        configPath: appDirectory === "." ? configPath : `${appDirectory}/${configPath}`,
        links: { viewer: null, download: null, run: "", config: "", artifacts: "" }, startedAt: Date.now(), updatedAt: Date.now(),
        build: { platform: config.app.platform, easProfile: config.app.easProfile }, artifactOnly: true,
        target, ...(targets.length > 1 ? { targets } : {}) };
      progress(`${target.id}: reviewing${target.id === platform ? "" : ` (${target.label})`}`);
      const result = await runCiReview({ projects, output, config, presentation, runId, runAttempt: "1", state, environment: platformEnvironment,
        ...(platforms.length > 1 ? { platforms } : {}), ...(targets.length > 1 ? { targets } : {}),
        // Targets of one platform capture the same commits from the same build; it is built and repacked once.
        ...(targets.length > 1 ? { buildShare: join(work, ".builds") } : {}),
        subscription, useLocalEasSession, progress: message => progress(`${target.id}: ${message}`),
        ...(options.runner ? { runner: options.runner } : {}), ...(options.now ? { now: options.now } : {}), ...(options.sleep ? { sleep: options.sleep } : {}),
        signal: abort.signal,
        // Model requests end on Ctrl+C: the session kills its own process group and restores any login it changed.
        agentSessionFactory: (configuration, sessionOptions) => {
          const session = (factory ?? (subscription ? createLocalCiAgentSession : createCiAgentSession))(configuration, sessionOptions);
          return { ...session,
            preflight: preflightOptions => session.preflight({ ...preflightOptions, signal: preflightOptions?.signal ? AbortSignal.any([preflightOptions.signal, abort.signal]) : abort.signal }),
            run: request => session.run({ ...request, signal: request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal }) };
        },
        prepareCapture: () => installed ??= (async () => {
          for (const side of ["head", "base"] as const) await install(projects[side], side);
        })(),
        assertCurrentHead: async () => {
          abort.signal.throwIfAborted();
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
      const report: LocalReviewReport = { platform, target, directory, zip, ...(changes === undefined ? {} : { changes }), ...(device ? { device } : {}) };
      // Keep both sides' captures for later reviews of these commits; a working-tree snapshot is never reviewed again.
      if (options.cache !== false) for (const side of ["base", "head"] as const) {
        if (side === "head" && head.uncommitted) continue;
        await keepCapture(join(output, `${side}-export`), captureCacheDirectory(environment, target.id, side === "base" ? base.sha : head.sha));
      }
      // The report is all that is kept; the captures, maps and checkouts are the bulk of the run.
      for (const entry of await readdir(output)) if (entry !== "report" && entry !== "report.zip") await rm(join(output, entry), { recursive: true, force: true });
      abort.signal.throwIfAborted();
      return report;
    };
    // Every target finishes or fails on its own, so each stops the simulators it started; then the first failure is the review's.
    // Whatever an earlier review stopped hard left running on this machine (simulators, emulators, daemons,
    // tool-servers) is stopped first; only what Explore recorded is touched.
    const swept = await sweepLocalCaptures({ environment, runner: options.runner ?? defaultRunner, cwd: work }).catch(() => [] as string[]);
    if (swept.length) progress(`stopped what an interrupted review left running: ${swept.join(", ")}`);
    // A capture worker that exited before its shared build said how it ended would leave the targets waiting on that build
    // polling until the review is stopped: its builds are failed instead.
    const releaseBuilds = async (target: RunTarget, error: unknown) => {
      const failure = toCiError(error);
      const side = /^capture-(head|base)$/.exec(failure.stage)?.[1];
      if (targets.length > 1 && failure.code === "CAPTURE_WORKER_EXITED" && side) {
        await abandonSharedBuilds(join(work, ".builds"), owner => owner === join(work, target.id, `${side}-export`), failure.code);
      }
    };
    const settled = await settleLimited(targets, options.parallel ?? targets.length,
      target => captureTarget(target).catch(async (error: unknown) => { await releaseBuilds(target, error).catch(() => undefined); throw error; }));
    // One target that fails costs that target's report, not the others': they are kept, and the failure is named.
    // Only an interrupted review, or one where every target failed, fails as a whole.
    const reports = settled.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
    const failed = settled.flatMap((outcome, index) => outcome.status === "rejected" ? [{ target: targets[index]!, reason: outcome.reason as unknown }] : []);
    abort.signal.throwIfAborted();
    if (!reports.length && failed.length) throw failed[0]!.reason;
    const failures = failed.map(({ target, reason }) => ({ target, error: serializeCiError(reason) }));
    for (const { target, error } of failures) progress(`${target.id}: no report (${error.code}: ${error.message})`);
    if (options.cache !== false) await pruneCaptureCache(environment).catch(() => []);
    // The install logs and snapshot index go too; the checkouts are removed with git below.
    for (const entry of await readdir(work)) if (![...targets.map(target => target.id), "base", "head"].includes(entry)) await rm(join(work, entry), { recursive: true, force: true });
    return { runId, base, head, work, reports, config: rawConfig, repository, failures };
  } catch (error) {
    failed = true;
    // A capture interrupted mid-session reports its cleanup; the interruption is what happened.
    throw abort.signal.aborted ? abort.signal.reason : error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    options.interrupt?.removeEventListener("abort", interrupt);
    // A capture stops its own sessions; this catches one that ended before it could. Tests inject their own runner.
    if (!options.runner) await stopRecordedSessions(outputs, environment).catch(() => []);
    // Only the run's own worktrees: a repository-wide prune would also drop the user's own worktrees on an unmounted disk.
    for (const tree of worktrees) git(root, ["worktree", "remove", "--force", tree]);
    // A failed run keeps what it produced for inspection; one that failed before producing anything leaves nothing.
    if (failed) {
      if ((await readdir(work).catch(() => [])).length) progress(`kept this review's files for inspection: ${work}`);
      else await rm(work, { recursive: true, force: true });
    }
  }
}
