import { createHash } from "node:crypto";
import { cp, lstat, realpath, mkdtemp, mkdir, writeFile, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, basename, dirname, resolve, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SourceRoute } from "../contracts/source-route.js";
import { CiError } from "../shared/ci-errors.js";
import { EXPLORE_VERSION } from "../shared/package-paths.js";
import { prepareCaptureObserver, captureObserverParameterKeys } from "./observer.js";
import { isRecord, parseJson, nonEmpty } from "./common.js";
import { isWithin } from "./fs-safety.js";
import type { CommandRunner } from "./run.js";

function fingerprintHashFrom(value: unknown, label: string): string {
  if (!isRecord(value) || typeof value.hash !== "string" || !value.hash) {
    throw new Error(`${label} did not return a hash`);
  }
  if (!/^[A-Za-z0-9._:-]{1,512}$/.test(value.hash)) {
    throw new Error(`${label} returned an unsafe hash`);
  }
  return value.hash;
}

export function fingerprintFrom(stdout: string): string {
  return fingerprintHashFrom(
    parseJson(stdout, "eas fingerprint:generate"),
    "eas fingerprint:generate",
  );
}

export function hasEasEnvironmentFetchFailure(stderr: string): boolean {
  return stderr.includes("Failed to pull env variables for environment ");
}

/** Which checkout `eas config` was resolved in. A review resolves it twice, once per side. */
export type EasProfileSource = { side: "base" | "head"; commit: string };

/**
 * The resolved `eas config` output must describe a simulator build of the configured app.
 * With a `source`, the error names the side and commit: a PR that fixes eas.json still fails on
 * the base side, whose checkout has its own eas.json, until the fix is on the default branch.
 */
export function assertCaptureEasProfile(configValue: { appConfig: Record<string, unknown>; buildProfile: Record<string, unknown> }, bundleId: string,
  platform: "ios" | "android" = "ios", source?: EasProfileSource): void {
  const where = source ? ` at the ${source.side} commit ${source.commit.slice(0, 8)}` : "";
  const profileFix = (setting: string) => `Set ${setting} on the selected profile in eas.json`
    + (source?.side === "base" ? " on the default branch (the base side is built from its own checkout), then rerun Explore." : ", then rerun Explore.");
  const bundleIdFix = (field: string) => `Set app.bundleId to the ${field} resolved by the selected EAS profile`
    + (source?.side === "base" ? ", or land the app config change on the default branch first." : ".");
  if (platform === "android") {
    // `eas config` resolves the platform section into the profile, so buildType sits beside distribution.
    // EAS Simulator installs APKs; internal distribution builds one unless the profile asks for an app bundle.
    const { buildType, distribution } = configValue.buildProfile;
    const apk = buildType === "apk" || (buildType === undefined && distribution === "internal");
    if (!apk || configValue.buildProfile.developmentClient === true) throw new CiError({ code: "EAS_PROFILE_NOT_SIMULATOR", stage: "configuration",
      message: `The selected EAS build profile${where} does not produce an Android emulator APK that opens the app directly.`,
      nextAction: profileFix("android.buildType: apk (without developmentClient)") });
    const configuredAndroid = configValue.appConfig.android;
    if (!isRecord(configuredAndroid) || configuredAndroid.package !== bundleId) throw new CiError({ code: "APP_BUNDLE_ID_MISMATCH", stage: "configuration",
      message: `The configured app package differs from the EAS app configuration resolved${where}.`,
      nextAction: bundleIdFix("android.package") });
    return;
  }
  if (configValue.buildProfile.simulator !== true) throw new CiError({ code: "EAS_PROFILE_NOT_SIMULATOR", stage: "configuration",
    message: `The selected EAS build profile${where} does not produce an iOS Simulator application.`,
    nextAction: profileFix("ios.simulator: true") });
  const configuredIos = configValue.appConfig.ios;
  if (!isRecord(configuredIos) || configuredIos.bundleIdentifier !== bundleId) throw new CiError({ code: "APP_BUNDLE_ID_MISMATCH", stage: "configuration",
    message: `The configured app bundle identifier differs from the EAS app configuration resolved${where}.`,
    nextAction: bundleIdFix("ios.bundleIdentifier") });
}

export function assertSimulatorAvailable(stdout: string): void {
  const availability = parseJson(stdout, "simulator availability");
  if (!isRecord(availability) || availability.available !== true) throw new CiError({ code: "SIMULATOR_UNAVAILABLE", stage: "preflight",
    message: "EAS Simulator is not available for this account.", nextAction: "Enable EAS Simulator access for the configured Expo account before running capture." });
}

/**
 * Names of `eas env:list` variables that capture cannot reproduce when it repacks a build:
 * secret-visibility values never leave EAS builders, and file variables are not repacked.
 */
export function unreproducibleEasVariables(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=\*{5} \(This is a (secret|file) env variable/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return [...names].sort();
}

function buildIdFrom(value: unknown, label: string): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id) {
    throw new Error(`${label} did not return a build id`);
  }
  if (!/^[A-Za-z0-9._:-]{1,512}$/.test(candidate.id)) {
    throw new Error(`${label} returned an unsafe build id`);
  }
  return candidate.id;
}

