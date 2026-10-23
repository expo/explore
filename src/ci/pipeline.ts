import { systemRegions } from "../contracts/capture.js";
import type { RunTarget } from "../types.js";
import { execFile, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildVerifiedPlan } from "./verified-plan.js";
import { runCiMap, type CiMapOptions, type CommandRunner } from "../capture/run.js";
import type { RepackShare } from "../capture/eas-build.js";
import { resolveColorSchemes, routeIdOfScreen, type ColorScheme } from "../capture/appearance.js";
import { baseEnvironment } from "../capture/common.js";
import { DEFAULT_MAX_SESSIONS, planSideSessions, sessionShare } from "./session-plan.js";
import { mergeCaptureExports, type SecondaryCaptureExport } from "./export-merge.js";
import { abandonSharedBuilds } from "../capture/shared-build.js";
import { prepareCaptureReview, readCaptureBundle } from "../review/capture-review.js";
import { quarantineReviewContract } from "../contracts/review-validation.js";
import { agentCaptureConstraints } from "../capture/agent/source-context.js";
import { captureArtifactCacheMayMatch, captureRecipeConfig, incompleteCaptureReason, restoreCaptureArtifactCache, writeCaptureArtifactCache } from "./artifact-cache.js";
import { runCiMapOnWorker } from "./capture-worker.js";
import { DEFAULT_BASELINE_WAIT_MINUTES, awaitPendingBaseline, type BaselineWaitOptions } from "./baseline-wait.js";
import { writeCiReportInput, readAppDirectory } from "../report/artifact.js";
import { assessPublicEvidence, readExportedMap, type PublicEvidenceSide } from "../review/evidence-assessment.js";
import { parseRuntimeExecutionContext } from "../review/runtime-adapter.js";
import { projectComparePresentation, projectPullRequestPresentation, type ReviewPresentation } from "../contracts/review.js";
import { renderPublicComment, platformSectionMerge, type PublicCommentState } from "../report/pr-comment-body.js";
import { upsertStickyComment } from "../report/pr-comment.js";
import { viewerLinks } from "../report/viewer-links.js";
import { DEFAULT_EXPLORE_CONFIG_PATH, captureRepack, type ExploreConfig, type ExplorePlatform } from "../config/explore-config.js";
import { prepareCiExploration, type PrepareCiExplorationOptions } from "../capture/agent/exploration.js";
import { generateAgentChangeNotes } from "../capture/agent/change-notes.js";
import { CiError, environmentSecrets, serializeCiError, toCiError } from "../shared/ci-errors.js";
import type { SourceCapturePlan } from "../source/capture-plan.js";
import { createSourceChangeSummaries } from "../source/change-summary.js";
import { assertNoCaptureHealthIssues, capturedEvidenceInDoubt, partitionCaptureHealthIssues, renderCaptureIssueAnnotation, renderComparisonDiagnosticAnnotation, renderNotesUnavailableAnnotation, renderReviewGapAnnotation, sortedCaptureHealthIssues } from "../capture/health.js";
import { EXPLORE_PACKAGE, EXPLORE_VERSION, packageBin } from "../shared/package-paths.js";
import { agentDeviceLauncher, ensureArgentToolServer, ensureController } from "../shared/controller-cache.js";
import { silentProgress, type Progress } from "../shared/progress.js";
import { createTimings, phaseSequence, silentTimings, type RecordedEvent, type Timings } from "../shared/timings.js";


function requireSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new CiError({ code: `${name}_MISSING`, stage: "preflight", message: `${name} is missing.`,
    nextAction: name === "GITHUB_TOKEN"
      ? "Pass GitHub's automatic github.token to the capture step as GITHUB_TOKEN with pull-requests: read permission."
      : `Add ${name} to GitHub Actions secrets and pass it to the Explore job.` });
  return value;
}
function assertCheckout(project: string, sha: string): void {
  for (const [args, expected] of [[ ["rev-parse", "HEAD"], sha ], [["status", "--porcelain", "--untracked-files=normal"], ""]] as const) {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim() !== expected) throw new CiError({
      code: "SOURCE_CHECKOUT_MISMATCH", stage: "preflight", message: `Source checkout does not match ${sha}.`,
      nextAction: "Check out the exact recorded commit and remove generated changes from the source checkout." });
  }
}
async function evidenceSide(directory: string): Promise<PublicEvidenceSide> {
  const side: PublicEvidenceSide = { directory, bundle: await readCaptureBundle(directory) };
  try { side.map = await readExportedMap(directory); } catch { /* Missing map is reported as an evidence gap. */ }
  try { side.execution = parseRuntimeExecutionContext(JSON.parse(await readFile(join(directory, "execution.json"), "utf8"))); }
  catch (error) { side.executionIssue = (error as Error).message; /* No fabricated runtime evidence; the reason travels with the comparison diagnostics. */ }
  return side;
}
async function recipe(config: ExploreConfig, plan: SourceCapturePlan, side: "base" | "head", environment: NodeJS.ProcessEnv, instructionsSha256?: string) {
  return { inventory: plan.surfaces.map(row => row[`${side}Surface`]).filter(Boolean),
    profile: `${config.app.easProfile}:${config.app.bundleId}`,
    config: captureRecipeConfig(config, instructionsSha256),
    toolsCommit: environment.TOOLS_COMMIT || EXPLORE_PACKAGE };
}
/** The capture's clock and host-side pause; tests pair them with an injected runner so readiness budgets are not real time. */
type CaptureClock = { now?: (() => number) | undefined; sleep?: ((milliseconds: number) => void) | undefined };

const execFileAsync = promisify(execFile);

function captureOptions(config: ExploreConfig, environment: NodeJS.ProcessEnv, runner?: CommandRunner, clock: CaptureClock = {}) {
  return { ...(runner && clock.now ? { now: clock.now } : {}), ...(runner && clock.sleep ? { sleep: clock.sleep } : {}), platform: config.app.platform, bundleId: config.app.bundleId,
    ...(config.app.scheme ? { scheme: config.app.scheme } : {}), device: config.device.name, ...(config.device.pose ? { devicePose: config.device.pose } : {}),
    easProfile: config.app.easProfile, expoToken: environment.EXPO_TOKEN ?? "",
    maxScreens: 5000, maxActions: config.capture.maxActions, maxDurationMinutes: config.capture.maxMinutes,
    setup: config.setup ?? [], forceFreshBuild: false, confirmExternalRun: true, confirmTrustedSource: true, repack: captureRepack(config), appearance: config.capture.appearance, launch: config.capture.launch, reset: config.capture.reset, unattributed: config.capture.unattributed, ...(config.capture.readinessSeconds !== undefined ? { readinessSeconds: config.capture.readinessSeconds } : {}), ...(config.capture.controller ? { controller: config.capture.controller } : {}),
    ...(config.capture.simulator ? { simulator: config.capture.simulator } : {}),
    environment, ...(runner ? { runner } : {}), easCommand: packageBin("eas-cli", "eas"), agentDeviceCommand: agentDeviceLauncher(environment), repackCommand: packageBin("@expo/repack-app", "repack-app") };
}
/**
 * The hosted repack this capture shares with the other matrix jobs of its GitHub run attempt (RepackShare): only inside
 * a GitHub Actions run, whose jobs are the only ones that meet, and only when another target repacks the same app
 * (`peers`, in config order, from hostedRepackPeers). A run attempt's repacks are never used by another attempt or run,
 * such as the baseline workflow's: "Re-run failed jobs" after an EAS environment value was fixed rebundles with it.
 * Each target's `rank` (its place among the peers) staggers how long it waits for another's repack (sharedRepackWaitMs);
 * a re-run attempt runs only the jobs it re-runs, so its leader may not be one of them, and its stagger starts at once.
 */
