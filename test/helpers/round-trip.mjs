import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPublicCi, runBaselineCi } from '../../dist/ci/pipeline.js';
import { exportCiReport, publishCiReportComment } from '../../dist/report/artifact.js';
import { readCaptureBundle } from '../../dist/review/capture-review.js';
import { readCommentRecords } from '../../dist/report/pr-comment-record.js';
import { bundleColorSchemes } from '../../dist/capture/appearance.js';
import { fixture, usageReceipt } from './public-ci-fixture.mjs';

const { tsImport } = await import('tsx/esm/api');
const { publicReviewToWorkspace, publicReviewProjection } = await tsImport('../../viewer/src/public/public-workspace.ts', import.meta.url);
export { publicReviewProjection };

/**
 * Regressions this suite would have caught before a release: #110 (colorSchemes in execution.json), #112/#113/#115/#117
 * (dark-only base vs light + dark head), #121 (<route>@dark comment links), #123 (Viewer graph on a dark-only base), #130
 * (fully reused light + dark baseline).
 *
 * The round-trip suites (test/node/round-trip-*.test.mjs, three files so they run in parallel) share this:
 * every evidence shape the capture can produce travels the whole pipeline in-process:
 * capture → health → review → report export → PR comment → Viewer load. A validator that
 * does not know a shape fails here, not in a user's PR after a release.
 */
export async function roundTrip(t, options, { cachedBase = true, measure, agentSessionFactory, configure } = {}) {
  const f = await fixture(t, 'expo-router', options);
  configure?.(f.config);
  t.mock.method(globalThis, 'fetch', async input => assert.fail(`Unmocked network request: ${input}`));
  const environment = { ...f.environment, ...(options.agentMode ? { ANTHROPIC_API_KEY: 'fixture-private-provider-key' } : {}) };
  const progress = [];
  let baseline;
  if (cachedBase) {
    baseline = await runBaselineCi({ project: f.baseProject, sha: f.baseSha, output: join(f.root, 'baseline'), config: f.config, environment, runner: f.runner, now: f.now, sleep: f.sleep, progress: line => progress.push(`baseline: ${line}`), ...(agentSessionFactory ? { agentSessionFactory } : {}) });
    assert.equal(baseline.cached, true);
    environment.EXPLORE_CAPTURE_CACHE = baseline.directory;
  }
  const output = join(f.root, 'review');
  const result = await runPublicCi({ baseProject: f.baseProject, headProject: f.headProject, pullRequestPath: f.pullRequestPath, output, config: f.config,
    environment, transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep, progress: line => progress.push(line), ...(measure ? { measure } : {}), ...(agentSessionFactory ? { agentSessionFactory } : {}), ...(options.platform ? { platform: options.platform, platforms: [options.platform] } : {}) });
  const bundles = { base: await readCaptureBundle(join(output, 'base-export')), head: await readCaptureBundle(join(output, 'head-export')) };
  const packaged = await exportCiReport({ inputPath: result.inputPath, outputPath: join(f.root, 'artifact') });
  const report = JSON.parse(await readFile(join(packaged.outputPath, 'review.json'), 'utf8'));
  await publishCiReportComment({ inputPath: result.inputPath, artifactUrl: 'https://github.com/acme/example/actions/runs/1234/artifacts/900', environment, transport: f.transport });
  const comment = f.comments.at(-1).replaceAll('\\', '');
  const records = readCommentRecords(f.comments.at(-1));
  const workspace = publicReviewToWorkspace(report.review);
  const projection = publicReviewProjection(report.review);
  const surfaceIds = new Set(report.review.surfaces.map(surface => surface.id));
  for (const [, id] of comment.matchAll(/[?&]screen=([^&>)]+)/g)) {
    assert.ok(surfaceIds.has(decodeURIComponent(id)), `comment deep link ${id} names a report surface`);
  }
  for (const id of surfaceIds) assert.ok(projection.surfaces[id], `the Viewer projects surface ${id}`);
  return { f, result, baseline, progress, bundles, report, comment, records, workspace, projection };
}

export const schemesOf = bundle => [...bundleColorSchemes(bundle)];
export const screenIds = bundle => Object.keys(bundle.images).sort();


/** A fixture agent session that captures every selected target deterministically; `notes` decides the notes phase. */
export function agentSession({ notes }) {
  return (config, options) => ({
    provider: config.provider, model: config.model,
    preflight: async () => { await options.onUsage(usageReceipt({ totals: { inputTokens: 1, outputTokens: 1 }, models: [] })); },
    run: async request => {
      const signal = request.signal ?? new AbortController().signal;
      const context = JSON.parse(request.prompt);
      const call = async (name, input = {}) => {
        const response = await request.callTool(name, input, signal);
        return { response, result: JSON.parse(response.content.find(block => block.type === 'text').text) };
      };
      if (request.tools.some(tool => tool.name === 'submit_readiness')) {
        await request.callTool('submit_readiness', { imageSha256: context.imageSha256, ready: true, reason: 'Fixture screen is visible.' }, signal);
        return { inputTokens: 1, outputTokens: 1 };
      }
      if (request.tools.some(tool => tool.name === 'read_evidence')) return notes({ context, call, options });
      let observed = await call('observe');
      for (const target of context.selectedTargets) {
        if (!observed.result.currentTargets.some(current => current.id === target.id)) {
          await call('act', { action: 'open', url: `sample://${target.path.replace(/^\//, '')}` });
          observed = await call('observe');
        }
        await call('capture', { targetId: target.id, frameId: observed.result.frameId, description: 'Stable fixture screen', requiredLabels: ['screen-title'] });
        if (target !== context.selectedTargets.at(-1)) observed = await call('observe');
      }
      await call('finish', { procedureSummary: 'Captured every selected screen.' });
      await options.onUsage(usageReceipt());
      return { inputTokens: 100, outputTokens: 20 };
    },
  });
}

export async function publishRun(f, { pullRequestPath = f.pullRequestPath, headProject = f.headProject, runId, cache, platform, output }) {
  const environment = { ...f.environment, GITHUB_RUN_ID: runId, ...(cache ? { EXPLORE_CAPTURE_CACHE: cache } : {}) };
  const progress = [];
  const result = await runPublicCi({ baseProject: f.baseProject, headProject, pullRequestPath, output, config: f.config, environment,
    transport: f.transport, runner: f.runner, now: f.now, sleep: f.sleep, progress: line => progress.push(line), ...(platform ? { platform } : {}) });
  const packaged = await exportCiReport({ inputPath: result.inputPath, outputPath: `${output}-artifact` });
  const report = JSON.parse(await readFile(join(packaged.outputPath, 'review.json'), 'utf8'));
  await publishCiReportComment({ inputPath: result.inputPath, artifactUrl: `https://github.com/acme/example/actions/runs/${runId}/artifacts/${900 + Number(runId) - 1234}`, environment, transport: f.transport });
  return { result, report, progress, comment: f.comments.at(-1).replaceAll('\\', ''), records: readCommentRecords(f.comments.at(-1)) };
}

