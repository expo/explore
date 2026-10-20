/**
 * Pauses between attempts of a GitHub lookup that may succeed later, 45 seconds in all. GitHub's Actions API is
 * eventually consistent just after an upload: in brentvatne/euxy's review run 39348956443, the duo-closed report job's
 * `actions/artifacts/<id>` answered 404 for the artifact that job had just uploaded, while the other four targets'
 * jobs found theirs.
 */
const GITHUB_LOOKUP_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000] as const;

/**
 * Runs a read-only GitHub lookup again after each pause while `transient` says its failure may clear on its own. The
 * caller decides what is transient; any other failure, or the last one, is thrown as it is.
 */
export async function retryGitHubLookup<T>(lookup: () => Promise<T>, transient: (error: unknown) => boolean,
  sleep: (milliseconds: number) => Promise<void> = milliseconds => new Promise<void>(done => setTimeout(done, milliseconds))): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try { return await lookup(); }
    catch (error) {
      const delayMs = GITHUB_LOOKUP_RETRY_DELAYS_MS[retry];
      if (delayMs === undefined || !transient(error)) throw error;
      // A lookup that succeeds later would otherwise leave no trace of the failure in the job log.
      process.stderr.write(`GitHub lookup failed (${(error instanceof Error ? error.message : String(error)).split("\n", 1)[0]}); trying again in ${delayMs / 1000} s\n`);
      await sleep(delayMs);
    }
  }
}
