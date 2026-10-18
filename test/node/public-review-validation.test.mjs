import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicReview, normalizePublicReviewForReading, quarantineReviewContract } from "../../dist/contracts/review-validation.js";

const baseSha = "a".repeat(40), headSha = "b".repeat(40), timestamp = "2026-09-01T00:00:00Z";

function review() {
  const route = id => ({ id, kind: "screen", route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`,
    sourceFiles: [`app/${id}.tsx`], variant: "default", provider: "expo-router", logicalPath: id });
  const image = (side, buildId) => ({ url: `https://embedded.expo-explore.invalid/${side}.png`, sha256: "c".repeat(64),
    sourceCommit: side === "base" ? baseSha : headSha, buildId, capturedAt: timestamp, width: 1, height: 1 });
  const outcome = () => ({ status: "captured", attempts: 1, landing: "verified", screenshotSha256: "c".repeat(64) });
  return {
    contract: "explore.review", mode: "all", createdAt: timestamp, runId: "1", runAttempt: "1",
    pullRequest: { base: { sha: baseSha }, head: { sha: headSha } },
    runtime: { projectId: "project", buildId: "head-build", gitCommit: headSha },
    surfaces: ["home", "settings"].map((id, index) => ({
      id, status: "modified", base: route(id), head: route(id),
      baseImage: image("base", `cached-build-${index}`), headImage: image("head", "head-build"),
      baseOutcome: outcome(), headOutcome: outcome(), review: { status: "unchanged", description: "No visible change" },
    })),
  };
}

test("verified evidence permits compatible baseline images from distinct builds of the same commit", () => {
  assert.doesNotThrow(() => assertPublicReview(review()));
});

test("all comparison verdicts require both verified destinations, including needs-review", () => {
  for (const status of ["modified", "unchanged", "needs-review"]) {
    const unverified = review();
    unverified.surfaces[0].review.status = status;
    unverified.surfaces[0].headOutcome.landing = "unverified";
    assert.throws(() => assertPublicReview(unverified), /both verified destination routes/);
    const missing = review();
    missing.surfaces[0].review.status = status;
    delete missing.surfaces[0].baseImage;
    delete missing.surfaces[0].baseOutcome;
    assert.throws(() => assertPublicReview(missing), /both verified destination routes/);
  }
});

test("unverified or incomplete evidence remains available without an app-change verdict", () => {
  const input = review();
  delete input.surfaces[0].review;
  input.surfaces[0].headOutcome.landing = "unverified";
  assert.doesNotThrow(() => assertPublicReview(input));
  input.surfaces[0].headOutcome = { status: "missing-params", attempts: 0, landing: "unverified" };
  delete input.surfaces[0].headImage;
  assert.doesNotThrow(() => assertPublicReview(input));
});

test("capture outcomes cannot claim an image, verification, or checksum that was not recorded", () => {
  for (const mutate of [
    surface => { surface.headOutcome.status = "failed"; },
    surface => { surface.headOutcome.screenshotSha256 = "d".repeat(64); },
    surface => { surface.headOutcome.attempts = -1; },
  ]) {
    const input = review();
    delete input.surfaces[0].review;
    mutate(input.surfaces[0]);
    assert.throws(() => assertPublicReview(input), /capture outcome is inconsistent/);
  }
});

test("visual-only verdicts require verified captures and cannot encode operational diff failures", () => {
  const input = review();
  delete input.surfaces[0].review;
  input.surfaces[0].visual = { verdict: 'needs-review', reason: 'provenance-gap', threshold: 0.1, tool: 'agent-device' };
  assert.doesNotThrow(() => assertPublicReview(input));
  input.surfaces[0].headOutcome.landing = 'unverified';
  assert.throws(() => assertPublicReview(input), /both verified destination routes/);
  input.surfaces[0].headOutcome.landing = 'verified';
  input.surfaces[0].visual.reason = 'diff-failed';
  assert.throws(() => assertPublicReview(input), /visual verdict is inconsistent/);
});

