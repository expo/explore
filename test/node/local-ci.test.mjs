import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { tsImport } from 'tsx/esm/api';
import { snapshotApps, writeUsageSummary, installApp, typecheckApp, parseRunArguments } from '../ci/run.mjs';
import { effectiveConfigText, loadScenario } from '../ci/lib/scenario.mjs';
import { checkExpectations, formatExpectations, routePattern } from '../ci/lib/expectations.mjs';
import { cellPassed, existingRuns, matrixTable, parseMatrixArguments, reportedCost } from '../ci/lib/matrix-cells.mjs';
import { standaloneReportFixture } from '../helpers/standalone-report-fixture.mjs';
const { projectReviewPresentation } = await tsImport('../../src/contracts/review.ts', import.meta.url);
const { assertPublicReview } = await tsImport('../../src/contracts/review-validation.ts', import.meta.url);
const { localAgentEnvironment } = await tsImport('../../src/capture/agent/session-local.ts', import.meta.url);
const { createLocalCiAgentSession } = await import('../../dist/capture/agent/session-local.js');
const local = { origin: 'local', repository: 'local/app', runId: 'auth-run-1', title: 'App', base: { ref: 'base', sha: 'a'.repeat(40) }, head: { ref: 'head', sha: 'b'.repeat(40) } };

test('local identity is exact, has no GitHub fields, and binds run and attempt', async t => {
  assert.deepEqual(projectReviewPresentation(local), local);
  for (const extra of [{ number: 1 }, { url: 'https://github.com/local/app/pull/1' }, { runId: '../escape' }]) assert.throws(() => projectReviewPresentation({ ...local, ...extra }));
  const fixture = await standaloneReportFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const review = { ...fixture.publicReview, pullRequest: local, runId: local.runId };
  delete review.surfaces[0].sourceChange;
  assert.doesNotThrow(() => assertPublicReview(review));
  assert.throws(() => assertPublicReview({ ...review, runId: 'another-run' }));
  assert.throws(() => assertPublicReview({ ...review, runAttempt: '2' }));
});

test('source snapshots freeze edits and ignore generated files without mutating the app', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-snapshot-')); t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app'); await mkdir(app);
  assert.equal(spawnSync('git', ['init', '-q', app]).status, 0);
  await writeFile(join(app, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(app, '.gitignore'), 'generated\n'); await writeFile(join(app, 'generated'), 'omit');
  await writeFile(join(app, 'source.txt'), 'dirty source');
  const a = await snapshotApps({ app, work: join(root, 'first'), instructions: 'Inspect the app.' });
  const b = await snapshotApps({ app, work: join(root, 'second'), instructions: 'Inspect the app.' });
  assert.deepEqual(a.commits, b.commits);
  assert.notEqual(a.commits.base, a.commits.head);
  assert.equal(a.sources.head.files.generated, undefined);
  assert.equal(await readFile(join(a.projects.head, 'source.txt'), 'utf8'), 'dirty source');
  await writeFile(join(app, 'source.txt'), 'changed after snapshot');
  assert.equal(await readFile(join(a.projects.head, 'source.txt'), 'utf8'), 'dirty source');
  await symlink('/etc/hosts', join(app, 'escape'));
  await assert.rejects(snapshotApps({ app, work: join(root, 'third') }), /regular files/);
});

async function scenarioFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-scenario-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const app = join(root, 'app'); await mkdir(join(app, 'src'), { recursive: true });
  await writeFile(join(app, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(app, 'src/keep.ts'), 'keep'); await writeFile(join(app, 'src/change.ts'), 'before'); await writeFile(join(app, 'src/drop.ts'), 'drop');
  const scenario = join(root, 'scenarios/app/change'); await mkdir(join(scenario, 'overlay/src'), { recursive: true });
  await writeFile(join(scenario, 'overlay/src/change.ts'), 'after'); await writeFile(join(scenario, 'overlay/src/add.ts'), 'added');
  await writeFile(join(scenario, 'scenario.json'), JSON.stringify({ description: 'Change one file, add one, drop one.', removed: ['src/drop.ts'] }));
  await writeFile(join(scenario, 'expected.json'), JSON.stringify({ surfaces: { '/add': 'added' }, others: 'unchanged' }));
  await writeFile(join(root, 'scenarios/app/deterministic.yaml'), 'mode: deterministic\nexploration:\n  scope: all\n');
  return { root, app, scenario };
}

