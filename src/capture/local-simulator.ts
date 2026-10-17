import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { apkAbis } from "../binary/archive.js";
import { CiError } from "../shared/ci-errors.js";
import { isRecord, parseJson } from "./common.js";
import type { CommandRunner } from "./run.js";

/**
 * A simulator Explore creates on this Mac for one capture (`capture.simulator: local`), in place of an EAS Simulator
 * session. Each capture gets its own device, so head and base run side by side without sharing app state, and the
 * device is deleted when the capture ends.
 */
export type LocalSimulator = { udid: string; name: string; deviceType: string; runtime: string; osVersion: string };

/** A session state file names a local simulator with this prefix, so an interrupted review deletes it rather than calling EAS. */
export const LOCAL_SIMULATOR_STATE_PREFIX = "simctl-";

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

function simctl(runner: CommandRunner, args: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs = 60_000, allowFailure = false) {
  return runner({ command: "xcrun", args: ["simctl", ...args], cwd, environment, timeoutMs, ...(allowFailure ? { allowFailure } : {}) });
}

function versionKey(version: string): number[] {
  return version.split(".").map(part => Number.parseInt(part, 10) || 0);
}

function newer(left: string, right: string): boolean {
  const a = versionKey(left), b = versionKey(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

/** The device type named like the configured device, and the newest installed iOS runtime that runs it. */
export function localSimulatorTarget(devicetypes: string, runtimes: string, device: string): { deviceType: string; runtime: string; osVersion: string } {
  const types = parseJson(devicetypes, "simctl list devicetypes");
  const type = (isRecord(types) && Array.isArray(types.devicetypes) ? types.devicetypes : [])
    .find(entry => isRecord(entry) && entry.name === device);
  if (!isRecord(type) || typeof type.identifier !== "string") throw new CiError({ code: "LOCAL_SIMULATOR_DEVICE_UNAVAILABLE", stage: "session",
    message: `This Mac's Xcode has no ${device} simulator.`,
    nextAction: `Set device.name in config.yaml to a simulator listed by xcrun simctl list devicetypes, or install the Xcode that adds ${device} and select it with xcode-select.` });
  const listed = parseJson(runtimes, "simctl list runtimes");
  let best: { runtime: string; osVersion: string } | undefined;
  for (const entry of isRecord(listed) && Array.isArray(listed.runtimes) ? listed.runtimes : []) {
    if (!isRecord(entry) || entry.isAvailable !== true || entry.platform !== "iOS" || typeof entry.identifier !== "string" || typeof entry.version !== "string") continue;
    const supported = Array.isArray(entry.supportedDeviceTypes) && entry.supportedDeviceTypes.some(supportedType => isRecord(supportedType) && supportedType.identifier === type.identifier);
    if (supported && (!best || newer(entry.version, best.osVersion))) best = { runtime: entry.identifier, osVersion: entry.version };
  }
  if (!best) throw new CiError({ code: "LOCAL_SIMULATOR_RUNTIME_UNAVAILABLE", stage: "session",
    message: `No installed iOS simulator runtime runs ${device}.`,
    nextAction: "Install an iOS simulator runtime in Xcode (Settings > Components) that supports this device, then rerun." });
  return { deviceType: type.identifier, ...best };
}

/**
 * Creates a fresh simulator of the configured device and starts it booting. `simctl boot` returns while the device is
 * still starting, so a capture boots it before repacking the app and waits for it (waitForLocalSimulator) afterwards.
 */
export async function createLocalSimulator(options: { runner: CommandRunner; device: string; name: string; cwd: string; environment: NodeJS.ProcessEnv;
  /** Called with the new device's UDID before it boots, so a caller can record it for cleanup. */
  created?: (udid: string) => void | Promise<void> }): Promise<LocalSimulator> {
  const { runner, cwd, environment } = options;
  const target = localSimulatorTarget(simctl(runner, ["list", "devicetypes", "-j"], cwd, environment).stdout,
    simctl(runner, ["list", "runtimes", "-j"], cwd, environment).stdout, options.device);
  const udid = simctl(runner, ["create", options.name, target.deviceType, target.runtime], cwd, environment).stdout.trim();
  if (!UDID.test(udid)) throw new Error("simctl create did not return a simulator UDID");
  await options.created?.(udid);
  simctl(runner, ["boot", udid], cwd, environment, 5 * 60_000);
  return { udid, name: options.name, ...target };
}

/** Waits until a simulator createLocalSimulator started has finished booting. */
export function waitForLocalSimulator(options: { runner: CommandRunner; udid: string; cwd: string; environment: NodeJS.ProcessEnv }): void {
  simctl(options.runner, ["bootstatus", options.udid, "-b"], options.cwd, options.environment, 5 * 60_000);
}

/**
 * Lets the app open its own links without iOS asking "Open in “App”?" first, as a person would have approved it once.
 * EAS Simulator gives no access to the device, so its captures still answer the prompt (route-capture.ts); a local
 * simulator never shows it.
 */
export function approveLinkScheme(options: { runner: CommandRunner; udid: string; scheme: string; bundleId: string; cwd: string; environment: NodeJS.ProcessEnv }): void {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(options.scheme)) throw new Error("Not a URL scheme");
  simctl(options.runner, ["spawn", options.udid, "defaults", "write", "com.apple.launchservices.schemeapproval",
    `com.apple.CoreSimulator.CoreSimulatorBridge-->${options.scheme}`, "-string", options.bundleId], options.cwd, options.environment);
}

/** The pixel size of a PNG, from its header. */
function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Whether a local foldable shows the pose it was folded to, by the shape of its lit display: the inner one is landscape
 * when open, the outer one portrait when closed. A half-open hinge shows either, so it is not checked.
 */
export async function localPoseShown(options: { runner: CommandRunner; udid: string; pose: string; directory: string; cwd: string; environment: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number) => void }): Promise<boolean> {
  if (options.pose !== "open" && options.pose !== "closed") return true;
  const file = join(options.directory, "pose.png");
  const sleep = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  // The display relights and resizes over a moment after the hinge moves.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt) sleep(1_000);
    simctl(options.runner, ["io", options.udid, "screenshot", file], options.cwd, options.environment, 60_000, true);
    const size = pngSize(await readFile(file).catch(() => Buffer.alloc(0)));
    await rm(file, { force: true });
    if (size && (options.pose === "open" ? size.width > size.height : size.height > size.width)) return true;
  }
  return false;
}

