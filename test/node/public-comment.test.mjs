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

const visible = body => body.split('\n').filter(line => !line.startsWith('<!-- expo-explore-record') && !line.startsWith('<!-- expo-explore-previous') && !line.startsWith('<!-- expo-explore-history')).join('\n');
const summaries = body => [...body.matchAll(/<summary>([^<]+)<\/summary>/g)].map(match => match[1]);
const titleOf = body => body.split('\n').find(line => line.startsWith('### '));
/** The `<sub>` two lines under the heading; the footer is the last line. */
const subtitleOf = body => { const lines = body.split('\n'); return lines[lines.findIndex(line => line.startsWith('### ')) + 2]; };
const statusOf = (body, label) => body.split('\n').find(line => line.startsWith(`${label} · `) || line.startsWith(`**${label} failed**`));
/** The changed-screen rows: the list before any collapsed block. */
const listOf = body => visible(body).split('\n<details>')[0].split('\n').filter(line => line.startsWith('- '));
const runLink = '[run](<https://github.com/expo/explore-playground/actions/runs/42/attempts/2>)';
const workflowRun = '[Workflow run](<https://github.com/expo/explore-playground/actions/runs/42/attempts/2>)';
const evidenceLink = '[evidence](<https://github.com/expo/explore-playground/actions/runs/42#artifacts>)';
const reportUrl = 'https://explore-preview.expo.app/?repo=expo%2Fexplore-playground&run=42&attempt=2&artifact=7654';
const commits = `[bbbbbbbb](<https://github.com/expo/explore-playground/commit/${headSha}>) vs [aaaaaaaa](<https://github.com/expo/explore-playground/commit/${baseSha}>)`;
const configLink = `[Config](<https://github.com/expo/explore-playground/blob/${headSha}/.expo-explore/config.yaml>)`;

test('the ready comment is a heading with the count and the report, a subtitle, the changed screens, and a footer', () => {
  const body = renderPublicComment(state({ artifactOnly: true }));
  const lines = body.split('\n');
  assert.equal(lines[0], CI_COMMENT_MARKER);
  assert.match(lines[1], /^<!-- expo-explore-record:ios:[A-Za-z0-9_-]+ -->$/);
  assert.equal(lines[2], `### 3 screens changed · [Review in Explore](<${reportUrl}>)`, 'the report link is the heading, where a phone shows it first');
  assert.equal(lines[4], `<sub>[iOS](<${reportUrl}>) · ${commits} · updated Sep 11, 3:07 AM UTC</sub>`);
  assert.deepEqual(lines.slice(5, 10), ['',
    `- Added [\`/cats/care-guide\`](<${reportUrl}&view=compare&screen=care-guide>)`,
    `- Removed [\`/cats/sweet-bee\`](<${reportUrl}&view=compare&screen=sweet-bee>)`,
    `- [\`/settings\`](<${reportUrl}&view=compare&screen=settings>) · Changed button title from “Share” to “Share Example”`, '']);
  assert.equal(lines.at(-1), `<sub>${workflowRun} · ${configLink}</sub>`, 'the run and the config sit in the footer');
  assert.equal(lines.length, 11);
  assert.deepEqual(summaries(body), []);
  assert.doesNotMatch(body, /<img|\*\*Changes\*\*|Validation|Capture issues|🟩|🟧|🟨|Managed via|zip|6m 12s|iPhone 17|Example 1|Unchanged|screen=cats|\/home|Reviewed at|Open Explore|Download report|View run|^\|/m);
  // Hidden state is the only thing the comment carries besides markdown.
  assert.equal(lines.filter(line => line.startsWith('<!--')).length, 2);
});

test('report links appear only once a report exists; a failed target says so with its run and evidence', () => {
  const beforeUpload = viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml' });
  const ready = renderPublicComment(state({ links: beforeUpload }));
  assert.equal(titleOf(ready), '### 3 screens changed', 'before the artifact exists there is nothing to open');
  assert.match(subtitleOf(ready), /^<sub>iOS · \[bbbbbbbb\]/);
  assert.match(ready, /\n- Added `\/cats\/care-guide`\n/);
  assert.doesNotMatch(ready, /\[zip\]|\[Open\]|Review in Explore|explore-preview/);
  const failed = renderPublicComment(state({ phase: 'failed', review: undefined, evidence: undefined, failure: { step: 'capture-head', message: 'head capture did not complete; token=abc123 leaked' } }));
  assert.equal(titleOf(failed), '### Explore review · capture failed');
  assert.equal(statusOf(failed, 'iOS'), `**iOS failed** · capture\\-head · head capture did not complete; token=\\[redacted\\] leaked · ${runLink} · ${evidenceLink}`);
  assert.deepEqual(listOf(failed), []);
  assert.doesNotMatch(failed, /\[Open\]|\[zip\]|abc123|Review in Explore|Validation/);
});

test('a secondary appearance surface (<route>@<scheme>) is listed with its scheme and deep-linked like any other route', () => {
  const dark = surface('settings@dark', 'added', { route: '/settings', extra: { colorScheme: 'dark', review: { status: 'added', description: 'Added the dark appearance of /settings.' } } });
  const body = renderPublicComment(state({ review: review([dark]) }));
  assert.match(body, /\n- Added \[`\/settings`\]\(<[^>]+&view=compare&screen=settings%40dark>\) \(dark\)\n/, 'an added screen needs no description beyond its route');
});

test('agent notes replace descriptions without changing counts or the rest of the comment', () => {
  const original = evidenceReview();
  const annotated = structuredClone(original);
  for (const [index, text] of [[0, 'Added care guidance and a daily reminder action.'], [1, 'Removed the Sweet Bee activity screen.'], [2, 'The settings share action now reads “Share Example”.']]) {
    annotated.surfaces[index].note = { text, evidenceDigest: 'd'.repeat(64), evidence: [] };
  }
  const before = visible(renderPublicComment(state({ review: original })));
  const after = visible(renderPublicComment(state({ review: annotated })));
  assert.equal(titleOf(after), titleOf(before));
  assert.equal(subtitleOf(after), subtitleOf(before));
  assert.equal(after.split('\n').at(-1), before.split('\n').at(-1));
  assert.equal(listOf(after).length, listOf(before).length);
  assert.match(after, /\n- Added \[`\/cats\/care-guide`\]\(<[^>]+>\) · Added care guidance and a daily reminder action\n/, 'a note on an added screen follows the route');
  assert.match(after, /\n- \[`\/settings`\]\(<[^>]+>\) · The settings share action now reads “Share Example”\n/);
  assert.doesNotMatch(after, /Changed button title from|evidenceDigest|Model|Tokens/);
});

test('the list shows ten screens and links the rest; the comment stays under GitHub\'s limit', () => {
  const screens = (count, description) => review(Array.from({ length: count }, (_, index) => surface(`screen-${index}`, 'modified', { extra: {
    review: { status: 'modified', description: description(index) },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 1, threshold: 0.1, tool: 'agent-device@0.20.2' },
  } })));
  const body = renderPublicComment(state({ review: screens(40, index => `Changed ${index}`), capture: { planned: { base: 40, head: 40 }, done: { base: 40, head: 40 }, baseFromCache: false } }));
  assert.equal(titleOf(body), `### 40 screens changed · [Review in Explore](<${reportUrl}>)`);
  assert.equal((body.match(/\n- \[`\/screen-\d+`\]/g) ?? []).length, 10);
  assert.equal(listOf(body).at(-1), `- [30 more screens in the report](<${reportUrl}>)`);
  assert.ok(body.length < PUBLIC_COMMENT_BODY_BUDGET);
  assert.equal(listOf(renderPublicComment(state({ review: screens(11, () => 'Changed') }))).at(-1), `- [1 more screen in the report](<${reportUrl}>)`);
  assert.equal(listOf(renderPublicComment(state({ review: screens(10, () => 'Changed') }))).length, 10, 'ten screens need no link to the rest');
  const long = renderPublicComment(state({ review: screens(900, index => `Changed ${index} in a way that takes a sentence to describe for the budget check.`) }));
  assert.ok(long.length < PUBLIC_COMMENT_BODY_BUDGET, String(long.length));
  assert.match(titleOf(long), /^### 900 screens changed · /);
  assert.match(long, /\n- \[890 more screens in the report\]\(<[^>]+>\)\n/);
});

