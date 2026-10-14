import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { assertCompleteCapture, assertCompleteCaptures, captureHealthIssues, hasVerifiedCapture, partitionCaptureHealthIssues, renderCaptureIssueAnnotation } = await tsImport("../../src/capture/health.ts", import.meta.url);
const COMMIT = "a".repeat(40);
const HASH = "b".repeat(64);
function fixture(side = "head") {
  return {
    contract: "explore.bundle", side, gitCommit: COMMIT, easBuildId: "build", easProjectId: "project",
    profile: "simulator", selectedSurfaceIds: ["home"],
    images: { home: { path: "artifacts/home.png", sha256: HASH, width: 100, height: 200,
      capturedAt: "2026-09-22T00:00:00.000Z", sourceCommit: COMMIT, buildId: "build" } },
    outcomes: { home: { status: "captured", attempts: 1, landing: "verified", screenshotSha256: HASH } },
  };
}

test("complete verified evidence and a genuinely empty capture selection pass", () => {
  const bundle = fixture();
  assert.doesNotThrow(() => assertCompleteCapture(bundle, ["home"], "head"));
  assert.deepEqual(captureHealthIssues(bundle, ["home"]), []);
  assert.equal(hasVerifiedCapture(bundle, "home"), true);
  assert.doesNotThrow(() => assertCompleteCapture({ ...bundle, selectedSurfaceIds: [], images: {}, outcomes: {} }, []));
});

test("every unavailable outcome fails the required coverage gate with an actionable diagnostic", async t => {
  for (const status of ["missing-params", "unsupported-link", "failed", "budget-exhausted"]) {
    await t.test(status, () => {
      const bundle = fixture();
      delete bundle.images.home;
      bundle.outcomes.home = { status, attempts: 0, landing: "unverified", reason: "The target could not be reached." };
      assert.equal(hasVerifiedCapture(bundle, "home"), false);
      assert.throws(() => assertCompleteCapture(bundle, ["home"]), error => {
        assert.equal(error.code, "CAPTURE_INCOMPLETE");
        assert.equal(error.stage, "capture-validation");
        assert.equal(error.retryable, false);
        assert.equal(error.details.issues[0].side, "head");
        assert.equal(error.details.issues[0].surfaceId, "home");
        assert.equal(error.details.issues[0].message, "The target could not be reached.");
        assert.ok(error.details.issues[0].nextAction.length > 20);
        return true;
      });
    });
  }
});

test("unverified, missing, hash-unbound, and wrong-revision screenshots cannot pass", async t => {
  const cases = [
    ["unverified", bundle => { bundle.outcomes.home.landing = "unverified"; }, "CAPTURE_DESTINATION_UNVERIFIED"],
    ["missing image", bundle => { delete bundle.images.home; }, "CAPTURE_IMAGE_MISSING"],
    ["missing hash binding", bundle => { delete bundle.outcomes.home.screenshotSha256; }, "CAPTURE_IMAGE_BINDING_INVALID"],
    ["different hash binding", bundle => { bundle.outcomes.home.screenshotSha256 = "c".repeat(64); }, "CAPTURE_IMAGE_BINDING_INVALID"],
    ["invalid hash", bundle => { bundle.images.home.sha256 = bundle.outcomes.home.screenshotSha256 = "not-a-hash"; }, "CAPTURE_IMAGE_BINDING_INVALID"],
    ["wrong revision", bundle => { bundle.images.home.sourceCommit = "c".repeat(40); }, "CAPTURE_IMAGE_PROVENANCE_INVALID"],
  ];
  for (const [name, mutate, expectedCode] of cases) {
    await t.test(name, () => {
      const bundle = fixture(); mutate(bundle);
      assert.equal(hasVerifiedCapture(bundle, "home"), false);
      assert.equal(captureHealthIssues(bundle, ["home"])[0].code, expectedCode);
      assert.throws(() => assertCompleteCapture(bundle, ["home"]), { code: "CAPTURE_INCOMPLETE" });
    });
  }
});

test("a bundle cannot pass by silently dropping a planned target or its outcome", () => {
  const bundle = fixture();
  assert.deepEqual(captureHealthIssues(bundle, ["home", "settings"]).map(issue => [issue.surfaceId, issue.code]), [
    ["settings", "CAPTURE_TARGET_MISSING"],
  ]);
  bundle.selectedSurfaceIds.push("settings");
  assert.equal(captureHealthIssues(bundle, ["home", "settings"])[0].code, "CAPTURE_OUTCOME_MISSING");
  assert.throws(() => assertCompleteCapture(bundle, ["home", "settings"]), { code: "CAPTURE_INCOMPLETE" });
});

test("wrong side, duplicated inventories, and unplanned evidence fail", () => {
  assert.equal(captureHealthIssues(fixture(), ["home"], "base")[0].code, "CAPTURE_SIDE_MISMATCH");
  assert.equal(captureHealthIssues(fixture(), ["home", "home"])[0].code, "CAPTURE_SELECTION_DUPLICATE");
  const bundle = fixture(); bundle.selectedSurfaceIds.push("home");
  assert.equal(captureHealthIssues(bundle, ["home"])[0].code, "CAPTURE_SELECTION_DUPLICATE");
  assert.equal(captureHealthIssues(fixture(), [])[0].code, "CAPTURE_TARGET_UNEXPECTED");
});

