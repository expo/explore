/**
 * The Argent controller's command line: Explore runs it where it would run agent-device, with the same
 * arguments. Each command becomes `argent run <tool> --args <json>` calls, as EAS Simulator recommends
 * driving an `argent` session, with the session's ARGENT_TOOLS_URL and ARGENT_AUTH_TOKEN in the environment.
 */
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { DecodedFrame } from "../shared/png-evidence.js";
import { ArgentCallError, runBridgeCommand, type ArgentBridgeState, type ArgentPlatform, type ArgentTree } from "./argent-driver.js";
import { ARGENT_VERSION } from "../shared/argent-version.js";
import { ensureController } from "../shared/controller-cache.js";

const ARGENT_CALL_TIMEOUT_MS = 180_000;

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

async function main(): Promise<number> {
  const environment = process.env;
  const statePath = environment.EXPLORE_ARGENT_STATE;
  const platform = environment.EXPLORE_ARGENT_PLATFORM as ArgentPlatform | undefined;
  const toolsUrl = environment.ARGENT_TOOLS_URL;
  if (!statePath || (platform !== "ios" && platform !== "android")) {
    process.stdout.write(JSON.stringify({ success: false, error: { code: "INVALID_ARGS", message: "The Argent controller needs EXPLORE_ARGENT_STATE and EXPLORE_ARGENT_PLATFORM." } }));
    return 1;
  }
  const argv = process.argv.slice(2);
  if (argv[0] !== "--version" && !toolsUrl) {
    // Without a URL the Argent client would start a local tool-server; Explore only drives the session's own.
    process.stdout.write(JSON.stringify({ success: false, error: { code: "INVALID_ARGS", message: "ARGENT_TOOLS_URL is not set for the Argent controller." } }));
    return 1;
  }
  // EXPLORE_ARGENT_LOG_DIR (opt-in): every Argent call this bridge makes, how long it took, and the shape of what it read.
  const logPath = environment.EXPLORE_ARGENT_LOG_DIR
    ? join(environment.EXPLORE_ARGENT_LOG_DIR, `argent-${platform}-${environment.EXPLORE_ARGENT_LOG_NAME ?? "bridge"}.jsonl`) : undefined;
  const log = async (entry: Record<string, unknown>) => {
    if (!logPath) return;
    await appendFile(logPath, `${JSON.stringify({ at: new Date().toISOString(), command: argv[0], ...entry })}\n`, { mode: 0o600 }).catch(() => undefined);
  };
  const state = await readState(statePath);
  let cli: string;
  try { cli = argv[0] === "--version" ? "" : await ensureController("argent", { environment, progress: message => process.stderr.write(`[explore] ${message}\n`) }); }
  catch (error) {
    const failure = error as { code?: string; message?: string };
    process.stdout.write(JSON.stringify({ success: false, error: { code: failure.code ?? "CONTROLLER_DOWNLOAD_FAILED", message: failure.message ?? String(error) } }));
    return 1;
  }

  const callArgent = async (tool: string, args: Record<string, unknown>, options?: { out?: string }): Promise<unknown> => {
    const run = spawnSync(process.execPath, [cli, "run", tool, "--args", JSON.stringify(args), ...(options?.out ? ["--out", options.out] : [])],
      { env: environment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: ARGENT_CALL_TIMEOUT_MS });
    if (run.error) throw new ArgentCallError(`argent run ${tool}: ${run.error.message}`, true);
    if (run.status !== 0) {
      const detail = `${run.stderr ?? ""}\n${run.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-4).join(" | ").slice(0, 800);
      throw new ArgentCallError(`argent run ${tool} failed: ${detail}`, true);
    }
    // With --out the client saves the tool's file and prints where ("Wrote: <path>"), not the tool's JSON.
    if (options?.out) {
      const written = await stat(options.out).catch(() => undefined);
      if (!written?.isFile() || written.size === 0) throw new ArgentCallError(`argent run ${tool} did not write ${options.out}`, true);
      return { path: options.out };
    }
    try { return JSON.parse(run.stdout); }
    catch { throw new ArgentCallError(`argent run ${tool} did not answer with JSON`, true); }
  };

  const result = await runBridgeCommand(argv, {
    state, platform, version: ARGENT_VERSION,
    ...(environment.EXPLORE_ARGENT_BUNDLE_ID ? { bundleId: environment.EXPLORE_ARGENT_BUNDLE_ID } : {}),
    call: async (tool, args, options) => {
      const started = Date.now();
      try {
        const value = await callArgent(tool, args, options);
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
    scratchImage: { path: join(dirname(statePath), "argent-scratch.png"), read: async path => {
      const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(bytes: Buffer, options: { checkCRC: boolean }): DecodedFrame } } };
      return PNG.sync.read(await readFile(path), { checkCRC: false });
    } },
    moveFile: async (from, to) => {
      // Argent's client downloads a recording under its HOME or the working directory; nothing else is moved.
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
  process.stdout.write(result.stdout);
  return result.exitCode;
}

process.exitCode = await main();
