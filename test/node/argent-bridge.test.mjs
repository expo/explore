import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "node:http";
import { startArgentBridgeRunner } from "../../dist/capture/argent-bridge-host.js";
import { argentClientCall } from "../../dist/capture/argent-bridge-worker.js";
import { argentRunFailureDetail } from "../../dist/capture/argent-bridge.js";
import { runBridgeCommand } from "../../dist/capture/argent-driver.js";
import { ARGENT_VERSION } from "../../dist/shared/argent-version.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function fakeClient(root, body) {
  const module = join(root, "client.mjs");
  await writeFile(module, `const calls = [];\nexport function createArgentClient() { return { calls, async callTool(name, args, options) { calls.push({ name, args }); ${body} } }; }\n`);
  return module;
}

test("the bridge thread answers the capture's commands through Argent's client and falls back for other executables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-argent-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shot.png"), PNG);
  const clientModule = await fakeClient(root, `
    if (name === "list-devices") return { data: { devices: [{ udid: "UDID-1", name: "iPhone 17", state: "Booted", platform: "ios", runtime: "iOS 26.0" }] } };
    if (name === "screenshot") return { data: { path: ${JSON.stringify(join(root, "shot.png"))} } };
    if (name === "await-screen-idle") { if (options?.signal?.aborted) throw options.signal.reason; await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 5_000); options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal.reason); }); }); return { data: { idle: true } }; }
    throw new Error("unexpected tool " + name);`);
  const fallbackCalls = [];
  const environment = { EXPLORE_ARGENT_STATE: join(root, "state.json"), EXPLORE_ARGENT_PLATFORM: "ios", ARGENT_TOOLS_URL: "http://127.0.0.1:9/tools", HOME: root, PATH: process.env.PATH };
  const bridge = startArgentBridgeRunner({ command: "/opt/argent-controller", environment, clientModule, fallback: request => { fallbackCalls.push(request.args[0]); return { stdout: "{}", stderr: "" }; } });
  t.after(() => bridge.close());
  const request = args => ({ command: "/opt/argent-controller", args, cwd: root, environment, timeoutMs: 20_000 });

  const version = bridge.runner(request(["--version"]));
  assert.equal(version.stdout.trim(), ARGENT_VERSION);
  const shot = JSON.parse(bridge.runner(request(["screenshot", join(root, "out", "screen.png"), "--session", "explore", "--platform", "ios", "--json"])).stdout);
  assert.equal(shot.success, true);
  assert.deepEqual(await readFile(join(root, "out", "screen.png")), PNG, "the materialized artifact is copied where the command asked");
  assert.ok(bridge.active);

  bridge.runner({ command: "/usr/bin/other", args: ["noop"], cwd: root, environment });
  assert.deepEqual(fallbackCalls, ["noop"], "other executables go to the fallback runner");

  const started = Date.now();
  assert.throws(() => bridge.runner({ ...request(["wait", "stable", "500", "8000", "--session", "explore", "--platform", "ios", "--json"]), timeoutMs: 300 }), /timed out after 300 ms/);
  assert.ok(Date.now() - started < 5_000, "a timed-out command is aborted, not waited out");
  assert.ok(bridge.active, "the thread answered the abort, so it keeps serving");
  assert.equal(bridge.runner(request(["--version"])).stdout.trim(), ARGENT_VERSION);
});

test("a thread whose Argent client cannot load hands every command to the fallback runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-argent-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fallbackCalls = [];
  const environment = { EXPLORE_ARGENT_STATE: join(root, "state.json"), EXPLORE_ARGENT_PLATFORM: "ios", ARGENT_TOOLS_URL: "http://127.0.0.1:9/tools", HOME: root, PATH: process.env.PATH };
  const bridge = startArgentBridgeRunner({ command: "/opt/argent-controller", environment, clientModule: join(root, "missing.mjs"), fallback: request => { fallbackCalls.push(request.args[0]); return { stdout: "{}", stderr: "" }; } });
  t.after(() => bridge.close());
  bridge.runner({ command: "/opt/argent-controller", args: ["snapshot", "--json"], cwd: root, environment, timeoutMs: 20_000 });
  bridge.runner({ command: "/opt/argent-controller", args: ["screenshot", "x.png", "--json"], cwd: root, environment, timeoutMs: 20_000 });
  assert.deepEqual(fallbackCalls, ["snapshot", "screenshot"]);
  assert.equal(bridge.active, false);
});

