import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_OBSERVER_IDENTIFIER, captureObserverParameterKeys, observedParameters } from '../../dist/capture/observer.js';
import { discoverRoutes } from '../../dist/source/route-inventory.js';
import { CiError } from '../../dist/shared/ci-errors.js';
import { assertAgentCaptureContext, fragmentLandmarks, readAgentSource, resolveAgentCaptureContext, runCiAgentNavigation } from '../../dist/capture/agent/runtime.js';
import { createExplorationInputs } from '../../dist/config/exploration-inputs.js';

const route = (id, extra = {}) => ({ id, provider: 'expo-router', kind: 'screen', route: `/${id}`, path: `/${id}`,
  logicalPath: `/${id}`, routeFile: `app/${id}.tsx`, sourceFiles: [], variant: 'default', ...extra });
const snapshot = (id, { parameters = {}, pathname = `/${id}`, landmarks = [`${id}-screen`], extra = [] } = {}) => ({ refsGeneration: 1, truncated: false, nodes: [
  { identifier: CAPTURE_OBSERVER_IDENTIFIER, type: 'StaticText', label: JSON.stringify({ provider: 'expo-router', pathname, segments: id.split('/'), parameters }) },
  ...landmarks.map(identifier => ({ type: 'StaticText', identifier, label: identifier, visible: true })), ...extra,
] });