export function repackShareOption(config: ExploreConfig, environment: NodeJS.ProcessEnv, peers: readonly string[] | undefined): { repackShare?: RepackShare } {
  const target = config.target?.id;
  if (!peers || peers.length < 2 || !target || !peers.includes(target) || captureRepack(config) !== "eas") return {};
  const run = environment.GITHUB_RUN_ID ?? "", attempt = environment.GITHUB_RUN_ATTEMPT ?? "1", repository = environment.GITHUB_REPOSITORY ?? "";
  if (!/^[1-9][0-9]*$/.test(run) || !/^[1-9][0-9]*$/.test(attempt) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return {};
  return { repackShare: { scope: `${repository}#${run}.${attempt}`, leader: peers[0]!, target, rank: peers.indexOf(target), ...(attempt === "1" ? {} : { rerun: true }) } };
}
/**
 * Head and base run in parallel worker threads when nothing ties them together: an agent session is
 * shared, an injected runner belongs to this thread, and a plausible baseline needs head's runtime profile.
 */
/** The controllers a capture of this config runs: agent-device always (it also compares screenshots), Argent when chosen. */
async function prefetchControllers(config: ExploreConfig, environment: NodeJS.ProcessEnv, progress: Progress): Promise<void> {
  await ensureController("agent-device", { environment, progress });
  if (config.capture.controller === "argent") await ensureController("argent", { environment, progress });
  // Argent on a local device also needs its tool-server, installed once before the targets capture side by side.
  if (config.capture.controller === "argent" && config.capture.simulator === "local") await ensureArgentToolServer({ environment, progress });
}

/**
 * The appearances a capture of this side renders, read before any session starts so the sessions can divide them. The
 * app config comes from `eas config` in a child process, as the capture reads it, with the capture's restricted
 * environment: never evaluated in this process, which holds the review's secrets. Unknown: undefined.
 */
async function expectedColorSchemes(config: ExploreConfig, project: string, environment: NodeJS.ProcessEnv, easCommand: string): Promise<ColorScheme[] | undefined> {
  // Argent switches the appearance only through serve-sim on an EAS iOS session; elsewhere it captures one.
  if (config.capture.controller === "argent" && config.capture.simulator !== "local" && config.app.platform !== "ios") return undefined;
  if (config.capture.appearance !== "auto") return resolveColorSchemes(config.capture.appearance, undefined, config.app.platform);
  const easEnvironment = { ...baseEnvironment(environment), ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}) };
  try {
    const { stdout } = await execFileAsync(easCommand, ["config", "--platform", config.app.platform, "--profile", config.app.easProfile, "--json", "--non-interactive"],
      { cwd: project, env: easEnvironment, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const app = (JSON.parse(stdout) as { appConfig?: Record<string, unknown> }).appConfig;
    return app && typeof app === "object" ? resolveColorSchemes("auto", app, config.app.platform) : undefined;
  } catch {
    // The capture reads the same config and reports why it cannot; until then the side keeps one session.
    return undefined;
  }
}

/**
 * Failures that fail the side even when only a secondary appearance session had them. A session Explore could not
 * confirm stopped, or whose identity it could not verify, must never be hidden behind a partial report; a checkout that
 * changed, evidence that failed its integrity checks, or a failure Explore did not classify means the primary's frames
 * may not be what they claim either.
 */
const SIDE_FAILURE_CODES = new Set(["SESSION_CLEANUP_FAILED", "SESSION_HANDOFF_UNVERIFIED", "CAPTURE_WORKER_EXITED", "EXPLORE_FAILED"]);

/**
 * Whether a secondary appearance session's failure can be reported as that appearance's frames failing, keeping the
 * primary's: only when the capture reported it itself (a worker that died before its cleanup ran rejects otherwise), its
 * session is proven stopped (the capture removes its session file only after a confirmed stop), and nothing in it
 * casts doubt on the primary's evidence.
 */
async function secondaryFailureKept(error: unknown, sessionStatePath: string | undefined): Promise<boolean> {
  if (!(error instanceof CiError)) return false;
  if (SIDE_FAILURE_CODES.has(error.code) || capturedEvidenceInDoubt(error.code)
    || (error.details as { allocation?: unknown } | undefined)?.allocation === "unknown") return false;
  return !(sessionStatePath && await lstat(sessionStatePath).then(() => true, () => false));
}

/**
 * Run one side's capture: in one session, or when `passes` splits its appearances, one worker session per pass. The
 * primary pass exports to `mapOptions.outputDirectory`; the others beside it, named by their appearances, then merge.
 * `runPass` replaces the worker capture of each pass (tests).
 */
export async function captureSideInSessions(mapOptions: CiMapOptions, passes: readonly (readonly ColorScheme[])[] | undefined,
  progress: Progress, signal: AbortSignal | undefined, worker: boolean,
  runPass?: (passOptions: CiMapOptions) => Promise<Awaited<ReturnType<typeof runCiMap>>>): Promise<Awaited<ReturnType<typeof runCiMap>>> {
  const runOnWorker = runPass ?? ((passOptions: CiMapOptions) =>
    runCiMapOnWorker((({ progress: _progress, runner: _runner, agent: _agent, signal: _signal, onBlocking: _onBlocking, ...rest }) => rest)(passOptions), progress, signal));
  if (!passes || passes.length <= 1) return worker ? runOnWorker(mapOptions) : runCiMap(mapOptions);
  const schemes = passes.flat();
  progress(`${mapOptions.side}: capturing ${passes.map(pass => pass.join("+")).join(" and ")} in separate sessions`);
  // The passes install the same app: they share one build and repack, as the targets of a local review do.
  const ownBuildShare = mapOptions.buildShare ? undefined : await mkdtemp(join(tmpdir(), "expo-explore-builds-"));
  const buildShare = mapOptions.buildShare ?? ownBuildShare!;
  const settled = await Promise.allSettled(passes.map(async (pass, index) => {
    const suffix = index === 0 ? "" : `-${pass.join("-")}`;
    const outputDirectory = `${mapOptions.outputDirectory}${suffix}`;
    try {
      return await runOnWorker({ ...mapOptions, mapDirectory: `${mapOptions.mapDirectory}${suffix}`, outputDirectory, buildShare,
        ...(mapOptions.sessionStatePath ? { sessionStatePath: `${mapOptions.sessionStatePath}${suffix}` } : {}), appearancePass: { all: schemes, capture: pass } });
    } catch (error) {
      // A pass that dies mid-build must not leave the others polling for its result.
      await abandonSharedBuilds(buildShare, owner => owner === outputDirectory, toCiError(error).code).catch(() => undefined);
      throw error;
    }
  }));
  // The build folder holds the repacked app, which the sessions have installed.
  if (ownBuildShare) await rm(ownBuildShare, { recursive: true, force: true });
  // Only the primary appearance's session fails the side, besides a stopped review and a secondary failure that cannot be
  // kept (secondaryFailureKept). In brentvatne/euxy's main baseline run 39506374824 the light session captured 16 of 16
  // routes and the dark session's install failed, which failed the whole target and lost its baseline. Such a failure is
  // kept in the report instead: every frame of its appearance is failed with its error, and the run is partial.
  const suffixOf = (pass: readonly ColorScheme[]) => `-${pass.join("-")}`;
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status !== "rejected" || index === 0) continue;
    const statePath = mapOptions.sessionStatePath ? `${mapOptions.sessionStatePath}${suffixOf(passes[index]!)}` : undefined;
    if (signal?.aborted || !await secondaryFailureKept(outcome.reason, statePath)) throw outcome.reason;
  }
  const primary = settled[0]!;
  if (primary.status === "rejected") throw primary.reason;
  const secrets = [mapOptions.expoToken, ...environmentSecrets(mapOptions.environment ?? {})];
  const secondaries = passes.slice(1).map((pass, index): SecondaryCaptureExport => {
    const outcome = settled[index + 1]!;
    if (outcome.status === "fulfilled") return { directory: `${mapOptions.outputDirectory}${suffixOf(pass)}`, scheme: pass[0]! };
    const error = serializeCiError(outcome.reason, { secrets });
    progress(`${mapOptions.side}: the ${pass.join("+")} session failed (${error.code}: ${error.message}); keeping the ${passes[0]!.join("+")} captures, and the report marks every ${pass.join("+")} frame failed`);
    return { scheme: pass[0]!, error: { code: error.code, stage: error.stage, message: error.message, nextAction: error.nextAction, retryable: error.retryable } };
  });
  await mergeCaptureExports(mapOptions.outputDirectory, secondaries);
  const result = primary.value;
  return secondaries.some(secondary => "error" in secondary) ? { ...result, runStatus: "partial" } : result;
}

