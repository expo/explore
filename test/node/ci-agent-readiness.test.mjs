import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { agentCaptureConstraints, revisionSpecificLandmarks } from '../../dist/capture/agent/source-context.js';
import { assessCaptureReadiness } from '../../dist/capture/agent/readiness.js';

test('source literals distinguish changed content from stable labels without constraining added routes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-context-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  const projects = { base: join(root, 'base'), head: join(root, 'head') };
  for (const side of ['base','head']) {
    await mkdir(projects[side]);
    await writeFile(join(projects[side], 'screen.tsx'), `export const labels = ['Settings', '${side === 'head' ? 'Account' : 'Legacy row'}']; export default () => <Text>Stable JSX</Text>;`);
  }
  const route = { routeFile: 'screen.tsx', sourceFiles: [] };
  const constraints = await agentCaptureConstraints({ surfaces: [
    { id: 'settings', baseSurface: route, headSurface: route }, { id: 'account', baseSurface: null, headSurface: route },
  ] }, projects);
  assert.deepEqual(constraints.settings.revisionLabels, ['Account', 'Legacy row']);
  assert.deepEqual(revisionSpecificLandmarks(['Settings', 'Account', 'Account, Open', 'Stable JSX'], constraints.settings), ['Account', 'Account, Open']);
  assert.equal(constraints.account, undefined);
});

test('runtime-assembled labels that carry revision-specific template text are not shared landmarks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-context-template-')); t.after(() => rm(root, { recursive: true, force: true }));
  const projects = { base: join(root, 'base'), head: join(root, 'head') };
  const sources = {
    base: 'export default ({ price }) => <><Text>Premium</Text><Text>{`${price} per year`}</Text><Text>Subscribe</Text></>;',
    head: 'export default ({ price, monthly, saving }) => <><Text>Premium</Text><Text>{`${price} per year · ${monthly} a month`}</Text><Text>{`Save ${saving}%`}</Text><Text>Subscribe</Text></>;',
  };
  for (const side of ['base', 'head']) { await mkdir(projects[side]); await writeFile(join(projects[side], 'plan.tsx'), sources[side]); }
  const route = { routeFile: 'plan.tsx', sourceFiles: [] };
  const constraints = await agentCaptureConstraints({ surfaces: [{ id: 'plan', baseSurface: route, headSurface: route }] }, projects);
  assert.ok(constraints.plan.revisionLabels.includes(' a month'), 'template text is source evidence');
  assert.deepEqual(revisionSpecificLandmarks(['Premium', 'Annual, $39.99 per year · $3.33 a month', 'Save 33%', 'Subscribe', 'Annual, $39.99 per year'], constraints.plan),
    ['Annual, $39.99 per year · $3.33 a month', 'Save 33%', 'Annual, $39.99 per year']);
  // Short revision strings still match only a whole label or label part.
  assert.deepEqual(revisionSpecificLandmarks(['Total %', '%'], { revisionLabels: ['%'], sourceChange: '' }), ['%']);
});

test('a label both revisions render stays a landmark when a revision adds text it contains', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-context-shared-')); t.after(() => rm(root, { recursive: true, force: true }));
  const projects = { base: join(root, 'base'), head: join(root, 'head') };
  const sources = {
    base: 'export default () => <><Text>Go Premium</Text><Text>Subscribe</Text></>;',
    head: 'export default () => <><Text>Go Premium</Text><Text>Premium</Text><Text>Subscribe</Text></>;',
  };
  for (const side of ['base', 'head']) { await mkdir(projects[side]); await writeFile(join(projects[side], 'plan.tsx'), sources[side]); }
  const route = { routeFile: 'plan.tsx', sourceFiles: [] };
  const constraints = await agentCaptureConstraints({ surfaces: [{ id: 'plan', baseSurface: route, headSurface: route }] }, projects);
  assert.deepEqual(constraints.plan.revisionLabels, ['Premium']);
  assert.deepEqual(constraints.plan.sharedLabels, ['Go Premium']);
  // The added badge and runtime text around it are revision-specific; the unchanged button is not.
  assert.deepEqual(revisionSpecificLandmarks(['Go Premium', 'Go Premium, Button', 'Premium', 'Premium plan', 'Subscribe'], constraints.plan),
    ['Premium', 'Premium plan']);
  assert.deepEqual(revisionSpecificLandmarks(['Plan, Save 20, monthly'], { revisionLabels: ['Save 20, monthly'], sourceChange: '' }), ['Plan, Save 20, monthly']);
  // Without shared strings nothing is recorded, so the constraint the agent sees stays as small as before.
  assert.equal((await agentCaptureConstraints({ surfaces: [{ id: 'same', baseSurface: route, headSurface: route }] }, { base: projects.base, head: projects.base })).same.sharedLabels, undefined);
});

