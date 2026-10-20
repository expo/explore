import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { PNG } = await import("pngjs");
const { ArgentCallError, describedButton, findOpenButton, iosRuntimeVersion, openInAppPromptShowing, parseCommand, runBridgeCommand, snapshotFromTree } = await tsImport("../../src/capture/argent-driver.ts", import.meta.url);

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/argent-0.29/${name}`, import.meta.url), "utf8"));
const IOS_HOME = fixture("fixture-ios-ui-tree-home.json");
const IOS_RENAME = fixture("fixture-ios-ui-tree-rename.json");
const ANDROID_HOME = fixture("fixture-android-ui-tree-home.json");
const ANDROID_RENAME = fixture("fixture-android-ui-tree-rename.json");
const IOS_DEVICES = fixture("list-devices.out");
// iOS 27.1 on iPhone Duo: the link prompt is up, SpringBoard is in front, and alertVisible is false.
const DUO_PROMPT = fixture("fixture-ios27-duo-open-prompt-ui-tree.json");
const DUO_PROMPT_DESCRIBE = fixture("fixture-ios27-duo-open-prompt-describe.json");
const DUO_HOME = fixture("fixture-ios27-duo-home-ui-tree.json");
// iPhone Duo opened (the inner display), Edit Lane sheet up: Argent reports the app root as the screen's top-left third.
const DUO_OPEN_EDIT_LANE = fixture("fixture-ios27-duo-open-edit-lane-ui-tree.json");
const DUO_DEVICES = { devices: [{ platform: "ios", udid: "74195B53-4DBC-4EAA-9991-F98E5BB86BA8", name: "iPhone Duo", state: "Booted", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-1", runtimeKind: "mobile" }] };
const ANDROID_DEVICES = { devices: [{ platform: "android", serial: "emulator-5554", state: "device", isEmulator: true, model: "sdk_gphone64_x86_64", avdName: "pixel_7", sdkLevel: 36, runtimeKind: "mobile" }], avds: [] };
const BUNDLE = "dev.brent.euxy";
const UDID = "404F2659-7202-4450-8465-912BD2AB744B";

/** A scripted tool-server: each tool answers from `answers` (a value, a function of the args, or a queue of either). */
function harness(platform, answers, options = {}) {
  const calls = [];
  const moves = [];
  const queues = Object.fromEntries(Object.entries(answers).map(([tool, answer]) => [tool, Array.isArray(answer) ? [...answer] : answer]));
  const context = {
    platform, version: "0.29.0", state: options.state ?? { generation: 0 }, ...(options.bundleId ? { bundleId: options.bundleId } : {}),
    sleep: async () => {},
    reachable: async () => options.reachable ?? true,
    moveFile: async (from, to) => { moves.push([from, to]); },
    call: async (tool, args, callOptions) => {
      calls.push({ tool, args, ...(callOptions ? { options: callOptions } : {}) });
      let answer = queues[tool];
      if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
      if (answer === undefined) throw new Error(`unexpected tool ${tool}`);
      const value = typeof answer === "function" ? answer(args) : answer;
      if (value instanceof Error) throw value;
      return structuredClone(value);
    },
  };
  return { calls, moves, context, run: argv => runBridgeCommand(argv, context).then(result => ({ ...result, json: result.stdout.trim().startsWith("{") ? JSON.parse(result.stdout) : result.stdout })) };
}

const flags = (platform, extra = []) => [...extra, "--session", "expo-explore-runtime", ...(platform === "ios" ? ["--device", "iPhone 17"] : []), "--platform", platform, "--json"];
const flatten = tree => { const out = []; const walk = node => { out.push(node); (node.children ?? []).forEach(walk); }; (tree.roots ?? []).forEach(walk); return out; };

test("parseCommand separates agent-device's trailing flags from positionals and keeps text after --", () => {
  assert.deepEqual(parseCommand(["e3", "--session", "s", "--device", "iPhone 17", "--platform", "ios", "--json", "--", "-h", "--json"]),
    { positional: ["e3", "-h", "--json"], flags: { session: "s", device: "iPhone 17", platform: "ios", json: true } });
});

test("iosRuntimeVersion reads the OS version from a CoreSimulator runtime id", () => {
  assert.equal(iosRuntimeVersion("com.apple.CoreSimulator.SimRuntime.iOS-26-5"), "26.5");
  assert.equal(iosRuntimeVersion("com.apple.CoreSimulator.SimRuntime.iOS-18-0-1"), "18.0.1");
  assert.equal(iosRuntimeVersion("com.apple.CoreSimulator.SimRuntime.tvOS-26-5"), undefined);
});

test("--version answers with the pinned Argent version without calling Argent", async () => {
  const { run, calls } = harness("ios", {});
  assert.equal((await run(["--version"])).stdout, "0.29.0\n");
  assert.equal(calls.length, 0);
});

test("an iOS snapshot is agent-device's shape: points, the app root, the observer, and no duplicate nodes", () => {
  const { nodes, refs, screen } = snapshotFromTree(IOS_HOME, "ios", 1, BUNDLE);
  assert.deepEqual(screen, { width: 402, height: 874 });
  assert.equal(nodes[0].type, "Application");
  assert.deepEqual(nodes[0].rect, { x: 0, y: 0, width: 402, height: 874 });
  assert.equal(nodes[0].hittable, false);
  for (const [index, node] of nodes.entries()) {
    assert.equal(node.index, index);
    assert.equal(node.ref, `e${index + 1}`);
    assert.ok(refs[node.ref]);
    if (index > 0) assert.ok(node.parentIndex < index, "a parent comes before its children");
    assert.ok(node.rect.x < 402 && node.rect.y < 874 && node.rect.x + node.rect.width > 0 && node.rect.y + node.rect.height > 0, "only on-screen nodes");
  }
  const observer = nodes.find(node => node.identifier === "expo-explore-observer");
  assert.ok(observer, "the capture observer is in the tree");
  assert.equal(JSON.parse(observer.label).pathname, "/");
  const keys = nodes.map(node => JSON.stringify([node.type, node.label, node.identifier, node.value, Object.values(node.rect).map(Math.round)]));
  assert.equal(new Set(keys).size, keys.length, "iOS AX duplicates appear once");
  assert.ok(nodes.length < flatten(IOS_HOME).length);
  assert.ok(nodes.some(node => node.type === "Button" && node.identifier === "lane-row-title-0"));
});

test("an Android snapshot keeps pixels, drops the system UI root, and names widgets as agent-device does", () => {
  const { nodes, screen } = snapshotFromTree(ANDROID_HOME, "android", 1, BUNDLE);
  assert.deepEqual(screen, { width: 720, height: 1600 });
  assert.equal(nodes[0].type, "Application");
  assert.deepEqual(nodes[0].rect, { x: 0, y: 0, width: 720, height: 1600 });
  assert.ok(!nodes.some(node => /^android\.widget\./.test(node.type)), "widget classes are simplified");
  assert.ok(nodes.some(node => node.identifier === "expo-explore-observer"));
  const systemUi = flatten({ roots: ANDROID_HOME.roots.filter(root => root.bundleId === "com.android.systemui") })
    .map(node => node.label ?? node.contentDescription).filter(Boolean);
  for (const label of systemUi) assert.ok(!nodes.some(node => node.label === label && node.depth === 0), `system UI root is left out (${label})`);
  assert.ok(nodes.filter(node => node.depth === 0).length === 1);
});

test("snapshot pins refs to its generation and reports the foreground app; press resolves a ref to the element's centre", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-tap": {} });
  const snapshot = await run(["snapshot", ...flags("ios", ["--force-full", "--level", "full"])]);
  assert.equal(snapshot.exitCode, 0);
  assert.equal(snapshot.json.data.refsGeneration, 1);
  assert.equal(snapshot.json.data.appBundleId, BUNDLE);
  assert.equal(snapshot.json.data.truncated, false);
  assert.equal(context.state.udid, UDID);
  assert.equal(context.state.model, "iPhone 17");
  assert.equal(context.state.osVersion, "26.5");
  const target = snapshot.json.data.nodes.find(node => node.identifier === "lane-row-title-0");
  const pressed = await run(["press", `@${target.ref}`, ...flags("ios")]);
  assert.equal(pressed.exitCode, 0);
  const tap = calls.at(-1);
  assert.equal(tap.tool, "gesture-tap");
  assert.equal(tap.args.udid, UDID);
  assert.ok(Math.abs(tap.args.x - (target.rect.x + target.rect.width / 2) / 402) < 1e-9);
  assert.ok(Math.abs(tap.args.y - (target.rect.y + target.rect.height / 2) / 874) < 1e-9);

  const stale = await run(["press", `${target.ref}~s0`, ...flags("ios")]);
  assert.equal(stale.exitCode, 1);
  assert.match(stale.json.error.message, /stale/);
});

test("press with coordinates normalizes Android pixels", async () => {
  const { run, calls } = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": ANDROID_HOME, "gesture-tap": {} });
  assert.equal((await run(["press", "360", "400", ...flags("android")])).exitCode, 0);
  assert.deepEqual(calls.at(-1), { tool: "gesture-tap", args: { udid: "emulator-5554", x: 0.5, y: 0.25 } });
});

test("open relaunches the app until its tree is readable and answers with agent-device's open envelope", async () => {
  const empty = { ...IOS_HOME, roots: [{ type: "Other", frame: { x: 0, y: 0, width: 1, height: 1 } }] };
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "restart-app": {}, "ui-tree": [empty, empty, IOS_HOME] });
  const opened = await run(["open", BUNDLE, ...flags("ios", ["--level", "full"])]);
  assert.equal(opened.exitCode, 0);
  assert.deepEqual(opened.json.data.device, { platform: "ios", target: "mobile", name: "iPhone 17", id: UDID, osVersion: "26.5" });
  assert.equal(opened.json.data.appBundleId, BUNDLE);
  assert.equal(opened.json.data.session, "expo-explore-runtime");
  assert.deepEqual(opened.json.data.identifiers, { session: "expo-explore-runtime", appBundleId: BUNDLE, deviceName: "iPhone 17", deviceId: UDID });
  assert.deepEqual(calls.filter(call => call.tool === "restart-app").map(call => call.args), [{ udid: UDID, bundleId: BUNDLE }]);
});

test("open fails clearly when the app never shows a tree", async () => {
  const empty = { ...IOS_HOME, roots: [] };
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "restart-app": {}, "ui-tree": empty });
  const opened = await run(["open", BUNDLE, ...flags("ios")]);
  assert.equal(opened.exitCode, 1);
  assert.equal(opened.json.error.code, "APP_NOT_READY");
  assert.equal(calls.filter(call => call.tool === "restart-app").length, 2);
});

test("a session with no single booted device is refused", async () => {
  const none = { devices: IOS_DEVICES.devices.map(device => ({ ...device, state: "Shutdown" })) };
  const { run } = harness("ios", { "list-devices": none });
  const result = await run(["snapshot", ...flags("ios")]);
  assert.equal(result.json.error.code, "DEVICE_UNAVAILABLE");
});

test("the first iOS deep link accepts the Open prompt once; later links open directly", async () => {
  // iOS 26.5 flags the prompt as an alert; its text is what identifies it as the link prompt.
  const prompt = { ...IOS_HOME, alertVisible: true, foregroundApp: "com.apple.springboard",
    roots: [...IOS_HOME.roots, { type: "Alert", label: "Open in “euxy”?", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 }, children: [] }] };
  const { run, calls, context } = harness("ios", { "list-devices": IOS_DEVICES, "open-url": {}, "gesture-tap": {}, "ui-tree": [prompt, IOS_HOME] });
  const first = await run(["open", BUNDLE, "euxy://settings", ...flags("ios")]);
  assert.equal(first.exitCode, 0);
  const tap = calls.find(call => call.tool === "gesture-tap");
  assert.ok(Math.abs(tap.args.x - (0.5 + 74 / 402)) < 1e-9 && Math.abs(tap.args.y - (0.5 + 37 / 874)) < 1e-9);
  assert.equal(context.state.deepLinkPromptAccepted, true);
  const before = calls.length;
  assert.equal((await run(["open", "euxy://patterns", ...flags("ios")])).exitCode, 0);
  assert.deepEqual(calls.slice(before).map(call => call.tool), ["open-url"]);
});

test("iOS fill taps the field, erases its text with backspaces, types, and checks the result", async () => {
  const field = flatten(IOS_RENAME).find(node => node.type === "TextField" && node.frame);
  assert.ok(field, "the rename fixture has a text field");
  const typed = structuredClone(IOS_RENAME);
  flatten(typed).find(node => node.type === "TextField" && node.frame).value = "Groove";
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": [IOS_RENAME, typed], "gesture-tap": {}, "run-sequence": {}, keyboard: {} });
  const snapshot = await run(["snapshot", ...flags("ios")]);
  const node = snapshot.json.data.nodes.find(item => item.type === "TextField");
  const filled = await run(["fill", node.ref, ...flags("ios"), "--", "Groove"]);
  assert.equal(filled.exitCode, 0, filled.stdout);
  const tools = calls.slice(2).map(call => call.tool);
  assert.equal(tools[0], "gesture-tap");
  const erase = (field.value ?? "").length;
  if (erase) {
    const sequence = calls.find(call => call.tool === "run-sequence");
    assert.equal(sequence.args.steps.length, erase);
    assert.deepEqual(sequence.args.steps[0], { tool: "keyboard", args: { udid: UDID, key: "backspace" } });
  }
  assert.deepEqual(calls.find(call => call.tool === "keyboard").args, { udid: UDID, text: "Groove" });
  assert.ok(!calls.some(call => call.tool === "fill"), "Argent's iOS fill is not used");
});

test("Android fill uses Argent's fill and requires it to verify the text", async () => {
  const { run, calls } = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": ANDROID_RENAME, "gesture-tap": {}, fill: [{ verified: true }, { verified: false }] });
  const snapshot = await run(["snapshot", ...flags("android")]);
  const node = snapshot.json.data.nodes.find(item => item.type === "TextField");
  assert.ok(node, "the rename fixture has an EditText");
  assert.equal(node.focused, true, "the focused field is marked, as agent-device marks it");
  assert.equal(snapshot.json.data.keyboardVisible, false, "whether a keyboard shows, which the Android tree cannot say, is passed on");
  assert.equal((await run(["fill", node.ref, ...flags("android"), "--", "Groove"])).exitCode, 0);
  assert.deepEqual(calls.find(call => call.tool === "fill").args, { udid: "emulator-5554", text: "Groove" });
  const unverified = await run(["fill", node.ref, ...flags("android"), "--", "Groove"]);
  assert.equal(unverified.exitCode, 1);
});

test("text with a {{secret:…}} placeholder never reaches Argent", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, keyboard: {} });
  const typed = await run(["type", ...flags("ios"), "--", "{{secret:PASSWORD}}"]);
  assert.equal(typed.json.error.code, "INVALID_ARGS");
  assert.ok(!calls.some(call => call.tool === "keyboard"));
});

test("keyboard dismiss matches agent-device: Android presses back; iOS taps a dismiss key or reports it could not", async () => {
  const android = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": [{ ...ANDROID_RENAME, keyboardVisible: true }, { ...ANDROID_RENAME, keyboardVisible: false }], button: {} });
  const dismissed = await android.run(["keyboard", "dismiss", ...flags("android")]);
  assert.deepEqual(dismissed.json.data, { platform: "android", action: "dismiss", wasVisible: true, dismissed: true, visible: false });
  assert.deepEqual(android.calls.find(call => call.tool === "button").args, { udid: "emulator-5554", button: "back" });

  // agent-device fails with this message when the keyboard has no dismiss key, and callers fall back to the return key.
  const noKey = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": { ...IOS_HOME, keyboardVisible: true } });
  const failed = await noKey.run(["keyboard", "dismiss", ...flags("ios")]);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.json.error.message, /^Unable to dismiss the iOS keyboard/);

  const hidden = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME });
  assert.equal((await hidden.run(["keyboard", "dismiss", ...flags("ios")])).json.data.wasVisible, false);
});

test("iOS back with no navigation bar back control fails with agent-device's message", async () => {
  const { run } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME });
  const back = await run(["back", ...flags("ios")]);
  assert.equal(back.exitCode, 1);
  assert.equal(back.json.error.message, "in-app back control is not available");
});

test("alerts read and answer in each platform's agent-device shape", async () => {
  const noAlert = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME });
  assert.equal((await noAlert.run(["alert", "get", ...flags("ios")])).json.error.message, "alert not found");
  const androidNone = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": ANDROID_HOME });
  assert.deepEqual((await androidNone.run(["alert", "get", ...flags("android")])).json.data, { platform: "android", alert: null });

  const alertTree = { ...IOS_HOME, alertVisible: true, roots: [{ type: "Alert", label: "Allow?", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 }, children: [
    { type: "StaticText", label: "Allow notifications?", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.05 } },
    { type: "Button", label: "Don’t Allow", frame: { x: 0.1, y: 0.55, width: 0.4, height: 0.05 } },
    { type: "Button", label: "Allow", frame: { x: 0.5, y: 0.55, width: 0.4, height: 0.05 } }] }] };
  const ios = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": [alertTree, alertTree, IOS_HOME], "gesture-tap": {} });
  assert.deepEqual((await ios.run(["alert", "get", ...flags("ios")])).json.data, { message: "Allow notifications?", items: ["Don’t Allow", "Allow"] });
  const accepted = await ios.run(["alert", "accept", ...flags("ios")]);
  assert.deepEqual(accepted.json.data, { action: "accept", button: "Allow" });
  const tap = ios.calls.find(call => call.tool === "gesture-tap");
  assert.ok(Math.abs(tap.args.x - 0.7) < 1e-9 && Math.abs(tap.args.y - 0.575) < 1e-9);
});

test("screenshots download at full resolution to the requested path", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, screenshot: {} });
  assert.deepEqual((await run(["screenshot", "/tmp/out.png", ...flags("ios")])).json.data, { path: "/tmp/out.png" });
  assert.deepEqual(calls.at(-1), { tool: "screenshot", args: { udid: UDID, scale: 1 }, options: { out: "/tmp/out.png" } });
});

test("a recording is moved from where the Argent client downloaded it to the path Explore asked for", async () => {
  const { run, moves, context } = harness("android", { "list-devices": ANDROID_DEVICES, "screen-recording-start": {}, "screen-recording-stop": { video: "/home/.argent/recordings/r.mp4", durationMs: 4200 } });
  assert.equal((await run(["record", "start", "/work/launch.mp4", ...flags("android")])).exitCode, 0);
  assert.equal(context.state.recording, "/work/launch.mp4");
  const stopped = await run(["record", "stop", ...flags("android")]);
  assert.deepEqual(stopped.json.data, { outPath: "/work/launch.mp4", durationMs: 4200 });
  assert.deepEqual(moves, [["/home/.argent/recordings/r.mp4", "/work/launch.mp4"]]);
  assert.equal(context.state.recording, undefined);
});

test("install reinstalls the archive under the bundle id the caller names", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "reinstall-app": {} }, { bundleId: BUNDLE });
  assert.deepEqual((await run(["install", "/work/bundle/euxy.app", ...flags("ios")])).json.data, { installed: true, appBundleId: BUNDLE });
  assert.deepEqual(calls.at(-1).args, { udid: UDID, bundleId: BUNDLE, appPath: "/work/bundle/euxy.app" });
  const missing = harness("ios", { "list-devices": IOS_DEVICES, "reinstall-app": {} });
  assert.equal((await missing.run(["install", "/work/a.app", ...flags("ios")])).json.error.code, "INVALID_ARGS");
});

test("appearance and logs are reported as unsupported, not silently ignored", async () => {
  const { run } = harness("ios", {});
  assert.equal((await run(["settings", "appearance", "dark", ...flags("ios")])).json.error.code, "CONTROLLER_UNSUPPORTED");
  assert.equal((await run(["logs", "path", ...flags("ios")])).json.error.code, "CONTROLLER_UNSUPPORTED");
});

test("a tool-server that is still starting is waited for before the action is sent", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-tap": {} });
  const answers = [false, false, false, true];
  context.reachable = async () => answers.shift() ?? true;
  assert.equal((await run(["press", "10", "10", ...flags("ios")])).exitCode, 0);
  assert.equal(calls.filter(call => call.tool === "gesture-tap").length, 1);
});

test("an unreachable tool-server before a UI action is the retryable 'Remote daemon is unavailable'", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-tap": {} }, { reachable: false });
  const pressed = await run(["press", "10", "10", ...flags("ios")]);
  assert.deepEqual(pressed.json.error, { code: "COMMAND_FAILED", message: "Remote daemon is unavailable" });
  assert.ok(!calls.some(call => call.tool === "gesture-tap"));
});

// brentvatne/euxy's main baseline run 39506374824: a replacement session's tool-server answered 404 to /tools for the
// first list-devices of its install, before it served its tools.
const TOOLS_404 = "argent run list-devices failed: GET /tools failed: 404 Not Found";

/** A clock the harness's pauses (and, given `requestMs`, its requests) move forward. */
function withClock(context, requestMs = () => 0) {
  const clock = { now: 0, pauses: [], timeouts: [] };
  context.now = () => clock.now;
  context.sleep = async milliseconds => { clock.pauses.push(milliseconds); clock.now += milliseconds; };
  const call = context.call;
  context.call = async (tool, args, options) => {
    if (options?.timeoutMs !== undefined) clock.timeouts.push(options.timeoutMs);
    clock.now += Math.min(requestMs(tool), options?.timeoutMs ?? Infinity);
    return call(tool, args, options);
  };
  return clock;
}

test("a tool-server that does not serve /tools yet is asked again, with a log line, until it does", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": [new ArgentCallError(TOOLS_404, true), new ArgentCallError(TOOLS_404, true), IOS_DEVICES], "reinstall-app": {} }, { bundleId: BUNDLE });
  const clock = withClock(context);
  const lines = [];
  context.progress = line => lines.push(line);
  assert.deepEqual((await run(["install", "/work/bundle/euxy.app", ...flags("ios")])).json.data, { installed: true, appBundleId: BUNDLE });
  assert.equal(calls.filter(call => call.tool === "list-devices").length, 3);
  assert.deepEqual(clock.pauses, [1_000, 2_000]);
  assert.deepEqual(lines, [
    "Argent's tool-server is not serving its tools yet (argent run list-devices failed: GET /tools failed: 404 Not Found); sending list-devices again in 1 s (75 s left of 75 s)",
    "Argent's tool-server is not serving its tools yet (argent run list-devices failed: GET /tools failed: 404 Not Found); sending list-devices again in 2 s (74 s left of 75 s)"]);
  assert.equal(context.state.toolsServed, true);
  assert.deepEqual(clock.timeouts, [75_000, 74_000, 72_000], "each try gets only what is left of the window");
  assert.equal(calls.filter(call => call.tool === "reinstall-app")[0].options, undefined, "a served tool-server's calls keep their own timeout");
});

test("a refused connection or a 503 from /tools is the tool-server still starting too", async () => {
  for (const failure of ["fetch failed: connect ECONNREFUSED 127.0.0.1:9", "GET /tools failed: 503 Service Unavailable"]) {
    const starting = new ArgentCallError(`argent run list-devices failed: ${failure}`, true);
    const { run, calls, context } = harness("ios", { "list-devices": [starting, starting, starting, IOS_DEVICES], "ui-tree": IOS_HOME });
    withClock(context);
    assert.equal((await run(["snapshot", ...flags("ios")])).exitCode, 0, failure);
    assert.equal(calls.filter(call => call.tool === "list-devices").length, 4, "asked past the two read retries");
  }
});

test("a tool-server that never serves /tools fails with a clear error 75 s after the first try", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": new ArgentCallError(TOOLS_404, true), "reinstall-app": {} }, { bundleId: BUNDLE });
  const clock = withClock(context);
  const failed = await run(["install", "/work/bundle/euxy.app", ...flags("ios")]);
  assert.deepEqual(failed.json.error, { code: "TOOL_SERVER_NOT_READY", message: `Argent's tool-server did not start serving its tools within 75 s: ${TOOLS_404}` });
  assert.equal(clock.now, 75_000);
  assert.equal(calls.filter(call => call.tool === "list-devices").length, 11);
  assert.ok(!calls.some(call => call.tool === "reinstall-app"));
});

