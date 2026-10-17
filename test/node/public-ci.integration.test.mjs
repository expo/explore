import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { runPublicCi, runBaselineCi } from '../../dist/ci/pipeline.js';
import { exportCiReport, publishCiReportComment } from '../../dist/report/artifact.js';
import { prepareCaptureReview, readCaptureBundle } from '../../dist/review/capture-review.js';
import { AGENT_ACCEPTANCE_POLICY, assertAgentAcceptance } from '../../dist/contracts/capture.js';
import { CiError } from '../../dist/shared/ci-errors.js';
import { assertNoCaptureHealthIssues, partitionCaptureHealthIssues } from '../../dist/capture/health.js';
import { fixture, git, value, usageReceipt, readUsage } from '../helpers/public-ci-fixture.mjs';
for (const provider of ['expo-router', 'react-navigation']) {
  test(`${provider}: source commits -> baseline cache -> PR capture -> artifact and hosted comment`, async t => {
    const f = await fixture(t, provider);
    t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
    await assert.rejects(runPublicCi({ baseProject: f.baseProject, headProject: f.headProject,
      pullRequestPath: f.pullRequestPath, output: join(f.root, 'missing-token'), config: f.config,
      environment: { ...f.environment, GITHUB_TOKEN: '' }, runner: f.runner, now: f.now, sleep: f.sleep }), error => {
      assert.equal(error.code, 'GITHUB_TOKEN_MISSING');
      assert.match(error.nextAction, /automatic github.token/);
      assert.doesNotMatch(error.nextAction, /Add GITHUB_TOKEN to.*secrets/);
      return true;
    });
    assert.equal(f.requests.length, 0, 'missing GitHub context fails before build or device allocation');
    const baseline = await runBaselineCi({ project: f.baseProject, sha: f.baseSha, output: join(f.root, 'baseline'), config: f.config, environment: f.environment, runner: f.runner, now: f.now, sleep: f.sleep });
    assert.equal(baseline.cached, true);
    const baselineBundle = await readCaptureBundle(baseline.directory);
    assert.equal(baselineBundle.gitCommit, f.baseSha);
    assert.ok(Object.values(baselineBundle.outcomes).every(outcome => outcome.status === 'captured' && outcome.landing === 'verified'));
    const before = f.requests.length;
    const output = join(f.root, 'review');
    const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath, output,
      config: f.config, environment: { ...f.environment, EXPLORE_CAPTURE_CACHE: baseline.directory }, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep });
    const plan = JSON.parse(await readFile(join(output, 'execution-plan.json'), 'utf8'));
    assert.equal(result.review.contract, 'explore.review');
    assert.equal(result.review.runtime.appVersion, '3.0.0', 'the Viewer header shows the captured app version');
    assert.equal(result.review.runtime.appBuildNumber, '7', 'the Viewer header shows the captured build number');
    assert.equal(result.review.surfaces.some(row => row.status === 'added'), true);
    assert.equal(result.review.surfaces.some(row => row.status === 'removed'), true);
    assert.equal(result.review.surfaces.some(row => row.status === 'modified'), true);
    assert.equal(result.review.surfaces.every(row => (row.head ?? row.base).provider === provider), true);
    assert.equal(result.evidence.summary.visual.failed, 0, 'local screenshot comparison succeeds');
    assert.ok(result.evidence.summary.visual.compared > 0);
    const ownSource = result.review.surfaces.find(row => (row.head ?? row.base).routeFile.endsWith(provider === 'expo-router' ? '/home.tsx' : '/Home.tsx'));
    assert.equal(ownSource.sourceChange.impact, 'direct');
    assert.ok(ownSource.sourceChange.files.length > 0);
    assert.ok(plan.surfaces.every(row => row.sourceChange));
    assert.equal((await readFile(join(output, 'plan.json'), 'utf8')).includes('sourceChange'), false);
    assert.equal(JSON.parse(await readFile(join(output, 'consistency.json'), 'utf8')).verified, true);
    const baseBundle = await readCaptureBundle(join(output, 'base-export'));
    const headBundle = await readCaptureBundle(join(output, 'head-export'));
    assert.deepEqual(Object.keys(baseBundle.outcomes).sort(), [...plan.baseCaptureSurfaceIds].sort());
    assert.deepEqual(Object.keys(headBundle.outcomes).sort(), [...plan.headCaptureSurfaceIds].sort());
    for (const [id, image] of Object.entries(baseBundle.images)) assert.deepEqual(image, baselineBundle.images[id], 'base evidence retains its original capture provenance');
    const starts = f.requests.slice(before).filter(request => request.args[0] === 'simulator:start');
    assert.equal(starts.length, 1, 'an exact baseline cache avoids a second EAS allocation');
    assert.equal(value(starts[0], '--device'), f.config.device.name);
    // The session starts empty beside the repack; the head's repacked app is installed through the controller.
    assert.equal(starts[0].args.includes('--build-id'), false);
    const installs = f.requests.slice(before).filter(request => request.args[0] === 'install');
    assert.equal(installs.length, 1);
    const packaged = await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact') });
    const report = JSON.parse(await readFile(join(packaged.outputPath, 'review.json'), 'utf8'));
    assert.equal(report.kind, 'explore.report');
    assert.equal(report.review.surfaces.length, plan.inventorySurfaceIds.length);
    assert.equal(report.assets.length, result.assets.length);
    assert.ok(report.assets.length > 0);
    const repeated = await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact-repeat') });
    assert.equal(await readFile(join(repeated.outputPath, 'review.json'), 'utf8'),
      await readFile(join(packaged.outputPath, 'review.json'), 'utf8'), 'the same captured evidence produces byte-identical review metadata');
    for (const asset of report.assets) {
      assert.deepEqual(await readFile(join(repeated.outputPath, asset.path)), await readFile(join(packaged.outputPath, asset.path)),
        're-export preserves every screenshot byte');
    }
    const published = await publishCiReportComment({ inputPath: result.inputPath,
      artifactUrl: 'https://github.com/acme/example/actions/runs/1234/artifacts/900', environment: f.environment, transport: f.transport });
    assert.equal(new URL(published.artifactUrl).origin, 'https://explore-preview.expo.app', 'CI always uses the hosted viewer, even with a legacy origin override');
    assert.match(f.comments.at(-1), /\[Open\]\(<https:\/\/explore-preview\.expo\.app\/\?[^>]+>\)/);
    assert.match(f.comments.at(-1), /\[zip\]\(<https:\/\/github\.com\/acme\/example\/actions\/runs\/1234\/artifacts\/900>\)/);
    assert.match(f.comments.at(-1), /explore-preview\.expo\.app/);
    assert.doesNotMatch(f.comments.at(-1), /viewer\.example/);
    // A matrix job's report artifact carries its target id: an unsuffixed artifact is not target duo-open's.
    const publishAs = selection => publishCiReportComment({ inputPath: result.inputPath,
      artifactUrl: 'https://github.com/acme/example/actions/runs/1234/artifacts/900', environment: f.environment, transport: f.transport, ...selection });
    await assert.rejects(publishAs({ target: 'duo-open' }), error => error.code === 'REPORT_ARTIFACT_MISMATCH');
    await assert.rejects(publishAs({ platform: 'ios' }), error => error.code === 'REPORT_ARTIFACT_MISMATCH', '--platform ios names explore-review-<run>-<attempt>-ios');
    await assert.rejects(publishAs({ target: 'Duo/../x' }), error => error.code === 'TARGET_INVALID');
    assert.equal(git(f.baseProject, 'status', '--porcelain'), '');
    assert.equal(git(f.headProject, 'status', '--porcelain'), '');
    assert.equal(f.requests.filter(request => request.args[0] === 'simulator:start').length,
      f.requests.filter(request => request.args[0] === 'simulator:stop').length);
  });
}