test('shared text containing commas remains usable inside a merged landmark without hiding changed text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-context-shared-comma-')); t.after(() => rm(root, { recursive: true, force: true }));
  const projects = { base: join(root, 'base'), head: join(root, 'head') };
  for (const side of ['base', 'head']) {
    await mkdir(projects[side]);
    await writeFile(join(projects[side], 'screen.tsx'), `export default () => <><Pressable><Text>Order complete, View details</Text><Text>Open</Text></Pressable>${side === 'head' ? '<Text>complete</Text><Text>details, Retry</Text>' : ''}</>;`);
  }
  const route = { routeFile: 'screen.tsx', sourceFiles: [] };
  const { screen } = await agentCaptureConstraints({ surfaces: [{ id: 'screen', baseSurface: route, headSurface: route }] }, projects);
  assert.deepEqual(screen.revisionLabels, ['complete', 'details, Retry']);
  assert.deepEqual(screen.sharedLabels, ['Order complete, View details']);
  const stable = ['Order complete, View details', 'Order complete, View details, Open',
    'Open, Order complete, View details', 'Order complete, View details, Order complete, View details'];
  const changed = ['complete', 'details, Retry', 'Order complete, View details, Open, complete',
    'complete, Order complete, View details, Open', 'Order complete, View details, complete status',
    'Order complete, View details, Retry', 'Prefix Order complete, View details, Open',
    'Order complete, View details suffix, Open'];
  assert.deepEqual(revisionSpecificLandmarks([...stable, ...changed], screen), changed);
});

const request = () => ({ image: PNG.sync.write({ width: 4, height: 6, data: Buffer.alloc(96, 255) }), route: '/result',
  context: { description: 'A rendered photo.', requiredLabels: ['Save'], parameters: {} }, instructions: 'Inspect the photo.',
  signal: new AbortController().signal, deadlineMs: Date.now() + 60000 });

test('independent assessment binds one exact image and fails closed when no decision is returned', async () => {
  const provider = { run: async r => {
    assert.equal(r.images.length, 1);
    assert.equal(r.tools.length, 1);
    assert.match(r.instructions, /blank white placeholder/);
    const { imageSha256 } = JSON.parse(r.prompt);
    await assert.rejects(r.callTool('submit_readiness', { imageSha256: 'f'.repeat(64), ready: true, reason: 'Wrong frame.' }));
    await r.callTool('submit_readiness', { imageSha256, ready: false, reason: 'The expected photo is missing.' });
    await assert.rejects(r.callTool('submit_readiness', { imageSha256, ready: true, reason: 'Changed my mind.' }));
    return { inputTokens: 1, outputTokens: 1 };
  } };
  const result = await assessCaptureReadiness(provider, request());
  assert.equal(result.ready, false);
  await assert.rejects(assessCaptureReadiness({ run: async () => ({ inputTokens: 0, outputTokens: 0 }) }, request()), { code: 'AGENT_READINESS_UNVERIFIED' });
});

test('the assessor receives the element each verified label matched and may not reject an icon for lacking printed text', async () => {
  const verifiedLabels = [{ value: 'Skip photo', matchedField: 'label', type: 'Button', rect: { x: 330, y: 780, width: 48, height: 48 } }];
  let prompt;
  const provider = { run: async r => {
    prompt = JSON.parse(r.prompt);
    assert.match(r.instructions, /Never reject because a verified label is not printed/);
    await r.callTool('submit_readiness', { imageSha256: prompt.imageSha256, ready: true, reason: 'The icon controls are visible.' });
    return { inputTokens: 1, outputTokens: 1 };
  } };
  const result = await assessCaptureReadiness(provider, { ...request(), verifiedLabels });
  assert.equal(result.policy, 'independent-image-readiness.v3');
  assert.deepEqual(prompt.verifiedLabels, verifiedLabels);
  await assessCaptureReadiness(provider, request());
  assert.deepEqual(prompt.verifiedLabels, []);
});
