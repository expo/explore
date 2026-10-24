import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedRepackBuildId, hostedRepackFailure, hostedRepackRetries, hostedRepackRunStart, hostedRepackShareKey, hostedRepackShareMarker, hostedRepackWorkflow, sharedRepackBuildView, sharedRepackWaitMs, sharedRepackBuilds, stagedProjectDigest } from '../../dist/capture/eas-build.js';
import { repackShareOption } from '../../dist/ci/pipeline.js';
import { CiError } from '../../dist/shared/ci-errors.js';

test('the generated repack workflow pins the source build, skips VCS and points Metro at the staged observer', () => {
  const workflow = hostedRepackWorkflow({ buildId: 'c776c923-ef47-4e5c-910b-5319ac705f6e', profile: 'explore', environment: 'development', message: 'expo-explore ios capture' });
  assert.match(workflow, /^name: expo-explore-repack$/m);
  assert.match(workflow, /^ {4}type: repack$/m);
  assert.match(workflow, /^ {6}build_id: "c776c923-ef47-4e5c-910b-5319ac705f6e"$/m);
  assert.match(workflow, /^ {6}profile: "explore"$/m);
  assert.match(workflow, /^ {4}environment: "development"$/m);
  assert.match(workflow, /^ {6}js_bundle_only: true$/m);
  assert.match(workflow, /^ {6}embed_bundle_assets: true$/m);
  assert.match(workflow, /^ {6}EAS_NO_VCS: "1"$/m);
  assert.match(workflow, /^ {6}EXPO_OVERRIDE_METRO_CONFIG: "\.expo-explore-observer\/metro\.config\.cjs"$/m);
});

const run = (job) => JSON.stringify({ id: 'run-1', status: job.status, jobs: [job] });

test('a successful repack job yields its build id', () => {
  assert.equal(hostedRepackBuildId(run({ key: 'repack', status: 'SUCCESS', outputs: { build_id: 'acc47014-3efc-4858-bc0d-ca75ee21b82d', platform: 'ios' } }), '', 'ios'), 'acc47014-3efc-4858-bc0d-ca75ee21b82d');
  assert.throws(() => hostedRepackBuildId(run({ key: 'repack', status: 'SUCCESS', outputs: { build_id: '../x' } }), '', 'ios'), /did not return the repacked build id/);
});

test('a failed repack job becomes EAS_REPACK_FAILED with the build error and the logs link', () => {
  const stderr = 'Workflow run failed.\nSee logs: https://expo.dev/accounts/acme/projects/example/workflows/run-1\n';
  const job = { key: 'repack', status: 'FAILURE', turtleBuild: { status: 'ERRORED', error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message: 'Build step "Repack" failed.' } }, outputs: {} };
  assert.throws(() => hostedRepackBuildId(run(job), stderr, 'android'), error => {
    assert.ok(error instanceof CiError); assert.equal(error.code, 'EAS_REPACK_FAILED');
    assert.match(error.message, /hosted EAS repack of the android build finished with status FAILURE: Build step "Repack" failed\./);
    assert.match(error.nextAction, /https:\/\/expo\.dev\/accounts\/acme\/projects\/example\/workflows\/run-1/);
    return true;
  });
});

test('an exhausted build plan surfaces as EAS_PLAN_LIMIT_REACHED even from the hosted job', () => {
  const job = { key: 'repack', status: 'FAILURE', turtleBuild: { error: { message: 'This account has used its builds from the production_plus plan this month, which will reset in 13 days (on Sat Oct 24 2026).' } } };
  assert.throws(() => hostedRepackBuildId(run(job), '', 'ios'), error => error instanceof CiError && error.code === 'EAS_PLAN_LIMIT_REACHED' && /Oct 24 2026/.test(error.message));
});

test('non-JSON output from eas workflow:run is reported with the CLI tail', () => {
  assert.throws(() => hostedRepackBuildId('', 'Error: Not logged in\n', 'ios'), error => error instanceof CiError && error.code === 'EAS_REPACK_FAILED' && /Not logged in/.test(error.message));
});

const failed = (job, stderr = '') => { try { hostedRepackBuildId(run(job), stderr, 'ios'); } catch (error) { return error; } assert.fail('the repack did not fail'); };

