import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { pairCheckpoints, conditionDifferences, runConditions } = await tsImport("../../src/contracts/flow-comparison.ts", import.meta.url);
const { compareFlowRuns } = await tsImport("../../src/review/flow-comparison.ts", import.meta.url);
const { writeFlowReviewReport } = await tsImport("../../src/review/flow-review.ts", import.meta.url);
const { PNG } = createRequire(import.meta.url)("pngjs");

const png = (width, height) => PNG.sync.write(new PNG({ width, height }));

/**
 * A minimal exploration report of a flows run, written to a directory. `flows` maps each flow name to its checkpoints,
 * each `[name, size]` for a picture of that size or `[name, { missing }]` for one without.
 */
async function run(flows, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "explore-flow-compare-"));
  await mkdir(join(directory, "assets"));
  const report = { kind: "explore.exploration-report", assets: [],
    map: { run: { environment: { deviceModel: options.device ?? "iPhone 17 Pro", locale: options.locale ?? "en_US", orientation: "portrait", colorScheme: options.colorScheme ?? "light" } }, observations: [], artifacts: [] },
    exploration: { app: { name: "Example", bundleId: options.bundleId ?? "dev.example.app", platform: options.platform ?? "ios" }, device: { model: options.device ?? "iPhone 17 Pro", osVersion: options.osVersion ?? "26.0" }, flows: [] } };
  let index = 0;
  for (const [name, checkpoints] of Object.entries(flows)) {
    const flow = { name, status: "completed", checkpoints: [], ...options.flow?.[name] };
    for (const [checkpoint, shot] of checkpoints) {
      if (shot.missing) { flow.checkpoints.push({ name: checkpoint, missing: shot.missing }); continue; }
      // Named by a digest, as a run names its assets: two runs never share a name for different pictures.
      const sha = createHash("sha256").update(`${directory}:${++index}`).digest("hex"), id = `obs_${index}`;
      await writeFile(join(directory, "assets", `${sha}.png`), png(...shot));
      report.assets.push({ sha256: sha, path: `assets/${sha}.png` });
      report.map.artifacts.push({ id: `art_${index}`, kind: "screenshot", sha256: sha });
      const observation = { id, screenshotArtifactId: `art_${index}` };
      const text = options.text?.[checkpoint];
      if (text) {
        // The accessibility tree a run keeps beside its report, as the explorer writes it.
        const path = `artifacts/accessibility/${index}.json`;
        await mkdir(join(directory, "artifacts", "accessibility"), { recursive: true });
        await writeFile(join(directory, path), JSON.stringify({ nodes: text.map(label => ({ label })) }));
        report.map.artifacts.push({ id: `acc_${index}`, kind: "accessibility", path });
        observation.accessibilityArtifactId = `acc_${index}`;
      }
      report.map.observations.push(observation);
      flow.checkpoints.push({ name: checkpoint, observationId: id });
    }
    report.exploration.flows.push(flow);
  }
  return { report, directory };
}

/** A diff that finds the given regions (in percent), each 1% of the pixels. */
const measuring = (regionsFor = () => []) => async (baselinePath, currentPath) => {
  const regions = regionsFor(baselinePath, currentPath).map((normalizedRect, index) => ({ index, normalizedRect, rect: normalizedRect, differentPixels: 100, shareOfDiffPercentage: 0, densityPercentage: 0, shape: "", size: "" }));
  return { baselinePath, currentPath, totalPixels: 10_000, differentPixels: regions.length * 100, mismatchPercentage: regions.length, match: regions.length === 0, regions };
};

