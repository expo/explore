import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPublicComment, platformRecordOf, PUBLIC_COMMENT_BODY_BUDGET } from '../../dist/report/pr-comment-body.js';
import { parsePlatformRecord } from '../../dist/report/pr-comment-record.js';
import { CI_COMMENT_MARKER } from '../../dist/report/pr-comment.js';
import { previewLinks, viewerLinks } from '../../dist/report/viewer-links.js';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const artifactUrl = 'https://github.com/expo/explore-playground/actions/runs/42/artifacts/7654';
const pullRequest = {
  repositoryId: '1', repository: 'expo/explore-playground', number: 1,
  title: 'Add cats care guide, retire Sweet Bee, refresh share label', url: 'https://github.com/expo/explore-playground/pull/1',
  base: { ref: 'main', sha: baseSha }, head: { ref: 'pilot/viewer-coverage', sha: headSha },
};
const image = { sha256: 'c'.repeat(64), width: 1179, height: 2556, capturedAt: '2026-09-11T03:05:00Z', buildId: 'eas-build' };
const entry = (id, route, kind = 'screen') => ({ id, route, routeFile: `src/app/${id}.tsx`, sourceFiles: [], provider: 'expo-router', logicalPath: route.slice(1) || 'index', path: route, variant: 'default', kind, ...(kind === 'redirect' ? { redirectTo: '/home' } : {}) });
function sourceChange(summary, impact = 'direct') {
  return { contract: 'expo.explore.source-change-summary.v1', baseSha, headSha, impact, summary, files: [], truncated: false };
}
function surface(id, status, options = {}) {
  const route = options.route ?? `/${id}`;
  const kind = options.kind ?? 'screen';
  const base = status === 'added' ? null : entry(id, route, kind);
  const head = status === 'removed' ? null : entry(id, route, kind);
  const withImages = kind !== 'redirect';
  return {
    id, status, base, head,
    ...(withImages && base ? { baseImage: { ...image, url: `https://cdn.convex.cloud/api/storage/base-${id}`, sourceCommit: baseSha }, baseOutcome: { status: 'captured', landing: 'verified', attempts: 1 } } : {}),
    ...(withImages && head ? { headImage: { ...image, url: `https://cdn.convex.cloud/api/storage/head-${id}`, sourceCommit: headSha }, headOutcome: { status: 'captured', landing: 'verified', attempts: 1 } } : {}),
    ...options.extra,
  };
}
function review(surfaces, options = {}) {
  return {
    contract: 'explore.review', pullRequest, mode: options.mode ?? 'changes', createdAt: '2026-09-11T03:07:00Z',
    runId: '42', runAttempt: '2',
    runtime: { projectId: 'project', buildId: 'eas-build', gitCommit: headSha, appName: 'Example', appVersion: '1.4.0', appBuildNumber: '27' },
    surfaces,
  };
}
const evidenceReview = () => review([
  surface('care-guide', 'added', { route: '/cats/care-guide', extra: { review: { status: 'added', description: 'Added' } } }),
  surface('sweet-bee', 'removed', { route: '/cats/sweet-bee', extra: { review: { status: 'removed', description: 'Removed' } } }),
  surface('settings', 'modified', { extra: {
    review: { status: 'modified', description: 'Changed button title from “Share” to “Share Example”.', facts: [{ category: 'visible-text', templateId: 'visible-text.changed', bullet: 'Changed button title from “Share” to “Share Example”.' }] },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 3.2, threshold: 0.1, tool: 'agent-device@0.20.2' },
    sourceChange: sourceChange('Renamed the share label in settings-screen.tsx.'),
  } }),
  surface('cats', 'modified', { extra: {
    review: { status: 'unchanged', description: 'No visible change' },
    visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.20.2' },
    sourceChange: sourceChange('Shared component recapture.', 'dependency'),
  } }),
  surface('home', 'unchanged', { kind: 'redirect' }),
]);
function state(overrides = {}) {
  const links = viewerLinks({ artifactUrl, repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml' });
  return {
    phase: 'ready', pullRequest, mode: 'changes', executionMode: 'deterministic', configPath: '.expo-explore/config.yaml', links,
    startedAt: Date.parse('2026-09-11T03:00:48Z'), updatedAt: Date.parse('2026-09-11T03:07:00Z'),
    build: { appName: 'Example', appVersion: '1.4.0', appBuildNumber: '27', platform: 'ios', easProfile: 'explore', easBuildId: 'eas-build', reusedEasBuild: true },
    runtime: { provider: 'eas-simulator', controller: 'agent-device', controllerPackageVersion: '0.20.2', easCliVersion: '25.2.0', platform: 'ios', deviceModel: 'iPhone 17', osVersion: '26.5', locale: 'en-US', orientation: 'portrait', colorScheme: 'light', sessionLifecycle: 'stopped' },
    capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 3 }, baseFromCache: true },
    review: evidenceReview(),
    evidence: {
      visual: { compared: 2, modified: 1, unchanged: 1, needsReview: 0, failed: 0, errors: [], threshold: 0.1, tool: 'agent-device@0.20.2' },
      accessibility: { compared: 2, described: 1, failed: 0, skipped: 0, errors: [] },
    },
    inventory: { routes: 54 },
    ...overrides,
  };
}

/** The comment for a review with no capture evidence or runtime details, as a republish would render it. */
function reviewOnlyState(review) {
  const now = Date.parse(review.createdAt);
  const count = (predicate) => ({ base: review.surfaces.filter((entry) => predicate(entry, 'base')).length,
    head: review.surfaces.filter((entry) => predicate(entry, 'head')).length });
  return {
    phase: 'ready', pullRequest: review.pullRequest, mode: review.mode, executionMode: 'deterministic',
    configPath: '.expo-explore/config.yaml', links: state().links, startedAt: now, updatedAt: now,
    build: { appName: review.runtime.appName, appVersion: review.runtime.appVersion, appBuildNumber: review.runtime.appBuildNumber,
      platform: 'ios', easProfile: '', easBuildId: review.runtime.buildId },
    capture: { planned: count((entry, side) => entry[`${side}Image`] || entry[`${side}Outcome`]),
      done: count((entry, side) => entry[`${side}Image`]), baseFromCache: false },
    review,
  };
}


const visible = body => body.split('\n').filter(line => !line.startsWith('<!-- expo-explore-record') && !line.startsWith('<!-- expo-explore-history')).join('\n');
const summaries = body => [...body.matchAll(/<summary>([^<]+)<\/summary>/g)].map(match => match[1]);
const platformRow = (body, platform) => body.split('\n').find(line => line.startsWith(`| ${platform} |`));
const checkRow = (body, check) => body.split('\n').find(line => line.startsWith(`| ${check} |`));
const runLink = '[run](<https://github.com/expo/explore-playground/actions/runs/42/attempts/2>)';

