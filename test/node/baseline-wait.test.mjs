import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, configure } from "@zip.js/zip.js";

const { waitForBaselineArtifact, awaitPendingBaseline } = await import("../../dist/ci/baseline-wait.js");
const { findPendingBaselineRun, findOptionalBaseline } = await import("../../dist/ci/workflow-steps.js");

const sha = "a".repeat(40);
const environment = { GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "test-token" };
const trustedRun = { id: 20, workflow_id: 77, head_sha: sha, head_branch: "main", event: "push", head_repository: { full_name: "acme/app" } };
const job = (status, conclusion = null, target = "iphone") => ({ name: `baseline (${target})`, status, conclusion });

async function zipFiles(files) {
  configure({ useWebWorkers: false });
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, content] of Object.entries(files)) await writer.add(name, new Uint8ArrayReader(new TextEncoder().encode(content)));
  return writer.close();
}

/**
 * GitHub as a review's wait sees it: baseline run 20 of `sha`, whose state moves to the next of `states` each time the
 * run is read (the last one stays), and artifact 500 of the iphone target, served from a storage URL GitHub redirects to.
 */
function fakeGitHub({ states = [{}], run = {}, zip, runFailures = [], runs } = {}) {
  let poll = -1;
  const requests = [];
  const state = () => states[Math.min(Math.max(poll, 0), states.length - 1)];
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    requests.push(`${url.pathname}${url.search}`);
    if (url.origin === "https://blob.example") {
      assert.equal(init.headers?.authorization, undefined, "the token never reaches the storage URL GitHub redirects to");
      return new Response(zip);
    }
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init.headers?.authorization, "Bearer test-token");
    const path = url.pathname;
    if (path === "/repos/acme/app") return Response.json({ default_branch: "main" });
    if (path === "/repos/acme/app/actions/workflows/explore-baseline.yml") return Response.json({ id: 77 });
    if (path === "/repos/acme/app/actions/artifacts") return Response.json({ artifacts: [] });
    if (path === "/repos/acme/app/actions/workflows/77/runs") {
      assert.equal(url.searchParams.get("head_sha"), sha);
      assert.equal(url.searchParams.get("branch"), "main");
      return Response.json({ workflow_runs: runs ?? [] });
    }
    if (path === "/repos/acme/app/actions/runs/20") {
      poll += 1;
      const failure = runFailures.shift();
      if (failure) return new Response("unavailable", { status: failure });
      return Response.json({ ...trustedRun, status: state().runStatus ?? "in_progress", conclusion: state().conclusion ?? null, ...run });
    }
    if (path === "/repos/acme/app/actions/runs/20/artifacts") {
      const name = url.searchParams.get("name");
      return Response.json({ artifacts: state().artifact && name === `explore-baseline-${sha}-iphone` ? [{ id: 500, name, expired: false, workflow_run: { id: 20 } }] : [] });
    }
    if (path === "/repos/acme/app/actions/runs/20/jobs") return Response.json({ jobs: [{ name: "targets", status: "completed", conclusion: "success" }, ...state().jobs ?? []] });
    if (path === "/repos/acme/app/actions/artifacts/500/zip") {
      assert.equal(init.redirect, "manual", "the redirect is followed by hand, without the token");
      return new Response(null, { status: 302, headers: { location: "https://blob.example/artifact.zip?sig=1" } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { transport, requests, polls: () => poll + 1 };
}

/** A clock the wait's pauses advance, so fifteen minutes of polling take no real time. */
function clock() {
  let milliseconds = 0;
  return { now: () => milliseconds, sleep: async pause => { milliseconds += pause; }, elapsed: () => milliseconds };
}

const waitOptions = (github, time, extra = {}) => ({ run: 20, sha, target: "iphone", timeoutMs: 15 * 60_000, environment, transport: github.transport,
  now: time.now, sleep: time.sleep, ...extra });

test("a baseline job in progress, then finished: the review reuses its artifact, downloaded and unpacked as download-artifact would", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-baseline-wait-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zip = await zipFiles({ "bundle.json": "{\"side\":\"head\"}", "cache-metadata.json": "{}", "screenshots/home.png": "png" });
  const github = fakeGitHub({ zip, states: [{ jobs: [] }, { jobs: [job("queued")] }, { jobs: [job("in_progress")] }, { jobs: [job("in_progress")] },
    { jobs: [job("completed", "success")], artifact: true }] });
  const time = clock(); const lines = [];
  const directory = join(root, "review", "baseline-download");
  assert.equal(await awaitPendingBaseline({ ...waitOptions(github, time, { progress: line => lines.push(line) }), directory }), directory);
  assert.deepEqual((await readdir(directory, { recursive: true })).sort(), ["bundle.json", "cache-metadata.json", "screenshots", "screenshots/home.png"]);
  assert.equal(await readFile(join(directory, "screenshots/home.png"), "utf8"), "png");
  assert.equal(github.polls(), 5);
  assert.deepEqual(lines, [
    "waiting for main's baseline run 20 of aaaaaaaa (iphone: not started, 0 min)",
    "waiting for main's baseline run 20 of aaaaaaaa (iphone: queued, 0 min)",
    "waiting for main's baseline run 20 of aaaaaaaa (iphone: in progress, 0 min)",
    "waiting for main's baseline run 20 of aaaaaaaa (iphone: in progress, 1 min)",
    "base: downloaded the baseline of aaaaaaaa that run 20 captured",
  ]);
  assert.ok(github.requests.every(request => !request.startsWith("/repos/acme/app/actions/runs/") || request.startsWith("/repos/acme/app/actions/runs/20")),
    "only the run ci:find-baseline named is read");
  assert.deepEqual((await readdir(join(root, "review"))).sort(), ["baseline-download"], "the downloaded zip is removed once unpacked");
});

test("this target's artifact is reused although another target's baseline job failed (#48)", async () => {
  const github = fakeGitHub({ states: [{ jobs: [job("completed", "failure", "duo-open"), job("in_progress")] },
    { runStatus: "completed", conclusion: "failure", jobs: [job("completed", "failure", "duo-open"), job("completed", "success")], artifact: true }] });
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(github, clock())), { artifact: { id: 500, run: 20 } });
});