test('unreachable screens do not fail CI: both revisions, the report and an Incomplete PR comment naming them are published', async t => {
  const f = await fixture(t, 'expo-router', { observerFailurePath: '/home' });
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const output = join(f.root, 'review');
  const progress = [];
  const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject,
    pullRequestPath: f.pullRequestPath, output, config: f.config, environment: f.environment,
    transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep, progress: line => progress.push(line) });
  assert.ok(result.inputPath, 'the report input is produced for the report job');
  // The observer never answers on /home. On the base it is the first route, so the build has not shown an observer yet
  // and the screen is unavailable; on the head /added was attributed first, so /home is "not ready" and the frame the
  // app showed is published as unattributed evidence.
  const base = await readCaptureBundle(join(output, 'base-export'));
  const baseHome = Object.entries(base.outcomes).find(([, outcome]) => outcome.error?.code === 'CAPTURE_OBSERVER_MISSING');
  assert.ok(baseHome && !base.images[baseHome[0]]);
  const head = await readCaptureBundle(join(output, 'head-export'));
  const headHome = Object.entries(head.outcomes).find(([, outcome]) => outcome.status === 'captured' && outcome.landing === 'unverified');
  assert.ok(headHome && head.images[headHome[0]], 'the unattributed frame is in the bundle');
  assert.deepEqual(headHome[1].observed, { reason: 'observer-not-ready', attempts: 2 });
  for (const bundle of [base, head]) {
    assert.ok(Object.values(bundle.outcomes).some(outcome => outcome.status === 'captured' && outcome.landing === 'verified'));
    assert.ok(Object.keys(bundle.images).length > 0, 'valid evidence is reported alongside the unavailable screen');
  }
  const warnings = progress.filter(line => line.startsWith('::warning title=Explore '));
  assert.deepEqual(warnings.map(line => line.slice(0, line.indexOf('::', 2))).sort(),
    ['::warning title=Explore base capture unavailable (home)', '::warning title=Explore head capture unavailable (home)']
      .map(line => line.replace('(home)', `(${result.review.surfaces.find(surface => surface.head?.route === '/home')?.id})`)).sort());
  assert.ok(progress.includes('2 screens are unavailable in this report'));
  const reportInput = JSON.parse(await readFile(join(output, 'report-input.json'), 'utf8'));
  assert.equal(reportInput.publicReview.surfaces.filter(surface => surface.headOutcome && surface.headOutcome.status !== 'captured').length, 0);
  assert.equal(reportInput.publicReview.surfaces.filter(surface => surface.headOutcome?.landing === 'unverified' && surface.headImage).length, 1);
  assert.equal(reportInput.publicReview.surfaces.filter(surface => surface.baseOutcome && surface.baseOutcome.status !== 'captured').length, 1);
  await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact') });
  await publishCiReportComment({ inputPath: result.inputPath,
    artifactUrl: 'https://github.com/acme/example/actions/runs/1234/artifacts/900', environment: f.environment, transport: f.transport });
  const comment = f.comments.at(-1).replaceAll('\\', '');
  assert.match(comment, /\| iOS \| [^|]+\| 🟨 [^|]*unavailable[^|]*\| \[Open\]\(<https:\/\/explore-preview\.expo\.app/, 'the report link is published even though a screen is unavailable');
  assert.doesNotMatch(comment, /🟥 failed/);
  assert.match(comment, /Head · \/home · CAPTURE_OBSERVER_NOT_READY/);
  assert.match(comment, /Base · \/home · CAPTURE_OBSERVER_MISSING/);
  assert.match(comment, /1 unavailable/);
  assert.match(comment, /1 unattributed/);
  assert.equal(f.requests.filter(request => request.args[0] === 'simulator:stop').length, 2);
  assert.equal(git(f.baseProject, 'status', '--porcelain'), '');
  assert.equal(git(f.headProject, 'status', '--porcelain'), '');
});

