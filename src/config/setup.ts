import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { DEFAULT_EXPLORE_CONFIG_PATH, readExploreConfig, validateExploreConfig, type ExploreConfig, type ExplorePlatform } from "./explore-config.js";
import { explorationSecretNames } from "./exploration-inputs.js";
import type { RouteEntryReport } from "../ci/route-entry.js";
import type { CiInstallResult } from "../ci/workflow-install.js";

/** Simulator models observed on EAS (iOS 26.5, 2026-09-08). Suggestions only; capture checks availability. */
const CAPTURE_DEVICE_MODELS = [
  "iPhone 17", "iPhone 17 Pro", "iPhone 17 Pro Max", "iPhone 17e", "iPhone Air",
  "iPad (A16)", "iPad Air 11-inch (M4)", "iPad Air 13-inch (M4)", "iPad mini (A17 Pro)",
  "iPad Pro 11-inch (M5)", "iPad Pro 13-inch (M5)",
] as const;
const ANDROID_DEVICE_PROFILES = ["pixel_7", "pixel_7_pro", "pixel_8", "pixel_tablet"] as const;
const ANDROID_PROFILE_HINT = [
  "Add one, then rerun setup:",
  "  { \"build\": { \"emulator\": { \"android\": { \"buildType\": \"apk\" } } } }",
].join("\n");

type ObjectValue = Record<string, unknown>;

/** First line of generated agent instructions; doctor warns until an app-specific rewrite removes it. */
export const DRAFT_INSTRUCTIONS_MARKER = "<!-- expo-explore: generated draft; replace with app-specific guidance -->";
export const DEFAULT_INSTRUCTIONS_PATH = ".expo-explore/instructions.md";
export const SETUP_SKILL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills/explore-setup/SKILL.md");
export const AGENT_PROVIDERS = {
  anthropic: { secret: "ANTHROPIC_API_KEY", keys: "https://platform.claude.com/settings/keys", models: "https://platform.claude.com/docs/en/about-claude/models/overview" },
  openai: { secret: "OPENAI_API_KEY", keys: "https://platform.openai.com/api-keys", models: "https://developers.openai.com/api/docs/models" },
} as const;
export const EXPO_TOKENS_URL = "https://expo.dev/settings/access-tokens";
export const PREVIEW_DOCS_URL = "https://github.com/expo/explore/blob/main/docs/private-review.md#hosted-previews";

/** Hand the app-specific part of setup to the user's coding agent. */
export function agentSetupPrompt(): string {
  return `Read ${SETUP_SKILL_PATH} and set up this app for Expo Explore CI reviews. `
    + "Recommend a capture mode, start from expo-explore doctor --json, read the app's source for the state each screen needs, "
    + "and repeat expo-explore doctor until it reports no problems. Ask me only for what you cannot find in the repository.";
}

