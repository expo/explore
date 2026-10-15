import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_BINARY_PROJECT } from "../binary/run.js";
import { repositoryName } from "../ci/local-review.js";
import { readExploreConfig, previewDays, DEFAULT_EXPLORE_CONFIG_PATH, PREVIEW_DEFAULT_DAYS, type ExploreConfig, type ExplorePlatform } from "../config/explore-config.js";
import { assertHostingExport, deployLocalReports, previewProjectSlug, readReportZip, zipReportDirectory, MAX_REPORT_BYTES, type ReportZipSummary } from "../report/preview-deploy.js";
import { startLocalReportServer } from "../report/local-report-server.js";
import { findSavedRun, listSavedRuns, pruneSavedRuns, readSavedReports, removeSavedRun, saveRun, savedRunsDirectory, SAVED_RUN_LIMITS, type SavedReport, type SavedRun } from "../report/saved-runs.js";
import { openViewerInBrowser } from "../map/viewer-server.js";
import { formatBytes, friendlyTime, kindLabel, runPicker, runTitle } from "./reports-picker.js";
import { pickIntro } from "./title-intros.js";
import { CiError, toCiError } from "../shared/ci-errors.js";
import { argumentError, flag, has, nonNegativeInteger, output, positionals, required } from "./args.js";

/** explore:binary's default: an exploration link is for a quick look. */
const EXPLORATION_DEFAULT_DAYS = 7;

/** A report directory (review.json or exploration.json and assets/), its parent holding report.zip, or a report ZIP. */
async function readReport(path: string): Promise<{ path: string; zip: Uint8Array; summary: ReportZipSummary }> {
  const target = resolve(process.cwd(), path);
  const info = await stat(target).catch(() => undefined);
  if (!info) argumentError(`There is no report at ${path}`, undefined, "Pass a report.zip or report directory that exists.");
  try {
    // A ZIP is sized before it is read: nothing larger than a hosted report can be is loaded into memory.
    const readZip = async (file: string) => {
      if ((await stat(file)).size > MAX_REPORT_BYTES) throw new Error(`${path} is larger than the ${MAX_REPORT_BYTES / 1024 / 1024} MiB a hosted report can be`);
      return new Uint8Array(await readFile(file));
    };
    let zip: Uint8Array;
    if (!info.isDirectory()) zip = await readZip(target);
    else if (await stat(join(target, "report.zip")).then(file => file.isFile()).catch(() => false)) zip = await readZip(join(target, "report.zip"));
    else zip = await zipReportDirectory(target);
    return { path, zip, summary: await readReportZip(zip) };
  } catch (error) {
    throw toCiError(error, { code: "REPORT_ZIP_FAILED", stage: "export",
      nextAction: `${path} is not an Explore report. Pass a report.zip or report directory written by capture:review, explore:binary or ci:report, or a downloaded explore-review artifact.` });
  }
}

type PreviewSettings = NonNullable<ExploreConfig["report"]>["preview"];

/** `<app>/.expo-explore/config.yaml` as the app directory and the path config readers take. */
function configLocation(file: string): { app: string; path: string } {
  return basename(dirname(file)) === ".expo-explore" ? { app: dirname(dirname(file)), path: relative(dirname(dirname(file)), file) } : { app: dirname(file), path: basename(file) };
}

/**
 * The report.preview a review's own uploads use: from --config, or else from this repository's committed config when the
 * reports are this repository's (the one in the current directory, or the only one, as in a monorepo). Says which.
 */
