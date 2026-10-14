import type { CiAgentContentBlock, CiAgentProviderName, CiAgentRequestOptions, CiAgentText, CiAgentTool } from "./provider.js";
import { runClaudeSession, type ClaudeSessionOptions } from "./session-claude.js";
import { runCodexSession, type CodexSessionOptions } from "./session-codex.js";
import { runBoundedSession, sessionError, validateSessionEnvironment } from "./session-shared.js";

export type CiAgentImage = Extract<CiAgentContentBlock, { type: "image" }>;
export type CiAgentToolResult = { content: Array<CiAgentText | CiAgentImage>; isError?: boolean };
export type CiAgentSessionConfig = { provider: CiAgentProviderName; model: string };
export type CiAgentUsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** A subset of outputTokens, never an additional token charge. */
  thinkingTokens?: number;
  /** The CLI's estimate for its query pipeline, not an invoiced amount. */
  estimatedCostUsd?: number;
};
export type CiAgentUsageReceipt = {
  provider: CiAgentProviderName;
  model: string;
  source: "claude-sdk" | "claude-cli" | "codex-cli";
  /** Complete refers to reported query-pipeline accounting, not all provider billing. */
  accounting: "complete" | "partial" | "unknown";
  scope: "query-pipeline" | "main-loop" | "unavailable";
  terminalResult: boolean;
  terminalSubtype?: string;
  unavailableReason?: "no-terminal-result" | "incomplete-terminal-metadata" | "possibly-zeroed-error-result";
  numTurns?: number;
  totals: CiAgentUsageTotals;
  models: Array<CiAgentUsageTotals & { model: string; costBasis?: "list" | "managed" | "unknown" }>;
  /** Local CLI only: unlisted Explore tool names passed back to the CLI as tool errors, in call order. */
  toleratedUnknownTools?: string[];
  /** Registered tool calls the CLI made after each tolerated name, by index; a count above zero shows recovery. */
  registeredCallsAfterUnknownTools?: number[];
};
export type CiAgentSessionRunRequest = {
  instructions: string;
  prompt: string;
  images?: CiAgentImage[];
  tools: CiAgentTool[];
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<CiAgentToolResult>;
  /** Absolute epoch milliseconds shared with the enclosing capture or notes phase. */
  deadlineMs: number;
  signal?: AbortSignal;
  maxTurns?: number;
  /** Emitted once per CLI query, including failure. Missing accounting is explicitly unknown. */
  onUsage?(receipt: CiAgentUsageReceipt): void | Promise<void>;
};
export type CiAgentSessionRunResult = { inputTokens: number; outputTokens: number };
export interface CiAgentSession {
  readonly provider: CiAgentProviderName;
  readonly model: string;
  preflight(options?: CiAgentRequestOptions): Promise<void>;
  run(request: CiAgentSessionRunRequest): Promise<CiAgentSessionRunResult>;
}
export type CiAgentSessionOptions = {
  env?: NodeJS.ProcessEnv;
  /** Includes the preflight query as well as capture and notes queries. */
  onUsage?(receipt: CiAgentUsageReceipt): void | Promise<void>;
  claude?: ClaudeSessionOptions;
  codex?: CodexSessionOptions;
};

/** Each run gives the CLI ownership of its complete tool loop; no raw model API fallback exists. */
export function createCiAgentSession(config: CiAgentSessionConfig, options: CiAgentSessionOptions = {}): CiAgentSession {
  const environment = validateSessionEnvironment(config, options.env ?? process.env);
  const run = (request: CiAgentSessionRunRequest) => runBoundedSession(config, { ...request,
    ...(options.onUsage || request.onUsage ? { onUsage: async (receipt: CiAgentUsageReceipt) => {
      await options.onUsage?.(receipt);
      await request.onUsage?.(receipt);
    } } : {}),
  }, bounded =>
    config.provider === "anthropic"
      ? runClaudeSession(config, bounded, environment, options.claude)
      : runCodexSession(config, bounded, environment, options.codex));
  return {
    provider: config.provider,
    model: config.model,
    run,
    async preflight(request = {}) {
      const timeoutMs = request.timeoutMs ?? 30_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw sessionError(config, "AGENT_REQUEST_INVALID",
        "The agent preflight time budget is invalid.", "Use a positive finite preflight timeout.");
      await run({ instructions: "This is an authentication and model-access check. Reply with OK. Do not use tools.",
        prompt: "Reply with OK.", tools: [],
        callTool: async () => { throw sessionError(config, "AGENT_TOOL_DENIED", "The preflight attempted to execute a tool.", "Check the pinned agent runtime and rerun."); },
        deadlineMs: Math.min(Date.now() + timeoutMs, request.deadlineMs ?? Infinity),
        ...(request.signal ? { signal: request.signal } : {}), maxTurns: 1 });
    },
  };
}
