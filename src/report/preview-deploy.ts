import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, configure } from "@zip.js/zip.js";
import { loadReport, MAX_METADATA_BYTES } from "./agent-api.js";
import { manifestBody } from "./preview-manifest.js";
import { publishCiReportComment, readCiReportInput, type CiReportInput } from "./artifact.js";
import { readZipDirectory, readZipEntry } from "./zip-reader.js";
import { reviewChangeCount, reviewDevice } from "./pr-comment-body.js";
import { isTargetId, type ExplorePlatform } from "../config/explore-config.js";
import type { RunTarget } from "../types.js";
import { targetParameter } from "./viewer-links.js";
import type { ArtifactReport } from "../contracts/artifact-report.js";
import { normalizePublicReviewForReading } from "../contracts/review-validation.js";
import { EXPLORATION_REPORT_KIND, type ExplorationReport } from "../contracts/standalone-report.js";
import { compareTitleMarkdown, type CompareReviewPresentation } from "../contracts/review.js";
import { CiError, toCiError } from "../shared/ci-errors.js";
import { TOOL_ROOT, packageBin } from "../shared/package-paths.js";

/**
 * `ci:deploy`: publish one token-gated EAS Hosting deployment for a packaged review.
 *
 * The deployment is the prebuilt preview export of viewer-host (routes `/p/[token]`, see viewer-host/README.md)
 * plus the report ZIP encrypted with a key that only the deployment's Worker environment holds. The Worker
 * serves the Viewer and the decrypted report at `/p/<token>` and answers 404 to everything else; after
 * `expiresAt` (if any) the token page says the link expired. Deployments are never deleted automatically. The report job already published the GitHub artifact links, so a failed deployment leaves
 * the comment on the download-and-drop flow.
 */
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv })
  => { status: number | null; stdout: string; stderr: string };

export type PreviewReportInput = {
  /** Set by the matrix workflows; the preview then serves this report at report.zip?platform=<platform>. */
  platform?: ExplorePlatform;
  /**
   * The capture target, set by the matrix workflows (wins over `platform`): the preview serves the report as
   * `<target id>.zip.enc` at report.zip?target=<id> (?platform=<id> for a target named after its platform).
   */
  target?: RunTarget;
  inputPath: string;
  /** The `ci:report` output directory: review.json and assets/. */
  reportPath: string;
  artifactUrl: string;
};

export type PreviewDeployOptions = (PreviewReportInput | {
  /** One report per platform from the same run, sealed into one deployment behind one token. */
  reports: PreviewReportInput[];
}) & {
  environment?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  run?: CommandRunner;
  /** Pause between `eas deploy` attempts; tests replace it so retries take no real time. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** The preview export (client/ and server/); defaults to the one shipped in this package. */
  exportPath?: string;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  /** Called with the URL token before it appears in any output, so CI can mask it. */
  onSecret?: (secret: string) => void;
  /** Milliseconds to keep re-checking a fresh deployment before giving up. */
  verifyTimeoutMs?: number;
};

export type PreviewDeployResult = {
  previewUrl: string;
  /** ISO instant, or null when the link does not expire. */
  expiresAt: string | null;
  deploymentId: string;
  deploymentUrl: string;
  project: string;
  owner: string;
  /** The first (or only) report's archive, as before; `reports` lists every platform's. */
  reportSha256: string;
  reportBytes: number;
  reports: Array<{ platform?: ExplorePlatform; target?: RunTarget; artifactUrl: string; reportSha256: string; reportBytes: number }>;
  headSha: string;
  /** A comparison's link is in the run summary only: callers must not print previewUrl, which is unmasked for it. */
  linkedFromRunSummary?: true;
};

export const PREVIEW_EXPORT_PATH = join(TOOL_ROOT, "dist", "hosting-preview");
const CIPHER_AAD = "expo-explore-preview/1";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** The largest report ZIP a hosted preview serves. */
export const MAX_REPORT_BYTES = 256 * 1024 * 1024;
const ZIP_DATE = new Date("2000-01-01T00:00:00Z");
const PLATFORM_LABELS: Record<ExplorePlatform, string> = { ios: "iOS", android: "Android" };

/** The target of a report from before targets, or of a config without them: its platform, under the platform's name. */
export function platformTarget(platform: ExplorePlatform): RunTarget {
  return { id: platform, platform, label: PLATFORM_LABELS[platform] };
}

/** The report.zip query that selects a target (see targetParameter): `?platform=ios` for configs without targets, as before. */
function targetQuery(target: RunTarget): string {
  const [key, value] = targetParameter(target.id);
  return `?${key}=${value}`;
}

/** A target as untrusted JSON names it (a report's review.runtime.target): its id, platform and a plain label, or undefined. */
function readTarget(value: unknown): RunTarget | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { id, platform, label } = value as Record<string, unknown>;
  if (!isTargetId(id) || (platform !== "ios" && platform !== "android")) return undefined;
  const shown = typeof label === "string" ? listingLabel(label) : "";
  return { id, platform, label: shown || PLATFORM_LABELS[platform] };
}

function assertTargets(targets: RunTarget[], message: string, nextAction: string): void {
  // At most 8, as a config names: the Worker refuses a longer listing.
  if (!targets.length || targets.length > 8 || targets.some(target => !isTargetId(target.id) || (target.platform !== "ios" && target.platform !== "android"))
    || new Set(targets.map(target => target.id)).size !== targets.length) throw previewError("PREVIEW_REPORTS_INVALID", message, nextAction);
}

function base32(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const defaultRun: CommandRunner = (command, args, options) => spawnSync(command, args, {
  cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024,
});

function deployError(code: string, message: string, nextAction: string, extra: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}): CiError {
  return new CiError({ code, stage: "publication", message, nextAction, ...extra });
}

function lastLine(text: string): string {
  return text.trim().split("\n").map(line => line.trim()).filter(Boolean).at(-1) ?? "";
}

const DEPLOY_ATTEMPTS = 3;
/** eas: "This account has reached the limit of 5 aliases from the Free plan." */
const ALIAS_LIMIT = /reached the limit of \d+ aliases[^\n]*/;
const DEPLOY_RETRY_DELAYS_MS = [5_000, 15_000] as const;

/** The tail of what a command printed, stderr first, without the EXPO_TOKEN should eas ever echo it. */
function commandOutput(result: ReturnType<CommandRunner>, token: string | undefined): string {
  const lines = `${result.stderr}\n${result.stdout}`.split("\n").map(line => line.trimEnd()).filter(Boolean);
  const tail = lines.slice(-30).join("\n");
  return token ? tail.split(token).join("***") : tail;
}

/** `eas whoami` has no JSON output; its account list is one `• name (Role: …)` line per account. */
export function whoamiAccounts(stdout: string): string[] {
  const accounts = stdout.split("\n").map(line => /^\s*[•*-]\s+([a-z0-9][a-z0-9_-]*)(?:\s+\(Role: [^)]*\))?\s*$/.exec(line)?.[1]).filter((name): name is string => !!name);
  if (accounts.length) return accounts;
  const single = /^\s*([a-z0-9][a-z0-9_-]*)\s*$/.exec(stdout.trim().split("\n").at(-1) ?? "")?.[1];
  return single ? [single] : [];
}

