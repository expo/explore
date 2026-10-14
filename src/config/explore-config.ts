import { parseUnattributedSetting, type UnattributedSetting } from "../capture/unattributed.js";
import { parseAppearance, type AppearanceSetting } from "../capture/appearance.js";
import { parseLaunchSetting, type LaunchSetting } from "../capture/launch-capture.js";
import { parseRouteResetSetting, type RouteResetSetting } from "../capture/route-reset.js";
import { readFile, realpath, stat } from "node:fs/promises";
import type { Platform } from "../types.js";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { isAlias, parseDocument, visit } from "yaml";
import { CiError } from "../shared/ci-errors.js";
import { isCredentialQueryKey } from "../contracts/source-validation.js";
import { explorationSecretNames } from "./exploration-inputs.js";

export const DEFAULT_EXPLORE_CONFIG_PATH = ".expo-explore/config.yaml";

export type CaptureSetupSelector =
  | { label: string; identifier?: never }
  | { identifier: string; label?: never };

export type CaptureSetupReady = CaptureSetupSelector & { enabled?: boolean };

/** UI operations provide inputs; the source plan still owns the route inventory. */
export type CaptureSetupAction = (
  | { action: "open"; url: string }
  | ({ action: "tap" } & CaptureSetupSelector)
  | ({ action: "fill"; text: string } & CaptureSetupSelector)
  | { action: "type"; text: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right" | "top" | "bottom" }
  | { action: "wait"; milliseconds: number }
) & {
  ready?: CaptureSetupReady;
  /** A route named as in the source plan; revisions whose inventory lacks it skip the action. */
  requiresRoute?: string;
};

export type ExploreSetupAction = CaptureSetupAction;

export type ExplorePlatform = Platform;
export const EXPLORE_PLATFORMS: readonly ExplorePlatform[] = ["ios", "android"];
export const DEFAULT_ANDROID_DEVICE = "pixel_7";

/**
 * One platform's capture target. `platforms.ios` fields default to the flat `app`/`device` fields;
 * `platforms.android` needs its own package and EAS profile (an `android.buildType: apk` profile).
 */
export type PlatformConfig = { device?: string; bundleId?: string; easProfile?: string };

/** Source discovery never consumes a user-authored screen inventory. */
export type ExploreConfig = {
  mode: "deterministic" | "agent";
  app: { name?: string; platform: ExplorePlatform; bundleId: string; easProfile: string; scheme?: string };
  navigation: { provider: "auto" | "expo-router" | "react-navigation"; entry?: string };
  device: { name: string };
  /**
   * Each platform Explore captures, in CI as one matrix job each. Absent: the single platform the
   * flat fields describe. Capture code never reads this map; resolvePlatformConfig flattens it.
   */
  platforms?: Partial<Record<ExplorePlatform, PlatformConfig>>;
  /** `exclude` names routes, as `requiresRoute` does, that stay in the map but are never captured. */
  exploration: { scope: "changes" | "all"; exclude?: string[] };
  capture: { maxMinutes: number; maxActions: number; repack: "eas" | "local"; appearance: AppearanceSetting; launch: LaunchSetting; reset: RouteResetSetting; unattributed: UnattributedSetting; readinessSeconds?: number };
  parameters?: Record<string, Record<string, string>>;
  setup?: ExploreSetupAction[];
  agent?: { provider: "openai" | "anthropic"; model: string; instructions?: string };
  /** Hosted previews: one token-gated EAS Hosting deployment per review, see docs/private-review.md. */
  report?: { preview?: { hosting: "eas"; /** null: the link never expires; the deployment lives until someone deletes it. */ expiresAfterDays: number | null; owner?: string; project?: string } };
  /**
   * `trustedAuthors`: GitHub logins (e.g. `devin-ai-integration[bot]`) whose same-repository pull
   * requests the review workflow captures although they lack write access. The workflow reads this
   * from the default branch, so a pull request cannot add its own author.
   */
  ci?: { trustedAuthors?: string[] };
};

export const PREVIEW_MAX_DAYS = 365;
export const PREVIEW_DEFAULT_DAYS = 30;

const MAX_CONFIG_BYTES = 64 * 1024;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RESERVED_SCHEMES = new Set(["http", "https", "file", "data", "javascript", "about", "blob"]);

function fail(message: string, field = "config", nextAction?: string): never {
  throw new CiError({
    code: "CONFIG_INVALID", stage: "preflight",
    message: `Invalid ${DEFAULT_EXPLORE_CONFIG_PATH}: ${message}`,
    nextAction: nextAction ?? `Correct ${field} in ${DEFAULT_EXPLORE_CONFIG_PATH} and rerun Explore.`,
    details: { file: DEFAULT_EXPLORE_CONFIG_PATH, field },
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a mapping`, label);
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  return value === undefined ? {} : record(value, label);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unsupported field ${key}`, `${label}.${key}`,
      `Remove ${label === "config" ? key : `${label}.${key}`} from ${DEFAULT_EXPLORE_CONFIG_PATH}. Use source discovery and the current configuration fields.`);
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") fail(`${label} must be a string`, label);
  const result = value.trim();
  if (!result || result.length > maximum || UNSAFE_CHARACTERS.test(result)) {
    fail(`${label} must contain 1–${maximum} characters without control characters`, label);
  }
  return result;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum);
}

function repoPath(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (isAbsolute(result) || /^[A-Za-z]:/.test(result) || result.includes("\\")
    || result.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${label} must be a relative repository path`, label);
  }
  return result;
}

function literal<T extends string>(value: unknown, allowed: readonly T[], label: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${label} must be one of ${allowed.join(", ")}`, label);
  return value as T;
}

function positiveInteger(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`, label);
  return value;
}

function customScheme(value: unknown, label: string): string {
  const result = text(value, label, 128).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(result) || RESERVED_SCHEMES.has(result)) {
    fail(`${label} must be an app custom scheme without ://`, label);
  }
  return result;
}