async function fixture(t, run = async () => {}, extra = {}) {
  const project = await mkdtemp(join(tmpdir(), 'explore-agent-runtime-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, 'app'));
  await writeFile(join(project, 'app/account.tsx'), 'export default function Account() { return "Account screen"; }');
  const requests = [], trace = [], captures = [], performed = [], replies = [];
  const secret = 'private-app-password';
  const inputs = createExplorationInputs({ instructions: 'Use {{secret:TEST_PASSWORD}}.', environment: { TEST_PASSWORD: secret } });
  const routes = extra.routes ?? [route('account')];
  let active = 'account';
  let frame = 0;
  const f = { requests, trace, captures, performed, replies, secret, setActive: value => { active = value; },
    snapshot: () => snapshot(active, { extra: [
      { type: 'TextField', identifier: 'password', label: 'Password', enabled: true },
      { type: 'Button', identifier: 'sign-in', label: 'Sign in', enabled: true },
      { type: 'Button', identifier: 'sign-out', label: 'Sign out', enabled: true },
    ] }) };
  f.options = {
    agent: { instructions: 'Use the test account; complete sign-out and re-login. Password: {{secret:TEST_PASSWORD}}.',
      contexts: {}, secretValues: [secret], resolveInput: inputs.resolve,
      provider: { provider: 'anthropic', model: 'test', preflight: async () => {}, run: async request => {
        requests.push(request);
        const call = async (name, input = {}) => {
          const response = await request.callTool(name, input, request.signal);
          const result = JSON.parse(response.content[0].text);
          replies.push({ name, result, response });
          return result;
        };
        if (typeof run === 'function') await run(call, f, request);
        return { inputTokens: 50, outputTokens: 20 };
      } } },
    project, routes, inventory: routes, scheme: 'testapp', deadlineMs: Date.now() + 60_000, maxTurns: 60,
    observe: async () => ({ snapshot: f.snapshot(), frameId: `frame-${++frame}`, image: 'aW1hZ2U=',
      imageSha256: 'a'.repeat(64), capturedAt: new Date(0).toISOString() }),
    act: async action => { performed.push(action); },
    capture: async (target, context, frameId) => { captures.push({ target, context, frameId }); },
    redact: inputs.redact, redactValue: inputs.redactValue, trace: async event => { trace.push(event); },
    ...extra,
  };
  return f;
}
const accept = async (call, id = 'account', observed) => {
  const view = observed ?? await call('observe');
  return call('capture', { frameId: view.frameId, targetId: id, description: 'The intended review state.', requiredLabels: [`${id}-screen`] });
};
const finish = call => call('finish', { procedureSummary: 'Completed the instructed exploration and transitions.' });

test('one CLI session directs authentication, observes outcomes, and completes transitions after captures', async t => {
  const f = await fixture(t, async (call, _f) => {
    await call('act', { action: 'open', url: 'testapp://account' });
    const login = await call('observe');
    const rejected = await call('capture', { frameId: login.frameId, targetId: 'account', description: 'Account.', requiredLabels: ['account-screen'] });
    assert.equal(rejected.error.code, 'AGENT_ROUTE_UNVERIFIED');
    await call('act', { action: 'fill', identifier: 'password', text: '{{secret:TEST_PASSWORD}}' });
    await call('observe');
    await call('act', { action: 'tap', identifier: 'sign-in' });
    await accept(call);
    await call('observe');
    await call('act', { action: 'tap', identifier: 'sign-out' });
    await accept(call, 'login');
    await call('observe');
    await call('act', { action: 'tap', identifier: 'sign-in' });
    const account = await call('observe');
    assert.equal(account.currentTargets[0].id, 'account');
    await finish(call);
  }, { routes: [route('account'), route('login')] });
  f.setActive('login');
  f.options.act = async action => {
    f.performed.push(action);
    if (action.action === 'tap') f.setActive(action.identifier === 'sign-in' ? 'account' : 'login');
  };
  await runCiAgentNavigation(f.options);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.captures.map(item => item.target.id), ['account', 'login']);
  assert.equal(f.performed.find(action => action.action === 'fill').text, f.secret);
  assert.equal(JSON.stringify(f.replies).includes(f.secret), false);
  assert.equal(JSON.stringify(f.trace).includes(f.secret), false);
  const prompt = JSON.parse(f.requests[0].prompt);
  assert.ok(prompt.sourceFiles.includes('app/account.tsx'));
  assert.equal(prompt.source, undefined, 'source is available on demand instead of copied into every session');
  assert.equal(f.trace.at(-1).result.completed, true);
  const reentry = f.trace.filter(e => e.action === 'observe').at(-1);
  assert.equal(reentry.observedAfter.destination.pathname, '/account');
});

test('finish, unknown targets, and duplicate captures cannot bypass verified receipts', async t => {
  const f = await fixture(t, async call => {
    assert.equal((await finish(call)).error.code, 'AGENT_TARGETS_INCOMPLETE');
    const frame = await call('observe');
    assert.equal((await call('capture', { frameId: frame.frameId, targetId: 'invented' })).error.code, 'AGENT_TARGET_UNKNOWN');
    await accept(call, 'account', frame);
    assert.equal((await call('capture', { frameId: frame.frameId, targetId: 'account' })).error.code, 'AGENT_TARGET_ALREADY_CAPTURED');
    await finish(call);
  });
  await runCiAgentNavigation(f.options);
  assert.equal(f.captures.length, 1);
});

test('a candidate is invalidated by observation or mutation and capture never requests another image', async t => {
  const f = await fixture(t, async (call, f) => {
    const first = await call('observe');
    const second = await call('observe');
    assert.equal((await call('capture', { frameId: first.frameId, targetId: 'account' })).error.code, 'AGENT_FRAME_STALE');
    f.setActive('login'); // The device changes while the model considers its already inspected image.
    await accept(call, 'account', second);
    assert.equal(f.captures[0].frameId, second.frameId);
    assert.equal(f.captures[0].target.id, 'account');
    await finish(call);
  });
  await runCiAgentNavigation(f.options);
  assert.equal(f.trace.filter(e => e.action === 'observe').length, 2);
});

test('capture preserves selector accessibility while consuming its image and automatic action observations request no screenshot', async t => {
  const observations = [];
  const f = await fixture(t, async call => {
    const first = await call('observe', { includeImage: false });
    assert.equal(first.frameId, undefined);
    assert.equal((await call('capture', { frameId: 'absent', targetId: 'account' })).error.code, 'AGENT_FRAME_UNAVAILABLE');
    const image = await call('observe', { includeImage: true });
    await accept(call, 'account', image);
    assert.equal((await call('act', { action: 'tap', frameId: image.frameId, x: 0.2, y: 0.3 })).error.code, 'AGENT_FRAME_STALE');
    const next = await call('act', { action: 'tap', identifier: 'sign-in' });
    assert.equal(next.performed, 'tap');
    assert.equal(next.frameId, undefined);
    assert.equal(next.currentTargets[0].captured, true);
    assert.deepEqual(next.currentTargets[0].context.requiredLabels, ['account-screen']);
    assert.equal((await call('act', { action: 'tap', identifier: 'sign-out' })).performed, 'tap');
    await finish(call);
  });
  const observe = f.options.observe;
  f.options.observe = async (signal, options) => { observations.push(options.includeImage); return observe(signal); };
  await runCiAgentNavigation(f.options);
  assert.deepEqual(observations, [false, true, false, false]);
  assert.equal(f.replies.filter(reply => reply.response.content.some(block => block.type === 'image')).length, 1);
  assert.deepEqual(f.performed.map(action => action.identifier), ['sign-in', 'sign-out']);
  assert.equal(f.trace.find(event => event.action === 'tap' && event.result.performed).observedAfter.destination.pathname, '/account');
  assert.equal(f.trace.some(event => 'usage' in event), false, 'tool calls do not fabricate provider token usage');
});

test('AX-only observation invalidates old frame and complete progress is fetched only on demand', async t => {
  const f = await fixture(t, async call => {
    const image = await call('observe');
    const light = await call('observe', { includeImage: false });
    assert.equal(light.frameId, undefined);
    assert.equal(light.contexts, undefined);
    assert.equal(light.remainingTargets, undefined);
    assert.equal(light.remainingCount, 1);
    assert.equal((await call('capture', { frameId: image.frameId, targetId: 'account' })).error.code, 'AGENT_FRAME_UNAVAILABLE');
    const progress = await call('get_progress');
    assert.equal(progress.remainingTargets[0].id, 'account');
    assert.deepEqual(progress.contexts, {});
    await accept(call);
    const complete = await call('get_progress');
    assert.deepEqual(complete.remainingTargets, []);
    assert.equal(complete.contexts.account.description, 'The intended review state.');
    await finish(call);
  });
  await runCiAgentNavigation(f.options);
});

test('uncertain mutations return fresh accessibility without replay, and failed post-action observations preserve performed status', async t => {
  let failObservation = false;
  const f = await fixture(t, async call => {
    await call('observe', { includeImage: false });
    const uncertain = await call('act', { action: 'tap', identifier: 'sign-in' });
    assert.equal(uncertain.error.code, 'MUTATION_UNCERTAIN');
    assert.equal(uncertain.outcome, 'unknown');
    assert.equal(uncertain.currentTargets[0].id, 'account');
    assert.ok(uncertain.observation.nodes.some(node => node.identifier === 'account-screen'));
    failObservation = true;
    const performed = await call('act', { action: 'wait', milliseconds: 1 });
    assert.equal(performed.performed, 'wait');
    assert.equal(performed.error, undefined);
    assert.equal(performed.observationError.code, 'OBSERVATION_UNAVAILABLE');
    assert.equal((await call('act', { action: 'tap', identifier: 'sign-out' })).error.code, 'AGENT_OBSERVATION_REQUIRED');
    failObservation = false;
    await accept(call); await finish(call);
  });
  const observe = f.options.observe;
  f.options.observe = async signal => {
    if (failObservation) throw new CiError({ code: 'OBSERVATION_UNAVAILABLE', stage: 'capture', message: 'Read failed.', nextAction: 'Observe.', retryable: true });
    return observe(signal);
  };
  f.options.act = async action => {
    f.performed.push(action);
    if (action.action === 'tap') throw new CiError({ code: 'MUTATION_UNCERTAIN', stage: 'controller', message: 'Submission may have completed.', nextAction: 'Observe.' });
  };
  await runCiAgentNavigation(f.options);
  assert.deepEqual(f.performed.map(action => action.action), ['tap', 'wait']);
  const attempted = f.trace.find(event => event.result.outcome === 'unknown');
  assert.equal(attempted.observedAfter.destination.pathname, '/account');
});

test('an action returns fresh accessibility and sensitive-image withholding still allows AX-guided input', async t => {
  const f = await fixture(t, async (call, f) => {
    const view = await call('observe');
    assert.equal(view.frameId, undefined);
    assert.equal((await call('capture', { frameId: 'invented', targetId: 'account' })).error.code, 'AGENT_FRAME_UNAVAILABLE');
    assert.equal((await call('act', { action: 'fill', identifier: 'password', text: '{{secret:TEST_PASSWORD}}' })).performed, 'fill');
    const tapped = await call('act', { action: 'tap', identifier: 'sign-in' });
    assert.equal(tapped.performed, 'tap');
    assert.ok(tapped.observation.nodes.length);
    assert.equal(tapped.frameId, undefined);
    f.options.observe = async () => ({ snapshot: f.snapshot(), frameId: 'safe', image: 'aW1hZ2U=', imageSha256: 'b'.repeat(64), capturedAt: new Date(0).toISOString() });
    await accept(call);
    await finish(call);
  });
  f.options.observe = async () => ({ snapshot: f.snapshot(), imageUnavailable: { code: 'CAPTURE_SENSITIVE_INPUT', message: 'Input visible.' } });
  await runCiAgentNavigation(f.options);
  assert.equal(f.captures.length, 1);
});

test('recoverable observations reach the CLI while terminal controller failures stop the session', async t => {
  const f = await fixture(t, async call => {
    assert.equal((await call('observe')).error.code, 'TEMPORARY_OBSERVATION_FAILED');
    await accept(call);
    await finish(call);
  });
  const observe = f.options.observe;
  let first = true;
  f.options.observe = async signal => {
    if (first) { first = false; throw new CiError({ code: 'TEMPORARY_OBSERVATION_FAILED', stage: 'capture', message: 'Try observing again.', nextAction: 'Observe.', retryable: true }); }
    return observe(signal);
  };
  await runCiAgentNavigation(f.options);
  for (const code of ['CONTROLLER_READ_BUSY', 'RUNNER_WEDGED', 'CONTROLLER_RECOVERY_UNVERIFIED', 'CONTROLLER_IDENTITY_MISMATCH']) {
    const terminal = await fixture(t, call => call('observe'));
    terminal.options.observe = async () => { throw new CiError({ code, stage: 'capture', message: 'Runner did not recover.', nextAction: 'Retry CI.' }); };
    await assert.rejects(runCiAgentNavigation(terminal.options), { code });
    assert.equal(terminal.requests[0].signal.aborted, true);
    assert.equal(terminal.trace.at(-1).result.error.code, code);
  }
});

test('secure field values absent from configured secrets never reach the CLI or trace', async t => {
  const privateValue = 'device-owned-password';
  const f = await fixture(t, async call => {
    const view = await call('observe');
    assert.equal(view.observation.nodes.find(node => node.identifier === 'secure-input').value, undefined);
    await accept(call, 'account', view);
    await finish(call);
  });
  f.snapshot = () => snapshot('account', { extra: [{ type: 'XCUIElementTypeSecureTextField', identifier: 'secure-input', label: 'Password', value: privateValue }] });
  await runCiAgentNavigation(f.options);
  assert.equal(JSON.stringify(f.replies).includes(privateValue), false);
  assert.equal(JSON.stringify(f.trace).includes(privateValue), false);
  assert.equal(f.snapshot().nodes.at(-1).value, privateValue);
});

test('CLI exit, provider failure, and operation exhaustion cannot claim completed navigation', async t => {
  const f = await fixture(t, call => call('observe'));
  await assert.rejects(runCiAgentNavigation(f.options), { code: 'AGENT_TARGETS_INCOMPLETE' });
  f.options.agent.provider.run = async () => { throw new CiError({ code: 'AGENT_QUOTA_EXHAUSTED', stage: 'agent', message: 'No quota.', nextAction: 'Restore credit.' }); };
  await assert.rejects(runCiAgentNavigation(f.options), { code: 'AGENT_QUOTA_EXHAUSTED' });
  const budget = await fixture(t, async call => { await call('observe'); await call('observe'); }, { maxTurns: 1 });
  await assert.rejects(runCiAgentNavigation(budget.options), { code: 'CAPTURE_BUDGET_EXHAUSTED' });
});

test('zero targets do not start an agent session', async t => {
  const f = await fixture(t, async () => { assert.fail('No session expected.'); }, { routes: [], inventory: [] });
  await runCiAgentNavigation(f.options);
  assert.equal(f.requests.length, 0);
});

test('selector corrections and state-landmark errors remain redacted and recoverable', async t => {
  const f = await fixture(t, async (call, f) => {
    const frame = await call('observe');
    const badSelector = await call('act', { action: 'fill', identifier: 'Enter name', text: 'Milo' });
    assert.equal(badSelector.error.code, 'AGENT_SELECTOR_FIELD_MISMATCH');
    assert.deepEqual(badSelector.error.details.suggestedSelectors, [{ label: 'Enter name' }]);
    const badLandmark = await call('capture', { frameId: frame.frameId, targetId: 'account', description: 'Account.', requiredLabels: [f.secret] });
    assert.equal(badLandmark.error.code, 'AGENT_CAPTURE_STATE_MISMATCH');
    assert.deepEqual(badLandmark.error.details.missingRequiredLabels, ['[REDACTED]']);
    await accept(call, 'account', frame);
    await finish(call);
  });
  f.snapshot = () => snapshot('account', { extra: [{ type: 'TextField', label: 'Enter name', value: f.secret }] });
  await runCiAgentNavigation(f.options);
  assert.equal(JSON.stringify(f.replies).includes(f.secret), false);
  assert.equal(JSON.stringify(f.trace).includes(f.secret), false);
});

test('source tools return bounded pages and preserve the source allowlist', async t => {
  const f = await fixture(t, async call => {
    const page = await call('read_source', { path: 'app/account.tsx', offset: 12000 });
    assert.equal(page.text.length, 12000);
    assert.equal(page.nextOffset, 24000);
    assert.equal((await call('read_source', { path: '../private.txt' })).error.code, 'AGENT_SOURCE_NOT_ALLOWED');
    await accept(call);
    await finish(call);
  });
  await writeFile(join(f.options.project, 'app/account.tsx'), 'x'.repeat(24500));
  await runCiAgentNavigation(f.options);
});

test('coordinate taps require a current image and finite normalized coordinates', async t => {
  const f = await fixture(t, async call => {
    const frame = await call('observe');
    assert.equal((await call('act', { action: 'tap', frameId: 'stale', x: 0.2, y: 0.3 })).error.code, 'AGENT_FRAME_STALE');
    assert.equal((await call('act', { action: 'tap', frameId: frame.frameId, x: 1, y: 0.3 })).error.code, 'AGENT_ACTION_INVALID');
    await call('act', { action: 'tap', frameId: frame.frameId, x: 0.2, y: 0.3 });
    await accept(call);
    await finish(call);
  });
  await runCiAgentNavigation(f.options);
  assert.deepEqual(f.performed, [{ action: 'tap', frameId: 'frame-1', x: 0.2, y: 0.3 }]);
});

test('parallel CLI tools are serialized and cannot race an observation with a mutation', async t => {
  const order = [];
  const f = await fixture(t, async call => {
    await Promise.all([call('observe'), call('act', { action: 'tap', identifier: 'sign-in' })]);
    await accept(call);
    await finish(call);
  });
  const observe = f.options.observe;
  f.options.observe = async signal => { order.push('observe-start'); await new Promise(resolve => setTimeout(resolve, 5)); order.push('observe-end'); return observe(signal); };
  f.options.act = async () => { order.push('act'); };
  await runCiAgentNavigation(f.options);
  assert.deepEqual(order.slice(0, 3), ['observe-start', 'observe-end', 'act']);
});

test('focused type uses fresh action-returned accessibility, appends once, and redacts secret text', async t => {
  let keyboard = false;
  const f = await fixture(t, async call => {
    await call('observe');
    assert.equal((await call('act', { action: 'type', text: 'value' })).error.code, 'AGENT_TYPE_FOCUS_REQUIRED');
    const focused = await call('act', { action: 'tap', identifier: 'password' });
    assert.equal(focused.focusedTypingAvailable, true);
    assert.equal(focused.frameId, undefined);
    const typed = await call('act', { action: 'type', text: '{{secret:TEST_PASSWORD}}' });
    assert.equal(typed.performed, 'type');
    assert.equal(typed.inputVerified, false);
    assert.match(typed.nextAction, /does not establish/);
    await call('observe');
    assert.equal((await call('act', { action: 'type', text: 'duplicate' })).error.code, 'AGENT_TYPE_FOCUS_REQUIRED');
    keyboard = false;
    await accept(call); await finish(call);
  });
  const originalSnapshot = f.snapshot;
  f.snapshot = () => {
    const value = originalSnapshot();
    if (keyboard) value.nodes.push({ type: 'Keyboard', visible: true, rect: { x: 0, y: 400, width: 300, height: 200 } });
    return value;
  };
  f.options.act = async action => { f.performed.push(action); if (action.action === 'tap') keyboard = true; };
  await runCiAgentNavigation(f.options);
  assert.deepEqual(f.performed.filter(action => action.action === 'type'), [{ action: 'type', text: f.secret }]);
  assert.equal(JSON.stringify(f.trace).includes(f.secret), false);
  assert.equal(JSON.stringify(f.replies).includes(f.secret), false);
  assert.match(f.requests[0].instructions, /Type is an explicit append recovery option/);
});

test('changed focus prerequisites and intervening mutations prevent focused typing', async t => {
  for (const reason of ['route', 'parameters', 'missing-keyboard', 'duplicate', 'disabled', 'other-action', 'button-tap']) {
    let keyboard = true, changed = false;
    const f = await fixture(t, async call => {
      await call('observe');
      await call('act', { action: 'tap', identifier: reason === 'button-tap' ? 'sign-in' : 'password' });
      changed = true;
      await call('observe');
      if (reason === 'other-action') {
        await call('act', { action: 'wait', milliseconds: 1 });
        await call('observe');
      }
      assert.equal((await call('act', { action: 'type', text: 'must not type' })).error.code, 'AGENT_TYPE_FOCUS_REQUIRED', reason);
      changed = false; keyboard = false;
      await accept(call); await finish(call);
    });
    f.snapshot = () => snapshot(changed && reason === 'route' ? 'login' : 'account', {
      parameters: changed && reason === 'parameters' ? { account: 'other' } : {},
      extra: [
        { type: 'TextField', identifier: 'password', enabled: !(changed && reason === 'disabled') },
        ...(changed && reason === 'duplicate' ? [{ type: 'TextField', identifier: 'password', enabled: true }] : []),
        { type: 'Button', identifier: 'sign-in', enabled: true },
        ...(keyboard && !(changed && reason === 'missing-keyboard') ? [{ type: 'Keyboard', rect: { x: 0, y: 400, width: 300, height: 200 } }] : []),
      ],
    });
    await runCiAgentNavigation(f.options);
    assert.equal(f.performed.some(action => action.action === 'type'), false, reason);
  }
});

test('uncertain native type failure consumes its focus intent without replaying appended text', async t => {
  let keyboard = true;
  const f = await fixture(t, async call => {
    await call('observe'); await call('act', { action: 'tap', identifier: 'password' }); await call('observe');
    const failed = await call('act', { action: 'type', text: '{{secret:TEST_PASSWORD}}' });
    assert.equal(failed.error.code, 'XCTEST_RECORDED_FAILURE');
    await call('observe');
    assert.equal((await call('act', { action: 'type', text: '{{secret:TEST_PASSWORD}}' })).error.code, 'AGENT_TYPE_FOCUS_REQUIRED');
    keyboard = false; await accept(call); await finish(call);
  });
  const originalSnapshot = f.snapshot;
  f.snapshot = () => { const value = originalSnapshot(); if (keyboard) value.nodes.push({ type: 'Keyboard', rect: { x: 0, y: 400, width: 300, height: 200 } }); return value; };
  f.options.act = async action => {
    f.performed.push(action);
    if (action.action === 'type') throw new CiError({ code: 'XCTEST_RECORDED_FAILURE', stage: 'controller',
      message: `The action may have partially typed ${action.text}`, nextAction: 'Observe its actual outcome.' });
  };
  await runCiAgentNavigation(f.options);
  assert.equal(f.performed.filter(action => action.action === 'type').length, 1);
  assert.equal(JSON.stringify(f.trace).includes(f.secret), false);
  assert.equal(JSON.stringify(f.replies).includes(f.secret), false);
});

test('fill and type reject invalid literal or resolved input before invoking the controller', async t => {
  const f = await fixture(t, async call => {
    for (const action of ['fill', 'type']) for (const text of ['line\nbreak', 'nul\u0000value', 'x'.repeat(4097), '{{secret:INVALID}}']) {
      await call('observe');
      const result = await call('act', { action, ...(action === 'fill' ? { identifier: 'password' } : {}), text });
      assert.equal(result.error.code, 'AGENT_ACTION_INVALID');
    }
    await call('observe');
    assert.equal((await call('act', { action: 'type', identifier: 'password', text: 'value' })).error.code, 'AGENT_ACTION_INVALID');
    await accept(call); await finish(call);
  });
  f.options.agent.resolveInput = value => value === '{{secret:INVALID}}' ? 'invalid\nresolved' : value;
  await runCiAgentNavigation(f.options);
  assert.deepEqual(f.performed, []);
});

test('a CLI failure drains its active device operation before capture cleanup can begin', async t => {
  const f = await fixture(t);
  const order = [];
  let started;
  const active = new Promise(resolve => { started = resolve; });
  f.options.act = async (_action, signal) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push('device-stopped');
    signal.throwIfAborted();
  };
  f.options.agent.provider.run = async request => {
    void request.callTool('act', { action: 'open', url: 'testapp://account' }, request.signal).catch(() => {});
    await active;
    throw new Error('CLI terminated');
  };
  await assert.rejects(runCiAgentNavigation(f.options), /CLI terminated/);
  order.push('capture-cleanup');
  assert.deepEqual(order, ['device-stopped', 'capture-cleanup']);
});