/** The dedicated preview project: `report.preview.project`, or `<repository name>-explore`. */
export function previewProjectSlug(repository: string, configured?: string): string {
  if (configured) return configured;
  const name = repository.split("/")[1]?.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
  const slug = `${name.slice(0, 50).replace(/-+$/, "") || "app"}-explore`;
  return slug;
}

/** Report files a sealed ZIP may carry at its root: a PR review or a standalone exploration report. */
const REPORT_FILE_NAMES = ["review.json", "exploration.json"] as const;

/** Deterministic ZIP of the report directory: review.json or exploration.json plus assets/<sha256>.png|mp4, like GitHub's artifact download. */
export async function zipReportDirectory(reportPath: string): Promise<Uint8Array> {
  configure({ useWebWorkers: false });
  const root = await realpath(resolve(reportPath));
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!(await lstat(path)).isFile()) throw new Error(`Report contains a non-regular file: ${relative(root, path)}`);
      files.push(path);
    }
  }
  await walk(root);
  const names = files.map(path => relative(root, path).split(sep).join("/"));
  const reportFile = REPORT_FILE_NAMES.find(name => names.includes(name));
  if (!reportFile || names.some(name => name !== reportFile && !/^assets\/[a-f0-9]{64}\.(png|mp4)$/.test(name))) {
    throw new Error("Report directory must contain review.json (or exploration.json) and assets/<sha256>.png or .mp4 only");
  }
  const writer = new ZipWriter(new Uint8ArrayWriter(), { lastModDate: ZIP_DATE, extendedTimestamp: false, zip64: false });
  let total = 0;
  for (const [index, path] of files.entries()) {
    const bytes = new Uint8Array(await readFile(path));
    total += bytes.byteLength;
    if (total > MAX_REPORT_BYTES) throw new Error("Report exceeds the 256 MiB hosted preview limit");
    await writer.add(names[index]!, new Uint8ArrayReader(bytes), { level: names[index] === reportFile ? 6 : 0 });
  }
  return writer.close();
}

/**
 * What a report ZIP holds, from its review.json or exploration.json: where to host it and how the target switch labels it.
 * `target` is review.runtime.target, or for reports from before targets (and explorations) the platform's own target.
 */
export type ReportZipSummary = { platform: ExplorePlatform; target: RunTarget; changes?: number; device?: string }
  & ({ kind: "review"; repository: string; runId: string; base: string; head: string } | { kind: "exploration" });

/**
 * Reads a report ZIP as `zipReportDirectory` writes it (or GitHub's download of a report artifact): one report file and
 * its assets, nothing else. It uses the hosted reader (zip-reader.ts) with its limits, so a ZIP accepted here is one a
 * hosted or local Viewer link can serve, and a crafted one cannot inflate past them.
 */
export async function readReportZip(zip: Uint8Array): Promise<ReportZipSummary> {
  if (zip.byteLength > MAX_REPORT_BYTES) throw new Error("Report exceeds the 256 MiB hosted preview limit");
  const entries = readZipDirectory(zip);
  if (!entries) throw new Error("Not a ZIP archive a hosted report can read");
  const names = [...entries.keys()].filter(name => !name.endsWith("/"));
  const reportFile = REPORT_FILE_NAMES.find(name => names.includes(name));
  if (!reportFile || names.some(name => name !== reportFile && !/^assets\/[a-f0-9]{64}\.(png|mp4)$/.test(name))) {
    throw new Error("A report ZIP must contain review.json (or exploration.json) and assets/<sha256>.png or .mp4 only");
  }
  const bytes = await readZipEntry(zip, entries.get(reportFile)!, MAX_METADATA_BYTES);
  if (!bytes) throw new Error(`${reportFile} is unreadable or larger than ${MAX_METADATA_BYTES / 1024 / 1024} MiB`);
  const report = JSON.parse(new TextDecoder().decode(bytes));
  if (reportFile === "exploration.json") {
    const exploration = (report as Partial<ExplorationReport>).exploration;
    if (report?.kind !== EXPLORATION_REPORT_KIND || !exploration || (exploration.app?.platform !== "ios" && exploration.app?.platform !== "android")) {
      throw new Error("exploration.json is not an Explore exploration report");
    }
    return { kind: "exploration", platform: exploration.app.platform, target: platformTarget(exploration.app.platform), device: `${exploration.device.model} ${exploration.device.osVersion}`.trim() };
  }
  const review = (report as Partial<ArtifactReport>).review;
  const pr = review?.pullRequest;
  // Reports from before Android support carry no platform; they are all iOS.
  const platform = review?.runtime?.platform ?? "ios";
  if (report?.kind !== "explore.report" || !review || !pr || (platform !== "ios" && platform !== "android")) {
    throw new Error("review.json is not an Explore review report");
  }
  // What the CLI later hands to git and shows in a terminal: full SHAs and plain text, or the ZIP is not a report.
  const sha = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1000;
  if (!sha(pr.head?.sha) || !sha(pr.base?.sha) || !text(pr.head?.ref) || !text(pr.base?.ref) || !text(pr.repository) || !text(pr.title) || !text(review.runId)) {
    throw new Error("review.json does not name its repository, title and commits as a report does");
  }
  const changes = reviewChangeCount({ review: normalizePublicReviewForReading(review) });
  const device = reviewDevice({ runtime: { deviceModel: review.runtime?.device?.model ?? "", osVersion: review.runtime?.device?.osVersion ?? "",
    ...(review.runtime?.colorSchemes ? { colorSchemes: review.runtime.colorSchemes } : {}) } });
  // A target whose platform is not the report's own is not this report's target.
  const named = readTarget(review.runtime?.target);
  const target = named?.platform === platform ? named : platformTarget(platform);
  return { kind: "review", platform, target, repository: pr.repository, runId: review.runId, base: pr.base.sha, head: pr.head.sha,
    ...(changes === undefined ? {} : { changes }), ...(device ? { device } : {}) };
}

/** iv (12 bytes) || AES-256-GCM ciphertext || tag, authenticated with the preview AAD; what the Worker decrypts. */
export function sealReport(plain: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(CIPHER_AAD));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([iv, body]));
}

/** Fails fast when the Viewer export that hosted reports need is not installed, so a run does not explore for minutes before learning it cannot upload. */
export async function assertHostingExport(exportPath: string = PREVIEW_EXPORT_PATH): Promise<void> {
  await assertExport(resolve(exportPath));
}

async function assertExport(exportPath: string): Promise<void> {
  for (const path of ["client/viewer/index.html", "server/_expo/routes.json"]) {
    try { if (!(await lstat(join(exportPath, path))).isFile()) throw new Error(); }
    catch { throw deployError("PREVIEW_EXPORT_MISSING", `The hosted preview export is missing ${path}`,
      "Reinstall @expo/explore; the release tarball ships dist/hosting-preview. In a checkout, run npm run build:hosting:preview."); }
  }
}

type SealedReport = { entry: PreviewReportInput; input: CiReportInput; target?: RunTarget; zip: Uint8Array; sha256: string; file: string };

function previewError(code: string, message: string, nextAction: string): CiError { return new CiError({ code, stage: "preflight", message, nextAction }); }

/**
 * A device label for the platform switch, safe in the sealed .env: letters, digits and a few separators only. `eas
 * deploy` reads that file with variable expansion, so a `$` (even single-quoted) would pull the deploying process's
 * environment into the label, and a `#` or a backslash would cut or corrupt the JSON around it.
 */
