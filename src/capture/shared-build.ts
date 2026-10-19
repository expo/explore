import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
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
 * (`keepApp`), which outlives each capture. A waiter is told so it can say whose build it uses, and told again
 * (`repacking`) once the builder calls its `repacking` (the native build is known and is being repacked), or the
 * build is done: a waiter starts its session then, not while a native build may run for most of an hour.
 */
export async function sharedBuild<T extends object>(options: { directory: string; key: SharedBuildKey; appName: string; signal?: AbortSignal;
  build: (keepApp: string, repacking: () => Promise<void>) => Promise<T>; waiting?: () => void; repacking?: () => void;
  /** Who builds it (the capture's output directory), so a review can fail its waiters if that capture dies (abandonSharedBuilds). */
  owner?: string }): Promise<T> {
  const folder = join(options.directory, sharedBuildId(options.key));
  const result = join(folder, "result.json"), failure = join(folder, "failure.json"), repack = join(folder, "repacking");
  await mkdir(options.directory, { recursive: true });
  let owner = true;
  try { await mkdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; owner = false; }
  if (owner) {
    if (options.owner) await writeFile(join(folder, "owner"), options.owner);
    try {
      const built = await options.build(join(folder, options.appName), () => writeFile(repack, "").catch(() => undefined));
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
  let repackSeen = false;
  for (;;) {
    options.signal?.throwIfAborted();
    const done = await readFile(result, "utf8").catch(() => undefined);
    if (!repackSeen && (done !== undefined || existsSync(repack))) { repackSeen = true; options.repacking?.(); }
    if (done !== undefined) return JSON.parse(done) as T;
    const failed = await readFile(failure, "utf8").catch(() => undefined);
    if (failed !== undefined) {
      const error = JSON.parse(failed) as { code: string; stage: string; message: string; nextAction: string };
      throw new CiError({ code: error.code, stage: error.stage, message: `The shared build failed: ${error.message}`, nextAction: error.nextAction });
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Fails the unfinished builds a capture owned, for one that ended without saying (a worker thread that exited before
 * its build wrote failure.json): the captures waiting on them stop instead of polling until the review is stopped.
 */
export async function abandonSharedBuilds(directory: string, ownedBy: (owner: string) => boolean, reason: string): Promise<void> {
  for (const folder of await readdir(directory).catch(() => [] as string[])) {
    const path = join(directory, folder);
    const owner = await readFile(join(path, "owner"), "utf8").catch(() => undefined);
    if (owner === undefined || !ownedBy(owner) || existsSync(join(path, "result.json")) || existsSync(join(path, "failure.json"))) continue;
    await writeFile(join(path, "failure.json"), JSON.stringify(serializeCiError(new CiError({ code: "CAPTURE_BUILD_FAILED", stage: "build",
      message: `the capture building it stopped (${reason})`, nextAction: "Inspect that target's failure above, correct it, and rerun Explore." }))));
  }
}
