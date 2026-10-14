import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { createCiAgentSession } = await tsImport("../../src/capture/agent/session.ts", import.meta.url);
const { runBoundedSession, validateSessionEnvironment, sessionError } = await tsImport("../../src/capture/agent/session-shared.ts", import.meta.url);
const { serializeCiError } = await tsImport("../../src/shared/ci-errors.ts", import.meta.url);
const CONFIG = { provider: "anthropic", model: "claude-fixture-model" };
const TOOL = { name: "observe", description: "Inspect the app.", inputSchema: {
  type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false,
} };
const IMAGE = { type: "image", mimeType: "image/png", data: "ZmFrZS1pbWFnZQ==" };
const request = overrides => ({ instructions: "Explore the app.", prompt: "Inspect the target.", tools: [TOOL],
  callTool: async () => ({ content: [{ type: "text", text: "Observed." }] }), deadlineMs: Date.now() + 2000, ...overrides });
const success = { type: "result", subtype: "success", is_error: false,
  modelUsage: { fixture: { inputTokens: 17, outputTokens: 9 } }, usage: { input_tokens: 17, output_tokens: 9 } };

function fixture(sequence, overrides = {}) {
  const state = { closed: 0, interrupted: 0, inputs: [] };
  const session = createCiAgentSession(CONFIG, {
    onUsage: overrides.onUsage,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "private-api-key", ANTHROPIC_WORKSPACE_ID: "wrkspc_example",
      ANTHROPIC_BASE_URL: "https://untrusted.invalid", ANTHROPIC_CUSTOM_HEADERS: "Authorization: private-override",
      OPENAI_API_KEY: "other-key", APP_PASSWORD: "app-secret", GITHUB_TOKEN: "github-secret", NODE_OPTIONS: "bad" },
    claude: { executable: async () => "/fixture/claude", verifyExecutable: async () => {},
      queryFactory: ({ prompt, options }) => {
        state.options = options;
        return { close() { state.closed++; }, async interrupt() { state.interrupted++; },
          async *[Symbol.asyncIterator]() {
            for await (const input of prompt) state.inputs.push(input);
            yield* sequence(options, state);
          } };
      }, ...overrides.claude },
  });
  return { state, session };
}

test("Claude CLI session preserves isolated API-key auth, MCP images, and one model-owned tool loop", async () => {
  let calls = 0;
  const { state, session } = fixture(async function* (options) {
    yield { type: "system", subtype: "init", tools: ["mcp__explore_ci__observe"] };
    // Exercise the pinned SDK's actual MCP request handler, not a replacement tool implementation.
    const handler = options.mcpServers.explore_ci.instance.server._requestHandlers.get("tools/call");
    const result = await handler({ method: "tools/call", params: { name: "observe", arguments: { target: "Account" } } },
      { signal: options.abortController.signal, requestId: "fixture-call" });
    assert.deepEqual(result.content, [{ type: "text", text: "Account" }, IMAGE]);
    yield success;
  });
  const usage = await session.run(request({ images: [IMAGE], callTool: async (name, input, signal) => {
    calls++; assert.equal(name, "observe"); assert.equal(input.target, "Account"); assert.equal(signal.aborted, false);
    return { content: [{ type: "text", text: "Account" }, IMAGE] };
  } }));
  assert.deepEqual(usage, { inputTokens: 17, outputTokens: 9 });
  assert.equal(calls, 1); assert.equal(state.closed, 1);
  assert.equal(state.options.env.ANTHROPIC_API_KEY, "private-api-key");
  assert.equal(state.options.env.ANTHROPIC_CUSTOM_HEADERS, "anthropic-workspace-id: wrkspc_example");
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "APP_PASSWORD", "GITHUB_TOKEN", "NODE_OPTIONS", "HOME"]) assert.equal(state.options.env[key], undefined);
  assert.deepEqual(state.options.tools, []); assert.deepEqual(state.options.settingSources, []);
  assert.equal(state.options.strictMcpConfig, true); assert.equal(state.options.persistSession, false);
  assert.equal(state.options.model, CONFIG.model);
  assert.equal(JSON.stringify(state.inputs).includes("private-api-key"), false);
  assert.equal(state.inputs[0].message.content[1].source.data, IMAGE.data);
  await assert.rejects(access(state.options.env.CLAUDE_CONFIG_DIR), { code: "ENOENT" });
});

const accountedResult = overrides => ({ ...success, total_cost_usd: 0.12, num_turns: 3,
  modelUsage: {
    "claude-fixture-model": { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 1200,
      cacheCreationInputTokens: 300, thinkingTokens: 15, costUSD: 0.10, costBasis: "list" },
    "claude-compaction-model": { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: 0.02, costBasis: "managed" },
  }, ...overrides });

