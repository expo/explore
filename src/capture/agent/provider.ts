import { CiError } from "../../shared/ci-errors.js";

/** Provider-neutral contracts shared by CLI sessions and exploration tools. */
export type CiAgentProviderName = "openai" | "anthropic";
export type CiAgentText = { type: "text"; text: string };
export type CiAgentContentBlock = CiAgentText
  | { type: "image"; mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string };
export type CiAgentTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type CiAgentRequestOptions = {
  signal?: AbortSignal;
  /** Total time for this CLI operation. */
  timeoutMs?: number;
  /** Absolute epoch milliseconds, normally the coordinator's remaining phase budget. */
  deadlineMs?: number;
};
type ProviderConfig = { provider: CiAgentProviderName; model: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function failure(config: ProviderConfig, code: string, message: string, nextAction: string, retryable = false): CiError {
  return new CiError({ code, stage: "agent", message, nextAction, retryable, details: { provider: config.provider, model: config.model } });
}

function invalidOutput(config: ProviderConfig, reason: string): CiError {
  return failure(config, "AGENT_OUTPUT_INVALID", `The agent provider returned invalid output: ${reason}.`,
    "Inspect the agent validation diagnostic and rerun with a model that supports the configured tools and image inputs.");
}

/** Uses structured status/type information; raw provider messages may contain private input. */
export function classifyCiAgentError(error: unknown, config: ProviderConfig): CiError {
  if (error instanceof CiError) return error;
  if (error instanceof SyntaxError) return invalidOutput(config, "the provider response is not valid JSON");
  const input = object(error);
  const body = object(input?.error);
  const nested = object(body?.error);
  const codes = [input?.code, body?.code, body?.type, nested?.code, nested?.type]
    .filter((value): value is string => typeof value === "string");
  const status = typeof input?.status === "number" ? input.status : undefined;
  const secretName = config.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (status === 401) return failure(config, "AGENT_API_KEY_INVALID", "The agent provider rejected its API credential.", `Replace ${secretName} with a valid provider key and rerun.`);
  if (status === 403) return failure(config, "AGENT_PERMISSION_DENIED", "The agent credential cannot access the requested model or operation.", "Grant access to the configured model or select a model available to this provider account.");
  if (status === 402 || codes.some(code => /^(insufficient_quota|quota_exceeded|billing_hard_limit_reached|credit_balance_too_low|insufficient_credits|billing_error)$/.test(code))) {
    return failure(config, "AGENT_QUOTA_EXHAUSTED", "The agent provider account has insufficient quota or billing credit.", "Restore the provider account's quota or billing credit and rerun.");
  }
  // Anthropic reports some account prerequisites as a generic 400 invalid_request_error.
  const message = nested?.message ?? body?.message;
  if (config.provider === "anthropic" && status === 400 && codes.includes("invalid_request_error")
    && typeof message === "string" && /not scoped to a workspace/i.test(message) && /anthropic-workspace-id/i.test(message)) {
    return failure(config, "AGENT_WORKSPACE_REQUIRED", "The Anthropic API key requires an explicit workspace.",
      "Use an API key scoped to one Anthropic workspace, or set ANTHROPIC_WORKSPACE_ID to send the anthropic-workspace-id header.");
  }
  if (config.provider === "anthropic" && status === 400 && typeof message === "string" && /credit balance is too low/i.test(message)) {
    return failure(config, "AGENT_QUOTA_EXHAUSTED", "The agent provider account has insufficient billing credit.", "Restore the provider account's billing credit and rerun.");
  }
  if (status === 404 || codes.includes("model_not_found")) return failure(config, "AGENT_MODEL_NOT_FOUND", "The configured agent model was not found or is unavailable to this account.", "Correct agent.model in the Explore configuration or select an available model.");
  if (status === 429) return failure(config, "AGENT_RATE_LIMITED", "The agent provider's temporary rate limit was reached.", "Wait for the provider's retry period and rerun after the rate limit clears.", true);
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)
    || (status === undefined && /^(APIConnectionError|APIConnectionTimeoutError|FetchError)$/.test(String(input?.name)))) {
    return failure(config, "AGENT_SERVICE_UNAVAILABLE", "The agent provider request failed because its service or network is temporarily unavailable.", "Check provider availability and runner connectivity, then rerun.", true);
  }
  return failure(config, "AGENT_REQUEST_INVALID", "The agent provider rejected the configured request.", "Check the selected model's image and tool support and the agent request configuration before rerunning.");
}