export function nativeBuildFrom(stdout: string): EasBuildDescriptor & { fingerprint: string } {
  const value = parseJson(stdout, "eas build");
  const candidate = Array.isArray(value) ? value[0] : value;
  const id = buildIdFrom(candidate, "eas build");
  if (!isRecord(candidate)) {
    throw new Error("eas build did not return a build");
  }
  return {
    ...easBuildDescriptor(candidate, id, "eas build"),
    fingerprint: fingerprintHashFrom(candidate.fingerprint, "eas build fingerprint"),
  };
}

export function existingBuild(stdout: string): EasBuildDescriptor | undefined {
  const value = parseJson(stdout, "eas build:list");
  if (!Array.isArray(value)) throw new Error("eas build:list did not return a build list");
  if (value.length === 0) return undefined;
  const id = buildIdFrom(value, "eas build:list");
  const candidate = value[0];
  return isRecord(candidate) ? easBuildDescriptor(candidate, id, "eas build:list") : { id };
}

async function downloadedAppPath(stdout: string, privateRoot: string, platform: "ios" | "android" = "ios"): Promise<string> {
  const value = parseJson(stdout, "eas build:download");
  if (!isRecord(value) || typeof value.path !== "string" || !isAbsolute(value.path)) {
    throw new Error("eas build:download did not return an absolute application path");
  }
  if (/\u0000|[\u0001-\u001f\u007f]/.test(value.path)) {
    throw new Error("eas build:download returned an unsafe application path");
  }
  const declaredInfo = await lstat(value.path);
  if (platform === "android") {
    if (declaredInfo.isSymbolicLink() || !declaredInfo.isFile()) {
      throw new Error("eas build:download must return a non-symlink Android .apk file");
    }
  } else if (declaredInfo.isSymbolicLink() || !declaredInfo.isDirectory()) {
    throw new Error("eas build:download must return a non-symlink iOS .app directory");
  }
  const canonical = await realpath(value.path);
  if (!basename(canonical).endsWith(platform === "android" ? ".apk" : ".app")) {
    throw new Error(platform === "android" ? "eas build:download must return an Android .apk file" : "eas build:download must return an iOS .app directory");
  }
  const canonicalRoot = await realpath(privateRoot);
  if (!isWithin(canonicalRoot, canonical)) {
    throw new Error("eas build:download returned an application outside its private directory");
  }
  return canonical;
}

export type RepackProfile = {
  easEnvironment: string;
  profileEnvironment: Record<string, string>;
  projectIdentity: {
    name: string;
    slug: string;
    owner: string;
    projectId: string;
    /** `expo.version` from the resolved app config, when declared. */
    version?: string;
    /** `expo.ios.buildNumber` from the resolved app config, when declared. */
    buildNumber?: string;
  };
};

/** A finished EAS build as `eas build:list --json` / `eas build --json` describe it. */
type EasBuildDescriptor = {
  id: string;
  appVersion?: string;
  appBuildVersion?: string;
};

function optionalAppText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || /[^\x20-\x7e]/.test(trimmed)) {
    throw new Error(`${label} must be 64 printable ASCII characters or fewer`);
  }
  return trimmed;
}

function easBuildDescriptor(candidate: Record<string, unknown>, id: string, label: string): EasBuildDescriptor {
  const appVersion = optionalAppText(candidate.appVersion, `${label} appVersion`);
  const appBuildVersion = optionalAppText(candidate.appBuildVersion, `${label} appBuildVersion`);
  return { id, ...(appVersion ? { appVersion } : {}), ...(appBuildVersion ? { appBuildVersion } : {}) };
}

function configValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`eas config did not return ${label}`);
  const result = nonEmpty(value, label);
  if (result.length > 512) throw new Error(`${label} is too long`);
  return result;
}

export function repackProfileFrom(stdout: string): RepackProfile {
  const value = parseJson(stdout, "eas config");
  if (!isRecord(value) || !isRecord(value.buildProfile) || !isRecord(value.appConfig)) {
    throw new Error("eas config did not return a build profile and app configuration");
  }
  const buildProfile = value.buildProfile;
  const profileEnvironment: Record<string, string> = Object.create(null);
  if (buildProfile.env !== undefined) {
    if (!isRecord(buildProfile.env)) {
      throw new Error("eas config returned an invalid build-profile environment");
    }
    for (const [name, environmentValue] of Object.entries(buildProfile.env)) {
      if (typeof environmentValue !== "string") {
        throw new Error("eas config returned an invalid build-profile environment");
      }
      profileEnvironment[name] = environmentValue;
    }
  }
  const inferredEnvironment = buildProfile.distribution === "store"
    ? "production"
    : buildProfile.developmentClient === true
      ? "development"
      : "preview";
  const easEnvironment = buildProfile.environment === undefined
    ? inferredEnvironment
    : configValue(buildProfile.environment, "EAS build-profile environment");
  if (easEnvironment.length > 256) {
    throw new Error("EAS build-profile environment is too long");
  }
  const appConfig = value.appConfig;
  const extra = isRecord(appConfig.extra) ? appConfig.extra : undefined;
  const eas = extra && isRecord(extra.eas) ? extra.eas : undefined;
  const owner = configValue(appConfig.owner, "EAS app owner");
  const ios = isRecord(appConfig.ios) ? appConfig.ios : undefined;
  const version = optionalAppText(appConfig.version, "app config version");
  const buildNumber = optionalAppText(ios?.buildNumber, "app config ios.buildNumber");
  return {
    easEnvironment,
    profileEnvironment,
    projectIdentity: {
      name: configValue(appConfig.name, "EAS app name"),
      slug: configValue(appConfig.slug, "EAS app slug"),
      owner,
      projectId: configValue(eas?.projectId, "EAS project id"),
      ...(version ? { version } : {}),
      ...(buildNumber ? { buildNumber } : {}),
    },
  };
}

