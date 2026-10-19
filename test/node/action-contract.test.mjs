import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const actionSource = await readFile(new URL("../../action.yml", import.meta.url), "utf8");
const action = parse(actionSource);
const reviewSource = await readFile(new URL("../../templates/explore-review.yml", import.meta.url), "utf8");
const review = parse(reviewSource);
const baselineSource = await readFile(new URL("../../templates/explore-baseline.yml", import.meta.url), "utf8");
const baseline = parse(baselineSource);
const compareSource = await readFile(new URL("../../templates/explore-compare.yml", import.meta.url), "utf8");
const compare = parse(compareSource);
const workflows = [review, baseline, compare];

test("one review, one baseline and one compare template replace all duplicate CI entrypoints", async () => {
  const names = (await readdir(new URL("../../templates/", import.meta.url))).filter(name => name.endsWith(".yml"));
  assert.deepEqual(names.sort(), ["explore-baseline.yml", "explore-compare.yml", "explore-review.yml"]);
  for (const source of [actionSource, reviewSource, baselineSource, compareSource]) {
    assert.doesNotMatch(source, /surface_manifest|surfaces\.json|runtime_probe|--keyless|KEYLESS|claude-code|agent_sandbox|report:export|report:comment/);
  }
  for (const removed of ["surface_manifest", "impact_plan", "runtime_probe_url", "keyless", "agent_sandbox", "bundle_id"]) {
    assert.equal(action.inputs[removed], undefined);
  }
});