test("Claude receipts retain cumulative query-pipeline costs and cached tokens without adding assistant fragments or thinking twice", async () => {
  const receipts = [];
  const { session } = fixture(async function* () {
    const fragment = { type: "assistant", message: { id: "same-api-response", content: [],
      usage: { input_tokens: 9000, output_tokens: 6000 } } };
    yield fragment; yield fragment;
    yield { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 6000 } } };
    yield accountedResult();
  });
  assert.deepEqual(await session.run(request({ onUsage: value => { receipts.push(value); } })), { inputTokens: 140, outputTokens: 50 });
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].totals, { inputTokens: 140, outputTokens: 50, cacheReadInputTokens: 1200,
    cacheCreationInputTokens: 300, thinkingTokens: 15, estimatedCostUsd: 0.12 });
  assert.equal(receipts[0].accounting, "complete");
  assert.equal(receipts[0].scope, "query-pipeline");
  assert.equal(receipts[0].numTurns, 3);
  assert.equal(receipts[0].models[1].costBasis, "managed");
  assert.equal(JSON.stringify(receipts).includes("same-api-response"), false);
});

test("billing errors retain later terminal accounting while preventing every subsequent host mutation", async () => {
  const receipts = [];
  let hostCalls = 0;
  const { state, session } = fixture(async function* (options) {
    yield { type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "private provider response" }] } };
    const handler = options.mcpServers.explore_ci.instance.server._requestHandlers.get("tools/call");
    const result = await handler({ method: "tools/call", params: { name: "observe", arguments: { target: "Account" } } },
      { signal: options.abortController.signal, requestId: "after-billing-error" });
    assert.equal(result.isError, true);
    yield accountedResult({ subtype: "error_during_execution", is_error: true, errors: ["private raw failure"] });
  });
  await assert.rejects(session.run(request({ onUsage: value => { receipts.push(value); }, callTool: async () => {
    hostCalls++; return { content: [{ type: "text", text: "Unsafe action." }] };
  } })), error => error.code === "AGENT_QUOTA_EXHAUSTED" && error.details.providerError === "billing_error");
  assert.equal(hostCalls, 0);
  assert.equal(state.closed, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].terminalSubtype, "error_during_execution");
  assert.equal(receipts[0].totals.estimatedCostUsd, 0.12);
  assert.equal(JSON.stringify(receipts).includes("private"), false);
});

test("the global usage hook includes preflight and each run, while per-run hooks receive only their own receipt", async () => {
  const global = []; const local = [];
  const { session } = fixture(async function* () { yield accountedResult(); }, { onUsage: value => { global.push(value); } });
  await session.preflight();
  await session.run(request({ onUsage: async value => { await Promise.resolve(); local.push(value); } }));
  assert.equal(global.length, 2);
  assert.equal(local.length, 1);
  assert.equal(local[0], global[1]);
});

test("a stalled error stream has bounded accounting drain and reports missing usage as unknown", async () => {
  const receipts = [];
  const { state, session } = fixture(async function* () {
    yield { type: "assistant", error: "billing_error", message: { content: [] } };
    await new Promise(() => {});
  }, { claude: { usageDrainMs: 20 } });
  const started = Date.now();
  await assert.rejects(session.run(request({ onUsage: value => { receipts.push(value); } })), { code: "AGENT_QUOTA_EXHAUSTED" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(state.closed, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].accounting, "unknown");
  assert.equal(receipts[0].terminalResult, false);
  assert.deepEqual(receipts[0].totals, {});
  assert.equal(receipts[0].unavailableReason, "no-terminal-result");
});

test("terminal execution failures retain usage, and zeroed failure results do not establish zero spend", async () => {
  for (const zeroed of [false, true]) {
    const receipts = [];
    const terminal = accountedResult({ subtype: "error_max_turns", is_error: true,
      ...(zeroed ? { total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 } } : {}) });
    const { session } = fixture(async function* () { yield terminal; });
    await assert.rejects(session.run(request({ onUsage: value => { receipts.push(value); } })), { code: "AGENT_BUDGET_EXCEEDED" });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].accounting, zeroed ? "partial" : "complete");
    assert.equal(receipts[0].totals.estimatedCostUsd, zeroed ? 0 : 0.12);
    if (zeroed) assert.equal(receipts[0].unavailableReason, "possibly-zeroed-error-result");
  }
});

