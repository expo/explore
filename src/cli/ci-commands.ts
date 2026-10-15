import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { runPublicCi, runBaselineCi, runCompareCi } from "../ci/pipeline.js";
import { exportCiReport, publishCiReportComment } from "../report/artifact.js";
import { collectPlatformReports, deployPreview } from "../report/preview-deploy.js";
import { publishFailureComment } from "../report/failure-comment.js";
import { runExploreSetup } from "../config/setup.js";
import { installCiFiles } from "../ci/workflow-install.js";
import { readRouteEntry } from "../ci/route-entry.js";
import { buildVerifiedPlan } from "../ci/verified-plan.js";
import { formatCaptureCheck, formatDoctorReport, referencedSecretNames, runCaptureCheck, runDoctor } from "../ci/doctor.js";
import { readExploreConfig, readExploreInstructions, resolvePlatformConfig, withRunOverrides, configPlatforms as listPlatforms, EXPLORE_PLATFORMS, DEFAULT_EXPLORE_CONFIG_PATH, type ExplorePlatform } from "../config/explore-config.js";
import { argumentError, output, required, has, flag, flags, oneOf } from "./args.js";
import { help } from "./help.js";
import { CiError } from "../shared/ci-errors.js";
import { cleanupAfterCapture, findBaselineArtifact, resolveCompareRefs, resolvePullRequest, writeCaptureOutputs, writeStepOutputs } from "../ci/workflow-steps.js";
import { stderrProgress } from "../shared/progress.js";