test("slow answers count against the 75 s too: each try is cut to the time left, and the wait ends on time", async () => {
  const slow = new ArgentCallError("argent run list-devices failed: GET /tools failed: 503 Service Unavailable", true);
  const { run, calls, context } = harness("ios", { "list-devices": slow, "reinstall-app": {} }, { bundleId: BUNDLE });
  // Each 503 takes 30 s to come back, as a gateway's might.
  const clock = withClock(context, () => 30_000);
  assert.equal((await run(["install", "/work/bundle/euxy.app", ...flags("ios")])).json.error.code, "TOOL_SERVER_NOT_READY");
  assert.equal(clock.now, 75_000, "not eleven 30 s tries");
  assert.deepEqual(clock.timeouts, [75_000, 44_000, 12_000]);
  assert.equal(calls.filter(call => call.tool === "list-devices").length, 3);
});

test("an unknown tool's 404 after the tool-server is up fails at once, and a later /tools 404 keeps only the read retries", async () => {
  const unknown = 'argent run gesture-tap failed: Tool "gesture-tap" not found';
  const { run, calls, context } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-tap": new ArgentCallError(unknown, true) });
  const pauses = [];
  context.sleep = async milliseconds => { pauses.push(milliseconds); };
  assert.deepEqual((await run(["press", "10", "10", ...flags("ios")])).json.error, { code: "ARGENT_TOOL_FAILED", message: unknown });
  assert.equal(calls.filter(call => call.tool === "gesture-tap").length, 1);
  assert.deepEqual(pauses, []);
  const served = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": new ArgentCallError("argent run ui-tree failed: GET /tools failed: 404 Not Found", true) },
    { state: { generation: 0, udid: UDID, toolsServed: true } });
  served.context.sleep = async milliseconds => { pauses.push(milliseconds); };
  assert.equal((await served.run(["snapshot", ...flags("ios")])).json.error.code, "ARGENT_TOOL_FAILED");
  assert.equal(served.calls.filter(call => call.tool === "ui-tree").length, 3);
  assert.deepEqual(pauses, [1_000, 2_000]);
});