test("source additions and removals retain their status when screenshots are unavailable", () => {
  for (const status of ['added', 'removed']) {
    const input = review();
    const surface = input.surfaces[0];
    surface.status = status;
    const missingSide = status === 'added' ? 'base' : 'head';
    const captureSide = status === 'added' ? 'head' : 'base';
    surface[missingSide] = null;
    delete surface[`${missingSide}Image`]; delete surface[`${missingSide}Outcome`];
    delete surface[`${captureSide}Image`];
    surface[`${captureSide}Outcome`] = { status: 'failed', attempts: 1, landing: 'unverified' };
    surface.review = { status, description: status === 'added' ? 'Added' : 'Removed' };
    assert.doesNotThrow(() => assertPublicReview(input));
    surface.review = { status: 'needs-review', description: 'Capture failed' };
    assert.throws(() => assertPublicReview(input), /both verified destination routes/);
  }
});

test("reader drops old unsupported verdicts without mutating capture diagnostics or weakening publication", () => {
  for (const status of ['modified', 'unchanged', 'needs-review']) {
    const input = review();
    const surface = input.surfaces[0];
    surface.headOutcome.landing = 'unverified';
    surface.headOutcome.reason = 'Observed /login instead of /home';
    surface.review = { status, description: 'Old unverified comparison', facts: [{ category: 'text', templateId: 'old', bullet: 'Untrusted screen text' }] };
    surface.visual = { verdict: 'unchanged', reason: 'matched', threshold: 0.1, tool: 'agent-device' };
    const original = structuredClone(input);
    assert.throws(() => assertPublicReview(input), /both verified destination routes/);
    const normalized = normalizePublicReviewForReading(input);
    assert.equal(normalized.surfaces[0].review, undefined);
    assert.equal(normalized.surfaces[0].visual, undefined);
    assert.deepEqual(normalized.surfaces[0].headOutcome, surface.headOutcome);
    assert.deepEqual(normalized.surfaces[0].headImage, surface.headImage);
    assert.deepEqual(normalized.surfaces[1], input.surfaces[1]);
    assert.deepEqual(input, original, 'reading never rewrites the immutable artifact');
    assert.doesNotThrow(() => assertPublicReview(normalized));
    assert.equal(normalizePublicReviewForReading(normalized), normalized);
  }
});

test("reader restores Added and Removed source presence from old capture-failure verdicts", () => {
  for (const status of ['added', 'removed']) {
    const input = review();
    const surface = input.surfaces[0];
    const absent = status === 'added' ? 'base' : 'head';
    const present = status === 'added' ? 'head' : 'base';
    surface.status = status;
    surface[absent] = null;
    delete surface[`${absent}Image`]; delete surface[`${absent}Outcome`]; delete surface[`${present}Image`];
    surface[`${present}Outcome`] = { status: 'failed', attempts: 1, landing: 'unverified', reason: 'Session failed' };
    surface.review = { status: 'needs-review', description: 'Capture failed' };
    const normalized = normalizePublicReviewForReading(input);
    assert.equal(normalized.surfaces[0].review.status, status);
    assert.equal(normalized.surfaces[0][`${present}Outcome`].reason, 'Session failed');
    assert.throws(() => assertPublicReview(input), /both verified destination routes/);
  }
});

test("reader discards operational diff failures even when destination capture was verified", () => {
  const input = review();
  input.surfaces[0].visual = { verdict: 'needs-review', reason: 'diff-failed', threshold: 0.1, tool: 'agent-device' };
  input.surfaces[0].review = { status: 'needs-review', description: 'Visual comparison failed' };
  const normalized = normalizePublicReviewForReading(input);
  assert.equal(normalized.surfaces[0].review, undefined);
  assert.equal(normalized.surfaces[0].visual, undefined);
  assert.equal(normalized.surfaces[0].headOutcome.landing, 'verified');
  assert.throws(() => assertPublicReview(input), /visual verdict is inconsistent/);
});