test('the ready comment is one header, a platform table, the changes listed once, and a collapsed validation block', () => {
  const body = renderPublicComment(state({ artifactOnly: true }));
  const lines = body.split('\n');
  assert.equal(lines[0], CI_COMMENT_MARKER);
  assert.match(lines[1], /^<!-- expo-explore-record:ios:[A-Za-z0-9_-]+ -->$/);
  assert.match(lines[2], /^### Explore review · \[Open report\]\(<https:\/\/explore-preview\.expo\.app\/\?repo=expo%2Fexplore-playground&run=42&attempt=2[^>]*>\)$/, 'the report link is the heading, where a phone shows it first');
  assert.equal(lines[4], '<sub>base [aaaaaaaa](<https://github.com/expo/explore-playground/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa>) → [bbbbbbbb](<https://github.com/expo/explore-playground/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb>)</sub>');
  assert.deepEqual([lines[3], ...lines.slice(5, 8)], ['', '', '| | Device | Result | Report |', '|---|---|---|---|']);
  assert.equal(lines[8], `| iOS | iPhone 17 26\\.5 · Example 1\\.4\\.0 \\(27\\) | 🟩 3 changes · 6m 12s | [Open](<https://explore-preview.expo.app/?repo=expo%2Fexplore-playground&run=42&attempt=2&artifact=7654>) |`, 'the Report cell is the report link alone');
  assert.deepEqual(summaries(body), ['🟩 Added (1)', '🟥 Removed (1)', '🟧 Modified (1)', 'Validation · iOS 🟩 6/6 captured']);
  assert.match(body, /\n\*\*Changes\*\* · 3 screens\n/);
  assert.match(body, /\n- `\/settings` — Changed button title from “Share” to “Share Example”\\\. · \[iOS\]\(<https:\/\/explore-preview\.expo\.app\/\?repo=expo%2Fexplore-playground&run=42&attempt=2&artifact=7654&view=compare&screen=settings>\)\n/);
  assert.match(body, /\n- `\/cats\/care-guide` — Added \/cats\/care\\-guide screen · \[iOS\]\(<[^>]+screen=care-guide>\)\n/);
  assert.match(body, /\n- `\/cats\/sweet-bee` — Removed \/cats\/sweet\\-bee screen · \[iOS\]\(<[^>]+screen=sweet-bee>\)\n/);
  assert.equal(checkRow(body, 'Capture'), '| Capture | 🟩 6/6 surfaces · base cache reused |');
  assert.equal(checkRow(body, 'Route verification'), '| Route verification | 🟩 6/6 verified |');
  assert.equal(checkRow(body, 'Visual comparison'), '| Visual comparison | 🟩 2 compared · threshold 0.1 |');
  assert.equal(checkRow(body, 'Accessibility comparison'), '| Accessibility comparison | 🟩 2 compared · 1 description |');
  assert.equal(checkRow(body, 'Source inventory'), '| Source inventory | 🟩 54 routes |');
  assert.equal(lines.at(-1), `Managed via [\`.expo-explore/config.yaml\`](<https://github.com/expo/explore-playground/blob/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/.expo-explore/config.yaml>) · Workflow ${runLink} · [zip](<https://github.com/expo/explore-playground/actions/runs/42/artifacts/7654>)`, 'the run and the report zip sit in the footer');
  assert.doesNotMatch(body, /<img|### Review target|### What changed|### Validation|Unchanged|screen=cats|\/home|Reviewed at|Open Explore|Download report|View run/);
  assert.ok(body.indexOf('**Changes**') < body.indexOf('<summary>Validation'));
  // Hidden state is the only thing the comment carries besides markdown.
  assert.equal(lines.filter(line => line.startsWith('<!--')).length, 2);
});

test('report links appear only once a report exists; a failed run links the run and its evidence', () => {
  const beforeUpload = viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml' });
  const ready = renderPublicComment(state({ links: beforeUpload }));
  assert.match(platformRow(ready, 'iOS'), /\| 🟩 3 changes · 6m 12s \| \[run\]\(<[^>]+>\) \|$/, 'before the artifact exists there is nothing to open');
  assert.doesNotMatch(ready, /\[zip\]|\[Open\]/);
  const failed = renderPublicComment(state({ phase: 'failed', review: undefined, evidence: undefined, failure: { step: 'capture-head', message: 'head capture did not complete; token=abc123 leaked' } }));
  assert.equal(platformRow(failed, 'iOS'), `| iOS | iPhone 17 26\\.5 · Example 1\\.4\\.0 \\(27\\) | 🟥 failed · capture\\-head | ${runLink} · [evidence](<https://github.com/expo/explore-playground/actions/runs/42#artifacts>) |`);
  assert.deepEqual(summaries(failed), ['Validation · iOS 🟥 failed']);
  assert.match(failed, /\*\*iOS failed\*\* — head capture did not complete; token=\\\[redacted\\\] leaked \[Open the failed run\]\(<[^>]+>\) · \[Evidence artifact\]\(<[^>]+>\)/);
  assert.equal(checkRow(failed, 'Capture'), '| Capture | 🟥 6/6 surfaces |');
  assert.equal(checkRow(failed, 'Visual comparison'), '| Visual comparison | — |');
  assert.doesNotMatch(failed, /\*\*Changes\*\*|\[Open\]|\[zip\]|abc123/);
});

test('a secondary appearance surface (<route>@<scheme>) is listed with its scheme and deep-linked like any other route', () => {
  const dark = surface('settings@dark', 'added', { route: '/settings', extra: { colorScheme: 'dark', review: { status: 'added', description: 'Added the dark appearance of /settings.' } } });
  const body = renderPublicComment(state({ review: review([dark]) }));
  assert.match(body, /\n- `\/settings` \(dark\) — Added [^·]+ · \[iOS\]\(<[^>]+&view=compare&screen=settings%40dark>\)\n/);
});

test('agent notes replace descriptions without changing groups, counts, or the rest of the comment', () => {
  const original = evidenceReview();
  const annotated = structuredClone(original);
  for (const [index, text] of [[0, 'Added care guidance and a daily reminder action.'], [1, 'Removed the Sweet Bee activity screen.'], [2, 'The settings share action now reads “Share Example”.']]) {
    annotated.surfaces[index].note = { text, evidenceDigest: 'd'.repeat(64), evidence: [] };
  }
  const before = visible(renderPublicComment(state({ review: original })));
  const after = visible(renderPublicComment(state({ review: annotated })));
  assert.deepEqual(summaries(after), summaries(before));
  assert.equal(after.slice(after.indexOf('<summary>Validation')), before.slice(before.indexOf('<summary>Validation')));
  assert.equal(after.slice(0, after.indexOf('**Changes**')), before.slice(0, before.indexOf('**Changes**')));
  assert.match(after, /Added care guidance and a daily reminder action/);
  assert.match(after, /The settings share action now reads “Share Example”/);
  assert.doesNotMatch(after, /Changed button title from|evidenceDigest|Model|Tokens/);
});

test('a long group is capped before the body budget and the comment stays under GitHub\'s limit', () => {
  const many = review(Array.from({ length: 40 }, (_, index) => surface(`screen-${index}`, 'modified', { extra: {
    review: { status: 'modified', description: `Changed ${index}` },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 1, threshold: 0.1, tool: 'agent-device@0.20.2' },
  } })));
  const body = renderPublicComment(state({ review: many, capture: { planned: { base: 40, head: 40 }, done: { base: 40, head: 40 }, baseFromCache: false } }));
  assert.match(body, /<summary>🟧 Modified \(40\)<\/summary>/);
  assert.equal((body.match(/\n- `\/screen-\d+`/g) ?? []).length, 40);
  assert.ok(body.length < PUBLIC_COMMENT_BODY_BUDGET);
  const huge = review(Array.from({ length: 900 }, (_, index) => surface(`s${index}`, 'modified', { extra: { review: { status: 'modified', description: `Changed ${index} in a way that takes a sentence to describe for the budget check.` } } })));
  const long = renderPublicComment(state({ review: huge }));
  assert.ok(long.length < PUBLIC_COMMENT_BODY_BUDGET, String(long.length));
  assert.match(long, /<summary>🟧 Modified \(900\)<\/summary>/);
  assert.match(long, /\n- \d+ more — \[Explore report\]\(<[^>]+>\)\n/);
});

test('pending and capturing runs show progress in the platform table and no change lists', () => {
  const links = viewerLinks({ viewerUrl: 'https://explore-preview.expo.app/map', repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml' });
  const pending = renderPublicComment(state({ phase: 'pending', links, review: undefined, evidence: undefined, runtime: undefined, capture: { planned: { base: 3, head: 3 }, done: { base: 0, head: 0 }, baseFromCache: false } }));
  assert.equal(platformRow(pending, 'iOS'), `| iOS | Example 1\\.4\\.0 \\(27\\) | ⏳ starting | ${runLink} |`);
  assert.deepEqual(summaries(pending), []);
  assert.doesNotMatch(pending, /\*\*Changes\*\*|Validation|Waiting|Open|zip/);
  const progress = (current, baseFromCache) => platformRow(renderPublicComment(state({ phase: 'capturing', links, review: undefined, evidence: undefined,
    capture: { planned: { base: 3, head: 3 }, done: { base: 2, head: 1 }, baseFromCache, current } })), 'iOS');
  assert.match(progress('base', false), /\| ⏳ capturing base 2\/3 \| /);
  assert.match(progress('head', false), /\| ⏳ capturing head 1\/3 \| /);
  assert.match(progress('head', true), /\| ⏳ capturing head 1\/3 · base reused \| /);
  assert.match(progress(undefined, false), /\| ⏳ capturing head 1\/3 \| /);
  const none = renderPublicComment(state({ review: review([surface('cats', 'modified', { extra: { review: { status: 'unchanged', description: 'No visible change' } } })]) }));
  assert.deepEqual(summaries(none), ['Validation · iOS 🟩 6/6 captured'], 'unchanged surfaces produce no group');
  assert.match(none, /\*\*Changes\*\* · 0 screens\n\nNo screen changed on the reviewed platforms\./);
});

test('an OS version the simulator did not report is omitted, not shown as unknown', () => {
  const body = renderPublicComment(state({ runtime: { ...state().runtime, osVersion: 'unknown' } }));
  assert.match(platformRow(body, 'iOS'), /^\| iOS \| iPhone 17 · Example 1\\\.4\\\.0 \\\(27\\\) \|/);
  assert.doesNotMatch(body, /unknown/i);
});

test('without evidence the comment lists only added and removed screens and says comparisons did not run', () => {
  const plain = review([surface('care-guide', 'added'), surface('sweet-bee', 'removed'), surface('settings', 'modified'), surface('cats', 'unchanged')]);
  const body = renderPublicComment(reviewOnlyState(plain));
  // A source change nobody compared is not a change the captures show.
  assert.deepEqual(summaries(body).slice(0, 2), ['🟩 Added (1)', '🟥 Removed (1)']);
  assert.doesNotMatch(body, /Source-affected|screen=settings/);
  assert.equal(checkRow(body, 'Visual comparison'), '| Visual comparison | 🟨 not run |');
  assert.equal(checkRow(body, 'Accessibility comparison'), '| Accessibility comparison | 🟨 not run |');
  assert.match(platformRow(body, 'iOS'), /^\| iOS \| Example 1\\\.4\\\.0 \\\(27\\\) \| 🟨 2 changes · 1 not compared · 0s \|/, 'the uncompared /settings is counted, not hidden');
  assert.doesNotMatch(body, /Needs review|Unchanged|screen=cats/);
});

test('the completed duration stays tied to the captured review when the comment is republished', () => {
  const original = platformRow(renderPublicComment(state()), 'iOS');
  assert.equal(platformRow(renderPublicComment(state({ updatedAt: Date.parse('2026-09-12T09:42:00Z') })), 'iOS'), original);
  assert.match(original, /🟩 3 changes · 6m 12s/);
  assert.doesNotMatch(renderPublicComment(state({ phase: 'capturing', review: undefined })), /6m 12s/);
});

test('needs-review surfaces keep their group and validation status without capture warnings', () => {
  const flagged = evidenceReview();
  flagged.surfaces[2].review = { status: 'needs-review', description: 'Screenshots differ (2.1%) without a source change' };
  flagged.surfaces.push(surface('coins', 'unchanged', { extra: { sourceScope: 'none', review: { status: 'variant', description: 'Runtime state differs: Removed text “84”.' },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 0.2, threshold: 0.1, tool: 'agent-device@0.21.15' } } }));
  const body = renderPublicComment(state({ review: flagged, warnings: ['src/app/orphan.tsx has unresolved navigation'], inventory: { routes: 54 } }));
  assert.match(body, /<summary>🟨 Needs review \(1\)<\/summary>/);
  assert.doesNotMatch(body, /<summary>🟧 Modified/);
  assert.match(body, /\n- `\/settings` — Screenshots differ \\\(2\\\.1%\\\) without a source change · \[iOS\]/);
  assert.equal(checkRow(body, 'Source inventory'), '| Source inventory | 🟩 54 routes |');
  assert.doesNotMatch(body, /Capture warnings|orphan/);
});

test('text is redacted and escaped before it reaches the comment, and credentialed links are refused', () => {
  const tainted = evidenceReview();
  tainted.surfaces[2].review.description = 'Changed title to <b>bold</b> | secret=abc';
  const body = renderPublicComment(state({ review: tainted }));
  assert.match(body, /&lt;b&gt;bold&lt;\/b&gt; \\\| secret=\\\[redacted\\\]/);
  assert.throws(() => renderPublicComment(state({ links: { ...state().links, run: 'https://user:pw@github.com/x' } })), /credentials/);
});

test('completed partial capture shows unavailable targets rather than ongoing work', () => {
  const capture = { planned: { base: 34, head: 34 }, done: { base: 21, head: 34 }, baseFromCache: false };
  const ready = renderPublicComment(state({ capture }));
  assert.equal(checkRow(ready, 'Capture'), '| Capture | 🟨 55/68 surfaces · 13 unavailable |');
  assert.match(platformRow(ready, 'iOS'), /\| 🟨 3 changes · 13 unavailable · 6m 12s \|/);
  assert.doesNotMatch(ready, /⏳/);
  assert.equal(checkRow(renderPublicComment(state({ phase: 'failed', capture, failure: { step: 'capture-base', message: 'failed' } })), 'Capture'), '| Capture | 🟥 55/68 surfaces |');
  assert.equal(checkRow(renderPublicComment(state({ capture: { ...capture, done: { base: 34, head: 34 } } })), 'Capture'), '| Capture | 🟩 68/68 surfaces |');
  assert.equal(checkRow(renderPublicComment(state({ capture: { ...capture, done: { base: 0, head: 0 } } })), 'Capture'), '| Capture | 🟨 6/68 surfaces · 62 unavailable |', 'the review’s own frames count as captured');
  assert.equal(checkRow(renderPublicComment(state({ capture: { ...capture, baseFromCache: true } })), 'Capture'), '| Capture | 🟨 55/68 surfaces · 13 unavailable · base cache reused |');
});

test('capture problems are listed as diagnostics inside the validation block with both sides', () => {
  const flagged = evidenceReview();
  const failure = side => ({ status: 'failed', attempts: 1, landing: 'unverified', error: {
    code: `${side.toUpperCase()}_SESSION_FAILED`, stage: 'capture', message: `${side} simulator disconnected; token=private`,
    nextAction: `Restart the ${side} simulator session and rerun capture.`, retryable: true,
  } });
  flagged.surfaces[0].headOutcome = failure('head'); delete flagged.surfaces[0].headImage;
  flagged.surfaces[0].review = { status: 'needs-review', description: 'old capture failure' };
  flagged.surfaces[1].baseOutcome = failure('base'); delete flagged.surfaces[1].baseImage;
  flagged.surfaces[1].review = { status: 'needs-review', description: 'old capture failure' };
  flagged.surfaces[2].baseOutcome = failure('base'); delete flagged.surfaces[2].baseImage;
  flagged.surfaces[2].headOutcome.landing = 'unverified';
  flagged.surfaces[2].review = { status: 'needs-review', description: 'old destination failure' };
  const body = renderPublicComment(state({ review: flagged, capture: { planned: { base: 3, head: 3 }, done: { base: 1, head: 2 }, baseFromCache: false } }));
  // /settings could not be compared, so it is no change: its failures are named under Validation.
  assert.deepEqual(summaries(body), ['🟩 Added (1)', '🟥 Removed (1)', 'Validation · iOS 🟨 3/6 captured']);
  assert.match(platformRow(body, 'iOS'), /\| 🟨 2 changes · 3 unavailable · 1 unattributed · 6m 12s \|/);
  assert.match(body, /\n- Base · \/settings · /);
  assert.match(body, /\*\*iOS\*\* · base 1\/3 verified · 2 unavailable · head 1\/3 verified · 1 unattributed · 1 unavailable/);
  assert.match(body, /\n- Base · \/cats\/sweet\\-bee · BASE\\_SESSION\\_FAILED: base simulator disconnected; token=\\\[redacted\\\] Next action: Restart the base simulator session and rerun capture\\\./);
  assert.match(body, /\n- Head · \/cats\/care\\-guide · HEAD\\_SESSION\\_FAILED/);
  assert.doesNotMatch(body, /Needs review|Modified|old capture|old destination|token=private/);
});

test('zero eligible pairs are visibly skipped instead of successful comparisons', () => {
  const flagged = evidenceReview();
  for (const surface of flagged.surfaces) {
    for (const side of ['base', 'head']) if (surface[`${side}Outcome`]) surface[`${side}Outcome`].landing = 'unverified';
    if (surface.status === 'modified') delete surface.review;
  }
  const counts = { planned: 3, captured: 3, verified: 0, unverified: 3, unavailable: 0 };
  const body = renderPublicComment(state({ review: flagged, evidence: {
    capture: { base: counts, head: counts }, comparison: { planned: 2, eligible: 0, skipped: 2 }, diagnostics: [],
    visual: { compared: 0, modified: 0, unchanged: 0, needsReview: 0, failed: 0, errors: [], threshold: 0.1, tool: 'agent-device@0.20.2' },
    accessibility: { compared: 0, described: 0, failed: 0, skipped: 0, errors: [] },
  } }));
  assert.equal(checkRow(body, 'Route verification'), '| Route verification | 🟨 0/6 verified · 6 unattributed |');
  assert.equal(checkRow(body, 'Visual comparison'), '| Visual comparison | 🟨 0 compared · threshold 0.1 · 2 skipped |');
  assert.equal(checkRow(body, 'Accessibility comparison'), '| Accessibility comparison | 🟨 0 compared · 0 descriptions |');
  assert.match(platformRow(body, 'iOS'), /\| 🟨 2 changes · 6 unattributed · 6m 12s \|/, 'the uncompared modified screens are not changes');
});

test('the review-only comment counts failed outcomes in planned coverage and lists the reason', () => {
  const added = surface('added', 'added');
  delete added.headImage;
  added.headOutcome = { status: 'missing-params', attempts: 0, landing: 'unverified', reason: 'Provide the item ID.' };
  const body = renderPublicComment(reviewOnlyState(review([added])));
  assert.equal(checkRow(body, 'Capture'), '| Capture | 🟨 0/1 surfaces · 1 unavailable |');
  assert.match(body, /<summary>🟩 Added \(1\)<\/summary>/);
  assert.match(body, /CAPTURE\\_UNAVAILABLE: Provide the item ID\\\./);
});

test('a failed run keeps the source additions and removals of its partial report', () => {
  const body = renderPublicComment(state({ phase: 'failed', failure: { step: 'capture', message: 'Capture coverage is incomplete.' } }));
  assert.match(platformRow(body, 'iOS'), /\| 🟥 failed · capture \|/);
  assert.match(body, /\*\*iOS failed\*\* — Capture coverage is incomplete\\\./);
  assert.doesNotMatch(body, /\*\*Changes\*\*|🟩 Added/, 'a failed run has no review to list');
});

test('screen variants and app-wide changes are stated once, not listed as review targets', () => {
  const variant = surface('coins', 'unchanged', { extra: { sourceScope: 'none',
    review: { status: 'variant', description: 'Runtime state differs: Removed text “84”.' },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 0.2, threshold: 0.1, tool: 'agent-device@0.21.15' } } });
  const appWide = surface('profile', 'modified', { extra: { sourceScope: 'app-wide',
    review: { status: 'unchanged', description: 'No visible change' },
    sourceChange: { ...sourceChange('Dependency update.', 'global'), files: [{ path: 'package.json', status: 'modified', relation: 'global', hunks: [], facts: [], truncated: false }] } } });
  const body = renderPublicComment(state({ review: review([...evidenceReview().surfaces, variant, appWide]) }));
  assert.doesNotMatch(body, /\/coins|\/profile|Needs review \(/);
  assert.match(body, /1 screen differs only in runtime state \(screen variants\); no source change reaches it\./);
  assert.match(body, /App-wide source changes \(`package\.json`\) reach every screen; screens without a visible difference are not listed\./);
});

test('a hosted preview is the Open link, the footer keeps the zip and run and says how long the link works', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz234567';
  const preview = previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, Date.parse('2026-09-18T03:07:00Z'));
  const links = { ...viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml', artifactUrl }), preview };
  const body = renderPublicComment(state({ links, artifactOnly: true }));
  const lines = body.split('\n');
  assert.equal(lines[1], '<!-- expo-explore-deployments:acme-explore--1lcbdcpwn3 -->');
  assert.match(platformRow(body, 'iOS'), new RegExp(`\\| \\[Open\\]\\(<https://acme-explore--1lcbdcpwn3\\.expo\\.app/p/${token}>\\) \\|$`));
  assert.match(lines.at(-1), /· Workflow \[run\]\(<[^>]+>\) · \[zip\]\(<[^>]+>\)$/);
  assert.match(body, new RegExp(`\\[iOS\\]\\(<https://acme-explore--1lcbdcpwn3\\.expo\\.app/p/${token}\\?view=compare&screen=settings>\\)`));
  assert.match(lines.at(-1), /^Preview links work until Sep 18, 2026 \(UTC\) for anyone who has them\. · Managed via /);
  assert.doesNotMatch(body, /Open Explore|explore-viewer\.expo\.app|explore-preview\.expo\.app/);
  assert.doesNotMatch(renderPublicComment(state({ links, phase: 'failed', review: undefined, failure: { step: 'capture-head', message: 'boom' } })), /acme-explore--1lcbdcpwn3\.expo\.app\/p|for anyone who has/);
  const forever = renderPublicComment(state({ links: { ...links, preview: previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, null) }, artifactOnly: true }));
  assert.match(forever, /\nPreview links work for anyone who has them until the deployment is deleted\. · Managed via /);
});