test('unresolved dynamic target records observer parameters and rejects a different second-side context', () => {
  const [target] = discoverRoutes({ 'app/items/[id].tsx': 'export default function Item() { return null; }' },
    { parameters: { '/items/[id]': { tab: 'overview' } } }).routes;
  const observed = snapshot('items/[id]', { pathname: '/items/42', parameters: { id: '42', tab: 'overview' }, landmarks: ['item-detail'] });
  const resolved = resolveAgentCaptureContext({ target, inventory: [target], snapshot: observed,
    description: 'Seeded fixture item.', requiredLabels: ['item-detail'] });
  assert.equal(resolved.route.id, target.id);
  assert.equal(resolved.route.path, '/items/42?tab=overview');
  assert.deepEqual(resolved.context.parameters, { id: '42', tab: 'overview' });
  assert.deepEqual(resolveAgentCaptureContext({ target, inventory: [target], previous: resolved.context, snapshot: observed }).context, resolved.context);
  assert.throws(() => resolveAgentCaptureContext({ target, inventory: [target], previous: resolved.context,
    snapshot: snapshot('items/[id]', { pathname: '/items/43', parameters: { id: '43', tab: 'overview' }, landmarks: ['item-detail'] }) }), { code: 'AGENT_CAPTURE_PARAMETERS_MISMATCH' });
  assert.equal(target.path, '/items/[id]?tab=overview');
});

