// Re-run comparison, notes, and report export for a retained local CI run from its captured
// evidence, without building, capturing, or starting a simulator. Writes a new report beside the
// original one; the run's recorded inputs, captures, and report are never modified.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { assessPublicEvidence, readExportedMap } from '../../dist/review/evidence-assessment.js';
import { systemRegions } from '../../dist/contracts/capture.js';
import { prepareCaptureReview, readCaptureBundle } from '../../dist/review/capture-review.js';
import { parseRuntimeExecutionContext } from '../../dist/review/runtime-adapter.js';
import { generateAgentChangeNotes } from '../../dist/capture/agent/change-notes.js';
import { createLocalCiAgentSession } from '../../dist/capture/agent/session-local.js';
import { exportCiReport, writeCiReportInput } from '../../dist/report/artifact.js';
import { renderPublicComment } from '../../dist/report/pr-comment-body.js';
import { repository, zipReport } from './run.mjs';
import { checkExpectations, formatExpectations } from './lib/expectations.mjs';

async function side(directory) {
  return { directory, bundle: await readCaptureBundle(directory), map: await readExportedMap(directory),
    execution: parseRuntimeExecutionContext(JSON.parse(await readFile(join(directory, 'execution.json'), 'utf8'))) };
}

export async function recompare(runDirectory) {
  const run = resolve(runDirectory), capture = join(run, 'artifacts/capture');
  const config = parse(await readFile(join(run, 'inputs/effective-config.yaml'), 'utf8'));
  const plan = JSON.parse(await readFile(join(capture, 'execution-plan.json'), 'utf8'));
  const previous = JSON.parse(await readFile(join(capture, 'report-input.json'), 'utf8'));
  const existing = (await readdir(join(run, 'artifacts'))).filter(name => /^recompare-\d+$/.test(name)).length;
  const label = `recompare-${existing + 1}`;
  const sides = { base: await side(join(capture, 'base-export')), head: await side(join(capture, 'head-export')) };
  // The run's own device and pose, as its comparison had them: a foldable's rail pill, or the platform's bands.
  const system = systemRegions({ platform: config.app.platform, device: config.device.name, pose: config.device.pose });
  const evidence = await assessPublicEvidence({ platform: config.app.platform, systemRegions: system, plan, ...sides, profile: `${config.app.easProfile}:${config.app.bundleId}`,
    agentDeviceCommand: join(repository, 'node_modules/.bin/agent-device') });
  const state = { ...previous.commentState };
  let { review, assets } = await prepareCaptureReview({ plan, pullRequest: state.pullRequest,
    baseDirectory: sides.base.directory, headDirectory: sides.head.directory, systemRegions: system, runId: previous.publicReview.runId,
    runAttempt: previous.publicReview.runAttempt, assertCurrentHead: async () => {}, assessments: evidence.surfaces,
    app: { ...(state.build?.appVersion ? { version: state.build.appVersion } : {}),
      ...(state.build?.appBuildNumber ? { buildNumber: state.build.appBuildNumber } : {}) } });
  if (config.mode === 'agent') {
    const provider = createLocalCiAgentSession(config.agent, { onUsage: () => {} });
    await provider.preflight();
    review = (await generateAgentChangeNotes({ review, assets, provider, deadlineMs: Date.now() + 10 * 60_000 })).review;
  }
  // The saved comment state predates the final phase update; a completed recomparison is ready.
  Object.assign(state, { review, evidence: evidence.summary, phase: 'ready' });
  // Asset paths are relative to the capture directory, so the new input lives there too.
  const inputPath = join(capture, `report-input-${label}.json`);
  await writeCiReportInput({ inputPath, publicReview: review, assets, commentState: state, onboarding: previous.onboarding });
  const output = join(run, 'artifacts', label);
  await mkdir(output);
  await exportCiReport({ inputPath, outputPath: join(output, 'report') });
  await zipReport(join(output, 'report'), join(output, 'report.zip'));
  // Re-judge the scenario's expectations against the new report; the original run.json stays as recorded.
  const expected = await readFile(join(run, 'inputs/expected.json'), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const expectations = expected && checkExpectations({ surfaces: review.surfaces, expected, level: 'report' });
  if (expectations) await writeFile(join(output, 'expectations.json'), JSON.stringify(expectations, null, 2) + '\n');
  return { zip: join(output, 'report.zip'), comment: renderPublicComment(state), summary: evidence.summary, expectations };
}

if (process.argv[1] && import.meta.url.endsWith('/recompare.mjs') && resolve(process.argv[1]).endsWith('recompare.mjs')) {
  const { values } = parseArgs({ options: { run: { type: 'string' } } });
  if (!values.run) throw new Error('Usage: node test/ci/recompare.mjs --run test/ci/runs/<run-id>');
  const result = await recompare(values.run);
  process.stdout.write(`${result.comment}\n${result.expectations ? `${formatExpectations(result.expectations)}\n` : ''}Report: ${result.zip}\nView: npm run ci:local:view -- --zip ${result.zip}\n`);
  if (result.expectations?.status === 'failed') process.exitCode = 1;
}
