import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CiError, serializeCiError, toCiError } from "../shared/ci-errors.js";

/**
 * Several targets of one review run the same commit of one platform and EAS profile: they need one build and one
 * repack, not one each. The captures run in parallel, in worker threads, so they meet in a directory: the first to
 * claim a build's folder builds it and writes the result there, and the others wait for that result (or its failure).
 */
export type SharedBuildKey = { platform: string; easProfile: string; bundleId: string; gitCommit: string; repack: string; local: boolean; routes: readonly string[] };

export function sharedBuildId(key: SharedBuildKey): string {
  return createHash("sha256").update(JSON.stringify({ ...key, routes: [...key.routes].sort() })).digest("hex").slice(0, 24);
}

const POLL_MS = 2_000;

/**
 * Runs `build` once per key across every capture sharing `directory`; the app it leaves goes in the build's folder
 * (`keepApp`), which outlives each capture. A waiter is told so it can say whose build it uses.
 */
export async function sharedBuild<T extends object>(options: { directory: string; key: SharedBuildKey; appName: string; signal?: AbortSignal;
  build: (keepApp: string) => Promise<T>; waiting?: () => void }): Promise<T> {
  const folder = join(options.directory, sharedBuildId(options.key));
  const result = join(folder, "result.json"), failure = join(folder, "failure.json");
  await mkdir(options.directory, { recursive: true });
  let owner = true;
  try { await mkdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; owner = false; }
  if (owner) {
    try {
      const built = await options.build(join(folder, options.appName));
      await writeFile(`${result}.tmp`, JSON.stringify(built));
      await rename(`${result}.tmp`, result);
      return built;
    } catch (error) {
      await writeFile(failure, JSON.stringify(serializeCiError(toCiError(error, { code: "CAPTURE_BUILD_FAILED", stage: "build",
        nextAction: "Inspect the capture diagnostic, correct the failing prerequisite, and rerun Explore." })))).catch(() => undefined);
      throw error;
    }
  }
  options.waiting?.();
  for (;;) {
    options.signal?.throwIfAborted();
    const done = await readFile(result, "utf8").catch(() => undefined);
    if (done !== undefined) return JSON.parse(done) as T;
    const failed = await readFile(failure, "utf8").catch(() => undefined);
    if (failed !== undefined) {
      const error = JSON.parse(failed) as { code: string; stage: string; message: string; nextAction: string };
      throw new CiError({ code: error.code, stage: error.stage, message: `The shared build failed: ${error.message}`, nextAction: error.nextAction });
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
