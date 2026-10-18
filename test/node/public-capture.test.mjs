import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedBytes } from '../../dist/shared/bounded-bytes.js';
import { ExploreStore, recordObservation } from '../../dist/map/store.js';
import { tsImport } from 'tsx/esm/api';
import { PNG } from 'pngjs';

const { prepareCaptureReview, readCaptureBundle } = await tsImport('../../src/review/capture-review.ts', import.meta.url);
const { assertPublicReview, projectPublicReviewForReport } = await tsImport('../../src/contracts/review-validation.ts', import.meta.url);
const { createSourceCapturePlan } = await tsImport('../../src/source/capture-plan.ts', import.meta.url);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const runtimeProfile = { deviceModel: 'iPhone 17', osVersion: '26.0', locale: 'en_US', orientation: 'portrait', colorScheme: 'light' };
const pr = { repositoryId: '123', repository: 'expo/explore-playground', number: 1, title: 'Change screen', url: 'https://github.com/expo/explore-playground/pull/1', base: { ref: 'main', sha: 'a'.repeat(40) }, head: { ref: 'feature', sha: 'b'.repeat(40) } };
const surface = { id: 'home', route: '/home', routeFile: 'src/app/home.tsx', sourceFiles: [], provider: 'expo-router', logicalPath: 'home', path: '/home', kind: 'screen', variant: 'default' };

test('bounded response reads keep bodies within their limit and reject larger ones', async () => {
  assert.deepEqual(await boundedBytes(new Response(png), png.length), new Uint8Array(png));
  await assert.rejects(boundedBytes(new Response(png), 2), /size limit/);
});

async function captureFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'explore-public-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([[surface.routeFile, 'export default function Home() { return null; }']]);
  const plan = createSourceCapturePlan({ baseSha: pr.base.sha, headSha: pr.head.sha,
    baseFiles: files, headFiles: files, changedFiles: [], mode: 'all' });
  const id = plan.surfaces[0].id;
  const bundles = {};
  for (const side of ['base', 'head']) {
    const directory = join(root, side); await mkdir(directory); await writeFile(join(directory, 'home.png'), png);
    const bundle = { contract: 'explore.bundle', side, gitCommit: pr[side].sha,
      easBuildId: 'build', easProjectId: 'project', appName: 'My App', profile: 'explore:bundle', runtimeProfile,
      selectedSurfaceIds: [id], images: { [id]: { path: 'home.png', sha256, width: 1, height: 1,
        capturedAt: '2026-09-08T00:00:00Z', sourceCommit: pr[side].sha, buildId: 'build' } },
      outcomes: { [id]: { status: 'captured', attempts: 1, landing: 'verified', screenshotSha256: sha256 } } };
    bundles[side] = bundle;
    await writeFile(join(directory, 'bundle.json'), JSON.stringify(bundle));
  }
  let checks = 0;
  const options = { plan, pullRequest: pr, baseDirectory: join(root, 'base'), headDirectory: join(root, 'head'),
    runId: '10', runAttempt: '1', assertCurrentHead: async () => { checks++; } };
  return { root, id, plan, bundles, options, checks: () => checks };
}

