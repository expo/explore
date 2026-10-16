import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appEnvironment, captureCacheDirectory, defaultBase, installDependencies, keepCapture, localInstallCommand, localReviewConfig, reportRef, reviewHeadSource, runLocalReview, snapshotWorkingTree } from '../../dist/ci/local-review.js';
import { mkdir, readdir } from 'node:fs/promises';
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


/** A GET over node:http, which the review tests' fetch mock does not intercept. */
function httpGet(url, accept) {
  return new Promise((done, fail) => {
    http.get(url, { headers: { accept } }, response => {
      let body = '';
      response.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () =>
        done({ status: response.statusCode, type: response.headers['content-type'] ?? '', headers: response.headers, body }));
    }).on('error', fail);
  });
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

test('the head is the working tree, as eas build uploads it, unless --committed, --head, or eas.json requireCommit says otherwise', async t => {
  const project = await scratch(t, 'explore-local-head-');
  assert.equal(await reviewHeadSource({}, project), 'working-tree', 'no eas.json');
  await writeFile(join(project, 'eas.json'), JSON.stringify({ cli: { version: '>= 16' }, build: {} }));
  assert.equal(await reviewHeadSource({}, project), 'working-tree');
  assert.equal(await reviewHeadSource({ committed: true }, project), 'commit');
  assert.equal(await reviewHeadSource({ head: 'HEAD' }, project), 'working-tree', '--head HEAD is the default head');
  assert.equal(await reviewHeadSource({ head: 'v1.0.0' }, project), 'commit');
  await writeFile(join(project, 'eas.json'), JSON.stringify({ cli: { requireCommit: true } }));
  assert.equal(await reviewHeadSource({}, project), 'require-commit', 'eas build refuses uncommitted changes here, so the review leaves them out');
  assert.equal(await reviewHeadSource({ uncommitted: true }, project), 'working-tree', '--uncommitted includes them anyway');
  await writeFile(join(project, 'eas.json'), '{ not json');
  assert.equal(await reviewHeadSource({}, project), 'working-tree');
  for (const conflict of [{ uncommitted: true, head: 'v1.0.0' }, { uncommitted: true, committed: true }]) {
    await assert.rejects(reviewHeadSource(conflict, project), { code: 'LOCAL_REVIEW_UNCOMMITTED_HEAD' });
  }
});

