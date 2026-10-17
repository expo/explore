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
function localRunner() {
  const requests = [];
  const ok = data => ({ stdout: JSON.stringify({ success: true, data }), stderr: "" });
  const runner = request => {
    requests.push(request);
    const [first, second, third] = request.args;
    if (request.command === "xcrun") {
      if (second === "list" && third === "devicetypes") return { stdout: JSON.stringify({ devicetypes: [{ name: "iPhone 17 Pro", identifier: DEVICE_TYPE }] }), stderr: "" };
      if (second === "list" && third === "runtimes") return { stdout: JSON.stringify({ runtimes: [{ isAvailable: true, platform: "iOS", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        version: "27.0", supportedDeviceTypes: [{ identifier: DEVICE_TYPE }] }] }), stderr: "" };
      if (second === "create") return { stdout: `${UDID}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    }
    if (first === "--version") return { stdout: `${controllerVersion("agent-device")}\n`, stderr: "" };
    if (first === "open") return ok({ session: CONTROLLER_SESSION, appBundleId: "dev.example.app", device: { platform: "ios", target: "mobile", name: "Explore iPhone 17 Pro", id: UDID },
      identifiers: { session: CONTROLLER_SESSION, appBundleId: "dev.example.app", deviceName: "Explore iPhone 17 Pro", deviceId: UDID } });
    if (first === "snapshot") return ok({ nodes: [{ type: "StaticText", label: "Welcome" }, { type: "Button", label: "Settings" }] });
    if (first === "appstate") return ok({ platform: "ios", appBundleId: "dev.example.app", state: "runningForeground", surface: "app" });
    if (first === "screenshot") { writeFileSync(request.args[1], PNG); return ok({}); }
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
