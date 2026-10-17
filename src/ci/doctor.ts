import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CiError, toCiError } from "../shared/ci-errors.js";
import type { CaptureBundle } from "../contracts/capture.js";
import type { SourceCapturePlan } from "../source/capture-plan.js";
import type { CommandRunner } from "../capture/run.js";
import { runBaselineCi } from "./pipeline.js";
import { DEFAULT_EXPLORE_CONFIG_PATH, configTargets, readExploreConfig, readExploreInstructions, resolveTargetConfig, withRunOverrides, type ExploreConfig, type ExplorePlatform } from "../config/explore-config.js";
import { explorationSecretNames } from "../config/exploration-inputs.js";
import { controllerCached } from "../shared/controller-cache.js";
import { androidTools, hostEmulatorAbi, localSimulatorTarget, localSystemImage } from "../capture/local-simulator.js";
import { ARGENT_VERSION } from "../shared/argent-version.js";
import { AGENT_PROVIDERS as PROVIDERS, DRAFT_INSTRUCTIONS_MARKER, EXPO_TOKENS_URL as TOKENS, appConfig, simulatorProfiles } from "../config/setup.js";
import { captureCompatibility } from "../capture/observer.js";
import { assertCaptureEasProfile, assertSimulatorAvailable, repackProfileFrom, unreproducibleEasVariables } from "../capture/eas-build.js";
import { createCiAgentSession } from "../capture/agent/session.js";
import { readRouteEntry, type RouteEntry, type RouteEntryReport } from "./route-entry.js";
import { LEGACY_VENDOR_DIRECTORY, OPTIONAL_WORKFLOW_FILES, WORKFLOW_FILES, ciLayout, renderWorkflow, workflowIssues, workflowTemplateDrift, workflowVersion } from "./workflow-install.js";
import { EXPLORE_VERSION, TOOL_ROOT, packageBin } from "../shared/package-paths.js";
import type { Progress } from "../shared/progress.js";

/** The setup steps shared by the CI quick start, the setup wizard, the explore-setup skill, and this report. */
export const SETUP_STEPS = {
  1: "Accounts and access",
  2: "App readiness",
  3: "Capture mode",
  4: "Base config",
  5: "Screen entry",
  6: "CI files",
  7: "Repository settings",
  8: "Capture check",
} as const;
export type SetupStep = keyof typeof SETUP_STEPS;
export type DoctorStatus = "pass" | "fail" | "warn" | "skip";
export type DoctorCheck = {
  step: SetupStep; id: string; status: DoctorStatus; message: string;
  code?: string; nextAction?: string; details?: Record<string, unknown>;
};
export type DoctorReport = { ok: boolean; mode: ExploreConfig["mode"] | null; checks: DoctorCheck[]; routes?: RouteEntryReport };
export type DoctorRun = (command: string, args: readonly string[], cwd: string) => { status: number | null; stdout: string; stderr: string };
export type DoctorOptions = {
  project: string;
  /** EAS account, project, simulator access and build environment. */
  online?: boolean;
  /** Repository settings through an authenticated GitHub CLI. */
  github?: boolean;
  /** One small model request with the local provider key. */
  checkModel?: boolean;
  /** `--controller`: the device controller to check, over the config's `capture.controller`. */
  controller?: string | undefined;
  /** `--simulator`: where the app runs, over the config's `capture.simulator`. */
  simulator?: string | undefined;
  run?: DoctorRun;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  createSession?: typeof createCiAgentSession;
};

const WAITLIST = "https://expo.dev/services/simulators";
function defaultRun(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.error ? String(result.error.message) : result.stderr ?? "" };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function lastLine(text: string): string {
  return text.split("\n").map(line => line.trim()).filter(line => line && !/eas-cli@|To upgrade|npm install -g|Proceeding with outdated/.test(line)).at(-1) ?? "";
}

function fromError(step: SetupStep, id: string, error: unknown, fallback: { code: string; nextAction: string }): DoctorCheck {
  if (error instanceof CiError) return { step, id, status: "fail", code: error.code, message: error.message, nextAction: error.nextAction };
  return { step, id, status: "fail", code: fallback.code, message: error instanceof Error ? error.message : String(error), nextAction: fallback.nextAction };
}

function list(values: readonly string[], limit = 8): string {
  return values.length > limit ? `${values.slice(0, limit).join(", ")} and ${values.length - limit} more` : values.join(", ");
}

/** Names referenced as {{secret:NAME}} by setup inputs and agent instructions. */
export function referencedSecretNames(config: ExploreConfig, instructions?: string): string[] {
  return explorationSecretNames([instructions ?? "",
    ...(config.setup ?? []).map(action => action.action === "fill" || action.action === "type" ? action.text : "")].join("\n"));
}

