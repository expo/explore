import assert from "node:assert/strict";
import test from "node:test";

const { tsImport } = await import("tsx/esm/api");
const { reviewProjectionFromWorkspace } = await tsImport("../../viewer/src/utils/review-model.ts", import.meta.url);

const base = { ref: "v1.3.0", sha: "a".repeat(40) };
const head = { ref: "v1.4.0", sha: "b".repeat(40) };
const url = `https://github.com/acme/app/compare/${base.sha}...${head.sha}`;
const projection = pullRequest => reviewProjectionFromWorkspace({ review: { surfaces: {}, runtimeEvidence: {}, pullRequest } })?.pullRequest;

test("the Viewer reads a comparison of two commits, with its compare page and no PR number", () => {
  assert.deepEqual(projection({ origin: "compare", title: "v1.4.0 vs v1.3.0", url, base, head }),
    { origin: "compare", title: "v1.4.0 vs v1.3.0", url, base, head });
});

test("the Viewer drops a comparison whose link is not the compare page of its own commits", () => {
  assert.equal(projection({ origin: "compare", title: "x", url: "https://example.com/compare", base, head }), undefined);
  assert.equal(projection({ origin: "compare", title: "x", url: `https://github.com/acme/app/compare/${head.sha}...${base.sha}`, base, head }), undefined);
  assert.equal(projection({ origin: "compare", title: "x", url: `https://github.com/acme/app/pull/7`, base, head }), undefined);
});
