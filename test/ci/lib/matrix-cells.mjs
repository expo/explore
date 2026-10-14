// Argument handling and result rules for test/ci/matrix.mjs: which (scenario, mode, scope) cells to run.
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

export const MATRIX_USAGE = 'Usage: npm run ci:local:matrix -- --app APP (--cells SCENARIO:MODE:SCOPE,... | --scenarios A,B [--modes deterministic,agent] [--scopes all,changes]) [--parallel N] [--prefix NAME] [--plan-only]';
const MODES = ['deterministic', 'agent'];
const SCOPES = ['all', 'changes'];
const list = value => (value ?? '').split(',').map(item => item.trim()).filter(Boolean);

/** A bare scenario name resolves under test/ci/scenarios/<app folder name>/. */
export function scenarioPath(app, value) {
  return value.includes('/') ? value : join('test/ci/scenarios', basename(app), value);
}

export function parseMatrixArguments(args, now = new Date()) {
  const { values } = parseArgs({ args, options: { app: { type: 'string' }, cells: { type: 'string' }, scenarios: { type: 'string' }, modes: { type: 'string' },
    scopes: { type: 'string' }, parallel: { type: 'string' }, prefix: { type: 'string' }, 'plan-only': { type: 'boolean' } } });
  if (!values.app || (!values.cells && !values.scenarios) || (values.cells && values.scenarios)) throw new Error(MATRIX_USAGE);
  const parallel = Number(values.parallel ?? 4);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) throw new Error('--parallel must be an integer from 1 to 16');
  const prefix = values.prefix ?? `${basename(values.app)}-${now.toISOString().replace(/[^0-9]/g, '').slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(prefix)) throw new Error('--prefix must be a short run id prefix');
  const requested = values.cells
    ? list(values.cells).map(cell => {
      const [scenario, mode, scope, ...rest] = cell.split(':');
      if (!scenario || !mode || !scope || rest.length) throw new Error(`Cell must be SCENARIO:MODE:SCOPE: ${cell}`);
      return { scenario, mode, scope };
    })
    : list(values.scenarios).flatMap(scenario => (values.modes ? list(values.modes) : ['deterministic']).flatMap(mode =>
      (values.scopes ? list(values.scopes) : ['all']).map(scope => ({ scenario, mode, scope }))));
  const seen = new Set();
  const cells = requested.map(({ scenario, mode, scope }) => {
    if (!MODES.includes(mode)) throw new Error(`Unknown mode in matrix: ${mode}`);
    if (!SCOPES.includes(scope)) throw new Error(`Unknown scope in matrix: ${scope}`);
    const name = `${basename(scenario)}-${mode === 'deterministic' ? 'det' : 'agent'}-${scope}`;
    if (seen.has(name)) throw new Error(`Duplicate matrix cell: ${name}`);
    seen.add(name);
    return { name, scenario: scenarioPath(values.app, scenario), mode, scope, runId: `${prefix}-${name}` };
  });
  if (!cells.length) throw new Error('The matrix has no cells');
  return { app: values.app, cells, parallel, prefix, planOnly: Boolean(values['plan-only']) };
}

/** The reported estimate and the receipts without one, from agent-mode-cost.md; null when none was reported. */
export function reportedCost(markdown) {
  const match = /Reported estimates total: \$([0-9]+(?:\.[0-9]+)?)\. Receipts without a cost estimate: ([0-9]+)/.exec(markdown ?? '');
  return match ? { usd: Number(match[1]), unknown: Number(match[2]) } : null;
}

// An unknown receipt is not free: show it next to the estimate instead of letting the total look complete.
const costText = cost => cost ? `$${cost.usd.toFixed(2)}${cost.unknown ? ` + ${cost.unknown} unknown` : ''}` : '—';

/**
 * Run directories this matrix would write that already exist. run.mjs never overwrites a run, so
 * such a cell would exit at once and its old record would read as this matrix's result.
 */
export async function existingRuns(runsRoot, { prefix, cells }) {
  const found = [];
  for (const name of [...cells.map(cell => cell.runId), `${prefix}-matrix`]) {
    if (await lstat(join(runsRoot, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) found.push(name);
  }
  return found;
}

/** A cell passes only when its own process exited 0 and its record passed (or planned) with no failed expectation. */
export const cellPassed = result => result.exitCode === 0 && ['passed', 'planned'].includes(result.status) && !result.expectations?.startsWith('failed');

export function matrixTable(results) {
  const minutes = ms => Number.isFinite(ms) ? `${(ms / 60_000).toFixed(1)} min` : '—';
  const status = r => `${r.status}${Number.isInteger(r.exitCode) && r.exitCode !== 0 ? ` (exit ${r.exitCode})` : ''}`;
  return ['| Cell | Status | Expectations | Captures (base/head) | Duration | Estimated cost |', '|---|---|---|---|---|---|',
    ...results.map(r => `| ${r.name} | ${status(r)} | ${r.expectations ?? '—'} | ${r.captures ?? '—'} | ${minutes(r.durationMs)} | ${costText(r.cost)} |`)].join('\n');
}