function setupActions(value: unknown, scheme?: string): ExploreSetupAction[] {
  if (!Array.isArray(value) || value.length > 100) fail("setup must be an array with at most 100 actions", "setup");
  return value.map((entry, index) => {
    const label = `setup[${index}]`;
    const action = record(entry, label);
    const selector = (value: Record<string, unknown>, label: string): CaptureSetupSelector => {
      if ((value.label === undefined) === (value.identifier === undefined)) fail(`${label} requires exactly one label or identifier`, label);
      return value.label === undefined ? { identifier: text(value.identifier, `${label}.identifier`, 256) }
        : { label: text(value.label, `${label}.label`, 256) };
    };
    let ready: CaptureSetupReady | undefined;
    if (action.ready !== undefined) {
      const condition = record(action.ready, `${label}.ready`);
      exactKeys(condition, ["label", "identifier", "enabled"], `${label}.ready`);
      if (condition.enabled !== undefined && typeof condition.enabled !== "boolean") fail(`${label}.ready.enabled must be a boolean`, `${label}.ready.enabled`);
      ready = { ...selector(condition, `${label}.ready`), ...(condition.enabled === undefined ? {} : { enabled: condition.enabled }) };
    }
    let requiresRoute: string | undefined;
    if (action.requiresRoute !== undefined) {
      requiresRoute = text(action.requiresRoute, `${label}.requiresRoute`, 512);
      if (/\s/.test(requiresRoute)) fail(`${label}.requiresRoute must be a route id, route, logical path, or link path without spaces`, `${label}.requiresRoute`);
    }
    const checkpoint = { ...(ready ? { ready } : {}), ...(requiresRoute ? { requiresRoute } : {}) };
    switch (action.action) {
      case "open": {
        exactKeys(action, ["action", "url", "ready", "requiresRoute"], label);
        const url = text(action.url, `${label}.url`, 2048);
        let parsed: URL;
        try { parsed = new URL(url); } catch { return fail(`${label}.url must be an absolute app URL`, `${label}.url`); }
        const protocol = parsed.protocol.slice(0, -1).toLowerCase();
        customScheme(protocol, `${label}.url`);
        if (parsed.username || parsed.password || scheme !== undefined && protocol !== scheme) {
          fail(`${label}.url must use the app's custom scheme without credentials`, `${label}.url`);
        }
        return { action: "open", url, ...checkpoint };
      }
      case "tap":
        exactKeys(action, ["action", "label", "identifier", "ready", "requiresRoute"], label);
        return { action: "tap", ...selector(action, label), ...checkpoint };
      case "fill":
        exactKeys(action, ["action", "label", "identifier", "text", "ready", "requiresRoute"], label);
        if (typeof action.text === "string") explorationSecretNames(action.text);
        return { action: "fill", ...selector(action, label), text: text(action.text, `${label}.text`, 4096), ...checkpoint };
      case "type":
        exactKeys(action, ["action", "text", "ready", "requiresRoute"], label);
        if (typeof action.text === "string") explorationSecretNames(action.text);
        return { action: "type", text: text(action.text, `${label}.text`, 4096), ...checkpoint };
      case "scroll":
        exactKeys(action, ["action", "direction", "ready", "requiresRoute"], label);
        return { action: "scroll", direction: literal(action.direction, ["up", "down", "left", "right", "top", "bottom"] as const, `${label}.direction`), ...checkpoint };
      case "wait": {
        exactKeys(action, ["action", "milliseconds", "ready", "requiresRoute"], label);
        const milliseconds = positiveInteger(action.milliseconds, `${label}.milliseconds`);
        if (milliseconds > 30_000) fail(`${label}.milliseconds must not exceed 30000`, `${label}.milliseconds`);
        return { action: "wait", milliseconds, ...checkpoint };
      }
      default: return fail(`${label}.action must be one of open, tap, fill, type, scroll, wait`, `${label}.action`);
    }
  });
}