test("a UI action whose answer is lost is reported once and never retried", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-tap": new ArgentCallError("argent run gesture-tap failed: socket hang up", true) });
  const pressed = await run(["press", "10", "10", ...flags("ios")]);
  assert.equal(pressed.json.error.code, "ARGENT_TOOL_FAILED");
  assert.notEqual(pressed.json.error.message, "Remote daemon is unavailable");
  assert.equal(calls.filter(call => call.tool === "gesture-tap").length, 1);
});

test("reads are retried after a transport failure", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": [new ArgentCallError("timeout", true), IOS_HOME] });
  assert.equal((await run(["snapshot", ...flags("ios")])).exitCode, 0);
  assert.equal(calls.filter(call => call.tool === "ui-tree").length, 2);
});

test("wait stable maps to await-screen-idle", async () => {
  const { run, calls } = harness("android", { "list-devices": ANDROID_DEVICES, "await-screen-idle": { settled: true } });
  assert.deepEqual((await run(["wait", "stable", "700", "5000", ...flags("android")])).json.data, { stable: true });
  assert.deepEqual(calls.at(-1).args, { udid: "emulator-5554", minStableMs: 700, timeoutMs: 5000 });
});

test("iOS 27.1's link prompt is recognized by its text when Argent does not flag it as an alert", () => {
  assert.equal(DUO_PROMPT.alertVisible, false);
  assert.equal(openInAppPromptShowing(DUO_PROMPT), true);
  assert.equal(openInAppPromptShowing(DUO_HOME), false);
  assert.equal(openInAppPromptShowing(IOS_HOME), false);
});

