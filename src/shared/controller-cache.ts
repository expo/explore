/**
 * The device controllers Explore drives, fetched on first use instead of installed with Explore. Each is pinned to
 * an exact npm release and its sha512 integrity; the tarball is checked before anything in it is written, nothing in
 * it runs at install time, and neither controller needs other packages at run time. Argent's tool-server, which a
 * local simulator needs, is the exception: ensureArgentToolServer installs it with its dependencies.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRelativePath, walkTar } from "../binary/archive.js";
import { CiError } from "./ci-errors.js";
import { AGENT_DEVICE_VERSION } from "./agent-device-version.js";
import { ARGENT_VERSION } from "./argent-version.js";

export type ControllerName = "agent-device" | "argent";

/** Each controller's npm release, the file Explore runs from it, and the integrity npm publishes for it. */
export const CONTROLLER_PACKAGES: Record<ControllerName, { name: string; version: string; bin: string; integrity: string }> = {
  "agent-device": { name: "agent-device", version: AGENT_DEVICE_VERSION, bin: "bin/agent-device.mjs",
    integrity: "sha512-Om1j6oNJkeKlkk8lBM+0V9bKwpxUXLMf/PDDSvAt3RFquBRqAiM58J81E0rvPQNxs6GCjhABYpwVvIAXptxjjA==" },
  argent: { name: "@swmansion/argent", version: ARGENT_VERSION, bin: "dist/cli.js",
    integrity: "sha512-XXWlWZJlHKqnAvNx3RDhuiVFQOPqh5EDB76+mFAyqC2mutC6irzw03+M/6S/WQ+Dzz2IYOkEfOzQnOOdhrGgJg==" },
};

const COMPLETE = ".explore-controller.json";
const MAX_CONTROLLER_BYTES = 256 * 1024 * 1024;
const LAUNCHER = fileURLToPath(new URL("../capture/controller-launcher.js", import.meta.url));

/** Where fetched controllers live: EXPLORE_CONTROLLER_CACHE, else the user's cache directory. */
export function controllerCacheRoot(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.EXPLORE_CONTROLLER_CACHE) return resolve(environment.EXPLORE_CONTROLLER_CACHE);
  const base = environment.XDG_CACHE_HOME || join(environment.HOME || homedir(), ".cache");
  return join(base, "expo-explore", "controllers");
}

export function controllerDirectory(controller: ControllerName, environment: NodeJS.ProcessEnv = process.env): string {
  const { name, version } = CONTROLLER_PACKAGES[controller];
  return join(controllerCacheRoot(environment), `${name.replace("/", "+")}@${version}`);
}

/** The controller's entry file in the cache; it exists once `ensureController` has run. */
export function controllerBin(controller: ControllerName, environment: NodeJS.ProcessEnv = process.env): string {
  return join(controllerDirectory(controller, environment), CONTROLLER_PACKAGES[controller].bin);
}

export function controllerCached(controller: ControllerName, environment: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(controllerDirectory(controller, environment), COMPLETE));
}