function routeChecks(config: ExploreConfig, report: RouteEntryReport): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const deterministic = config.mode === "deterministic";
  const screens = report.routes.filter(route => route.status !== "redirect");
  const ready = screens.filter(route => route.status === "ready");
  const needs = screens.filter(route => route.status === "needs-parameters");
  const noLink = screens.filter(route => route.status === "no-link");
  checks.push({ step: 5, id: "routes", status: "pass",
    message: `Source analysis found ${screens.length} screens (${report.provider ?? "no provider"}); ${ready.length} open directly by app link.`,
    details: { commit: report.commit } });
  // Parameter gaps are reported per route below; history-dependent back actions only lose a flow edge.
  const unreadable = report.diagnostics.filter(message => !/^(?:Route requires parameter|Unresolved React Navigation linking parameters|History-dependent navigation)/.test(message));
  if (unreadable.length) checks.push({ step: 5, id: "route-diagnostics", status: "warn", code: "SOURCE_ANALYSIS_INCOMPLETE",
    message: `Source analysis could not fully read ${unreadable.length} ${unreadable.length === 1 ? "place" : "places"}: ${list(unreadable, 3)}`,
    nextAction: "Screens or navigation there may be missing from the map. Check these files, and set navigation.entry when the entry module is ambiguous." });
  if (needs.length) checks.push({ step: 5, id: "route-parameters", status: deterministic ? "fail" : "warn", code: "CAPTURE_PARAMETERS_MISSING",
    message: `${needs.length} dynamic ${needs.length === 1 ? "route needs" : "routes need"} parameter values: ${list(needs.map(route => `${route.parameterKey} (${route.missingParameters.join(", ")})`))}.`,
    nextAction: `Add a real value for each under parameters: in ${DEFAULT_EXPLORE_CONFIG_PATH}, for example\n  parameters:\n    ${needs[0]!.parameterKey}:\n      ${needs[0]!.missingParameters[0]}: <value>\n`
      + "Take values from records that exist in the test environment (seed data, fixtures, a test account); never invent an ID."
      + (deterministic ? "" : " Agent mode can also reach these screens through the UI when the instructions say how."),
    details: { routes: needs.map(route => ({ key: route.parameterKey, parameters: route.missingParameters })) } });
  if (noLink.length) checks.push({ step: 5, id: "route-links", status: deterministic ? "fail" : "warn", code: "CAPTURE_LINK_UNSUPPORTED",
    message: config.app.scheme
      ? `${noLink.length} ${noLink.length === 1 ? "screen has" : "screens have"} no app link in source: ${list(noLink.map(route => route.logicalPath))}.`
      : "The app has no custom URL scheme, so no screen can be opened by app link.",
    nextAction: deterministic
      ? (config.app.scheme ? "Declare a linking path for these screens, or switch to agent mode, which reaches screens through the UI."
        : "Add a scheme to the Expo config and app.scheme to config.yaml; deterministic capture opens every screen by app link.")
      : "Describe in the agent instructions how to reach these screens through the UI.",
    details: { routes: noLink.map(route => route.logicalPath) } });
  const guards = new Map<string, RouteEntry[]>();
  for (const route of screens) for (const guard of route.guards) {
    const key = `${guard.sourceFile} → ${guard.to}`;
    guards.set(key, [...guards.get(key) ?? [], route]);
  }
  if (guards.size) {
    const groups = [...guards].map(([key, routes]) => `${key} (${routes.length} ${routes.length === 1 ? "route" : "routes"})`);
    const unprepared = deterministic && !(config.setup ?? []).length;
    checks.push(unprepared
      ? { step: 5, id: "route-guards", status: "warn", code: "ROUTE_GUARD_UNPREPARED",
        message: `Source redirects can send screens elsewhere: ${list(groups, 5)}. config.yaml has no setup, so these screens start in the app's initial state.`,
        nextAction: "Read each guard and add setup actions that put the app in the state it requires, ordered so each screen is reached in the state it should be captured in (the explore-setup skill does this from source). Verify with expo-explore doctor --capture.",
        details: { guards: [...guards].map(([key, routes]) => ({ guard: key, routes: routes.map(route => route.logicalPath) })) } }
      : { step: 5, id: "route-guards", status: "pass",
        message: `Source redirects can send screens elsewhere: ${list(groups, 5)}. ${deterministic
          ? "Doctor cannot tell whether setup establishes the state they need; expo-explore doctor --capture shows it."
          : "The agent instructions should say how to satisfy them."}`,
        details: { guards: [...guards].map(([key, routes]) => ({ guard: key, routes: routes.map(route => route.logicalPath) })) } });
  }
  const searching = screens.filter(route => route.searchParameters.unset.length || route.searchParameters.opaque);
  if (searching.length) checks.push({ step: 5, id: "search-parameters", status: "warn", code: "ROUTE_SEARCH_PARAMETERS_UNSET",
    message: `${searching.length} ${searching.length === 1 ? "screen reads" : "screens read"} search parameters that config.yaml does not set: ${list(searching.map(route =>
      `${route.parameterKey} (${[...route.searchParameters.unset, ...(route.searchParameters.opaque ? ["names in its parameter type"] : [])].join(", ")})`))}. Opened by app link without them, a screen shows its empty or default state.`,
    nextAction: `If that is not the state to review, add the values under parameters: keys that are not path segments become query parameters of the app link, for example\n  parameters:\n    ${searching[0]!.parameterKey}:\n      ${searching[0]!.searchParameters.unset[0] ?? "<name>"}: <value>\nRead the screen to see which values it needs (a record ID, a mode, a flag that keeps a transient screen on display).`,
    details: { routes: searching.map(route => ({ key: route.parameterKey, unset: route.searchParameters.unset, opaque: route.searchParameters.opaque })) } });
  if (report.unusedParameterKeys.length) checks.push({ step: 5, id: "parameter-keys", status: "warn", code: "CONFIG_PARAMETER_UNUSED",
    message: `parameters keys match no discovered route: ${list(report.unusedParameterKeys)}.`,
    nextAction: "Use a route pattern such as /items/[id], its logical path, or its route id, as listed by expo-explore doctor --json." });
  if (report.unknownSetupRoutes.length) checks.push({ step: 5, id: "setup-routes", status: "warn", code: "SETUP_ROUTE_UNKNOWN",
    message: `setup requiresRoute names routes that the committed source does not define: ${list(report.unknownSetupRoutes)}.`,
    nextAction: "Fix the spelling, or keep it only when a pull request adds or removes that route (the other revision then skips the step)." });
  if (report.unknownExcludedRoutes.length) checks.push({ step: 5, id: "excluded-routes", status: "warn", code: "EXCLUDE_ROUTE_UNKNOWN",
    message: `exploration.exclude names routes that the committed source does not define: ${list(report.unknownExcludedRoutes)}. CI fails when no compared revision defines them.`,
    nextAction: "Fix the spelling, or remove the entry once no revision you compare defines that route." });
  return checks;
}

/** Every target, resolved, once per platform, EAS profile and app: targets that differ only by device or pose share these checks. */
function resolvedTargets(config: ExploreConfig, by: (target: ExploreConfig) => string = target => `${target.app.platform}:${target.app.easProfile}:${target.app.bundleId}`): ExploreConfig[] {
  const seen = new Set<string>();
  return configTargets(config).map(target => resolveTargetConfig(config, { target: target.id })).filter(target => !seen.has(by(target)) && !!seen.add(by(target)));
}

/**
 * `capture.simulator: local`, in place of EAS Simulator access: this Mac's Xcode can create each iOS target's device,
 * and the Android SDK can start each Android target's device profile with a system image this machine runs.
 */
