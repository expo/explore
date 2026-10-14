import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { credentialSavePromptDecline, executeCaptureSetup, isUnreadableSystemSurface } from '../../dist/capture/setup-actions.js';
import { CiError } from '../../dist/shared/ci-errors.js';
import { CAPTURE_OBSERVER_IDENTIFIER } from '../../dist/capture/observer.js';

const node = (ref, type, label, rest = {}) => ({ ref, type, label, enabled: true, hittable: false, ...rest });
const snapshot = (generation, nodes) => ({ refsGeneration: generation, truncated: false, nodes });
const inputSnapshot = (generation, { keyboard = true, pathname = '/account', parameters = {}, input = {}, extra = [] } = {}) => snapshot(generation, [
  { identifier: CAPTURE_OBSERVER_IDENTIFIER, label: JSON.stringify({ provider: 'expo-router', pathname, segments: pathname.split('/').filter(Boolean), parameters }) },
  node('e7', 'SecureTextField', 'Password', { identifier: 'password', rect: { x: 10, y: 100, width: 200, height: 40 }, ...input }),
  ...(keyboard ? [node('e8', 'Keyboard', 'Keyboard', { rect: { x: 0, y: 600, width: 400, height: 250 } })] : []), ...extra,
]);

function runtime(snapshots, overrides = {}) {
  const events = [];
  let index = 0;
  return { events, options: {
    command: args => { events.push(['command', args]); },
    open: url => { events.push(['open', url]); },
    snapshot: () => { events.push(['snapshot']); return snapshots[Math.min(index++, snapshots.length - 1)]; },
    afterAction: event => { events.push(['afterAction', event.index, event.snapshot.refsGeneration]); },
    readinessAttempts: 3,
    pollMilliseconds: 100,
    ...overrides,
  } };
}

test('caller-owned post-action observation preserves fresh selector resolution without a duplicate trailing read', async () => {
  const { events, options } = runtime([snapshot(20, [node('e13', 'Button', 'Continue')])], {
    afterAction: undefined, postActionObservation: 'caller',
  });
  await executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options);
  assert.deepEqual(events, [['snapshot'], ['command', ['press', '@e13~s20', '--level', 'full', '--json']]]);
});

test('caller-owned observation cannot skip explicit readiness or after-action evidence', async () => {
  const { events, options } = runtime([snapshot(20, []), snapshot(21, [node('e13', 'Button', 'Continue')])], {
    afterAction: undefined, postActionObservation: 'caller',
  });
  await executeCaptureSetup([{ action: 'open', url: 'sample://next', ready: { label: 'Continue' } }], options);
  assert.equal(events.filter(event => event[0] === 'snapshot').length, 2);
  const withCallback = runtime([snapshot(22, [])], { postActionObservation: 'caller' });
  await executeCaptureSetup([{ action: 'wait', milliseconds: 1 }], withCallback.options);
  assert.deepEqual(withCallback.events.slice(-2), [['snapshot'], ['afterAction', 0, 22]]);
  const unmet = runtime([snapshot(23, [])], { afterAction: undefined, postActionObservation: 'caller' });
  await assert.rejects(executeCaptureSetup([{ action: 'open', url: 'sample://next', ready: { label: 'Missing' } }], unmet.options),
    { code: 'SETUP_READINESS_TIMEOUT' });
});

test('fills the real input instead of its same-label wrapper and uses the fresh snapshot generation', async () => {
  const first = snapshot(20, [node('e12', 'Other', 'Enter cat name'), node('e13', 'TextField', 'Enter cat name')]);
  const second = snapshot(21, [node('e13', 'TextField', 'Enter cat name'), node('e18', 'Button', 'Continue')]);
  const third = snapshot(22, [node('e11', 'Button', 'Male')]);
  const { events, options } = runtime([first, second, second, third]);
  await executeCaptureSetup([
    { action: 'fill', label: 'Enter cat name', text: 'Milo' },
    { action: 'tap', label: 'Continue' },
  ], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
    ['fill', '@e13~s20', 'Milo', '--level', 'full', '--json'],
    ['press', '@e18~s21', '--level', 'full', '--json'],
  ]);
});

