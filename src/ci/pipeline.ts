import type { RunTarget } from "../types.js";
import { spawnSync } from "node:child_process";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildVerifiedPlan } from "./verified-plan.js";
import { runCiMap, type CommandRunner } from "../capture/run.js";
import { routeIdOfScreen } from "../capture/appearance.js";
import { prepareCaptureReview, readCaptureBundle } from "../review/capture-review.js";
import { quarantineReviewContract } from "../contracts/review-validation.js";
import { agentCaptureConstraints } from "../capture/agent/source-context.js";
import { captureArtifactCacheMayMatch, captureRecipeConfig, restoreCaptureArtifactCache, writeCaptureArtifactCache } from "./artifact-cache.js";
import { runCiMapOnWorker } from "./capture-worker.js";
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
import { CiError, serializeCiError, toCiError } from "../shared/ci-errors.js";
import type { SourceCapturePlan } from "../source/capture-plan.js";
import { createSourceChangeSummaries } from "../source/change-summary.js";
import { assertNoCaptureHealthIssues, partitionCaptureHealthIssues, renderCaptureIssueAnnotation, renderComparisonDiagnosticAnnotation, renderNotesUnavailableAnnotation, renderReviewGapAnnotation, sortedCaptureHealthIssues } from "../capture/health.js";
import { EXPLORE_PACKAGE, packageBin } from "../shared/package-paths.js";
import { agentDeviceLauncher, ensureArgentToolServer, ensureController } from "../shared/controller-cache.js";
import { silentProgress, type Progress } from "../shared/progress.js";


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

function captureOptions(config: ExploreConfig, environment: NodeJS.ProcessEnv, runner?: CommandRunner, clock: CaptureClock = {}) {
  return { ...(runner && clock.now ? { now: clock.now } : {}), ...(runner && clock.sleep ? { sleep: clock.sleep } : {}), platform: config.app.platform, bundleId: config.app.bundleId,
    ...(config.app.scheme ? { scheme: config.app.scheme } : {}), device: config.device.name, ...(config.device.pose ? { devicePose: config.device.pose } : {}),
    easProfile: config.app.easProfile, expoToken: environment.EXPO_TOKEN ?? "",
    maxScreens: 5000, maxActions: config.capture.maxActions, maxDurationMinutes: config.capture.maxMinutes,
    setup: config.setup ?? [], forceFreshBuild: false, confirmExternalRun: true, confirmTrustedSource: true, repack: captureRepack(config), appearance: config.capture.appearance, launch: config.capture.launch, reset: config.capture.reset, unattributed: config.capture.unattributed, ...(config.capture.readinessSeconds !== undefined ? { readinessSeconds: config.capture.readinessSeconds } : {}), ...(config.capture.controller ? { controller: config.capture.controller } : {}),
    ...(config.capture.simulator ? { simulator: config.capture.simulator } : {}),
    ...(config.flows ? { flows: { tests: config.flows.tests, only: config.mode === "flows", ...(config.agent ? { agent: { provider: config.agent.provider, model: config.agent.model } } : {}) } } : {}),
    environment, ...(runner ? { runner } : {}), easCommand: packageBin("eas-cli", "eas"), agentDeviceCommand: agentDeviceLauncher(environment), repackCommand: packageBin("@expo/repack-app", "repack-app") };
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
  baseProject: string; headProject: string; pullRequestPath: string; output: string;
  config: ExploreConfig; configPath?: string; environment?: NodeJS.ProcessEnv; transport?: typeof fetch;
  now?: () => number; sleep?: (milliseconds: number) => void; onComment?: (state: PublicCommentState, body: string) => void;
  runner?: CommandRunner;
  /** Internal dependency injection; configuration cannot replace the authenticated CLI session. */
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"];
  progress?: Progress;
};

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
    ...(config.target ? { target: config.target } : {}), ...(options.targets && options.targets.length > 1 ? { targets: options.targets } : {}) };
  return { projects, output, state };
}

/** A review of any two commits (`capture:review --compare FILE`): the same capture as a PR's, with no PR to verify or comment on. */
export async function runCompareCi(options: Omit<PublicCiOptions, "pullRequestPath" | "transport" | "onComment"> & { comparePath: string }) {
  const environment = options.environment ?? process.env;
  assertRunIdentity(environment);
  const comparison = projectComparePresentation(JSON.parse(await readFile(options.comparePath, "utf8")));
  const { projects, output, state } = await prepareCiRun(options, environment, comparison);
  const assertCurrentHead = async () => { for (const side of ["base", "head"] as const) assertCheckout(projects[side], comparison[side].sha); };
  return runCiReview({ ...options, projects, output, state, presentation: comparison,
    environment, runId: environment.GITHUB_RUN_ID!, runAttempt: environment.GITHUB_RUN_ATTEMPT!,
    assertCurrentHead, postComment: async () => {} });
}

