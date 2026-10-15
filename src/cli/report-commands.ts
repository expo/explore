import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_BINARY_PROJECT } from "../binary/run.js";
import { repositoryName } from "../ci/local-review.js";
import { readExploreConfig, previewDays, DEFAULT_EXPLORE_CONFIG_PATH, PREVIEW_DEFAULT_DAYS, type ExploreConfig, type ExplorePlatform } from "../config/explore-config.js";
import { assertHostingExport, deployLocalReports, previewProjectSlug, readReportZip, zipReportDirectory, MAX_REPORT_BYTES, type ReportZipSummary } from "../report/preview-deploy.js";
import { CiError, toCiError } from "../shared/ci-errors.js";
import { argumentError, flag, has, output, positionals, required } from "./args.js";

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

/**
 * `report:upload <report.zip | report directory>...`: hosts reports already on this machine behind one token-gated EAS
 * Hosting link, as `capture:review --upload` and `explore:binary` do for the report they just wrote. Several reports
 * must be one review's platforms; a review goes to the repository's preview project, an exploration to expo-explore.
 */
export async function reportUpload(): Promise<void> {
  const paths = positionals();
  if (!paths.length) argumentError("Pass the report to host: expo-explore report:upload ios/report.zip", undefined,
    "Run expo-explore report:upload with a report.zip or report directory, one per platform of the same review.");
  const reports = [];
  for (const path of paths) reports.push(await readReport(path));
  const [first, ...others] = reports as [typeof reports[number], ...typeof reports];
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
  await assertHostingExport();
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