test("a baseline job that fails or is cancelled ends the wait, and the review captures the base itself", async t => {
  for (const [conclusion, reason] of [["failure", "its iphone job failed"], ["cancelled", "its iphone job was cancelled"], ["skipped", "its iphone job ended (skipped)"]]) {
    const github = fakeGitHub({ states: [{ jobs: [job("in_progress")] }, { jobs: [job("completed", conclusion)] }] });
    assert.deepEqual(await waitForBaselineArtifact(waitOptions(github, clock())), { reason }, conclusion);
  }
  const root = await mkdtemp(join(tmpdir(), "explore-baseline-wait-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const github = fakeGitHub({ states: [{ jobs: [job("in_progress")] }, { jobs: [job("completed", "failure")] }] });
  const lines = [];
  assert.equal(await awaitPendingBaseline({ ...waitOptions(github, clock(), { progress: line => lines.push(line) }), directory: join(root, "baseline-download") }), undefined);
  assert.equal(lines.at(-1), "base: stopped waiting for the baseline of aaaaaaaa (its iphone job failed); capturing the base too");
  assert.ok(!github.requests.some(request => request.includes("/zip")), "nothing is downloaded");
  await assert.rejects(stat(join(root, "baseline-download")), { code: "ENOENT" });
});

test("a run that ends without this target's job, or a job whose artifact is never listed, ends the wait after a minute's grace", async () => {
  const ended = fakeGitHub({ states: [{ runStatus: "completed", conclusion: "failure", jobs: [] }] });
  const time = clock();
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(ended, time)), { reason: "the run ended (failure) without a iphone baseline job" });
  assert.equal(time.elapsed(), 60_000);
  const unlisted = fakeGitHub({ states: [{ jobs: [job("completed", "success")] }] });
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(unlisted, clock())), { reason: `its iphone job finished, but GitHub lists no explore-baseline-${sha}-iphone artifact` });
});

test("the wait gives up at its time limit, polling every 20 s", async () => {
  const github = fakeGitHub({ states: [{ jobs: [job("in_progress")] }] });
  const time = clock(); const lines = [];
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(github, time, { progress: line => lines.push(line) })), { reason: "its iphone job is still in progress after 15 min" });
  assert.equal(time.elapsed(), 15 * 60_000);
  assert.equal(github.polls(), 15 * 3 + 1);
  assert.equal(lines.length, 15, "one line a minute, not one a poll");
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(fakeGitHub({ states: [{ jobs: [job("in_progress")] }] }), clock(), { timeoutMs: 50_000, pollMs: 30_000 })),
    { reason: "its iphone job is still in progress after 1 min" }, "the last pause ends at the limit");
});

test("only a baseline run of exactly the base commit, on the default branch of this repository, from a push or dispatch, is waited for", async () => {
  for (const mutation of [{ head_branch: "feature" }, { event: "pull_request_target" }, { event: "pull_request" }, { workflow_id: 99 },
    { head_sha: "b".repeat(40) }, { head_repository: { full_name: "fork/app" } }]) {
    const github = fakeGitHub({ run: mutation, states: [{ jobs: [job("completed", "success")], artifact: true }] });
    assert.deepEqual(await waitForBaselineArtifact(waitOptions(github, clock())), { reason: "run 20 is not a baseline run of aaaaaaaa on main" }, JSON.stringify(mutation));
    assert.ok(!github.requests.some(request => request.startsWith("/repos/acme/app/actions/runs/20/")), "nothing of an untrusted run is read");
  }
  const dispatched = fakeGitHub({ run: { event: "workflow_dispatch" }, states: [{ artifact: true }] });
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(dispatched, clock())), { artifact: { id: 500, run: 20 } });
});

