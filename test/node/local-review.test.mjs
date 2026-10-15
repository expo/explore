import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appEnvironment, captureCacheDirectory, defaultBase, localInstallCommand, runLocalReview, snapshotWorkingTree } from '../../dist/ci/local-review.js';
import { startLocalReportServer } from '../../dist/report/local-report-server.js';
import { fixture, git } from '../helpers/public-ci-fixture.mjs';
import { writeCaptureObserverPackages } from '../helpers/capture-observer-fixture.mjs';

async function scratch(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repository(t) {
  const root = await scratch(t, 'explore-local-repo-');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) git(root, ...args);
  await writeFile(join(root, 'tracked.txt'), 'one\n'); await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'one');
  return root;
}

test('the working tree becomes a commit on HEAD without touching the index, files or refs; untracked files only on request', async t => {
  const root = await repository(t);
  const work = await scratch(t, 'explore-local-work-');
  assert.equal(await snapshotWorkingTree(root, { work }), undefined, 'nothing changed');
  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'staged.txt'), 'staged\n'); git(root, 'add', 'staged.txt');
  await writeFile(join(root, 'untracked.txt'), 'new\n'); await writeFile(join(root, 'ignored.txt'), 'secret\n');
  const before = { status: git(root, 'status', '--porcelain'), index: git(root, 'diff', '--cached', '--name-only'), refs: git(root, 'for-each-ref'), head: git(root, 'rev-parse', 'HEAD') };
  const tracked = await snapshotWorkingTree(root, { work });
  assert.deepEqual(tracked.changed.sort(), ['staged.txt', 'tracked.txt'], 'tracked changes, staged or not; no untracked file');
  assert.equal(git(root, 'show', `${tracked.sha}:tracked.txt`), 'two');
  assert.equal(git(root, 'rev-parse', `${tracked.sha}^`), before.head, 'on top of HEAD');
  const withUntracked = await snapshotWorkingTree(root, { work, untracked: true });
  assert.deepEqual(withUntracked.changed.sort(), ['staged.txt', 'tracked.txt', 'untracked.txt']);
  assert.deepEqual(withUntracked.untracked, ['untracked.txt'], 'named, since they would be uploaded with the build');
  assert.equal(spawnSync('git', ['-C', root, 'cat-file', '-e', `${withUntracked.sha}:ignored.txt`]).status !== 0, true, 'ignored files never go in');
  assert.deepEqual({ status: git(root, 'status', '--porcelain'), index: git(root, 'diff', '--cached', '--name-only'), refs: git(root, 'for-each-ref'), head: git(root, 'rev-parse', 'HEAD') }, before);
});

test('with no base, a branch is compared with where it left the default branch', async t => {
  const root = await repository(t);
  const fork = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'feature'); await writeFile(join(root, 'tracked.txt'), 'feature\n'); git(root, 'commit', '-q', '-am', 'feature');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.deepEqual(defaultBase(root, head), { ref: 'main', sha: fork });
  git(root, 'checkout', '-q', 'main'); await writeFile(join(root, 'other.txt'), 'later\n'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'later on main');
  assert.deepEqual(defaultBase(root, head), { ref: 'main (merge base)', sha: fork }, 'main moved on; the merge base keeps its changes out of the review');
});

test('installs run without Explore credentials and without changing the Node install', () => {
  const environment = appEnvironment({ PATH: '/bin', HOME: '/h', EXPO_TOKEN: 'e', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', NPM_TOKEN: 'n' });
  assert.deepEqual(environment, { PATH: '/bin', HOME: '/h', NPM_TOKEN: 'n' }, 'a private registry token stays');
  assert.equal(localInstallCommand('pnpm', '.'), 'pnpm install --frozen-lockfile --ignore-scripts --dir "."');
  assert.equal(localInstallCommand('npm', 'apps/mobile'), 'npm ci --ignore-scripts --prefix "apps/mobile"');
  assert.equal(captureCacheDirectory({ HOME: '/h' }, 'ios', 'a'.repeat(40)), `/h/.cache/expo-explore/captures/ios/${'a'.repeat(40)}`);
  assert.equal(captureCacheDirectory({ XDG_CACHE_HOME: '/x', EXPLORE_CACHE_DIR: '/c' }, 'android', 'b'), '/c/captures/android/b');
});

test('the local Viewer serves the built Viewer and each report the way a hosted report does, and nothing else', async t => {
  const viewerRoot = await scratch(t, 'explore-local-viewer-');
  await writeFile(join(viewerRoot, 'index.html'), '<!doctype html><title>Viewer</title>');
  const reports = [{ platform: 'ios', zip: new Uint8Array([1, 2]), changes: 3, device: 'iPhone 17' }, { platform: 'android', zip: new Uint8Array([4]) }];
  const server = await startLocalReportServer({ reports, viewerRoot, token: 'abcdefghijklmnopqrstuvwxyz234567' });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/p\/abcdefghijklmnopqrstuvwxyz234567$/);
  const get = path => fetch(new URL(path, server.url));
  assert.match(await (await get(server.url)).text(), /<title>Viewer/);
  assert.deepEqual(new Uint8Array(await (await get(`${server.url}/report.zip?platform=android`)).arrayBuffer()), new Uint8Array([4]));
  assert.deepEqual(new Uint8Array(await (await get(`${server.url}/report.zip`)).arrayBuffer()), new Uint8Array([1, 2]));
  assert.deepEqual(await (await get(`${server.url}/reports.json`)).json(), [{ platform: 'ios', changes: 3, device: 'iPhone 17' }, { platform: 'android' }]);
  for (const path of ['/', '/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '/p/abcdefghijklmnopqrstuvwxyz234567/x', '/assets/../index.html', '/assets/missing.js']) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test('a local review captures two commits of the repository in its own worktrees and packages a report', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const installs = [];
  const cache = await scratch(t, 'explore-local-cache-');
  const environment = { ...f.environment, EXPLORE_CACHE_DIR: cache, GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '', GITHUB_TOKEN: '' };
  const result = await runLocalReview({ project: f.headProject, base: f.baseSha, head: f.headSha, environment,
    install: async (checkout, side) => { installs.push(side); await writeCaptureObserverPackages(checkout, { provider: 'expo-router' }); },
    runner: f.runner, now: f.now, sleep: f.sleep });
  assert.deepEqual(installs, ['head', 'base'], 'installed once, only once there is capture work');
  assert.match(result.runId, /^local-\d{14}-[0-9a-f]{6}$/);
  assert.deepEqual([result.base.sha, result.head.sha], [f.baseSha, f.headSha]);
  const [report] = result.reports;
  assert.equal(report.platform, 'ios');
  const review = JSON.parse(await readFile(join(report.directory, 'review.json'), 'utf8')).review;
  assert.equal(review.pullRequest.origin, 'local');
  assert.equal(review.runId, result.runId);
  for (const status of ['added', 'removed', 'modified']) assert.ok(review.surfaces.some(row => row.status === status), status);
  assert.ok((await lstat(report.zip)).size > 0);
  // The worktrees are gone and the repository's own checkout is untouched.
  assert.equal(git(f.headProject, 'worktree', 'list').split('\n').length, 2, 'only the fixture\'s own two checkouts remain');
  assert.equal(git(f.headProject, 'status', '--porcelain'), '');
  // Both commits' captures are kept for the next review of either.
  for (const sha of [f.baseSha, f.headSha]) assert.ok((await lstat(join(captureCacheDirectory(environment, 'ios', sha), 'bundle.json'))).isFile(), sha);
});
