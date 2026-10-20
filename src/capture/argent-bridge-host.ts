/**
 * Runs the Argent bridge's commands on a worker thread of this process, through a synchronous runner, so the
 * capture's command-at-a-time control flow keeps one bridge and one tool-server connection for the whole run
 * instead of starting a process per command. Commands for any other executable go to the fallback runner.
 */
import { Worker } from "node:worker_threads";
import { commandOutcome } from "./controller.js";
import type { CommandRequest, CommandResult, CommandRunner } from "./run.js";
import { BRIDGE_HEADER_BYTES, BRIDGE_KIND_UNAVAILABLE, BRIDGE_SLOT_KIND, BRIDGE_SLOT_LENGTH, BRIDGE_SLOT_READY, type BridgeRequest, type BridgeWorkerData } from "./argent-bridge-worker.js";

/** Room for one answer: an accessibility tree of a large screen is a few megabytes. */
const BRIDGE_BUFFER_BYTES = 64 * 1024 * 1024;
/** How long a command gets when its request names no timeout. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** After a timeout, how long the thread gets to confirm it dropped the command. */
const ABORT_GRACE_MS = 15_000;

export type ArgentBridgeRunner = {
  runner: CommandRunner;
  /** Whether commands still go to the thread (false after it proved unavailable or stopped answering). */
  readonly active: boolean;
  close(): void;
};

export function startArgentBridgeRunner(options: {
  /** The bridge executable the callers name; its commands run on the thread. */
  command: string;
  /** The bridge's environment, as argentControllerInvocation builds it. */
  environment: NodeJS.ProcessEnv;
  fallback: CommandRunner;
  /** Tests: a module exporting `createArgentClient` in place of the pinned Argent release's client. */
  clientModule?: string;
  progress?: (message: string) => void;
}): ArgentBridgeRunner {
  const shared = new SharedArrayBuffer(BRIDGE_HEADER_BYTES + BRIDGE_BUFFER_BYTES);
  const header = new Int32Array(shared, 0, BRIDGE_HEADER_BYTES / 4);
  const bytes = new Uint8Array(shared, BRIDGE_HEADER_BYTES);
  const workerData: BridgeWorkerData = { shared, ...(options.clientModule ? { clientModule: options.clientModule } : {}) };
  let worker: Worker | undefined;
  // The environment the thread runs with: a copy, so a caller that changes the session's (a restarted local
  // tool-server's URL and token) is seen by the next command, which starts a thread with the new one.
  let environment: NodeJS.ProcessEnv = {};
  const start = (from: NodeJS.ProcessEnv) => {
    environment = { ...from };
    try {
      const started = new Worker(new URL("./argent-bridge-worker.js", import.meta.url), { workerData, env: environment });
      // A thread that crashes stops serving; the commands after it run per command.
      started.on("error", error => { if (worker === started) stop(`the Argent bridge thread failed (${error.message}); running the bridge per command`); });
      worker = started;
    } catch (error) { options.progress?.(`the Argent bridge thread could not start (${(error as Error).message}); running the bridge per command`); }
  };
  let sequence = 0;
  const stop = (reason: string) => {
    if (!worker) return;
    options.progress?.(reason);
    void worker.terminate();
    worker = undefined;
  };
  const changed = (next: NodeJS.ProcessEnv) => {
    const keys = new Set([...Object.keys(environment), ...Object.keys(next)]);
    return [...keys].some(key => environment[key] !== next[key]);
  };
  const waitFor = (id: number, timeoutMs: number): boolean => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // The value waited on is the one just compared: an answer stored after the comparison wakes the wait at once.
      const ready = Atomics.load(header, BRIDGE_SLOT_READY);
      if (ready === id) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      Atomics.wait(header, BRIDGE_SLOT_READY, ready, remaining);
    }
  };
  start(options.environment);
  const runner: CommandRunner = (request: CommandRequest): CommandResult => {
    // A recording runs per command, in the session's own directory: Argent's client saves one under the project its
    // working directory is in, and this thread's is the caller's checkout. The state file carries it between hosts.
    if (!worker || request.command !== options.command || request.args[0] === "record") return options.fallback(request);
    if (changed(request.environment)) { void worker.terminate(); worker = undefined; start(request.environment); }
    if (!worker) return options.fallback(request);
    const id = ++sequence;
    Atomics.store(header, BRIDGE_SLOT_READY, 0);
    worker.postMessage({ id, argv: request.args, ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}) } satisfies BridgeRequest);
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!waitFor(id, timeoutMs)) {
      worker.postMessage({ abort: id } satisfies BridgeRequest);
      if (!waitFor(id, ABORT_GRACE_MS)) stop("the Argent bridge thread stopped answering; running the bridge per command");
      throw Object.assign(new Error(`${request.command} ${request.args[0] ?? ""} timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" });
    }
    const text = Buffer.from(bytes.subarray(0, Atomics.load(header, BRIDGE_SLOT_LENGTH))).toString("utf8");
    if (Atomics.load(header, BRIDGE_SLOT_KIND) === BRIDGE_KIND_UNAVAILABLE) {
      stop(`the Argent bridge thread is unavailable (${text}); running the bridge per command`);
      return options.fallback(request);
    }
    const result = JSON.parse(text) as { exitCode: number; stdout: string; notes?: string[] };
    // The thread cannot reach the capture's log while this one waits for it, so its lines come with the answer.
    for (const note of result.notes ?? []) options.progress?.(note);
    return commandOutcome(request, { status: result.exitCode, stdout: result.stdout, stderr: "" });
  };
  return { runner, get active() { return worker !== undefined; }, close: () => { if (worker) { void worker.terminate(); worker = undefined; } } };
}