test('explicit input tap permits one native type from fresh observed focus without claiming verified contents', async () => {
  const f = runtime([inputSnapshot(1, { keyboard: false }), inputSnapshot(2, { keyboard: false }), inputSnapshot(3), inputSnapshot(4)]);
  await executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text: 'fixture-input' }], f.options);
  assert.deepEqual(f.events.filter(event => event[0] === 'command').map(event => event[1]), [
    ['press', '@e7~s1', '--level', 'full', '--json'], ['type', 'fixture-input', '--level', 'full', '--json'],
  ]);
  assert.deepEqual(f.events.filter(event => event[0] === 'afterAction').map(event => event.slice(1)), [[0, 2], [1, 4]]);
  const repeated = runtime([inputSnapshot(1)]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', identifier: 'password' },
    { action: 'type', text: 'first' }, { action: 'type', text: 'second' }], repeated.options), { code: 'SETUP_TYPE_FOCUS_REQUIRED' });
  assert.equal(repeated.events.filter(event => event[0] === 'command' && event[1][0] === 'type').length, 1);
});

test('typing fails closed on changed focus evidence and any intervening setup action', async () => {
  for (const changed of [
    { pathname: '/other' }, { parameters: { account: 'other' } }, { keyboard: false },
    { input: { enabled: false } }, { input: { type: 'TextField' } },
    { extra: [node('e9', 'SecureTextField', 'Password', { identifier: 'password' })] },
    { extra: [node('e10', 'Alert', 'Unexpected alert')] },
  ]) {
    const f = runtime([inputSnapshot(1), inputSnapshot(2), inputSnapshot(3, changed)]);
    await assert.rejects(executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text: 'private-input' }], f.options),
      error => error.code === 'SETUP_TYPE_FOCUS_REQUIRED' && !JSON.stringify(error).includes('private-input'));
    assert.equal(f.events.some(event => event[0] === 'command' && event[1][0] === 'type'), false);
  }
  for (const intervening of [{ action: 'wait', milliseconds: 1 }, { action: 'scroll', direction: 'bottom' },
    { action: 'fill', identifier: 'password', text: 'existing' }, { action: 'open', url: 'sample://account' }]) {
    const f = runtime([inputSnapshot(1)]);
    await assert.rejects(executeCaptureSetup([{ action: 'tap', identifier: 'password' }, intervening, { action: 'type', text: 'value' }], f.options),
      { code: 'SETUP_TYPE_FOCUS_REQUIRED' });
    assert.equal(f.events.some(event => event[0] === 'command' && event[1][0] === 'type'), false);
  }
});

test('deterministic typing waits for keyboard readiness and stops on changed input evidence', async () => {
  for (const changed of [false, true]) {
    const f = runtime([inputSnapshot(1, { keyboard: false }), inputSnapshot(2, { keyboard: false }),
      inputSnapshot(3, { keyboard: false }), inputSnapshot(4, changed ? { pathname: '/other' } : {}), inputSnapshot(5)]);
    const run = executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text: 'fixture-input' }], f.options);
    if (changed) await assert.rejects(run, { code: 'SETUP_TYPE_FOCUS_REQUIRED' });
    else await run;
    assert.equal(f.events.filter(event => event[0] === 'command' && event[1][0] === 'wait').length, 1);
    assert.equal(f.events.filter(event => event[0] === 'command' && event[1][0] === 'type').length, changed ? 0 : 1);
  }
});

