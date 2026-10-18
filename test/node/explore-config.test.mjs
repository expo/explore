import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { DEFAULT_EXPLORE_CONFIG_PATH, assertExecutionMode, parseExploreConfig, readExploreConfig, validateExploreConfig, configPlatforms, configTargets, resolvePlatformConfig, resolveTargetConfig, withRunOverrides, captureRepack } =
  await tsImport("../../src/config/explore-config.ts", import.meta.url);

const SOURCE = `app:
  name: Example
  platform: ios
  bundleId: com.example.app
  easProfile: explore
  scheme: example-app
device:
  name: iPhone 17 Pro
`;
const base = () => ({ app: { bundleId: "com.example.app", easProfile: "explore" }, device: { name: "iPhone 17 Pro" } });

test("normalizes current configuration with deterministic defaults and no version label", () => {
  assert.deepEqual(parseExploreConfig(SOURCE), {
    mode: "deterministic",
    app: { name: "Example", platform: "ios", bundleId: "com.example.app", easProfile: "explore", scheme: "example-app" },
    device: { name: "iPhone 17 Pro" }, navigation: { provider: "auto" },
    exploration: { scope: "changes" }, capture: { maxMinutes: 30, maxActions: 500, appearance: "auto", launch: "screenshot", reset: "root-link", unattributed: "publish" },
  });
  assert.deepEqual(validateExploreConfig({ ...base(), navigation: { provider: "react-navigation", entry: "src/navigation/Root.tsx" }, exploration: { scope: "all" } }).navigation,
    { provider: "react-navigation", entry: "src/navigation/Root.tsx" });
});

test("rejects obsolete configuration and gives the exact next action", () => {
  for (const field of ["contract", "manifest", "viewer"]) {
    assert.throws(() => validateExploreConfig({ ...base(), [field]: "old" }), (error) => {
      assert.equal(error.code, "CONFIG_INVALID");
      assert.equal(error.stage, "preflight");
      assert.equal(error.retryable, false);
      assert.match(error.nextAction, new RegExp(`Remove ${field}`));
      return true;
    });
  }
  for (const capture of [{ keyless: true }, { mode: "all" }]) {
    assert.throws(() => validateExploreConfig({ ...base(), capture }), /unsupported field/);
  }
  assert.throws(() => validateExploreConfig({ ...base(), app: { ...base().app, runtimeProbeUrl: "app://__explore/runtime" } }), /runtimeProbeUrl/);
  assert.equal(validateExploreConfig({ ...base(), capture: { readinessSeconds: 12 } }).capture.readinessSeconds, 12);
  assert.equal("readinessSeconds" in validateExploreConfig(base()).capture, false);
  assert.throws(() => validateExploreConfig({ ...base(), capture: { readinessSeconds: 0 } }), /capture.readinessSeconds must be a positive integer/);
});

test("validates device, capture limits, providers, paths, and custom app schemes", () => {
  for (const device of [undefined, null, {}, { name: "" }]) assert.throws(() => validateExploreConfig({ ...base(), device }), /device/);
  for (const limit of [0, -1, 0.5, "30", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateExploreConfig({ ...base(), capture: { maxMinutes: limit } }), /positive integer/);
  }
  assert.throws(() => validateExploreConfig({ ...base(), navigation: { provider: "unknown" } }), /navigation.provider/);
  for (const entry of ["../App.tsx", "/App.tsx", "C:/App.tsx", "src\\App.tsx"]) {
    assert.throws(() => validateExploreConfig({ ...base(), navigation: { entry } }), /relative repository path/);
  }
  for (const scheme of ["https", "javascript", "file", "my-app://", "bad scheme"]) {
    assert.throws(() => validateExploreConfig({ ...base(), app: { ...base().app, scheme } }), /custom scheme/);
  }
  assert.equal(validateExploreConfig({ ...base(), app: { ...base().app, platform: "android" } }).app.platform, "android");
  assert.throws(() => validateExploreConfig({ ...base(), app: { ...base().app, platform: "web" } }), /app.platform/);
  assert.throws(() => validateExploreConfig({ ...base(), device: { name: "bad\nname" } }), /control characters/);
});