async function localSimulatorChecks(project: string, config: ExploreConfig, run: DoctorRun, environment: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const target of resolvedTargets(config, each => `${each.app.platform}:${each.device.name}`)) {
    const device = target.device.name;
    if (target.app.platform === "ios") {
      const types = run("xcrun", ["simctl", "list", "devicetypes", "-j"], project);
      const runtimes = run("xcrun", ["simctl", "list", "runtimes", "-j"], project);
      try {
        if (types.status !== 0 || runtimes.status !== 0) throw new Error(lastLine(types.stderr || runtimes.stderr || "xcrun simctl failed"));
        const local = localSimulatorTarget(types.stdout, runtimes.stdout, device);
        checks.push({ step: 1, id: "local-simulator", status: "pass", message: `This Mac can create an ${device} simulator (iOS ${local.osVersion}).` });
      } catch (error) {
        checks.push(fromError(1, "local-simulator", error, { code: "LOCAL_SIMULATOR_UNAVAILABLE",
          nextAction: "Install Xcode and an iOS simulator runtime for the configured device, select it with xcode-select (or DEVELOPER_DIR), then rerun doctor." }));
      }
      continue;
    }
    try {
      const tools = androidTools(environment);
      const image = await localSystemImage(tools.sdk, hostEmulatorAbi());
      const devices = run(tools.avdmanager, ["list", "device", "-c"], project);
      if (devices.status !== 0) throw new Error(lastLine(devices.stderr || devices.stdout || "avdmanager failed"));
      if (!devices.stdout.split("\n").map(line => line.trim()).includes(device)) throw new CiError({ code: "LOCAL_EMULATOR_DEVICE_UNAVAILABLE", stage: "preflight",
        message: `The Android SDK has no ${device} device profile.`, nextAction: "Set the target's device to a profile listed by avdmanager list device -c, such as pixel_7." });
      checks.push({ step: 1, id: "local-emulator", status: "pass", message: `This machine can start a ${device} emulator (${image.image.split(";").slice(1).join(" ")}).` });
    } catch (error) {
      checks.push(fromError(1, "local-emulator", error, { code: "LOCAL_EMULATOR_UNAVAILABLE",
        nextAction: "Install the Android SDK's emulator, platform-tools, cmdline-tools and a system image with sdkmanager, export ANDROID_HOME, then rerun doctor." }));
    }
  }
  return checks;
}

async function easChecks(project: string, config: ExploreConfig, run: DoctorRun, environment: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  let eas: string;
  try { eas = packageBin("eas-cli", "eas"); if (!await exists(eas)) throw new Error(); }
  catch { return [{ step: 1, id: "eas-cli", status: "fail", code: "EXPLORE_TOOLS_MISSING",
    message: "The EAS CLI that Explore pins is not installed.", nextAction: "Reinstall @expo/explore with optional dependencies, then rerun doctor." }]; }
  const checks: DoctorCheck[] = [];
  const who = run(eas, ["whoami"], project);
  if (who.status !== 0) {
    checks.push({ step: 1, id: "eas-login", status: "fail", code: "EAS_NOT_AUTHENTICATED", message: "The EAS CLI is not signed in.",
      nextAction: `Run eas login (or export EXPO_TOKEN from ${TOKENS}), then rerun doctor.` });
    return checks;
  }
  const account = who.stdout.split("\n").map(line => line.trim()).find(Boolean) ?? "your account";
  checks.push({ step: 1, id: "eas-login", status: "pass", message: `Signed in to Expo as ${account}.` });
  const info = run(eas, ["project:info"], project);
  checks.push(info.status === 0
    ? { step: 1, id: "eas-project", status: "pass", message: "The app is linked to an EAS project this account can access." }
    : { step: 1, id: "eas-project", status: "fail", code: "EAS_PROJECT_UNAVAILABLE", message: `EAS project check failed: ${lastLine(info.stderr || info.stdout)}`,
      nextAction: "Run eas init in the app directory to link it, or ask the project's owner for access. The CI EXPO_TOKEN must belong to an account with the same access." });
  if (config.capture.simulator === "local") checks.push(...await localSimulatorChecks(project, config, run, environment));
  else {
    const availability = run(eas, ["simulator:availability", "--json", "--non-interactive"], project);
    try {
      if (availability.status !== 0) throw new Error(lastLine(availability.stderr || availability.stdout));
      assertSimulatorAvailable(availability.stdout);
      checks.push({ step: 1, id: "eas-simulator", status: "pass", message: "EAS Simulator is available for this account." });
    } catch (error) {
      checks.push({ ...fromError(1, "eas-simulator", error, { code: "SIMULATOR_UNAVAILABLE", nextAction: "" }),
        code: "SIMULATOR_UNAVAILABLE", nextAction: `Join the EAS Simulator waitlist at ${WAITLIST} with ${account}, the account the CI EXPO_TOKEN must use. Capture cannot run until access is granted.` });
    }
  }
  const checkedEnvironments = new Set<string>();
  for (const target of resolvedTargets(config)) {
    const { platform, easProfile, bundleId } = target.app;
    const resolved = run(eas, ["config", "--platform", platform, "--profile", easProfile, "--json", "--non-interactive"], project);
    if (resolved.status !== 0) {
      checks.push({ step: 2, id: "eas-profile", status: "fail", code: "EAS_CONFIG_FAILED", message: `eas config failed for profile ${easProfile} (${platform}): ${lastLine(resolved.stderr || resolved.stdout)}`,
        nextAction: "Install the app dependencies and supply any environment the app config needs, then rerun doctor." });
      continue;
    }
    let environment: string;
    let environmentSource = "";
    try {
      const value = JSON.parse(resolved.stdout) as { appConfig: Record<string, unknown>; buildProfile: Record<string, unknown> };
      assertCaptureEasProfile(value, bundleId, platform);
      environment = repackProfileFrom(resolved.stdout).easEnvironment;
      environmentSource = value.buildProfile.environment === undefined
        ? `the EAS environment that profile ${easProfile} uses by default`
        : `the EAS environment that profile ${easProfile} selects`;
      const schemes = [value.appConfig.scheme].flat().filter((scheme): scheme is string => typeof scheme === "string").map(scheme => scheme.toLowerCase());
      checks.push(config.app.scheme && schemes.length && !schemes.includes(config.app.scheme)
        ? { step: 2, id: "eas-profile", status: "fail", code: "APP_SCHEME_MISMATCH",
          message: `app.scheme ${config.app.scheme} is not a scheme of the app built by profile ${easProfile} (${schemes.join(", ")}).`,
          nextAction: `Set app.scheme in ${DEFAULT_EXPLORE_CONFIG_PATH} to one of: ${schemes.join(", ")}.` }
        : { step: 2, id: "eas-profile", status: "pass", message: platform === "ios"
          ? `Profile ${easProfile} builds ${bundleId} for the iOS Simulator.` : `Profile ${easProfile} builds ${bundleId} as an Android APK.` });
    } catch (error) {
      checks.push(fromError(2, "eas-profile", error, { code: "EAS_CONFIG_FAILED", nextAction: "Check the profile in eas.json and rerun doctor." }));
      continue;
    }
    if (checkedEnvironments.has(environment)) continue;
    checkedEnvironments.add(environment);
    const names = new Set<string>();
    let listed = true;
    for (const scope of ["project", "account"]) {
      const variables = run(eas, ["env:list", environment, "--scope", scope], project);
      if (variables.status !== 0) { listed = false; continue; }
      for (const name of unreproducibleEasVariables(variables.stdout)) names.add(name);
    }
    checks.push(names.size
      ? { step: 2, id: "eas-environment", status: "fail", code: "CAPTURE_OBSERVER_BUILD_UNSUPPORTED",
        message: `EAS environment ${environment} has secret-visibility or file variables that capture cannot rebuild with: ${[...names].sort().join(", ")}.`,
        nextAction: `Change them to plain text or sensitive visibility, or point profile ${easProfile} at an environment without them (build.${easProfile}.environment in eas.json).` }
      : listed
        ? { step: 2, id: "eas-environment", status: "pass", message: `EAS environment ${environment} (${environmentSource}) has no variables that stop capture from rebuilding the app.` }
        : { step: 2, id: "eas-environment", status: "warn", code: "EAS_ENVIRONMENT_UNCHECKED", message: `Could not list the variables of EAS environment ${environment}.`,
          nextAction: "Check that it has no secret-visibility or file variables; capture cannot rebuild with them." });
  }
  return checks;
}

