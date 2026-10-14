// A scenario turns one tracked app into a fixed base/head pair: head = base − removed + overlay.
// Its Explore configs live beside it (or one directory up, shared by every scenario of the app).
// A shared config can leave named setup slots (`- include: NAME`) that a scenario's setup.yaml fills.
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { parse, stringify } from 'yaml';

const MODES = ['deterministic', 'agent'];
const SCOPES = ['all', 'changes'];
const STATUSES = ['added', 'removed', 'modified', 'needs-review', 'unchanged', 'variant'];

const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const readJson = async (path, label) => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
};

/** Tracked and nonignored files below `directory`, relative to it. */
function listFiles(directory) {
  const result = spawnSync('git', ['-C', directory, 'ls-files', '-c', '-o', '--exclude-standard', '-z', '--', '.'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not list scenario overlay files: ${result.stderr}`);
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) throw new Error(`${label} must be a relative path`);
  const path = normalize(value);
  if (path.startsWith('..') || path.split(sep).includes('..') || path === '.') throw new Error(`${label} must stay inside the app: ${value}`);
  return path.split(sep).join('/');
}

export function validateExpected(expected, label = 'expected.json') {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(expected)) if (!['surfaces', 'others'].includes(key)) throw new Error(`${label} has an unknown field: ${key}`);
  const surfaces = expected.surfaces ?? {};
  if (typeof surfaces !== 'object' || Array.isArray(surfaces)) throw new Error(`${label} surfaces must map routes to statuses`);
  for (const [route, status] of Object.entries(surfaces)) if (!STATUSES.includes(status)) throw new Error(`${label} ${route} has an unknown status: ${status}`);
  if (expected.others !== undefined && !STATUSES.includes(expected.others)) throw new Error(`${label} others has an unknown status: ${expected.others}`);
  return { surfaces, ...(expected.others ? { others: expected.others } : {}) };
}

const isSlot = step => Boolean(step) && typeof step === 'object' && !Array.isArray(step)
  && Object.keys(step).length === 1 && typeof step.include === 'string';

/** setup.yaml: slot name → the setup steps this scenario inserts where a shared config includes that slot. */
async function readSetupSlots(root) {
  const path = join(root, 'setup.yaml');
  if (!await exists(path)) return {};
  const value = parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('setup.yaml must map slot names to setup steps');
  for (const [slot, steps] of Object.entries(value)) {
    if (!Array.isArray(steps) || !steps.length || steps.some(step => !step || typeof step !== 'object' || Array.isArray(step) || isSlot(step))) {
      throw new Error(`setup.yaml ${slot} must list setup steps`);
    }
  }
  return value;
}

/** Read a scenario directory and select the Explore config for a mode. */
export async function loadScenario(directory, { mode = 'deterministic' } = {}) {
  if (!MODES.includes(mode)) throw new Error(`--mode must be one of ${MODES.join(', ')}`);
  const root = await realpath(resolve(directory));
  const definition = await readJson(join(root, 'scenario.json'), 'scenario.json');
  if (!definition) throw new Error(`Scenario has no scenario.json: ${directory}`);
  for (const key of Object.keys(definition)) if (!['description', 'removed'].includes(key)) throw new Error(`scenario.json has an unknown field: ${key}`);
  if (typeof definition.description !== 'string' || !definition.description.trim()) throw new Error('scenario.json needs a description');
  if (definition.removed !== undefined && !Array.isArray(definition.removed)) throw new Error('scenario.json removed must be an array');
  const removed = [...new Set((definition.removed ?? []).map((path, index) => relativePath(path, `scenario.json removed[${index}]`)))].sort();
  const overlayRoot = join(root, 'overlay');
  const overlay = await exists(overlayRoot) ? listFiles(overlayRoot) : [];
  for (const path of overlay) if (removed.includes(path)) throw new Error(`Scenario both removes and overlays ${path}`);
  const expectedValue = await readJson(join(root, 'expected.json'), 'expected.json');
  const candidates = [join(root, `${mode}.yaml`), join(dirname(root), `${mode}.yaml`)];
  let configPath;
  for (const candidate of candidates) if (await exists(candidate)) { configPath = candidate; break; }
  if (!configPath) throw new Error(`No ${mode}.yaml in the scenario or its parent directory: ${directory}`);
  return { root, description: definition.description.trim(), removed, overlay: { root: overlayRoot, files: overlay },
    ...(expectedValue === undefined ? {} : { expected: validateExpected(expectedValue) }), setup: await readSetupSlots(root),
    configPath, rawConfig: await readFile(configPath, 'utf8') };
}

/**
 * The config text for this run: the scenario config with its setup slots filled and an optional
 * scope override. An empty slot disappears. A config without setup (agent mode) ignores the slots;
 * a config with setup must include every slot the scenario fills, so a misspelt slot fails.
 */
export function effectiveConfigText(raw, { mode, scope, setup = {} } = {}) {
  if (scope !== undefined && !SCOPES.includes(scope)) throw new Error(`--scope must be one of ${SCOPES.join(', ')}`);
  const value = parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Scenario config must be a YAML mapping');
  if (mode !== undefined && (value.mode ?? 'deterministic') !== mode) throw new Error(`Scenario ${mode}.yaml declares mode ${value.mode ?? 'deterministic'}`);
  let filled = false;
  if (Array.isArray(value.setup)) {
    const included = new Set();
    value.setup = value.setup.flatMap(step => {
      if (!isSlot(step)) return [step];
      filled = true; included.add(step.include);
      return setup[step.include] ?? [];
    });
    const unused = Object.keys(setup).filter(slot => !included.has(slot));
    if (unused.length) throw new Error(`The config has no setup slot for: ${unused.join(', ')}`);
  }
  if (scope === undefined && !filled) return raw;
  if (scope !== undefined) value.exploration = { ...(value.exploration ?? {}), scope };
  return stringify(value);
}
