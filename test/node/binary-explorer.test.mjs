import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { runBlackBoxExploration, screenEvidenceKey, elementsOf, fieldName, systemDialogTitle } = await tsImport("../../src/binary/explorer.ts", import.meta.url);
const { ExploreStore, validateMap } = await tsImport("../../src/map/store.ts", import.meta.url);
const { CONTRACT } = await tsImport("../../src/types.ts", import.meta.url);
const tsRun = await tsImport("../../src/binary/run.ts", import.meta.url);
const { assertAppUrl, describeForeground, foreignNode, guardPositionals, leftForeground, retryWhileBusy } = tsRun;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SCREENS = {
  home: [{ type: "StaticText", label: "Welcome back, 12:31" }, { type: "Button", label: "Settings" }, { type: "Button", label: "Delete account" }, { type: "Button", label: "Share" }],
  settings: [{ type: "StaticText", label: "Settings" }, { type: "Switch", label: "Dark mode" }, { type: "Button", label: "Back" }],
};

async function harness(script, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-explorer-"));
  const store = new ExploreStore(root);
  const now = new Date("2026-01-01T00:00:00Z").toISOString();
  const map = { contract: CONTRACT, revision: 0, run: { id: "run-1", name: "Example", platform: "ios", controller: "agent-device", bundleId: "dev.example.app", status: "exploring",
    createdAt: now, updatedAt: now, build: { hash: "0".repeat(64), source: "local" }, environment: { deviceModel: "iPhone 17 Pro" }, limits: { maxScreens: 10, maxActions: 10, maxDurationMinutes: 5 } },
    artifacts: [], screens: [], variants: [], observations: [], elements: [], actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [] };
  await store.initialize(map, false);
  let current = "home"; const acted = [];
  const calls = [];
  const session = { provider: "anthropic", model: "test", async preflight() {}, async run(request) {
    for (const [name, input] of script) {
      let result;
      try { result = await request.callTool(name, input, request.signal); }
      catch (error) { if (request.signal.aborted) return { stopReason: "aborted" }; throw error; }
      calls.push({ name, result: JSON.parse(result.content[0].text) });
      if (request.signal.aborted) return { stopReason: "aborted" };
    }
    return { stopReason: "done" };
  } };
  const result = await (options.explore ?? runBlackBoxExploration)({ session, store, map, app: { name: "Example", bundleId: "dev.example.app", platform: "ios" },
    deadlineMs: Date.now() + 60_000, maxScreens: 10, maxActions: 10, maxTurns: 50, loadingSettleMs: 0,
    observe: async includeImage => ({ nodes: SCREENS[current], capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${calls.length}`, png: PNG, imageSha256: `${calls.length}`.padStart(64, "a") } : {}) }),
    act: async action => { acted.push(action); if (action.action === "tap" && action.label === "Settings") current = "settings"; if (action.action === "back") current = "home"; }, ...options });
  return { result, map, calls, acted, root, store };
}

test("evidence keys ignore volatile text but not structure", () => {
  const key = screenEvidenceKey(SCREENS.home);
  assert.equal(key, screenEvidenceKey([{ type: "StaticText", label: "Welcome back, 09:05" }, ...SCREENS.home.slice(1)]));
  assert.notEqual(key, screenEvidenceKey(SCREENS.settings));
});

test("a scripted exploration records screens, a blocked destructive tap, a transition, and finishes", async () => {
  const frame = index => `frame-${index}`;
  const { result, map, calls, acted, root } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Delete account" }],
    ["act", { action: "tap", label: "Settings" }],
    ["observe", { includeImage: true }], ["capture", { frameId: frame(4), title: "Settings" }],
    ["act", { action: "tap", label: "Dark mode" }],
    ["act", { action: "back" }], ["get_progress", {}], ["finish", { summary: "Two screens." }],
  ]);
  assert.equal(result.stopReason, "finished"); assert.equal(result.summary, "Two screens.");
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home", "Settings"]);
  assert.equal(map.observations.filter(observation => observation.screenshotArtifactId).length, 2);
  assert.ok(map.observations.every(observation => observation.accessibilityArtifactId));
  assert.ok(acted.every(action => action.label !== "Delete account"), "destructive tap never reached the device");
  assert.equal(calls[2].result.blocked, true);
  assert.ok(map.actionAttempts.some(attempt => attempt.outcome === "blocked" && attempt.risk === "destructive"));
  assert.ok(map.elements.some(element => element.label === "Delete account" && element.risk === "destructive"));
  assert.ok(!map.frontier.some(item => item.label === "Delete account"), "destructive controls are never queued");
  assert.equal(map.transitions.length, 3, "Settings, the Dark mode self-transition, and back");
  assert.equal(calls[3].result.outcome, "transition");
  assert.equal(calls[6].result.outcome, "same-screen");
  const sameScreen = map.actionAttempts.find(attempt => attempt.outcome === "same-screen");
  assert.ok(map.transitions.some(transition => transition.fromScreenId === transition.toScreenId && transition.attemptIds.includes(sameScreen.id)), "same-screen attempts belong to a self-transition");
  assert.ok(map.frontier.some(item => item.label === "Settings" && item.status === "done"));
  for (const artifact of map.artifacts) await stat(join(root, artifact.path));
  assert.equal(map.observations.filter(observation => observation.screenshotArtifactId).length, 2);
  // Every harness frame is the same PNG bytes, so the shots share one artifact: screenshots are hashed and deduplicated here.
  assert.equal(map.artifacts.filter(artifact => artifact.kind === "screenshot").length, 1);
});

test("the action budget stops the run and leaves a coverage gap", async () => {
  const { result, map } = await harness([
    ["observe", { includeImage: false }], ["act", { action: "tap", label: "Settings" }], ["act", { action: "back" }], ["act", { action: "tap", label: "Settings" }],
  ], { maxActions: 2 });
  assert.equal(result.stopReason, "budget-actions"); assert.equal(result.actions, 2);
  assert.ok(map.gaps.some(gap => /actions budget/.test(gap.message)));
  assert.ok(map.frontier.some(item => item.status === "pending"), "unexplored controls stay pending for gap:list");
});

test("an action before any observation observes first, so the attempt has a source screen", async () => {
  const { map } = await harness([["act", { action: "tap", label: "Settings" }], ["finish", { summary: "Acted blind." }]]);
  assert.equal(map.actionAttempts.length, 1);
  assert.ok(map.actionAttempts[0].sourceScreenId && map.actionAttempts[0].sourceObservationId);
  assert.ok(map.screens.length >= 1);
});

test("capture requires the latest observed frame", async () => {
  const { calls } = await harness([["observe", { includeImage: true }], ["capture", { frameId: "stale", title: "Nope" }], ["finish", { summary: "x" }]]);
  assert.equal(calls[1].result.code, "AGENT_FRAME_STALE");
});

test("controls that leave the app are blocked like destructive ones and never queued", async () => {
  const { map, calls, acted } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Share" }], ["finish", { summary: "Done." }],
  ]);
  assert.equal(calls[2].result.blocked, true);
  assert.match(calls[2].result.reason, /opens another app/);
  assert.ok(acted.every(action => action.label !== "Share"));
  assert.ok(map.actionAttempts.some(attempt => attempt.outcome === "blocked" && attempt.risk === "external"));
  assert.ok(!map.frontier.some(item => item.label === "Share"));
  const { map: allowed, acted: allowedActs } = await harness([["observe", { includeImage: false }], ["act", { action: "tap", label: "Share" }], ["finish", { summary: "Done." }]], { allowDestructive: ["Share"] });
  assert.ok(allowedActs.some(action => action.label === "Share"), "--allow-destructive lifts the block");
  assert.ok(allowed.frontier.some(item => item.label === "Share"));
});

test("an in-app Map tab is safe; a named maps app or directions leave the app", async () => {
  const { riskOf } = await tsImport("../../src/binary/explorer.ts", import.meta.url);
  for (const label of ["Map", "Maps", "Store map", "Map view"]) assert.equal(riskOf(label, []), "safe", label);
  for (const label of ["Open in Maps", "Apple Maps", "Google Maps", "Get directions"]) assert.equal(riskOf(label, []), "external", label);
});

test("open is confined to the app's own URL schemes; system and store schemes never leave the app", () => {
  for (const url of ["https://example.com", "itms-apps://apps.apple.com/app/id1", "app-settings:", "prefs:root=General", "shortcuts://run", "market://details?id=x", "intent://scan#Intent;end", "tel:911", "x-apple-health://"]) {
    assert.throws(() => assertAppUrl(url), /AGENT_URL_NOT_ALLOWED|leave the app/, url);
  }
  assertAppUrl("euxy://settings");
  assertAppUrl("euxy://settings", ["euxy", "exp+euxy"]);
  assert.throws(() => assertAppUrl("otherapp://x", ["euxy"]), /not a URL scheme this app registers/);
  assert.throws(() => assertAppUrl("not a url"), /Not a URL/);
});

test("free text handed to agent-device sits behind a -- separator so it is never parsed as a flag", () => {
  assert.deepEqual(guardPositionals(["type", "--help", "--level", "full", "--json"]), ["type", "--level", "full", "--json", "--", "--help"]);
  assert.deepEqual(guardPositionals(["fill", "@e3", "-5 octaves", "--level", "full", "--json"]), ["fill", "--level", "full", "--json", "--", "@e3", "-5 octaves"]);
  // The controller appends --json after the caller's args; typed text must not swallow it (Rocket.Chat received "test.rocket.chat --json").
  assert.deepEqual(guardPositionals(["fill", "@e3", "test.rocket.chat", "--json"]), ["fill", "--json", "--", "@e3", "test.rocket.chat"]);
  assert.deepEqual(guardPositionals(["type", "hello world", "--json"]), ["type", "--json", "--", "hello world"]);
  assert.deepEqual(guardPositionals(["press", "@e3", "--level", "full", "--json"]), ["press", "@e3", "--level", "full", "--json"]);
});

test("explore:session picks the app in the foreground, else the only installed app, else asks for --bundle-id", async () => {
  const { resolveSessionApp } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const connection = { sessionId: "s", daemonBaseUrl: "https://daemon.example", daemonAuthToken: "secret-token" };
  const calls = [];
  const runner = ({ appstate, apps }) => request => {
    calls.push(request.args);
    assert.equal(request.environment.AGENT_DEVICE_DAEMON_AUTH_TOKEN, "secret-token");
    if (request.args[0] === "appstate") { if (appstate instanceof Error) throw appstate; return { stdout: JSON.stringify({ success: true, data: appstate }) }; }
    return { stdout: JSON.stringify({ success: true, data: { apps } }) };
  };
  const ios = { platform: "ios", appName: "dev.brent.euxy", appBundleId: "dev.brent.euxy", source: "runner", state: "runningForeground", surface: "app" };
  assert.deepEqual(resolveSessionApp(runner({ appstate: ios, apps: [] }), connection, "/tmp", "ios", "iPhone 17 Pro", "mine", {}), { bundleId: "dev.brent.euxy" });
  assert.deepEqual(calls[0].slice(0, 3), ["appstate", "--session", "mine"]);
  assert.ok(calls[0].includes("--device") && calls[0].includes("iPhone 17 Pro"));

  // No agent-device session yet: only the installed list is consulted.
  calls.length = 0;
  assert.deepEqual(resolveSessionApp(runner({ apps: ["euxy (dev.brent.euxy)"] }), connection, "/tmp", "ios", "iPhone 17 Pro", undefined, {}), { bundleId: "dev.brent.euxy", name: "euxy" });
  assert.deepEqual(calls.map(args => args[0]), ["apps"]);

  // Android foreground on the launcher is not an app; a single third-party package wins, system packages are ignored.
  const launcher = { platform: "android", appBundleId: "com.google.android.apps.nexuslauncher", state: "runningForeground", surface: "app" };
  assert.deepEqual(resolveSessionApp(runner({ appstate: launcher, apps: ["com.android.settings", "dev.brent.euxy"] }), connection, "/tmp", "android", "", "mine", {}), { bundleId: "dev.brent.euxy" });

  // A failing appstate falls through; several installed apps need --bundle-id, and the error lists them.
  assert.throws(
    () => resolveSessionApp(runner({ appstate: new Error("boom secret-token"), apps: ["A (dev.a)", "B (dev.b)"] }), connection, "/tmp", "ios", "iPhone 17 Pro", "mine", {}),
    error => error.code === "BUNDLE_ID_REQUIRED" && /dev\.a, dev\.b/.test(error.message) && !/secret-token/.test(error.message));
  assert.throws(() => resolveSessionApp(runner({ apps: [] }), connection, "/tmp", "ios", "iPhone 17 Pro", undefined, {}), error => error.code === "BUNDLE_ID_REQUIRED");
});

test("decorative images, covered controls, and icons nested inside a control are not queued as controls of their own", async () => {
  const tabBar = [
    { index: 0, type: "Application", label: "wtlfo" },
    { index: 1, parentIndex: 0, type: "TabBar", label: "Tab Bar" },
    { index: 2, parentIndex: 1, type: "Button", label: "Editor", hittable: true },
    { index: 3, parentIndex: 2, type: "Image", label: "waveform", identifier: "waveform", hittable: true },
    { index: 4, parentIndex: 1, type: "Button", label: "Learn", hittable: true },
    { index: 5, parentIndex: 4, type: "Image", label: "bookmark", identifier: "book", hittable: true },
    { index: 6, parentIndex: 1, type: "Cell", label: "Row", hittable: true },
    { index: 7, parentIndex: 6, type: "Switch", label: "Enabled", hittable: true },
    { index: 8, parentIndex: 0, type: "Image", label: "Hero", hittable: true, traits: ["button"] },
    { index: 9, parentIndex: 0, type: "Image", label: "tempo", identifier: "metronome", hittable: true },
    { index: 10, parentIndex: 0, type: "Button", label: "Covered", hittable: false },
    { index: 11, parentIndex: 0, type: "Other", label: "About this app, What it does, ›", hittable: true },
    { index: 12, parentIndex: 0, type: "Other", hittable: true },
    { index: 13, parentIndex: 0, type: "Other", label: "Heading", hittable: false },
  ];
  const { map } = await harness([["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Tabs" }], ["finish", { summary: "Tabs." }]],
    { observe: async includeImage => ({ nodes: tabBar, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png: PNG, imageSha256: "b".repeat(64) } : {}) }) });
  assert.deepEqual(map.frontier.map(item => item.label).sort(), ["About this app, What it does, ›", "Editor", "Enabled", "Hero", "Learn", "Row"]);
});

test("an app icon handed to the explorer becomes a screenshot artifact the run points at", async () => {
  const { map, store } = await harness([["finish", { summary: "Nothing." }]], { appIcon: PNG });
  assert.ok(map.run.appIcon); assert.equal(map.run.appIcon.width, 1);
  assert.ok(map.artifacts.some(artifact => artifact.id === map.run.appIcon.id && artifact.path === map.run.appIcon.path));
  assert.deepEqual(await validateMap(map, store, { checkArtifacts: true }), []);
});

test("model-driven scroll and typing are recorded with the gesture and input the map schema requires", async () => {
  const { map, store } = await harness([
    ["observe", { includeImage: false }],
    ["act", { action: "scroll", direction: "down" }],
    ["act", { action: "type", text: "hello" }],
    ["finish", { summary: "Scrolled and typed." }],
  ]);
  const kinds = map.actionAttempts.map(attempt => [attempt.action.kind, attempt.action.gesture?.direction, attempt.action.input?.value]);
  assert.deepEqual(kinds, [["swipe", "down", undefined], ["fill", undefined, "hello"]]);
  assert.deepEqual(await validateMap(map, store, { checkArtifacts: true }), []);
});

test("a {{secret:NAME}} from the hints is typed on the device, while the model, the map, and the screenshots only hold the reference", async () => {
  // One module graph, so the explorer recognises the inputs' errors as its own CiError.
  const { createExplorationInputs } = await import("../../dist/config/exploration-inputs.js");
  const { runBlackBoxExploration: explore } = await import("../../dist/binary/explorer.js");
  const { readFile } = await import("node:fs/promises");
  const secret = "hunter2-test-password";
  const inputs = createExplorationInputs({ instructions: "Sign in with {{secret:APP_TEST_PASSWORD}}.", environment: { APP_TEST_PASSWORD: secret } });
  let typed = "";
  const device = [];
  const signIn = () => [{ type: "StaticText", label: "Sign in" }, { type: "TextField", label: "Password", value: typed }, { type: "Button", label: "Continue" }];
  const { map, calls, root } = await harness([
    ["observe", { includeImage: true }],
    ["act", { action: "fill", label: "Password", text: "{{secret:APP_TEST_PASSWORD}}" }],
    ["observe", { includeImage: true }],
    ["capture", { frameId: "frame-2", title: "Sign in filled", state: "filled" }],
    ["act", { action: "fill", label: "Password", text: "{{secret:OTHER_PASSWORD}}" }],
    ["finish", { summary: "Signed in." }],
  ], { explore, inputs, hints: "Sign in with {{secret:APP_TEST_PASSWORD}}.",
    observe: async includeImage => ({ nodes: signIn(), capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${device.length + 1}`, png: PNG } : {}) }),
    act: async action => { device.push(action); if (action.action === "fill") typed = action.text; } });
  assert.deepEqual(device.map(action => action.text), [secret], "only the declared reference reached the device, as its value");
  assert.equal(calls[2].result.imageUnavailable.code, "CAPTURE_SENSITIVE_INPUT", "a frame showing the value keeps no picture");
  assert.equal(calls[3].result.code, "CAPTURE_SENSITIVE_INPUT");
  assert.equal(calls[4].result.code, "EXPLORATION_SECRET_UNDECLARED");
  const attempt = map.actionAttempts.find(item => item.action.input);
  assert.deepEqual(attempt.action.input, { value: "{{secret:APP_TEST_PASSWORD}}", redacted: true });
  assert.ok(!JSON.stringify(calls).includes(secret), "the model never sees the value");
  assert.ok(!JSON.stringify(map).includes(secret));
  for (const artifact of map.artifacts) assert.ok(!(await readFile(join(root, artifact.path), "utf8")).includes(secret), artifact.path);
});