function excludedRoutes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) fail("exploration.exclude must be a list of at most 500 routes", "exploration.exclude");
  const routes = value.map((route, index) => text(route, `exploration.exclude[${index}]`, 512));
  if (new Set(routes).size !== routes.length) fail("exploration.exclude lists a route twice", "exploration.exclude");
  return routes;
}

function parameters(value: unknown): Record<string, Record<string, string>> {
  const mapping = record(value, "parameters");
  return Object.fromEntries(Object.keys(mapping).sort().map((route) => {
    text(route, "parameters route key", 512);
    const params = record(mapping[route], `parameters.${route}`);
    return [route, Object.fromEntries(Object.keys(params).sort().map((key) => {
      const label = `parameters.${route} parameter name`;
      text(key, label, 128);
      // Parameters travel in the app link, so a name must work as a link query key.
      if (/\s/.test(key)) fail(`${label} must not contain whitespace`, label);
      if (isCredentialQueryKey(key)) fail(`${label} ${key} is credential-like; app links must not carry credentials`, label);
      return [key, text(params[key], `parameters.${route}.${key}`, 2048)];
    }))];
  }));
}

/** Validate and normalize plain data; credential validation is a separate execution gate. */
export function validateExploreConfig(value: unknown): ExploreConfig {
  const root = record(value, "config");
  exactKeys(root, ["mode", "app", "navigation", "device", "platforms", "exploration", "capture", "parameters", "setup", "agent", "report", "ci"], "config");
  const app = record(root.app, "app");
  exactKeys(app, ["name", "platform", "bundleId", "easProfile", "scheme"], "app");
  const device = record(root.device, "device");
  exactKeys(device, ["name"], "device");
  const navigation = optionalRecord(root.navigation, "navigation");
  exactKeys(navigation, ["provider", "entry"], "navigation");
  const exploration = optionalRecord(root.exploration, "exploration");
  exactKeys(exploration, ["scope", "exclude"], "exploration");
  const capture = optionalRecord(root.capture, "capture");
  exactKeys(capture, ["maxMinutes", "maxActions", "repack", "appearance", "launch", "reset", "unattributed", "readinessSeconds"], "capture");
  const mode = literal(root.mode, ["deterministic", "agent"] as const, "mode", "deterministic");
  const name = optionalText(app.name, "app.name", 128);
  const scheme = app.scheme === undefined ? undefined : customScheme(app.scheme, "app.scheme");
  const platform = literal(app.platform, EXPLORE_PLATFORMS, "app.platform", "ios");
  const bundleId = applicationId(app.bundleId, "app.bundleId");
  const easProfile = profileName(app.easProfile, "app.easProfile");
  const platforms = platformsConfig(root.platforms, platform);
  let agent: ExploreConfig["agent"];
  if (root.agent !== undefined || mode === "agent") {
    const input = record(root.agent, "agent");
    exactKeys(input, ["provider", "model", "instructions"], "agent");
    agent = {
      provider: literal(input.provider, ["openai", "anthropic"] as const, "agent.provider"),
      model: text(input.model, "agent.model", 128),
      ...(input.instructions === undefined ? {} : { instructions: repoPath(input.instructions, "agent.instructions") }),
    };
    if (mode === "agent" && !agent.instructions) fail("agent.instructions is required in agent mode", "agent.instructions",
      "Use the explore-setup skill to write app-specific instructions and set agent.instructions to their repository-relative path.");
  }
  const report = reportConfig(root.report);
  const ci = ciConfig(root.ci);
  return {
    mode,
    app: {
      ...(name === undefined ? {} : { name }),
      platform, bundleId, easProfile,
      ...(scheme === undefined ? {} : { scheme }),
    },
    navigation: {
      provider: literal(navigation.provider, ["auto", "expo-router", "react-navigation"] as const, "navigation.provider", "auto"),
      ...(navigation.entry === undefined ? {} : { entry: repoPath(navigation.entry, "navigation.entry") }),
    },
    device: { name: text(device.name, "device.name", 128) },
    ...(platforms === undefined ? {} : { platforms }),
    exploration: {
      scope: literal(exploration.scope, ["changes", "all"] as const, "exploration.scope", "changes"),
      ...(exploration.exclude === undefined ? {} : { exclude: excludedRoutes(exploration.exclude) }),
    },
    capture: {
      maxMinutes: positiveInteger(capture.maxMinutes, "capture.maxMinutes", 30),
      maxActions: positiveInteger(capture.maxActions, "capture.maxActions", 500),
      repack: literal(capture.repack, ["eas", "local"] as const, "capture.repack", "eas"),
      appearance: parseAppearance(capture.appearance, "capture.appearance"),
      launch: parseLaunchSetting(capture.launch, "capture.launch"),
      reset: parseRouteResetSetting(capture.reset, "capture.reset"),
      unattributed: parseUnattributedSetting(capture.unattributed, "capture.unattributed"),
      ...(capture.readinessSeconds !== undefined ? { readinessSeconds: positiveInteger(capture.readinessSeconds, "capture.readinessSeconds") } : {}),
    },
    ...(root.parameters === undefined ? {} : { parameters: parameters(root.parameters) }),
    ...(root.setup === undefined ? {} : { setup: setupActions(root.setup, scheme) }),
    ...(agent === undefined ? {} : { agent }),
    ...(report === undefined ? {} : { report }),
    ...(ci === undefined ? {} : { ci }),
  };
}