test("describe locates the prompt's Open button where it is on screen", () => {
  assert.deepEqual(describedButton(DUO_PROMPT_DESCRIBE.description, "Open"), { x: 0.418, y: 0.473, width: 0.3, height: 0.071 });
  assert.equal(describedButton(DUO_PROMPT_DESCRIBE.description, "Allow"), undefined);
  assert.equal(describedButton(undefined, "Open"), undefined);
});

test("on iPhone Duo the first link taps Open where describe puts it, not at iPhone 17's offset", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": DUO_DEVICES, "open-url": {}, "gesture-tap": {}, describe: DUO_PROMPT_DESCRIBE, "ui-tree": [DUO_PROMPT, DUO_HOME] });
  const opened = await run(["open", "dev.brent.euxy", "euxy://", ...flags("ios")]);
  assert.equal(opened.exitCode, 0, opened.stdout);
  const tap = calls.find(call => call.tool === "gesture-tap");
  assert.ok(Math.abs(tap.args.x - (0.418 + 0.15)) < 1e-9 && Math.abs(tap.args.y - (0.473 + 0.0355)) < 1e-9, JSON.stringify(tap.args));
  assert.equal(context.state.deepLinkPromptAccepted, true);
});

test("a snapshot taken while iOS 27.1's link prompt is up reports it as an alert", async () => {
  const { run } = harness("ios", { "list-devices": DUO_DEVICES, "ui-tree": DUO_PROMPT });
  const snapshot = await run(["snapshot", ...flags("ios")]);
  assert.ok(snapshot.json.data.nodes.some(node => node.type === "Alert"));
});

