import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, configure } from '@zip.js/zip.js';
import { runPublicCi, runBaselineCi, captureBaseAfterWait } from '../../dist/ci/pipeline.js';
import { readCaptureBundle } from '../../dist/review/capture-review.js';
import { fixture } from '../helpers/public-ci-fixture.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(done => setImmediate(done));

/** The files of a baseline export, zipped as actions/upload-artifact uploads them. */
async function zipDirectory(directory) {
  configure({ useWebWorkers: false });
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    await writer.add(path.slice(directory.length + 1), new Uint8ArrayReader(await readFile(path)));
  }
  return writer.close();
}

test('base starts the moment the wait gives up, beside head, and a waited baseline is restored only once head has finished', async () => {
  const events = [];
  const run = ({ head, waited }) => captureBaseAfterWait({ waited: waited?.promise, head: head.promise, stopWaiting: () => events.push('stop waiting'),
    captureBase: async cache => { events.push(cache ? `base from ${cache}` : 'base captures'); } });
  // The baseline job failed while head was still capturing: base captures at once, in its own session.
  let head = deferred(), waited = deferred();
  let base = run({ head, waited });
  waited.resolve(undefined); await tick();
  assert.deepEqual(events, ['base captures'], 'base did not wait for head');
  head.resolve(); await base;
  // The baseline arrived first: restoring it needs head's runtime profile, so base starts after head.
  events.length = 0; head = deferred(); waited = deferred();
  base = run({ head, waited });
  waited.resolve('/runner/baseline-download'); await tick();
  assert.deepEqual(events, []);
  head.resolve(); await base;
  assert.deepEqual(events, ['base from /runner/baseline-download']);
  // Head failed while base still waited: the wait stops, and base never starts for a failed review.
  events.length = 0; head = deferred(); waited = deferred();
  base = run({ head, waited });
  head.reject(new Error('head capture failed')); await tick();
  assert.deepEqual(events, ['stop waiting']);
  waited.resolve(undefined); await base;
  assert.deepEqual(events, ['stop waiting'], 'base was not captured');
  // Without a wait, base starts as before.
  events.length = 0;
  await captureBaseAfterWait({ waited: undefined, head: new Promise(() => {}), stopWaiting: () => events.push('stop waiting'), captureBase: async () => { events.push('base captures'); } });
  assert.deepEqual(events, ['base captures']);
});

test('head capture starts while the review waits for the baseline, and the waited baseline is restored for base', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const baseline = await runBaselineCi({ project: f.baseProject, sha: f.baseSha, output: join(f.root, 'baseline'), config: f.config, environment: f.environment, runner: f.runner, now: f.now, sleep: f.sleep });
  const before = f.requests.length;
  // The baseline finishes only once head capture has started a simulator session; were head held back by the wait,
  // the fallback would end it with no baseline after 20 s, and base would capture.
  const finished = deferred();
  let finishedBy;
  const fallback = setTimeout(() => { finishedBy ??= 'timeout'; finished.resolve(undefined); }, 20_000);
  t.after(() => clearTimeout(fallback));
  const runner = request => {
    if (request.args[0] === 'simulator:start' && !finishedBy) { finishedBy = 'head started'; setImmediate(() => finished.resolve(baseline.directory)); }
    return f.runner(request);
  };
  let waitSignal;
  const progress = [];
  const output = join(f.root, 'review');
  await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath, output, config: f.config,
    environment: f.environment, transport: f.transport, runner, now: f.now, sleep: f.sleep, progress: line => progress.push(line),
    awaitBaseline: signal => { waitSignal = signal; return finished.promise; } });
  assert.equal(finishedBy, 'head started');
  assert.equal(f.requests.slice(before).filter(request => request.args[0] === 'simulator:start').length, 1, 'base reused the baseline instead of a second session');
  assert.ok(progress.includes(`base waits for the baseline run of ${f.baseSha.slice(0, 8)} still being captured; head captures meanwhile`));
  assert.ok(progress.includes(`base: found the baseline captures of ${f.baseSha.slice(0, 8)}`));
  const baselineBundle = await readCaptureBundle(baseline.directory);
  for (const [id, image] of Object.entries((await readCaptureBundle(join(output, 'base-export'))).images)) assert.deepEqual(image, baselineBundle.images[id]);
  assert.equal(JSON.parse(await readFile(join(output, 'execution.json'), 'utf8')).capture.baseFromCache, true);
  assert.equal(waitSignal.aborted, true, 'the wait is told to stop once the review is done');
});

