import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CiAgentSession, CiAgentSessionConfig, CiAgentSessionOptions, CiAgentSessionRunRequest, CiAgentSessionRunResult } from "./session.js";
import { classifySessionError, runBoundedSession, sessionError } from "./session-shared.js";
import { usageReceipt } from "./session-claude.js";
import { runCodexSession } from "./session-codex.js";

/** Login remains in the user's CLI credential store; app/EAS/API secrets never enter it. */
export function localAgentEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  // macOS Claude Code finds its claude.ai login in the Keychain under $USER; without it the CLI reports logged out.
  for (const key of ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (input[key] !== undefined) env[key] = input[key];
  }
  // npm scripts prepend project CLI shims, which may be API-test-only or uninstalled.
  // Local mode intentionally resolves the user's independently installed CLIs.
  if (env.PATH) env.PATH = env.PATH.split(delimiter).filter(path =>
    !/(?:^|[\\/])node_modules[\\/]\.bin[\\/]?$/.test(path)
      && !/(?:^|[\\/])node-gyp-bin[\\/]?$/.test(path)).join(delimiter);
  return env;
}

const MAX_UNKNOWN_EXPLORE_TOOLS = 3;

async function runLocalClaude(config: CiAgentSessionConfig, request: CiAgentSessionRunRequest, env: NodeJS.ProcessEnv): Promise<CiAgentSessionRunResult> {
  const root = await mkdtemp(join(tmpdir(), "explore-local-claude-"));
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/" || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    try {
      req.setEncoding("utf8");
      let body = "";
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Tool request too large"); }
      request.signal?.throwIfAborted();
      if (failure) throw failure;
      const value = JSON.parse(body);
      const result = value.method === "tools/list" ? { tools: request.tools }
        : value.method === "tools/call" ? await request.callTool(value.params?.name, value.params?.arguments ?? {}, request.signal!)
          : undefined;
      if (!result) throw new Error("Unknown tool operation");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch { res.writeHead(500).end(); }
  });
  let terminal: Parameters<typeof usageReceipt>[1];
  let stopped = false;
  let failure: unknown;
  let kill: ((signal: NodeJS.Signals) => void) | undefined;
  let abort: (() => void) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let accountingDrain: ReturnType<typeof setTimeout> | undefined;
  const toleratedUnknownTools: string[] = [];
  const registeredCallsAfterUnknownTools: number[] = [];
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local tool host did not start");
    const bridge = fileURLToPath(new URL("./mcp-bridge-worker.js", import.meta.url));
    const mcp = join(root, "mcp.json");
    await writeFile(mcp, JSON.stringify({ mcpServers: { explore: { command: process.execPath, args: [bridge],
      env: { EXPLORE_CI_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/`, EXPLORE_CI_MCP_TOKEN: token } } } }), { mode: 0o600 });
    const args = ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--model", config.model, "--max-turns", String(request.maxTurns ?? 1000), "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", mcp,
      "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true }),
      "--disable-slash-commands", "--no-session-persistence", "--system-prompt", request.instructions];
    if (request.tools.length) args.push("--allowedTools", request.tools.map(t => `mcp__explore__${t.name}`).join(","));
    const child = spawn("claude", args, { cwd: root, env, stdio: "pipe", detached: process.platform !== "win32" });
    kill = signal => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
    abort = () => { failure ??= request.signal?.reason; kill?.("SIGTERM"); killTimer ??= setTimeout(() => kill?.("SIGKILL"), 2000); };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => {
      buffer += chunk;
      try {
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new Error("CLI response too large");
          const value = JSON.parse(line);
          if (value.type === "result") {
            terminal = value;
            if (accountingDrain) clearTimeout(accountingDrain);
          }
          if (value.type === "assistant" && value.error) {
            const diagnostic = classifySessionError(config, { code: value.error });
            const code = diagnostic.code === "AGENT_API_KEY_INVALID" ? "AGENT_SUBSCRIPTION_LOGIN_REQUIRED" : diagnostic.code;
            failure ??= sessionError(config, code, "The local Claude subscription CLI reported a provider failure.",
              "Check Claude subscription login, quota, model access, and connectivity before rerunning; no API fallback was attempted.", diagnostic.retryable);
            // Retain a following terminal usage receipt, but stop accepting host actions.
            accountingDrain ??= setTimeout(() => abort?.(), 1500);
          }
          if (value.type === "assistant") for (const item of value.message?.content ?? []) {
            if (item.type !== "tool_use") continue;
            if (request.tools.some(t => item.name === `mcp__explore__${t.name}`)) {
              for (let index = 0; index < registeredCallsAfterUnknownTools.length; index++) registeredCallsAfterUnknownTools[index]! += 1;
            } else {
              // The Explore server cannot execute an unlisted name in its namespace; the CLI returns a tool error.
              if (typeof item.name === "string" && item.name.startsWith("mcp__explore__") && toleratedUnknownTools.length < MAX_UNKNOWN_EXPLORE_TOOLS) {
                toleratedUnknownTools.push(item.name); registeredCallsAfterUnknownTools.push(0); continue;
              }
              const denied = sessionError(config, "AGENT_TOOL_DENIED", "The local CLI attempted an unregistered tool.", "Use only Explore's supplied tools.");
              denied.details!.tool = String(item.name);
              throw denied;
            }
          }
        }
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) throw new Error("CLI response too large");
      } catch (error) { failure = error; abort?.(); }
    });
    const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", code => { stopped = true; resolve(code); }); });
    child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: request.prompt },
      ...(request.images ?? []).map(i => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }))] } })}\n`);
    const code = await exited;
    if (failure) throw failure;
    if (code !== 0 || !terminal || terminal.is_error || terminal.subtype !== "success") throw sessionError(config,
      "AGENT_LOCAL_CLI_FAILED", `Local Claude did not complete successfully (${terminal?.subtype ?? `exit ${code}`}).`,
      "Check Claude subscription quota, CLI login, and the configured model; no API fallback was attempted.");
    const totals = usageReceipt(config, terminal).totals;
    return { inputTokens: totals.inputTokens ?? 0, outputTokens: totals.outputTokens ?? 0 };
  } catch (error) {
    failure ??= error;
    throw error;
  } finally {
    if (abort) request.signal?.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    if (accountingDrain) clearTimeout(accountingDrain);
    kill?.("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const receipt = usageReceipt(config, terminal, !stopped || !!failure);
    receipt.source = "claude-cli";
    if (toleratedUnknownTools.length) {
      receipt.toleratedUnknownTools = toleratedUnknownTools;
      receipt.registeredCallsAfterUnknownTools = registeredCallsAfterUnknownTools;
    }
    try { await request.onUsage?.(receipt); } catch (error) { if (!failure) throw error; } finally { await rm(root, { recursive: true, force: true }); }
  }
}

/** `claude auth status` methods backed by a claude.ai subscription: an interactive login or a `claude setup-token` token. API keys are not. */
const SUBSCRIPTION_AUTH_METHODS = new Set(["claude.ai", "oauth_token"]);

export function createLocalCiAgentSession(config: CiAgentSessionConfig, options: CiAgentSessionOptions = {}): CiAgentSession {
  const env = localAgentEnvironment(options.env ?? process.env);
  const run = (request: CiAgentSessionRunRequest) => runBoundedSession(config, { ...request,
    onUsage: async receipt => { await options.onUsage?.(receipt); await request.onUsage?.(receipt); },
  }, bounded => config.provider === "anthropic" ? runLocalClaude(config, bounded, env)
    : runCodexSession(config, bounded, env, { subscription: true }).catch(error => {
      if (error?.code === "AGENT_RUNTIME_UNSAFE") throw sessionError(config, "AGENT_LOCAL_CONFIG_UNSAFE",
        "Codex requires a ChatGPT login and a configuration without external tools.",
        "Set CODEX_HOME to a clean local directory, run codex login with that same CODEX_HOME, and pass it to local CI. No API fallback was attempted.");
      throw error;
    }));
  return { ...config, run, async preflight(request = {}) {
    if (config.provider === "anthropic") {
      // A cold `claude` start takes several seconds; not answering at all is a different failure from not being logged in.
      const result = spawnSync("claude", ["auth", "status", "--json"], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
      if (result.error || result.signal) throw sessionError(config, "AGENT_SUBSCRIPTION_LOGIN_REQUIRED",
        `claude auth status did not answer (${result.signal ? `exited on ${result.signal}` : (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timed out after 30 s" : result.error?.message}).`,
        "Check that the claude CLI is installed and runs from this shell, then rerun.");
      let auth: { loggedIn?: boolean; authMethod?: string } = {};
      try { auth = JSON.parse(result.stdout); } catch { /* Fail closed. */ }
      if (result.status !== 0 || !auth.loggedIn || !SUBSCRIPTION_AUTH_METHODS.has(auth.authMethod ?? "")) throw sessionError(config,
        "AGENT_SUBSCRIPTION_LOGIN_REQUIRED", "Claude subscription login is required.",
        "Run claude auth login, or set CLAUDE_CODE_OAUTH_TOKEN from claude setup-token, then rerun local CI.");
    }
    await run({ instructions: "Reply OK. Do not use tools.", prompt: "Reply OK.", tools: [], callTool: async () => { throw new Error("Unexpected tool"); },
      deadlineMs: Math.min(request.deadlineMs ?? Infinity, Date.now() + (request.timeoutMs ?? 30_000)),
      ...(request.signal ? { signal: request.signal } : {}), maxTurns: 1 });
  } };
}