test("a tool-server that lists no devices on its first call is asked again", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": [{ devices: [], avds: [] }, DUO_DEVICES], "ui-tree": DUO_HOME });
  assert.equal((await run(["snapshot", ...flags("ios")])).exitCode, 0);
  assert.equal(calls.filter(call => call.tool === "list-devices").length, 2);
  assert.equal(context.state.model, "iPhone Duo");
  assert.equal(context.state.osVersion, "27.1");
});

test("alert get and accept read iOS 27.1's link prompt and press Open where describe puts it", async () => {
  const { run, calls } = harness("ios", { "list-devices": DUO_DEVICES, "gesture-tap": {}, describe: DUO_PROMPT_DESCRIBE, "ui-tree": [DUO_PROMPT, DUO_PROMPT, DUO_HOME] });
  const read = await run(["alert", "get", ...flags("ios")]);
  assert.deepEqual(read.json.data, { message: "Open in “euxy”?", items: ["Cancel", "Open"] });
  const accepted = await run(["alert", "accept", ...flags("ios")]);
  assert.deepEqual(accepted.json.data, { action: "accept", button: "Open" });
  const tap = calls.find(call => call.tool === "gesture-tap");
  assert.ok(Math.abs(tap.args.x - 0.568) < 1e-9 && Math.abs(tap.args.y - 0.5085) < 1e-9, JSON.stringify(tap.args));
});

const image = name => PNG.sync.read(readFileSync(new URL(`../fixtures/argent-0.29/${name}`, import.meta.url)));
const near = (actual, expected, tolerance = 0.02) => Math.abs(actual - expected) <= tolerance;

test("the link prompt's Open button is found in iOS 26 and iOS 27.1 screenshots", () => {
  // iPhone Duo: describe puts Open at (0.418, 0.473, 0.3 × 0.071).
  const duo = findOpenButton(image("screenshot-ios27-duo-open-prompt.png"));
  assert.ok(duo && near(duo.x, 0.568) && near(duo.y, 0.5085), JSON.stringify(duo));
  const iphone17 = findOpenButton(image("screenshot-ios26-iphone17-open-prompt.png"));
  assert.ok(iphone17 && iphone17.x > 0.5 && iphone17.x < 0.85 && iphone17.y > 0.48 && iphone17.y < 0.6, JSON.stringify(iphone17));
});

test("no Open button is found without the prompt, even with a blue key on screen", () => {
  assert.equal(findOpenButton(image("screenshot-ios27-duo-no-prompt-small.png")), undefined);
  assert.equal(findOpenButton(image("screenshot-ios26-keyboard.png")), undefined);
});

