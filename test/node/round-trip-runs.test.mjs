import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPublicCi } from '../../dist/ci/pipeline.js';
import { publishCiReportComment } from '../../dist/report/artifact.js';
import { readCaptureBundle } from '../../dist/review/capture-review.js';
import { readCommentRecords } from '../../dist/report/pr-comment-record.js';
import { roundTrip, schemesOf, publishRun, publicReviewProjection } from '../helpers/round-trip.mjs';

test('round trip: a push mid-review publishes the finished run under previous runs; the next run on the new head becomes current', async t => {
  const first = await roundTrip(t, { userInterfaceStyle: 'automatic' });
  const f = first.f;
  // The PR moves on: a new head commit lands and a new run starts on it, while the first run's report is already published.
  execFileSync('git', ['-C', f.headProject, 'commit', '--allow-empty', '-q', '-m', 'another push'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' } });
  const newHead = execFileSync('git', ['-C', f.headProject, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const pr = JSON.parse(await readFile(f.pullRequestPath, 'utf8'));
  await writeFile(f.pullRequestPath, JSON.stringify({ ...pr, head: { ...pr.head, sha: newHead } }));
  const environment = { ...f.environment, GITHUB_RUN_ID: '1235', EXPLORE_CAPTURE_CACHE: first.baseline.directory };
  const output = join(f.root, 'review-2');
  const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath, output, config: f.config,
    environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep, progress: () => {} });
  await publishCiReportComment({ inputPath: result.inputPath, artifactUrl: 'https://github.com/acme/example/actions/runs/1235/artifacts/901', environment, transport: f.transport });
  const comment = f.comments.at(-1).replaceAll('\\', '');
  const records = readCommentRecords(f.comments.at(-1));
  assert.equal(records.current.ios.runId, '1235');
  assert.equal(records.current.ios.headSha, newHead);
  assert.equal(records.history.length, 1);
  assert.equal(records.history[0].headSha, f.headSha);
  assert.match(comment, new RegExp(`^<sub>\\[iOS\\]\\(<[^>]+>\\) · \\[${newHead.slice(0, 8)}\\]\\(<[^>]+>\\) vs \\[${f.baseSha.slice(0, 8)}\\]`, 'm'));
  assert.match(comment, /Previous runs \(1\)/);
  assert.ok(comment.includes(f.headSha.slice(0, 8)), 'the previous head is named');
  assert.ok(comment.includes('/actions/runs/1234/'), 'the previous run stays linked');
});

test('round trip: iOS and Android jobs of one run share a single comment: one row per platform, changes listed once, both reports open in the Viewer', async t => {
  const ios = await roundTrip(t, { userInterfaceStyle: 'automatic' });
  const f = ios.f;
  f.setPlatform('android');
  const android = await publishRun(f, { runId: '1234', cache: ios.baseline.directory, platform: 'android', output: join(f.root, 'review-android') });
  assert.ok(android.progress.some(line => /no compatible baseline/.test(line)), 'an iOS baseline does not serve the Android base');
  assert.equal(android.report.review.runtime.platform, 'android');
  assert.deepEqual(schemesOf(await readCaptureBundle(join(f.root, 'review-android', 'head-export'))), ['light', 'dark']);
  const { comment, records } = android;
  assert.equal(records.current.ios.phase, 'ready');
  assert.equal(records.current.android.phase, 'ready');
  assert.equal(records.current.ios.runId, records.current.android.runId);
  assert.equal(comment.match(/^### /gm).length, 1, 'one header');
  assert.match(comment, /^<sub>\[iOS\]\(<[^>]+>\) · \[Android\]\(<[^>]+>\) · /m, 'the subtitle links each platform\'s report');
  const routeLines = comment.split('\n').filter(line => /^- (Added |Removed )?\[`\/(added|removed|home)`\]\(</.test(line));
  assert.ok(routeLines.length >= 1, `the comment lists changed routes once:\n${comment}`);
  assert.equal(routeLines.length, 6, `each changed screen is listed once:\n${comment}`);
  for (const line of routeLines) assert.doesNotMatch(line, / only$|not on /, `a screen changed on both platforms names neither: ${line}`);
  const projection = publicReviewProjection(android.report.review);
  for (const surface of android.report.review.surfaces) assert.ok(projection.surfaces[surface.id], `the Viewer projects the Android surface ${surface.id}`);
  assert.ok(ios.projection.surfaces[ios.report.review.surfaces[0].id], 'the iOS report still opens');
});

test('round trip: a run on an old head that finishes after the new head\'s run files itself under previous runs and leaves the current review alone', async t => {
  const first = await roundTrip(t, { userInterfaceStyle: 'automatic' });
  const f = first.f;
  const oldPr = JSON.parse(await readFile(f.pullRequestPath, 'utf8'));
  const oldPrPath = join(f.root, 'pull-request-old.json');
  await writeFile(oldPrPath, JSON.stringify(oldPr));
  execFileSync('git', ['-C', f.headProject, 'commit', '--allow-empty', '-q', '-m', 'another push'],
    { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.x' } });
  const newHead = execFileSync('git', ['-C', f.headProject, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(f.pullRequestPath, JSON.stringify({ ...oldPr, head: { ...oldPr.head, sha: newHead } }));

  const second = await publishRun(f, { runId: '1235', cache: first.baseline.directory, output: join(f.root, 'review-2') });
  assert.equal(second.records.current.ios.runId, '1235');
  // A retry of the old head's job (a later run id, its own checkout of that head) finishes now; GitHub says the PR has moved on.
  const oldCheckout = join(f.root, 'head-old');
  await cp(f.headProject, oldCheckout, { recursive: true });
  execFileSync('git', ['-C', oldCheckout, 'checkout', '-q', f.headSha]);
  const late = await publishRun(f, { runId: '1236', pullRequestPath: oldPrPath, headProject: oldCheckout, cache: first.baseline.directory, output: join(f.root, 'review-3') });
  assert.equal(late.records.current.ios.runId, '1235', 'the review of the live head stays current');
  assert.equal(late.records.current.ios.headSha, newHead);
  assert.equal(late.records.history.length, 2);
  assert.ok(late.records.history.some(entry => entry.headSha === f.headSha && entry.platforms?.ios?.superseded === true || entry.superseded === true), JSON.stringify(late.records.history));
  assert.match(late.comment, /Previous runs \(2\)/);
  assert.ok(late.comment.includes('/actions/runs/1236/'), 'the late report stays reachable');
  assert.match(late.comment, new RegExp(`^<sub>\\[iOS\\]\\(<[^>]+>\\) · \\[${newHead.slice(0, 8)}\\]\\(<[^>]+>\\) vs \\[${f.baseSha.slice(0, 8)}\\]`, 'm'));
});
