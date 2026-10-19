/**
 * The Argent bridge behind both of its hosts: the command-line worker Explore spawns per command, and the
 * in-process worker thread that keeps one bridge (and one tool-server connection) for a whole capture. Each command
 * reads the shared state file, runs through `runBridgeCommand`, and writes the state back, so the two hosts can
 * take turns on one session.
 */
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { DecodedFrame } from "../shared/png-evidence.js";
import { runBridgeCommand, type ArgentBridgeState, type ArgentCall, type ArgentPlatform, type ArgentTree, type BridgeResult } from "./argent-driver.js";
import { ARGENT_VERSION } from "../shared/argent-version.js";

export type ArgentBridgeSettings = {
  environment: NodeJS.ProcessEnv;
  statePath: string;
  platform: ArgentPlatform;
  toolsUrl: string | undefined;
};

/** Reads the settings the bridge takes from its environment; absent when they are incomplete. */
export function argentBridgeSettings(environment: NodeJS.ProcessEnv): ArgentBridgeSettings | undefined {
  const statePath = environment.EXPLORE_ARGENT_STATE;
  const platform = environment.EXPLORE_ARGENT_PLATFORM;
  if (!statePath || (platform !== "ios" && platform !== "android")) return undefined;
  return { environment, statePath, platform, toolsUrl: environment.ARGENT_TOOLS_URL };
}

async function readState(path: string): Promise<ArgentBridgeState> {
  try { return JSON.parse(await readFile(path, "utf8")) as ArgentBridgeState; }
  catch { return { generation: 0 }; }
}

/** Written whole and renamed into place, so a command stopped mid-write never leaves a torn state. */
async function writeState(path: string, state: ArgentBridgeState): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

/** A call's arguments for the debug log: text that could be typed into a field is logged by length only. */
function loggedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => key === "text" && typeof value === "string" ? [key, `<${value.length} characters>`]
    : key === "steps" && Array.isArray(value) ? [key, `<${value.length} steps>`] : [key, value]));
}

/** What a call answered, for the debug log: a tree's shape, not its contents. */
function summarize(tool: string, value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (tool !== "ui-tree") return Object.keys(value);
  const tree = value as ArgentTree;
  let nodes = 0;
  const walk = (node: { children?: unknown[] }) => { nodes++; (node.children ?? []).forEach(child => walk(child as { children?: unknown[] })); };
  (tree.roots ?? []).forEach(walk);
  return { foregroundApp: tree.foregroundApp, alertVisible: tree.alertVisible, keyboardVisible: tree.keyboardVisible, truncated: tree.truncated,
    screen: tree.screen, nodes, roots: (tree.roots ?? []).map(root => [root.type ?? null, root.bundleId ?? null, (root.children ?? []).length]) };
}

export type ArgentBridge = {
  /** Runs one agent-device-shaped command against the session. */
  run(argv: readonly string[]): Promise<BridgeResult>;
};

/**
 * One bridge over the given Argent call. `host` names the process running it in the debug log.
 */
export function createArgentBridge(settings: ArgentBridgeSettings, call: ArgentCall, host: "process" | "thread"): ArgentBridge {
  const { environment, statePath, platform, toolsUrl } = settings;
  const logPath = environment.EXPLORE_ARGENT_LOG_DIR
    ? join(environment.EXPLORE_ARGENT_LOG_DIR, `argent-${platform}-${environment.EXPLORE_ARGENT_LOG_NAME ?? "bridge"}.jsonl`) : undefined;
  return {
    async run(argv) {
      // EXPLORE_ARGENT_LOG_DIR (opt-in): every Argent call this bridge makes, how long it took, and the shape of what it read.
      const log = async (entry: Record<string, unknown>) => {
        if (!logPath) return;
        await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), host, command: argv[0], ...entry })}\n`, { mode: 0o600 }).catch(() => undefined);
      };
      const state = await readState(statePath);
      const result = await runBridgeCommand(argv, {
        state, platform, version: ARGENT_VERSION,
        ...(environment.EXPLORE_ARGENT_BUNDLE_ID ? { bundleId: environment.EXPLORE_ARGENT_BUNDLE_ID } : {}),
        ...(environment.EXPLORE_ARGENT_DEVICE ? { device: environment.EXPLORE_ARGENT_DEVICE } : {}),
        // An opened foldable's inner panel shows its UI in landscape (Argent's fold: "Unfolded, the UI is landscape").
        ...(platform === "ios" && ["open", "half-open"].includes(environment.EXPLORE_ARGENT_POSE ?? "") ? { landscape: true } : {}),
        call: async (tool, args, options) => {
          const started = Date.now();
          try {
            const value = await call(tool, args, options);
            await log({ tool, args: loggedArgs(args), ms: Date.now() - started, summary: summarize(tool, value) });
            return value;
          } catch (error) {
            await log({ tool, args: loggedArgs(args), ms: Date.now() - started, error: (error instanceof Error ? error.message : String(error)).slice(0, 400) });
            throw error;
          }
        },
        reachable: async () => {
          let ok = false;
          try {
            const token = environment.ARGENT_AUTH_TOKEN;
            // The same URL Argent's own client checks: ARGENT_TOOLS_URL may carry a path, which /tools is appended to.
            const response = await fetch(`${(toolsUrl ?? "").replace(/\/+$/, "")}/tools`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5_000) });
            await response.body?.cancel();
            ok = response.status < 500;
          } catch { ok = false; }
          if (!ok) await log({ tool: "reachable", ok });
          return ok;
        },
        sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
        orientVideo: async path => {
          const probed = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path], { encoding: "utf8", timeout: 30_000 });
          const [width, height] = (probed.stdout ?? "").trim().split("x").map(Number);
          if (probed.status !== 0 || !width || !height || width >= height) return;
          const turned = `${path}.upright.mp4`;
          const ffmpeg = spawnSync("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", "-i", path, "-vf", "transpose=clock", "-an", turned], { encoding: "utf8", timeout: 120_000 });
          if (ffmpeg.status === 0) await rename(turned, path);
          else await rm(turned, { force: true });
        },
        scratchImage: { path: join(dirname(statePath), "argent-scratch.png"), read: async path => {
          const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame } } };
          return PNG.sync.read(await readFile(path), { checkCRC: false });
        } },
        moveFile: async (from, to) => {
          const source = await realpath(from);
          const roots = await Promise.all([environment.HOME, process.cwd()].filter((root): root is string => !!root).map(root => realpath(root).catch(() => root)));
          if (!roots.some(root => source.startsWith(`${root}/`))) throw new Error(`Argent returned a recording outside its own directories: ${from}`);
          await mkdir(dirname(to), { recursive: true });
          try { await rename(from, to); }
          catch { await copyFile(from, to); await rm(from, { force: true }); }
        },
      });
      await writeState(statePath, state);
      await log({ result: result.exitCode === 0 ? "ok" : result.stdout.slice(0, 300) });
      return result;
    },
  };
}