const protectedRepackEnvironmentNames = new Set([
  "CI",
  "HOME",
  "PATH",
  "SHELL",
  "TMP",
  "TEMP",
  "TMPDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "CDPATH",
  "EXPO_TOKEN",
  "EXPO_OVERRIDE_METRO_CONFIG",
]);

const EAS_PLAN_LIMIT_MESSAGE = /This account has used its [^|.]*plan this month[^|.]*/i;

/** `eas upload` counts repacked builds against the account's build plan; name the quota instead of the raw CLI dump. */
export function easPlanLimitError(error: unknown, platform: "ios" | "android"): CiError | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const match = EAS_PLAN_LIMIT_MESSAGE.exec(text);
  if (!match) return undefined;
  return new CiError({
    code: "EAS_PLAN_LIMIT_REACHED",
    stage: "instrumentation",
    message: `EAS refused the repacked ${platform} build upload because the account's build plan is used up: ${match[0].trim()}.`,
    nextAction: "Each review uploads one repacked build per side and platform. Wait for the plan's monthly reset or raise the EAS plan limit; a current baseline artifact for the default branch halves the uploads a review needs.",
    cause: error,
  });
}

class UnsupportedRepackEnvironmentError extends Error {
  override readonly name = "UnsupportedRepackEnvironmentError";
}

function assertSafeRepackEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new UnsupportedRepackEnvironmentError(
      `EAS environment variable ${name} cannot be represented safely during local repacking`,
    );
  }
  const upper = name.toUpperCase();
  if (
    protectedRepackEnvironmentNames.has(upper)
    || upper === "EAS_BUILD"
    || upper.startsWith("EAS_BUILD_")
    || upper.startsWith("LD_")
    || upper.startsWith("DYLD_")
    || upper.startsWith("NPM_CONFIG_")
  ) {
    throw new UnsupportedRepackEnvironmentError(
      `EAS environment variable ${name} cannot override the repack process environment`,
    );
  }
}

function assertSafeRepackEnvironmentValue(name: string, value: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UnsupportedRepackEnvironmentError(
      `EAS environment variable ${name} cannot be represented safely during local repacking`,
    );
  }
}

async function pulledEnvironment(options: {
  source: string;
  environment: string;
  fileRoot: string;
}): Promise<{ values: Record<string, string>; secretNames: string[] }> {
  const values: Record<string, string> = Object.create(null);
  const secretNames: string[] = [];
  const lines = options.source.split("\n");
  const expectedHeader = `# Environment: ${options.environment.toLowerCase()}`;
  if ((lines.shift() ?? "").replace(/\r$/, "") !== expectedHeader) {
    throw new Error("eas env:pull returned an unexpected environment header");
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const secret = /^# ([A-Za-z_][A-Za-z0-9_]*)=\*\*\*\*\* \(secret\)$/.exec(line);
    if (secret) {
      secretNames.push(secret[1]!);
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!assignment || /[\u0000-\u001f\u007f]/.test(assignment[2]!)) {
      throw new UnsupportedRepackEnvironmentError(
        "eas env:pull returned an unsupported environment assignment",
      );
    }
    const name = assignment[1]!;
    const environmentValue = assignment[2]!;
    assertSafeRepackEnvironmentName(name);
    if (environmentValue) {
      const candidateFile = resolve(environmentValue);
      if (isWithin(options.fileRoot, candidateFile)) {
        const info = await lstat(candidateFile);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error(`EAS file environment variable ${name} is not a regular file`);
        }
        const canonicalFile = await realpath(candidateFile);
        const canonicalRoot = await realpath(options.fileRoot);
        if (!isWithin(canonicalRoot, canonicalFile)) {
          throw new Error(`EAS file environment variable ${name} escapes its private directory`);
        }
        throw new UnsupportedRepackEnvironmentError(
          `EAS file environment variable ${name} cannot be reproduced safely during local repacking`,
        );
      }
    }
    values[name] = environmentValue;
  }
  return { values, secretNames };
}


export type RepackMode = "eas" | "local";

const HOSTED_REPACK_WORKFLOW = ".eas/workflows/expo-explore-repack.yml";
const HOSTED_OBSERVER_DIRECTORY = ".expo-explore-observer";

/** A one-job EAS workflow that repacks `buildId` with the staged copy's JavaScript and the route observer. */
export function hostedRepackWorkflow(input: {
  buildId: string;
  profile: string;
  environment: string;
  message: string;
}): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "# Generated by expo-explore for one capture of a staged checkout copy; nothing here is committed.",
    "name: expo-explore-repack",
    "on:",
    "  workflow_dispatch: {}",
    "jobs:",
    "  repack:",
    "    type: repack",
    `    environment: ${q(input.environment)}`,
    "    params:",
    `      build_id: ${q(input.buildId)}`,
    `      profile: ${q(input.profile)}`,
    "      js_bundle_only: true",
    "      embed_bundle_assets: true",
    `      message: ${q(input.message)}`,
    "    env:",
    // The uploaded copy has no .git; without this the job's build:internal step prompts for `git init`.
    '      EAS_NO_VCS: "1"',
    `      EXPO_OVERRIDE_METRO_CONFIG: ${q(`${HOSTED_OBSERVER_DIRECTORY}/metro.config.cjs`)}`,
    "",
  ].join("\n");
}

