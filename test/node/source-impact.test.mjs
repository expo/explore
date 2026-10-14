import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GLOBAL_IMPACT_PATHS,
  parseTwoDotSourceImpact,
} from "../../dist/source/impact.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function fixture(changes = []) {
  return {
    schemaVersion: 1,
    mode: "two-dot",
    range: `${BASE}..${HEAD}`,
    baseSha: BASE,
    headSha: HEAD,
    changes,
  };
}

test("normalizes trusted Git name-status records", () => {
  assert.deepEqual(parseTwoDotSourceImpact(fixture([
    { status: "M", path: "src/screens/home.tsx" },
    { status: "A", path: "src/screens/new.tsx" },
    { status: "D", path: "src/screens/old.tsx" },
    { status: "T", path: "assets/icon.png" },
    { status: "R100", path: "src/old.tsx", nextPath: "src/new.tsx" },
    { status: "C87", path: "src/source.tsx", nextPath: "src/copy.tsx" },
  ])).changes, [
    { status: "modified", path: "src/screens/home.tsx" },
    { status: "added", path: "src/screens/new.tsx" },
    { status: "removed", path: "src/screens/old.tsx" },
    { status: "type-changed", path: "assets/icon.png" },
    { status: "renamed", previousPath: "src/old.tsx", path: "src/new.tsx" },
    { status: "copied", previousPath: "src/source.tsx", path: "src/copy.tsx" },
  ]);
});

test("requires an exact two-dot range and lowercase full SHAs", () => {
  assert.throws(
    () => parseTwoDotSourceImpact({ ...fixture(), range: `${BASE}...${HEAD}` }),
    /exactly match/,
  );
  assert.throws(
    () => parseTwoDotSourceImpact({ ...fixture(), baseSha: BASE.toUpperCase() }),
    /lowercase full 40-character/,
  );
});

test("rejects merge-conflict statuses, unsafe paths, duplicate destinations, and extra fields", () => {
  assert.throws(
    () => parseTwoDotSourceImpact(fixture([{ status: "U", path: "src/a.tsx" }])),
    /unsupported/,
  );
  assert.throws(
    () => parseTwoDotSourceImpact(fixture([{ status: "M", path: "../secret" }])),
    /safe repository-relative/,
  );
  assert.throws(
    () => parseTwoDotSourceImpact(fixture([
      { status: "M", path: "src/a.tsx" },
      { status: "A", path: "src/a.tsx" },
    ])),
    /repeats destination/,
  );
  assert.throws(
    () => parseTwoDotSourceImpact({ ...fixture(), mergeBase: BASE }),
    /missing or unsupported/,
  );
});

test("ships conservative app-wide impact rules", () => {
  assert.ok(DEFAULT_GLOBAL_IMPACT_PATHS.includes("package.json"));
  assert.ok(DEFAULT_GLOBAL_IMPACT_PATHS.includes("src/app/_layout.tsx"));
  assert.ok(DEFAULT_GLOBAL_IMPACT_PATHS.includes("src/theme/"));
});