async function repositoryPreview(repository: string): Promise<{ preview: PreviewSettings; source: string } | undefined> {
  const explicit = flag("config");
  if (explicit) {
    const { app, path } = configLocation(resolve(process.cwd(), explicit));
    return { preview: (await readExploreConfig(app, path)).report?.preview, source: explicit };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" });
  if (top.status !== 0) return undefined;
  const root = top.stdout.trim();
  const listed = spawnSync("git", ["ls-files", "--full-name", "--", ":(glob)**/.expo-explore/config.yaml"], { cwd: root, encoding: "utf8" });
  const committed = listed.status === 0 ? listed.stdout.split("\n").filter(Boolean) : [];
  const here = relative(root, join(process.cwd(), DEFAULT_EXPLORE_CONFIG_PATH)).split(sep).join("/");
  const file = committed.includes(here) ? here : committed.length === 1 ? committed[0]! : undefined;
  if (!file) return undefined;
  const { app, path } = configLocation(join(root, file));
  const config = await readExploreConfig(app, path);
  return repositoryName(root, config) === repository ? { preview: config.report?.preview, source: file } : undefined;
}

type ReadReport = Awaited<ReturnType<typeof readReport>>;

/** Several reports share one link only as one review's platforms; an exploration goes up on its own. */
function assertOneReview(reports: ReadReport[]): void {
  const [first, ...others] = reports as [ReadReport, ...ReadReport[]];
  const platforms = new Set<ExplorePlatform>([first.summary.platform]);
  for (const report of others) {
    if (platforms.has(report.summary.platform)) throw new CiError({ code: "PREVIEW_REPORTS_INVALID", stage: "preflight",
      message: `More than one ${report.summary.platform} report: one link holds one report per platform.`, nextAction: "Upload each platform's report once." });
    platforms.add(report.summary.platform);
    const a = first.summary, b = report.summary;
    if (a.kind !== "review" || b.kind !== "review" || a.repository !== b.repository || a.runId !== b.runId || a.base !== b.base || a.head !== b.head) {
      throw new CiError({ code: "PREVIEW_REPORTS_MISMATCH", stage: "preflight", message: `${first.path} and ${report.path} are not the same review's platforms.`,
        nextAction: "Upload the reports of one review together (one per platform), and anything else on its own." });
    }
  }
}

/** Hosts checked reports in the project `--upload` would have used (flags win), and prints the link. */
async function hostReports(reports: ReadReport[]): Promise<void> {
  await assertHostingExport();
  const first = reports[0]!;
  const review = first.summary.kind === "review" ? first.summary : undefined;
  const found = review ? await repositoryPreview(review.repository) : undefined;
  const preview = found?.preview;
  if (review) process.stderr.write(found ? `report.preview from ${found.source}\n`
    : `no config of ${review.repository} here: hosting with the defaults (pass --config, or --owner, --project and --expires-in)\n`);
  const project = flag("project") ?? (review ? previewProjectSlug(review.repository, preview?.project) : DEFAULT_BINARY_PROJECT);
  const owner = flag("owner") ?? preview?.owner;
  const expiresAfterDays = has("expires-in") ? previewDays(required("expires-in"), "--expires-in")
    : preview ? preview.expiresAfterDays : review ? PREVIEW_DEFAULT_DAYS : EXPLORATION_DEFAULT_DAYS;
  const hosted = await deployLocalReports({ project, ...(owner ? { owner } : {}), expiresAfterDays,
    reports: reports.map(report => ({ platform: report.summary.platform, zip: report.zip,
      ...(report.summary.changes === undefined ? {} : { changes: report.summary.changes }), ...(report.summary.device ? { device: report.summary.device } : {}) })),
    ownerHint: "Pass --owner with the Expo account that should host the report.",
    projectHint: "Give this EAS login permission to create projects under the owner, or pass --project with an existing project slug." });
  if (has("json")) {
    output({ ok: true, url: hosted.previewUrl, expiresAt: hosted.expiresAt, project: hosted.project, owner: hosted.owner,
      reports: reports.map(report => ({ path: report.path, platform: report.summary.platform, kind: report.summary.kind })) });
    return;
  }
  console.log(`Report: ${hosted.previewUrl}${hosted.expiresAt ? ` (until ${hosted.expiresAt.slice(0, 10)})` : ""}`);
  console.log(`Hosted on @${hosted.owner}/${hosted.project}. Anyone with the link can open it.`);
}

/** Keeps reports among the saved runs; a failure to keep them never fails the command that made them. */
export async function keepReports(reports: SavedReport[] | (() => Promise<SavedReport[]>), extra: Parameters<typeof saveRun>[1] = {}): Promise<SavedRun | undefined> {
  try { return await saveRun(typeof reports === "function" ? await reports() : reports, extra); }
  catch (error) { process.stderr.write(`Could not keep this run in expo-explore reports: ${error instanceof Error ? error.message : String(error)}\n`); return undefined; }
}

/** The subject line of a commit, when this checkout has it. */
export function commitSubject(cwd: string, sha: string): string | undefined {
  const result = spawnSync("git", ["log", "-1", "--format=%s", sha], { cwd, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/**
 * `report:upload <report.zip | report directory>...`: hosts reports already on this machine behind one token-gated EAS
 * Hosting link, as `capture:review --upload` and `explore:binary` do for the report they just wrote. Several reports
 * must be one review's platforms; a review goes to the repository's preview project, an exploration to expo-explore.
 * The reports are also kept among the saved runs (`expo-explore reports`).
 */
export async function reportUpload(): Promise<void> {
  const paths = positionals();
  if (!paths.length) argumentError("Pass the report to host: expo-explore report:upload ios/report.zip", undefined,
    "Run expo-explore report:upload with a report.zip or report directory, one per platform of the same review.");
  const reports: ReadReport[] = [];
  for (const path of paths) reports.push(await readReport(path));
  assertOneReview(reports);
  const review = reports[0]!.summary.kind === "review" ? reports[0]!.summary : undefined;
  const head = review && commitSubject(process.cwd(), review.head), base = review && commitSubject(process.cwd(), review.base);
  await keepReports(reports.map(report => ({ platform: report.summary.platform, zip: report.zip })), { subjects: { ...(head ? { head } : {}), ...(base ? { base } : {}) } });
  await hostReports(reports);
}

/** Serves reports in the local Viewer, opens it, and waits for Ctrl+C. */
export async function openInViewer(reports: SavedReport[]): Promise<void> {
  const server = await startLocalReportServer({ reports, ...(has("port") ? { port: nonNegativeInteger("port") } : {}) });
  console.log(`Viewer: ${server.url} (Ctrl+C to stop)`);
  if (!has("no-open")) openViewerInBrowser(server.url);
  await new Promise<void>(done => { process.once("SIGINT", () => done()); process.once("SIGTERM", () => done()); });
  await server.close();
}

/** This checkout's GitHub repository (owner/name), which saved reviews name; undefined outside one. */
function currentRepository(): string | undefined {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: process.cwd(), encoding: "utf8" });
  const match = remote.status === 0 ? /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote.stdout.trim()) : null;
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function savedRun(id: string | undefined): Promise<SavedRun> {
  if (!id) argumentError("Name the run: an id from expo-explore reports list, or latest", undefined, "Run expo-explore reports list to see the saved runs.");
  const run = await findSavedRun(id);
  if (!run) throw new CiError({ code: "REPORT_RUN_NOT_FOUND", stage: "preflight", message: id === "latest" ? "There are no saved runs yet." : `There is no saved run ${id}.`,
    nextAction: "Run expo-explore reports list to see the saved runs." });
  return run;
}

async function uploadSavedRun(run: SavedRun): Promise<void> {
  const reports: ReadReport[] = [];
  for (const report of await readSavedReports(run)) reports.push({ path: `${run.id}/${report.platform}.zip`, zip: report.zip, summary: await readReportZip(report.zip) });
  await hostReports(reports);
}

function listLines(runs: SavedRun[], now = Date.now()): string[] {
  if (!runs.length) return ["No saved runs yet. expo-explore capture:review reviews your branch on this machine, and its report is kept here."];
  const idWidth = Math.max(...runs.map(run => run.id.length));
  return [...runs.map(run => `${run.id.padEnd(idWidth)}  ${kindLabel(run).padEnd(9)}${runTitle(run)}  (${run.platforms.join(", ")}, ${friendlyTime(run.createdAt, now)})`),
    "", "Open one with: expo-explore reports open <id>"];
}

/**
 * `reports [list | open ID | add REPORT... | upload ID | rm ID | prune] [--all] [--json]`: the runs kept on this machine. In a terminal
 * with no subcommand it is an arrow-key picker (Enter opens the run in the local Viewer, u hosts it); elsewhere it lists.
 * ID is a run's id or `latest`.
 */
export async function reports(): Promise<void> {
  const [subcommand = "", id, ...rest] = positionals();
  const all = await listSavedRuns();
  const repository = currentRepository();
  const scoped = has("all") || !repository || !all.some(run => run.repository === repository) ? all : all.filter(run => run.repository === repository);
  const totalBytes = () => all.reduce((sum, run) => sum + run.bytes, 0);
  switch (subcommand) {
    case "open": return openInViewer(await readSavedReports(await savedRun(id)));
    case "add": {
      // A report already on disk (a downloaded explore-review artifact, say), kept like a run made here, without hosting it.
      const paths = [id, ...rest].filter((path): path is string => !!path);
      if (!paths.length) argumentError("Pass the report to keep: expo-explore reports add ios/report.zip", undefined, "Run expo-explore reports add with a report.zip or report directory, one per platform of the same review.");
      const read: ReadReport[] = [];
      for (const path of paths) read.push(await readReport(path));
      assertOneReview(read);
      const review = read[0]!.summary.kind === "review" ? read[0]!.summary : undefined;
      const head = review && commitSubject(process.cwd(), review.head), base = review && commitSubject(process.cwd(), review.base);
      const run = await saveRun(read.map(report => ({ platform: report.summary.platform, zip: report.zip })), { subjects: { ...(head ? { head } : {}), ...(base ? { base } : {}) } });
      if (has("json")) output({ ok: true, run }); else console.log(`Kept ${runTitle(run)} as ${run.id}.`);
      return;
    }
    case "upload": return uploadSavedRun(await savedRun(id));
    case "rm": {
      const run = await savedRun(id);
      await removeSavedRun(run.id);
      if (has("json")) output({ ok: true, removed: run.id }); else console.log(`Deleted ${runTitle(run)} (${run.id}).`);
      return;
    }
    case "prune": {
      const removed = await pruneSavedRuns();
      if (has("json")) output({ ok: true, removed: removed.map(run => run.id) });
      else console.log(removed.length ? `Removed ${removed.length} run${removed.length === 1 ? "" : "s"} kept longer than ${SAVED_RUN_LIMITS.maxAgeDays} days or past ${formatBytes(SAVED_RUN_LIMITS.maxBytes)}.` : "Nothing to prune.");
      return;
    }
    case "list": case "": break;
    default: argumentError(`Unknown reports subcommand: ${subcommand}`, undefined, "Use expo-explore reports, or reports list, open, add, upload, rm or prune.");
  }
  if (has("json")) { output({ ok: true, runs: scoped, bytes: totalBytes(), directory: savedRunsDirectory() }); return; }
  if (subcommand === "list" || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) { for (const line of listLines(scoped)) console.log(line); return; }
  const color = !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const action = await runPicker({ runs: all, ...(repository ? { repository } : {}),
    scope: scoped === all ? "all" : "repository", filter: "", filtering: false, selected: 0, offset: 0 },
  { input: process.stdin, output: process.stdout, color, intro: color && !has("no-intro") ? pickIntro(process.env) : undefined,
    remove: async run => { await removeSavedRun(run.id); all.splice(all.findIndex(each => each.id === run.id), 1); }, totalBytes });
  if (action.type === "open") { console.log(`${runTitle(action.run)}`); await openInViewer(await readSavedReports(action.run)); }
  else if (action.type === "upload") { console.log(`Hosting ${runTitle(action.run)}…`); await uploadSavedRun(action.run); }
}
