import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { summarizeFlowReport, flowId, flowSlug } = await tsImport("../../src/capture/flows/report.ts", import.meta.url);
const report = JSON.parse(readFileSync(new URL("../fixtures/flows/e2e-report.json", import.meta.url), "utf8"));

test("summarizes the selected tests of an e2e report with their steps and screenshot frames", () => {
  const tests = summarizeFlowReport(report);
  assert.equal(tests.length, 1, "unselected files stay out");
  const [flow] = tests;
  assert.equal(flow.id, "send/send-money-reaches-contacts");
  assert.equal(flow.status, "passed");
  assert.equal(flow.file, "tests/send.e2e.ts");
  assert.deepEqual(flow.steps.map(step => [step.api, step.label, step.status, step.frame]), [
    ["app.screenshot", "home", "passed", "home"],
    ["locator.tap", 'getByTestId("home-send")', "passed", undefined],
    ["expect.toBeVisible", 'getByRole("heading", name: "Your contacts")', "passed", undefined],
    ["app.screenshot", "contacts", "passed", "contacts"],
  ]);
  assert.deepEqual(flow.frames.map(frame => [frame.key, frame.path, frame.stepIndex]), [
    ["home", "send-money-reaches-contacts-09af3c698e01af96/attempt-1/screenshots/001.png", 0],
    ["contacts", "send-money-reaches-contacts-09af3c698e01af96/attempt-1/screenshots/002.png", 3],
  ]);
  assert.ok(Number.isFinite(Date.parse(flow.frames[0].capturedAt)));
});

test("flow ids and frame keys are stable path segments", () => {
  assert.equal(flowId("tests/checkout/Pay now.e2e.ts", ["Checkout", "pays with the test card"]), "checkout-pay-now/checkout-pays-with-the-test-card");
  assert.equal(flowId("e2e/onboarding.e2e.ts", ["signs up"]), "onboarding/signs-up");
  assert.equal(flowSlug("  Review — step 2!  "), "review-step-2");
  assert.equal(flowSlug("***"), "flow");
});

test("a failed flow keeps the frames it took and names the failing step", () => {
  const failed = structuredClone(report);
  const result = failed.run.results.find(entry => entry.selected);
  result.status = "failed";
  const attempt = result.attempts[0];
  attempt.status = "failed";
  attempt.error = { code: "LOCATOR_NOT_FOUND", message: "no element matches getByText(\"Alex Rivera\")" };
  attempt.steps = [...attempt.steps.slice(0, 2), { ...attempt.steps[1], index: 2, api: "locator.tap", label: 'getByText("Alex Rivera")', status: "failed", artifacts: [],
    error: { code: "LOCATOR_NOT_FOUND", message: "no element matches" } }];
  const [flow] = summarizeFlowReport(failed);
  assert.equal(flow.status, "failed");
  assert.equal(flow.error.code, "LOCATOR_NOT_FOUND");
  assert.deepEqual(flow.frames.map(frame => frame.key), ["home"]);
  assert.equal(flow.steps[2].status, "failed");
  assert.equal(flow.steps[2].error.code, "LOCATOR_NOT_FOUND");
});

test("repeated screenshot labels get distinct frame keys", () => {
  const twice = structuredClone(report);
  const attempt = twice.run.results.find(entry => entry.selected).attempts[0];
  attempt.steps[3] = { ...attempt.steps[3], label: "home" };
  const [flow] = summarizeFlowReport(twice);
  assert.deepEqual(flow.frames.map(frame => frame.key), ["home", "home-2"]);
});

test("steps and tests carry the e2e source line of the test file", async () => {
  const summaries = summarizeFlowReport(JSON.parse(readFileSync(new URL("../fixtures/flows/e2e-report.json", import.meta.url), "utf8")));
  const send = summaries.find(summary => summary.file === "tests/send.e2e.ts");
  assert.equal(send.steps[0].line, 3);
  assert.equal(send.steps[1].line, 4);
  assert.ok(send.line === undefined || send.line > 0);
});

test("per-step frames fill the steps that took no frame of their own, keyed by step number", () => {
  const selected = report.run.results.find(result => result.selected !== false);
  const stepFrames = new Map([[selected.testId, [
    { stepIndex: 1, path: "explore-step-frames/a-1.png", capturedAt: "2026-01-01T00:00:01.000Z" },
    { stepIndex: 0, path: "explore-step-frames/a-0.png", capturedAt: "2026-01-01T00:00:00.000Z" },
    { stepIndex: 2, path: "explore-step-frames/a-2.png", capturedAt: "2026-01-01T00:00:02.000Z" },
    { stepIndex: 9, path: "explore-step-frames/a-9.png", capturedAt: "2026-01-01T00:00:09.000Z" },
  ]]]);
  const [flow] = summarizeFlowReport(report, stepFrames);
  assert.deepEqual(flow.steps.map(step => step.frame), ["home", "step-2", "step-3", "contacts"], "a screenshot step keeps its own frame; a step past the end is ignored");
  assert.deepEqual(flow.frames.map(frame => [frame.key, frame.stepIndex, frame.path]), [
    ["home", 0, flow.frames[0].path],
    ["step-2", 1, "explore-step-frames/a-1.png"],
    ["step-3", 2, "explore-step-frames/a-2.png"],
    ["contacts", 3, flow.frames[3].path],
  ], "frames come out in step order");
  assert.equal(flow.frames[1].label, '2. getByTestId("home-send")');
  assert.deepEqual(summarizeFlowReport(report, new Map([["other-test", [{ stepIndex: 1, path: "x.png", capturedAt: "" }]]]))[0].frames.length, 2, "frames of another test are not attached");
});