async function agentCaptureFixture(t) {
  const f = await captureFixture(t);
  const maps = {};
  for (const side of ['base', 'head']) {
    const store = new ExploreStore(join(f.root, `${side}-active`));
    const timestamp = new Date().toISOString();
    const map = {
      contract: 'expo.explore.local-map.v1', revision: 0,
      run: { id: `capture-${side}`, name: 'Agent capture evidence', platform: 'ios', controller: 'agent-device', status: 'draft',
        createdAt: timestamp, updatedAt: timestamp, build: { id: 'build', gitCommit: pr[side].sha, source: 'eas' },
        environment: runtimeProfile, limits: { maxScreens: 1, maxActions: 10, maxDurationMinutes: 1 } },
      screens: [], variants: [], observations: [], elements: [], artifacts: [],
      actionAttempts: [], transitions: [], journeys: [], frontier: [], gaps: [],
    };
    await store.initialize(map, false);
    const snapshotText = JSON.stringify({ nodes: [{ type: 'text', label: 'Account' }] });
    const snapshotPath = join(f.root, `${side}-snapshot.json`);
    await writeFile(snapshotPath, snapshotText);
    const recorded = await recordObservation({ store, map, title: 'Home', screenId: f.id, route: '/home',
      variantName: 'default', start: true, screenshotPath: join(f.root, side, 'home.png'), snapshotText, snapshotPath,
      elements: [{ identifier: 'account-title', role: 'text', label: 'Account', actions: [], actionable: false, risk: 'safe' }] });
    await store.write(map, recorded.preparedArtifacts);
    map.run.status = 'complete';
    map.run.completedAt = recorded.observation.capturedAt;
    await store.write(map);
    const directory = join(f.root, `${side}-agent`);
    await store.exportTo(directory, map);
    const artifact = recorded.preparedArtifacts.find(entry => entry.artifact.kind === 'screenshot').artifact;
    const bundle = f.bundles[side];
    bundle.images[f.id] = { path: artifact.path, sha256: artifact.sha256, width: artifact.width, height: artifact.height,
      capturedAt: recorded.observation.capturedAt, sourceCommit: pr[side].sha, buildId: 'build' };
    bundle.captureContexts = { [f.id]: { description: 'Show the signed-in home screen.', parameters: {}, requiredLabels: ['Account'] } };
    bundle.agentAcceptance = { policy: 'agent-inspected-frame.v1', frames: { [f.id]: {
      frameId: recorded.observation.id, imageSha256: artifact.sha256, capturedAt: recorded.observation.capturedAt,
    } } };
    await writeFile(join(directory, 'bundle.json'), JSON.stringify(bundle));
    f.options[`${side}Directory`] = directory;
    maps[side] = map;
  }
  return { ...f, maps };
}

test('local review preparation preserves metadata and verified evidence without a publication service', async t => {
  const f = await captureFixture(t);
  const sourceChange = {
    contract: 'expo.explore.source-change-summary.v1', baseSha: pr.base.sha, headSha: pr.head.sha,
    impact: 'none', summary: 'No source changes affect this route.', files: [], truncated: false,
  };
  f.plan.surfaces[0].sourceChange = sourceChange;
  const assessment = { visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1,
    tool: 'agent-device@0.20.2' }, review: { status: 'unchanged', description: 'No visible change' } };
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Review preparation must not upload or fetch artifacts'));
  const result = await prepareCaptureReview({ ...f.options, assessments: { [f.id]: assessment }, app: { version: '1.4.0', buildNumber: '27' } });
  assertPublicReview(result.review);
  assert.equal(result.review.contract, 'explore.review');
  assert.equal(result.review.runtime.appName, 'My App');
  assert.equal(result.review.runtime.appVersion, '1.4.0');
  assert.equal(result.review.runtime.appBuildNumber, '27');
  assert.deepEqual(result.review.surfaces[0].visual, assessment.visual);
  assert.deepEqual(result.review.surfaces[0].review, assessment.review);
  assert.equal(f.checks(), 1);
  assert.equal(result.review.surfaces[0].status, 'unchanged');
  assert.deepEqual(f.plan.surfaces[0].sourceChange, sourceChange, 'Preparation leaves source analysis intact');
  assert.equal(projectPublicReviewForReport(result.review).surfaces[0].sourceChange, undefined);
  assert.deepEqual(result.review.surfaces[0].baseOutcome, f.bundles.base.outcomes[f.id]);
  assert.deepEqual(result.review.surfaces[0].headOutcome, f.bundles.head.outcomes[f.id]);
  assert.equal(result.assets.length, 1, 'Identical screenshot bytes share one content-addressed asset');
  assert.equal(result.assets[0].sha256, sha256);
  assert.deepEqual(await readFile(result.assets[0].path), png);
  assert.equal(result.review.surfaces[0].baseImage.url, `https://embedded.expo-explore.invalid/${sha256}.png`);
  assert.equal(result.review.surfaces[0].headImage.sourceCommit, pr.head.sha);
  assert.deepEqual(await readCaptureBundle(f.options.baseDirectory), f.bundles.base);
  await assert.rejects(readCaptureBundle(join(f.root, 'missing')), /ENOENT/);
  await mkdir(join(f.root, 'bad'));
  await writeFile(join(f.root, 'bad/bundle.json'), JSON.stringify({ contract: 'other' }));
  await assert.rejects(readCaptureBundle(join(f.root, 'bad')), /explore\.bundle/);
});

