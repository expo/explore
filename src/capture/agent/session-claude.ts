import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_SDK_VERSION, resolveClaudeExecutable } from "./claude-runtime.js";
import type { CiAgentSessionConfig, CiAgentSessionRunRequest, CiAgentSessionRunResult, CiAgentUsageReceipt } from "./session.js";
import { classifySessionError, sessionError, sessionRecord } from "./session-shared.js";
import { CiError } from "../../shared/ci-errors.js";

type SessionQuery = AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "close">;
const diagnosticToolNames = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "Task", "TaskOutput", "TaskStop",
  "TodoWrite", "ToolSearch", "WebSearch", "WebFetch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "tool_search", "tool_search_tool_regex", "tool_search_tool_bm25", "code_execution", "web_search", "web_fetch"]);
export type ClaudeSessionOptions = {
  /** Typed protocol fixture; production always uses the pinned SDK/native pair. */
  queryFactory?: (request: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SessionQuery;
  executable?: () => Promise<string>;
  verifyExecutable?: (executable: string, signal: AbortSignal) => Promise<void>;
  terminateGraceMs?: number;
  /** Time to receive terminal accounting after an API error; no host tools run during this drain. */
  usageDrainMs?: number;
};

const tokenFields = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "thinkingTokens"] as const;
const coreTokenFields = tokenFields.slice(0, 4);
const tokenCount = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const costAmount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Result modelUsage is cumulative and includes compaction; assistant fragments must never be summed. */
export function usageReceipt(config: CiAgentSessionConfig, message?: Extract<SDKMessage, { type: "result" }>, providerFailed = false): CiAgentUsageReceipt {
  const receipt: CiAgentUsageReceipt = { provider: config.provider, model: config.model, source: "claude-sdk",
    accounting: "unknown", scope: "unavailable", terminalResult: !!message, totals: {}, models: [], unavailableReason: "no-terminal-result" };
  if (!message) return receipt;
  receipt.terminalSubtype = message.subtype;
  receipt.unavailableReason = "incomplete-terminal-metadata";
  const turns = tokenCount(message.num_turns);
  if (turns !== undefined) receipt.numTurns = turns;
  const models = sessionRecord(message.modelUsage);
  for (const [model, raw] of Object.entries(models ?? {})) {
    if (!model || model.length > 256 || /[\u0000-\u0020\u007f]/.test(model)) continue;
    const usage = sessionRecord(raw);
    const entry: CiAgentUsageReceipt["models"][number] = { model };
    for (const field of tokenFields) {
      const value = tokenCount(usage?.[field]);
      if (value !== undefined) entry[field] = value;
    }
    const cost = costAmount(usage?.costUSD);
    if (cost !== undefined) entry.estimatedCostUsd = cost;
    if (usage?.costBasis === "list" || usage?.costBasis === "managed" || usage?.costBasis === "unknown") entry.costBasis = usage.costBasis;
    receipt.models.push(entry);
  }
  if (receipt.models.length && receipt.models.length === Object.keys(models ?? {}).length) {
    receipt.scope = "query-pipeline";
    for (const field of tokenFields) {
      if (receipt.models.every(usage => usage[field] !== undefined)) {
        const total = receipt.models.reduce((sum, usage) => sum + usage[field]!, 0);
        if (Number.isSafeInteger(total)) receipt.totals[field] = total;
      }
    }
  } else if (!Object.keys(models ?? {}).length) {
    // Older/zeroed results may expose only main-loop usage. Retain it as partial, not pipeline totals.
    const main = sessionRecord(message.usage);
    if (main) receipt.scope = "main-loop";
    for (const [field, source] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"],
      ["cacheReadInputTokens", "cache_read_input_tokens"], ["cacheCreationInputTokens", "cache_creation_input_tokens"]] as const) {
      const value = tokenCount(main?.[source]);
      if (value !== undefined) receipt.totals[field] = value;
    }
  }
  const cost = costAmount(message.total_cost_usd);
  if (cost !== undefined) receipt.totals.estimatedCostUsd = cost;
  if (Object.keys(receipt.totals).length || receipt.models.some(usage => Object.keys(usage).length > 1)) receipt.accounting = "partial";
  if (receipt.models.length && coreTokenFields.every(field => receipt.totals[field] !== undefined)
    && receipt.models.every(usage => usage.estimatedCostUsd !== undefined) && cost !== undefined && turns !== undefined) {
    receipt.accounting = "complete";
    delete receipt.unavailableReason;
  }
  // The SDK documents zeroed crash/startup results. Report their numbers without asserting no spend.
  if ((providerFailed || message.is_error || message.subtype !== "success")
    && coreTokenFields.every(field => (receipt.totals[field] ?? 0) === 0) && (cost ?? 0) === 0) {
    receipt.accounting = Object.keys(receipt.totals).length ? "partial" : "unknown";
    receipt.unavailableReason = "possibly-zeroed-error-result";
  }
  return receipt;
}

