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