function listingDevice(device: string): string {
  return device.replace(/[^\p{L}\p{N} .,()+·_:/-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 120);
}
/** A target's label for the switch, as safe as a device label and shorter. */
function listingLabel(label: string): string {
  return listingDevice(label).slice(0, 80).trim();
}

/** One EXPLORE_PREVIEW_REPORTS entry, keys in the order the Worker echoes them in reports.json. */
export type PreviewListingEntry = { target: string; platform: ExplorePlatform; label?: string; path: string; changes?: number; device?: string };
function listingEntry(target: RunTarget, path: string, changes?: number, device?: string): PreviewListingEntry {
  const label = listingLabel(target.label), shown = device ? listingDevice(device) : "";
  return { target: target.id, platform: target.platform, ...(label ? { label } : {}), path, ...(changes === undefined ? {} : { changes }), ...(shown ? { device: shown } : {}) };
}

/** The worker's EXPLORE_PREVIEW_REPORTS entries, in the order the workflow lists targets; also what reports.json must echo. */
export function previewReportListing(reports: ReadonlyArray<Pick<SealedReport, "input" | "file"> & { target: RunTarget }>, reportDirectory: string): PreviewListingEntry[] {
  return reports.map(report => listingEntry(report.target, `/_report/${reportDirectory}/${report.file}`, reviewChangeCount(report.input.commentState), reviewDevice(report.input.commentState)));
}

export async function deployPreview(options: PreviewDeployOptions): Promise<PreviewDeployResult> {
  const environment = options.environment ?? process.env; const transport = options.transport ?? fetch;
  const run = options.run ?? defaultRun; const now = options.now ?? Date.now; const random = options.random ?? (bytes => new Uint8Array(randomBytes(bytes)));
  const entries: PreviewReportInput[] = "reports" in options ? options.reports
    : [{ inputPath: options.inputPath, reportPath: options.reportPath, artifactUrl: options.artifactUrl }];
  if (!entries.length) throw previewError("PREVIEW_REPORTS_MISSING", "There is no platform report to deploy",
    "Pass --inputs and --reports directories holding one explore-capture and one explore-review artifact per platform.");
  const multi = entries.some(entry => entry.platform !== undefined || entry.target !== undefined);
  if (multi) {
    if (entries.some(entry => !entry.platform && !entry.target)) throw previewError("PREVIEW_REPORTS_INVALID", "Each report of a multi-target preview must name its target", "Deploy one report per target of the same run.");
    assertTargets(entries.map(entry => entry.target ?? platformTarget(entry.platform!)), "Each report of a multi-target preview must name a distinct target", "Deploy one report per target of the same run.");
  }
  const inputs: Array<{ entry: PreviewReportInput; input: CiReportInput; target?: RunTarget }> = [];
  for (const entry of entries) {
    const input = await readCiReportInput(entry.inputPath);
    // A platform-named entry takes the report's own label when the report names that target.
    const named = readTarget(input.publicReview.runtime.target);
    const target = entry.target ?? (entry.platform ? (named?.id === entry.platform ? named : platformTarget(entry.platform)) : undefined);
    inputs.push({ entry, input, ...(target ? { target } : {}) });
  }
  const first = inputs[0]!.input; const review = first.publicReview; const pr = review.pullRequest;
  if (!first.preview) throw new CiError({ code: "PREVIEW_NOT_CONFIGURED", stage: "preflight",
    message: "This review did not request a hosted preview", nextAction: "Set report.preview.hosting: eas in .expo-explore/config.yaml, or remove the deploy job." });
  if (!environment.EXPO_TOKEN?.trim()) throw new CiError({ code: "EXPO_TOKEN_MISSING", stage: "preflight",
    message: "EXPO_TOKEN is required to deploy a hosted preview", nextAction: "Pass the EXPO_TOKEN secret to the deploy job; it must be able to create projects in the app's Expo account." });
  if (!environment.GITHUB_TOKEN?.trim()) throw new CiError({ code: "GITHUB_TOKEN_MISSING", stage: "preflight",
    message: "GITHUB_TOKEN is required to publish the preview link", nextAction: "Pass GITHUB_TOKEN to the deploy job with Actions read and PR comment write permissions." });
  if (pr.origin === "local") throw new Error("Local reports cannot be deployed as hosted previews");
  for (const { input } of inputs.slice(1)) {
    const other = input.publicReview;
    if (!input.preview || other.pullRequest.origin !== pr.origin || other.pullRequest.repository !== pr.repository || other.pullRequest.number !== pr.number
      || other.pullRequest.head.sha !== pr.head.sha || other.pullRequest.base.sha !== pr.base.sha || other.runId !== review.runId || other.runAttempt !== review.runAttempt) {
      throw previewError("PREVIEW_REPORTS_MISMATCH", "The target reports do not come from the same review run", "Deploy only the reports this workflow run produced for the same PR head.");
    }
  }
  const exportPath = resolve(options.exportPath ?? PREVIEW_EXPORT_PATH);
  await assertExport(exportPath);

  const reports: SealedReport[] = [];
  for (const { entry, input, target } of inputs) {
    let zip: Uint8Array;
    try { zip = await zipReportDirectory(entry.reportPath); }
    catch (error) { throw toCiError(error, { code: "REPORT_ZIP_FAILED", stage: "export",
      nextAction: "Pass the ci:report output directory downloaded from this run's explore-review artifact." }); }
    reports.push({ entry, input, ...(target ? { target } : {}), zip, sha256: createHash("sha256").update(zip).digest("hex"), file: multi && target ? `${target.id}.zip.enc` : "report.zip.enc" });
  }

  const reportDirectory = base32(random(10));
  const expiresAt = first.preview.expiresAfterDays === null ? null : now() + first.preview.expiresAfterDays * 86_400_000;
  const project = previewProjectSlug(pr.repository, first.preview.project);
  const listing = multi ? previewReportListing(reports.map(report => ({ ...report, target: report.target! })), reportDirectory) : undefined;
  let hosted: Awaited<ReturnType<typeof deploySealedReports>>;
  try {
    hosted = await deploySealedReports({
    reports: reports.map(report => ({ zip: report.zip, sha256: report.sha256, file: report.file, query: multi && report.target ? targetQuery(report.target) : "" })),
    reportDirectory, ...(listing ? { listing } : {}), project, ...(first.preview.owner ? { owner: first.preview.owner } : {}),
    ownerHint: "Set report.preview.owner in .expo-explore/config.yaml to the account that should hold the preview project.",
    projectHint: "Give EXPO_TOKEN's account permission to create projects, or set report.preview.project to an existing project it can deploy to.",
    expiresAt, exportPath, environment, run, transport, now, random, ...(options.sleep ? { sleep: options.sleep } : {}),
    // The runner masks secrets in job summaries too, so a masked token would reach a comparison's summary as ***.
    // Its link appears nowhere else (not in the log), as a PR's appears only in its comment, for the same readers.
    ...(options.onSecret && pr.origin !== "compare" ? { onSecret: options.onSecret } : {}),
    verifyTimeoutMs: options.verifyTimeoutMs ?? 180_000 });
  } catch (error) {
    // The report job's comment says the report is deploying; it must now offer the download-and-drop flow instead.
    if (pr.origin !== "compare") for (const report of reports) {
      try {
        await publishCiReportComment({ inputPath: report.entry.inputPath, artifactUrl: report.entry.artifactUrl, environment, transport,
          ...commentTarget(report), previewFailed: true });
      } catch { /* the deployment failure is the one to report */ }
    }
    throw error;
  }
  const previewUrl = hosted.previewUrl;
  // A comparison has no pull request: its link goes to the run's summary, which the same repository readers see.
  if (pr.origin === "compare") await writeCompareSummary(environment, pr, previewUrl, expiresAt, reports.map(report => report.input));
  {
    let headSha = pr.head.sha;
    if (pr.origin !== "compare") for (const report of reports) {
      const published = await publishCiReportComment({ inputPath: report.entry.inputPath, artifactUrl: report.entry.artifactUrl, environment, transport,
        ...commentTarget(report), preview: { url: previewUrl, expiresAt } });
      headSha = published.headSha;
    }
    return { previewUrl, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), deploymentId: hosted.deploymentId, deploymentUrl: hosted.deploymentUrl,
      project, owner: hosted.owner, reportSha256: reports[0]!.sha256, reportBytes: reports[0]!.zip.byteLength,
      reports: reports.map(report => ({ ...(report.entry.platform ? { platform: report.entry.platform } : {}), ...(report.target ? { target: report.target } : {}), artifactUrl: report.entry.artifactUrl,
        reportSha256: report.sha256, reportBytes: report.zip.byteLength })), headSha,
      ...(pr.origin === "compare" ? { linkedFromRunSummary: true as const } : {}) };
  }
}