/**
 * This target's share of `capture.maxSessions`: the targets are this review's (`targets`), or the config's one, and
 * `posedTargets` (foldables) take the sessions that do not divide evenly.
 */
function targetSessionShare(config: ExploreConfig, targets: readonly RunTarget[] | undefined, posedTargets: readonly string[] | undefined): number {
  const targetIds: string[] = (targets ?? []).map(target => target.id);
  if (targetIds.length === 0) targetIds.push(...(config.targets ? Object.keys(config.targets) : [config.target?.id ?? "default"]));
  return sessionShare({ maxSessions: config.capture.maxSessions, targets: targetIds, target: config.target?.id ?? targetIds[0]!,
    prefer: id => posedTargets?.includes(id) ? 1 : 0 });
}

/**
 * The appearance passes one side spreads over sessions of its own, out of its target's share of `capture.maxSessions`;
 * undefined keeps the side in one session. The side's app config is read only when its share and routes could pay for
 * a split.
 */
export async function sideAppearancePasses(config: ExploreConfig, environment: NodeJS.ProcessEnv,
  input: { share: number; sides: 1 | 2; routes: number; project: string; easCommand?: string }): Promise<ColorScheme[][] | undefined> {
  // A pass observes its launch only when capture.launch asks for it.
  const plan = (schemes: readonly ColorScheme[]) => planSideSessions({ share: input.share, sides: input.sides, routes: input.routes, schemes,
    ...(config.capture.launch === "off" ? { launchSeconds: 0 } : {}) }).passes;
  if (plan(["light", "dark"]).length < 2) return undefined;
  const schemes = await expectedColorSchemes(config, input.project, environment, input.easCommand ?? packageBin("eas-cli", "eas"));
  const passes = schemes ? plan(schemes) : [];
  return passes.length > 1 ? passes.map(pass => [...pass]) : undefined;
}

/**
 * Base's start in a review that waits for a baseline still being captured; head has already started. Base captures as
 * soon as the wait gives up, beside head when the sides capture concurrently, and a downloaded baseline is restored
 * once head finishes, since restoring checks it against head's runtime profile. A head that fails ends the wait, and
 * base is never started for a review that has already failed.
 */
export async function captureBaseAfterWait(input: { waited: Promise<string | undefined> | undefined; head: Promise<void>; stopWaiting: () => void;
  captureBase: (cacheDirectory?: string) => Promise<void>; timings?: Timings }): Promise<void> {
  if (!input.waited) return input.captureBase();
  let headFailed = false;
  input.head.catch(() => { headFailed = true; input.stopWaiting(); });
  // What the wait cost: from where base would have started to the wait's end. The wait itself began beside head.
  const blocked = (input.timings ?? silentTimings).span("baseline-blocked");
  const waited = await input.waited;
  blocked(waited ? "ok" : "skipped");
  if (headFailed) return;
  if (!waited) return input.captureBase();
  await input.head;
  return input.captureBase(waited);
}

export function captureSidesConcurrently(input: { plan: SourceCapturePlan; agent: boolean; injectedRunner: boolean; baselineMayExist: boolean }): boolean {
  return !input.agent && !input.injectedRunner && !input.baselineMayExist
    && input.plan.headCaptureSurfaceIds.length > 0 && input.plan.baseCaptureSurfaceIds.length > 0;
}
type AgentUsagePhase = "preflight" | "capture-head" | "capture-base" | "notes" | "capture-baseline";
function recordAgentUsage(output: string, phase: () => AgentUsagePhase): NonNullable<PrepareCiExplorationOptions["onUsage"]> {
  return async receipt => {
    const record = { contract: "explore.agent-usage.v1", phase: phase(), timestamp: new Date().toISOString(), receipt };
    await mkdir(output, { recursive: true });
    const file = await open(join(output, "agent-usage.jsonl"), "a", 0o600);
    try {
      await file.chmod(0o600);
      await file.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    } finally { await file.close(); }
  };
}
export type PublicCiOptions = {
  /** Replaces the agent-device screenshot comparator (tests exercise comparator failures with it). */
  measure?: Parameters<typeof assessPublicEvidence>[0]["measure"];
  /** Set when the workflow passes --platform; artifact and report names then carry the platform suffix. */
  platform?: ExplorePlatform;
  /** The target id a matrix job captures (--target, or --platform from older workflows): its comment section and names. */
  target?: string;
  /** Every platform config.yaml captures; recorded in the report so the Viewer links the sibling platform's report. */
  platforms?: ExplorePlatform[];
  /** Every target config.yaml captures, in config order; recorded in the report so the Viewer links the sibling targets' reports. */
  targets?: RunTarget[];
  /** The targets with a device pose (foldables), which take the sessions `capture.maxSessions` does not divide evenly. */
  posedTargets?: readonly string[];
  /** The targets whose jobs repack the same app as this one, in config order (hostedRepackPeers): they share one hosted repack per commit. */
  repackPeers?: readonly string[];
  baseProject: string; headProject: string; pullRequestPath: string; output: string;
  config: ExploreConfig; configPath?: string; environment?: NodeJS.ProcessEnv; transport?: typeof fetch;
  now?: () => number; sleep?: (milliseconds: number) => void; onComment?: (state: PublicCommentState, body: string) => void;
  runner?: CommandRunner;
  /** Internal dependency injection; configuration cannot replace the authenticated CLI session. */
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"];
  /** Internal dependency injection for tests: replaces the wait for a baseline run that EXPLORE_BASELINE_RUN names. */
  awaitBaseline?: BaselineWait;
  progress?: Progress;
  /** Where the run's timings are appended (`$RUNNER_TEMP/explore-diagnostics/timings.jsonl`); none are kept without it. */
  timingsPath?: string;
  progressPostMs?: number;
  /** Stops the captures between steps (a cancelled job): a session is still stopped, and a hosted repack run cancelled. */
  signal?: AbortSignal;
};

/**
 * Waits for a baseline of the base commit still being captured: its downloaded export's directory, or undefined.
 * `watch` hears what the baseline job is doing and records the wait.
 */
type BaselineWait = (signal: AbortSignal, watch?: Pick<BaselineWaitOptions, "onUpdate" | "timings">) => Promise<string | undefined>;

/**
 * The wait for a baseline still capturing the base commit: for the run `ci:find-baseline` named in
 * EXPLORE_BASELINE_RUN, which the wait checks again by the same trust rules, for up to capture.baselineWaitMinutes. A
 * workflow that names no run, or a config that sets 0, captures the base as before.
 */