test("aggregated failure retains both revisions and original actionable capture errors in deterministic order", () => {
  const base = fixture("base"); base.outcomes.home.landing = "unverified";
  const head = fixture("head"); delete head.images.home;
  head.outcomes.home = { status: "failed", attempts: 2, landing: "unverified", error: {
    code: "ROUTE_MISMATCH", stage: "capture", message: "Expected /home but observed /onboarding.",
    nextAction: "Complete onboarding before opening /home.", retryable: false,
  } };
  const input = [{ bundle: head, selectedIds: ["home"] }, { bundle: base, selectedIds: ["home"] }];
  const diagnostics = [];
  for (const entries of [input, [...input].reverse()]) {
    assert.throws(() => assertCompleteCaptures(entries), error => {
      assert.match(error.message, /base: 1 incomplete target — CAPTURE_DESTINATION_UNVERIFIED ×1: home; head: 1 incomplete target — ROUTE_MISMATCH ×1: home/);
      diagnostics.push(error.details);
      assert.deepEqual(error.details.issues.map(issue => [issue.side, issue.code]), [
        ["base", "CAPTURE_DESTINATION_UNVERIFIED"], ["head", "ROUTE_MISMATCH"],
      ]);
      assert.equal(error.details.issues[1].message, "Expected /home but observed /onboarding.");
      assert.equal(error.details.issues[1].nextAction, "Complete onboarding before opening /home.");
      return true;
    });
  }
  assert.deepEqual(diagnostics[0], diagnostics[1]);
});

test("a dark+light bundle carries each target's secondary frame as <target>@<scheme>: expected, and required once the route captured", () => {
  const both = () => {
    const bundle = fixture();
    bundle.runtimeProfile = { deviceModel: "iPhone", osVersion: "26", locale: "en", orientation: "portrait", colorScheme: "light", colorSchemes: "light,dark" };
    bundle.images["home@dark"] = { ...bundle.images.home, path: "artifacts/home-dark.png", sha256: "c".repeat(64) };
    return bundle;
  };
  assert.deepEqual(captureHealthIssues(both(), ["home"]), []);
  const missing = both(); delete missing.images["home@dark"];
  assert.deepEqual(captureHealthIssues(missing, ["home"]).map(issue => [issue.code, issue.surfaceId]), [["CAPTURE_IMAGE_MISSING", "home@dark"]]);
  const wrongCommit = both(); wrongCommit.images["home@dark"].sourceCommit = "f".repeat(40);
  assert.deepEqual(captureHealthIssues(wrongCommit, ["home"]).map(issue => issue.code), ["CAPTURE_IMAGE_PROVENANCE_INVALID"]);
  const asTarget = both(); asTarget.outcomes["home@dark"] = asTarget.outcomes.home;
  assert.deepEqual(captureHealthIssues(asTarget, ["home"]).map(issue => issue.code), ["CAPTURE_TARGET_UNEXPECTED"]);
  const single = fixture(); single.images["home@dark"] = { ...single.images.home };
  assert.deepEqual(captureHealthIssues(single, ["home"]).map(issue => issue.code), ["CAPTURE_TARGET_UNEXPECTED"]);
  const darkFailed = both(); delete darkFailed.images["home@dark"];
  darkFailed.outcomes["home@dark"] = { status: "failed", attempts: 0, landing: "unverified", reason: "Configured UI prerequisites did not complete.",
    error: { code: "SETUP_FAILED", stage: "setup", message: "Setup timed out.", nextAction: "Fix setup.", retryable: false } };
  const issues = captureHealthIssues(darkFailed, ["home"]);
  assert.deepEqual(issues.map(issue => [issue.code, issue.surfaceId, issue.message]), [["SETUP_FAILED", "home@dark", "Configured UI prerequisites did not complete."]],
    "a failed appearance pass is that appearance's own unavailability, not an unexpected target");
  assert.deepEqual(partitionCaptureHealthIssues(issues).integrity, []);
  assert.deepEqual(partitionCaptureHealthIssues(captureHealthIssues(wrongCommit, ["home"])).unavailable, []);
  assert.match(renderCaptureIssueAnnotation(issues[0]), /^::warning title=Explore head capture unavailable \(home@dark\)::SETUP_FAILED: Configured UI prerequisites did not complete\.%0ANext action/);
  // The light pass died in setup and the dark pass landed: the route is published from its dark frame, light unavailable.
  const darkOnly = both();
  darkOnly.outcomes["home@dark"] = { ...darkOnly.outcomes.home, screenshotSha256: "c".repeat(64) };
  delete darkOnly.images.home;
  darkOnly.outcomes.home = { status: "failed", attempts: 1, landing: "unverified", reason: "Configured UI prerequisites did not complete.",
    error: { code: "SETUP_FAILED", stage: "setup", message: "adb: device offline", nextAction: "Rerun capture.", retryable: true } };
  const darkOnlyIssues = captureHealthIssues(darkOnly, ["home"]);
  assert.deepEqual(darkOnlyIssues.map(issue => [issue.code, issue.surfaceId]), [["SETUP_FAILED", "home"]]);
  assert.deepEqual(partitionCaptureHealthIssues(darkOnlyIssues).integrity, []);
  const darkOnlyNoImage = structuredClone(darkOnly); delete darkOnlyNoImage.images["home@dark"];
  assert.deepEqual(captureHealthIssues(darkOnlyNoImage, ["home"]).map(issue => [issue.code, issue.surfaceId]),
    [["CAPTURE_IMAGE_MISSING", "home@dark"], ["SETUP_FAILED", "home"]], "a verified secondary outcome still needs its screenshot");
});
