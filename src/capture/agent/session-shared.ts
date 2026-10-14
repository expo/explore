import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { CiError } from "../../shared/ci-errors.js";
import { classifyCiAgentError } from "./provider.js";
import type { CiAgentSessionConfig, CiAgentSessionRunRequest, CiAgentSessionRunResult, CiAgentToolResult } from "./session.js";

export function sessionError(config: CiAgentSessionConfig, code: string, message: string, nextAction: string, retryable = false): CiError {
  return new CiError({ code, stage: "agent", message, nextAction, retryable,
    details: { provider: config.provider, model: config.model } });
}

export function sessionRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function classifyKnownSessionError(config: CiAgentSessionConfig, error: unknown): CiError {
  if (error instanceof CiError) return error;
  const data = sessionRecord(error);
  const code = typeof data?.code === "string" ? data.code : typeof data?.error === "string" ? data.error : "";
  if (code === "authentication_failed") return sessionError(config, "AGENT_API_KEY_INVALID",
    "The agent CLI rejected its API credential.", "Replace the selected provider API key and rerun.");
  if (["oauth_org_not_allowed", "permission_denied", "verification_required"].includes(code)) return sessionError(config,
    "AGENT_PERMISSION_DENIED", "The agent credential cannot access this model or operation.", "Check the provider account and configured model access.");
  if (["billing_error", "insufficient_quota", "quota_exceeded", "account_on_hold"].includes(code)) return sessionError(config,
    "AGENT_QUOTA_EXHAUSTED", "The agent provider account has insufficient quota or billing credit.", "Restore the provider account's quota or billing credit and rerun.");
  if (code === "model_not_found") return sessionError(config, "AGENT_MODEL_NOT_FOUND",
    "The configured model is unavailable to the agent CLI.", "Select a model supported by the pinned CLI and available to the API account.");
  if (code === "rate_limit") return sessionError(config, "AGENT_RATE_LIMITED",
    "The agent provider's rate limit was reached.", "Wait for the rate limit to clear and rerun.", true);
  if (["error_max_turns", "error_max_budget_usd", "max_output_tokens"].includes(code)) return sessionError(config,
    "AGENT_BUDGET_EXCEEDED", "The agent CLI reached its execution budget.", "Inspect the agent trace or increase the configured capture budget.");
  if (code === "error_max_structured_output_retries") return sessionError(config, "AGENT_OUTPUT_INVALID",
    "The agent CLI could not produce the required structured output.", "Inspect the validation diagnostic and rerun with a compatible model.");
  if (["overloaded", "server_error", "httpConnectionFailed", "responseStreamDisconnected"].includes(code)) return sessionError(config,
    "AGENT_SERVICE_UNAVAILABLE", "The agent CLI could not reach its model service.", "Check provider availability and runner connectivity, then rerun.", true);
  return classifyCiAgentError(error, config);
}

/** Keep useful typed CLI diagnostics, never free-form errors or provider messages. */
export function classifySessionError(config: CiAgentSessionConfig, error: unknown): CiError {
  if (error instanceof CiError) return error;
  const failure = classifyKnownSessionError(config, error);
  const data = sessionRecord(error);
  const code = data?.code;
  const knownCodes = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required",
    "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "unknown",
    "max_output_tokens", "cloud_credential_error", "error_during_execution", "error_max_turns", "error_max_budget_usd",
    "error_max_structured_output_retries", "httpConnectionFailed", "responseStreamDisconnected"]);
  const providerError = typeof code === "string" && knownCodes.has(code) ? code : undefined;
  const providerStatus = typeof data?.status === "number" && Number.isInteger(data.status) && data.status >= 400 && data.status <= 599
    ? data.status : undefined;
  return new CiError({ code: failure.code, stage: failure.stage, message: failure.message, nextAction: failure.nextAction,
    retryable: failure.retryable, details: { ...failure.details,
      ...(providerError ? { providerError } : {}), ...(providerStatus ? { providerStatus } : {}) } });
}