/** Which comment section and artifact a report is: its target, or (single-report runs) none. */
function commentTarget(report: SealedReport): { target?: string; platform?: ExplorePlatform } {
  if (report.target) return { target: report.target.id, platform: report.target.platform };
  return report.entry.platform ? { platform: report.entry.platform } : {};
}

/** The comparison's job summary: what was compared, the hosted link, and each target's change count. */
export function renderCompareSummary(comparison: CompareReviewPresentation, previewUrl: string, expiresAt: number | null, inputs: CiReportInput[]): string {
  const platforms = inputs.map(input => {
    const changes = reviewChangeCount(input.commentState);
    const device = reviewDevice(input.commentState);
    const label = readTarget(input.publicReview.runtime.target)?.label ?? (input.publicReview.runtime.platform === "android" ? "Android" : "iOS");
    return `- ${label}${device ? ` (${device})` : ""}: ${changes === undefined ? "no review" : `${changes} ${changes === 1 ? "change" : "changes"}`}`;
  });
  return [`### Explore: ${compareTitleMarkdown(comparison)}`, "",
    `[Open the report](${previewUrl}) · [${comparison.base.sha.slice(0, 8)}..${comparison.head.sha.slice(0, 8)}](${comparison.url})`
      + (expiresAt === null ? "" : ` · link expires ${new Date(expiresAt).toISOString().slice(0, 10)}`), "",
    ...platforms, ""].join("\n");
}

async function writeCompareSummary(environment: NodeJS.ProcessEnv, comparison: CompareReviewPresentation, previewUrl: string, expiresAt: number | null, inputs: CiReportInput[]) {
  const path = environment.GITHUB_STEP_SUMMARY;
  if (!path) return;
  await appendFile(path, renderCompareSummary(comparison, previewUrl, expiresAt, inputs));
}

type HostedReportInput = { zip: Uint8Array; sha256: string; file: string; query: string };
export type HostedDeployment = { previewUrl: string; expiresAt: string | null; deploymentId: string; deploymentUrl: string; aliasUrl?: string; project: string; owner: string };

/** EAS Hosting alias names: lowercase slugs, as `eas deploy --alias` normalises them. */
export const HOSTING_ALIAS = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
/** The `/p/<token>` segment the Worker gates on (viewer-host PREVIEW_TOKEN). */
export const HOSTED_TOKEN = /^[a-z2-7]{32}$/;

/**
 * Seal the report ZIPs, deploy the exported Viewer around them to EAS Hosting, and verify the live bytes.
 * Shared by the PR preview (`ci:deploy`) and standalone exploration reports; it knows nothing about GitHub.
 */
