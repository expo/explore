import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHAT_CONFIG, CODEX_VERSION, MAX_CODEX_MESSAGE_BYTES, record } from "./codex-config.js";
import type { CiAgentSessionConfig, CiAgentSessionRunRequest, CiAgentSessionRunResult } from "./session.js";
import { classifySessionError, sessionError } from "./session-shared.js";

type SpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; stdio: "pipe"; detached: boolean };
export type CodexSessionOptions = {
  subscription?: boolean;
  /** Transport seam for local protocol tests; production always uses the pinned bundled CLI. */
  spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  terminateGraceMs?: number;
};

const require = createRequire(import.meta.url);
const CI_CONFIG = { ...CHAT_CONFIG, forced_login_method: "api", model_provider: "openai" } as const;
const ALLOWED_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "contextCompaction", "dynamicToolCall"]);

function toml(value: unknown): string {
  if (["string", "boolean", "number"].includes(typeof value)) return JSON.stringify(value);
  const object = record(value);
  if (object) return `{${Object.entries(object).map(([key, entry]) => `${key}=${toml(entry)}`).join(",")}}`;
  throw new Error("Unsupported Codex configuration value");
}

function failure(config: CiAgentSessionConfig, code = "AGENT_RUNTIME_UNAVAILABLE") {
  return sessionError(config, code, "The bundled Codex agent runtime could not complete its session.",
    "Check the pinned Codex installation and CI provider configuration, then rerun.");
}

/** Do not propagate arbitrary messages: provider errors can echo prompts or credentials. */
function providerFailure(config: CiAgentSessionConfig, raw: unknown) {
  const error = record(raw);
  const info = error?.codexErrorInfo;
  const codes: Record<string, string> = {
    unauthorized: "AGENT_API_KEY_INVALID", usageLimitExceeded: "AGENT_QUOTA_EXHAUSTED",
    rateLimitExceeded: "AGENT_RATE_LIMITED", contextWindowExceeded: "AGENT_BUDGET_EXCEEDED",
    sessionBudgetExceeded: "AGENT_BUDGET_EXCEEDED", serverOverloaded: "AGENT_SERVICE_UNAVAILABLE",
    internalServerError: "AGENT_SERVICE_UNAVAILABLE", badRequest: "AGENT_REQUEST_INVALID",
  };
  if (typeof info === "string" && codes[info]) return sessionError(config, codes[info]!,
    "The Codex provider could not complete the configured agent request.",
    "Check the configured model, API key, billing credit, and provider availability before rerunning.",
    ["rateLimitExceeded", "serverOverloaded", "internalServerError"].includes(info));
  const infoObject = record(info);
  const status = infoObject && Object.values(infoObject).map(value => record(value)?.httpStatusCode)
    .find(value => typeof value === "number");
  if (status !== undefined) return classifySessionError(config, { status });
  if (infoObject && ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]
    .some(key => Object.hasOwn(infoObject, key))) return classifySessionError(config, { code: "httpConnectionFailed" });
  return classifySessionError(config, raw);
}

type RpcMessage = Record<string, unknown>;

