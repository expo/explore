// Compare a scenario's expected review statuses with a plan or a report. App-agnostic: routes and
// statuses come from the scenario's expected.json, never from this file.
import { surfaceSourceScope } from '../../../dist/source/capture-plan.js';

/** The public route pattern of an Expo Router logical path: groups and a trailing index are dropped. */
export function routePattern(logicalPath) {
  const segments = logicalPath.split('/').filter(Boolean).filter(segment => !/^\(.*\)$/.test(segment));
  if (segments.at(-1) === 'index') segments.pop();
  return `/${segments.join('/')}`;
}

const keysOf = route => route ? [route.id, route.logicalPath, route.logicalPath && routePattern(route.logicalPath), route.route].filter(Boolean) : [];

const incomplete = outcome => outcome !== undefined && (outcome.status !== 'captured' || outcome.landing !== 'verified');

/** Report level: what a reviewer sees for this surface. A failed capture on either side is never evidence. */
function reportStatus(surface) {
  if (incomplete(surface.baseOutcome) || incomplete(surface.headOutcome)) return 'not-compared';
  if (surface.review?.status) return surface.review.status;
  if (surface.status === 'added' || surface.status === 'removed') return surface.status;
  return surface.baseOutcome || surface.headOutcome ? 'not-compared' : 'not-selected';
}

/** Plan level: the source status before any capture; an app-wide-only change is reported apart. */
function planStatus(surface) {
  // The planner's own rule, so a new screen-change reason cannot drift from this check.
  if (surfaceSourceScope(surface) === 'app-wide') return 'app-wide';
  return surface.baseCapture || surface.headCapture || surface.status !== 'unchanged' ? surface.status : 'not-selected';
}

/** Which report statuses each plan status can still become once evidence is compared. */
const PLAN_OUTCOMES = {
  added: ['added'], removed: ['removed'], modified: ['modified', 'needs-review'],
  'app-wide': ['unchanged', 'modified', 'needs-review'], unchanged: ['unchanged', 'variant'], 'not-selected': ['unchanged'],
};

function matches(expected, actual, level) {
  if (level === 'plan') return PLAN_OUTCOMES[actual]?.includes(expected) ?? false;
  // Unselected surfaces carry no evidence; they satisfy "unchanged" only.
  return expected === actual || (actual === 'not-selected' && expected === 'unchanged');
}

/**
 * `surfaces` are review.json surfaces (level "report") or execution-plan.json surfaces (level "plan").
 * Keys of expected.surfaces may be a route pattern, a logical path, or a surface id.
 */
export function checkExpectations({ surfaces, expected, level }) {
  const normalized = surfaces.map(surface => {
    const route = level === 'plan' ? surface.headSurface ?? surface.baseSurface : surface.head ?? surface.base;
    const both = level === 'plan' ? [surface.headSurface, surface.baseSurface] : [surface.head, surface.base];
    const kind = route?.kind;
    return { id: surface.id, route: route?.logicalPath ? routePattern(route.logicalPath) : route?.route ?? surface.id,
      keys: new Set([surface.id, ...both.flatMap(keysOf)]), kind, actual: level === 'plan' ? planStatus(surface) : reportStatus(surface) };
  });
  const mismatches = [];
  const claimed = new Set();
  for (const [key, status] of Object.entries(expected.surfaces ?? {})) {
    const found = normalized.filter(surface => surface.keys.has(key));
    if (!found.length) { mismatches.push({ route: key, expected: status, actual: 'missing' }); continue; }
    for (const surface of found) {
      claimed.add(surface.id);
      if (!matches(status, surface.actual, level)) mismatches.push({ route: surface.route, id: surface.id, expected: status, actual: surface.actual });
    }
  }
  let others = 0;
  if (expected.others) for (const surface of normalized) {
    if (claimed.has(surface.id) || surface.kind === 'redirect') continue;
    others++;
    if (!matches(expected.others, surface.actual, level)) mismatches.push({ route: surface.route, id: surface.id, expected: expected.others, actual: surface.actual });
  }
  return { status: mismatches.length ? 'failed' : 'passed', level, checked: claimed.size + others, mismatches };
}

/** `declared`: the scenario has an expected.json, so a missing result means it could not be checked. */
export function formatExpectations(result, { declared = false } = {}) {
  if (!result) return declared ? 'Expectations: **not checked**; the run produced no plan or report to compare.' : 'Expectations: none declared.';
  const head = `Expectations (${result.level}): **${result.status}**, ${result.checked} surfaces checked`;
  if (!result.mismatches.length) return `${head}.`;
  return [`${head}, ${result.mismatches.length} mismatched:`, '', '| Route | Expected | Actual |', '|---|---|---|',
    ...result.mismatches.map(m => `| ${m.route} | ${m.expected} | ${m.actual} |`)].join('\n');
}
