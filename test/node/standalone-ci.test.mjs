import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareCaptureReview } from "../../dist/review/capture-review.js";
import { createSourceCapturePlan } from "../../dist/source/capture-plan.js";
import { writeCiReportInput, exportCiReport, publishCiReportComment } from "../../dist/report/artifact.js";
import { viewerLinks } from "../../dist/report/viewer-links.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
const pr = { repositoryId: "123", repository: "expo/explore-playground", number: 1,
  title: "</script><script>throw 1</script>", url: "https://github.com/expo/explore-playground/pull/1",
  base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/dynamic-branch", sha: "b".repeat(40) } };
const artifactUrl = "https://github.com/expo/explore-playground/actions/runs/10/artifacts/20";
const environment = { GITHUB_TOKEN: "test-token", GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: pr.repository };

async function fixture(t, { verified = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "explore-artifact-ci-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([["app/index.tsx", "export default function Home() { return null; }"]]);
  const plan = createSourceCapturePlan({ baseSha: pr.base.sha, headSha: pr.head.sha,
    baseFiles: files, headFiles: files, changedFiles: [], mode: "all" });
  const id = plan.surfaces[0].id;
  plan.surfaces[0].sourceChange = { contract: "expo.explore.source-change-summary.v1", baseSha: pr.base.sha,
    headSha: pr.head.sha, impact: "none", summary: "No source changes.", files: [], truncated: false };
  for (const side of ["base", "head"]) {
    const directory = join(root, side); await mkdir(directory); await writeFile(join(directory, "home.png"), png);
    await writeFile(join(directory, "bundle.json"), JSON.stringify({ contract: "explore.bundle",
      side, gitCommit: pr[side].sha, easBuildId: "build", easProjectId: "project", profile: "explore:bundle", selectedSurfaceIds: [id],
      images: { [id]: { path: "home.png", sha256, width: 1, height: 1, sourceCommit: pr[side].sha,
        buildId: "build", capturedAt: "2026-09-15T00:00:00Z" } },
      outcomes: { [id]: { status: "captured", attempts: 1, landing: verified ? "verified" : "unverified" } } }));
  }
  const prepared = await prepareCaptureReview({ plan, pullRequest: pr, baseDirectory: join(root, "base"),
    headDirectory: join(root, "head"), runId: "10", runAttempt: "1", assertCurrentHead: async () => {},
    ...(verified ? { assessments: { [id]: { review: { status: "unchanged", description: "No visible change" } } } } : {}) });
  const inputPath = join(root, "report-input.json");
  await writeCiReportInput({ inputPath, publicReview: prepared.review, assets: prepared.assets,
    commentState: { phase: "capturing", pullRequest: pr, mode: "all", executionMode: "deterministic", configPath: ".expo-explore/config.yaml",
      startedAt: 1, updatedAt: 2, artifactOnly: true,
      links: viewerLinks({ repository: pr.repository, headSha: pr.head.sha, runId: "10", runAttempt: "1", configPath: ".expo-explore/config.yaml" }) } });
  return { root, inputPath, prepared };
}

test("capture preparation retains PR provenance without delivering internal source analysis", async t => {
  const { prepared, inputPath } = await fixture(t);
  assert.equal(prepared.assets.length, 1, "identical base/head bytes deduplicate");
  assert.equal(prepared.review.pullRequest.head.ref, "feature/dynamic-branch");
  assert.equal(prepared.review.surfaces[0].sourceChange.impact, "none", "Capture callers retain their internal analysis");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  assert.equal(input.publicReview.surfaces[0].sourceChange, undefined);
  assert.equal(input.commentState.phase, "capturing", "capture does not publish Ready before upload");
  assert.equal(input.commentState.links.viewer, null);
  assert.equal(input.onboarding, undefined, "reports carry no Live checkout guidance");
  assert.equal(input.assets[0].path, "head/home.png");
  assert.doesNotMatch(JSON.stringify(input), /"sourceChange"/);
});

test("CI report input strips legacy source payloads from the review and saved comment state", async t => {
  const { root, inputPath, prepared } = await fixture(t);
  const original = JSON.parse(await readFile(inputPath, "utf8"));
  const sourceChange = { contract: "expo.explore.source-change-summary.v1", baseSha: pr.base.sha,
    headSha: pr.head.sha, impact: "direct", summary: "Internal source analysis", truncated: false,
    files: [{ path: "app/index.tsx", status: "modified", relation: "route", hunks: [], facts: [], truncated: false,
      patch: "diff --git a/app/index.tsx b/app/index.tsx\n+private-source-sentinel\n" }] };
  const review = { status: "modified", description: "Home greeting changed", facts: [
    { category: "text", templateId: "text.changed", bullet: "Greeting changed from Hello to Welcome" },
  ] };
  prepared.review.surfaces[0].sourceChange = sourceChange;
  // A modified verdict follows a screen-specific source change.
  prepared.review.surfaces[0].status = "modified";
  prepared.review.surfaces[0].sourceScope = "screen";
  for (const side of ["base", "head"]) {
    prepared.review.surfaces[0][`${side}Outcome`] = {
      ...prepared.review.surfaces[0][`${side}Outcome`], landing: "verified",
    };
  }
  prepared.review.surfaces[0].review = review;
  const note = { text: 'The home greeting now welcomes returning users.', evidenceDigest: 'd'.repeat(64),
    evidence: ['base', 'head'].map(side => ({ side, sourceCommit: pr[side].sha, imageSha256: sha256 })) };
  prepared.review.surfaces[0].note = note;
  const projectedPath = join(root, "projected-report-input.json");
  await writeCiReportInput({ inputPath: projectedPath, publicReview: prepared.review, assets: prepared.assets,
    commentState: { ...original.commentState, review: prepared.review } });
  const serialized = await readFile(projectedPath, "utf8");
  const projected = JSON.parse(serialized);
  for (const output of [projected.publicReview, projected.commentState.review]) {
    assert.equal(output.surfaces[0].sourceChange, undefined);
    assert.deepEqual(output.surfaces[0].review, review);
    assert.deepEqual(output.surfaces[0].note, note);
    assert.equal(output.surfaces[0].baseOutcome.landing, "verified");
    assert.equal(output.surfaces[0].headOutcome.landing, "verified");
    assert.deepEqual(output.surfaces[0].headImage, prepared.review.surfaces[0].headImage);
    assert.deepEqual(output.pullRequest, pr);
  }
  assert.doesNotMatch(serialized, /"sourceChange"|"patch"|"hunks"|private-source-sentinel/);
  assert.equal(prepared.review.surfaces[0].sourceChange, sourceChange, "Internal evidence remains available to its caller");
  const outputPath = join(root, 'notes-report');
  await exportCiReport({ inputPath: projectedPath, outputPath });
  const delivered = JSON.parse(await readFile(join(outputPath, 'review.json'), 'utf8'));
  assert.deepEqual(delivered.review.surfaces[0].note, note);
});

test("export creates portable JSON and hashed image files without shipping executable HTML", async t => {
  const { root, inputPath } = await fixture(t);
  const outputPath = join(root, "report");
  const result = await exportCiReport({ inputPath, outputPath });
  assert.equal(result.imageCount, 1);
  assert.deepEqual((await readdir(outputPath)).sort(), ["assets", "review.json"]);
  const report = JSON.parse(await readFile(join(outputPath, "review.json"), "utf8"));
  assert.equal(report.kind, "explore.report");
  assert.equal(report.review.pullRequest.title, pr.title, "PR text remains JSON data, not executable markup");
  assert.equal(report.onboarding, undefined);
  assert.deepEqual(report.assets, [{ sha256, path: `assets/${sha256}.png` }]);
  assert.deepEqual(await readFile(join(outputPath, report.assets[0].path)), png);
  await writeFile(join(root, "head/home.png"), "tampered");
  await assert.rejects(exportCiReport({ inputPath, outputPath: join(root, "tampered-report") }), /hash|SHA|mismatch/i);
});

test("report export rejects path traversal and symlink images from downloaded evidence", async t => {
  const { root, inputPath } = await fixture(t);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const traversal = join(root, "traversal-input.json");
  await writeFile(traversal, JSON.stringify({ ...input, assets: [{ sha256, path: "../outside.png" }] }));
  await assert.rejects(exportCiReport({ inputPath: traversal, outputPath: join(root, "traversal-report") }), /asset path/);
  await symlink(join(root, "head/home.png"), join(root, "linked.png"));
  const linked = join(root, "linked-input.json");
  await writeFile(linked, JSON.stringify({ ...input, assets: [{ sha256, path: "linked.png" }] }));
  await assert.rejects(exportCiReport({ inputPath: linked, outputPath: join(root, "linked-report") }), /regular file/);
});

function transportFixture({ stale = false, expired = false, artifactName = "explore-review-10-1", artifactRun = 10, attempt = 1,
  status, headers, artifactNotFound = 0 } = {}) {
  const calls = [];
  let artifactLookups = 0;
  const transport = async (input, options = {}) => {
    const url = new URL(input); calls.push({ url, options });
    if (status) return new Response("private-upstream-error", { status, headers });
    // GitHub can answer 404 for an artifact its run uploaded moments ago (euxy run 39348956443).
    if (url.pathname.endsWith("/actions/artifacts/20") && (artifactLookups += 1) <= artifactNotFound) return new Response("Not Found", { status: 404 });
    if (url.pathname.endsWith("/actions/artifacts/20")) return Response.json({ id: 20, name: artifactName, expired, workflow_run: { id: artifactRun } });
    if (url.pathname.endsWith("/actions/runs/10/attempts/1")) return Response.json({ id: 10, run_attempt: attempt, status: "in_progress", conclusion: null });
    if (url.pathname.endsWith("/pulls/1")) return Response.json({ state: "open", base: pr.base,
      head: { ...pr.head, ...(stale ? { sha: "c".repeat(40) } : {}), repo: { full_name: pr.repository } } });
    if (url.pathname.endsWith("/issues/1/comments") && options.method === "POST") return Response.json({ id: 100 });
    if (url.pathname.endsWith("/issues/1/comments")) return Response.json([]);
    throw new Error(`Unexpected request ${url}`);
  };
  return { calls, transport };
}

test("only a live uploaded final artifact becomes Ready with a central Viewer deep link", async t => {
  const { inputPath } = await fixture(t); const { transport, calls } = transportFixture();
  const result = await publishCiReportComment({ inputPath, artifactUrl, environment, transport });
  const posted = calls.find(call => call.options.method === "POST");
  assert.ok(posted);
  const body = JSON.parse(posted.options.body).body;
  assert.match(body, /^### (\d+ screens?|No screens) changed · \[Review in Explore\]\(<https:\/\/explore-preview/m);
  const viewer = new URL(result.artifactUrl);
  assert.equal(viewer.origin, "https://explore-preview.expo.app");
  assert.equal(viewer.pathname, "/");
  assert.deepEqual(Object.fromEntries(viewer.searchParams), { repo: pr.repository, run: "10", attempt: "1", artifact: "20" });
  assert.ok(body.includes(result.artifactUrl));
  assert.match(body, new RegExp(`^### (\\d+ screens?|No screens) changed · \\[Review in Explore\\]\\(<${result.artifactUrl.replace(/[.?+*]/g, "\\$&")}>\\)$`, "m"), "the report link is the heading");
  assert.match(body, /^<sub>\[Workflow run\]\(<https:\/\/github\.com\/expo\/explore-playground\/actions\/runs\/10\/attempts\/1>\) · \[Config\]\(<[^>]+>\)<\/sub>$/m, "the run sits in the footer");
  assert.doesNotMatch(body, /embedded\.expo-explore\.invalid|<img|convex/);
  assert.ok(calls.some(call => call.url.pathname.endsWith("/actions/runs/10/attempts/1")));
});

test("an uploaded diagnostic artifact with unverified landings remains Incomplete", async t => {
  const { inputPath } = await fixture(t, { verified: false });
  const { transport, calls } = transportFixture();
  await publishCiReportComment({ inputPath, artifactUrl, environment, transport });
  const body = JSON.parse(calls.find(call => call.options.method === "POST").options.body).body;
  assert.match(body, /^iOS · 2 unattributed · \[run\]/m);
  assert.match(body, /<summary>Capture issues \(2\)<\/summary>/);
  assert.match(body, /\n- Base · [^\n]+ · CAPTURE\\_LANDING\\_UNVERIFIED/);
  assert.doesNotMatch(body, /⏳|capturing|Needs review/);
});

test("report publication separates credential, permission, rate limit, and service failures", async t => {
  const { inputPath } = await fixture(t);
  await assert.rejects(publishCiReportComment({ inputPath, artifactUrl, environment: { ...environment, GITHUB_TOKEN: "" } }),
    { code: "GITHUB_TOKEN_MISSING", retryable: false });
  for (const [status, headers, code, retryable, action] of [
    [401, {}, "GITHUB_TOKEN_INVALID", false, /valid GitHub token/],
    [403, {}, "GITHUB_PERMISSION_DENIED", false, /permissions/],
    [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED", true, /rate limit/],
    [403, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", true, /rate limit/],
    [429, {}, "GITHUB_RATE_LIMITED", true, /rate limit/],
    [503, {}, "GITHUB_REQUEST_FAILED", true, /service status/],
  ]) {
    const { transport, calls } = transportFixture({ status, headers });
    const pauses = [];
    await assert.rejects(publishCiReportComment({ inputPath, artifactUrl, environment, transport, sleep: async milliseconds => { pauses.push(milliseconds); } }), error => {
      assert.equal(error.code, code);
      assert.equal(error.stage, "publication");
      assert.equal(error.retryable, retryable);
      assert.match(error.nextAction, action);
      assert.doesNotMatch(error.message, /private-upstream-error|test-token/);
      return true;
    });
    assert.equal(calls.some(call => call.options.method === "POST"), false);
    // Only a 5xx is looked up again; a bad token, a missing permission and a rate limit fail on the first answer.
    assert.equal(calls.length, status >= 500 ? 5 : 1, `${status} ${JSON.stringify(headers)}`);
    assert.equal(pauses.length, calls.length - 1);
  }
});

test("an artifact GitHub does not list yet is looked up again, and one it never lists keeps the not-found failure", async t => {
  const { inputPath } = await fixture(t);
  const late = transportFixture({ artifactNotFound: 1 });
  const pauses = [];
  await publishCiReportComment({ inputPath, artifactUrl, environment, transport: late.transport, sleep: async milliseconds => { pauses.push(milliseconds); } });
  assert.equal(late.calls.filter(call => call.url.pathname.endsWith("/actions/artifacts/20")).length, 2);
  assert.equal(pauses.length, 1);
  assert.ok(late.calls.some(call => call.options.method === "POST"), "the comment is published once the artifact is found");

  const missing = transportFixture({ artifactNotFound: Infinity });
  const waited = [];
  await assert.rejects(publishCiReportComment({ inputPath, artifactUrl, environment, transport: missing.transport, sleep: async milliseconds => { waited.push(milliseconds); } }), error => {
    assert.equal(error.code, "GITHUB_RESOURCE_NOT_FOUND");
    assert.equal(error.message, "Report publication GitHub check failed (404)");
    assert.match(error.nextAction, /artifact ID/);
    return true;
  });
  assert.equal(missing.calls.length, 5);
  assert.equal(waited.length, 4, "no pause after the last lookup");
  const total = waited.reduce((sum, milliseconds) => sum + milliseconds, 0);
  assert.ok(total >= 30_000 && total <= 60_000, `${total} ms of pauses`);
  assert.equal(missing.calls.some(call => call.options.method === "POST"), false);
});

test("stale PRs, expired artifacts, foreign artifacts, and replayed attempts cannot announce Ready", async t => {
  const { inputPath } = await fixture(t);
  const moved = transportFixture({ stale: true });
  await publishCiReportComment({ inputPath, artifactUrl, environment, transport: moved.transport });
  const movedBody = JSON.parse(moved.calls.find(call => call.options.method === "POST").options.body).body;
  assert.match(movedBody, /Previous runs \(1\)/, "a PR that moved on still gets its report, under previous runs");
  assert.match(movedBody, /^### Explore review$/m, "nothing is presented as the current review");
  for (const configuration of [{ expired: true }, { artifactName: "explore-capture-evidence-1" },
    { artifactRun: 11 }, { attempt: 2 }]) {
    const { transport, calls } = transportFixture(configuration);
    await assert.rejects(publishCiReportComment({ inputPath, artifactUrl, environment, transport }));
    assert.equal(calls.some(call => call.options.method === "POST"), false);
  }
  await assert.rejects(publishCiReportComment({ inputPath, artifactUrl: artifactUrl.replace("/runs/10/", "/runs/11/"), environment }), /artifact URL/);
  await assert.rejects(publishCiReportComment({ inputPath, artifactUrl, environment: { ...environment, GITHUB_RUN_ATTEMPT: "2" } }), /current repository run/);
});
