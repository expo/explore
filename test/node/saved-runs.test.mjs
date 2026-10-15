import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { describeReports, findSavedRun, listSavedRuns, pruneSavedRuns, readSavedReports, removeSavedRun, saveRun, savedRunsDirectory } from '../../dist/report/saved-runs.js';
import { pruneCaptureCache } from '../../dist/ci/local-review.js';
import { readReportZip, zipReportDirectory } from '../../dist/report/preview-deploy.js';

const root = resolve(import.meta.dirname, '../..');
const cli = join(root, 'dist', 'cli.js');
const review = new Uint8Array(await readFile(join(import.meta.dirname, '../fixtures/example-review-artifact.zip')));

async function cache(t) {
  const directory = await mkdtemp(join(tmpdir(), 'explore-saved-runs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { EXPLORE_CACHE_DIR: directory };
}

async function exploration(t) {
  const directory = await mkdtemp(join(tmpdir(), 'explore-saved-exploration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'exploration.json'), JSON.stringify({ kind: 'explore.exploration-report', map: { screens: [{}, {}, {}] }, coverage: { frontier: { pending: 2 } },
    exploration: { app: { name: 'Acme', bundleId: 'com.acme', platform: 'android', version: '2.0', buildNumber: '41' }, device: { model: 'Pixel 9', osVersion: '16' },
      completedAt: '2026-10-12T09:00:00.000Z' } }));
  return zipReportDirectory(directory);
}

test('a review report is kept with what the list shows: kind, title, commits, platforms and changes', async t => {
  const environment = await cache(t);
  const run = await saveRun([{ platform: 'ios', zip: review }], { subjects: { head: 'Add cats', base: 'Initial commit' } }, environment);
  assert.deepEqual({ ...run, savedAt: undefined }, { version: 1, id: 'pr-1-explore-playground-35721157511-1', kind: 'pull-request', title: 'Add cats care guide, retire Sweet Bee, refresh share label',
    repository: 'expo/explore-playground', number: 1, head: { ref: 'pilot/viewer-coverage', sha: 'efa2903d85090a8906b5fd42cd6d13608d1cb5ff', subject: 'Add cats' },
    base: { ref: 'main', sha: 'afdd3403fd85a5ec3b312339a9b18a683554a6c1', subject: 'Initial commit' }, platforms: ['ios'], changes: { added: 1, removed: 1, modified: 3 },
    createdAt: '2026-09-22T11:42:08.764Z', savedAt: undefined, bytes: review.byteLength });
  assert.deepEqual((await readdir(join(savedRunsDirectory(environment), run.id))).sort(), ['ios.zip', 'run.json']);
  assert.deepEqual(await listSavedRuns(environment), [run]);
  assert.deepEqual((await findSavedRun('latest', environment))?.id, run.id);
  const [saved] = await readSavedReports(run, environment);
  assert.deepEqual(saved.zip, review, 'the ZIP is kept as is, so it opens and hosts like the original');
  // Saving the same run again replaces it rather than adding a second copy.
  await saveRun([{ platform: 'ios', zip: review }], {}, environment);
  assert.equal((await listSavedRuns(environment)).length, 1);
  assert.equal(await removeSavedRun(run.id, environment), true);
  assert.deepEqual(await listSavedRuns(environment), []);
  assert.equal(await removeSavedRun('../escape', environment), false);
});

test('an exploration is kept under its app, with its screens and what was left unexplored', async t => {
  const environment = await cache(t);
  const run = await saveRun([{ platform: 'android', zip: await exploration(t) }], {}, environment);
  assert.match(run.id, /^explore-acme-[0-9a-f]{10}$/);
  assert.equal(run.kind, 'exploration');
  assert.equal(run.title, 'Acme 2.0 (41) on Pixel 9');
  assert.deepEqual(run.explored, { app: 'Acme', version: '2.0', buildNumber: '41', screens: 3, unexplored: 2 });
  assert.equal(run.createdAt, '2026-10-12T09:00:00.000Z');
});

test('pruning drops runs kept too long, then the longest kept past the size limit, never the one just saved', async t => {
  const environment = await cache(t);
  const day = 86_400_000, now = Date.UTC(2026, 9, 15);
  const old = await saveRun([{ platform: 'android', zip: await exploration(t) }], {}, environment, now - 40 * day);
  const recent = await saveRun([{ platform: 'ios', zip: review }], {}, environment, now - 20 * day);
  assert.deepEqual((await listSavedRuns(environment)).map(run => run.id).sort(), [old.id, recent.id].sort(), 'twenty days on, the first run is still within the limit');
  assert.deepEqual((await pruneSavedRuns(environment, now)).map(run => run.id), [old.id], 'forty days on, it is not');
  assert.deepEqual((await pruneSavedRuns(environment, now, { maxAgeDays: 30, maxBytes: 1 }, recent.id)).map(run => run.id), [], 'the run being kept is never pruned');
  assert.deepEqual((await pruneSavedRuns(environment, now, { maxAgeDays: 30, maxBytes: 1 })).map(run => run.id), [recent.id]);
});

test('a folder that is not a readable run is skipped, and a report from before Android support is iOS', async t => {
  const environment = await cache(t);
  await mkdir(join(savedRunsDirectory(environment), 'broken'), { recursive: true });
  await writeFile(join(savedRunsDirectory(environment), 'broken', 'run.json'), '{"version":1}');
  assert.deepEqual(await listSavedRuns(environment), []);
  assert.equal((await readReportZip(review)).platform, 'ios', 'review.json has no runtime.platform');
  await assert.rejects(describeReports([{ platform: 'ios', zip: new Uint8Array([1, 2, 3]) }]), /Not an Explore report ZIP/);
});

test('reports lists, opens by id, removes and prunes from the command line', async t => {
  const environment = await cache(t);
  const run = await saveRun([{ platform: 'ios', zip: review }], {}, environment);
  const reports = (...args) => spawnSync(process.execPath, [cli, 'reports', ...args], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, ...environment, CI: '' } });
  // Not a terminal: the plain list rather than the picker.
  const list = reports();
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`^${run.id}  PR #1    Add cats care guide`));
  assert.match(list.stdout, /Open one with: expo-explore reports open <id>/);
  const json = JSON.parse(reports('--json').stdout);
  assert.deepEqual(json.runs.map(each => each.id), [run.id]);
  assert.equal(json.directory, savedRunsDirectory(environment));
  assert.match(reports('open', 'nope').stderr, /There is no saved run nope/);
  assert.match(reports('open').stderr, /Name the run/);
  assert.match(reports('frobnicate').stderr, /Unknown reports subcommand: frobnicate/);
  assert.match(reports('prune').stdout, /Nothing to prune/);
  assert.match(reports('rm', 'latest').stdout, /Deleted Add cats care guide/);
  assert.match(reports().stdout, /No saved runs yet/);
  // A downloaded report is kept without hosting it.
  const added = reports('add', join(import.meta.dirname, '../fixtures/example-review-artifact.zip'));
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, new RegExp(`Kept Add cats care guide, retire Sweet Bee, refresh share label as ${run.id}\\.`));
  assert.deepEqual((await listSavedRuns(environment)).map(each => each.id), [run.id]);
  assert.match(reports('add').stderr, /Pass the report to keep/);
});