test('scenario overlays derive head from one app: removed files go, overlay files replace or add', async t => {
  const { root, app, scenario } = await scenarioFixture(t);
  const loaded = await loadScenario(scenario);
  assert.deepEqual(loaded.removed, ['src/drop.ts']);
  assert.deepEqual(loaded.overlay.files, ['src/add.ts', 'src/change.ts']);
  assert.match(loaded.configPath, /scenarios\/app\/deterministic\.yaml$/);
  assert.deepEqual(loaded.expected, { surfaces: { '/add': 'added' }, others: 'unchanged' });
  const snapshot = await snapshotApps({ app, work: join(root, 'work'), removed: loaded.removed, overlay: loaded.overlay });
  assert.notEqual(snapshot.commits.base, snapshot.commits.head);
  assert.equal(await readFile(join(snapshot.projects.base, 'src/change.ts'), 'utf8'), 'before');
  assert.equal(await readFile(join(snapshot.projects.base, 'src/drop.ts'), 'utf8'), 'drop');
  assert.equal(await readFile(join(snapshot.projects.head, 'src/change.ts'), 'utf8'), 'after');
  assert.equal(await readFile(join(snapshot.projects.head, 'src/add.ts'), 'utf8'), 'added');
  await assert.rejects(readFile(join(snapshot.projects.head, 'src/drop.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(snapshot.projects.head, 'src/keep.ts'), 'utf8'), 'keep');
  assert.deepEqual(snapshot.sources.head.removed, ['src/drop.ts']);
  assert.deepEqual(snapshot.sources.head.overlay, ['src/add.ts', 'src/change.ts']);
  assert.equal(snapshot.sources.base.files['src/add.ts'], undefined);
  assert.equal(await readFile(join(app, 'src/change.ts'), 'utf8'), 'before'); // The app itself is never modified.
  const empty = await snapshotApps({ app, work: join(root, 'identical') });
  assert.notEqual(empty.commits.base, empty.commits.head);
  assert.equal(empty.sources.base.digest, empty.sources.head.digest);
});

test('scenario overlays reject no-op files, unknown removals and symlinks', async t => {
  const { root, app, scenario } = await scenarioFixture(t);
  const loaded = await loadScenario(scenario);
  await assert.rejects(snapshotApps({ app, work: join(root, 'missing'), removed: ['src/absent.ts'], overlay: loaded.overlay }), /does not contain: src\/absent\.ts/);
  await writeFile(join(scenario, 'overlay/src/keep.ts'), 'keep');
  await assert.rejects(snapshotApps({ app, work: join(root, 'noop'), overlay: (await loadScenario(scenario)).overlay }), /leaves src\/keep\.ts unchanged/);
  await rm(join(scenario, 'overlay/src/keep.ts'));
  await symlink('/etc/hosts', join(scenario, 'overlay/src/link.ts'));
  await assert.rejects(snapshotApps({ app, work: join(root, 'link'), overlay: (await loadScenario(scenario)).overlay }), /regular files/);
  await rm(join(scenario, 'overlay/src/link.ts'));
  await writeFile(join(scenario, 'scenario.json'), JSON.stringify({ description: 'Escape', removed: ['../outside.ts'] }));
  await assert.rejects(loadScenario(scenario), /must stay inside the app/);
  await writeFile(join(scenario, 'scenario.json'), JSON.stringify({ description: 'Both', removed: ['src/change.ts'] }));
  await assert.rejects(loadScenario(scenario), /both removes and overlays src\/change\.ts/);
  await writeFile(join(scenario, 'scenario.json'), JSON.stringify({ description: 'Typo', remove: [] }));
  await assert.rejects(loadScenario(scenario), /unknown field: remove/);
  await writeFile(join(scenario, 'scenario.json'), JSON.stringify({ description: 'Fine' }));
  await writeFile(join(scenario, 'expected.json'), JSON.stringify({ surfaces: { '/add': 'changed' } }));
  await assert.rejects(loadScenario(scenario), /unknown status: changed/);
  await assert.rejects(loadScenario(scenario, { mode: 'agent' }), /No agent\.yaml/);
});

test('a scenario config keeps its text unless the run overrides the scope', () => {
  const raw = 'mode: deterministic\n# kept\nexploration:\n  scope: all\n';
  assert.equal(effectiveConfigText(raw, { mode: 'deterministic' }), raw);
  assert.match(effectiveConfigText(raw, { mode: 'deterministic', scope: 'changes' }), /scope: changes/);
  assert.throws(() => effectiveConfigText(raw, { mode: 'agent' }), /declares mode deterministic/);
  assert.throws(() => effectiveConfigText(raw, { scope: 'some' }), /--scope must be one of all, changes/);
  assert.deepEqual(parseRunArguments(['--app', 'a', '--scenario', 's']), { app: 'a', scenario: 's', mode: 'deterministic', runId: undefined, planOnly: undefined });
  assert.equal(parseRunArguments(['--app', 'a', '--scenario', 's', '--mode', 'agent', '--scope', 'changes']).scope, 'changes');
  assert.throws(() => parseRunArguments(['--app', 'a']), /Usage/);
  assert.throws(() => parseRunArguments(['--app', 'a', '--scenario', 's', '--mode', 'keyed']), /--mode/);
});

test('scenario setup slots fill a shared config, and a slot the config does not have fails', async t => {
  const raw = 'mode: deterministic\nsetup:\n  - action: open\n    url: app://a\n  - include: signed-out\n  - action: open\n    url: app://b\n';
  const urls = text => parse(text).setup.map(step => step.url);
  assert.deepEqual(urls(effectiveConfigText(raw, { mode: 'deterministic' })), ['app://a', 'app://b']);
  const setup = { 'signed-out': [{ action: 'open', url: 'app://extra', requiresRoute: '/extra' }] };
  assert.deepEqual(urls(effectiveConfigText(raw, { setup })), ['app://a', 'app://extra', 'app://b']);
  assert.equal(parse(effectiveConfigText(raw, { setup, scope: 'changes' })).exploration.scope, 'changes');
  assert.throws(() => effectiveConfigText(raw, { setup: { 'signed-in': setup['signed-out'] } }), /no setup slot for: signed-in/);
  // An agent config has no setup; a scenario's slots do not apply to it.
  const agent = 'mode: agent\nagent:\n  instructions: instructions.md\n';
  assert.equal(effectiveConfigText(agent, { mode: 'agent', setup }), agent);
  const { scenario } = await scenarioFixture(t);
  assert.deepEqual((await loadScenario(scenario)).setup, {});
  await writeFile(join(scenario, 'setup.yaml'), 'signed-out:\n  - action: open\n    url: app://extra\n');
  assert.deepEqual((await loadScenario(scenario)).setup, { 'signed-out': [{ action: 'open', url: 'app://extra' }] });
  for (const invalid of ['- action: open\n', 'signed-out: []\n', 'signed-out:\n  - include: other\n']) {
    await writeFile(join(scenario, 'setup.yaml'), invalid);
    await assert.rejects(loadScenario(scenario), /setup\.yaml/);
  }
});

const route = (logicalPath, extra = {}) => ({ id: `expo-${logicalPath}`, logicalPath, route: logicalPath, kind: 'screen', ...extra });

test('expectations compare report statuses by route pattern and never pass missing evidence', () => {
  assert.equal(routePattern('/(app)/(tabs)/home'), '/home');
  assert.equal(routePattern('/onboarding/index'), '/onboarding');
  assert.equal(routePattern('/index'), '/');
  const surfaces = [
    { id: 'a', status: 'added', head: route('/auth/forgot-password') },
    { id: 'r', status: 'removed', base: route('/onboarding/features') },
    { id: 'm', status: 'modified', base: route('/(app)/paywall'), head: route('/(app)/paywall'), review: { status: 'modified' }, baseOutcome: { status: 'captured', landing: 'verified' }, headOutcome: { status: 'captured', landing: 'verified' } },
    { id: 'n', status: 'modified', base: route('/(app)/transactions/[id]', { route: '/transactions/tx-1' }), head: route('/(app)/transactions/[id]', { route: '/transactions/tx-1' }), review: { status: 'needs-review' } },
    { id: 'u', status: 'unchanged', base: route('/(app)/(tabs)/home'), head: route('/(app)/(tabs)/home'), review: { status: 'unchanged' } },
    { id: 's', status: 'unchanged', base: route('/(app)/(tabs)/cards'), head: route('/(app)/(tabs)/cards') },
    { id: 'd', status: 'unchanged', base: route('/(app)/index', { kind: 'redirect' }), head: route('/(app)/index', { kind: 'redirect' }) },
  ];
  const expected = { surfaces: { '/auth/forgot-password': 'added', '/onboarding/features': 'removed', '/paywall': 'modified', '/transactions/[id]': 'needs-review' }, others: 'unchanged' };
  assert.deepEqual(checkExpectations({ surfaces, expected, level: 'report' }), { status: 'passed', level: 'report', checked: 6, mismatches: [] });
  // A failed capture is "not compared", which never satisfies "unchanged".
  const failed = surfaces.map(s => s.id === 's' ? { ...s, headOutcome: { status: 'failed', landing: 'unverified' } } : s);
  assert.deepEqual(checkExpectations({ surfaces: failed, expected, level: 'report' }).mismatches, [{ route: '/cards', id: 's', expected: 'unchanged', actual: 'not-compared' }]);
  // Added and removed surfaces always carry a review; their own capture must still have succeeded.
  const removedFailed = surfaces.map(s => s.id === 'r' ? { ...s, baseOutcome: { status: 'failed', landing: 'unverified' } } : s);
  assert.deepEqual(checkExpectations({ surfaces: removedFailed, expected, level: 'report' }).mismatches, [{ route: '/onboarding/features', id: 'r', expected: 'removed', actual: 'not-compared' }]);
  const variant = surfaces.map(s => s.id === 'u' ? { ...s, review: { status: 'variant' } } : s);
  assert.equal(checkExpectations({ surfaces: variant, expected, level: 'report' }).mismatches[0].actual, 'variant');
  assert.deepEqual(checkExpectations({ surfaces, expected: { surfaces: { '/missing': 'added' } }, level: 'report' }).mismatches, [{ route: '/missing', expected: 'added', actual: 'missing' }]);
  // Keys can also be a surface id or a logical path.
  assert.equal(checkExpectations({ surfaces, expected: { surfaces: { m: 'modified', '/(app)/transactions/[id]': 'needs-review' } }, level: 'report' }).status, 'passed');
});

test('plan-level expectations accept every status the evidence could still produce', () => {
  const plan = [
    { id: 'a', status: 'added', headSurface: route('/auth/forgot-password'), reasons: [], headCapture: true },
    { id: 'm', status: 'modified', baseSurface: route('/paywall'), headSurface: route('/paywall'), reasons: ['Source changed: src/app/(app)/paywall.tsx'], baseCapture: true, headCapture: true },
    { id: 'w', status: 'modified', baseSurface: route('/home'), headSurface: route('/home'), reasons: ['Global source changed: package.json'], baseCapture: true, headCapture: true },
    { id: 'n', status: 'unchanged', baseSurface: route('/cards'), headSurface: route('/cards'), reasons: [], baseCapture: false, headCapture: false },
  ];
  assert.equal(checkExpectations({ surfaces: plan, expected: { surfaces: { '/auth/forgot-password': 'added', '/paywall': 'needs-review' }, others: 'unchanged' }, level: 'plan' }).status, 'passed');
  assert.deepEqual(checkExpectations({ surfaces: plan, expected: { surfaces: { '/home': 'added' } }, level: 'plan' }).mismatches, [{ route: '/home', id: 'w', expected: 'added', actual: 'app-wide' }]);
  assert.equal(checkExpectations({ surfaces: plan, expected: { surfaces: { '/paywall': 'unchanged' } }, level: 'plan' }).status, 'failed');
  // A run that ends before a plan or report cannot be judged; it is never reported as having no expectations.
  assert.match(formatExpectations(undefined, { declared: true }), /not checked/);
  assert.equal(formatExpectations(undefined), 'Expectations: none declared.');
});

test('matrix cells expand scenarios, modes and scopes into distinct run ids', () => {
  const now = new Date('2026-09-27T12:34:00Z');
  const product = parseMatrixArguments(['--app', 'test/ci/apps/wallet', '--scenarios', 'release', '--modes', 'deterministic,agent', '--scopes', 'all,changes'], now);
  assert.deepEqual(product.cells.map(cell => cell.runId), ['wallet-202609271234-release-det-all', 'wallet-202609271234-release-det-changes', 'wallet-202609271234-release-agent-all', 'wallet-202609271234-release-agent-changes']);
  assert.equal(product.cells[0].scenario, 'test/ci/scenarios/wallet/release');
  assert.equal(product.parallel, 4);
  const listed = parseMatrixArguments(['--app', 'apps/x', '--cells', 'identical:deterministic:changes,other/dir:agent:all', '--prefix', 'p', '--parallel', '2'], now);
  assert.deepEqual(listed.cells.map(cell => [cell.name, cell.scenario]), [['identical-det-changes', 'test/ci/scenarios/x/identical'], ['dir-agent-all', 'other/dir']]);
  assert.throws(() => parseMatrixArguments(['--app', 'a', '--cells', 'x:agent'], now), /SCENARIO:MODE:SCOPE/);
  assert.throws(() => parseMatrixArguments(['--app', 'a', '--cells', 'x:agent:all,x:agent:all'], now), /Duplicate/);
  assert.throws(() => parseMatrixArguments(['--app', 'a', '--scenarios', 'x', '--modes', 'keyed'], now), /Unknown mode/);
  assert.throws(() => parseMatrixArguments(['--app', 'a'], now), /Usage/);
  assert.deepEqual(reportedCost('Reported estimates total: $12.345600. Receipts without a cost estimate: 1.'), { usd: 12.3456, unknown: 1 });
  assert.equal(reportedCost('Total estimated cost: unknown'), null);
  assert.match(matrixTable([{ name: 'c', status: 'failed', cost: { usd: 0.5, unknown: 1 } }]), /\$0\.50 \+ 1 unknown/);
});

test('a matrix never reads an older run as its own result', async t => {
  const runs = await mkdtemp(join(tmpdir(), 'explore-local-matrix-')); t.after(() => rm(runs, { recursive: true, force: true }));
  const options = parseMatrixArguments(['--app', 'apps/x', '--cells', 'a:deterministic:all,b:agent:changes', '--prefix', 'p']);
  assert.deepEqual(await existingRuns(runs, options), []);
  await mkdir(join(runs, 'p-b-agent-changes')); await mkdir(join(runs, 'p-matrix'));
  assert.deepEqual(await existingRuns(runs, options), ['p-b-agent-changes', 'p-matrix']);
  // A cell whose process failed does not pass, whatever its run.json says.
  assert.equal(cellPassed({ status: 'passed', exitCode: 0, expectations: 'passed (report)' }), true);
  assert.equal(cellPassed({ status: 'passed', exitCode: 1, expectations: 'passed (report)' }), false);
  assert.equal(cellPassed({ status: 'passed', exitCode: 0, expectations: 'failed (report)' }), false);
  assert.equal(cellPassed({ status: 'not started', exitCode: null }), false);
  assert.match(matrixTable([{ name: 'c', status: 'no record', exitCode: 1 }]), /\| no record \(exit 1\) \|/);
});

test('local model environment cannot inherit API, EAS, GitHub or app credentials', () => {
  const env = localAgentEnvironment({ HOME: '/home/test', PATH: '/bin', CODEX_HOME: '/home/test/.codex', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', EXPO_TOKEN: 'secret', GITHUB_TOKEN: 'secret', LOGIN_PASSWORD: 'secret' });
  assert.equal(env.HOME, '/home/test'); assert.equal(env.CODEX_HOME, '/home/test/.codex');
  assert.equal(Object.values(env).includes('secret'), false);
});

test('local model environment keeps the user identity the CLI login store is keyed by', () => {
  const env = localAgentEnvironment({ HOME: '/home/test', PATH: '/bin', USER: 'test', LOGNAME: 'test' });
  assert.equal(env.USER, 'test'); assert.equal(env.LOGNAME, 'test');
});

test('local model environment passes a Claude Code OAuth token through: it is the login, not an API key', () => {
  const env = localAgentEnvironment({ HOME: '/home/test', PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fixture' });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-fixture');
});

test('usage summaries preserve unknown accounting on a failed/no-receipt run', async t => {
  const run = await mkdtemp(join(tmpdir(), 'explore-local-usage-')); t.after(() => rm(run, { recursive: true, force: true }));
  await writeUsageSummary(run);
  assert.match(await readFile(join(run, 'agent-mode-cost.md'), 'utf8'), /No provider receipt/);
  await mkdir(join(run, 'artifacts/capture'), { recursive: true });
  await writeFile(join(run, 'artifacts/capture/agent-usage.jsonl'), JSON.stringify({ phase: 'capture-head', receipt: { source: 'claude-cli', model: 'fixture', accounting: 'unknown', totals: {} } }) + '\n');
  await writeUsageSummary(run);
  assert.match(await readFile(join(run, 'agent-mode-cost.md'), 'utf8'), /unknown \| unknown \| unknown \| unknown/);
  assert.match(await readFile(join(run, 'agent-mode-cost.md'), 'utf8'), /Tolerated unknown tool calls: none\./);
  await writeFile(join(run, 'artifacts/capture/agent-usage.jsonl'), JSON.stringify({ phase: 'capture-base', receipt: { source: 'claude-cli', model: 'fixture', accounting: 'unknown', totals: {}, toleratedUnknownTools: ['mcp__explore__scroll'], registeredCallsAfterUnknownTools: [12] } }) + '\n');
  await writeUsageSummary(run);
  assert.match(await readFile(join(run, 'agent-mode-cost.md'), 'utf8'), /Tolerated unknown tool calls: capture-base: mcp__explore__scroll \(12 registered tool calls followed\)\./);
});

test('direct Claude CLI requires subscription auth and emits accounting without API fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'claude');
  await writeFile(cli, `#!${process.execPath}\nif(process.argv.includes('auth')) console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'})); else { let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0.01,usage:{input_tokens:5,output_tokens:1},modelUsage:{fixture:{inputTokens:5,outputTokens:1,costUSD:0.01}}}))); }\n`);
  await chmod(cli, 0o755);
  const receipts = [];
  const session = createLocalCiAgentSession({ provider: 'anthropic', model: 'fixture' }, { env: { HOME: root, PATH: root }, onUsage: r => receipts.push(r) });
  await session.preflight();
  assert.equal(receipts.length, 1); assert.equal(receipts[0].source, 'claude-cli'); assert.equal(receipts[0].totals.inputTokens, 5);
  const body = (await readFile(cli, 'utf8')).replace("authMethod:'claude.ai'", "authMethod:'oauth_token'");
  await writeFile(cli, body);
  await session.preflight();
  assert.equal(receipts.length, 2, 'a claude setup-token login (CLAUDE_CODE_OAUTH_TOKEN) is a subscription login');
  await writeFile(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true,authMethod:'api_key'}));\n`);
  await assert.rejects(session.preflight(), { code: 'AGENT_SUBSCRIPTION_LOGIN_REQUIRED' });
  assert.equal(receipts.length, 2);
  await writeFile(cli, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGKILL');\n`);
  await assert.rejects(session.preflight(), error => error.code === 'AGENT_SUBSCRIPTION_LOGIN_REQUIRED' && /did not answer/.test(error.message),
    'a claude CLI that cannot run is told apart from one that is not logged in');
});

test('local Claude deadline terminates its process and retains unknown failure accounting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-deadline-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'claude');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.HOME+'/pid',String(process.pid));setInterval(()=>{},1000);\n`); await chmod(cli, 0o755);
  const receipts = [];
  const session = createLocalCiAgentSession({ provider: 'anthropic', model: 'fixture' }, { env: { HOME: root, PATH: root }, onUsage: r => receipts.push(r) });
  await assert.rejects(session.run({ instructions: 'Reply OK.', prompt: 'OK', tools: [], callTool: async () => { throw Error('Unexpected'); }, deadlineMs: Date.now() + 500 }), { code: 'AGENT_BUDGET_EXCEEDED' });
  const pid = Number(await readFile(join(root, 'pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(receipts.length, 1); assert.equal(receipts[0].accounting, 'unknown'); assert.equal(receipts[0].terminalResult, false);
});

test('local Claude tool bridge returns images and enforces the supplied schema', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-tool-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'claude');
  await writeFile(cli, `#!${process.execPath}
const fs=require('node:fs');const cfg=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8')).mcpServers.explore.env;
const call=async(method,params)=>{const r=await fetch(cfg.EXPLORE_CI_MCP_ENDPOINT,{method:'POST',headers:{authorization:'Bearer '+cfg.EXPLORE_CI_MCP_TOKEN},body:JSON.stringify({method,params})});if(!r.ok)throw Error('bridge failed');return r.json()};
(async()=>{const list=await call('tools/list');if(list.tools[0].name!=='inspect')throw Error('tools');
const denied=await call('tools/call',{name:'inspect',arguments:{undeclared:true}});if(!denied.isError)throw Error('schema');
const result=await call('tools/call',{name:'inspect',arguments:{}});if(result.content[0].type!=='image'||result.content[0].data!=='aW1hZ2U=')throw Error('image');
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,usage:{input_tokens:5,output_tokens:1}}));})().catch(()=>process.exit(1));
`); await chmod(cli, 0o755);
  let calls = 0;
  const session = createLocalCiAgentSession({ provider: 'anthropic', model: 'fixture' }, { env: { HOME: root, PATH: root } });
  await session.run({ instructions: 'Inspect.', prompt: 'Inspect.', deadlineMs: Date.now() + 5000,
    tools: [{ name: 'inspect', description: 'Inspect', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    callTool: async () => { calls++; return { content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] }; } });
  assert.equal(calls, 1);
});


test('npm script shims cannot shadow the independently installed subscription CLI', () => {
  const env = localAgentEnvironment({ PATH: '/repo/node_modules/.bin:/usr/local/bin:/npm/node-gyp-bin:/usr/bin' });
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin');
});


test('local comments never label uncaptured source as a visual unchanged result', async () => {
  const { renderPublicComment } = await tsImport('../../src/report/pr-comment-body.ts', import.meta.url);
  const state = { phase: 'ready', pullRequest: local, executionMode: 'agent', mode: 'changes', capture: { planned: { base: 0, head: 0 }, done: { base: 0, head: 0 } },
    review: { surfaces: [{ id: 'home', status: 'unchanged', head: { route: '/home' } }] } };
  const comment = renderPublicComment(state);
  assert.match(comment, /visual comparison was not required/);
  assert.doesNotMatch(comment, /home: unchanged/);
  state.capture.planned.head = 1;
  state.review.surfaces[0].headOutcome = { status: 'failed' };
  assert.match(renderPublicComment(state), /home: not compared/);
});


test('typed local Claude quota failures retain the terminal receipt and cannot become success', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-quota-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'claude');
  await writeFile(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'assistant',error:'billing_error',message:{content:[]}}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0}}));\n`); await chmod(cli, 0o755);
  const receipts = [];
  const session = createLocalCiAgentSession({ provider: 'anthropic', model: 'fixture' }, { env: { HOME: root, PATH: root }, onUsage: r => receipts.push(r) });
  await assert.rejects(session.run({ instructions: 'Reply OK.', prompt: 'OK', tools: [], callTool: async () => { throw Error('Unexpected'); }, deadlineMs: Date.now() + 5000 }), { code: 'AGENT_QUOTA_EXHAUSTED' });
  assert.equal(receipts[0].terminalResult, true); assert.equal(receipts[0].accounting, 'partial');
  assert.equal(receipts[0].unavailableReason, 'possibly-zeroed-error-result');
});


test('cancelled installation joins its child and redacts retained output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-install-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'npm');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.HOME+'/pid',String(process.pid));console.log(process.env.TEST_SECRET);process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`); await chmod(cli, 0o755);
  const abort = new AbortController();
  const pending = installApp(root, join(root, 'install.log'), abort.signal, { HOME: root, PATH: root, TEST_SECRET: 'private-install-input' });
  // Wait for this process's startup marker, then cancel while it is running.
  let pid;
  for (let i = 0; i < 100 && !pid; i++) {
    pid = await readFile(join(root, 'pid'), 'utf8').then(Number, () => undefined);
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  abort.abort(new Error('cancel installation'));
  await assert.rejects(pending, /cancel installation/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const log = await readFile(join(root, 'install.log'), 'utf8');
  assert.doesNotMatch(log, /private-install-input/);
});

