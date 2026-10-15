import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(await readFile(new URL("../../templates/explore-review.yml", import.meta.url), "utf8"));
const { resolvePullRequest, findBaselineArtifact, findOptionalBaseline } = await import("../../dist/ci/workflow-steps.js");
const environment = { GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "test-token" };
const samplePr = () => ({
  state: "open", draft: false, number: 91, title: "PR", html_url: "https://github.com/acme/app/pull/91", user: { login: "author" },
  base: { ref: "main", sha: "a".repeat(40), repo: { id: 12, full_name: "acme/app", default_branch: "main" } },
  head: { ref: "feature/settings", sha: "b".repeat(40), repo: { full_name: "acme/app" } },
});

/** `ci:pr` against a GitHub that answers with this PR, the author's permission, and the default branch's config. */
async function authorize(t, { pr = samplePr(), permission = "write", number = "91", config, configStatus } = {}) {
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(init.headers?.authorization, "Bearer test-token");
    if (url.pathname === "/repos/acme/app/pulls/91") return Response.json(pr);
    if (url.pathname === `/repos/acme/app/collaborators/${encodeURIComponent(pr.user.login)}/permission`) return Response.json({ permission });
    if (url.pathname === "/repos/acme/app/contents/.expo-explore/config.yaml") {
      assert.equal(url.searchParams.get("ref"), "main", "trust comes from the default branch, never the PR");
      if (configStatus) return new Response("boom", { status: configStatus });
      return config === undefined ? new Response("Not Found", { status: 404 }) : Response.json({ content: Buffer.from(config).toString("base64") });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { presentation } = await resolvePullRequest({ number: Number(number), environment, transport });
  return { metadata: presentation, outputs: { pr_number: presentation.number } };
}

test("the review workflow resolves and authorizes the PR with ci:pr from the installed release, in both jobs that need it", () => {
  for (const job of ["platforms", "capture"]) {
    const step = workflow.jobs[job].steps.find(step => step.id === "pr");
    assert.match(step.run, /cli\.js" ci:pr --pr "\$PR_NUMBER"/);
    assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
    assert.ok(workflow.jobs[job].steps.indexOf(step) < workflow.jobs[job].steps.findIndex(step => step.uses?.startsWith("actions/checkout@")), `${job}: authorize before checking out PR code`);
  }
  assert.equal(JSON.stringify(workflow).includes("actions/github-script"), false);
});

test("live API metadata is used for public and private PR branch identity", async t => {
  for (const privateRepo of [true, false]) {
    const pr = samplePr();
    pr.base.repo.private = privateRepo;
    const result = await authorize(t, { pr });
    assert.deepEqual(result.metadata.head, { ref: pr.head.ref, sha: pr.head.sha });
    assert.equal(result.outputs.pr_number, 91);
  }
});

test("forks, closed/draft PRs, invalid numbers, and revoked author write permission cannot reach checkout", async t => {
  for (const mutate of [pr => { pr.head.repo.full_name = "fork/app"; }, pr => { pr.head.repo = null; },
    pr => { pr.draft = true; }, pr => { pr.state = "closed"; }]) {
    const pr = samplePr(); mutate(pr);
    await assert.rejects(authorize(t, { pr }), /Capture requires an open, non-draft same-repository pull request/);
  }
  for (const permission of ["read", "triage", "none"]) await assert.rejects(authorize(t, { permission }), /write access/);
  for (const number of ["", "NaN", "0", "-2", "1.5"]) await assert.rejects(authorize(t, { number }), error => error.code === "PR_NUMBER_INVALID");
});

test("baseline restore rejects foreign workflows, revisions, branches, and unfinished runs", async () => {
  const valid = { id: 20, workflow_id: 77, conclusion: "success", head_sha: "a".repeat(40), head_branch: "main",
    event: "push", head_repository: { full_name: "acme/app" } };
  const mutations = [
    { workflow_id: 99 }, { head_sha: "b".repeat(40) }, { head_branch: "feature" },
    { conclusion: null }, { head_repository: { full_name: "fork/app" } }, { event: "pull_request_target" },
  ];
  const runs = Object.fromEntries(mutations.map((mutation, i) => [i + 30, { ...valid, ...mutation, id: i + 30 }]));
  runs[20] = valid;
  const artifacts = Object.keys(runs).map(id => ({ id: Number(id), workflow_run: { id: Number(id) }, expired: false }));
  artifacts.push({ id: 99, expired: true, workflow_run: { id: 99 } });
  const names = [];
  const transport = async input => {
    const url = new URL(input);
    if (url.pathname === "/repos/acme/app") return Response.json({ default_branch: "main" });
    if (url.pathname === "/repos/acme/app/actions/workflows/explore-baseline.yml") return Response.json({ id: 77 });
    if (url.pathname === "/repos/acme/app/actions/artifacts") {
      names.push(url.searchParams.get("name"));
      return Response.json({ artifacts: url.searchParams.get("name").endsWith("-ios") ? artifacts : [] });
    }
    const run = /^\/repos\/acme\/app\/actions\/runs\/(\d+)$/.exec(url.pathname);
    if (run) return Response.json(runs[run[1]]);
    throw new Error(`unexpected request ${url}`);
  };
  assert.deepEqual(await findBaselineArtifact({ sha: "a".repeat(40), platform: "ios", environment, transport }), { id: 20, run: 20 });
  assert.deepEqual(names, [`explore-baseline-${"a".repeat(40)}-ios`, `explore-baseline-${"a".repeat(40)}`], "iOS also accepts the unsuffixed name older baselines used");
});

test("a failed baseline lookup is a warning and no baseline, never an error a failure comment could blame", async () => {
  const outage = async () => new Response("bad gateway", { status: 502 });
  const result = await findOptionalBaseline({ sha: "a".repeat(40), platform: "ios", environment, transport: outage });
  assert.equal(result.baseline, undefined);
  assert.equal(result.warning.code, "GITHUB_REQUEST_FAILED");
  assert.match(result.warning.message, /^No baseline is reused, so capture captures the base too: GitHub answered HTTP 502/);
  assert.deepEqual(await findOptionalBaseline({ sha: "a".repeat(40), environment, transport: async () => new Response("", { status: 404 }) }), {}, "no baseline workflow: nothing to say");
});

const { publishFailureComment } = await import("../../dist/report/failure-comment.js");

const sampleDiagnostic = () => ({ code: "APP_INPUT_MISSING", stage: "capture-head", message: "Required app input is missing.",
  nextAction: "Set APP_REVIEW_PASSWORD for the capture step and rerun Explore.", retryable: false });

async function reportFailure(t, { capture, report, comments = [], pr = samplePr(), mutateFiles, platform = "ios", head = "b".repeat(40), base = "a".repeat(40) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "explore-failure-comment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // download-artifact with a pattern puts each platform artifact in a directory named after it.
  for (const [relative, content] of [[`capture/explore-diagnostics-1234-1-${platform}/explore-diagnostics/error.json`, capture], [`report/explore-report-diagnostics-1234-1-${platform}/error.json`, report]]) {
    if (content === undefined) continue;
    const file = join(directory, "explore-failure", relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  await mutateFiles?.(directory);
  const writes = [];
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(init.headers?.authorization, "Bearer test-token");
    if (url.pathname === "/repos/acme/app/pulls/91") return Response.json(pr);
    if (url.pathname === "/repos/acme/app/issues/91/comments" && (init.method ?? "GET") === "GET") return Response.json(comments);
    if (url.pathname === "/repos/acme/app/issues/91/comments" && init.method === "POST") { writes.push({ action: "create", body: JSON.parse(init.body).body }); return Response.json({ id: 100 }); }
    const update = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(url.pathname);
    if (update && init.method === "PATCH") { writes.push({ action: "update", comment_id: Number(update[1]), body: JSON.parse(init.body).body }); return Response.json({ id: Number(update[1]) }); }
    throw new Error(`unexpected request ${init.method ?? "GET"} ${url}`);
  };
  const result = await publishFailureComment({ repository: "acme/app", pullNumber: 91, headSha: head, baseSha: base, runId: "1234", runAttempt: "1",
    diagnosticsPath: join(directory, "explore-failure"), environment: { GITHUB_TOKEN: "test-token" }, transport });
  return Object.assign(writes, { result });
}

test("the failure job runs ci:failure from the installed release instead of an inline script", () => {
  const steps = workflow.jobs.failure.steps;
  assert.equal(steps.some(step => step.uses?.startsWith("actions/github-script")), false);
  const step = steps.find(step => step.name === "Report failure only on the current PR");
  assert.match(step.run, /ci:failure --pr "\$\{PR_NUMBER:-0\}" --head "\$\{HEAD_SHA:-\}" --base "\$\{BASE_SHA:-\}" --diagnostics "\$RUNNER_TEMP\/explore-failure"/);
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.deepEqual(workflow.jobs.failure.permissions, { actions: "read", "pull-requests": "write" });
});

test("failure comments use actionable capture diagnostics and update only the bot-owned sticky comment", async t => {
  const diagnostic = sampleDiagnostic();
  const writes = await reportFailure(t, { capture: diagnostic, comments: [
    { id: 1, user: { login: "author" }, body: "<!-- expo-explore-ci -->" },
    { id: 2, user: { login: "github-actions[bot]" }, body: "Other comment" },
    { id: 3, user: { login: "github-actions[bot]" }, body: "<!-- expo-explore-ci -->\nPrevious run" },
  ] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].action, "update");
  assert.equal(writes[0].comment_id, 3);
  assert.match(writes[0].body, /\| iOS \| [^|]*\| 🟥 failed · capture\\-head \|/);
  assert.match(writes[0].body, /APP\\_INPUT\\_MISSING/);
  assert.match(writes[0].body, /Required app input is missing/);
  assert.match(writes[0].body, /Next action\\: Set APP\\_REVIEW\\_PASSWORD/);
  assert.match(writes[0].body, /actions\/runs\/1234/);
  assert.deepEqual(writes.result, { posted: true });
});

test("report failure diagnostics take precedence and cannot fall back to successful capture diagnostics", async t => {
  const capture = sampleDiagnostic();
  const report = { ...sampleDiagnostic(), code: "REPORT_EXPORT_FAILED", stage: "export", message: "Report asset is missing." };
  const [write] = await reportFailure(t, { capture, report });
  assert.match(write.body, /REPORT\\_EXPORT\\_FAILED/);
  assert.doesNotMatch(write.body, /APP\\_INPUT\\_MISSING/);
  const [fallback] = await reportFailure(t, { capture, report: "invalid JSON" });
  assert.match(fallback.body, /error code, cause, and next action/);
  assert.doesNotMatch(fallback.body, /APP\\_INPUT\\_MISSING/);
});

test("missing, malformed, oversized, and escaping diagnostic files use the generic fallback", async t => {
  const invalid = [undefined, "{", null, [], { ...sampleDiagnostic(), retryable: "false" },
    { ...sampleDiagnostic(), code: "invalid code" }, { ...sampleDiagnostic(), stage: "<capture>" },
    { ...sampleDiagnostic(), message: "" }, { ...sampleDiagnostic(), nextAction: 42 },
    { ...sampleDiagnostic(), message: "x".repeat(4001) }, " ".repeat(32769)];
  for (const capture of invalid) {
    const [write] = await reportFailure(t, { capture });
    assert.match(write.body, /error code, cause, and next action/);
  }
  const [write] = await reportFailure(t, { mutateFiles: async directory => {
    await mkdir(join(directory, "explore-failure/capture/explore-diagnostics-1234-1-ios/explore-diagnostics"), { recursive: true });
    await writeFile(join(directory, "private.json"), JSON.stringify(sampleDiagnostic()));
    await symlink(join(directory, "private.json"), join(directory, "explore-failure/capture/explore-diagnostics-1234-1-ios/explore-diagnostics/error.json"));
  } });
  assert.match(write.body, /error code, cause, and next action/);
});

test("failure diagnostics are rendered as inert text with secondary token redaction", async t => {
  const [write] = await reportFailure(t, { capture: { ...sampleDiagnostic(),
    message: '<script>alert(1)</script> @reviewer [click](https://example.invalid)\n<!-- expo-explore-ci --> Bearer raw-token',
    nextAction: 'Use sk-ant-abcdefghijklmnop and https://user:password@example.invalid/?token=sensitive-token' } });
  assert.doesNotMatch(write.body, /<script>|@reviewer|raw-token|sk-ant-abcdefghijklmnop|user:password|sensitive-token|\[click\]\(/);
  assert.match(write.body, /&lt;script&gt;/);
  assert.match(write.body, /&#64;reviewer/);
  assert.equal(write.body.split("<!-- expo-explore-ci -->").length, 2);
});

test("closed, draft, and forked PRs receive no failure comment; a PR that moved on files the failure under previous runs", async t => {
  for (const mutate of [pr => { pr.state = "closed"; }, pr => { pr.draft = true; }, pr => { pr.head.repo.full_name = "fork/app"; }]) {
    const pr = samplePr(); mutate(pr);
    const writes = await reportFailure(t, { capture: sampleDiagnostic(), pr });
    assert.deepEqual([...writes], []);
    assert.equal(writes.result.posted, false);
  }
  const moved = samplePr(); moved.head.sha = "d".repeat(40);
  const [write] = Object.assign([], await reportFailure(t, { capture: sampleDiagnostic(), pr: moved }));
  assert.match(write.body, /<summary>Previous runs \(1\)<\/summary>/);
  assert.match(write.body, /bbbbbbbb.*iOS 🟥 failed · capture\\-head/);
  assert.doesNotMatch(write.body, /^<sub>base \[/m);
  const invalid = await reportFailure(t, { capture: sampleDiagnostic(), head: "not-a-sha" });
  assert.deepEqual([...invalid], []);
});

test("a failed platform joins the other platform's row in a multi-platform comment", async t => {
  const { renderPublicComment } = await import("../../dist/report/pr-comment-body.js");
  const { viewerLinks } = await import("../../dist/report/viewer-links.js");
  const links = viewerLinks({ repository: "acme/app", headSha: "b".repeat(40), runId: "1234", runAttempt: "1", configPath: ".expo-explore/config.yaml", platform: "ios" });
  const pr = samplePr();
  const existing = renderPublicComment({ phase: "capturing", mode: "changes", executionMode: "deterministic", configPath: ".expo-explore/config.yaml",
    pullRequest: { repositoryId: "12", repository: "acme/app", number: 91, title: "PR", url: pr.html_url, base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "feature/settings", sha: "b".repeat(40) } },
    links, startedAt: Date.now(), updatedAt: Date.now(), artifactOnly: true, build: { platform: "ios", easProfile: "x" },
    capture: { planned: { base: 2, head: 2 }, done: { base: 2, head: 1 }, baseFromCache: false, current: "head" } }, undefined, "ios");
  const comments = [{ id: 7, user: { login: "github-actions[bot]" }, body: existing }];
  const [write] = await reportFailure(t, { capture: sampleDiagnostic(), platform: "android", comments });
  assert.equal(write.comment_id, 7);
  assert.match(write.body, /\| iOS \| [^|]*\| ⏳ capturing head 1\/2 \|/);
  assert.match(write.body, /\| Android \| [^|]*\| 🟥 failed · capture\\-head \|/);
  assert.match(write.body, /APP\\_INPUT\\_MISSING/);
  assert.equal(write.body.split("<!-- expo-explore-ci -->").length, 2);
  // A comment without records (a legacy layout) is replaced by the failure alone.
  const [whole] = await reportFailure(t, { capture: sampleDiagnostic(), platform: "android", comments: [{ id: 8, user: { login: "github-actions[bot]" }, body: "<!-- expo-explore-ci -->\nPrevious run" }] });
  assert.match(whole.body, /^<!-- expo-explore-ci -->\n<!-- expo-explore-record:android:/);
  assert.doesNotMatch(whole.body, /\| iOS \|/);
});

test("ci.trustedAuthors on the default branch admits listed authors without write access, nobody else", async t => {
  const block = "app:\n  bundleId: com.acme.app\nci:\n  trustedAuthors:\n    - devin-ai-integration[bot] # reviews\n    - 'Renovate[bot]'\nreport:\n  preview:\n    hosting: eas\n";
  const flow = "ci: # bots\n  trustedAuthors: [\"devin-ai-integration[bot]\", 'renovate[bot]'] # quoted: plain scalars cannot hold [ ] in flow style\n";
  for (const config of [block, flow]) {
    for (const login of ["devin-ai-integration[bot]", "Devin-AI-Integration[bot]", "renovate[bot]"]) {
      const pr = samplePr(); pr.user.login = login;
      const result = await authorize(t, { pr, permission: "read", config });
      assert.equal(result.outputs.pr_number, 91);
    }
    const stranger = samplePr(); stranger.user.login = "dependabot[bot]";
    await assert.rejects(authorize(t, { pr: stranger, permission: "read", config }), /write access/);
  }
  const bot = samplePr(); bot.user.login = "devin-ai-integration[bot]";
  await assert.rejects(authorize(t, { pr: bot, permission: "read" }), /write access/);
  await assert.rejects(authorize(t, { pr: bot, permission: "read", config: "ci:\n  trustedAuthors: []\n" }), /write access/);
  await assert.rejects(authorize(t, { pr: bot, permission: "read", config: "report:\n  preview:\n    hosting: eas\n" }), /write access/);
  const fork = samplePr(); fork.user.login = "devin-ai-integration[bot]"; fork.head.repo.full_name = "fork/app";
  await assert.rejects(authorize(t, { pr: fork, permission: "read", config: block }), error => error.code === "SOURCE_NOT_TRUSTED");
  const draft = samplePr(); draft.user.login = "devin-ai-integration[bot]"; draft.draft = true;
  await assert.rejects(authorize(t, { pr: draft, permission: "read", config: block }), error => error.code === "SOURCE_NOT_TRUSTED");
  await assert.rejects(authorize(t, { pr: bot, permission: "read", config: "x: [\n" }), /write access/);
  // A list that fails validation trusts no one, and the refusal says the list was ignored and why.
  await assert.rejects(authorize(t, { pr: bot, permission: "read", config: "ci:\n  trustedAuthors: [\"devin-ai-integration[bot]\", \"not a login\"]\n" }), error => {
    assert.equal(error.code, "SOURCE_NOT_TRUSTED");
    assert.match(error.message, /The default branch's ci\.trustedAuthors was ignored: .*trustedAuthors\[1\]/);
    assert.match(error.nextAction, /^Fix ci\.trustedAuthors/);
    return true;
  });
  // Only the list is read: a default-branch config written for another release, with keys this one does not know,
  // still trusts its bots.
  assert.equal((await authorize(t, { pr: bot, permission: "read", config: "ci:\n  trustedAuthors: [\"devin-ai-integration[bot]\"]\n  someLaterKey: true\nlaterSection: {}\n" })).outputs.pr_number, 91);
  const server = samplePr(); server.user.login = "devin-ai-integration[bot]";
  await assert.rejects(authorize(t, { pr: server, permission: "read", configStatus: 500 }), error => error.code === "GITHUB_REQUEST_FAILED" && error.retryable);
});