/**
 * Why a hosted repack failed, as far as its run tells: `app` when the app's own JavaScript or build environment broke it
 * (the "Repack" step), which a rerun repeats; `configuration` when the CLI was refused before a run started (a token or
 * workflow EAS rejects); `canceled` when someone stopped it; `infrastructure` when EAS failed around the repack (spin-up,
 * the upload of the app it made, a timeout); `unknown` when the run does not say.
 */
export type HostedRepackFailure = "app" | "configuration" | "canceled" | "infrastructure" | "unknown";

const APP_REPACK_FAILURE = /Build step "Repack(?: app)?" failed|Unable to resolve module|SyntaxError|TransformError|Error while bundling|Bundling failed|Cannot find module/i;
const CONFIGURATION_REPACK_FAILURE = /Not logged in|unauthori[sz]ed|not authorized|forbidden|permission|EXPO_TOKEN|validation error|invalid workflow|YAML/i;
// "Failed to upload application archive." is how the upload step reported "Turtle build is not in progress" in
// brentvatne/euxy#176 (review run 39506405687): EAS ended a build that had repacked, and a fresh repack succeeds.
const INFRASTRUCTURE_REPACK_FAILURE = /upload|download|not in progress|timed? ?out|timeout|worker|spin.?up|provision|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|fetch failed|server error|internal error|unavailable|\b5\d\d\b|SERVER_ERROR|EAS_BUILD_TIMEOUT_ERROR|Failed to start the workflow/i;

/** How many fresh repacks a failure earns: two after EAS's own failure, one after one nothing explains, none otherwise. */
export function hostedRepackRetries(error: unknown): number {
  const failure = error instanceof CiError && error.code === "EAS_REPACK_FAILED" ? error.details?.failure : undefined;
  return failure === "infrastructure" ? 2 : failure === "unknown" ? 1 : 0;
}

/** The repacked build id from `eas workflow:run --json`, or the job's failure as a readable error. */
export function hostedRepackBuildId(stdout: string, stderr: string, platform: "ios" | "android"): string {
  let logs = /See logs: (https:\/\/expo\.dev\/\S+)/.exec(stderr)?.[1];
  let value: unknown;
  try {
    value = parseJson(stdout, "eas workflow:run");
  } catch (error) {
    const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 600);
    const failure: HostedRepackFailure = CONFIGURATION_REPACK_FAILURE.test(tail) ? "configuration" : INFRASTRUCTURE_REPACK_FAILURE.test(tail) ? "infrastructure" : "unknown";
    throw new CiError({
      code: "EAS_REPACK_FAILED",
      stage: "instrumentation",
      message: `eas workflow:run did not report the hosted ${platform} repack: ${tail || (error instanceof Error ? error.message : String(error))}`,
      nextAction: `Check that EXPO_TOKEN can run workflows for this EAS project and retry.${logs ? ` Logs: ${logs}` : ""}`,
      details: { failure, ...(logs ? { logs } : {}) },
      cause: error,
    });
  }
  if (isRecord(value) && typeof value.url === "string" && /^https:\/\/expo\.dev\/\S+$/.test(value.url)) logs = value.url;
  const where = logs ? ` Logs: ${logs}` : "";
  const jobs = isRecord(value) && Array.isArray(value.jobs) ? value.jobs.filter(isRecord) : [];
  const job = jobs.find(entry => entry.key === "repack") ?? jobs[0];
  if (!job || job.status !== "SUCCESS") {
    const build = job && isRecord(job.turtleBuild) ? job.turtleBuild : undefined;
    const buildError = build && isRecord(build.error) ? build.error : undefined;
    const detail = typeof buildError?.message === "string" ? buildError.message.trim() : undefined;
    const planLimit = easPlanLimitError(new Error(`${detail ?? ""}\n${stderr}`), platform);
    if (planLimit) throw planLimit;
    const jobErrors = Array.isArray(job?.errors) ? job.errors.filter(isRecord).map(entry => `${String(entry.title ?? "")} ${String(entry.message ?? "")}`) : [];
    const evidence = [detail ?? "", typeof buildError?.errorCode === "string" ? buildError.errorCode : "", ...jobErrors].join("\n");
    const failure: HostedRepackFailure = job?.status === "CANCELED" ? "canceled" : APP_REPACK_FAILURE.test(evidence) ? "app"
      : INFRASTRUCTURE_REPACK_FAILURE.test(evidence) ? "infrastructure" : "unknown";
    throw new CiError({
      code: "EAS_REPACK_FAILED",
      stage: "instrumentation",
      message: `The hosted EAS repack of the ${platform} build ${job ? `finished with status ${String(job.status)}` : "did not run"}${detail ? `: ${detail.slice(0, 600)}` : "."}`,
      nextAction: `Open the EAS workflow run and fix the repack job; a broken app build environment usually surfaces in its "Repack" step.${where}`,
      details: { failure, ...(logs ? { logs } : {}) },
    });
  }
  const outputs = isRecord(job.outputs) ? job.outputs : {};
  const buildId = outputs.build_id;
  if (typeof buildId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(buildId)) {
    throw new Error("eas workflow:run did not return the repacked build id");
  }
  return buildId;
}