test('source-derived React Navigation contexts bind required and optional observed linking parameters', () => {
  const [target] = discoverRoutes({ 'App.tsx': `import { NavigationContainer } from '@react-navigation/native';
    import { createNativeStackNavigator } from '@react-navigation/native-stack';
    const Stack = createNativeStackNavigator(); function Product() { return null; }
    export default function App() { return <NavigationContainer linking={{ config: { screens: { Product: 'products/:id/:sort?' } } }}>
      <Stack.Navigator><Stack.Screen name="Product" component={Product}/></Stack.Navigator></NavigationContainer>; }` }).routes;
  const keys = captureObserverParameterKeys([target]);
  const observed = parameters => ({ refsGeneration: 1, truncated: false, nodes: [
    { identifier: CAPTURE_OBSERVER_IDENTIFIER, label: JSON.stringify({ provider: 'react-navigation', segments: ['Product'], parameters: observedParameters(parameters, keys) }) },
    { identifier: 'product-detail', visible: true },
  ] });
  const options = { target, inventory: [target], description: 'Seeded fixture product.', requiredLabels: ['product-detail'] };
  const first = resolveAgentCaptureContext({ ...options, snapshot: observed({ id: 42, token: 'private' }) });
  assert.deepEqual(first.context.parameters, { id: '42' });
  assert.equal(first.route.path, null);
  assert.deepEqual(resolveAgentCaptureContext({ ...options, previous: first.context, snapshot: observed({ id: '42' }) }).context, first.context);
  for (const parameters of [{ id: '99' }, { id: '42', sort: 'new' }]) {
    assert.throws(() => resolveAgentCaptureContext({ ...options, previous: first.context, snapshot: observed(parameters) }), { code: 'AGENT_CAPTURE_PARAMETERS_MISMATCH' });
  }
  for (const parameters of [{}, { id: {} }, { id: '' }, { id: ['42'] }]) {
    assert.throws(() => resolveAgentCaptureContext({ ...options, snapshot: observed(parameters) }), { code: 'AGENT_ROUTE_UNVERIFIED' });
  }
  const optional = resolveAgentCaptureContext({ ...options, snapshot: observed({ id: '42', sort: 'new' }) });
  assert.deepEqual(optional.context.parameters, { id: '42', sort: 'new' });
  assert.throws(() => resolveAgentCaptureContext({ ...options, previous: optional.context, snapshot: observed({ id: '42' }) }), { code: 'AGENT_CAPTURE_PARAMETERS_MISMATCH' });
});

