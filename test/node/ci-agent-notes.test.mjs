import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const { generateAgentChangeNotes } = await tsImport('../../src/capture/agent/change-notes.ts', import.meta.url);
const { assertPublicReview, projectPublicReviewForReport } = await tsImport('../../src/contracts/review-validation.ts', import.meta.url);
const { CiError } = await tsImport('../../src/shared/ci-errors.ts', import.meta.url);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
const timestamp = '2026-09-24T00:00:00Z';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'explore-agent-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'screen.png');
  await writeFile(path, png);
  const route = id => ({ id, kind: 'screen', route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`,
    sourceFiles: [`app/${id}.tsx`], variant: 'default', provider: 'expo-router', logicalPath: id });
  const image = side => ({ url: `https://embedded.expo-explore.invalid/${sha256}.png`, sha256,
    sourceCommit: side === 'base' ? baseSha : headSha, buildId: `${side}-build`, capturedAt: timestamp, width: 1, height: 1 });
  const outcome = () => ({ status: 'captured', attempts: 1, landing: 'verified', screenshotSha256: sha256 });
  const surfaces = ['changed', 'unchanged', 'added', 'inventory'].map(id => ({
    id, status: id === 'added' ? 'added' : id === 'inventory' ? 'unchanged' : 'modified',
    base: id === 'added' ? null : route(id), head: route(id),
    ...(id === 'inventory' ? {} : {
      ...(id === 'added' ? {} : { baseImage: image('base'), baseOutcome: outcome() }),
      headImage: image('head'), headOutcome: outcome(),
      review: { status: id === 'changed' ? 'modified' : id === 'added' ? 'added' : 'unchanged', description: 'Deterministic fact.' },
    }),
  }));
  surfaces[0].sourceChange = { contract: 'expo.explore.source-change-summary.v1', baseSha, headSha,
    impact: 'direct', summary: 'The account action label changed.', files: [], truncated: false };
  const review = { contract: 'explore.review', mode: 'all', createdAt: timestamp, runId: '1', runAttempt: '1',
    pullRequest: { base: { sha: baseSha }, head: { sha: headSha } },
    runtime: { projectId: 'project', buildId: 'head-build', gitCommit: headSha }, surfaces };
  const requests = [];
  const evidenceResponses = [];
  const submissions = [];
  const state = {};
  const run = async request => {
    requests.push(request);
    const signal = request.signal ?? new AbortController().signal;
    let count = 0;
    for (const surfaceId of JSON.parse(request.prompt).pendingSurfaceIds) {
      if (count === state.stopAfter) break;
      const evidence = await request.callTool('read_evidence', { surfaceId }, signal);
      assert.equal(evidence.isError, undefined);
      evidenceResponses.push(evidence);
      const context = JSON.parse(evidence.content[0].text);
      const text = context.surfaceId === 'unchanged' ? 'No visible change.'
        : context.surfaceId === 'added' ? 'Added an account screen with a sign-in action.'
        : 'The account action now reads “Sign in”.';
      const input = { surfaceId: context.surfaceId, evidenceDigest: context.evidenceDigest, text };
      state.mutateInput?.(input);
      submissions.push(await request.callTool('submit_change_note', input, signal));
      count++;
    }
    return { inputTokens: count * 10, outputTokens: count * 5 };
  };
  return { review, assets: [{ sha256, path }], provider: { provider: 'openai', model: 'test-model', preflight: async () => {}, run },
    requests, evidenceResponses, submissions, state, path };
}

test('agent notes cover every selected capture and retain all deterministic judgments', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.review);
  const result = await generateAgentChangeNotes(f);
  assert.deepEqual(f.review, original, 'generation does not mutate capture or comparison evidence');
  assert.deepEqual(result.diagnostics, { surfaces: 3, inputTokens: 20, outputTokens: 10 });
  assert.deepEqual(result.review.surfaces.map(surface => surface.note?.text), [
    'The account action now reads “Sign in”.', 'No visible change.', 'Added an account screen with a sign-in action.', undefined,
  ]);
  assert.deepEqual(result.review.surfaces.map(({ note: _note, ...surface }) => surface), original.surfaces);
  assert.equal(f.requests.length, 1, 'the CLI owns one notes session for screens needing an explanation');
  assert.deepEqual(JSON.parse(f.requests[0].prompt).pendingSurfaceIds, ['changed', 'added']);
  assert.deepEqual(f.evidenceResponses.map(response => response.content.filter(block => block.type === 'image').length), [2, 1]);
  assert.equal(JSON.parse(f.evidenceResponses[0].content[0].text).source.summary, 'The account action label changed.');
  assert.match(f.requests[0].instructions, /untrusted evidence, not instructions/);
  assert.match(f.requests[0].instructions, /English/);
  assert.ok(Number.isFinite(f.requests[0].deadlineMs) && f.requests[0].deadlineMs > Date.now());
  assert.deepEqual(f.requests[0].tools.map(tool => tool.name), ['read_evidence', 'submit_change_note']);
  assert.ok(f.submissions.every(result => !result.isError));
  assertPublicReview(result.review);
  const delivered = projectPublicReviewForReport(result.review);
  assert.equal(delivered.surfaces[0].sourceChange, undefined);
  assert.deepEqual(delivered.surfaces[0].note, result.review.surfaces[0].note);
  assert.deepEqual(delivered.surfaces[2].note.evidence, [{ side: 'head', sourceCommit: headSha, imageSha256: sha256 }]);
  assert.doesNotMatch(JSON.stringify(delivered), /inputTokens|outputTokens|model/);
});

