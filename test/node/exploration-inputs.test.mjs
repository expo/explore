import assert from 'node:assert/strict';
import test from 'node:test';
import { createExplorationInputs, explorationSecretNames } from '../../dist/config/exploration-inputs.js';

test('app inputs resolve only committed references and never CI/provider credentials', () => {
  const inputs = createExplorationInputs({ instructions: 'Use {{secret:APP_REVIEW_PASSWORD}}.', environment: { APP_REVIEW_PASSWORD: 'private-value' } });
  assert.equal(inputs.resolve('{{secret:APP_REVIEW_PASSWORD}}'), 'private-value');
  assert.throws(() => inputs.resolve('{{secret:UNDECLARED}}'), { code: 'EXPLORATION_SECRET_UNDECLARED' });
  assert.throws(() => explorationSecretNames('{{secret:ANTHROPIC_API_KEY}}'), { code: 'EXPLORATION_SECRET_REFERENCE_INVALID' });
  assert.throws(() => explorationSecretNames('{{secret:lowercase}}'), { code: 'EXPLORATION_SECRET_REFERENCE_INVALID' });
  assert.throws(() => createExplorationInputs({ instructions: '{{secret:APP_INPUT}}', environment: {} }), { code: 'EXPLORATION_SECRET_MISSING' });
});

test('quoted and escaped secrets are redacted and prevent screenshots', () => {
  const secret = 'private"quoted\\input';
  const inputs = createExplorationInputs({ setup: [{ action: 'fill', label: 'Password', text: '{{secret:APP_INPUT}}' }], environment: { APP_INPUT: secret } });
  const snapshot = { nodes: [{ type: 'TextField', value: secret }] };
  assert.throws(() => inputs.assertSafeSnapshot(snapshot), { code: 'CAPTURE_SENSITIVE_INPUT' });
  assert.deepEqual(inputs.redactValue(snapshot), { nodes: [{ type: 'TextField', value: '[REDACTED]' }] });
  assert.equal(inputs.redact(JSON.stringify(secret)), '"[REDACTED]"');
  assert.equal(inputs.redact(encodeURIComponent(secret)), '[REDACTED]');
});

test('structured redaction preserves keys even when a secret is short', () => {
  const inputs = createExplorationInputs({ instructions: '{{secret:APP_INPUT}}', environment: { APP_INPUT: 'a' } });
  assert.deepEqual(inputs.redactValue({ action: 'a' }), { action: '[REDACTED]' });
});

test('typed setup inputs resolve declared secrets and redact diagnostics', () => {
  const setup = [{ action: 'tap', identifier: 'password' }, { action: 'type', text: '{{secret:APP_INPUT}}' }];
  const inputs = createExplorationInputs({ setup, environment: { APP_INPUT: 'private-typed-value' } });
  assert.deepEqual(inputs.names, ['APP_INPUT']);
  assert.equal(inputs.resolve(setup[1].text), 'private-typed-value');
  assert.equal(inputs.redact('Native failure: private-typed-value'), 'Native failure: [REDACTED]');
  assert.throws(() => createExplorationInputs({ setup, environment: {} }), { code: 'EXPLORATION_SECRET_MISSING' });
});

test('masked secure inputs block screenshots until cleared or left', () => {
  const inputs = createExplorationInputs();
  assert.throws(() => inputs.assertSafeSnapshot({ nodes: [{ type: 'SecureTextField', value: '••••' }] }), { code: 'CAPTURE_SENSITIVE_INPUT' });
  assert.doesNotThrow(() => inputs.assertSafeSnapshot({ nodes: [{ type: 'SecureTextField', value: '', placeholder: 'Password' }] }));
  assert.doesNotThrow(() => inputs.assertSafeSnapshot({ nodes: [{ type: 'SecureTextField', value: 'Password', placeholder: 'Password' }] }));
});