test("hint inputs are read before a session starts and name what to set", async () => {
  const { hintInputs } = await tsImport("../../src/binary/run.ts", import.meta.url);
  assert.deepEqual(hintInputs("Explore the settings", {}).names, []);
  assert.deepEqual(hintInputs("Use {{secret:APP_TEST_EMAIL}} and {{secret:APP_TEST_PASSWORD}}", { APP_TEST_EMAIL: "a@example.com", APP_TEST_PASSWORD: "pw" }).names, ["APP_TEST_EMAIL", "APP_TEST_PASSWORD"]);
  assert.throws(() => hintInputs("Use {{secret:APP_TEST_PASSWORD}}", {}), error => error.code === "EXPLORATION_SECRET_MISSING" && /export APP_TEST_PASSWORD=/.test(error.nextAction));
  assert.throws(() => hintInputs("Use {{secret:EXPO_TOKEN}}", { EXPO_TOKEN: "t" }), { code: "EXPLORATION_SECRET_REFERENCE_INVALID" });
});

test("a screen the model reached but never captured is named after the path to it, not 'Screen N'", async () => {
  let current = "home", frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Settings" }],
    ["act", { action: "type", text: "hello" }],
    ["finish", { summary: "Peeked at settings." }],
  ], { act: async action => { if (action.action === "tap") current = "settings"; if (action.action === "type") current = "typing"; },
    observe: async includeImage => ({ nodes: current === "typing" ? [...SCREENS.settings, { type: "TextField", label: "hello" }] : SCREENS[current], capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames++}`, png: PNG, imageSha256: "c".repeat(64) } : {}) }) });
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home", "Home → Settings", "Home → Settings → typing"]);
});

test("a capture titled like an existing screen folds into it as a state instead of a new screen", async () => {
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Settings" }],
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-3", title: "home", state: "keyboard up" }],
    ["finish", { summary: "Done." }],
  ]);
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home"]);
  // Home's capture, the shot taken on arriving at the unnamed screen, and the "keyboard up" capture that folded it.
  assert.equal(map.observations.filter(item => item.screenshotArtifactId).length, 3);
});

test("a tap aimed at an identifier is recorded under the control's visible label", async () => {
  const home = [{ type: "StaticText", label: "Welcome back" }, { type: "Button", label: "Settings", identifier: "settingsBtn" }];
  let current = "home"; const taps = [];
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", identifier: "settingsBtn" }],
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-3", title: "Settings" }],
    ["finish", { summary: "Opened settings." }],
  ], { act: async action => { taps.push(action); if (action.action === "tap") current = "settings"; },
    observe: async includeImage => ({ nodes: current === "home" ? home : SCREENS.settings, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${current === "home" ? 0 : 3}`, png: PNG, imageSha256: "1".repeat(64) } : {}) }) });
  assert.deepEqual(taps, [{ action: "tap", identifier: "settingsBtn" }]);
  assert.deepEqual(map.actionAttempts.map(attempt => [attempt.action.label, attempt.outcome]), [["Settings", "transition"]]);
});

test("a coordinate tap is named after the control under it and completes that frontier item", async () => {
  const screen = [{ type: "Other", label: "Root", rect: { x: 0, y: 0, width: 390, height: 844 } }, { type: "Button", label: "Settings", rect: { x: 20, y: 100, width: 100, height: 44 } }];
  const performed = []; let frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", frameId: "frame-0", x: 70 / 390, y: 122 / 844 }],
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-1", title: "Settings" }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: performed.length ? SCREENS.settings : screen, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}`.padStart(64, "a") } : {}) }),
    act: async action => { performed.push(action); } });
  assert.equal(performed[0].action, "tap"); assert.ok("frameId" in performed[0], "the device still receives the coordinate tap");
  const attempt = map.actionAttempts.find(item => item.action.kind === "press");
  assert.equal(attempt.action.label, "Settings");
  assert.ok(attempt.action.elementId, "the attempt points at the element under the tap");
  assert.equal(attempt.outcome, "transition", attempt.error);
  assert.ok(map.frontier.some(item => item.label === "Settings" && item.status === "done"));
});