/** How long `eas workflow:run --wait` may take for one hosted repack, queue included. */
const HOSTED_REPACK_TIMEOUT_MS = 30 * 60_000;
/**
 * A fresh repack starts only this long after the first one did: the EAS session started beside the repack is given 20
 * minutes beyond the capture's own (SESSION_PREPARATION_MINUTES in run.ts), and a later app would eat into the capture.
 */
const HOSTED_REPACK_RETRY_BUDGET_MS = 20 * 60_000;

/**
 * Where the matrix jobs of one GitHub run meet to make one hosted repack of an app instead of one each: `scope` names the
 * run (repository and run id), `leader` the first target in config order that repacks this app, and `target` this one.
 * In brentvatne/euxy#176 (review run 39506405687) four iOS targets each repacked EAS build a81d5d80 with the same
 * commit's JavaScript at the same time, and one of the four failed.
 */
export type RepackShare = { scope: string; leader: string; target: string };

/** How long a target waits for its leader's repack to appear on EAS before it repacks itself. */
const SHARED_REPACK_APPEAR_MS = 3 * 60_000;
/** Polls while the leader's repack has not appeared, and while a repack this target waits for runs. */
const SHARED_REPACK_APPEAR_POLL_MS = 15_000;
const SHARED_REPACK_FOLLOW_POLL_MS = 30_000;
/** The recent builds of the platform each poll reads; one this run made minutes ago is among them. */
const SHARED_REPACK_LIST_LIMIT = 30;

/**
 * Every byte the hosted repack would upload, as one digest: the staged checkout's tracked files and the generated
 * observer, path by path, with their kind, executable bit and content (a symlink by its target).
 */
export async function stagedProjectDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = (await readdir(root, { recursive: true, withFileTypes: true }))
    .map(entry => ({ entry, path: relative(root, join(entry.parentPath, entry.name)).split(sep).join("/") }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const { entry, path } of entries) {
    const full = join(root, path);
    if (entry.isSymbolicLink()) hash.update(`link\0${path}\0${await readlink(full)}\0`);
    else if (entry.isDirectory()) hash.update(`directory\0${path}\0`);
    else if (entry.isFile()) {
      const executable = ((await lstat(full)).mode & 0o111) !== 0;
      hash.update(`file\0${path}\0${executable ? "x" : "-"}\0${createHash("sha256").update(await readFile(full)).digest("hex")}\0`);
    } else throw new Error(`The staged copy holds ${path}, which is neither a file, a directory nor a symlink`);
  }
  return hash.digest("hex");
}

/**
 * The key a shared repack's build carries in its message: everything the repack is made from, so two jobs share one only
 * when each would have uploaded the same bytes for the same native build, profile, environment and Explore release, in
 * the same run. Nothing in it comes from another job.
 */
export function hostedRepackShareKey(input: { scope: string; platform: "ios" | "android"; nativeBuildId: string; easProfile: string;
  environment: string; project: string }): string {
  return createHash("sha256").update(JSON.stringify({ contract: "expo-explore.repack-share.v1", explore: EXPLORE_VERSION, scope: input.scope,
    platform: input.platform, nativeBuildId: input.nativeBuildId, easProfile: input.easProfile, environment: input.environment, project: input.project }))
    .digest("hex").slice(0, 32);
}

/** The marker a shared repack's build message ends with. */
export function hostedRepackShareMarker(key: string): string {
  return `[explore share ${key}]`;
}

type ListedBuild = { id: string; status: string };

/** The builds `eas build:list --json` lists that carry `marker` for `platform`, or undefined when the list is unreadable. */
export function sharedRepackBuilds(stdout: string, marker: string, platform: "ios" | "android"): ListedBuild[] | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).flatMap(build => typeof build.id === "string" && /^[A-Za-z0-9-]{1,128}$/.test(build.id) && typeof build.status === "string"
    && typeof build.message === "string" && build.message.endsWith(marker) && String(build.platform).toLowerCase() === platform
    ? [{ id: build.id, status: build.status }] : []);
}

const LIVE_BUILD_STATUSES = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS"]);

/**
 * A repack another job of this run made, or is making, of exactly this app: its EAS build id once it finished, or
 * undefined when this job should repack itself. The leader looks once; another target waits up to
 * SHARED_REPACK_APPEAR_MS for one to appear. A repack it waits for that fails, disappears from the list or outlasts a
 * repack's own timeout sends it to repack itself, and so do three unreadable lists in a row: it never waits on a job
 * that cannot answer.
 */
