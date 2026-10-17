import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalCaptureRecord, sweepLocalCaptures } from "../../dist/capture/local-registry.js";

const UDID = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D";
const DEAD = 999999999;

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "explore-local-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // HOME is the scratch root, so the registry and port locks live in its .cache/expo-explore.
  return { root, environment: { PATH: process.env.PATH, HOME: root, ANDROID_HOME: join(root, "sdk") }, registry: join(root, ".cache", "expo-explore", "local-captures") };
}

/** A runner that records commands: adb lists nothing (the emulator is gone after emu kill) and pgrep finds no process. */
function recordingRunner() {
  const requests = [];
  const runner = request => { requests.push([request.command.split("/").at(-1), ...request.args]); return { stdout: "", stderr: "" }; };
  return { requests, runner };
}

test("a capture's record names what it started, and goes once everything is stopped", async t => {
  const { root, environment, registry } = await scratch(t);
  const record = await openLocalCaptureRecord(environment, join(root, "session"));
  const [file] = await readdir(registry);
  await record.update({ udid: UDID });
  await record.update({ argent: { pid: 4242, cli: "/cli.js", home: "/home" } });
  const saved = JSON.parse(await readFile(join(registry, file), "utf8"));
  assert.equal(saved.owner, process.pid);
  assert.equal(saved.directory, join(root, "session"));
  assert.equal(saved.udid, UDID);
  assert.deepEqual(saved.argent, { pid: 4242, cli: "/cli.js", home: "/home" });
  await record.close();
  assert.deepEqual(await readdir(registry), []);
});

test("a review sweeps what a capture stopped hard left running: its simulator, emulator, daemon, tool-server and files", async t => {
  const { root, environment, registry } = await scratch(t);
  await mkdir(registry, { recursive: true });
  const directory = join(root, "expo-explore-session-old");
  await mkdir(join(directory, "agent-device-state"), { recursive: true });
  // Stand-ins for the orphaned agent-device daemon and Argent tool-server.
  const daemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { daemon.kill("SIGKILL"); server.kill("SIGKILL"); });
  const exited = child => new Promise(resolve => child.once("exit", () => resolve(true)));
  const daemonExited = exited(daemon), serverExited = exited(server);
  await writeFile(join(directory, "agent-device-state", "daemon.json"), JSON.stringify({ pid: daemon.pid }));
  await writeFile(join(registry, "old.json"), JSON.stringify({ owner: DEAD, startedAt: "2026-10-17T00:00:00.000Z", directory, udid: UDID,
    serial: "emulator-5556", avd: "explore-base-d6227297", argent: { pid: server.pid, cli: join(root, "missing-cli.js"), home: join(root, "argent-home") } }));
  const { requests, runner } = recordingRunner();
  const swept = await sweepLocalCaptures({ environment, runner, cwd: root });
  assert.deepEqual(swept, [`Argent tool-server (pid ${server.pid})`, "agent-device daemon", `simulator ${UDID}`, "emulator emulator-5556"]);
  assert.ok(await daemonExited && await serverExited, "the daemon and tool-server are stopped");
  assert.ok(requests.some(request => request.join(" ") === `xcrun simctl delete ${UDID}`));
  assert.ok(requests.some(request => request.join(" ") === "adb -s emulator-5556 emu kill"));
  assert.equal(existsSync(directory), false, "its files go");
  assert.deepEqual(await readdir(registry), [], "and so does its record");
});

test("a sweep leaves a live capture's record alone, and an emulator whose port a live capture now holds", async t => {
  const { root, environment, registry } = await scratch(t);
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, "live.json"), JSON.stringify({ owner: process.pid, startedAt: "2026-10-17T00:00:00.000Z", directory: join(root, "live"), udid: UDID }));
  // A dead capture's emulator port, since reserved by this (live) process for its own emulator.
  const ports = join(root, ".cache", "expo-explore", "emulator-ports");
  await mkdir(ports, { recursive: true });
  await writeFile(join(ports, "5554.lock"), String(process.pid));
  await writeFile(join(registry, "dead.json"), JSON.stringify({ owner: DEAD, startedAt: "2026-10-17T00:00:00.000Z", directory: join(root, "dead"), serial: "emulator-5554" }));
  const { requests, runner } = recordingRunner();
  const swept = await sweepLocalCaptures({ environment, runner, cwd: root });
  assert.deepEqual(swept, ["agent-device daemon"]);
  assert.equal(requests.some(request => request.includes("simctl") || request.includes("emu")), false, "nothing live is stopped");
  assert.deepEqual((await readdir(registry)).sort(), ["live.json"]);
});