test('pending and capturing runs say what they are doing in the heading and a line per target, with no list', () => {
  const links = viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml' });
  const pending = renderPublicComment(state({ phase: 'pending', links, review: undefined, evidence: undefined, runtime: undefined, capture: { planned: { base: 3, head: 3 }, done: { base: 0, head: 0 }, baseFromCache: false } }));
  assert.equal(titleOf(pending), '### Explore review · starting');
  assert.equal(subtitleOf(pending), `<sub>iOS · ${commits} · updated Sep 11, 3:07 AM UTC</sub>`);
  assert.equal(statusOf(pending, 'iOS'), `iOS · starting · ${runLink}`);
  assert.deepEqual(listOf(pending), []);
  assert.deepEqual(summaries(pending), []);
  assert.doesNotMatch(pending, /changed|Review in Explore|Validation|Waiting|Open|zip/);
  const progress = (current, baseFromCache) => statusOf(renderPublicComment(state({ phase: 'capturing', links, review: undefined, evidence: undefined,
    capture: { planned: { base: 3, head: 3 }, done: { base: 2, head: 1 }, baseFromCache, current } })), 'iOS');
  assert.equal(progress('base', false), `iOS · capturing base 2/3 · ${runLink}`);
  assert.equal(progress('head', false), `iOS · capturing head 1/3 · ${runLink}`);
  assert.equal(progress('head', true), `iOS · capturing head 1/3 · base reused · ${runLink}`);
  assert.equal(progress(undefined, false), `iOS · capturing head 1/3 · ${runLink}`);
  assert.equal(titleOf(renderPublicComment(state({ phase: 'capturing', links, review: undefined, evidence: undefined }))), '### Explore review · capturing');
  const none = renderPublicComment(state({ review: review([surface('cats', 'modified', { extra: { review: { status: 'unchanged', description: 'No visible change' } } })]) }));
  assert.equal(titleOf(none), `### No screens changed · [Review in Explore](<${reportUrl}>)`, 'unchanged surfaces are no change');
  assert.deepEqual(listOf(none), []);
});