test('review preparation rejects altered image hashes, metadata and paths outside the capture directory', async t => {
  for (const mutation of ['hash', 'dimensions', 'source-commit', 'parent-path', 'absolute-path', 'symlink']) {
    await t.test(mutation, async t => {
      const f = await captureFixture(t);
      const image = f.bundles.head.images[f.id];
      if (mutation === 'hash') {
        image.sha256 = '0'.repeat(64);
        // Keep the metadata internally consistent to exercise validation of the actual image bytes.
        f.bundles.head.outcomes[f.id].screenshotSha256 = image.sha256;
      }
      if (mutation === 'dimensions') image.width = 2;
      if (mutation === 'source-commit') image.sourceCommit = pr.base.sha;
      if (mutation === 'parent-path') {
        await writeFile(join(f.root, 'outside.png'), png);
        image.path = '../outside.png';
      }
      if (mutation === 'absolute-path') image.path = join(f.root, 'head/home.png');
      if (mutation === 'symlink') {
        await symlink('home.png', join(f.root, 'head/alias.png'));
        image.path = 'alias.png';
      }
      await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(f.bundles.head));
      await assert.rejects(prepareCaptureReview(f.options), /provenance mismatch|Invalid capture artifact path/);
    });
  }
});

test('partial captures retain failure evidence and never invent a missing screenshot', async t => {
  const f = await captureFixture(t);
  delete f.bundles.head.images[f.id];
  f.bundles.head.outcomes[f.id] = { status: 'failed', attempts: 1, landing: 'unverified', reason: 'App did not open the target route' };
  await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(f.bundles.head));
  const result = await prepareCaptureReview({ ...f.options, assessments: {} });
  assertPublicReview(result.review);
  assert.equal(result.review.surfaces[0].headImage, undefined);
  assert.equal(result.review.surfaces[0].baseImage.sha256, sha256);
  assert.equal(result.review.surfaces[0].headOutcome.status, 'failed');
  assert.equal(result.review.surfaces[0].review, undefined, 'capture failures are diagnostics, not app-change verdicts');
  assert.deepEqual(result.assets, [{ sha256, path: join(f.root, 'base/home.png') }]);
});

test('cached capture contexts cover captured surfaces and retain bounded goals', async t => {
  const f = await agentCaptureFixture(t);
  const bundle = f.bundles.base;
  const path = join(f.options.baseDirectory, 'bundle.json');
  assert.deepEqual((await readCaptureBundle(f.options.baseDirectory)).captureContexts, bundle.captureContexts);
  for (const contexts of [
    {},
    { extra: bundle.captureContexts[f.id] },
    { [f.id]: { ...bundle.captureContexts[f.id], description: '' } },
    { [f.id]: { ...bundle.captureContexts[f.id], parameters: { user: 42 } } },
    { [f.id]: { ...bundle.captureContexts[f.id], requiredLabels: [null] } },
  ]) {
    await writeFile(path, JSON.stringify({ ...bundle, captureContexts: contexts }));
    await assert.rejects(readCaptureBundle(f.options.baseDirectory), /Capture context/);
  }
  const failed = structuredClone(bundle);
  failed.images = {};
  failed.outcomes[f.id] = { status: 'failed', attempts: 1, landing: 'unverified', reason: 'Route unavailable' };
  failed.captureContexts = {};
  failed.agentAcceptance.frames = {};
  const failedDirectory = join(f.root, 'failed-agent');
  await mkdir(failedDirectory);
  await writeFile(join(failedDirectory, 'bundle.json'), JSON.stringify(failed));
  assert.deepEqual(await readCaptureBundle(failedDirectory), failed, 'Failed selected routes need neither a frame receipt nor an exported map');
});

test('agent bundle reading and review preparation retain receipts for the actual exported frames', async t => {
  const f = await agentCaptureFixture(t);
  for (const side of ['base', 'head']) {
    const bundle = await readCaptureBundle(f.options[`${side}Directory`]);
    assert.deepEqual(bundle, f.bundles[side]);
    assert.equal(bundle.agentAcceptance.frames[f.id].capturedAt, f.maps[side].observations[0].capturedAt);
  }
  const result = await prepareCaptureReview(f.options);
  assertPublicReview(result.review);
  assert.equal(result.review.surfaces[0].baseImage.sha256, sha256);
  assert.equal(result.review.surfaces[0].headImage.capturedAt, f.bundles.head.agentAcceptance.frames[f.id].capturedAt);
  assert.deepEqual(await readFile(result.assets[0].path), png);
});

test('capture contexts require inspected-frame receipts before public review preparation', async t => {
  const f = await agentCaptureFixture(t);
  delete f.bundles.head.agentAcceptance;
  await writeFile(join(f.options.headDirectory, 'bundle.json'), JSON.stringify(f.bundles.head));
  await assert.rejects(readCaptureBundle(f.options.headDirectory), /Agent acceptance receipts are required/);
  await assert.rejects(prepareCaptureReview(f.options), /Agent acceptance receipts are required/);
});