test("exploration.exclude names routes once each", () => {
  assert.deepEqual(validateExploreConfig({ ...base(), exploration: { exclude: ["/c/[channel]", " /debug "] } }).exploration,
    { scope: "changes", exclude: ["/c/[channel]", "/debug"] });
  for (const exclude of ["/debug", [""], ["/a", "/a"], [1]]) {
    assert.throws(() => validateExploreConfig({ ...base(), exploration: { exclude } }), error => error.code === "CONFIG_INVALID" && error.details.field.startsWith("exploration.exclude"));
  }
});

test("parameters are sorted and structured setup is validated without becoming an inventory", () => {
  const config = validateExploreConfig({
    ...base(), app: { ...base().app, scheme: "app" },
    parameters: { "/z/[id]": { z: "last", id: "42" }, "/a": { query: "a b" } },
    setup: [{ action: "open", url: "app://login" }, { action: "tap", label: "Continue" }, { action: "wait", milliseconds: 300 }],
  });
  assert.deepEqual(Object.keys(config.parameters), ["/a", "/z/[id]"]);
  assert.deepEqual(Object.keys(config.parameters["/z/[id]"]), ["id", "z"]);
  assert.equal(config.setup.length, 3);
  assert.throws(() => validateExploreConfig({ ...base(), parameters: { "/x": { id: 1 } } }), /must be a string/);
  // Parameters travel in the app link, so their names must be usable as query keys.
  assert.throws(() => validateExploreConfig({ ...base(), parameters: { "/x": { "hold me": "true" } } }), /parameter name.*whitespace/);
  assert.throws(() => validateExploreConfig({ ...base(), parameters: { "/x": { Token: "abc" } } }), /credential-like/);
  for (const setup of [[{ action: "shell", command: "anything" }], [{ action: "wait", milliseconds: 30_001 }], [{ action: "tap", label: "" }], [{ action: "open", url: "https://example.com" }]]) {
    assert.throws(() => validateExploreConfig({ ...base(), setup }), /setup/);
  }
  assert.throws(() => validateExploreConfig({ ...base(), app: { ...base().app, scheme: "app" }, setup: [{ action: "open", url: "other://login" }] }), /app's custom scheme/);
});

test("UI setup validates input, scroll, exact selectors and readiness without defining capture targets", () => {
  const setup = [
    { action: "fill", label: "Cat name", text: "Milo", ready: { identifier: "continue", enabled: true } },
    { action: "tap", identifier: "password" },
    { action: "type", text: "{{secret:TEST_PASSWORD}}" },
    { action: "scroll", direction: "bottom" },
    { action: "tap", identifier: "continue", ready: { label: "Next screen" } },
  ];
  assert.deepEqual(validateExploreConfig({ ...base(), setup }).setup, setup);
  for (const invalid of [
    { action: "tap", identifier: "continue", label: "Continue" },
    { action: "fill", identifier: "name" },
    { action: "fill", identifier: "name", text: "line\nbreak" },
    { action: "type", identifier: "password", text: "value" },
    { action: "type", text: "line\nbreak" },
    { action: "scroll", direction: "end" },
    { action: "tap", label: "Continue", ready: { label: "Next", enabled: "yes" } },
    { action: "tap", label: "Continue", ready: { label: "Next", route: "/next" } },
  ]) assert.throws(() => validateExploreConfig({ ...base(), setup: [invalid] }), /setup/);
  const gated = [{ action: "tap", label: "Create a new account", requiresRoute: "/auth/sign-up" }, { action: "open", url: "app://account", requiresRoute: "/cats/[catId]" }];
  assert.deepEqual(validateExploreConfig({ ...base(), app: { ...base().app, scheme: "app" }, setup: gated }).setup, gated);
  for (const requiresRoute of ["Root/Account", "expo-account-e51ad3c7b139", "/scan/loading?exploreHold=true"]) {
    assert.equal(validateExploreConfig({ ...base(), setup: [{ action: "tap", label: "Continue", requiresRoute }] }).setup[0].requiresRoute, requiresRoute);
  }
  for (const requiresRoute of ["/sign in", "", 3]) {
    assert.throws(() => validateExploreConfig({ ...base(), setup: [{ action: "tap", label: "Continue", requiresRoute }] }), /requiresRoute/);
  }
  assert.throws(() => validateExploreConfig({ ...base(), setup: [{ action: "type", text: "{{secret:OPENAI_API_KEY}}" }] }),
    { code: "EXPLORATION_SECRET_REFERENCE_INVALID" });
});

test("agent mode requires explicit configuration and credentials without affecting static validation", () => {
  for (const [provider, secret] of [["openai", "OPENAI_API_KEY"], ["anthropic", "ANTHROPIC_API_KEY"]]) {
    const config = validateExploreConfig({ ...base(), mode: "agent", agent: { provider, model: "explicit-model", instructions: ".expo-explore/instructions.md" } });
    for (const value of [undefined, "", "   "]) {
      assert.throws(() => assertExecutionMode(config, { [secret]: value }), (error) => {
        assert.equal(error.code, "AGENT_API_KEY_MISSING");
        assert.match(error.message, new RegExp(secret));
        assert.match(error.nextAction, /GitHub Actions secrets/);
        return true;
      });
    }
    assert.doesNotThrow(() => assertExecutionMode(config, { [secret]: "present-but-not-tested" }));
  }
  assert.doesNotThrow(() => assertExecutionMode(validateExploreConfig(base()), {}));
  assert.doesNotThrow(() => assertExecutionMode(validateExploreConfig(base()), { OPENAI_API_KEY: "key", ANTHROPIC_API_KEY: "key" }));
  assert.throws(() => validateExploreConfig({ ...base(), mode: "agent" }), /agent must be a mapping/);
  assert.throws(() => validateExploreConfig({ ...base(), mode: "agent", agent: { provider: "openai" } }), /agent.model/);
});

test("rejects YAML alias/anchor execution surfaces, custom tags, duplicate keys, and oversized files", () => {
  for (const source of ["app: &app {}\n", "app: *app\n", "app: !!js/function 'x'\n", "app: {}\napp: {}\n", "x".repeat(70 * 1024)]) {
    assert.throws(() => parseExploreConfig(source), (error) => error.code === "CONFIG_INVALID");
  }
});

test("read failures identify the action and symbolic links cannot escape the project", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "explore-config-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const project = join(parent, "repo");
  await mkdir(join(project, ".expo-explore"), { recursive: true });
  await writeFile(join(project, DEFAULT_EXPLORE_CONFIG_PATH), SOURCE);
  assert.equal((await readExploreConfig(project)).device.name, "iPhone 17 Pro");
  await assert.rejects(readExploreConfig(project, "../outside.yaml"), /escapes the project/);
  await assert.rejects(readExploreConfig(project, "missing.yaml"), (error) => error.code === "CONFIG_READ_FAILED" && error.details.filesystemCode === "ENOENT");
  await writeFile(join(parent, "outside.yaml"), SOURCE);
  await symlink(join(parent, "outside.yaml"), join(project, "linked.yaml"));
  await assert.rejects(readExploreConfig(project, "linked.yaml"), /symbolic link/);
});

