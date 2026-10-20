/**
 * The Argent controller's command line: Explore runs it where it would run agent-device, with the same
 * arguments. Each command becomes `argent run <tool> --args <json>` calls, as EAS Simulator recommends
 * driving an `argent` session, with the session's ARGENT_TOOLS_URL and ARGENT_AUTH_TOKEN in the environment.
 * A capture keeps the same bridge on a worker thread instead (argent-bridge-host); this entry serves the callers
 * that run one command at a time.
 */
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { ArgentCallError } from "./argent-driver.js";
import { argentBridgeSettings, createArgentBridge } from "./argent-bridge.js";
import { ensureController } from "../shared/controller-cache.js";

const ARGENT_CALL_TIMEOUT_MS = 180_000;

async function main(): Promise<number> {
  const environment = process.env;
  const settings = argentBridgeSettings(environment);
  if (!settings) {
    process.stdout.write(JSON.stringify({ success: false, error: { code: "INVALID_ARGS", message: "The Argent controller needs EXPLORE_ARGENT_STATE and EXPLORE_ARGENT_PLATFORM." } }));
    return 1;
  }
  const argv = process.argv.slice(2);
  if (argv[0] !== "--version" && !settings.toolsUrl) {
    // Without a URL the Argent client would start a local tool-server; Explore only drives the session's own.
    process.stdout.write(JSON.stringify({ success: false, error: { code: "INVALID_ARGS", message: "ARGENT_TOOLS_URL is not set for the Argent controller." } }));
    return 1;
  }
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
      const lines = `${run.stderr ?? ""}\n${run.stdout ?? ""}`.trim().split("\n").filter(Boolean);
      // A stack trace can follow the line that says the tool-server is not serving its tools yet, which the bridge waits
      // out (argent-driver's TOOLS_NOT_SERVED), so that line is kept ahead of the last ones.
      const notServed = lines.find(line => /GET \/tools failed: \d{3}|ECONNREFUSED/.test(line));
      const detail = [...new Set([...(notServed ? [notServed] : []), ...lines.slice(-4)])].join(" | ").slice(0, 800);
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

  const result = await createArgentBridge(settings, callArgent, "process").run(argv);
  for (const note of result.notes ?? []) process.stderr.write(`[explore] ${note}\n`);
  process.stdout.write(result.stdout);
  return result.exitCode;
}

process.exitCode = await main();
