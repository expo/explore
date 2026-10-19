import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupAfterCapture, resolveCommit, resolveCompareRefs, writeStepOutputs } from "../../dist/ci/workflow-steps.js";
import { renderWorkflow, workflowIssues } from "../../dist/ci/workflow-install.js";

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function repository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "explore-steps-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test");
  await writeFile(join(root, "a.txt"), "1"); git(root, "add", "-A"); git(root, "commit", "-q", "-m", "one"); git(root, "tag", "v1.0.0");
  const first = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "a.txt"), "2"); git(root, "commit", "-q", "-am", "two"); git(root, "branch", "release");
  const second = git(root, "rev-parse", "HEAD");
  return { root, first, second };
}

const environment = { GITHUB_REPOSITORY: "acme/app", GITHUB_REPOSITORY_ID: "42" };

test("ci:compare-refs resolves tags, branches and SHAs to the comparison a capture uses", async t => {
  const { root, first, second } = await repository(t);
  assert.deepEqual(resolveCompareRefs({ project: root, base: "v1.0.0", head: "release", environment }), {
    origin: "compare", repositoryId: "42", repository: "acme/app", title: "release vs v1.0.0",
    url: `https://github.com/acme/app/compare/${first}..${second}`,
    base: { ref: "v1.0.0", sha: first }, head: { ref: "release", sha: second } });
  assert.equal(resolveCompareRefs({ project: root, base: first, head: "HEAD", environment }).title, `HEAD vs ${first.slice(0, 8)}`);
  for (const [base, head, code] of [["v1.0.0", "v1.0.0", "COMPARE_SAME_COMMIT"], ["v9", "main", "COMPARE_REF_NOT_FOUND"],
    ["--upload-pack=x", "main", "COMPARE_REF_INVALID"], ["main", "", "COMPARE_REF_INVALID"], ["a b", "main", "COMPARE_REF_INVALID"]]) {
    assert.throws(() => resolveCompareRefs({ project: root, base, head, environment }), error => error.code === code, `${base}..${head}`);
  }
});

test("HEAD is the checked-out commit and a local branch beats origin's, while CI's remote-only branches still resolve", async t => {
  const { root: upstream, first, second } = await repository(t);
  const clone = await realpath(await mkdtemp(join(tmpdir(), "explore-steps-clone-")));
  t.after(() => rm(clone, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["clone", "-q", upstream, clone]).status, 0);
  git(clone, "config", "user.email", "test@example.com"); git(clone, "config", "user.name", "Test");
  git(clone, "commit", "-q", "--allow-empty", "-m", "local only");
  const local = git(clone, "rev-parse", "HEAD");
  git(clone, "checkout", "-q", "--detach", first);
  assert.equal(git(clone, "rev-parse", "refs/remotes/origin/HEAD"), second, "origin/HEAD is not HEAD here");
  assert.equal(resolveCommit(clone, "HEAD", "head"), first);
  assert.equal(resolveCommit(clone, "@", "head"), first);
  assert.equal(resolveCommit(clone, "HEAD~0", "head"), first);
  assert.equal(resolveCommit(clone, "main", "base"), local, "your main, not a stale origin/main");
  assert.equal(resolveCommit(clone, "origin/main", "base"), second);
  assert.equal(resolveCommit(clone, "release", "base"), second, "a branch only origin has, as in a CI checkout");
  assert.equal(resolveCommit(clone, "v1.0.0", "base"), first);
});

test("ci:after-capture reports a checkout that capture modified, and passes clean ones and missing ones", async t => {
  const { root } = await repository(t);
  const output = await mkdtemp(join(tmpdir(), "explore-steps-output-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const env = { RUNNER_TEMP: output };
  assert.deepEqual(await cleanupAfterCapture({ output, checkouts: [root, join(output, "never-checked-out")], environment: env }), { stopped: [], failures: [] });
  await writeFile(join(root, "generated.json"), "{}");
  const dirty = await cleanupAfterCapture({ output, checkouts: [root], environment: env });
  assert.deepEqual(dirty.failures.map(failure => failure.code), ["CHECKOUT_MODIFIED"]);
  assert.equal(JSON.parse(await readFile(join(output, "explore-diagnostics", "cleanup.json"), "utf8")).failures.length, 1);
});

test("step outputs go to GITHUB_OUTPUT one line each, and nowhere outside Actions", async t => {
  const directory = await mkdtemp(join(tmpdir(), "explore-steps-outputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "output");
  await writeStepOutputs({ GITHUB_OUTPUT: path }, { base: "a".repeat(40), compare: JSON.stringify({ title: "x\ny" }) });
  assert.equal(await readFile(path, "utf8"), `base=${"a".repeat(40)}\ncompare={"title":"x\\ny"}\n`);
  await writeStepOutputs({}, { ignored: "1" });
});

test("doctor names a workflow that sets the app directory in one job but not another", async () => {
  const layout = { projectDir: "apps/mobile", installDir: ".", manager: "npm", secretNames: [] };
  for (const name of ["explore-review.yml", "explore-baseline.yml", "explore-compare.yml"]) {
    const rendered = renderWorkflow(await readFile(new URL(`../../templates/${name}`, import.meta.url), "utf8"), layout);
    assert.deepEqual([...rendered.matchAll(/APP_PROJECT_DIR: (.*)/g)].map(match => match[1]), ["apps/mobile"], `${name} sets it once, for every job`);
    assert.deepEqual(workflowIssues(name, rendered, layout), []);
  }
  // Workflows generated before this release set it per job, and only the first was rendered.
  const older = "env:\n  EXPLORE_VERSION: 1.0.0\njobs:\n  a:\n    env:\n      APP_PROJECT_DIR: apps/mobile\n      APP_INSTALL_DIR: .\n  b:\n    env:\n      APP_PROJECT_DIR: .\n      APP_INSTALL_DIR: .\n";
  const issues = workflowIssues("review", older, layout);
  assert.deepEqual(issues.map(issue => issue.code), ["WORKFLOW_APP_DIR_MISMATCH"]);
  assert.match(issues[0].message, /APP_PROJECT_DIR is \. in one of its jobs/);
});

test("ci:after-capture stops the sessions a side's appearance passes recorded, not only the side's own", async t => {
  const output = await mkdtemp(join(tmpdir(), "explore-steps-sessions-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  // Unreadable ids make the cleanup report each file it was handed without calling EAS.
  for (const name of ["head-session-dark", "base-session-dark", "baseline-session-light"]) await writeFile(join(output, name), "not a session id\n");
  await writeFile(join(output, "head-session-sepia"), "not a session id\n");
  const result = await cleanupAfterCapture({ output, checkouts: [], environment: { RUNNER_TEMP: output, EXPO_TOKEN: "token" } });
  assert.deepEqual(result.failures.map(failure => failure.message), Array(3).fill("Refusing an invalid session ID."));
});