test('without evidence the comment lists only added and removed screens and counts the uncompared one', () => {
  const plain = review([surface('care-guide', 'added'), surface('sweet-bee', 'removed'), surface('settings', 'modified'), surface('cats', 'unchanged')]);
  const body = renderPublicComment(reviewOnlyState(plain));
  // A source change nobody compared is not a change the captures show.
  assert.match(titleOf(body), /^### 2 screens changed · /);
  assert.deepEqual(listOf(body).map(line => /^- (Added|Removed) /.exec(line)?.[1]), ['Added', 'Removed']);
  assert.equal(statusOf(body, 'iOS'), `iOS · 1 not compared · ${runLink}`, 'the uncompared /settings is counted, not hidden');
  assert.doesNotMatch(body, /Source-affected|screen=settings|Needs review|Unchanged|screen=cats|not run/);
});

test('the subtitle says when the comment last changed: the review\'s time once ready, the writer\'s before', () => {
  assert.match(subtitleOf(renderPublicComment(state({ updatedAt: Date.parse('2026-09-12T09:42:00Z') }))), /· updated Sep 11, 3:07 AM UTC<\/sub>$/, 'a republished review keeps its time');
  assert.match(subtitleOf(renderPublicComment(state({ phase: 'capturing', review: undefined, updatedAt: Date.parse('2026-09-12T09:42:00Z') }))), /· updated Sep 12, 9:42 AM UTC<\/sub>$/);
});

test('needs-review surfaces are tagged on their row; screen variants and capture warnings stay out', () => {
  const flagged = evidenceReview();
  flagged.surfaces[2].review = { status: 'needs-review', description: 'Screenshots differ (2.1%) without a source change' };
  flagged.surfaces.push(surface('coins', 'unchanged', { extra: { sourceScope: 'none', review: { status: 'variant', description: 'Runtime state differs: Removed text “84”.' },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 0.2, threshold: 0.1, tool: 'agent-device@0.21.15' } } }));
  const body = renderPublicComment(state({ review: flagged, warnings: ['src/app/orphan.tsx has unresolved navigation'], inventory: { routes: 54 } }));
  assert.match(titleOf(body), /^### 3 screens changed · /);
  assert.match(body, /\n- \[`\/settings`\]\(<[^>]+>\) · Screenshots differ \\\(2\\\.1%\\\) without a source change · needs review\n/);
  assert.doesNotMatch(body, /coins|Capture warnings|orphan|Needs review \(|54 routes/);
});

test('text is redacted and escaped before it reaches the comment, and credentialed links are refused', () => {
  const tainted = evidenceReview();
  tainted.surfaces[2].review.description = 'Changed title to <b>bold</b> | secret=abc';
  const body = renderPublicComment(state({ review: tainted }));
  assert.match(body, /&lt;b&gt;bold&lt;\/b&gt; \\\| secret=\\\[redacted\\\]/);
  assert.throws(() => renderPublicComment(state({ links: { ...state().links, run: 'https://user:pw@github.com/x' } })), /credentials/);
});

test('a completed partial capture gets one line with the count of missing captures, not ongoing work', () => {
  const capture = { planned: { base: 34, head: 34 }, done: { base: 21, head: 34 }, baseFromCache: false };
  const ready = renderPublicComment(state({ capture }));
  assert.equal(statusOf(ready, 'iOS'), `iOS · 13 captures unavailable · ${runLink}`);
  assert.match(titleOf(ready), /^### 3 screens changed · /);
  assert.doesNotMatch(ready, /⏳|Capture issues|surfaces/);
  assert.equal(statusOf(renderPublicComment(state({ phase: 'failed', capture, failure: { step: 'capture-base', message: 'failed' } })), 'iOS'), `**iOS failed** · capture\\-base · failed · ${runLink} · ${evidenceLink}`);
  assert.equal(statusOf(renderPublicComment(state({ capture: { ...capture, done: { base: 34, head: 34 } } })), 'iOS'), undefined, 'a complete capture needs no line');
  assert.equal(statusOf(renderPublicComment(state({ capture: { ...capture, done: { base: 0, head: 0 } } })), 'iOS'), `iOS · 62 captures unavailable · ${runLink}`, 'the review’s own frames count as captured');
});

test('capture problems are counted on the target\'s line and listed, collapsed, with both sides', () => {
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
  // /settings could not be compared, so it is no change: its failures are named under Capture issues.
  assert.match(titleOf(body), /^### 2 screens changed · /);
  assert.equal(statusOf(body, 'iOS'), `iOS · 3 captures unavailable · 1 unattributed · ${runLink}`);
  assert.deepEqual(summaries(body), ['Capture issues (4)']);
  assert.ok(body.indexOf('<summary>Capture issues') > body.indexOf('\n- Removed '), 'the list comes first');
  assert.match(body, /\n- Base · \/settings · /);
  assert.match(body, /\n- Base · \/cats\/sweet\\-bee · BASE\\_SESSION\\_FAILED: base simulator disconnected; token=\\\[redacted\\\] Next action: Restart the base simulator session and rerun capture\\\./);
  assert.match(body, /\n- Head · \/cats\/care\\-guide · HEAD\\_SESSION\\_FAILED/);
  assert.doesNotMatch(body, /needs review|Modified|old capture|old destination|token=private|\*\*iOS\*\*|Validation/);
});

test('a target whose dark session failed reads as ready, counts its dark frames unavailable, and names each one with the session\'s error', () => {
  // brentvatne/euxy's main baseline run 39506374824: the light session captured every route, the dark session's install failed.
  const error = { code: 'CAPTURE_SESSION_FAILED', stage: 'session', message: 'install: argent run list-devices failed: GET /tools failed: 404 Not Found',
    nextAction: 'Rerun the capture on a new session.', retryable: true };
  const unchanged = { review: { status: 'unchanged', description: 'No visible change' }, visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.20.2' } };
  const light = surface('settings', 'modified', { extra: { colorScheme: 'light', ...unchanged } });
  const dark = surface('settings@dark', 'modified', { route: '/settings', extra: { colorScheme: 'dark',
    headOutcome: { status: 'failed', attempts: 0, landing: 'unverified', reason: error.message, error } } });
  delete dark.headImage;
  const body = renderPublicComment(state({ review: review([light, dark]), evidence: undefined, capture: { planned: { base: 1, head: 1 }, done: { base: 1, head: 1 }, baseFromCache: true } }));
  assert.doesNotMatch(body, /failed\*\*|capture failed|🟥/, 'one appearance missing is not a failed review');
  assert.equal(statusOf(body, 'iOS'), `iOS · 1 capture unavailable · ${runLink}`);
  assert.deepEqual(summaries(body), ['Capture issues (1)']);
  assert.match(titleOf(body), /^### No compared screens changed · /);
  assert.match(body, /\n- Head · \/settings \\\(dark\\\) · CAPTURE\\_SESSION\\_FAILED: install\\: argent run list\\-devices failed\\: GET \/tools failed\\: 404 Not Found Next action: Rerun the capture on a new session\\\.\n/);
  assert.doesNotMatch(body, /\n- Head · \/settings · /, 'the light frame is not the one that failed');
});

test('zero eligible pairs are counted as unattributed instead of successful comparisons', () => {
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
  assert.match(titleOf(body), /^### 2 screens changed · /, 'the uncompared modified screens are not changes');
  assert.equal(statusOf(body, 'iOS'), `iOS · 6 unattributed · ${runLink}`);
});

test('the review-only comment counts failed outcomes as unavailable and lists the reason', () => {
  const added = surface('added', 'added');
  delete added.headImage;
  added.headOutcome = { status: 'missing-params', attempts: 0, landing: 'unverified', reason: 'Provide the item ID.' };
  const body = renderPublicComment(reviewOnlyState(review([added])));
  assert.equal(statusOf(body, 'iOS'), `iOS · 1 capture unavailable · ${runLink}`);
  assert.match(body, /\n- Added \[`\/added`\]\(<[^>]+screen=added>\)\n/);
  assert.deepEqual(summaries(body), ['Capture issues (1)']);
  assert.match(body, /CAPTURE\\_UNAVAILABLE: Provide the item ID\\\./);
});

test('a failed run keeps its message on the target\'s line and lists nothing', () => {
  const body = renderPublicComment(state({ phase: 'failed', failure: { step: 'capture', message: 'Capture coverage is incomplete.' } }));
  assert.equal(titleOf(body), '### Explore review · capture failed');
  assert.equal(statusOf(body, 'iOS'), `**iOS failed** · capture · Capture coverage is incomplete\\. · ${runLink} · ${evidenceLink}`);
  assert.deepEqual(listOf(body), [], 'a failed run has no review to list');
});

test('screen variants and app-wide source changes are left to the report', () => {
  const variant = surface('coins', 'unchanged', { extra: { sourceScope: 'none',
    review: { status: 'variant', description: 'Runtime state differs: Removed text “84”.' },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 0.2, threshold: 0.1, tool: 'agent-device@0.21.15' } } });
  const appWide = surface('profile', 'modified', { extra: { sourceScope: 'app-wide',
    review: { status: 'unchanged', description: 'No visible change' },
    sourceChange: { ...sourceChange('Dependency update.', 'global'), files: [{ path: 'package.json', status: 'modified', relation: 'global', hunks: [], facts: [], truncated: false }] } } });
  const body = renderPublicComment(state({ review: review([...evidenceReview().surfaces, variant, appWide]) }));
  assert.match(titleOf(body), /^### 3 screens changed · /);
  assert.doesNotMatch(body, /\/coins|\/profile|runtime state|App-wide|package\.json/);
});

test('a changed splash screen is one line after the list; an unchanged one is not mentioned', () => {
  const launch = verdict => ({ ...evidenceReview(), launch: [
    { colorScheme: 'light', head: { status: 'observed', source: 'recording', splashVisibleMs: 900, firstScreenMs: 1900 }, base: { status: 'observed' }, visual: { verdict } },
    { colorScheme: 'dark', head: { status: 'observed', source: 'recording', splashVisibleMs: 900, firstScreenMs: 1900 }, base: { status: 'observed' }, visual: { verdict: 'unchanged' } }] });
  const changed = renderPublicComment(state({ review: launch('modified'), artifactOnly: true }));
  assert.match(changed, /\n- \[`\/settings`\][^\n]+\n\nSplash screen changed in light mode\n\n<sub>/);
  assert.match(renderPublicComment(state({ review: launch('needs-review'), artifactOnly: true })), /\nSplash screen needs review in light mode\n/);
  assert.doesNotMatch(renderPublicComment(state({ review: launch('unchanged'), artifactOnly: true })), /Splash|Launch|first screen/);
  const both = { ...evidenceReview(), launch: [{ head: { status: 'observed', source: 'recording' }, base: { status: 'observed' }, visual: { verdict: 'modified' } }] };
  assert.match(renderPublicComment(state({ review: both, artifactOnly: true })), /\nSplash screen changed\n/);
});

test('a hosted preview is the report link, and the footer says how long the links work', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz234567';
  const preview = previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, Date.parse('2026-09-18T03:07:00Z'));
  const links = { ...viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml', artifactUrl }), preview };
  const body = renderPublicComment(state({ links, artifactOnly: true }));
  const lines = body.split('\n');
  assert.equal(lines[1], '<!-- expo-explore-deployments:acme-explore--1lcbdcpwn3 -->');
  assert.equal(titleOf(body), `### 3 screens changed · [Review in Explore](<https://acme-explore--1lcbdcpwn3.expo.app/p/${token}>)`);
  assert.equal(subtitleOf(body), `<sub>[iOS](<https://acme-explore--1lcbdcpwn3.expo.app/p/${token}>) · ${commits} · updated Sep 11, 3:07 AM UTC</sub>`);
  assert.match(body, new RegExp(`\\n- \\[\`/settings\`\\]\\(<https://acme-explore--1lcbdcpwn3\\.expo\\.app/p/${token}\\?view=compare&screen=settings>\\) · `));
  assert.equal(lines.at(-1), `<sub>Preview links work for anyone who has them until Sep 18, 2026 (UTC) · ${workflowRun} · ${configLink}</sub>`);
  assert.doesNotMatch(body, /Open Explore|explore-viewer\.expo\.app|explore-preview\.expo\.app|zip/);
  assert.doesNotMatch(renderPublicComment(state({ links, phase: 'failed', review: undefined, failure: { step: 'capture-head', message: 'boom' } })), /acme-explore--1lcbdcpwn3\.expo\.app\/p|for anyone who has/);
  const forever = renderPublicComment(state({ links: { ...links, preview: previewLinks(`https://acme-explore--1lcbdcpwn3.expo.app/p/${token}`, null) }, artifactOnly: true }));
  assert.match(forever, /\n<sub>Preview links work for anyone who has them until the deployment is deleted · \[Workflow run\]/);
});

test('two platforms share one comment: both named in the subtitle, every changed screen listed once, a line only for the one still working', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const ready = state({ artifactOnly: true });
  const single = renderPublicComment(ready);
  assert.equal(platformSectionMerge(ready, undefined).merge(undefined), single);
  assert.equal(platformSectionMerge(ready, 'ios').merge(undefined), single, 'the iOS writer of a matrix renders the same comment as a single-platform run');
  const androidState = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' },
    runtime: { ...state().runtime, platform: 'android', deviceModel: 'EasAndroidDevice01', osVersion: '15.0' }, ...overrides });
  const capturing = platformSectionMerge(androidState({ phase: 'capturing', review: undefined, evidence: undefined, capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 1 }, baseFromCache: false, current: 'head' } }), 'android').merge(single);
  assert.deepEqual(Object.keys(readCommentRecords(capturing).current), ['ios', 'android']);
  assert.equal(titleOf(capturing), titleOf(single), 'a platform still capturing has no report to link yet');
  assert.equal(subtitleOf(capturing), `<sub>[iOS](<${reportUrl}>) · Android · ${commits} · updated Sep 11, 3:07 AM UTC</sub>`);
  assert.equal(statusOf(capturing, 'Android'), `Android · capturing head 1/3 · ${runLink}`);
  assert.equal(statusOf(capturing, 'iOS'), undefined);
  assert.deepEqual(listOf(capturing), listOf(single), 'a platform still capturing adds nothing to the list');
  const flagged = evidenceReview();
  flagged.surfaces[2].review = { status: 'needs-review', description: 'Screenshots differ (2.1%) without a source change' };
  flagged.surfaces.push(surface('coins', 'unchanged', { extra: { sourceScope: 'none', review: { status: 'variant', description: 'Runtime state differs: Removed text “84”.' },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 0.2, threshold: 0.1, tool: 'agent-device@0.21.15' } } }));
  const both = platformSectionMerge(androidState({ review: flagged }), 'android').merge(capturing);
  assert.deepEqual(Object.keys(readCommentRecords(both).current), ['ios', 'android']);
  assert.equal(titleOf(both), titleOf(single), 'the heading links the first platform’s report');
  assert.match(subtitleOf(both), /^<sub>\[iOS\]\(<[^>]+artifact=7654>\) · \[Android\]\(<[^>]+artifact=7654>\) · \[bbbbbbbb\]/);
  assert.equal(statusOf(both, 'Android'), undefined);
  assert.equal(listOf(both).length, 3, 'no screen is listed twice');
  assert.match(both, /\n- Added \[`\/cats\/care-guide`\]\(<[^>]+screen=care-guide>\)\n/);
  assert.match(both, /\n- \[`\/settings`\]\(<[^>]+>\) · Changed button title from “Share” to “Share Example”\n/, 'a platform whose verdict differs does not change the row');
  assert.doesNotMatch(both, / only\n|not on |coins|runtime state|iOS · /);
  assert.ok(both.length < 8_000, String(both.length));
  // A writer that finds no records (a legacy or hand-edited comment) starts over rather than failing.
  const legacy = `${CI_COMMENT_MARKER}\nExplore review for x\n<!-- expo-explore-platform:ios -->\n## iOS · 3 changes\n<!-- /expo-explore-platform:ios -->`;
  assert.equal(platformSectionMerge(ready, 'ios').merge(legacy), single);
  const tampered = both.replace(/expo-explore-record:android:[A-Za-z0-9_-]+/, 'expo-explore-record:android:AAAA');
  assert.equal(platformSectionMerge(ready, 'ios').merge(tampered), single);
});