test("ci:find-baseline names a trusted baseline run still capturing the base commit, preferring the one already capturing", async () => {
  const run = (id, status, mutation = {}) => ({ ...trustedRun, id, status, conclusion: status === "completed" ? "success" : null, ...mutation });
  const lookup = runs => findPendingBaselineRun({ sha, target: "iphone", environment, transport: fakeGitHub({ runs }).transport });
  assert.deepEqual(await lookup([run(30, "completed"), run(31, "in_progress", { event: "pull_request_target" }), run(33, "queued"), run(32, "in_progress"),
    run(34, "in_progress", { head_branch: "feature" }), run(35, "in_progress", { head_repository: { full_name: "fork/app" } })]), { run: 32 });
  assert.deepEqual(await lookup([run(33, "queued"), run(36, "waiting")]), { run: 36 }, "otherwise the newest");
  assert.equal(await lookup([run(30, "completed"), run(31, "in_progress", { workflow_id: 99 })]), undefined);
  assert.deepEqual(await findOptionalBaseline({ sha, target: "iphone", environment, transport: fakeGitHub({ runs: [run(32, "in_progress")] }).transport }), { pending: { run: 32 } },
    "with no finished baseline to download");
  const outage = async input => new URL(input).pathname.endsWith("/77/runs") ? new Response("bad gateway", { status: 502 }) : fakeGitHub().transport(input, { headers: { authorization: "Bearer test-token" } });
  const failed = await findOptionalBaseline({ sha, target: "iphone", environment, transport: outage });
  assert.equal(failed.pending, undefined);
  assert.match(failed.warning.message, /^No baseline run in progress is waited for, so capture captures the base too: GitHub answered HTTP 502/);
});

test("a GitHub 5xx while polling is retried, and a missing permission ends the wait without failing the review", async t => {
  const github = fakeGitHub({ runFailures: [0, 502, 503], states: [{ jobs: [job("in_progress")] }, { jobs: [job("in_progress")] }, { jobs: [job("in_progress")] }, { artifact: true }] });
  t.mock.method(process.stderr, "write", () => true);
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(github, clock())), { artifact: { id: 500, run: 20 } });
  const outage = fakeGitHub({ runFailures: [502, 502, 502, 502, 502] });
  assert.match((await waitForBaselineArtifact(waitOptions(outage, clock()))).reason, /^GITHUB_REQUEST_FAILED: GitHub answered HTTP 502/, "an outage that outlasts its retries ends the wait");
  const denied = fakeGitHub({ runFailures: [403] });
  assert.deepEqual(await waitForBaselineArtifact(waitOptions(denied, clock())),
    { reason: "GITHUB_PERMISSION_DENIED: GitHub answered HTTP 403 for repos/acme/app/actions/runs/20." });
  assert.equal(denied.polls(), 1, "a missing permission is not retried");
  const tokenless = await waitForBaselineArtifact(waitOptions(fakeGitHub(), clock(), { environment: { GITHUB_REPOSITORY: "acme/app" } }));
  assert.match(tokenless.reason, /^GITHUB_TOKEN_MISSING/);
});

test("an artifact with a path outside its directory is refused before anything is written, and base captures as before", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-baseline-wait-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const github = fakeGitHub({ zip: await zipFiles({ "bundle.json": "{}", "../escape.txt": "outside" }), states: [{ artifact: true }] });
  const lines = [];
  assert.equal(await awaitPendingBaseline({ ...waitOptions(github, clock(), { progress: line => lines.push(line) }), directory: join(root, "review", "baseline-download") }), undefined);
  // zip.js refuses the entry as it reads the archive's directory, before the unpacking's own path check would.
  assert.equal(lines.at(-1), "base: the baseline of aaaaaaaa from run 20 could not be downloaded (Unsafe filename); capturing the base too");
  assert.deepEqual(await readdir(join(root, "review")), [], "neither the download nor a partial directory is left");
  await assert.rejects(stat(join(root, "escape.txt")), { code: "ENOENT" });
});

test("a review that no longer needs the baseline stops waiting at once", async () => {
  const github = fakeGitHub({ states: [{ jobs: [job("in_progress")] }] });
  const controller = new AbortController();
  const waiting = waitForBaselineArtifact({ run: 20, sha, target: "iphone", timeoutMs: 15 * 60_000, environment, transport: github.transport, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  assert.deepEqual(await waiting, { reason: "the review stopped waiting" });
  assert.ok(Date.now() - started < 5_000);
});
