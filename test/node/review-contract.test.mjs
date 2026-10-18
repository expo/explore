import assert from "node:assert/strict";
import test from "node:test";
import { projectPullRequestPresentation, projectReviewPresentation } from "../../dist/contracts/review.js";

const input = {
  repositoryId: "123456789",
  repository: "expo/explore-playground",
  number: 42,
  title: "Review the Example app map",
  url: "https://github.com/expo/explore-playground/pull/42",
  base: { ref: "pilot/explore-base", sha: "a".repeat(40) },
  head: { ref: "pilot/explore-changes", sha: "b".repeat(40) },
};

test("projects exact non-default PR base and head metadata", () => {
  assert.deepEqual(projectPullRequestPresentation(input), input);
});

test("rejects PR URLs and metadata that can escape the fixed repository", () => {
  assert.throws(
    () => projectPullRequestPresentation({ ...input, url: "https://example.com/secret" }),
    /canonical github.com/,
  );
  assert.throws(
    () => projectPullRequestPresentation({ ...input, extra: "secret" }),
    /unsupported field/,
  );
});

const comparison = {
  origin: "compare",
  repositoryId: "123456789",
  repository: "expo/explore-playground",
  base: { ref: "v1.3.0", sha: "a".repeat(40) },
  head: { ref: "v1.4.0-rc.1", sha: "b".repeat(40) },
};

test("a comparison of two commits gets github.com's compare URL and a title from its refs", () => {
  assert.deepEqual(projectReviewPresentation(comparison), {
    ...comparison, title: "v1.4.0-rc.1 vs v1.3.0",
    url: `https://github.com/expo/explore-playground/compare/${"a".repeat(40)}..${"b".repeat(40)}`,
  });
  const bySha = projectReviewPresentation({ ...comparison, head: { ref: "b".repeat(40), sha: "b".repeat(40) } });
  assert.equal(bySha.title, "bbbbbbbb vs v1.3.0", "a ref given as a SHA reads as its short form");
  assert.equal(projectReviewPresentation({ ...comparison, title: "Nightly" }).title, "Nightly");
  const projected = projectReviewPresentation(comparison);
  assert.deepEqual(projectReviewPresentation(projected), projected, "projection is stable, so a stored comparison validates again");
});

test("rejects comparisons that name another URL, a PR number, or one commit twice", () => {
  assert.throws(() => projectReviewPresentation({ ...comparison, url: "https://example.com/compare" }), /compare URL/);
  assert.throws(() => projectReviewPresentation({ ...comparison, number: 7 }), /unsupported field/);
  assert.throws(() => projectReviewPresentation({ ...comparison, head: comparison.base }), /different commits/);
  assert.throws(() => projectReviewPresentation({ ...comparison, repositoryId: "x" }), /decimal GitHub id/);
});

test("a run's scope overrides the reviewed config only where the workflow set it; a link lifetime from older workflows changes nothing", async () => {
  const { withRunOverrides } = await import("../../dist/config/explore-config.js");
  const config = { exploration: { scope: "changes" }, report: { preview: { hosting: "eas" } } };
  assert.deepEqual(withRunOverrides(config, {}), config);
  assert.deepEqual(withRunOverrides(config, { scope: "all", expiresIn: "never" }), { exploration: { scope: "all" }, report: { preview: { hosting: "eas" } } });
  // A hosted preview lasts as long as its EAS Hosting deployment, so --expires-in is accepted from older workflows and ignored, whatever it says.
  assert.deepEqual(withRunOverrides(config, { expiresIn: "forever" }), config);
  assert.throws(() => withRunOverrides(config, { scope: "everything" }), /--scope must be changes or all/);
});

test("a comparison links GitHub's direct two-dot diff, which matches what capture compares, also for a rollback", () => {
  // Three dots diff from the merge base: comparing a newer base to an older head would show nothing there.
  const rollback = projectReviewPresentation({ ...comparison, base: comparison.head, head: comparison.base });
  assert.equal(rollback.url, `https://github.com/expo/explore-playground/compare/${"b".repeat(40)}..${"a".repeat(40)}`);
  assert.throws(() => projectReviewPresentation({ ...comparison, url: `https://github.com/expo/explore-playground/compare/${"a".repeat(40)}...${"b".repeat(40)}` }), /compare URL/);
});
