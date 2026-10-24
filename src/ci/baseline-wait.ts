import { openAsBlob } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BlobReader, Uint8ArrayWriter, ZipReader, configure } from "@zip.js/zip.js";
import { CiError, environmentSecrets } from "../shared/ci-errors.js";
import { silentProgress, type Progress } from "../shared/progress.js";
import { githubRunLink, safeText, silentTimings, type Timings } from "../shared/timings.js";
import { retryGitHubLookup } from "../report/github-lookup.js";
import { safeRelativePath } from "../shared/archive-entries.js";
import { CAPTURE_CACHE_MAX_BYTES, CAPTURE_CACHE_MAX_FILES } from "./artifact-cache.js";
import { baselineLookup, githubContext, trustedBaselineRun, type GithubArtifact, type GithubRun } from "./workflow-steps.js";

/**
 * A review that waits for main's baseline of its base commit instead of capturing the base itself. Right after a
 * merge, the next pull request's review starts while the baseline workflow is still capturing the new base: in
 * brentvatne/euxy's review run 39348956443 it had started 15 s before, so every target captured its base too, about
 * 10–14 minutes per target instead of 6, on twice the EAS Simulator sessions. A baseline job takes 6–8 minutes and
 * head capture 5–8, so `runCiReview` starts head at once and waits here only where base would start.
 */

/** `capture.baselineWaitMinutes` when the config sets none: two baseline jobs' worth, so one queued behind another still counts. */
export const DEFAULT_BASELINE_WAIT_MINUTES = 15;
const POLL_MS = 20_000;
/** GitHub's Actions API lists an artifact a little after its upload (#47); a finished job gets this long for its artifact to appear. */
const ARTIFACT_LISTING_GRACE_MS = 60_000;
/** A zip of the largest capture cache, stored rather than deflated, plus its headers. */
const MAX_ARTIFACT_ZIP_BYTES = CAPTURE_CACHE_MAX_BYTES + 16 * 1024 * 1024;

type GithubStep = { name?: string; number?: number; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null };
type GithubJob = { name: string; status?: string; conclusion?: string | null; steps?: GithubStep[] };

/** What the review is waiting on, as it changes: the baseline job's state and the step it is in, from the same poll. */
export type BaselineWaitUpdate = { state: string; step?: string; stepSince?: number; waitedMs: number };

export type BaselineWaitOptions = {
  /** The baseline run `ci:find-baseline` named; it is checked again here, by the same trust rules. */
  run: number; sha: string; target: string;
  /** The longest the review waits, from its first poll (`capture.baselineWaitMinutes`). */
  timeoutMs: number; pollMs?: number;
  environment?: NodeJS.ProcessEnv; transport?: typeof fetch; progress?: Progress; signal?: AbortSignal;
  now?: () => number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Called when the baseline job's state or step changes: the review's sticky comment says what it waits on. */
  onUpdate?: (update: BaselineWaitUpdate) => void;
  /** Records the wait, and the steps the baseline job finished (or was still in) while the review waited. */
  timings?: Timings;
};

/** A failed GitHub read that may succeed later: no answer or a 5xx. A bad token or a missing permission is not. */
const transientGitHubFailure = (error: unknown) => error instanceof CiError && error.retryable;
const describe = (error: unknown) => error instanceof CiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
const statusText = (status: string | undefined) => (status ?? "queued").replaceAll("_", " ");

/**
 * Polls one baseline run until this target's baseline artifact is listed, and answers with it. The run must pass the
 * trust check a finished baseline passes. Each target's job uploads its own artifact when it finishes, so a target is
 * reused even when another target's job fails (#48); this target's job failing or being cancelled ends the wait, as do
 * the time limit, a missing permission and GitHub failures that outlast their retries. The reason says which.
 */