test('native typing failure is never replayed and invalid text is rejected before dispatch', async () => {
  let types = 0;
  const f = runtime([inputSnapshot(1)], { command: args => { if (args[0] === 'type') { types++; throw new Error('uncertain native result'); } } });
  await assert.rejects(executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text: 'value' },
    { action: 'type', text: 'replay' }], f.options), /uncertain native result/);
  assert.equal(types, 1);
  await assert.rejects(executeCaptureSetup([{ action: 'type', text: 'new invocation' }], f.options), { code: 'SETUP_TYPE_FOCUS_REQUIRED' });
  for (const text of ['', 'line\nbreak', 'x'.repeat(4097)]) {
    await assert.rejects(executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text }], f.options), { code: 'SETUP_INPUT_INVALID' });
  }
  assert.equal(types, 1);
});

test('identifier selection prefers the enabled button over its wrapper without relying on hittable', async () => {
  const nodes = [node('e2', 'Other', 'Continue', { identifier: 'continue' }),
    node('e3', 'Button', 'Continue', { identifier: 'continue' })];
  const { events, options } = runtime([snapshot(15, nodes)]);
  await executeCaptureSetup([{ action: 'tap', identifier: 'continue' }], options);
  assert.deepEqual(events.find(event => event[0] === 'command')[1], ['press', '@e3~s15', '--level', 'full', '--json']);
});

test('explicit input taps select the unique field over its same-selector label and wrapper', async () => {
  for (const type of ['TextField', 'SecureTextField', 'TextView', 'SearchField']) {
    for (const selector of [{ label: 'Account input' }, { identifier: 'account-input' }]) {
      const nodes = [
        node('e2', 'Other', 'Account input', { identifier: 'account-input', rect: { x: 0, y: 0, width: 402, height: 874 } }),
        node('e3', 'StaticText', 'Account input', { identifier: 'account-input', rect: { x: 24, y: 80, width: 100, height: 20 } }),
        node('e4', type, 'Account input', { identifier: 'account-input', rect: { x: 24, y: 110, width: 354, height: 50 } }),
      ];
      const { events, options } = runtime([snapshot(15, nodes)]);
      await executeCaptureSetup([{ action: 'tap', ...selector }], options);
      assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
        ['press', '@e4~s15', '--level', 'full', '--json'],
      ]);
    }
  }
});

test('ambiguous input taps fail without choosing a field or its label', async () => {
  const nodes = [node('e2', 'StaticText', 'Account input'), node('e3', 'TextField', 'Account input'),
    node('e4', 'SecureTextField', 'Account input')];
  const { events, options } = runtime([snapshot(15, nodes)]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Account input' }], options),
    { code: 'SETUP_SELECTOR_AMBIGUOUS' });
  assert.equal(events.some(event => event[0] === 'command'), false);
});

test('a disabled input tap never falls back to its label or wrapper', async () => {
  const nodes = [node('e2', 'Other', 'Account input'), node('e3', 'StaticText', 'Account input'),
    node('e4', 'TextField', 'Account input', { enabled: false })];
  const { events, options } = runtime([snapshot(15, nodes)]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Account input' }], options),
    { code: 'SETUP_CONTROL_NOT_READY' });
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1][0]), ['wait', 'wait']);
});

test('a unique Other control supports the app microphone button', async () => {
  const { events, options } = runtime([snapshot(15, [node('e19', 'Other', 'Start recording')])]);
  await executeCaptureSetup([{ action: 'tap', label: 'Start recording' }], options);
  assert.equal(events.find(event => event[0] === 'command')[1][1], '@e19~s15');
});

