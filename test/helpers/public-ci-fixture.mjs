import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { AGENT_DEVICE_VERSION } from '../../dist/capture/run.js';
import { CAPTURE_OBSERVER_IDENTIFIER } from '../../dist/capture/observer.js';
import { writeCaptureObserverPackages } from './capture-observer-fixture.mjs';

/**
 * In-process public CI fixture: a git project with base/head commits plus mocked `eas`, `repack-app`,
 * `agent-device` and GitHub transports, so a review runs end to end without network or a simulator.
 */

export const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
export const HEADER = '# Do not commit this file.\n# Do not modify these values manually. They are managed by eas-cli.\n# It holds configuration only for the current simulator session.\n\n';
export const page = text => `export default function Screen(){return <Text>${text}</Text>;}`;
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const json = data => ({ stdout: JSON.stringify(data), stderr: '' });
export const ok = data => json({ success: true, data });
export const value = (request, name) => request.args[request.args.indexOf(name) + 1];
export const usageReceipt = (overrides = {}) => ({ provider: 'anthropic', model: 'fixture-model', source: 'claude-sdk',
  accounting: 'complete', scope: 'query-pipeline', terminalResult: true, terminalSubtype: 'success', numTurns: 1,
  totals: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, estimatedCostUsd: 0.012 },
  models: [{ model: 'fixture-model', inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 40, estimatedCostUsd: 0.012, costBasis: 'list' }],
  ...overrides });
export async function readUsage(output) {
  const path = join(output, 'agent-usage.jsonl');
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'usage receipts are private artifacts');
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const record of records) {
    assert.equal(record.contract, 'explore.agent-usage.v1');
    assert.equal(new Date(record.timestamp).toISOString(), record.timestamp);
    assert.deepEqual(Object.keys(record).sort(), ['contract', 'phase', 'receipt', 'timestamp']);
  }
  return records;
}

