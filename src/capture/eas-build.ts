import { cp, lstat, realpath, mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, basename, dirname, resolve, join } from "node:path";
import type { SourceRoute } from "../contracts/source-route.js";
import { CiError } from "../shared/ci-errors.js";
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

/** The repacked build id from `eas workflow:run --json`, or the job's failure as a readable error. */
export function hostedRepackBuildId(stdout: string, stderr: string, platform: "ios" | "android"): string {
  const logs = /See logs: (https:\/\/expo\.dev\/\S+)/.exec(stderr)?.[1];
  const where = logs ? ` Logs: ${logs}` : "";
  let value: unknown;
  try {
    value = parseJson(stdout, "eas workflow:run");
  } catch (error) {
    throw new CiError({
      code: "EAS_REPACK_FAILED",
      stage: "instrumentation",
      message: `eas workflow:run did not report the hosted ${platform} repack: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 600) || (error instanceof Error ? error.message : String(error))}`,
      nextAction: `Check that EXPO_TOKEN can run workflows for this EAS project and retry.${where}`,
      cause: error,
    });
  }
  const jobs = isRecord(value) && Array.isArray(value.jobs) ? value.jobs.filter(isRecord) : [];
  const job = jobs.find(entry => entry.key === "repack") ?? jobs[0];
  if (!job || job.status !== "SUCCESS") {
    const build = job && isRecord(job.turtleBuild) ? job.turtleBuild : undefined;
    const detail = build && isRecord(build.error) && typeof build.error.message === "string" ? build.error.message.trim() : undefined;
    const planLimit = easPlanLimitError(new Error(`${detail ?? ""}\n${stderr}`), platform);
    if (planLimit) throw planLimit;
    throw new CiError({
      code: "EAS_REPACK_FAILED",
      stage: "instrumentation",
      message: `The hosted EAS repack of the ${platform} build ${job ? `finished with status ${String(job.status)}` : "did not run"}${detail ? `: ${detail.slice(0, 600)}` : "."}`,
      nextAction: `Open the EAS workflow run and fix the repack job; a broken app build environment usually surfaces in its "Repack" step.${where}`,
    });
  }
  const outputs = isRecord(job.outputs) ? job.outputs : {};
  const buildId = outputs.build_id;
  if (typeof buildId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(buildId)) {
    throw new Error("eas workflow:run did not return the repacked build id");
  }
  return buildId;
}

/**
 * Repack on EAS instead of the runner: the tracked files of the clean checkout are staged beside the
 * observer and a one-job workflow, uploaded with `eas workflow:run`, and the job's `build_id` comes back.
 * No build tools, no `eas upload`, and the profile's EAS environment applies as it does for any build.
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
  const workflowPath = join(staged, HOSTED_REPACK_WORKFLOW);
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, hostedRepackWorkflow({ buildId: options.nativeBuildId, profile: options.easProfile,
    environment: options.repackProfile.easEnvironment, message: `expo-explore ${options.platform} capture: route observer repack` }), { flag: "wx", mode: 0o600 });
  const run = options.runner({
    command: options.easCommand,
    args: ["workflow:run", HOSTED_REPACK_WORKFLOW, "--wait", "--json", "--non-interactive"],
    cwd: staged,
    environment: { ...options.easEnvironment, EAS_NO_VCS: "1", TMPDIR: options.root, TMP: options.root, TEMP: options.root },
    timeoutMs: 30 * 60_000,
    allowFailure: true,
  });
  return hostedRepackBuildId(run.stdout, run.stderr, options.platform);
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
        parameterKeys: captureObserverParameterKeys(options.routes), root });
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