function applicationId(value: unknown, label: string): string {
  const result = text(value, label, 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result) || !result.includes(".")) fail(`${label} must be a reverse-DNS identifier`, label);
  return result;
}

function profileName(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) fail(`${label} must be an eas.json profile name`, label);
  return result;
}

function platformsConfig(value: unknown, primary: ExplorePlatform): ExploreConfig["platforms"] {
  if (value === undefined) return undefined;
  const mapping = record(value, "platforms");
  exactKeys(mapping, EXPLORE_PLATFORMS, "platforms");
  const entries = EXPLORE_PLATFORMS.filter(platform => mapping[platform] !== undefined);
  if (!entries.length) fail("platforms must list ios, android, or both", "platforms");
  const result: NonNullable<ExploreConfig["platforms"]> = {};
  for (const platform of entries) {
    const label = `platforms.${platform}`;
    const entry = mapping[platform] === null ? {} : record(mapping[platform], label);
    exactKeys(entry, ["device", "bundleId", "easProfile"], label);
    const device = optionalText(entry.device, `${label}.device`, 128);
    const bundleId = entry.bundleId === undefined ? undefined : applicationId(entry.bundleId, `${label}.bundleId`);
    const easProfile = entry.easProfile === undefined ? undefined : profileName(entry.easProfile, `${label}.easProfile`);
    if (platform !== primary && (bundleId === undefined || easProfile === undefined)) {
      fail(`${label} needs bundleId and easProfile`, label,
        `Set ${label}.bundleId to the app's ${platform === "android" ? "android.package" : "ios.bundleIdentifier"} and ${label}.easProfile to an eas.json profile that builds a ${platform === "android" ? "signed APK (android.buildType: apk)" : "simulator app (ios.simulator: true)"}.`);
    }
    result[platform] = { ...(device === undefined ? {} : { device }), ...(bundleId === undefined ? {} : { bundleId }), ...(easProfile === undefined ? {} : { easProfile }) };
  }
  return result;
}

/** The platforms a configuration captures, iOS first; the flat fields alone describe one. */
export function configPlatforms(config: ExploreConfig): ExplorePlatform[] {
  return config.platforms ? EXPLORE_PLATFORMS.filter(platform => config.platforms![platform] !== undefined) : [config.app.platform];
}

/**
 * The flat configuration capture consumes for one platform: `app.platform`, `app.bundleId`,
 * `app.easProfile`, and `device.name` describe that platform; everything else is shared.
 */