test("a coordinate tap on nothing the tree knows that returns to the previous screen is recorded as Back", async () => {
  const performed = []; let frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Settings" }],
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-1", title: "Settings" }],
    ["act", { action: "tap", frameId: "frame-1", x: 0.05, y: 0.1 }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: performed.length === 1 ? SCREENS.settings.map(node => ({ ...node, rect: { x: 0, y: 200, width: 390, height: 44 } })) : SCREENS.home,
      capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}`.padStart(64, "a") } : {}) }),
    act: async action => { performed.push(action); } });
  const presses = map.actionAttempts.filter(item => item.action.kind === "press");
  assert.deepEqual(presses.map(item => [item.action.label, item.outcome]), [["Settings", "transition"], ["Back", "transition"]]);
  assert.ok(!presses[1].action.elementId, "no element claimed the tap");
});

test("a screen seen for the first time gets its screenshot even when the model never captures it", async () => {
  const { map } = await harness([["observe", { includeImage: false }], ["act", { action: "tap", label: "Settings" }], ["finish", { summary: "Moved on." }]]);
  const settings = map.screens.find(screen => screen.id !== map.screens[0].id);
  assert.ok(settings, "the tap created a second screen");
  const observations = map.observations.filter(observation => observation.screenId === settings.id);
  assert.equal(observations.length, 1);
  assert.ok(observations[0].screenshotArtifactId, "the new screen's first observation carries a screenshot");
  assert.equal(map.observations.filter(observation => observation.screenshotArtifactId).length, 2, "the start screen is photographed on arrival too");
});

test("icon-font glyphs are stripped from labels, and a tap on such a control presses its centre", async () => {
  const nodes = [{ type: "Other", label: "root", rect: { x: 0, y: 0, width: 400, height: 800 } },
    { type: "Other", hittable: true, label: "\ue01d, 排行榜", rect: { x: 100, y: 700, width: 200, height: 50 } },
    { type: "Button", hittable: true, label: "\ue5c4" }];
  const pressed = [];
  const { calls, map } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", label: "排行榜" }], ["finish", { summary: "Glyphs." }]], {
    observe: async includeImage => ({ nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-glyph", png: PNG } : {}) }),
    act: async action => { pressed.push(action); } });
  assert.deepEqual(calls[0].result.nodes.map(node => node.label), ["root", "排行榜", undefined]);
  assert.deepEqual(map.elements.map(element => element.label), ["排行榜"]);
  assert.equal(pressed[0].action, "tap");
  assert.ok("frameId" in pressed[0], "pressed by coordinates, not by the cleaned label the device does not know");
  assert.ok(Math.abs(pressed[0].x - 0.5) < 0.01 && Math.abs(pressed[0].y - 725 / 800) < 0.01);
  assert.equal(map.actionAttempts[0].action.label, "排行榜");
});

test("evidence keys ignore a long, changing label on a role-less element", () => {
  const banner = text => [{ type: "Other", label: text, depth: 3 }, { type: "Button", label: "Home", depth: 2 }];
  assert.equal(screenEvidenceKey(banner("boot award --mode console, SYSTEM READY, cat /var/log/award.log")),
    screenEvidenceKey(banner("boot award --mode console, SYSTEM READY, whoami and some more words")));
  assert.notEqual(screenEvidenceKey(banner("Short label")), screenEvidenceKey(banner("Other label")));
});

test("a controller command refused while the runner winds down a previous one is retried, within a budget", () => {
  const busy = () => new Error("press: The iOS runner is still finishing a previous command that exceeded its execution watchdog.");
  let attempts = 0; const pauses = [];
  const result = retryWhileBusy(() => { attempts += 1; if (attempts < 3) throw busy(); return "ok"; }, ms => pauses.push(ms));
  assert.equal(result, "ok"); assert.deepEqual(pauses, [5000, 5000]);
  let clock = 0;
  assert.throws(() => retryWhileBusy(() => { throw busy(); }, ms => { clock += ms; }, 12_000, 5_000, () => clock), /still finishing/);
  assert.equal(clock, 15_000, "three pauses, then the budget is spent");
  assert.throws(() => retryWhileBusy(() => { throw new Error("main thread execution timed out"); }, () => assert.fail("no pause")), /timed out/);
});

test("a launch-blocked reason names what appstate found in front, not just \"another app\"", () => {
  assert.equal(describeForeground({ appBundleId: "com.google.android.apps.nexuslauncher", state: "runningForeground", surface: "app" }), "com.google.android.apps.nexuslauncher is in front");
  assert.equal(describeForeground({ surface: "home" }), "the device shows its home surface");
  assert.equal(describeForeground({ appBundleId: "xyz.blueskyweb.app", surface: "home" }), "the device shows its home surface (appstate names xyz.blueskyweb.app)");
  assert.equal(describeForeground({ state: "notRunning" }), "the snapshot shows another app");
});

test("the app is known to have left the foreground when appstate names another app or a non-app surface", () => {
  assert.equal(leftForeground({ appBundleId: "com.google.android.apps.nexuslauncher", state: "runningForeground", surface: "app" }, "xyz.blueskyweb.app"), true);
  assert.equal(leftForeground({ appBundleId: "xyz.blueskyweb.app", surface: "home" }, "xyz.blueskyweb.app"), true);
  assert.equal(leftForeground({ appBundleId: "xyz.blueskyweb.app", state: "runningForeground", surface: "app" }, "xyz.blueskyweb.app"), false);
  // YakiHonne asks for notifications on launch: the prompt is Android's permission controller, not another app.
  assert.equal(leftForeground({ appBundleId: "com.google.android.permissioncontroller", state: "runningForeground", surface: "app" }, "com.yakihonne.yakihonne"), false);
  assert.equal(leftForeground({ appName: "Bluesky (xyz.blueskyweb.app)", appBundleId: "Bluesky (xyz.blueskyweb.app)" }, "xyz.blueskyweb.app"), false);
  assert.equal(leftForeground({}, "xyz.blueskyweb.app"), false);
});

test("an empty or volatile text node does not count toward screen identity", () => {
  const textView = { type: "android.widget.TextView", editable: false, clickable: false };
  const drawer = [{ ...textView, label: "Notes", depth: 11 }, { ...textView, label: "Starred", depth: 11 }];
  assert.equal(screenEvidenceKey(drawer), screenEvidenceKey([...drawer, { ...textView, label: "", depth: 12 }]));
  assert.equal(screenEvidenceKey(drawer), screenEvidenceKey([...drawer, { ...textView, label: "Synced 3 minutes ago", depth: 12 }]));
  assert.notEqual(screenEvidenceKey(drawer), screenEvidenceKey([...drawer, { type: "android.widget.Button", label: "", depth: 12 }]));
});

test("every digit in a label is masked for screen identity, so a clock tick or a counter does not create a screen", () => {
  const screen = time => [{ type: "Other", label: "root" }, { type: "StaticText", label: `Updated ${time}` }, { type: "StaticText", label: "Connection" }];
  assert.equal(screenEvidenceKey(screen("5:43")), screenEvidenceKey(screen("5:44")));
  assert.equal(screenEvidenceKey(screen("12 of 30")), screenEvidenceKey(screen("13 of 31")));
});

test("Android's static TextViews are text, not fields; an editable one is", async () => {
  const nodes = [{ type: "android.view.ViewGroup", rect: { x: 0, y: 0, width: 400, height: 800 } },
    { type: "android.widget.TextView", label: "Connection", editable: false, rect: { x: 10, y: 100, width: 200, height: 30 } },
    { type: "android.widget.EditText", label: "Device name", editable: true, rect: { x: 10, y: 200, width: 200, height: 40 } },
    { type: "android.widget.Button", label: "Save", rect: { x: 10, y: 300, width: 200, height: 40 } }];
  const { map } = await harness([["observe", { includeImage: true }], ["finish", { summary: "Roles." }]], {
    observe: async includeImage => ({ nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-roles", png: PNG } : {}) }) });
  assert.deepEqual(map.elements.map(element => [element.label, element.role, element.actions]), [["Device name", "field", ["fill"]], ["Save", "button", ["press"]]]);
});

test("a node another package drew is foreign to the app", () => {
  assert.equal(foreignNode({ type: "android.widget.TextView", label: "5:42", bundleId: "com.android.systemui" }, "dev.brent.euxy"), true);
  assert.equal(foreignNode({ type: "android.widget.TextView", label: "MIDI", bundleId: "dev.brent.euxy" }, "dev.brent.euxy"), false);
  assert.equal(foreignNode({ type: "StaticText", label: "MIDI" }, "dev.brent.euxy"), false);
  // A permission prompt's nodes are the screen while it is up, not the status bar.
  assert.equal(foreignNode({ type: "android.widget.Button", label: "Allow", bundleId: "com.google.android.permissioncontroller" }, "com.robosats"), false);
  assert.equal(foreignNode({ type: "android.widget.Button", label: "Allow", bundleId: "com.android.permissioncontroller" }, "com.robosats"), false);
  assert.equal(foreignNode({ type: "android.widget.TextView", label: "Gmail", bundleId: "com.google.android.apps.nexuslauncher" }, "com.robosats"), true);
  assert.equal(foreignNode({ type: "android.widget.TextView", label: '{"provider":"expo-router"}', identifier: "expo-explore-observer", bundleId: "dev.brent.euxy" }, "dev.brent.euxy"), true);
});

test("a screenshot that is one flat colour is recognised as capture-protected", async () => {
  const { solidColour } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const { PNG } = await import("pngjs");
  const solid = new PNG({ width: 40, height: 60 });
  solid.data.fill(0); for (let i = 3; i < solid.data.length; i += 4) solid.data[i] = 255;
  assert.equal(solidColour(PNG.sync.write(solid)), true);
  const mixed = new PNG({ width: 40, height: 60 });
  mixed.data.fill(0); for (let i = 3; i < mixed.data.length; i += 4) mixed.data[i] = 255;
  mixed.data[4 * 97 * 3] = 200;
  assert.equal(solidColour(PNG.sync.write(mixed)), false);
  assert.equal(solidColour(Buffer.from("not a png")), false);
});

test("an empty accessibility tree after an action is not a screen", async () => {
  let tapped = false; let observes = 0; let frames = 0;
  const { map, calls } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Settings" }],
    ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => { observes += 1; return { nodes: tapped ? [] : SCREENS.home, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}`.padStart(64, "a") } : {}) }; },
    act: async () => { tapped = true; } });
  assert.equal(map.screens.length, 1, "no card was minted out of an empty tree");
  assert.ok(map.screens.every(screen => !screen.id.startsWith("scr_e3b0c442")), "no screen keyed on the empty hash");
  const attempt = map.actionAttempts.find(item => item.action.kind === "press");
  assert.equal(attempt.outcome, "same-screen");
  assert.ok(calls.some(call => call.result.emptyTree), "the model is told why nothing new was recorded");
  assert.ok(observes >= 3, "the tree was read again before giving up");
});

test("a labelled Android ViewGroup (a Pressable) and a CheckedTextView are controls; their text children are not", () => {
  const row = (label, index) => ({ index, type: "android.view.ViewGroup", label, depth: 2, editable: false, enabled: true, parentIndex: 1 });
  const nodes = [
    { index: 0, type: "android.widget.FrameLayout", depth: 0, editable: false },
    { index: 1, type: "android.widget.ScrollView", depth: 1, editable: false, parentIndex: 0 },
    row("Networking", 2),
    { index: 3, type: "android.widget.TextView", label: "Networking", depth: 3, editable: false, parentIndex: 2 },
    row("Privacy", 4),
    { index: 5, type: "android.widget.TextView", label: "Privacy", depth: 3, editable: false, parentIndex: 4 },
    { index: 6, type: "android.widget.CheckedTextView", label: "Mainnet", identifier: "android:id/text1", depth: 2, editable: false, parentIndex: 1 },
    { index: 7, type: "android.view.ViewGroup", depth: 2, editable: false, parentIndex: 1 },
  ];
  assert.deepEqual(elementsOf(nodes, []).map(element => [element.role, element.label]), [
    ["other", "Networking"],
    ["other", "Privacy"],
    ["menu-item", "Mainnet"],
  ]);
});