test('while base waits for the baseline, the comment names the step the baseline job is in, and the run records its phases', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const baseline = await runBaselineCi({ project: f.baseProject, sha: f.baseSha, output: join(f.root, 'baseline'), config: f.config, environment: f.environment,
    runner: f.runner, now: f.now, sleep: f.sleep, timingsPath: join(f.root, 'baseline-timings.jsonl') });
  const finished = deferred();
  const bodies = [];
  const timingsPath = join(f.root, 'timings.jsonl');
  const runner = request => {
    if (request.args[0] === 'simulator:start') setImmediate(() => finished.resolve(baseline.directory));
    return f.runner(request);
  };
  await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath, output: join(f.root, 'review'), config: f.config,
    environment: f.environment, transport: f.transport, runner, now: f.now, sleep: f.sleep, timingsPath, onComment: (_state, body) => bodies.push(body),
    awaitBaseline: (_signal, watch) => {
      watch.onUpdate({ state: 'in progress', step: 'Install the launch recording decoder', stepSince: 0, waitedMs: 0 });
      return finished.promise;
    } });
  const waiting = bodies.filter(body => body.includes("base waits for the default branch's baseline (in “Install the launch recording decoder”)"));
  assert.ok(waiting.length >= 1, bodies.join('\n---\n'));
  assert.equal(bodies.at(-1).includes('base waits for'), false, 'the comment stops saying so once the wait is over');
  const events = (await readFile(timingsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'run');
  assert.deepEqual(events.at(-1), { ...events.at(-1), type: 'finish', outcome: 'ok' });
  const ended = events.filter(event => event.type === 'end');
  const started = events.filter(event => event.type === 'start');
  assert.deepEqual(started.map(event => event.id).sort(), ended.map(event => event.id).sort(), 'every span the review opened, it closed');
  const phases = new Set(ended.map(event => `${event.phase}${event.side ? `:${event.side}` : ''}`));
  for (const phase of ['plan', 'preflight', 'capture', 'compare', 'report', 'baseline-blocked', 'pass:head', 'configuration:head', 'session-start:head', 'route:head']) {
    assert.ok(phases.has(phase), `${phase} in ${[...phases].join(', ')}`);
  }
  const baselineEvents = (await readFile(join(f.root, 'baseline-timings.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(baselineEvents.some(event => event.type === 'end' && event.phase === 'pass' && event.side === 'baseline'));
  assert.deepEqual(baselineEvents.at(-1), { ...baselineEvents.at(-1), type: 'finish', outcome: 'ok' });
});

test('capture:review waits for the baseline run ci:find-baseline named, downloads its artifact, and restores base from it', async t => {
  const f = await fixture(t, 'expo-router');
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const baseline = await runBaselineCi({ project: f.baseProject, sha: f.baseSha, output: join(f.root, 'baseline'), config: f.config, environment: f.environment, runner: f.runner, now: f.now, sleep: f.sleep });
  const zip = await zipDirectory(baseline.directory);
  const actions = [];
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin === 'https://blob.example') { actions.push('download'); assert.equal(init.headers?.authorization, undefined); return new Response(zip); }
    const path = url.pathname.replace('/repos/acme/example', '');
    if (path === '' || path.startsWith('/actions/runs/40') || path.startsWith('/actions/workflows/') || path.startsWith('/actions/artifacts/77')) actions.push(path);
    if (path === '') return Response.json({ default_branch: 'main' });
    if (path === '/actions/workflows/explore-baseline.yml') return Response.json({ id: 5 });
    if (path === '/actions/runs/40') return Response.json({ id: 40, status: 'in_progress', conclusion: null, workflow_id: 5, head_sha: f.baseSha, head_branch: 'main', event: 'push', head_repository: { full_name: 'acme/example' } });
    if (path === '/actions/runs/40/artifacts') return Response.json({ artifacts: [{ id: 77, name: url.searchParams.get('name'), expired: false, workflow_run: { id: 40 } }] });
    if (path === '/actions/artifacts/77/zip') return new Response(null, { status: 302, headers: { location: 'https://blob.example/77.zip' } });
    return f.transport(input, init);
  };
  const review = async (name, config) => {
    const before = f.requests.length; actions.length = 0;
    const output = join(f.root, name);
    const progress = [];
    await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath, output, config,
      environment: { ...f.environment, EXPLORE_BASELINE_RUN: '40' }, transport, runner: f.runner, now: f.now, sleep: f.sleep, progress: line => progress.push(line) });
    return { output, progress, sessions: f.requests.slice(before).filter(request => request.args[0] === 'simulator:start').length };
  };
  const waited = await review('review', f.config);
  assert.deepEqual(actions, ['', '/actions/workflows/explore-baseline.yml', '/actions/runs/40', '/actions/runs/40/artifacts', '/actions/artifacts/77/zip', 'download']);
  assert.ok(waited.progress.includes(`base: downloaded the baseline of ${f.baseSha.slice(0, 8)} that run 40 captured`));
  assert.equal(waited.sessions, 1, 'base was restored from the downloaded baseline');
  assert.equal(JSON.parse(await readFile(join(waited.output, 'execution.json'), 'utf8')).capture.baseFromCache, true);
  const off = await review('review-no-wait', { ...f.config, capture: { ...f.config.capture, baselineWaitMinutes: 0 } });
  assert.deepEqual(actions, [], 'capture.baselineWaitMinutes: 0 never waits');
  assert.equal(off.sessions, 2, 'base captured itself');
});