/** Only the selected model credential enters the CLI. App inputs and EAS/GitHub credentials remain in the host. */
export function validateSessionEnvironment(config: CiAgentSessionConfig, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!["openai", "anthropic"].includes(config.provider) || typeof config.model !== "string" || !config.model.trim()
    || config.model.length > 256 || /[\u0000-\u0020\u007f]/.test(config.model)) {
    throw sessionError(config, "AGENT_REQUEST_INVALID", "The agent runtime configuration is invalid.", "Select a provider and explicit model in the Explore configuration.");
  }
  const name = config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const key = inherited[name]?.trim();
  if (!key) throw sessionError(config, "AGENT_API_KEY_MISSING", `${name} is required for agent mode.`, `Add ${name} to GitHub Secrets and pass it to the capture job.`);
  const environment: NodeJS.ProcessEnv = { [name]: key, NO_COLOR: "1" };
  for (const variable of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    if (inherited[variable] !== undefined) environment[variable] = inherited[variable];
  }
  if (config.provider === "anthropic") {
    const workspace = inherited.ANTHROPIC_WORKSPACE_ID?.trim();
    if (workspace && !/^wrkspc_[A-Za-z0-9]{1,120}$/.test(workspace)) throw sessionError(config, "AGENT_REQUEST_INVALID",
      "ANTHROPIC_WORKSPACE_ID must be a valid workspace identifier.", "Use the workspace's wrkspc_... identifier or a workspace-scoped API key.");
    if (workspace) environment.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${workspace}`;
  }
  return environment;
}

function validToolResult(result: CiAgentToolResult): boolean {
  return Array.isArray(result?.content) && result.content.length <= 32 && result.content.every(block =>
    block.type === "text" ? typeof block.text === "string" && block.text.length <= 1_000_000
      : block.type === "image" && ["image/png", "image/jpeg", "image/webp"].includes(block.mimeType)
        && typeof block.data === "string" && block.data.length <= 28_000_000);
}

/** Serialize tool callbacks and keep one deadline through native CLI startup, model work, and tool execution. */
export async function runBoundedSession(config: CiAgentSessionConfig, request: CiAgentSessionRunRequest,
  execute: (request: CiAgentSessionRunRequest) => Promise<CiAgentSessionRunResult>): Promise<CiAgentSessionRunResult> {
  const invalid = () => sessionError(config, "AGENT_REQUEST_INVALID", "The agent session request is invalid.", "Check its instructions, tools, and remaining time budget.");
  if (!Number.isFinite(request.deadlineMs) || typeof request.instructions !== "string" || !request.instructions.trim()
    || typeof request.prompt !== "string" || !Array.isArray(request.tools) || request.tools.length > 128
    || request.onUsage !== undefined && typeof request.onUsage !== "function"
    || request.maxTurns !== undefined && (!Number.isSafeInteger(request.maxTurns) || request.maxTurns < 1)) throw invalid();
  const validators = new Map<string, ValidateFunction>();
  try {
    const ajv = new Ajv2020({ strict: false, allErrors: false });
    for (const tool of request.tools) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || validators.has(tool.name) || tool.inputSchema.type !== "object") throw invalid();
      validators.set(tool.name, ajv.compile(tool.inputSchema));
    }
  } catch { throw invalid(); }
  const controller = new AbortController();
  const cancelled = () => sessionError(config, "AGENT_CANCELLED", "The agent session was cancelled.", "Rerun the review if cancellation was unintended.");
  const expired = () => sessionError(config, "AGENT_BUDGET_EXCEEDED", "The agent session exceeded its remaining time budget.", "Inspect the agent trace or increase the capture budget.");
  const cancel = () => controller.abort(cancelled());
  if (request.signal?.aborted) throw cancelled();
  if (request.deadlineMs <= Date.now()) throw expired();
  request.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(expired()), Math.min(2_147_483_647, Math.max(1, request.deadlineMs - Date.now())));
  let tail: Promise<unknown> = Promise.resolve();
  let fatal: unknown;
  let calls = 0;
  const callTool: CiAgentSessionRunRequest["callTool"] = (name, input, toolSignal) => {
    const signal = toolSignal ? AbortSignal.any([controller.signal, toolSignal]) : controller.signal;
    const call = tail.then(async () => {
      signal.throwIfAborted();
      if (Date.now() >= request.deadlineMs) { controller.abort(expired()); controller.signal.throwIfAborted(); }
      const validator = validators.get(name);
      if (!validator || !sessionRecord(input) || !validator(input)) return { isError: true,
        content: [{ type: "text" as const, text: "Tool input does not match the declared schema. Use an available tool with its required fields and no extra fields." }] };
      if (++calls > 4000) throw sessionError(config, "AGENT_BUDGET_EXCEEDED", "The agent session reached its tool-call limit.", "Simplify the exploration instructions or split the selected routes.");
      const result = await request.callTool(name, input, signal);
      signal.throwIfAborted();
      if (!validToolResult(result)) throw sessionError(config, "AGENT_OUTPUT_INVALID", "An exploration tool returned an invalid result.", "Check the exploration tool adapter and rerun.");
      return result;
    }).catch(error => { fatal ??= error; controller.abort(error); throw error; });
    tail = call.catch(() => undefined);
    return call;
  };
  try {
    const result = await execute({ ...request, signal: controller.signal, callTool });
    await tail;
    if (fatal) throw fatal;
    controller.signal.throwIfAborted();
    if (Date.now() >= request.deadlineMs) throw expired();
    if (![result.inputTokens, result.outputTokens].every(value => Number.isFinite(value) && value >= 0)) throw sessionError(config,
      "AGENT_OUTPUT_INVALID", "The agent CLI returned invalid usage metadata.", "Check the pinned agent runtime and rerun.");
    return result;
  } catch (error) {
    throw classifySessionError(config, fatal ?? (controller.signal.aborted ? controller.signal.reason : error));
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
    controller.abort(cancelled());
    // Host callbacks own controller requests and evidence writes; join their abort cleanup.
    await tail;
  }
}
