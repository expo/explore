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

/** The message Explore's hosted repacks give their builds (hostedRepackWorkflow), with or without a share marker. */
const EXPLORE_REPACK_MESSAGE = /^expo-explore (?:ios|android) capture: route observer repack\b/;

/**
 * The finished build to repack from `eas build:list --fingerprint-hash`: the newest one Explore did not repack itself,
 * else the newest. A repack keeps its source build's native code, and may carry its fingerprint; preferring the build
 * it came from has every job of a run pick the same one, which a shared repack's key needs (RepackShare), instead of a
 * repack another job finished a minute earlier.
 */
export function existingBuild(stdout: string): EasBuildDescriptor | undefined {
  const value = parseJson(stdout, "eas build:list");
  if (!Array.isArray(value)) throw new Error("eas build:list did not return a build list");
  if (value.length === 0) return undefined;
  const index = Math.max(0, value.findIndex(build => !(isRecord(build) && typeof build.message === "string" && EXPLORE_REPACK_MESSAGE.test(build.message))));
  const candidate = value[index];
  const id = buildIdFrom([candidate], "eas build:list");
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
 * Why a hosted repack failed, as far as its run tells:
 * - `app`: the app's own code broke it: the "Repack" step failed, or the logs show a bundling error. A rerun repeats it.
 * - `configuration`: EAS or a package registry refused a credential (not logged in, unauthorized, a 401 or 403).
 * - `canceled`: someone cancelled the run.
 * - `timeout`: the build ran out its EAS build time, which a rerun would wait out again, or Explore's time for the repack ran out.
 * - `unconfirmed`: Explore could not learn whether the run ended; it asked EAS to cancel it and starts no other beside it.
 * - `infrastructure`: EAS failed around the app's code: a step that sets up the job, downloads or uploads failed, or EAS
 *   ended the build (brentvatne/euxy#176).
 * - `unknown`: nothing says why.
 */
export type HostedRepackFailure = "app" | "configuration" | "canceled" | "timeout" | "unconfirmed" | "infrastructure" | "unknown";

const APP_REPACK_STEP = /^Repack(?: app)?$/i;
// Metro's, Babel's and Expo's words for the app's own code or files: `Unable to resolve "react-native-reanimated" from
// "index.js"`, a missing module, a file an asset step could not read.
const APP_REPACK_FAILURE = /Unable to resolve\b|SyntaxError|TransformError|Error while bundling|Bundling failed|Cannot find module|could not read \.{0,2}\/|no such file or directory, open '\.{0,2}\//i;
// A file of EAS's own worker missing (`Cannot find module '/opt/eas/...'`) is EAS's failure, whatever the step.
const WORKER_REPACK_FAILURE = /['"]\/opt\/eas\//;
const CONFIGURATION_REPACK_FAILURE = /Not logged in|\bunauthori[sz]ed\b|\bnot authorized\b|\bE40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b|authentication (?:failed|required)/i;
const TIMEOUT_REPACK_FAILURE = /\bEAS_BUILD_TIMEOUT_ERROR\b/;
// The steps EAS runs around the app's own: setting up the job, fetching the build to repack, saving the result.
const INFRASTRUCTURE_REPACK_STEP = /^(?:Spin up|Set up|Download|Upload)\b/i;
// EAS's and eas-cli's own words for a failure on their side. In brentvatne/euxy#176 (review run 39506405687) EAS refused
// the "Upload artifact" step with "Turtle build is not in progress", and the build reported "Failed to upload application archive.".
const INFRASTRUCTURE_REPACK_FAILURE = /Turtle build is not in progress|Failed to upload application archive|\bSERVER_ERROR\b|Failed to upload project sources|Failed to start the workflow with the API|Unexpected response from server \(5\d\d\)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|socket hang up|fetch failed/;

/** How a failure reads: from the build's error, the job's errors, the failed job's logs and the CLI's output. */
export function hostedRepackFailure(evidence: string, status?: unknown): HostedRepackFailure {
  if (status === "CANCELED") return "canceled";
  if (CONFIGURATION_REPACK_FAILURE.test(evidence)) return "configuration";
  if (WORKER_REPACK_FAILURE.test(evidence)) return "infrastructure";
  const step = [...evidence.matchAll(/Build step "([^"]+)" failed/g)].at(-1)?.[1];
  if ((step && APP_REPACK_STEP.test(step)) || APP_REPACK_FAILURE.test(evidence)) return "app";
  if (TIMEOUT_REPACK_FAILURE.test(evidence)) return "timeout";
  if ((step && INFRASTRUCTURE_REPACK_STEP.test(step)) || INFRASTRUCTURE_REPACK_FAILURE.test(evidence)) return "infrastructure";
  return "unknown";
}

/** How many fresh repacks a failure earns: two after EAS's own failure, one after one nothing explains, none otherwise. */
export function hostedRepackRetries(error: unknown): number {
  const failure = error instanceof CiError && error.code === "EAS_REPACK_FAILED" ? error.details?.failure : undefined;
  return failure === "infrastructure" ? 2 : failure === "unknown" ? 1 : 0;
}

const EXPO_URL = /^https:\/\/expo\.dev\/\S+$/;
const EAS_ID = /^[A-Za-z0-9-]{1,128}$/;

/**
 * The repacked build id from a finished run's JSON (`eas workflow:view --json`), or the job's failure as a readable
 * error. `evidence` is the rest of what the run said: the CLI's stderr and the failed job's logs.
 */
export function hostedRepackBuildId(stdout: string, evidence: string, platform: "ios" | "android"): string {
  let logs = /See logs: (https:\/\/expo\.dev\/\S+)/.exec(evidence)?.[1];
  let value: unknown;
  try {
    value = parseJson(stdout, "eas workflow:run");
  } catch (error) {
    const tail = evidence.trim().split("\n").slice(-3).join(" | ").slice(0, 600);
    throw new CiError({
      code: "EAS_REPACK_FAILED",
      stage: "instrumentation",
      message: `eas workflow:run did not report the hosted ${platform} repack: ${tail || (error instanceof Error ? error.message : String(error))}`,
      nextAction: `Check that EXPO_TOKEN can run workflows for this EAS project and retry.${logs ? ` Logs: ${logs}` : ""}`,
      details: { failure: hostedRepackFailure(evidence), ...(logs ? { logs } : {}) },
      cause: error,
    });
  }
  for (const field of ["url", "logURL"]) {
    const link = isRecord(value) ? value[field] : undefined;
    if (typeof link === "string" && EXPO_URL.test(link)) logs = link;
  }
  const where = logs ? ` Logs: ${logs}` : "";
  const jobs = isRecord(value) && Array.isArray(value.jobs) ? value.jobs.filter(isRecord) : [];
  const job = jobs.find(entry => entry.key === "repack") ?? jobs[0];
  if (!job || job.status !== "SUCCESS") {
    const build = job && isRecord(job.turtleBuild) ? job.turtleBuild : undefined;
    const buildError = build && isRecord(build.error) ? build.error : undefined;
    const detail = typeof buildError?.message === "string" ? buildError.message.trim() : undefined;
    const planLimit = easPlanLimitError(new Error(`${detail ?? ""}\n${evidence}`), platform);
    if (planLimit) throw planLimit;
    const jobErrors = Array.isArray(job?.errors) ? job.errors.filter(isRecord).map(entry => `${String(entry.title ?? "")} ${String(entry.message ?? "")}`) : [];
    const failure = hostedRepackFailure([detail ?? "", typeof buildError?.errorCode === "string" ? buildError.errorCode : "", ...jobErrors, evidence].join("\n"),
      job?.status ?? (isRecord(value) ? value.status : undefined));
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
  if (typeof buildId !== "string" || !EAS_ID.test(buildId)) {
    throw new Error("eas workflow:run did not return the repacked build id");
  }
  return buildId;
}

/**
 * The run `eas workflow:run --json` (without `--wait`) started: its id and link, from its JSON or, when the JSON is
 * missing, from the "See logs:" link it printed once the run existed. With neither, no run started, and the failure
 * says why.
 */
export function hostedRepackRunStart(stdout: string, stderr: string, platform: "ios" | "android"): { id: string; url?: string } {
  const printed = /See logs: (https:\/\/expo\.dev\/\S+)/.exec(stderr)?.[1];
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { value = undefined; }
  const url = isRecord(value) && typeof value.url === "string" && EXPO_URL.test(value.url) ? value.url : printed;
  const id = isRecord(value) && typeof value.id === "string" ? value.id : url ? /\/workflows\/([^/?#\s]+)$/.exec(url)?.[1] : undefined;
  if (id && EAS_ID.test(id)) return { id, ...(url ? { url } : {}) };
  const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 600);
  throw new CiError({ code: "EAS_REPACK_FAILED", stage: "instrumentation",
    message: `eas workflow:run did not start the hosted ${platform} repack: ${tail || "it printed no run"}`,
    nextAction: "Check that EXPO_TOKEN can run workflows for this EAS project and retry.",
    details: { failure: hostedRepackFailure(stderr) } });
}

/**
 * The most time preparing the app may take once the build to repack is known: waiting for another job's repack,
 * following it, and every repack this job starts, each run's wait included. It replaces a 30-minute wait per run, which
 * with a share wait and two retries let one capture prepare for over an hour; a capture whose app takes longer than
 * the session's allowance (SESSION_PREPARATION_MINUTES in run.ts) gets a fresh session.
 */
export const HOSTED_REPACK_BUDGET_MS = 30 * 60_000;
/** A repack starts only with this much of the budget left: a typical one takes about five minutes. */
const HOSTED_REPACK_MIN_ATTEMPT_MS = 5 * 60_000;
/** How often a running repack's state is read, and how many unreadable reads in a row mean Explore cannot tell. */
const HOSTED_REPACK_POLL_MS = 20_000;
const HOSTED_REPACK_UNREADABLE_READS = 6;
const TERMINAL_RUN_STATUSES = new Set(["SUCCESS", "FAILURE", "CANCELED"]);

/** What the hosted repack waits and reports with: the end of its budget, the clock and pause (tests replace both), and an abort. */
type RepackClock = { deadline: number; now: () => number; sleep?: ((milliseconds: number) => void) | undefined; signal?: AbortSignal | undefined };

async function pause(milliseconds: number, clock: RepackClock): Promise<void> {
  if (clock.sleep) clock.sleep(milliseconds);
  else {
    try { await delay(milliseconds, undefined, clock.signal ? { signal: clock.signal } : {}); }
    catch (error) { clock.signal?.throwIfAborted(); throw error; }
  }
  clock.signal?.throwIfAborted();
}

function timeoutError(platform: "ios" | "android", detail: string, logs?: string): CiError {
  return new CiError({ code: "EAS_REPACK_FAILED", stage: "instrumentation",
    message: `The hosted EAS repack of the ${platform} build did not finish within the ${HOSTED_REPACK_BUDGET_MS / 60_000} minutes a capture has to prepare its app: ${detail}.`,
    nextAction: `Check the EAS workflow run for a long queue or a stuck step, then rerun Explore.${logs ? ` Logs: ${logs}` : ""}`,
    details: { failure: "timeout", ...(logs ? { logs } : {}) } });
}

/**
 * The failed step's logs from `eas workflow:logs --json` (the step that logged `Build step "…" failed`, else the last
 * with any lines), so that a warning another step printed does not decide the failure; nothing when unreadable.
 */
function workflowLogText(stdout: string): string {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value)) return "";
    const steps = Object.values(value).map(lines => Array.isArray(lines) ? lines.filter(isRecord).map(line => String(line.msg ?? "")) : []).filter(lines => lines.length);
    const failed = [...steps].reverse().find(lines => lines.some(line => /Build step "[^"]+" failed/.test(line))) ?? steps.at(-1) ?? [];
    return failed.slice(-400).join("\n");
  } catch { return ""; }
}

type EasCall = (args: string[], timeoutMs: number, options?: { cwd?: string; strict?: boolean }) => { stdout: string; stderr: string };

/** What a command that threw still printed: defaultRunner keeps a timed-out or signalled command's output on its error. */
function printedBy(error: unknown): { stdout: string; stderr: string } {
  const value = error as { stdout?: unknown; stderr?: unknown } | undefined;
  return { stdout: typeof value?.stdout === "string" ? value.stdout : "", stderr: typeof value?.stderr === "string" ? value.stderr : "" };
}

/**
 * One hosted repack run: started without `--wait`, so Explore always knows the run and waits on it within its own
 * budget. eas-cli's `--wait` gives up after six failed status reads with exit code 13 and leaves the run going, and
 * Explore then started another beside it. A run whose state stays unreadable, that outlasts the budget, or whose
 * capture is stopped is cancelled (`eas workflow:cancel`) and not replaced: only a run EAS reports finished is
 * followed by another. A start that timed out or was stopped is waited on when it printed its run, and otherwise
 * not replaced, since it may have started one.
 */
async function hostedRepackRun(options: { eas: EasCall; staged: string; platform: "ios" | "android"; clock: RepackClock }): Promise<string> {
  const { clock, platform } = options;
  let started: { stdout: string; stderr: string };
  let startFailure: unknown;
  try { started = options.eas(["workflow:run", HOSTED_REPACK_WORKFLOW, "--json", "--non-interactive"], Math.min(10 * 60_000, clock.deadline - clock.now()), { cwd: options.staged }); }
  catch (error) { started = printedBy(error); startFailure = error; }
  let run: { id: string; url?: string };
  try { run = hostedRepackRunStart(started.stdout, started.stderr, platform); }
  catch (error) {
    if (startFailure === undefined) throw error;
    throw new CiError({ code: "EAS_REPACK_FAILED", stage: "instrumentation",
      message: `eas workflow:run did not finish starting the hosted ${platform} repack (${startFailure instanceof Error ? startFailure.message : String(startFailure)}), and printed no run: one may have started, so Explore does not start another.`,
      nextAction: "Check the project's workflow runs on expo.dev, cancel a repack still running, and rerun Explore.",
      details: { failure: "unconfirmed" }, cause: startFailure });
  }
  const cancel = (): boolean => {
    try { options.eas(["workflow:cancel", run.id, "--non-interactive"], 2 * 60_000, { strict: true }); return true; } catch { return false; }
  };
  try {
    let unreadable = 0;
    for (;;) {
      clock.signal?.throwIfAborted();
      let view = { stdout: "", stderr: "" };
      try { view = options.eas(["workflow:view", run.id, "--json", "--non-interactive"], 2 * 60_000); } catch { /* Counted as an unreadable read below. */ }
      let value: unknown;
      try { value = JSON.parse(view.stdout); } catch { value = undefined; }
      const status = isRecord(value) && typeof value.status === "string" ? value.status : undefined;
      if (status && TERMINAL_RUN_STATUSES.has(status)) {
        const jobs = isRecord(value) && Array.isArray(value.jobs) ? value.jobs.filter(isRecord) : [];
        const job = jobs.find(entry => entry.key === "repack") ?? jobs[0];
        let logs = "";
        if (status === "FAILURE" && typeof job?.id === "string" && EAS_ID.test(job.id)) {
          try { logs = workflowLogText(options.eas(["workflow:logs", job.id, "--json", "--non-interactive"], 2 * 60_000).stdout); } catch { /* The build's error still classifies it. */ }
        }
        return hostedRepackBuildId(view.stdout, `${started.stderr}\n${logs}`, platform);
      }
      unreadable = status ? 0 : unreadable + 1;
      if (unreadable >= HOSTED_REPACK_UNREADABLE_READS) {
        const cancelled = cancel();
        throw new CiError({ code: "EAS_REPACK_FAILED", stage: "instrumentation",
          message: `EAS did not report the state of the hosted ${platform} repack ${HOSTED_REPACK_UNREADABLE_READS} times in a row; ${cancelled ? "Explore cancelled the run" : "Explore could not cancel the run"} and did not start another beside it.`,
          nextAction: `Check the EAS status and the run${cancelled ? "" : ", and cancel it if it is still going"}, then rerun Explore.${run.url ? ` Logs: ${run.url}` : ""}`,
          details: { failure: "unconfirmed", ...(run.url ? { logs: run.url } : {}) } });
      }
      const left = clock.deadline - clock.now();
      if (left <= 0) {
        const cancelled = cancel();
        throw timeoutError(platform, `run ${run.id} was still ${status ?? "unreadable"}; ${cancelled ? "it was cancelled" : "it could not be cancelled"}`, run.url);
      }
      await pause(Math.min(HOSTED_REPACK_POLL_MS, left), clock);
    }
  } catch (error) {
    // A capture stopped while its repack runs (a cancelled job, Ctrl+C) leaves no run behind it.
    if (clock.signal?.aborted) cancel();
    throw error;
  }
}

/**
 * Where the matrix jobs of one GitHub run attempt meet to make one hosted repack of an app instead of one each: `scope`
 * names the run attempt (repository, run id and attempt), `leader` the first target in config order that repacks this
 * app, `target` this one, `rank` its place among them (the leader's is 0), and `rerun` an attempt after the first, which
 * runs only the jobs it re-runs. In brentvatne/euxy#176 (review run 39506405687) four iOS targets each repacked EAS
 * build a81d5d80 with the same commit's JavaScript at the same time, and one of the four failed.
 */
export type RepackShare = { scope: string; leader: string; target: string; rank: number; rerun?: boolean };

/** How long the target after the leader waits for a repack to appear on EAS before it repacks itself. */
const SHARED_REPACK_APPEAR_MS = 3 * 60_000;
/**
 * Each later target waits this much longer, so that when the leader makes no repack (its baseline covered every route,
 * or `max-parallel` kept it out of the first jobs) the next target's repack has appeared before the one after it would
 * start another: the targets join one repack instead of all starting their own at the same moment.
 */
const SHARED_REPACK_STAGGER_MS = 60_000;
/** How long a target whose followed repack failed looks for the repack that replaces it (the leader's retry) before repacking itself. */
const SHARED_REPACK_GRACE_MS = 60_000;
/** Polls while no repack is followed, and while one is. */
const SHARED_REPACK_APPEAR_POLL_MS = 15_000;
const SHARED_REPACK_FOLLOW_POLL_MS = 30_000;
/** The recent builds of the platform a look reads (eas-cli's most): one this run made minutes ago is among them. */
const SHARED_REPACK_LIST_LIMIT = 50;

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
 * when each would have uploaded the same bytes for the same native build, profile, EAS environment (by name and by a
 * snapshot of its variables) and Explore release, in the same run attempt.
 */
export function hostedRepackShareKey(input: { scope: string; platform: "ios" | "android"; nativeBuildId: string; easProfile: string;
  environment: string; environmentVariables: string; project: string }): string {
  return createHash("sha256").update(JSON.stringify({ contract: "expo-explore.repack-share.v2", explore: EXPLORE_VERSION, scope: input.scope,
    platform: input.platform, nativeBuildId: input.nativeBuildId, easProfile: input.easProfile, environment: input.environment,
    environmentVariables: input.environmentVariables, project: input.project })).digest("hex").slice(0, 32);
}

/** The marker a shared repack's build message ends with. */
export function hostedRepackShareMarker(key: string): string {
  return `[explore share ${key}]`;
}

type ListedBuild = { id: string; status: string };

function sharedRepackBuild(build: unknown, marker: string, platform: "ios" | "android"): ListedBuild | undefined {
  return isRecord(build) && typeof build.id === "string" && EAS_ID.test(build.id) && typeof build.status === "string"
    && typeof build.message === "string" && build.message.endsWith(marker) && String(build.platform).toLowerCase() === platform
    ? { id: build.id, status: build.status } : undefined;
}

/** The builds `eas build:list --json` lists that carry `marker` for `platform`, or undefined when the list is unreadable. */
export function sharedRepackBuilds(stdout: string, marker: string, platform: "ios" | "android"): ListedBuild[] | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(build => sharedRepackBuild(build, marker, platform) ?? []);
}

/** One build from `eas build:view --json`: null when it no longer carries `marker` for `platform`, undefined when unreadable. */
export function sharedRepackBuildView(stdout: string, marker: string, platform: "ios" | "android"): ListedBuild | null | undefined {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { return undefined; }
  return isRecord(value) ? sharedRepackBuild(value, marker, platform) ?? null : undefined;
}

/**
 * A snapshot of the EAS environment's variables the repack job reads: `eas env:list --format long` of the project's
 * and the account's variables, which names each with its value (masked when sensitive or secret) and when it was last
 * updated, so an edited value changes it. Undefined when either list fails.
 */
function easEnvironmentSnapshot(list: (scope: "project" | "account") => string | undefined): string | undefined {
  const project = list("project"), account = list("account");
  if (project === undefined || account === undefined) return undefined;
  return createHash("sha256").update(JSON.stringify([project, account])).digest("hex");
}

const LIVE_BUILD_STATUSES = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS"]);

/**
 * How long a target looks for another's repack before it repacks itself: the leader not at all, and each target after it
 * SHARED_REPACK_STAGGER_MS longer than the one before, from SHARED_REPACK_APPEAR_MS. A re-run attempt's leader may not
 * run again, so there the stagger starts at once. After a followed repack failed, the wait is SHARED_REPACK_GRACE_MS,
 * staggered the same way.
 */
export function sharedRepackWaitMs(share: Pick<RepackShare, "rank" | "rerun">, afterFailure = false): number {
  const later = Math.max(0, share.rank - 1) * SHARED_REPACK_STAGGER_MS;
  if (afterFailure) return SHARED_REPACK_GRACE_MS + later;
  if (share.rank === 0) return 0;
  return share.rerun ? share.rank * SHARED_REPACK_STAGGER_MS : SHARED_REPACK_APPEAR_MS + later;
}

/**
 * A repack another job of this run attempt made, or is making, of exactly this app: its EAS build id once it finished,
 * or undefined when this job should repack itself.
 * - The leader looks once. Another target looks every 15 s for as long as sharedRepackWaitMs gives it, and joins any
 *   repack with the key it finds, whichever job started it.
 * - A repack it finds is then read by its id every 30 s (a list of recent builds can lose it on a busy project).
 * - One that fails, or no longer carries the key, is set aside, and for SHARED_REPACK_GRACE_MS the target looks for
 *   another with the key (the leader's retry, at once in brentvatne/euxy#176) before it repacks itself.
 * - Looking stops while the budget still has time for a repack of this job's own, and following stops at the end of
 *   the budget. Three unreadable reads in a row also end the wait: it never waits on a job that cannot answer.
 */
async function sharedHostedRepack(options: { share: RepackShare; marker: string; platform: "ios" | "android"; list: () => string;
  view: (id: string) => string; say: (message: string) => void; clock: RepackClock }): Promise<string | undefined> {
  const { clock, say } = options;
  const start = clock.now();
  const lookLatest = clock.deadline - HOSTED_REPACK_MIN_ATTEMPT_MS;
  const firstWait = sharedRepackWaitMs(options.share);
  let lookUntil = Math.min(start + firstWait, lookLatest);
  let followed: string | undefined;
  const setAside = new Set<string>();
  let unreadable = 0;
  let announced = false;
  for (;;) {
    clock.signal?.throwIfAborted();
    let read: ListedBuild[] | null | undefined;
    try {
      if (followed) {
        const build = sharedRepackBuildView(options.view(followed), options.marker, options.platform);
        read = build === undefined ? undefined : build === null ? [] : [build];
      } else read = sharedRepackBuilds(options.list(), options.marker, options.platform);
    } catch { read = undefined; }
    if (!read) {
      unreadable += 1;
      if (unreadable >= 3) { say("EAS did not answer three times in a row; repacking here instead of waiting for another target's repack"); return undefined; }
    } else {
      unreadable = 0;
      const builds = read.filter(build => !setAside.has(build.id));
      const finished = builds.find(build => build.status === "FINISHED");
      if (finished) {
        say(`using EAS build ${finished.id}, the hosted repack of this commit another target of this run made, instead of repacking it again`);
        return finished.id;
      }
      const live = builds.find(build => LIVE_BUILD_STATUSES.has(build.status));
      if (followed && !live) {
        say(`the shared repack (EAS build ${followed}) ${read[0] ? `ended ${read[0].status}` : "no longer carries this commit's key"}; looking for another for up to ${sharedRepackWaitMs(options.share, true) / 1000} s before repacking here`);
        setAside.add(followed);
        followed = undefined;
        lookUntil = Math.min(clock.now() + sharedRepackWaitMs(options.share, true), lookLatest);
      } else if (!followed && live) {
        followed = live.id;
        say(`waiting for EAS build ${live.id}, the hosted repack of this commit another target of this run started, instead of repacking it again`);
      }
    }
    const now = clock.now();
    if (followed && now >= clock.deadline) {
      say(`the shared repack (EAS build ${followed}) did not finish in the time this capture has to prepare its app`);
      return undefined;
    }
    if (!followed && now >= lookUntil) {
      if (setAside.size) say("no other repack of this commit appeared; repacking here");
      else if (firstWait) say(`no repack of this commit from ${options.share.leader} or another target appeared within ${Math.round((now - start) / 60_000)} minutes; repacking here`);
      return undefined;
    }
    if (!followed && !announced && firstWait) {
      announced = true;
      say(`waiting up to ${Math.round(firstWait / 60_000)} minutes for the hosted repack ${options.share.leader} or another target makes of this commit, instead of repacking it again`);
    }
    const until = followed ? clock.deadline : lookUntil;
    await pause(Math.max(0, Math.min(followed ? SHARED_REPACK_FOLLOW_POLL_MS : SHARED_REPACK_APPEAR_POLL_MS, until - now)), clock);
  }
}

/**
 * Repack on EAS instead of the runner: the tracked files of the clean checkout are staged beside the
 * observer and a one-job workflow, uploaded with `eas workflow:run`, and the job's `build_id` comes back.
 * No build tools, no `eas upload`, and the profile's EAS environment applies as it does for any build.
 * With a `share`, a repack another job of this run attempt makes of the same staged bytes is used instead
 * (sharedHostedRepack), and this job's own repack carries the key that lets the others use it. A repack that fails
 * for a reason a rerun can fix starts again (hostedRepackRetries): in brentvatne/euxy#176 EAS ended a build that had
 * repacked before it could save the app. All of it stays within the capture's budget (`clock.deadline`).
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
  clock: RepackClock;
}): Promise<string> {
  const { clock, platform } = options;
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
  const privateEnvironment = { ...options.easEnvironment, TMPDIR: options.root, TMP: options.root, TEMP: options.root };
  // Reads may fail and say so in their output; `strict` makes a failed command throw (a cancel that did not happen).
  const eas: EasCall = (args, timeoutMs, { cwd = options.project, strict = false } = {}) => options.runner({ command: options.easCommand, args, cwd,
    environment: cwd === staged ? { ...privateEnvironment, EAS_NO_VCS: "1" } : privateEnvironment, timeoutMs, ...(strict ? {} : { allowFailure: true }) });
  let message = `expo-explore ${platform} capture: route observer repack`;
  if (options.share) {
    const environment = options.repackProfile.easEnvironment;
    const variables = easEnvironmentSnapshot(scope => {
      try {
        const listedVariables = options.runner({ command: options.easCommand, args: ["env:list", "--environment", environment, "--scope", scope, "--format", "long", "--non-interactive"],
          cwd: options.project, environment: privateEnvironment, timeoutMs: 2 * 60_000 });
        return listedVariables.stdout;
      } catch { return undefined; }
    });
    if (variables === undefined) options.say(`EAS did not list the ${environment} environment's variables; repacking here without sharing the repack`);
    else {
      // The digest is taken before the workflow file is written: the file's message carries the key made from it.
      const marker = hostedRepackShareMarker(hostedRepackShareKey({ scope: options.share.scope, platform, nativeBuildId: options.nativeBuildId,
        easProfile: options.easProfile, environment, environmentVariables: variables, project: await stagedProjectDigest(staged) }));
      const shared = await sharedHostedRepack({ share: options.share, marker, platform, say: options.say, clock,
        list: () => eas(["build:list", "--platform", platform, "--limit", String(SHARED_REPACK_LIST_LIMIT), "--json", "--non-interactive"], 2 * 60_000).stdout,
        view: id => eas(["build:view", id, "--json"], 2 * 60_000).stdout });
      if (shared) return shared;
      message = `${message} ${marker}`;
    }
  }
  const workflowPath = join(staged, HOSTED_REPACK_WORKFLOW);
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, hostedRepackWorkflow({ buildId: options.nativeBuildId, profile: options.easProfile,
    environment: options.repackProfile.easEnvironment, message }), { flag: "wx", mode: 0o600 });
  let retries = 0;
  for (;;) {
    if (clock.deadline - clock.now() < HOSTED_REPACK_MIN_ATTEMPT_MS) throw timeoutError(platform, retries ? "too little time was left for another repack" : "too little time was left for a repack of its own");
    try {
      return await hostedRepackRun({ eas, staged, platform, clock });
    } catch (error) {
      // Only a run EAS reported finished gets here with a failure that earns another (hostedRepackRun), so none is left beside it.
      const allowed = hostedRepackRetries(error);
      if (retries >= allowed || clock.deadline - clock.now() < HOSTED_REPACK_MIN_ATTEMPT_MS) throw error;
      retries += 1;
      const logs = error instanceof CiError && typeof error.details?.logs === "string" ? error.details.logs : undefined;
      options.say(`the hosted EAS repack${logs ? ` ${logs}` : ""} failed (${error instanceof Error ? error.message : String(error)}); starting another repack (${retries}/${allowed})`);
      clock.signal?.throwIfAborted();
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
  /** When preparing the app must be done by (HOSTED_REPACK_BUDGET_MS after the session started beside it), on `now`'s clock. */
  deadline?: number | undefined;
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
        clock: { deadline: options.deadline ?? (options.now ?? Date.now)() + HOSTED_REPACK_BUDGET_MS, now: options.now ?? Date.now, sleep: options.sleep, signal: options.signal } });
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