test("missing cost metadata is partial, invalid values are absent, and an EOF has no fabricated token counts", async () => {
  const receipts = [];
  const partial = fixture(async function* () {
    yield { ...success, total_cost_usd: NaN, num_turns: -1,
      modelUsage: { fixture: { inputTokens: 17, outputTokens: 9, cacheReadInputTokens: -1, costUSD: Infinity } } };
  });
  await partial.session.run(request({ onUsage: value => { receipts.push(value); } }));
  assert.equal(receipts[0].accounting, "partial");
  assert.deepEqual(receipts[0].totals, { inputTokens: 17, outputTokens: 9 });
  assert.equal(receipts[0].numTurns, undefined);
  const eof = fixture(async function* () {});
  await assert.rejects(eof.session.run(request({ onUsage: value => { receipts.push(value); } })), { code: "AGENT_RUNTIME_STOPPED" });
  assert.equal(receipts[1].accounting, "unknown");
  assert.deepEqual(receipts[1].totals, {});
});

test("usage persistence failure is explicit on success but cannot replace a billing failure", async () => {
  for (const error of [undefined, "billing_error"]) {
    const { state, session } = fixture(async function* () {
      if (error) yield { type: "assistant", error, message: { content: [] } };
      yield accountedResult();
    });
    await assert.rejects(session.run(request({ onUsage: async () => { throw new Error("private storage details"); } })), failure => {
      assert.equal(failure.code, error ? "AGENT_QUOTA_EXHAUSTED" : "AGENT_USAGE_WRITE_FAILED");
      assert.equal(JSON.stringify(failure).includes("private storage"), false);
      return true;
    });
    assert.equal(state.closed, 1);
  }
});

test("CLI preflight is one tool-free model turn through the same session adapter", async () => {
  const { state, session } = fixture(async function* (options) {
    assert.deepEqual(options.mcpServers, {}); assert.deepEqual(options.allowedTools, []);
    assert.equal(options.maxTurns, 1); yield success;
  });
  await session.preflight({ timeoutMs: 1000 });
  assert.equal(state.inputs.length, 1); assert.equal(state.inputs[0].message.content[0].text, "Reply with OK.");
});

test("session validates provider credentials and derives only a validated Anthropic workspace header", () => {
  assert.throws(() => createCiAgentSession(CONFIG, { env: {} }), { code: "AGENT_API_KEY_MISSING" });
  assert.throws(() => createCiAgentSession(CONFIG, { env: { ANTHROPIC_API_KEY: "key", ANTHROPIC_WORKSPACE_ID: "wrkspc_id\nAuthorization: bad" } }), { code: "AGENT_REQUEST_INVALID" });
  const env = validateSessionEnvironment({ provider: "openai", model: "fixture" }, {
    OPENAI_API_KEY: "key", ANTHROPIC_WORKSPACE_ID: "not-valid", ANTHROPIC_API_KEY: "not-selected",
  });
  assert.deepEqual(env, { OPENAI_API_KEY: "key", NO_COLOR: "1" });
});

test("host serializes CLI tool requests, rejects invalid arguments, and permits corrected calls", async () => {
  const order = [];
  let active = 0;
  const result = await runBoundedSession(CONFIG, request({ callTool: async (_name, input) => {
    assert.equal(active++, 0); order.push(input.target);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return { content: [{ type: "text", text: input.target }] };
  } }), async bounded => {
    assert.equal((await bounded.callTool("observe", { wrong: "value" }, bounded.signal)).isError, true);
    await Promise.all([bounded.callTool("observe", { target: "one" }, bounded.signal), bounded.callTool("observe", { target: "two" }, bounded.signal)]);
    return { inputTokens: 1, outputTokens: 2 };
  });
  assert.deepEqual(order, ["one", "two"]); assert.deepEqual(result, { inputTokens: 1, outputTokens: 2 });
});

test("fatal host tool failures survive a CLI that swallows the callback rejection", async () => {
  const failure = sessionError(CONFIG, "AGENT_NOTES_EVIDENCE_INVALID", "Evidence changed.", "Recapture.");
  await assert.rejects(runBoundedSession(CONFIG, request({ callTool: async () => { throw failure; } }), async bounded => {
    await bounded.callTool("observe", { target: "one" }, bounded.signal).catch(() => {});
    return { inputTokens: 1, outputTokens: 1 };
  }), error => error === failure);
});