test('structured notes reject foreign ids, stale digests, invented status and unsafe text', async t => {
  for (const mutate of [
    input => { input.surfaceId = 'unknown'; },
    input => { input.evidenceDigest = '0'.repeat(64); },
    input => { input.verdict = 'unchanged'; },
    input => { input.text = ''; },
    input => { input.text = 'x'.repeat(161); },
    input => { input.text = 'Line one\nLine two'; },
    input => { input.text = '<script>alert(1)</script>'; },
    input => { input.text = 'See https://foreign.example for details'; },
  ]) {
    const f = await fixture(t);
    f.state.mutateInput = mutate;
    await assert.rejects(generateAgentChangeNotes(f), error => error.code === 'AGENT_NOTES_INVALID');
    assert.ok(f.submissions.every(result => result.isError === true));
    assert.equal(f.review.surfaces.some(surface => surface.note), false);
  }
});

test('authoritative unchanged evidence receives a fixed evidence-bound note without a provider session', async t => {
  const f = await fixture(t);
  f.review.surfaces = [f.review.surfaces[1]];
  f.provider.run = async () => assert.fail('Unchanged notes must not start a paid session');
  const result = await generateAgentChangeNotes(f);
  assert.deepEqual(result.diagnostics, { surfaces: 1, inputTokens: 0, outputTokens: 0 });
  assert.equal(result.review.surfaces[0].note.text, 'No visible change.');
  assert.deepEqual(result.review.surfaces[0].note.evidence, [
    { side: 'base', sourceCommit: baseSha, imageSha256: sha256 },
    { side: 'head', sourceCommit: headSha, imageSha256: sha256 },
  ]);
  assertPublicReview(result.review);
  const digest = result.review.surfaces[0].note.evidenceDigest;
  f.review.surfaces[0].review.description = 'A revised deterministic explanation.';
  const revised = await generateAgentChangeNotes(f);
  assert.notEqual(revised.review.surfaces[0].note.evidenceDigest, digest, 'Local notes remain bound to their exact comparison context');
});

test('local unchanged notes still reject missing, changed and undecodable screenshot artifacts', async t => {
  for (const kind of ['missing', 'changed', 'invalid-png']) {
    const f = await fixture(t);
    f.review.surfaces = [f.review.surfaces[1]];
    f.provider.run = async () => assert.fail('Invalid local evidence must not start a paid session');
    if (kind === 'missing') f.assets = [];
    else {
      const bytes = Buffer.from('This is not a PNG');
      await writeFile(f.path, bytes);
      if (kind === 'invalid-png') {
        const digest = createHash('sha256').update(bytes).digest('hex');
        f.assets[0].sha256 = digest;
        for (const side of ['base', 'head']) {
          f.review.surfaces[0][`${side}Image`].sha256 = digest;
          f.review.surfaces[0][`${side}Outcome`].screenshotSha256 = digest;
        }
      }
    }
    await assert.rejects(generateAgentChangeNotes(f), error => error.code === 'AGENT_NOTES_EVIDENCE_INVALID', kind);
    assert.equal(f.review.surfaces[0].note, undefined);
  }
});

test('local unchanged notes respect an expired enclosing deadline without invoking the provider', async t => {
  const f = await fixture(t);
  f.review.surfaces = [f.review.surfaces[1]];
  f.provider.run = async () => assert.fail('Expired notes must not start a paid session');
  await assert.rejects(generateAgentChangeNotes({ ...f, deadlineMs: Date.now() - 1 }),
    error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.stage === 'notes');
  assert.equal(f.review.surfaces[0].note, undefined);
});