test('two platforms share one comment: one table row each, every changed screen listed once with a link per platform, one validation table', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const ready = state({ artifactOnly: true });
  const single = renderPublicComment(ready);
  assert.equal(platformSectionMerge(ready, undefined).merge(undefined), single);
  assert.equal(platformSectionMerge(ready, 'ios').merge(undefined), single, 'the iOS writer of a matrix renders the same comment as a single-platform run');
  const androidState = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' },
    runtime: { ...state().runtime, platform: 'android', deviceModel: 'EasAndroidDevice01', osVersion: '15.0' }, ...overrides });
  const capturing = platformSectionMerge(androidState({ phase: 'capturing', review: undefined, evidence: undefined, capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 1 }, baseFromCache: false, current: 'head' } }), 'android').merge(single);
  assert.deepEqual(Object.keys(readCommentRecords(capturing).current), ['ios', 'android']);
  assert.equal(platformRow(capturing, 'iOS'), platformRow(single, 'iOS'));
  assert.equal(platformRow(capturing, 'Android'), `| Android | EasAndroidDevice01 15\\.0 · Example 1\\.4\\.0 \\(27\\) | ⏳ capturing head 1/3 | ${runLink} |`);
  assert.deepEqual(summaries(capturing), ['🟩 Added (1)', '🟥 Removed (1)', '🟧 Modified (1)', 'Validation · iOS 🟩 6/6 captured · Android ⏳ in progress']);
  assert.match(capturing, /\| Check \| iOS \| Android \|\n\|---\|---\|---\|\n\| Capture \| 🟩 6\/6 surfaces · base cache reused \| ⏳ \|/);
  assert.match(capturing, /\n- `\/settings` — Changed button title from “Share” to “Share Example”\\\. · \[iOS\]\(<[^>]+>\)\n/, 'a platform still capturing adds no link');
  const flagged = evidenceReview();
  flagged.surfaces[2].review = { status: 'needs-review', description: 'Screenshots differ (2.1%) without a source change' };
  flagged.surfaces.push(surface('coins', 'unchanged', { extra: { sourceScope: 'none', review: { status: 'variant', description: 'Runtime state differs: Removed text “84”.' },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 0.2, threshold: 0.1, tool: 'agent-device@0.21.15' } } }));
  const both = platformSectionMerge(androidState({ review: flagged }), 'android').merge(capturing);
  assert.deepEqual(Object.keys(readCommentRecords(both).current), ['ios', 'android']);
  assert.equal(platformRow(both, 'iOS'), platformRow(single, 'iOS'));
  assert.match(platformRow(both, 'Android'), /^\| Android \| EasAndroidDevice01 15\\\.0 · Example 1\\\.4\\\.0 \\\(27\\\) \| 🟩 3 changes · 6m 12s \| \[Open\]/);
  assert.match(both, /\*\*Changes\*\* · 3 screens · a screen is listed once, with a link per platform\n/);
  assert.match(capturing, /^### Explore review · \[Open report\]\(<[^>]+>\)$/m, 'a platform still capturing has no report to link yet');
  assert.match(both, /^### Explore review · \[iOS report\]\(<[^>]+>\) · \[Android report\]\(<[^>]+>\)$/m, 'with two platforms the heading links each report');
  assert.match(both, /\nAndroid · 1 screen differs only in runtime state \(screen variants\); no source change reaches it\.\n/, 'a context line from one platform names it');
  assert.doesNotMatch(both, /iOS · /);
  assert.match(both, /\n- `\/cats\/care-guide` — Added \/cats\/care\\-guide screen · \[iOS\]\(<[^>]+screen=care-guide>\) · \[Android\]\(<[^>]+screen=care-guide>\)\n/);
  assert.match(both, /\n- `\/settings` — Changed button title from “Share” to “Share Example”\\\. · \[iOS\]\(<[^>]+>\) · \[Android \(needs review\)\]\(<[^>]+>\)\n/, 'a platform whose verdict differs says so on the row');
  assert.deepEqual(summaries(both), ['🟩 Added (1)', '🟥 Removed (1)', '🟧 Modified (1)', 'Validation · iOS 🟩 6/6 captured · Android 🟩 8/8 captured']);
  assert.equal((both.match(/\n- `/g) ?? []).length, 3, 'no screen is listed twice');
  assert.equal((both.match(/\| Capture \|/g) ?? []).length, 1);
  assert.ok(both.length < 8_000, String(both.length));
  // A writer that finds no records (a legacy or hand-edited comment) starts over rather than failing.
  const legacy = `${CI_COMMENT_MARKER}\nExplore review for x\n<!-- expo-explore-platform:ios -->\n## iOS · 3 changes\n<!-- /expo-explore-platform:ios -->`;
  assert.equal(platformSectionMerge(ready, 'ios').merge(legacy), single);
  const tampered = both.replace(/expo-explore-record:android:[A-Za-z0-9_-]+/, 'expo-explore-record:android:AAAA');
  assert.equal(platformSectionMerge(ready, 'ios').merge(tampered), single);
});

test('a newer run moves the current run into Previous runs; a run the PR moved past joins history without displacing the current review', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const first = platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined);
  const androidReady = state({ artifactOnly: true, build: { ...state().build, platform: 'android' }, runtime: { ...state().runtime, platform: 'android', deviceModel: 'Pixel 9' } });
  const both = platformSectionMerge(androidReady, 'android').merge(first);
  const nextHead = 'd'.repeat(40);
  const nextLinks = runId => viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId, runAttempt: '1', configPath: '.expo-explore/config.yaml' });
  const nextState = overrides => state({ phase: 'capturing', review: undefined, evidence: undefined, links: nextLinks('43'), pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    startedAt: Date.parse('2026-09-11T04:00:00Z'), updatedAt: Date.parse('2026-09-11T04:01:00Z'), capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 0 }, baseFromCache: true, current: 'head' }, ...overrides });
  const next = platformSectionMerge(nextState(), 'ios').merge(both);
  assert.match(next.split('\n').find(line => line.startsWith('<sub>')), /^<sub>base \[aaaaaaaa\]\(<[^>]+>\) → \[dddddddd\]/);
  assert.deepEqual(Object.keys(readCommentRecords(next).current), ['ios']);
  assert.deepEqual(summaries(next), ['Previous runs (1)']);
  assert.match(next, /\n- \[bbbbbbbb\]\(<https:\/\/github\.com\/expo\/explore-playground\/commit\/b{40}>\) · iOS 🟩 3 changes \(\[report\]\(<https:\/\/explore-preview\.expo\.app\/\?repo=[^>]+&artifact=7654>\) · \[run\]\(<[^>]+runs\/42\/attempts\/2>\)\) · Android 🟩 3 changes \(\[report\]\(<[^>]+>\) · \[run\]\(<[^>]+>\)\)\n/);
  assert.doesNotMatch(next, /\*\*Changes\*\*|screen=settings/);
  // The previous run's Android report job finishes after the new run started: it is superseded and lands in history.
  const late = platformSectionMerge(androidReady, 'android').merge(next);
  assert.deepEqual(Object.keys(readCommentRecords(late).current), ['ios']);
  assert.equal(readCommentRecords(late).history.length, 1);
  assert.match(late, /^<sub>base \[aaaaaaaa\]\(<[^>]+>\) → \[dddddddd\]/m);
  // The new run's Android writer joins the current run, and the previous run stays listed.
  const joined = platformSectionMerge(nextState({ build: { ...state().build, platform: 'android' } }), 'android').merge(late);
  assert.deepEqual(Object.keys(readCommentRecords(joined).current), ['ios', 'android']);
  assert.deepEqual(summaries(joined), ['Previous runs (1)']);
  // Each later run pushes one more entry; history is capped.
  let body = joined;
  for (let run = 44; run < 52; run += 1) {
    const sha = run.toString(16).padStart(40, '0');
    body = platformSectionMerge(state({ links: viewerLinks({ repository: pullRequest.repository, headSha: sha, runId: String(run), runAttempt: '1', configPath: '.expo-explore/config.yaml' }),
      pullRequest: { ...pullRequest, head: { ref: 'feature', sha } }, startedAt: Date.parse('2026-09-11T04:00:00Z') + run, updatedAt: Date.parse('2026-09-11T04:01:00Z') + run }), 'ios').merge(body);
  }
  const history = readCommentRecords(body).history;
  assert.equal(history.length, 5);
  assert.deepEqual(history.map(entry => entry.runId), ['50', '49', '48', '47', '46']);
  assert.match(body, /<summary>Previous runs \(5\)<\/summary>/);
  assert.ok(body.length < PUBLIC_COMMENT_BODY_BUDGET);
  // A state marked superseded by its own writer goes straight to history even when the comment has nothing newer yet.
  const superseded = platformSectionMerge(state({ artifactOnly: true, superseded: true }), 'ios').merge(undefined);
  assert.match(superseded, /The pull request moved while this run worked; its report is kept here until the current run replaces it\./);
  const replaced = platformSectionMerge(nextState(), 'ios').merge(superseded);
  assert.match(replaced, /Previous runs \(1\)/);
});