test('receipts without capture contexts still require an exported map from the captured source revision', async t => {
  const f = await agentCaptureFixture(t);
  delete f.bundles.head.captureContexts;
  await writeFile(join(f.options.headDirectory, 'bundle.json'), JSON.stringify(f.bundles.head));
  assert.deepEqual(await readCaptureBundle(f.options.headDirectory), f.bundles.head);
  const mapPath = join(f.options.headDirectory, 'screen-map.json');
  f.maps.head.run.build.gitCommit = pr.base.sha;
  await writeFile(mapPath, JSON.stringify(f.maps.head));
  await assert.rejects(readCaptureBundle(f.options.headDirectory), /different source commit/);
  await rm(mapPath);
  await assert.rejects(readCaptureBundle(f.options.headDirectory), /No map found/);
});

test('altered agent screenshot bytes are rejected by bundle reading and public review preparation', async t => {
  const f = await agentCaptureFixture(t);
  const path = join(f.options.headDirectory, f.bundles.head.images[f.id].path);
  const altered = Buffer.from(png);
  altered[altered.length - 1] ^= 1;
  await writeFile(path, altered);
  await assert.rejects(readCaptureBundle(f.options.headDirectory), /Exported map is invalid/);
  await assert.rejects(prepareCaptureReview(f.options), /Exported map is invalid/);
});

test('the head app icon travels into the review runtime and its bytes into the report assets', async t => {
  const f = await captureFixture(t);
  const { PNG } = createRequire(import.meta.url)('pngjs');
  const icon = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 200) });
  const iconSha = createHash('sha256').update(icon).digest('hex');
  await writeFile(join(f.root, 'head/app-icon.png'), icon);
  f.bundles.head.appIcon = { path: 'app-icon.png', sha256: iconSha, width: 2, height: 2 };
  await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(f.bundles.head));
  const result = await prepareCaptureReview(f.options);
  assertPublicReview(result.review);
  assert.deepEqual(result.review.runtime.appIcon, {
    sha256: iconSha, width: 2, height: 2, url: `https://embedded.expo-explore.invalid/${iconSha}.png`,
  });
  assert.deepEqual(projectPublicReviewForReport(result.review).runtime.appIcon, result.review.runtime.appIcon);
  const asset = result.assets.find(entry => entry.sha256 === iconSha);
  assert.deepEqual(await readFile(asset.path), icon);

  // A record that does not match its bytes, or names another file, is refused.
  f.bundles.head.appIcon = { ...f.bundles.head.appIcon, width: 3 };
  await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(f.bundles.head));
  await assert.rejects(prepareCaptureReview(f.options), /app icon does not match/);
  f.bundles.head.appIcon = { path: 'home.png', sha256, width: 1, height: 1 };
  await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(f.bundles.head));
  await assert.rejects(readCaptureBundle(f.options.headDirectory), /app icon is invalid/);
});

test('a dark+light capture reviews each appearance as its own surface, dark as <id>@dark', async t => {
  const f = await captureFixture(t);
  for (const side of ['base', 'head']) {
    const bundle = f.bundles[side];
    bundle.runtimeProfile = { ...runtimeProfile, colorSchemes: 'light,dark' };
    await writeFile(join(f.root, side, 'home-dark.png'), png);
    bundle.images[`${f.id}@dark`] = { ...bundle.images[f.id], path: 'home-dark.png' };
    await writeFile(join(f.root, side, 'bundle.json'), JSON.stringify(bundle));
  }
  const darkAssessment = { visual: { verdict: 'modified', reason: 'mismatch', mismatchPercentage: 2.5, threshold: 0.1,
    tool: 'agent-device@0.20.2' }, review: { status: 'variant', description: 'Pixels differ without a source change' } };
  const result = await prepareCaptureReview({ ...f.options, assessments: { [`${f.id}@dark`]: darkAssessment } });
  assertPublicReview(result.review);
  assert.deepEqual(result.review.runtime.colorSchemes, ['light', 'dark']);
  assert.deepEqual(result.review.surfaces.map(s => [s.id, s.colorScheme, s.status]), [[f.id, 'light', 'unchanged'], [`${f.id}@dark`, 'dark', 'unchanged']]);
  assert.deepEqual(result.review.surfaces[1].review, darkAssessment.review);
  assert.equal(result.review.surfaces[0].review, undefined);
  assert.equal(result.review.surfaces[1].headImage.url, `https://embedded.expo-explore.invalid/${sha256}.png`);
  assert.deepEqual(result.review.surfaces[1].headOutcome, f.bundles.head.outcomes[f.id], 'The route outcome covers both appearances');
  assert.equal(result.assets.length, 1);
});