test("agent instruction files must exist inside the repository", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "explore-agent-config-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, ".expo-explore"));
  await writeFile(join(project, DEFAULT_EXPLORE_CONFIG_PATH), `${SOURCE}\nmode: agent\nagent:\n  provider: anthropic\n  model: explicit-model\n  instructions: .expo-explore/instructions.md\n`);
  await assert.rejects(readExploreConfig(project), (error) => error.code === "CONFIG_READ_FAILED");
  await writeFile(join(project, ".expo-explore/instructions.md"), "Open the app and capture available routes.");
  assert.equal((await readExploreConfig(project)).agent.instructions, ".expo-explore/instructions.md");
});

test("report.preview opts into hosted previews with a bounded expiry and an optional project slug", () => {
  assert.deepEqual(validateExploreConfig({ ...base(), report: { preview: { hosting: "eas" } } }).report,
    { preview: { hosting: "eas", expiresAfterDays: 30 } });
  assert.deepEqual(validateExploreConfig({ ...base(), report: { preview: { hosting: "eas", expiresAfter: "14 days", owner: "acme", project: "acme-explore" } } }).report,
    { preview: { hosting: "eas", expiresAfterDays: 14, owner: "acme", project: "acme-explore" } });
  assert.deepEqual(validateExploreConfig({ ...base(), report: { preview: { hosting: "eas", expiresAfter: 3 } } }).report?.preview?.expiresAfterDays, 3);
  assert.equal(validateExploreConfig({ ...base(), report: { preview: { hosting: "eas", expiresAfter: "365d" } } }).report?.preview?.expiresAfterDays, 365);
  assert.equal(validateExploreConfig({ ...base(), report: { preview: { hosting: "eas", expiresAfter: "never" } } }).report?.preview?.expiresAfterDays, null);
  assert.deepEqual(validateExploreConfig({ ...base(), report: {} }).report, {});
  assert.equal(validateExploreConfig(base()).report, undefined);
  for (const preview of [{ hosting: "vercel" }, { hosting: "eas", expiresAfter: "366d" }, { hosting: "eas", expiresAfter: "0d" }, { hosting: "eas", expiresAfter: "forever" },
    { hosting: "eas", expiresAfter: "2 weeks" }, { hosting: "eas", project: "Acme" },
    { hosting: "eas", owner: "Acme Org" }, { hosting: "eas", token: "x" }, {}]) {
    assert.throws(() => validateExploreConfig({ ...base(), report: { preview } }), /Invalid .expo-explore\/config.yaml: report.preview/);
  }
  assert.throws(() => validateExploreConfig({ ...base(), report: { hosting: "eas" } }), /report/);
});