for (const [error, expected] of [["authentication_failed", "AGENT_API_KEY_INVALID"], ["rate_limit", "AGENT_RATE_LIMITED"], ["model_not_found", "AGENT_MODEL_NOT_FOUND"]]) {
  test(`Claude typed ${error} becomes a safe CI error and closes its session`, async () => {
    const { state, session } = fixture(async function* () {
      yield { type: "assistant", error, message: { content: [{ type: "text", text: "private-api-key private prompt" }] } };
    });
    await assert.rejects(session.run(request()), failure => {
      assert.equal(failure.code, expected); assert.equal(JSON.stringify(serializeCiError(failure)).includes("private"), false); return true;
    });
    assert.equal(state.closed, 1);
  });
}

test("Claude EOF and unexpected native tools are failures, not successful exploration", async () => {
  const ended = fixture(async function* () {});
  await assert.rejects(ended.session.run(request()), { code: "AGENT_RUNTIME_STOPPED" });
  const extra = fixture(async function* () { yield { type: "system", subtype: "init", tools: ["Bash"] }; });
  await assert.rejects(extra.session.run(request()), { code: "AGENT_TOOL_DENIED" });
});

test("Claude denied-tool diagnostics identify known names and hash untrusted names without inputs", async () => {
  for (const [type, name] of [["server_tool_use", "observe"], ["server_tool_use", "web_search"], ["server_tool_use", "private-sensitive-name"]]) {
    const { session } = fixture(async function* () {
      yield { type: "assistant", message: { content: [{ type, name, input: { text: "private input value" } }] } };
    });
    await assert.rejects(session.run(request()), error => {
      assert.equal(error.code, "AGENT_TOOL_DENIED");
      assert.equal(error.details.blockType, type);
      if (name === "private-sensitive-name") { assert.equal(error.details.toolName, undefined); assert.match(error.details.toolNameSha256, /^[a-f0-9]{64}$/); }
      else assert.equal(error.details.toolName, name);
      assert.equal(JSON.stringify(error).includes("private"), false);
      return true;
    });
  }
});

test("ordinary unknown tool attempts remain CLI-correctable without invoking a host tool", async () => {
  const calls = [];
  const { session } = fixture(async function* (options) {
    yield { type: "system", subtype: "init", tools: ["mcp__explore_ci__observe"] };
    yield { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__explore_ci__open", input: { url: "fixture://" } }] } };
    const handler = options.mcpServers.explore_ci.instance.server._requestHandlers.get("tools/call");
    await handler({ method: "tools/call", params: { name: "observe", arguments: { target: "Account" } } },
      { signal: options.abortController.signal, requestId: "corrected-call" });
    yield success;
  });
  await session.run(request({ callTool: async name => { calls.push(name); return { content: [{ type: "text", text: "Observed." }] }; } }));
  assert.deepEqual(calls, ["observe"]);
});

test("deadline abort reaches the CLI and closes the private session", async () => {
  const { state, session } = fixture(async function* (options) {
    if (!options.abortController.signal.aborted) await new Promise(resolve => options.abortController.signal.addEventListener("abort", resolve, { once: true }));
    options.abortController.signal.throwIfAborted();
  });
  await assert.rejects(session.run(request({ deadlineMs: Date.now() + 80 })), { code: "AGENT_BUDGET_EXCEEDED" });
  assert.equal(state.closed, 1);
  await assert.rejects(access(state.options.env.CLAUDE_CONFIG_DIR), { code: "ENOENT" });
});

test("missing pinned Claude executable is a safe preflight failure", async () => {
  const session = createCiAgentSession(CONFIG, { env: { ANTHROPIC_API_KEY: "private-api-key" },
    claude: { executable: async () => { throw new Error("private path and key"); } } });
  await assert.rejects(session.preflight(), error => error.code === "AGENT_RUNTIME_UNAVAILABLE"
    && !JSON.stringify(serializeCiError(error)).includes("private path"));
});

test("adapter cancellation reaches an active host callback before session teardown", async () => {
  const local = new AbortController();
  let observed;
  await assert.rejects(runBoundedSession(CONFIG, request({ callTool: async (_name, _input, signal) => {
    observed = signal;
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    signal.throwIfAborted();
  } }), async bounded => {
    const active = bounded.callTool("observe", { target: "one" }, local.signal);
    await new Promise(resolve => setImmediate(resolve));
    local.abort(sessionError(CONFIG, "AGENT_OUTPUT_INVALID", "Transport failed.", "Rerun."));
    assert.equal(observed.aborted, true);
    await active;
    return { inputTokens: 0, outputTokens: 0 };
  }), { code: "AGENT_OUTPUT_INVALID" });
});

test("session failure joins aborted host tool cleanup before returning", async () => {
  let cleaned = false;
  await assert.rejects(runBoundedSession(CONFIG, request({ callTool: async (_name, _input, signal) => {
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 15));
    cleaned = true;
    signal.throwIfAborted();
  } }), async bounded => {
    void bounded.callTool("observe", { target: "one" }, bounded.signal).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    throw sessionError(CONFIG, "AGENT_RUNTIME_STOPPED", "CLI stopped.", "Rerun.");
  }), { code: "AGENT_RUNTIME_STOPPED" });
  assert.equal(cleaned, true);
});