test('Android View classes resolve like iOS element types: a ViewGroup row is pressed and an EditText is filled', async () => {
  const row = { identifier: 'lane-row-title-0', rect: { x: 30, y: 217, width: 510, height: 105 }, hittable: true };
  const pressed = runtime([snapshot(3, [
    node('e40', 'android.view.ViewGroup', undefined, row),
    node('e41', 'android.widget.TextView', 'Kick', { rect: { x: 56, y: 240, width: 60, height: 40 } }),
  ])]);
  await executeCaptureSetup([{ action: 'tap', identifier: 'lane-row-title-0' }], pressed.options);
  assert.deepEqual(pressed.events.find(event => event[0] === 'command')[1].slice(0, 2), ['press', '@e40~s3']);
  const filled = runtime([snapshot(4, [
    node('e1', 'android.view.ViewGroup', 'Name', { rect: { x: 0, y: 90, width: 400, height: 60 } }),
    node('e2', 'android.widget.TextView', 'Name', { rect: { x: 10, y: 100, width: 80, height: 40 } }),
    node('e3', 'android.widget.EditText', 'Name', { rect: { x: 100, y: 100, width: 200, height: 40 } }),
  ])]);
  await executeCaptureSetup([{ action: 'fill', label: 'Name', text: 'Lead' }], filled.options);
  assert.deepEqual(filled.events.find(event => event[0] === 'command')[1].slice(0, 3), ['fill', '@e3~s4', 'Lead']);
});

test('disabled controls are polled but never pressed until enabled', async () => {
  const { events, options } = runtime([
    snapshot(10, [node('e3', 'Button', 'Continue', { enabled: false })]),
    snapshot(11, [node('e6', 'Button', 'Continue')]),
    snapshot(12, []),
  ]);
  await executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1].slice(0, 2)), [
    ['wait', '100'], ['press', '@e6~s11'],
  ]);
});

test('ambiguous labels fail without tapping a guessed control', async () => {
  const { events, options } = runtime([snapshot(10, [node('e3', 'Button', 'Continue'), node('e4', 'Button', 'Continue')])]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options), { code: 'SETUP_SELECTOR_AMBIGUOUS' });
  assert.equal(events.some(event => event[0] === 'command'), false);
});

test('a nested text exposed twice with one frame is one control, but separate frames stay ambiguous', async () => {
  // Observed on agent-device 0.21.15: a form title appeared as two StaticText nodes (e4, e5) with one frame.
  const title = (ref, y = 94) => node(ref, 'StaticText', "What is your cat's name?", { rect: { x: 24, y, width: 354, height: 76 } });
  const { events, options } = runtime([snapshot(12, [title('e4'), title('e5')])]);
  await executeCaptureSetup([{ action: 'tap', label: "What is your cat's name?" }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [['press', '@e5~s12', '--level', 'full', '--json']]);
  const separate = runtime([snapshot(13, [title('e4'), title('e5', 300)])]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: "What is your cat's name?" }], separate.options), { code: 'SETUP_SELECTOR_AMBIGUOUS' });
  assert.equal(separate.events.some(event => event[0] === 'command'), false);
});

test('only a visible iOS password save or update prompt yields its unique Not Now button', () => {
  const notNow = node('e6', 'Button', 'Not Now');
  for (const title of ['Save Password?', 'Update Password?']) assert.equal(credentialSavePromptDecline([node('e3', 'StaticText', title), notNow, node('e7', 'Button', 'Save')]), notNow);
  assert.equal(credentialSavePromptDecline([node('e3', 'StaticText', 'Turn on notifications?'), notNow]), undefined);
  assert.equal(credentialSavePromptDecline([node('e3', 'StaticText', 'Save Password?', { visible: false }), notNow]), undefined);
  assert.equal(credentialSavePromptDecline([node('e3', 'StaticText', 'Save Password?'), notNow, node('e8', 'Button', 'Not Now')]), undefined);
  assert.equal(credentialSavePromptDecline([node('e3', 'StaticText', 'Save Password?'), node('e6', 'Button', 'Not Now', { enabled: false })]), undefined);
});

test('missing controls exhaust bounded waits, never execute subsequent actions, and do not expose fill text', async () => {
  const { events, options } = runtime([snapshot(10, [])]);
  await assert.rejects(executeCaptureSetup([
    { action: 'fill', identifier: 'email', text: 'private-input@example.com' },
    { action: 'open', url: 'sample://unexpected' },
  ], options), error => {
    assert.equal(error.code, 'SETUP_CONTROL_NOT_READY');
    assert.equal(JSON.stringify(error).includes('private-input'), false);
    return true;
  });
  assert.equal(events.filter(event => event[0] === 'snapshot').length, 3);
  assert.equal(events.filter(event => event[0] === 'command').length, 2);
  assert.equal(events.some(event => event[0] === 'open'), false);
});

