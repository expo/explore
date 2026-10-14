import assert from "node:assert/strict";
import test from "node:test";
import { projectPullRequestPresentation } from "../../dist/contracts/review.js";

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