async function sharedHostedRepack(options: { share: RepackShare; marker: string; platform: "ios" | "android"; list: () => string;
  say: (message: string) => void; now: () => number; sleep?: ((milliseconds: number) => void) | undefined; signal?: AbortSignal | undefined }): Promise<string | undefined> {
  const leader = options.share.leader === options.share.target;
  const start = options.now();
  const appearBy = start + (leader ? 0 : SHARED_REPACK_APPEAR_MS);
  let followed: string | undefined;
  let unreadable = 0;
  let announced = false;
  for (;;) {
    options.signal?.throwIfAborted();
    let listed: ListedBuild[] | undefined;
    try { listed = sharedRepackBuilds(options.list(), options.marker, options.platform); } catch { listed = undefined; }
    if (!listed) {
      unreadable += 1;
      if (unreadable >= 3) { options.say("EAS did not list its builds three times in a row; repacking here instead of waiting for another target's repack"); return undefined; }
    } else {
      unreadable = 0;
      const finished = listed.find(build => build.status === "FINISHED");
      if (finished) {
        options.say(`using EAS build ${finished.id}, the hosted repack of this commit another target of this run made, instead of repacking it again`);
        return finished.id;
      }
      if (followed) {
        const current = listed.find(build => build.id === followed);
        if (!current || !LIVE_BUILD_STATUSES.has(current.status)) {
          options.say(`the shared repack (EAS build ${followed}) ${current ? `ended ${current.status}` : "is no longer listed"}; repacking here`);
          return undefined;
        }
      } else {
        const live = listed.find(build => LIVE_BUILD_STATUSES.has(build.status));
        if (live) {
          followed = live.id;
          options.say(`waiting for EAS build ${live.id}, the hosted repack of this commit another target of this run started, instead of repacking it again`);
        }
      }
    }
    const now = options.now();
    if (!followed && now >= appearBy) {
      if (!leader) options.say(`no repack of this commit from ${options.share.leader} appeared within ${SHARED_REPACK_APPEAR_MS / 60_000} minutes; repacking here`);
      return undefined;
    }
    if (now - start >= HOSTED_REPACK_TIMEOUT_MS) {
      options.say(`the shared repack (EAS build ${followed}) did not finish within ${HOSTED_REPACK_TIMEOUT_MS / 60_000} minutes; repacking here`);
      return undefined;
    }
    if (!followed && !announced) {
      announced = true;
      options.say(`waiting up to ${SHARED_REPACK_APPEAR_MS / 60_000} minutes for the hosted repack ${options.share.leader} makes of this commit, instead of repacking it again`);
    }
    const pause = followed ? SHARED_REPACK_FOLLOW_POLL_MS : SHARED_REPACK_APPEAR_POLL_MS;
    if (options.sleep) options.sleep(pause);
    else await delay(pause, undefined, options.signal ? { signal: options.signal } : {});
  }
}

/**
 * Repack on EAS instead of the runner: the tracked files of the clean checkout are staged beside the
 * observer and a one-job workflow, uploaded with `eas workflow:run`, and the job's `build_id` comes back.
 * No build tools, no `eas upload`, and the profile's EAS environment applies as it does for any build.
 * With a `share`, a repack another job of this run makes of the same staged bytes is used instead (sharedHostedRepack),
 * and this job's own repack carries the key that lets the others use it. A repack that fails for a reason a rerun can
 * fix starts again (hostedRepackRetries): in brentvatne/euxy#176 EAS ended a build that had repacked before it could
 * save the app.
 */