test('post-action observation runs once after readiness succeeds and never relaunches', async () => {
  const { events, options } = runtime([snapshot(10, []), snapshot(11, [node('e3', 'Button', 'Continue')])]);
  await executeCaptureSetup([{ action: 'open', url: 'sample://scan/camera', ready: { label: 'Continue', enabled: true } }], options);
  assert.deepEqual(events, [
    ['open', 'sample://scan/camera'], ['snapshot'],
    ['command', ['wait', '100', '--level', 'full', '--json']], ['snapshot'],
    ['afterAction', 0, 11],
  ]);
  assert.equal(JSON.stringify(events).includes('relaunch'), false);
  assert.deepEqual(events.filter(event => event[0] === 'afterAction'), [
    ['afterAction', 0, 11],
  ]);
});

test('actions without readiness expose transient destinations before the next action', async () => {
  const { events, options } = runtime([snapshot(10, []), snapshot(11, [])]);
  await executeCaptureSetup([
    { action: 'open', url: 'sample://scan/loading' },
    { action: 'open', url: 'sample://scan/result' },
  ], options);
  assert.deepEqual(events, [
    ['open', 'sample://scan/loading'], ['snapshot'], ['afterAction', 0, 10],
    ['open', 'sample://scan/result'], ['snapshot'], ['afterAction', 1, 11],
  ]);
});

test('scroll and fixed waits share command budget and support enabled readiness', async () => {
  const { events, options } = runtime([
    snapshot(10, [node('e3', 'Button', 'Continue', { enabled: false })]),
    snapshot(11, [node('e3', 'Button', 'Continue')]),
  ]);
  await executeCaptureSetup([
    { action: 'scroll', direction: 'bottom', ready: { label: 'Continue', enabled: true } },
    { action: 'wait', milliseconds: 50 },
  ], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1].slice(0, 2)), [
    ['scroll', 'bottom'], ['wait', '100'], ['wait', '50'],
  ]);
});

test('readiness failure is explicit and does not repeat the mutation', async () => {
  const { events, options } = runtime([snapshot(10, [])]);
  await assert.rejects(executeCaptureSetup([{ action: 'scroll', direction: 'bottom', ready: { label: 'Continue' } }], options),
    { code: 'SETUP_READINESS_TIMEOUT' });
  assert.equal(events.filter(event => event[0] === 'command' && event[1][0] === 'scroll').length, 1);
  assert.equal(events.some(event => event[0] === 'afterAction'), false);
});

test('caller budget errors survive unchanged and stop the sequence', async () => {
  const error = new CiError({ code: 'CAPTURE_BUDGET_EXHAUSTED', stage: 'capture', message: 'Exhausted', nextAction: 'Increase capture budget.' });
  const { events, options } = runtime([snapshot(10, [])], { command: () => { throw error; } });
  await assert.rejects(executeCaptureSetup([{ action: 'wait', milliseconds: 10 }, { action: 'open', url: 'sample://next' }], options), value => value === error);
  assert.equal(events.length, 0);
});

test('truncated snapshots and missing generations never produce unsafe unpinned presses', async () => {
  for (const [value, code] of [
    [{ ...snapshot(10, [node('e3', 'Button', 'Continue')]), truncated: true }, 'SETUP_SNAPSHOT_INVALID'],
    [{ nodes: [node('e3', 'Button', 'Continue')] }, 'SETUP_REFERENCE_UNAVAILABLE'],
  ]) {
    const { events, options } = runtime([value]);
    await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options), { code });
    assert.equal(events.some(event => event[0] === 'command'), false);
  }
});