export async function fixture(t, provider, { docsOnly = false, unresolvedParameters = false, observerFailurePath, agentMode = false,
  instructions = 'Explore selected routes in a stable, comparable state.', recoverableOpenFailure = false,
  userInterfaceStyle, headUserInterfaceStyle, platform: initialPlatform = 'ios' } = {}) {
  let platform = initialPlatform;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'explore-ci-integration-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const headProject = join(root, 'head'); const baseProject = join(root, 'base');
  await mkdir(headProject);
  git(headProject, 'init', '-b', 'main');
  git(headProject, 'config', 'user.name', 'Explore Test');
  git(headProject, 'config', 'user.email', 'explore@example.invalid');
  const put = async (path, source) => { await mkdir(dirname(join(headProject, path)), { recursive: true }); await writeFile(join(headProject, path), source); };
  const commit = message => { git(headProject, 'add', '.'); git(headProject, 'commit', '-m', message); return git(headProject, 'rev-parse', 'HEAD'); };
  const config = { mode: 'deterministic', app: { name: 'Example', platform, bundleId: 'com.example.app', easProfile: 'capture', scheme: 'sample' },
    device: { name: 'iPhone 17 Pro' }, navigation: { provider, ...(provider === 'react-navigation' ? { entry: 'src/App.tsx' } : {}) },
    exploration: { scope: 'changes' }, capture: { maxMinutes: 30, maxActions: 500, repack: 'eas' },
    parameters: provider === 'expo-router' && !unresolvedParameters ? { '/item/[id]': { id: 'example-item' } } : {} };
  if (agentMode) { config.mode = 'agent'; config.agent = { provider: 'anthropic', model: 'fixture-model', instructions: '.expo-explore/instructions.md' }; }
  await put('.expo-explore/instructions.md', instructions);
  await put('.gitignore', 'node_modules/\n');
  await put('package.json', JSON.stringify({ name: 'capture-fixture', version: '1.0.0', packageManager: 'npm@10.0.0', dependencies: provider === 'expo-router' ? { 'expo-router': '6.0.0' } : { '@react-navigation/native': '7.0.0' } }));
  await put('.expo-explore/config.yaml', JSON.stringify(config));
  const appJson = style => JSON.stringify({ expo: { name: 'Example', slug: 'example', owner: 'acme', scheme: 'sample', ...(style ? { userInterfaceStyle: style } : {}),
    ios: { bundleIdentifier: 'com.example.app' }, android: { package: 'com.example.app' }, extra: { eas: { projectId: PROJECT_ID } } } });
  await put('app.json', appJson(userInterfaceStyle));
  await put('eas.json', JSON.stringify({ build: { capture: { ios: { simulator: true }, android: { buildType: 'apk', distribution: 'internal' } } } }));
  const registration = names => `import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createStaticNavigation} from '@react-navigation/native';
${names.map(name => `import ${name} from './${name}';`).join('\n')}
const Root=createNativeStackNavigator({screens:{${names.map(name => `${name}:{screen:${name},linking:'${name.toLowerCase()}'}`).join(',')}}});
const Navigation=createStaticNavigation(Root); export default function App(){return <Navigation/>;}`;
  if (provider === 'expo-router') {
    await put('app/_layout.tsx', `import {Stack} from 'expo-router'; export default function Layout(){return <Stack/>;}`);
    await put('app/home.tsx', `import {router} from 'expo-router'; export default () => <Button title="Before" onPress={()=>router.push('/settings')}/>;`);
    for (const name of ['settings', 'removed', 'unaffected']) await put(`app/${name}.tsx`, page(name));
    await put('app/item/[id].tsx', page('Dynamic'));
  } else {
    await put('src/App.tsx', registration(['Home', 'Settings', 'Removed', 'Other', 'Private']));
    await put('src/Home.tsx', `export default function Home({navigation}){return <Button title="Before" onPress={()=>navigation.navigate('Settings')}/>;}`);
    for (const name of ['Settings', 'Removed', 'Other', 'Private']) await put(`src/${name}.tsx`, page(name));
  }
  const baseSha = commit('base app');
  if (docsOnly) {
    await put('README.md', 'Documentation only.\n');
  } else if (provider === 'expo-router') {
    await put('app/home.tsx', `import {router} from 'expo-router'; export default () => <Button title="After" onPress={()=>router.push('/settings')}/>;`);
    await rm(join(headProject, 'app/removed.tsx'));
    await put('app/added.tsx', page('Added'));
  } else {
    await put('src/Home.tsx', `export default function Home({navigation}){return <Button title="After" onPress={()=>navigation.navigate('Settings')}/>;}`);
    await put('src/App.tsx', registration(['Home', 'Settings', 'Added', 'Other', 'Private']));
    await rm(join(headProject, 'src/Removed.tsx'));
    await put('src/Added.tsx', page('Added'));
  }
  if (headUserInterfaceStyle !== undefined) await put('app.json', appJson(headUserInterfaceStyle));
  const headSha = commit('modify add and remove source screens');
  git(headProject, 'worktree', 'add', '--detach', baseProject, baseSha);
  await writeCaptureObserverPackages(headProject, { provider });
  await writeCaptureObserverPackages(baseProject, { provider });
  const pr = { repositoryId: '123', repository: 'acme/example', number: 7, title: 'Source capture integration', url: 'https://github.com/acme/example/pull/7',
    base: { ref: 'main', sha: baseSha }, head: { ref: 'feature', sha: headSha } };
  const pullRequestPath = join(root, 'pull-request.json'); await writeFile(pullRequestPath, JSON.stringify(pr));
  const environment = { PATH: process.env.PATH, HOME: root, RUNNER_TEMP: root, EXPO_TOKEN: 'test-expo-secret', GITHUB_TOKEN: 'test-github-secret',
    GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: pr.repository, TOOLS_COMMIT: 'c'.repeat(40), EXPLORE_VIEWER_ORIGIN: 'https://viewer.example' };
  const requests = []; const comments = []; const sessions = new Map(); let currentSession; const idleDevice = { path: '/', scheme: 'light' }; let sessionCounter = 0; let repackedSha; let openFailed = false;
  const identity = () => ({ session: 'expo-explore-runtime', appBundleId: config.app.bundleId,
    device: { id: 'device-1', name: config.device.name, platform, target: 'mobile', osVersion: '26.0', locale: 'en-US', orientation: 'portrait', colorScheme: 'light' },
    identifiers: { session: 'expo-explore-runtime', appBundleId: config.app.bundleId, deviceId: 'device-1', deviceName: config.device.name } });
  // The fixture's clock: every controller round trip advances it by one poll interval, as a device snapshot would, so a
  // readiness budget expires in simulated time and a route that never becomes ready costs no real seconds.
  let clockMs = Date.now();
  const now = () => clockMs;
  const sleep = milliseconds => { clockMs += milliseconds; };
  const runner = request => {
    requests.push(request);
    if (basename(request.command) === 'agent-device') clockMs += 600;
    if (request.command === 'git') { const result = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8', env: request.environment }); assert.equal(result.status, 0); return { stdout: result.stdout, stderr: result.stderr }; }
    const command = request.args[0];
    if (basename(request.command) === 'eas') {
      if (command === 'config') {
        const declared = JSON.parse(readFileSync(join(request.cwd, 'app.json'), 'utf8')).expo.userInterfaceStyle;
        return json({ buildProfile: { simulator: true, distribution: 'internal', environment: 'preview', env: {} }, appConfig: { name: 'Example', slug: 'example', owner: 'acme', scheme: 'sample',
          ...(declared ? { userInterfaceStyle: declared } : {}), ios: { bundleIdentifier: config.app.bundleId }, android: { package: config.app.bundleId }, extra: { eas: { projectId: PROJECT_ID } } } });
      }
      if (command === 'simulator:availability') return json({ available: true });
      if (command === 'fingerprint:generate') return json({ hash: `fingerprint-${git(request.cwd, 'rev-parse', 'HEAD')}` });
      if (command === 'build:list') return json([]);
      if (command === 'build') return json([{ id: `build-${git(request.cwd, 'rev-parse', 'HEAD')}`, fingerprint: { hash: 'mock-native-fingerprint' }, appVersion: '3.0.0', appBuildVersion: '7' }]);
      if (command === 'env:pull') { writeFileSync(value(request, '--path'), '# Environment: preview\n'); return { stdout: '', stderr: '' }; }
      if (command === 'build:download') { const path = join(request.environment.TMPDIR, 'native.app'); mkdirSync(path); return json({ path }); }
      if (command === 'upload') return json({ url: `https://expo.dev/accounts/acme/projects/example/builds/repacked-${repackedSha}` });
      if (command === 'workflow:run') {
        assert.equal(request.environment.EAS_NO_VCS, '1');
        const workflow = readFileSync(join(request.cwd, request.args[1]), 'utf8');
        assert.match(workflow, /EAS_NO_VCS: "1"/);
        assert.ok(existsSync(join(request.cwd, '.expo-explore-observer/metro.config.cjs')), 'the staged copy carries the observer');
        assert.ok(!existsSync(join(request.cwd, '.git')), 'the staged copy has no repository');
        repackedSha = /build_id: "build-([0-9a-f]+)"/.exec(workflow)[1];
        return json({ jobs: [{ key: 'repack', status: 'SUCCESS', outputs: { build_id: `repacked-${repackedSha}`, platform } }] });
      }
      if (command === 'simulator:start') {
        const id = `session-${++sessionCounter}`; currentSession = id; openFailed = false;
        const session = { id, name: value(request, '--name'), build: value(request, '--build-id'), path: '/', scheme: 'light' }; sessions.set(id, session);
        writeFileSync(join(request.cwd, '.env.eas-simulator'), `${HEADER}EAS_SIMULATOR_SESSION_ID='${id}'\nAGENT_DEVICE_DAEMON_BASE_URL='https://controller.example/${id}'\nAGENT_DEVICE_DAEMON_AUTH_TOKEN='controller-private-token'\n`);
        return { stdout: 'ready', stderr: '' };
      }
      if (command === 'simulator:get') { const session = sessions.get(value(request, '--id')); return json({ id: session.id, name: session.name, type: 'agent-device', platform: platform.toUpperCase(), status: 'IN_PROGRESS', app: { id: PROJECT_ID, slug: 'example', ownerAccount: { name: 'acme' } }, remoteConfig: { agentDeviceRemoteSessionUrl: `https://controller.example/${session.id}`, agentDeviceRemoteSessionToken: 'controller-private-token' } }); }
      if (command === 'simulator:stop') return json({ id: value(request, '--id'), status: 'STOPPED' });
    }
    if (basename(request.command) === 'repack-app') {
      repackedSha = git(request.cwd, 'rev-parse', 'HEAD');
      assert.ok(request.environment.EXPO_OVERRIDE_METRO_CONFIG, 'fresh and reused native builds must include the automatic observer');
      mkdirSync(value(request, '--output'));
      return { stdout: '', stderr: '' };
    }
    if (basename(request.command) === 'agent-device') {
      // Base and head capture in parallel, each on its own simulator: a request names its session in the daemon URL,
      // so the route, appearance and build it sees are that session's, not whichever session started last.
      const device = sessions.get(/\/([^/]+)$/.exec(request.environment?.AGENT_DEVICE_DAEMON_BASE_URL ?? '')?.[1]) ?? sessions.get(currentSession) ?? idleDevice;
      if (command === '--version') return { stdout: AGENT_DEVICE_VERSION, stderr: '' };
      if (command === 'open') {
        if (request.args[2]?.startsWith('sample://')) {
          if (recoverableOpenFailure && !openFailed) {
            openFailed = true;
            return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'The app is not ready for this link yet.' } });
          }
          device.path = '/' + request.args[2].slice('sample://'.length);
        }
        return ok(identity());
      }
      if (command === 'appstate') return ok({ platform, appBundleId: config.app.bundleId, source: 'session', device_udid: 'device-1' });
      if (command === 'wait') return ok({});
      if (command === 'alert' && request.args[1] === 'get') return json({ success: false, error: { code: 'COMMAND_FAILED', message: 'alert not found' } });
      if (command === 'snapshot') {
        const dynamic = device.path.startsWith('/item/');
        const destination = provider === 'expo-router'
          ? { provider, pathname: device.path, segments: dynamic ? ['item', '[id]'] : device.path.split('/').filter(Boolean), parameters: dynamic ? { id: device.path.slice('/item/'.length) } : {} }
          : { provider, segments: [device.path.slice(1).replace(/^./, first => first.toUpperCase())], parameters: {} };
        return ok({ truncated: false, nodes: [
          { index: 0, type: 'StaticText', label: device.path, identifier: 'screen-title', enabled: true, visible: true, rect: { x: 0, y: 0, width: 16, height: 24 } },
          ...(device.path === observerFailurePath ? [] : [{ index: 1, type: 'StaticText', label: JSON.stringify(destination), identifier: CAPTURE_OBSERVER_IDENTIFIER, enabled: true, visible: true }]),
        ] });
      }
      if (command === 'settings') { if (request.args[1] === 'appearance') device.scheme = request.args[2]; return ok({ setting: request.args[1], value: request.args[2] }); }
      if (command === 'screenshot') { const color = createHash('sha256').update(`${device.path}:${device.scheme}:${device.path === '/home' ? device.build : 'unchanged-source'}`).digest(); const data = Buffer.alloc(16 * 24 * 4); for (let i = 0; i < data.length; i += 4) { data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255; } writeFileSync(request.args[1], PNG.sync.write({ width: 16, height: 24, data })); return ok({ path: request.args[1] }); }
    }
    throw new Error(`Unexpected mocked command: ${request.command} ${request.args.join(' ')}`);
  };
  let sticky;
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.headers.authorization, `Bearer ${environment.GITHUB_TOKEN}`);
    if (url.pathname.endsWith('/pulls/7')) {
      // GitHub's view of the PR follows pull-request.json, so a test that moves the head moves the live PR too.
      const live = JSON.parse(await readFile(pullRequestPath, 'utf8'));
      return Response.json({ state: 'open', base: live.base, head: { ...live.head, repo: { full_name: live.repository } } });
    }
    // Artifact 900 belongs to run 1234, 901 to 1235, …: a later run on the same PR publishes its own artifact.
    const artifact = url.pathname.match(/\/actions\/artifacts\/(9\d\d)$/);
    if (artifact) { const run = 1234 + Number(artifact[1]) - 900; return Response.json({ expired: false, name: `explore-review-${run}-1`, workflow_run: { id: run } }); }
    const attempt = url.pathname.match(/\/actions\/runs\/(\d+)\/attempts\/1$/);
    if (attempt) return Response.json({ id: Number(attempt[1]), run_attempt: 1 });
    if (url.pathname.endsWith('/issues/7/comments') && (!init.method || init.method === 'GET')) return Response.json(sticky ? [sticky] : []);
    if ((url.pathname.endsWith('/issues/7/comments') && init.method === 'POST') || (url.pathname.endsWith('/issues/comments/42') && init.method === 'PATCH')) {
      const body = JSON.parse(init.body).body; comments.push(body); sticky = { id: 42, body, user: { login: 'github-actions[bot]' }, html_url: `${pr.url}#issuecomment-42` }; return Response.json(sticky);
    }
    throw new Error(`Unexpected mocked GitHub request: ${init.method ?? 'GET'} ${url.pathname}`);
  };
  // The other platform's job of the same run: the same PR, checkouts and sticky comment, a device of that platform.
  const setPlatform = next => { platform = next; config.app.platform = next; };
  return { root, baseProject, headProject, baseSha, headSha, config, environment, pullRequestPath, runner, now, sleep, requests, transport, comments, setPlatform };
}