async function deploySealedReports(options: {
  reports: HostedReportInput[]; reportDirectory: string; listing?: ReturnType<typeof previewReportListing>; project: string; owner?: string;
  ownerHint: string; projectHint: string; expiresAt: number | null; exportPath: string; environment: NodeJS.ProcessEnv; run: typeof defaultRun;
  transport: typeof fetch; now: () => number; random: (bytes: number) => Uint8Array; onSecret?: (secret: string) => void; verifyTimeoutMs: number;
  /** `eas deploy --alias`: a fixed host that always serves the newest deployment, for links that must not change between runs. */
  alias?: string;
  /** A caller-chosen `/p/<token>`; with `alias`, the hosted link is identical from one run to the next. */
  token?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<HostedDeployment> {
  const { reports, reportDirectory, listing, project, environment, run, transport, now, random, expiresAt } = options;
  const token = options.token ?? base32(random(20)); const key = random(32);
  options.onSecret?.(token);
  // `eas deploy` reads the sealed .env through @expo/env, where any variable already in its own environment wins,
  // even an empty one: an inherited EXPLORE_PREVIEW_* would replace the sealed value and every route would 404.
  const easEnvironment = { ...Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("EXPLORE_PREVIEW_"))),
    CI: "1", EXPO_NO_TELEMETRY: "1" };
  // Run the pinned CLI through this Node binary: the deploy job has no node on PATH for spawned shebang scripts to rely on.
  let eas: string;
  try { eas = packageBin("eas-cli", "eas"); await lstat(eas); }
  catch { throw deployError("EXPLORE_TOOLS_MISSING", "The EAS CLI that Explore pins is not installed.", "Reinstall @expo/explore with optional dependencies in the deploy job."); }
  const work = await mkdtemp(join(tmpdir(), "explore-preview-"));
  try {
    await cp(options.exportPath, join(work, "dist"), { recursive: true });
    const sealedDirectory = join(work, "dist", "client", "_report", reportDirectory);
    await mkdir(sealedDirectory, { recursive: true });
    for (const report of reports) await writeFile(join(sealedDirectory, report.file), sealReport(report.zip, key, random(12)));
    await writeFile(join(work, ".env"), [
      `EXPLORE_PREVIEW_TOKEN=${token}`,
      `EXPLORE_PREVIEW_KEY=${Buffer.from(key).toString("base64")}`,
      ...(expiresAt === null ? [] : [`EXPLORE_PREVIEW_EXPIRES_AT=${new Date(expiresAt).toISOString()}`]),
      listing ? `EXPLORE_PREVIEW_REPORTS=${JSON.stringify(listing)}` : `EXPLORE_PREVIEW_REPORT=/_report/${reportDirectory}/${reports[0]!.file}`,
      "",
    ].join("\n"), { mode: 0o600 });

    const who = run(process.execPath, [eas, "whoami"], { cwd: work, env: easEnvironment });
    const accounts = who.status === 0 ? whoamiAccounts(who.stdout) : [];
    // On a laptop without EXPO_TOKEN the deploy uses your `eas login`, and the messages say so.
    const login = environment.EXPO_TOKEN?.trim() ? "EXPO_TOKEN" : "Your EAS login";
    if (!accounts.length) throw deployError("EAS_NOT_AUTHENTICATED", login === "EXPO_TOKEN" ? "The EAS CLI could not sign in with EXPO_TOKEN." : "You are not logged in to EAS.",
      login === "EXPO_TOKEN" ? "Use a valid EXPO_TOKEN for a robot user of the app's Expo account." : "Run eas login (or set EXPO_TOKEN), then rerun.", { details: { stderr: lastLine(who.stderr) } });
    const owner = options.owner ?? (accounts.length === 1 ? accounts[0]! : undefined);
    if (!owner || !accounts.includes(owner)) throw deployError("PREVIEW_OWNER_AMBIGUOUS",
      owner ? `${login} has no access to the Expo account ${owner}.` : `${login} can deploy to several Expo accounts: ${accounts.join(", ")}.`,
      options.ownerHint, { details: { accounts } });
    await writeFile(join(work, "package.json"), JSON.stringify({ name: project, version: "0.0.0", private: true }));
    await writeFile(join(work, "app.json"), JSON.stringify({ expo: { name: `${project}`, slug: project, owner, web: { output: "server" } } }));
    const init = run(process.execPath, [eas, "init", "--force", "--non-interactive", "--json"], { cwd: work, env: easEnvironment });
    if (init.status !== 0) throw deployError("PREVIEW_PROJECT_FAILED", `EAS could not create or link the preview project @${owner}/${project}: ${lastLine(init.stderr || init.stdout)}`,
      options.projectHint, { details: { project, owner } });
    const hostedOrigin = (value: string | undefined): URL | undefined => {
      const url = value ? new URL(value) : undefined;
      return url && url.protocol === "https:" && url.hostname.endsWith(".expo.app") && url.pathname === "/" ? url : undefined;
    };
    // `eas deploy` is one upload plus a few API calls; an API error on one attempt ("GraphQL request failed") is resent
    // with a pause rather than failing the job, and every attempt's output goes to the job log, since eas only prints
    // the error's detail above its last line.
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds)));
    let deploy!: ReturnType<CommandRunner>;
    let deployment: { url?: string; identifier?: string; aliases?: Array<{ url?: string; name?: string }> } = {};
    let deploymentUrl: URL | undefined;
    for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS; attempt += 1) {
      deploy = run(process.execPath, [eas, "deploy", "--json", "--non-interactive", "--export-dir", "dist", ...(options.alias ? ["--alias", options.alias] : [])], { cwd: work, env: easEnvironment });
      deployment = {};
      try { deployment = JSON.parse(deploy.stdout.slice(deploy.stdout.indexOf("{"))) as typeof deployment; } catch { /* reported below */ }
      deploymentUrl = hostedOrigin(deployment.url);
      if (deploy.status === 0 && deploymentUrl && /^[a-z0-9]{1,32}$/.test(deployment.identifier ?? "")) break;
      // An account at its alias quota rejects every attempt the same way, and each attempt has already created a deployment.
      const aliasLimit = ALIAS_LIMIT.exec(deploy.stderr || deploy.stdout);
      if (aliasLimit) {
        throw deployError("PREVIEW_ALIAS_LIMIT", `EAS Hosting could not assign the alias ${options.alias}: ${aliasLimit[0]}`,
          `Delete the aliases of closed pull requests on @${owner}/${project} (eas deploy:alias:delete pr-<n> --non-interactive) or raise the account's plan, then rerun the deploy job.`,
          { retryable: false, details: { project, owner, alias: options.alias, output: commandOutput(deploy, environment.EXPO_TOKEN) } });
      }
      process.stderr.write(`eas deploy attempt ${attempt} of ${DEPLOY_ATTEMPTS} failed (exit ${deploy.status}):\n${commandOutput(deploy, environment.EXPO_TOKEN)}\n`);
      if (attempt < DEPLOY_ATTEMPTS) await sleep(DEPLOY_RETRY_DELAYS_MS[attempt - 1] ?? DEPLOY_RETRY_DELAYS_MS.at(-1)!);
    }
    if (!deploymentUrl) {
      throw deployError("PREVIEW_DEPLOY_FAILED", `EAS Hosting deployment failed ${DEPLOY_ATTEMPTS} times: ${lastLine(deploy.stderr || deploy.stdout)}`,
        "Check the EAS Hosting status for the preview project and rerun the deploy job; the eas output of every attempt is in the job log.",
        { retryable: true, details: { project, owner, attempts: DEPLOY_ATTEMPTS, output: commandOutput(deploy, environment.EXPO_TOKEN) } });
    }
    const aliasUrl = options.alias ? hostedOrigin(deployment.aliases?.find(candidate => candidate.name === options.alias)?.url) : undefined;
    if (options.alias && !aliasUrl) {
      throw deployError("PREVIEW_DEPLOY_FAILED", `EAS Hosting deployed ${deploymentUrl.origin} but did not report the alias ${options.alias}.`,
        "Check the deployment's aliases in the EAS Hosting dashboard and rerun.", { retryable: true, details: { project, owner, alias: options.alias } });
    }
    const verify = (origin: string, alias = false) => verifyDeployment({ origin, token, transport, now, timeoutMs: options.verifyTimeoutMs, alias,
      reports: reports.map(report => ({ query: report.query, sha256: report.sha256, bytes: report.zip.byteLength })),
      ...(listing ? { listing: JSON.stringify(listing.map(({ path: _path, ...rest }) => rest)) } : {}) });
    const seconds = (milliseconds: number) => `${Math.round(milliseconds / 1000)} s after eas deploy returned`;
    const served = await verify(deploymentUrl.origin);
    process.stderr.write(`Deployment ${deploymentUrl.origin} serves this run's report (${seconds(served.liveAfterMs)}).\n`);
    // The alias moves to the new deployment after the deployment itself is live — usually within seconds, but it has
    // taken longer than the whole budget (every verification failure of 2026-10-14 was the alias, with the deployment
    // serving in 1 s). The deployment is verified and immutable, so when the alias is still behind the pull request
    // links the deployment instead of failing the job; the alias catches up on its own and the next push relinks it.
    let linkOrigin = deploymentUrl.origin;
    if (aliasUrl) {
      try {
        const alias = await verify(aliasUrl.origin, true);
        process.stderr.write(`Alias ${aliasUrl.origin} serves it too (${seconds(alias.liveAfterMs)}).\n`);
        linkOrigin = aliasUrl.origin;
      } catch (error) {
        if ((error as { code?: string }).code !== "PREVIEW_ALIAS_BEHIND") throw error;
        process.stderr.write(`::warning::${(error as Error).message} The pull request links the deployment ${deploymentUrl.origin} instead.\n`);
      }
    }
    const previewUrl = `${linkOrigin}/p/${token}`;
    return { previewUrl, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), deploymentId: deployment.identifier!, deploymentUrl: deploymentUrl.origin,
      ...(aliasUrl ? { aliasUrl: aliasUrl.origin } : {}), project, owner };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export type ExplorationDeployOptions = {
  /** The `explore:binary` report directory (exploration.json plus assets/). */
  reportPath: string;
  /** The explored app's platform, listed so the Worker does not take the report for iOS. */
  platform?: ExplorePlatform;
  project: string;
  owner?: string;
  /** Days until the hosted link stops serving the report; null never expires. */
  expiresAfterDays: number | null;
  exportPath?: string;
  environment?: NodeJS.ProcessEnv;
  run?: typeof defaultRun;
  sleep?: (milliseconds: number) => Promise<void>;
  transport?: typeof fetch;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  onSecret?: (secret: string) => void;
  verifyTimeoutMs?: number;
  /** EAS Hosting alias for the deployment (`eas deploy --alias`): one host per app that always serves the newest run. */
  alias?: string;
  /** A fixed `/p/<token>` (32 base32 characters); with `alias` the link never changes between runs. */
  token?: string;
};

