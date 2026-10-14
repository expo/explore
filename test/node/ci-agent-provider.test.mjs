import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const providerModule = await tsImport("../../src/capture/agent/provider.ts", import.meta.url);
const { classifySessionError } = await tsImport("../../src/capture/agent/session-shared.ts", import.meta.url);
const CONFIG = provider => ({ provider, model: "fixture-model" });

test("the shared provider module exposes classification only, with no direct API execution path", () => {
  assert.deepEqual(Object.keys(providerModule), ["classifyCiAgentError"]);
});

for (const [error, expected, retryable] of [
  [{ status: 401 }, "AGENT_API_KEY_INVALID", false],
  [{ status: 403 }, "AGENT_PERMISSION_DENIED", false],
  [{ status: 404 }, "AGENT_MODEL_NOT_FOUND", false],
  [{ status: 429 }, "AGENT_RATE_LIMITED", true],
  [{ status: 503 }, "AGENT_SERVICE_UNAVAILABLE", true],
  [{ name: "APIConnectionTimeoutError" }, "AGENT_SERVICE_UNAVAILABLE", true],
  [{ status: 429, error: { code: "insufficient_quota" } }, "AGENT_QUOTA_EXHAUSTED", false],
  [new SyntaxError("private prompt malformed"), "AGENT_OUTPUT_INVALID", false],
]) {
  test(`structured CLI provider diagnostics classify ${expected} without persisting raw details`, () => {
    for (const provider of ["anthropic", "openai"]) {
      const failure = classifySessionError(CONFIG(provider), Object.assign(error, {
        message: "private prompt or API key", request_id: "private request ID",
      }));
      assert.equal(failure.code, expected);
      assert.equal(failure.retryable, retryable);
      assert.equal(JSON.stringify(failure).includes("private"), false);
      assert.deepEqual(failure.details, { ...CONFIG(provider), ...(error.status ? { providerStatus: error.status } : {}) });
    }
  });
}

test("Anthropic workspace selection uses only the exact structured prerequisite envelope", () => {
  const message = "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.";
  const failure = classifySessionError(CONFIG("anthropic"), { status: 400,
    error: { type: "error", error: { type: "invalid_request_error", message: `${message} private input` } } });
  assert.equal(failure.code, "AGENT_WORKSPACE_REQUIRED");
  assert.match(failure.nextAction, /ANTHROPIC_WORKSPACE_ID/);
  assert.equal(JSON.stringify(failure).includes(message), false);
  assert.equal(JSON.stringify(failure).includes("private input"), false);
  for (const [provider, status, type, text] of [
    ["openai", 400, "invalid_request_error", message],
    ["anthropic", 500, "invalid_request_error", message],
    ["anthropic", 400, "invalid_request_error", "Invalid anthropic-workspace-id header."],
    ["anthropic", 400, "other_error", message],
  ]) {
    assert.notEqual(classifySessionError(CONFIG(provider), { status, error: { type, message: text } }).code, "AGENT_WORKSPACE_REQUIRED");
  }
});

test("Anthropic billing metadata remains distinct from invalid requests", () => {
  assert.equal(classifySessionError(CONFIG("anthropic"), { status: 400,
    error: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } }).code, "AGENT_QUOTA_EXHAUSTED");
  assert.equal(classifySessionError(CONFIG("anthropic"), new Error("secret echoed request")).code, "AGENT_REQUEST_INVALID");
});

test("CLI diagnostics retain only recognized error codes and numeric HTTP statuses", () => {
  assert.equal(classifySessionError(CONFIG("anthropic"), { code: "error_during_execution", message: "private stdout" }).details.providerError,
    "error_during_execution");
  assert.deepEqual(classifySessionError(CONFIG("anthropic"), { code: "private-api-key", status: "private status" }).details, CONFIG("anthropic"));
});