test("a session whose tool-server was replaced is driven at the new one: the thread starts again with the changed environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-argent-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shot.png"), PNG);
  // The fake client notes which tool-server it was given, as Argent's reads ARGENT_TOOLS_URL from its environment.
  const clientModule = await fakeClient(root, `
    if (name === "list-devices") return { data: { devices: [{ udid: "UDID-1", name: "iPhone 17", state: "Booted", platform: "ios", runtime: "iOS 26.0" }] } };
    if (name === "screenshot") { (await import("node:fs")).appendFileSync(${JSON.stringify(join(root, "servers.txt"))}, process.env.ARGENT_TOOLS_URL + "\\n"); return { data: { path: ${JSON.stringify(join(root, "shot.png"))} } }; }
    throw new Error("unexpected tool " + name);`);
  const environment = { EXPLORE_ARGENT_STATE: join(root, "state.json"), EXPLORE_ARGENT_PLATFORM: "ios", ARGENT_TOOLS_URL: "http://127.0.0.1:9/old", HOME: root, PATH: process.env.PATH };
  const bridge = startArgentBridgeRunner({ command: "/opt/argent-controller", environment, clientModule, fallback: () => assert.fail("the thread serves every command") });
  t.after(() => bridge.close());
  const screenshot = () => JSON.parse(bridge.runner({ command: "/opt/argent-controller", args: ["screenshot", join(root, "out", "screen.png"), "--session", "explore", "--platform", "ios", "--json"],
    cwd: root, environment, timeoutMs: 20_000 }).stdout);
  assert.equal(screenshot().success, true);
  // As the capture's local recovery does: the same environment object, pointed at the restarted tool-server.
  Object.assign(environment, { ARGENT_TOOLS_URL: "http://127.0.0.1:9/new", ARGENT_AUTH_TOKEN: "new-token" });
  assert.equal(screenshot().success, true);
  assert.deepEqual((await readFile(join(root, "servers.txt"), "utf8")).trim().split("\n"), ["http://127.0.0.1:9/old", "http://127.0.0.1:9/new"]);
  assert.ok(bridge.active);
});

test("a thread that crashes stops serving, and the commands after it run per command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-argent-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shot.png"), PNG);
  // An exception nothing catches, thrown on the thread well after its answer.
  const clientModule = await fakeClient(root, `
    if (name === "list-devices") return { data: { devices: [{ udid: "UDID-1", name: "iPhone 17", state: "Booted", platform: "ios", runtime: "iOS 26.0" }] } };
    if (name === "screenshot") { setTimeout(() => { throw new Error("the client crashed"); }, 300); return { data: { path: ${JSON.stringify(join(root, "shot.png"))} } }; }
    throw new Error("unexpected tool " + name);`);
  const fallbackCalls = [], messages = [];
  const environment = { EXPLORE_ARGENT_STATE: join(root, "state.json"), EXPLORE_ARGENT_PLATFORM: "ios", ARGENT_TOOLS_URL: "http://127.0.0.1:9/tools", HOME: root, PATH: process.env.PATH };
  const bridge = startArgentBridgeRunner({ command: "/opt/argent-controller", environment, clientModule, progress: message => messages.push(message),
    fallback: request => { fallbackCalls.push(request.args[0]); return { stdout: "{}", stderr: "" }; } });
  t.after(() => bridge.close());
  const request = args => ({ command: "/opt/argent-controller", args, cwd: root, environment, timeoutMs: 20_000 });
  assert.equal(JSON.parse(bridge.runner(request(["screenshot", join(root, "out", "screen.png"), "--session", "explore", "--platform", "ios", "--json"])).stdout).success, true);
  await new Promise(resolve => setTimeout(resolve, 1_500));
  assert.equal(bridge.active, false);
  assert.match(messages.join("\n"), /the Argent bridge thread failed \(the client crashed\)/);
  bridge.runner(request(["snapshot", "--json"]));
  assert.deepEqual(fallbackCalls, ["snapshot"]);
});

test("a recording runs per command, and a screenshot is taken only from a file that is an image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-argent-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "shot.png"), PNG);
  await writeFile(join(root, "notes.txt"), "not a screenshot\n");
  const answer = join(root, "answer.json");
  const clientModule = await fakeClient(root, `
    if (name === "list-devices") return { data: { devices: [{ udid: "UDID-1", name: "iPhone 17", state: "Booted", platform: "ios", runtime: "iOS 26.0" }] } };
    if (name === "screenshot") return { data: JSON.parse((await import("node:fs")).readFileSync(${JSON.stringify(answer)}, "utf8")) };
    throw new Error("unexpected tool " + name);`);
  const fallbackCalls = [];
  const environment = { EXPLORE_ARGENT_STATE: join(root, "state.json"), EXPLORE_ARGENT_PLATFORM: "ios", ARGENT_TOOLS_URL: "http://127.0.0.1:9/tools", HOME: root, PATH: process.env.PATH };
  const bridge = startArgentBridgeRunner({ command: "/opt/argent-controller", environment, clientModule,
    fallback: request => { fallbackCalls.push(request.args.slice(0, 2).join(" ")); return { stdout: "{}", stderr: "" }; } });
  t.after(() => bridge.close());
  const request = args => ({ command: "/opt/argent-controller", args, cwd: root, environment, timeoutMs: 20_000 });

  bridge.runner(request(["record", "start", join(root, "launch.mp4"), "--scope", "app", "--json"]));
  bridge.runner(request(["record", "stop", "--json"]));
  assert.deepEqual(fallbackCalls, ["record start", "record stop"], "recordings go to the per-command bridge");
  assert.ok(bridge.active);

  const screenshot = out => JSON.parse(bridge.runner({ ...request(["screenshot", out, "--session", "explore", "--platform", "ios", "--json"]), allowFailure: true }).stdout);
  // A path to a file that is not an image is not a screenshot, whatever its key; the image beside it is.
  await writeFile(answer, JSON.stringify({ path: join(root, "notes.txt"), image: join(root, "shot.png") }));
  assert.equal(screenshot(join(root, "out", "one.png")).success, true);
  assert.deepEqual(await readFile(join(root, "out", "one.png")), PNG);
  await writeFile(answer, JSON.stringify({ path: join(root, "notes.txt") }));
  const failed = screenshot(join(root, "out", "two.png"));
  assert.equal(failed.success, false);
  assert.match(failed.error.message, /did not write/);
  await assert.rejects(readFile(join(root, "out", "two.png")), { code: "ENOENT" });
});