test('evidence that cannot be trusted still fails CI', async t => {
  const f = await fixture(t, 'expo-router', { observerFailurePath: '/home' });
  const split = partitionCaptureHealthIssues([
    { side: 'head', surfaceId: 'x', code: 'CAPTURE_IMAGE_BINDING_INVALID', message: 'm', nextAction: 'n' },
    { side: 'head', surfaceId: 'y', code: 'SETUP_FAILED', message: 'm', nextAction: 'n' },
  ]);
  assert.deepEqual(split.integrity.map(issue => issue.surfaceId), ['x']);
  assert.deepEqual(split.unavailable.map(issue => issue.surfaceId), ['y']);
  assert.throws(() => assertNoCaptureHealthIssues(split.integrity), { code: 'CAPTURE_INCOMPLETE', stage: 'capture-validation' });
  assert.doesNotThrow(() => assertNoCaptureHealthIssues([]));
  assert.ok(f.root);
});

test('baseline with a planned dynamic route that lacks parameters is cached without that screen and says so', async t => {
  const f = await fixture(t, 'expo-router', { unresolvedParameters: true });
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const output = join(f.root, 'baseline');
  const progress = [];
  const baseline = await runBaselineCi({ project: f.baseProject, sha: f.baseSha, output,
    config: f.config, environment: f.environment, runner: f.runner, now: f.now, sleep: f.sleep, progress: line => progress.push(line) });
  assert.equal(baseline.cached, true);
  assert.equal(baseline.unavailable, 1);
  assert.ok(progress.some(line => line.startsWith('::warning title=Explore head capture unavailable') && line.includes('CAPTURE_MISSING_PARAMS')), progress.join('\n'));
  assert.ok(progress.some(line => /1 screen is unavailable in this baseline/.test(line)));
  const bundle = await readCaptureBundle(join(output, 'baseline-export'));
  assert.ok(Object.values(bundle.outcomes).some(outcome => outcome.status === 'missing-params'));
  assert.ok(Object.values(bundle.outcomes).some(outcome => outcome.status === 'captured' && outcome.landing === 'verified'));
  assert.equal(f.requests.filter(request => request.args[0] === 'simulator:stop').length, 1);
});