test("when Argent reads nothing while the prompt is up, Open is tapped from a screenshot", async () => {
  const blind = { schemaVersion: 1, source: "ax-service", screen: { width: 466, height: 678 }, roots: [{ role: "AXGroup", children: [] }], truncated: false, alertVisible: false };
  const frames = [image("screenshot-ios27-duo-open-prompt.png"), image("screenshot-ios27-duo-no-prompt-small.png")];
  const { run, calls, context } = harness("ios", { "list-devices": DUO_DEVICES, "open-url": {}, "gesture-tap": {}, screenshot: {}, "ui-tree": blind });
  context.scratchImage = { path: "/work/argent-scratch.png", read: async () => frames.shift() };
  const opened = await run(["open", "dev.brent.euxy", "euxy://", ...flags("ios")]);
  assert.equal(opened.exitCode, 0, opened.stdout);
  const tap = calls.find(call => call.tool === "gesture-tap");
  assert.ok(near(tap.args.x, 0.568) && near(tap.args.y, 0.5085), JSON.stringify(tap.args));
  assert.deepEqual(calls.filter(call => call.tool === "screenshot").map(call => call.options), [{ out: "/work/argent-scratch.png" }, { out: "/work/argent-scratch.png" }]);
  assert.equal(context.state.deepLinkPromptAccepted, true);
});

test("reset-reader stops the device's Argent helpers by its UDID and forgets what the old reader saw", async () => {
  const state = { generation: 3, udid: UDID, screen: { width: 402, height: 874 }, refs: { e1: {} } };
  const { calls, run } = harness("ios", { "stop-all-simulator-servers": { stopped: [`NativeDevtools:${UDID}`, `AXService:${UDID}`] } }, { state });
  const reset = await run(["reset-reader", ...flags("ios")]);
  assert.deepEqual(reset.json.data, { action: "reset-reader", stopped: [`NativeDevtools:${UDID}`, `AXService:${UDID}`] });
  assert.deepEqual(calls, [{ tool: "stop-all-simulator-servers", args: { devices: [UDID] } }]);
  assert.equal(state.screen, undefined); assert.equal(state.refs, undefined); assert.equal(state.generation, 4);
});

test("fold moves a foldable to a pose and forgets the old panel's geometry", async () => {
  // Argent's fold answers with the panel it lit, in pixels; the inner panel is 2007 × 2853 (669 × 951 points).
  const { run, calls, context } = harness("ios", { "list-devices": DUO_DEVICES, "ui-tree": [DUO_HOME, DUO_OPEN_EDIT_LANE], "stop-all-simulator-servers": { stopped: [] },
    fold: { activeScreen: 3, screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 }, posture: "open", hingeAngle: 180 } });
  await run(["snapshot", ...flags("ios")]);
  const generation = context.state.generation;
  const reads = calls.filter(call => call.tool === "ui-tree").length;
  const folded = await run(["fold", "open", ...flags("ios")]);
  assert.deepEqual(folded.json.data, { action: "fold", pose: "open" });
  const fold = calls.findIndex(call => call.tool === "fold");
  assert.equal(calls.slice(0, fold).filter(call => call.tool === "ui-tree").length, reads, "nothing is read between the command and the fold");
  assert.deepEqual(calls[fold].args, { udid: "74195B53-4DBC-4EAA-9991-F98E5BB86BA8", posture: "open" });
  // The device's helpers are reset just before the fold, so the panel it lights is read by fresh ones.
  assert.deepEqual(calls[fold - 1], { tool: "stop-all-simulator-servers", args: { devices: ["74195B53-4DBC-4EAA-9991-F98E5BB86BA8"] } });
  assert.equal(context.state.screen, undefined);
  assert.equal(context.state.refs, undefined);
  assert.equal(context.state.generation, generation + 1);
  assert.equal((await run(["fold", "sideways", ...flags("ios")])).json.error.code, "INVALID_ARGS");
});

test("a reader stuck on the dark panel after a fold is reset once more before the fold is called unverified", async () => {
  const fold = { activeScreen: 3, screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 }, posture: "open", hingeAngle: 180 };
  const stopped = { stopped: ["AXService:74195B53-4DBC-4EAA-9991-F98E5BB86BA8"] };
  // Ten reads still in the cover panel's shape (as on EAS, 2026-10-17), then the inner panel once the helpers restart.
  const recovers = harness("ios", { "list-devices": DUO_DEVICES, fold, "stop-all-simulator-servers": stopped, "ui-tree": [...Array(10).fill(DUO_HOME), DUO_OPEN_EDIT_LANE] });
  assert.deepEqual((await recovers.run(["fold", "open", ...flags("ios")])).json.data, { action: "fold", pose: "open" });
  assert.deepEqual(recovers.calls.filter(call => call.tool === "stop-all-simulator-servers").map(call => call.args), Array(2).fill({ devices: ["74195B53-4DBC-4EAA-9991-F98E5BB86BA8"] }));

  const stuck = harness("ios", { "list-devices": DUO_DEVICES, fold, "stop-all-simulator-servers": stopped, "ui-tree": DUO_HOME });
  const failed = await stuck.run(["fold", "open", ...flags("ios")]);
  assert.equal(failed.json.error.code, "CONTROLLER_FOLD_UNVERIFIED");
  assert.match(failed.json.error.message, /after its device helpers were reset/);
  assert.equal(stuck.calls.filter(call => call.tool === "stop-all-simulator-servers").length, 2, "before the fold and once after, not in a loop");
});

// brentvatne/euxy#172, review run 39348956443: the fold after capture restarted SpringBoard failed with this, before it ran.
const DEPENDENCY_FAILED = "argent run fold failed: [Tool:fold] Service dependency failed: [SimulatorServer:74195B53-4DBC-4EAA-9991-F98E5BB86BA8] Timed out waiting for simulator-server to become ready";

test("a fold whose simulator-server did not start is sent again after a pause, and then folds", async () => {
  const lit = { activeScreen: 3, screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 }, posture: "open", hingeAngle: 180 };
  const { run, calls, context } = harness("ios", { "list-devices": DUO_DEVICES, "ui-tree": DUO_OPEN_EDIT_LANE, "stop-all-simulator-servers": { stopped: [] },
    fold: [new ArgentCallError(DEPENDENCY_FAILED, true), lit] });
  const pauses = [];
  context.sleep = async milliseconds => { pauses.push(milliseconds); };
  assert.deepEqual((await run(["fold", "open", ...flags("ios")])).json.data, { action: "fold", pose: "open" });
  assert.equal(calls.filter(call => call.tool === "fold").length, 2);
  assert.deepEqual(pauses, [3_000], "one pause before the fold is sent again");
});