test("checkpoints pair by flow and checkpoint name, ignoring case, in the after run's order", async () => {
  const before = await run({ "Sign in": [["Welcome", [4, 8]], ["Home", [4, 8]]], Settings: [["Settings", [4, 8]]] });
  const after = await run({ "sign in": [["home", [4, 8]], ["welcome", { missing: "The screenshot was blocked." }]], Profile: [["Profile", [4, 8]]] });
  const pairs = pairCheckpoints(before.report, after.report);
  assert.deepEqual(pairs.map(pair => [pair.flow, pair.checkpoint, !!pair.before, !!pair.after]), [
    ["sign in", "home", true, true], ["sign in", "welcome", true, true], ["Profile", "Profile", false, true], ["Settings", "Settings", true, false]]);
  assert.deepEqual(pairs[1].after, { missing: "The screenshot was blocked." });
  assert.equal(pairs[0].before.screenshot, before.report.assets[1].path, "Home is the before run's second picture");
});

test("a run's conditions that differ are listed, not refused", async () => {
  const before = await run({ A: [["Home", [4, 8]]] }), after = await run({ A: [["Home", [4, 8]]] }, { osVersion: "27.0", colorScheme: "dark" });
  assert.deepEqual(conditionDifferences(runConditions(before.report), runConditions(after.report)),
    [{ field: "osVersion", before: "26.0", after: "27.0" }, { field: "colorScheme", before: "light", after: "dark" }]);
});

test("each pair gets a verdict: unchanged, changed with where, missing, different-size, added or removed", async () => {
  const before = await run({ Flow: [["Same", [4, 8]], ["Moved", [4, 8]], ["Gone", [4, 8]], ["Blocked", [4, 8]], ["Rotated", [4, 8]]] });
  const after = await run({ Flow: [["Same", [4, 8]], ["Moved", [4, 8]], ["New", [4, 8]], ["Blocked", { missing: "A secret was on screen." }], ["Rotated", [8, 4]]] });
  const measured = [];
  const result = await compareFlowRuns(before, after, measuring((baseline, current) => {
    measured.push([baseline, current]);
    return baseline.endsWith(before.report.assets[1].path) ? [{ x: 10, y: 40, width: 20, height: 10 }] : [];
  }));
  assert.deepEqual(result.checkpoints.map(item => [item.checkpoint, item.verdict]),
    [["Same", "unchanged"], ["Moved", "changed"], ["New", "added"], ["Blocked", "missing"], ["Rotated", "different-size"], ["Gone", "removed"]]);
  assert.equal(measured.length, 2, "only pairs with a picture of the same size on both sides are diffed");
  assert.deepEqual(result.checkpoints[1].regions, [{ x: 10, y: 40, width: 20, height: 10 }]);
  assert.equal(result.checkpoints[1].mismatchPercentage, 1);
  assert.deepEqual(result.counts, { unchanged: 1, changed: 1, "different-size": 1, missing: 1, added: 1, removed: 1 });
  assert.deepEqual(result.conditions, []);
});

test("a difference only in the status bar is set aside, as in a review", async () => {
  const before = await run({ Flow: [["Home", [4, 8]]] }), after = await run({ Flow: [["Home", [4, 8]]] });
  const result = await compareFlowRuns(before, after, measuring(() => [{ x: 80, y: 1, width: 10, height: 2 }]));
  assert.equal(result.checkpoints[0].verdict, "unchanged");
});

test("on a foldable, the status bar is not set aside and the result says why", async () => {
  const before = await run({ Flow: [["Home", [4, 8]]] }, { device: "iPhone Duo" }), after = await run({ Flow: [["Home", [4, 8]]] }, { device: "iPhone Duo" });
  // Where the folded panel's status bar is: guessing that panel would hide a change the open panel shows there.
  const result = await compareFlowRuns(before, after, measuring(() => [{ x: 86, y: 13, width: 4, height: 4 }]));
  assert.equal(result.checkpoints[0].verdict, "changed");
  assert.match(result.notes[0], /foldable/);
});