test('docs-only changes publish a complete inventory without allocating an EAS build or session', async t => {
  const f = await fixture(t, 'expo-router', { docsOnly: true });
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  // The pipeline stamps its times from the fixture's simulated clock, which starts at the wall clock and runs ahead of it.
  const startedAt = f.now();
  const output = join(f.root, 'review');
  const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath,
    output, config: f.config, environment: f.environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep });
  assert.ok(result.review.surfaces.length > 0);
  assert.equal(result.review.surfaces.every(row => row.status === 'unchanged'), true);
  assert.equal(f.requests.some(request => request.command !== 'git'), false);
  assert.equal(result.assets.length, 0);
  const packaged = await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact') });
  assert.equal(packaged.imageCount, 0);
  const report = JSON.parse(await readFile(join(packaged.outputPath, 'review.json'), 'utf8'));
  assert.equal(report.review.surfaces.length, result.review.surfaces.length);
  const sides = await Promise.all(['base', 'head'].map(async side => {
    const directory = join(output, `${side}-export`);
    const bundle = await readCaptureBundle(directory);
    const map = JSON.parse(await readFile(join(directory, 'screen-map.json'), 'utf8'));
    assert.equal(bundle.completedAt, map.run.completedAt);
    assert.ok(Date.parse(bundle.completedAt) >= startedAt && Date.parse(bundle.completedAt) <= f.now());
    return { directory, bundle };
  }));
  assert.equal(result.review.createdAt, new Date(Math.max(...sides.map(({ bundle }) => Date.parse(bundle.completedAt)))).toISOString());
  const preparation = { plan: JSON.parse(await readFile(join(output, 'execution-plan.json'), 'utf8')),
    pullRequest: JSON.parse(await readFile(f.pullRequestPath, 'utf8')), baseDirectory: sides[0].directory, headDirectory: sides[1].directory,
    runId: f.environment.GITHUB_RUN_ID, runAttempt: f.environment.GITHUB_RUN_ATTEMPT,
    assertCurrentHead: async () => {}, assessments: result.evidence.surfaces };
  assert.deepEqual((await prepareCaptureReview(preparation)).review, result.review, 'preparing the same bundles again retains the runtime timestamp');
  const repeated = await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact-again') });
  assert.equal(await readFile(join(repeated.outputPath, 'review.json'), 'utf8'), await readFile(join(packaged.outputPath, 'review.json'), 'utf8'));
  for (const { directory, bundle } of sides) {
    delete bundle.completedAt;
    await writeFile(join(directory, 'bundle.json'), JSON.stringify(bundle));
  }
  assert.equal((await prepareCaptureReview(preparation)).review.createdAt, result.review.createdAt, 'internal bundles without a timestamp use their recorded map completion time');
  for (const { directory } of sides) await rm(join(directory, 'screen-map.json'));
  await assert.rejects(prepareCaptureReview(preparation), error => error.code === 'CAPTURE_TIMESTAMP_MISSING');
});


test('zero-target agent review needs no provider or Expo credential and makes no runtime requests', async t => {
  const f = await fixture(t, 'expo-router', { docsOnly: true, agentMode: true });
  delete f.environment.EXPO_TOKEN;
  delete f.environment.ANTHROPIC_API_KEY;
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No provider request is permitted'));
  const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject,
    pullRequestPath: f.pullRequestPath, output: join(f.root, 'agent-empty'), config: f.config,
    environment: f.environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep,
    agentSessionFactory: () => assert.fail('Zero-target planning must not create an agent session') });
  assert.ok(result.inputPath);
  assert.equal(f.requests.filter(request => basename(request.command) !== "git").length, 0);
});