test("a fold whose simulator-server never starts fails as it did before, after two more tries", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": DUO_DEVICES, "ui-tree": DUO_OPEN_EDIT_LANE, "stop-all-simulator-servers": { stopped: [] },
    fold: new ArgentCallError(DEPENDENCY_FAILED, true) });
  const pauses = [];
  context.sleep = async milliseconds => { pauses.push(milliseconds); };
  const failed = await run(["fold", "open", ...flags("ios")]);
  assert.deepEqual(failed.json.error, { code: "ARGENT_TOOL_FAILED", message: DEPENDENCY_FAILED });
  assert.equal(calls.filter(call => call.tool === "fold").length, 3);
  assert.deepEqual(pauses, [3_000, 6_000]);
});

test("a UI action that failed for another reason is still sent once, even when its message mentions a dependency", async () => {
  // Only the tool's own wrap counts: a nested tool's dependency failure is not this tool failing to start.
  for (const message of ["argent run gesture-tap failed: [Tool:gesture-tap] simulator-server answered 500",
    "argent run gesture-tap failed: [Tool:gesture-tap] [Tool:keyboard] Service dependency failed: [SimulatorServer:x] Timed out"]) {
    const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-tap": new ArgentCallError(message, true) });
    const pressed = await run(["press", "10", "10", ...flags("ios")]);
    assert.deepEqual(pressed.json.error, { code: "ARGENT_TOOL_FAILED", message });
    assert.equal(calls.filter(call => call.tool === "gesture-tap").length, 1, message);
  }
});

test("an alert that is not the link prompt is left for capture to answer", async () => {
  const other = { ...IOS_HOME, alertVisible: true, foregroundApp: "com.apple.springboard",
    roots: [{ type: "Alert", label: "Delete all data?", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 }, children: [
      { type: "Button", label: "Delete", frame: { x: 0.5, y: 0.55, width: 0.4, height: 0.05 } }] }] };
  const { run, calls, context } = harness("ios", { "list-devices": IOS_DEVICES, "open-url": {}, "gesture-tap": {}, describe: { description: "" }, "ui-tree": other });
  assert.equal((await run(["open", BUNDLE, "euxy://settings", ...flags("ios")])).exitCode, 0);
  assert.equal(calls.some(call => call.tool === "gesture-tap"), false, "nothing is pressed");
  assert.equal(context.state.deepLinkPromptAccepted, undefined);
});

test("a failed read with no roots is not taken for the blind link prompt", async () => {
  const { run, calls, context } = harness("ios", { "list-devices": IOS_DEVICES, "open-url": {}, "gesture-tap": {}, screenshot: {}, "ui-tree": [{ ...IOS_HOME, roots: [], foregroundApp: undefined }] });
  context.scratchImage = { path: "/work/argent-scratch.png", read: async () => image("screenshot-ios27-duo-open-prompt.png") };
  await run(["open", BUNDLE, "euxy://", ...flags("ios")]);
  assert.equal(calls.some(call => call.tool === "screenshot" || call.tool === "gesture-tap"), false);
});

test("describe's Open is read only from a line Argent printed, not from app text that spells one out", () => {
  const spoof = `ROOT  AXGroup (0.000, 0.000, 1.000, 1.000)\n  AXStaticText "x AXButton "Open" (0.010, 0.010, 0.050, 0.050)"  (0.1, 0.1, 0.5, 0.05)\n  AXButton "Open"  (0.418, 0.473, 0.300, 0.071)`;
  assert.deepEqual(describedButton(spoof, "Open"), { x: 0.418, y: 0.473, width: 0.3, height: 0.071 });
});

test("an app's own Done above the keyboard is never pressed to dismiss it", async () => {
  const withDone = { ...IOS_HOME, keyboardVisible: true, roots: [{ type: "Other", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [
    { type: "Button", label: "Done", frame: { x: 0.8, y: 0.06, width: 0.15, height: 0.05 } }] }] };
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": withDone, "gesture-tap": {} });
  assert.equal((await run(["keyboard", "dismiss", ...flags("ios")])).exitCode, 1);
  assert.equal(calls.some(call => call.tool === "gesture-tap"), false);
});

test("iOS fill stops when erasing the field stops partway, and types nothing", async () => {
  const filled = structuredClone(IOS_RENAME);
  flatten(filled).find(node => node.type === "TextField" && node.frame).value = "Old";
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": filled, "gesture-tap": {}, "run-sequence": { completed: 1, total: 3, steps: [] }, keyboard: {} });
  const snapshot = await run(["snapshot", ...flags("ios")]);
  const field = snapshot.json.data.nodes.find(node => node.type === "TextField");
  const result = await run(["fill", field.ref, ...flags("ios"), "--", "New"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.json.error.message, /after 1 of 3 keys/);
  assert.equal(calls.some(call => call.tool === "keyboard"), false);
});

test("a truncated tree is reported as truncated", async () => {
  const { run } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": { ...IOS_HOME, truncated: true } });
  assert.equal((await run(["snapshot", ...flags("ios")])).json.data.truncated, true);
});

test("Android disabled controls are reported disabled (the recorded rename screen has four)", () => {
  const { nodes } = snapshotFromTree(ANDROID_RENAME, "android", 1, BUNDLE);
  const rename = nodes.find(node => node.label === "Rename" && node.type === "Button");
  assert.ok(rename, "the rename fixture has its Rename button");
  assert.equal(rename.enabled, false);
  assert.equal(rename.hittable, false);
});

test("an Android permission dialog from another package stays in the snapshot as an alert", async () => {
  const dialog = { ...ANDROID_HOME, roots: [...ANDROID_HOME.roots, { type: "android.widget.FrameLayout", bundleId: "com.google.android.permissioncontroller",
    frame: { x: 0.1, y: 0.35, width: 0.8, height: 0.3 }, children: [
      { type: "android.widget.TextView", label: "Allow euxy to send you notifications?", frame: { x: 0.15, y: 0.4, width: 0.7, height: 0.05 } },
      { type: "android.widget.Button", label: "Allow", frame: { x: 0.15, y: 0.55, width: 0.7, height: 0.05 } }] }] };
  const { run } = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": dialog });
  const snapshot = (await run(["snapshot", ...flags("android")])).json.data;
  assert.ok(snapshot.nodes.some(node => node.type === "Button" && node.label === "Allow"), "the dialog's buttons can be found");
  assert.ok(snapshot.nodes.some(node => node.type === "Alert"), "capture sees an alert covering the app");
  assert.ok(!snapshot.nodes.some(node => /systemui/.test(JSON.stringify(node))), "the system UI is still left out");
  assert.deepEqual((await run(["alert", "get", ...flags("android")])).json.data.alert.buttons, ["Allow"]);
});

test("system back swipes from the iOS edge; Android prefers an in-app back control", async () => {
  const ios = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "gesture-swipe": {} });
  assert.equal((await ios.run(["back", "--system", ...flags("ios")])).exitCode, 0);
  assert.deepEqual(ios.calls.at(-1).args, { udid: UDID, fromX: 0.05, fromY: 0.5, toX: 0.8, toY: 0.5, momentum: false });

  const up = { ...ANDROID_HOME, roots: [...ANDROID_HOME.roots.filter(root => root.bundleId !== BUNDLE), { type: "android.widget.FrameLayout", bundleId: BUNDLE,
    frame: { x: 0, y: 0, width: 1, height: 1 }, children: [{ type: "android.widget.ImageButton", contentDescription: "Navigate up", frame: { x: 0, y: 0.05, width: 0.1, height: 0.05 } }] }] };
  const android = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": up, "gesture-tap": {}, button: {} });
  assert.deepEqual((await android.run(["back", "--in-app", ...flags("android")])).json.data, { action: "back", mode: "in-app" });
  assert.equal(android.calls.some(call => call.tool === "button"), false);
  const none = harness("android", { "list-devices": ANDROID_DEVICES, "ui-tree": ANDROID_HOME, button: {} });
  assert.equal((await none.run(["back", "--in-app", ...flags("android")])).json.error.message, "in-app back control is not available");
  assert.deepEqual((await none.run(["back", ...flags("android")])).json.data, { action: "back", mode: "system" });
});