test('installation matches the review workflow and skips lifecycle scripts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-install-args-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'npm');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.HOME+'/args',JSON.stringify(process.argv.slice(2)));\n`); await chmod(cli, 0o755);
  await installApp(root, join(root, 'install.log'), new AbortController().signal, { HOME: root, PATH: root });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'args'), 'utf8')), ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
});

test('typecheck runs the app script when it has one, so a head that does not compile fails before a build', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-typecheck-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'npm');
  await writeFile(cli, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.HOME+'/args',JSON.stringify(process.argv.slice(2)));process.exit(Number(process.env.EXIT_CODE||0));\n`); await chmod(cli, 0o755);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  assert.equal(await typecheckApp(root, join(root, 'typecheck.log'), new AbortController().signal, { HOME: root, PATH: root }), false);
  await assert.rejects(readFile(join(root, 'args')), { code: 'ENOENT' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
  assert.equal(await typecheckApp(root, join(root, 'typecheck.log'), new AbortController().signal, { HOME: root, PATH: root }), true);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'args'), 'utf8')), ['run', 'typecheck']);
  await assert.rejects(typecheckApp(root, join(root, 'typecheck.log'), new AbortController().signal, { HOME: root, PATH: root, EXIT_CODE: '2' }), /App npm run typecheck exited 2/);
});

test('local Claude tolerates a bounded number of unknown Explore tool names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'explore-local-unknown-tool-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'claude');
  const run = async names => {
    await writeFile(cli, `#!${process.execPath}
