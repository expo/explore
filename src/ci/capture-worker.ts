import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { runCiMap, type CiMapOptions, type CiMapResult } from "../capture/run.js";
import { CiError, serializeCiError, type CiErrorData } from "../shared/ci-errors.js";
import type { Progress } from "../shared/progress.js";

type WorkerMessage = { type: "progress"; message: string } | { type: "done"; result: CiMapResult } | { type: "error"; error: CiErrorData };
/** From the parent: stop between steps, as `signal` does for a capture on the main thread. */
type ParentMessage = { type: "abort"; reason: CiErrorData };

/** Options a worker can receive: the controller runs through synchronous subprocesses, so a side only overlaps another from its own thread. */
export type CaptureWorkerOptions = Omit<CiMapOptions, "progress" | "runner" | "now" | "fetch" | "agent" | "signal">;

/** Run one capture side on a worker thread so head and base can drive their simulator sessions at the same time. */
export function runCiMapOnWorker(options: CaptureWorkerOptions, progress: Progress, signal?: AbortSignal): Promise<CiMapResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./capture-worker.js", import.meta.url), { workerData: options });
    // An AbortSignal cannot cross threads; the worker aborts its own, and its capture stops its session as usual.
    const abort = () => worker.postMessage({ type: "abort", reason: serializeCiError(signal!.reason) } satisfies ParentMessage);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    worker.once("exit", () => signal?.removeEventListener("abort", abort));
    let settled = false;
    const finish = (callback: () => void) => { if (!settled) { settled = true; callback(); } };
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress") progress(message.message);
      else if (message.type === "done") finish(() => resolve(message.result));
      else finish(() => reject(new CiError({ ...message.error, ...(message.error.details ? { details: message.error.details } : {}) })));
    });
    worker.on("error", error => finish(() => reject(error)));
    worker.on("exit", code => finish(() => reject(new CiError({ code: "CAPTURE_WORKER_EXITED", stage: `capture-${options.side ?? "side"}`,
      message: `The capture worker for the ${options.side ?? "selected"} side exited with code ${code} before it reported a result.`,
      nextAction: "Inspect the job log for the worker's failure, then rerun Explore." }))));
  });
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const options = workerData as CaptureWorkerOptions;
  const controller = new AbortController();
  port.on("message", (message: ParentMessage) => { if (message.type === "abort") controller.abort(new CiError(message.reason)); });
  // Listening for an abort must not keep the worker alive once its capture is done.
  port.unref();
  runCiMap({ ...options, signal: controller.signal, progress: message => port.postMessage({ type: "progress", message } satisfies WorkerMessage) })
    .then(result => port.postMessage({ type: "done", result } satisfies WorkerMessage))
    .catch((error: unknown) => port.postMessage({ type: "error", error: serializeCiError(error, { secrets: [options.expoToken] }) } satisfies WorkerMessage));
}