test('the deployments line names every hosted preview the comment links right now, current and previous', async () => {
  const { platformSectionMerge, existingDeploymentMarker } = await import('../../dist/report/pr-comment-body.js');
  const marker = '<!-- expo-explore-deployments:acme-explore--abc123 -->';
  const preview = previewLinks('https://acme-explore--abc123.expo.app/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now() + 86_400_000);
  const deployed = state({ links: { ...state().links, preview } });
  const single = platformSectionMerge(deployed, undefined).merge(undefined);
  assert.equal(single.split('\n')[1], marker);
  assert.equal(existingDeploymentMarker(single), marker);
  assert.equal(platformSectionMerge(state(), undefined).merge(undefined).includes('expo-explore-deployments'), false);
  // A redeploy of the same run replaces the record and so the line; a newer run keeps the old preview in history.
  const redeployed = state({ links: { ...state().links, preview: previewLinks('https://acme-explore--def456.expo.app/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', Date.now() + 86_400_000) } });
  assert.equal(platformSectionMerge(redeployed, 'ios').merge(single).split('\n')[1], '<!-- expo-explore-deployments:acme-explore--def456 -->');
  const nextHead = 'd'.repeat(40);
  const next = state({ links: { ...viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }),
    preview: previewLinks('https://acme-explore--def456.expo.app/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', Date.now() + 86_400_000) }, pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } } });
  assert.equal(platformSectionMerge(next, 'ios').merge(single).split('\n')[1], '<!-- expo-explore-deployments:acme-explore--abc123,acme-explore--def456 -->');
  assert.equal(existingDeploymentMarker(`${CI_COMMENT_MARKER}\n<!-- expo-explore-deployments:Bad Host -->\nx`), undefined);
});