export function installOnLocalSimulator(options: { runner: CommandRunner; udid: string; app: string; cwd: string; environment: NodeJS.ProcessEnv }): void {
  simctl(options.runner, ["install", options.udid, options.app], options.cwd, options.environment, 5 * 60_000);
}

/** Shuts the simulator down and deletes it. Shutting down a device that is not booted fails harmlessly; only the delete counts. */
export function deleteLocalSimulator(options: { runner: CommandRunner; udid: string; cwd: string; environment: NodeJS.ProcessEnv }): void {
  if (!UDID.test(options.udid)) throw new Error("Not a simulator UDID");
  simctl(options.runner, ["shutdown", options.udid], options.cwd, options.environment, 2 * 60_000, true);
  simctl(options.runner, ["delete", options.udid], options.cwd, options.environment, 2 * 60_000);
}

/** The UDID a session state file records for a local simulator, or undefined when it names an EAS session. */
export function localSimulatorFromState(state: string): string | undefined {
  if (!state.startsWith(LOCAL_SIMULATOR_STATE_PREFIX)) return undefined;
  const udid = state.slice(LOCAL_SIMULATOR_STATE_PREFIX.length);
  return UDID.test(udid) ? udid : undefined;
}

/**
 * An Android emulator Explore creates on this machine for one capture. Its AVD lives in the capture's own
 * `ANDROID_AVD_HOME`, so it never appears among the user's emulators and goes with the capture's directory.
 */
export type LocalEmulator = { serial: string; avd: string; avdHome: string; image: string; osVersion: string };

/** A session state file names a local emulator by its adb serial with this prefix. */
export const LOCAL_EMULATOR_STATE_PREFIX = "adb-";

const SERIAL = /^emulator-[0-9]{4}$/;