test("Actions are immutable, have explicit permissions, and never persist checkout credentials", () => {
  for (const workflow of workflows) {
    assert.deepEqual(workflow.permissions, {});
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(job.permissions);
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
        if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
      }
    }
  }
  // Capture posts progress updates; publication rewrites the finished comment.
  assert.equal(review.jobs.capture.permissions["pull-requests"], "write");
  assert.equal(review.jobs.report.permissions["pull-requests"], "write");
  assert.doesNotMatch(JSON.stringify(review.jobs.report), /EXPO_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test("CI and capture templates use Node 24 without skipping browser coverage or enabling privileged caches", async () => {
  const ci = parse(await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const setup = parse(await readFile(new URL("../../.github/actions/setup/action.yml", import.meta.url), "utf8"));
  const playwright = parse(await readFile(new URL("../../.github/actions/playwright/action.yml", import.meta.url), "utf8"));
  const node = setup.runs.steps.find(step => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(node.with["node-version"], 24);
  const jobs = Object.values(ci.jobs);
  for (const job of jobs) {
    assert.equal(job.steps[1].uses, "./.github/actions/setup", job.name);
    for (const step of [...job.steps, ...setup.runs.steps, ...playwright.runs.steps]) {
      if (step.uses?.startsWith("actions/")) assert.match(step.uses, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
    }
  }
  const steps = jobs.flatMap(job => job.steps);
  for (const command of ["npx playwright test --shard=${{ matrix.shard }}/6", "npm run test:viewer:browser", "node --test test/browser/${{ matrix.suite }}.browser.mjs", "npm run test:hosting", "npm run build:hosting"]) {
    const step = steps.find(step => step.run === command);
    assert.ok(step, command);
    assert.equal(step.if, undefined, command);
  }
  assert.deepEqual(ci.jobs.e2e.strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const artifactSuites = manifest.scripts["test:viewer:artifacts"].match(/test\/browser\/([a-z-]+)\.browser\.mjs/g).map(file => file.slice("test/browser/".length, -".browser.mjs".length));
  assert.deepEqual(ci.jobs["viewer-artifacts"].strategy.matrix.suite, artifactSuites);
  assert.deepEqual(ci.jobs.unit.strategy.matrix.shard, [1, 2, 3]);
  assert.equal(ci.jobs.unit.steps.at(-1).run, "node --test --test-shard=${{ matrix.shard }}/3 test/node/*.test.mjs");
  assert.ok(playwright.runs.steps.some(step => step.run === "npx playwright install --with-deps chromium"));
  for (const workflow of workflows) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter(step => step.uses?.startsWith("actions/setup-node@"))) {
        assert.equal(step.with["node-version"], 24);
        assert.equal(step.with["package-manager-cache"], false);
        assert.equal(step.with.cache, undefined);
      }
    }
  }
  for (const directory of ["", "viewer-host/"]) {
    const manifest = JSON.parse(await readFile(new URL(`../../${directory}package.json`, import.meta.url), "utf8"));
    const lock = JSON.parse(await readFile(new URL(`../../${directory}package-lock.json`, import.meta.url), "utf8"));
    assert.equal(manifest.engines.node, ">=24.12.0", directory);
    assert.equal(lock.packages[""].engines.node, manifest.engines.node, directory);
  }
});

test("source consistency verification precedes app installs and capture", () => {
  for (const job of [review.jobs.capture, baseline.jobs.baseline]) {
    const names = job.steps.map(step => step.name);
    const verify = names.indexOf("Verify deterministic source planning");
    const install = names.indexOf("Install app dependencies");
    const capture = job.steps.findIndex(step => /capture:(review|baseline)/.test(step.run ?? ""));
    assert.ok(verify > 0 && verify < install && install < capture);
    assert.match(job.steps[verify].run, /source:verify/);
    assert.match(job.steps[verify].run, /--output "\$RUNNER_TEMP\/explore-consistency"/);
    const tools = names.indexOf("Install Explore");
    assert.ok(tools > 0 && tools < verify);
    assert.match(job.steps[tools].run, /EXPLORE_VERSION_INVALID/);
  }
  const verify = action.runs.steps.findIndex(step => step.name === "Verify deterministic source planning");
  assert.ok(verify < action.runs.steps.findIndex(step => step.id === "capture"));
});

test("workflows install the pinned npm release from the default branch's copy", () => {
  for (const workflow of workflows) {
    assert.match(workflow.env.EXPLORE_VERSION, /^set-by-expo-explore-setup$/);
    assert.doesNotMatch(JSON.stringify(workflow), /EXPLORE_TOOLS_COMMIT|vendor\/expo-explore/);
    for (const job of Object.values(workflow.jobs)) for (const step of job.steps.filter(step => step.name === "Install Explore")) {
      assert.match(step.run, /npm pack "@expo\/explore@\$EXPLORE_VERSION"/);
    }
  }
  assert.ok(Object.hasOwn(review.on, "pull_request_target"), "the default branch's workflow, and so its version, runs for every PR");
});

test("trusted tools retain native agent runtimes while omitting development dependencies and lifecycle scripts", () => {
  const builds = [action.runs.steps.find(step => step.name === "Build the pinned Explore CLI"),
    ...workflows.flatMap(workflow => Object.values(workflow.jobs)
      .flatMap(job => job.steps.filter(step => step.name === "Install Explore")))];
  assert.equal(builds.length, 12, "composite action, review targets/capture/report/deploy/failure, baseline targets/baseline, and compare targets/capture/report/deploy install the trusted tools");
  for (const step of builds) {
    const install = step.run.split("\n").find(line => /^\s*npm ci\b/.test(line));
    assert.ok(install, step.name);
    const flags = install.trim().split(/\s+/).slice(2);
    assert.ok(flags.includes("--omit=dev"), step.name);
    assert.ok(flags.includes("--include=optional"), "platform-native production runtimes must survive npm omit configuration");
    assert.ok(flags.includes("--ignore-scripts"), step.name);
    assert.ok(!flags.some(flag => /^--omit=.*optional|^--no-optional$/.test(flag)), step.name);
    assert.doesNotMatch(step.run, /npm (?:install|i) -g|node_modules\/\.bin\/claude/);
  }
});

test("baseline captures a complete single default-branch commit without a PR", () => {
  assert.ok(Object.hasOwn(baseline.on, "push"));
  assert.ok(Object.hasOwn(baseline.on, "workflow_dispatch"));
  const job = baseline.jobs.baseline;
  assert.match(baseline.jobs.targets.if, /github\.event\.repository\.default_branch/);
  assert.deepEqual(job.needs, "targets");
  assert.deepEqual(job.strategy, { "fail-fast": false, "max-parallel": "${{ fromJSON(needs.targets.outputs.max_parallel) }}",
    matrix: { target: "${{ fromJSON(needs.targets.outputs.targets) }}" } });
  assert.equal(job.env.TARGET, "${{ matrix.target }}");
  assert.match(baseline.jobs.targets.steps.at(-1).run, /config:targets --project "\$GITHUB_WORKSPACE\/app\/\$APP_PROJECT_DIR"/);
  const verify = job.steps.find(step => step.name === "Verify deterministic source planning");
  assert.match(verify.run, /--base-sha "\$GITHUB_SHA" --head-sha "\$GITHUB_SHA" --scope all/);
  const capture = job.steps.find(step => step.name === "Capture complete single-commit baseline");
  assert.match(capture.run, /capture:baseline/);
  assert.doesNotMatch(baselineSource, /--pull-request|capture:review|inputs\.pr/);
  const upload = job.steps.find(step => step.name === "Upload exact-commit baseline evidence");
  assert.equal(upload.with.name, "explore-baseline-${{ github.sha }}-${{ matrix.target }}");
  assert.equal(upload.with["retention-days"], 30);
  const diagnostics = job.steps.find(step => step.name === "Upload planning and baseline diagnostics");
  assert.equal(diagnostics.if, "always()");
  assert.match(diagnostics.with.path, /explore-diagnostics/);
});

test("provider secrets reach runtime capture without entering static verification or reporting", () => {
  for (const job of [review.jobs.capture, baseline.jobs.baseline]) {
    const verify = job.steps.find(step => step.name === "Verify deterministic source planning");
    assert.equal(verify.env?.OPENAI_API_KEY, undefined);
    assert.equal(verify.env?.ANTHROPIC_API_KEY, undefined);
    const capture = job.steps.find(step => /capture:(review|baseline)/.test(step.run ?? ""));
    assert.equal(capture.env.OPENAI_API_KEY, "${{ secrets.OPENAI_API_KEY }}");
    assert.equal(capture.env.ANTHROPIC_API_KEY, "${{ secrets.ANTHROPIC_API_KEY }}");
  }
  assert.doesNotMatch(JSON.stringify(review.jobs.failure), /EXPO_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  const verify = action.runs.steps.find(step => step.name === "Verify deterministic source planning");
  assert.equal(verify.env.OPENAI_API_KEY, undefined);
  assert.equal(verify.env.ANTHROPIC_API_KEY, undefined);
  const capture = action.runs.steps.find(step => step.id === "capture");
  assert.equal(capture.env.OPENAI_API_KEY, "${{ inputs.openai_api_key }}");
  assert.equal(capture.env.ANTHROPIC_API_KEY, "${{ inputs.anthropic_api_key }}");
});

test("optional Anthropic workspace selection reaches capture steps only", () => {
  assert.equal(action.inputs.anthropic_workspace_id.required, false);
  assert.equal(action.inputs.anthropic_workspace_id.default, "");
  for (const workflow of workflows) {
    assert.equal(workflow.env?.ANTHROPIC_WORKSPACE_ID, undefined);
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job.env?.ANTHROPIC_WORKSPACE_ID, undefined);
      for (const step of job.steps) {
        if (/capture:(review|baseline)/.test(step.run ?? "")) {
          assert.equal(step.env.ANTHROPIC_WORKSPACE_ID, "${{ vars.ANTHROPIC_WORKSPACE_ID }}");
        } else {
          assert.doesNotMatch(JSON.stringify(step), /ANTHROPIC_WORKSPACE_ID/);
        }
      }
    }
  }
  for (const step of action.runs.steps) {
    if (step.id === "capture") {
      assert.equal(step.env.ANTHROPIC_WORKSPACE_ID, "${{ inputs.anthropic_workspace_id }}");
    } else {
      assert.doesNotMatch(JSON.stringify(step), /ANTHROPIC_WORKSPACE_ID|anthropic_workspace_id/);
    }
  }
});

test("failed navigation traces remain in the always-uploaded diagnostic artifact", () => {
  const diagnostics = review.jobs.capture.steps.find(step => step.name === "Upload planning and failure diagnostics");
  assert.equal(diagnostics.if, "always()");
  assert.match(diagnostics.with.path, /base-map\/capture-diagnostics/);
  assert.match(diagnostics.with.path, /head-map\/capture-diagnostics/);
  assert.match(diagnostics.with.path, /explore-review\/agent-usage\.jsonl/);
  const baselineDiagnostics = baseline.jobs.baseline.steps.find(step => step.name === "Upload planning and baseline diagnostics");
  assert.equal(baselineDiagnostics.if, "always()");
  assert.match(baselineDiagnostics.with.path, /explore-baseline\/agent-usage\.jsonl/);
  const packaging = review.jobs.capture.steps.find(step => step.name === "Upload captured review for packaging");
  assert.doesNotMatch(packaging.with.path, /map\/capture-diagnostics/);
});

test("every checked-in shell step passes Bash syntax validation", () => {
  const steps = [...action.runs.steps, ...workflows.flatMap(workflow => Object.values(workflow.jobs).flatMap(job => job.steps))];
  for (const step of steps) {
    if (!step.run) continue;
    const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
    assert.equal(result.status, 0, `${step.name}: ${result.stderr}`);
  }
});


test("capture receives the automatic GitHub token for current PR verification", () => {
  const capture = review.jobs.capture.steps.find(step => step.name === "Capture review");
  assert.equal(capture.env.GITHUB_TOKEN, "${{ github.token }}");
  const compositeCapture = action.runs.steps.find(step => step.id === "capture");
  assert.equal(compositeCapture.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.doesNotMatch(reviewSource, /secrets\.GITHUB_TOKEN/);
  assert.equal(review.jobs.capture.permissions["pull-requests"], "write");
});

test("after capture, success or not, ci:after-capture stops the recorded sessions and checks every checkout", () => {
  for (const [job, condition, output, checkouts] of [
    [review.jobs.capture, "always() && steps.pr.outcome == 'success'", "explore-review", ["app-base", "app-head"]],
    [compare.jobs.capture, "always() && steps.explore.outcome == 'success'", "explore-review", ["app-base", "app-head"]],
    [baseline.jobs.baseline, "always() && steps.explore.outcome == 'success'", "explore-baseline", ["app"]],
  ]) {
    const cleanup = job.steps.find(step => step.run?.includes("ci:after-capture"));
    assert.equal(cleanup.if, condition);
    assert.ok(cleanup["timeout-minutes"] <= 5);
    assert.equal(cleanup.env.EXPO_TOKEN, "${{ secrets.EXPO_TOKEN }}");
    assert.equal(cleanup.run, `node "$TOOLS/dist/cli.js" ci:after-capture --output "$RUNNER_TEMP/${output}" ${checkouts.map(dir => `--checkout ${dir}`).join(" ")}`);
    assert.ok(job.steps.indexOf(cleanup) < job.steps.findIndex(step => step.uses?.startsWith("actions/upload-artifact@")), "before any upload");
  }
  assert.equal(action.runs.steps.at(-1).name, "Stop retained capture sessions");
  assert.equal(action.runs.steps.at(-1).if, "always() && steps.preflight.outcome == 'success'");
});


test("action rejects reused, escaping, or symlinked output paths before installing tools", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "explore-action-output-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporary = join(root, "runner-temp");
  await mkdir(temporary);
  const preflight = action.runs.steps.find(step => step.id === "preflight");
  assert.equal(preflight.env.RUNNER_TEMP_DIRECTORY, "${{ runner.temp }}");
  const script = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(preflight.run)[1];
  const check = output => spawnSync(process.execPath, ["--input-type=module", "-", output, temporary], {
    input: script, encoding: "utf8",
  });
  assert.equal(check(join(temporary, "fresh", "report")).status, 0);
  await mkdir(join(temporary, "existing"));
  await writeFile(join(temporary, "file"), "not a directory");
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(temporary, "escape"));
  await symlink(join(temporary, "existing"), join(temporary, "local-link"));
  await symlink(join(root, "outside"), join(temporary, "fresh-report-consistency"));
  for (const output of ["relative", temporary, join(root, "outside", "report"), join(temporary, "existing"),
    join(temporary, "file", "report"), join(temporary, "escape", "report"), join(temporary, "local-link", "report"),
    join(temporary, "fresh-report")]) {
    const result = check(output);
    assert.equal(result.status, 1, output);
    assert.match(result.stderr, /INVALID_OUTPUT_PATH/);
  }
});