test('a repack EAS failed around is repacked twice more, an unexplained one once, and one the app, a credential, a timeout or a person ended never', () => {
  // brentvatne/euxy#176 (review run 39506405687): the upload step's report of "Turtle build is not in progress".
  const upload = failed({ key: 'repack', status: 'FAILURE', turtleBuild: { status: 'ERRORED', error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message: 'Failed to upload application archive.' } } });
  assert.equal(upload.details.failure, 'infrastructure'); assert.equal(hostedRepackRetries(upload), 2);
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'SERVER_ERROR', message: 'Internal error.' } } })), 2);
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'ERRORED' })), 1, 'a run that says nothing is tried once more');
  const unexplained = { key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message: 'Unknown custom build error. See logs for more information.' } } };
  assert.equal(hostedRepackRetries(failed(unexplained)), 1);
  // What the CLI printed and the failed job's logs count too: a bundling error there is the app's.
  assert.equal(failed(unexplained, 'SyntaxError: app/home.tsx: Unexpected token (4:2)\n').details.failure, 'app');
  assert.equal(failed(unexplained, 'Build step "Repack app" failed\n').details.failure, 'app');
  assert.equal(failed(unexplained, 'Build step "Spin up build environment" failed\n').details.failure, 'infrastructure');
  for (const message of ['Build step "Repack app" failed', 'Unable to resolve module ./missing from app/index.tsx', 'SyntaxError: app/home.tsx: Unexpected token (4:2)']) {
    const error = failed({ key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message } } });
    assert.equal(error.details.failure, 'app', message); assert.equal(hostedRepackRetries(error), 0, message);
  }
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'CANCELED' })), 0, 'a run someone cancelled is not started again');
  // A build that ran out its time (a bundling hang, say) would run it out again.
  assert.equal(failed({ key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'EAS_BUILD_TIMEOUT_ERROR', message: 'Build timed out.' } } }).details.failure, 'timeout');
  // Before a run starts: a refused token is not retried, a failed upload of the staged copy is.
  assert.throws(() => hostedRepackBuildId('', 'Error: Not logged in\n', 'ios'), error => hostedRepackRetries(error) === 0);
  assert.throws(() => hostedRepackBuildId('', 'Failed to upload project sources.\nError: socket hang up\n', 'ios'), error => hostedRepackRetries(error) === 2);
  assert.equal(hostedRepackRetries(new Error('spawnSync eas ETIMEDOUT')), 0, 'a command that ran out its time is not repeated');
  // The run's own link names it, as eas workflow:view --json reports it.
  assert.equal(failed({ key: 'repack', status: 'ERRORED' }).details.logs, undefined);
  assert.throws(() => hostedRepackBuildId(JSON.stringify({ id: 'run-2', logURL: 'https://expo.dev/accounts/acme/projects/example/workflows/run-2', jobs: [{ key: 'repack', status: 'ERRORED' }] }), '', 'ios'),
    error => error.details.logs === 'https://expo.dev/accounts/acme/projects/example/workflows/run-2');
});

test('only exact EAS words make a failure infrastructure, and a refused credential is never retried', () => {
  const cases = {
    infrastructure: ["Error: Cannot find module '/opt/eas/node_modules/@expo/build-tools/dist/index.js'", 'Turtle build is not in progress, it cannot save artifacts.', 'Unexpected response from server (503): Service Unavailable', 'Error: socket hang up',
      'getaddrinfo EAI_AGAIN api.expo.dev', 'Failed to start the workflow with the API.', 'Build step "Upload artifact" failed', 'Build step "Download build" failed'],
    app: ['Unable to resolve "react-native-reanimated" from "index.js"', 'Asset upload failed: could not read ./assets/icon.png', "Cannot find module './missing'",
      'Build step "Upload artifact" failed\nAsset upload failed: could not read ./assets/icon.png'],
    configuration: ['npm error code E401\nnpm error 401 Unauthorized - GET https://npm.example.com/download/@acme/ui-1.0.0.tgz', 'Error: Not logged in',
      'Entity not authorized: AppEntity[1234]', 'Request failed: 403 Forbidden'],
    timeout: ['EAS_BUILD_TIMEOUT_ERROR Build timed out.'],
    unknown: ['Unexpected response from server (400): bad request', 'a download of 500 files', 'Build step "Install dependencies" failed', 'the request has a timeout of 10 s',
      'Permission check finished', ''],
  };
  for (const [failure, texts] of Object.entries(cases)) for (const text of texts) assert.equal(hostedRepackFailure(text), failure, text);
  assert.equal(hostedRepackFailure('Turtle build is not in progress', 'CANCELED'), 'canceled');
});