test("open without --relaunch keeps a running app as it is", async () => {
  const { run, calls } = harness("ios", { "list-devices": IOS_DEVICES, "ui-tree": IOS_HOME, "restart-app": {} });
  assert.equal((await run(["open", BUNDLE, ...flags("ios")])).exitCode, 0);
  assert.equal(calls.some(call => call.tool === "restart-app"), false);
});

test("a link prompt that lingers a moment after Open is pressed is not a failure", async () => {
  const prompt = { ...IOS_HOME, alertVisible: true, foregroundApp: "com.apple.springboard",
    roots: [...IOS_HOME.roots, { type: "Alert", label: "Open in “euxy”?", frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 }, children: [] }] };
  // Read once before the press, twice more while the app comes forward, then the app.
  const { run, context } = harness("ios", { "list-devices": IOS_DEVICES, "open-url": {}, "gesture-tap": {}, describe: { description: "" }, "ui-tree": [prompt, prompt, prompt, IOS_HOME] });
  assert.equal((await run(["open", BUNDLE, "euxy://", ...flags("ios")])).exitCode, 0);
  assert.equal(context.state.deepLinkPromptAccepted, true);
});

test("on iPhone Duo's inner display, a sheet's title outside Argent's shrunken root frame is visible", () => {
  assert.deepEqual(DUO_OPEN_EDIT_LANE.roots[0].frame, { x: 0, y: 0, width: 0.3333333333333333, height: 0.3333333333333333 }, "the recorded Argent quirk");
  const { nodes } = snapshotFromTree(DUO_OPEN_EDIT_LANE, "ios", 1, BUNDLE);
  for (const label of ["Edit Lane", "Cancel", "Done"]) {
    const node = nodes.find(item => item.label === label);
    assert.ok(node, label);
    assert.notEqual(node.visible, false, `${label} is visible`);
  }
});

test("a node its ancestor clips away is still reported hidden on iOS", () => {
  const clipped = { screen: { width: 400, height: 800 }, foregroundApp: BUNDLE, roots: [{ type: "Application", frame: { x: 0, y: 0, width: 1, height: 1 }, children: [
    { type: "ScrollView", frame: { x: 0, y: 0, width: 1, height: 0.5 }, children: [
      { type: "Button", label: "In view", frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 } },
      { type: "Button", label: "Scrolled away", frame: { x: 0.1, y: 0.7, width: 0.3, height: 0.05 } }] }] }] };
  const { nodes } = snapshotFromTree(clipped, "ios", 1, BUNDLE);
  assert.notEqual(nodes.find(node => node.label === "In view").visible, false);
  assert.equal(nodes.find(node => node.label === "Scrolled away").visible, false);
});

test("a fold whose panel Argent never reads fails clearly instead of capturing the dark panel", async () => {
  const lit = { activeScreen: 3, screen: { id: 3, panel: "inner panel", width: 2007, height: 2853 }, posture: "open", hingeAngle: 180 };
  const blindClosed = { ...DUO_HOME, foregroundApp: undefined, roots: [{ role: "AXGroup", children: [] }] };
  const late = harness("ios", { "list-devices": DUO_DEVICES, fold: lit, "stop-all-simulator-servers": { stopped: [] }, "ui-tree": [blindClosed, blindClosed, DUO_OPEN_EDIT_LANE] });
  assert.equal((await late.run(["fold", "open", ...flags("ios")])).exitCode, 0, "a reader that catches up within the wait is fine");
  const stuck = harness("ios", { "list-devices": DUO_DEVICES, fold: lit, "stop-all-simulator-servers": { stopped: [] }, "ui-tree": blindClosed });
  const failed = await stuck.run(["fold", "open", ...flags("ios")]);
  assert.equal(failed.json.error.code, "CONTROLLER_FOLD_UNVERIFIED");
  assert.equal(stuck.calls.filter(call => call.tool === "fold").length, 1, "the session is not folded back and forth");
});

test("an opened foldable's screenshots are captured upright and its recordings handed to be turned; others are left as Argent saves them", async () => {
  const replies = { "list-devices": IOS_DEVICES, screenshot: {}, "screen-recording-start": {}, "screen-recording-stop": { video: "/home/.argent/recordings/r.mp4" } };
  for (const landscape of [true, false]) {
    const { run, context, calls } = harness("ios", replies, { state: { generation: 0, screen: { width: 669, height: 951 } } });
    // Argent reads the opened panel on its portrait axes, like the closed one: only the pose tells them apart.
    if (landscape) context.landscape = true;
    const oriented = [];
    context.orientVideo = async path => { oriented.push(path); };
    assert.equal((await run(["screenshot", "/work/screen.png", ...flags("ios")])).exitCode, 0);
    await run(["record", "start", "/work/launch.mp4", ...flags("ios")]);
    await run(["record", "stop", ...flags("ios")]);
    assert.deepEqual(calls.find(call => call.tool === "screenshot").args, { udid: UDID, scale: 1, ...(landscape ? { rotation: "LandscapeRight" } : {}) });
    assert.deepEqual(oriented, landscape ? ["/work/launch.mp4"] : []);
  }
});