export function resolvePlatformConfig(config: ExploreConfig, platform: ExplorePlatform | undefined): ExploreConfig {
  const platforms = configPlatforms(config);
  if (platform === undefined) {
    if (platforms.length > 1) throw new CiError({ code: "PLATFORM_REQUIRED", stage: "preflight",
      message: `${DEFAULT_EXPLORE_CONFIG_PATH} lists ${platforms.join(" and ")}; pass --platform to select one.`,
      nextAction: "Run expo-explore setup --workflows to install the matrix workflows, which pass --platform per job." });
    platform = platforms[0]!;
  }
  if (!platforms.includes(platform)) throw new CiError({ code: "PLATFORM_NOT_CONFIGURED", stage: "preflight",
    message: `${DEFAULT_EXPLORE_CONFIG_PATH} does not configure ${platform}.`,
    nextAction: `Add platforms.${platform} to ${DEFAULT_EXPLORE_CONFIG_PATH} or capture one of: ${platforms.join(", ")}.` });
  const entry = config.platforms?.[platform] ?? {};
  const primary = platform === config.app.platform;
  const { platforms: _platforms, ...rest } = config;
  void _platforms;
  return { ...rest,
    app: { ...config.app, platform, bundleId: entry.bundleId ?? (primary ? config.app.bundleId : fail(`platforms.${platform}.bundleId is required`)),
      easProfile: entry.easProfile ?? (primary ? config.app.easProfile : fail(`platforms.${platform}.easProfile is required`)) },
    device: { name: entry.device ?? (primary ? config.device.name : platform === "android" ? DEFAULT_ANDROID_DEVICE : config.device.name) } };
}

/** `expiresAfter` is a whole number of days (`30d`, `30 days`, or `30`), at most PREVIEW_MAX_DAYS, or `never` (null). */
export function previewDays(value: unknown, field: string): number | null {
  if (value === undefined) return PREVIEW_DEFAULT_DAYS;
  if (typeof value === "string" && /^\s*never\s*$/i.test(value)) return null;
  const match = typeof value === "number" ? [null, String(value)] : typeof value === "string" ? /^\s*(\d{1,3})\s*(?:d|days?)?\s*$/i.exec(value) : null;
  const days = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > PREVIEW_MAX_DAYS) {
    fail(`${field} must be between 1 and ${PREVIEW_MAX_DAYS} days, such as 30d, or never`, field);
  }
  return days;
}

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
export const TRUSTED_AUTHORS_MAX = 20;

function ciConfig(value: unknown): ExploreConfig["ci"] {
  if (value === undefined) return undefined;
  const ci = record(value, "ci");
  exactKeys(ci, ["trustedAuthors"], "ci");
  if (ci.trustedAuthors === undefined) return {};
  if (!Array.isArray(ci.trustedAuthors)) fail("ci.trustedAuthors must be a list of GitHub logins", "ci.trustedAuthors");
  if (ci.trustedAuthors.length > TRUSTED_AUTHORS_MAX) {
    fail(`ci.trustedAuthors lists at most ${TRUSTED_AUTHORS_MAX} logins`, "ci.trustedAuthors");
  }
  const trustedAuthors = ci.trustedAuthors.map((entry, index) => {
    const login = text(entry, `ci.trustedAuthors[${index}]`, 64);
    if (!GITHUB_LOGIN.test(login)) {
      fail(`ci.trustedAuthors[${index}] must be a GitHub login such as devin-ai-integration[bot]`, `ci.trustedAuthors[${index}]`);
    }
    return login;
  });
  if (new Set(trustedAuthors.map(login => login.toLowerCase())).size !== trustedAuthors.length) {
    fail("ci.trustedAuthors lists a login twice", "ci.trustedAuthors");
  }
  return { trustedAuthors };
}

function reportConfig(value: unknown): ExploreConfig["report"] {
  if (value === undefined) return undefined;
  const report = record(value, "report");
  exactKeys(report, ["preview"], "report");
  if (report.preview === undefined) return {};
  const preview = record(report.preview, "report.preview");
  exactKeys(preview, ["hosting", "expiresAfter", "owner", "project"], "report.preview");
  const owner = optionalText(preview.owner, "report.preview.owner", 64);
  if (owner !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(owner)) {
    fail("report.preview.owner must be an Expo account name, as shown by eas whoami", "report.preview.owner");
  }
  const project = optionalText(preview.project, "report.preview.project", 64);
  if (project !== undefined && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(project)) {
    fail("report.preview.project must be a lowercase EAS project slug", "report.preview.project");
  }
  return { preview: {
    hosting: literal(preview.hosting, ["eas"] as const, "report.preview.hosting"),
    expiresAfterDays: previewDays(preview.expiresAfter, "report.preview.expiresAfter"),
    ...(owner === undefined ? {} : { owner }),
    ...(project === undefined ? {} : { project }),
  } };
}