test("an identifier several controls share is not offered as a selector", () => {
  const option = (label, index) => ({ index, type: "android.widget.CheckedTextView", label, identifier: "android:id/text1", depth: 2, editable: false, parentIndex: 0 });
  const nodes = [
    { index: 0, type: "android.widget.ListView", identifier: "app:id/select_dialog_listview", depth: 1, editable: false },
    option("Mainnet", 1), option("Testnet", 2), option("Mutinynet", 3),
    { index: 4, type: "android.widget.Button", label: "Cancel", identifier: "android:id/button2", depth: 2, editable: false, parentIndex: 0 },
  ];
  assert.deepEqual(elementsOf(nodes, []).map(element => [element.label, element.identifier]), [
    ["Mainnet", undefined], ["Testnet", undefined], ["Mutinynet", undefined], ["Cancel", "android:id/button2"],
  ]);
});

test("an Android Button with no text of its own is listed under its child TextView's caption", () => {
  const nodes = [
    { index: 0, type: "android.widget.FrameLayout", depth: 0, editable: false },
    { index: 1, type: "android.view.ViewGroup", depth: 1, editable: false, parentIndex: 0 },
    { index: 2, type: "android.widget.TextView", label: "Welcome to DevHub", depth: 2, editable: false, parentIndex: 1 },
    { index: 3, type: "android.widget.Button", depth: 2, editable: false, parentIndex: 1, rect: { x: 62, y: 996, width: 596, height: 103 } },
    { index: 4, type: "android.widget.TextView", label: "Sign in with GitHub", depth: 3, editable: false, parentIndex: 3 },
    { index: 5, type: "android.widget.Button", label: "Skip", depth: 2, editable: false, parentIndex: 1 },
    { index: 6, type: "android.widget.TextView", label: "Skip for now", depth: 3, editable: false, parentIndex: 5 },
  ];
  assert.deepEqual(elementsOf(nodes, []).map(element => [element.role, element.label]), [
    ["button", "Sign in with GitHub"],
    ["button", "Skip"],
  ]);
});

test("the tree after a scroll is the same screen further down, not a new one", async () => {
  let scrolled = false; let frames = 0;
  const lower = [...SCREENS.home.filter(node => !/Settings/.test(String(node.label ?? ""))),
    { type: "Button", label: "Learn more", enabled: true, hittable: true, rect: { x: 10, y: 700, width: 200, height: 40 } },
    { type: "StaticText", label: "Resources", rect: { x: 10, y: 660, width: 200, height: 30 } }];
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Sign in" }],
    ["act", { action: "scroll", direction: "down" }],
    ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: scrolled ? lower : SCREENS.home, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}` } : {}) }),
    act: async () => { scrolled = true; } });
  assert.equal(map.screens.length, 1, "scrolling did not mint a screen");
  assert.equal(map.actionAttempts.find(item => item.action.kind === "swipe").outcome, "same-screen");
  assert.ok(map.elements.some(element => element.screenId === map.screens[0].id && element.label === "Learn more"), "the rows the scroll revealed belong to the screen");
});

test("a list that has loaded more rows is the same screen", () => {
  const cell = depth => [{ type: "android.view.ViewGroup", depth }, { type: "android.view.ViewGroup", depth: depth + 1 }, { type: "android.widget.ImageView", depth: depth + 2 }];
  const header = [{ type: "android.widget.TextView", label: "#photography", depth: 10 }];
  const eight = [...header, ...Array.from({ length: 8 }, () => cell(20)).flat()];
  const seventeen = [...header, ...Array.from({ length: 17 }, () => cell(20)).flat()];
  assert.equal(screenEvidenceKey(eight), screenEvidenceKey(seventeen));
  assert.notEqual(screenEvidenceKey(eight), screenEvidenceKey([{ type: "android.widget.TextView", label: "#food", depth: 10 }, ...cell(20)]));
});

test("leaving the app with an empty tree on return does not mint a screen", async () => {
  let left = false; let frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "back" }],
    ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: left ? [] : SCREENS.home, capturedAt: new Date().toISOString(), ...(left ? { leftApp: true } : {}), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}` } : {}) }),
    act: async () => { left = true; } });
  assert.equal(map.screens.length, 1, "no card was minted after leaving the app");
  assert.equal(map.actionAttempts.find(item => item.action.kind === "back").outcome, "external");
});

test("a press agent-device refuses because the control's area belongs to its children is retried at its centre", async () => {
  const nodes = [{ type: "Other", label: "root", rect: { x: 0, y: 0, width: 400, height: 800 } },
    { type: "android.view.ViewGroup", identifier: "HeaderMenu", label: "Menu", rect: { x: 0, y: 40, width: 100, height: 60 } }];
  const pressed = [];
  const { calls, map } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", label: "Menu" }], ["finish", { summary: "Covered." }]], {
    observe: async includeImage => ({ nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-covered", png: PNG } : {}) }),
    act: async action => {
      pressed.push(action);
      if (!("frameId" in action)) throw new Error("press: Ref @e32 has no parent-owned touch point outside its interactive descendants");
    } });
  assert.equal(pressed.length, 2, "pressed by label, then by its centre");
  assert.ok("frameId" in pressed[1] && Math.abs(pressed[1].x - 50 / 400) < 0.01 && Math.abs(pressed[1].y - 70 / 800) < 0.01);
  assert.equal(calls[1].result.ok, true);
  assert.equal(map.actionAttempts[0].outcome, "same-screen");
  assert.equal(map.actionAttempts[0].error, undefined);
  assert.equal(map.actionAttempts[0].action.label, "Menu");
});

test("a press refused for a label that differs only by a typographic apostrophe is retried with the label agent-device names", async () => {
  const nodes = [{ type: "Other", label: "root", rect: { x: 0, y: 0, width: 400, height: 800 } },
    { type: "android.widget.Button", label: "Don\u2019t allow", rect: { x: 0, y: 40, width: 100, height: 60 } }];
  const pressed = [];
  const { calls, map } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", label: "Don't allow" }], ["finish", { summary: "Done." }]], {
    observe: async includeImage => ({ nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-prompt", png: PNG } : {}) }),
    act: async action => {
      pressed.push(action);
      if ("label" in action && action.label === "Don't allow") throw new Error('The requested UI control did not become available. The screen has a similar label: "Don\u2019t allow".');
    } });
  assert.equal(pressed.length, 2, "pressed by the typed label, then by the label agent-device named");
  assert.equal(pressed[1].label, "Don\u2019t allow");
  assert.equal(calls[1].result.ok, true);
  assert.equal(map.actionAttempts[0].error, undefined);
});

test("a bare Android View with a roleDescription is that control; a labelled hittable View is a control too", () => {
  const nodes = [
    { type: "android.view.View", label: "Feed", roleDescription: "Tab", hittable: true, enabled: true, rect: { x: 0, y: 0, width: 100, height: 40 } },
    { type: "android.view.View", label: "Open player", hittable: true, enabled: true, rect: { x: 0, y: 50, width: 100, height: 40 } },
    { type: "android.view.View", rect: { x: 0, y: 100, width: 100, height: 40 } },
  ];
  const elements = elementsOf(nodes, []);
  assert.deepEqual(elements.map(element => [element.label, element.role]), [["Feed", "tab"], ["Open player", "other"]]);
});

test("a spinner or a busy control does not make a screen a different screen", () => {
  const idle = [{ type: "android.widget.Button", label: "Sign Up", depth: 5 }, { type: "android.widget.Button", label: "Login", depth: 5 }];
  const busy = [{ type: "android.widget.Button", label: "busy", depth: 5 }, { type: "android.widget.Button", label: "Login", depth: 5 }];
  assert.notEqual(screenEvidenceKey(idle), screenEvidenceKey(busy), "a renamed button is still different evidence");
  const loaded = [{ type: "android.widget.TextView", label: "No follower activity yet", depth: 6 }, { type: "android.view.View", label: "Feed", roleDescription: "Tab", depth: 4 }];
  const loading = [{ type: "android.widget.ProgressBar", depth: 6 }, { type: "android.view.View", label: "Feed", roleDescription: "Tab", depth: 4 }];
  assert.equal(screenEvidenceKey(loading), screenEvidenceKey([{ type: "android.view.View", label: "Feed", roleDescription: "Tab", depth: 4 }]), "the spinner is not evidence");
  assert.notEqual(screenEvidenceKey(loading), screenEvidenceKey(loaded));
});

test("a tree with a spinner is given a moment to load before it counts as a screen", async () => {
  const loading = [{ type: "android.widget.ProgressBar", rect: { x: 100, y: 300, width: 40, height: 40 } }, { type: "Button", label: "Home", hittable: true }];
  const loaded = [{ type: "StaticText", label: "No follower activity yet" }, { type: "Button", label: "Home", hittable: true }, { type: "Button", label: "Global", hittable: true }];
  let observed = 0; let current = SCREENS.home;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", label: "Settings" }],
    ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { loadingSettleMs: 1, observe: async includeImage => { observed += 1; const nodes = current === "pulse" ? (observed > 3 ? loaded : loading) : SCREENS.home;
      return { nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${observed}`, png: PNG, imageSha256: `${observed}`.padStart(64, "b") } : {}) }; },
    act: async () => { current = "pulse"; } });
  assert.equal(map.screens.length, 2, "the loading placeholder is not a screen of its own");
  const pulse = map.screens.find(screen => screen.id !== map.screens[0].id);
  assert.ok(map.elements.some(element => element.screenId === pulse.id && element.label === "Global"), "the card has the loaded content");
});

test("a tree still loading is the screen whose evidence contains it, and the loaded tree that follows a loading-only screen is that screen", async () => {
  const welcome = [{ type: "Button", label: "Login", hittable: true, depth: 2 }, { type: "Button", label: "Sign Up", hittable: true, depth: 2 }, { type: "Button", label: "Skip for now", hittable: true, depth: 2 }];
  const welcomeBusy = [{ type: "Button", label: "Login", hittable: true, depth: 2 }, { type: "Button", label: "busy", hittable: true, depth: 2 }, { type: "Button", label: "Skip for now", hittable: true, depth: 2 }];
  const pulseLoading = [{ type: "Button", label: "Feed", hittable: true, depth: 3 }, { type: "android.widget.ProgressBar", depth: 4 }];
  const pulseLoaded = [{ type: "Button", label: "Feed", hittable: true, depth: 4 }, { type: "StaticText", label: "No follower activity yet", depth: 5 }];
  const trees = [welcome, welcomeBusy, pulseLoading, pulseLoaded];
  let step = -1;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Welcome" }],
    ["act", { action: "back" }], ["observe", { includeImage: true }],
    ["act", { action: "tap", label: "Skip for now" }], ["observe", { includeImage: true }],
    ["act", { action: "tap", label: "Feed" }], ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => { step = Math.min(step + 1, trees.length - 1); const nodes = trees[step];
      return { nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${step}`, png: PNG, imageSha256: `${step}`.padStart(64, "c") } : {}) }; } });
  assert.equal(map.screens.length, 2, "busy Welcome joined Welcome; the loaded Pulse joined the loading Pulse");
  assert.equal(map.actionAttempts[0].outcome, "same-screen");
  assert.ok(map.elements.some(element => element.screenId === map.screens[1].id && element.label === "Feed"));
});