/** `named`: the config names its own targets, so only a workflow with a target matrix captures each one. */
async function ciFileChecks(project: string, secretNames: readonly string[], run: DoctorRun, online: boolean, platformCount = 1, named = false): Promise<{ checks: DoctorCheck[]; root?: string }> {
  let layout: Awaited<ReturnType<typeof ciLayout>>;
  try { layout = await ciLayout(project); }
  catch (error) { return { checks: [fromError(6, "repository", error, { code: "NOT_A_GIT_REPOSITORY", nextAction: "Put the app in a Git repository, commit it, and rerun doctor." })] }; }
  const checks: DoctorCheck[] = [];
  const versions = new Set<string>();
  if (await exists(join(layout.root, LEGACY_VENDOR_DIRECTORY))) checks.push({ step: 6, id: "tools-snapshot", status: "warn", code: "TOOLS_SNAPSHOT_UNUSED",
    message: `${LEGACY_VENDOR_DIRECTORY} is no longer used. CI installs @expo/explore from npm.`,
    nextAction: `Delete ${LEGACY_VENDOR_DIRECTORY} and the EXPLORE_TOOLS_COMMIT repository variable.` });
  for (const name of WORKFLOW_FILES) {
    const file = `.github/workflows/${name}`;
    const path = join(layout.root, file);
    if (!await exists(path)) {
      checks.push(OPTIONAL_WORKFLOW_FILES.has(name)
        ? { step: 6, id: `workflow-${name}`, status: "warn", code: "WORKFLOW_MISSING", message: `${file} is missing, so reviews of two commits without a pull request (a tag against the last release, say) cannot run.`,
          nextAction: "Run expo-explore setup --workflows to add it, then commit it." }
        : { step: 6, id: `workflow-${name}`, status: "fail", code: "WORKFLOW_MISSING", message: `${file} is missing.`,
          nextAction: "Run expo-explore setup --workflows, then commit the workflows." });
      continue;
    }
    const text = await readFile(path, "utf8");
    const issues = workflowIssues(file, text, { ...layout, secretNames });
    checks.push(...issues.map(issue => ({ step: 6 as const, id: `workflow-${name}`, status: "fail" as const, code: issue.code, message: issue.message, nextAction: issue.nextAction })));
    if (issues.length) continue;
    const version = workflowVersion(text)!;
    versions.add(version);
    checks.push({ step: 6, id: `workflow-${name}`, status: "pass", message: `${file} installs @expo/explore ${version} and matches the app layout${secretNames.length ? " and passes its app-test secrets" : ""}.` });
    if (version !== EXPLORE_VERSION) checks.push({ step: 6, id: `workflow-version-${name}`, status: "warn", code: "EXPLORE_VERSION_DIFFERENT",
      message: `${file} installs @expo/explore ${version}, but this CLI is ${EXPLORE_VERSION}.`,
      nextAction: "Run expo-explore setup --workflows with the version CI should use, then commit the workflows." });
    const template = await readFile(join(TOOL_ROOT, "templates", name), "utf8");
    const drift = workflowTemplateDrift(text, renderWorkflow(template, { ...layout, secretNames }));
    if (drift) checks.push({ step: 6, id: `workflow-template-${name}`, status: "warn", code: "WORKFLOW_TEMPLATE_DRIFT",
      message: `${file} ${drift === "stale" ? "was generated by an older @expo/explore template" : "differs from the @expo/explore template (edited after setup, or generated by an older version)"}; steps the ${EXPLORE_VERSION} template adds (such as installing ffmpeg for launch recordings) are missing from CI.`,
      nextAction: drift === "stale" ? "Run expo-explore setup --workflows, then commit the workflows." : "Run expo-explore setup --workflows --force to regenerate it (reapply your edits), then commit the workflows." });
    // Workflows installed before targets run one job per platform, which covers a config whose targets are its platforms.
    const matrix = text.includes("matrix.target") || (text.includes("matrix.platform") && !named);
    if (platformCount > 1 && !matrix) checks.push({ step: 6, id: `workflow-platforms-${name}`, status: "warn", code: "WORKFLOW_PLATFORM_MATRIX_MISSING",
      message: `${DEFAULT_EXPLORE_CONFIG_PATH} configures ${platformCount} targets, but ${file} does not capture each one (no matrix.target).`,
      nextAction: "Run expo-explore setup --workflows to install the matrix workflows, then commit them." });
  }
  if (online) for (const version of versions) {
    const published = run("npm", ["view", `@expo/explore@${version}`, "version"], layout.root);
    if (published.status !== 0 || published.stdout.trim() !== version) checks.push({ step: 6, id: "explore-version", status: "fail", code: "EXPLORE_VERSION_UNPUBLISHED",
      message: `@expo/explore ${version} is not on npm, so CI cannot install it.`,
      nextAction: "Run expo-explore setup --workflows with a published @expo/explore (npx @expo/explore@latest setup --workflows)." });
  }
  return { checks, root: layout.root };
}

