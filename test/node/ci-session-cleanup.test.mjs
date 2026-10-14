import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupCiSessions } from '../../scripts/cleanup-ci-sessions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'explore-cleanup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const head = join(root, 'head-session');
  const base = join(root, 'base-session');
  const calls = [];
  const environment = { RUNNER_TEMP: root, EXPO_TOKEN: 'expo-test-key', GITHUB_TOKEN: 'github-test-key', ANTHROPIC_API_KEY: 'agent-test-key' };
  const options = { sessionFiles: [head, base], easCommand: '/pinned/tools/eas', environment,
    runCommand: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ id: args[2], status: 'STOPPED' }), stderr: '' };
    } };
  return { root, head, base, calls, options };
}

test('absent retained handoffs cause no process or authentication attempt', async t => {
  const f = await fixture(t);
  const result = await cleanupCiSessions({ ...f.options, environment: { RUNNER_TEMP: f.root } });
  assert.deepEqual(result, { stopped: [], failures: [] });
  assert.equal(f.calls.length, 0);
});

test('cleanup targets only explicit owned handoffs, validates response, and isolates credentials and files', async t => {
  const f = await fixture(t);
  await writeFile(f.head, 'owned-head\n');
  await writeFile(f.base, 'owned-base\n');
  await writeFile(join(f.root, 'unrelated-session'), 'not-ours\n');
  const result = await cleanupCiSessions(f.options);
  assert.deepEqual(result, { stopped: ['owned-head', 'owned-base'], failures: [] });
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.command, '/pinned/tools/eas');
    assert.deepEqual(call.args, ['simulator:stop', '--id', ['owned-head', 'owned-base'][index], '--json', '--non-interactive']);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(call.options.killSignal, 'SIGKILL');
    assert.deepEqual(call.options.env, { CI: 'true', EXPO_TOKEN: 'expo-test-key' });
    await assert.rejects(access(call.options.cwd));
  }
  await assert.rejects(access(f.head));
  await assert.rejects(access(f.base));
  assert.equal(await readFile(join(f.root, 'unrelated-session'), 'utf8'), 'not-ours\n');
});

test('malformed, oversized, symlinked, and escaping handoffs never issue a stop', async t => {
  const f = await fixture(t);
  for (const value of ['--all\n', 'id\nother-id', 'a'.repeat(300)]) {
    await writeFile(f.head, value);
    assert.equal((await cleanupCiSessions(f.options)).failures.length, 1);
  }
  await rm(f.head);
  await writeFile(f.base, 'valid-id');
  await symlink(f.base, f.head);
  const result = await cleanupCiSessions({ ...f.options, sessionFiles: [f.head] });
  assert.equal(result.failures.length, 1);
  const outside = await mkdtemp(join(tmpdir(), 'explore-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const path = join(outside, 'head-session'); await writeFile(path, 'valid-id');
  assert.equal((await cleanupCiSessions({ ...f.options, sessionFiles: [path] })).failures.length, 1);
  assert.equal(f.calls.length, 0);
});

test('unconfirmed stop retains its exact handoff, continues other cleanup, and never echoes raw stderr', async t => {
  const f = await fixture(t);
  await writeFile(f.head, 'owned-head\n'); await writeFile(f.base, 'owned-base\n');
  const result = await cleanupCiSessions({ ...f.options, runCommand: (command, args, options) => args[2] === 'owned-head'
    ? { status: 1, stderr: 'expo-test-key github-test-key', stdout: '' }
    : f.options.runCommand(command, args, options) });
  assert.deepEqual(result.stopped, ['owned-base']);
  assert.equal(result.failures[0].code, 'SESSION_CLEANUP_FAILED');
  assert.equal(result.failures[0].sessionId, 'owned-head');
  assert.doesNotMatch(JSON.stringify(result), /expo-test-key|github-test-key/);
  assert.equal(await readFile(f.head, 'utf8'), 'owned-head\n');
  await assert.rejects(access(f.base));
  for (const response of [{ id: 'other', status: 'STOPPED' }, { id: 'owned-head', status: 'IN_PROGRESS' }]) {
    const checked = await cleanupCiSessions({ ...f.options, runCommand: () => ({ status: 0, stdout: JSON.stringify(response) }) });
    assert.equal(checked.failures.length, 1);
    assert.equal(await readFile(f.head, 'utf8'), 'owned-head\n');
  }
});
