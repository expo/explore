import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DEFAULT_BINARY_PROJECT, runBinaryExploration, runSessionExploration } from "../binary/run.js";
import { openViewerInBrowser, startViewerServer, waitForViewerShutdown } from "../map/viewer-server.js";
import { writeExplorationReport } from "../binary/report.js";
import { assertHostingExport, deployExplorationReport, zipReportDirectory } from "../report/preview-deploy.js";
import { keepReports } from "./report-commands.js";
import { warnIgnoredExpiry } from "../config/explore-config.js";
import { argumentError, flag, flags, has, nonNegativeInteger, oneOf, output, positional, positiveInteger, required } from "./args.js";
import { readReplayPlan } from "../binary/replay.js";
import { readFlowPlan } from "../binary/flows.js";
import { EXPLORATION_REPORT_KIND, type ExplorationFlow, type ExplorationReport } from "../contracts/standalone-report.js";
import { compareFlowRuns, type FlowRun } from "../review/flow-comparison.js";
import { diffScreenshots } from "../review/visual-evidence.js";
import { agentDeviceLauncher, ensureController } from "../shared/controller-cache.js";
import { CiError } from "../shared/ci-errors.js";


/** `--alias NAME` plus a fixed token from EXPLORE_PREVIEW_TOKEN: the hosted link stays the same from one run to the next (validated by the deploy). */
function stableLinkOptions(): { alias?: string; token?: string } {
  const token = process.env.EXPLORE_PREVIEW_TOKEN?.trim();
  return { ...(flag("alias") ? { alias: flag("alias")!.trim().toLowerCase() } : {}), ...(token ? { token } : {}) };
}

/** Each flow's outcome for the run summary: how many of its checkpoints have a picture. */
function flowSummary(flows: readonly ExplorationFlow[]) {
  return flows.map(flow => ({ name: flow.name, status: flow.status, checkpoints: `${flow.checkpoints.filter(item => item.observationId).length}/${flow.checkpoints.length}`, ...(flow.reason ? { reason: flow.reason } : {}) }));
}

export function defaultOutputDirectory(archive: string, now = new Date()): string {
  const slug = basename(archive).replace(/\.(tar\.gz|tgz|ipa|apk|app)$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/T(\d{4})\d{2}\.\d+Z$/, "-$1");
  return `explore-${slug}-${stamp}`;
}

