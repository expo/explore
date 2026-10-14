import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const source = await readFile(new URL("../../templates/explore-review.yml", import.meta.url), "utf8");
const workflow = parse(source);

test("report publishes one normal ZIP artifact to the hosted Viewer", () => {
  const report = workflow.jobs.report;
  const packageIndex = report.steps.findIndex(step => step.name === "Package hosted review bundle");
  const uploadIndex = report.steps.findIndex(step => step.name === "Upload hosted review bundle");
  const publishIndex = report.steps.findIndex(step => step.name === "Publish current PR hosted links");
  assert.ok(packageIndex > 0 && uploadIndex > packageIndex && publishIndex > uploadIndex);
  assert.match(report.steps[packageIndex].run, /ci:report --input/);
  const upload = report.steps[uploadIndex];
  assert.equal(upload.with.name, "explore-review-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.platform }}");
  assert.equal(upload.with.path, "${{ runner.temp }}/explore-report");
  assert.equal(upload.with.archive, undefined);
  assert.equal(upload.with["retention-days"], 30);
  assert.equal(report.steps[publishIndex].env.ARTIFACT_URL, "${{ steps.viewer.outputs.artifact-url }}");
  assert.match(report.steps[publishIndex].run, /ci:publish/);
  assert.doesNotMatch(source, /EXPLORE_VIEWER_ORIGIN/);
  assert.doesNotMatch(source, /build:report|expo-explore\.html|archive: false|EXPLORE_DATA_|CONVEX|git push|orphan/);
});

test("capture transfer uses explicit secret-free output paths and short retention", () => {
  const steps = workflow.jobs.capture.steps;
  const restore = steps.find(step => step.name === "Download optional exact-base evidence");
  assert.equal(restore["continue-on-error"], true);
  const transfer = steps.find(step => step.name === "Upload captured review for packaging");
  assert.equal(transfer.with["retention-days"], 7);
  assert.match(transfer.with.path, /report-input\.json/);
  assert.match(transfer.with.path, /base-export/);
  assert.match(transfer.with.path, /head-export/);
  assert.doesNotMatch(transfer.with.path, /session|\/explore-review\s*$/);
  const diagnostics = steps.find(step => step.name === "Upload planning and failure diagnostics");
  assert.equal(diagnostics.if, "always()");
  assert.match(diagnostics.with.path, /explore-diagnostics/);
  assert.equal(diagnostics.with["retention-days"], 7);
  assert.equal(diagnostics.with["if-no-files-found"], "ignore");
});

test("report job persists its own diagnostics even when packaging or publication fails", () => {
  const step = workflow.jobs.report.steps.find(step => step.name === "Upload report failure diagnostics");
  assert.equal(step.if, "always()");
  assert.equal(step.with.path, "${{ runner.temp }}/explore-diagnostics");
  assert.equal(step.with["retention-days"], 7);
  assert.equal(step.with.name, "explore-report-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.platform }}");
});

test("failure reporting downloads only this run attempt's failed-job diagnostics", () => {
  const job = workflow.jobs.failure;
  assert.equal(job.permissions.actions, "read");
  assert.equal(job.permissions["pull-requests"], "write");
  assert.equal(job.permissions.contents, undefined);
  for (const [side, artifact] of [["capture", "explore-diagnostics"], ["report", "explore-report-diagnostics"]]) {
    const step = job.steps.find(step => step.name === `Download ${side} failure diagnostic`);
    assert.equal(step.if, `needs.${side}.result == 'failure'`);
    assert.equal(step["continue-on-error"], true);
    assert.equal(step.with.name, undefined);
    assert.equal(step.with.pattern, `${artifact}-` + "${{ github.run_id }}-${{ github.run_attempt }}-*");
    assert.equal(step.with.path, "${{ runner.temp }}/explore-failure/" + side);
    assert.equal(step.with["run-id"], undefined, "download-artifact defaults to this run");
    assert.equal(step.with.repository, undefined);
  }
  const resolve = workflow.jobs.capture.steps.findIndex(step => step.id === "pr");
  const install = workflow.jobs.capture.steps.findIndex(step => step.name === "Install Explore");
  assert.ok(resolve >= 0 && resolve < install, "authorized PR identity survives early tool settings failures");
});