test("action rejects unsupported Node versions before installing tools", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "explore-action-node-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const preflight = action.runs.steps.find(step => step.id === "preflight");
  const script = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(preflight.run)[1];
  for (const [version, supported] of [["22.22.0", false], ["24.11.99", false], ["24.12.0", true], ["24.21.0", true], ["26.0.0", true]]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-", join(temporary, "report"), temporary], {
      input: `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });\n${script}`,
      encoding: "utf8",
    });
    assert.equal(result.status, supported ? 0 : 1, `${version}: ${result.stderr}`);
    if (!supported) assert.match(result.stderr, /NODE_VERSION_UNSUPPORTED::Install Node\.js 24\.12 or newer/);
  }
});

test("the deploy job is the only post-capture job that holds EXPO_TOKEN, and it runs only for a requested hosted preview", () => {
  const deploy = review.jobs.deploy;
  assert.deepEqual(deploy.needs, ["targets", "capture", "report"]);
  assert.equal(deploy.if, "needs.capture.outputs.preview == 'eas'");
  assert.deepEqual(deploy.permissions, { contents: "read", actions: "read", "pull-requests": "write" });
  const step = deploy.steps.find(step => step.name === "Deploy the hosted preview and publish its Explore report links");
  assert.equal(step.env.EXPO_TOKEN, "${{ secrets.EXPO_TOKEN }}");
  assert.equal(step.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(step.env.ARTIFACT_URL, undefined);
  assert.match(step.run, /ci:deploy --inputs "\$RUNNER_TEMP\/explore-review" --reports "\$RUNNER_TEMP\/explore-report"/);
  // Every target's capture and report artifact, one directory each, so the deployment serves all of them.
  const downloads = deploy.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(downloads.map(step => step.with.pattern), ["explore-capture-${{ github.run_id }}-${{ github.run_attempt }}-*", "explore-review-${{ github.run_id }}-${{ github.run_attempt }}-*"]);
  assert.ok(downloads.every(step => step.with.name === undefined && step.with["merge-multiple"] === undefined));
  assert.doesNotMatch(JSON.stringify(deploy), /OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  assert.equal(review.jobs.report.outputs, undefined);
  // capture:review writes preview=<hosting> to the step outputs from the reviewed config.
  assert.equal(review.jobs.capture.outputs.preview, "${{ steps.capture.outputs.preview }}");
  assert.match(review.jobs.capture.steps.find(step => step.id === "capture").run, /capture:review/);
  assert.deepEqual(review.jobs.failure.needs, ["targets", "capture", "report", "deploy"]);
  assert.match(review.jobs.failure.if, /needs\.targets\.result == 'failure'/);
  assert.match(review.jobs.failure.if, /needs\.deploy\.result == 'failure'/);
});

test("closing a pull request runs nothing: hosted previews stay until a developer deletes them", () => {
  assert.ok(!review.on.pull_request_target.types.includes("closed"));
  assert.doesNotMatch(review.jobs.targets.if, /closed/);
  assert.equal(review.jobs.cleanup, undefined);
  for (const workflow of workflows) assert.doesNotMatch(JSON.stringify(workflow), /ci:cleanup|deploy:delete/);
});

test("review captures and reports each configured target in its own matrix job, with target-suffixed artifacts", () => {
  const targets = review.jobs.targets;
  assert.deepEqual(targets.permissions, { contents: "read", "pull-requests": "read" });
  assert.equal(targets.outputs.targets, "${{ steps.targets.outputs.targets }}");
  // config:targets lists ids in config order; a config without targets: lists ["ios"] / ["ios","android"], as config:platforms did.
  assert.match(targets.steps.at(-1).run, /config:targets --project "\$GITHUB_WORKSPACE\/app-head\/\$APP_PROJECT_DIR" --config \.expo-explore\/config\.yaml/);
  assert.equal(targets.outputs.max_parallel, "${{ steps.targets.outputs.max_parallel }}");
  assert.doesNotMatch(JSON.stringify(targets), /EXPO_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|APP_REVIEW/);
  for (const workflow of [review, compare, baseline]) {
    assert.doesNotMatch(JSON.stringify(workflow), /matrix\.platform|config:platforms|\$PLATFORM|needs\.platforms/, "every job is keyed by target, never by platform");
    assert.match(JSON.stringify(workflow), /matrix\.target/, "doctor looks for matrix.target in an installed workflow");
  }
  // Each capture job needs a simulator session, so at most capture.maxSessions of them run at once; a report needs none.
  for (const job of [review.jobs.capture, compare.jobs.capture]) {
    assert.deepEqual(job.strategy, { "fail-fast": false, "max-parallel": "${{ fromJSON(needs.targets.outputs.max_parallel) }}",
      matrix: { target: "${{ fromJSON(needs.targets.outputs.targets) }}" } });
    assert.equal(job.env.TARGET, "${{ matrix.target }}");
  }
  assert.deepEqual(review.jobs.report.strategy, { "fail-fast": false, matrix: { target: "${{ fromJSON(needs.targets.outputs.targets) }}" } });
  assert.equal(review.jobs.report.env.TARGET, "${{ matrix.target }}");
  assert.equal(review.jobs.capture.needs, "targets");
  assert.deepEqual(review.jobs.report.needs, ["targets", "capture"]);
  const runs = [review.jobs.capture, review.jobs.report, baseline.jobs.baseline].flatMap(job => job.steps.filter(step => step.run).map(step => step.run));
  for (const command of ["source:verify", "capture:review", "capture:baseline", "ci:report", "ci:publish"]) {
    const uses = runs.filter(run => run.includes(`cli.js" ${command}`));
    assert.ok(uses.length > 0, command);
    for (const run of uses) assert.match(run, /--target "\$TARGET"/, command);
  }
  for (const workflow of [review, compare]) {
    assert.equal(workflow.jobs.capture.steps.find(step => step.name === "Find optional exact-base evidence").run,
      'node "$TOOLS/dist/cli.js" ci:find-baseline --sha "$BASE_SHA" --target "$TARGET"');
  }
  for (const [job, name] of [[review.jobs.capture, "Upload captured review for packaging"], [review.jobs.capture, "Upload planning and failure diagnostics"],
    [review.jobs.report, "Upload hosted review bundle"], [review.jobs.report, "Upload report failure diagnostics"],
    [baseline.jobs.baseline, "Upload exact-commit baseline evidence"], [baseline.jobs.baseline, "Upload planning and baseline diagnostics"]]) {
    assert.ok(job.steps.find(step => step.name === name).with.name.endsWith("-${{ matrix.target }}"), name);
  }
});

test("compare reviews any two refs from a manual run or another workflow, with no pull request access", () => {
  for (const trigger of ["workflow_dispatch", "workflow_call"]) {
    assert.deepEqual(Object.keys(compare.on[trigger].inputs).sort(), ["base", "expires-in", "head", "scope"]);
    for (const name of ["base", "head"]) assert.equal(compare.on[trigger].inputs[name].required, true);
    for (const name of ["scope", "expires-in"]) assert.deepEqual([compare.on[trigger].inputs[name].required, compare.on[trigger].inputs[name].default], [false, ""]);
  }
  assert.deepEqual(Object.keys(compare.on).sort(), ["workflow_call", "workflow_dispatch"]);
  for (const job of Object.values(compare.jobs)) assert.equal(job.permissions["pull-requests"], undefined, "a comparison never touches pull requests");
  const capture = compare.jobs.capture.steps.find(step => step.name === "Capture review");
  assert.match(capture.run, /capture:review[\s\S]*--compare "\$RUNNER_TEMP\/explore-compare\.json"/);
  assert.doesNotMatch(compareSource, /ci:failure|--pull-request/);
  // Each override reaches the CLI only when the caller set it; the CLI validates the value.
  assert.match(capture.run, /\$\{SCOPE:\+--scope "\$SCOPE"\} \$\{EXPIRES_IN:\+--expires-in "\$EXPIRES_IN"\}/);
  assert.match(compare.jobs.capture.steps.find(step => step.name === "Verify deterministic source planning").run, /\$\{SCOPE:\+--scope "\$SCOPE"\}/);
  assert.match(compare.jobs.report.steps.find(step => step.name === "Link the report from the run summary").run, /ci:publish --input .* --artifact-url "\$ARTIFACT_URL" --target "\$TARGET"/);
  assert.equal(compare.jobs.capture.env.BASE_SHA, "${{ needs.targets.outputs.base }}", "capture checks out the commits the refs resolved to once");
  assert.equal(compare.jobs.capture.env.HEAD_SHA, "${{ needs.targets.outputs.head }}");
  assert.equal(compare.concurrency.group, "explore-compare-${{ inputs.base }}..${{ inputs.head }}", "\"..\" cannot appear in a ref, so groups never collide");
  const diagnostics = compare.jobs.report.steps.find(step => step.name === "Upload report failure diagnostics");
  assert.deepEqual([diagnostics.if, diagnostics.with.path], ["always()", "${{ runner.temp }}/explore-diagnostics"]);
  assert.match(compare.jobs.targets.steps.find(step => step.id === "refs").run, /ci:compare-refs --project app-head --base "\$BASE_REF" --head "\$HEAD_REF"/);
  assert.match(compare.jobs.capture.steps.find(step => step.id === "capture").run, /printf '%s' "\$COMPARE" > "\$RUNNER_TEMP\/explore-compare\.json"/);
  assert.match(compare.jobs.deploy.steps.at(-1).run, /ci:deploy --inputs/);
});

test("the targets job lists the target ids and how many capture jobs run at once: no more than capture.maxSessions", async t => {
  const root = await mkdtemp(join(tmpdir(), "explore-targets-step-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new URL("../..", import.meta.url).pathname;
  const run = async (workflow, checkout, config) => {
    const project = join(root, checkout); await mkdir(join(project, ".expo-explore"), { recursive: true });
    await writeFile(join(project, ".expo-explore", "config.yaml"), config);
    const output = join(root, "output"); await writeFile(output, "");
    const step = workflow.jobs.targets.steps.find(entry => entry.id === "targets");
    const result = spawnSync("bash", ["-c", step.run], { encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, TOOLS: tools, GITHUB_WORKSPACE: root, APP_PROJECT_DIR: ".", GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries((await readFile(output, "utf8")).trim().split("\n").map(line => line.split(/=(.*)/s).slice(0, 2)));
    return { targets: JSON.parse(outputs.targets), maxParallel: JSON.parse(outputs.max_parallel) };
  };
  const app = "app:\n  bundleId: com.example.app\n  easProfile: explore\ndevice:\n  name: iPhone 17\n";
  const five = "targets:\n" + ["iphone", "ipad", "duo-closed", "duo-open"].map(id => `  ${id}: { platform: ios }\n`).join("") + "  pixel: { platform: android, bundleId: com.example.app, easProfile: explore }\n";
  for (const [workflow, checkout] of [[review, "app-head"], [compare, "app-head"], [baseline, "app"]]) {
    assert.deepEqual(await run(workflow, checkout, app + five), { targets: ["iphone", "ipad", "duo-closed", "duo-open", "pixel"], maxParallel: 5 }, "unset: five");
    assert.deepEqual((await run(workflow, checkout, app + "capture:\n  maxSessions: 2\n" + five)).maxParallel, 2, "a starter plan's two");
    assert.deepEqual(await run(workflow, checkout, app), { targets: ["ios"], maxParallel: 1 });
  }
});