/** Host a standalone exploration report: no pull request, no GitHub token, the same sealed ZIP and token-gated Viewer as PR previews. */
export async function deployExplorationReport(options: ExplorationDeployOptions): Promise<HostedDeployment & { reportSha256: string; reportBytes: number }> {
  const environment = options.environment ?? process.env;
  if (!environment.EXPO_TOKEN?.trim() && !environment.EXPO_SESSION_SECRET?.trim() && !environment.HOME) throw new CiError({ code: "EXPO_LOGIN_REQUIRED", stage: "preflight",
    message: "An EAS login is required to host the report", nextAction: "Run `eas login` or set EXPO_TOKEN, then rerun with --upload." });
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(options.project)) throw previewError("PREVIEW_PROJECT_INVALID", `Invalid EAS project slug: ${options.project}`, "Pass --project as a lowercase slug such as expo-explore.");
  if (options.alias !== undefined && !HOSTING_ALIAS.test(options.alias)) throw previewError("PREVIEW_ALIAS_INVALID", `Invalid EAS Hosting alias: ${options.alias}`, "Pass --alias as a lowercase slug such as bluesky.");
  if (options.token !== undefined && !HOSTED_TOKEN.test(options.token)) throw previewError("PREVIEW_TOKEN_INVALID", "EXPLORE_PREVIEW_TOKEN must be 32 characters of a-z and 2-7.", "Generate one with `LC_ALL=C tr -dc a-z2-7 </dev/urandom | head -c 32` and set EXPLORE_PREVIEW_TOKEN, or unset it for a random token.");
  const exportPath = resolve(options.exportPath ?? PREVIEW_EXPORT_PATH);
  await assertExport(exportPath);
  let zip: Uint8Array;
  try { zip = await zipReportDirectory(options.reportPath); }
  catch (error) { throw toCiError(error, { code: "REPORT_ZIP_FAILED", stage: "export", nextAction: "Pass the report directory explore:binary wrote." }); }
  const random = options.random ?? (bytes => new Uint8Array(randomBytes(bytes)));
  const now = options.now ?? Date.now;
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const reportDirectory = base32(random(10));
  const target = options.platform ? platformTarget(options.platform) : undefined;
  const file = target ? `${target.id}.zip.enc` : "report.zip.enc";
  const hosted = await deploySealedReports({ reports: [{ zip, sha256, file, query: target ? targetQuery(target) : "" }], reportDirectory,
    ...(target ? { listing: [listingEntry(target, `/_report/${reportDirectory}/${file}`)] } : {}), project: options.project,
    ...(options.owner ? { owner: options.owner } : {}), ownerHint: "Pass --owner with the Expo account that should host the report.",
    projectHint: "Give this EAS login permission to create projects under the owner, or pass --project with an existing slug.",
    expiresAt: options.expiresAfterDays === null ? null : now() + options.expiresAfterDays * 86_400_000, exportPath, environment, run: options.run ?? defaultRun, ...(options.sleep ? { sleep: options.sleep } : {}),
    transport: options.transport ?? fetch, now, random, ...(options.onSecret ? { onSecret: options.onSecret } : {}), verifyTimeoutMs: options.verifyTimeoutMs ?? 180_000,
    ...(options.alias ? { alias: options.alias } : {}), ...(options.token ? { token: options.token } : {}) });
  return { ...hosted, reportSha256: sha256, reportBytes: zip.byteLength };
}

export type FixturePreviewOptions = {
  /** Report ZIPs as a hosted preview serves them from report.zip, one per target (`platform` alone: the platform's target), with what the switch says of each. */
  reports: Array<{ platform: ExplorePlatform; target?: RunTarget; zipPath: string; changes?: number; device?: string }>;
  project: string;
  owner?: string;
  alias: string;
  /** The `/p/<token>` to keep; a new one is drawn when absent. */
  token?: string;
  exportPath?: string;
  environment?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  transport?: typeof fetch;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  onSecret?: (secret: string) => void;
  verifyTimeoutMs?: number;
};

/**
 * Host fixed reports behind a fixed alias with this checkout's Viewer: the Explore repository's own pull requests
 * preview their Viewer changes on real data. No GitHub token, no expiry; each run replaces what the alias serves.
 */
export async function deployFixturePreview(options: FixturePreviewOptions): Promise<HostedDeployment> {
  const environment = options.environment ?? process.env;
  if (!environment.EXPO_TOKEN?.trim() && !environment.EXPO_SESSION_SECRET?.trim() && !environment.HOME) throw new CiError({ code: "EXPO_LOGIN_REQUIRED", stage: "preflight",
    message: "An EAS login is required to deploy the Viewer preview", nextAction: "Run `eas login` or set EXPO_TOKEN." });
  if (!HOSTING_ALIAS.test(options.alias)) throw previewError("PREVIEW_ALIAS_INVALID", `Invalid EAS Hosting alias: ${options.alias}`, "Pass --alias as a lowercase slug such as pr-123.");
  if (options.token !== undefined && !HOSTED_TOKEN.test(options.token)) throw previewError("PREVIEW_TOKEN_INVALID", "The preview token must be 32 characters of a-z and 2-7.", "Pass the /p/<token> segment of the previous preview link, or none for a new one.");
  assertTargets(options.reports.map(report => report.target ?? platformTarget(report.platform)), "A fixture preview needs one report per target", "Pass each target's report ZIP once.");
  const exportPath = resolve(options.exportPath ?? PREVIEW_EXPORT_PATH);
  await assertExport(exportPath);
  const random = options.random ?? (bytes => new Uint8Array(randomBytes(bytes)));
  const reportDirectory = base32(random(10));
  const reports = await Promise.all(options.reports.map(async report => {
    const zip = new Uint8Array(await readFile(report.zipPath));
    const target = report.target ?? platformTarget(report.platform);
    return { ...report, target, zip, sha256: createHash("sha256").update(zip).digest("hex"), file: `${target.id}.zip.enc` };
  }));
  const listing = reports.map(report => listingEntry(report.target, `/_report/${reportDirectory}/${report.file}`, report.changes, report.device));
  return deploySealedReports({
    reports: reports.map(report => ({ zip: report.zip, sha256: report.sha256, file: report.file, query: targetQuery(report.target) })),
    reportDirectory, listing, project: options.project, ...(options.owner ? { owner: options.owner } : {}),
    ownerHint: "Pass --owner with the Expo account that holds the preview project.",
    projectHint: "Give EXPO_TOKEN's account permission to create projects, or pass --project with an existing slug.",
    expiresAt: null, exportPath, environment, run: options.run ?? defaultRun, ...(options.sleep ? { sleep: options.sleep } : {}), transport: options.transport ?? fetch, now: options.now ?? Date.now, random,
    ...(options.onSecret ? { onSecret: options.onSecret } : {}), verifyTimeoutMs: options.verifyTimeoutMs ?? 180_000, alias: options.alias,
    ...(options.token ? { token: options.token } : {}) });
}

