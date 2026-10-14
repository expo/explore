import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedRepackBuildId, hostedRepackWorkflow } from '../../dist/capture/eas-build.js';
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