test('a failed dark pass on a route that captured in light reads as a valid bundle and reviews dark as unavailable', async t => {
  const f = await captureFixture(t);
  for (const side of ['base', 'head']) {
    const bundle = f.bundles[side];
    bundle.runtimeProfile = { ...runtimeProfile, colorSchemes: 'light,dark' };
    if (side === 'base') {
      await writeFile(join(f.root, side, 'home-dark.png'), png);
      bundle.images[`${f.id}@dark`] = { ...bundle.images[f.id], path: 'home-dark.png' };
    } else {
      // mergeSchemeOutcomes files the secondary pass's failure under <id>@dark; the route itself stays captured.
      bundle.outcomes[`${f.id}@dark`] = { status: 'failed', attempts: 2, landing: 'unverified',
        reason: 'The capture build has not exposed its active navigation destination.',
        error: { code: 'CAPTURE_OBSERVER_MISSING', stage: 'capture', message: 'The capture build has not exposed its active navigation destination.', nextAction: 'Rerun capture.', retryable: true } };
    }
    await writeFile(join(f.root, side, 'bundle.json'), JSON.stringify(bundle));
  }
  const head = await readCaptureBundle(f.options.headDirectory);
  assert.equal(head.outcomes[`${f.id}@dark`].status, 'failed');
  const result = await prepareCaptureReview(f.options);
  assertPublicReview(result.review);
  const dark = result.review.surfaces.find(s => s.id === `${f.id}@dark`);
  assert.ok(dark, 'the dark appearance is still a surface of the report');
  assert.equal(dark.headImage, undefined, 'no dark head frame is invented');
  assert.equal(dark.headOutcome?.status, 'failed');
  assert.equal(dark.headOutcome?.error?.code, 'CAPTURE_OBSERVER_MISSING');
});

test('a head that gained a light appearance keeps its route in source navigation on the dark-only base', async t => {
  const f = await captureFixture(t);
  f.bundles.base.runtimeProfile = { ...runtimeProfile, colorSchemes: 'dark' };
  await writeFile(join(f.root, 'base/bundle.json'), JSON.stringify(f.bundles.base));
  const head = f.bundles.head;
  head.runtimeProfile = { ...runtimeProfile, colorSchemes: 'light,dark' };
  await writeFile(join(f.root, 'head/home-dark.png'), png);
  head.images[`${f.id}@dark`] = { ...head.images[f.id], path: 'home-dark.png' };
  await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(head));
  const result = await prepareCaptureReview(f.options);
  const [light, dark] = result.review.surfaces;
  assert.deepEqual([light.id, light.status, light.base, dark.id, dark.status], [f.id, 'added', null, `${f.id}@dark`, 'unchanged']);
  assert.deepEqual(dark.baseOutcome, f.bundles.base.outcomes[f.id], 'The dark frame pairs with the base route, which rendered dark as its primary');
  const graph = { contract: 'explore.navigation', edges: [], modalSurfaceIds: [f.id], unresolved: [] };
  result.review.navigation = { base: structuredClone(graph), head: structuredClone(graph) };
  assertPublicReview(result.review);
});

test('a head that gained a dark appearance reviews <id>@dark with its own digest and no base evidence', async t => {
  const f = await captureFixture(t);
  const dark = (() => { const image = new PNG({ width: 1, height: 1 }); image.data.set([0, 0, 0, 255]); return PNG.sync.write(image); })();
  const darkSha = createHash('sha256').update(dark).digest('hex');
  assert.notEqual(darkSha, sha256);
  const bundle = f.bundles.head;
  bundle.runtimeProfile = { ...runtimeProfile, colorSchemes: 'light,dark' };
  await writeFile(join(f.root, 'head/home-dark.png'), dark);
  bundle.images[`${f.id}@dark`] = { ...bundle.images[f.id], path: 'home-dark.png', sha256: darkSha };
  await writeFile(join(f.root, 'head/bundle.json'), JSON.stringify(bundle));
  const result = await prepareCaptureReview(f.options);
  assertPublicReview(result.review);
  const [primary, secondary] = result.review.surfaces;
  assert.deepEqual([primary.id, secondary.id], [f.id, `${f.id}@dark`]);
  assert.deepEqual(primary.baseOutcome, f.bundles.base.outcomes[f.id]);
  assert.equal(secondary.baseOutcome, undefined, 'The single-appearance base never rendered dark');
  assert.equal(secondary.baseImage, undefined);
  assert.equal(secondary.status, 'added');
  assert.equal(secondary.base, null);
  assert.equal(secondary.sourceScope, undefined);
  assert.equal(primary.status, 'unchanged');
  assert.equal(secondary.headOutcome.screenshotSha256, darkSha, 'The dark frame carries its own digest');
  assert.equal(secondary.headOutcome.status, 'captured');
  assert.equal(secondary.headImage.url, `https://embedded.expo-explore.invalid/${darkSha}.png`);
});

