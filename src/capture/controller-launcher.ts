/**
 * Runs a device controller Explore fetches on first use: `controller-launcher.js <controller> <args...>` makes sure
 * the pinned release is in the cache, then runs it with the arguments, passing its output and exit code through.
 * A failed fetch answers in agent-device's JSON envelope, so callers report it like any controller failure.
 */
import { spawn } from "node:child_process";
import { ensureController, type ControllerName } from "../shared/controller-cache.js";

async function main(): Promise<number> {
  const [controller, ...args] = process.argv.slice(2);
  if (controller !== "agent-device") {
    process.stdout.write(JSON.stringify({ success: false, error: { code: "INVALID_ARGS", message: `Unknown controller: ${controller ?? ""}` } }));
    return 1;
  }
  let bin: string;
  try { bin = await ensureController(controller as ControllerName, { progress: message => process.stderr.write(`[explore] ${message}\n`) }); }
  catch (error) {
    const failure = error as { code?: string; message?: string; nextAction?: string };
    process.stdout.write(JSON.stringify({ success: false, error: { code: failure.code ?? "CONTROLLER_DOWNLOAD_FAILED",
      message: failure.message ?? String(error), ...(failure.nextAction ? { hint: failure.nextAction } : {}) } }));
    return 1;
  }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: "inherit" });
    // A capture that stops the launcher stops the controller with it.
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });
}

process.exitCode = await main();