/**
 * Report ZIPs on this machine behind one token (`capture:review --upload`, `report:upload`), one per target: the same
 * sealed deployment as a PR preview, from ZIPs instead of GitHub artifacts, with the local EAS login or EXPO_TOKEN.
 */
export async function deployLocalReports(options: {
  /** One per target; an entry without `target` is its platform's target, as before targets. */
  reports: Array<{ platform: ExplorePlatform; target?: RunTarget; zip: Uint8Array; changes?: number; device?: string }>;
  project: string; owner?: string; expiresAfterDays: number | null;
  /** What to change when the owner or project is not usable; defaults name report.preview in config.yaml. */
  ownerHint?: string; projectHint?: string;
  exportPath?: string; environment?: NodeJS.ProcessEnv; run?: CommandRunner; sleep?: (milliseconds: number) => Promise<void>;
  transport?: typeof fetch; now?: () => number; random?: (bytes: number) => Uint8Array; verifyTimeoutMs?: number;
}): Promise<HostedDeployment> {
  const environment = options.environment ?? process.env;
  assertTargets(options.reports.map(report => report.target ?? platformTarget(report.platform)), "A local upload needs one report per target", "Capture each target once, then upload.");
  const exportPath = resolve(options.exportPath ?? PREVIEW_EXPORT_PATH);
  await assertExport(exportPath);
  const now = options.now ?? Date.now;
  const random = options.random ?? (bytes => new Uint8Array(randomBytes(bytes)));
  const reportDirectory = base32(random(10));
  // Always listed, even alone: the Worker takes an unlisted report for iOS, so an Android one would be mislabelled.
  const reports = options.reports.map(report => {
    const target = report.target ?? platformTarget(report.platform);
    return { ...report, target, sha256: createHash("sha256").update(report.zip).digest("hex"), file: `${target.id}.zip.enc` };
  });
  const listing = reports.map(report => listingEntry(report.target, `/_report/${reportDirectory}/${report.file}`, report.changes, report.device));
  return deploySealedReports({
    reports: reports.map(report => ({ zip: report.zip, sha256: report.sha256, file: report.file, query: targetQuery(report.target) })),
    reportDirectory, listing, project: options.project, ...(options.owner ? { owner: options.owner } : {}),
    ownerHint: options.ownerHint ?? "Set report.preview.owner in .expo-explore/config.yaml to the account that should hold the hosted reports.",
    projectHint: options.projectHint ?? "Make sure your Expo account can create projects, or set report.preview.project to an existing project you can deploy to.",
    expiresAt: options.expiresAfterDays === null ? null : now() + options.expiresAfterDays * 86_400_000, exportPath, environment,
    run: options.run ?? defaultRun, ...(options.sleep ? { sleep: options.sleep } : {}), transport: options.transport ?? fetch, now, random,
    verifyTimeoutMs: options.verifyTimeoutMs ?? 180_000 });
}

/** explore-(capture|review)-<run>-<attempt>-<target id>; the id starts with a letter, so the run and attempt end unambiguously. */
const ARTIFACT_DIRECTORY = /^explore-(capture|review)-\d+-\d+-([a-z][a-z0-9-]{0,31})$/;

/**
 * The fan-in deploy job's inputs: actions/download-artifact puts each explore-capture-<run>-<attempt>-<target>
 * directory under --inputs and each explore-review-… directory under --reports (the target is the platform for
 * configs without targets). Pairs them by target, in the order the run's review lists its targets, and looks up each
 * report artifact's URL on the run, since matrix jobs cannot hand their artifact URLs forward.
 */
export async function collectPlatformReports(options: { inputsPath: string; reportsPath: string; environment?: NodeJS.ProcessEnv; transport?: typeof fetch }): Promise<PreviewReportInput[]> {
  const environment = options.environment ?? process.env; const transport = options.transport ?? fetch;
  const directories = async (root: string, kind: "capture" | "review") => {
    const found = new Map<string, string>();
    for (const name of (await readdir(root)).sort()) {
      const match = ARTIFACT_DIRECTORY.exec(name);
      if (!match || match[1] !== kind || !isTargetId(match[2])) continue;
      if (found.has(match[2]!)) throw previewError("PREVIEW_REPORTS_INVALID", `Several ${kind} artifacts for ${match[2]} were downloaded`,
        "Download only this run attempt's artifacts into the --inputs and --reports directories.");
      found.set(match[2]!, join(root, name));
    }
    return found;
  };
  const inputs = await directories(options.inputsPath, "capture"); const reports = await directories(options.reportsPath, "review");
  if (!inputs.size) throw previewError("PREVIEW_REPORTS_MISSING", "No explore-capture-<run>-<attempt>-<target> artifact was downloaded",
    "Download this run's explore-capture artifacts into the --inputs directory before ci:deploy.");
  if (inputs.size > 8) throw previewError("PREVIEW_REPORTS_INVALID", `${inputs.size} capture artifacts were downloaded; a run has at most 8 targets`,
    "Download only this run attempt's artifacts into the --inputs and --reports directories.");
  const entries: PreviewReportInput[] = [];
  for (const [id, inputDirectory] of inputs) {
    const reportPath = reports.get(id);
    if (!reportPath) throw previewError("PREVIEW_REPORTS_INCOMPLETE", `The ${id} capture has no report artifact to deploy`,
      "Rerun the workflow; the report job for that target did not upload its explore-review artifact.");
    const inputPath = join(inputDirectory, "report-input.json");
    const runtime = (await readCiReportInput(inputPath)).publicReview.runtime;
    // A report from before targets names only its platform, and its artifact is named after it.
    const named = readTarget(runtime.target);
    if (named && named.id !== id) throw previewError("PREVIEW_REPORTS_INVALID", `The ${id} capture artifact holds the report of ${named.id}`,
      "Download only this run attempt's artifacts, as the capture jobs named them.");
    const target = named ?? (id === "ios" || id === "android" ? platformTarget(id) : { id, platform: runtime.platform ?? "ios", label: id });
    entries.push({ ...(id === target.platform ? { platform: target.platform } : {}), target, inputPath, reportPath, artifactUrl: "" });
  }
  // Config order, as the review lists its targets (or, before targets, its platforms); directory order otherwise.
  const listed = (await readCiReportInput(entries[0]!.inputPath)).publicReview.runtime;
  const order: string[] = listed.targets?.map(target => target.id) ?? listed.platforms ?? [];
  const rank = (entry: PreviewReportInput) => { const index = order.indexOf(entry.target!.id); return index === -1 ? order.length : index; };
  entries.sort((a, b) => rank(a) - rank(b));
  const review = (await readCiReportInput(entries[0]!.inputPath)).publicReview;
  if (review.pullRequest.origin === "local") throw new Error("Local reports cannot be deployed as hosted previews");
  const repository = review.pullRequest.repository;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^\d+$/.test(review.runId) || !/^\d+$/.test(review.runAttempt)) {
    throw previewError("REPORT_INPUT_INVALID", "The report input does not name a GitHub run", "Use the report-input.json produced by this run's capture job.");
  }
  for (const entry of entries) {
    const name = `explore-review-${review.runId}-${review.runAttempt}-${entry.target!.id}`;
    const url = `https://api.github.com/repos/${repository}/actions/runs/${review.runId}/artifacts?per_page=100&name=${encodeURIComponent(name)}`;
    const response = await transport(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${environment.GITHUB_TOKEN ?? ""}`,
      "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(60_000) });
    const body = response.ok ? await response.json() as { artifacts?: Array<{ id?: unknown; name?: unknown; expired?: unknown }> } : undefined;
    const artifact = body?.artifacts?.find(candidate => candidate.name === name && candidate.expired !== true);
    if (!artifact || typeof artifact.id !== "number" || !Number.isSafeInteger(artifact.id) || artifact.id <= 0) {
      throw deployError("REPORT_ARTIFACT_MISSING", `The run has no artifact named ${name} (HTTP ${response.status}).`,
        "Rerun the workflow so every target's report job uploads its artifact before the deploy job runs.", { retryable: true });
    }
    entry.artifactUrl = `https://github.com/${repository}/actions/runs/${review.runId}/artifacts/${artifact.id}`;
  }
  return entries;
}