test('what a report or commit says reaches the terminal as plain text, and run.json can only name the two platforms', async t => {
  const environment = await cache(t);
  const run = await saveRun([{ platform: 'ios', zip: review }], { subjects: { head: 'Add cats\x1b]52;c;cHduZWQ=\x07\x1b[2J', base: 'Initial\x9b2J commit' } }, environment);
  assert.equal(run.head.subject, 'Add cats]52;c;cHduZWQ=[2J');
  assert.equal(run.base.subject, 'Initial2J commit');
  // A run.json edited (or written by an older version) with escape sequences is read back plain.
  const file = join(savedRunsDirectory(environment), run.id, 'run.json');
  const edited = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...edited, title: 'Evil\x1b[2J title', device: 'Pixel\x07' }));
  const [read] = await listSavedRuns(environment);
  assert.deepEqual([read.title, read.device], ['Evil[2J title', 'Pixel']);
  // Platforms name the ZIPs read back: anything else is not a run.
  await writeFile(file, JSON.stringify({ ...edited, platforms: ['../../private'] }));
  assert.deepEqual(await listSavedRuns(environment), []);
});

test('a review\'s platforms saved one at a time are one run, and runs of a long-named repository keep apart', async t => {
  const environment = await cache(t);
  const dir = await mkdtemp(join(tmpdir(), 'explore-saved-platforms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.zip'), review);
  spawnSync('unzip', ['-q', '-o', join(dir, 'a.zip'), '-d', join(dir, 'report')]);
  const variant = async (mutate, name) => {
    const json = JSON.parse(await readFile(join(dir, 'report', 'review.json'), 'utf8'));
    mutate(json.review);
    const copy = join(dir, name);
    await rm(copy, { recursive: true, force: true });
    await mkdir(copy);
    await writeFile(join(copy, 'review.json'), JSON.stringify(json));
    await spawnSync('cp', ['-R', join(dir, 'report', 'assets'), join(copy, 'assets')]);
    return zipReportDirectory(copy);
  };
  const android = await variant(r => { r.runtime.platform = 'android'; }, 'android');
  await saveRun([{ platform: 'ios', zip: review }], { subjects: { head: 'Add cats' } }, environment);
  const both = await saveRun([{ platform: 'android', zip: android }], {}, environment);
  assert.deepEqual(both.platforms, ['ios', 'android']);
  assert.equal(both.head.subject, 'Add cats', 'what the first save knew is kept');
  assert.deepEqual((await readdir(join(savedRunsDirectory(environment), both.id))).sort(), ['android.zip', 'ios.zip', 'run.json']);
  // Another attempt of the same run is another run, however long the repository's name.
  const long = 'an-unusually-long-repository-name-for-the-app';
  const first = await variant(r => { r.pullRequest.repository = `acme/${long}`; r.runId = '18234567890'; r.runAttempt = '1'; }, 'first');
  const second = await variant(r => { r.pullRequest.repository = `acme/${long}`; r.runId = '18234567890'; r.runAttempt = '2'; }, 'second');
  const a = await saveRun([{ platform: 'ios', zip: first }], {}, environment), b = await saveRun([{ platform: 'ios', zip: second }], {}, environment);
  assert.notEqual(a.id, b.id);
  assert.equal((await listSavedRuns(environment)).length, 3);
});