/** Parse YAML as plain data: no anchors, aliases, merge keys, or custom tags. */
export function parseExploreConfig(source: string): ExploreConfig {
  if (Buffer.byteLength(source) > MAX_CONFIG_BYTES) fail("file is too large");
  const document = parseDocument(source, { uniqueKeys: true, merge: false, schema: "core" });
  if (document.errors.length > 0) fail(document.errors[0]!.message.split("\n")[0]!);
  visit(document, (_key, node) => {
    if (isAlias(node) || node && typeof node === "object" && "anchor" in node && node.anchor) fail("anchors and aliases are not allowed");
    if (node && typeof node === "object" && "tag" in node && typeof node.tag === "string" && !node.tag.startsWith("tag:yaml.org,2002:")) {
      fail("custom tags are not allowed");
    }
  });
  return validateExploreConfig(document.toJS());
}

/** Credential gate for active agent execution; never call during static planning. */
export function assertExecutionMode(config: ExploreConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (config.mode === "deterministic") return;
  if (!config.agent) fail("agent must be configured when mode is agent", "agent");
  const secret = config.agent.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!env[secret]?.trim()) {
    throw new CiError({
      code: "AGENT_API_KEY_MISSING", stage: "preflight",
      message: `Agent mode requires ${secret}.`,
      nextAction: `Add ${secret} to GitHub Actions secrets and pass it to the Explore job.`,
      details: { provider: config.agent.provider, secretName: secret },
    });
  }
}

function contained(root: string, target: string): boolean {
  return target !== root && target.startsWith(`${root}${sep}`);
}

/** Read one bounded, repository-contained instruction document for both revisions. */
export async function readExploreInstructions(project: string, config: ExploreConfig): Promise<{ text: string; sha256: string } | undefined> {
  if (config.mode !== "agent") return undefined;
  const path = config.agent?.instructions;
  if (!path) fail("agent.instructions is required in agent mode", "agent.instructions");
  const root = await realpath(project);
  const file = await realpath(resolve(root, path));
  if (!contained(root, file)) fail("agent.instructions escapes the project", "agent.instructions");
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) fail("agent.instructions must be a file of at most 64 KiB", "agent.instructions");
  const source = await readFile(file, "utf8");
  if (!source.trim() || source.includes("\0")) fail("agent.instructions must contain nonempty text", "agent.instructions");
  explorationSecretNames(source);
  return { text: source, sha256: createHash("sha256").update(source).digest("hex") };
}

/** Read only inside the project, including the real targets of symbolic links. */
export async function readExploreConfig(project: string, path = DEFAULT_EXPLORE_CONFIG_PATH): Promise<ExploreConfig> {
  const root = resolve(project);
  const target = resolve(root, path);
  if (!contained(root, target)) fail("config path escapes the project", "config path");
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    if (!contained(realRoot, realTarget)) fail("config path escapes the project through a symbolic link", "config path");
    const info = await stat(realTarget);
    if (!info.isFile()) fail("config path must point to a file", "config path");
    if (info.size > MAX_CONFIG_BYTES) fail("file is too large");
    const config = parseExploreConfig(await readFile(realTarget, "utf8"));
    await readExploreInstructions(realRoot, config);
    return config;
  } catch (error) {
    if (error instanceof CiError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const missingFile = code === "ENOENT" ? (error as NodeJS.ErrnoException).path : undefined;
    throw new CiError({
      code: "CONFIG_READ_FAILED", stage: "preflight",
      message: missingFile
        ? `${missingFile.endsWith(path) ? `Explore configuration ${path}` : `Referenced file ${missingFile}`} does not exist.`
        : `Cannot read Explore configuration or its referenced instructions: ${code ?? "read failed"}.`,
      nextAction: missingFile?.endsWith(path)
        ? "Run expo-explore setup to create it, or ask your coding agent to set up Explore with the explore-setup skill."
        : `Ensure ${path} and any agent.instructions file exist inside the repository and are readable.`,
      details: { file: path, ...(code === undefined ? {} : { filesystemCode: code }) }, cause: error,
    });
  }
}