test("platforms: a flat config is iOS-only and resolves to itself", () => {
  const config = validateExploreConfig(base());
  assert.deepEqual(configPlatforms(config), ["ios"]);
  assert.deepEqual(resolvePlatformConfig(config, undefined), config);
  assert.deepEqual(resolvePlatformConfig(config, "ios"), config);
  assert.throws(() => resolvePlatformConfig(config, "android"), (error) => error.code === "PLATFORM_NOT_CONFIGURED");
  const android = validateExploreConfig({ ...base(), app: { ...base().app, platform: "android", bundleId: "com.example.app" }, device: { name: "pixel_8" } });
  assert.deepEqual(configPlatforms(android), ["android"]);
  assert.equal(resolvePlatformConfig(android, undefined).app.platform, "android");
});

test("platforms: the map adds Android next to the flat iOS fields and flattens per platform", () => {
  const config = validateExploreConfig({ ...base(), platforms: { ios: null, android: { bundleId: "com.example.app", easProfile: "explore-android" } } });
  assert.deepEqual(config.platforms, { ios: {}, android: { bundleId: "com.example.app", easProfile: "explore-android" } });
  assert.deepEqual(configPlatforms(config), ["ios", "android"]);
  const ios = resolvePlatformConfig(config, "ios");
  assert.equal(ios.platforms, undefined);
  assert.deepEqual(ios.app, { platform: "ios", bundleId: "com.example.app", easProfile: "explore" });
  assert.deepEqual(ios.device, { name: "iPhone 17 Pro" });
  const android = resolvePlatformConfig(config, "android");
  assert.deepEqual(android.app, { platform: "android", bundleId: "com.example.app", easProfile: "explore-android" });
  assert.deepEqual(android.device, { name: "pixel_7" });
  assert.equal(resolvePlatformConfig(validateExploreConfig({ ...base(), platforms: { ios: { device: "iPhone 16" }, android: { device: "pixel_8", bundleId: "com.example.app", easProfile: "x" } } }), "android").device.name, "pixel_8");
  assert.throws(() => resolvePlatformConfig(config, undefined), (error) => error.code === "PLATFORM_REQUIRED");
  // Android-only through the map keeps the flat fields as unused iOS defaults.
  assert.deepEqual(configPlatforms(validateExploreConfig({ ...base(), platforms: { android: { bundleId: "com.example.app", easProfile: "x" } } })), ["android"]);
  assert.throws(() => validateExploreConfig({ ...base(), platforms: { android: {} } }), /platforms.android needs bundleId and easProfile/);
  assert.throws(() => validateExploreConfig({ ...base(), platforms: {} }), /platforms must list/);
  assert.throws(() => validateExploreConfig({ ...base(), platforms: { web: {} } }), /unsupported field web/);
  assert.throws(() => validateExploreConfig({ ...base(), platforms: { ios: { simulator: true } } }), /unsupported field simulator/);
  assert.throws(() => validateExploreConfig({ ...base(), app: { ...base().app, platform: "web" } }), /app.platform must be one of ios, android/);
});

