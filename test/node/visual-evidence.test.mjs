import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assessVisualMeasurements,
  diffScreenshots,
} from "../../dist/review/visual-evidence.js";

const visualEvidenceSource = await readFile(
  resolve(import.meta.dirname, "../../src/review/visual-evidence.ts"),
  "utf8",
);

function measurement(mismatchPercentage, match = mismatchPercentage === 0) {
  return {
    baselinePath: "/tmp/base.png",
    currentPath: "/tmp/head.png",
    totalPixels: 100,
    differentPixels: mismatchPercentage,
    mismatchPercentage,
    match,
    regions: [],
  };
}

test("runs only an explicit absolute agent-device binary with direct diff arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "expo-explore-visual-diff-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const baseline = join(root, "baseline.png");
  const current = join(root, "current.png");
  const command = join(root, "agent-device");
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await Promise.all([
    writeFile(baseline, pngSignature),
    writeFile(current, pngSignature),
  ]);
  const [canonicalBaseline, canonicalCurrent] = await Promise.all([
    realpath(baseline),
    realpath(current),
  ]);
  const expectedArguments = [
    "--json",
    "diff",
    "screenshot",
    "--baseline",
    canonicalBaseline,
    canonicalCurrent,
    "--threshold",
    "0.1",
  ];
  await writeFile(
    command,
    `#!/usr/bin/env node\nconst actual = process.argv.slice(2);\nconst expected = ${JSON.stringify(expectedArguments)};\nif (JSON.stringify(actual) !== JSON.stringify(expected)) { console.error(JSON.stringify(actual)); process.exit(2); }\nprocess.stdout.write(JSON.stringify({ success: true, data: { regions: [], totalPixels: 1, differentPixels: 0, mismatchPercentage: 0, match: true } }));\n`,
    { mode: 0o700 },
  );
  await chmod(command, 0o700);

  const result = await diffScreenshots({ baselinePath: baseline, currentPath: current, command });
  assert.equal(result.match, true);
  assert.equal(result.totalPixels, 1);
  await assert.rejects(
    diffScreenshots({ baselinePath: baseline, currentPath: current, command: "agent-device" }),
    /absolute path/,
  );
  assert.doesNotMatch(visualEvidenceSource, /\bnpx\b|npm_config_yes|agent-device@/);
});

test("requires three stable samples before confirming an impacted visual change", () => {
  const result = assessVisualMeasurements({
    baselineSamples: 1,
    currentSamples: 1,
    requiredSamples: 3,
    baselineWithin: [],
    currentWithin: [],
    crossBuild: [measurement(8.4, false)],
  });
  assert.equal(result.status, "needs-review");
  assert.equal(result.reason, "insufficient-samples");
});

test("confirms only a stable repeated cross-build delta", () => {
  const representative = measurement(8.4, false);
  const result = assessVisualMeasurements({
    baselineSamples: 3,
    currentSamples: 3,
    requiredSamples: 3,
    baselineWithin: [measurement(0), measurement(0), measurement(0)],
    currentWithin: [measurement(0), measurement(0), measurement(0)],
    crossBuild: [representative, measurement(8.3, false), measurement(8.5, false)],
    representative,
  });
  assert.equal(result.status, "modified");
  assert.equal(result.reason, "repeated-cross-build-delta");
  assert.equal(result.crossBuildMismatchPercentage, 8.4);
});

test("measures a difference without judging its source provenance", () => {
  const result = assessVisualMeasurements({
    baselineSamples: 1,
    currentSamples: 1,
    requiredSamples: 1,
    baselineWithin: [],
    currentWithin: [],
    crossBuild: [measurement(3.2, false)],
  });
  assert.equal(result.status, "modified");
  assert.equal(result.reason, "repeated-cross-build-delta");
  const noise = assessVisualMeasurements({ baselineSamples: 1, currentSamples: 1, requiredSamples: 1,
    baselineWithin: [], currentWithin: [], crossBuild: [measurement(0.004, false)] });
  assert.equal(noise.status, "unchanged", "a mismatch that rounds to 0.00% is noise");
});

test("does not call an unstable surface changed", () => {
  const result = assessVisualMeasurements({
    baselineSamples: 3,
    currentSamples: 3,
    requiredSamples: 3,
    baselineWithin: [measurement(0), measurement(1.2, false)],
    currentWithin: [measurement(0)],
    crossBuild: [measurement(9, false), measurement(9.1, false), measurement(9.2, false)],
  });
  assert.equal(result.status, "needs-review");
  assert.equal(result.reason, "within-side-instability");
});

test("keeps stable matching screenshots unchanged", () => {
  const result = assessVisualMeasurements({
    baselineSamples: 1,
    currentSamples: 1,
    requiredSamples: 1,
    baselineWithin: [],
    currentWithin: [],
    crossBuild: [measurement(0)],
  });
  assert.equal(result.status, "unchanged");
  assert.equal(result.reason, "matched");
});