test('a screen that changed on some devices only says which, the shorter way', async () => {
  const { platformSectionMerge } = await import('../../dist/report/pr-comment-body.js');
  const [iphone, closed, open, android] = duoTargets;
  const settingsOnly = review([evidenceReview().surfaces[2]]);
  let body;
  for (const target of [iphone, closed, open]) body = platformSectionMerge(targetState(target), target.id).merge(body);
  body = platformSectionMerge(targetState(android, { review: settingsOnly }), 'android').merge(body);
  assert.match(body, /\n- Added \[`\/cats\/care-guide`\]\(<[^>]+>\) · not on Pixel 7\n/);
  assert.match(body, /\n- \[`\/settings`\]\(<[^>]+>\) · Changed button title from “Share” to “Share Example”\n/, 'a screen changed everywhere names no device');
  const two = platformSectionMerge(targetState(android, { review: settingsOnly }), 'android').merge(platformSectionMerge(targetState(iphone), 'iphone').merge(undefined));
  assert.match(two, /\n- Added \[`\/cats\/care-guide`\]\(<[^>]+>\) · iPhone 17 only\n/);
  // A device missing a capture may have changed the screen too: the row says where it changed, not where it did not.
  const missing = platformSectionMerge(targetState(android, { review: settingsOnly, capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 2 }, baseFromCache: false } }), 'android')
    .merge(platformSectionMerge(targetState(iphone), 'iphone').merge(undefined));
  assert.match(missing, /\nPixel 7 · 1 capture unavailable · /);
  assert.match(missing, /\n- Added \[`\/cats\/care-guide`\]\(<[^>]+>\) · on iPhone 17\n/);
  assert.doesNotMatch(missing, / only\n|not on /);
});

test('a new run keeps the last finished review up, under a line saying it is working, until it has a finished target; the old run joins Previous runs', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const first = platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined);
  const androidReady = state({ artifactOnly: true, build: { ...state().build, platform: 'android' }, runtime: { ...state().runtime, platform: 'android', deviceModel: 'Pixel 9' } });
  const both = platformSectionMerge(androidReady, 'android').merge(first);
  const nextHead = 'd'.repeat(40);
  const nextLinks = (runId, artifact) => viewerLinks({ ...(artifact ? { artifactUrl: `https://github.com/expo/explore-playground/actions/runs/${runId}/artifacts/${artifact}` } : {}),
    repository: pullRequest.repository, headSha: nextHead, runId, runAttempt: '1', configPath: '.expo-explore/config.yaml' });
  const nextState = overrides => state({ phase: 'capturing', review: undefined, evidence: undefined, links: nextLinks('43'), pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    startedAt: Date.parse('2026-09-11T04:00:00Z'), updatedAt: Date.parse('2026-09-11T04:01:00Z'), capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 0 }, baseFromCache: true, current: 'head' }, ...overrides });
  const next = platformSectionMerge(nextState(), 'ios').merge(both);
  assert.equal(visible(next).split('\n')[1], `> **New run in progress** for [dddddddd](<https://github.com/expo/explore-playground/commit/${nextHead}>) · capturing on iOS · [run](<https://github.com/expo/explore-playground/actions/runs/43/attempts/1>)`);
  assert.equal(titleOf(next), titleOf(both), 'the previous review stays up');
  assert.equal(subtitleOf(next), subtitleOf(both));
  assert.deepEqual(listOf(next), listOf(both));
  assert.deepEqual(Object.keys(readCommentRecords(next).current), ['ios']);
  assert.deepEqual(Object.keys(readCommentRecords(next).previous), ['ios', 'android']);
  assert.deepEqual(summaries(next), ['Previous runs (1)']);
  assert.match(next, /\n- \[bbbbbbbb\]\(<https:\/\/github\.com\/expo\/explore-playground\/commit\/b{40}>\) · iOS 🟩 3 changes \(\[report\]\(<https:\/\/explore-preview\.expo\.app\/\?repo=[^>]+&artifact=7654>\) · \[run\]\(<[^>]+runs\/42\/attempts\/2>\)\) · Android 🟩 3 changes \(\[report\]\(<[^>]+>\) · \[run\]\(<[^>]+>\)\)\n/);
  // The previous run's Android report job finishes after the new run started: it is superseded and lands in history.
  const late = platformSectionMerge(androidReady, 'android').merge(next);
  assert.deepEqual(Object.keys(readCommentRecords(late).current), ['ios']);
  assert.equal(readCommentRecords(late).history.length, 1);
  assert.equal(titleOf(late), titleOf(both));
  // The new run's Android writer joins; nothing finished yet, so the previous review stays.
  const joined = platformSectionMerge(nextState({ build: { ...state().build, platform: 'android' } }), 'android').merge(late);
  assert.deepEqual(Object.keys(readCommentRecords(joined).current), ['ios', 'android']);
  assert.match(visible(joined).split('\n')[1], /^> \*\*New run in progress\*\* for \[dddddddd\]\(<[^>]+>\) · capturing on iOS, Android · \[run\]/);
  assert.deepEqual(listOf(joined), listOf(both));
  assert.deepEqual(summaries(joined), ['Previous runs (1)']);
  // The new run's iOS finishes: its review takes over; the previous Android record waits for the new one.
  const iosDone = platformSectionMerge(nextState({ phase: 'ready', review: evidenceReview(), links: nextLinks('43', '7700') }), 'ios').merge(joined);
  assert.doesNotMatch(iosDone, /New run in progress/);
  assert.match(titleOf(iosDone), /^### 3 screens changed · \[Review in Explore\]\(<[^>]+artifact=7700>\)$/);
  assert.match(subtitleOf(iosDone), /^<sub>\[iOS\]\(<[^>]+artifact=7700>\) · Android · \[dddddddd\]/);
  assert.equal(statusOf(iosDone, 'Android'), 'Android · capturing head 0/3 · base reused · [run](<https://github.com/expo/explore-playground/actions/runs/43/attempts/1>)');
  assert.deepEqual(Object.keys(readCommentRecords(iosDone).previous), ['android']);
  const androidDone = platformSectionMerge(nextState({ phase: 'ready', review: evidenceReview(), links: nextLinks('43', '7700'), build: { ...state().build, platform: 'android' } }), 'android').merge(iosDone);
  assert.equal(readCommentRecords(androidDone).previous, undefined, 'once every target finished nothing previous is kept');
  assert.doesNotMatch(androidDone, /expo-explore-previous/);
  assert.equal(statusOf(androidDone, 'Android'), undefined);
  // Each later run pushes one more entry; history is capped.
  let body = androidDone;
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
  assert.doesNotMatch(body, /expo-explore-previous|New run in progress/);
  // A state marked superseded by its own writer goes straight to history even when the comment has nothing newer yet.
  const superseded = platformSectionMerge(state({ artifactOnly: true, superseded: true }), 'ios').merge(undefined);
  assert.match(superseded, /^### Explore review\n\nThe pull request moved while this run worked; its report is kept here until the current run replaces it\./m);
  const replaced = platformSectionMerge(nextState(), 'ios').merge(superseded);
  assert.equal(titleOf(replaced), '### Explore review · capturing');
  assert.match(replaced, /Previous runs \(1\)/);
});

