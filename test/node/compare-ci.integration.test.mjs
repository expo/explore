import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCompareCi } from '../../dist/ci/pipeline.js';
import { writeCaptureOutputs } from '../../dist/ci/workflow-steps.js';
import { exportCiReport, publishCiReportComment, readCiReportInput } from '../../dist/report/artifact.js';
import { renderCompareSummary } from '../../dist/report/preview-deploy.js';
import { readCaptureBundle } from '../../dist/review/capture-review.js';
import { fixture, git } from '../helpers/public-ci-fixture.mjs';

test('any two commits: a capture and report like a pull request\'s, with no pull request, GitHub token or GitHub request', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const comparePath = join(f.root, 'compare.json');
  await writeFile(comparePath, JSON.stringify({ origin: 'compare', repositoryId: '123', repository: 'acme/example',
    base: { ref: 'v1.0.0', sha: f.baseSha }, head: { ref: 'v1.1.0', sha: f.headSha } }));
  const output = join(f.root, 'compare');
  const result = await runCompareCi({ baseProject: f.baseProject, headProject: f.headProject, comparePath, output, config: f.config,
    environment: { ...f.environment, GITHUB_TOKEN: '' }, runner: f.runner, now: f.now, sleep: f.sleep });

  assert.deepEqual(result.review.pullRequest, { origin: 'compare', repositoryId: '123', repository: 'acme/example', title: 'v1.1.0 vs v1.0.0',
    url: `https://github.com/acme/example/compare/${f.baseSha}..${f.headSha}`,
    base: { ref: 'v1.0.0', sha: f.baseSha }, head: { ref: 'v1.1.0', sha: f.headSha } });
  for (const status of ['added', 'removed', 'modified']) assert.ok(result.review.surfaces.some(row => row.status === status), `a ${status} screen`);
  assert.equal(f.comments.length, 0, 'no pull request comment');
  assert.equal((await readCaptureBundle(join(output, 'head-export'))).gitCommit, f.headSha);
  assert.ok(f.requests.filter(request => request.args[0] === 'simulator:start').every(request => !request.args.join(' ').includes('pr-')),
    'no build or session is named after a pull request');

  const packaged = await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact') });
  const report = JSON.parse(await readFile(join(packaged.outputPath, 'review.json'), 'utf8'));
  assert.equal(report.review.pullRequest.origin, 'compare');
  assert.ok(packaged.imageCount > 0);
  // ci:publish links a comparison from the run summary, with the Open and zip links a PR comment would carry.
  const runSummary = join(f.root, 'run-summary.md');
  await publishCiReportComment({ inputPath: result.inputPath, artifactUrl: 'https://github.com/acme/example/actions/runs/1234/artifacts/900',
    environment: { ...f.environment, GITHUB_TOKEN: '', GITHUB_STEP_SUMMARY: runSummary }, transport: async input => assert.fail(`no GitHub request: ${input}`) });
  const line = await readFile(runSummary, 'utf8');
  assert.match(line, /^- iOS report of `v1\.1\.0` vs `v1\.0\.0`: \[Open\]\(https:\/\/explore-preview\.expo\.app\/\?repo=acme%2Fexample&run=1234&attempt=1&artifact=900\) · \[zip\]\(https:\/\/github\.com\/acme\/example\/actions\/runs\/1234\/artifacts\/900\) · \d+ changes?\n$/);
  assert.equal(f.comments.length, 0);
  // A target of a config with targets: is linked by its id and labelled as config.yaml names it, escaped as Markdown text.
  const targeted = join(f.root, 'targeted-input.json');
  const input = JSON.parse(await readFile(result.inputPath, 'utf8'));
  await writeFile(targeted, JSON.stringify({ ...input, commentState: { ...input.commentState, target: { id: 'duo-open', platform: 'ios', label: 'iPhone Duo [open]' } } }));
  const targetSummary = join(f.root, 'target-summary.md');
  await publishCiReportComment({ inputPath: targeted, artifactUrl: 'https://github.com/acme/example/actions/runs/1234/artifacts/900', target: 'duo-open',
    environment: { ...f.environment, GITHUB_TOKEN: '', GITHUB_STEP_SUMMARY: targetSummary }, transport: async input => assert.fail(`no GitHub request: ${input}`) });
  assert.match(await readFile(targetSummary, 'utf8'), /^- iPhone Duo \\\[open\\\] report of `v1\.1\.0` vs `v1\.0\.0`: \[Open\]\(https:\/\/explore-preview\.expo\.app\/\?repo=acme%2Fexample&run=1234&attempt=1&target=duo-open&artifact=900\) · /);

  const summary = renderCompareSummary(result.review.pullRequest, 'https://example.expo.app/p/token', null, [await readCiReportInput(result.inputPath)]);
  assert.match(summary, /^### Explore: `v1\.1\.0` vs `v1\.0\.0`$/m);
  // Refs are code spans: one with ] ( ) would otherwise break the line's links. A caller's own title is one span.
  const odd = { ...result.review.pullRequest, base: { ...result.review.pullRequest.base, ref: 'x](evil)' }, title: 'v1.1.0 vs x](evil)' };
  assert.match(renderCompareSummary(odd, 'https://example.expo.app/p/token', null, []), /^### Explore: `v1\.1\.0` vs `x\]\(evil\)`$/m);
  assert.match(renderCompareSummary({ ...odd, title: 'Nightly `build`' }, 'https://example.expo.app/p/token', null, []), /^### Explore: `Nightly 'build'`$/m);

  // capture:review's preview output starts the deploy job only when the reviewed config hosts the report.
  const outputs = join(f.root, 'outputs');
  await writeCaptureOutputs(result.inputPath, { GITHUB_OUTPUT: outputs });
  const hosted = join(f.root, 'hosted-input.json');
  await writeFile(hosted, JSON.stringify({ ...JSON.parse(await readFile(result.inputPath, 'utf8')), preview: { hosting: 'eas', expiresAfterDays: null } }));
  await writeCaptureOutputs(hosted, { GITHUB_OUTPUT: outputs });
  assert.equal(await readFile(outputs, 'utf8'), 'preview=\npreview=eas\n');
  assert.match(summary, /\[Open the report\]\(https:\/\/example\.expo\.app\/p\/token\)/);
  assert.match(summary, new RegExp(`\\(https://github\\.com/acme/example/compare/${f.baseSha}\\.\\.${f.headSha}\\)`));
  assert.match(summary, /^- iOS.*: \d+ changes?$/m);

  assert.equal(git(f.baseProject, 'status', '--porcelain'), '');
  assert.equal(git(f.headProject, 'status', '--porcelain'), '');
  assert.equal(f.requests.filter(request => request.args[0] === 'simulator:start').length,
    f.requests.filter(request => request.args[0] === 'simulator:stop').length);
});

test('a comparison needs the run identity and checkouts of exactly its two commits', async t => {
  const f = await fixture(t, 'expo-router', { docsOnly: true });
  const comparePath = join(f.root, 'compare.json');
  await writeFile(comparePath, JSON.stringify({ origin: 'compare', repositoryId: '123', repository: 'acme/example',
    base: { ref: 'main', sha: f.headSha }, head: { ref: 'v2', sha: f.baseSha } }));
  const options = { baseProject: f.baseProject, headProject: f.headProject, comparePath, config: f.config, runner: f.runner, now: f.now, sleep: f.sleep };
  await assert.rejects(runCompareCi({ ...options, output: join(f.root, 'no-run'), environment: { ...f.environment, GITHUB_RUN_ID: '' } }),
    error => error.code === 'CI_RUN_IDENTITY_MISSING');
  await assert.rejects(runCompareCi({ ...options, output: join(f.root, 'swapped'), environment: f.environment }),
    error => error.code === 'SOURCE_CHECKOUT_MISMATCH', 'the base checkout must be the base commit');
});
