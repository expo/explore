import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { parseExploreConfig } from '../../dist/config/explore-config.js';
import { buildVerifiedPlan } from '../../dist/ci/verified-plan.js';
import { revisionSetup } from '../../dist/capture/run.js';
import { runCiReview } from '../../dist/ci/pipeline.js';
import { createLocalCiAgentSession, localAgentEnvironment } from '../../dist/capture/agent/session-local.js';
import { renderPublicComment } from '../../dist/report/pr-comment-body.js';
import { prepareCaptureReview } from '../../dist/review/capture-review.js';
import { exportCiReport, writeCiReportInput } from '../../dist/report/artifact.js';
import { serializeCiError } from '../../dist/shared/ci-errors.js';
import { effectiveConfigText, loadScenario } from './lib/scenario.mjs';
import { checkExpectations, formatExpectations } from './lib/expectations.mjs';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = data => createHash('sha256').update(data).digest('hex');
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const json = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } });
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trimEnd();
};

/** Tracked and nonignored regular files of an app, including uncommitted edits. */
async function appFiles(source) {
  const files = new Map();
  for (const name of [...new Set(git(source, 'ls-files', '-c', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort()) {
    if (name.split('/').some(p => ['.git', 'node_modules', '.expo'].includes(p)) || name.startsWith('.expo-explore/local-')) continue;
    const from = resolve(source, name);
    if (relative(source, from).startsWith('..') || isAbsolute(name)) throw new Error('Source path escapes app');
    if (!await exists(from)) continue;
    const info = await lstat(from);
    if (!info.isFile()) throw new Error(`App snapshots require regular files: ${name}`);
    files.set(name, { from, executable: Boolean(info.mode & 0o111) });
  }
  return files;
}

/**
 * Freeze one app into a disposable two-commit history: base is the app, head is the app without
 * `removed` and with the `overlay` files on top. Never follows symlinks outside the sources.
 */
export async function snapshotApps({ app, work, instructions, removed = [], overlay }) {
  const repo = join(work, 'repository');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Explore local snapshot'); git(repo, 'config', 'user.email', 'local@explore.invalid');
  const baseFiles = await appFiles(app);
  for (const name of removed) if (!baseFiles.has(name)) throw new Error(`Scenario removes a file the app does not contain: ${name}`);
  const overlayFiles = new Map();
  for (const name of overlay?.files ?? []) {
    const from = resolve(overlay.root, name);
    if (relative(overlay.root, from).startsWith('..') || isAbsolute(name)) throw new Error('Overlay path escapes scenario');
    const info = await lstat(from);
    if (!info.isFile()) throw new Error(`Scenario overlays require regular files: ${name}`);
    const base = baseFiles.get(name);
    if (base && hash(await readFile(base.from)) === hash(await readFile(from))) throw new Error(`Scenario overlay leaves ${name} unchanged; remove it from the overlay`);
    overlayFiles.set(name, { from, executable: Boolean(info.mode & 0o111) });
  }
  const sides = {
    base: baseFiles,
    head: new Map([...[...baseFiles].filter(([name]) => !removed.includes(name)), ...overlayFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  const commits = {}, sources = {};
  for (const side of ['base', 'head']) {
    for (const entry of await readdir(repo)) if (entry !== '.git') await rm(join(repo, entry), { recursive: true, force: true });
    const inventory = {};
    for (const [name, file] of sides[side]) {
      const data = await readFile(file.from);
      const to = join(repo, name); await mkdir(dirname(to), { recursive: true }); await writeFile(to, data, { mode: file.executable ? 0o755 : 0o644 });
      inventory[name] = { sha256: hash(data), executable: file.executable };
    }
    if (!inventory['package.json']) throw new Error('App snapshot has no package.json');
    if (instructions) { await mkdir(join(repo, '.expo-explore'), { recursive: true }); await writeFile(join(repo, '.expo-explore/local-instructions.md'), instructions); }
    git(repo, 'add', '-A');
    if (instructions) git(repo, 'add', '-f', '.expo-explore/local-instructions.md');
    git(repo, 'commit', '-q', '--allow-empty', '-m', `Explore ${side} snapshot`);
    commits[side] = git(repo, 'rev-parse', 'HEAD');
    sources[side] = { path: relative(repository, app), digest: hash(JSON.stringify(inventory)), files: inventory };
  }
  sources.head.removed = [...removed];
  sources.head.overlay = [...overlayFiles.keys()];
  const projects = {};
  for (const side of ['base', 'head']) { projects[side] = join(work, side); git(repo, 'worktree', 'add', '--detach', projects[side], commits[side]); }
  return { projects, commits, sources };
}

export async function writeUsageSummary(run) {
  const file = join(run, 'artifacts/capture/agent-usage.jsonl');
  const receipts = (await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })).trim().split('\n').filter(Boolean).map(JSON.parse);
  const estimates = receipts.flatMap(({ receipt }) => Number.isFinite(receipt.totals.estimatedCostUsd) ? [receipt.totals.estimatedCostUsd] : []);
  const rows = receipts.map(({ phase, receipt: r }) => `| ${phase} | ${r.source} | ${r.model} | ${r.accounting}${r.unavailableReason ? ` (${r.unavailableReason})` : ''} | ${r.totals.inputTokens ?? 'unknown'} | ${r.totals.outputTokens ?? 'unknown'} | ${r.totals.cacheReadInputTokens ?? 'unknown'} | ${r.totals.cacheCreationInputTokens ?? 'unknown'} | ${r.totals.thinkingTokens ?? 'unknown'} | ${r.totals.estimatedCostUsd?.toFixed(6) ?? 'unknown'} |`);
  const tolerated = receipts.flatMap(({ phase, receipt }) => (receipt.toleratedUnknownTools ?? []).map((name, index) => {
    const later = receipt.registeredCallsAfterUnknownTools?.[index];
    return `${phase}: ${name}${Number.isInteger(later) ? ` (${later} registered tool calls followed)` : ''}`;
  }));
  await writeFile(join(run, 'agent-mode-cost.md'), ['# Agent usage', '', 'CLI estimates are not subscription charges. Cached input and cache creation are reported separately. Thinking is already included in output tokens; do not add it again. Missing accounting is unknown; failed runs are never assumed free.', '',
    '| Phase | Source | Model | Accounting | Input | Output | Cached input | Cache creation | Thinking (within output) | Estimated USD |', '|---|---|---|---|---|---|---|---|---|---|', ...rows, '',
    estimates.length ? `Reported estimates total: $${estimates.reduce((sum, value) => sum + value, 0).toFixed(6)}. Receipts without a cost estimate: ${receipts.length - estimates.length}.` : 'Total estimated cost: unknown (no reported estimates).', '',
    `Tolerated unknown tool calls: ${tolerated.length ? tolerated.join(', ') : 'none'}.`, '',
    receipts.length ? 'Detailed receipts: artifacts/capture/agent-usage.jsonl. EAS charges are not included.' : 'No provider receipt was retained. Consult run.json to distinguish a request that was never started from unavailable accounting.', ''].join('\n'));
}

export async function zipReport(directory, output) {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  async function add(root, prefix = '') {
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(root, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) await add(path, name + '/');
      else await writer.add(name, new Uint8ArrayReader(await readFile(path)));
    }
  }
  await add(directory); await writeFile(output, await writer.close());
}

/** Run one npm command in an app snapshot as its own process group; cancellation stops the group. */
async function runAppNpm(project, args, logfile, signal, environment) {
  signal.throwIfAborted();
  const label = args[0] === 'run' ? `npm run ${args[1]}` : `npm ${args[0]}`;
  const child = spawn('npm', args, {
    cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const output = [];
  let timer, failure, bytes = 0;
  const kill = kind => { try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, kind); else child.kill(kind);
  } catch { /* Already exited. */ } };
  const stop = () => { kill('SIGTERM'); timer ??= setTimeout(() => kill('SIGKILL'), 2000); };
  const collect = chunk => {
    bytes += chunk.length;
    if (bytes <= 16 * 1024 * 1024) output.push(chunk);
    else { failure ??= new Error(`App ${label} output exceeded 16 MiB; retained log is truncated.`); stop(); }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => signal.aborted ? reject(signal.reason) : failure ? reject(failure)
        : code === 0 ? resolve() : reject(new Error(`App ${label} exited ${code}; see ${logfile}`)));
    });
  } finally {
    signal.removeEventListener('abort', stop);
    if (timer) clearTimeout(timer);
    kill('SIGKILL'); // Also stop descendants after a parent exits successfully or on cancellation.
    let text = Buffer.concat(output).toString('utf8');
    for (const [key, value] of Object.entries(environment)) if (/TOKEN|SECRET|PASSWORD|KEY/.test(key) && value) text = text.replaceAll(value, '[REDACTED]');
    await writeFile(logfile, text);
  }
}