function githubChecks(root: string, config: ExploreConfig, secretNames: readonly string[], run: DoctorRun): DoctorCheck[] {
  const required = ["EXPO_TOKEN", ...(config.mode === "agent" && config.agent ? [PROVIDERS[config.agent.provider].secret] : []), ...secretNames];
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], root);
  let repo: string; let branch: string;
  try {
    if (repository.status !== 0) throw new Error();
    const value = JSON.parse(repository.stdout) as { nameWithOwner: string; defaultBranchRef: { name: string } };
    repo = value.nameWithOwner; branch = value.defaultBranchRef.name;
    if (!repo || !branch) throw new Error();
  } catch {
    const detail = `${repository.stderr}`;
    const reason = repository.status === null ? "The GitHub CLI (gh) is not installed."
      : /auth login|not logged|authentication/i.test(detail) ? "The GitHub CLI is not signed in."
      : /remote/i.test(detail) ? "The repository has no GitHub remote yet."
      : `The GitHub CLI could not read the repository: ${lastLine(detail) || "unknown error"}.`;
    return [{ step: 7, id: "github", status: "skip", message: `${reason} Repository settings were not checked.`,
      nextAction: `Check by hand in GitHub → Settings → Secrets and variables → Actions: secrets ${required.join(", ")}; and that both workflows are on the default branch. Or run gh auth login and rerun doctor.` }];
  }
  const checks: DoctorCheck[] = [];
  // pull_request_target runs the default branch's copy, so it must match the local workflow, not just exist.
  const remote = (path: string, ref: string): string | undefined => {
    const result = run("gh", ["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, "--jq", ".content"], root);
    return result.status === 0 ? Buffer.from(result.stdout.replace(/\\n|\s/g, ""), "base64").toString("utf8") : undefined;
  };
  const stale = WORKFLOW_FILES.flatMap(name => {
    const path = `.github/workflows/${name}`;
    const published = remote(path, branch);
    let local: string | undefined;
    try { local = readFileSync(join(root, path), "utf8"); } catch { /* Reported by the CI file checks. */ }
    if (local === undefined && OPTIONAL_WORKFLOW_FILES.has(name)) return [];
    return published === undefined ? [`${name} (missing)`] : local !== undefined && published !== local ? [`${name} (different)`] : [];
  });
  checks.push(stale.length
    ? { step: 7, id: "default-branch", status: "fail", code: "WORKFLOW_NOT_ON_DEFAULT_BRANCH",
      message: `${branch} does not have this checkout's workflows: ${stale.join(", ")}. Pull request reviews run the default branch's workflow.`,
      nextAction: `Commit the Explore files and merge them into ${branch}.` }
    : { step: 7, id: "default-branch", status: "pass", message: `${branch} has the same workflows as this checkout.` });
  const secrets = run("gh", ["secret", "list", "--json", "name", "-R", repo], root);
  try {
    if (secrets.status !== 0) throw new Error("list");
    const present = new Set((JSON.parse(secrets.stdout) as Array<{ name: string }>).map(secret => secret.name));
    const missing = required.filter(name => !present.has(name));
    checks.push(missing.length
      ? { step: 7, id: "secrets", status: "fail", code: missing.includes("EXPO_TOKEN") ? "EXPO_TOKEN_MISSING"
        : config.agent && missing.includes(PROVIDERS[config.agent.provider].secret) ? "AGENT_API_KEY_MISSING" : "EXPLORATION_SECRET_MISSING",
        message: `Repository secrets are missing: ${missing.join(", ")}.`,
        nextAction: [
          ...missing.map(name => `gh secret set ${name} -R ${repo}`
            + (name === "EXPO_TOKEN" ? `   # create the token at ${TOKENS}` : "")
            + (config.agent && name === PROVIDERS[config.agent.provider].secret ? `   # create the key at ${PROVIDERS[config.agent.provider].keys}` : "")),
          "An organization secret also works if this repository can read it; this check sees repository secrets only.",
        ].join("\n") }
      : { step: 7, id: "secrets", status: "pass", message: `Repository secrets are set: ${required.join(", ")}.` });
  } catch {
    checks.push({ step: 7, id: "secrets", status: "skip", message: "Could not list repository secrets (repository admin access is needed).",
      nextAction: `Check these secrets in GitHub → Settings → Secrets and variables → Actions: ${required.join(", ")}.` });
  }
  return checks;
}

/**
 * Check that a repository is ready for Explore CI and say how to fix what is not. Every check is
 * read-only; only --check-model sends one small model request.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const run = options.run ?? defaultRun;
  const environment = options.environment ?? process.env;
  const checks: DoctorCheck[] = [];
  const project = await realpath(options.project);
  const [major = 0, minor = 0] = (options.nodeVersion ?? process.versions.node).split(".").map(Number);
  checks.push(major > 24 || major === 24 && minor >= 12
    ? { step: 2, id: "node", status: "pass", message: `Node.js ${options.nodeVersion ?? process.versions.node}.` }
    : { step: 2, id: "node", status: "fail", code: "NODE_UNSUPPORTED", message: `Node.js ${options.nodeVersion ?? process.versions.node} is too old for the Explore CLI.`, nextAction: "Install Node.js 24.12 or newer." });
  let dependencies: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as Record<string, Record<string, unknown>>;
    dependencies = { ...pkg.devDependencies, ...pkg.dependencies };
  } catch { /* Reported below as a missing Expo app. */ }
  if (!dependencies.expo) {
    checks.push({ step: 2, id: "app", status: "fail", code: "APP_NOT_EXPO", message: `${project} is not an Expo app directory.`,
      nextAction: "Run doctor from the Expo app directory, or pass --project apps/mobile." });
    return { ok: false, mode: null, checks };
  }
  if (!await exists(join(project, DEFAULT_EXPLORE_CONFIG_PATH))) {
    checks.push({ step: 1, id: "eas", status: "skip", message: options.online === false
      ? "EAS login, project, simulator access and build profile were not checked (--offline)."
      : "EAS login, project, simulator access and build profile are checked once a config exists." });
    checks.push({ step: 4, id: "config", status: "fail", code: "CONFIG_MISSING", message: `${DEFAULT_EXPLORE_CONFIG_PATH} does not exist.`,
      nextAction: "Run expo-explore setup, or ask your coding agent to set up Explore with the explore-setup skill." });
    // Route analysis before a config exists, so the capture mode can be chosen from it.
    let routes: RouteEntryReport | undefined;
    try {
      const app = await appConfig(project);
      const scheme = [app.scheme].flat().find((value): value is string => typeof value === "string")?.toLowerCase();
      routes = readRouteEntry(project, { navigation: { provider: dependencies["expo-router"] ? "expo-router" : "auto" },
        app: { platform: "ios", bundleId: "com.example.app", easProfile: "explore", ...(scheme ? { scheme } : {}) } });
      const screens = routes.routes.filter(route => route.status !== "redirect");
      const count = (status: string) => screens.filter(route => route.status === status).length;
      checks.push({ step: 3, id: "routes", status: "pass",
        message: `Source analysis for choosing a mode (${routes.provider ?? "no provider"}): ${screens.length} ${screens.length === 1 ? "screen" : "screens"}; ${count("ready")} open by app link, `
          + `${count("needs-parameters")} need parameter values, ${count("no-link")} have no app link, ${screens.filter(route => route.guards.length).length} sit behind source redirects, `
          + `${screens.filter(route => route.searchParameters.unset.length || route.searchParameters.opaque).length} read search parameters.` });
    } catch (error) {
      checks.push({ step: 3, id: "routes", status: "skip", message: `Source analysis did not run: ${(error as Error).message}` });
    }
    return { ok: false, mode: null, checks, ...(routes ? { routes } : {}) };
  }
  let config: ExploreConfig;
  try { config = withRunOverrides(await readExploreConfig(project), { controller: options.controller, simulator: options.simulator }); }
  catch (error) {
    checks.push(fromError(4, "config", error, { code: "CONFIG_INVALID", nextAction: `Correct ${DEFAULT_EXPLORE_CONFIG_PATH} and rerun doctor.` }));
    return { ok: false, mode: null, checks };
  }
  checks.push({ step: 4, id: "config", status: "pass", message: `${DEFAULT_EXPLORE_CONFIG_PATH} is valid.` });
  checks.push(config.mode === "agent"
    ? { step: 3, id: "mode", status: "pass", message: `Agent mode with ${config.agent!.provider} ${config.agent!.model}. Capture navigation uses the model and is billed to your ${config.agent!.provider} account.` }
    : { step: 3, id: "mode", status: "pass", message: "Deterministic mode: capture replays config.yaml without a model, so it needs no API key and has no AI charges." });
  if (config.capture.controller === "argent") checks.push(argentCheck(environment));
  if (config.capture.launch !== "off") {
    const ffmpeg = run("ffmpeg", ["-version"], project);
    checks.push(ffmpeg.status === 0
      ? { step: 3, id: "launch-decoder", status: "pass", message: `ffmpeg is installed: launch recordings are decoded to find the splash screen (capture.launch: ${config.capture.launch}).` }
      : { step: 3, id: "launch-decoder", status: "warn", code: "LAUNCH_DECODER_MISSING",
        message: "ffmpeg is not installed on this machine, so the splash screen can only be observed from screenshots; on Android it usually finishes before the first one.",
        nextAction: "Install ffmpeg on the capture runner (the generated workflows do; rerun `expo-explore setup --workflows` if yours predate 0.15.2), or set capture.launch: off." });
  }
  try {
    const eas = JSON.parse(await readFile(join(project, "eas.json"), "utf8")) as Record<string, unknown>;
    for (const target of resolvedTargets(config)) {
      const { platform, easProfile } = target.app;
      const requirement = platform === "ios" ? "ios.simulator: true" : "android.buildType: apk";
      if (!simulatorProfiles(eas, platform).includes(easProfile)) throw new CiError({ code: platform === "ios" ? "EAS_PROFILE_NOT_SIMULATOR" : "EAS_PROFILE_NOT_APK", stage: "preflight",
        message: `eas.json profile ${easProfile} is missing or does not set ${requirement}.`,
        nextAction: `Add build.${easProfile}.${requirement} to eas.json (keep the other profiles).` });
      checks.push({ step: 2, id: "eas-json", status: "pass", message: platform === "ios"
        ? `eas.json profile ${easProfile} builds for the iOS Simulator.` : `eas.json profile ${easProfile} builds an Android APK.` });
    }
  } catch (error) {
    checks.push(fromError(2, "eas-json", error, { code: "EAS_PROFILE_NOT_SIMULATOR", nextAction: config.app.platform === "android"
      ? "Add an eas.json profile with android.buildType: apk and set app.easProfile to it."
      : "Add an eas.json profile with ios.simulator: true and set app.easProfile to it." }));
  }
  checks.push(config.app.scheme
    ? { step: 2, id: "scheme", status: "pass", message: `App links use the scheme ${config.app.scheme}://.` }
    : { step: 2, id: "scheme", status: config.mode === "deterministic" ? "fail" : "warn", code: "APP_SCHEME_MISSING",
      message: "config.yaml has no app.scheme, so capture cannot open screens by app link.",
      nextAction: "Add a scheme to the Expo config (expo.scheme) and set app.scheme in config.yaml to it." });
  let routes: RouteEntryReport | undefined;
  try {
    routes = readRouteEntry(project, config);
    checks.push(...routeChecks(config, routes));
  } catch (error) {
    checks.push(fromError(5, "routes", error, { code: "SOURCE_ANALYSIS_FAILED", nextAction: "Commit the app source and check navigation.provider and navigation.entry." }));
  }
  const provider = routes?.provider ?? (config.navigation.provider === "auto" ? (dependencies["expo-router"] ? "expo-router" : "react-navigation") : config.navigation.provider);
  try {
    const compatibility = await captureCompatibility(project, provider);
    checks.push({ step: 2, id: "compatibility", status: "pass", message: `Expo ${compatibility.expoVersion} with ${provider} ${compatibility.navigationVersion} supports capture.` });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND";
    checks.push({ step: 2, id: "compatibility", status: "fail", code: missing ? "APP_DEPENDENCIES_MISSING" : "CAPTURE_OBSERVER_UNSUPPORTED",
      message: missing ? "The app's dependencies are not installed, so capture compatibility cannot be checked." : (error as Error).message,
      nextAction: missing ? "Install the app dependencies from its lockfile, then rerun doctor." : "Use Expo SDK 57 or newer, with Expo Router 57 or newer or React Navigation 6 or newer." });
  }
  let instructions: string | undefined;
  if (config.mode === "agent" && config.agent) {
    instructions = (await readExploreInstructions(project, config))?.text;
    const path = config.agent.instructions!;
    const tracked = run("git", ["ls-files", "--error-unmatch", "--", path], project).status === 0;
    checks.push(tracked
      ? { step: 5, id: "instructions", status: "pass", message: `${path} is committed.` }
      : { step: 5, id: "instructions", status: "fail", code: "AGENT_INSTRUCTIONS_UNCOMMITTED", message: `${path} is not committed.`, nextAction: `Commit ${path} together with ${DEFAULT_EXPLORE_CONFIG_PATH}.` });
    if (instructions?.includes(DRAFT_INSTRUCTIONS_MARKER)) checks.push({ step: 5, id: "instructions-draft", status: "warn", code: "AGENT_INSTRUCTIONS_DRAFT",
      message: `${path} is still the generated draft.`,
      nextAction: "Have your coding agent rewrite it from the app's source with the explore-setup skill (how to reach screens, prerequisites and test inputs, readiness, actions to avoid), then remove the draft comment." });
    const setup = PROVIDERS[config.agent.provider];
    if (!options.checkModel) checks.push({ step: 1, id: "model", status: "skip",
      message: `The ${config.agent.provider} key and model ${config.agent.model} were not tried.`,
      nextAction: `Export ${setup.secret} and run expo-explore doctor --check-model to send one small request (a small API charge). Create a key at ${setup.keys}; model IDs: ${setup.models}.` });
    else if (!environment[setup.secret]?.trim()) checks.push({ step: 1, id: "model", status: "fail", code: "AGENT_API_KEY_MISSING",
      message: `${setup.secret} is not set in this shell.`, nextAction: `Create a key at ${setup.keys}, export ${setup.secret}, and rerun with --check-model. CI needs the same key as a repository secret.` });
    else {
      try {
        await (options.createSession ?? createCiAgentSession)(config.agent, { env: environment }).preflight({ timeoutMs: 30_000 });
        checks.push({ step: 1, id: "model", status: "pass", message: `${config.agent.provider} accepted the key and model ${config.agent.model}.` });
      } catch (error) {
        checks.push(fromError(1, "model", error, { code: "AGENT_PREFLIGHT_FAILED", nextAction: `Check the key and that ${config.agent.model} is a model your account can use (${setup.models}).` }));
      }
    }
  }
  const secretNames = referencedSecretNames(config, instructions);
  const files = await ciFileChecks(project, secretNames, run, options.online !== false, configTargets(config).length, !!config.targets);
  checks.push(...files.checks);
  if (files.root) {
    const pending = run("git", ["status", "--porcelain", "--untracked-files=all", "--", DEFAULT_EXPLORE_CONFIG_PATH, ...(config.agent?.instructions ? [config.agent.instructions] : [])], project).stdout
      + run("git", ["status", "--porcelain", "--untracked-files=normal", "--", ...WORKFLOW_FILES.map(name => `.github/workflows/${name}`)], files.root).stdout;
    const paths = [...new Set(pending.split("\n").map(line => line.slice(3).trim()).filter(Boolean))];
    if (paths.length) checks.push({ step: 6, id: "committed", status: "fail", code: "SETUP_FILES_UNCOMMITTED",
      message: `Setup files are not committed: ${list(paths)}. CI reads them from the pushed repository.`,
      nextAction: "Commit them, push, and merge them into the default branch." });
  }
  if (options.online !== false) checks.push(...await easChecks(project, config, run, environment));
  else checks.push({ step: 1, id: "eas", status: "skip", message: "EAS login, project, simulator access and build profile were not checked (--offline)." });
  if (options.github !== false && files.root) checks.push(...githubChecks(files.root, config, secretNames, run));
  else if (files.root) checks.push({ step: 7, id: "github", status: "skip", message: `Repository settings were not checked (${options.online === false ? "--offline" : "--no-github"}).` });
  checks.sort((a, b) => a.step - b.step);
  return { ok: !checks.some(check => check.status === "fail"), mode: config.mode, checks, ...(routes ? { routes } : {}) };
}