test("reader never shows malformed original verdicts, capture outcomes, or provenance: the part is quarantined, a broken report is rejected", () => {
  const input = review();
  input.contract = "unknown";
  assert.throws(() => normalizePublicReviewForReading(input));
  for (const mutate of [
    input => { input.surfaces[0].review.description = 42; },
    input => { input.surfaces[0].review.status = 'unknown'; },
    input => { input.surfaces[0].review.facts = [{ bullet: 'incomplete fact' }]; },
    input => { input.surfaces[0].headOutcome.status = 'unknown'; },
    input => { input.surfaces[0].headOutcome.attempts = -1; },
    input => { input.surfaces[0].headImage.sourceCommit = baseSha; },
    input => { input.surfaces[0].headImage.url = 'http://insecure.example/image.png'; },
    input => { input.surfaces[0].visual = { verdict: 'unchanged', reason: 'matched', threshold: -Infinity, tool: 'agent-device' }; },
  ]) {
    const input = review();
    input.surfaces[0].headOutcome.landing = 'unverified';
    mutate(input);
    const gaps = [];
    const published = normalizePublicReviewForReading(input, gap => gaps.push(gap));
    assert.ok(gaps.length >= 1 && gaps.every(gap => gap.surfaceId === "home"), JSON.stringify(gaps));
    const home = published.surfaces.find(surface => surface.id === "home");
    assert.ok(!home || (home.review === undefined && home.visual === undefined), "nothing malformed is shown");
    assert.equal(published.surfaces.at(-1).id, "settings");
    assert.doesNotThrow(() => assertPublicReview(published));
  }
});

test("a source scope allows only its verdicts, and legacy source-unchanged differences read as variants", () => {
  const allowed = { screen: ["modified", "needs-review", "unchanged"], "app-wide": ["modified", "needs-review", "unchanged"], none: ["unchanged", "variant"] };
  for (const [scope, statuses] of Object.entries(allowed)) {
    for (const status of ["modified", "needs-review", "unchanged", "variant"]) {
      const input = review();
      input.surfaces[0].status = scope === "none" ? "unchanged" : "modified";
      input.surfaces[0].sourceScope = scope;
      input.surfaces[0].review = { status, description: "Evidence" };
      if (statuses.includes(status)) assert.doesNotThrow(() => assertPublicReview(input), `${scope} ${status}`);
      else assert.throws(() => assertPublicReview(input), /inconsistent/, `${scope} ${status}`);
    }
  }
  const mismatched = review();
  mismatched.surfaces[0].sourceScope = "none";
  assert.throws(() => assertPublicReview(mismatched), /source scope is inconsistent/);
  // A report from before source scopes: its source-unchanged differences become variants on read.
  const legacy = review();
  legacy.surfaces[0].status = "unchanged";
  legacy.surfaces[0].review = { status: "modified", description: "Removed text “84”." };
  legacy.surfaces[1].review = { status: "unchanged", description: "No visible change" };
  const read = normalizePublicReviewForReading(legacy);
  assert.deepEqual(read.surfaces[0].review, { status: "variant", description: "Runtime state differs: Removed text “84”." });
  assert.deepEqual(read.surfaces[1].review, legacy.surfaces[1].review, "a legacy source-changed verdict has no scope to re-judge");
  // A report from before 0.19.1 called a source change with matching captures "needs review": it reads as unchanged.
  const older = review();
  older.surfaces[0].review = { status: "needs-review", description: "Source changed; no visible difference was captured." };
  older.surfaces[1].review = { status: "needs-review", description: "Visual comparison was inconclusive" };
  const reread = normalizePublicReviewForReading(older);
  assert.deepEqual(reread.surfaces[0].review, { status: "unchanged", description: "No visible change" });
  assert.equal(reread.surfaces[1].review.status, "needs-review", "an inconclusive comparison still needs a look");
});