test("an empty Android Button takes the caption that precedes it under the same parent (Expo Go)", () => {
  const nodes = [
    { index: 0, type: "android.widget.LinearLayout", depth: 8, rect: { x: 0, y: 0, width: 400, height: 60 } },
    { index: 1, parentIndex: 0, type: "android.widget.TextView", label: "OK", editable: false, depth: 9, rect: { x: 300, y: 10, width: 60, height: 40 } },
    { index: 2, parentIndex: 0, type: "android.widget.Button", label: "", depth: 9, enabled: true, rect: { x: 290, y: 0, width: 80, height: 60 } },
  ];
  const elements = elementsOf(nodes, []);
  assert.deepEqual(elements.map(element => [element.label, element.role]), [["OK", "button"]]);
});

test("a refused press whose label no extracted control carries is retried at the labelled node's centre", async () => {
  const nodes = [
    { type: "Other", label: "root", rect: { x: 0, y: 0, width: 400, height: 800 } },
    { type: "android.widget.TextView", label: "HELP", rect: { x: 300, y: 100, width: 80, height: 40 } },
  ];
  const pressed = [];
  const { map } = await harness(
    [["observe", { includeImage: true }], ["act", { action: "tap", label: "HELP" }], ["finish", { summary: "Covered." }]],
    { observe: async includeImage => ({ nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-help", png: PNG } : {}) }),
      act: async action => { pressed.push(action); if (!("frameId" in action)) throw new Error("press: Ref @e21 has no parent-owned touch point outside its interactive descendants"); } },
  );
  assert.equal(pressed.length, 2);
  assert.ok("frameId" in pressed[1] && Math.abs(pressed[1].x - 340 / 400) < 0.01 && Math.abs(pressed[1].y - 120 / 800) < 0.01);
  assert.equal(map.actionAttempts[0].error, undefined);
});

test("a text field's placeholder or typed text is not screen identity; the field is named by its accessibility label", () => {
  const home = (room, extra = {}) => [
    { index: 0, type: "android.widget.TextView", label: "Enter room name", editable: false, depth: 3 },
    { index: 1, type: "android.widget.EditText", label: room, value: room, placeholder: room, contentDescription: "Enter room name", editable: true, hintShowing: true, depth: 4, ...extra },
    { index: 2, type: "android.widget.Button", label: "Join", depth: 4 },
  ];
  // Jitsi suggests a new random room name on every visit.
  assert.equal(screenEvidenceKey(home("LivelyAssistantsCountlessSweetly")), screenEvidenceKey(home("ConstitutionalWorkersGrowSelfishly")));
  // Typing into the field does not make a new screen either.
  assert.equal(screenEvidenceKey(home("LivelyAssistantsCountlessSweetly")), screenEvidenceKey(home("standup", { placeholder: undefined, hintShowing: false })));
  assert.notEqual(screenEvidenceKey(home("standup")), screenEvidenceKey(home("standup").slice(0, 2)));
  const [field] = elementsOf(home("LivelyAssistantsCountlessSweetly"), []).filter(element => element.role === "field");
  assert.equal(field.label, "Enter room name");
  // Without an accessibility label the static placeholder names the control, but still does not identify the screen.
  const bare = { type: "android.widget.EditText", label: "Eg: John Doe", value: "Eg: John Doe", placeholder: "Eg: John Doe", editable: true, hintShowing: true };
  assert.equal(fieldName(bare), undefined);
  assert.equal(elementsOf([{ index: 0, ...bare }], [])[0].label, "Eg: John Doe");
  assert.equal(fieldName({ type: "XCUIElementTypeTextField", label: "Email", value: "brent@expo.dev" }), "Email");
});

test("a control's caption (child or sibling text) names it before its testID, as react-native-paper's default testIDs need", () => {
  const paper = [
    { index: 0, type: "android.view.ViewGroup", depth: 0 },
    { index: 1, parentIndex: 0, type: "android.widget.Button", identifier: "icon-button", depth: 1 },
    { index: 2, parentIndex: 1, type: "android.widget.TextView", label: "\u{f035c}", depth: 2, editable: false },
    { index: 3, parentIndex: 0, type: "android.view.ViewGroup", depth: 1 },
    { index: 4, parentIndex: 3, type: "android.widget.TextView", label: "Private key", identifier: "text-input-outlined-label-inactive", depth: 2, editable: false },
    { index: 5, parentIndex: 3, type: "android.widget.EditText", label: " ", value: " ", identifier: "text-input-outlined", editable: true, depth: 2 },
    { index: 6, parentIndex: 0, type: "android.widget.Button", identifier: "button", depth: 1 },
    { index: 7, parentIndex: 6, type: "android.widget.TextView", label: "Access", identifier: "button-text", depth: 2, editable: false },
    { index: 8, parentIndex: 0, type: "android.widget.Button", identifier: "button", depth: 1 },
    { index: 9, parentIndex: 8, type: "android.widget.TextView", label: "Create keys", identifier: "button-text", depth: 2, editable: false },
  ];
  const labels = elementsOf(paper, []).map(element => `${element.role}:${element.label}`);
  assert.deepEqual(labels, ["button:icon-button", "field:Private key", "button:Access", "button:Create keys"]);
});

test("a tree whose content sits one wrapper deeper is the same screen (RoboSats' welcome after back)", () => {
  const welcome = depth => [
    { type: "android.widget.TextView", label: "A Simple and Private LN P2P Exchange", depth, editable: false },
    { type: "android.widget.Button", label: "START", depth: depth + 1 },
    { type: "android.widget.Button", label: "RECOVERY", depth: depth + 1 },
  ];
  assert.equal(screenEvidenceKey(welcome(12)), screenEvidenceKey(welcome(13)));
  assert.notEqual(screenEvidenceKey(welcome(12)), screenEvidenceKey(welcome(12).slice(0, 2)));
});

test("a loading tree whose placeholder text differs from the loaded screen's still joins it (RoboSats' Robot Profile)", async () => {
  const chrome = [{ type: "android.widget.Button", label: "open menu drawer" }, { type: "android.widget.Button", label: "Robot Garage" }];
  const loaded = [...chrome, { type: "android.widget.TextView", label: "No existing orders found", editable: false }];
  const loading = [...chrome, { type: "android.widget.TextView", label: "Looking for orders!", editable: false }, { type: "android.widget.ProgressBar", label: "indeterminate" }];
  let current = loaded;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Robot Profile" }],
    ["act", { action: "tap", label: "Robot Garage" }], ["observe", { includeImage: true }], ["finish", { summary: "done" }],
  ], {
    observe: async includeImage => ({ nodes: current, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png: PNG, imageSha256: "b".repeat(64) } : {}) }),
    act: async () => { current = loading; },
  });
  assert.deepEqual(map.screens.map(screen => screen.title), ["Robot Profile"]);
});

test("a permission prompt is one screen across Android's two asks, titled by its question", () => {
  const prompt = deny => [
    { type: "android.widget.TextView", label: "Allow Robosats to send you notifications?", bundleId: "com.google.android.permissioncontroller", editable: false },
    { type: "android.widget.Button", label: "Allow", identifier: "com.android.permissioncontroller:id/permission_allow_button", bundleId: "com.google.android.permissioncontroller" },
    { type: "android.widget.Button", label: "Don’t allow", identifier: deny, bundleId: "com.google.android.permissioncontroller" },
  ];
  assert.equal(
    screenEvidenceKey(prompt("com.android.permissioncontroller:id/permission_deny_button")),
    screenEvidenceKey(prompt("com.android.permissioncontroller:id/permission_deny_and_dont_ask_again_button")));
  assert.equal(systemDialogTitle(prompt("x")), "Allow Robosats to send you notifications?");
  assert.equal(systemDialogTitle([{ type: "android.widget.TextView", label: "Welcome", editable: false }]), undefined);
});

test("a hittable bare ViewGroup with no label is the pressable, named by the text inside; a layout wrapping controls is not", () => {
  const key = (index, parentIndex, digit) => [
    { index, parentIndex, type: "android.view.ViewGroup", hittable: true, bundleId: "io.hexawallet.hexa2" },
    { index: index + 1, parentIndex: index, type: "android.widget.TextView", label: digit, value: digit, editable: false, bundleId: "io.hexawallet.hexa2" },
  ];
  const nodes = [
    { index: 0, type: "android.widget.ScrollView", hittable: true, bundleId: "io.hexawallet.hexa2" },
    { index: 1, parentIndex: 0, type: "android.view.ViewGroup", hittable: true, bundleId: "io.hexawallet.hexa2" },
    { index: 2, parentIndex: 1, type: "android.widget.TextView", label: "Please enter a passcode", editable: false, bundleId: "io.hexawallet.hexa2" },
    ...key(3, 1, "1"),
    ...key(5, 1, "2"),
    { index: 7, parentIndex: 1, type: "android.view.ViewGroup", hittable: true, bundleId: "io.hexawallet.hexa2" },
    { index: 8, parentIndex: 7, type: "android.widget.TextView", label: "\uf151", editable: false, bundleId: "io.hexawallet.hexa2" },
  ];
  const labels = elementsOf(nodes, []).map(element => `${element.role}:${element.label}`);
  assert.deepEqual(labels, ["other:1", "other:2"]);
});

test("a glyph-only or letterless text node is not screen identity (passcode dots, a caret)", () => {
  const screen = indicator => [
    { type: "android.widget.TextView", label: "Please enter a passcode", editable: false },
    { type: "android.widget.TextView", label: indicator, editable: false },
    { type: "android.view.ViewGroup", hittable: true },
    { type: "android.widget.TextView", label: "1", editable: false },
  ];
  assert.equal(screenEvidenceKey(screen("|")), screenEvidenceKey(screen("\uf111")));
  assert.equal(screenEvidenceKey(screen("|")), screenEvidenceKey([...screen("|"), { type: "android.widget.TextView", label: "\uf111\uf111", editable: false }]));
  assert.notEqual(screenEvidenceKey(screen("|")), screenEvidenceKey([...screen("|"), { type: "android.widget.TextView", label: "Proceed", editable: false }]));
});

test("a press agent-device cannot find because the label was composed from several texts inside the pressable is retried at its centre", async () => {
  const nodes = [{ type: "Other", label: "root", rect: { x: 0, y: 0, width: 400, height: 800 } },
    { index: 1, type: "android.view.ViewGroup", hittable: true, clickable: true, rect: { x: 0, y: 100, width: 400, height: 80 } },
    { index: 2, parentIndex: 1, type: "android.widget.TextView", label: "Account Management", editable: false, rect: { x: 20, y: 110, width: 200, height: 30 } },
    { index: 3, parentIndex: 1, type: "android.widget.TextView", label: "View and manage your accounts", editable: false, rect: { x: 20, y: 140, width: 300, height: 30 } }];
  const pressed = [];
  const { calls, map } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", label: "Account Management View and manage your accounts" }], ["finish", { summary: "Done." }]], {
    observe: async includeImage => ({ nodes, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-composed", png: PNG } : {}) }),
    act: async action => {
      pressed.push(action);
      if (!("frameId" in action)) throw new Error("The requested UI control did not become available and enabled within the setup budget.");
    } });
  assert.equal(pressed.length, 2, "pressed by label, then by its centre");
  assert.ok("frameId" in pressed[1] && Math.abs(pressed[1].x - 200 / 400) < 0.01 && Math.abs(pressed[1].y - 140 / 800) < 0.01);
  assert.equal(calls[1].result.ok, true);
  assert.equal(map.actionAttempts[0].error, undefined);
});