test('active agent missing key fails before builds and writes actionable feedback', async t => {
  const f = await fixture(t, 'expo-router', { agentMode: true });
  delete f.environment.ANTHROPIC_API_KEY;
  await assert.rejects(runPublicCi({ baseProject: f.baseProject, headProject: f.headProject,
    pullRequestPath: f.pullRequestPath, output: join(f.root, 'agent-missing-key'), config: f.config,
    environment: f.environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep,
    agentSessionFactory: () => assert.fail('An injected session cannot bypass the provider-secret gate') }), { code: 'AGENT_API_KEY_MISSING' });
  await assert.rejects(runBaselineCi({ project: f.baseProject, sha: f.baseSha, output: join(f.root, 'baseline-agent-missing-key'),
    config: f.config, environment: f.environment, runner: f.runner, now: f.now, sleep: f.sleep,
    agentSessionFactory: () => assert.fail('Baseline cannot bypass the provider-secret gate') }), { code: 'AGENT_API_KEY_MISSING' });
  assert.equal(f.requests.length, 0);
  assert.match(f.comments.at(-1), /ANTHROPIC/);
});

test('PR verification retries a transient server response and continues with the live identity', async t => {
  const f = await fixture(t, 'expo-router', { docsOnly: true });
  let checks = 0;
  const transport = async (input, init) => {
    if (new URL(input).pathname.endsWith('/pulls/7') && ++checks === 1) return new Response('', { status: 500 });
    return f.transport(input, init);
  };
  const result = await runPublicCi({ ...f, output: join(f.root, 'retry-review'), transport });
  assert.ok(result.inputPath);
  assert.ok(checks > 2, 'the failed read retries and later publication still verifies the live PR');
  assert.ok(f.comments.length > 0);
});