test('later targets wait a minute longer each, so a missing leader is replaced by one repack and not one per target', () => {
  assert.deepEqual([0, 1, 2, 3].map(rank => sharedRepackWaitMs({ rank })), [0, 180_000, 240_000, 300_000]);
  assert.deepEqual([0, 1, 2, 3].map(rank => sharedRepackWaitMs({ rank, rerun: true })), [0, 60_000, 120_000, 180_000]);
  assert.deepEqual([0, 1, 2, 3].map(rank => sharedRepackWaitMs({ rank }, true)), [60_000, 60_000, 120_000, 180_000]);
});

test('a started run is known by its JSON or by the link it printed, and a start that printed neither started none', () => {
  const url = 'https://expo.dev/accounts/acme/projects/example/workflows/01a15b61-c4a2-7c7b-b950-9f280edea954';
  assert.deepEqual(hostedRepackRunStart(JSON.stringify({ id: '01a15b61-c4a2-7c7b-b950-9f280edea954', url }), '', 'ios'), { id: '01a15b61-c4a2-7c7b-b950-9f280edea954', url });
  assert.deepEqual(hostedRepackRunStart('', `Using workflow file from .eas/workflows/expo-explore-repack.yml\nSee logs: ${url}\n`, 'ios'), { id: '01a15b61-c4a2-7c7b-b950-9f280edea954', url });
  assert.throws(() => hostedRepackRunStart('', 'Failed to upload project sources.\nError: socket hang up\n', 'ios'),
    error => error.code === 'EAS_REPACK_FAILED' && hostedRepackRetries(error) === 2 && /did not start the hosted ios repack/.test(error.message));
  assert.throws(() => hostedRepackRunStart('', 'Error: Not logged in\n', 'ios'), error => hostedRepackRetries(error) === 0);
  // The link is written to logs and errors: only the page, never a query or fragment eas-cli appended to it.
  assert.deepEqual(hostedRepackRunStart(JSON.stringify({ id: '01a15b61-c4a2-7c7b-b950-9f280edea954', url: `${url}?token=SECRET#frag` }), '', 'ios'),
    { id: '01a15b61-c4a2-7c7b-b950-9f280edea954', url });
  const failed = (() => { try { hostedRepackBuildId(JSON.stringify({ status: 'FAILURE', logURL: `${url}?sig=SECRET`, jobs: [{ key: 'repack', status: 'FAILURE' }] }), '', 'ios'); } catch (error) { return error; } })();
  assert.equal(failed.details.logs, url);
  assert.equal(JSON.stringify(failed).includes('SECRET') || failed.nextAction.includes('SECRET'), false);
});

test('the staged digest changes with any file, mode or link, and the share key with every input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-staged-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'index.js'), 'export default 1;\n');
  await writeFile(join(root, 'package.json'), '{}\n');
  await symlink('app/index.js', join(root, 'entry.js'));
  const digests = [await stagedProjectDigest(root)];
  assert.equal(await stagedProjectDigest(root), digests[0], 'the digest is stable');
  await writeFile(join(root, 'app', 'index.js'), 'export default 2;\n'); digests.push(await stagedProjectDigest(root));
  await chmod(join(root, 'package.json'), 0o755); digests.push(await stagedProjectDigest(root));
  await rm(join(root, 'entry.js')); await symlink('package.json', join(root, 'entry.js')); digests.push(await stagedProjectDigest(root));
  await mkdir(join(root, 'empty')); digests.push(await stagedProjectDigest(root));
  assert.equal(new Set(digests).size, digests.length);
  const input = { scope: 'acme/example#39506405687.1', platform: 'ios', fingerprint: 'ea9bf84e1a5b0900000ba7c1e6b1c7e272e1306f', easProfile: 'explore', environment: 'preview', environmentVariables: 'a'.repeat(64), project: digests[0] };
  const key = hostedRepackShareKey(input);
  assert.match(key, /^[0-9a-f]{32}$/);
  for (const [name, other] of Object.entries({ scope: 'acme/example#39506405687.2', platform: 'android', fingerprint: 'fc2446ef4e6d0000000000000000000000000000', easProfile: 'other', environment: 'production',
    environmentVariables: 'b'.repeat(64), project: digests[1] })) {
    assert.notEqual(hostedRepackShareKey({ ...input, [name]: other }), key, name);
  }
  // Which build a job found to repack does not matter, only its native code: a target that starts after the others'
  // repack finished finds that repack as its newest build of the fingerprint (brentvatne/euxy#179), and must still
  // join it rather than make another.
  assert.equal(hostedRepackShareKey({ ...input, nativeBuildId: '7f6b592a' }), hostedRepackShareKey({ ...input, nativeBuildId: '2ebcfd8d' }));
});