test("ci.trustedAuthors is a short list of GitHub logins", () => {
  assert.deepEqual(validateExploreConfig({ ...base(), ci: { trustedAuthors: ["devin-ai-integration[bot]", "octo-cat"] } }).ci,
    { trustedAuthors: ["devin-ai-integration[bot]", "octo-cat"] });
  assert.deepEqual(validateExploreConfig({ ...base(), ci: {} }).ci, {});
  assert.equal(validateExploreConfig(base()).ci, undefined);
  for (const trustedAuthors of ["devin", [""], ["-devin"], ["devin--bot"], ["a".repeat(40)], ["devin[bot]x"], ["a b"], [1], ["devin", "Devin"],
    Array.from({ length: 21 }, (_, index) => `bot-${index}`)]) {
    assert.throws(() => validateExploreConfig({ ...base(), ci: { trustedAuthors } }), /ci\.trustedAuthors/);
  }
  assert.throws(() => validateExploreConfig({ ...base(), ci: { authors: [] } }), /ci/);
});

test("capture.reset accepts root-link or none, defaults to root-link, and rejects other values", () => {
  assert.equal(validateExploreConfig(base()).capture.reset, "root-link");
  assert.equal(validateExploreConfig({ ...base(), capture: { reset: "none" } }).capture.reset, "none");
  assert.throws(() => validateExploreConfig({ ...base(), capture: { reset: "relaunch" } }), /capture\.reset must be "root-link" or "none"/);
});

test("capture.controller chooses Argent; agent-device, the default, leaves the config as it was", () => {
  const plain = validateExploreConfig(base());
  assert.equal("controller" in plain.capture, false);
  assert.deepEqual(validateExploreConfig({ ...base(), capture: { controller: "agent-device" } }), plain);
  assert.equal(validateExploreConfig({ ...base(), capture: { controller: "argent" } }).capture.controller, "argent");
  assert.throws(() => validateExploreConfig({ ...base(), capture: { controller: "maestro" } }), error => error.code === "CONFIG_INVALID");
});

test("--controller overrides the config's controller for one run and is validated", () => {
  const plain = validateExploreConfig(base());
  const argent = withRunOverrides(plain, { controller: "argent" });
  assert.equal(argent.capture.controller, "argent");
  assert.deepEqual(withRunOverrides(argent, { controller: "agent-device" }), plain);
  assert.deepEqual(withRunOverrides(plain, {}), plain);
  assert.throws(() => withRunOverrides(plain, { controller: "appium" }), /--controller must be agent-device or argent/);
});

test("capture.simulator: local runs on a simulator on this Mac; eas, the default, leaves the config as it was", () => {
  const plain = validateExploreConfig(base());
  assert.equal("simulator" in plain.capture, false);
  assert.deepEqual(validateExploreConfig({ ...base(), capture: { simulator: "eas" } }), plain);
  assert.equal(validateExploreConfig({ ...base(), capture: { simulator: "local" } }).capture.simulator, "local");
  assert.throws(() => validateExploreConfig({ ...base(), capture: { simulator: "device-farm" } }), error => error.code === "CONFIG_INVALID");
});