export async function exploreBinary(): Promise<void> {
  const archive = positional() ?? flag("archive") ?? argumentError("Pass the app archive: expo-explore explore:binary ./app.apk", "archive",
    "Run expo-explore explore:binary <path to .apk, .app, .tar.gz, or simulator .ipa>.");
  if (has("upload") && has("no-upload")) argumentError("Pass either --upload or --no-upload", "no-upload");
  const outputDirectory = resolve(process.cwd(), flag("output") ?? defaultOutputDirectory(archive));
  if (has("expires-in")) warnIgnoredExpiry("--expires-in");
  const platform = flag("platform") === undefined ? undefined : oneOf("platform", ["ios", "android"] as const);
  const provider = flag("provider") === undefined ? undefined : oneOf("provider", ["anthropic", "openai"] as const);
  const controller = flag("controller") === undefined ? undefined : oneOf("controller", ["agent-device", "argent"] as const);
  const simulator = flag("simulator") === undefined ? "eas" : oneOf("simulator", ["eas", "local"] as const);
  // On EAS Simulator the report is hosted unless --no-upload; locally it opens in the Viewer unless --upload, so a
  // local run needs no Expo account at all.
  const upload = simulator === "local" ? has("upload") : !has("no-upload");
  const port = flag("port") === undefined ? undefined : nonNegativeInteger("port");
  const started = Date.now();
  const say = (message: string) => { process.stderr.write(`[explore ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`); };
  const allowDestructive = flags("allow-destructive").flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
  if (upload) await assertHostingExport();
  const result = await runBinaryExploration({
    archive: resolve(process.cwd(), archive), output: outputDirectory, progress: say, simulator,
    ...(platform ? { platform } : {}), ...(provider ? { provider } : {}), ...(controller ? { controller } : {}),
    ...(flag("device") ? { device: flag("device")! } : {}), ...(flag("bundle-id") ? { bundleId: flag("bundle-id")! } : {}),
    ...(flag("launch-url") ? { launchUrl: flag("launch-url")! } : {}), ...(flag("hints") ? { hints: flag("hints")! } : {}),
    ...(allowDestructive.length ? { allowDestructive } : {}), ...(flag("model") ? { model: flag("model")! } : {}),
    ...(flag("owner") ? { owner: flag("owner")! } : {}), ...(flag("project") ? { project: flag("project")! } : {}),
    ...(flag("max-duration-minutes") ? { maxDurationMinutes: positiveInteger("max-duration-minutes") } : {}),
    ...(flag("max-screens") ? { maxScreens: positiveInteger("max-screens") } : {}),
    ...(flag("max-actions") ? { maxActions: positiveInteger("max-actions") } : {}),
    ...(flag("replay") ? { replay: await readReplayPlan(resolve(process.cwd(), flag("replay")!)) } : {}),
    ...(flag("flows") ? { flows: await readFlowPlan(resolve(process.cwd(), flag("flows")!)) } : {}),
  });
  say(`exploration ${result.exploration.stopReason}: ${result.exploration.screens} screens, ${result.exploration.observations} captures, ${result.exploration.actions} actions`);
  const report = await writeExplorationReport(result, join(outputDirectory, "report"));
  await keepReports(async () => [{ platform: result.archive.platform, zip: await zipReportDirectory(report.reportPath) }]);
  let hosted: Awaited<ReturnType<typeof deployExplorationReport>> | undefined;
  if (upload) {
    say("hosting the report on EAS Hosting");
    const owner = result.session.owner || flag("owner");
    hosted = await deployExplorationReport({ reportPath: report.reportPath, platform: result.archive.platform, project: flag("project") ?? DEFAULT_BINARY_PROJECT, ...(owner ? { owner } : {}), ...stableLinkOptions() });
    say(`report: ${hosted.previewUrl}${hosted.expiresAt ? ` (expires ${hosted.expiresAt})` : ""}`);
  }
  const summary = { ok: true,
    app: { name: result.archive.appName, bundleId: result.archive.bundleId, platform: result.archive.platform, ...(result.archive.version ? { version: result.archive.version } : {}) },
    archive: { path: result.archive.path, kind: result.archive.kind, sha256: result.archive.sha256, bytes: result.archive.bytes },
    device: { model: result.runtime.deviceModel, osVersion: result.runtime.osVersion }, session: { id: result.session.id, simulator, ...(simulator === "eas" ? { owner: result.session.owner, project: result.session.project } : {}) },
    model: result.model, exploration: { stopReason: result.exploration.stopReason, ...(result.exploration.summary ? { summary: result.exploration.summary } : {}),
      screens: result.exploration.screens, observations: result.exploration.observations, actions: result.exploration.actions, durationMs: result.durationMs,
      ...(result.exploration.flows ? { flows: flowSummary(result.exploration.flows) } : {}) },
    map: result.mapPath, report: report.reportPath, ...(hosted ? { url: hosted.previewUrl, expiresAt: hosted.expiresAt, deploymentUrl: hosted.deploymentUrl, ...(hosted.aliasUrl ? { aliasUrl: hosted.aliasUrl } : {}) } : {}),
    next: [`expo-explore view --dir ${outputDirectory}`, `expo-explore screen:list --dir ${outputDirectory}`, `expo-explore gap:list --dir ${outputDirectory}`] };
  if (has("json")) { output(summary); return; }
  console.log(`${summary.app.name} (${summary.app.bundleId}, ${summary.app.platform}) explored on ${summary.device.model} ${summary.device.osVersion}: ${summary.exploration.screens} screens, ${summary.exploration.actions} actions, stopped because ${summary.exploration.stopReason}.`);
  for (const flow of summary.exploration.flows ?? []) console.log(`  ${flow.name}: ${flow.status}, ${flow.checkpoints} checkpoints${flow.reason ? ` (${flow.reason})` : ""}`);
  if (hosted) console.log(`Hosted report: ${hosted.previewUrl}${hosted.expiresAt ? ` (expires ${hosted.expiresAt})` : ""}`);
  console.log(`Local report: ${report.reportPath}`);
  if (simulator === "eas" || hosted || has("no-open")) { console.log(`Next: ${summary.next.join("  |  ")}`); return; }
  const viewer = await startViewerServer({ root: outputDirectory, ...(port === undefined ? {} : { port }) });
  console.log(`Viewer: ${viewer.url} (Ctrl+C to stop)`);
  openViewerInBrowser(viewer.url);
  await waitForViewerShutdown(viewer);
}