test("the same controls with a field focused (keyboard up, text that no longer fits dropped) are the screen in its editing state", async () => {
  const field = focused => ({ type: "android.widget.EditText", label: "Enter wallet name", editable: true, focused, rect: { x: 20, y: 200, width: 360, height: 48 } });
  const idle = [{ type: "android.widget.TextView", label: "New Wallet Creation", editable: false }, field(false), { type: "android.widget.TextView", label: "Note", editable: false },
    { type: "android.widget.TextView", label: "Wallet name is used in the messages you send.", editable: false }];
  const editing = [{ type: "android.widget.TextView", label: "New Wallet Creation", editable: false }, field(true)];
  let typing = false; let frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Name wallet" }],
    ["act", { action: "tap", label: "Enter wallet name" }],
    ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: typing ? editing : idle, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}` } : {}) }),
    act: async () => { typing = true; } });
  assert.equal(map.screens.length, 1, "focusing the field did not mint a screen");
  assert.equal(map.actionAttempts[0].outcome, "same-screen");
});

test("a tree read while a text node was still missing, photographed identically to a screen already seen, is that screen (AudioScape's playlist title)", async () => {
  const tabs = [{ type: "android.view.View", label: "Home", hittable: true, editable: false }, { type: "android.view.View", label: "Library", hittable: true, editable: false }];
  const titled = [{ type: "android.widget.TextView", label: "My Playlist", editable: false }, ...tabs];
  const untitled = [...tabs];
  const library = [{ type: "android.widget.TextView", label: "Library", editable: false }, { type: "android.view.View", label: "My Playlist", hittable: true, editable: false }, ...tabs];
  const PLAYLIST = Buffer.concat([PNG, Buffer.from([1])]);
  let visits = 0; let frames = 0; let where = "library";
  const trees = { library, titled, untitled };
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Library" }],
    ["act", { action: "tap", label: "My Playlist" }], ["observe", { includeImage: true }],
    ["act", { action: "back" }], ["observe", { includeImage: true }],
    ["act", { action: "tap", label: "My Playlist" }], ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: trees[where], capturedAt: new Date().toISOString(),
      ...(includeImage ? { frameId: `frame-${frames}`, png: where === "library" ? PNG : PLAYLIST, imageSha256: `${frames++}` } : {}) }),
    act: async action => { if (action.action === "back") where = "library"; else where = visits++ === 0 ? "titled" : "untitled"; } });
  assert.equal(map.screens.length, 2, "the second read of the playlist did not mint a screen");
  assert.equal(map.observations.filter(item => item.screenId === map.screens[1].id).length, 2, "both reads are observations of the one playlist screen");
  assert.equal(map.actionAttempts.filter(item => item.outcome === "transition").length, 3);
});

test("a coordinate tap the model describes is named by that description (MangaReader's header icons)", async () => {
  const home = [
    { type: "android.widget.FrameLayout", label: "", hittable: true, rect: { x: 0, y: 0, width: 412, height: 915 } },
    { type: "android.widget.Button", label: "\ue8b6", hittable: true, rect: { x: 340, y: 90, width: 48, height: 48 } },
    { type: "android.widget.TextView", label: "漫画收藏为空~", editable: false, rect: { x: 100, y: 500, width: 200, height: 30 } },
  ];
  let frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", frameId: "frame-0", x: 364 / 412, y: 114 / 915, target: "search icon in the header" }],
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-1", title: "Search" }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: frames > 0 ? SCREENS.settings : home, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}`.padStart(64, "c") } : {}) }),
    act: async () => {} });
  const attempt = map.actionAttempts.find(item => item.action.kind === "press");
  assert.equal(attempt.action.label, "search icon in the header");
  assert.equal(attempt.outcome, "transition", attempt.error);
});

test("a coordinate tap with no description on an icon-font button is named by what it is and where it sits", async () => {
  const home = [
    { type: "android.widget.FrameLayout", label: "", hittable: true, rect: { x: 0, y: 0, width: 412, height: 915 } },
    { type: "android.widget.Button", label: "\ue8b6", hittable: true, rect: { x: 340, y: 90, width: 48, height: 48 } },
    { type: "android.widget.TextView", label: "漫画收藏为空~", editable: false, rect: { x: 100, y: 500, width: 200, height: 30 } },
  ];
  let frames = 0;
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }],
    ["act", { action: "tap", frameId: "frame-0", x: 364 / 412, y: 114 / 915 }],
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-1", title: "Search" }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: frames > 0 ? SCREENS.settings : home, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: `frame-${frames}`, png: PNG, imageSha256: `${frames++}`.padStart(64, "d") } : {}) }),
    act: async () => {} });
  const attempt = map.actionAttempts.find(item => item.action.kind === "press");
  assert.equal(attempt.action.label, "icon button, top right");
});

test("with no --provider, model access falls through API keys and local logins to the first that passes preflight", async () => {
  const { preflightModelSession } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const tried = [];
  const working = "anthropic/local-login";
  const createSession = (config, { auth }) => ({ async preflight() {
    tried.push(`${config.provider}/${auth}`);
    if (`${config.provider}/${auth}` !== working) throw new Error(`${config.provider} ${auth} refused`);
  } });
  const said = [];
  const model = await preflightModelSession({ createSession }, { OPENAI_API_KEY: "key" }, message => said.push(message));
  assert.deepEqual(tried, ["openai/api-key", "anthropic/local-login"]);
  assert.equal(model.provider, "anthropic");
  assert.equal(model.auth, "local-login");
  assert.match(said.join("\n"), /openai API key unavailable \(openai api-key refused\)/);
});

test("an explicit --provider is the only model access tried, and its preflight error is the one reported", async () => {
  const { preflightModelSession } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const tried = [];
  const createSession = (config, { auth }) => ({ async preflight() { tried.push(`${config.provider}/${auth}`); throw new Error("refused"); } });
  await assert.rejects(preflightModelSession({ provider: "openai", createSession }, { ANTHROPIC_API_KEY: "key" }, () => {}), /refused/);
  assert.deepEqual(tried, ["openai/local-login"]);
});

test("when nothing passes preflight, the first failure is reported", async () => {
  const { preflightModelSession } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const createSession = (config, { auth }) => ({ async preflight() { throw new Error(`${config.provider} ${auth} refused`); } });
  await assert.rejects(preflightModelSession({ createSession }, {}, () => {}), /anthropic local-login refused/);
});

test("a landscape frame on a portrait panel (an opened iPhone Duo) is stored upright", async () => {
  const { createRequire } = await import("node:module");
  const { PNG: Png } = createRequire(import.meta.url)("pngjs");
  const raw = new Png({ width: 1, height: 2 });
  raw.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  const png = Png.sync.write(raw);
  const { map, root } = await harness([["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }], ["finish", { summary: "One." }]], {
    observe: async includeImage => ({ nodes: SCREENS.home, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png, width: 1, height: 2, landscape: true } : {}) }) });
  const artifact = map.artifacts.find(item => item.kind === "screenshot");
  assert.deepEqual([artifact.width, artifact.height], [2, 1]);
  const { readFile } = await import("node:fs/promises");
  const stored = Png.sync.read(await readFile(join(root, artifact.path)));
  // The panel's top (red) is the UI's right-hand side once turned a quarter clockwise.
  assert.deepEqual([...stored.data], [0, 0, 255, 255, 255, 0, 0, 255]);
});

/** A PNG of `width` × `height` RGBA pixels, each given as [r, g, b, a] row by row. */
async function pngOf(width, height, pixels) {
  const { createRequire } = await import("node:module");
  const { PNG: Png } = createRequire(import.meta.url)("pngjs");
  const image = new Png({ width, height });
  image.data.set(pixels.flat());
  return Png.sync.write(image);
}

test("an opened Duo's frame shows the same pixels as a screen already seen once turned, so it is that screen (AudioScape's playlist title, rotated)", async () => {
  const tabs = [{ type: "Button", label: "Home", hittable: true }, { type: "Button", label: "Library", hittable: true }];
  const library = [{ type: "StaticText", label: "Library" }, { type: "Button", label: "My Playlist", hittable: true }, ...tabs];
  const trees = { library, titled: [{ type: "StaticText", label: "My Playlist" }, ...tabs], untitled: [...tabs] };
  const images = { library: await pngOf(1, 2, [[255, 0, 0, 255], [0, 0, 255, 255]]), playlist: await pngOf(1, 2, [[0, 255, 0, 255], [0, 0, 255, 255]]) };
  let visits = 0; let frames = 0; let where = "library";
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Library" }],
    ["act", { action: "tap", label: "My Playlist" }], ["observe", { includeImage: true }],
    ["act", { action: "back" }], ["observe", { includeImage: true }],
    ["act", { action: "tap", label: "My Playlist" }], ["observe", { includeImage: true }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: trees[where], capturedAt: new Date().toISOString(),
      ...(includeImage ? { frameId: `frame-${frames++}`, png: Buffer.from(images[where === "library" ? "library" : "playlist"]), width: 1, height: 2, landscape: true } : {}) }),
    act: async action => { if (action.action === "back") where = "library"; else where = visits++ === 0 ? "titled" : "untitled"; } });
  assert.equal(map.screens.length, 2, "the second read of the playlist did not mint a screen");
  assert.equal(map.observations.filter(item => item.screenId === map.screens[1].id).length, 2, "both reads are observations of the one playlist screen");
  assert.equal(map.artifacts.filter(item => item.kind === "screenshot").length, 2);
});

test("a coordinate tap on an opened Duo is named by where it shows in the upright screenshot", async () => {
  // The inner panel's portrait axes: a button near the portrait top right is at the upright bottom right.
  const home = [
    { type: "Application", label: "", rect: { x: 0, y: 0, width: 669, height: 951 } },
    { type: "Button", label: "", hittable: true, rect: { x: 600, y: 40, width: 44, height: 44 } },
  ];
  let frames = 0; let tapped = false;
  // The look without an image carries no landscape flag; the screen's stored screenshot still says it was turned.
  const { map } = await harness([
    ["observe", { includeImage: true }], ["capture", { frameId: "frame-0", title: "Home" }], ["observe", { includeImage: false }],
    ["act", { action: "tap", frameId: "frame-0", x: 622 / 669, y: 62 / 951 }],
    ["finish", { summary: "Done." }],
  ], { observe: async includeImage => ({ nodes: tapped ? SCREENS.settings : home, capturedAt: new Date().toISOString(),
      ...(includeImage ? { frameId: `frame-${frames++}`, png: await pngOf(1, 2, [[255, 0, 0, 255], [0, 0, 255, 255]]), width: 1, height: 2, landscape: true } : {}) }),
    act: async () => { tapped = true; } });
  assert.equal(map.actionAttempts.find(item => item.action.kind === "press").action.label, "icon button, bottom right");
  assert.deepEqual(map.artifacts.find(item => item.kind === "screenshot").turned, { width: 669, height: 951 });
});