test('state landmarks and keyboard visibility must be verified independently of a model capture claim', () => {
  const context = { description: 'Signed-in account.', parameters: {}, requiredLabels: ['account-screen'] };
  assert.throws(() => assertAgentCaptureContext(snapshot('login').nodes, context), { code: 'AGENT_CAPTURE_STATE_MISMATCH' });
  assert.throws(() => assertAgentCaptureContext(snapshot('account', { extra: [{ type: 'Keyboard', visible: true }] }).nodes, context), { code: 'AGENT_CAPTURE_KEYBOARD_VISIBLE' });
  assert.throws(() => assertAgentCaptureContext(snapshot('account', { extra: [{ type: 'Key', label: 'q', visible: true }] }).nodes, context), { code: 'AGENT_CAPTURE_KEYBOARD_VISIBLE' });
  assert.doesNotThrow(() => assertAgentCaptureContext(snapshot('account').nodes, context));
});

test('capture diagnostics distinguish input values from landmarks without accepting or changing the context', () => {
  const nodes = snapshot('account', { extra: [
    { type: 'TextField', label: 'Enter name', identifier: 'name-input', value: 'Milo', visible: true },
    { type: 'Button', label: 'Continue', visible: true },
    { type: 'TextField', label: 'Hidden input', value: 'Unavailable', visible: false },
  ] }).nodes;
  const context = { description: 'Completed form.', parameters: {}, requiredLabels: ['Milo', 'Continue', 'Unavailable'] };
  const original = structuredClone(context);
  assert.throws(() => assertAgentCaptureContext(nodes, context), error => {
    assert.equal(error.code, 'AGENT_CAPTURE_STATE_MISMATCH');
    assert.deepEqual(error.details.missingRequiredLabels, ['Milo', 'Unavailable']);
    assert.deepEqual(error.details.valueMatches, [{ requested: 'Milo', matchedField: 'value', label: 'Enter name', identifier: 'name-input' }]);
    assert.match(error.message, /not node.value/);
    assert.equal(error.message.includes('Milo'), false);
    assert.match(error.nextAction, /details.missingRequiredLabels and details.valueMatches/);
    assert.equal(error.nextAction.includes('Enter name'), false);
    assert.match(error.nextAction, /without changing the context/);
    return true;
  });
  assert.deepEqual(context, original);
  assert.doesNotThrow(() => assertAgentCaptureContext(nodes, { ...context, requiredLabels: ['Enter name', 'Continue'] }));
});