test('a report whose hosted preview is still deploying says so instead of linking the central Viewer', () => {
  const deploying = renderPublicComment(state({ links: { ...state().links, deploying: true }, artifactOnly: true }));
  assert.match(deploying, /^### Explore review · report deploying, not ready yet$/m, 'the heading says the report is not ready');
  assert.ok(!deploying.includes('explore-preview.expo.app'), 'no download-and-drop Viewer link while the hosted report is on its way');
  assert.match(deploying, /\| deploying… \|/, 'the Report cell says so');
  assert.match(deploying, /· Workflow \[run\]\(<[^>]+>\) · \[zip\]\(<[^>]+>\)$/, 'the footer keeps the zip and run');
  const deployed = renderPublicComment(state({ links: { ...state().links, deploying: true,
    preview: previewLinks('https://acme-explore--1lcbdcpwn3.expo.app/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', null) } }));
  assert.match(deployed, /^### Explore review · \[Open report\]\(<https:\/\/acme-explore--1lcbdcpwn3\.expo\.app[^>]*>\)$/m, 'once deployed the hosted report is the heading');
  const record = JSON.parse(JSON.stringify(platformRecordOf(state({ links: { ...state().links, deploying: true }, artifactOnly: true }))));
  assert.equal(record.links.report, undefined, 'the record carries no report link while deploying');
  assert.equal(parsePlatformRecord(record).links.deploying, true, 'the deploying flag survives the comment round trip');
});

test('a screen whose screenshots match but whose accessibility tree changed is listed as accessibility only, apart from the visual changes', () => {
  const accessibilityOnly = (id) => surface(id, 'modified', { extra: {
    review: { status: 'modified', description: 'Added button “Edit tempo”.', facts: [
      { category: 'element', templateId: 'element.added', bullet: 'Added button “Edit tempo”.' },
      { category: 'accessibility', templateId: 'accessibility.label-changed', bullet: 'Changed accessibility label from “lane-row-title-3” to “Clap”.' },
    ] },
    visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.20.2' },
    sourceChange: sourceChange('Labelled the lane rows.'),
  } });
  const withAccessibility = review([...evidenceReview().surfaces, accessibilityOnly('device-picker'), accessibilityOnly('enable-midi')]);
  const body = renderPublicComment(state({ review: withAccessibility, artifactOnly: true }));
  assert.match(platformRow(body, 'iOS'), /\| 🟩 3 visual changes · 2 accessibility only · 6m 12s \|/);
  assert.deepEqual(summaries(body), ['🟩 Added (1)', '🟥 Removed (1)', '🟧 Modified (1)', '🟦 Accessibility only (2)', 'Validation · iOS 🟩 10/10 captured']);
  assert.match(body, /\n\*\*Changes\*\* · 5 screens\n/);
  assert.match(body, /<summary>🟦 Accessibility only \(2\)<\/summary>\n\nBefore and After look the same\. What screen readers and voice control read changed\.\n\n- `\/device-picker` — Added button “Edit tempo”\\\. · \[iOS\]/);
  const record = parsePlatformRecord(JSON.parse(JSON.stringify(platformRecordOf(state({ review: withAccessibility, artifactOnly: true })))));
  assert.deepEqual(record.changes.filter(change => change.group === 'accessibility-only').map(change => change.id), ['device-picker', 'enable-midi'],
    'the group survives the comment round trip');
  // A comment with no accessibility-only screen keeps its plain count.
  assert.match(platformRow(renderPublicComment(state({ artifactOnly: true })), 'iOS'), /\| 🟩 3 changes · 6m 12s \|/);
});

test('a comment whose only changes are for assistive technology counts just those', () => {
  const only = review([surface('device-picker', 'modified', { extra: {
    review: { status: 'modified', description: 'Changed “Play” from a text to a button.', facts: [{ category: 'accessibility', templateId: 'accessibility.role-changed', bullet: 'Changed “Play” from a text to a button.' }] },
    visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.20.2' },
    sourceChange: sourceChange('Made Play a button.'),
  } })]);
  assert.match(platformRow(renderPublicComment(state({ review: only, artifactOnly: true })), 'iOS'), /\| 🟩 1 accessibility only · 6m 12s \|/);
});

test('a screen accessibility-only on iOS and visibly modified on Android is listed as Modified, whichever platform comes first', async () => {
  const { platformSectionMerge } = await import('../../dist/report/pr-comment-body.js');
  const settings = (verdict) => {
    const changed = evidenceReview();
    changed.surfaces[2].visual = { ...changed.surfaces[2].visual, verdict, mismatchPercentage: verdict === 'modified' ? 3.2 : 0 };
    return changed;
  };
  const androidState = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' },
    runtime: { ...state().runtime, platform: 'android', deviceModel: 'EasAndroidDevice01', osVersion: '15.0' }, ...overrides });
  const ios = renderPublicComment(state({ review: settings('unchanged'), artifactOnly: true }));
  assert.ok(summaries(ios).includes('🟦 Accessibility only (1)'), 'iOS alone: the screenshots match');
  const both = platformSectionMerge(androidState({ review: settings('modified') }), 'android').merge(ios);
  assert.deepEqual(summaries(both).slice(0, 3), ['🟩 Added (1)', '🟥 Removed (1)', '🟧 Modified (1)']);
  assert.doesNotMatch(both, /Accessibility only \(|Before and After look the same/);
  assert.match(both, /\n- `\/settings` — [^\n]+ · \[iOS \(accessibility only\)\]\(<[^>]+>\) · \[Android\]\(<[^>]+>\)\n/);
});

test('screens whose comparison did not run are counted as not compared, never as a green "no change"', () => {
  const uncompared = review([surface('settings', 'modified'), surface('tempo', 'modified')]);
  const body = renderPublicComment(state({ review: uncompared, artifactOnly: true }));
  assert.match(platformRow(body, 'iOS'), /\| 🟨 0 changes · 2 not compared · 6m 12s \|/);
  assert.match(body, /\nNo compared screen changed on the reviewed platforms\.\n/);
  // A screen that was never captured (outside the capture scope) stays out of the count.
  const outOfScope = surface('channel', 'modified');
  for (const key of ['baseImage', 'headImage', 'baseOutcome', 'headOutcome']) delete outOfScope[key];
  const quiet = renderPublicComment(state({ review: review([outOfScope]), artifactOnly: true, evidence: undefined, capture: { planned: { base: 0, head: 0 }, done: { base: 0, head: 0 }, baseFromCache: false } }));
  assert.match(platformRow(quiet, 'iOS'), /\| 🟩 0 changes · 6m 12s \|/);
  assert.match(quiet, /\nNo screen changed on the reviewed platforms\.\n/);
});

const duoTargets = [{ id: 'iphone', platform: 'ios', label: 'iPhone 17' }, { id: 'duo-closed', platform: 'ios', label: 'iPhone Duo (closed)' },
  { id: 'duo-open', platform: 'ios', label: 'iPhone Duo (open)' }, { id: 'android', platform: 'android', label: 'Pixel 7' }];
const targetState = (target, overrides = {}) => state({ artifactOnly: true, target, targets: duoTargets,
  build: { ...state().build, platform: target.platform }, runtime: { ...state().runtime, platform: target.platform, deviceModel: target.label }, ...overrides });

test('a config without targets writes the same records and comment as before targets: target ios and android are the platforms', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const perPlatform = [{ id: 'ios', platform: 'ios', label: 'iOS' }, { id: 'android', platform: 'android', label: 'Android' }];
  const android = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' }, runtime: { ...state().runtime, platform: 'android', deviceModel: 'Pixel 9' }, ...overrides });
  const before = platformSectionMerge(android(), 'android').merge(platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined));
  const after = platformSectionMerge(android({ target: perPlatform[1], targets: perPlatform }), 'android')
    .merge(platformSectionMerge(state({ artifactOnly: true, target: perPlatform[0], targets: perPlatform }), 'ios').merge(undefined));
  assert.equal(after, before, 'byte-identical comment, record lines included');
  const record = platformRecordOf(state({ target: perPlatform[0], targets: perPlatform }));
  assert.deepEqual(Object.keys(record).slice(0, 3), ['v', 'platform', 'runId'], 'no target, label or order fields');
  // A writer that knows its target only from the CLI flag (the state names none) keys its record the same way.
  assert.equal(platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined), renderPublicComment(state({ artifactOnly: true, target: perPlatform[0] })));
  assert.deepEqual(Object.keys(readCommentRecords(after).current), ['ios', 'android']);
});