/** The deployment must serve the Viewer and the exact reports at the token, and nothing anywhere else. */
async function verifyDeployment(check: { origin: string; token: string; reports: Array<{ query: string; sha256: string; bytes: number }>; listing?: string;
  transport: typeof fetch; now: () => number; timeoutMs: number; alias?: boolean }): Promise<{ liveAfterMs: number }> {
  const get = async (path: string, accept = "*/*") => {
    try {
      return await check.transport(`${check.origin}${path}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
        headers: { accept } });
    } catch (error) {
      throw deployError("PREVIEW_VERIFY_FAILED", "The hosted preview could not be reached after deployment.",
        "Check EAS Hosting availability and rerun the deploy job.", { retryable: true, cause: error });
    }
  };
  // What the token serves differs from what was deployed: a listing or report that does not match, or undefined.
  const mismatch = async (): Promise<CiError | undefined> => {
    for (const expected of check.reports) {
      const report = await get(`/p/${check.token}/report.zip${expected.query}`);
      const bytes = report.status === 200 ? new Uint8Array(await report.arrayBuffer()) : new Uint8Array();
      if (report.status !== 200 || bytes.byteLength !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
        return deployError("PREVIEW_VERIFY_FAILED", "The hosted preview did not serve the exact report that was deployed.",
          "Rerun the deploy job; the deployment's sealed key or ciphertext did not match.", { details: { status: report.status, report: expected.query } });
      }
      // What the Viewer opens: the manifest the deployed ZIP makes, and one of its assets byte for byte.
      const loaded = await loadReport(bytes);
      const manifest = await get(`/p/${check.token}/manifest.json${expected.query}`);
      const body = manifest.status === 200 ? await manifest.text() : "";
      const asset = loaded ? Object.keys(JSON.parse(manifestBody(loaded)).entries as Record<string, number>)[0] : undefined;
      const served = asset ? await get(`/p/${check.token}/${asset}${expected.query}`) : undefined;
      const assetBytes = served?.status === 200 ? new Uint8Array(await served.arrayBuffer()) : new Uint8Array();
      if (!loaded || body !== manifestBody(loaded)
        || (asset && createHash("sha256").update(assetBytes).digest("hex") !== asset.slice("assets/".length, "assets/".length + 64))) {
        return deployError("PREVIEW_VERIFY_FAILED", "The hosted preview did not serve the report's manifest and screenshots, which the Viewer opens.",
          "Rerun the deploy job; if it keeps failing, inspect the deployment in the EAS Hosting dashboard.",
          { details: { status: manifest.status, ...(served ? { assetStatus: served.status } : {}), report: expected.query } });
      }
    }
    if (check.listing !== undefined) {
      const list = await get(`/p/${check.token}/reports.json`);
      const body = list.status === 200 ? await list.text() : "";
      if (list.status !== 200 || body !== check.listing) return deployError("PREVIEW_VERIFY_FAILED", "The hosted preview did not list the targets that were deployed.",
        "Rerun the deploy job; the deployment's report listing did not match.", { details: { status: list.status } });
    }
    return undefined;
  };
  const started = check.now();
  let liveAfterMs = 0;
  for (;;) {
    // A browser's request: the token page negotiates, and anything that does not ask for HTML gets the Markdown index.
    const shell = await get(`/p/${check.token}`, "text/html");
    const serving = shell.status === 200 && (shell.headers.get("content-type") ?? "").startsWith("text/html");
    // An alias with a fixed token (the example report) serves the token page from the deployment it still points at, so
    // it has moved only once it serves this deployment's listing and reports as well.
    const stale = serving && check.alias ? await mismatch() : undefined;
    if (serving && !stale) { liveAfterMs = check.now() - started; break; }
    const waitedMs = check.now() - started;
    if (waitedMs > check.timeoutMs) {
      // An alias that does not serve the token page yet still points at an earlier deployment; the deployment itself not serving is a failed deployment.
      if (check.alias) throw deployError("PREVIEW_ALIAS_BEHIND", stale
        ? `The alias ${check.origin} still serves an earlier deployment ${Math.round(waitedMs / 1000)} s after eas deploy returned.`
        : `The alias ${check.origin} still answers HTTP ${shell.status} ${Math.round(waitedMs / 1000)} s after eas deploy returned.`,
        "Nothing to do: the alias catches up on its own, and the next push verifies it again.", { retryable: true, details: { origin: check.origin, status: shell.status, waitedMs } });
      throw deployError("PREVIEW_VERIFY_FAILED", `The hosted preview did not become available (HTTP ${shell.status}).`,
        "Rerun the deploy job; if the deployment keeps failing verification, inspect it in the EAS Hosting dashboard.", { retryable: true, details: { origin: check.origin, status: shell.status, waitedMs } });
    }
    await new Promise(done => setTimeout(done, 3_000));
  }
  const api = await get(`/p/${check.token}/api/v1`);
  if (api.status !== 200 || !(api.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw deployError("PREVIEW_VERIFY_FAILED", `The hosted preview did not answer the agent API (HTTP ${api.status}).`, "Rerun the deploy job; if the deployment keeps failing verification, inspect it in the EAS Hosting dashboard.", { retryable: true });
  }
  // The deployment itself serves exactly what was deployed or it failed; the alias was checked while it was polled.
  if (!check.alias) { const failure = await mismatch(); if (failure) throw failure; }
  const other = check.token.endsWith("a") ? `${check.token.slice(0, -1)}b` : `${check.token.slice(0, -1)}a`;
  // Errors name each probe by its shape: the near-miss token differs from the real one in its last character only.
  for (const [path, shape] of [["/", "/"], [`/p/${other}`, "/p/<wrong token>"], [`/p/${other}/report.zip`, "/p/<wrong token>/report.zip"],
    [`/p/${check.token}/viewer/index.html`, "/p/<token>/viewer/index.html"]] as const) {
    const response = await get(path);
    if (response.status !== 404) throw deployError("PREVIEW_VERIFY_FAILED", `The hosted preview answered HTTP ${response.status} without a valid token at ${shape}.`,
      "Do not share this deployment; delete it in the EAS Hosting dashboard and report the issue to Explore.", { details: { path: shape, status: response.status } });
  }
  return { liveAfterMs };
}

