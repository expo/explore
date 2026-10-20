import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedRepackBuildId, hostedRepackRetries, hostedRepackShareKey, hostedRepackShareMarker, hostedRepackWorkflow, sharedRepackBuilds, stagedProjectDigest } from '../../dist/capture/eas-build.js';
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

test('a repack EAS failed around is repacked twice more, an unexplained one once, and one the app or a person ended never', () => {
  // brentvatne/euxy#176 (review run 39506405687): the upload step's report of "Turtle build is not in progress".
  const upload = failed({ key: 'repack', status: 'FAILURE', turtleBuild: { status: 'ERRORED', error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message: 'Failed to upload application archive.' } } });
  assert.equal(upload.details.failure, 'infrastructure'); assert.equal(hostedRepackRetries(upload), 2);
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'EAS_BUILD_TIMEOUT_ERROR', message: 'Build timed out.' } } })), 2);
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'ERRORED' })), 1, 'a run that says nothing is tried once more');
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message: 'Unknown custom build error. See logs for more information.' } } })), 1);
  for (const message of ['Build step "Repack app" failed', 'Unable to resolve module ./missing from app/index.tsx', 'SyntaxError: app/home.tsx: Unexpected token (4:2)']) {
    const error = failed({ key: 'repack', status: 'FAILURE', turtleBuild: { error: { errorCode: 'UNKNOWN_CUSTOM_BUILD_ERROR', message } } });
    assert.equal(error.details.failure, 'app', message); assert.equal(hostedRepackRetries(error), 0, message);
  }
  assert.equal(hostedRepackRetries(failed({ key: 'repack', status: 'CANCELED' })), 0, 'a run someone cancelled is not started again');
  // Before a run starts: a refused token is not retried, a failed upload of the staged copy is.
  assert.throws(() => hostedRepackBuildId('', 'Error: Not logged in\n', 'ios'), error => hostedRepackRetries(error) === 0);
  assert.throws(() => hostedRepackBuildId('', 'Failed to upload project sources.\nError: socket hang up\n', 'ios'), error => hostedRepackRetries(error) === 2);
  assert.equal(hostedRepackRetries(new Error('spawnSync eas ETIMEDOUT')), 0, 'a repack that ran out its 30 minutes is not repeated');
  // The run's own link names it, as eas workflow:run --json reports it.
  const linked = failed({ key: 'repack', status: 'ERRORED' });
  assert.equal(linked.details.logs, undefined);
  assert.throws(() => hostedRepackBuildId(JSON.stringify({ id: 'run-2', url: 'https://expo.dev/accounts/acme/projects/example/workflows/run-2', jobs: [{ key: 'repack', status: 'ERRORED' }] }), '', 'ios'),
    error => error.details.logs === 'https://expo.dev/accounts/acme/projects/example/workflows/run-2');
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
  const input = { scope: 'acme/example#39506405687', platform: 'ios', nativeBuildId: 'a81d5d80', easProfile: 'explore', environment: 'preview', project: digests[0] };
  const key = hostedRepackShareKey(input);
  assert.match(key, /^[0-9a-f]{32}$/);
  for (const [name, other] of Object.entries({ scope: 'acme/example#1', platform: 'android', nativeBuildId: 'b0000000', easProfile: 'other', environment: 'production', project: digests[1] })) {
    assert.notEqual(hostedRepackShareKey({ ...input, [name]: other }), key, name);
  }
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
});

test("a target shares its repacks only with its own GitHub run's jobs, and only when another target repacks the same app", () => {
  const config = { target: { id: 'duo-open', platform: 'ios', label: 'Duo open' }, capture: {} };
  const environment = { GITHUB_RUN_ID: '39506405687', GITHUB_REPOSITORY: 'brentvatne/euxy' };
  assert.deepEqual(repackShareOption(config, environment, ['iphone', 'duo-open']), { repackShare: { scope: 'brentvatne/euxy#39506405687', leader: 'iphone', target: 'duo-open' } });
  assert.deepEqual(repackShareOption(config, environment, ['duo-open']), {}, 'a single target behaves as before');
  assert.deepEqual(repackShareOption(config, environment, undefined), {});
  assert.deepEqual(repackShareOption(config, {}, ['iphone', 'duo-open']), {}, 'outside GitHub Actions there is no run to share with');
  assert.deepEqual(repackShareOption({ ...config, capture: { repack: 'local' } }, environment, ['iphone', 'duo-open']), {});
});