test('several targets share a comment: one row each in config order, labelled by target, keyed by id in the records and history', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const [iphone, closed, open, android] = duoTargets;
  // Report jobs finish in any order; the comment follows config order.
  let body;
  for (const target of [android, open, iphone]) body = platformSectionMerge(targetState(target), target.id).merge(body);
  body = platformSectionMerge(targetState(closed, { phase: 'capturing', review: undefined, evidence: undefined,
    capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 1 }, baseFromCache: false, current: 'head' } }), 'duo-closed').merge(body);
  assert.deepEqual([...body.matchAll(/^<!-- expo-explore-record:([a-z0-9-]+):/gm)].map(match => match[1]), ['iphone', 'duo-closed', 'duo-open', 'android']);
  const records = readCommentRecords(body).current;
  assert.deepEqual(Object.keys(records).sort(), ['android', 'duo-closed', 'duo-open', 'iphone']);
  assert.deepEqual([records['duo-open'].platform, records['duo-open'].target, records['duo-open'].label, records['duo-open'].order], ['ios', 'duo-open', 'iPhone Duo (open)', 2]);
  assert.deepEqual([records.android.platform, records.android.target, records.android.label, records.android.order], ['android', undefined, 'Pixel 7', 3]);
  const lines = body.split('\n'), header = lines.indexOf('| | Device | Result | Report |');
  assert.deepEqual(lines.slice(header + 2, lines.indexOf('', header)).map(line => line.split(' | ')[0]),
    ['| iPhone 17', '| iPhone Duo \\(closed\\)', '| iPhone Duo \\(open\\)', '| Pixel 7']);
  assert.match(body, /^### Explore review · \[iPhone 17 report\]\(<[^>]+>\) · \[iPhone Duo \\\(open\\\) report\]\(<[^>]+>\) · \[Pixel 7 report\]\(<[^>]+>\)$/m);
  assert.match(body, /\*\*Changes\*\* · 3 screens · a screen is listed once, with a link per device\n/);
  assert.match(body, /\n- `\/cats\/care-guide` — Added \/cats\/care\\-guide screen · \[iPhone 17\]\(<[^>]+>\) · \[iPhone Duo \\\(open\\\)\]\(<[^>]+>\) · \[Pixel 7\]\(<[^>]+>\)\n/);
  assert.match(body, /\| Check \| iPhone 17 \| iPhone Duo \\\(closed\\\) \| iPhone Duo \\\(open\\\) \| Pixel 7 \|\n\|---\|---\|---\|---\|---\|/);
  assert.deepEqual(summaries(body).at(-1), 'Validation · iPhone 17 🟩 6/6 captured · iPhone Duo \\(closed\\) ⏳ in progress · iPhone Duo \\(open\\) 🟩 6/6 captured · Pixel 7 🟩 6/6 captured');
  // A newer run moves them all into history, still labelled and ordered by target.
  const nextHead = 'd'.repeat(40);
  const next = platformSectionMerge(targetState(open, { phase: 'capturing', review: undefined, evidence: undefined, pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    links: viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) }), 'duo-open').merge(body);
  assert.deepEqual(Object.keys(readCommentRecords(next).current), ['duo-open']);
  const history = readCommentRecords(next).history;
  assert.deepEqual(Object.keys(history[0].platforms).sort(), ['android', 'duo-closed', 'duo-open', 'iphone']);
  assert.match(next, /\n- \[bbbbbbbb\]\(<[^>]+>\) · iPhone 17 🟩 3 changes \(.*?\) · iPhone Duo \\\(closed\\\) ⏳ did not finish \(.*?\) · iPhone Duo \\\(open\\\) 🟩 3 changes \(.*?\) · Pixel 7 🟩 3 changes /);
});