test("only a build whose message ends with this key, for this platform, is another job's repack", () => {
  const marker = hostedRepackShareMarker('0'.repeat(32));
  const message = `expo-explore ios capture: route observer repack ${marker}`;
  const listed = JSON.stringify([
    { id: 'shared', status: 'IN_PROGRESS', platform: 'IOS', message },
    { id: 'android', status: 'FINISHED', platform: 'ANDROID', message },
    { id: 'other-key', status: 'FINISHED', platform: 'IOS', message: `expo-explore ios capture: route observer repack ${hostedRepackShareMarker('1'.repeat(32))}` },
    { id: 'suffixed', status: 'FINISHED', platform: 'IOS', message: `${message} and more` },
    { id: '../escape', status: 'FINISHED', platform: 'IOS', message },
    { id: 'no-message', status: 'FINISHED', platform: 'IOS' },
  ]);
  assert.deepEqual(sharedRepackBuilds(listed, marker, 'ios'), [{ id: 'shared', status: 'IN_PROGRESS' }]);
  assert.equal(sharedRepackBuilds('Error: GraphQL request failed', marker, 'ios'), undefined);
  // A followed build is read by its id: null once it no longer carries the key, undefined when unreadable.
  assert.deepEqual(sharedRepackBuildView(JSON.stringify({ id: 'shared', status: 'FINISHED', platform: 'IOS', message }), marker, 'ios'), { id: 'shared', status: 'FINISHED' });
  assert.equal(sharedRepackBuildView(JSON.stringify({ id: 'shared', status: 'FINISHED', platform: 'IOS', message: 'edited' }), marker, 'ios'), null);
  assert.equal(sharedRepackBuildView('', marker, 'ios'), undefined);
});

test("a target shares its repacks only with its own GitHub run's jobs, and only when another target repacks the same app", () => {
  const config = { target: { id: 'duo-open', platform: 'ios', label: 'Duo open' }, capture: {} };
  const environment = { GITHUB_RUN_ID: '39506405687', GITHUB_REPOSITORY: 'brentvatne/euxy' };
  assert.deepEqual(repackShareOption(config, environment, ['iphone', 'duo-open']), { repackShare: { scope: 'brentvatne/euxy#39506405687.1', leader: 'iphone', target: 'duo-open', rank: 1 } });
  // "Re-run failed jobs" is an attempt of its own, whose stagger starts at once: the first attempt's leader may not run again.
  assert.deepEqual(repackShareOption(config, { ...environment, GITHUB_RUN_ATTEMPT: '2' }, ['iphone', 'duo-open']),
    { repackShare: { scope: 'brentvatne/euxy#39506405687.2', leader: 'iphone', target: 'duo-open', rank: 1, rerun: true } });
  assert.deepEqual(repackShareOption(config, { ...environment, GITHUB_RUN_ATTEMPT: 'x' }, ['iphone', 'duo-open']), {});
  assert.deepEqual(repackShareOption(config, environment, ['duo-open']), {}, 'a single target behaves as before');
  assert.deepEqual(repackShareOption(config, environment, undefined), {});
  assert.deepEqual(repackShareOption(config, {}, ['iphone', 'duo-open']), {}, 'outside GitHub Actions there is no run to share with');
  assert.deepEqual(repackShareOption({ ...config, capture: { repack: 'local' } }, environment, ['iphone', 'duo-open']), {});
});