const MARKS: Record<DoctorStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "-" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`Expo Explore doctor${report.mode ? ` — ${report.mode} mode` : ""}`];
  for (const [step, title] of Object.entries(SETUP_STEPS)) {
    const checks = report.checks.filter(check => check.step === Number(step));
    if (!checks.length) continue;
    lines.push("", `${step}. ${title}`);
    for (const check of checks) {
      lines.push(`  ${MARKS[check.status]} ${check.message}${check.code && check.status !== "pass" ? ` [${check.code}]` : ""}`);
      if (check.nextAction && check.status !== "pass") lines.push(...check.nextAction.split("\n").map((line, index) => `    ${index ? "  " : "→ "}${line}`));
    }
  }
  const failures = report.checks.filter(check => check.status === "fail").length;
  const warnings = report.checks.filter(check => check.status === "warn").length;
  const skipped = report.checks.filter(check => check.status === "skip").length;
  const review = warnings ? `, ${warnings} to review` : "";
  lines.push("", failures ? `${failures} ${failures === 1 ? "problem" : "problems"} to fix${review}. Fix ${failures === 1 ? "it" : "them"} and rerun expo-explore doctor.`
    : skipped ? `No problems in the checks that ran${review}; ${skipped} ${skipped === 1 ? "check was" : "checks were"} skipped (marked -), so this is not yet a complete check.`
    : warnings ? `Ready, with ${warnings} ${warnings === 1 ? "item" : "items"} to review.` : "Ready for Explore CI.");
  return lines.join("\n");
}