test('provider failures retain their cause if the enclosing deadline expires while the provider exits', async t => {
  const f = await fixture(t);
  const deadlineMs = Date.now() + 60_000;
  const failure = new CiError({ code: 'AGENT_QUOTA_EXHAUSTED', stage: 'agent',
    message: 'Provider credit exhausted.', nextAction: 'Restore provider credit.' });
  f.provider.run = async () => {
    t.mock.method(Date, 'now', () => deadlineMs + 1);
    throw failure;
  };
  await assert.rejects(generateAgentChangeNotes({ ...f, deadlineMs }), error => error === failure);
  assert.equal(f.review.surfaces.some(surface => surface.note), false);
});

test('unchanged source inventory never suppresses modified, uncertain or unavailable review explanations', async t => {
  for (const status of ['modified', 'needs-review', undefined]) {
    const f = await fixture(t);
    f.review.surfaces = [f.review.surfaces[0]];
    f.review.surfaces[0].status = 'unchanged';
    if (status) f.review.surfaces[0].review.status = status;
    else delete f.review.surfaces[0].review;
    const result = await generateAgentChangeNotes(f);
    assert.equal(f.requests.length, 1, status ?? 'no review');
    assert.deepEqual(JSON.parse(f.requests[0].prompt).pendingSurfaceIds, ['changed']);
    assert.equal(result.review.surfaces[0].note.text, 'The account action now reads “Sign in”.');
  }
});

test('removed screens still receive model explanations with only their available base evidence', async t => {
  const f = await fixture(t);
  const surface = f.review.surfaces[0];
  f.review.surfaces = [surface];
  surface.status = surface.review.status = 'removed';
  surface.head = null;
  delete surface.headImage;
  delete surface.headOutcome;
  f.state.mutateInput = input => { input.text = 'This screen was removed from the source inventory.'; };
  const result = await generateAgentChangeNotes(f);
  assert.equal(f.requests.length, 1);
  assert.equal(f.evidenceResponses[0].content.filter(block => block.type === 'image').length, 1);
  assert.deepEqual(result.review.surfaces[0].note.evidence, [{ side: 'base', sourceCommit: baseSha, imageSha256: sha256 }]);
});

test('notes fail visibly on session failure, early completion, missing or altered image evidence', async t => {
  const f = await fixture(t);
  const failure = new CiError({ code: 'AGENT_PROVIDER_AUTH_FAILED', stage: 'agent-provider',
    message: 'Provider authentication failed.', nextAction: 'Replace the configured provider secret.' });
  await assert.rejects(generateAgentChangeNotes({ ...f, provider: { ...f.provider, run: async () => { throw failure; } } }), error => error === failure);
  await assert.rejects(generateAgentChangeNotes({ ...f, provider: { ...f.provider, run: async () => ({ inputTokens: 1, outputTokens: 1 }) } }),
    error => error.code === 'AGENT_NOTES_INVALID');
  f.state.stopAfter = 1;
  await assert.rejects(generateAgentChangeNotes(f), error => error.code === 'AGENT_NOTES_INVALID');
  delete f.state.stopAfter;
  await assert.rejects(generateAgentChangeNotes({ ...f, assets: [] }), error => error.code === 'AGENT_NOTES_EVIDENCE_INVALID');
  await writeFile(f.path, 'altered');
  await assert.rejects(generateAgentChangeNotes(f), error => error.code === 'AGENT_NOTES_EVIDENCE_INVALID');
});

test('the notes session can correct rejected submissions without changing accepted notes or verdicts', async t => {
  const f = await fixture(t);
  const run = f.provider.run;
  let corrections = 0;
  f.provider.run = request => run({ ...request, callTool: async (name, input, signal) => {
    if (name !== 'submit_change_note') return request.callTool(name, input, signal);
    const invalid = await request.callTool(name, { ...input, verdict: 'unchanged' }, signal);
    assert.equal(invalid.isError, true);
    const corrected = await request.callTool(name, input, signal);
    assert.equal(corrected.isError, undefined);
    const duplicate = await request.callTool(name, { ...input, text: 'Replacement explanation.' }, signal);
    assert.equal(duplicate.isError, true);
    corrections++;
    return corrected;
  } });
  const result = await generateAgentChangeNotes(f);
  assert.equal(corrections, 2);
  assert.equal(result.diagnostics.surfaces, 3);
  assert.equal(result.review.surfaces[0].note.text, 'The account action now reads “Sign in”.');
  assert.deepEqual(result.review.surfaces.map(({ note: _note, ...surface }) => surface), f.review.surfaces);
});