export async function waitForBaselineArtifact(options: BaselineWaitOptions): Promise<{ artifact: { id: number; run: number } } | { reason: string }> {
  const timings = options.timings ?? silentTimings;
  const now = options.now ?? Date.now;
  const end = timings.span("baseline-wait", { run: options.run });
  // The step the baseline job was last seen in: when the wait ends there, it is recorded with the time it had taken so far.
  const watch: BaselineWatch = { recorded: new Set() };
  const outcome = await pollBaselineArtifact(options, watch);
  if (watch.current) timings.record({ type: "baseline-step", name: watch.current.name, ms: Math.max(0, now() - watch.current.since), conclusion: "still running" });
  end("artifact" in outcome ? "ok" : "skipped", "artifact" in outcome ? { result: "artifact" } : { result: "gave up", reason: outcome.reason });
  return outcome;
}

type BaselineWatch = { recorded: Set<number>; current?: { name: string; since: number } };

/** A step's start or end as GitHub reports it, as a time on the wait's clock; GitHub's clock and the runner's agree to seconds. */
const stepTime = (value: string | null | undefined) => { const time = Date.parse(value ?? ""); return Number.isFinite(time) ? time : undefined; };

async function pollBaselineArtifact(options: BaselineWaitOptions, watch: BaselineWatch): Promise<{ artifact: { id: number; run: number } } | { reason: string }> {
  const now = options.now ?? Date.now;
  const timings = options.timings ?? silentTimings;
  const secrets = environmentSecrets(options.environment ?? process.env);
  const sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => delay(milliseconds, undefined, signal ? { signal } : {}));
  const progress = options.progress ?? silentProgress;
  const started = now();
  const short = options.sha.slice(0, 8);
  try {
    const lookup = await baselineLookup({ sha: options.sha, target: options.target, ...(options.environment ? { environment: options.environment } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      retry: read => retryGitHubLookup(read, transientGitHubFailure, milliseconds => sleep(milliseconds, options.signal)) });
    if (!lookup) return { reason: "the repository has no baseline workflow" };
    const { context, get, target } = lookup;
    // The matrix names each baseline job after its target; an older single-platform workflow's one job is `baseline`.
    const jobNames = [`baseline (${target})`, ...(target === "ios" ? ["baseline"] : [])];
    let finishedAt: number | undefined;
    let logged = "";
    let reported = "";
    let link = githubRunLink(options.environment ?? process.env, options.run);
    for (;;) {
      const run = await get<GithubRun>(`repos/${context.repository}/actions/runs/${options.run}`);
      if (!trustedBaselineRun(run, lookup)) return { reason: `run ${options.run} is not a baseline run of ${short} on ${lookup.defaultBranch}` };
      if (link) { progress(`waiting for ${lookup.defaultBranch}'s baseline run ${run.id} of ${short}: ${link}`); link = undefined; }
      for (const name of lookup.names) {
        const listed = await get<{ artifacts?: GithubArtifact[] }>(`repos/${context.repository}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}&per_page=100`);
        const artifact = (listed?.artifacts ?? []).filter(candidate => !candidate.expired && (candidate.name ?? name) === name
          && Number.isSafeInteger(candidate.id) && candidate.id > 0).sort((a, b) => b.id - a.id)[0];
        if (artifact) return { artifact: { id: artifact.id, run: run.id } };
      }
      const jobs = await get<{ jobs?: GithubJob[] }>(`repos/${context.repository}/actions/runs/${run.id}/jobs?per_page=100`);
      const job = jobs?.jobs?.find(candidate => jobNames.includes(candidate.name));
      // The job's steps say where it is: in brentvatne/euxy#179 a baseline sat 19 minutes installing ffmpeg while the
      // review's line said only "in progress". Each finished step is recorded once; the one running is named.
      for (const step of job?.steps ?? []) {
        const started = stepTime(step.started_at), completed = stepTime(step.completed_at);
        if (step.status !== "completed" || typeof step.number !== "number" || watch.recorded.has(step.number) || started === undefined || completed === undefined) continue;
        watch.recorded.add(step.number);
        timings.record({ type: "baseline-step", name: step.name ?? "?", ms: Math.max(0, completed - started), conclusion: step.conclusion ?? "unknown" });
      }
      const running = job?.status === "in_progress" ? job.steps?.find(step => step.status === "in_progress" && step.name) : undefined;
      const since = stepTime(running?.started_at);
      if (running && since !== undefined) watch.current = { name: running.name!, since };
      else delete watch.current;
      if (job?.status === "completed" && job.conclusion !== "success") {
        return { reason: `its ${target} job ${job.conclusion === "cancelled" ? "was cancelled" : job.conclusion === "failure" ? "failed" : `ended (${job.conclusion ?? "no conclusion"})`}` };
      }
      if (job?.status === "completed" || run.status === "completed") {
        finishedAt ??= now();
        if (now() - finishedAt >= ARTIFACT_LISTING_GRACE_MS) return { reason: job ? `its ${target} job finished, but GitHub lists no ${lookup.names[0]} artifact`
          : `the run ended (${run.conclusion ?? "no conclusion"}) without a ${target} baseline job` };
      }
      const waited = now() - started;
      const state = job ? statusText(job.status) : run.status === "completed" ? "finished" : "not started";
      if (waited >= options.timeoutMs) return { reason: `its ${target} job is still ${state} after ${Math.round(waited / 60_000)} min` };
      const step = watch.current ? safeText(watch.current.name, secrets) : undefined;
      const update = `${state}\0${step ?? ""}`;
      if (update !== reported) {
        reported = update;
        options.onUpdate?.({ state, ...(step && watch.current ? { step, stepSince: watch.current.since } : {}), waitedMs: waited });
      }
      // A line when the state changes and once a minute, not on every poll.
      const where = step && watch.current ? `, in "${step}" for ${Math.max(0, Math.floor((now() - watch.current.since) / 60_000))} min` : "";
      const line = `waiting for ${lookup.defaultBranch}'s baseline run ${run.id} of ${short} (${target}: ${state}${where}, ${Math.floor(waited / 60_000)} min)`;
      if (line !== logged) { progress(line); logged = line; }
      await sleep(Math.min(options.pollMs ?? POLL_MS, options.timeoutMs - waited), options.signal);
    }
  } catch (error) {
    return { reason: options.signal?.aborted ? "the review stopped waiting" : describe(error) };
  }
}

