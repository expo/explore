import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitSubject, keepReports } from "./report-commands.js";
import { createInterface } from "node:readline/promises";
import { runPublicCi, runBaselineCi, runCompareCi } from "../ci/pipeline.js";
import { exportCiReport, publishCiReportComment } from "../report/artifact.js";
import { collectPlatformReports, deployLocalReports, deployPreview, previewProjectSlug } from "../report/preview-deploy.js";
import { startLocalReportServer } from "../report/local-report-server.js";
import { openViewerInBrowser } from "../map/viewer-server.js";
import { runLocalReview } from "../ci/local-review.js";
import { publishFailureComment } from "../report/failure-comment.js";
import { runExploreSetup } from "../config/setup.js";
import { installCiFiles } from "../ci/workflow-install.js";
import { readRouteEntry } from "../ci/route-entry.js";
import { buildVerifiedPlan } from "../ci/verified-plan.js";
import { formatCaptureCheck, formatDoctorReport, referencedSecretNames, runCaptureCheck, runDoctor } from "../ci/doctor.js";
import { readExploreConfig, readExploreInstructions, resolveTargetConfig, configTargets, isTargetId, withRunOverrides, previewDays, configPlatforms as listPlatforms, EXPLORE_PLATFORMS, DEFAULT_EXPLORE_CONFIG_PATH, PREVIEW_DEFAULT_DAYS, type ExplorePlatform } from "../config/explore-config.js";
import { argumentError, output, required, has, flag, flags, nonNegativeInteger, oneOf, positiveInteger } from "./args.js";
import { help } from "./help.js";
import { CiError } from "../shared/ci-errors.js";
import { cleanupAfterCapture, findOptionalBaseline, resolveCompareRefs, resolvePullRequest, writeCaptureOutputs, writeStepOutputs } from "../ci/workflow-steps.js";
import { stderrProgress } from "../shared/progress.js";

export async function doctor(): Promise<void> {
  if (has("help")) return help();
  const project = flag("project") ?? process.cwd();
  const report = await runDoctor({ project, online: !has("offline"), github: !has("no-github") && !has("offline"),
    checkModel: has("check-model"), controller: flag("controller"), simulator: flag("simulator"), repack: flag("repack") });
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
    const answer = await terminal.question(`This builds the app on EAS and runs an EAS Simulator session (EAS usage applies${report.mode === "agent" ? "; agent mode also uses your model API key or local claude/codex login" : ""}). Continue? (yes/no) `);
    terminal.close();
    if (!/^(y|yes)$/i.test(answer.trim())) return;
  }
  let result: Awaited<ReturnType<typeof runCaptureCheck>>;
  try {
    const platform = platformFlag();
    result = await runCaptureCheck({ project, ...(platform ? { platform } : {}), target: targetFlag(), controller: flag("controller"), simulator: flag("simulator"), repack: flag("repack"), output: resolve(flag("output") ?? await mkdtemp(join(tmpdir(), "expo-explore-capture-"))), progress: stderrProgress() });
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
  const platform = platformFlag(), target = targetFlag();
  output({ ok: true, ...await publishCiReportComment({ inputPath: required("input"), artifactUrl: required("artifact-url"), ...(platform ? { platform } : {}), ...(target ? { target } : {}) }) });
}

/** The failure job's comment for a job that died before Explore could post its own: `ci:failure --pr N --head SHA --base SHA [--diagnostics DIR] [--platform P]`. */
export async function ciFailure(): Promise<void> {
  const platform = platformFlag(), target = targetFlag();
  const repository = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID, runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!repository || !runId || !runAttempt) throw new CiError({ code: "CONFIG_MISSING", stage: "preflight", message: "GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required",
    nextAction: "Run ci:failure inside the GitHub Actions failure job." });
  const pullNumber = Number(required("pr"));
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) { output({ ok: true, posted: false, reason: "No PR number: the capture job never started." }); return; }
  output({ ok: true, ...await publishFailureComment({ repository, pullNumber, headSha: required("head"), baseSha: required("base"), runId, runAttempt,
    ...(has("diagnostics") ? { diagnosticsPath: required("diagnostics") } : {}), ...(platform ? { platform } : {}), ...(target ? { target } : {}) }) });
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
  const platform = platformFlag(), target = targetFlag();
  const { baseline, warning } = await findOptionalBaseline({ sha: required("sha"), ...(platform ? { platform } : {}), ...(target ? { target } : {}) });
  if (baseline) await writeStepOutputs(process.env, { id: String(baseline.id), run: String(baseline.run) });
  if (warning && process.env.GITHUB_ACTIONS) console.log(`::warning title=${warning.code}::${warning.message.replace(/[\r\n]+/g, " ")}`);
  output({ ok: true, baseline: baseline ?? null, ...(warning ? { warning } : {}) });
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