process.stdin.resume();process.stdin.on('end',()=>{for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'t',name,input:{}}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,usage:{input_tokens:5,output_tokens:1}}));});
`); await chmod(cli, 0o755);
    const session = createLocalCiAgentSession({ provider: 'anthropic', model: 'fixture' }, { env: { HOME: root, PATH: root }, onUsage: r => receipts.push(r) });
    return session.run({ instructions: 'Act.', prompt: 'Act.', deadlineMs: Date.now() + 5000,
      tools: [{ name: 'act', description: 'Act', inputSchema: { type: 'object', properties: {} } }], callTool: async () => { throw Error('Unexpected'); } });
  };
  const receipts = [];
  await run(['mcp__explore__act', 'mcp__explore__scroll', 'mcp__explore__act', 'mcp__explore__scroll', 'mcp__explore__swipe', 'mcp__explore__act']);
  assert.deepEqual(receipts.at(-1).toleratedUnknownTools, ['mcp__explore__scroll', 'mcp__explore__scroll', 'mcp__explore__swipe']);
  // Recovery evidence: registered calls after each tolerated name.
  assert.deepEqual(receipts.at(-1).registeredCallsAfterUnknownTools, [2, 1, 1]);
  await run(['mcp__explore__act']);
  assert.equal(receipts.at(-1).toleratedUnknownTools, undefined);
  await assert.rejects(run(Array(4).fill('mcp__explore__scroll')), error => error.code === 'AGENT_TOOL_DENIED' && error.details.tool === 'mcp__explore__scroll');
  await assert.rejects(run(['Bash']), error => error.code === 'AGENT_TOOL_DENIED' && error.details.tool === 'Bash');
});

test('with --free-port, the report view takes a port from the system, never one near Vite\'s default 5173', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'explore-view-port-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const zip = join(directory, 'report.zip');
  await writeFile(zip, 'not opened until a browser asks for it');
  const child = spawn(process.execPath, ['test/ci/view.mjs', '--zip', zip, '--no-watch', '--free-port'], { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output += chunk;
      const match = /Viewer: http:\/\/127\.0\.0\.1:(\d+)\/r/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', code => reject(new Error(`The report view exited with ${code}: ${output}`)));
  });
  assert.ok(port < 5173 || port > 5273, `Vite picked ${port} itself`);
});