/**
 * Downloads a baseline artifact and unpacks it into `directory`, which must not exist yet: what
 * actions/download-artifact would have put in EXPLORE_CAPTURE_CACHE. The token goes to GitHub only, never to the
 * storage URL GitHub redirects to. Paths are confined to the directory and the cache's size limits apply before
 * anything is written; restoreCaptureArtifactCache then checks the evidence as it checks a downloaded one.
 */
export async function downloadBaselineArtifact(options: { artifact: number; directory: string; environment?: NodeJS.ProcessEnv; transport?: typeof fetch;
  signal?: AbortSignal; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void> }): Promise<void> {
  const environment = options.environment ?? process.env; const transport = options.transport ?? fetch;
  const context = githubContext(environment);
  const sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => delay(milliseconds, undefined, signal ? { signal } : {}));
  const signal = (milliseconds: number) => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
  const path = `repos/${context.repository}/actions/artifacts/${options.artifact}/zip`;
  // A 404 just after the artifact was listed is the Actions API catching up (#47), as a 5xx or no answer may be.
  const located = await retryGitHubLookup(async () => {
    let response: Response;
    try {
      response = await transport(`https://api.github.com/${path}`, { redirect: "manual", signal: signal(60_000),
        headers: { authorization: `Bearer ${context.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
    } catch (error) {
      throw new CiError({ code: "GITHUB_REQUEST_FAILED", stage: "capture-base", message: `GitHub could not be reached (${path}).`,
        nextAction: "Check GitHub availability.", retryable: true, cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return { location: response.headers.get("location") ?? "" };
    }
    if (response.ok) return { response };
    await response.body?.cancel().catch(() => {});
    throw new CiError({ code: response.status === 403 ? "GITHUB_PERMISSION_DENIED" : "GITHUB_REQUEST_FAILED", stage: "capture-base",
      message: `GitHub answered HTTP ${response.status} for ${path}.`, retryable: response.status === 404 || response.status >= 500,
      nextAction: response.status === 403 ? "Grant the capture job actions: read." : "Rerun the workflow; check GitHub's status if it keeps failing." });
  }, transientGitHubFailure, milliseconds => sleep(milliseconds, options.signal));
  let response = located.response;
  if (!response) {
    const location = URL.canParse(located.location ?? "") ? new URL(located.location!) : undefined;
    if (location?.protocol !== "https:") throw new Error("GitHub redirected the artifact download to no HTTPS address");
    response = await transport(location.href, { signal: signal(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`The artifact download answered HTTP ${response.status}`);
  }
  await mkdir(dirname(resolve(options.directory)), { recursive: true });
  const stage = await mkdtemp(`${resolve(options.directory)}.download-`);
  try {
    const archive = join(stage, "artifact.zip");
    const file = await open(archive, "wx", 0o600);
    try {
      let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > MAX_ARTIFACT_ZIP_BYTES) throw new Error("The baseline artifact is larger than a capture cache can be");
        await file.write(chunk);
      }
    } finally { await file.close(); }
    await unpackArtifact(archive, options.directory);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function unpackArtifact(archive: string, directory: string): Promise<void> {
  configure({ useWebWorkers: false });
  const zip = new ZipReader(new BlobReader(await openAsBlob(archive)), { useWebWorkers: false });
  try {
    const entries = await zip.getEntries();
    const files = entries.filter(entry => !entry.directory);
    // The cache's own metadata file is the one file beyond its evidence.
    if (files.length > CAPTURE_CACHE_MAX_FILES + 1 || files.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > CAPTURE_CACHE_MAX_BYTES + 2 * 1024 * 1024) {
      throw new Error("The baseline artifact exceeds the capture cache's limits");
    }
    const root = resolve(directory);
    await mkdir(root);
    for (const entry of files) {
      const path = safeRelativePath(entry.filename);
      const target = path ? resolve(root, path) : undefined;
      if (!target || relative(root, target).startsWith("..") || !entry.getData) throw new Error(`The baseline artifact holds an unsafe path: ${entry.filename}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await entry.getData(new Uint8ArrayWriter(), { checkSignature: true, useWebWorkers: false }), { flag: "wx", mode: 0o600 });
    }
  } finally {
    await zip.close();
  }
}

/**
 * The wait as `capture:review` runs it: the downloaded baseline's directory, or undefined, and then base captures as it
 * would have. It never fails the review; each outcome is one progress line.
 */
export async function awaitPendingBaseline(options: BaselineWaitOptions & { directory: string }): Promise<string | undefined> {
  const progress = options.progress ?? silentProgress;
  const short = options.sha.slice(0, 8);
  const outcome = await waitForBaselineArtifact(options);
  if ("reason" in outcome) {
    progress(`base: stopped waiting for the baseline of ${short} (${outcome.reason}); capturing the base too`);
    return undefined;
  }
  try {
    await downloadBaselineArtifact({ ...options, artifact: outcome.artifact.id });
    progress(`base: downloaded the baseline of ${short} that run ${outcome.artifact.run} captured`);
    return options.directory;
  } catch (error) {
    await rm(options.directory, { recursive: true, force: true }).catch(() => {});
    progress(`base: the baseline of ${short} from run ${outcome.artifact.run} could not be downloaded (${options.signal?.aborted ? "the review stopped waiting" : describe(error)}); capturing the base too`);
    return undefined;
  }
}