test("turnedClockwise puts the portrait top on the right and keeps the colour chunks", async () => {
  const { turnedClockwise, assertDecodedPng } = await tsImport("../../src/shared/png-evidence.ts", import.meta.url);
  const { createRequire } = await import("node:module");
  const { PNG: Png } = createRequire(import.meta.url)("pngjs");
  const { crc32 } = await import("node:zlib");
  // 3 wide and 2 tall; each pixel's red is its index, so where it lands says where it came from.
  const plain = await pngOf(3, 2, [0, 1, 2, 3, 4, 5].map(index => [index * 40, 0, 0, 255]));
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const gamma = Buffer.alloc(4); gamma.writeUInt32BE(45455);
  const source = Buffer.concat([plain.subarray(0, 33), chunk("sRGB", Buffer.from([0])), chunk("gAMA", gamma), plain.subarray(33)]);
  const turned = turnedClockwise(source);
  assertDecodedPng(turned, "Turned");
  const decoded = Png.sync.read(turned);
  assert.deepEqual([decoded.width, decoded.height], [2, 3]);
  // Source (x, y) lands at (height - 1 - y, x): the top row (0, 1, 2) runs down the right-hand column.
  const red = [...Array(6).keys()].map(index => decoded.data[index * 4] / 40);
  assert.deepEqual(red, [3, 0, 4, 1, 5, 2]);
  const types = [];
  for (let offset = 8; offset < turned.length; offset += 12 + turned.readUInt32BE(offset)) types.push(turned.toString("latin1", offset + 4, offset + 8));
  assert.deepEqual(types.slice(0, 3), ["IHDR", "sRGB", "gAMA"]);
  assert.ok(turned.includes(gamma), "the gamma is the source's");
});

test("only an opened Duo's frame on its inner panel's portrait axes is turned upright", () => {
  const { duoScreenshotTurn } = tsRun;
  const root = (width, height) => ({ type: "Application", label: "Expo Go", rect: { x: 0, y: 0, width, height } });
  const frame = (deviceModel, nodes, width, height, platform = "ios") => duoScreenshotTurn({ platform, deviceModel, nodes, width, height });
  const cases = [
    ["Duo open", frame("iPhone Duo", [root(669, 951)], 2007, 2853), "turn"],
    ["Duo half-open", frame("iPhone Duo", [root(669, 951), { type: "Button", label: "Home", rect: { x: 20, y: 40, width: 44, height: 44 } }], 2007, 2853), "turn"],
    ["Duo closed", frame("iPhone Duo", [root(466, 678)], 1398, 2034), "keep"],
    ["iPhone 17 Pro", frame("iPhone 17 Pro", [root(402, 874)], 1206, 2622), "keep"],
    ["an iPhone in landscape", frame("iPhone 17 Pro", [root(874, 402)], 2622, 1206), "keep"],
    ["iPad", frame("iPad Pro 13-inch (M5)", [root(1032, 1376)], 2064, 2752), "keep"],
    ["Android", frame("Pixel 9", [root(669, 951)], 2007, 2853, "android"), "keep"],
    ["an empty tree", frame("iPhone Duo", [], 2007, 2853), "keep"],
    ["a first node that isn't the Application", frame("iPhone Duo", [{ type: "Window", rect: { x: 0, y: 0, width: 300, height: 200 } }, root(669, 951)], 2007, 2853), "turn"],
    ["a root off by a fraction of a point", frame("iPhone Duo", [root(669.33, 951)], 2008, 2853), "turn"],
    ["an already-landscape image", frame("iPhone Duo", [root(669, 951)], 2853, 2007), "keep"],
    ["the inner panel on its own axes", frame("iPhone Duo", [root(951, 669)], 2853, 2007), "keep"],
    ["a Duo root on neither panel", frame("iPhone Duo", [root(700, 1000)], 2100, 3000), "unmatched"],
    ["a Duo root the image does not show", frame("iPhone Duo", [root(669, 951)], 2000, 2000), "unmatched"],
  ];
  for (const [name, actual, expected] of cases) assert.equal(actual, expected, name);
});

test("the agent API lists a turned screenshot's element bounds on its upright axes", async () => {
  const { agentApiReply } = await tsImport("../../src/report/agent-api.ts", import.meta.url);
  const sha = "a".repeat(64);
  const map = { screens: [{ id: "scr_home", title: "Home", observationIds: ["obs_1"] }], observations: [{ id: "obs_1", screenshotArtifactId: "art_1" }],
    artifacts: [{ id: "art_1", kind: "screenshot", sha256: sha, width: 2853, height: 2007, turned: { width: 669, height: 951 } }],
    elements: [{ id: "el_1", screenId: "scr_home", label: "Settings", role: "button", bounds: { x: 600, y: 40, width: 44, height: 30, unit: "points" } }], transitions: [], variants: [], gaps: [] };
  const loaded = { kind: "exploration", file: "exploration.json", raw: new Uint8Array(), json: { map }, entries: new Map(), read: async () => undefined };
  const reply = await agentApiReply({ pageUrl: "https://example.test/p/token", platforms: ["ios"], expiresAt: null }, loaded, "/screens/scr_home", new URLSearchParams(), "application/json");
  const body = JSON.parse(await new Response(reply.body).text());
  // Portrait (600, 40) on a 951-point-tall screen shows at (951 - 40 - 30, 600) upright, near the bottom right.
  assert.deepEqual(body.elements[0].bounds, { x: 881, y: 600, width: 30, height: 44, unit: "points" });
});

const { assertReplayFits, createReplaySession, parseReplayPlan, replaySetup } = await tsImport("../../src/binary/replay.ts", import.meta.url);

function replayDevice(screens = SCREENS) {
  let screen = "home", frames = 0;
  const acted = [];
  return { acted, options: {
    observe: async includeImage => ({ nodes: screens[screen], capturedAt: new Date().toISOString(),
      ...(includeImage ? { frameId: `replay-${++frames}`, png: PNG, imageSha256: `${frames}`.padStart(64, "b") } : {}) }),
    act: async action => {
      acted.push(action);
      if (action.label === "Missing" || action.label === "Nowhere") throw new Error(`No element labelled ${action.label}`);
      if (action.action === "tap" && action.label === "Settings") screen = "settings";
      if (action.action === "tap" && action.label === "Dark mode" && screens.settingsDark) screen = "settingsDark";
      if (action.action === "back") screen = "home";
    },
  } };
}

test("a replay plan takes the same steps on each run: platform-only steps are skipped, optional failures are passed over and listed", async () => {
  const plan = parseReplayPlan({ steps: [
    { capture: "Home" },
    { action: "tap", label: "Missing", optional: true },
    { action: "tap", label: "Android only", platforms: ["android"] },
    { action: "tap", label: "Settings" }, { capture: "Settings" },
    { action: "tap", label: "Dark mode" }, { capture: "Settings", state: "dark" },
    { action: "back" },
  ] });
  const device = replayDevice();
  const { result, map } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options });
  assert.equal(result.stopReason, "finished");
  assert.match(result.summary, /Every planned screen was captured\. Optional steps skipped because they failed: step 2 \(tap "Missing"\)\.$/);
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home", "Settings"]);
  assert.ok(!device.acted.some(action => action.label === "Android only"));
  assert.ok(map.variants.some(variant => variant.name === "dark"), "the dark state is recorded as a variant");
});

test("a failed replay step stops the run, keeps what was captured, and names the screens it did not reach", async () => {
  const plan = parseReplayPlan({ steps: [
    { capture: "Home" }, { action: "tap", label: "Settings" }, { capture: "Settings" }, { action: "back" },
    { action: "tap", label: "Nowhere" }, { capture: "Never" }, { capture: "Android screen", platforms: ["android"] },
  ] });
  const device = replayDevice();
  const { result, map } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options });
  assert.equal(result.stopReason, "blocked");
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home", "Settings"]);
  assert.match(result.summary, /Replay step 5 \(tap "Nowhere"\) failed: .*No element labelled Nowhere.*Not captured: Never$/);
});

test("a blocked step names the screens still ahead before earlier misses, within stop_blocked's limit", async () => {
  const plan = parseReplayPlan({ steps: [
    { capture: "Home" },
    ...Array.from({ length: 20 }, (_, index) => ({ capture: `Earlier miss ${index} ${"x".repeat(60)}` })),
    { action: "tap", label: "Nowhere" },
    { capture: "Ahead" },
  ] });
  const device = replayDevice();
  const { result } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options, maxTurns: 100 });
  assert.equal(result.stopReason, "blocked");
  assert.ok(result.summary.length <= 1000, `${result.summary.length} characters`);
  assert.match(result.summary, /Not captured: Ahead, Earlier miss 0 .* and \d+ more$/);
});

test("a destructive or app-leaving tap in a replay plan is refused, as a model's would be", async () => {
  const plan = parseReplayPlan({ steps: [
    { capture: "Home" }, { action: "tap", label: "Share", optional: true }, { action: "tap", label: "Delete account" }, { capture: "Gone" },
  ] });
  const device = replayDevice();
  const { result, map } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options });
  assert.equal(result.stopReason, "blocked");
  assert.match(result.summary, /^Replay step 3 \(tap "Delete account"\) failed: "Delete account" looks destructive.*Not captured: Gone$/);
  assert.deepEqual(device.acted, [], "neither tap reaches the device");
  assert.deepEqual(map.actionAttempts.map(attempt => [attempt.action.label, attempt.outcome]), [["Share", "blocked"], ["Delete account", "blocked"]]);
});

test("a replay plan is checked before any device starts: unknown, hostile and malformed fields are refused", () => {
  const refused = (step, pattern) => assert.throws(() => parseReplayPlan({ steps: [step] }), error => error.code === "REPLAY_PLAN_INVALID" && pattern.test(error.message), JSON.stringify(step));
  assert.throws(() => parseReplayPlan({ steps: [] }), /no steps/);
  assert.throws(() => parseReplayPlan({ steps: [{ capture: "Home" }], step: [] }), /field "step" it does not take/);
  refused({ action: "tap" }, /exactly one of label or identifier/);
  refused({ action: "swipe" }, /needs a capture title or an action/);
  refused({ action: "constructor" }, /needs a capture title or an action/);
  refused({ capture: "Home", platforms: ["web"] }, /platforms must list ios and\/or android/);
  // A coordinate tap's fields would turn a label tap into a tap whose risk comes from `target`.
  refused({ action: "tap", label: "Delete account", frameId: "frame-1", x: 0.2, y: 0.15, target: "Next" }, /^Step 1 \(tap\) has a field "frameId" it does not take; a tap step takes action, label, identifier, platforms, optional\.$/);
  refused({ action: "tap", label: "Next", platform: ["ios"] }, /field "platform"/);
  refused({ action: "tap", label: "Next", optinal: true }, /field "optinal"/);
  refused({ capture: "Home", optional: true }, /\(capture\) has a field "optional"/);
  refused({ capture: "Home", action: "tap", label: "Next" }, /\(capture\) has a field "action"/);
  refused({ action: "back", label: "Back" }, /\(back\) has a field "label"/);
  refused({ action: "scroll", direction: ["up"] }, /scroll needs a direction/);
  refused({ action: "scroll", direction: "sideways" }, /scroll needs a direction/);
  refused({ action: "tap", label: "x".repeat(257) }, /label must be 1–256 characters without control characters/);
  refused({ action: "tap", identifier: "row\nnext" }, /identifier must be 1–256 characters/);
  refused({ action: "fill", label: "Name", text: "two\nlines" }, /fill needs text: one line/);
  refused({ action: "type", text: "x".repeat(2001) }, /type needs text/);
  refused({ action: "type", text: "{{secret:lowercase}}" }, /invalid secret reference/);
  refused({ action: "type", text: "{{secret:OPENAI_API_KEY}}" }, /cannot reference provider/);
  refused({ action: "wait", milliseconds: 15_001 }, /between 1 and 15000/);
  assert.deepEqual(parseReplayPlan({ steps: [{ capture: "Home" }] }).steps, [{ capture: "Home" }]);
  assert.deepEqual(parseReplayPlan({ steps: [{ action: "scroll", direction: "down", optional: true, platforms: ["ios"] }] }).steps,
    [{ action: "scroll", direction: "down", platforms: ["ios"], optional: true }]);
});