function pendingBaselineWait(options: Pick<PublicCiOptions, "awaitBaseline" | "config" | "target" | "platform" | "output" | "progress">,
  environment: NodeJS.ProcessEnv, transport: typeof fetch, baseSha: string): BaselineWait | undefined {
  if (options.awaitBaseline) return options.awaitBaseline;
  const run = Number(environment.EXPLORE_BASELINE_RUN);
  const minutes = options.config.capture.baselineWaitMinutes ?? DEFAULT_BASELINE_WAIT_MINUTES;
  if (!Number.isSafeInteger(run) || run <= 0 || minutes === 0) return undefined;
  const target = options.target ?? options.platform ?? options.config.target?.id ?? "ios";
  return (signal, watch) => awaitPendingBaseline({ run, sha: baseSha, target, timeoutMs: minutes * 60_000, directory: join(resolve(options.output), "baseline-download"),
    environment, transport, signal, ...(options.progress ? { progress: options.progress } : {}), ...watch });
}

function assertRunIdentity(environment: NodeJS.ProcessEnv): void {
  if (!/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ATTEMPT ?? "")) {
    throw new CiError({ code: "CI_RUN_IDENTITY_MISSING", stage: "preflight", message: "The GitHub run ID or attempt is missing.",
      nextAction: "Run capture:review inside the maintained Explore GitHub Actions workflow." });
  }
}

/** What both CI adapters check before capture: exact checkouts of both sides and an output outside them. */
async function prepareCiRun(options: Pick<PublicCiOptions, "baseProject" | "headProject" | "output" | "config" | "configPath" | "now" | "targets">,
  environment: NodeJS.ProcessEnv, presentation: ReviewPresentation) {
  const now = options.now ?? Date.now;
  const config = options.config;
  const projects = { base: await realpath(options.baseProject), head: await realpath(options.headProject) };
  const output = resolve(options.output);
  const temporary = await realpath(environment.RUNNER_TEMP || tmpdir());
  const outputRelative = relative(temporary, output);
  if (!outputRelative || outputRelative.startsWith("..") || isAbsolute(outputRelative)) throw new Error("CI output must be inside RUNNER_TEMP, outside source checkouts");
  for (const side of ["base", "head"] as const) {
    assertCheckout(projects[side], presentation[side].sha);
    const rel = relative(projects[side], output);
    if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("Capture output cannot be inside a source checkout");
  }
  const appDirectory = await readAppDirectory(projects.head);
  const configPath = options.configPath ?? DEFAULT_EXPLORE_CONFIG_PATH;
  const repositoryConfigPath = appDirectory === "." ? configPath : `${appDirectory}/${configPath}`;
  const state: PublicCommentState = { phase: "pending", pullRequest: presentation, mode: config.exploration.scope,
    executionMode: config.mode, configPath: repositoryConfigPath,
    links: viewerLinks({ repository: presentation.repository, headSha: presentation.head.sha, runId: environment.GITHUB_RUN_ID!,
      runAttempt: environment.GITHUB_RUN_ATTEMPT!, configPath: repositoryConfigPath }),
    startedAt: now(), updatedAt: now(), build: { platform: config.app.platform, easProfile: config.app.easProfile }, artifactOnly: true,
    ...(config.target ? { target: config.target } : {}), ...(options.targets && options.targets.length > 1 ? { targets: options.targets } : {}),
    ...(config.report?.comment?.map ? { map: true } : {}) };
  return { projects, output, state };
}

/** A review of any two commits (`capture:review --compare FILE`): the same capture as a PR's, with no PR to verify or comment on. */
export async function runCompareCi(options: Omit<PublicCiOptions, "pullRequestPath" | "onComment"> & { comparePath: string }) {
  const environment = options.environment ?? process.env;
  assertRunIdentity(environment);
  const comparison = projectComparePresentation(JSON.parse(await readFile(options.comparePath, "utf8")));
  const { projects, output, state } = await prepareCiRun(options, environment, comparison);
  const assertCurrentHead = async () => { for (const side of ["base", "head"] as const) assertCheckout(projects[side], comparison[side].sha); };
  const awaitBaseline = pendingBaselineWait(options, environment, options.transport ?? fetch, comparison.base.sha);
  return runCiReview({ ...options, projects, output, state, presentation: comparison, ...(awaitBaseline ? { awaitBaseline } : {}),
    environment, runId: environment.GITHUB_RUN_ID!, runAttempt: environment.GITHUB_RUN_ATTEMPT!,
    assertCurrentHead, postComment: async () => {}, postProgress: async () => {} });
}