test('a review uses the head commit\'s config, else an uncommitted one, else the defaults setup would write', async t => {
  const project = await scratch(t, 'explore-local-app-');
  const head = await scratch(t, 'explore-local-head-');
  const json = (path, value) => writeFile(join(project, path), JSON.stringify(value));
  await json('package.json', { dependencies: { expo: '*', 'expo-router': '*' } });
  await json('app.json', { expo: { name: 'Test app', scheme: 'test-app', ios: { bundleIdentifier: 'com.example.test' } } });
  await json('eas.json', { build: { explore: { ios: { simulator: true } } } });
  const configPath = '.expo-explore/config.yaml';
  const resolve = (options = {}) => localReviewConfig({ project, head, configPath, explicit: false, ...options });

  const messages = [];
  const defaults = await resolve({ progress: message => messages.push(message) });
  assert.equal(defaults.mode, 'deterministic');
  assert.deepEqual([defaults.app.platform, defaults.app.bundleId, defaults.app.easProfile, defaults.app.scheme], ['ios', 'com.example.test', 'explore', 'test-app']);
  assert.equal(defaults.navigation.provider, 'expo-router');
  assert.equal(defaults.exploration.scope, 'changes');
  assert.match(messages.join('\n'), /setup's defaults \(com\.example\.test, EAS profile explore, iPhone 17\)/);
  await assert.rejects(lstat(join(project, '.expo-explore')), { code: 'ENOENT' }, 'the defaults are not written');

  const config = name => `mode: deterministic\napp:\n  name: ${name}\n  platform: ios\n  bundleId: com.example.test\n  easProfile: explore\n`
    + 'navigation:\n  provider: expo-router\ndevice:\n  name: iPhone 17\nexploration:\n  scope: changes\n';
  await mkdir(join(project, '.expo-explore')); await writeFile(join(project, configPath), config('Checkout'));
  assert.equal((await resolve()).app.name, 'Checkout', 'setup ran but its config is not committed yet');
  await mkdir(join(head, '.expo-explore')); await writeFile(join(head, configPath), config('Head'));
  assert.equal((await resolve()).app.name, 'Head', 'the commit under review wins');

  await assert.rejects(resolve({ configPath: 'other.yaml', explicit: true }), { code: 'CONFIG_READ_FAILED' }, 'a --config path must be in the commit');
  await rm(join(project, '.expo-explore'), { recursive: true }); await rm(join(head, '.expo-explore'), { recursive: true });
  await rm(join(project, 'eas.json'));
  await assert.rejects(resolve(), error => error.code === 'LOCAL_REVIEW_CONFIG_DEFAULTS' && /no \.expo-explore\/config\.yaml.*No eas\.json found/s.test(error.message));
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

test('installs run without any credential-named variable, keeping network and cache settings, and without changing the Node install', () => {
  const environment = appEnvironment({ PATH: '/bin', HOME: '/h', EXPO_TOKEN: 'e', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o',
    NPM_TOKEN: 'n', CLAUDE_CODE_OAUTH_TOKEN: 'c', NODE_AUTH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 's', HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/ca.pem', npm_config_cache: '/cache', SSH_AUTH_SOCK: '/agent' });
  // A reviewed commit's .npmrc can expand any of these into a request to a registry it picks, even with --ignore-scripts.
  assert.deepEqual(environment, { PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost',
    NODE_EXTRA_CA_CERTS: '/ca.pem', npm_config_cache: '/cache', SSH_AUTH_SOCK: '/agent' });
  assert.equal(localInstallCommand('pnpm', '.'), 'pnpm install --frozen-lockfile --ignore-scripts --dir "."');
  assert.equal(localInstallCommand('npm', 'apps/mobile'), 'npm ci --ignore-scripts --prefix "apps/mobile"');
  assert.equal(captureCacheDirectory({ HOME: '/h' }, 'ios', 'a'.repeat(40)), `/h/.cache/expo-explore/captures/ios/${'a'.repeat(40)}`);
  assert.equal(captureCacheDirectory({ XDG_CACHE_HOME: '/x', EXPLORE_CACHE_DIR: '/c' }, 'android', 'b'), '/c/captures/android/b');
});

test('the dependency install starts at the app directory, so an app with its own lockfile in a monorepo installs', async t => {
  const root = await repository(t);
  await mkdir(join(root, 'apps/mobile'), { recursive: true });
  await writeFile(join(root, 'apps/mobile/package.json'), JSON.stringify({ name: 'mobile', version: '1.0.0' }));
  await writeFile(join(root, 'apps/mobile/package-lock.json'), JSON.stringify({ name: 'mobile', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'mobile', version: '1.0.0' } } }));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'app');
  const log = join(await scratch(t, 'explore-local-log-'), 'install.log');
  await installDependencies(join(root, 'apps/mobile'), log, { ...process.env, NPM_TOKEN: 'never-passed' });
  assert.match(await readFile(log, 'utf8'), /^\$ npm ci --ignore-scripts --prefix "apps\/mobile"/);
  // Starting from the repository root, as before, finds no lockfile at all.
  await assert.rejects(installDependencies(root, log, process.env), error => error.code === 'LOCAL_REVIEW_LOCKFILE_MISSING');
});

test('the default base is the newer fork point of the local and origin default branches, never a tag of that name', async t => {
  const upstream = await repository(t);
  const clone = await scratch(t, 'explore-local-clone-');
  assert.equal(spawnSync('git', ['clone', '-q', upstream, clone]).status, 0);
  for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) git(clone, ...args);
  const old = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'tag', 'main', old);
  // Upstream moves on and is fetched; local main stays behind. The branch starts from origin/main.
  await writeFile(join(upstream, 'upstream.txt'), 'u\n'); git(upstream, 'add', '-A'); git(upstream, 'commit', '-q', '-m', 'upstream');
  git(clone, 'fetch', '-q', 'origin');
  const fetched = git(clone, 'rev-parse', 'origin/main');
  git(clone, 'checkout', '-q', '-b', 'feature', 'origin/main'); await writeFile(join(clone, 'tracked.txt'), 'feature\n'); git(clone, 'commit', '-q', '-am', 'feature');
  const head = git(clone, 'rev-parse', 'HEAD');
  assert.deepEqual(defaultBase(clone, head), { ref: 'main', sha: fetched }, 'a stale local main and the tag named main are both passed over');
  // The other way round: local main is ahead of an unfetched origin/main and the branch starts from it.
  git(clone, 'checkout', '-q', 'main'); git(clone, 'merge', '-q', '--ff-only', 'origin/main');
  await writeFile(join(clone, 'local.txt'), 'l\n'); git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'local');
  const local = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'checkout', '-q', '-b', 'feature2'); await writeFile(join(clone, 'tracked.txt'), 'two\n'); git(clone, 'commit', '-q', '-am', 'feature2');
  assert.deepEqual(defaultBase(clone, git(clone, 'rev-parse', 'HEAD')), { ref: 'main', sha: local });
  // On main itself, its unpushed commits are reviewed against origin/main rather than against themselves.
  git(clone, 'checkout', '-q', 'main');
  assert.deepEqual(defaultBase(clone, local), { ref: 'main', sha: fetched });
});