/** The SDK's own tools, so a different adb or avdmanager earlier on PATH does not answer for this SDK. */
export function androidTools(environment: NodeJS.ProcessEnv): { sdk: string; adb: string; emulator: string; avdmanager: string } {
  const sdk = environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT;
  if (!sdk) throw new CiError({ code: "ANDROID_SDK_MISSING", stage: "session",
    message: "A local Android emulator needs the Android SDK, and neither ANDROID_HOME nor ANDROID_SDK_ROOT is set.",
    nextAction: "Install the SDK's platform-tools, emulator, cmdline-tools and a system image with sdkmanager, export ANDROID_HOME, and rerun." });
  return { sdk, adb: join(sdk, "platform-tools", "adb"), emulator: join(sdk, "emulator", "emulator"), avdmanager: join(sdk, "cmdline-tools", "latest", "bin", "avdmanager") };
}

/** The ABI an emulator runs natively on this machine: Apple silicon runs arm64 images; x86_64 images need an Intel host. */
export function hostEmulatorAbi(arch: string = process.arch): string {
  return arch === "arm64" ? "arm64-v8a" : "x86_64";
}

/** The newest installed Google APIs system image for this machine's ABI, as `system-images;android-35;google_apis;arm64-v8a`. */
export async function localSystemImage(sdk: string, abi: string): Promise<{ image: string; apiLevel: number }> {
  let best: { image: string; apiLevel: number } | undefined;
  const platforms = await readdir(join(sdk, "system-images")).catch(() => [] as string[]);
  for (const platform of platforms) {
    const apiLevel = Number(/^android-(\d+)$/.exec(platform)?.[1]);
    if (!Number.isInteger(apiLevel)) continue;
    for (const tag of ["google_apis_playstore", "google_apis"]) {
      if (!existsSync(join(sdk, "system-images", platform, tag, abi, "system.img"))) continue;
      if (!best || apiLevel > best.apiLevel) best = { image: `system-images;${platform};${tag};${abi}`, apiLevel };
    }
  }
  if (!best) throw new CiError({ code: "LOCAL_EMULATOR_IMAGE_UNAVAILABLE", stage: "session",
    message: `The Android SDK at ${sdk} has no Google APIs system image for ${abi}.`,
    nextAction: `Install one, for example: sdkmanager "system-images;android-35;google_apis;${abi}", then rerun.` });
  return best;
}

/** Refuses an APK whose native libraries cannot load on this machine's emulator, before an emulator is started for it. */
export async function assertLocalEmulatorCompatible(apk: string, abi: string): Promise<void> {
  const abis = await apkAbis(apk);
  if (abis.length && !abis.includes(abi)) throw new CiError({ code: "LOCAL_EMULATOR_ABI_UNSUPPORTED", stage: "session",
    message: `The APK ships native libraries only for ${abis.join(", ")}; this machine's emulator runs ${abi}.`,
    nextAction: `Build an APK that includes ${abi} (a universal build does), or capture Android on EAS Simulator with --simulator eas.` });
}

/**
 * Creates an AVD of the configured device profile (such as pixel_7) and starts it without a window. It boots in the
 * background while a capture repacks the app; waitForLocalEmulator waits for it afterwards.
 */