export async function runPublicCi(options: PublicCiOptions) {
  const environment = options.environment ?? process.env;
  const transport = options.transport ?? fetch;
  const now = options.now ?? Date.now;
  const githubToken = requireSecret(environment, "GITHUB_TOKEN");
  assertRunIdentity(environment);
  const pr = projectPullRequestPresentation(JSON.parse(await readFile(options.pullRequestPath, "utf8")));
  const { projects, output, state } = await prepareCiRun(options, environment, pr);
  // One write at a time, each rendering the state when its turn comes: a progress post still in flight can never land
  // after a later phase's post, or the failure's, and undo it.
  let writing = Promise.resolve();
  const upsert = () => (writing = writing.then(async () => {
    state.updatedAt = now(); const body = renderPublicComment(state); options.onComment?.(state, body);
    try { await upsertStickyComment({ repository: pr.repository, issueNumber: pr.number, body, ...platformSectionMerge(state, options.target ?? options.platform), token: githubToken, fetchImpl: transport }); }
    catch (error) { process.stderr.write(`Progress comment unavailable: ${serializeCiError(error).message}\n`); }
  }));
  const postComment = async () => { await assertCurrentPr(); await upsert(); };
  // A status update between the phases' posts: it skips the PR check, whose failure would fail the review, and never throws.
  const postProgress = async () => { if (!prVerificationFailed) await upsert().catch(() => undefined); };
  let prVerificationFailed = false;
  const assertCurrentPr = async () => {
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        let current: any;
        try {
          const response = await transport(`https://api.github.com/repos/${pr.repository}/pulls/${pr.number}`, {
            headers: { authorization: `Bearer ${githubToken}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000), redirect: "error" });
          if (!response.ok) {
            const retryable = response.status >= 500 && response.status <= 599;
            if (retryable && attempt < 3) {
              await response.body?.cancel().catch(() => {});
              await delay(250 * attempt);
              continue;
            }
            throw new CiError({ code: response.status === 401 ? "GITHUB_TOKEN_INVALID" : response.status === 403 ? "GITHUB_PERMISSION_DENIED" : "GITHUB_REQUEST_FAILED",
              stage: "publication", message: `GitHub PR verification failed (${response.status}).`,
              nextAction: response.status === 401 ? "Use a valid GitHub token." : "Check repository access and pull-requests permission; retry temporary GitHub failures.", retryable });
          }
          current = await response.json();
        } catch (error) {
          // Retry only this read, never comment writes, malformed responses, or authorization failures.
          const networkFailure = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"
            || (error instanceof TypeError && error.message === "fetch failed")
            || ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN",
              "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]
              .includes(String((error.cause as { code?: unknown } | undefined)?.code)));
          if (!networkFailure) throw error;
          if (attempt < 3) { await delay(250 * attempt); continue; }
          throw new CiError({ code: "GITHUB_REQUEST_FAILED", stage: "publication",
            message: "GitHub PR verification could not complete after three network attempts.",
            nextAction: "Check GitHub availability and network access, then rerun Explore.", retryable: true, cause: error });
        }
        if (current.state !== "open" || current.head?.repo?.full_name !== pr.repository) throw new CiError({ code: "PR_CHANGED", stage: "publication",
          message: "The PR closed before publication.", nextAction: "Run Explore for an open PR." });
        // A push while this run worked: the run still finishes for the head it captured, and the comment keeps
        // its report under previous runs instead of presenting it as the current review.
        if (current.head?.sha !== pr.head.sha || current.base?.sha !== pr.base.sha) {
          if (!state.superseded) process.stderr.write(`The PR moved to ${String(current.head?.sha).slice(0, 8)} while this run reviewed ${pr.head.sha.slice(0, 8)}; this report publishes as a previous run.\n`);
          state.superseded = true;
        }
        return;
      }
    } catch (error) {
      prVerificationFailed = true;
      throw error;
    }
  };
  const assertCurrentHead = async () => {
    for (const side of ["base", "head"] as const) assertCheckout(projects[side], pr[side].sha);
    await assertCurrentPr();
  };
  const awaitBaseline = pendingBaselineWait(options, environment, transport, pr.base.sha);
  return runCiReview({ ...options, projects, output, state, presentation: pr, ...(awaitBaseline ? { awaitBaseline } : {}),
    environment, runId: environment.GITHUB_RUN_ID!, runAttempt: environment.GITHUB_RUN_ATTEMPT!,
    assertCurrentHead, postComment, postProgress, canPublish: () => !prVerificationFailed });
}

/** The least time between two posts of the comment's waiting status, besides the posts that start and end the wait. */
const PROGRESS_POST_MS = 3 * 60_000;

/** Fetches the controllers in a span; a failure there ends the run before its phases, so it records the run's finish too. */
async function controllersTimed(timings: Timings, fetch: () => Promise<void>): Promise<void> {
  try { await timings.measure("controllers", fetch); }
  catch (error) {
    timings.record({ type: "finish", outcome: "failed", code: toCiError(error).code });
    throw error;
  }
}

/** The run a timings file belongs to: the workflow, target, release, and run attempt, from the runner's variables. */
function runHeader(environment: NodeJS.ProcessEnv, config: ExploreConfig): RecordedEvent {
  return { type: "run", release: EXPLORE_VERSION, ...(config.target ? { target: config.target.id } : {}),
    ...(environment.GITHUB_WORKFLOW ? { workflow: environment.GITHUB_WORKFLOW } : {}),
    ...(/^\d+$/.test(environment.GITHUB_RUN_ID ?? "") ? { run: environment.GITHUB_RUN_ID! } : {}),
    ...(/^\d+$/.test(environment.GITHUB_RUN_ATTEMPT ?? "") ? { attempt: environment.GITHUB_RUN_ATTEMPT! } : {}) };
}

function planSummary(plan: SourceCapturePlan, baseline = false): string {
  const changed = plan.surfaces.filter(surface => surface.status !== "unchanged").length;
  return `source plan: ${plan.inventorySurfaceIds.length} routes`
    + (baseline ? `; capturing ${plan.headCaptureSurfaceIds.length}`
      : `, ${changed} changed; capturing ${plan.headCaptureSurfaceIds.length} on head and ${plan.baseCaptureSurfaceIds.length} on base`)
    + (plan.excludedSurfaceIds?.length ? `; ${plan.excludedSurfaceIds.length} excluded by config` : "");
}

/** Shared capture/review orchestration; adapters own run identity and publication. */
export async function runCiReview(options: {
  projects: { base: string; head: string }; output: string; config: ExploreConfig;
  presentation: ReviewPresentation; runId: string; runAttempt: string;
  platforms?: ExplorePlatform[];
  /** Every target config.yaml captures; `config.target` is the one this review captures. */
  targets?: RunTarget[];
  /** The targets with a device pose (foldables), which take the sessions `capture.maxSessions` does not divide evenly. */
  posedTargets?: readonly string[];
  /** A folder shared with the other targets' reviews, so the targets of one platform build each commit once. */
  buildShare?: string;
  /** The targets whose matrix jobs repack the same app as this one, in config order: they share one hosted repack per commit. */
  repackPeers?: readonly string[];
  measure?: Parameters<typeof assessPublicEvidence>[0]["measure"];
  state: PublicCommentState; environment: NodeJS.ProcessEnv;
  assertCurrentHead: () => Promise<void>; postComment: () => Promise<void>; canPublish?: () => boolean;
  /** Posts the comment's state without verifying the PR first; best effort, for what changes between phases. */
  postProgress?: () => Promise<void>;
  /** The least time between two progress posts while base waits for a baseline (PROGRESS_POST_MS); tests shorten it. */
  progressPostMs?: number;
  /** Where the run's timings are appended; none are kept without it. */
  timingsPath?: string;
  now?: () => number; sleep?: (milliseconds: number) => void; runner?: CommandRunner; subscription?: boolean; useLocalEasSession?: boolean;
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"];
  prepareCapture?: () => Promise<void>;
  /**
   * Waits for a baseline of the base commit that is still being captured, when no downloaded baseline matches. It runs
   * alongside head, and base waits for it only where base would start capturing.
   */
  awaitBaseline?: BaselineWait;
  progress?: Progress;
  /** Stops the captures between steps; model requests take it through agentSessionFactory. */
  signal?: AbortSignal;
}) {
  const { projects, output, config, environment, state, assertCurrentHead, postComment } = options;
  const progress = options.progress ?? silentProgress;
  const timings = createTimings({ path: options.timingsPath, secrets: environmentSecrets(environment) });
  timings.record(runHeader(environment, config));
  const phases = phaseSequence(timings);
  // The controllers are fetched before any EAS work, so a blocked download fails before a session is paid for. agent-device
  // also compares the screenshots. An injected runner (tests) stands in for the controllers' calls, but not for that
  // comparison: it still runs the real agent-device, which fetches itself on first use.
  if (!options.runner) await controllersTimed(timings, () => prefetchControllers(config, environment, progress));
  const pr = options.presentation;
  const now = options.now ?? Date.now;
  const secretValues = environmentSecrets(environment);
  let stage = "plan";
  let usagePhase: AgentUsagePhase = "preflight";
  let preserveReport: (() => Promise<void>) | undefined;
  let reportWritten = false;
  // Stops a baseline wait still polling once the review no longer needs it: done, failed, or stopped.
  const stopWaiting = new AbortController();
  let progressPost: ReturnType<typeof setTimeout> | undefined;
  let progressPostedAt = -Infinity;
  try {
    phases.enter("plan");
    progress(`planning the review of ${pr.head.sha.slice(0, 8)} against base ${pr.base.sha.slice(0, 8)} (scope ${config.exploration.scope})`);
    const plan = await buildVerifiedPlan({ baseProject: projects.base, headProject: projects.head,
      baseSha: pr.base.sha, headSha: pr.head.sha, config, output });
    progress(planSummary(plan));
    if (plan.baseSha !== plan.headSha) {
      const summaries = createSourceChangeSummaries({ baseProject: projects.base, headProject: projects.head, plan });
      for (const surface of plan.surfaces) surface.sourceChange = summaries[surface.id]!;
      await writeFile(join(output, "execution-plan.json"), JSON.stringify(plan));
    }
    state.inventory = { routes: plan.surfaces.filter(row => row.headSurface).length };
    state.warnings = [...new Set([...plan.unresolved, ...plan.diagnostics.base, ...plan.diagnostics.head])].sort();
    state.capture = { planned: { base: plan.baseCaptureSurfaceIds.length, head: plan.headCaptureSurfaceIds.length },
      done: { base: 0, head: 0 }, baseFromCache: false };
    await assertCurrentHead(); await postComment();
    stage = "preflight"; phases.enter("preflight");
    const active = plan.headCaptureSurfaceIds.length + plan.baseCaptureSurfaceIds.length > 0;
    if (active && !options.useLocalEasSession) requireSecret(environment, "EXPO_TOKEN");
    const exploration = await prepareCiExploration(config, projects.head, environment, active,
      { ...(options.agentSessionFactory ? { createSession: options.agentSessionFactory } : {}),
        onUsage: recordAgentUsage(output, () => usagePhase), ...(options.subscription ? { subscription: true } : {}) });
    if (exploration.agent) exploration.agent.captureConstraints = await agentCaptureConstraints(plan, projects);
    if (active) await options.prepareCapture?.();
    let runtimeProfile: Awaited<ReturnType<typeof readCaptureBundle>>["runtimeProfile"] = null;
    const cacheRecipes = { head: await recipe(config, plan, "head", environment, exploration.instructionsSha256),
      base: await recipe(config, plan, "base", environment, exploration.instructionsSha256) };
    if (options.subscription) for (const side of ["head", "base"] as const) cacheRecipes[side].toolsCommit += ":local-subscription";
    // A baseline that may be restored needs the head runtime profile first; otherwise both sides capture at once.
    const baselineMayExist = plan.baseCaptureSurfaceIds.length > 0 && await captureArtifactCacheMayMatch({ ...cacheRecipes.base,
      ...(environment.EXPLORE_CAPTURE_CACHE ? { sourceDirectory: environment.EXPLORE_CAPTURE_CACHE } : {}), commit: pr.base.sha });
    // With no finished baseline to reuse, one still being captured is waited for: from now, alongside head, and base
    // waits for it only where it would start. Head is never delayed by it (brentvatne/euxy's review run 39348956443).
    // While it waits, the comment says so and names the step the baseline job is in. It is posted when the wait starts
    // and ends, and in between at most every `progressPostMs` with the latest step: every post rewrites the whole
    // comment, which the other targets' jobs write too.
    const waitingFor = (step?: string) => {
      if (step === undefined) delete state.capture!.waiting;
      else state.capture!.waiting = { on: "baseline", ...(step ? { step } : {}) };
      clearTimeout(progressPost);
      const post = () => { progressPostedAt = Date.now(); void options.postProgress?.(); };
      const due = progressPostedAt + (options.progressPostMs ?? PROGRESS_POST_MS) - Date.now();
      if (step === undefined || due <= 0) post();
      else (progressPost = setTimeout(post, due)).unref();
    };
    const waitedBaseline = !baselineMayExist && plan.baseCaptureSurfaceIds.length > 0 && options.awaitBaseline
      ? options.awaitBaseline(options.signal ? AbortSignal.any([stopWaiting.signal, options.signal]) : stopWaiting.signal,
        { timings, onUpdate: update => waitingFor(update.step ?? "") }).catch(() => undefined)
        .finally(() => { if (state.capture?.waiting) waitingFor(undefined); }) : undefined;
    const share = targetSessionShare(config, options.targets, options.posedTargets);
    // A share of one session captures the sides in turn.
    const concurrent = captureSidesConcurrently({ plan, agent: !!exploration.agent, injectedRunner: !!options.runner, baselineMayExist }) && share >= 2;
    // Each side's appearances split by its own app config: a pull request can change userInterfaceStyle. Sides taken in
    // turn (a baseline may be restored) each have the whole share. Passes run on worker threads, which cannot take an
    // injected runner or an agent session.
    const sidePasses = { head: undefined as ColorScheme[][] | undefined, base: undefined as ColorScheme[][] | undefined };
    if (!exploration.agent && !options.runner) await Promise.all((["head", "base"] as const).map(async side => {
      sidePasses[side] = await sideAppearancePasses(config, environment, { share, sides: concurrent ? 2 : 1, routes: plan[`${side}CaptureSurfaceIds`].length, project: projects[side] });
    }));
    const split = (["head", "base"] as const).filter(side => sidePasses[side]);
    progress(`sessions: ${share} of ${config.capture.maxSessions ?? DEFAULT_MAX_SESSIONS} for this target; `
      + (split.length ? `${split.join(" and ")} ${split.length === 1 ? "captures its" : "capture their"} appearances in separate sessions`
        : concurrent ? "one session per side" : "the sides in turn"));
    const captureSide = async (side: "head" | "base", cacheDirectory = environment.EXPLORE_CAPTURE_CACHE) => {
      const directory = join(output, `${side}-export`);
      const selectedIds = plan[`${side}CaptureSurfaceIds`];
      const cacheRecipe = cacheRecipes[side];
      let reuseDirectory: string | undefined;
      if (side === "base" && selectedIds.length && runtimeProfile && cacheDirectory) {
        const restored = await restoreCaptureArtifactCache({ ...cacheRecipe, sourceDirectory: cacheDirectory,
          commit: pr.base.sha, selectedIds, directory: join(output, "base-cache"), runtimeProfile,
          ...(exploration.agent ? { captureContexts: exploration.agent.contexts } : {}) });
        if (restored) reuseDirectory = join(output, "base-cache");
        const incomplete = restored ? undefined : await incompleteCaptureReason(cacheDirectory, pr.base.sha);
        progress(restored ? `base: found the baseline captures of ${pr.base.sha.slice(0, 8)}`
          : incomplete ? `base: the baseline of ${pr.base.sha.slice(0, 8)} has nothing to reuse (${incomplete}); capturing the base too`
            : `base: no compatible baseline of ${pr.base.sha.slice(0, 8)}; capturing the base too`);
      }
      const mapOptions = { ...captureOptions(config, environment, options.runner, { now: options.now, sleep: options.sleep }), progress,
        ...(options.useLocalEasSession ? { useLocalEasSession: true } : {}),
        ...(exploration.agent ? { agent: exploration.agent } : {}), project: projects[side],
        mapDirectory: join(output, `${side}-map`), outputDirectory: directory,
        name: config.app.name ?? pr.repository, buildId: pr.origin === "local" ? `local-${pr.runId}-${side}` : pr.origin === "compare" ? `compare-${options.runId}-${side}` : `pr-${pr.number}-${side}`, buildVersion: pr[side].sha.slice(0, 8), gitCommit: pr[side].sha,
        planPath: join(output, "execution-plan.json"), side, sessionStatePath: join(output, `${side}-session`), ...(options.buildShare ? { buildShare: options.buildShare } : {}),
        ...(options.timingsPath ? { timingsPath: options.timingsPath } : {}),
        ...repackShareOption(config, environment, options.repackPeers),
        ...(reuseDirectory ? { reuseDirectory } : {}), ...(options.signal ? { signal: options.signal } : {}) };
      // A restored baseline already holds every appearance pass, so it never splits.
      const captured = await captureSideInSessions(mapOptions, reuseDirectory ? undefined : sidePasses[side], progress, options.signal, concurrent);
      const bundle = await readCaptureBundle(directory);
      bundle.profile = cacheRecipe.profile;
      await writeFile(join(directory, "bundle.json"), JSON.stringify(bundle));
      const captureState = state.capture!;
      // Progress counts planned surfaces (routes); a secondary appearance pass adds `<id>@dark` images for the same surface.
      captureState.done[side] = Object.keys(bundle.images).filter(id => !routeIdOfScreen(id).scheme).length;
      if (reuseDirectory) captureState.baseFromCache = true;
      if (side === "head") {
        runtimeProfile = bundle.runtimeProfile;
        state.build = { platform: config.app.platform, easProfile: config.app.easProfile, appName: captured.app.name,
          ...(captured.easBuildId ? { easBuildId: captured.easBuildId } : {}), reusedEasBuild: captured.reusedEasBuild,
          ...(captured.app.version ? { appVersion: captured.app.version } : {}),
          ...(captured.app.buildNumber ? { appBuildNumber: captured.app.buildNumber } : {}) };
        if (captured.simulatorRuntime) state.runtime = captured.simulatorRuntime;
      }
      await writeCaptureArtifactCache(directory, cacheRecipe);
    };
    const captureBase = (head: Promise<void>) => captureBaseAfterWait({ waited: waitedBaseline, head, stopWaiting: () => stopWaiting.abort(),
      captureBase: cacheDirectory => captureSide("base", cacheDirectory), timings });
    phases.enter("capture");
    if (waitedBaseline) progress(`base waits for the baseline run of ${pr.base.sha.slice(0, 8)} still being captured; head captures meanwhile`);
    if (concurrent) {
      stage = "capture-head"; state.phase = "capturing"; state.capture.current = "head"; usagePhase = "capture-head";
      progress(waitedBaseline ? "capturing head; base captures in a second simulator session if the baseline cannot be reused"
        : "capturing head and base at the same time in two simulator sessions");
      await postComment();
      // Let both sides finish or fail on their own so every started session is stopped by its owner.
      const head = captureSide("head");
      const settled = await Promise.allSettled([head, captureBase(head)]);
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "rejected") { stage = index === 0 ? "capture-head" : "capture-base"; throw outcome.reason; }
      }
    } else {
      for (const side of ["head", "base"] as const) {
        stage = `capture-${side}`; state.phase = "capturing"; state.capture.current = side;
        usagePhase = `capture-${side}`;
        await postComment();
        await (side === "head" ? captureSide("head") : captureBase(Promise.resolve()));
      }
    }
    delete state.capture.current;
    stage = "compare"; phases.enter("compare");
    progress("comparing base and head captures");
    const sides = { base: await evidenceSide(join(output, "base-export")), head: await evidenceSide(join(output, "head-export")) };
    const system = systemRegions({ platform: config.app.platform, device: config.device.name, pose: config.device.pose });
    const evidence = await assessPublicEvidence({ platform: config.app.platform, systemRegions: system, plan, ...sides, ...(options.measure ? { measure: options.measure } : {}), profile: `${config.app.easProfile}:${config.app.bundleId}`, agentDeviceCommand: agentDeviceLauncher(options.environment) });
    const result = await prepareCaptureReview({ plan, pullRequest: pr, baseDirectory: sides.base.directory, headDirectory: sides.head.directory, systemRegions: system,
      runId: options.runId, runAttempt: options.runAttempt, assertCurrentHead, assessments: evidence.surfaces,
      ...(options.platforms ? { platforms: options.platforms } : {}),
      ...(config.target ? { target: config.target } : {}), ...(options.targets ? { targets: options.targets } : {}),
      app: { ...(state.build?.appVersion ? { version: state.build.appVersion } : {}),
        ...(state.build?.appBuildNumber ? { buildNumber: state.build.appBuildNumber } : {}) } });
    const contract = quarantineReviewContract(result.review);
    for (const gap of contract.gaps) {
      progress(renderReviewGapAnnotation(gap));
      evidence.summary.diagnostics.push({ surfaceId: gap.surfaceId ?? gap.section ?? "report", code: "REVIEW_CONTRACT_GAP", stage: "review",
        message: `${gap.message} (${gap.dropped} omitted)`, nextAction: "Report this with the diagnostics artifact; the rest of the report is unaffected.", retryable: false });
    }
    if (contract.gaps.length) progress(`${contract.gaps.length} part${contract.gaps.length === 1 ? "" : "s"} of the review failed its contract and ${contract.gaps.length === 1 ? "is" : "are"} omitted`);
    result.review = contract.review;
    state.review = result.review; state.evidence = evidence.summary;
    const inputPath = join(output, "report-input.json");
    preserveReport = async () => {
      if (reportWritten) return;
      await writeCiReportInput({ inputPath, publicReview: result.review, assets: result.assets, commentState: state,
        ...(config.report?.preview ? { preview: config.report.preview } : {}) });
      reportWritten = true;
    };
    await writeFile(join(output, "execution.json"), JSON.stringify({ runId: options.runId, runAttempt: options.runAttempt,
      baseSha: pr.base.sha, headSha: pr.head.sha, startedAt: state.startedAt, completedAt: now(), capture: state.capture }));
    stage = "capture-validation";
    // Evidence that cannot be trusted fails the run. Screens the run could not reach do not: the report still publishes
    // and names them as unavailable, the comment reads Incomplete, and each one becomes a warning annotation.
    const health = partitionCaptureHealthIssues(sortedCaptureHealthIssues((["base", "head"] as const).map(side => ({
      bundle: sides[side].bundle, selectedIds: plan[`${side}CaptureSurfaceIds`], side,
    }))));
    assertNoCaptureHealthIssues(health.integrity);
    if (health.unavailable.length) {
      for (const issue of health.unavailable) progress(renderCaptureIssueAnnotation(issue));
      progress(`${health.unavailable.length} ${health.unavailable.length === 1 ? "screen is" : "screens are"} unavailable in this report`);
    }
    stage = "comparison-validation";
    // A comparator that never ran leaves no evidence to review and fails the run. A pair whose comparison failed
    // is a named gap: its surface reads "Visual comparison failed" / Needs review, the comment counts it, and the run
    // annotates it.
    const { visual, accessibility, comparison } = evidence.summary;
    if (comparison.eligible > 0 && (!visual || !accessibility || visual.compared + visual.failed === 0 || accessibility.compared + accessibility.failed === 0)) {
      throw new CiError({ code: "COMPARISON_INCOMPLETE", stage,
        message: "Verified screenshots were captured, but required evidence comparison did not run.",
        nextAction: "Inspect the comparison diagnostics, restore the required comparator, and rerun Explore.",
        details: { diagnostics: evidence.summary.diagnostics,
          ...(sides.base.executionIssue ? { baseExecution: sides.base.executionIssue } : {}),
          ...(sides.head.executionIssue ? { headExecution: sides.head.executionIssue } : {}) } });
    }
    const failedComparisons = evidence.summary.diagnostics.filter(diagnostic => diagnostic.stage === "compare");
    for (const diagnostic of failedComparisons) progress(renderComparisonDiagnosticAnnotation(diagnostic));
    if (failedComparisons.length) progress(`${failedComparisons.length} comparison${failedComparisons.length === 1 ? "" : "s"} failed; the affected screens read as needing review`);
    if (exploration.agent) {
      stage = "notes"; phases.enter("notes");
      usagePhase = "notes";
      try {
        const notes = await generateAgentChangeNotes({ review: result.review, assets: result.assets,
          provider: exploration.agent.provider, deadlineMs: Date.now() + 10 * 60_000 });
        result.review = notes.review;
        state.review = notes.review;
        await writeFile(join(output, "agent-notes-diagnostics.json"), JSON.stringify(notes.diagnostics));
      } catch (error) {
        // Change notes explain verdicts; they are not evidence. A notes session that fails (provider down, budget,
        // malformed output) leaves the deterministic verdicts and captures as they are and the report publishes
        // without notes. Altered or unreadable image evidence is an integrity defect and still fails.
        if (error instanceof CiError && error.code === "AGENT_NOTES_EVIDENCE_INVALID") throw error;
        const failure = toCiError(error, { code: "AGENT_NOTES_FAILED", stage: "notes",
          nextAction: "Check the provider's status and the notes diagnostic; rerun Explore for a report with notes." });
        progress(renderNotesUnavailableAnnotation(failure));
        progress("change notes are unavailable for this report; verdicts and captures are unaffected");
        evidence.summary.diagnostics.push({ surfaceId: "report", code: "AGENT_NOTES_UNAVAILABLE", stage: "review",
          message: `${failure.code}: ${failure.message}`, nextAction: failure.nextAction, retryable: failure.retryable });
        state.evidence = evidence.summary;
        await writeFile(join(output, "agent-notes-diagnostics.json"), JSON.stringify({ error: serializeCiError(failure) }));
      }
    }
    phases.enter("report");
    await preserveReport();
    progress(pr.origin === "compare" || pr.origin === "local" ? "writing the report" : "writing the report and updating the pull request comment");
    await assertCurrentHead(); await postComment();
    phases.end();
    timings.record({ type: "finish", outcome: "ok" });
    return { ...result, evidence, inputPath };
  } catch (error) {
    state.phase = "failed"; const diagnostic = serializeCiError(error, { secrets: secretValues });
    const cancelled = diagnostic.code === "CAPTURE_CANCELLED";
    phases.end(cancelled ? "cancelled" : "failed", diagnostic.code);
    timings.record({ type: "finish", outcome: cancelled ? "cancelled" : "failed", code: diagnostic.code });
    state.failure = { step: stage, message: `${diagnostic.code}: ${diagnostic.message} ${diagnostic.nextAction}` };
    try { await preserveReport?.(); } catch { /* Retain the original failure if its report cannot be written. */ }
    // An exhausted verification already established that publication is unavailable; do not repeat its attempts.
    if (options.canPublish?.() !== false) {
      try { await postComment(); } catch { /* A stale PR or inaccessible GitHub must not replace the original failure. */ }
    }
    throw error;
  } finally {
    stopWaiting.abort();
    clearTimeout(progressPost);
  }
}

export async function runBaselineCi(options: { platform?: ExplorePlatform; project: string; sha: string; output: string; config: ExploreConfig; environment?: NodeJS.ProcessEnv; runner?: CommandRunner;
  /** Every target config.yaml captures, so this baseline takes its target's share of `capture.maxSessions`. */
  targets?: RunTarget[];
  /** The targets with a device pose (foldables), which take the sessions `capture.maxSessions` does not divide evenly. */
  posedTargets?: readonly string[];
  /** The targets whose baseline jobs repack the same app as this one, in config order: they share one hosted repack. */
  repackPeers?: readonly string[];
  now?: () => number; sleep?: (milliseconds: number) => void;
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"]; progress?: Progress;
  /** Use the local `eas login` session instead of EXPO_TOKEN (expo-explore doctor --capture). */
  useLocalEasSession?: boolean;
  /** Agent mode with the local claude or codex login instead of the provider's API key. */
  subscription?: boolean;
  /** Stops the capture between steps (a cancelled job): its session is still stopped, and a hosted repack run cancelled. */
  signal?: AbortSignal;
  /** Where the run's timings are appended; none are kept without it. */
  timingsPath?: string }) {
  const environment = options.environment ?? process.env;
  assertCheckout(options.project, options.sha);
  const timings = createTimings({ path: options.timingsPath, labels: { side: "baseline" }, secrets: environmentSecrets(environment) });
  timings.record(runHeader(environment, options.config));
  if (!options.runner) await controllersTimed(timings, () => prefetchControllers(options.config, environment, options.progress ?? silentProgress));
  const phases = phaseSequence(timings);
  try {
    phases.enter("plan");
    const baseline = await captureBaseline(options, environment, phases);
    phases.end();
    timings.record({ type: "finish", outcome: "ok" });
    return baseline;
  } catch (error) {
    const code = toCiError(error).code;
    const outcome = code === "CAPTURE_CANCELLED" ? "cancelled" : "failed";
    phases.end(outcome, code);
    timings.record({ type: "finish", outcome, code });
    throw error;
  }
}

async function captureBaseline(options: Parameters<typeof runBaselineCi>[0], environment: NodeJS.ProcessEnv, phases: ReturnType<typeof phaseSequence>) {
  const output = resolve(options.output);
  const relativeOutput = relative(await realpath(options.project), output);
  if (!relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) throw new Error("Baseline output must be outside the source checkout");
  const progress = options.progress ?? silentProgress;
  progress(`planning the baseline of ${options.sha.slice(0, 8)}`);
  const plan = await buildVerifiedPlan({ baseProject: options.project, headProject: options.project,
    baseSha: options.sha, headSha: options.sha, config: options.config, output, scope: "all" });
  progress(planSummary(plan, true));
  const active = plan.headCaptureSurfaceIds.length > 0;
  phases.enter("preflight");
  if (active && !options.useLocalEasSession) requireSecret(environment, "EXPO_TOKEN");
  let usagePhase: AgentUsagePhase = "preflight";
  const exploration = await prepareCiExploration(options.config, options.project, environment, active,
    { ...(options.agentSessionFactory ? { createSession: options.agentSessionFactory } : {}),
      onUsage: recordAgentUsage(output, () => usagePhase), ...(options.subscription ? { subscription: true } : {}) });
  const directory = join(output, "baseline-export");
  usagePhase = "capture-baseline";
  const baselineOptions: CiMapOptions = { ...captureOptions(options.config, environment, options.runner, { now: options.now, sleep: options.sleep }), progress,
    ...(options.useLocalEasSession ? { useLocalEasSession: true } : {}),
    ...(exploration.agent ? { agent: exploration.agent } : {}), project: options.project,
    mapDirectory: join(output, "baseline-map"), outputDirectory: directory, name: options.config.app.name ?? options.config.app.bundleId,
    buildId: `baseline-${options.sha.slice(0, 12)}`, buildVersion: options.sha.slice(0, 8), gitCommit: options.sha,
    side: "head", planPath: join(output, "execution-plan.json"), sessionStatePath: join(output, "baseline-session"),
    ...(options.timingsPath ? { timingsPath: options.timingsPath, timingsSide: "baseline" } : {}),
    ...repackShareOption(options.config, environment, options.repackPeers), ...(options.signal ? { signal: options.signal } : {}) };
  const share = targetSessionShare(options.config, options.targets, options.posedTargets);
  // Passes on worker threads cannot take an injected runner or an agent session.
  const passes = !options.runner && !exploration.agent
    ? await sideAppearancePasses(options.config, environment, { share, sides: 1, routes: plan.headCaptureSurfaceIds.length, project: options.project }) : undefined;
  progress(`sessions: ${share} of ${options.config.capture.maxSessions ?? DEFAULT_MAX_SESSIONS} for this target; `
    + (passes ? `capturing ${passes.map(pass => pass.join("+")).join(" and ")} in separate sessions` : "one session"));
  phases.enter("capture");
  const result = await captureSideInSessions(baselineOptions, passes, progress, options.signal, passes !== undefined);
  phases.enter("report");
  const cacheRecipe = await recipe(options.config, plan, "head", environment, exploration.instructionsSha256);
  if (options.subscription) cacheRecipe.toolsCommit += ":local-subscription";
  const bundle = await readCaptureBundle(directory); bundle.profile = cacheRecipe.profile;
  await writeFile(join(directory, "bundle.json"), JSON.stringify(bundle));
  const cached = await writeCaptureArtifactCache(directory, cacheRecipe);
  assertCheckout(options.project, options.sha);
  // Same bar as a PR run: untrustworthy evidence fails the baseline, unreachable screens do not. The cache holds no
  // image for them, so a PR run that reuses this baseline captures those routes itself.
  const health = partitionCaptureHealthIssues(sortedCaptureHealthIssues([{ bundle, selectedIds: plan.headCaptureSurfaceIds, side: "head" }]));
  assertNoCaptureHealthIssues(health.integrity);
  for (const issue of health.unavailable) progress(renderCaptureIssueAnnotation(issue));
  if (health.unavailable.length) progress(`${health.unavailable.length} ${health.unavailable.length === 1 ? "screen is" : "screens are"} unavailable in this baseline; a review reusing it captures ${health.unavailable.length === 1 ? "that screen" : "those screens"} itself`);
  return { directory, cached, captured: Object.keys(bundle.images).length, unavailable: health.unavailable.length, result };
}