export async function doctor(): Promise<void> {
  if (has("help")) return help();
  const project = flag("project") ?? process.cwd();
  const report = await runDoctor({ project, online: !has("offline"), github: !has("no-github") && !has("offline"),
    checkModel: has("check-model") });
  if (!has("capture")) {
    if (has("json")) output({ ...report });
    else console.log(formatDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  // CI files and repository settings do not affect a local capture; everything before them does.
  const blocking = report.checks.filter(check => check.status === "fail" && check.step !== 6 && check.step !== 7);
  if (blocking.length) {
    if (has("json")) output({ ...report, capture: null });
    else console.log(`${formatDoctorReport(report)}

Fix the problems in steps 1–5 before a capture check.`);
    process.exitCode = 1;
    return;
  }
  if (!has("yes")) {
    if (!process.stdin.isTTY || has("json")) argumentError("A capture check starts an EAS build and simulator session; pass --yes to confirm.", "yes");
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await terminal.question(`This builds the app on EAS and runs an EAS Simulator session (EAS usage applies${report.mode === "agent" ? "; agent mode also uses your model API key" : ""}). Continue? (yes/no) `);
    terminal.close();
    if (!/^(y|yes)$/i.test(answer.trim())) return;
  }
  let result: Awaited<ReturnType<typeof runCaptureCheck>>;
  try {
    const platform = platformFlag();
    result = await runCaptureCheck({ project, ...(platform ? { platform } : {}), output: resolve(flag("output") ?? await mkdtemp(join(tmpdir(), "expo-explore-capture-"))), progress: stderrProgress() });
  } catch (error) {
    // A refusal before any EAS work: show it with its next action next to the static report.
    if (!(error instanceof CiError)) throw error;
    if (has("json")) output({ ...report, capture: { ok: false, failure: { code: error.code, message: error.message, nextAction: error.nextAction } } });
    else console.log(`${formatDoctorReport(report)}\n\nCapture check not started: ${error.message} [${error.code}]\n  → ${error.nextAction}`);
    process.exitCode = 1;
    return;
  }
  if (has("json")) output({ ...report, capture: result });
  else console.log(`${formatDoctorReport(report)}\n\n${formatCaptureCheck(result)}`);
  if (!result.ok) process.exitCode = 1;
}

export async function ciReport(): Promise<void> {
  output({ ok: true, ...await exportCiReport({ inputPath: required("input"), outputPath: required("output") }) });
}

/** Deploy the packaged review as a token-gated EAS Hosting preview and link it from the PR comment as Explore report. */
export async function ciDeploy(): Promise<void> {
  const onSecret = (secret: string) => { if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${secret}`); };
  // Matrix workflows fan several platforms' artifacts into one deployment; the single-platform flags predate them.
  const result = has("inputs") || has("reports")
    ? await deployPreview({ reports: await collectPlatformReports({ inputsPath: required("inputs"), reportsPath: required("reports") }), onSecret })
    : await deployPreview({ inputPath: required("input"), reportPath: required("report"), artifactUrl: required("artifact-url"), onSecret });
  // A comparison's token is not masked (see deployPreview), so its link stays out of the log.
  const { previewUrl, ...unlinked } = result;
  output({ ok: true, ...(result.linkedFromRunSummary ? unlinked : { previewUrl, ...unlinked }) });
}

export async function ciPublish(): Promise<void> {
  const platform = platformFlag();
  output({ ok: true, ...await publishCiReportComment({ inputPath: required("input"), artifactUrl: required("artifact-url"), ...(platform ? { platform } : {}) }) });
}

/** The failure job's comment for a job that died before Explore could post its own: `ci:failure --pr N --head SHA --base SHA [--diagnostics DIR] [--platform P]`. */
export async function ciFailure(): Promise<void> {
  const platform = platformFlag();
  const repository = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID, runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!repository || !runId || !runAttempt) throw new CiError({ code: "CONFIG_MISSING", stage: "preflight", message: "GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required",
    nextAction: "Run ci:failure inside the GitHub Actions failure job." });
  const pullNumber = Number(required("pr"));
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) { output({ ok: true, posted: false, reason: "No PR number: the capture job never started." }); return; }
  output({ ok: true, ...await publishFailureComment({ repository, pullNumber, headSha: required("head"), baseSha: required("base"), runId, runAttempt,
    ...(has("diagnostics") ? { diagnosticsPath: required("diagnostics") } : {}), ...(platform ? { platform } : {}) }) });
}

/** `ci:pr --pr N [--output FILE]`: the live, authorized pull request; its commits go to the step outputs. */
export async function ciPullRequest(): Promise<void> {
  const { presentation, author } = await resolvePullRequest({ number: Number(required("pr")),
    ...(has("app-dir") ? { appDirectory: required("app-dir") } : {}), ...(has("config") ? { configPath: required("config") } : {}) });
  if (has("output")) await writeFile(required("output"), JSON.stringify(presentation));
  await writeStepOutputs(process.env, { pr_number: String(presentation.number), base: presentation.base.sha, head: presentation.head.sha });
  output({ ok: true, pullRequest: presentation, author });
}

/** `ci:find-baseline --sha SHA [--platform P]`: a reusable baseline artifact of the base commit, if one exists. */
export async function ciFindBaseline(): Promise<void> {
  const platform = platformFlag();
  const found = await findBaselineArtifact({ sha: required("sha"), ...(platform ? { platform } : {}) });
  if (found) await writeStepOutputs(process.env, { id: String(found.id), run: String(found.run) });
  output({ ok: true, baseline: found ?? null });
}

/** `ci:compare-refs --project DIR --base REF --head REF [--output FILE]`: the two commits a comparison captures. */
export async function ciCompareRefs(): Promise<void> {
  const comparison = resolveCompareRefs({ project: required("project"), base: required("base"), head: required("head"),
    ...(has("title") ? { title: required("title") } : {}) });
  if (has("output")) await writeFile(required("output"), JSON.stringify(comparison));
  await writeStepOutputs(process.env, { base: comparison.base.sha, head: comparison.head.sha, compare: JSON.stringify(comparison) });
  output({ ok: true, comparison });
}

/** `ci:after-capture --output DIR --checkout DIR...`: stop recorded sessions and check the checkouts are untouched; fails after reporting every problem. */
export async function ciAfterCapture(): Promise<void> {
  const result = await cleanupAfterCapture({ output: required("output"), checkouts: flags("checkout") });
  for (const failure of result.failures) console.error(`::error title=${failure.code}::${failure.message} ${failure.nextAction}`);
  output({ ok: result.failures.length === 0, ...result });
  if (result.failures.length) process.exitCode = 1;
}

/** The `--platform` flag, when given; capture then reads that platform's fields from config.yaml. */
export function platformFlag(): ExplorePlatform | undefined {
  return has("platform") ? oneOf("platform", EXPLORE_PLATFORMS) : undefined;
}

/** The platforms config.yaml captures, for the review workflow's matrix. */
export async function configPlatforms(): Promise<void> {
  const config = await readExploreConfig(flag("project") ?? process.cwd(), flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH);
  output({ ok: true, platforms: listPlatforms(config) });
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

export async function setup(): Promise<void> {
  if (has("help")) return help();
  const project = flag("project") ?? process.cwd();
  if (has("workflows") && !has("check") && await exists(join(project, DEFAULT_EXPLORE_CONFIG_PATH))) {
    // An existing config: only add or update the CI files, forwarding every app-test secret it references.
    const config = await readExploreConfig(project);
    const instructions = await readExploreInstructions(project, config);
    const result = await installCiFiles(project, referencedSecretNames(config, instructions?.text), { force: has("force") });
    if (has("json")) output({ ok: true, workflows: result });
    else {
      for (const file of result.written) console.log(`Wrote ${file}`);
      for (const file of result.kept) console.log(`Kept ${file}`);
      for (const note of result.notes) console.log(`Note: ${note}`);
      console.log("Commit these files and merge them into the default branch, then run expo-explore doctor.");
    }
    return;
  }
  const result = await runExploreSetup({
    project, device: flag("device"), scope: flag("scope"), profile: flag("profile"),
    bundleId: flag("bundle-id"), platform: flag("platform"), scheme: flag("scheme"), navigation: flag("navigation"),
    mode: flag("mode"), provider: flag("provider"), model: flag("model"), params: flags("param"), appState: flag("app-state"),
    workflows: has("workflows") ? true : has("no-workflows") ? false : undefined,
    nonInteractive: has("non-interactive") || has("json"), check: has("check"),
  }, undefined, { analyzeRoutes: readRouteEntry, installWorkflows: installCiFiles });
  if (has("json")) output({ ok: true, ...result });
  else if (!result.created) console.log(`Validated ${result.path}. Run expo-explore doctor to check the whole setup.`);
  else if (has("non-interactive")) {
    console.log(`Created ${result.path}`);
    if (result.workflows) {
      for (const file of result.workflows.written) console.log(`Wrote ${file}`);
      for (const file of result.workflows.kept) console.log(`Kept ${file}`);
      for (const note of result.workflows.notes) console.log(`Note: ${note}`);
    }
    for (const [index, step] of (result.nextSteps ?? []).entries()) console.log(`${index + 1}. ${step}`);
  }
}

export async function sourceVerify(): Promise<void> {
  const headProject = required("head-project");
  const config = resolvePlatformConfig(await readExploreConfig(headProject, flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH), platformFlag());
  const scope = oneOf("scope", ["all", "changes"] as const, config.exploration.scope);
  const plan = await buildVerifiedPlan({ baseProject: required("base-project"), headProject,
    baseSha: required("base-sha"), headSha: required("head-sha"), config, scope, output: required("output") });
  output({ ok: true, deterministic: true, routes: plan.inventorySurfaceIds.length });
}

export async function captureReview(): Promise<void> {
  const headProject = required("head-project");
  const configPath = flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH;
  const platform = platformFlag();
  const rawConfig = await readExploreConfig(headProject, configPath);
  const config = withRunOverrides(resolvePlatformConfig(rawConfig, platform), { scope: flag("scope"), expiresIn: flag("expires-in") });
  if (has("pull-request") === has("compare")) argumentError("Pass --pull-request FILE for a pull request, or --compare FILE for any two commits.", has("compare") ? "compare" : "pull-request");
  const common = { ...(platform ? { platform } : {}), platforms: listPlatforms(rawConfig), baseProject: required("base-project"), headProject,
    output: required("output"), config, configPath, progress: stderrProgress() };
  const result = has("compare") ? await runCompareCi({ ...common, comparePath: required("compare") })
    : await runPublicCi({ ...common, pullRequestPath: required("pull-request") });
  // The deploy job runs only when the reviewed config asks for a hosted report.
  await writeCaptureOutputs(result.inputPath);
  output({ ok: true, inputPath: result.inputPath });
}

export async function captureBaseline(): Promise<void> {
  const project = required("project");
  const platform = platformFlag();
  const config = resolvePlatformConfig(await readExploreConfig(project, flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH), platform);
  output({ ok: true, ...await runBaselineCi({ ...(platform ? { platform } : {}), project, sha: required("sha"), output: required("output"), config, progress: stderrProgress() }) });
}