/** Accounting drain must end even if a broken transport stops yielding messages after an API error. */
async function nextMessage(iterator: AsyncIterator<SDKMessage>, signal: AbortSignal): Promise<IteratorResult<SDKMessage>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => iterator.next()).then(result => {
      signal.removeEventListener("abort", abort); resolve(result);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function claudeEnvironment(home: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1", DISABLE_FEEDBACK_COMMAND: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", NO_COLOR: "1" };
}

/** No account or network request: verify that the already-installed native executable starts. */
async function verifyExecutable(executable: string, signal: AbortSignal, owned: OwnedChild[], cwd: string,
  environment: NodeJS.ProcessEnv): Promise<void> {
  await access(executable, constants.X_OK);
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    // Version checks need no credentials and share the session's process ownership and deadline.
    const env = { ...environment };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
    const child = ownChild({ command: executable, args: ["--version"], env, cwd, signal }, owned);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4096) child.kill("SIGKILL");
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", code => code === 0 && /Claude Code/.test(output) && /\d+\.\d+\.\d+/.test(output)
      ? resolve() : reject(new Error("Native Claude version check failed")));
  });
}

type OwnedChild = { child: ChildProcessWithoutNullStreams; closed: Promise<void> };

function ownChild(options: Parameters<NonNullable<Options["spawnClaudeCodeProcess"]>>[0], owned: OwnedChild[]): ChildProcessWithoutNullStreams {
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal,
    stdio: "pipe", detached: process.platform !== "win32" });
  // A custom SDK spawn bypasses its default stderr reader. Drain without retaining diagnostics.
  child.stderr.resume();
  const entry: OwnedChild = { child, closed: Promise.resolve() };
  entry.closed = new Promise(resolve => {
    child.once("close", () => { resolve(); });
    child.once("error", () => { if (!child.pid) { resolve(); } });
  });
  owned.push(entry);
  return child;
}

async function stopOwnedChildren(owned: OwnedChild[], graceMs: number): Promise<void> {
  await Promise.all(owned.map(async entry => {
    const kill = (signal: NodeJS.Signals) => {
      if (!entry.child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-entry.child.pid, signal);
        else entry.child.kill(signal);
      } catch { /* The owned process may already have exited. */ }
    };
    entry.child.stdin.end();
    kill("SIGTERM");
    const escalation = setTimeout(() => kill("SIGKILL"), graceMs);
    let finalTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entry.closed, new Promise<never>((_resolve, reject) => {
        finalTimeout = setTimeout(() => reject(new Error("Owned CLI process did not close")), graceMs + 2000);
      })]);
    } finally {
      // A parent can exit before its descendants. Kill the owned group even after parent close.
      kill("SIGKILL");
      clearTimeout(escalation);
      if (finalTimeout) clearTimeout(finalTimeout);
    }
  }));
}