test("launch evidence carries verified splash and settled frames, an mp4 with provenance, and a splash verdict only when both sides observed one", () => {
  const frame = url => ({ url, sha256: "d".repeat(64), width: 1, height: 1, capturedAt: timestamp });
  const side = extra => ({ status: "observed", source: "screenshot", splash: frame("https://embedded.expo-explore.invalid/splash.png"),
    settled: frame("https://embedded.expo-explore.invalid/settled.png"), relaunchedAt: timestamp, splashVisibleMs: 3000, ...extra });
  const launch = entry => {
    const base = review();
    return { ...base, launch: [entry], ...(entry.colorScheme ? { runtime: { ...base.runtime, colorSchemes: ["light", "dark"] } } : {}) };
  };
  assert.doesNotThrow(() => assertPublicReview(launch({ id: "launch:splash", base: side(), head: side(), visual: { verdict: "unchanged", reason: "matched", threshold: 0.1, tool: "agent-device", mismatchPercentage: 0 } })));
  assert.doesNotThrow(() => assertPublicReview(launch({ id: "launch:splash@dark", colorScheme: "dark", head: side({
    video: { url: "https://embedded.expo-explore.invalid/launch.mp4", sha256: "e".repeat(64), bytes: 1200, mimeType: "video/mp4", durationMs: 7000 } }) })));
  assert.doesNotThrow(() => assertPublicReview(launch({ id: "launch:splash", head: { status: "not-observed", source: "screenshot", settled: frame("https://embedded.expo-explore.invalid/settled.png"), relaunchedAt: timestamp } })));
  assert.throws(() => assertPublicReview(launch({ id: "launch:splash", head: { status: "not-observed", source: "screenshot", splash: frame("https://embedded.expo-explore.invalid/splash.png"), settled: frame("https://embedded.expo-explore.invalid/settled.png"), relaunchedAt: timestamp } })), /launch/);
  assert.throws(() => assertPublicReview(launch({ id: "launch:splash", head: side({ video: { url: "https://embedded.expo-explore.invalid/launch.mp4", sha256: "e".repeat(64), bytes: 1200, mimeType: "video/webm" } }) })), /launch/);
  assert.throws(() => assertPublicReview(launch({ id: "launch:splash", head: side({ splash: undefined, status: "not-observed" }), base: side(), visual: { verdict: "unchanged", reason: "matched", threshold: 0.1, tool: "agent-device" } })), /visual verdict/);
  assert.throws(() => assertPublicReview(launch({ id: "home", head: side() })), /launch/);
  assert.throws(() => assertPublicReview(launch({ id: "launch:splash@dark", colorScheme: "light", head: side() })), /launch/);
});

test("quarantine: a verdict that breaks the contract is omitted and the screen keeps its captures", () => {
  const broken = review();
  broken.surfaces[1].review.description = "x".repeat(400);
  const { review: published, gaps } = quarantineReviewContract(broken);
  assert.deepEqual(gaps.map(gap => [gap.surfaceId, gap.dropped]), [["settings", "verdict"]]);
  assert.equal(published.surfaces.length, 2);
  assert.equal(published.surfaces[1].review, undefined);
  assert.ok(published.surfaces[1].headImage && published.surfaces[1].baseImage);
  assert.equal(published.surfaces[0].review.description, "No visible change");
  assert.doesNotThrow(() => assertPublicReview(published));
  assert.doesNotThrow(() => assertPublicReview(broken.surfaces[1].review.description.length === 400 ? published : broken), "the input is not mutated");
});

test("quarantine: a surface whose evidence breaks the contract is omitted, the rest publishes", () => {
  const broken = review();
  broken.surfaces[0].headOutcome.screenshotSha256 = "d".repeat(64);
  const { review: published, gaps } = quarantineReviewContract(broken);
  assert.deepEqual(gaps.map(gap => [gap.surfaceId, gap.dropped]), [["home", "verdict"], ["home", "surface"]]);
  assert.deepEqual(published.surfaces.map(surface => surface.id), ["settings"]);
  assert.doesNotThrow(() => assertPublicReview(published));
});

test("quarantine: a report-level contract failure still throws", () => {
  const broken = review();
  broken.runtime.gitCommit = baseSha;
  assert.throws(() => quarantineReviewContract(broken), /Invalid public review workspace/);
  const provenance = review();
  provenance.surfaces[0].headImage.buildId = "other-build";
  assert.throws(() => quarantineReviewContract(provenance), /disagree with their build provenance/);
});


test('a visual region may carry the shift its content moved by, and a malformed one is rejected', async () => {
  const { assertPublicReview } = await import('../../dist/contracts/review-validation.js');
  const valid = JSON.parse(JSON.stringify(reviewWithRegion({ x: 0, y: -4.17 })));
  assert.doesNotThrow(() => assertPublicReview(valid));
  // A card recentred on iPhone Duo's inner display moved 395 pixels: a large move is still a move.
  assert.doesNotThrow(() => assertPublicReview(JSON.parse(JSON.stringify(reviewWithRegion({ x: 395, y: 0 })))));
  for (const shift of [{ x: 0 }, { x: 0, y: Number.NaN }, { x: 0, y: 9000 }, 'up']) {
    assert.throws(() => assertPublicReview(reviewWithRegion(shift)), /visual verdict is inconsistent/, JSON.stringify(shift));
  }
});