const keyboard = ref => node(ref, 'Keyboard', 'Padding-Left', { rect: { x: 0, y: 583, width: 402, height: 233 } });
const covered = ref => node(ref, 'Button', 'Continue', { rect: { x: 80, y: 779, width: 300, height: 49 } });

test('dismisses a keyboard that covers the tap target and presses from a fresh snapshot', async () => {
  const open = snapshot(30, [keyboard('e16'), covered('e71')]);
  const closed = snapshot(31, [node('e9', 'Button', 'Continue', { rect: { x: 80, y: 779, width: 300, height: 49 } })]);
  const { events, options } = runtime([open, closed]);
  await executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
    ['keyboard', 'dismiss', '--level', 'full', '--json'],
    ['press', '@e9~s31', '--level', 'full', '--json'],
  ]);
});

test('agent-device 0.21.15 keys without a Keyboard element still cover the tap target and enable typing', async () => {
  // Shape of an agent-device 0.21.15 setup snapshot: Key rows and the input assistant only.
  const keys = [node('e20', 'Key', 'q', { rect: { x: 5, y: 590, width: 36, height: 42 } }),
    node('e21', 'Key', 'Done', { rect: { x: 300, y: 755, width: 94, height: 42 } })];
  const assistant = node('e12', 'Other', undefined, { identifier: 'SystemInputAssistantView', rect: { x: 0, y: 539, width: 402, height: 44 } });
  const open = snapshot(30, [...keys, assistant, covered('e10')]);
  const closed = snapshot(31, [node('e9', 'Button', 'Continue', { rect: { x: 80, y: 779, width: 300, height: 49 } })]);
  const { events, options } = runtime([open, closed]);
  await executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
    ['keyboard', 'dismiss', '--level', 'full', '--json'],
    ['press', '@e9~s31', '--level', 'full', '--json'],
  ]);
  const withKeys = generation => snapshot(generation, [...inputSnapshot(generation, { keyboard: false }).nodes, ...keys]);
  const f = runtime([inputSnapshot(1, { keyboard: false }), inputSnapshot(2, { keyboard: false }), withKeys(3), withKeys(4)]);
  await executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text: 'fixture-input' }], f.options);
  assert.deepEqual(f.events.filter(event => event[0] === 'command').map(event => event[1][0]), ['press', 'type']);
});

test('dismisses a keyboard covering an input tap or fill and reselects it from a fresh generation', async () => {
  const open = snapshot(30, [keyboard('e16'), node('e71', 'TextField', 'Email', {
    identifier: 'auth-email', rect: { x: 24, y: 620, width: 354, height: 50 },
  })]);
  const closed = snapshot(31, [node('e9', 'TextField', 'Email', {
    identifier: 'auth-email', rect: { x: 24, y: 510, width: 354, height: 50 },
  })]);
  for (const action of [{ action: 'tap', identifier: 'auth-email' },
    { action: 'fill', identifier: 'auth-email', text: 'reviewer@example.test' }]) {
    const { events, options } = runtime([open, closed]);
    await executeCaptureSetup([action], options);
    assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
      ['keyboard', 'dismiss', '--level', 'full', '--json'],
      action.action === 'tap' ? ['press', '@e9~s31', '--level', 'full', '--json']
        : ['fill', '@e9~s31', 'reviewer@example.test', '--level', 'full', '--json'],
    ]);
  }
});

test('dismisses the iOS prediction strip covering an input above the keyboard keys', async () => {
  // Actual iPhone 17 AX geometry: the email center is in the assistant strip,
  // while the Keyboard node begins below the entire input.
  const email = ref => node(ref, 'TextField', 'Email address', {
    identifier: 'auth-email', rect: { x: 46, y: 525.3333282470703, width: 310, height: 48 },
  });
  const assistant = node('e5', 'Other', 'Typing Predictions', {
    identifier: 'SystemInputAssistantView', rect: { x: 0, y: 539, width: 402, height: 44 },
  });
  const { events, options } = runtime([
    snapshot(30, [keyboard('e16'), assistant, email('e71')]),
    snapshot(31, [email('e9')]),
  ]);
  await executeCaptureSetup([{ action: 'fill', identifier: 'auth-email', text: 'reviewer@example.test' }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
    ['keyboard', 'dismiss', '--level', 'full', '--json'],
    ['fill', '@e9~s31', 'reviewer@example.test', '--level', 'full', '--json'],
  ]);
});