export async function startLocalEmulator(options: { runner: CommandRunner; device: string; name: string; directory: string; cwd: string; environment: NodeJS.ProcessEnv;
  /** Called with the emulator's adb serial once it is starting, so a caller can record it for cleanup. */
  started?: (serial: string) => void | Promise<void>;
  /** Whether the controller still holds a serial (a claim an interrupted run left behind); such a port is skipped. */
  claimed?: (serial: string) => boolean }): Promise<Omit<LocalEmulator, "osVersion"> & { apiLevel: number }> {
  const { runner, cwd } = options;
  const tools = androidTools(options.environment);
  const avdHome = join(options.directory, "avd");
  await mkdir(avdHome, { recursive: true });
  const environment = { ...options.environment, ANDROID_AVD_HOME: avdHome };
  const { image, apiLevel } = await localSystemImage(tools.sdk, hostEmulatorAbi());
  const created = runner({ command: tools.avdmanager, args: ["create", "avd", "--name", options.name, "--package", image, "--device", options.device, "--force"],
    cwd, environment: { ...environment, ANDROID_SDK_ROOT: tools.sdk }, timeoutMs: 2 * 60_000, allowFailure: true });
  if (!existsSync(join(avdHome, `${options.name}.avd`))) throw new CiError({ code: "LOCAL_EMULATOR_DEVICE_UNAVAILABLE", stage: "session",
    message: `avdmanager could not create an ${options.device} emulator: ${(created.stderr || created.stdout).trim().split("\n").at(-1) ?? "no output"}`,
    nextAction: "Set device.name to a device profile listed by avdmanager list device -c (such as pixel_7), then rerun." });
  // Emulators listen on even console ports from 5554; this one takes the first that adb does not list and no other capture
  // has reserved, since several start at once.
  const listed = runner({ command: tools.adb, args: ["devices"], cwd, environment, timeoutMs: 30_000 }).stdout;
  let port = 5554;
  while (listed.includes(`emulator-${port}`) || listed.includes(`emulator-${port + 1}`) || options.claimed?.(`emulator-${port}`) || !await reservePort(port, options.environment)) {
    port += 2;
    if (port > 5682) throw new CiError({ code: "LOCAL_EMULATOR_PORT_UNAVAILABLE", stage: "session", message: "Every emulator console port (5554-5682) is in use.",
      nextAction: "Stop some running emulators (adb devices lists them), then rerun." });
  }
  const serial = `emulator-${port}`;
  // The emulator runs until the capture kills it; the shell returns as soon as it is started.
  // gRPC (with a token) makes the emulator publish itself in avd/running, where Argent's device server finds it.
  runner({ command: "/bin/sh", args: ["-c", 'nohup "$0" "$@" > "$EXPLORE_EMULATOR_LOG" 2>&1 &', tools.emulator, "-avd", options.name, "-port", String(port),
    "-grpc", String(port + 3000), "-grpc-use-token", "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect"],
  cwd, environment: { ...environment, EXPLORE_EMULATOR_LOG: join(options.directory, "emulator.log") }, timeoutMs: 30_000 });
  await options.started?.(serial);
  return { serial, avd: options.name, avdHome, image, apiLevel };
}

/** Waits until an emulator startLocalEmulator started has booted, and reads its Android version. */
export function waitForLocalEmulator(options: { runner: CommandRunner; serial: string; device: string; apiLevel: number; directory: string; cwd: string;
  environment: NodeJS.ProcessEnv; now?: () => number; sleep?: (milliseconds: number) => void }): string {
  const { runner, serial, cwd } = options;
  const tools = androidTools(options.environment);
  const environment = { ...options.environment, ANDROID_AVD_HOME: join(options.directory, "avd") };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  runner({ command: tools.adb, args: ["-s", serial, "wait-for-device"], cwd, environment, timeoutMs: 5 * 60_000 });
  const deadline = now() + 5 * 60_000;
  while (runner({ command: tools.adb, args: ["-s", serial, "shell", "getprop", "sys.boot_completed"], cwd, environment, timeoutMs: 30_000, allowFailure: true }).stdout.trim() !== "1") {
    if (now() > deadline) throw new CiError({ code: "LOCAL_EMULATOR_BOOT_TIMEOUT", stage: "session",
      message: `The ${options.device} emulator did not finish booting in 5 minutes.`, nextAction: `Inspect ${join(options.directory, "emulator.log")} and rerun.` });
    sleep(2_000);
  }
  return runner({ command: tools.adb, args: ["-s", serial, "shell", "getprop", "ro.build.version.release"], cwd, environment, timeoutMs: 30_000 }).stdout.trim() || String(options.apiLevel);
}

export function installOnLocalEmulator(options: { runner: CommandRunner; serial: string; apk: string; cwd: string; environment: NodeJS.ProcessEnv }): void {
  const { adb } = androidTools(options.environment);
  options.runner({ command: adb, args: ["-s", options.serial, "install", "-r", options.apk], cwd: options.cwd, environment: options.environment, timeoutMs: 5 * 60_000 });
}

/** Where a capture reserves an emulator console port, in the machine's temporary directory; it names the process holding it. */
function portLock(port: number, environment: NodeJS.ProcessEnv): string {
  return join(environment.TMPDIR || tmpdir(), `expo-explore-emulator-${port}.lock`);
}