test('a commit named by a report is never read as one of git\'s options', async t => {
  const { commitSubject } = await import('../../dist/cli/report-commands.js');
  const repo = await mkdtemp(join(tmpdir(), 'explore-subject-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  for (const args of [['init', '-q'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'First']]) spawnSync('git', args, { cwd: repo });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  assert.equal(commitSubject(repo, sha), 'First');
  assert.equal(commitSubject(repo, `--output=${join(repo, 'victim')}`), undefined);
  await assert.rejects(readFile(join(repo, 'victim')), { code: 'ENOENT' });
});

test('cached captures go after 30 days unused, then the least recently used past the size limit', async t => {
  const environment = await cache(t);
  const { utimes } = await import('node:fs/promises');
  const day = 86_400_000, now = Date.UTC(2026, 9, 15);
  const capture = async (sha, usedDaysAgo, bytes) => {
    const dir = join(environment.EXPLORE_CACHE_DIR, 'captures', 'ios', sha);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'image.png'), Buffer.alloc(bytes));
    await writeFile(join(dir, 'cache-metadata.json'), '{}');
    const when = new Date(now - usedDaysAgo * day);
    await utimes(join(dir, 'cache-metadata.json'), when, when);
    return dir;
  };
  const old = await capture('a'.repeat(40), 40, 10), recent = await capture('b'.repeat(40), 2, 10), newest = await capture('c'.repeat(40), 1, 10);
  assert.deepEqual(await pruneCaptureCache(environment, now), [old]);
  assert.deepEqual(await pruneCaptureCache(environment, now, { maxAgeDays: 30, maxBytes: 15 }), [recent], 'the least recently used goes first');
  assert.deepEqual((await readdir(join(environment.EXPLORE_CACHE_DIR, 'captures', 'ios'))), ['c'.repeat(40)]);
  assert.ok(newest);
});
