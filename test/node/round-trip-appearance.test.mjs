import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleColorSchemes } from '../../dist/capture/appearance.js';
import { roundTrip, schemesOf, screenIds } from '../helpers/round-trip.mjs';

test('round trip: light + dark on both sides with a fully reused baseline', async t => {
  const { result, bundles, report, comment, records, workspace, projection, progress } = await roundTrip(t, { userInterfaceStyle: 'automatic' });
  assert.deepEqual(schemesOf(bundles.base), ['light', 'dark'], 'the reused base keeps its colour schemes');
  assert.deepEqual(schemesOf(bundles.head), ['light', 'dark']);
  assert.ok(screenIds(bundles.base).some(id => id.endsWith('@dark')));
  assert.ok(screenIds(bundles.head).some(id => id.endsWith('@dark')));
  assert.equal(result.evidence.summary.visual.failed, 0);
  assert.ok(result.evidence.summary.visual.compared > 0);
  assert.ok(report.review.surfaces.some(surface => surface.id.endsWith('@dark')), 'dark surfaces reach the report');
  assert.ok(result.evidence.summary.accessibility && result.evidence.summary.accessibility.compared > 0, 'accessibility compared the pairs');
  const inconclusiveDark = report.review.surfaces.filter(surface => surface.id.endsWith('@dark') && surface.review?.status === 'needs-review');
  assert.deepEqual(inconclusiveDark.map(surface => `${surface.id}: ${surface.review.description}`), [], 'an unchanged dark pair compares conclusively');
  assert.ok(!progress.some(line => line.startsWith('::warning')), progress.filter(line => line.startsWith('::warning')).join('\n'));
  assert.match(comment, /\| iOS \| [^|]*light \+ dark[^|]*\| 🟩 /);
  assert.equal(records.current.ios?.phase, 'ready');
  assert.ok(records.current.ios?.capture, 'the final record keeps the capture counts');
  assert.deepEqual(records.current.ios.capture.done, records.current.ios.capture.planned, 'progress counts surfaces (routes), not light + dark images');
  assert.ok(Object.keys(workspace).length > 0, 'the Viewer loads the report');
  assert.ok(projection);
});

test('round trip: a dark-only base against a light + dark head (the first PR that turns on a second appearance)', async t => {
  const { result, bundles, report, comment, records, progress } = await roundTrip(t, { userInterfaceStyle: 'dark', headUserInterfaceStyle: 'automatic' });
  assert.deepEqual(schemesOf(bundles.base), ['dark']);
  assert.deepEqual(schemesOf(bundles.head), ['light', 'dark']);
  assert.equal(result.evidence.summary.visual.failed, 0);
  assert.ok(result.evidence.summary.visual.compared > 0, 'head dark pairs with base dark');
  const lightOnly = report.review.surfaces.filter(surface => surface.head && !surface.base && !surface.id.endsWith('@dark') && surface.head.route !== '/added');
  assert.ok(lightOnly.length > 0, 'the light appearance is an added surface, not a modified one');
  assert.ok(!progress.some(line => line.startsWith('::warning')), progress.filter(line => line.startsWith('::warning')).join('\n'));
  assert.match(comment, /\| iOS \| [^|]*light \+ dark[^|]*\| 🟩 /);
  assert.equal(records.current.ios?.phase, 'ready');
});

test('round trip: light + dark with a freshly captured base', async t => {
  const { result, bundles, comment } = await roundTrip(t, { userInterfaceStyle: 'automatic' }, { cachedBase: false });
  assert.deepEqual(schemesOf(bundles.base), ['light', 'dark']);
  assert.equal(result.evidence.summary.visual.failed, 0);
  assert.match(comment, /\| iOS \| [^|]*light \+ dark[^|]*\| 🟩 /);
});

test('round trip: Android light + dark', async t => {
  const { result, bundles, comment, records } = await roundTrip(t, { userInterfaceStyle: 'automatic', platform: 'android' });
  assert.deepEqual(schemesOf(bundles.head), ['light', 'dark']);
  assert.equal(result.evidence.summary.visual.failed, 0);
  assert.match(comment, /\| Android \| [^|]*light \+ dark[^|]*\| 🟩 /);
  assert.equal(records.current.android?.phase, 'ready');
});

test('round trip: a single-scheme app (no userInterfaceStyle) captures light only, byte-for-byte the pre-appearance shape', async t => {
  const { bundles, report, comment, records } = await roundTrip(t, {});
  assert.deepEqual(bundleColorSchemes(bundles.head), ['light']);
  assert.ok(!report.review.surfaces.some(surface => /@(light|dark)$/.test(surface.id)), 'no secondary appearance surfaces');
  assert.equal(report.review.runtime.colorSchemes, undefined);
  assert.match(comment, /\| iOS \| [^|]*\| 🟩 /);
  assert.doesNotMatch(comment, /light \+ dark/);
  assert.equal(records.current.ios.phase, 'ready');
});

test('round trip: capture.appearance "light" on an app that declares automatic captures light only', async t => {
  const { bundles, report, comment, records } = await roundTrip(t, { userInterfaceStyle: 'automatic' },
    { configure: config => { config.capture.appearance = ['light']; } });
  assert.deepEqual(schemesOf(bundles.base), ['light']);
  assert.deepEqual(schemesOf(bundles.head), ['light']);
  assert.ok(!report.review.surfaces.some(surface => /@(light|dark)$/.test(surface.id)), 'no appearance surfaces');
  assert.doesNotMatch(comment, /light \+ dark/);
  assert.equal(records.current.ios.phase, 'ready');
});