test('a ref the report cannot name as typed is named by its branch or short SHA, before anything is captured', async t => {
  const upstream = await repository(t);
  const clone = await scratch(t, 'explore-local-refs-');
  assert.equal(spawnSync('git', ['clone', '-q', upstream, clone]).status, 0);
  const sha = git(clone, 'rev-parse', 'HEAD');
  assert.equal(reportRef(clone, '@{u}', sha), 'origin/main');
  assert.equal(reportRef(clone, 'HEAD@{0}', sha), sha.slice(0, 8));
  for (const ref of ['main', 'HEAD~0', 'v1.2.0']) assert.equal(reportRef(clone, ref, sha), ref);
});

test('a cached capture is replaced by another recipe, kept against a smaller one of the same recipe, and never made from unvalidated evidence', async t => {
  const root = await scratch(t, 'explore-local-keep-');
  const exportOf = async (name, recipe, images) => {
    const directory = join(root, name); await mkdir(directory);
    await writeFile(join(directory, 'bundle.json'), JSON.stringify({ images: Object.fromEntries(Array.from({ length: images }, (_, index) => [`s${index}`, {}])) }));
    if (recipe) await writeFile(join(directory, 'cache-metadata.json'), JSON.stringify({ recipe }));
    return directory;
  };
  const target = join(root, 'cache/ios/sha');
  assert.equal(await keepCapture(await exportOf('unvalidated', undefined, 5), target), false);
  assert.equal(await keepCapture(await exportOf('full', 'r1', 5), target), true);
  assert.equal(await keepCapture(await exportOf('partial', 'r1', 2), target), false, 'a partial capture never shrinks a fuller one');
  assert.equal(await keepCapture(await exportOf('upgraded', 'r2', 2), target), true, 'a stale recipe is replaced even by fewer screens');
  assert.equal(JSON.parse(await readFile(join(target, 'cache-metadata.json'), 'utf8')).recipe, 'r2');
});

test('the local Viewer serves the built Viewer and each report the way a hosted report does, and nothing else', async t => {
  const viewerRoot = await scratch(t, 'explore-local-viewer-');
  await writeFile(join(viewerRoot, 'index.html'), '<!doctype html><title>Viewer</title>');
  const reports = [{ platform: 'ios', zip: new Uint8Array([1, 2]), changes: 3, device: 'iPhone 17' }, { platform: 'android', zip: new Uint8Array([4]) }];
  const server = await startLocalReportServer({ reports, viewerRoot, token: 'abcdefghijklmnopqrstuvwxyz234567' });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/p\/abcdefghijklmnopqrstuvwxyz234567$/);
  const get = path => fetch(new URL(path, server.url));
  assert.match(await (await fetch(server.url, { headers: { accept: 'text/html' } })).text(), /<title>Viewer/);
  assert.equal((await get(server.url)).status, 404, 'an agent fetch of a report the agent API cannot read is a 404, not the Viewer shell');
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
  t.after(() => rm(result.work, { recursive: true, force: true }));
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
  // Only the reports are kept; the captures, maps and checkouts are gone.
  assert.deepEqual((await readdir(result.work)).sort(), ['ios']);
  assert.deepEqual((await readdir(join(result.work, 'ios'))).sort(), ['report', 'report.zip']);
  // The worktrees are gone and the repository's own checkout is untouched.
  assert.equal(git(f.headProject, 'worktree', 'list').split('\n').length, 2, 'only the fixture\'s own two checkouts remain');
  assert.equal(git(f.headProject, 'status', '--porcelain'), '');
  // Both commits' captures are kept for the next review of either.
  for (const sha of [f.baseSha, f.headSha]) assert.ok((await lstat(join(captureCacheDirectory(environment, 'ios', sha), 'bundle.json'))).isFile(), sha);

  // An agent on this machine reads the report the way it reads a hosted one: the Markdown index, then the JSON API.
  const viewerRoot = await scratch(t, 'explore-local-viewer-');
  await writeFile(join(viewerRoot, 'index.html'), '<!doctype html><title>Viewer</title>');
  const server = await startLocalReportServer({ reports: [{ platform: 'ios', zip: new Uint8Array(await readFile(report.zip)) }], viewerRoot });
  t.after(() => server.close());
  const index = await httpGet(server.url, '*/*');
  assert.equal(index.status, 200);
  assert.match(index.type, /^text\/markdown/);
  assert.match(index.headers.link, new RegExp(`<${server.url}/api/v1>; rel="alternate"`));
  assert.ok(index.body.includes(`${server.url}/api/v1`), 'the index links the local API, not a hosted one');
  assert.match(index.body.split('\n')[0], new RegExp(`^# Expo Explore report: .+ ${f.headSha} vs ${f.baseSha} \\(ios\\)$`), 'a local review is named by its refs, not as a pull request');
  assert.equal((await httpGet(`${server.url}/llms.txt`, '*/*')).body, index.body);
  const api = JSON.parse((await httpGet(`${server.url}/api/v1`, 'application/json')).body);
  assert.equal(api.kind, 'pr-review');
  const screens = await httpGet(`${server.url}/api/v1/screens?status=modified`, 'application/json');
  assert.equal(screens.status, 200);
  assert.ok(JSON.parse(screens.body).items.length > 0);
  assert.match((await httpGet(server.url, 'text/html')).body, /<title>Viewer/, 'a browser still gets the Viewer');
  assert.equal((await httpGet(`${server.url}/api/v1?platform=android`, 'application/json')).status, 404);
});