test('the review a new run keeps up comes from one run: a target the last run never finished does not bring back an older run', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const androidOf = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' }, runtime: { ...state().runtime, platform: 'android', deviceModel: 'Pixel 9' }, ...overrides });
  const run = (runId, head, artifact) => ({ pullRequest: { ...pullRequest, head: { ref: 'feature', sha: head } },
    links: viewerLinks({ ...(artifact ? { artifactUrl: `https://github.com/expo/explore-playground/actions/runs/${runId}/artifacts/${artifact}` } : {}),
      repository: pullRequest.repository, headSha: head, runId, runAttempt: '1', configPath: '.expo-explore/config.yaml' }) });
  const working = { phase: 'capturing', review: undefined, evidence: undefined };
  const [c, d] = ['c'.repeat(40), 'd'.repeat(40)];
  let body = platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined);
  body = platformSectionMerge(androidOf({}), 'android').merge(body);
  // Run 43 finishes Android only; its iOS job never reports (cancelled).
  body = platformSectionMerge(state({ ...working, ...run('43', c) }), 'ios').merge(body);
  body = platformSectionMerge(androidOf({ ...run('43', c, '7800'), review: review([evidenceReview().surfaces[2]]) }), 'android').merge(body);
  body = platformSectionMerge(state({ ...working, ...run('44', d) }), 'ios').merge(body);
  const previous = readCommentRecords(body).previous;
  assert.deepEqual(Object.keys(previous), ['android']);
  assert.equal(previous.android.runId, '43');
  assert.match(subtitleOf(body), /^<sub>\[Android\]\(<[^>]+artifact=7800>\) · \[cccccccc\]/);
  assert.equal(titleOf(body), '### 1 screen changed · [Review in Explore](<https://explore-preview.expo.app/?repo=expo%2Fexplore-playground&run=43&attempt=1&artifact=7800>)');
  assert.doesNotMatch(visible(body).split('<details>')[0], /artifact=7654/, 'run 42 is only under Previous runs');
});

test('a new run\'s failure does not replace the previous review: it is named on the new-run line until a target is ready', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const androidOf = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' }, runtime: { ...state().runtime, platform: 'android', deviceModel: 'Pixel 9' }, ...overrides });
  const both = platformSectionMerge(androidOf({}), 'android').merge(platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined));
  const nextHead = 'd'.repeat(40);
  const next = { pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    links: viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) };
  const commit = `[dddddddd](<https://github.com/expo/explore-playground/commit/${nextHead}>)`;
  const run43 = '[run](<https://github.com/expo/explore-playground/actions/runs/43/attempts/1>) · [evidence](<https://github.com/expo/explore-playground/actions/runs/43#artifacts>)';
  const failure = { phase: 'failed', review: undefined, evidence: undefined, failure: { step: 'capture-head', message: 'boom' } };
  // Android fails before iOS posts anything.
  const failed = platformSectionMerge(androidOf({ ...next, ...failure }), 'android').merge(both);
  assert.equal(visible(failed).split('\n')[1], `> **New run failed** for ${commit} · **Android failed** · capture\\-head · boom · ${run43}`);
  assert.equal(titleOf(failed), titleOf(both));
  assert.deepEqual(listOf(failed), listOf(both));
  assert.deepEqual(Object.keys(readCommentRecords(failed).previous), ['ios', 'android']);
  const working = platformSectionMerge(state({ ...next, phase: 'capturing', review: undefined, evidence: undefined, capture: undefined }), 'ios').merge(failed);
  assert.equal(visible(working).split('\n')[1], `> **New run in progress** for ${commit} · capturing on iOS · **Android failed** · capture\\-head · boom · ${run43}`);
  assert.deepEqual(listOf(working), listOf(both));
  // iOS is ready: its review takes over, and Android's failure is its own line.
  const ready = platformSectionMerge(state({ ...next, artifactOnly: true }), 'ios').merge(working);
  assert.doesNotMatch(ready, /New run|expo-explore-previous/);
  assert.match(statusOf(ready, 'Android'), /^\*\*Android failed\*\* · capture\\-head · boom · /);
  // A single target that failed keeps the review before it, and the run after it still has that review to keep.
  const single = platformSectionMerge(state({ ...next, ...failure }), 'ios').merge(platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined));
  assert.equal(visible(single).split('\n')[1], `> **New run failed** for ${commit} · capture\\-head · boom · ${run43}`);
  assert.match(titleOf(single), /^### 3 screens changed · /);
  const later = platformSectionMerge(state({ phase: 'capturing', review: undefined, evidence: undefined, capture: undefined,
    links: viewerLinks({ repository: pullRequest.repository, headSha: 'e'.repeat(40), runId: '44', runAttempt: '1', configPath: '.expo-explore/config.yaml' }),
    pullRequest: { ...pullRequest, head: { ref: 'feature', sha: 'e'.repeat(40) } } }), 'ios').merge(single);
  assert.equal(readCommentRecords(later).previous.ios.runId, '42');
  assert.match(titleOf(later), /^### 3 screens changed · /);
});

test('a rerun keeps the attempt it replaces up until the new attempt finishes', async () => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const ready = platformSectionMerge(state({ artifactOnly: true }), 'ios').merge(undefined);
  const attempt3 = viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '3', configPath: '.expo-explore/config.yaml' });
  const rerun = platformSectionMerge(state({ phase: 'capturing', review: undefined, evidence: undefined, links: attempt3 }), 'ios').merge(ready);
  assert.equal(visible(rerun).split('\n')[1], `> **New run in progress** for [bbbbbbbb](<https://github.com/expo/explore-playground/commit/${headSha}>) · capturing · [run](<https://github.com/expo/explore-playground/actions/runs/42/attempts/3>)`);
  assert.equal(titleOf(rerun), titleOf(ready));
  assert.deepEqual(listOf(rerun), listOf(ready));
  assert.equal(readCommentRecords(rerun).previous.ios.runAttempt, '2');
  // The same attempt writing again (capture progress, a republish) keeps nothing.
  assert.equal(readCommentRecords(platformSectionMerge(state({ phase: 'capturing', review: undefined, evidence: undefined }), 'ios').merge(ready)).previous, undefined);
  const done = platformSectionMerge(state({ artifactOnly: true, links: { ...attempt3, viewer: state().links.viewer } }), 'ios').merge(rerun);
  assert.equal(readCommentRecords(done).previous, undefined);
  assert.doesNotMatch(done, /New run in progress/);
});

test('over budget, the previous run\'s records go before the hidden state is cut', async () => {
  const { readCommentRecords, renderCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const previous = platformRecordOf(state({ artifactOnly: true }));
  const nextHead = 'd'.repeat(40);
  const current = platformRecordOf(state({ phase: 'capturing', review: undefined, evidence: undefined, pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    links: viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) }));
  const records = { current: { ios: current }, previous: { ios: previous }, history: [] };
  const full = renderCommentRecords(records);
  assert.match(full, /New run in progress/);
  assert.deepEqual(Object.keys(readCommentRecords(full).previous), ['ios']);
  const without = renderCommentRecords({ current: { ios: current }, history: [] });
  assert.equal(renderCommentRecords(records, undefined, without.length + 10), without);
  // Once the new run shows a finished target, the previous records it still carries are hidden: they go before the list shrinks.
  const twelve = review(Array.from({ length: 12 }, (_, index) => surface(`screen-${index}`, 'modified', { extra: {
    review: { status: 'modified', description: `Changed ${index} in a way that takes a sentence to describe for the budget check.` },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 1, threshold: 0.1, tool: 'agent-device@0.20.2' } } })));
  const finished = platformRecordOf(state({ artifactOnly: true, review: twelve, pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    links: viewerLinks({ artifactUrl: 'https://github.com/expo/explore-playground/actions/runs/43/artifacts/7700', repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) }));
  const android = { ...current, platform: 'android' };
  const hidden = { current: { ios: finished, android }, previous: { android: { ...previous, platform: 'android' } }, history: [] };
  const lean = renderCommentRecords({ ...hidden, previous: {} });
  assert.equal(renderCommentRecords(hidden, undefined, lean.length + 10), lean);
  assert.equal(listOf(lean).length, 11, 'ten screens and the link to the rest');
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
  // While the new run works the previous run's preview is still the one on show.
  const working = platformSectionMerge({ ...next, phase: 'capturing', review: undefined, evidence: undefined, links: viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) }, 'ios').merge(single);
  assert.equal(working.split('\n')[1], marker);
  assert.equal(existingDeploymentMarker(`${CI_COMMENT_MARKER}\n<!-- expo-explore-deployments:Bad Host -->\nx`), undefined);
});