function reviewWithRegion(shift) {
  const input = review();
  input.surfaces[0].review = { status: "modified", description: "Updated visual styling in the main content area." };
  input.surfaces[0].visual = { verdict: "modified", reason: "repeated-cross-build-delta", mismatchPercentage: 1, threshold: 0.1, tool: "agent-device",
    regions: [{ rect: { x: 0, y: 0, width: 1, height: 1 }, normalizedRect: { x: 0, y: 0, width: 100, height: 100 },
      differentPixels: 1, shareOfDiffPercentage: 100, dominantChange: "mixed", location: "center", shift }] };
  return input;
}

test('allRegionsMoved is only true, and only where every published region carries its shift', async () => {
  const { assertPublicReview } = await import('../../dist/contracts/review-validation.js');
  const moved = reviewWithRegion({ x: 0, y: 1 });
  moved.surfaces[0].visual.allRegionsMoved = true;
  assert.doesNotThrow(() => assertPublicReview(moved));
  for (const [label, mutate] of [['false', visual => { visual.allRegionsMoved = false; }],
    ['a region without a shift', visual => { delete visual.regions[0].shift; }],
    ['no regions', visual => { delete visual.regions; }]]) {
    const input = reviewWithRegion({ x: 0, y: 1 });
    input.surfaces[0].visual.allRegionsMoved = true;
    mutate(input.surfaces[0].visual);
    assert.throws(() => assertPublicReview(input), /visual verdict is inconsistent/, label);
  }
});

test('a large move publishes as one region where the content is now, with its members\' pixels and the arrived region\'s location', async () => {
  const { publishMeasuredRegions } = await import('../../dist/review/evidence-assessment.js');
  const region = (x, share, location, dominantChange) => ({ index: 0, rect: { x, y: 100, width: 100, height: 200 },
    normalizedRect: { x: x / 10, y: 10, width: 10, height: 20 }, differentPixels: share * 100, shareOfDiffPercentage: share,
    densityPercentage: 50, shape: 'block', size: 'large', location, dominantChange });
  // Arrived first: the card is centred now, so the region says center whichever member has more pixels.
  const all = [region(100, 50.01, 'middle-left', 'brighter'), region(450, 50.01, 'center', 'darker')];
  const moves = [{ rect: { x: 450, y: 100, width: 100, height: 200 }, shift: { x: 350, y: 0 }, members: [1, 0] }];
  const published = publishMeasuredRegions(all, [undefined, undefined], moves, 1000, 1000);
  assert.deepEqual(published.regions, [{ rect: { x: 450, y: 100, width: 100, height: 200 }, normalizedRect: { x: 45, y: 10, width: 10, height: 20 },
    differentPixels: 10002, shareOfDiffPercentage: 100, dominantChange: 'mixed', location: 'center', shift: { x: 350, y: 0 } }],
  'two shares of 50.01 cap at 100, the Viewer\'s bound');
  assert.equal(published.allRegionsMoved, true, 'nothing else on the screen changed');
  // A change that is not part of the move keeps the screen from reading as only moved, and more regions than the
  // published limit keep the largest.
  const crowded = [...all, ...Array.from({ length: 9 }, (_, index) => region(index, 0.5, 'top-left', 'mixed'))];
  const withChanges = publishMeasuredRegions(crowded, crowded.map(() => undefined), moves, 1000, 1000);
  assert.equal(withChanges.allRegionsMoved, undefined);
  assert.equal(withChanges.regions.length, 8);
  assert.deepEqual(withChanges.regions[0].shift, { x: 350, y: 0 });
});

test("an excluded surface carries no capture evidence", () => {
  const excluded = review();
  excluded.surfaces[1].excluded = true;
  assert.throws(() => assertPublicReview(excluded), /excluded surface carries capture evidence/);
  for (const key of ["baseImage", "headImage", "baseOutcome", "headOutcome", "review"]) delete excluded.surfaces[1][key];
  assert.doesNotThrow(() => assertPublicReview(excluded));
  excluded.surfaces[1].excluded = false;
  assert.throws(() => assertPublicReview(excluded), /excluded surface carries capture evidence/);
});