type SetupOptions = {
  project?: string | undefined;
  device?: string | undefined;
  scope?: string | undefined;
  profile?: string | undefined;
  bundleId?: string | undefined;
  /** ios (default) or android. */
  platform?: string | undefined;
  scheme?: string | undefined;
  navigation?: string | undefined;
  mode?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** ROUTE.NAME=VALUE, for example /items/[id].id=item-1 */
  params?: readonly string[] | undefined;
  /** How deterministic mode prepares app state for screens behind source redirects. */
  appState?: string | undefined;
  workflows?: boolean | undefined;
  nonInteractive?: boolean;
  /** Return the config without writing anything. */
  dryRun?: boolean;
  check?: boolean;
};
type Interaction = {
  ask: (label: string, fallback: string, choices?: readonly string[]) => Promise<string>;
  log: (message: string) => void;
};
/** Source analysis and CI installation live above the config layer; the CLI supplies them. */
export type SetupServices = {
  analyzeRoutes?: (project: string, config: ExploreConfig) => RouteEntryReport;
  installWorkflows?: (project: string, secretNames: readonly string[]) => Promise<CiInstallResult>;
};

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path: string): Promise<ObjectValue> {
  try { return object(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { throw new Error(`Cannot read ${path}: ${(error as Error).message}`); }
}

export async function appConfig(project: string): Promise<ObjectValue> {
  if (await exists(join(project, "app.config.ts")) || await exists(join(project, "app.config.js"))) {
    let getConfig: (root: string, options: { skipPlugins: boolean; skipSDKVersionRequirement: boolean }) => { exp: unknown };
    try { ({ getConfig } = createRequire(join(project, "package.json"))("expo/config")); }
    catch {
      throw new Error("Dynamic app config requires this app's installed expo/config. Install the app dependencies and rerun setup.");
    }
    try { return object(getConfig(project, { skipPlugins: true, skipSDKVersionRequirement: true }).exp); }
    catch (error) { throw new Error(`Cannot evaluate the app config. Supply its required environment and rerun setup: ${(error as Error).message}`); }
  }
  for (const name of ["app.config.json", "app.json"]) {
    if (await exists(join(project, name))) {
      const config = await readJson(join(project, name));
      return object(config.expo ?? config);
    }
  }
  return {};
}

export function simulatorProfiles(eas: ObjectValue, platform: "ios" | "android" = "ios"): string[] {
  const profiles = object(eas.build);
  // Android: a profile that EAS builds as an APK (android.buildType: apk, or internal distribution
  // without a buildType) and not as a development client, so the emulator opens the app itself.
  function resolvedProfile(name: string, visited = new Set<string>()): ObjectValue {
    if (visited.has(name)) throw new Error(`Circular EAS profile inheritance at ${name}. Fix eas.json and rerun setup.`);
    if (!profiles[name]) throw new Error(`Missing inherited EAS profile ${name}. Fix eas.json and rerun setup.`);
    visited.add(name);
    const profile = object(profiles[name]);
    const parent = typeof profile.extends === "string" ? resolvedProfile(profile.extends, visited) : {};
    return { ...parent, ...profile, android: { ...object(parent.android), ...object(profile.android) } };
  }
  function isEmulatorApk(name: string): boolean {
    const resolved = resolvedProfile(name);
    const buildType = object(resolved.android).buildType;
    const apk = buildType === "apk" || (buildType === undefined && resolved.distribution === "internal");
    return apk && resolved.developmentClient !== true;
  }
  if (platform === "android") return Object.keys(profiles).filter((name) => isEmulatorApk(name));
  function isSimulator(name: string, visited = new Set<string>()): boolean {
    if (visited.has(name)) throw new Error(`Circular EAS profile inheritance at ${name}. Fix eas.json and rerun setup.`);
    if (!profiles[name]) throw new Error(`Missing inherited EAS profile ${name}. Fix eas.json and rerun setup.`);
    visited.add(name);
    const profile = object(profiles[name]);
    const inherited = typeof profile.extends === "string" ? isSimulator(profile.extends, visited) : false;
    return object(profile.ios).simulator === undefined ? inherited : object(profile.ios).simulator === true;
  }
  return Object.keys(profiles).filter((name) => isSimulator(name));
}

function terminalInteraction(): Interaction & { close: () => void } {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  return {
    close: () => terminal.close(),
    log: (message) => process.stderr.write(`${message}\n`),
    ask: async (label, fallback, choices) => {
      if (choices) process.stderr.write(`${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n")}\n`);
      const answer = (await terminal.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim();
      if (!answer) return fallback;
      if (choices && /^\d+$/.test(answer)) {
        const choice = choices[Number(answer) - 1];
        if (!choice) throw new Error(`Choose a number from 1 to ${choices.length}. Rerun setup; no config was written.`);
        return choice;
      }
      return answer;
    },
  };
}

type GuardGroup = { guard: string; routes: string[] };

function guardGroups(report: RouteEntryReport | undefined): GuardGroup[] {
  const groups = new Map<string, string[]>();
  for (const route of report?.routes ?? []) {
    if (route.status === "redirect") continue;
    for (const guard of route.guards) {
      const key = `${guard.sourceFile} → ${guard.to}`;
      groups.set(key, [...groups.get(key) ?? [], route.logicalPath]);
    }
  }
  return [...groups].map(([guard, routes]) => ({ guard, routes }));
}

function parseParameters(values: readonly string[]): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const value of values) {
    const match = /^(.+)\.([A-Za-z0-9_-]+)=(.*)$/.exec(value);
    if (!match || !match[3]) throw new Error(`--param ${value} must look like ROUTE.NAME=VALUE, for example /items/[id].id=item-1.`);
    (result[match[1]!] ??= {})[match[2]!] = match[3]!;
  }
  return result;
}

function setupTemplate(config: ExploreConfig, guards: readonly GuardGroup[]): string {
  const scheme = config.app.scheme ?? "your-scheme";
  return [
    "",
    "# setup: put the app in the state each screen needs, in order. A screen that a step lands on is",
    "# captured in that state, so order the steps from the first state (for example signed out) to the last.",
    ...(guards.length ? ["# Source redirects that need a state first (found by expo-explore setup):",
      ...guards.map(group => `#   ${group.guard} (${group.routes.length} ${group.routes.length === 1 ? "route" : "routes"})`)] : []),
    "# Actions: open (url), tap and fill (identifier or label), type, scroll, wait. Each can have",
    "# ready: { identifier | label } and requiresRoute. Write sensitive input as {{secret:NAME}}.",
    "# Your coding agent can write these steps from the app's source: see the explore-setup skill.",
    "# setup:",
    "#   - action: open",
    `#     url: ${scheme}://<screen that starts the flow>`,
    "#     ready: { identifier: <control that shows the screen is ready> }",
    "",
  ].join("\n");
}

function instructionsDraft(config: ExploreConfig, answers: Record<string, string>, guards: readonly GuardGroup[]): string {
  const section = (title: string, answer: string | undefined, hint: string) => [`## ${title}`, "", answer?.trim() || hint, ""];
  return [
    DRAFT_INSTRUCTIONS_MARKER,
    `# Capture instructions for ${config.app.name ?? config.app.bundleId}`,
    "",
    "The capture agent follows these instructions on both revisions of a pull request. Your coding agent",
    "can rewrite this draft from the app's source with the explore-setup skill; then remove the first line.",
    "",
    ...section("Reaching screens", answers.reach, "Describe how a reviewer reaches the app's screens: the first screen, tabs, menus and links."),
    ...section("Prerequisites and test inputs", answers.prerequisites,
      "Describe the state each screen needs and how to establish it through the app. Write sensitive values as secret references (see the explore-setup skill) and add each name as a GitHub secret."),
    ...(guards.length ? ["Source redirects that need a state first:", "", ...guards.map(group => `- ${group.guard} (${group.routes.join(", ")})`), ""] : []),
    ...section("Ready to capture", answers.ready, "Describe what shows that a screen has finished loading and is in its representative state."),
    ...section("Avoid", answers.avoid, "List actions the agent must not take, such as purchases, deleting data, or sending messages to real people."),
  ].join("\n");
}

const SIMULATOR_PROFILE_HINT = [
  "Add one, then rerun setup:",
  "  { \"build\": { \"simulator\": { \"ios\": { \"simulator\": true } } } }",
  "A coding agent can do this with the explore-setup skill.",
].join("\n");

export type SetupResult = {
  path: string; config: ExploreConfig; created: boolean;
  instructions?: string; workflows?: CiInstallResult; routes?: { screens: number; ready: number; needsParameters: string[]; noLink: string[]; guards: GuardGroup[] };
  nextSteps?: string[];
};

/**
 * The config `setup --non-interactive` would write, without writing it: what a local review runs with in an app that
 * has no config yet. Throws setup's errors when the app cannot be built for capture.
 */
export async function defaultExploreConfig(project: string, platform?: ExplorePlatform): Promise<ExploreConfig> {
  return (await runExploreSetup({ project, platform, nonInteractive: true, dryRun: true })).config;
}

/**
 * The guided setup. It writes what it can derive (app identity, mode, route parameters it was given,
 * an agent-instructions draft, CI files) and hands the app-specific flows to the user's coding agent.
 */
export async function runExploreSetup(options: SetupOptions = {}, interaction?: Interaction, services: SetupServices = {}): Promise<SetupResult> {
  const project = await realpath(resolve(options.project ?? process.cwd()));
  const path = join(project, DEFAULT_EXPLORE_CONFIG_PATH);
  if (options.check) return { path, config: await readExploreConfig(project), created: false };
  if (await exists(path)) {
    await readExploreConfig(project);
    throw new Error(`${path} already exists and was preserved. Run expo-explore doctor to check it, setup --workflows to add the CI files, or the explore-setup skill to update it.`);
  }
  const parent = dirname(path);
  if (await exists(parent)) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${parent} must be a directory, not a symlink.`);
  }
  const pkg = await readJson(join(project, "package.json"));
  const dependencies = { ...object(pkg.devDependencies), ...object(pkg.dependencies) };
  if (!dependencies.expo) throw new Error("Choose an Expo app directory with --project (for example, --project apps/mobile).");
  const app = await appConfig(project);
  if (options.platform !== undefined && options.platform !== "ios" && options.platform !== "android") throw new Error("--platform must be ios or android.");
  const platform: "ios" | "android" = options.platform === "android" ? "android" : "ios";
  const hint = platform === "android" ? ANDROID_PROFILE_HINT : SIMULATOR_PROFILE_HINT;
  const defaultDevice = platform === "android" ? ANDROID_DEVICE_PROFILES[0] : CAPTURE_DEVICE_MODELS[0];
  if (!await exists(join(project, "eas.json"))) {
    throw new Error(`No eas.json found. Explore builds the app for the ${platform === "android" ? "Android Emulator" : "iOS Simulator"} with an EAS build profile. ${hint}`);
  }
  const profiles = simulatorProfiles(await readJson(join(project, "eas.json")), platform);
  if (!profiles.length) throw new Error(platform === "android" ? `No EAS build profile in eas.json builds an Android APK (android.buildType: apk) without developmentClient. ${hint}` : `No EAS build profile in eas.json has ios.simulator: true. ${hint}`);
  if (options.nonInteractive && options.mode === "agent" && (!options.provider || !options.model)) {
    throw new Error("Non-interactive agent setup requires --provider (anthropic or openai) and --model.");
  }
  if (!options.nonInteractive && !interaction && (!process.stdin.isTTY || !process.stderr.isTTY)) {
    throw new Error("Run setup in a terminal, or pass --non-interactive --device NAME --scope changes|all.");
  }
  const suppliedParameters = parseParameters(options.params ?? []);
  const terminal = !options.nonInteractive && !interaction ? terminalInteraction() : undefined;
  const ui = interaction ?? terminal;
  const log = (message: string) => ui?.log(message);
  const choose = async (label: string, supplied: string | undefined, fallback: string, choices?: readonly string[]) => {
    if (supplied !== undefined) return supplied;
    if (options.nonInteractive) return fallback;
    return ui!.ask(label, fallback, choices);
  };
  try {
    log(`Expo Explore setup — ${platform === "android" ? "Android" : "iOS"} capture for pull request reviews`);
    const bundleId = platform === "android"
      ? await choose("Android package", options.bundleId, string(object(app.android).package))
      : await choose("iOS bundle identifier", options.bundleId, string(object(app.ios).bundleIdentifier));
    if (!bundleId) {
      throw new Error(platform === "android" ? "No Android package found. Set android.package in the app config or pass --bundle-id com.example.app."
        : "No iOS bundle identifier found. Set ios.bundleIdentifier in the app config or pass --bundle-id com.example.app.");
    }
    const schemes = Array.isArray(app.scheme) ? app.scheme.filter((value): value is string => typeof value === "string") : undefined;
    const scheme = await choose("URL scheme (optional)", options.scheme, schemes?.[0] ?? string(app.scheme), schemes);
    const profile = await choose(platform === "android" ? "EAS emulator (APK) build profile" : "EAS simulator build profile", options.profile,
      // With several, the one named explore, the name the README and the explore-setup skill give it.
      profiles.length === 1 ? profiles[0]! : profiles.includes("explore") ? "explore" : "", profiles);
    if (!profiles.includes(profile)) throw new Error(`Choose ${platform === "android" ? "an Android APK" : "a simulator"} profile from eas.json with --profile: ${profiles.join(", ")}.`);
    const inferredProvider = dependencies["expo-router"] ? "expo-router" : dependencies["@react-navigation/native"] ? "react-navigation" : "auto";
    const provider = await choose("Navigation provider", options.navigation, inferredProvider, ["auto", "expo-router", "react-navigation"]);
    const base = (extra: Record<string, unknown> = {}) => validateExploreConfig({
      mode: "deterministic",
      app: { ...(string(app.name) ? { name: app.name } : {}), platform, bundleId, easProfile: profile, ...(scheme ? { scheme } : {}) },
      navigation: { provider }, device: { name: options.device ?? defaultDevice }, exploration: { scope: options.scope ?? "changes" },
      capture: { maxMinutes: 30, maxActions: 500 }, ...extra,
    });

    let routes: RouteEntryReport | undefined;
    if (services.analyzeRoutes) {
      try { routes = services.analyzeRoutes(project, base(Object.keys(suppliedParameters).length ? { parameters: suppliedParameters } : {})); }
      catch (error) { log(`Source analysis skipped: ${(error as Error).message}`); }
    }
    const screens = (routes?.routes ?? []).filter(route => route.status !== "redirect");
    const needs = screens.filter(route => route.status === "needs-parameters");
    const noLink = screens.filter(route => route.status === "no-link");
    const guards = guardGroups(routes);
    if (routes) {
      log(`\nSource analysis (${routes.provider ?? "no provider"}): ${screens.length} screens. ${screens.length - needs.length - noLink.length} open by app link, `
        + `${needs.length} need parameter values, ${noLink.length} have no app link, ${guards.reduce((sum, group) => sum + group.routes.length, 0)} sit behind source redirects.`);
    }

    log("\nCapture mode:\n"
      + "  deterministic — replays config.yaml without a model: no API key, no AI charges.\n"
      + "                  Screens open by app link and fixed setup steps prepare app state.\n"
      + "                  Recommended to start.\n"
      + "  agent         — Claude Code or Codex navigates with your provider API key\n"
      + "                  (billed by your provider). It can reach screens without links\n"
      + "                  and recover from unexpected states.");
    let mode = await choose("Capture mode", options.mode, "deterministic", ["deterministic", "agent"]);
    if (mode !== "deterministic" && mode !== "agent") throw new Error("Choose deterministic or agent for the capture mode.");
    log("Device suggestions are not a live catalog. You can type another name; availability is checked during capture.");
    const device = platform === "android" ? await choose("Capture device (AVD hardware profile)", options.device, defaultDevice, [...ANDROID_DEVICE_PROFILES])
      : await choose("Capture device", options.device, CAPTURE_DEVICE_MODELS[0], [...CAPTURE_DEVICE_MODELS]);
    log("changes: affected routes and navigation context; all: the full screen inventory.");
    const scope = await choose("Capture scope", options.scope, "changes", ["changes", "all"]);

    const parameters: Record<string, Record<string, string>> = structuredClone(suppliedParameters);
    const unresolved = needs.flatMap(route => route.missingParameters.map(name => ({ key: route.parameterKey, name })));
    if (unresolved.length && !options.nonInteractive) {
      log(`\n${needs.length} dynamic ${needs.length === 1 ? "route needs" : "routes need"} a real value from your test data (seed data, fixtures, a test account). Press Enter to skip one;`
        + " a skipped route is not captured until you add it to parameters in config.yaml.");
      for (const { key, name } of unresolved) {
        const value = (await ui!.ask(`${key} → ${name}`, "")).trim();
        if (value) (parameters[key] ??= {})[name] = value;
      }
    }

    let appState: string | undefined;
    if (mode === "deterministic" && guards.length) {
      log(`\nThese screens can redirect in source unless the app is in the right state (signed in, onboarded, and so on):\n`
        + guards.map(group => `  ${group.guard} (${group.routes.length} ${group.routes.length === 1 ? "route" : "routes"})`).join("\n")
        + "\nDeterministic capture prepares that state with setup steps, which need the app's own flows, controls and test data.");
      appState = await choose("Prepare app state with", options.appState, "coding agent",
        ["coding agent", "setup template", "agent mode", "skip"]);
      if (appState === "agent mode") mode = "agent";
    }

    let agent: ExploreConfig["agent"] | undefined;
    let instructions: string | undefined;
    const instructionsPath = join(project, DEFAULT_INSTRUCTIONS_PATH);
    if (mode === "agent") {
      const providerName = await choose("Model provider", options.provider, "anthropic", ["anthropic", "openai"]);
      if (providerName !== "anthropic" && providerName !== "openai") throw new Error("Choose anthropic or openai for the model provider.");
      const links = AGENT_PROVIDERS[providerName];
      log(`Model IDs: ${links.models}`);
      const model = await choose("Model ID", options.model, "");
      if (!model.trim()) throw new Error("Agent mode needs a model ID. Rerun setup with a model your provider account can use.");
      agent = { provider: providerName, model: model.trim(), instructions: DEFAULT_INSTRUCTIONS_PATH };
      if (!await exists(instructionsPath)) {
        const answers: Record<string, string> = {};
        if (!options.nonInteractive) {
          log("\nDescribe the app for the capture agent in a sentence or two each. Press Enter to leave a part for your coding agent.");
          answers.reach = await ui!.ask("How does a reviewer reach the app's screens?", "");
          answers.prerequisites = await ui!.ask("What state or test inputs do screens need? (write secrets as {{secret:NAME}})", "");
          answers.ready = await ui!.ask("What shows a screen is ready to capture?", "");
          answers.avoid = await ui!.ask("What must the agent never do?", "");
        }
        instructions = instructionsDraft(base(), answers, guards);
        explorationSecretNames(instructions);
      }
    }

    const config = validateExploreConfig({
      mode,
      app: { ...(string(app.name) ? { name: app.name } : {}), platform, bundleId, easProfile: profile, ...(scheme ? { scheme } : {}) },
      navigation: { provider }, device: { name: device }, exploration: { scope },
      capture: { maxMinutes: 30, maxActions: 500 },
      ...(Object.keys(parameters).length ? { parameters } : {}),
      ...(agent ? { agent } : {}),
    });
    const yaml = stringify(config) + (appState === "setup template" ? setupTemplate(config, guards) : "");
    if (!options.nonInteractive) {
      ui!.log(`\n${path}\n\n${yaml}${instructions ? `\n${instructionsPath} (draft)\n` : ""}`);
      const answer = await ui!.ask("Write this config? (yes/no)", "yes");
      if (!/^(y|yes)$/i.test(answer.trim())) throw new Error("Setup canceled; no config was written.");
    }
    if (options.dryRun) return { path, config, created: false };
    await mkdir(parent, { recursive: true });
    await writeFile(path, yaml, { flag: "wx" });
    if (instructions) await writeFile(instructionsPath, instructions, { flag: "wx" });

    const secretNames = explorationSecretNames(instructions ?? "");
    let workflows: CiInstallResult | undefined;
    if (services.installWorkflows) {
      const install = options.workflows ?? (options.nonInteractive ? false
        : /^(y|yes)$/i.test((await ui!.ask("Install the GitHub workflows now? (yes/no)", "yes")).trim()));
      if (install) {
        try { workflows = await services.installWorkflows(project, secretNames); }
        catch (error) { log(`CI files were not installed: ${(error as Error).message}`); }
      }
    }

    const nextSteps = setupNextSteps(config, { nonInteractive: !!options.nonInteractive,
      workflows: !!workflows, secretNames,
      unresolvedParameters: needs.filter(route => route.missingParameters.some(name => !parameters[route.parameterKey]?.[name])).map(route => route.parameterKey),
      appFlows: mode === "agent" ? !!instructions : guards.length > 0 && appState !== "skip",
    });
    if (workflows) log(`\nCI files: ${[...workflows.written.map(file => `wrote ${file}`), ...workflows.kept.map(file => `kept ${file}`)].join(", ")}`
      + (workflows.notes.length ? `\n${workflows.notes.map(note => `  note: ${note}`).join("\n")}` : ""));
    log(`\nNext steps\n${nextSteps.map((step, index) => `  ${index + 1}. ${step.replace(/\n/g, "\n     ")}`).join("\n")}`);
    return { path, config, created: true, ...(instructions ? { instructions: instructionsPath } : {}), ...(workflows ? { workflows } : {}),
      ...(routes ? { routes: { screens: screens.length, ready: screens.length - needs.length - noLink.length,
        needsParameters: needs.map(route => route.parameterKey), noLink: noLink.map(route => route.logicalPath), guards } } : {}),
      nextSteps };
  } finally {
    terminal?.close();
  }
}

/** What is left after setup writes its files, in order, as commands where one exists. */
export function setupNextSteps(config: ExploreConfig, state: { workflows: boolean; secretNames: readonly string[]; unresolvedParameters: readonly string[]; appFlows: boolean; nonInteractive?: boolean }): string[] {
  const steps: string[] = [];
  if (state.appFlows || state.unresolvedParameters.length) steps.push(state.nonInteractive
    ? `Write the app-specific part from the app's source (explore-setup skill, step 5): the state each guarded screen needs${config.mode === "agent" ? " in the agent instructions" : " as setup steps"}, and real parameter values. Then run expo-explore doctor.`
    : `Finish the app-specific part with your coding agent (it reads the app's source for sign-in and other flows, parameter values and readiness):\n"${agentSetupPrompt()}"`);
  if (state.unresolvedParameters.length) steps.push(`Or add real values under parameters in ${DEFAULT_EXPLORE_CONFIG_PATH} for: ${state.unresolvedParameters.join(", ")}.`);
  if (!state.workflows) steps.push("Install the CI files: expo-explore setup --workflows");
  steps.push("Commit .expo-explore and .github, then merge them into the default branch (pull request reviews run the default branch's workflow).");
  steps.push(`gh secret set EXPO_TOKEN   (create the token at ${EXPO_TOKENS_URL})`
    + (config.report?.preview ? `\nHosted previews deploy with the same token: it must be allowed to create projects in the app's Expo account, so use a robot user's token (expo.dev account settings, Access tokens) rather than a personal one; see ${PREVIEW_DOCS_URL}` : ""));
  if (config.mode === "agent" && config.agent) {
    const links = AGENT_PROVIDERS[config.agent.provider];
    steps.push(`gh secret set ${links.secret}   (create the key at ${links.keys}; agent capture is billed to this account)`
      + (config.agent.provider === "anthropic" ? "\nIf the key is not workspace-scoped: gh variable set ANTHROPIC_WORKSPACE_ID --body <workspace id>" : ""));
  }
  for (const name of state.secretNames) steps.push(`gh secret set ${name}   (app-test input referenced as {{secret:${name}}})`);
  steps.push(`expo-explore doctor${config.mode === "agent" ? " --check-model" : ""}   (checks all of the above and names what is left)`);
  steps.push("Run Expo Explore baseline from the repository's Actions tab, then open a pull request.");
  return steps;
}
