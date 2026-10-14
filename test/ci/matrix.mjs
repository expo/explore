// Run several local CI cells (scenario × mode × scope) in parallel processes and summarize them.
// Each cell is an ordinary `test/ci/run.mjs` run with its own run directory and report.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATRIX_USAGE, cellPassed, existingRuns, matrixTable, parseMatrixArguments, reportedCost } from './lib/matrix-cells.mjs';

// Not imported from run.mjs: that module loads dist/, which this script builds first.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runsRoot = join(repository, 'test/ci/runs');

const readText = path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });

async function main() {
  let options;
  try { options = parseMatrixArguments(process.argv.slice(2)); } catch (error) { console.error(error.message); console.error(MATRIX_USAGE); process.exitCode = 2; return; }
  const existing = await existingRuns(runsRoot, options);
  if (existing.length) {
    console.error(`These run directories already exist: ${existing.join(', ')}. Choose another --prefix; a matrix never reuses or overwrites a run.`);
    process.exitCode = 2; return;
  }
  // run.mjs imports dist/; build it once instead of once per cell.
  if (spawnSync('npm', ['run', 'build:cli'], { cwd: repository, stdio: 'inherit' }).status !== 0) throw new Error('npm run build:cli failed');

  const children = new Set();
  let interrupts = 0;
  const onSignal = () => {
    interrupts++;
    // First Ctrl+C lets each run cancel and clean up its EAS session; a second one stops them.
    for (const child of children) { try { process.kill(-child.pid, interrupts === 1 ? 'SIGINT' : 'SIGKILL'); } catch { /* Already exited. */ } }
    if (interrupts === 1) console.error('Cancelling matrix cells; press Ctrl+C again to stop them immediately.');
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);

  const runCell = cell => new Promise(resolveCell => {
    const started = Date.now();
    const args = ['test/ci/run.mjs', '--app', options.app, '--scenario', cell.scenario, '--mode', cell.mode, '--scope', cell.scope, '--run-id', cell.runId,
      ...(options.planOnly ? ['--plan-only'] : [])];
    const child = spawn(process.execPath, args, { cwd: repository, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.add(child);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) process.stdout.write(`[${cell.name}] ${line}\n`);
      });
      stream.on('end', () => { if (pending) process.stdout.write(`[${cell.name}] ${pending}\n`); });
    }
    child.on('close', code => { children.delete(child); resolveCell({ cell, code, durationMs: Date.now() - started }); });
  });

  const queue = [...options.cells];
  const finished = [];
  await Promise.all(Array.from({ length: Math.min(options.parallel, queue.length) }, async () => {
    while (queue.length && interrupts === 0) finished.push(await runCell(queue.shift()));
  }));

  const results = [];
  for (const cell of options.cells) {
    const outcome = finished.find(entry => entry.cell === cell);
    const directory = join(runsRoot, cell.runId);
    const run = JSON.parse(await readText(join(directory, 'run.json')) ?? 'null');
    results.push({ name: cell.name, runId: cell.runId, scenario: cell.scenario, mode: cell.mode, scope: cell.scope,
      status: run?.status ?? (outcome ? 'no record' : 'not started'), exitCode: outcome?.code ?? null,
      expectations: run?.expectations ? `${run.expectations.status} (${run.expectations.level})` : undefined,
      captures: run?.capture ? `${run.capture.done.base}/${run.capture.planned.base} · ${run.capture.done.head}/${run.capture.planned.head}`
        : run?.plan ? `${run.plan.baseCaptures} · ${run.plan.headCaptures} planned` : undefined,
      durationMs: run?.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : outcome?.durationMs,
      cost: reportedCost(await readText(join(directory, 'agent-mode-cost.md'))) });
  }
  const summary = join(runsRoot, `${options.prefix}-matrix`);
  await mkdir(summary);
  await writeFile(join(summary, 'matrix.json'), JSON.stringify({ contract: 'explore.local-matrix.v1', app: options.app, prefix: options.prefix, planOnly: options.planOnly, results }, null, 2) + '\n');
  await writeFile(join(summary, 'README.md'), [`# ${options.prefix} matrix`, '', `App: \`${options.app}\`${options.planOnly ? ' · planning only' : ''}`, '', matrixTable(results), '',
    ...results.map(r => `- [${r.name}](../${r.runId}/README.md)`), '', 'Estimated costs are CLI estimates for agent sessions; EAS charges are not included.', ''].join('\n'));
  console.log(`\n${matrixTable(results)}\n\nSummary: test/ci/runs/${options.prefix}-matrix/README.md`);
  const ok = results.every(cellPassed);
  if (!ok || interrupts) process.exitCode = 1;
}

await main();