export function installApp(project, logfile, signal, environment = process.env) {
  // Match the review workflow template's install so local results predict production CI.
  return runAppNpm(project, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], logfile, signal, environment);
}

/**
 * Run the app's own `typecheck` script, when it has one. A scenario's overlay files exist only in
 * the materialized head, so this is where they are compiled; a head that does not typecheck fails
 * here instead of in a native build. Returns whether a script ran.
 */
export async function typecheckApp(project, logfile, signal, environment = process.env) {
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  if (typeof manifest.scripts?.typecheck !== 'string') return false;
  await runAppNpm(project, ['run', 'typecheck'], logfile, signal, environment);
  return true;
}

export async function runLocalCi(input) {
  const runId = input.runId ?? `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(runId)) throw new Error('Invalid run id');
  const run = join(repository, 'test/ci/runs', runId);
  await mkdir(dirname(run), { recursive: true }); await mkdir(run); // Exclusive creation; never overwrite evidence.
  const artifacts = join(run, 'artifacts'), output = join(artifacts, 'capture');
  await mkdir(join(run, 'inputs')); await mkdir(join(artifacts, 'logs'), { recursive: true }); await mkdir(output);
  const metadata = { contract: 'explore.local-run.v1', runId, status: 'preparing', startedAt: new Date().toISOString(),
    requested: { app: input.app, scenario: input.scenario, mode: input.mode ?? 'deterministic', ...(input.scope ? { scope: input.scope } : {}), planOnly: Boolean(input.planOnly) },
    report: null, node: process.version };
  await json(join(run, 'request.json'), metadata.requested); await json(join(run, 'run.json'), metadata);
  await writeFile(join(run, 'issues.md'), '# Run findings\n\nRecord observations here; file confirmed shared CI defects as GitHub issues.\n');
  // The CLI owns this process; declare its retained disposable work root for CI path guards.
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = artifacts;
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Local CI cancelled'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let state, snapshot, config, scenario;
  const update = async () => {
    if (state) { metadata.capture = state.capture; metadata.phase = metadata.status === 'planned' ? 'plan-complete' : state.phase;
      await writeFile(join(run, 'PR-comment.md'), metadata.status === 'planned'
        ? `# Local CI planning complete\n\nRun: ${runId}\n\nBase: ${metadata.plan.baseCaptures} selected captures. Head: ${metadata.plan.headCaptures} selected captures.\n\nNo model, build, or simulator was started.\n` : renderPublicComment(state)); }
    await json(join(run, 'run.json'), metadata);
    await appendFile(join(artifacts, 'logs/events.jsonl'), JSON.stringify({ at: new Date().toISOString(), status: metadata.status, phase: metadata.phase, capture: metadata.capture }) + '\n');
  };
  console.log(`Local CI run: ${relative(repository, run)}`);
  try {
    const app = await realpath(resolve(input.app));
    scenario = await loadScenario(input.scenario, { mode: input.mode });
    for (const path of [app, scenario.root]) if (relative(repository, path).startsWith('..') || path === repository) throw new Error('Select an app and a scenario inside this repository');
    if (!relative(app, scenario.root).startsWith('..')) throw new Error('Keep the scenario outside the app directory; the app snapshot would include it');
    metadata.scenario = { path: relative(repository, scenario.root), description: scenario.description,
      config: relative(repository, scenario.configPath), removed: scenario.removed.length, overlay: scenario.overlay.files.length };
    await json(join(run, 'inputs/scenario.json'), { description: scenario.description, removed: scenario.removed, overlay: scenario.overlay.files,
      ...(Object.keys(scenario.setup).length ? { setup: scenario.setup } : {}) });
    if (scenario.expected) await json(join(run, 'inputs/expected.json'), scenario.expected);
    await writeFile(join(run, 'inputs/config.yaml'), scenario.rawConfig);
    config = parseExploreConfig(effectiveConfigText(scenario.rawConfig, { mode: input.mode ?? 'deterministic', scope: input.scope, setup: scenario.setup }));
    let instructions;
    if (config.agent?.instructions) {
      instructions = await readFile(resolve(dirname(scenario.configPath), config.agent.instructions), 'utf8');
      await writeFile(join(run, 'inputs/instructions.md'), instructions);
      config.agent.instructions = '.expo-explore/local-instructions.md';
    }
    await writeFile(join(run, 'inputs/effective-config.yaml'), stringify(config));
    snapshot = await snapshotApps({ app, work: join(artifacts, 'work'), instructions, removed: scenario.removed, overlay: scenario.overlay });
    await json(join(run, 'inputs/sources.json'), snapshot.sources);
    metadata.commits = snapshot.commits;
    metadata.toolsCommit = git(repository, 'rev-parse', 'HEAD');
    const toolSource = join(artifacts, 'tool-source'); await mkdir(toolSource);
    for (const path of ['src', 'viewer', 'scripts', 'schema', 'tsconfig.json', 'package.json', 'package-lock.json', 'test/ci/run.mjs', 'test/ci/view.mjs', 'test/ci/lib']) {
      await cp(join(repository, path), join(toolSource, path), { recursive: true, filter: p => !p.split('/').some(c => ['node_modules', 'dist', '.vite'].includes(c)) });
    }
    const toolFiles = {};
    async function inventoryTools(root) {
      for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) await inventoryTools(path);
        else toolFiles[relative(toolSource, path)] = hash(await readFile(path));
      }
    }
    await inventoryTools(toolSource);
    metadata.toolsSourceDigest = hash(JSON.stringify(toolFiles));
    await json(join(artifacts, 'tool-source.json'), toolFiles);
    metadata.toolsDiffDigest = hash(git(repository, 'diff', '--binary', 'HEAD', '--', 'src', 'viewer', 'scripts', 'package.json', 'package-lock.json'));
    const versions = {};
    for (const command of ['claude', 'codex']) {
      const version = spawnSync(command, ['--version'], { env: localAgentEnvironment(process.env), encoding: 'utf8', timeout: 10_000 });
      versions[command] = version.status === 0 ? version.stdout.trim() : 'unavailable';
    }
    metadata.cliVersions = versions;
    const presentation = { origin: 'local', repository: `local/${config.app.name?.replace(/[^A-Za-z0-9_-]/g, '-') || 'app'}`, runId,
      title: config.app.name ?? 'Local app comparison', base: { ref: 'base', sha: snapshot.commits.base }, head: { ref: 'head', sha: snapshot.commits.head } };
    state = { phase: 'pending', pullRequest: presentation, mode: config.exploration.scope, executionMode: config.mode,
      configPath: 'inputs/config.yaml', links: { viewer: null, download: null, run: '', config: '', artifacts: '' }, startedAt: Date.now(), updatedAt: Date.now(), artifactOnly: true };
    await update();
    if (input.planOnly) {
      const plan = await buildVerifiedPlan({ baseProject: snapshot.projects.base, headProject: snapshot.projects.head, baseSha: snapshot.commits.base,
        headSha: snapshot.commits.head, config, output });
      metadata.plan = { baseCaptures: plan.baseCaptureSurfaceIds.length, headCaptures: plan.headCaptureSurfaceIds.length };
      // Capture validates setup routes per revision; do it here so a bad config fails before any EAS work.
      for (const side of ['base', 'head']) revisionSetup(config.setup ?? [], plan, side);
      if (scenario.expected) metadata.expectations = checkExpectations({ surfaces: plan.surfaces, expected: scenario.expected, level: 'plan' });
      metadata.status = 'planned';
    } else {
      const require = createRequire(import.meta.url);
      const { default: SessionManager } = require('eas-cli-preview/build/user/SessionManager.js');
      const session = new SessionManager({ logEvent() {}, setActor() {}, async flushAsync() {} });
      const localLogin = !process.env.EXPO_TOKEN && Boolean(session.getSessionSecret());
      metadata.status = 'running'; await update();
      const environment = { ...process.env, TOOLS_COMMIT: `${metadata.toolsCommit}:${metadata.toolsSourceDigest}:${JSON.stringify(versions)}` };
      delete environment.EXPLORE_CAPTURE_CACHE; // Acceptance exercises both fresh sides.
      await runCiReview({ projects: snapshot.projects, output, config, presentation, runId, runAttempt: '1', state, environment,
        subscription: true, useLocalEasSession: localLogin,
        prepareCapture: async () => {
          metadata.status = 'installing'; await update();
          for (const side of ['head', 'base']) await installApp(snapshot.projects[side], join(artifacts, `logs/install-${side}.log`), abort.signal);
          metadata.typecheck = {};
          for (const side of ['head', 'base']) {
            metadata.typecheck[side] = await typecheckApp(snapshot.projects[side], join(artifacts, `logs/typecheck-${side}.log`), abort.signal) ? 'passed' : 'no script';
          }
          const availability = spawnSync(process.execPath, [join(repository, 'node_modules/eas-cli-preview/bin/run'), 'simulator:availability', '--json', '--non-interactive'],
            { cwd: snapshot.projects.head, env: process.env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
          if (availability.status !== 0) throw new Error('EAS Simulator availability check failed; verify project access with eas simulator:availability --json in the app checkout.');
          const access = JSON.parse(availability.stdout);
          metadata.easSimulatorAvailable = access.available === true;
          if (!metadata.easSimulatorAvailable) throw new Error('EAS Simulator is not enabled for the selected app account.');
          metadata.status = 'running'; await update();
        },
        agentSessionFactory: (configuration, options) => {
          const provider = createLocalCiAgentSession(configuration, options);
          return { ...provider, preflight: options => provider.preflight({ ...options, signal: abort.signal }),
            run: request => provider.run({ ...request, signal: request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal }) };
        },
        assertCurrentHead: async () => { abort.signal.throwIfAborted(); for (const side of ['base', 'head']) {
          if (git(snapshot.projects[side], 'rev-parse', 'HEAD') !== snapshot.commits[side] || git(snapshot.projects[side], 'status', '--porcelain')) throw new Error('App snapshot changed during capture');
        } }, postComment: update });
      metadata.status = 'passed'; state.phase = 'ready';
    }
  } catch (error) {
    metadata.status = abort.signal.aborted ? 'cancelled' : 'failed';
    metadata.error = serializeCiError(error, { secrets: Object.entries(process.env).filter(([k]) => /TOKEN|SECRET|PASSWORD|KEY/.test(k)).flatMap(([,v]) => v ? [v] : []) });
    if (state) { state.phase = 'failed'; state.failure ??= { step: metadata.phase ?? 'preflight', message: `${metadata.error.code}: ${metadata.error.message}` }; }
    console.error(`${metadata.status}: ${metadata.error.code}: ${metadata.error.message}`);
  } finally {
    try {
      // A side may export partial evidence before throwing. Freeze its real count
      // before serializing the report so the archive and run summary agree.
      if (state?.capture) for (const side of ['base', 'head']) {
        const bundlePath = join(output, `${side}-export/bundle.json`);
        if (await exists(bundlePath)) state.capture.done[side] = Object.keys(JSON.parse(await readFile(bundlePath, 'utf8')).images ?? {}).length;
      }
      if (state?.capture) delete state.capture.current;
      const inputPath = join(output, 'report-input.json');
      if (!input.planOnly && !await exists(inputPath) && state && await exists(join(output, 'execution-plan.json'))) {
        const plan = JSON.parse(await readFile(join(output, 'execution-plan.json'), 'utf8'));
        for (const side of ['base','head']) {
          const directory = join(output, `${side}-export`); await mkdir(directory, { recursive: true });
          if (!await exists(join(directory, 'bundle.json'))) await json(join(directory, 'bundle.json'), {
            contract: 'explore.bundle', side, gitCommit: plan[`${side}Sha`], easBuildId: null, easProjectId: null,
            completedAt: new Date().toISOString(), profile: `${config.app.easProfile}:${config.app.bundleId}`,
            selectedSurfaceIds: plan[`${side}CaptureSurfaceIds`], images: {}, outcomes: Object.fromEntries(plan[`${side}CaptureSurfaceIds`].map(id => [id,
              { status: 'failed', landing: 'unverified', attempts: 0, reason: 'Run ended before this target produced evidence.' }])) });
        }
        const review = await prepareCaptureReview({ plan, pullRequest: state.pullRequest, runId, runAttempt: '1',
          baseDirectory: join(output, 'base-export'), headDirectory: join(output, 'head-export'), assertCurrentHead: async () => {} });
        state.review = review.review;
        await writeCiReportInput({ inputPath, publicReview: review.review, assets: review.assets, commentState: state });
      }
      if (await exists(inputPath)) {
        const reportDir = join(artifacts, 'report'); await exportCiReport({ inputPath, outputPath: reportDir });
        const zip = join(artifacts, 'report.zip'); await zipReport(reportDir, zip);
        metadata.report = { path: 'artifacts/report.zip', sha256: hash(await readFile(zip)) };
        if (scenario?.expected) {
          const report = JSON.parse(await readFile(join(reportDir, 'review.json'), 'utf8'));
          metadata.expectations = checkExpectations({ surfaces: report.review.surfaces, expected: scenario.expected, level: 'report' });
        }
      }
    } catch (error) { metadata.reportError = serializeCiError(error); if (metadata.status === 'passed') { metadata.status = 'failed'; if (state) { state.phase = 'failed'; state.failure = { step: 'report', message: metadata.reportError.message }; } } }
    if (metadata.expectations?.status === 'failed') await appendFile(join(run, 'issues.md'), `\n## Expectation mismatch\n\n${formatExpectations(metadata.expectations)}\n\nDecide whether the CI result or the scenario's expected.json is wrong before changing either.\n`);
    if (metadata.error) await appendFile(join(run, 'issues.md'), `\n## Execution failure\n\nCode: ${metadata.error.code}\n\n${metadata.error.message}\n\nNext action: ${metadata.error.nextAction ?? 'Inspect the retained diagnostics.'}\n\nClassify the cause before linking a shared CI defect; a run failure alone does not establish a CI bug.\n`);
    metadata.completedAt = new Date().toISOString();
    await writeUsageSummary(run); await update();
    if (!state) await writeFile(join(run, 'PR-comment.md'), `# Local CI ${metadata.status}\n\n${metadata.error?.message ?? 'No capture was started.'}\n`);
    await writeFile(join(run, 'README.md'), `# ${runId}\n\nStatus: **${metadata.status}**\n\n${metadata.error?.message ?? ''}\n\n${metadata.scenario ? `Scenario: \`${metadata.scenario.path}\` (${metadata.scenario.description}) · mode ${config?.mode ?? input.mode ?? 'deterministic'} · scope ${config?.exploration.scope ?? input.scope ?? 'default'}\n\n` : ''}${metadata.expectations || scenario?.expected ? `${formatExpectations(metadata.expectations, { declared: Boolean(scenario?.expected) })}\n\n` : ''}Inputs: [scenario](inputs/scenario.json), [config](inputs/config.yaml), [resolved config](inputs/effective-config.yaml)${scenario?.expected ? ', [expected](inputs/expected.json)' : ''}.\n\n[Summary](PR-comment.md) · [Usage](agent-mode-cost.md) · [Issues](issues.md)\n\n${metadata.report ? `View: \`npm run ci:local:view -- --run test/ci/runs/${runId}\`\n\nArchive: [report.zip](artifacts/report.zip). Generated artifacts are local and ignored by Git; retain this original ZIP when moving machines.` : `No report was produced. ${metadata.reportError?.message ?? (input.planOnly ? 'This was a planning-only run.' : 'See run.json and artifacts/logs.')}`}\n`);
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = previousRunnerTemp;
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
  return { run, metadata };
}

export const USAGE = 'Usage: npm run ci:local -- --app APP --scenario SCENARIO [--mode deterministic|agent] [--scope all|changes] [--run-id ID] [--plan-only]';

export function parseRunArguments(args) {
  const { values } = parseArgs({ args, options: { app: { type: 'string' }, scenario: { type: 'string' }, mode: { type: 'string' }, scope: { type: 'string' },
    'run-id': { type: 'string' }, 'plan-only': { type: 'boolean' } } });
  if (!values.app || !values.scenario) throw new Error(USAGE);
  if (values.mode && !['deterministic', 'agent'].includes(values.mode)) throw new Error('--mode must be deterministic or agent');
  if (values.scope && !['all', 'changes'].includes(values.scope)) throw new Error('--scope must be all or changes');
  return { app: values.app, scenario: values.scenario, mode: values.mode ?? 'deterministic', ...(values.scope ? { scope: values.scope } : {}),
    runId: values['run-id'], planOnly: values['plan-only'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { metadata } = await runLocalCi(parseRunArguments(process.argv.slice(2)));
  if (['failed', 'cancelled'].includes(metadata.status) || metadata.expectations?.status === 'failed') process.exitCode = 1;
}