test("a replay plan with no steps for the platform, or more than the budgets hold, is refused before any device starts", () => {
  const limits = { maxScreens: 40, maxActions: 150, maxTurns: 400 };
  assert.throws(() => assertReplayFits(parseReplayPlan({ steps: [{ capture: "Home", platforms: ["android"] }, { action: "back", platforms: ["android"] }] }), "ios", limits),
    error => error.code === "REPLAY_PLAN_EMPTY" && /No step of the replay plan runs on ios/.test(error.message));
  const plan = parseReplayPlan({ steps: [{ capture: "Home" }, { action: "tap", label: "Settings" }, { capture: "Settings" }, { action: "back" }, { action: "wait", milliseconds: 100 }] });
  assert.doesNotThrow(() => assertReplayFits(plan, "ios", limits));
  assert.throws(() => assertReplayFits(plan, "ios", { ...limits, maxScreens: 2, maxActions: 1 }),
    error => error.code === "REPLAY_PLAN_OVER_BUDGET" && /2 captures, which need a screen budget of at least 3 \(it is 2\) and 2 actions, more than the action budget of 1/.test(error.message)
      && /--max-screens 3 --max-actions 2/.test(error.nextAction));
  assert.throws(() => assertReplayFits(plan, "ios", { ...limits, maxTurns: 8 }), /takes 9 tool calls, more than the 8/);
});

test("a replay that runs out of budget names the planned screens it did not reach in the gap", async () => {
  const plan = parseReplayPlan({ steps: [{ capture: "Home" }, { action: "tap", label: "Settings" }, { capture: "Settings" }, { action: "back" }, { capture: "Later" }] });
  const device = replayDevice();
  const session = createReplaySession(plan, "ios");
  const { result, map } = await harness([], { session, budgetNote: session.budgetNote, ...device.options, maxScreens: 2 });
  assert.equal(result.stopReason, "budget-screens");
  assert.match(map.gaps.at(-1).message, /^The exploration stopped at its screens budget with \d+ controls unexplored\. Not captured: Settings, Later\.$/);
});

test("a capture of a screen the plan already captured under another title is reported and does not rename it", async () => {
  const plan = parseReplayPlan({ steps: [
    { capture: "Home" }, { capture: "Start" }, { capture: "home" }, { action: "tap", label: "Settings" }, { action: "back" },
  ] });
  const device = replayDevice();
  const { result, map } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options });
  assert.equal(result.stopReason, "finished");
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home", "Home → Settings"]);
  assert.match(result.summary, /Not captured: Start \(looked the same as Home\)\. Also reached, not in the plan: 1 unnamed screen\.$/);
});

test("a planned state that the explorer merges into an earlier screen is neither reported as unplanned nor left in the map", async () => {
  // The README's own example: Dark mode changes the tree, and the capture titled Settings folds that new screen into Settings.
  const screens = { ...SCREENS, settingsDark: [...SCREENS.settings, { type: "Button", label: "Theme options" }] };
  const plan = parseReplayPlan({ steps: [
    { capture: "Home" }, { action: "tap", label: "Settings" }, { capture: "Settings" },
    { action: "tap", label: "Dark mode" }, { capture: "Settings", state: "dark" },
  ] });
  const device = replayDevice(screens);
  const { result, map } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options });
  assert.equal(result.stopReason, "finished");
  assert.deepEqual(map.screens.map(screen => screen.title), ["Home", "Settings"]);
  const settings = map.screens.find(screen => screen.title === "Settings");
  assert.ok(map.variants.some(variant => variant.screenId === settings.id && variant.name === "dark"));
  assert.equal(result.summary, "Replayed 5 planned steps on ios. Every planned screen was captured.");
});

test("a long replay summary is kept within finish's limit, the most useful names first", async () => {
  const titles = Array.from({ length: 60 }, (_, index) => `Planned screen ${String(index).padStart(2, "0")} ${"y".repeat(60)}`);
  const plan = parseReplayPlan({ steps: [{ capture: "Home" }, ...titles.map(title => ({ capture: title }))] });
  const device = replayDevice();
  const { result } = await harness([], { session: createReplaySession(plan, "ios"), ...device.options, maxTurns: 200 });
  assert.equal(result.stopReason, "finished");
  assert.ok(result.summary.length <= 4000, `${result.summary.length} characters`);
  assert.match(result.summary, /^Replayed 61 planned steps on ios\. Not captured: Planned screen 00 y+ \(looked the same as Home\), .* and \d+ more\.$/);
});

test("a refused finish ends the replay with stop_blocked instead of a turn budget, and a refused stop is an error", async () => {
  const plan = parseReplayPlan({ steps: [{ action: "back" }] });
  const calls = [];
  const request = refuse => ({ signal: new AbortController().signal, callTool: async (name, input) => {
    calls.push({ name, input });
    const value = name === "get_progress" ? { captured: [] } : refuse.includes(name) ? { ok: false, code: "AGENT_ACTION_INVALID", message: `${name} refused` } : { ok: true };
    return { content: [{ type: "text", text: JSON.stringify(value) }], ...(refuse.includes(name) ? { isError: true } : {}) };
  } });
  await createReplaySession(plan, "ios").run(request(["finish"]));
  assert.deepEqual(calls.map(call => call.name), ["act", "get_progress", "finish", "stop_blocked"]);
  assert.match(calls.at(-1).input.reason, /^The replay could not finish \(finish refused\)\. Replayed 1 planned steps on ios\./);
  await assert.rejects(createReplaySession(plan, "ios").run(request(["finish", "stop_blocked"])), { code: "REPLAY_STOP_REFUSED" });
});

test("a replay plan's {{secret:NAME}} inputs are read before any device starts and typed for the plan", async () => {
  const { runBinaryExploration, runSessionExploration } = await tsImport("../../src/binary/run.ts", import.meta.url);
  const { createExplorationInputs } = await tsImport("../../src/config/exploration-inputs.ts", import.meta.url);
  const plan = parseReplayPlan({ steps: [{ capture: "Home" }, { action: "fill", label: "Password", text: "{{secret:APP_TEST_PASSWORD}}" }] });
  const output = await mkdtemp(join(tmpdir(), "explore-replay-"));
  for (const run of [runBinaryExploration, runSessionExploration]) {
    await assert.rejects(run({ archive: join(output, "missing.apk"), output, replay: plan, environment: {} }),
      error => error.code === "EXPLORATION_SECRET_MISSING" && /APP_TEST_PASSWORD/.test(error.message));
    await assert.rejects(run({ archive: join(output, "missing.apk"), output, replay: plan, environment: {}, provider: "openai", hints: "Look around" }),
      error => error.code === "REPLAY_OPTIONS_IGNORED" && /--provider and --hints would do nothing/.test(error.message));
    await assert.rejects(run({ archive: join(output, "missing.apk"), output, replay: { steps: [{ action: "tap", label: "Next", optinal: true }] }, environment: {} }), { code: "REPLAY_PLAN_INVALID" });
    await assert.rejects(run({ archive: join(output, "missing.apk"), output, replay: parseReplayPlan({ steps: [{ action: "open", url: "https://example.com" }] }), environment: {} }),
      error => error.code === "REPLAY_PLAN_INVALID" && /^Step 1: https: URLs leave the app/.test(error.message));
  }
  const device = replayDevice();
  const inputs = createExplorationInputs({ setup: replaySetup(plan), environment: { APP_TEST_PASSWORD: "hunter2-test" } });
  const { result, map } = await harness([], { session: createReplaySession(plan, "ios"), inputs, ...device.options });
  assert.equal(result.stopReason, "finished");
  assert.deepEqual(device.acted, [{ action: "fill", label: "Password", text: "hunter2-test" }]);
  assert.equal(map.actionAttempts[0].action.input.value, "{{secret:APP_TEST_PASSWORD}}");
  assert.ok(!JSON.stringify(map).includes("hunter2-test"));
});

test("risk words are found inside identifiers that join them", async () => {
  const { riskOf } = await tsImport("../../src/binary/explorer.ts", import.meta.url);
  for (const label of ["btn_delete", "deleteAccount", "sign-out", "logOutButton", "settings.reset"]) assert.equal(riskOf(label, []), "destructive", label);
  assert.equal(riskOf("openInSafari", []), "external");
  for (const label of ["postsTab", "settings_button", "Profile", "MapView"]) assert.equal(riskOf(label, []), "safe", label);
  assert.equal(riskOf("resetFilters", ["resetFilters"]), "safe", "an allowed identifier");
});

/**
 * A screen whose only control is a hittable custom view the map does not record as a control (type Other, as many
 * custom pressables are): its risk is in its own label and identifier.
 */
function iconScreen(icon) {
  return [{ type: "Window", rect: { x: 0, y: 0, width: 400, height: 800 } }, { type: "StaticText", label: "Inbox" },
    { type: "Other", hittable: true, rect: { x: 340, y: 40, width: 44, height: 44 }, ...icon }];
}

test("a coordinate tap is judged by the control under the point, whatever the model calls it", async () => {
  for (const icon of [{ identifier: "btn_delete" }, { label: "Delete conversation" }]) {
    const { calls, acted, map } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", frameId: "frame-0", x: 0.9, y: 0.075, target: "Profile" }], ["finish", { summary: "x" }]],
      { observe: async includeImage => ({ nodes: iconScreen(icon), capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png: PNG, imageSha256: "d".repeat(64) } : {}) }) });
    assert.equal(acted.length, 0, JSON.stringify(icon));
    assert.equal(calls[1].result.blocked, true);
    assert.match(calls[1].result.reason, /looks destructive.*--allow-destructive/);
    assert.equal(map.actionAttempts.at(-1).risk, "destructive");
  }
});

test("a coordinate tap on a control allowed by its label goes through, even when its identifier reads as risky", async () => {
  const { acted } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", frameId: "frame-0", x: 0.9, y: 0.075 }], ["finish", { summary: "x" }]],
    { allowDestructive: ["Reset filters"],
      observe: async includeImage => ({ nodes: iconScreen({ label: "Reset filters", identifier: "resetFilters" }), capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png: PNG, imageSha256: "d".repeat(64) } : {}) }) });
  assert.equal(acted.length, 1);
});

test("a coordinate tap with no control under the point is still recorded as unknown, not refused", async () => {
  const { acted, map } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", frameId: "frame-0", x: 0.5, y: 0.5 }], ["finish", { summary: "x" }]],
    { observe: async includeImage => ({ nodes: iconScreen({ identifier: "btn_delete" }), capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png: PNG, imageSha256: "d".repeat(64) } : {}) }) });
  assert.equal(acted.length, 1);
  assert.equal(map.actionAttempts.at(-1).risk, "unknown");
});

test("a tap by identifier on a control allowed by its label goes through", async () => {
  const screen = [{ type: "StaticText", label: "Filters" }, { type: "Button", label: "Reset filters", identifier: "resetFilters" }];
  const { acted } = await harness([["observe", { includeImage: true }], ["act", { action: "tap", identifier: "resetFilters" }], ["finish", { summary: "x" }]],
    { allowDestructive: ["Reset filters"], observe: async includeImage => ({ nodes: screen, capturedAt: new Date().toISOString(), ...(includeImage ? { frameId: "frame-0", png: PNG, imageSha256: "e".repeat(64) } : {}) }) });
  assert.equal(acted.length, 1);
});