/** The `--target` flag, when given: the config.yaml target to capture. */
export function targetFlag(): string | undefined {
  const value = flag("target");
  if (value !== undefined && !isTargetId(value)) argumentError("--target must be a target id from config.yaml: lowercase letters, digits and dashes.", "target");
  return value;
}

/** The target `--target` (or `--platform`, from workflows installed before targets) selects. */
function targetSelection(): { target?: string; platform?: ExplorePlatform } {
  const target = targetFlag(), platform = platformFlag();
  return { ...(target ? { target } : {}), ...(platform ? { platform } : {}) };
}

/** The targets config.yaml captures, as ids (the review workflow's matrix); workflows installed before targets read them as platforms. */
export async function configPlatforms(): Promise<void> {
  const config = await readExploreConfig(flag("project") ?? process.cwd(), flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH);
  output({ ok: true, platforms: configTargets(config).map(target => target.id) });
}

/** The targets config.yaml captures, in order, with their platforms and labels: the review workflow's matrix. */
export async function configTargetList(): Promise<void> {
  const config = await readExploreConfig(flag("project") ?? process.cwd(), flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH);
  output({ ok: true, targets: configTargets(config) });
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
  const config = resolveTargetConfig(await readExploreConfig(headProject, flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH), targetSelection());
  const scope = oneOf("scope", ["all", "changes"] as const, config.exploration.scope);
  const plan = await buildVerifiedPlan({ baseProject: required("base-project"), headProject,
    baseSha: required("base-sha"), headSha: required("head-sha"), config, scope, output: required("output") });
  output({ ok: true, deterministic: true, routes: plan.inventorySurfaceIds.length });
}

export async function captureReview(): Promise<void> {
  // Refs without the CI flags: a review on this machine, with your own logins (see runLocalReview).
  if (!has("base-project") && !has("head-project") && !has("pull-request") && !has("compare")) return localReview();
  const headProject = required("head-project");
  const configPath = flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH;
  const selection = targetSelection();
  const rawConfig = await readExploreConfig(headProject, configPath);
  const config = withRunOverrides(resolveTargetConfig(rawConfig, selection), { scope: flag("scope"), expiresIn: flag("expires-in"), controller: flag("controller"), simulator: flag("simulator"), repack: flag("repack") });
  if (has("pull-request") === has("compare")) argumentError("Pass --pull-request FILE for a pull request, or --compare FILE for any two commits.", has("compare") ? "compare" : "pull-request");
  // A matrix job names its target; its artifacts, report and comment section carry the target's id.
  const named = selection.target !== undefined || selection.platform !== undefined;
  const common = { ...(named ? { target: config.target!.id } : {}), ...(selection.platform ? { platform: selection.platform } : {}),
    platforms: listPlatforms(rawConfig), targets: configTargets(rawConfig), baseProject: required("base-project"), headProject,
    output: required("output"), config, configPath, progress: stderrProgress() };
  const result = has("compare") ? await runCompareCi({ ...common, comparePath: required("compare") })
    : await runPublicCi({ ...common, pullRequestPath: required("pull-request") });
  // The deploy job runs only when the reviewed config asks for a hosted report.
  await writeCaptureOutputs(result.inputPath);
  output({ ok: true, inputPath: result.inputPath });
}

export async function captureBaseline(): Promise<void> {
  const project = required("project");
  const config = withRunOverrides(resolveTargetConfig(await readExploreConfig(project, flag("config") ?? DEFAULT_EXPLORE_CONFIG_PATH), targetSelection()), { controller: flag("controller"), simulator: flag("simulator"), repack: flag("repack") });
  output({ ok: true, ...await runBaselineCi({ platform: config.app.platform, project, sha: required("sha"), output: required("output"), config, progress: stderrProgress() }) });
}