test('persistent PR verification server errors stop after three reads without retrying feedback', async t => {
  const f = await fixture(t, 'expo-router', { docsOnly: true });
  let checks = 0;
  const transport = async (input, init) => {
    if (new URL(input).pathname.endsWith('/pulls/7')) { checks++; return new Response('', { status: 503 }); }
    return f.transport(input, init);
  };
  await assert.rejects(runPublicCi({ ...f, output: join(f.root, 'retry-failed'), transport }), error => {
    assert.equal(error.code, 'GITHUB_REQUEST_FAILED');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(checks, 3);
  assert.equal(f.comments.length, 0);
  assert.equal(f.requests.length, 0);
});

test('a PR that moved during a verification retry still publishes, as a previous run', async t => {
  const f = await fixture(t, 'expo-router', { docsOnly: true });
  let checks = 0;
  const transport = async (input, init) => {
    if (new URL(input).pathname.endsWith('/pulls/7')) {
      if (++checks === 1) return new Response('', { status: 502 });
      const response = await f.transport(input, init);
      const pr = await response.json();
      pr.head.sha = 'd'.repeat(40);
      return Response.json(pr);
    }
    return f.transport(input, init);
  };
  await runPublicCi({ ...f, output: join(f.root, 'retry-stale'), transport });
  assert.ok(checks >= 2, 'the 502 was retried');
  assert.ok(f.comments.length > 0, 'the run keeps posting; its report is kept under previous runs');
  assert.match(f.comments.at(-1), /Previous runs \(1\)/);
  assert.match(f.comments.at(-1), /The pull request moved while this run worked/);
  assert.doesNotMatch(f.comments.at(-1), /^<sub>base \[/m, 'nothing is presented as the current review');
});

test('authorization and other non-server PR verification failures are never retried', async t => {
  for (const [status, code] of [[401, 'GITHUB_TOKEN_INVALID'], [403, 'GITHUB_PERMISSION_DENIED'],
    [404, 'GITHUB_REQUEST_FAILED'], [429, 'GITHUB_REQUEST_FAILED']]) {
    await t.test(String(status), async t => {
      const f = await fixture(t, 'expo-router', { docsOnly: true });
      let checks = 0;
      const transport = async (input, init) => {
        if (new URL(input).pathname.endsWith('/pulls/7')) { checks++; return new Response('', { status }); }
        return f.transport(input, init);
      };
      await assert.rejects(runPublicCi({ ...f, output: join(f.root, 'retry-denied'), transport }), error => {
        assert.equal(error.code, code);
        assert.equal(error.retryable, false);
        return true;
      });
      assert.equal(checks, 1);
      assert.equal(f.comments.length, 0);
    });
  }
});

test('PR verification retries transient network errors and bounds persistent timeouts', async t => {
  for (const persistent of [false, true]) {
    await t.test(persistent ? 'timeout' : 'connection reset', async t => {
      const f = await fixture(t, 'expo-router', { docsOnly: true });
      let checks = 0;
      const transport = async (input, init) => {
        if (new URL(input).pathname.endsWith('/pulls/7')) {
          checks++;
          if (persistent) throw new DOMException('Request timed out with private details', 'TimeoutError');
          if (checks === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        }
        return f.transport(input, init);
      };
      const review = runPublicCi({ ...f, output: join(f.root, 'retry-network'), transport });
      if (persistent) {
        await assert.rejects(review, error => {
          assert.equal(error.code, 'GITHUB_REQUEST_FAILED');
          assert.equal(error.retryable, true);
          assert.doesNotMatch(error.message, /private details/);
          return true;
        });
        assert.equal(checks, 3);
        assert.equal(f.comments.length, 0);
      } else assert.ok((await review).inputPath);
    });
  }
});

test('CLI sessions recover navigation, accept both-side inspected frames, finish required transitions, and write notes', async t => {
  const f = await fixture(t, 'expo-router', { agentMode: true, recoverableOpenFailure: true,
    instructions: 'Explore selected routes in a stable, comparable state. After all selected captures are complete, open sample://unaffected and observe that screen before finishing.' });
  f.environment.ANTHROPIC_API_KEY = 'fixture-private-provider-key';
  t.mock.method(globalThis, 'fetch', async () => assert.fail('CLI session integration must not fall back to a raw provider HTTP request'));
  const phases = [], accepted = new Map();
  let factories = 0, preflights = 0, recoveries = 0;
  const screenshots = () => f.requests.filter(request => request.args[0] === 'screenshot').length;
  const agentSessionFactory = (config, options) => {
    factories++;
    assert.equal(config.provider, 'anthropic');
    assert.equal(config.model, 'fixture-model');
    assert.equal(options.env.ANTHROPIC_API_KEY, f.environment.ANTHROPIC_API_KEY);
    return {
      provider: config.provider, model: config.model,
      preflight: async request => {
        preflights++; assert.equal(request.timeoutMs, 30_000);
        await options.onUsage(usageReceipt({ totals: { inputTokens: 1, outputTokens: 1 }, models: [] }));
      },
      run: async request => {
        const notes = request.tools.some(tool => tool.name === 'read_evidence');
        const readiness = request.tools.some(tool => tool.name === 'submit_readiness');
        const phase = { name: readiness ? 'readiness' : notes ? 'notes' : 'navigation', events: [] };
        phases.push(phase);
        assert.ok(request.deadlineMs > Date.now());
        const signal = request.signal ?? new AbortController().signal;
        const call = async (name, input = {}) => {
          const response = await request.callTool(name, input, signal);
          const result = JSON.parse(response.content.find(block => block.type === 'text').text);
          phase.events.push({ name, input, result, isError: response.isError === true });
          return { response, result };
        };
        const context = JSON.parse(request.prompt);
        if (readiness) {
          assert.equal(request.images.length, 1);
          assert.deepEqual(request.tools.map(tool => tool.name), ['submit_readiness']);
          assert.equal(createHash('sha256').update(Buffer.from(request.images[0].data, 'base64')).digest('hex'), context.imageSha256);
          await request.callTool('submit_readiness', { imageSha256: context.imageSha256, ready: true, reason: 'Fixture screen is visible.' }, signal);
          await options.onUsage(usageReceipt({ totals: { inputTokens: 3, outputTokens: 1 }, models: [] }));
          return { inputTokens: 3, outputTokens: 1 };
        }
        if (notes) {
          for (const surfaceId of context.pendingSurfaceIds) {
            const { response, result: evidence } = await call('read_evidence', { surfaceId });
            assert.equal(response.isError, undefined);
            assert.ok(response.content.some(block => block.type === 'image'));
            const submitted = await call('submit_change_note', { surfaceId, evidenceDigest: evidence.evidenceDigest,
              text: evidence.deterministicReview?.status === 'unchanged' ? 'No visible change.' : 'Screen content changes.' });
            assert.equal(submitted.response.isError, undefined);
          }
          await options.onUsage(usageReceipt({ totals: { inputTokens: 50, outputTokens: 10 }, models: [] }));
          return { inputTokens: 50, outputTokens: 10 };
        }
        assert.match(context.instructions, /open sample:\/\/unaffected.*before finishing/);
        assert.deepEqual(request.tools.map(tool => tool.name), ['stop_blocked', 'observe', 'get_progress', 'read_source', 'act', 'capture', 'finish']);
        let observed = await call('observe');
        for (const target of context.selectedTargets) {
          if (!observed.result.currentTargets.some(current => current.id === target.id)) {
            const input = { action: 'open', url: `sample://${target.path.replace(/^\//, '')}` };
            let moved = await call('act', input);
            if (moved.response.isError) {
              recoveries++;
              assert.ok(moved.result.error.code);
              observed = await call('observe');
              assert.equal(observed.response.isError, false, 'the session observes actual state after a failed UI command');
              moved = await call('act', input);
            }
            assert.equal(moved.response.isError, false);
            observed = await call('observe');
          }
          assert.ok(observed.result.currentTargets.some(current => current.id === target.id));
          const image = observed.response.content.find(block => block.type === 'image');
          assert.ok(image, 'capture receives the image that the session inspected');
          assert.equal(createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex'), observed.result.imageSha256);
          const before = screenshots();
          const captured = await call('capture', { targetId: target.id, frameId: observed.result.frameId,
            description: 'Stable fixture screen', requiredLabels: ['screen-title'] });
          assert.equal(captured.response.isError, false);
          assert.equal(screenshots(), before, 'accepting the inspected frame must not take a replacement screenshot');
          accepted.set(observed.result.frameId, { targetId: target.id, imageSha256: observed.result.imageSha256,
            capturedAt: observed.result.capturedAt });
          if (target !== context.selectedTargets.at(-1)) observed = await call('observe');
        }
        assert.equal(phase.events.at(-1).result.remainingCount, 0);
        assert.equal((await call('get_progress')).result.remainingTargets.length, 0);
        assert.equal((await call('act', { action: 'open', url: 'sample://unaffected' })).response.isError, false);
        const final = await call('observe');
        assert.ok(final.result.observation.nodes.some(node => node.identifier === 'screen-title' && node.label === '/unaffected'));
        const finished = await call('finish', { procedureSummary: 'Captured every selected screen, then opened and inspected the required unaffected screen.' });
        assert.equal(finished.response.isError, false);
        await options.onUsage(usageReceipt());
        return { inputTokens: 100, outputTokens: 20 };
      },
    };
  };
  const output = join(f.root, 'agent-review');
  const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject,
    pullRequestPath: f.pullRequestPath, output, config: f.config,
    environment: f.environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep, agentSessionFactory });
  const input = JSON.parse(await readFile(result.inputPath, 'utf8'));
  assert.ok(result.review.surfaces.filter(surface => surface.baseImage || surface.headImage).every(surface => surface.note));
  assert.ok(JSON.stringify(input).includes('evidenceDigest'));
  assert.equal(factories, 1);
  assert.equal(preflights, 1);
  assert.deepEqual(phases.filter(phase => phase.name !== 'readiness').map(phase => phase.name), ['navigation', 'navigation', 'notes']);
  assert.equal(phases.filter(phase => phase.name === 'readiness').length, accepted.size);
  const allUsage = await readUsage(output);
  assert.equal(allUsage.filter(record => record.receipt.totals.inputTokens === 3).length, accepted.size);
  const usage = allUsage.filter(record => record.receipt.totals.inputTokens !== 3);
  assert.deepEqual(usage.map(record => record.phase), ['preflight', 'capture-head', 'capture-base', 'notes']);
  assert.deepEqual(usage.map(record => record.receipt.totals.inputTokens), [1, 100, 100, 50]);
  assert.deepEqual(usage[1].receipt, usageReceipt());
  assert.doesNotMatch(JSON.stringify(input), /agent-usage|estimatedCostUsd|cacheReadInputTokens|query-pipeline/);
  assert.doesNotMatch(f.comments.join('\n'), /agent-usage|estimatedCostUsd|cacheReadInputTokens|query-pipeline/);
  assert.equal(recoveries, 2, 'head and base each recover their first failed navigation command');
  for (const phase of phases.filter(phase => phase.name === 'navigation')) {
    const lastCapture = phase.events.findLastIndex(event => event.name === 'capture');
    assert.deepEqual(phase.events.slice(lastCapture + 1).map(event => event.name), ['get_progress', 'act', 'observe', 'finish']);
    assert.equal(phase.events[lastCapture + 2].input.url, 'sample://unaffected');
  }
  for (const side of ['head', 'base']) {
    const bundle = await readCaptureBundle(join(output, `${side}-export`));
    const map = JSON.parse(await readFile(join(output, `${side}-export`, 'screen-map.json'), 'utf8'));
    assertAgentAcceptance(bundle, map, { required: true });
    assert.equal(bundle.agentAcceptance.policy, AGENT_ACCEPTANCE_POLICY);
    for (const [id, receipt] of Object.entries(bundle.agentAcceptance.frames)) {
      assert.deepEqual(accepted.get(receipt.frameId), { targetId: id, imageSha256: receipt.imageSha256, capturedAt: receipt.capturedAt });
      assert.equal(bundle.images[id].sha256, receipt.imageSha256);
      assert.equal(bundle.images[id].capturedAt, receipt.capturedAt);
    }
  }
  assert.deepEqual(input.publicReview.surfaces.map(surface => surface.note), result.review.surfaces.map(surface => surface.note));
  assert.equal(f.requests.filter(request => request.args[0] === 'simulator:start').length, 2);
  assert.equal(f.requests.filter(request => request.args[0] === 'simulator:stop').length, 2);
  const baselineOutput = join(f.root, 'agent-baseline');
  await runBaselineCi({ project: f.headProject, sha: f.headSha, output: baselineOutput, config: f.config,
    environment: f.environment, runner: f.runner, now: f.now, sleep: f.sleep, agentSessionFactory });
  const baselineUsage = (await readUsage(baselineOutput)).filter(record => record.receipt.totals.inputTokens !== 3);
  assert.deepEqual(baselineUsage.map(record => record.phase), ['preflight', 'capture-baseline']);
  assert.deepEqual(baselineUsage[1].receipt, usageReceipt());
});

for (const failedPhase of ['preflight', 'capture-head']) {
  test(`CLI usage keeps unknown failure accounting private during ${failedPhase}`, async t => {
    const f = await fixture(t, 'expo-router', { agentMode: true });
    f.environment.ANTHROPIC_API_KEY = 'fixture-private-provider-key';
    t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
    const output = join(f.root, `usage-failure-${failedPhase}`);
    const unknown = usageReceipt({ accounting: 'unknown', scope: 'unavailable', terminalResult: false,
      terminalSubtype: undefined, unavailableReason: 'no-terminal-result', numTurns: undefined, totals: {}, models: [] });
    const failure = new CiError({ code: 'AGENT_QUOTA_EXHAUSTED', stage: 'agent',
      message: 'The fixture query failed before terminal usage was available.', nextAction: 'Restore fixture quota.' });
    const agentSessionFactory = (config, options) => ({ provider: config.provider, model: config.model,
      preflight: async () => {
        if (failedPhase === 'preflight') {
          try { throw failure; } finally { await options.onUsage(unknown); }
        }
        await options.onUsage(usageReceipt());
      },
      run: async () => {
        try { throw failure; } finally { await options.onUsage(unknown); }
      },
    });
    await assert.rejects(runPublicCi({ baseProject: f.baseProject, headProject: f.headProject,
      pullRequestPath: f.pullRequestPath, output, config: f.config,
      environment: f.environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep, agentSessionFactory }), error => {
      assert.equal(error, failure, 'recording usage preserves the original query failure');
      return true;
    });
    const usage = await readUsage(output);
    assert.equal(usage[0].phase, 'preflight');
    assert.equal(usage.at(-1).phase, failedPhase);
    assert.equal(usage.length, failedPhase === 'preflight' ? 1 : 2);
    assert.deepEqual(usage.at(-1).receipt, JSON.parse(JSON.stringify(unknown)));
    assert.deepEqual(usage.at(-1).receipt.totals, {}, 'unknown usage is never invented as zero');
    assert.doesNotMatch(f.comments.join('\n'), /agent-usage|estimatedCostUsd|cacheReadInputTokens|query-pipeline/);
  });
}