/** `--env-file` wins; otherwise the `.env.eas-simulator` that `eas simulator:start --out-config-type dotenv` wrote in the current directory, unless the environment already carries a session. */
async function defaultSessionEnvFile(envFileFlag: string | undefined): Promise<string | undefined> {
  if (envFileFlag) return resolve(process.cwd(), envFileFlag);
  if (process.env.EAS_SIMULATOR_SESSION_ID?.trim()) return undefined;
  const candidate = resolve(process.cwd(), ".env.eas-simulator");
  return await stat(candidate).then(info => info.isFile()).catch(() => false) ? candidate : undefined;
}

/** Explores an app already on a session the caller started; the result opens in the local Viewer unless --upload or --no-open. */
export async function exploreSession(): Promise<void> {
  const session = positional() ?? flag("session");
  const bundleId = flag("bundle-id");
  const outputDirectory = resolve(process.cwd(), flag("output") ?? defaultOutputDirectory(bundleId ?? "session"));
  if (has("expires-in")) warnIgnoredExpiry("--expires-in");
  const platform = flag("platform") === undefined ? undefined : oneOf("platform", ["ios", "android"] as const);
  const provider = flag("provider") === undefined ? undefined : oneOf("provider", ["anthropic", "openai"] as const);
  const controller = flag("controller") === undefined ? undefined : oneOf("controller", ["agent-device", "argent"] as const);
  const port = flag("port") === undefined ? undefined : nonNegativeInteger("port");
  const started = Date.now();
  const say = (message: string) => { process.stderr.write(`[explore ${Math.round((Date.now() - started) / 1000)}s] ${message}\n`); };
  const allowDestructive = flags("allow-destructive").flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
  const envFile = await defaultSessionEnvFile(flag("env-file"));
  if (has("upload")) await assertHostingExport();
  const result = await runSessionExploration({
    output: outputDirectory, progress: say,
    ...(bundleId ? { bundleId } : {}), ...(session ? { session } : {}), ...(envFile ? { envFile } : {}),
    ...(flag("app-name") ? { appName: flag("app-name")! } : {}), ...(flag("app-version") ? { version: flag("app-version")! } : {}),
    ...(platform ? { platform } : {}), ...(provider ? { provider } : {}), ...(controller ? { controller } : {}),
    ...(flag("device") ? { device: flag("device")! } : {}),
    ...(flag("launch-url") ? { launchUrl: flag("launch-url")! } : {}), ...(flag("hints") ? { hints: flag("hints")! } : {}),
    ...(allowDestructive.length ? { allowDestructive } : {}), ...(flag("model") ? { model: flag("model")! } : {}),
    ...(flag("max-duration-minutes") ? { maxDurationMinutes: positiveInteger("max-duration-minutes") } : {}),
    ...(flag("max-screens") ? { maxScreens: positiveInteger("max-screens") } : {}),
    ...(flag("max-actions") ? { maxActions: positiveInteger("max-actions") } : {}),
    ...(flag("replay") ? { replay: await readReplayPlan(resolve(process.cwd(), flag("replay")!)) } : {}),
    ...(flag("flows") ? { flows: await readFlowPlan(resolve(process.cwd(), flag("flows")!)) } : {}),
  });
  say(`exploration ${result.exploration.stopReason}: ${result.exploration.screens} screens, ${result.exploration.observations} captures, ${result.exploration.actions} actions`);
  const report = await writeExplorationReport(result, join(outputDirectory, "report"));
  await keepReports(async () => [{ platform: result.app.platform, zip: await zipReportDirectory(report.reportPath) }]);
  let hosted: Awaited<ReturnType<typeof deployExplorationReport>> | undefined;
  if (has("upload")) {
    say("hosting the report on EAS Hosting");
    hosted = await deployExplorationReport({ reportPath: report.reportPath, platform: result.app.platform, project: flag("project") ?? DEFAULT_BINARY_PROJECT, ...(flag("owner") ? { owner: flag("owner")! } : {}), ...stableLinkOptions() });
    say(`report: ${hosted.previewUrl}${hosted.expiresAt ? ` (expires ${hosted.expiresAt})` : ""}`);
  }
  const summary = { ok: true, app: result.app, device: { model: result.runtime.deviceModel, osVersion: result.runtime.osVersion },
    session: { id: result.session.id, name: result.session.name, ...(result.session.url ? { url: result.session.url } : {}), stopped: false },
    model: result.model, exploration: { stopReason: result.exploration.stopReason, ...(result.exploration.summary ? { summary: result.exploration.summary } : {}),
      screens: result.exploration.screens, observations: result.exploration.observations, actions: result.exploration.actions, durationMs: result.durationMs,
      ...(result.exploration.flows ? { flows: flowSummary(result.exploration.flows) } : {}) },
    map: result.mapPath, report: report.reportPath, ...(hosted ? { url: hosted.previewUrl, expiresAt: hosted.expiresAt, deploymentUrl: hosted.deploymentUrl, ...(hosted.aliasUrl ? { aliasUrl: hosted.aliasUrl } : {}) } : {}),
    next: [`expo-explore view --dir ${outputDirectory}`, `expo-explore screen:list --dir ${outputDirectory}`, `expo-explore gap:list --dir ${outputDirectory}`] };
  if (has("json")) { output(summary); return; }
  console.log(`${summary.app.name} (${summary.app.bundleId}, ${summary.app.platform}) explored on ${summary.device.model} ${summary.device.osVersion}: ${summary.exploration.screens} screens, ${summary.exploration.actions} actions, stopped because ${summary.exploration.stopReason}.`);
  for (const flow of summary.exploration.flows ?? []) console.log(`  ${flow.name}: ${flow.status}, ${flow.checkpoints} checkpoints${flow.reason ? ` (${flow.reason})` : ""}`);
  console.log(`Session ${result.session.id} is still running (stop it with: eas simulator:stop --id ${result.session.id}).`);
  if (hosted) console.log(`Hosted report: ${hosted.previewUrl}${hosted.expiresAt ? ` (expires ${hosted.expiresAt})` : ""}`);
  console.log(`Local report: ${report.reportPath}`);
  if (hosted || has("no-open")) { console.log(`Next: ${summary.next.join("  |  ")}`); return; }
  const viewer = await startViewerServer({ root: outputDirectory, ...(port === undefined ? {} : { port }) });
  console.log(`Viewer: ${viewer.url} (Ctrl+C to stop)`);
  openViewerInBrowser(viewer.url);
  await waitForViewerShutdown(viewer);
}

