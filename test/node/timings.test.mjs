import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { createTimings, silentTimings, blockingCall, throttledProgress, githubRunLink, easPageLink, safeText, renderTimingsSummary, formatDuration } =
  await tsImport("../../src/shared/timings.ts", import.meta.url);
const { CiError } = await tsImport("../../src/shared/ci-errors.ts", import.meta.url);

async function withFile(run) {
  const directory = await mkdtemp(join(tmpdir(), "explore-timings-"));
  try { return await run(join(directory, "explore-diagnostics", "timings.jsonl")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const events = async path => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));

test("a span is written when it opens and when it closes, with its labels, duration and outcome", () => withFile(async path => {
  let clock = 1_000;
  const timings = createTimings({ path, now: () => clock }).labelled({ side: "head", pass: "dark" });
  const end = timings.span("repack", { attempt: 1 });
  clock += 2_500;
  end("ok", { build: "abc" });
  end("failed");
  const [start, finish, ...rest] = await events(path);
  assert.deepEqual(start, { type: "start", id: start.id, phase: "repack", at: 1_000, side: "head", pass: "dark", attributes: { attempt: 1 } });
  assert.deepEqual(finish, { type: "end", id: start.id, phase: "repack", at: 3_500, ms: 2_500, outcome: "ok", side: "head", pass: "dark", attributes: { attempt: 1, build: "abc" } });
  assert.equal(rest.length, 0, "a span closes once");
}));

test("measure ends a span ok, failed with the error's code, or cancelled, for sync and async work", () => withFile(async path => {
  const timings = createTimings({ path });
  assert.equal(timings.measure("plan", () => 4), 4);
  assert.equal(await timings.measure("compare", async () => 5), 5);
  assert.throws(() => timings.measure("install", () => { throw new CiError({ code: "INSTALL_FAILED", stage: "s", message: "m", nextAction: "n" }); }));
  await assert.rejects(timings.measure("session-start", async () => { throw new CiError({ code: "CAPTURE_CANCELLED", stage: "s", message: "m", nextAction: "n" }); }));
  const ends = (await events(path)).filter(event => event.type === "end");
  assert.deepEqual(ends.map(event => [event.phase, event.outcome, event.attributes?.code]),
    [["plan", "ok", undefined], ["compare", "ok", undefined], ["install", "failed", "INSTALL_FAILED"], ["session-start", "cancelled", "CAPTURE_CANCELLED"]]);
}));

test("a recorder that cannot write never fails the capture it times", () => {
  const timings = createTimings({ path: "/dev/null/not-a-directory/timings.jsonl" });
  assert.equal(timings.measure("plan", () => "done"), "done");
  timings.record({ type: "finish", outcome: "ok" });
  assert.equal(silentTimings.measure("plan", () => 1), 1);
});

test("nothing a recorder writes carries a secret, a signed link or a session's fragment token", () => withFile(async path => {
  const secret = "expo-token-CANARY-1234567890";
  const timings = createTimings({ path, secrets: [secret] });
  timings.record({ type: "baseline-step", name: `Install ${secret} https://x.example/a#token=FRAGMENT-CANARY`, ms: 1, conclusion: "success" });
  timings.span("repack", { note: "https://bucket.s3.amazonaws.com/a?X-Amz-Signature=SIGNATURE-CANARY", other: `?sig=SIG-CANARY ${secret}` })();
  const text = await readFile(path, "utf8");
  for (const canary of ["CANARY-1234567890", "FRAGMENT-CANARY", "SIGNATURE-CANARY", "SIG-CANARY"]) assert.equal(text.includes(canary), false, canary);
  const summary = renderTimingsSummary(text);
  for (const canary of ["CANARY-1234567890", "FRAGMENT-CANARY"]) assert.equal(summary.includes(canary), false, canary);
}));

test("safe text has no links, one line and a bounded length", () => {
  assert.equal(safeText("Install the launch\nrecording decoder"), "Install the launch recording decoder");
  assert.equal(safeText("see https://expo.dev/a?b=c for logs"), "see [link] for logs");
  assert.equal(safeText("x".repeat(200)).length, 80);
});

test("a wait's heartbeat prints at once, then at most once a minute", () => {
  let clock = 0;
  const lines = [];
  const tick = throttledProgress(line => lines.push(`${clock}:${line}`), { now: () => clock });
  for (clock of [0, 20_000, 40_000, 59_999, 60_000, 80_000, 119_999, 120_000]) tick("waiting");
  assert.deepEqual(lines, ["0:waiting", "60000:waiting", "120000:waiting"]);
});

test("a blocking call is timed with its bound and tells the notice when it starts and ends", () => withFile(async path => {
  const told = [];
  const notice = (phase, boundMs) => { told.push(["start", phase, boundMs]); return () => told.push(["end"]); };
  assert.equal(blockingCall(createTimings({ path }), notice, "native-build", 45 * 60_000, () => "built"), "built");
  assert.throws(() => blockingCall(createTimings({ path }), notice, "install", 1000, () => { throw new Error("failed"); }));
  assert.deepEqual(told, [["start", "native-build", 2_700_000], ["end"], ["start", "install", 1000], ["end"]]);
  const ends = (await events(path)).filter(event => event.type === "end");
  assert.deepEqual(ends.map(event => [event.phase, event.outcome]), [["native-build", "ok"], ["install", "failed"]]);
}));

test("links are rebuilt from their validated parts, never copied", () => {
  const environment = { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "brentvatne/euxy" };
  assert.equal(githubRunLink(environment, 40029888046), "https://github.com/brentvatne/euxy/actions/runs/40029888046");
  assert.equal(githubRunLink(environment, "1?x=y"), undefined);
  assert.equal(githubRunLink({ ...environment, GITHUB_REPOSITORY: "a/b/../c?d" }, 1), undefined);
  assert.equal(easPageLink("https://expo.dev/accounts/brent/projects/euxy/workflows/01ABC-def?token=x#y", "workflows"),
    "https://expo.dev/accounts/brent/projects/euxy/workflows/01ABC-def");
  // eas-cli's "See logs: <link>." brings the full stop along.
  assert.equal(easPageLink("https://expo.dev/accounts/brent/projects/euxy/workflows/01ABC-def.", "workflows"),
    "https://expo.dev/accounts/brent/projects/euxy/workflows/01ABC-def");
  for (const value of ["https://evil.dev/accounts/a/projects/b/workflows/c", "https://user:pw@expo.dev/accounts/a/projects/b/workflows/c",
    "https://expo.dev/accounts/a/projects/b/builds/c", "https://expo.dev/accounts/a/projects/b/simulator-sessions/c", "http://expo.dev/accounts/a/projects/b/workflows/c", "not a url", undefined]) {
    assert.equal(easPageLink(value, "workflows"), undefined, String(value));
  }
});

test("the summary totals phases per side, describes the routes, and names spans the job never finished", () => withFile(async path => {
  let clock = 0;
  const timings = createTimings({ path, now: () => clock });
  timings.record({ type: "run", target: "iphone" });
  const head = timings.labelled({ side: "head" });
  for (const [route, ms] of [["/a", 1_000], ["/b", 2_000], ["/c", 3_000], ["/d", 10_000]]) { const end = head.span("route", { route }); clock += ms; end(); }
  const repack = head.span("repack"); clock += 90_000; repack();
  timings.labelled({ side: "base" }).span("session-start");
  clock += 5_000;
  timings.record({ type: "baseline-step", name: "Install the launch recording decoder", ms: 19 * 60_000, conclusion: "cancelled" });
  const summary = renderTimingsSummary(await readFile(path, "utf8"));
  assert.match(summary, /### Explore capture timings · iphone/);
  assert.match(summary, /\| repack \| head \| 1 \| 1 min 30 s \| 1 min 30 s \|/);
  assert.match(summary, /\*\*Routes:\*\* 4, median 2 s, p90 10 s; slowest \/d 10 s, \/c 3 s, \/b 2 s\./);
  assert.match(summary, /- Install the launch recording decoder: 19 min \(cancelled\)/);
  assert.match(summary, /\*\*Never finished\*\* \(the job ended first\): session-start \(base\), 5 s\+/);
  assert.match(summary, /no finish recorded/);
  assert.equal(renderTimingsSummary(""), "");
  assert.equal(formatDuration(850), "850 ms");
}));