/** One disposable JSONL connection. The CLI owns its model/tool loop until turn/completed. */
class SessionTransport {
  private sequence = 0;
  private buffer = "";
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private failed: unknown;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly stopped: Promise<never>;
  private rejectStopped!: (error: unknown) => void;
  onMessage: (message: RpcMessage) => void = () => undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly config: CiAgentSessionConfig,
    private readonly kill: (signal: NodeJS.Signals) => void, private readonly graceMs: number,
    private readonly onFailure: (error: unknown) => void) {
    this.stopped = new Promise((_resolve, reject) => { this.rejectStopped = reject; });
    void this.stopped.catch(() => undefined);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => this.fail(failure(config)));
    child.on("error", () => this.fail(failure(config)));
    this.exited = new Promise(resolve => child.once("close", () => {
      this.closed = true;
      this.fail(failure(config));
      resolve();
    }));
  }

  fail(error: unknown): void {
    if (this.failed !== undefined) return;
    this.failed = error;
    this.onFailure(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.rejectStopped(error);
  }

  private consume(chunk: string): void {
    if (this.failed !== undefined) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_CODEX_MESSAGE_BYTES) { this.fail(failure(this.config, "AGENT_OUTPUT_INVALID")); return; }
      try {
        const message = record(JSON.parse(line));
        if (!message) throw failure(this.config, "AGENT_OUTPUT_INVALID");
        if (typeof message.method === "string") this.onMessage(message);
        else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          if (message.error) pending.reject(providerFailure(this.config, message.error));
          else pending.resolve(message.result);
        } else throw failure(this.config, "AGENT_OUTPUT_INVALID");
      } catch (error) { this.fail(error instanceof SyntaxError ? failure(this.config, "AGENT_OUTPUT_INVALID") : error); return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_CODEX_MESSAGE_BYTES) this.fail(failure(this.config, "AGENT_OUTPUT_INVALID"));
  }

  write(message: RpcMessage): void {
    if (this.failed !== undefined) throw this.failed;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async untilStopped<T>(operation: Promise<T>): Promise<T> {
    if (this.failed !== undefined) throw this.failed;
    const result = await Promise.race([operation, this.stopped]);
    if (this.failed !== undefined) throw this.failed;
    return result;
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.fail(failure(this.config));
      if (this.closed) { this.kill("SIGKILL"); return; }
      this.child.stdin.end();
      this.kill("SIGTERM");
      const timer = setTimeout(() => this.kill("SIGKILL"), this.graceMs);
      let finalTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
          finalTimeout = setTimeout(() => reject(failure(this.config, "AGENT_RUNTIME_CLEANUP_FAILED")), this.graceMs + 2_000);
        })]);
      } finally {
        // Parent close does not prove its descendants exited. Always terminate the owned group.
        this.kill("SIGKILL");
        clearTimeout(timer);
        if (finalTimeout) clearTimeout(finalTimeout);
      }
    })();
  }
}

/**
 * A user's CODEX_HOME carries their MCP servers and plugins, which `-c` overrides merge into
 * rather than replace, so the subscription CLI runs in a private home holding only the login.
 */
async function isolateSubscriptionLogin(environment: NodeJS.ProcessEnv, runtimeHome: string) {
  const userAuth = join(environment.CODEX_HOME ?? join(environment.HOME!, ".codex"), "auth.json");
  const runtimeAuth = join(runtimeHome, "auth.json");
  const original = await readFile(userAuth, "utf8").catch(() => undefined);
  if (original !== undefined) await copyFile(userAuth, runtimeAuth);
  // Codex rotates the refresh token as it uses it; keep the user's login current unless it changed meanwhile.
  return async () => {
    if (original === undefined) return;
    const refreshed = await readFile(runtimeAuth, "utf8").catch(() => undefined);
    if (refreshed === undefined || refreshed === original) return;
    if (await readFile(userAuth, "utf8").catch(() => undefined) !== original) return;
    const staged = `${userAuth}.explore-${process.pid}`;
    await copyFile(runtimeAuth, staged);
    await chmod(staged, 0o600);
    await rename(staged, userAuth);
  };
}

function validateConfig(config: CiAgentSessionConfig, response: unknown, subscription = false): void {
  const actual = record(record(response)?.config);
  const matches = (expected: unknown, value: unknown): boolean => {
    const object = record(expected);
    if (!object) return expected === value;
    const target = record(value);
    return !!target && (Object.keys(object).length === 0 ? Object.keys(target).length === 0
      : Object.entries(object).every(([key, entry]) => matches(entry, target[key])));
  };
  // 0.159.2's typed Config.tools projects only web_search; the two disabled tools
  // remain explicit strict startup overrides but cannot be echoed by config/read.
  const { tools: _startupOnlyTools, ...readableConfig } = subscription ? { ...CI_CONFIG, forced_login_method: "chatgpt" } : CI_CONFIG;
  if (!actual || !matches(readableConfig, actual)) throw failure(config, "AGENT_RUNTIME_UNSAFE");
}