/** The SDK drives one real Claude Code process and its entire MCP tool loop. */
export async function runClaudeSession(config: CiAgentSessionConfig, request: CiAgentSessionRunRequest,
  environment: NodeJS.ProcessEnv, options: ClaudeSessionOptions = {}): Promise<CiAgentSessionRunResult> {
  const graceMs = options.terminateGraceMs ?? 2000;
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 10_000) throw sessionError(config,
    "AGENT_REQUEST_INVALID", "The Claude runtime termination budget is invalid.", "Use a bounded process termination grace period.");
  const usageDrainMs = options.usageDrainMs ?? 5000;
  if (!Number.isFinite(usageDrainMs) || usageDrainMs < 0 || usageDrainMs > 10_000) throw sessionError(config,
    "AGENT_REQUEST_INVALID", "The Claude accounting drain budget is invalid.", "Use a bounded accounting drain period.");
  const unavailable = () => sessionError(config, "AGENT_RUNTIME_UNAVAILABLE", "The pinned Claude Code runtime is unavailable.",
    `Install Claude Agent SDK ${CLAUDE_SDK_VERSION} with its matching optional native dependency and rerun.`);
  const controller = new AbortController();
  const cancel = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", cancel, { once: true });
  if (request.signal?.aborted) cancel();
  let home: string | undefined;
  let query: SessionQuery | undefined;
  let failed = false;
  let providerFailure: CiError | undefined;
  let terminalResult: Extract<SDKMessage, { type: "result" }> | undefined;
  let usageDrainTimer: ReturnType<typeof setTimeout> | undefined;
  const toolController = new AbortController();
  const owned: OwnedChild[] = [];
  try {
    controller.signal.throwIfAborted();
    home = await mkdtemp(join(tmpdir(), "explore-ci-claude-"));
    await chmod(home, 0o700);
    const cwd = join(home, "empty-workspace");
    await mkdir(cwd, { mode: 0o700 });
    const env = claudeEnvironment(home, environment);
    let executable: string;
    try {
      executable = await (options.executable ?? resolveClaudeExecutable)();
      if (options.verifyExecutable) await options.verifyExecutable(executable, controller.signal);
      else await verifyExecutable(executable, controller.signal, owned, cwd, env);
    } catch { controller.signal.throwIfAborted(); throw unavailable(); }
    controller.signal.throwIfAborted();
    const [{ query: sdkQuery, createSdkMcpServer, tool }, { z }] = await Promise.all([
      import("@anthropic-ai/claude-agent-sdk"), import("zod"),
    ]);
    const allowed = new Set(request.tools.map(item => `mcp__explore_ci__${item.name}`));
    const deniedTool = (blockType: "init" | "server_tool_use", name: string) => {
      const recognizedName = diagnosticToolNames.has(name) || allowed.has(name) || request.tools.some(tool => tool.name === name);
      const failure = sessionError(config, "AGENT_TOOL_DENIED", blockType === "init"
        ? "Claude Code exposed a tool outside the exploration allowlist." : "Claude Code attempted an unauthorized tool.",
      "Check the pinned runtime and tool allowlist.");
      return new CiError({ ...failure, message: failure.message, details: { ...failure.details, blockType,
        ...(recognizedName ? { toolName: name } : { toolNameSha256: createHash("sha256").update(name).digest("hex") }) } });
    };
    const mcp = request.tools.length ? createSdkMcpServer({ name: "explore_ci", version: "1.0.0", alwaysLoad: true,
      tools: request.tools.map(definition => {
        const schema = z.fromJSONSchema(definition.inputSchema);
        if (!(schema instanceof z.ZodObject)) throw sessionError(config, "AGENT_REQUEST_INVALID", "An agent tool schema is invalid.", "Use object schemas for exploration tools.");
        return tool(definition.name, definition.description, schema.shape, async input => {
          controller.signal.throwIfAborted();
          if (providerFailure) throw providerFailure;
          const result = await request.callTool(definition.name, input as Record<string, unknown>, AbortSignal.any([controller.signal, toolController.signal]));
          return { ...(result.isError === undefined ? {} : { isError: result.isError }),
            content: result.content.map(item => item.type === "text" ? item : { type: "image" as const, data: item.data, mimeType: item.mimeType }) };
        }, { alwaysLoad: true });
      }),
    }) : undefined;
    async function* prompt(): AsyncIterable<SDKUserMessage> {
      yield { type: "user", session_id: "", parent_tool_use_id: null, uuid: randomUUID(), message: { role: "user",
        content: [{ type: "text", text: request.prompt }, ...(request.images ?? []).map(image => ({ type: "image" as const,
          source: { type: "base64" as const, media_type: image.mimeType, data: image.data } }))] } };
    }
    const settings: Options = {
      cwd, env, pathToClaudeCodeExecutable: executable,
      abortController: controller, model: config.model, maxTurns: request.maxTurns ?? 1000,
      tools: [], skills: [], agents: {}, plugins: [], strictMcpConfig: true,
      mcpServers: mcp ? { explore_ci: mcp } : {}, allowedTools: [...allowed],
      settingSources: [], persistSession: false, enableFileCheckpointing: false,
      title: "Explore CI", extraArgs: { "safe-mode": null },
      settings: { autoMemoryEnabled: false, disableAllHooks: true, disableClaudeAiConnectors: true },
      permissionMode: "dontAsk", canUseTool: async () => ({ behavior: "deny", message: "Only the supplied Explore tools are permitted." }),
      systemPrompt: { type: "custom", prompt: request.instructions, snapshot: false },
      includePartialMessages: true, stderr: () => undefined,
      spawnClaudeCodeProcess: child => ownChild(child, owned),
    };
    query = (options.queryFactory ?? sdkQuery)({ prompt: prompt(), options: settings });
    const interrupt = () => { void query?.interrupt().catch(() => undefined); };
    controller.signal.addEventListener("abort", interrupt, { once: true });
    try {
      const iterator = query[Symbol.asyncIterator]();
      while (true) {
        const next = await nextMessage(iterator, controller.signal);
        if (next.done) break;
        const message = next.value;
        controller.signal.throwIfAborted();
        if (message.type === "system" && message.subtype === "init") {
          const unexpected = message.tools.find(name => !allowed.has(name));
          if (unexpected) throw deniedTool("init", unexpected);
        }
        if (message.type === "assistant") {
          if (message.error) {
            providerFailure ??= classifySessionError(config, { code: message.error });
            toolController.abort(providerFailure);
            // Keep the first typed provider failure while allowing its final usage result to arrive.
            usageDrainTimer ??= setTimeout(() => controller.abort(providerFailure),
              Math.max(0, Math.min(usageDrainMs, request.deadlineMs - Date.now())));
            continue;
          }
          for (const block of message.message.content) {
            // Unknown ordinary tool names are rejected by the pinned CLI and returned as
            // tool errors so its model loop can correct them. Only declared MCP callbacks
            // can reach the host; the init inventory and permission policy stay restricted.
            if (block.type === "server_tool_use") {
              throw deniedTool(block.type, block.name);
            }
          }
        }
        if (message.type === "result") {
          terminalResult = message;
          if (providerFailure) throw providerFailure;
          if (message.subtype !== "success" || message.is_error) throw classifySessionError(config, { code: message.subtype });
          const totals = usageReceipt(config, message).totals;
          return { inputTokens: totals.inputTokens ?? NaN, outputTokens: totals.outputTokens ?? NaN };
        }
      }
      if (providerFailure) throw providerFailure;
      throw sessionError(config, "AGENT_RUNTIME_STOPPED", "Claude Code stopped without a terminal result.", "Inspect the sanitized runtime diagnostic and rerun.");
    } finally { controller.signal.removeEventListener("abort", interrupt); }
  } catch (error) {
    failed = true;
    throw classifySessionError(config, providerFailure ?? (controller.signal.aborted ? controller.signal.reason : error));
  } finally {
    if (usageDrainTimer) clearTimeout(usageDrainTimer);
    request.signal?.removeEventListener("abort", cancel);
    controller.abort();
    let cleanupFailed = false;
    try { query?.close(); } catch { cleanupFailed = true; }
    try { await stopOwnedChildren(owned, graceMs); } catch { cleanupFailed = true; }
    if (home) try { await rm(home, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    try { await request.onUsage?.(usageReceipt(config, terminalResult, !!providerFailure)); }
    catch { if (!failed) throw sessionError(config, "AGENT_USAGE_WRITE_FAILED",
      "The agent usage receipt could not be retained.", "Check the private diagnostic directory and rerun."); }
    if (cleanupFailed && !failed) throw sessionError(config, "AGENT_RUNTIME_STOPPED",
      "The Claude session could not complete its cleanup.", "Check the runner's process and temporary-directory permissions before rerunning.");
  }
}