/** `capture` (or `capture:review`) `[--base REF] [--head REF | --committed]`: a local review, opened in the Viewer or hosted with --upload. */
async function localReview(): Promise<void> {
  const platform = platformFlag(), target = targetFlag();
  const parallel = has("parallel") ? positiveInteger("parallel") : undefined;
  const result = await runLocalReview({ project: flag("project") ?? process.cwd(), base: flag("base"), head: flag("head"), ...(target ? { target } : {}),
    ...(parallel ? { parallel } : {}),
    // --include-untracked is accepted from before untracked files were included by default.
    committed: has("committed"), uncommitted: has("uncommitted"), ...(platform ? { platform } : {}),
    scope: flag("scope"), expiresIn: flag("expires-in"), controller: flag("controller"), simulator: flag("simulator"), repack: flag("repack"), cache: !has("no-cache"), configPath: flag("config"), progress: stderrProgress() });
  if (has("output")) {
    for (const report of result.reports) {
      const destination = resolve(required("output"), report.target.id);
      await cp(report.directory, join(destination, "report"), { recursive: true });
      await cp(report.zip, join(destination, "report.zip"));
      report.directory = join(destination, "report"); report.zip = join(destination, "report.zip");
    }
    // The reports now live under --output; the temporary copies are not needed.
    await rm(result.work, { recursive: true, force: true });
  }
  // A target that failed outright has no report; the others still open, save and upload, and the command exits 1.
  if (result.failures.length) process.exitCode = 1;
  const summary = { ok: result.failures.length === 0, runId: result.runId, base: result.base, head: result.head,
    ...(result.failures.length ? { failures: result.failures.map(({ target, error }) => ({ target: target.id, code: error.code, message: error.message })) } : {}),
    reports: result.reports.map(({ platform, target, directory, zip, changes, device }) => ({ platform, target: target.id, label: target.label, directory, zip,
      ...(changes === undefined ? {} : { changes }), ...(device ? { device } : {}) })) };
  const zips = await Promise.all(result.reports.map(async report => ({ platform: report.platform, target: report.target, zip: new Uint8Array(await readFile(report.zip)),
    ...(report.changes === undefined ? {} : { changes: report.changes }), ...(report.device ? { device: report.device } : {}) })));
  // Kept among the saved runs, with the commits' subjects (an uncommitted head is named by the commit under it).
  const project = resolve(flag("project") ?? process.cwd());
  const headSubject = commitSubject(project, result.head.uncommitted ? `${result.head.sha}^` : result.head.sha), baseSubject = commitSubject(project, result.base.sha);
  const saved = await keepReports(zips.map(({ platform, target, zip }) => ({ platform, target, zip })), { subjects: { ...(headSubject ? { head: headSubject } : {}), ...(baseSubject ? { base: baseSubject } : {}) },
    ...(result.head.uncommitted?.length ? { uncommittedFiles: result.head.uncommitted.length } : {}) });
  if (has("upload")) {
    const preview = result.config.report?.preview;
    const hosted = await deployLocalReports({ reports: zips, project: previewProjectSlug(result.repository, preview?.project), ...(preview?.owner ? { owner: preview.owner } : {}),
      // null is expiresAfter: never, which must not fall back to the default.
      expiresAfterDays: has("expires-in") ? previewDays(required("expires-in"), "--expires-in") : preview ? preview.expiresAfterDays : PREVIEW_DEFAULT_DAYS });
    // Hosted, the temporary copies are not needed (a failed upload keeps them for report:upload); --output keeps its own.
    const copied = has("output");
    if (!copied) await rm(result.work, { recursive: true, force: true });
    if (has("json")) output({ ...summary, ...(copied ? {} : { reports: summary.reports.map(({ directory: _directory, zip: _zip, ...report }) => report) }),
      url: hosted.previewUrl, expiresAt: hosted.expiresAt });
    else console.log(`Report: ${hosted.previewUrl}${hosted.expiresAt ? ` (until ${hosted.expiresAt.slice(0, 10)})` : ""}`);
    return;
  }
  if (has("json") || has("no-open")) {
    if (has("json")) output(summary);
    else for (const report of result.reports) console.log(`${report.target.id}: ${report.zip}`);
    return;
  }
  const server = await startLocalReportServer({ reports: zips, ...(has("port") ? { port: nonNegativeInteger("port") } : {}) });
  console.log(`Viewer: ${server.url} (Ctrl+C to stop)`);
  if (saved) console.log(`Saved as ${saved.id}: expo-explore reports reopens it, and reports upload ${saved.id} hosts it.`);
  openViewerInBrowser(server.url);
  await new Promise<void>(done => { process.once("SIGINT", () => done()); process.once("SIGTERM", () => done()); });
  await server.close();
  // The Viewer served the reports from memory, and the saved run keeps them; the temporary copy is no longer needed.
  if (saved) await rm(result.work, { recursive: true, force: true });
}