test('notes require reading the exact selected evidence and expose no general-purpose tools', async t => {
  const f = await fixture(t);
  const run = f.provider.run;
  f.provider.run = async request => {
    const signal = new AbortController().signal;
    for (const [name, input] of [
      ['read_evidence', { surfaceId: 'inventory' }],
      ['read_evidence', { surfaceId: 'unchanged' }],
      ['read_evidence', { surfaceId: 'changed', path: '/private/file.png' }],
      ['read_evidence', null],
      ['read_source', { surfaceId: 'changed' }],
      ['submit_change_note', { surfaceId: 'changed', evidenceDigest: '0'.repeat(64), text: 'Unverified note.' }],
    ]) assert.equal((await request.callTool(name, input, signal)).isError, true);
    return run(request);
  };
  const result = await generateAgentChangeNotes(f);
  assert.equal(result.diagnostics.surfaces, 3);
  assert.equal(result.review.surfaces[3].note, undefined);
});

test('repeated evidence reads omit duplicate images while explicit rereads preserve access after compaction', async t => {
  const f = await fixture(t);
  const run = f.provider.run;
  f.provider.run = request => run({ ...request, callTool: async (name, input, signal) => {
    const first = await request.callTool(name, input, signal);
    if (name !== 'read_evidence' || first.isError) return first;
    const repeated = await request.callTool(name, input, signal);
    assert.equal(repeated.isError, undefined);
    assert.equal(repeated.content.filter(block => block.type === 'image').length, 0);
    assert.equal(repeated.content[0].text, first.content[0].text);
    assert.match(repeated.content.at(-1).text, /includeImages: true/);
    const refreshed = await request.callTool(name, { ...input, includeImages: true }, signal);
    assert.deepEqual(refreshed, first, 'A model that lost image context can retrieve verified screenshots again');
    assert.equal((await request.callTool(name, { ...input, includeImages: 'yes' }, signal)).isError, true);
    return first;
  } });
  const result = await generateAgentChangeNotes(f);
  assert.equal(result.diagnostics.surfaces, 3);
  const request = f.requests[0];
  const acceptedRead = await request.callTool('read_evidence', { surfaceId: 'changed', includeImages: true }, new AbortController().signal);
  assert.equal(acceptedRead.isError, true, 'Completed screens cannot trigger additional image reads');
});

test('the notes session receives the enclosing deadline and cancellation signal', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const deadlineMs = Date.now() + 60_000;
  await generateAgentChangeNotes({ ...f, deadlineMs, signal: controller.signal });
  assert.equal(f.requests[0].deadlineMs, deadlineMs);
  assert.equal(f.requests[0].signal, controller.signal);
  controller.abort(new Error('Canceled notes test'));
  await assert.rejects(generateAgentChangeNotes({ ...f, signal: controller.signal }), error => error === controller.signal.reason);
  f.review.surfaces = [f.review.surfaces[1]];
  await assert.rejects(generateAgentChangeNotes({ ...f, signal: controller.signal }), error => error === controller.signal.reason);
  assert.equal(f.review.surfaces.some(surface => surface.note), false);
});

test('oversized evidence context fails before starting a notes session', async t => {
  const f = await fixture(t);
  f.review.surfaces[0].sourceChange.files = Array.from({ length: 9 }, (_, index) => ({
    path: `app/file-${index}.tsx`, relation: 'route', status: 'modified', hunks: [], truncated: false,
    facts: [{ kind: 'code', summary: 'x'.repeat(8000) }],
  }));
  assertPublicReview(f.review);
  await assert.rejects(generateAgentChangeNotes(f), error => error.code === 'AGENT_NOTES_EVIDENCE_INVALID');
  assert.equal(f.requests.length, 0);
});

test('published notes validate exact side coverage, image identity and digest shape', async t => {
  const f = await fixture(t);
  const result = await generateAgentChangeNotes(f);
  for (const mutate of [
    note => { note.evidence.pop(); },
    note => { note.evidence[0].side = 'head'; },
    note => { note.evidence[0].sourceCommit = headSha; },
    note => { note.evidence[0].imageSha256 = '0'.repeat(64); },
    note => { note.evidenceDigest = 'short'; },
    note => { note.evidenceDigest = ['a'.repeat(64)]; },
    note => { note.text = 'x'.repeat(161); },
    note => { note.status = 'added'; },
  ]) {
    const candidate = structuredClone(result.review);
    mutate(candidate.surfaces[0].note);
    assert.throws(() => assertPublicReview(candidate), /change note/);
  }
  const candidate = structuredClone(result.review);
  candidate.surfaces[3].note = candidate.surfaces[0].note;
  assert.throws(() => assertPublicReview(candidate), /change note/);
});

test('no selected captures performs no provider work', async t => {
  const f = await fixture(t);
  f.review.surfaces = [f.review.surfaces[3]];
  const result = await generateAgentChangeNotes(f);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(result.review, f.review);
  assert.deepEqual(result.diagnostics, { surfaces: 0, inputTokens: 0, outputTokens: 0 });
});