export async function runCodexSession(config: CiAgentSessionConfig, request: CiAgentSessionRunRequest,
  environment: NodeJS.ProcessEnv, options: CodexSessionOptions = {}): Promise<CiAgentSessionRunResult> {
  const graceMs = options.terminateGraceMs ?? 2_000;
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 10_000) throw failure(config, "AGENT_REQUEST_INVALID");
  request.signal?.throwIfAborted();
  if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= Date.now()) throw failure(config, "AGENT_BUDGET_EXCEEDED");
  const root = await mkdtemp(join(tmpdir(), "explore-ci-codex-"));
  let transport: SessionTransport | undefined;
  let onAbort: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let usage: CiAgentSessionRunResult = { inputTokens: 0, outputTokens: 0 };
  let terminal = false;
  let cachedInputTokens: number | undefined;
  let reportedUsage = false;
  let sessionFailure: unknown;
  let restoreLogin: (() => Promise<void>) | undefined;
  try {
    const runtimeHome = join(root, "codex");
    const cwd = join(root, "workspace");
    await Promise.all([mkdir(runtimeHome, { mode: 0o700 }), mkdir(cwd, { mode: 0o700 })]);
    const entrypoint = require.resolve("@openai/codex/bin/codex.js");
    const manifest = record(JSON.parse(await readFile(join(dirname(entrypoint), "..", "package.json"), "utf8")));
    if (manifest?.version !== CODEX_VERSION) throw failure(config, "AGENT_RUNTIME_VERSION");
    if (options.subscription) restoreLogin = await isolateSubscriptionLogin(environment, runtimeHome);
    const env: NodeJS.ProcessEnv = { CODEX_HOME: runtimeHome, NO_COLOR: "1" };
    for (const key of [...(options.subscription ? ["HOME"] : []), "PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
      if (environment[key] !== undefined) env[key] = environment[key];
    }
    // The key travels only over private stdio login, never arguments, inherited auth, or model input.
    const child = (options.spawn ?? spawn)(options.subscription ? "codex" : process.execPath, [...(options.subscription ? [] : ["--input-type=module", "-e",
      "process.umask(0o077); await import(process.argv[1]);", pathToFileURL(entrypoint).href]),
      "app-server", "--listen", "stdio://", "--strict-config",
      ...Object.entries(options.subscription ? { ...CI_CONFIG, forced_login_method: "chatgpt" } : CI_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])],
    { cwd, env, stdio: "pipe", detached: process.platform !== "win32" });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process group may already have exited. */ }
    };
    const controller = new AbortController();
    const toolSignal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const rpc = transport = new SessionTransport(child, config, kill, graceMs, error => controller.abort(error));
    onAbort = () => {
      rpc.fail(request.signal?.reason ?? failure(config, "AGENT_CANCELLED"));
      void rpc.close();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => {
      rpc.fail(failure(config, "AGENT_BUDGET_EXCEEDED"));
      void rpc.close();
    }, Math.min(2_147_483_647, Math.max(1, request.deadlineMs - Date.now())));
    if (request.signal?.aborted) onAbort();
    if (Date.now() >= request.deadlineMs) rpc.fail(failure(config, "AGENT_BUDGET_EXCEEDED"));

    let threadId: string | undefined;
    let turnId: string | undefined;
    let runningCalls = 0;
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const calls = new Map<string, { signature: string; response: Promise<unknown> }>();
    const acceptTurn = (value: unknown) => {
      if (typeof value !== "string" || !value || turnId !== undefined && value !== turnId) throw failure(config, "AGENT_OUTPUT_INVALID");
      turnId = value;
    };
    rpc.onMessage = message => {
      const params = record(message.params);
      if (message.id !== undefined) {
        if (terminal || (typeof message.id !== "number" && typeof message.id !== "string") || message.method !== "item/tool/call"
          || !params || !threadId || params.threadId !== threadId || params.namespace != null
          || typeof params.callId !== "string" || !params.callId || typeof params.tool !== "string"
          || !request.tools.some(tool => tool.name === params.tool) || !record(params.arguments)) {
          throw failure(config, "AGENT_TOOL_DENIED");
        }
        acceptTurn(params.turnId);
        const signature = JSON.stringify([params.tool, params.arguments]);
        let call = calls.get(params.callId);
        if (call && call.signature !== signature) throw failure(config, "AGENT_OUTPUT_INVALID");
        if (!call) {
          if (calls.size >= 2_000) throw failure(config, "AGENT_BUDGET_EXCEEDED");
          runningCalls++;
          const response = Promise.resolve().then(() => {
            toolSignal.throwIfAborted();
            return request.callTool(params.tool as string, params.arguments as Record<string, unknown>, toolSignal);
          })
            .then(result => ({ success: !result.isError, contentItems: result.content.map(item => item.type === "text"
              ? { type: "inputText", text: item.text } : { type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` }) }))
            .finally(() => { runningCalls--; });
          call = { signature, response };
          calls.set(params.callId, call);
        }
        void call.response.then(result => rpc.write({ id: message.id, result }), error => rpc.fail(error)).catch(error => rpc.fail(error));
        return;
      }
      if (!params || !threadId || params.threadId !== threadId) return;
      if (message.method === "thread/tokenUsage/updated") {
        acceptTurn(params.turnId);
        const total = record(record(params.tokenUsage)?.total);
        if (!total || ![total.inputTokens, total.outputTokens].every(value => Number.isSafeInteger(value) && Number(value) >= 0)) throw failure(config, "AGENT_OUTPUT_INVALID");
        usage = { inputTokens: Number(total.inputTokens), outputTokens: Number(total.outputTokens) };
        reportedUsage = true;
        if (total.cachedInputTokens !== undefined) {
          if (!Number.isSafeInteger(total.cachedInputTokens) || Number(total.cachedInputTokens) < 0
            || Number(total.cachedInputTokens) > usage.inputTokens) throw failure(config, "AGENT_OUTPUT_INVALID");
          cachedInputTokens = Number(total.cachedInputTokens);
        }
      } else if (message.method === "item/started") {
        if (terminal) throw failure(config, "AGENT_TOOL_DENIED");
        acceptTurn(params.turnId);
        const item = record(params.item);
        if (!item || typeof item.type !== "string" || !ALLOWED_ITEMS.has(item.type)) throw failure(config, "AGENT_TOOL_DENIED");
      } else if (message.method === "turn/completed") {
        const turn = record(params.turn);
        acceptTurn(turn?.id);
        if (turn?.status !== "completed") throw providerFailure(config, turn?.error);
        if (runningCalls) throw failure(config, "AGENT_OUTPUT_INVALID");
        terminal = true;
        finish();
      } else if (message.method === "error" && params.willRetry !== true) throw providerFailure(config, params.error);
    };
    await rpc.request("initialize", { clientInfo: { name: "expo_explore_ci", title: "Explore CI", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    rpc.write({ method: "initialized", params: {} });
    validateConfig(config, await rpc.request("config/read", { includeLayers: false }), options.subscription);
    if (!options.subscription) {
      const login = record(await rpc.request("account/login/start", { type: "apiKey", apiKey: environment.OPENAI_API_KEY }));
      if (login?.type !== "apiKey") throw failure(config, "AGENT_RUNTIME_UNSAFE");
    }
    const account = record(await rpc.request("account/read", { refreshToken: false }));
    if (record(account?.account)?.type !== (options.subscription ? "chatgpt" : "apiKey")) throw failure(config, "AGENT_RUNTIME_UNSAFE");
    const started = record(await rpc.request("thread/start", {
      model: config.model, modelProvider: "openai", allowProviderModelFallback: false,
      ephemeral: true, cwd, environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
      sandbox: "read-only", approvalPolicy: "never", baseInstructions: request.instructions,
      developerInstructions: "Use only the supplied Explore tools. Native host tools and external context are unavailable. In Code Mode, dynamic tools return text strings. To view a returned image, extract its data:image URL and call image(url).",
      dynamicTools: request.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    }));
    const thread = record(started?.thread);
    if (typeof thread?.id !== "string" || !thread.id) throw failure(config, "AGENT_OUTPUT_INVALID");
    threadId = thread.id;
    // Codex has one top-level turn and no native maxTurns equivalent. The shared deadline
    // and tool-call cap bound the CLI-owned loop; usage notifications are not turn counters.
    const startedTurn = record(await rpc.request("turn/start", { threadId, model: config.model, environments: [],
      input: [{ type: "text", text: request.prompt, text_elements: [] },
        ...(request.images ?? []).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))],
    }));
    acceptTurn(record(startedTurn?.turn)?.id);
    await rpc.untilStopped(completed);
    await rpc.untilStopped(Promise.all([...calls.values()].map(call => call.response)));
    return usage;
  } catch (error) {
    sessionFailure = error;
    throw error;
  } finally {
    try { await request.onUsage?.({ provider: config.provider, model: config.model, source: "codex-cli",
      accounting: reportedUsage ? "partial" : "unknown", scope: reportedUsage ? "main-loop" : "unavailable", terminalResult: terminal,
      totals: reportedUsage ? { ...usage, ...(cachedInputTokens !== undefined ? { cacheReadInputTokens: cachedInputTokens } : {}) } : {}, models: [] }); } catch (error) {
      if (!sessionFailure) throw error;
    } finally {
      if (deadline) clearTimeout(deadline);
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
      try { await transport?.close(); await restoreLogin?.(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}
