import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleColorSchemes } from '../../dist/capture/appearance.js';
import { usageReceipt } from '../helpers/public-ci-fixture.mjs';
import { roundTrip, agentSession } from '../helpers/round-trip.mjs';

test('round trip: light + dark with an unavailable screen publishes an incomplete review that the Viewer opens', async t => {
  const { report, comment, records, progress } = await roundTrip(t, { userInterfaceStyle: 'automatic', observerFailurePath: '/home' }, { cachedBase: false });
  // /home's observer reports nothing after answering for an earlier route: the frame the app showed is unattributed evidence.
  const unattributed = report.review.surfaces.filter(surface => surface.headOutcome?.status === 'captured' && surface.headOutcome.landing === 'unverified');
  assert.ok(unattributed.length >= 1);
  assert.ok(unattributed.every(surface => surface.headImage && surface.headOutcome.observed?.reason === 'observer-not-ready'));
  assert.ok(progress.some(line => line.startsWith('::warning title=Explore head capture unavailable')), progress.filter(line => line.startsWith('::warning')).join('\n'));
  assert.match(comment, /^iOS · [^\n]*unattributed · \[run\]/m);
  assert.doesNotMatch(comment, /🟥 failed/);
  assert.equal(records.current.ios?.phase, 'ready');
});

test('round trip: a failed screenshot comparison is a named gap, not a failed run', async t => {
  let pairs = 0;
  const measure = async (baselinePath, currentPath) => {
    if (pairs++ < 2) throw new Error('comparator crashed on this pair');
    return { baselinePath, currentPath, totalPixels: 384, differentPixels: 0, mismatchPercentage: 0, match: true, regions: [] };
  };
  const { result, report, comment, records, progress } = await roundTrip(t, { userInterfaceStyle: 'automatic' }, { measure });
  assert.equal(result.evidence.summary.visual.failed, 2);
  assert.equal(result.evidence.summary.visual.compared, 2, 'the other pairs compared');
  assert.ok(progress.some(line => line.startsWith('::warning title=Explore comparison failed')), progress.join('\n'));
  const failed = result.evidence.summary.diagnostics.filter(diagnostic => diagnostic.code === 'VISUAL_COMPARISON_FAILED').map(diagnostic => diagnostic.surfaceId);
  assert.equal(failed.length, 2);
  for (const id of failed) {
    const surface = report.review.surfaces.find(candidate => candidate.id === id);
    assert.ok(surface, `${id} stays in the report`);
    assert.notEqual(surface.review?.status, 'modified', 'a failed comparison is not reported as a change');
  }
  assert.match(comment, /^iOS · [^\n]*2 comparisons failed · \[run\]/m);
  assert.doesNotMatch(comment, /🟥 failed/);
  assert.equal(records.current.ios?.phase, 'ready');
});

test('round trip: a baseline with an unavailable screen is still cached, and the review captures that screen itself', async t => {
  const { baseline, result, comment, records, progress } = await roundTrip(t, { userInterfaceStyle: 'automatic', observerFailurePath: '/home' });
  assert.ok(baseline.unavailable >= 1, 'the unreachable route is unavailable in the baseline');
  assert.ok(progress.some(line => line.startsWith('baseline: ::warning title=Explore head capture unavailable')));
  assert.ok(progress.some(line => !line.startsWith('baseline:') && /reused from the baseline, \d+ to capture/.test(line)), progress.filter(line => line.includes('capture')).join('\n'));
  assert.ok(result.evidence.summary.visual.compared > 0);
  assert.match(comment, /^iOS · [^\n]*· \[run\]/m, 'the gap is named on the iOS line');
  assert.equal(records.current.ios?.phase, 'ready');
});

test('round trip: the notes session failing (provider down) publishes the report without notes; verdicts, captures and the comment are unaffected', async t => {
  let notesAttempts = 0;
  const { result, report, comment, progress, records } = await roundTrip(t, { agentMode: true, userInterfaceStyle: 'automatic' },
    { agentSessionFactory: agentSession({ notes: () => { notesAttempts++; throw new Error('provider unavailable: 503'); } }) });
  assert.ok(notesAttempts >= 1);
  assert.ok(progress.some(line => line.startsWith('::warning title=Explore change notes unavailable')), progress.filter(l => l.startsWith('::warning')).join('\n'));
  assert.ok(progress.includes('change notes are unavailable for this report; verdicts and captures are unaffected'));
  assert.ok(result.evidence.summary.diagnostics.some(d => d.code === 'AGENT_NOTES_UNAVAILABLE'));
  assert.ok(report.review.surfaces.every(surface => !surface.note), 'no note is invented');
  assert.ok(report.review.surfaces.some(surface => surface.headImage && surface.review), 'verdicts and captures remain');
  assert.equal(records.current.ios.phase, 'ready');
  assert.match(comment, /AGENT_NOTES_UNAVAILABLE/);
});

test('round trip: agent mode with automatic light + dark; the notes session covers every appearance surface', async t => {
  const notes = async ({ context, call, options }) => {
    for (const surfaceId of context.pendingSurfaceIds) {
      const { result: evidence } = await call('read_evidence', { surfaceId });
      const submitted = await call('submit_change_note', { surfaceId, evidenceDigest: evidence.evidenceDigest,
        text: evidence.deterministicReview?.status === 'unchanged' ? 'No visible change.' : 'Screen content changes.' });
      assert.equal(submitted.response.isError, undefined, JSON.stringify(submitted.result));
    }
    await options.onUsage(usageReceipt({ totals: { inputTokens: 50, outputTokens: 10 }, models: [] }));
    return { inputTokens: 50, outputTokens: 10 };
  };
  const { bundles, report, records, progress } = await roundTrip(t, { agentMode: true, userInterfaceStyle: 'automatic' },
    { agentSessionFactory: agentSession({ notes }) });
  assert.deepEqual(bundleColorSchemes(bundles.head), ['light', 'dark']);
  assert.ok(Object.keys(bundles.head.agentAcceptance.frames).some(id => id.endsWith('@dark')), 'dark frames carry acceptance receipts');
  assert.ok(report.review.surfaces.filter(surface => surface.baseImage || surface.headImage).every(surface => surface.note), 'every captured surface, dark ones included, has a note');
  assert.ok(!progress.some(line => line.startsWith('::warning')), progress.filter(line => line.startsWith('::warning')).join('\n'));
  assert.equal(records.current.ios.phase, 'ready');
});