async function prepareHostedRepack(options: {
  platform: "ios" | "android";
  runner: CommandRunner;
  easCommand: string;
  project: string;
  nativeBuildId: string;
  easProfile: string;
  repackProfile: RepackProfile;
  easEnvironment: NodeJS.ProcessEnv;
  restrictedEnvironment: NodeJS.ProcessEnv;
  provider: SourceRoute["provider"];
  parameterKeys: readonly string[];
  root: string;
  share?: RepackShare | undefined;
  say: (message: string) => void;
  now: () => number;
  sleep?: ((milliseconds: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<string> {
  const staged = join(options.root, "project");
  await mkdir(staged, { mode: 0o700 });
  // Paths relative to the app directory, which is what is staged. With --full-name they were relative to the
  // repository root, so an app in a monorepo subdirectory (apps/mobile) copied apps/mobile/apps/mobile/... .
  const listed = options.runner({
    command: "git",
    args: ["ls-files", "-z", "--cached"],
    cwd: options.project,
    environment: options.restrictedEnvironment,
    timeoutMs: 60_000,
  }).stdout;
  const project = await realpath(options.project);
  const files = listed.split("\0").filter(Boolean);
  if (!files.length) throw new Error("git ls-files listed no tracked files to stage for the hosted repack");
  for (const file of files) {
    const source = join(project, file);
    const target = join(staged, file);
    if (!isWithin(project, source) || !isWithin(staged, target)) throw new Error(`Tracked path escapes the checkout: ${file}`);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { verbatimSymlinks: true, errorOnExist: true, force: false });
  }
  try {
    await prepareCaptureObserver({ project: options.project, outputDirectory: join(staged, HOSTED_OBSERVER_DIRECTORY), mountProject: staged,
      provider: options.provider, parameterKeys: options.parameterKeys });
  } catch (error) {
    throw new CiError({ code: "CAPTURE_OBSERVER_UNSUPPORTED", stage: "instrumentation",
      message: error instanceof Error ? error.message : "The route observer could not be prepared.",
      nextAction: "Check the installed Expo and navigation package compatibility for automatic capture instrumentation.", cause: error });
  }
  let message = `expo-explore ${options.platform} capture: route observer repack`;
  if (options.share) {
    // The digest is taken before the workflow file is written: the file's message carries the key made from it.
    const marker = hostedRepackShareMarker(hostedRepackShareKey({ scope: options.share.scope, platform: options.platform, nativeBuildId: options.nativeBuildId,
      easProfile: options.easProfile, environment: options.repackProfile.easEnvironment, project: await stagedProjectDigest(staged) }));
    const shared = await sharedHostedRepack({ share: options.share, marker, platform: options.platform, say: options.say, now: options.now, sleep: options.sleep, signal: options.signal,
      list: () => options.runner({ command: options.easCommand, args: ["build:list", "--platform", options.platform, "--limit", String(SHARED_REPACK_LIST_LIMIT), "--json", "--non-interactive"],
        cwd: options.project, environment: { ...options.easEnvironment, TMPDIR: options.root, TMP: options.root, TEMP: options.root }, timeoutMs: 2 * 60_000, allowFailure: true }).stdout });
    if (shared) return shared;
    message = `${message} ${marker}`;
  }
  const workflowPath = join(staged, HOSTED_REPACK_WORKFLOW);
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, hostedRepackWorkflow({ buildId: options.nativeBuildId, profile: options.easProfile,
    environment: options.repackProfile.easEnvironment, message }), { flag: "wx", mode: 0o600 });
  const first = options.now();
  let retries = 0;
  for (;;) {
    const run = options.runner({
      command: options.easCommand,
      args: ["workflow:run", HOSTED_REPACK_WORKFLOW, "--wait", "--json", "--non-interactive"],
      cwd: staged,
      environment: { ...options.easEnvironment, EAS_NO_VCS: "1", TMPDIR: options.root, TMP: options.root, TEMP: options.root },
      timeoutMs: HOSTED_REPACK_TIMEOUT_MS,
      allowFailure: true,
    });
    try {
      return hostedRepackBuildId(run.stdout, run.stderr, options.platform);
    } catch (error) {
      // A failed run has ended (`--wait` reports only a finished run), so a fresh one leaves nothing running beside it.
      const allowed = hostedRepackRetries(error);
      if (retries >= allowed || options.now() - first >= HOSTED_REPACK_RETRY_BUDGET_MS) throw error;
      retries += 1;
      const logs = error instanceof CiError && typeof error.details?.logs === "string" ? error.details.logs : undefined;
      options.say(`the hosted EAS repack${logs ? ` ${logs}` : ""} failed (${error instanceof Error ? error.message : String(error)}); starting another repack (${retries}/${allowed})`);
      options.signal?.throwIfAborted();
    }
  }
}

/**
 * The instrumented app a capture runs, on this machine, and the EAS build it came from when a hosted job repacked it.
 * A local repack is never uploaded, so it has no build id.
 */
export type PreparedBuild = { buildId: string | null; app: string };

export async function prepareExactSourceBuild(options: {
  platform?: "ios" | "android";
  runner: CommandRunner;
  easCommand: string;
  repackCommand: string;
  project: string;
  nativeBuildId: string;
  fingerprint: string;
  repackProfile: RepackProfile;
  easEnvironment: NodeJS.ProcessEnv;
  repackEnvironment: NodeJS.ProcessEnv;
  routes: readonly SourceRoute[];
  /** `eas` (default) repacks in a hosted EAS workflow job; `local` runs repack-app on this machine. */
  repack?: RepackMode | undefined;
  /** The capture build profile name; the hosted repack job builds against it. */
  easProfile?: string | undefined;
  /** Where to leave the instrumented app on this machine, for the capture to install; it must not exist yet. */
  keepApp: string;
  /** The other matrix jobs of this run that repack the same app, to make one hosted repack with (RepackShare). */
  share?: RepackShare | undefined;
  /** Says what the hosted repack is doing when it waits for another job's repack or starts another one. */
  progress?: ((message: string) => void) | undefined;
  /** The clock and pause the waits and retries use; tests replace them so that minutes are not real time. */
  now?: (() => number) | undefined;
  sleep?: ((milliseconds: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<PreparedBuild | undefined> {
  const platform = options.platform ?? "ios";
  const root = await mkdtemp(join(tmpdir(), "expo-explore-repack-"));
  let outcome: PreparedBuild | null | undefined;
  let primaryError: unknown;
  try {
    const providers = [...new Set(options.routes.map(route => route.provider))];
    if (providers.length !== 1) throw new CiError({ code: "CAPTURE_OBSERVER_PROVIDER_AMBIGUOUS", stage: "instrumentation",
      message: "Capture requires exactly one resolved navigation provider.",
      nextAction: "Select the application's navigation provider in config.yaml and rerun source planning." });
    if ((options.repack ?? "eas") === "eas") {
      if (!options.easProfile) throw new Error("The hosted repack needs the capture build profile name.");
      const hosted = await prepareHostedRepack({ platform, runner: options.runner, easCommand: options.easCommand, project: options.project,
        nativeBuildId: options.nativeBuildId, easProfile: options.easProfile, repackProfile: options.repackProfile,
        easEnvironment: options.easEnvironment, restrictedEnvironment: options.repackEnvironment, provider: providers[0]!,
        parameterKeys: captureObserverParameterKeys(options.routes), root, share: options.share, say: options.progress ?? (() => undefined),
        now: options.now ?? Date.now, sleep: options.sleep, signal: options.signal });
      {
        // The hosted job leaves its app on EAS; the capture installs a copy downloaded here.
        const downloaded = await downloadedAppPath(options.runner({ command: options.easCommand,
          args: ["build:download", "--build-id", hosted, "--json", "--non-interactive"], cwd: options.project,
          environment: { ...options.easEnvironment, TMPDIR: root, TMP: root, TEMP: root }, timeoutMs: 10 * 60_000 }).stdout, root, platform);
        await rename(downloaded, options.keepApp);
        outcome = { buildId: hosted, app: options.keepApp };
      }
    } else {
      const shadowProject = join(root, "eas-project");
      const pulledEnvironmentPath = join(root, "server.env");
      const privateEasEnvironment: NodeJS.ProcessEnv = {
        ...options.easEnvironment,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
      };
      await mkdir(shadowProject, { recursive: true });
      await Promise.all([
        writeFile(join(shadowProject, "package.json"), `${JSON.stringify({ private: true })}\n`, { mode: 0o600 }),
        writeFile(join(shadowProject, "app.json"), `${JSON.stringify({
          expo: {
            name: options.repackProfile.projectIdentity.name,
            slug: options.repackProfile.projectIdentity.slug,
            ...(options.repackProfile.projectIdentity.owner
              ? { owner: options.repackProfile.projectIdentity.owner }
              : {}),
            extra: { eas: { projectId: options.repackProfile.projectIdentity.projectId } },
          },
        })}\n`, { mode: 0o600 }),
      ]);
      options.runner({
        command: options.easCommand,
        args: [
          "env:pull",
          "--environment", options.repackProfile.easEnvironment,
          "--path", pulledEnvironmentPath,
          "--non-interactive",
        ],
        cwd: shadowProject,
        environment: options.easEnvironment,
        timeoutMs: 5 * 60_000,
      });
      const pulledInfo = await lstat(pulledEnvironmentPath);
      if (pulledInfo.isSymbolicLink() || !pulledInfo.isFile()) {
        throw new Error("eas env:pull did not create a regular environment file");
      }
      let serverEnvironment: Awaited<ReturnType<typeof pulledEnvironment>> | undefined;
      try {
        const parsedEnvironment = await pulledEnvironment({
          source: await readFile(pulledEnvironmentPath, "utf8"),
          environment: options.repackProfile.easEnvironment,
          fileRoot: join(shadowProject, ".eas", ".env"),
        });
        for (const [name, value] of Object.entries(options.repackProfile.profileEnvironment)) {
          assertSafeRepackEnvironmentName(name);
          assertSafeRepackEnvironmentValue(name, value);
        }
        serverEnvironment = parsedEnvironment;
      } catch (error) {
        if (!(error instanceof UnsupportedRepackEnvironmentError)) throw error;
      }
      if (serverEnvironment === undefined || serverEnvironment.secretNames.length > 0) {
        outcome = null;
      } else {
        const sourceApp = await downloadedAppPath(options.runner({
          command: options.easCommand,
          args: [
            "build:download",
            "--build-id", options.nativeBuildId,
            "--json",
            "--non-interactive",
          ],
          cwd: options.project,
          environment: privateEasEnvironment,
          timeoutMs: 10 * 60_000,
        }).stdout, root, platform);
        const repackedApp = join(root, platform === "android" ? "repacked.apk" : "repacked.app");
        let observer: Awaited<ReturnType<typeof prepareCaptureObserver>>;
        try {
          observer = await prepareCaptureObserver({ project: options.project, outputDirectory: join(root, "observer"),
            provider: providers[0]!, parameterKeys: captureObserverParameterKeys(options.routes) });
        } catch (error) {
          throw new CiError({ code: "CAPTURE_OBSERVER_UNSUPPORTED", stage: "instrumentation",
            message: error instanceof Error ? error.message : "The route observer could not be prepared.",
            nextAction: "Check the installed Expo and navigation package compatibility for automatic capture instrumentation.", cause: error });
        }
        const repackArgs = [
          "--platform", platform,
          "--source-app", sourceApp,
          "--output", repackedApp,
          "--working-directory", join(root, "working"),
          "--embed-bundle-assets",
          "--js-bundle-only",
          ".",
        ];
        const repackEnvironment: NodeJS.ProcessEnv = {
          ...options.repackEnvironment,
          ...serverEnvironment.values,
          ...options.repackProfile.profileEnvironment,
          ...observer.environment,
        };
        if (repackEnvironment.NODE_ENV === undefined) repackEnvironment.NODE_ENV = "production";
        delete repackEnvironment.EXPO_TOKEN;
        if (options.platform === "android") {
          const sdkRoot = repackEnvironment.ANDROID_SDK_ROOT ?? repackEnvironment.ANDROID_HOME;
          if (!sdkRoot) throw new CiError({ code: "ANDROID_SDK_MISSING", stage: "instrumentation",
            message: "Repacking an Android APK needs the Android SDK build-tools, and neither ANDROID_SDK_ROOT nor ANDROID_HOME is set.",
            nextAction: "Install the Android SDK build-tools (sdkmanager \"build-tools;35.0.0\") and export ANDROID_SDK_ROOT; GitHub-hosted runners set it already." });
          repackEnvironment.ANDROID_SDK_ROOT = sdkRoot;
        }
        options.runner({
          command: options.repackCommand,
          args: repackArgs,
          cwd: options.project,
          environment: repackEnvironment,
          timeoutMs: 15 * 60_000,
        });
        const repackedInfo = await lstat(repackedApp);
        if (repackedInfo.isSymbolicLink() || (platform === "android" ? !repackedInfo.isFile() : !repackedInfo.isDirectory())) {
          throw new Error(platform === "android" ? "repack-app did not produce a non-symlink Android .apk file" : "repack-app did not produce a non-symlink iOS .app directory");
        }
        // The capture installs the repacked app from here (a local device directly, an EAS session through its
        // controller), so it is never uploaded.
        await rename(repackedApp, options.keepApp);
        outcome = { buildId: null, app: options.keepApp };
      }
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Exact-source app preparation failed and its temporary files could not be removed",
      );
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  if (outcome === undefined) throw new Error("Exact-source app preparation finished without a result");
  return outcome ?? undefined;
}
