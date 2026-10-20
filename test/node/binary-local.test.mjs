import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { runBinaryExploration } = await tsImport("../../src/binary/run.ts", import.meta.url);
const { controllerVersion } = await tsImport("../../src/capture/simulator.ts", import.meta.url);
const { CONTROLLER_SESSION } = await tsImport("../../src/capture/common.ts", import.meta.url);

const UDID = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";

async function simulatorApp(root) {
  const app = join(root, "Example.app");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.example.app</string>
<key>CFBundleDisplayName</key><string>Example</string>
<key>DTPlatformName</key><string>iphonesimulator</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>example</string></array></dict></array>
</dict></plist>`);
  await writeFile(join(app, "Example"), "binary");
  return app;
}

/** simctl and agent-device on a Mac with one iPhone 17 Pro runtime; the app shows a single screen. */
function localRunner(device = { name: "iPhone 17 Pro", identifier: DEVICE_TYPE }, screen = { nodes: [{ type: "StaticText", label: "Welcome" }, { type: "Button", label: "Settings" }], png: PNG }) {
  const requests = [];
  const ok = data => ({ stdout: JSON.stringify({ success: true, data }), stderr: "" });
  const runner = request => {
    requests.push(request);
    const [first, second, third] = request.args;
    if (request.command === "xcrun") {
      if (second === "list" && third === "devicetypes") return { stdout: JSON.stringify({ devicetypes: [device] }), stderr: "" };
      if (second === "list" && third === "runtimes") return { stdout: JSON.stringify({ runtimes: [{ isAvailable: true, platform: "iOS", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        version: "27.0", supportedDeviceTypes: [{ identifier: device.identifier }] }] }), stderr: "" };
      if (second === "create") return { stdout: `${UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    }
    if (first === "--version") return { stdout: `${controllerVersion("agent-device")}\n`, stderr: "" };
    if (first === "open") return ok({ session: CONTROLLER_SESSION, appBundleId: "dev.example.app", device: { platform: "ios", target: "mobile", name: "Explore iPhone 17 Pro", id: UDID },
      identifiers: { session: CONTROLLER_SESSION, appBundleId: "dev.example.app", deviceName: "Explore iPhone 17 Pro", deviceId: UDID } });
    if (first === "snapshot") return ok({ nodes: screen.nodes });
    if (first === "appstate") return ok({ platform: "ios", appBundleId: "dev.example.app", state: "runningForeground", surface: "app" });
    if (first === "screenshot") { writeFileSync(request.args[1], screen.png); return ok({}); }
    return ok({});
  };
  return { requests, runner };
}

test("explore:binary --simulator local runs on a simulator it creates, with no EAS login, and deletes it afterwards", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-binary-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { requests, runner } = localRunner();
  const session = { provider: "anthropic", model: "test", async preflight() {}, async run() { return { stopReason: "done" }; } };
  const result = await runBinaryExploration({ archive: await simulatorApp(root), output: join(root, "out"), simulator: "local", provider: "anthropic", runner,
    createSession: () => session, environment: { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: "key" } });

  // No EAS: no login check, project, or session.
  assert.equal(requests.some(request => request.args.some(arg => /^(whoami|init|simulator:)/.test(arg))), false);
  const simctl = requests.filter(request => request.command === "xcrun").map(request => request.args.slice(1).join(" "));
  assert.ok(simctl.some(command => command.startsWith(`create Explore iPhone 17 Pro (binary `)));
  assert.ok(simctl.includes(`spawn ${UDID} defaults write com.apple.launchservices.schemeapproval com.apple.CoreSimulator.CoreSimulatorBridge-->example -string dev.example.app`),
    "the app's own scheme opens without a prompt");
  assert.ok(simctl.some(command => command.startsWith(`install ${UDID} `)), "simctl installs the app");
  assert.equal(simctl.at(-1), `delete ${UDID}`, "and the simulator goes last");

  // agent-device runs its own daemon in the run's directory and is pointed at the simulator by its UDID.
  const controller = requests.filter(request => request.command !== "xcrun" && request.args[0] !== "--version" && request.args[0] !== "close");
  assert.ok(controller.length > 0);
  for (const request of controller) {
    assert.deepEqual(request.args.slice(request.args.indexOf("--udid"), request.args.indexOf("--udid") + 2), ["--udid", UDID]);
    assert.match(request.environment.AGENT_DEVICE_STATE_DIR, /agent-device-state$/);
    assert.equal(request.environment.AGENT_DEVICE_DAEMON_BASE_URL, undefined);
  }
  assert.equal(controller.some(request => request.args[0] === "install"), false, "the controller does not install it again");

  assert.equal(result.runtime.provider, "local-simulator");
  assert.equal(result.runtime.osVersion, "27.0");
  assert.equal(result.session.id, `local-${UDID}`);
  assert.deepEqual(await readdir(join(root, ".cache", "expo-explore", "local-captures")), [], "nothing is left for a sweep");
});

test("an opened iPhone Duo's screenshots are stored upright, and the run records the landscape they show", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-binary-duo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createRequire } = await import("node:module");
  const { PNG: Png } = createRequire(import.meta.url)("pngjs");
  // The inner panel on its portrait axes at 1x, as local agent-device returns it: the tree's root is 669×951 points.
  const raw = new Png({ width: 669, height: 951 });
  for (let offset = 0; offset < raw.data.length; offset += 4) raw.data.set(offset < 669 * 4 ? [255, 0, 0, 255] : [255, 255, 255, 255], offset);
  const nodes = [{ type: "Application", label: "Example", rect: { x: 0, y: 0, width: 669, height: 951 } }, { type: "Button", label: "Settings", rect: { x: 20, y: 40, width: 80, height: 44 } }];
  const { runner } = localRunner({ name: "iPhone Duo", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo" }, { nodes, png: Png.sync.write(raw) });
  const session = { provider: "anthropic", model: "test", async preflight() {}, async run(request) {
    const observed = JSON.parse((await request.callTool("observe", { includeImage: true }, request.signal)).content[0].text);
    await request.callTool("capture", { frameId: observed.frameId, title: "Home" }, request.signal);
    await request.callTool("finish", { summary: "One." }, request.signal).catch(() => {});
    return { stopReason: "done" };
  } };
  const result = await runBinaryExploration({ archive: await simulatorApp(root), output: join(root, "out"), simulator: "local", device: "iPhone Duo", provider: "anthropic", runner,
    createSession: () => session, environment: { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: "key" } });
  const { readFile } = await import("node:fs/promises");
  const map = JSON.parse(await readFile(result.mapPath, "utf8"));
  const artifact = map.artifacts.find(item => item.kind === "screenshot");
  assert.deepEqual([artifact.width, artifact.height], [951, 669]);
  const stored = Png.sync.read(await readFile(join(result.outputDirectory, artifact.path)));
  assert.deepEqual([stored.width, stored.height], [951, 669]);
  // The panel's top row (red) is the right-hand column once turned.
  assert.deepEqual([...stored.data.subarray((951 - 1) * 4, 951 * 4)], [255, 0, 0, 255]);
  assert.deepEqual([...stored.data.subarray(0, 4)], [255, 255, 255, 255]);
  assert.equal(map.run.environment.orientation, "landscape");
  assert.equal(result.runtime.orientation, "landscape");
});