test('repository source context cannot follow a symlink outside the checkout', async t => {
  const f = await fixture(t, []);
  const outside = await mkdtemp(join(tmpdir(), 'explore-agent-private-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.tsx'), 'private external contents');
  await symlink(join(outside, 'private.tsx'), join(f.options.project, 'app/private.tsx'));
  await assert.rejects(readAgentSource(f.options.project, new Set(['app/private.tsx']), 'app/private.tsx'),
    { code: 'AGENT_SOURCE_NOT_ALLOWED' });
});

test('capture landmarks preserve real multiline labels and still reject mismatches, NUL, and oversized values', () => {
  const label = 'Welcome to\nyour account.';
  const target = route('account');
  const current = snapshot('account', { landmarks: [label] });
  const resolved = resolveAgentCaptureContext({ target, inventory: [target], snapshot: current,
    description: 'Welcome.', requiredLabels: [label] });
  assert.deepEqual(resolved.context.requiredLabels, [label]);
  assert.throws(() => assertAgentCaptureContext(snapshot('account', { landmarks: ['Welcome to your account.'] }).nodes, resolved.context),
    { code: 'AGENT_CAPTURE_STATE_MISMATCH' });
  for (const invalid of ['bad\0label', 'x'.repeat(257), '\n']) {
    assert.throws(() => resolveAgentCaptureContext({ target, inventory: [target], snapshot: current,
      description: 'Welcome.', requiredLabels: [invalid] }), { code: 'AGENT_ACTION_INVALID' });
  }
});