test('a comment written by a per-platform version keeps parsing, and malformed target records are dropped', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const { encodeRecordPayload } = await import('../../dist/report/pr-comment-record.js');
  const old = platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined);
  // A run with targets follows a per-platform run: the iOS run lands in history under its old key and label.
  const nextHead = 'd'.repeat(40);
  const next = platformSectionMerge(targetState(duoTargets[0], { pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    links: viewerLinks({ artifactUrl: 'https://github.com/expo/explore-playground/actions/runs/43/artifacts/7655', repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) }), 'iphone').merge(old);
  assert.deepEqual(Object.keys(readCommentRecords(next).current), ['iphone']);
  assert.deepEqual(Object.keys(readCommentRecords(next).history[0].platforms), ['ios']);
  assert.match(next, /\n- \[bbbbbbbb\]\(<[^>]+>\) · iOS 🟩 3 changes /);
  const valid = platformRecordOf(targetState(duoTargets[2]));
  const line = (key, record) => `<!-- expo-explore-record:${key}:${encodeRecordPayload(record)} -->`;
  const parse = (...lines) => Object.keys(readCommentRecords([CI_COMMENT_MARKER, ...lines].join('\n')).current);
  assert.deepEqual(parse(line('duo-open', valid)), ['duo-open']);
  assert.deepEqual(parse(line('ios', valid)), [], 'the line names the record it carries');
  assert.deepEqual(parse(line('base', { ...valid, target: 'base' })), [], 'reserved ids are not targets');
  assert.deepEqual(parse(line('duo-open', { ...valid, label: 'x'.repeat(81) })), []);
  assert.deepEqual(parse(line('duo-open', { ...valid, order: 8 })), []);
  const many = Array.from({ length: 10 }, (_, index) => line(`t${index}`, { ...valid, target: `t${index}` }));
  assert.equal(parse(...many).length, 8, 'a comment holds at most one record per configurable target');
});