test("the repack runs on this machine with a local simulator and in EAS otherwise, unless the config or --repack chooses", () => {
  const plain = validateExploreConfig(base());
  assert.equal("repack" in plain.capture, false, "an unset repack is resolved where it is used");
  assert.equal(captureRepack(plain), "eas");
  assert.equal(captureRepack(validateExploreConfig({ ...base(), capture: { simulator: "local" } })), "local");
  assert.equal(captureRepack(validateExploreConfig({ ...base(), capture: { simulator: "local", repack: "eas" } })), "eas");
  assert.equal(captureRepack(validateExploreConfig({ ...base(), capture: { repack: "local" } })), "local");
  // --simulator local brings the local repack with it; --repack wins over both.
  assert.equal(captureRepack(withRunOverrides(plain, { simulator: "local" })), "local");
  assert.equal(captureRepack(withRunOverrides(plain, { simulator: "local", repack: "eas" })), "eas");
  assert.equal(captureRepack(withRunOverrides(plain, { repack: "local" })), "local");
  assert.throws(() => withRunOverrides(plain, { repack: "remote" }), /--repack must be eas or local/);
  assert.throws(() => validateExploreConfig({ ...base(), capture: { repack: "remote" } }), error => error.code === "CONFIG_INVALID");
});

test("--simulator overrides the config's simulator for one run and is validated", () => {
  const plain = validateExploreConfig(base());
  const local = withRunOverrides(plain, { simulator: "local" });
  assert.equal(local.capture.simulator, "local");
  assert.deepEqual(withRunOverrides(local, { simulator: "eas" }), plain);
  assert.throws(() => withRunOverrides(plain, { simulator: "remote" }), /--simulator must be eas or local/);
});

test("device.pose folds the primary platform's device and is validated", () => {
  const open = validateExploreConfig({ ...base(), device: { name: "iPhone Duo", pose: "open" } });
  assert.deepEqual(open.device, { name: "iPhone Duo", pose: "open" });
  assert.equal("pose" in validateExploreConfig(base()).device, false);
  assert.throws(() => validateExploreConfig({ ...base(), device: { name: "iPhone Duo", pose: "flat" } }), error => error.code === "CONFIG_INVALID");
  const both = validateExploreConfig({ ...base(), app: { ...base().app, platform: "ios" }, device: { name: "iPhone Duo", pose: "open" },
    platforms: { ios: {}, android: { device: "pixel_7", bundleId: "com.example.app", easProfile: "explore" } } });
  assert.deepEqual(resolvePlatformConfig(both, "ios").device, { name: "iPhone Duo", pose: "open" });
  assert.deepEqual(resolvePlatformConfig(both, "android").device, { name: "pixel_7" });
});

test("targets name several captures, even of one platform, each resolved to its own flat config", () => {
  const config = validateExploreConfig({ ...base(), targets: {
    iphone: { platform: "ios" },
    "duo-closed": { platform: "ios", device: "iPhone Duo", pose: "closed" },
    "duo-open": { platform: "ios", device: "iPhone Duo", pose: "open", label: "Duo open" },
    android: { platform: "android", bundleId: "com.example.app", easProfile: "explore-apk" },
  } });
  assert.deepEqual(configTargets(config), [
    { id: "iphone", platform: "ios", label: "iPhone 17 Pro" },
    { id: "duo-closed", platform: "ios", label: "iPhone Duo (closed)" },
    { id: "duo-open", platform: "ios", label: "Duo open" },
    { id: "android", platform: "android", label: "pixel_7" },
  ]);
  assert.deepEqual(configPlatforms(config), ["ios", "android"]);
  const open = resolveTargetConfig(config, { target: "duo-open" });
  assert.deepEqual(open.device, { name: "iPhone Duo", pose: "open" });
  assert.deepEqual(open.target, { id: "duo-open", platform: "ios", label: "Duo open" });
  assert.equal("targets" in open, false);
  const android = resolveTargetConfig(config, { platform: "android" });
  assert.deepEqual([android.app.platform, android.app.easProfile, android.device.name], ["android", "explore-apk", "pixel_7"]);
  assert.throws(() => resolveTargetConfig(config, { platform: "ios" }), error => error.code === "TARGET_REQUIRED");
  assert.throws(() => resolveTargetConfig(config, { target: "tablet" }), error => error.code === "TARGET_NOT_CONFIGURED");
});