/** A flows run's report: the report directory explore:binary or explore:session wrote, or the output directory holding it. */
async function flowRun(path: string, name: "before" | "after"): Promise<FlowRun> {
  const refuse = (message: string) => { throw new CiError({ code: "FLOW_COMPARE_INPUT_INVALID", stage: "preflight", message,
    nextAction: `Pass --${name} the output directory of an explore:binary or explore:session run that used --flows (or its report directory).` }); };
  for (const directory of [resolve(path), resolve(path, "report")]) {
    let text: string;
    try { text = await readFile(join(directory, "exploration.json"), "utf8"); } catch { continue; }
    let report: ExplorationReport;
    try { report = JSON.parse(text) as ExplorationReport; } catch { return refuse(`${join(directory, "exploration.json")} is not JSON.`); }
    if (report?.kind !== EXPLORATION_REPORT_KIND) return refuse(`${join(directory, "exploration.json")} is not an exploration report.`);
    if (!Array.isArray(report.exploration?.flows)) return refuse(`The run in ${directory} did not follow a flows file, so it has no checkpoints to compare.`);
    return { report, directory };
  }
  return refuse(`No exploration.json was found in ${resolve(path)} or its report folder.`);
}

/** `compare:flows --before DIR --after DIR [--output FILE]`: two runs of one flows file, checkpoint by checkpoint. */
export async function compareFlows(): Promise<void> {
  const [before, after] = await Promise.all([flowRun(required("before"), "before"), flowRun(required("after"), "after")]);
  let command: string | undefined;
  const comparison = await compareFlowRuns(before, after, async (beforePath, afterPath) => {
    if (!command) { await ensureController("agent-device", { environment: process.env }); command = agentDeviceLauncher(process.env); }
    return diffScreenshots({ baselinePath: beforePath, currentPath: afterPath, command });
  });
  const path = flag("output");
  if (path) await writeFile(resolve(path), JSON.stringify(comparison, null, 2));
  output({ ok: true, ...(path ? { output: resolve(path) } : {}), comparison });
}