/** The registry tarball for a release, from EXPLORE_NPM_REGISTRY (a mirror) or the public npm registry. */
export function controllerTarballUrl(controller: ControllerName, environment: NodeJS.ProcessEnv = process.env): string {
  const { name, version } = CONTROLLER_PACKAGES[controller];
  const registry = (environment.EXPLORE_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  return `${registry}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
}

/**
 * The command that runs agent-device: a small script in the cache that fetches the pinned release on first use and
 * then runs it with the same arguments. It names the cache, so a caller that narrows the environment (no HOME) still
 * finds it. Written synchronously, so capture options can name it before any controller call.
 */
export function agentDeviceLauncher(environment: NodeJS.ProcessEnv = process.env): string {
  const root = controllerCacheRoot(environment);
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  // The registry is part of the command too: controller calls run with a narrowed environment that drops it.
  const registry = environment.EXPLORE_NPM_REGISTRY ? ` EXPLORE_NPM_REGISTRY=${quote(environment.EXPLORE_NPM_REGISTRY)}` : "";
  const script = `#!/bin/sh\nEXPLORE_CONTROLLER_CACHE=${quote(root)}${registry} exec ${quote(process.execPath)} ${quote(LAUNCHER)} agent-device "$@"\n`;
  // One command per pinned release and installation, so two Explore installs on a machine never swap each other's
  // controller in the middle of a capture.
  const digest = createHash("sha256").update(script).digest("hex").slice(0, 12);
  const command = join(root, "bin", `agent-device-${CONTROLLER_PACKAGES["agent-device"].version}-${digest}`);
  if (existsSync(command) && readFileSync(command, "utf8") === script) return command;
  mkdirSync(dirname(command), { recursive: true, mode: 0o700 });
  const temporary = `${command}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, script, { mode: 0o755 });
  renameSync(temporary, command);
  return command;
}

/** A fetch killed mid-download (a timed-out controller call) leaves its staging files; clear any over an hour old. */
async function removeAbandonedStaging(root: string): Promise<void> {
  const cutoff = Date.now() - 60 * 60_000;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(".staging-")) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }
}

function downloadFailed(controller: ControllerName, message: string): CiError {
  const { name, version } = CONTROLLER_PACKAGES[controller];
  return new CiError({ code: "CONTROLLER_DOWNLOAD_FAILED", stage: "preflight", message: `${name}@${version} could not be fetched: ${message}`,
    nextAction: "Check that this machine can reach the npm registry (or set EXPLORE_NPM_REGISTRY to a mirror that serves it), then rerun." });
}

/**
 * Fetches the pinned controller into the cache once and returns its entry file. The download is hashed while it
 * streams and must match the pinned integrity before it is unpacked; only regular files and directories inside the
 * package are written, and the finished directory is renamed into place, so concurrent runs never see half of it.
 */
export async function ensureController(controller: ControllerName, options: {
  environment?: NodeJS.ProcessEnv; fetch?: typeof fetch; progress?: (message: string) => void;
  /** Tests: releases built on the spot instead of the pinned npm ones. */
  packages?: typeof CONTROLLER_PACKAGES;
} = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const pinned = (options.packages ?? CONTROLLER_PACKAGES)[controller];
  const directory = controllerDirectory(controller, environment);
  const bin = join(directory, pinned.bin);
  if (controllerCached(controller, environment)) return bin;
  const root = controllerCacheRoot(environment);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await removeAbandonedStaging(root);
  const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
  const tarball = `${staging}.tgz`;
  try {
    options.progress?.(`fetching ${pinned.name}@${pinned.version}`);
    let response: Response;
    try { response = await (options.fetch ?? fetch)(controllerTarballUrl(controller, environment)); }
    catch (error) { throw downloadFailed(controller, error instanceof Error ? error.message : String(error)); }
    if (!response.ok || !response.body) throw downloadFailed(controller, `the registry answered ${response.status}`);
    const hash = createHash("sha512");
    const file = await open(tarball, "wx", 0o600);
    let bytes = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > MAX_CONTROLLER_BYTES) throw downloadFailed(controller, "the tarball is larger than expected");
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally { await file.close(); }
    const integrity = `sha512-${hash.digest("base64")}`;
    if (integrity !== pinned.integrity) {
      throw new CiError({ code: "CONTROLLER_INTEGRITY_MISMATCH", stage: "preflight",
        message: `${pinned.name}@${pinned.version} from the registry does not match the release Explore pins (${integrity}).`,
        nextAction: "Do not use this registry for Explore's controllers; unset EXPLORE_NPM_REGISTRY or point it at a faithful mirror." });
    }
    await mkdir(staging, { mode: 0o700 });
    let written = 0;
    await walkTar(tarball, async (entry, contents) => {
      const relative = safeRelativePath(entry.name);
      if (relative === "package" && entry.type === "5") return;
      if (!relative || !relative.startsWith("package/")) throw downloadFailed(controller, `the tarball has an entry outside the package (${entry.name})`);
      const target = join(staging, relative.slice("package/".length));
      if (!target.startsWith(`${staging}${sep}`)) throw downloadFailed(controller, `the tarball has an unsafe entry (${entry.name})`);
      if (entry.type === "5") { await mkdir(target, { recursive: true }); return; }
      if (entry.type !== "0") throw downloadFailed(controller, `the tarball has a link or special file (${entry.name})`);
      written += entry.size;
      if (written > MAX_CONTROLLER_BYTES) throw downloadFailed(controller, "the package is larger than expected");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await contents(), { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    });
    if (!existsSync(join(staging, pinned.bin))) throw downloadFailed(controller, `the package has no ${pinned.bin}`);
    await chmod(join(staging, pinned.bin), 0o755);
    await writeFile(join(staging, COMPLETE), `${JSON.stringify({ name: pinned.name, version: pinned.version, integrity })}\n`);
    try { await rename(staging, directory); }
    catch (error) {
      // Another run finished first; its copy is the same verified release.
      if (!controllerCached(controller, environment)) throw error;
    }
    return bin;
  } finally {
    await rm(tarball, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Argent's tool-server, for driving simulators on this machine (`capture.simulator: local`): unlike the client, it
 * needs Argent's dependencies, some native (sharp, tree-sitter). They are installed once, on first use, with npm and
 * without running any package's install scripts; Argent itself must be the release Explore pins. Returns its CLI.
 */
export async function ensureArgentToolServer(options: { environment?: NodeJS.ProcessEnv; progress?: (message: string) => void;
  /** Tests: stands in for `npm install`, given the folder to install into. */
  install?: (directory: string) => Promise<void> } = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const pinned = CONTROLLER_PACKAGES.argent;
  const root = controllerCacheRoot(environment);
  const directory = join(root, `argent-tool-server@${pinned.version}`);
  const cli = join(directory, "node_modules", "@swmansion", "argent", pinned.bin);
  if (existsSync(join(directory, COMPLETE))) return cli;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await removeAbandonedStaging(root);
  const staging = join(root, `.staging-${process.pid}-${randomUUID()}`);
  try {
    options.progress?.(`installing Argent's tool-server (${pinned.name}@${pinned.version} and its dependencies)`);
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, "package.json"), `${JSON.stringify({ private: true })}\n`);
    await (options.install ?? (async target => {
      const registry = environment.EXPLORE_NPM_REGISTRY ? ["--registry", environment.EXPLORE_NPM_REGISTRY] : [];
      const npm = spawnSync("npm", ["install", `${pinned.name}@${pinned.version}`, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", ...registry],
        { cwd: target, env: environment, encoding: "utf8", timeout: 10 * 60_000 });
      if (npm.error || npm.status !== 0) throw new CiError({ code: "CONTROLLER_DOWNLOAD_FAILED", stage: "preflight",
        message: `Argent's tool-server could not be installed: ${(npm.error?.message ?? npm.stderr ?? "").trim().split("\n").at(-1) ?? "npm failed"}`,
        nextAction: "Check that npm is on PATH and can reach the registry (or set EXPLORE_NPM_REGISTRY), then rerun." });
    }))(staging);
    // npm checked every package against the registry; Argent itself must also be the exact release Explore pins.
    const lock = JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string; integrity?: string }> };
    const installed = lock.packages?.[`node_modules/${pinned.name}`];
    if (installed?.version !== pinned.version || installed.integrity !== pinned.integrity) throw new CiError({ code: "CONTROLLER_INTEGRITY_MISMATCH", stage: "preflight",
      message: `The ${pinned.name} npm installed (${installed?.version ?? "none"}, ${installed?.integrity ?? "no integrity"}) is not the release Explore pins.`,
      nextAction: "Do not use this registry for Explore's controllers; unset EXPLORE_NPM_REGISTRY or point it at a faithful mirror." });
    await writeFile(join(staging, COMPLETE), `${JSON.stringify({ name: pinned.name, version: pinned.version, integrity: pinned.integrity })}\n`);
    // Several captures may install at once; the first to finish keeps its copy.
    try { await rename(staging, directory); }
    catch (error) { if (!existsSync(join(directory, COMPLETE))) throw error; }
    return cli;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