test('revision-specific labels cannot bind shared contexts; stable state still captures on both revisions', async t => {
  const head = await fixture(t, async call => {
    const view = await call('observe');
    const rejected = await call('capture', { frameId: view.frameId, targetId: 'account', description: 'Shared state.', requiredLabels: ['account-screen', 'Account'] });
    assert.equal(rejected.error.code, 'AGENT_CAPTURE_REVISION_LANDMARK');
    await accept(call, 'account', view);
    await finish(call);
  });
  const original = head.snapshot;
  head.snapshot = () => ({ ...original(), nodes: [...original().nodes, { type: 'StaticText', label: 'Account' }] });
  head.options.agent.captureConstraints = { account: { revisionLabels: ['Account'], sourceChange: 'Added Account row.' } };
  await runCiAgentNavigation(head.options);
  const base = await fixture(t, async call => { await accept(call); await finish(call); });
  base.options.agent.contexts = structuredClone(head.options.agent.contexts);
  base.options.agent.captureConstraints = head.options.agent.captureConstraints;
  await runCiAgentNavigation(base.options);
  assert.deepEqual(base.captures[0].context, head.captures[0].context);
});

test('blocked termination records a failed outcome and prevents further UI work', async t => {
  const f = await fixture(t, async call => { await call('observe'); await call('stop_blocked', { reason: 'The required image remains blank after recovery.' }); });
  await assert.rejects(runCiAgentNavigation(f.options), { code: 'AGENT_EXPLORATION_BLOCKED' });
  assert.equal(f.captures.length, 0);
  assert.equal(f.trace.at(-1).result.error.code, 'AGENT_EXPLORATION_BLOCKED');
  assert.deepEqual(f.trace.at(-1).result.error.details.remainingTargetIds, ['account']);
});

test('completion accepts multiline prose but rejects empty, NUL, and oversized summaries', async t => {
  const summary = 'Completed captures.\n\nVerified sign-out and sign-in.\r\nSession restored.';
  const f = await fixture(t, async call => {
    await accept(call);
    for (const procedureSummary of ['\n', 'bad\0summary', 'x'.repeat(4001)]) {
      const result = await call('finish', { procedureSummary });
      assert.equal(result.error.code, 'AGENT_ACTION_INVALID');
    }
    const result = await call('finish', { procedureSummary: summary });
    assert.equal(result.completed, true);
    assert.equal(result.procedureSummary, summary);
  });
  await runCiAgentNavigation(f.options);
});