test('with report.comment.map, the map draws the added, removed and visually changed screens, the screens one step before them, and tabs as a group', async () => {
  const { readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const edge = (from, to, kind) => ({ from, to, kind, sourceFile: 'src/app/_layout.tsx', provenance: 'source' });
  const graph = edges => ({ contract: 'explore.navigation', edges, modalSurfaceIds: [], unresolved: [] });
  const base = evidenceReview();
  const dark = surface('settings@dark', 'modified', { route: '/settings', extra: base.surfaces[2].review && { review: base.surfaces[2].review, visual: base.surfaces[2].visual } });
  const withNavigation = { ...base, surfaces: [...base.surfaces, dark], navigation: {
    // home is a redirect, not a screen; cats and settings are tabs; cats changed only in source, so it is drawn as the way to care-guide.
    head: graph([edge('cats', 'care-guide', 'push'), edge('cats', 'settings', 'tab'), edge('settings', 'cats', 'tab'), edge('home', 'cats', 'replace')]),
    base: graph([edge('cats', 'sweet-bee', 'push'), edge('cats', 'settings', 'tab')]),
  } };
  // Off by default: a review with hundreds of changed screens would draw a wall.
  assert.ok(!/<summary>Map/.test(renderPublicComment(state({ artifactOnly: true, review: withNavigation }))));
  assert.equal(platformRecordOf(state({ review: withNavigation })).navigation, undefined);
  const body = renderPublicComment(state({ artifactOnly: true, map: true, review: withNavigation }));
  assert.deepEqual(summaries(body), ['🟩 Added (1)', '🟥 Removed (1)', '🟧 Modified (2)', 'Map (4 screens)', 'Validation · iOS 🟩 8/8 captured']);
  const map = body.slice(body.indexOf('```mermaid'), body.indexOf('```\n', body.indexOf('```mermaid')) + 3);
  assert.equal(map, ['```mermaid', 'flowchart LR', '  subgraph tabs["Tabs"]', '    n0["/cats"]', '    n3["/settings"]', '  end',
    '  n1["/cats/care-guide"]', '  n2["/cats/sweet-bee"]', '  n0 -->|push| n1', '  n0 -.->|push| n2',
    '  classDef added stroke:#1a7f37,stroke-width:3px', '  class n1 added', '  classDef modified stroke:#bc4c00,stroke-width:3px', '  class n3 modified',
    '  classDef removed stroke:#cf222e,stroke-width:2px,stroke-dasharray:5 4', '  class n2 removed', '```'].join('\n'));
  assert.ok(body.indexOf('<summary>🟧 Modified') < body.indexOf('<summary>Map') && body.indexOf('<summary>Map') < body.indexOf('<summary>Validation'));
  assert.match(body, /<summary>Map \(4 screens\)<\/summary>\n\n```mermaid\n/, 'a blank line opens the fence inside the collapsible');
  assert.deepEqual(readCommentRecords(body).current.ios.navigation, platformRecordOf(state({ map: true, review: withNavigation })).navigation, 'the map is carried in the record');

  // A label cannot end itself, its line or the fence.
  const odd = { ...withNavigation, surfaces: withNavigation.surfaces.map(entry => entry.id === 'care-guide'
    ? { ...entry, head: { ...entry.head, logicalPath: 'cats/"a"#<b>`c`' } } : entry) };
  assert.match(renderPublicComment(state({ map: true, review: odd })), /\n {2}n1\["\/cats\/#quot;a#quot;#35;#lt;b#gt;#96;c#96;"\]\n/);
  // No navigation, or nothing changed visually: no map.
  assert.ok(!summaries(renderPublicComment(state({ map: true }))).includes('Map (4 screens)'));
  const unchanged = { ...withNavigation, surfaces: withNavigation.surfaces.filter(entry => entry.status !== 'added' && entry.status !== 'removed' && !entry.id.startsWith('settings')) };
  assert.ok(!/<summary>Map/.test(renderPublicComment(state({ map: true, review: unchanged }))));
});

test('the map is dropped before the change lists shrink, and a malformed map is dropped from the record', async () => {
  const { encodeRecordPayload } = await import('../../dist/report/pr-comment-record.js');
  const { readCommentRecords, renderCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const record = { ...platformRecordOf(state()), navigation: { nodes: [{ route: '/a', group: 'modified' }, { route: '/b' }], edges: [{ from: 1, to: 0, kinds: ['push'] }] } };
  const records = { current: { ios: record }, history: [] };
  assert.match(renderCommentRecords(records), /<summary>Map \(2 screens\)<\/summary>/);
  const tight = renderCommentRecords(records, undefined, renderCommentRecords(records).length - 1);
  assert.ok(!tight.includes('```mermaid'));
  assert.match(tight, /<summary>🟧 Modified \(1\)<\/summary>/);
  const parse = navigation => readCommentRecords(`<!-- expo-explore-record:ios:${encodeRecordPayload({ ...record, navigation })} -->`).current.ios;
  assert.deepEqual(parse(record.navigation).navigation, record.navigation);
  for (const navigation of [{ ...record.navigation, edges: [{ from: 0, to: 2, kinds: ['push'] }] }, { ...record.navigation, edges: [{ from: 0, to: 1, kinds: ['teleport'] }] },
    { ...record.navigation, nodes: [{ route: '/a', group: 'needs-review' }, { route: '/b' }] }, { nodes: [], edges: [] }]) {
    const parsed = parse(navigation);
    assert.ok(parsed, 'the rest of the record still parses');
    assert.equal(parsed.navigation, undefined);
  }
});