test('a flows failure is published per side and validated as a code and a bounded message', async t => {
  const f = await captureFixture(t);
  const result = await prepareCaptureReview({ ...f.options });
  const failure = { code: 'FLOWS_NOT_RUN', message: 'The e2e worker wrote no result.' };
  assertPublicReview({ ...result.review, flowsFailure: { head: failure } });
  assertPublicReview({ ...result.review, flowsFailure: { base: failure, head: failure } });
  for (const invalid of [{}, { head: {} }, { head: { code: 1, message: 'x' } }, { head: { ...failure, extra: true } }, { other: failure }, { head: { ...failure, message: 'x'.repeat(4_001) } }]) {
    assert.throws(() => assertPublicReview({ ...result.review, flowsFailure: invalid }), /Public flows failure is invalid/);
  }
});

test('flow frames are report assets: the review names them by hash and the local report carries their bytes', async t => {
  const f = await captureFixture(t);
  // A second PNG, distinct from the route frame.
  const frameImage = new PNG({ width: 1, height: 1 }); frameImage.data = Buffer.from([12, 34, 56, 255]);
  const framePng = PNG.sync.write(frameImage);
  const frameSha = createHash('sha256').update(framePng).digest('hex');
  const headDirectory = f.options.headDirectory;
  await mkdir(join(headDirectory, 'flows', 'home', 'home-opens'), { recursive: true });
  await writeFile(join(headDirectory, 'flows', 'home', 'home-opens', 'home.png'), framePng);
  const darkImage = new PNG({ width: 1, height: 1 }); darkImage.data = Buffer.from([1, 2, 3, 255]);
  const darkPng = PNG.sync.write(darkImage); const darkSha = createHash('sha256').update(darkPng).digest('hex');
  await writeFile(join(headDirectory, 'flows', 'home', 'home-opens', 'home@dark.png'), darkPng);
  const head = { ...f.bundles.head, runtimeProfile: { ...f.bundles.head.runtimeProfile, colorSchemes: 'light,dark' }, flows: { 'home/home-opens': { file: 'e2e/home.e2e.ts', title: 'home opens', status: 'passed', durationMs: 12,
    steps: [{ api: 'app.screenshot', label: 'home', status: 'passed', durationMs: 3, frame: 'home' }],
    frames: { home: { path: 'flows/home/home-opens/home.png', sha256: frameSha, width: 1, height: 1, capturedAt: '2026-09-08T00:00:01Z' },
      'home@dark': { path: 'flows/home/home-opens/home@dark.png', sha256: darkSha, width: 1, height: 1, capturedAt: '2026-09-08T00:00:02Z' } } } } };
  await writeFile(join(headDirectory, 'bundle.json'), JSON.stringify(head));
  const result = await prepareCaptureReview({ ...f.options });
  assertPublicReview(result.review);
  const flow = result.review.flows[0];
  assert.equal(flow.id, 'home/home-opens');
  assert.match(flow.head.frames.home.url, new RegExp(`${frameSha}\\.png$`));
  assert.deepEqual(result.assets.filter(asset => asset.sha256 === frameSha).map(asset => asset.path), [join(headDirectory, 'flows', 'home', 'home-opens', 'home.png')]);
  // A second appearance's frame is its own surface, `<key>@<scheme>`, carrying the scheme; the primary frame carries none.
  assert.deepEqual(flow.frames.map(frame => [frame.key, frame.id, frame.colorScheme]),
    [['home', 'flow:home/home-opens/home', undefined], ['home@dark', 'flow:home/home-opens/home@dark', 'dark']]);
  assert.match(flow.head.frames['home@dark'].url, new RegExp(`${darkSha}\\.png$`));
  assert.equal(result.assets.filter(asset => asset.sha256 === darkSha).length, 1);
});