test("compare:flows reads two output directories, needs no diff when no pair has two pictures, and refuses a run without flows", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = join(import.meta.dirname, "../..");
  const cli = join(root, "dist", "cli.js");
  const before = await run({ Flow: [["Home", { missing: "Not reached." }]] }), after = await run({ Flow: [["Home", [4, 8]]] });
  // explore:binary leaves the report in <output>/report.
  const output = await mkdtemp(join(tmpdir(), "explore-flow-compare-out-"));
  await mkdir(join(output, "report", "assets"), { recursive: true });
  await writeFile(join(output, "report", "exploration.json"), JSON.stringify(after.report));
  await writeFile(join(before.directory, "exploration.json"), JSON.stringify(before.report));
  const compared = spawnSync(process.execPath, [cli, "compare:flows", "--before", before.directory, "--after", output], { cwd: root, encoding: "utf8" });
  assert.equal(compared.status, 0, compared.stderr);
  const result = JSON.parse(compared.stdout);
  assert.deepEqual(result.comparison.checkpoints.map(item => [item.checkpoint, item.verdict]), [["Home", "missing"]]);
  const plain = await run({});
  delete plain.report.exploration.flows;
  await writeFile(join(plain.directory, "exploration.json"), JSON.stringify(plain.report));
  const refused = spawnSync(process.execPath, [cli, "compare:flows", "--before", plain.directory, "--after", output], { cwd: root, encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(JSON.parse(refused.stderr).error, /did not follow a flows file/);
});

test("a review report is the after run's report with the review beside it: both builds' pictures and text, each flow's outcome and steps", async () => {
  const steps = [{ checkpoint: "Home" }, { action: 'tap "Continue"' }, { checkpoint: "Done" }];
  const before = await run({ Flow: [["Home", [4, 8]], ["Done", [4, 8]]] }, { text: { Home: ["Welcome", "Sign in"], Done: ["All set"] }, flow: { Flow: { steps } } });
  const after = await run({ Flow: [["Home", [4, 8]], ["Done", { missing: "The flow did not reach it." }]] },
    { text: { Home: ["Welcome", "Log in"] }, flow: { Flow: { status: "failed", reason: "Step 2 (tap \"Continue\") failed: no such element", steps, failedStep: 2 } } });
  const comparison = await compareFlowRuns(before, after, measuring(() => [{ x: 10, y: 40, width: 20, height: 10 }]));
  const target = await mkdtemp(join(tmpdir(), "explore-flow-review-"));
  await writeFlowReviewReport(comparison, before, after, target);
  const written = JSON.parse(await readFile(join(target, "exploration.json"), "utf8"));
  assert.equal(written.kind, "explore.exploration-report");
  assert.deepEqual(written.exploration, after.report.exploration, "the after run's report is kept as it was");
  const [flow] = written.flowReview.flows;
  assert.deepEqual(flow.after, { status: "failed", reason: 'Step 2 (tap "Continue") failed: no such element', steps, failedStep: 2 });
  assert.deepEqual(flow.before, { status: "completed", steps });
  assert.deepEqual(flow.checkpoints.map(item => [item.name, item.verdict]), [["Home", "changed"], ["Done", "missing"]]);
  assert.deepEqual(flow.checkpoints[0].before.text, ["Welcome", "Sign in"]);
  assert.deepEqual(flow.checkpoints[0].after.text, ["Welcome", "Log in"]);
  assert.deepEqual(flow.checkpoints[0].regions, [{ x: 10, y: 40, width: 20, height: 10 }]);
  assert.deepEqual(flow.checkpoints[1].after, { missing: "The flow did not reach it." });
  // Every picture the review names is in the report's folder, the before run's included.
  for (const checkpoint of flow.checkpoints) for (const side of [checkpoint.before, checkpoint.after]) {
    if (side?.screenshot) await access(join(target, side.screenshot));
  }
  assert.equal(written.assets.length, 3);
});

test("a review report is not written over one of the runs' own reports", async () => {
  const before = await run({ Flow: [["Home", [4, 8]]] }), after = await run({ Flow: [["Home", [4, 8]]] });
  const comparison = await compareFlowRuns(before, after, measuring());
  await assert.rejects(writeFlowReviewReport(comparison, before, after, after.directory), /its own folder/);
});