test("a config without targets has one target per platform, named after it", () => {
  const config = validateExploreConfig({ ...base(), platforms: { ios: {}, android: { bundleId: "com.example.app", easProfile: "explore-apk" } } });
  assert.deepEqual(configTargets(config).map(target => target.id), ["ios", "android"]);
  assert.deepEqual(resolveTargetConfig(config, { target: "android" }).target, { id: "android", platform: "android", label: "Android" });
  assert.deepEqual(resolveTargetConfig(validateExploreConfig(base())).target, { id: "ios", platform: "ios", label: "iOS" });
});

test("target ids and entries are validated", () => {
  for (const targets of [{ Base: { platform: "ios" } }, { head: { platform: "ios" } }, { iphone: { platform: "web" } }, { iphone: { platform: "ios", pose: "flat" } },
    { pixel: { platform: "android" } }, {}]) {
    assert.throws(() => validateExploreConfig({ ...base(), targets }), error => error.code === "CONFIG_INVALID", JSON.stringify(targets));
  }
  assert.throws(() => validateExploreConfig({ ...base(), platforms: { ios: {} }, targets: { iphone: { platform: "ios" } } }), /targets or platforms, not both/);
});

test("a target can choose its own controller and simulator over capture's", () => {
  const config = validateExploreConfig({ ...base(), capture: { controller: "argent", simulator: "local" }, targets: {
    duo: { platform: "ios", device: "iPhone Duo" },
    android: { platform: "android", bundleId: "com.example.app", easProfile: "explore-apk", controller: "agent-device" },
    cloud: { platform: "ios", simulator: "eas" },
  } });
  const capture = id => resolveTargetConfig(config, { target: id }).capture;
  assert.deepEqual([capture("duo").controller, capture("duo").simulator], ["argent", "local"]);
  assert.deepEqual([capture("android").controller, capture("android").simulator], [undefined, "local"], "agent-device is the default, so it is absent");
  assert.deepEqual([capture("cloud").controller, capture("cloud").simulator], ["argent", undefined]);
  // The repack follows each target's simulator.
  assert.deepEqual(["duo", "android", "cloud"].map(id => captureRepack(resolveTargetConfig(config, { target: id }))), ["local", "local", "eas"]);
  assert.throws(() => validateExploreConfig({ ...base(), targets: { duo: { platform: "ios", controller: "maestro" } } }), error => error.code === "CONFIG_INVALID");
});

test("flows: the app's e2e tests run in flows mode or beside deterministic routes, never with the agent", () => {
  const flows = validateExploreConfig({ ...base(), mode: "flows", flows: { tests: ["flows/*.e2e.ts", "e2e/checkout.e2e.ts"] } });
  assert.equal(flows.mode, "flows");
  assert.deepEqual(flows.flows, { tests: ["flows/*.e2e.ts", "e2e/checkout.e2e.ts"] });
  assert.deepEqual(validateExploreConfig({ ...base(), flows: { tests: "e2e/**/*.e2e.ts" } }).flows, { tests: ["e2e/**/*.e2e.ts"] });
  assert.throws(() => validateExploreConfig({ ...base(), mode: "flows" }), /flows.tests is required in flows mode/);
  assert.throws(() => validateExploreConfig({ ...base(), mode: "agent", agent: { provider: "openai", model: "m", instructions: "x.md" }, flows: { tests: ["a.e2e.ts"] } }), /cannot be combined with agent mode/);
  assert.throws(() => validateExploreConfig({ ...base(), flows: { tests: ["../outside.e2e.ts"] } }), /inside the app directory/);
  assert.throws(() => validateExploreConfig({ ...base(), flows: { tests: [], extra: 1 } }), /flows/);
});
