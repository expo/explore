import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const cli = join(root, "dist", "cli.js");
const { defaultOutputDirectory, expiresInDays } = await import(join(root, "dist", "cli", "binary-commands.js"));

function fail(args) {
  // Without an EAS login (as on CI) argument and archive errors must still come first.
  const result = spawnSync(process.execPath, [cli, "explore:binary", ...args, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, EXPO_TOKEN: "", EXPO_SESSION_SECRET: "" } });
  assert.notEqual(result.status, 0, result.stdout);
  // Progress lines precede the structured error on stderr.
  const payload = JSON.parse(result.stderr.trim().split("\n").at(-1));
  assert.equal(payload.ok, false); assert.equal(payload.command, "explore:binary");
  return payload.error;
}

test("explore:binary is in the short help with its archive kinds and --no-upload", () => {
  const help = spawnSync(process.execPath, [cli, "help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /explore:binary <app\.apk \| app\.app \| app\.tar\.gz \| simulator \.ipa>.*--no-upload/);
});

test("explore:binary validates its arguments before touching EAS or a model", () => {
  assert.match(fail([]), /Pass the app archive/);
  assert.match(fail(["./app.apk", "--upload", "--no-upload"]), /either --upload or --no-upload/);
  assert.match(fail(["./app.apk", "--expires-in", "400d"]), /--expires-in must be 1d to 90d, or never/);
  assert.match(fail(["./app.apk", "--platform", "web"]), /platform/);
  assert.match(fail(["./does-not-exist.apk", "--no-upload"]), /Archive not found: .*does-not-exist\.apk/);
  assert.match(fail(["./package.json", "--no-upload"]), /Unsupported archive: package\.json/);
  const human = spawnSync(process.execPath, [cli, "explore:binary", "./does-not-exist.apk", "--no-upload"], { cwd: root, encoding: "utf8", env: { ...process.env, EXPO_TOKEN: "", EXPO_SESSION_SECRET: "" } });
  assert.notEqual(human.status, 0);
  assert.match(human.stderr, /Archive not found: .*does-not-exist\.apk\n→ Check the path/);
});

test("expiry and output directory defaults", () => {
  assert.equal(expiresInDays("7d"), 7); assert.equal(expiresInDays("90d"), 90); assert.equal(expiresInDays("never"), null);
  assert.throws(() => expiresInDays("0d")); assert.throws(() => expiresInDays("7")); assert.throws(() => expiresInDays("91d"));
  const now = new Date("2026-10-11T16:28:48.123Z");
  assert.equal(defaultOutputDirectory("/builds/euxy-ios.tar.gz", now), "explore-euxy-ios-20261011-1628");
  assert.equal(defaultOutputDirectory("My App (1).app", now), "explore-My-App-1-20261011-1628");
  assert.equal(defaultOutputDirectory("/x/.apk", now), "explore-app-20261011-1628");
});

function failSession(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, "explore:session", ...args, "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, EAS_SIMULATOR_SESSION_ID: "", AGENT_DEVICE_DAEMON_BASE_URL: "", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "", ...env } });
  assert.notEqual(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stderr.trim().split("\n").at(-1));
  assert.equal(payload.ok, false); assert.equal(payload.command, "explore:session");
  return payload.error;
}

test("explore:session is in the help and validates its inputs before touching EAS", () => {
  const help = spawnSync(process.execPath, [cli, "help"], { cwd: root, encoding: "utf8" });
  assert.match(help.stdout, /explore:session \[SESSION_ID\] \[--bundle-id ID\].*--upload/);
  assert.match(failSession([]), /No EAS Simulator session connection was found/);
  assert.match(failSession(["--bundle-id", "bad id"]), /not a bundle or package id/);
  assert.match(failSession(["--bundle-id", "dev.example.app"]), /No EAS Simulator session connection was found/);
  assert.match(failSession(["01a1-other", "--bundle-id", "dev.example.app"], { EAS_SIMULATOR_SESSION_ID: "01a1-mine", AGENT_DEVICE_DAEMON_BASE_URL: "https://daemon.example", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "t" }),
    /EAS_SIMULATOR_SESSION_ID is 01a1-mine, not 01a1-other/);
  const human = spawnSync(process.execPath, [cli, "explore:session", "--bundle-id", "dev.example.app"], { cwd: root, encoding: "utf8", env: { ...process.env, EAS_SIMULATOR_SESSION_ID: "" } });
  assert.notEqual(human.status, 0);
  assert.match(human.stderr, /No EAS Simulator session connection was found[^\n]*\n→ Start one with `eas simulator:start --type agent-device --out-config-type dotenv`/);
});

test("explore:session picks up ./.env.eas-simulator from the current directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "explore-session-cwd-"));
  try {
    await writeFile(join(cwd, ".env.eas-simulator"), ["# Do not commit this file.", "# Do not modify these values manually. They are managed by eas-cli.", "# It holds configuration only for the current simulator session.", "", "EAS_SIMULATOR_SESSION_ID='01a1-file'", "AGENT_DEVICE_DAEMON_BASE_URL='https://daemon.example'", "AGENT_DEVICE_DAEMON_AUTH_TOKEN='t'",
      // A session started with `--egress local` also carries the egress client's settings.
      "EAS_SIMULATOR_EGRESS_URL='wss://egress.example'", "EAS_SIMULATOR_EGRESS_TOKEN='e'", "EAS_SIMULATOR_EGRESS_FINGERPRINT='f'",
      "EAS_SIMULATOR_EGRESS_PORT='443'", "EAS_SIMULATOR_EGRESS_ALLOW='localhost:8081'", "EAS_SIMULATOR_EGRESS_PLATFORM='ios'", ""].join("\n"));
    const env = { ...process.env, EAS_SIMULATOR_SESSION_ID: "", AGENT_DEVICE_DAEMON_BASE_URL: "", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "" };
    const mismatch = spawnSync(process.execPath, [cli, "explore:session", "01a1-other", "--json"], { cwd, encoding: "utf8", env });
    assert.notEqual(mismatch.status, 0);
    assert.match(JSON.parse(mismatch.stderr.trim().split("\n").at(-1)).error, /\.env\.eas-simulator describes session 01a1-file, not 01a1-other/);
    const fromEnvironment = spawnSync(process.execPath, [cli, "explore:session", "01a1-other", "--json"], { cwd, encoding: "utf8", env: { ...env, EAS_SIMULATOR_SESSION_ID: "01a1-env" } });
    assert.match(JSON.parse(fromEnvironment.stderr.trim().split("\n").at(-1)).error, /EAS_SIMULATOR_SESSION_ID is 01a1-env, not 01a1-other/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("attached sessions are proven live, agent-device typed, and served by the given connection", async () => {
  const { assertAttachedSimulatorSession, resolveAttachedSimulatorSession } = await import(join(root, "dist", "capture", "simulator.js"));
  const connection = { sessionId: "01a1-mine", daemonBaseUrl: "https://daemon.example.eas.dev", daemonAuthToken: "secret" };
  const session = (overrides = {}) => JSON.stringify({ id: "01a1-mine", name: "mine", type: "agent-device", status: "IN_PROGRESS", platform: "IOS",
    deviceRunSessionUrl: "https://expo.dev/accounts/a/projects/p/simulator-sessions/01a1-mine", remoteConfig: { agentDeviceRemoteSessionUrl: connection.daemonBaseUrl, agentDeviceRemoteSessionToken: "secret" }, ...overrides });
  assert.deepEqual(assertAttachedSimulatorSession(session(), connection), { platform: "ios", name: "mine", deviceRunSessionUrl: "https://expo.dev/accounts/a/projects/p/simulator-sessions/01a1-mine" });
  assert.equal(assertAttachedSimulatorSession(session({ platform: "ANDROID" }), connection).platform, "android");
  assert.throws(() => assertAttachedSimulatorSession(session({ status: "FINISHED" }), connection), /is finished, not in progress/);
  assert.throws(() => assertAttachedSimulatorSession(session({ type: "interactive" }), connection), /agent-device/);
  assert.throws(() => assertAttachedSimulatorSession(session({ platform: "ANDROID" }), connection, "ios"), /is android, not ios/);
  assert.throws(() => assertAttachedSimulatorSession(session({ remoteConfig: { agentDeviceRemoteSessionUrl: connection.daemonBaseUrl, agentDeviceRemoteSessionToken: "other" } }), connection), /different agent-device connection/);
  assert.throws(() => assertAttachedSimulatorSession(session({ id: "01a1-other" }), connection), /attached agent-device session/);
  const env = { EAS_SIMULATOR_SESSION_ID: "01a1-mine", AGENT_DEVICE_DAEMON_BASE_URL: connection.daemonBaseUrl, AGENT_DEVICE_DAEMON_AUTH_TOKEN: "secret" };
  assert.deepEqual(await resolveAttachedSimulatorSession(env, undefined), connection);
  assert.deepEqual(await resolveAttachedSimulatorSession(env, undefined, "01a1-mine"), connection);
  await assert.rejects(resolveAttachedSimulatorSession({}, undefined), /EAS_SIMULATOR_SESSION_ID did not return a session id/);
  await assert.rejects(resolveAttachedSimulatorSession({ ...env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: "" }, undefined), /unsafe agent-device connection/);
});
