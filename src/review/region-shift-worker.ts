import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { measureRegionMoves, type Rect } from "./region-shift.js";

type MeasuredRegions = Awaited<ReturnType<typeof measureRegionMoves>>;
type RegionMoveWork = { regionMoveWork: true; basePath: string; headPath: string; regions: ReadonlyArray<Rect & { dominantChange?: string }> };
type RegionMoveReply = { measured: MeasuredRegions } | { error: string };

/**
 * Measures region shifts and large moves on a worker thread, so several screenshot pairs search at once while the
 * main thread stays free: the search is CPU-bound and takes seconds on a tablet-sized screenshot. Falls back to the
 * calling thread when no worker can start.
 */
export async function measureRegionMovesInWorker(basePath: string, headPath: string, regions: RegionMoveWork["regions"]): Promise<MeasuredRegions> {
  const work: RegionMoveWork = { regionMoveWork: true, basePath, headPath, regions };
  let worker: Worker;
  try { worker = new Worker(new URL("./region-shift-worker.js", import.meta.url), { workerData: work }); }
  catch { return measureRegionMoves(basePath, headPath, regions); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void) => { if (!settled) { settled = true; outcome(); } };
    worker.once("message", (reply: RegionMoveReply) => finish(() => "error" in reply ? reject(new Error(reply.error)) : resolve(reply.measured)));
    // A worker that fails to load or dies before answering is a worker that did not start: the calling thread measures.
    worker.once("error", () => finish(() => resolve(measureRegionMoves(basePath, headPath, regions))));
    worker.once("exit", () => finish(() => resolve(measureRegionMoves(basePath, headPath, regions))));
  });
}

if (!isMainThread && parentPort && (workerData as Partial<RegionMoveWork> | null)?.regionMoveWork === true) {
  const port = parentPort;
  const work = workerData as RegionMoveWork;
  measureRegionMoves(work.basePath, work.headPath, work.regions)
    .then(measured => port.postMessage({ measured } satisfies RegionMoveReply), (error: unknown) => port.postMessage({ error: (error as Error).message } satisfies RegionMoveReply));
}