test('a report whose hosted preview is still deploying says so instead of linking the central Viewer', () => {
  const deploying = renderPublicComment(state({ links: { ...state().links, deploying: true }, artifactOnly: true }));
  assert.equal(titleOf(deploying), '### 3 screens changed · report deploying…', 'the heading says the report is not ready');
  assert.ok(!deploying.includes('explore-preview.expo.app'), 'no download-and-drop Viewer link while the hosted report is on its way');
  assert.match(subtitleOf(deploying), /^<sub>iOS · \[bbbbbbbb\]/, 'nothing to link the platform to yet');
  assert.match(deploying, /\n- Added `\/cats\/care-guide`\n/);
  assert.equal(deploying.split('\n').at(-1), `<sub>${workflowRun} · ${configLink}</sub>`);
  const deployed = renderPublicComment(state({ links: { ...state().links, deploying: true,
    preview: previewLinks('https://acme-explore--1lcbdcpwn3.expo.app/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', null) } }));
  assert.match(titleOf(deployed), /^### 3 screens changed · \[Review in Explore\]\(<https:\/\/acme-explore--1lcbdcpwn3\.expo\.app[^>]*>\)$/, 'once deployed the hosted report is the heading');
  const record = JSON.parse(JSON.stringify(platformRecordOf(state({ links: { ...state().links, deploying: true }, artifactOnly: true }))));
  assert.equal(record.links.report, undefined, 'the record carries no report link while deploying');
  assert.equal(parsePlatformRecord(record).links.deploying, true, 'the deploying flag survives the comment round trip');
});

test('a screen whose screenshots match but whose accessibility tree changed is listed after the visual changes, tagged accessibility only', () => {
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
  assert.match(titleOf(body), /^### 5 screens changed · /);
  assert.deepEqual(listOf(body).slice(3), [
    `- [\`/device-picker\`](<${reportUrl}&view=compare&screen=device-picker>) · Added button “Edit tempo” · accessibility only`,
    `- [\`/enable-midi\`](<${reportUrl}&view=compare&screen=enable-midi>) · Added button “Edit tempo” · accessibility only`]);
  assert.doesNotMatch(body, /Before and After look the same/);
  const record = parsePlatformRecord(JSON.parse(JSON.stringify(platformRecordOf(state({ review: withAccessibility, artifactOnly: true })))));
  assert.deepEqual(record.changes.filter(change => change.group === 'accessibility-only').map(change => change.id), ['device-picker', 'enable-midi'],
    'the group survives the comment round trip');
});

test('a comment whose only change is for assistive technology counts it like any other', () => {
  const only = review([surface('device-picker', 'modified', { extra: {
    review: { status: 'modified', description: 'Changed “Play” from a text to a button.', facts: [{ category: 'accessibility', templateId: 'accessibility.role-changed', bullet: 'Changed “Play” from a text to a button.' }] },
    visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.20.2' },
    sourceChange: sourceChange('Made Play a button.'),
  } })]);
  const body = renderPublicComment(state({ review: only, artifactOnly: true }));
  assert.match(titleOf(body), /^### 1 screen changed · /);
  assert.deepEqual(listOf(body), [`- [\`/device-picker\`](<${reportUrl}&view=compare&screen=device-picker>) · Changed “Play” from a text to a button · accessibility only`]);
});

test('a screen accessibility-only on iOS and visibly modified on Android is listed as the visible change, whichever platform comes first', async () => {
  const { platformSectionMerge } = await import('../../dist/report/pr-comment-body.js');
  const settings = (verdict) => {
    const changed = evidenceReview();
    changed.surfaces[2].visual = { ...changed.surfaces[2].visual, verdict, mismatchPercentage: verdict === 'modified' ? 3.2 : 0 };
    return changed;
  };
  const androidState = overrides => state({ artifactOnly: true, build: { ...state().build, platform: 'android' },
    runtime: { ...state().runtime, platform: 'android', deviceModel: 'EasAndroidDevice01', osVersion: '15.0' }, ...overrides });
  const androidLinks = viewerLinks({ artifactUrl: 'https://github.com/expo/explore-playground/actions/runs/42/artifacts/7700', repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath: '.expo-explore/config.yaml' });
  const ios = renderPublicComment(state({ review: settings('unchanged'), artifactOnly: true }));
  assert.match(ios, /\n- \[`\/settings`\]\(<[^>]+>\) · [^\n]+ · accessibility only\n/, 'iOS alone: the screenshots match');
  const both = platformSectionMerge(androidState({ review: settings('modified'), links: androidLinks }), 'android').merge(ios);
  assert.match(both, /\n- \[`\/settings`\]\(<[^>]+artifact=7700&view=compare&screen=settings>\) · Changed button title from “Share” to “Share Example”\n/, 'the link opens Android, where it changed visibly');
  assert.doesNotMatch(both, /accessibility only/);
  const androidFirst = platformSectionMerge(state({ review: settings('unchanged'), artifactOnly: true }), 'ios')
    .merge(platformSectionMerge(androidState({ review: settings('modified'), links: androidLinks }), 'android').merge(undefined));
  assert.match(androidFirst, /\n- \[`\/settings`\]\(<[^>]+artifact=7700&view=compare&screen=settings>\) · Changed button title from “Share” to “Share Example”\n/);
});

test('screens whose comparison did not run are counted as not compared, never as a green "no change"', () => {
  const uncompared = review([surface('settings', 'modified'), surface('tempo', 'modified')]);
  const body = renderPublicComment(state({ review: uncompared, artifactOnly: true }));
  assert.equal(titleOf(body), `### No compared screens changed · [Review in Explore](<${reportUrl}>)`);
  assert.equal(statusOf(body, 'iOS'), `iOS · 2 not compared · ${runLink}`);
  // A screen that was never captured (outside the capture scope) stays out of the count.
  const outOfScope = surface('channel', 'modified');
  for (const key of ['baseImage', 'headImage', 'baseOutcome', 'headOutcome']) delete outOfScope[key];
  const quiet = renderPublicComment(state({ review: review([outOfScope]), artifactOnly: true, evidence: undefined, capture: { planned: { base: 0, head: 0 }, done: { base: 0, head: 0 }, baseFromCache: false } }));
  assert.equal(titleOf(quiet), `### No screens changed · [Review in Explore](<${reportUrl}>)`);
  assert.equal(statusOf(quiet, 'iOS'), undefined);
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

/**
 * brentvatne/euxy#172, review run 39362642343: five targets, two strings changed. Tempo's footnote sits low in a
 * scrolling sheet. On the closed iPhone Duo the accessibility tree has the new text but the screenshots match: the
 * footnote runs past the bottom of the screen (`offScreen`, from the elements' bounds). On the half-open and opened Duo
 * neither the tree nor the pixels have it. Android captures no dark appearance.
 */
const euxyTargets = [{ id: 'iphone', platform: 'ios', label: 'iPhone 17' }, { id: 'duo-closed', platform: 'ios', label: 'iPhone Duo (closed)' },
  { id: 'duo-half-open', platform: 'ios', label: 'iPhone Duo (half-open)' }, { id: 'duo-open', platform: 'ios', label: 'iPhone Duo (open)' },
  { id: 'android', platform: 'android', label: 'Android' }];
const footnote = 'Added text “Changes apply live while playing. Base resolution sets the step grid for lanes you add next.”.';
const footnoteText = 'Added text “Changes apply live while playing\\. Base resolution sets the step grid for lanes you add next\\.”';
function euxyReview(target, options = {}) {
  const own = { sourceImpact: ['own'], sourceScope: 'screen' };
  const matched = { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.21.29' };
  const changed = (description, mismatchPercentage) => ({ ...own,
    review: { status: 'modified', description, facts: [{ category: 'element', templateId: 'element.added', bullet: description }] },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage, threshold: 0.1, tool: 'agent-device@0.21.29' } });
  const inTreeOnly = { ...changed(footnote, 0), visual: matched };
  if (options.offScreen !== false) inTreeOnly.review.offScreen = true;
  if (options.diffFailed) inTreeOnly.visual = { ...matched, reason: 'diff-failed' };
  const unseen = { ...own, review: { status: 'unchanged', description: 'No visible change' }, visual: matched };
  const tempo = target === 'duo-closed' ? inTreeOnly : ['duo-half-open', 'duo-open'].includes(target) ? unseen : changed(footnote, 0.11);
  const rename = changed('Added text “Pattern name”.', 0.16);
  const schemes = target === 'android' ? [''] : ['', '@dark'];
  return review(schemes.flatMap(scheme => [
    surface(`tempo${scheme}`, 'modified', { route: '/tempo', extra: structuredClone(tempo) }),
    surface(`rename-pattern${scheme}`, 'modified', { route: '/rename-pattern', extra: structuredClone(rename) }),
  ]));
}
async function euxyRows(reviewOf = euxyReview) {
  const { platformSectionMerge } = await import('../../dist/report/pr-comment-body.js');
  let body;
  for (const target of euxyTargets) body = platformSectionMerge(state({ artifactOnly: true, target, targets: euxyTargets, review: reviewOf(target.id),
    build: { ...state().build, platform: target.platform }, runtime: { ...state().runtime, platform: target.platform, deviceModel: target.label } }), target.id).merge(body);
  return { body, rows: listOf(body).map(line => line.replace(/\(<[^>]+>\)/, '')) };
}

test('a change whose elements run past the screen on a device is named off-screen there, beside the devices that show it (euxy#172)', async () => {
  const { body, rows } = await euxyRows();
  assert.deepEqual(rows, [
    `- [\`/tempo\`] · ${footnoteText} · iPhone 17, Android only · off-screen on iPhone Duo \\(closed\\)`,
    `- [\`/rename-pattern\`] · Added text “Pattern name”`,
    `- [\`/tempo\`] (dark) · ${footnoteText} · iPhone 17 only · off-screen on iPhone Duo \\(closed\\)`,
    `- [\`/rename-pattern\`] (dark) · Added text “Pattern name” · not on Android`,
  ], 'the half-open and opened Duo have no trace of it, so they stay among the devices it is not on');
  const { readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  assert.deepEqual(readCommentRecords(body).current['duo-closed'].changes.filter(change => change.offScreen).map(change => change.id), ['tempo', 'tempo@dark'],
    'the mark survives the comment round trip');
});

test('without geometry that puts it past the screen, or with a failed comparison, a device keeps today\'s wording', async () => {
  // The review euxy#172 published: the closed Duo's change is accessibility-only, with nothing saying where its elements are.
  const { rows } = await euxyRows(target => euxyReview(target, { offScreen: false }));
  assert.equal(rows[0], `- [\`/tempo\`] · ${footnoteText} · not on iPhone Duo \\(half\\-open\\), iPhone Duo \\(open\\)`);
  assert.equal(rows[2], `- [\`/tempo\`] (dark) · ${footnoteText} · iPhone 17, iPhone Duo \\(closed\\) only`);
  // A comparison that failed is no verdict at all: the closed Duo is not counted among the devices with the change.
  const failed = await euxyRows(target => euxyReview(target, { diffFailed: true }));
  assert.match(failed.rows[0], / · on iPhone 17, Android$/);
  assert.doesNotMatch(failed.rows.join('\n'), /off-screen/);
});

test('a change one platform has and another lacks keeps "only" and "not on"', async () => {
  // An iOS-only branch in a shared screen file: Android's capture of the screen shows no change, and says nothing off-screen.
  const iosOnly = target => {
    const reviewed = euxyReview(target);
    if (target === 'android') for (const entry of reviewed.surfaces) Object.assign(entry, { review: { status: 'unchanged', description: 'No visible change' },
      visual: { verdict: 'unchanged', reason: 'matched', mismatchPercentage: 0, threshold: 0.1, tool: 'agent-device@0.21.29' } });
    return reviewed;
  };
  const { rows } = await euxyRows(iosOnly);
  assert.equal(rows[0], `- [\`/tempo\`] · ${footnoteText} · iPhone 17 only · off-screen on iPhone Duo \\(closed\\)`);
  assert.match(rows.find(row => row.startsWith('- [`/rename-pattern`] ·')), / · not on Android$/);
});

test('several targets share a comment: named in config order in the subtitle, each linking its report, keyed by id in the records and history', async () => {
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
  assert.equal(titleOf(body), `### 3 screens changed · [Review in Explore](<${reportUrl}>)`);
  assert.equal(subtitleOf(body), `<sub>[iPhone 17](<${reportUrl}>) · iPhone Duo \\(closed\\) · [iPhone Duo \\(open\\)](<${reportUrl}>) · [Pixel 7](<${reportUrl}>) · ${commits} · updated Sep 11, 3:07 AM UTC</sub>`);
  assert.equal(statusOf(body, 'iPhone Duo \\(closed\\)'), `iPhone Duo \\(closed\\) · capturing head 1/3 · ${runLink}`);
  assert.equal(listOf(body).length, 3);
  assert.doesNotMatch(body, / only\n|not on /);
  // A newer run moves them all into history, still labelled and ordered by target, and keeps their review up while it works.
  const nextHead = 'd'.repeat(40);
  const next = platformSectionMerge(targetState(open, { phase: 'capturing', review: undefined, evidence: undefined, pullRequest: { ...pullRequest, head: { ref: 'feature', sha: nextHead } },
    links: viewerLinks({ repository: pullRequest.repository, headSha: nextHead, runId: '43', runAttempt: '1', configPath: '.expo-explore/config.yaml' }) }), 'duo-open').merge(body);
  assert.deepEqual(Object.keys(readCommentRecords(next).current), ['duo-open']);
  assert.deepEqual(Object.keys(readCommentRecords(next).previous).sort(), ['android', 'duo-open', 'iphone'], 'the target still capturing had nothing to keep');
  assert.match(visible(next).split('\n')[1], /^> \*\*New run in progress\*\* for \[dddddddd\]\(<[^>]+>\) · capturing on iPhone Duo \\\(open\\\) · \[run\]/);
  assert.equal(subtitleOf(next), `<sub>[iPhone 17](<${reportUrl}>) · [iPhone Duo \\(open\\)](<${reportUrl}>) · [Pixel 7](<${reportUrl}>) · ${commits} · updated Sep 11, 3:07 AM UTC</sub>`);
  const history = readCommentRecords(next).history;
  assert.deepEqual(Object.keys(history[0].platforms).sort(), ['android', 'duo-closed', 'duo-open', 'iphone']);
  assert.match(next, /\n- \[bbbbbbbb\]\(<[^>]+>\) · iPhone 17 🟩 3 changes \(.*?\) · iPhone Duo \\\(closed\\\) ⏳ did not finish \(.*?\) · iPhone Duo \\\(open\\\) 🟩 3 changes \(.*?\) · Pixel 7 🟩 3 changes /);
});

test('one of five targets failed: the comment shows the four reports and that failure, and no new-run banner (brentvatne/euxy#172)', async t => {
  const { platformSectionMerge, readCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const { publishFailureComment } = await import('../../dist/report/failure-comment.js');
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const targets = [...duoTargets, { id: 'pixel-dark', platform: 'android', label: 'Pixel 7 (dark)' }];
  const configPath = '.expo-explore/config.yaml';
  const firstAttempt = viewerLinks({ artifactUrl: 'https://github.com/expo/explore-playground/actions/runs/42/artifacts/7650', repository: pullRequest.repository, headSha, runId: '42', runAttempt: '1', configPath });
  const working = viewerLinks({ repository: pullRequest.repository, headSha, runId: '42', runAttempt: '2', configPath });
  // Attempt 1 published every target; attempt 2 captured them all at once, and the iPhone Duo (open) session failed.
  let body;
  for (const target of targets) body = platformSectionMerge(targetState(target, { targets, links: firstAttempt }), target.id).merge(body);
  for (const target of targets) body = platformSectionMerge(targetState(target, { targets, links: working, phase: 'capturing', review: undefined, evidence: undefined,
    capture: { planned: { base: 3, head: 3 }, done: { base: 3, head: 1 }, baseFromCache: false, current: 'head' } }), target.id).merge(body);
  assert.match(visible(body), /New run in progress/);
  for (const target of targets.filter(target => target.id !== 'duo-open')) body = platformSectionMerge(targetState(target, { targets }), target.id).merge(body);

  const root = await mkdtemp(join(tmpdir(), 'explore-one-failed-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const target of targets) await mkdir(join(root, 'capture', `explore-diagnostics-42-2-${target.id}`, 'explore-diagnostics'), { recursive: true });
  await writeFile(join(root, 'capture', 'explore-diagnostics-42-2-duo-open', 'explore-diagnostics', 'error.json'), JSON.stringify({ code: 'ARGENT_TOOL_FAILED', stage: 'session',
    message: 'fold: argent run fold failed: [Tool:fold] Service dependency failed', nextAction: 'Rerun the capture.', retryable: false, target: 'duo-open' }));
  let comments = [{ id: 5, user: { login: 'github-actions[bot]' }, body }];
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/repos/expo/explore-playground/pulls/1') return Response.json({ state: 'open', draft: false, title: pullRequest.title, html_url: pullRequest.url,
      base: { ref: 'main', sha: baseSha, repo: { id: 1, full_name: pullRequest.repository } }, head: { ref: pullRequest.head.ref, sha: headSha, repo: { full_name: pullRequest.repository } } });
    if (url.pathname === '/repos/expo/explore-playground/issues/1/comments') return Response.json(comments);
    if (url.pathname === '/repos/expo/explore-playground/issues/comments/5' && init.method === 'PATCH') {
      comments = [{ ...comments[0], body: JSON.parse(init.body).body }]; return Response.json({ id: 5 });
    }
    throw new Error(`unexpected request ${init.method ?? 'GET'} ${url}`);
  };
  assert.deepEqual(await publishFailureComment({ repository: pullRequest.repository, pullNumber: 1, headSha, baseSha, runId: '42', runAttempt: '2', diagnosticsPath: root,
    environment: { GITHUB_TOKEN: 'test-token' }, transport }), { posted: true });
  const final = comments[0].body;
  assert.doesNotMatch(visible(final), /New run in progress|New run failed/);
  assert.equal(readCommentRecords(final).previous, undefined, "attempt 1's records go once every target of attempt 2 finished");
  const records = readCommentRecords(final).current;
  assert.deepEqual(targets.map(target => [records[target.id].runAttempt, records[target.id].phase]),
    [['2', 'ready'], ['2', 'ready'], ['2', 'failed'], ['2', 'ready'], ['2', 'ready']]);
  assert.match(statusOf(final, 'iPhone Duo \\(open\\)'), /^\*\*iPhone Duo \\\(open\\\) failed\*\* · session · ARGENT\\_TOOL\\_FAILED\\: fold\\: argent run fold failed/);
  // Each published target links its report; the failure's record is the newest, so it sets the updated time.
  assert.ok(subtitleOf(final).startsWith(`<sub>[iPhone 17](<${reportUrl}>) · [iPhone Duo \\(closed\\)](<${reportUrl}>) · iPhone Duo \\(open\\) · [Pixel 7](<${reportUrl}>) · [Pixel 7 \\(dark\\)](<${reportUrl}>) · ${commits} · updated `), subtitleOf(final));
  assert.equal(titleOf(final), `### 3 screens changed · [Review in Explore](<${reportUrl}>)`);
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
  const previous = readCommentRecords([CI_COMMENT_MARKER, line('duo-open', valid), `<!-- expo-explore-previous:iphone:${encodeRecordPayload({ ...valid, target: 'iphone' })} -->`, '<!-- expo-explore-previous:iphone:AAAA -->'].join('\n')).previous;
  assert.deepEqual(Object.keys(previous), ['iphone'], 'previous records parse the same way');
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
  // Off by default: most reviews do not need it, so a config opts in with report.comment.map.
  assert.ok(!/<summary>Map/.test(renderPublicComment(state({ artifactOnly: true, review: withNavigation }))));
  assert.equal(platformRecordOf(state({ review: withNavigation })).navigation, undefined);
  const body = renderPublicComment(state({ artifactOnly: true, map: true, review: withNavigation }));
  assert.deepEqual(summaries(body), ['Map (4 screens)']);
  const map = body.slice(body.indexOf('```mermaid'), body.indexOf('```\n', body.indexOf('```mermaid')) + 3);
  assert.equal(map, ['```mermaid', 'flowchart LR', '  subgraph tabs["Tabs"]', '    n0["/cats"]', '    n3["/settings"]', '  end',
    '  n1["/cats/care-guide"]', '  n2["/cats/sweet-bee"]', '  n0 -->|push| n1', '  n0 -.->|push| n2',
    '  classDef added stroke:#1a7f37,stroke-width:3px', '  class n1 added', '  classDef modified stroke:#bc4c00,stroke-width:3px', '  class n3 modified',
    '  classDef removed stroke:#cf222e,stroke-width:2px,stroke-dasharray:5 4', '  class n2 removed', '```'].join('\n'));
  assert.ok(body.indexOf('\n- [`/settings`]') < body.indexOf('<summary>Map'), 'the map follows the list');
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

test('the map is dropped before the list shrinks, and a malformed map is dropped from the record', async () => {
  const { encodeRecordPayload } = await import('../../dist/report/pr-comment-record.js');
  const { readCommentRecords, renderCommentRecords } = await import('../../dist/report/pr-comment-body.js');
  const record = { ...platformRecordOf(state()), navigation: { nodes: [{ route: '/a', group: 'modified' }, { route: '/b' }], edges: [{ from: 1, to: 0, kinds: ['push'] }] } };
  const records = { current: { ios: record }, history: [] };
  assert.match(renderCommentRecords(records), /<summary>Map \(2 screens\)<\/summary>/);
  const tight = renderCommentRecords(records, undefined, renderCommentRecords(records).length - 1);
  assert.ok(!tight.includes('```mermaid'));
  assert.equal(listOf(tight).length, 3, 'the list is intact');
  const parse = navigation => readCommentRecords(`<!-- expo-explore-record:ios:${encodeRecordPayload({ ...record, navigation })} -->`).current.ios;
  assert.deepEqual(parse(record.navigation).navigation, record.navigation);
  for (const navigation of [{ ...record.navigation, edges: [{ from: 0, to: 2, kinds: ['push'] }] }, { ...record.navigation, edges: [{ from: 0, to: 1, kinds: ['teleport'] }] },
    { ...record.navigation, nodes: [{ route: '/a', group: 'needs-review' }, { route: '/b' }] }, { nodes: [], edges: [] }]) {
    const parsed = parse(navigation);
    assert.ok(parsed, 'the rest of the record still parses');
    assert.equal(parsed.navigation, undefined);
  }
});

test('an excluded route is neither listed nor counted as an app-wide screen', () => {
  const excluded = surface('channel', 'modified', { extra: { sourceScope: 'app-wide', excluded: true,
    sourceChange: { ...sourceChange('Dependency update.', 'global'), files: [{ path: 'package.json', status: 'modified', relation: 'global', hunks: [], facts: [], truncated: false }] } } });
  for (const key of ['baseImage', 'headImage', 'baseOutcome', 'headOutcome']) delete excluded[key];
  const body = renderPublicComment(state({ review: review([...evidenceReview().surfaces, excluded]) }));
  assert.doesNotMatch(body, /\/channel|App-wide source changes|not compared/);
});

test('an excluded route that is new is not one of the changed screens, nor of the ones the list links to', () => {
  const screens = Array.from({ length: 11 }, (_, index) => surface(`screen-${index}`, 'modified', { extra: {
    review: { status: 'modified', description: `Changed ${index}` },
    visual: { verdict: 'modified', reason: 'repeated-cross-build-delta', mismatchPercentage: 1, threshold: 0.1, tool: 'agent-device@0.20.2' },
  } }));
  const excluded = surface('channel', 'added', { route: '/c/[channel]', extra: { excluded: true } });
  for (const key of ['baseImage', 'headImage', 'baseOutcome', 'headOutcome']) delete excluded[key];
  const body = renderPublicComment(state({ review: review([...screens, excluded]) }));
  assert.equal(titleOf(body), `### 11 screens changed · [Review in Explore](<${reportUrl}>)`);
  assert.equal(listOf(body).at(-1), `- [1 more screen in the report](<${reportUrl}>)`);
  assert.doesNotMatch(body, /\/c\/\[channel\]/);
});