export type CaptureCheckRoute = {
  id: string; route: string; status: "captured" | "problem" | "not-run";
  screenshot?: string; code?: string; message?: string; nextAction?: string;
};
export type CaptureCheckResult = {
  ok: boolean; commit: string; output: string; routes: CaptureCheckRoute[];
  failure?: { code: string; message: string; nextAction: string };
};

const OUTCOME_ADVICE: Record<string, { code: string; message: string; nextAction: string }> = {
  "missing-params": { code: "CAPTURE_PARAMETERS_MISSING", message: "The route needs parameter values.", nextAction: "Add real values under parameters in config.yaml." },
  "unsupported-link": { code: "CAPTURE_LINK_UNSUPPORTED", message: "The route has no app link.", nextAction: "Declare a linking path for it, or use agent mode." },
  "budget-exhausted": { code: "CAPTURE_BUDGET_EXHAUSTED", message: "The capture budget ran out first.", nextAction: "Raise capture.maxMinutes or capture.maxActions in config.yaml." },
  failed: { code: "CAPTURE_FAILED", message: "The capture failed.", nextAction: "Inspect capture-diagnostics in the output directory." },
};

/** Route-by-route results of a capture check, from the plan and whatever bundle the run left behind. */
export function summarizeCaptureCheck(plan: SourceCapturePlan, bundle: CaptureBundle | undefined, exportDirectory: string): CaptureCheckRoute[] {
  const names = new Map(plan.surfaces.map(surface => [surface.id, surface.headSurface?.logicalPath ?? surface.headSurface?.route ?? surface.id]));
  return plan.headCaptureSurfaceIds.map((id): CaptureCheckRoute => {
    const route = names.get(id) ?? id;
    const outcome = bundle?.outcomes[id];
    if (!outcome) return { id, route, status: "not-run", message: "The run stopped before this route." };
    const image = bundle?.images[id];
    if (outcome.status === "captured" && outcome.landing === "verified") {
      return { id, route, status: "captured", ...(image ? { screenshot: join(exportDirectory, image.path) } : {}) };
    }
    const advice = outcome.error ?? (outcome.status === "captured"
      ? { code: "CAPTURE_LANDING_UNVERIFIED", message: "A screenshot was taken, but the app was not on this route.",
        nextAction: "The screen probably redirected: prepare the state it needs with setup actions (or agent instructions)." }
      : OUTCOME_ADVICE[outcome.status]!);
    return { id, route, status: "problem", code: advice.code, message: outcome.reason ?? advice.message, nextAction: advice.nextAction,
      ...(image ? { screenshot: join(exportDirectory, image.path) } : {}) };
  });
}