test("the thread's lines about a tool-server still starting reach the capture's log with the command's answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "explore-argent-bridge-")); t.after(() => rm(root, { recursive: true, force: true }));
  // Argent's client asks GET /tools before each call; the first one is answered 404, as on euxy's main baseline run 39506374824.
  const clientModule = await fakeClient(root, `
    if (name === "list-devices" && calls.filter(call => call.name === "list-devices").length === 1) throw new Error("GET /tools failed: 404 Not Found");
    if (name === "list-devices") return { data: { devices: [{ udid: "UDID-1", name: "iPhone 17", state: "Booted", platform: "ios", runtime: "iOS 26.0" }] } };
    if (name === "await-screen-idle") return { data: { settled: true } };
    throw new Error("unexpected tool " + name);`);
  const messages = [];
  const environment = { EXPLORE_ARGENT_STATE: join(root, "state.json"), EXPLORE_ARGENT_PLATFORM: "ios", ARGENT_TOOLS_URL: "http://127.0.0.1:9/tools", HOME: root, PATH: process.env.PATH };
  const bridge = startArgentBridgeRunner({ command: "/opt/argent-controller", environment, clientModule, progress: message => messages.push(message),
    fallback: () => assert.fail("the thread serves every command") });
  t.after(() => bridge.close());
  const waited = JSON.parse(bridge.runner({ command: "/opt/argent-controller", args: ["wait", "stable", "--session", "explore", "--platform", "ios", "--json"], cwd: root, environment, timeoutMs: 20_000 }).stdout);
  assert.deepEqual(waited, { success: true, data: { stable: true } });
  assert.deepEqual(messages, ["Argent's tool-server is not serving its tools yet (argent run list-devices failed: GET /tools failed: 404 Not Found); sending list-devices again in 1 s (75 s left of 75 s)"]);
});

test("a refused connection to a localhost tool-server, whose cause is an AggregateError with no message, is the tool-server still starting", async () => {
  // A port nothing listens on: bound, then closed.
  const port = await new Promise(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const client = { async callTool() { const response = await fetch(`http://localhost:${port}/tools`); return { data: await response.json() }; } };
  const call = argentClientCall(client, () => new AbortController().signal);
  const refused = await call("list-devices", {}).then(() => assert.fail("nothing listens"), error => error);
  assert.match(refused.message, /^argent run list-devices failed: fetch failed: .*ECONNREFUSED/);
  // Through the bridge, the refusal is waited out like a 404 from /tools, until the window ends.
  let now = 0, tries = 0;
  const result = await runBridgeCommand(["snapshot", "--platform", "ios", "--json"], { state: { generation: 0 }, platform: "ios", version: "0.29.0",
    now: () => now, sleep: async milliseconds => { now += milliseconds; }, reachable: async () => true, moveFile: async () => {},
    call: async (tool, args, options) => { tries++; return call(tool, args, options); } });
  assert.equal(JSON.parse(result.stdout).error.code, "TOOL_SERVER_NOT_READY");
  assert.equal(tries, 11);
});

test("a failed argent run keeps the line saying /tools is not served ahead of the stack trace that follows it", () => {
  const stderr = ["[argent] Unhandled rejection: Error: GET /tools failed: 404 Not Found", "    at fetchTools (file:///argent/dist/cli-cmds.mjs:10065:21)",
    "    at async fetchTool (file:///argent/dist/cli-cmds.mjs:10070:19)", "    at async run (file:///argent/dist/cli-cmds.mjs:31166:17)",
    "    at async main (file:///argent/dist/cli.js:12:3)"].join("\n");
  const detail = argentRunFailureDetail(stderr, "");
  assert.ok(detail.startsWith("[argent] Unhandled rejection: Error: GET /tools failed: 404 Not Found |     at fetchTools "), detail);
  assert.ok(detail.endsWith("at async main (file:///argent/dist/cli.js:12:3)"), "the last frames follow it");
  assert.equal(argentRunFailureDetail("Tool \"gesture-tap\" not found. Run `argent tools` to list available tools.\n", ""), "Tool \"gesture-tap\" not found. Run `argent tools` to list available tools.");
  assert.equal(argentRunFailureDetail("GET /tools failed: 503 Service Unavailable\n", ""), "GET /tools failed: 503 Service Unavailable", "a line named once");
});