test('merged control labels, not child text fragments, bind shared contexts', async t => {
  const merged = { type: 'Button', label: 'Check Mood, 3', visible: true };
  const child = { type: 'StaticText', label: 'Check Mood', visible: true };
  const head = await fixture(t, async call => {
    const view = await call('observe');
    const rejected = await call('capture', { frameId: view.frameId, targetId: 'account', description: 'Edit photo.', requiredLabels: ['Check Mood', 'account-screen'] });
    assert.equal(rejected.error.code, 'AGENT_CAPTURE_FRAGMENT_LANDMARK');
    assert.deepEqual(rejected.error.details.fragments, [{ requested: 'Check Mood', mergedLabels: ['Check Mood, 3'] }]);
    const accepted = await call('capture', { frameId: view.frameId, targetId: 'account', description: 'Edit photo.', requiredLabels: ['Check Mood, 3', 'account-screen'] });
    assert.equal(accepted.error, undefined, JSON.stringify(accepted));
    await finish(call);
  });
  const headSnapshot = head.snapshot;
  head.snapshot = () => ({ ...headSnapshot(), nodes: [...headSnapshot().nodes, merged, child] });
  await runCiAgentNavigation(head.options);
  // Base exposes only the merged control label; the head context still binds it.
  const base = await fixture(t, async call => {
    const view = await call('observe');
    const accepted = await call('capture', { frameId: view.frameId, targetId: 'account' });
    assert.equal(accepted.error, undefined, JSON.stringify(accepted));
    await finish(call);
  });
  const baseSnapshot = base.snapshot;
  base.snapshot = () => ({ ...baseSnapshot(), nodes: [...baseSnapshot().nodes, merged] });
  base.options.agent.contexts = structuredClone(head.options.agent.contexts);
  await runCiAgentNavigation(base.options);
  assert.deepEqual(base.captures[0].context, head.captures[0].context);
});

test('fragment landmarks never fire for identifiers, interactive labels, or unmerged text', () => {
  const nodes = [{ type: 'Button', label: 'Check Mood, 3', visible: true }, { type: 'StaticText', label: 'Check Mood', visible: true },
    { type: 'StaticText', label: 'Settings', identifier: 'Settings', visible: true }, { type: 'Cell', label: 'Settings, 2', visible: true },
    { type: 'Button', label: 'Save', visible: true }, { type: 'StaticText', label: 'Save', visible: true }, { type: 'Cell', label: 'Save, draft', visible: true },
    { type: 'StaticText', label: 'Profile', visible: true }];
  assert.deepEqual(fragmentLandmarks(nodes, ['Check Mood', 'Settings', 'Save', 'Profile', 'Check Mood, 3']), [{ requested: 'Check Mood', mergedLabels: ['Check Mood, 3'] }]);
  // Base matching stays exact: a merged label never satisfies one of its parts.
  assert.throws(() => assertAgentCaptureContext([{ type: 'Button', label: 'Check Mood, 3', visible: true }],
    { description: 'Edit photo', parameters: {}, requiredLabels: ['Check Mood'] }), error => error.code === 'AGENT_CAPTURE_STATE_MISMATCH');
});

test('a capture context binds the scene presentation observed on head', () => {
  const target = route('cats');
  const marker = y => ({ identifier: CAPTURE_OBSERVER_IDENTIFIER, type: 'StaticText', label: JSON.stringify({ provider: 'expo-router', pathname: target.path,
    segments: target.path.split('/').filter(Boolean), parameters: {} }), rect: { x: 0, y, width: 1, height: 1 }, visible: true });
  const nodes = y => [marker(y), { type: 'StaticText', label: 'account-screen', visible: true }];
  const head = resolveAgentCaptureContext({ target, inventory: [target], snapshot: { nodes: nodes(0.4) }, description: 'Cats', requiredLabels: ['account-screen'] });
  assert.deepEqual(head.context.presentation, { sceneOrigin: { x: 0, y: 0 } });
  // The same full-screen scene on base, within the rounding tolerance, is accepted.
  resolveAgentCaptureContext({ target, inventory: [target], snapshot: { nodes: nodes(1.6) }, previous: head.context });
  // A leftover sheet holds the same route 72 points below the top of the window.
  assert.throws(() => resolveAgentCaptureContext({ target, inventory: [target], snapshot: { nodes: nodes(72) }, previous: head.context }),
    error => error.code === 'AGENT_CAPTURE_PRESENTATION_MISMATCH' && error.retryable === true
      && error.details.expectedSceneOrigin.y === 0 && error.details.observedSceneOrigin.y === 72);
  // A marker without geometry cannot prove the presentation of an established context.
  assert.throws(() => assertAgentCaptureContext([{ ...marker(0), rect: undefined }, { type: 'StaticText', label: 'account-screen', visible: true }], head.context),
    error => error.code === 'AGENT_CAPTURE_PRESENTATION_MISMATCH');
});

test('head captures a target in its least-nested presentation, not inside another presented sheet', async t => {
  let y = 62;
  const f = await fixture(t, async call => {
    await call('observe', { includeImage: false });
    y = 72; // The same target reached again inside another sheet.
    const nested = await call('observe');
    const rejected = await call('capture', { frameId: nested.frameId, targetId: 'account', description: 'Account.', requiredLabels: ['account-screen'] });
    assert.equal(rejected.error.code, 'AGENT_CAPTURE_PRESENTATION_NESTED');
    assert.equal(rejected.error.retryable, true);
    assert.deepEqual(rejected.error.details.leastNestedSceneOrigin, { x: 0, y: 62 });
    y = 62;
    const direct = await call('observe');
    const accepted = await call('capture', { frameId: direct.frameId, targetId: 'account', description: 'Account.', requiredLabels: ['account-screen'] });
    assert.equal(accepted.error, undefined, JSON.stringify(accepted));
    await finish(call);
  });
  const original = f.snapshot;
  f.snapshot = () => {
    const value = original();
    return { ...value, nodes: value.nodes.map(node => node.identifier === CAPTURE_OBSERVER_IDENTIFIER ? { ...node, rect: { x: 0, y, width: 1, height: 1 } } : node) };
  };
  await runCiAgentNavigation(f.options);
  assert.deepEqual(f.captures[0].context.presentation, { sceneOrigin: { x: 0, y: 62 } });
});