/**
 * Capture the committed HEAD the way the baseline workflow does, with the local EAS login. This is
 * the only doctor step that starts an EAS build and a simulator session.
 */
/** An Argent capture records one appearance, and fetches the pinned Argent release on first use. agent-device, the default, is not reported. */
function argentCheck(environment: NodeJS.ProcessEnv): DoctorCheck {
  const cached = controllerCached("argent", environment);
  return { step: 3, id: "controller", status: "warn", code: "CONTROLLER_APPEARANCE_FIXED",
    message: `Device controller: Argent ${ARGENT_VERSION} (${cached ? "cached on this machine" : "fetched from npm on the first capture, about 27 MB"}). `
      + "Argent cannot switch the simulator's appearance yet (software-mansion/argent#1509), so each capture records one appearance: the app's forced one, else light.",
    nextAction: "Nothing to do unless you need dark-mode screenshots; use agent-device (the default) for those." };
}

export async function runCaptureCheck(options: { project: string; output: string; platform?: ExplorePlatform; controller?: string | undefined; simulator?: string | undefined; target?: string | undefined; environment?: NodeJS.ProcessEnv; runner?: CommandRunner; progress?: Progress }): Promise<CaptureCheckResult> {
  const project = await realpath(options.project);
  const git = (...args: string[]) => spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 10_000 });
  const head = git("rev-parse", "HEAD");
  if (head.status !== 0) throw new CiError({ code: "CAPTURE_CHECK_UNCOMMITTED", stage: "preflight", message: "The app has no commit to capture.",
    nextAction: "Commit the app and its .expo-explore files (a local commit is enough), then rerun." });
  const pending = git("status", "--porcelain", "--untracked-files=normal").stdout.split("\n").map(line => line.slice(3).trim()).filter(Boolean);
  if (pending.length) throw new CiError({ code: "CAPTURE_CHECK_UNCOMMITTED", stage: "preflight",
    message: `The checkout has uncommitted or untracked files (${list(pending, 5)}); the capture check reads the committed source, as CI does.`,
    nextAction: "Commit your changes, including .expo-explore (a local commit is enough; nothing is pushed), then rerun. "
      + "To keep unrelated files, run it from a clean checkout instead: git worktree add --detach ../app-capture HEAD, install the app's dependencies there, and run doctor --capture in it." });
  const commit = head.stdout.trim();
  const config = withRunOverrides(resolveTargetConfig(await readExploreConfig(project), { platform: options.platform, target: options.target }), { controller: options.controller, simulator: options.simulator });
  // Capture keeps its working directories in the system temporary directory, outside the app.
  await mkdir(options.output, { recursive: true });
  const output = await realpath(options.output);
  const temporary = await realpath(tmpdir());
  if (!output.startsWith(`${temporary}${sep}`) || output.startsWith(`${project}${sep}`)) throw new CiError({ code: "CAPTURE_CHECK_OUTPUT_INVALID", stage: "preflight",
    message: `The capture check output ${output} is not inside the system temporary directory ${temporary}.`,
    nextAction: "Omit --output to use a new temporary directory, or pass a directory inside the system temporary directory." });
  let failure: CaptureCheckResult["failure"];
  try {
    // Agent mode with no API key set uses the local claude or codex login, as a local review does.
    const subscription = config.mode === "agent" && config.agent !== undefined && !(options.environment ?? process.env)[PROVIDERS[config.agent.provider].secret]?.trim();
    await runBaselineCi({ ...(options.platform ? { platform: options.platform } : {}), project, sha: commit, output, config, useLocalEasSession: true,
      ...(subscription ? { subscription: true } : {}),
      ...(options.environment ? { environment: options.environment } : {}), ...(options.runner ? { runner: options.runner } : {}),
      ...(options.progress ? { progress: options.progress } : {}) });
  } catch (error) {
    const ci = toCiError(error);
    failure = { code: ci.code, message: ci.message, nextAction: ci.nextAction };
  }
  const read = async <T>(path: string): Promise<T | undefined> => {
    try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return undefined; }
  };
  const plan = await read<SourceCapturePlan>(join(output, "execution-plan.json"));
  const exportDirectory = join(output, "baseline-export");
  const routes = plan ? summarizeCaptureCheck(plan, await read<CaptureBundle>(join(exportDirectory, "bundle.json")), exportDirectory) : [];
  return { ok: !failure && routes.every(route => route.status === "captured"), commit, output, routes, ...(failure ? { failure } : {}) };
}

export function formatCaptureCheck(result: CaptureCheckResult): string {
  const captured = result.routes.filter(route => route.status === "captured");
  const lines = [`Capture check of ${result.commit.slice(0, 12)}: ${captured.length} of ${result.routes.length} routes captured.`];
  if (result.failure) lines.push(`  ✗ ${result.failure.message} [${result.failure.code}]`, `    → ${result.failure.nextAction}`);
  for (const route of result.routes.filter(item => item.status !== "captured")) {
    lines.push(`  ${route.status === "problem" ? "✗" : "-"} ${route.route}: ${route.message}${route.code ? ` [${route.code}]` : ""}`);
    if (route.nextAction) lines.push(`    → ${route.nextAction}`);
  }
  lines.push(`Screenshots and diagnostics: ${result.output}`,
    "Open the screenshots of guarded screens to confirm each is in the state you meant to review, not just reachable.");
  return lines.join("\n");
}
