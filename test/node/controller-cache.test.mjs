import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { AGENT_DEVICE_VERSION } from "../../dist/shared/agent-device-version.js";
import { ARGENT_VERSION } from "../../dist/shared/argent-version.js";
import { CONTROLLER_PACKAGES, agentDeviceLauncher, argentToolServerDirectory, controllerBin, controllerCacheRoot, controllerCached, controllerDirectory, controllerTarballUrl, ensureArgentToolServer, ensureController, npmEnvironment } from "../../dist/shared/controller-cache.js";

/** A gzip tarball of `entries` ({ name, contents?, type?, mode?, link? }), laid out as npm publishes one. */
function tarball(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write(`${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(`${(entry.type === "0" || !entry.type ? contents.length : 0).toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(entry.type ?? "0", 156);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (!entry.type || entry.type === "0") blocks.push(contents, Buffer.alloc((512 - (contents.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function harness(t, entries, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-controller-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = tarball(entries);
  const environment = { EXPLORE_CONTROLLER_CACHE: join(root, "cache") };
  const packages = { ...CONTROLLER_PACKAGES, "agent-device": { ...CONTROLLER_PACKAGES["agent-device"], integrity: options.integrity ?? integrity(bytes) } };
  const requests = [];
  const fetch = async url => { requests.push(String(url)); return new Response(bytes); };
  return { root, environment, requests, ensure: () => ensureController("agent-device", { environment, fetch, packages }) };
}

const CLI = { name: "package/bin/agent-device.mjs", contents: "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n" };

test("the pinned controllers are the versions Explore drives, and agent-device matches the lockfile Explore tests with", async () => {
  assert.equal(CONTROLLER_PACKAGES["agent-device"].version, AGENT_DEVICE_VERSION);
  assert.equal(CONTROLLER_PACKAGES.argent.version, ARGENT_VERSION);
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["agent-device"], undefined, "agent-device is fetched on use, not installed with Explore");
  assert.equal(manifest.dependencies["@swmansion/argent"], undefined, "Argent is fetched on use, not installed with Explore");
  assert.equal(manifest.devDependencies["agent-device"], AGENT_DEVICE_VERSION);
  assert.equal(lock.packages["node_modules/agent-device"].integrity, CONTROLLER_PACKAGES["agent-device"].integrity);
});

test("tarballs come from the npm registry, or a mirror, at the pinned version", () => {
  assert.equal(controllerTarballUrl("argent", {}), `https://registry.npmjs.org/@swmansion/argent/-/argent-${ARGENT_VERSION}.tgz`);
  assert.equal(controllerTarballUrl("agent-device", { EXPLORE_NPM_REGISTRY: "https://npm.example.com/" }),
    `https://npm.example.com/agent-device/-/agent-device-${AGENT_DEVICE_VERSION}.tgz`);
  assert.equal(controllerCacheRoot({ HOME: "/home/me" }), "/home/me/.cache/expo-explore/controllers");
  assert.equal(controllerCacheRoot({ HOME: "/home/me", XDG_CACHE_HOME: "/cache" }), "/cache/expo-explore/controllers");
  assert.match(controllerDirectory("argent", { EXPLORE_CONTROLLER_CACHE: "/c" }), new RegExp(`^/c/@swmansion\\+argent@${ARGENT_VERSION}$`));
});

test("a controller is fetched once, verified, unpacked, and its entry made executable", async t => {
  const f = await harness(t, [{ name: "package/", type: "5", mode: 0o755 }, CLI, { name: "package/package.json", contents: "{}" }]);
  const bin = await f.ensure();
  assert.equal(bin, controllerBin("agent-device", f.environment));
  assert.equal(statSync(bin).mode & 0o111, 0o111);
  assert.ok(controllerCached("agent-device", f.environment));
  assert.equal(await f.ensure(), bin);
  assert.equal(f.requests.length, 1, "a cached controller is not fetched again");
  assert.deepEqual((await readdir(join(f.root, "cache"))).filter(name => name.startsWith(".staging")), [], "no staging files are left");
});

test("a tarball that does not match the pinned integrity is never unpacked", async t => {
  const f = await harness(t, [CLI], { integrity: "sha512-not-the-release" });
  await assert.rejects(f.ensure(), error => error.code === "CONTROLLER_INTEGRITY_MISMATCH");
  assert.equal(controllerCached("agent-device", f.environment), false);
  assert.equal(existsSync(controllerDirectory("agent-device", f.environment)), false);
});

test("links and paths outside the package are refused", async t => {
  for (const entry of [{ name: "package/evil", type: "2", link: "/etc/passwd" }, { name: "package/../escape.js", contents: "x" }, { name: "other/file.js", contents: "x" }]) {
    const f = await harness(t, [CLI, entry]);
    await assert.rejects(f.ensure(), error => error.code === "CONTROLLER_DOWNLOAD_FAILED", entry.name);
    assert.equal(controllerCached("agent-device", f.environment), false);
  }
});

test("a registry failure names the release and the mirror setting", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-controller-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(ensureController("agent-device", { environment: { EXPLORE_CONTROLLER_CACHE: root }, fetch: async () => new Response("no", { status: 404 }) }),
    error => error.code === "CONTROLLER_DOWNLOAD_FAILED" && /agent-device@/.test(error.message) && /EXPLORE_NPM_REGISTRY/.test(error.nextAction));
});

test("the agent-device command runs the cached release with the caller's arguments, without a network", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-controller-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { EXPLORE_CONTROLLER_CACHE: join(root, "cache") };
  const directory = controllerDirectory("agent-device", environment);
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "bin/agent-device.mjs"), CLI.contents, { mode: 0o755 });
  await writeFile(join(directory, ".explore-controller.json"), "{}\n");
  const command = agentDeviceLauncher(environment);
  assert.equal(agentDeviceLauncher(environment), command, "the command is stable");
  assert.match(command, new RegExp(`/bin/agent-device-${AGENT_DEVICE_VERSION}-[0-9a-f]{12}$`), "the command names its release");
  const mirrored = agentDeviceLauncher({ ...environment, EXPLORE_NPM_REGISTRY: "https://npm.example.com" });
  assert.notEqual(mirrored, command, "another setup gets a command of its own instead of rewriting this one");
  assert.match(await readFile(mirrored, "utf8"), /EXPLORE_NPM_REGISTRY='https:\/\/npm\.example\.com'/, "the mirror reaches the narrowed controller environment");
  // The command names its cache, so a caller that narrows the environment still reaches it.
  const run = spawnSync(command, ["snapshot", "--json", "--", "-h"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ["snapshot", "--json", "--", "-h"]);
});

test("the tool-server's shipped lockfile locks the Argent release Explore pins, and every package with an integrity", async () => {
  const lock = JSON.parse(await readFile(new URL("../../controllers/argent-tool-server/package-lock.json", import.meta.url), "utf8"));
  const argent = lock.packages["node_modules/@swmansion/argent"];
  assert.deepEqual([argent.version, argent.integrity], [CONTROLLER_PACKAGES.argent.version, CONTROLLER_PACKAGES.argent.integrity]);
  const unlocked = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.link && !/^sha512-/.test(entry.integrity ?? ""));
  assert.deepEqual(unlocked.map(([path]) => path), [], "every package is locked to its tarball");
  const manifest = JSON.parse(await readFile(new URL("../../controllers/argent-tool-server/package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.dependencies, { "@swmansion/argent": CONTROLLER_PACKAGES.argent.version });
  assert.ok(JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")).files.includes("controllers/argent-tool-server"), "it ships with Explore");
});

test("the tool-server installs from the shipped lockfile into a folder named for it, once", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-tool-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { EXPLORE_CONTROLLER_CACHE: root, HOME: root };
  const installs = [];
  const install = async directory => {
    installs.push(await readdir(directory));
    // npm ci leaves the lockfile it installed from, and the package under node_modules.
    await mkdir(join(directory, "node_modules", "@swmansion", "argent", "dist"), { recursive: true });
  };
  const cli = await ensureArgentToolServer({ environment, install });
  assert.ok(cli.startsWith(argentToolServerDirectory(root)));
  assert.match(argentToolServerDirectory(root), /argent-tool-server@0\.29\.0-[0-9a-f]{12}$/);
  assert.deepEqual(installs, [["package-lock.json", "package.json"]]);
  assert.equal(await ensureArgentToolServer({ environment, install }), cli);
  assert.equal(installs.length, 1, "an installed copy is reused");
});

test("npm installing the tool-server gets what reaches the registry and none of a capture's secrets", () => {
  const passed = npmEnvironment({ PATH: "/usr/bin", HOME: "/home/me", TMPDIR: "/tmp/me", HTTPS_PROXY: "http://proxy", npm_config_registry: "https://mirror",
    EXPO_TOKEN: "expo", GITHUB_TOKEN: "github", ANTHROPIC_API_KEY: "key", OPENAI_API_KEY: "key", AGENT_DEVICE_DAEMON_AUTH_TOKEN: "token" });
  assert.deepEqual(Object.keys(passed).sort(), ["HOME", "HTTPS_PROXY", "PATH", "TMPDIR", "npm_config_registry"]);
});