test("Claude drains custom-process stderr and waits for forced process cleanup", async () => {
  let child;
  let home;
  const session = createCiAgentSession(CONFIG, { env: { ANTHROPIC_API_KEY: "private-api-key" },
    claude: { executable: async () => "/fixture/claude", verifyExecutable: async () => {}, terminateGraceMs: 20,
      queryFactory: ({ options }) => {
        home = options.env.CLAUDE_CONFIG_DIR;
        return { close() {}, async interrupt() {}, async *[Symbol.asyncIterator]() {
          child = options.spawnClaudeCodeProcess({ command: process.execPath,
            args: ["-e", "process.on('SIGTERM',()=>{});process.stderr.write('x'.repeat(400000),()=>process.stdout.write('ready'));setInterval(()=>{},1000);"],
            cwd: options.cwd, env: options.env, signal: options.abortController.signal });
          child.on("error", () => {});
          await new Promise(resolve => child.stdout.once("data", resolve));
          yield success;
        } };
      } } });
  assert.deepEqual(await session.run(request()), { inputTokens: 17, outputTokens: 9 });
  assert.equal(child.signalCode, "SIGKILL");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  await assert.rejects(access(home), { code: "ENOENT" });
});

test("Claude cleanup failures are sanitized and cannot replace an earlier typed failure", async () => {
  for (const error of [undefined, "authentication_failed"]) {
    const session = createCiAgentSession(CONFIG, { env: { ANTHROPIC_API_KEY: "private-api-key" },
      claude: { executable: async () => "/fixture/claude", verifyExecutable: async () => {}, queryFactory: () => ({
        close() { throw new Error("private-api-key raw close failure"); }, async interrupt() {},
        async *[Symbol.asyncIterator]() { yield error ? { type: "assistant", error, message: { content: [] } } : success; },
      }) } });
    await assert.rejects(session.run(request()), failure => {
      assert.equal(failure.code, error ? "AGENT_API_KEY_INVALID" : "AGENT_RUNTIME_STOPPED");
      assert.equal(JSON.stringify(failure).includes("private-api-key"), false);
      return true;
    });
  }
});

test("Claude cleanup kills same-group descendants after their parent exits", { skip: process.platform === "win32" }, async () => {
  let descendant;
  const script = "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000);";
  const session = createCiAgentSession(CONFIG, { env: { ANTHROPIC_API_KEY: "private-api-key" },
    claude: { executable: async () => "/fixture/claude", verifyExecutable: async () => {}, terminateGraceMs: 20,
      queryFactory: ({ options }) => ({ close() {}, async interrupt() {}, async *[Symbol.asyncIterator]() {
        const child = options.spawnClaudeCodeProcess({ command: process.execPath,
          args: ["-e", `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(script)}],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',d=>process.stdout.write(d));setInterval(()=>{},1000);`],
          cwd: options.cwd, env: options.env, signal: options.abortController.signal });
        child.on("error", () => {});
        descendant = Number(await new Promise(resolve => child.stdout.once("data", data => resolve(String(data)))));
        yield success;
      } }) } });
  try {
    await session.run(request());
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(descendant, 0); } catch (error) { if (error.code === "ESRCH") { stopped = true; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(stopped, true);
  } finally { if (descendant) try { process.kill(descendant, "SIGKILL"); } catch {} }
});

test("native Claude version checks share cancellation and forced cleanup without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "explore-cli-version-fixture-"));
  const executable = join(root, "claude-fixture");
  const pidPath = join(root, "pid");
  await writeFile(executable, `#!${process.execPath}\n` +
    `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));` +
    "if(process.env.ANTHROPIC_API_KEY)process.exit(1);process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n", { mode: 0o700 });
  try {
    const session = createCiAgentSession(CONFIG, { env: { ANTHROPIC_API_KEY: "private-api-key" },
      claude: { executable: async () => executable, terminateGraceMs: 20 } });
    await assert.rejects(session.preflight({ timeoutMs: 1000 }), { code: "AGENT_BUDGET_EXCEEDED" });
    const { readFile } = await import("node:fs/promises");
    const pid = Number(await readFile(pidPath, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