test('an input assistant is an occluder only while it and a keyboard are visible', async () => {
  const assistant = node('e5', 'Other', 'Typing Predictions', {
    identifier: 'SystemInputAssistantView', rect: { x: 0, y: 539, width: 402, height: 44 },
  });
  const input = node('e9', 'TextField', 'Email address', {
    identifier: 'auth-email', rect: { x: 46, y: 525.3333282470703, width: 310, height: 48 },
  });
  for (const nodes of [
    [assistant, input],
    [{ ...keyboard('e16'), visible: false }, assistant, input],
    [keyboard('e16'), { ...assistant, visible: false }, input],
  ]) {
    const { events, options } = runtime([snapshot(40, nodes)]);
    await executeCaptureSetup([{ action: 'fill', identifier: 'auth-email', text: 'reviewer@example.test' }], options);
    assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
      ['fill', '@e9~s40', 'reviewer@example.test', '--level', 'full', '--json'],
    ]);
  }
});

test('an uncovered input tap or fill keeps the keyboard open', async () => {
  const current = snapshot(40, [keyboard('e16'), node('e3', 'TextField', 'Email', {
    identifier: 'auth-email', rect: { x: 24, y: 300, width: 354, height: 50 },
  })]);
  for (const action of [{ action: 'tap', identifier: 'auth-email' },
    { action: 'fill', identifier: 'auth-email', text: 'reviewer@example.test' }]) {
    const { events, options } = runtime([current]);
    await executeCaptureSetup([action], options);
    assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
      action.action === 'tap' ? ['press', '@e3~s40', '--level', 'full', '--json']
        : ['fill', '@e3~s40', 'reviewer@example.test', '--level', 'full', '--json'],
    ]);
  }
});

test('an input tap or fill that remains covered fails after one dismissal without touching the field', async () => {
  const current = snapshot(50, [keyboard('e16'), node('e71', 'SecureTextField', 'Password', {
    identifier: 'auth-password', rect: { x: 24, y: 650, width: 354, height: 50 },
  })]);
  for (const action of [{ action: 'tap', identifier: 'auth-password' },
    { action: 'fill', identifier: 'auth-password', text: 'fixture-password' }]) {
    const { events, options } = runtime([current]);
    await assert.rejects(executeCaptureSetup([action], options),
      error => error instanceof CiError && error.code === 'SETUP_KEYBOARD_BLOCKING');
    assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [
      ['keyboard', 'dismiss', '--level', 'full', '--json'],
    ]);
  }
});

test('a keyboard that does not cover the target is left open', async () => {
  const { events, options } = runtime([snapshot(40, [keyboard('e16'), node('e3', 'Button', 'Continue', { rect: { x: 80, y: 300, width: 300, height: 49 } })])]);
  await executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [['press', '@e3~s40', '--level', 'full', '--json']]);
});

test('a keyboard that stays over the target fails with an explicit next action and one dismissal', async () => {
  const { events, options } = runtime([snapshot(50, [keyboard('e16'), covered('e71')])]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options),
    error => error instanceof CiError && error.code === 'SETUP_KEYBOARD_BLOCKING' && /Done\/return/.test(error.nextAction));
  assert.equal(events.filter(event => event[0] === 'command' && event[1][0] === 'keyboard').length, 1);
  assert.equal(events.filter(event => event[0] === 'command' && event[1][0] === 'press').length, 0);
});