/**
 * Reserves a console port for this process; a reservation whose process has exited is taken over. Head and base start
 * their emulators at once on worker threads of one process, and other reviews may too: each reservation runs alone,
 * under a mutex directory, since taking over a stale lock is a read, a removal and a write that two captures would
 * otherwise both complete.
 */
export async function reservePort(port: number, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const mutex = join(environment.TMPDIR || tmpdir(), "expo-explore-emulator-ports.lock");
  for (;;) {
    try { await mkdir(mutex); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A holder keeps it for a few file operations; one that died holding it leaves it behind, which is broken after 10 s.
      const held = await stat(mutex).then(info => Date.now() - info.mtimeMs, () => 0);
      if (held > 10_000) await rm(mutex, { recursive: true, force: true });
      else await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const lock = portLock(port, environment);
    const holder = Number(await readFile(lock, "utf8").catch(() => ""));
    let alive = Number.isInteger(holder) && holder > 0;
    if (alive) try { process.kill(holder, 0); } catch (signal) { alive = (signal as NodeJS.ErrnoException).code === "EPERM"; }
    if (alive) return false;
    await writeFile(lock, String(process.pid));
    return true;
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

/** Stops the emulator and frees its console port; its AVD goes with the capture's directory. */
export async function deleteLocalEmulator(options: { runner: CommandRunner; serial: string; cwd: string; environment: NodeJS.ProcessEnv }): Promise<void> {
  if (!SERIAL.test(options.serial)) throw new Error("Not an emulator serial");
  const { adb } = androidTools(options.environment);
  // An emulator that already exited (or crashed) is stopped too; only one adb still lists is not.
  options.runner({ command: adb, args: ["-s", options.serial, "emu", "kill"], cwd: options.cwd, environment: options.environment, timeoutMs: 60_000, allowFailure: true });
  const listed = (serial: string) => options.runner({ command: adb, args: ["devices"], cwd: options.cwd, environment: options.environment, timeoutMs: 30_000, allowFailure: true })
    .stdout.split("\n").some(line => line.split("\t")[0] === serial && line.includes("device"));
  for (let attempt = 0; listed(options.serial); attempt += 1) {
    if (attempt === 10) throw new Error(`${options.serial} is still running after emu kill`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  // An emulator adb has lost (its console port closed, a child defunct) is not listed and ignores emu kill, yet runs on
  // with its AVD open; its process, by the AVD name and port this capture started it with, is stopped instead.
  const port = Number(options.serial.slice("emulator-".length));
  const running = () => options.runner({ command: "pgrep", args: ["-f", `qemu-system.* -avd explore-[a-z]+-[0-9a-f]{8} -port ${port} `], cwd: options.cwd,
    environment: options.environment, timeoutMs: 30_000, allowFailure: true }).stdout.split("\n").map(Number).filter(pid => Number.isInteger(pid) && pid > 0);
  for (let attempt = 0, pids = running(); pids.length > 0; attempt += 1, pids = running()) {
    if (attempt === 10) throw new Error(`${options.serial} is still running after it was signalled`);
    for (const pid of pids) try { process.kill(pid, attempt < 5 ? "SIGTERM" : "SIGKILL"); } catch { /* it has already exited */ }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  await rm(portLock(port, options.environment), { force: true });
}

/** The adb serial a session state file records for a local emulator, or undefined when it names something else. */
export function localEmulatorFromState(state: string): string | undefined {
  if (!state.startsWith(LOCAL_EMULATOR_STATE_PREFIX)) return undefined;
  const serial = state.slice(LOCAL_EMULATOR_STATE_PREFIX.length);
  return SERIAL.test(serial) ? serial : undefined;
}

/** Argent's tool-server for one capture on this machine: where it listens, its token, and its process. */
export type LocalArgentServer = { url: string; token: string; pid: number; cli: string; home: string };

/**
 * Starts Argent's tool-server for one capture, on a free port, with a HOME of its own so captures running side by
 * side do not share its state, and waits for it to say where it listens. Its simulator server looks for devices
 * under $HOME, so that HOME links to this machine's simulators and Android settings.
 */
export async function startLocalArgentServer(options: { runner: CommandRunner; cli: string; directory: string; cwd: string; environment: NodeJS.ProcessEnv;
  now?: () => number; sleep?: (milliseconds: number) => void }): Promise<LocalArgentServer> {
  const home = join(options.directory, "argent-server-home"), log = join(options.directory, "argent-server.log");
  await mkdir(join(home, "Library", "Developer"), { recursive: true, mode: 0o700 });
  const realHome = options.environment.HOME || homedir();
  // Running emulators publish themselves (gRPC port and token) in TemporaryItems/avd/running.
  const running = join("Library", "Caches", "TemporaryItems", "avd");
  await mkdir(join(realHome, running), { recursive: true });
  await mkdir(join(home, "Library", "Caches", "TemporaryItems"), { recursive: true, mode: 0o700 });
  for (const path of [join("Library", "Developer", "CoreSimulator"), ".android", running]) {
    if (existsSync(join(realHome, path))) await symlink(join(realHome, path), join(home, path)).catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  const started = options.runner({ command: "/bin/sh", args: ["-c", 'nohup "$0" "$1" server start --port 0 > "$EXPLORE_ARGENT_SERVER_LOG" 2>&1 & echo $!', process.execPath, options.cli],
    cwd: options.cwd, environment: { ...options.environment, HOME: home, DO_NOT_TRACK: "1", EXPLORE_ARGENT_SERVER_LOG: log }, timeoutMs: 30_000 });
  const pid = Number(started.stdout.trim());
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); });
  const deadline = now() + 60_000;
  for (;;) {
    const text = await readFile(log, "utf8").catch(() => "");
    const url = /Tools server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
    const token = /--token ([0-9a-f]+)/.exec(text)?.[1];
    if (url && token && Number.isInteger(pid) && pid > 0) return { url, token, pid, cli: options.cli, home };
    if (now() > deadline) {
      if (Number.isInteger(pid) && pid > 0) stopLocalArgentServer({ pid, cli: options.cli, home });
      throw new CiError({ code: "LOCAL_ARGENT_UNAVAILABLE", stage: "session", message: `Argent's tool-server did not start: ${text.trim().split("\n").at(-1) ?? "no output"}`,
        nextAction: `Inspect ${log}, then rerun.` });
    }
    sleep(500);
  }
}

/** Stops the tool-server the way Argent does (its own `server stop`, which ends the server it spawned), then its process. */
export function stopLocalArgentServer(server: Pick<LocalArgentServer, "pid" | "cli" | "home">): void {
  spawnSync(process.execPath, [server.cli, "server", "stop"], { env: { ...process.env, HOME: server.home }, timeout: 30_000, stdio: "ignore" });
  try { process.kill(server.pid, "SIGTERM"); } catch { /* it has already exited */ }
}

/** Switches a local simulator's appearance from the host, for a controller that cannot (Argent). */
export function setLocalSimulatorAppearance(options: { runner: CommandRunner; udid: string; scheme: "light" | "dark"; cwd: string; environment: NodeJS.ProcessEnv }): void {
  simctl(options.runner, ["ui", options.udid, "appearance", options.scheme], options.cwd, options.environment);
}

/** Switches a local emulator's night mode from the host, for a controller that cannot (Argent). */
export function setLocalEmulatorAppearance(options: { runner: CommandRunner; serial: string; scheme: "light" | "dark"; cwd: string; environment: NodeJS.ProcessEnv }): void {
  const { adb } = androidTools(options.environment);
  options.runner({ command: adb, args: ["-s", options.serial, "shell", "cmd", "uimode", "night", options.scheme === "dark" ? "yes" : "no"],
    cwd: options.cwd, environment: options.environment, timeoutMs: 60_000 });
}

/**
 * Stops the agent-device daemon a local capture ran in its own state directory. `close` ends the session, but the
 * daemon outlives a directory removed under it; the pid it records (daemon.json) is the one to stop.
 */
export async function stopLocalAgentDevice(stateDirectory: string): Promise<void> {
  const info = await readFile(join(stateDirectory, "daemon.json"), "utf8").then(text => JSON.parse(text) as { pid?: unknown }, () => undefined);
  if (typeof info?.pid === "number" && Number.isInteger(info.pid) && info.pid > 0 && info.pid !== process.pid) {
    try { process.kill(info.pid, "SIGTERM"); } catch { /* it has already exited */ }
  }
}