test('Ctrl+C during a deterministic capture stops it before the next route and still stops its session', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const environment = { ...f.environment, EXPLORE_CACHE_DIR: await scratch(t, 'explore-local-cache-'), GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '', GITHUB_TOKEN: '' };
  const ctrlC = new AbortController();
  const calls = [];
  const runner = request => {
    const name = request.command.split('/').at(-1);
    calls.push({ name, command: request.args[0], afterCtrlC: ctrlC.signal.aborted });
    // The first route link is opened: the person presses Ctrl+C while it loads.
    if (name === 'agent-device' && request.args[0] === 'open' && /sample:\/\//.test(request.args[2] ?? '') && !ctrlC.signal.aborted) ctrlC.abort();
    return f.runner(request);
  };
  let kept;
  await assert.rejects(runLocalReview({ project: f.headProject, base: f.baseSha, head: f.headSha, environment, interrupt: ctrlC.signal,
    progress: message => { kept ??= /^kept this review's files for inspection: (.+)$/.exec(message)?.[1]; },
    install: async checkout => { await writeCaptureObserverPackages(checkout, { provider: 'expo-router' }); }, runner, now: f.now, sleep: f.sleep }),
  error => error.code === 'LOCAL_REVIEW_INTERRUPTED');
  if (kept) t.after(() => rm(kept, { recursive: true, force: true }));
  assert.ok(calls.some(call => call.afterCtrlC === false && call.command === 'simulator:start'), 'the capture had started a session');
  const after = calls.filter(call => call.afterCtrlC);
  assert.ok(after.some(call => call.command === 'simulator:stop'), 'its session is stopped');
  assert.equal(after.filter(call => call.command === 'simulator:start').length, 0, 'no other session starts');
  assert.ok(after.filter(call => call.name === 'agent-device' && call.command === 'open').length <= 1, 'no further route is opened');
});

test('Ctrl+C stops the review, and the checkouts are removed while its files are kept', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const environment = { ...f.environment, EXPLORE_CACHE_DIR: await scratch(t, 'explore-local-cache-'), GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '', GITHUB_TOKEN: '' };
  const messages = []; const ctrlC = new AbortController();
  const listeners = process.listenerCount('SIGINT');
  await assert.rejects(runLocalReview({ project: f.headProject, base: f.baseSha, head: f.headSha, environment, progress: message => messages.push(message),
    interrupt: ctrlC.signal,
    install: async checkout => { await writeCaptureObserverPackages(checkout, { provider: 'expo-router' }); ctrlC.abort(); },
    runner: f.runner, now: f.now, sleep: f.sleep }), error => error.code === 'LOCAL_REVIEW_INTERRUPTED');
  assert.equal(git(f.headProject, 'worktree', 'list').split('\n').length, 2, 'the review\'s checkouts are removed');
  const kept = messages.map(message => /^kept this review's files for inspection: (.+)$/.exec(message)?.[1]).find(Boolean);
  assert.ok(kept, 'a failed run says where its files are');
  t.after(() => rm(kept, { recursive: true, force: true }));
  assert.equal(process.listenerCount('SIGINT'), listeners, 'its handlers are gone, so a later Ctrl+C behaves normally');
});