test('an unsupported keyboard dismissal is reported as the blocking cause', async () => {
  const { options } = runtime([snapshot(60, [keyboard('e16'), covered('e71')])], {
    command: args => { if (args[0] === 'keyboard') throw new Error('UNSUPPORTED_OPERATION'); },
  });
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Continue' }], options),
    error => error instanceof CiError && error.code === 'SETUP_KEYBOARD_BLOCKING' && /could not be dismissed/.test(error.message));
});

test('a same-label full-screen wrapper is not pressed in place of the text it contains', async () => {
  const nodes = [
    node('e61', 'Other', 'How old is your cat?', { rect: { x: 0, y: 0, width: 402, height: 874 } }),
    node('e62', 'ScrollView', 'How old is your cat?', { rect: { x: 0, y: 0, width: 402, height: 874 } }),
    node('e63', 'StaticText', 'How old is your cat?', { rect: { x: 24, y: 94, width: 354, height: 38 } }),
    keyboard('e16'),
  ];
  const { events, options } = runtime([snapshot(70, nodes)]);
  await executeCaptureSetup([{ action: 'tap', label: 'How old is your cat?' }], options);
  assert.deepEqual(events.filter(event => event[0] === 'command').map(event => event[1]), [['press', '@e63~s70', '--level', 'full', '--json']]);
});

test('a missing control names the on-screen label that differs only in punctuation', async () => {
  const { options } = runtime([snapshot(80, [node('e14', 'Button', 'Check Mood, 3')])]);
  await assert.rejects(executeCaptureSetup([{ action: 'tap', label: 'Check Mood 3' }], options),
    error => error instanceof CiError && error.code === 'SETUP_CONTROL_NOT_READY'
      && error.message.includes('"Check Mood, 3"') && /exact label/.test(error.nextAction));
});

test('each emitted command shape passes the installed pinned controller parser without a device', async () => {
  const { events, options } = runtime([snapshot(10, [node('e3', 'Button', 'Continue'), node('e4', 'TextField', 'Name')])]);
  await executeCaptureSetup([
    { action: 'tap', label: 'Continue' }, { action: 'fill', label: 'Name', text: 'Milo' },
    { action: 'scroll', direction: 'bottom' }, { action: 'wait', milliseconds: 10 },
  ], options);
  const typing = runtime([inputSnapshot(1)]);
  await executeCaptureSetup([{ action: 'tap', identifier: 'password' }, { action: 'type', text: 'fixture-input' }], typing.options);
  const commands = [...events.filter(event => event[0] === 'command').map(event => event[1]),
    ...typing.events.filter(event => event[0] === 'command').map(event => event[1]), ['keyboard', 'dismiss', '--level', 'full', '--json']];
  for (const args of commands) {
    const result = spawnSync('./node_modules/.bin/agent-device', [...args, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${args[0]} CLI rejected its arguments: ${result.stderr || result.stdout}`);
  }
});

test('a snapshot that cannot read the system surface over the app is recognized, and nothing else is', () => {
  const failed = (message, nextAction) => new CiError({ code: 'COMMAND_FAILED', stage: 'controller', message, ...(nextAction ? { nextAction } : {}) });
  assert.equal(isUnreadableSystemSurface(failed('snapshot: regular iOS snapshot presentation requires a valid viewport')), true);
  assert.equal(isUnreadableSystemSurface(failed('snapshot failed', 'com.apple.SafariViewService hosts the surface presented over the app, and this capture targeted that surface.')), true);
  assert.equal(isUnreadableSystemSurface(failed('snapshot failed', 'No snapshot backend could read this screen (XCTest-backed snapshot tiers were deferred after recent slow accessibility work on this screen).')), true);
  assert.equal(isUnreadableSystemSurface(failed('Remote daemon is unavailable')), false);
  assert.equal(isUnreadableSystemSurface(new CiError({ code: 'SETUP_FAILED', stage: 'setup', message: 'requires a valid viewport' })), false);
  assert.equal(isUnreadableSystemSurface(new Error('requires a valid viewport')), false);
});