export async function runPublicCi(options: PublicCiOptions) {
  const environment = options.environment ?? process.env;
  const transport = options.transport ?? fetch;
  const now = options.now ?? Date.now;
  const githubToken = requireSecret(environment, "GITHUB_TOKEN");
  assertRunIdentity(environment);
  const pr = projectPullRequestPresentation(JSON.parse(await readFile(options.pullRequestPath, "utf8")));
  const { projects, output, state } = await prepareCiRun(options, environment, pr);
  const postComment = async () => {
    await assertCurrentPr();
    state.updatedAt = now(); const body = renderPublicComment(state); options.onComment?.(state, body);
    try { await upsertStickyComment({ repository: pr.repository, issueNumber: pr.number, body, ...platformSectionMerge(state, options.target ?? options.platform), token: githubToken, fetchImpl: transport }); }
    catch (error) { process.stderr.write(`Progress comment unavailable: ${serializeCiError(error).message}\n`); }
  };
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
  return runCiReview({ ...options, projects, output, state, presentation: pr,
    environment, runId: environment.GITHUB_RUN_ID!, runAttempt: environment.GITHUB_RUN_ATTEMPT!,
    assertCurrentHead, postComment, canPublish: () => !prVerificationFailed });
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
  /** A folder shared with the other targets' reviews, so the targets of one platform build each commit once. */
  buildShare?: string;
  measure?: Parameters<typeof assessPublicEvidence>[0]["measure"];
  state: PublicCommentState; environment: NodeJS.ProcessEnv;
  assertCurrentHead: () => Promise<void>; postComment: () => Promise<void>; canPublish?: () => boolean;
  now?: () => number; sleep?: (milliseconds: number) => void; runner?: CommandRunner; subscription?: boolean; useLocalEasSession?: boolean;
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"];
  prepareCapture?: () => Promise<void>;
  progress?: Progress;
  /** Stops the captures between steps; model requests take it through agentSessionFactory. */
  signal?: AbortSignal;
}) {
  const { projects, output, config, environment, state, assertCurrentHead, postComment } = options;
  const progress = options.progress ?? silentProgress;
  // The controllers are fetched before any EAS work, so a blocked download fails before a session is paid for. agent-device
  // also compares the screenshots. An injected runner (tests) runs no real controller.
  if (!options.runner) await prefetchControllers(config, environment, progress);
  const pr = options.presentation;
  const now = options.now ?? Date.now;
  const secretValues = Object.entries(environment).filter(([key]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)).flatMap(([, value]) => value ? [value] : []);
  let stage = "plan";
  let usagePhase: AgentUsagePhase = "preflight";
  let preserveReport: (() => Promise<void>) | undefined;
  let reportWritten = false;
  try {
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
    stage = "preflight";
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
    const concurrent = captureSidesConcurrently({ plan, agent: !!exploration.agent, injectedRunner: !!options.runner, baselineMayExist });
    const captureSide = async (side: "head" | "base") => {
      const directory = join(output, `${side}-export`);
      const selectedIds = plan[`${side}CaptureSurfaceIds`];
      const cacheRecipe = cacheRecipes[side];
      let reuseDirectory: string | undefined;
      if (side === "base" && selectedIds.length && runtimeProfile && environment.EXPLORE_CAPTURE_CACHE) {
        const restored = await restoreCaptureArtifactCache({ ...cacheRecipe, sourceDirectory: environment.EXPLORE_CAPTURE_CACHE,
          commit: pr.base.sha, selectedIds, directory: join(output, "base-cache"), runtimeProfile,
          ...(exploration.agent ? { captureContexts: exploration.agent.contexts } : {}) });
        if (restored) reuseDirectory = join(output, "base-cache");
        progress(restored ? `base: found the baseline captures of ${pr.base.sha.slice(0, 8)}` : `base: no compatible baseline of ${pr.base.sha.slice(0, 8)}; capturing the base too`);
      }
      const mapOptions = { ...captureOptions(config, environment, options.runner, { now: options.now, sleep: options.sleep }), progress,
        ...(options.useLocalEasSession ? { useLocalEasSession: true } : {}),
        ...(exploration.agent ? { agent: exploration.agent } : {}), project: projects[side],
        mapDirectory: join(output, `${side}-map`), outputDirectory: directory,
        name: config.app.name ?? pr.repository, buildId: pr.origin === "local" ? `local-${pr.runId}-${side}` : pr.origin === "compare" ? `compare-${options.runId}-${side}` : `pr-${pr.number}-${side}`, buildVersion: pr[side].sha.slice(0, 8), gitCommit: pr[side].sha,
        planPath: join(output, "execution-plan.json"), side, sessionStatePath: join(output, `${side}-session`), ...(options.buildShare ? { buildShare: options.buildShare } : {}),
        ...(reuseDirectory ? { reuseDirectory } : {}), ...(options.signal ? { signal: options.signal } : {}) };
      const captured = concurrent
        ? await runCiMapOnWorker((({ progress: _progress, runner: _runner, agent: _agent, signal: _signal, ...rest }) => rest)(mapOptions), progress, options.signal)
        : await runCiMap(mapOptions);
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
    if (concurrent) {
      stage = "capture-head"; state.phase = "capturing"; state.capture.current = "head"; usagePhase = "capture-head";
      progress("capturing head and base at the same time in two simulator sessions");
      await postComment();
      // Let both sides finish or fail on their own so every started session is stopped by its owner.
      const settled = await Promise.allSettled([captureSide("head"), captureSide("base")]);
      for (const [index, outcome] of settled.entries()) {
        if (outcome.status === "rejected") { stage = index === 0 ? "capture-head" : "capture-base"; throw outcome.reason; }
      }
    } else {
      for (const side of ["head", "base"] as const) {
        stage = `capture-${side}`; state.phase = "capturing"; state.capture.current = side;
        usagePhase = `capture-${side}`;
        await postComment();
        await captureSide(side);
      }
    }
    delete state.capture.current;
    stage = "compare";
    progress("comparing base and head captures");
    const sides = { base: await evidenceSide(join(output, "base-export")), head: await evidenceSide(join(output, "head-export")) };
    const evidence = await assessPublicEvidence({ platform: config.app.platform, plan, ...sides, ...(options.measure ? { measure: options.measure } : {}), profile: `${config.app.easProfile}:${config.app.bundleId}`, agentDeviceCommand: agentDeviceLauncher(options.environment) });
    const result = await prepareCaptureReview({ plan, pullRequest: pr, baseDirectory: sides.base.directory, headDirectory: sides.head.directory,
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
      stage = "notes";
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
    await preserveReport();
    progress(pr.origin === "compare" || pr.origin === "local" ? "writing the report" : "writing the report and updating the pull request comment");
    await assertCurrentHead(); await postComment();
    return { ...result, evidence, inputPath };
  } catch (error) {
    state.phase = "failed"; const diagnostic = serializeCiError(error, { secrets: secretValues });
    state.failure = { step: stage, message: `${diagnostic.code}: ${diagnostic.message} ${diagnostic.nextAction}` };
    try { await preserveReport?.(); } catch { /* Retain the original failure if its report cannot be written. */ }
    // An exhausted verification already established that publication is unavailable; do not repeat its attempts.
    if (options.canPublish?.() !== false) {
      try { await postComment(); } catch { /* A stale PR or inaccessible GitHub must not replace the original failure. */ }
    }
    throw error;
  }
}

export async function runBaselineCi(options: { platform?: ExplorePlatform; project: string; sha: string; output: string; config: ExploreConfig; environment?: NodeJS.ProcessEnv; runner?: CommandRunner;
  now?: () => number; sleep?: (milliseconds: number) => void;
  agentSessionFactory?: PrepareCiExplorationOptions["createSession"]; progress?: Progress;
  /** Use the local `eas login` session instead of EXPO_TOKEN (expo-explore doctor --capture). */
  useLocalEasSession?: boolean;
  /** Agent mode with the local claude or codex login instead of the provider's API key. */
  subscription?: boolean }) {
  const environment = options.environment ?? process.env;
  assertCheckout(options.project, options.sha);
  if (!options.runner) await prefetchControllers(options.config, environment, options.progress ?? silentProgress);
  const output = resolve(options.output);
  const relativeOutput = relative(await realpath(options.project), output);
  if (!relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) throw new Error("Baseline output must be outside the source checkout");
  const progress = options.progress ?? silentProgress;
  progress(`planning the baseline of ${options.sha.slice(0, 8)}`);
  const plan = await buildVerifiedPlan({ baseProject: options.project, headProject: options.project,
    baseSha: options.sha, headSha: options.sha, config: options.config, output, scope: "all" });
  progress(planSummary(plan, true));
  const active = plan.headCaptureSurfaceIds.length > 0;
  if (active && !options.useLocalEasSession) requireSecret(environment, "EXPO_TOKEN");
  let usagePhase: AgentUsagePhase = "preflight";
  const exploration = await prepareCiExploration(options.config, options.project, environment, active,
    { ...(options.agentSessionFactory ? { createSession: options.agentSessionFactory } : {}),
      onUsage: recordAgentUsage(output, () => usagePhase), ...(options.subscription ? { subscription: true } : {}) });
  const directory = join(output, "baseline-export");
  usagePhase = "capture-baseline";
  const result = await runCiMap({ ...captureOptions(options.config, environment, options.runner, { now: options.now, sleep: options.sleep }), progress,
    ...(options.useLocalEasSession ? { useLocalEasSession: true } : {}),
    ...(exploration.agent ? { agent: exploration.agent } : {}), project: options.project,
    mapDirectory: join(output, "baseline-map"), outputDirectory: directory, name: options.config.app.name ?? options.config.app.bundleId,
    buildId: `baseline-${options.sha.slice(0, 12)}`, buildVersion: options.sha.slice(0, 8), gitCommit: options.sha,
    side: "head", planPath: join(output, "execution-plan.json"), sessionStatePath: join(output, "baseline-session") });
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
