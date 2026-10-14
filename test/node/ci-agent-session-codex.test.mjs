import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { runCodexSession } = await tsImport("../../src/capture/agent/session-codex.ts", import.meta.url);
const { CHAT_CONFIG } = await tsImport("../../src/capture/agent/codex-config.ts", import.meta.url);
const { CiError, serializeCiError } = await tsImport("../../src/shared/ci-errors.ts", import.meta.url);
const CONFIG = { provider: "openai", model: "explicit-test-model" };
const RUNTIME_CONFIG = { ...CHAT_CONFIG, forced_login_method: "api", model_provider: "openai" };
const KEY = "private-test-key-never-in-model-context";
const ENV = { PATH: process.env.PATH, OPENAI_API_KEY: KEY, CODEX_HOME: "/untrusted/codex", HOME: "/private/home",
  OPENAI_BASE_URL: "https://untrusted.test", CODEX_API_KEY: "private-other-key", ANTHROPIC_API_KEY: "private-other-provider",
  NODE_OPTIONS: "--require injected.js", GITHUB_TOKEN: "private-github-token", HTTPS_PROXY: "https://secret.test" };
const TOOL = { name: "observe", description: "Inspect the current application.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false } };
const IMAGE = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
const toolParams = (extra = {}) => ({ threadId: "thread-1", turnId: "turn-1", callId: "call-1", namespace: null, tool: "observe", arguments: {}, ...extra });

function harness(behavior = {}) {
  const messages = [];
  const kills = [];
  let captured;
  let child;
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => send({ method, params });
  const finish = (extra = {}) => notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, ...extra } });
  const tool = (id = "server-1", params = {}) => send({ id, method: "item/tool/call", params: toolParams(params) });
  const respond = message => {
    messages.push(message);
    if (behavior.receive?.(message, { send, notify, finish, tool }) === true) return;
    if (message.method === "initialize") send({ id: message.id, result: {} });
    else if (message.method === "config/read") send({ id: message.id, result: { config: behavior.config ?? RUNTIME_CONFIG } });
    else if (message.method === "account/login/start") send({ id: message.id, result: { type: "apiKey" } });
    else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
    else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "turn-1" } } });
      if (behavior.turn) behavior.turn({ send, notify, finish, tool });
      else finish();
    } else if (message.id !== undefined && !message.method) behavior.result?.(message, { send, notify, finish, tool });
  };
  const spawn = (command, args, options) => {
    captured = { command, args, options };
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let buffer = "";
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const parsed = JSON.parse(line);
        queueMicrotask(() => respond(parsed));
      }
      callback();
    } });
    child.kill = signal => {
      kills.push(signal);
      if (!behavior.ignoreTerm || signal === "SIGKILL") setTimeout(() => {
        child.stdout.end(); child.stderr.end(); child.emit("close", 0, signal);
      }, behavior.closeDelay ?? 0);
      return true;
    };
    behavior.spawned?.(child, captured);
    return child;
  };
  const run = (request = {}) => runCodexSession(CONFIG, {
    instructions: "Explore only the supplied application tools.", prompt: "Observe the current screen.", tools: [TOOL],
    callTool: async () => ({ content: [{ type: "text", text: "Observed." }] }),
    deadlineMs: Date.now() + 5_000, ...request,
  }, { ...ENV, ...behavior.env }, { spawn, terminateGraceMs: 15, ...(behavior.subscription ? { subscription: true } : {}) });
  return { run, messages, kills, get captured() { return captured; }, get child() { return child; } };
}

async function cleaned(fixture) {
  assert.ok(fixture.kills.length, "The subprocess must be stopped before resolving the session");
  await assert.rejects(access(dirname(fixture.captured.options.cwd)), { code: "ENOENT" });
}

test("Codex CI uses a private API-key session, selected model, native image tools, and cumulative usage", async () => {
  let calls = 0;
  let rootMode;
  let workspaceContents;
  const fixture = harness({
    turn({ tool }) { tool(); tool("same-call-retry"); },
    result(message, { notify, finish }) {
      if (message.id !== "same-call-retry") return;
      notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { inputTokens: 12, outputTokens: 4 } } });
      notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { inputTokens: 27, outputTokens: 9 } } });
      finish();
    },
  });
  const result = await fixture.run({ images: [IMAGE], callTool: async (name, input, signal) => {
    calls++;
    assert.equal(name, "observe"); assert.deepEqual(input, {}); assert.ok(signal instanceof AbortSignal);
    rootMode = (await stat(dirname(fixture.captured.options.cwd))).mode & 0o777;
    workspaceContents = await readdir(fixture.captured.options.cwd);
    return { content: [{ type: "text", text: "Screenshot metadata." }, IMAGE] };
  } });
  assert.deepEqual(result, { inputTokens: 27, outputTokens: 9 });
  assert.equal(calls, 1, "Repeated call IDs must not repeat stateful tool actions");
  assert.equal(rootMode, 0o700);
  assert.deepEqual(workspaceContents, []);
  const { args, options } = fixture.captured;
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.includes('forced_login_method="api"'));
  assert.ok(args.includes('model_provider="openai"'));
  assert.ok(args.includes('shell_environment_policy={inherit="none"}'));
  assert.equal(JSON.stringify(args).includes(KEY), false);
  assert.equal(options.env.CODEX_HOME.startsWith(dirname(options.cwd)), true);
  assert.deepEqual(Object.keys(options.env).sort(), ["CODEX_HOME", "NO_COLOR", "PATH"]);
  const login = fixture.messages.find(message => message.method === "account/login/start");
  assert.deepEqual(login.params, { type: "apiKey", apiKey: KEY });
  const thread = fixture.messages.find(message => message.method === "thread/start").params;
  assert.equal(thread.model, CONFIG.model); assert.equal(thread.ephemeral, true);
  assert.equal(thread.allowProviderModelFallback, false);
  assert.deepEqual(thread.environments, []); assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  assert.deepEqual(thread.selectedCapabilityRoots, []);
  assert.equal(thread.approvalPolicy, "never"); assert.equal(thread.sandbox, "read-only");
  assert.deepEqual(thread.dynamicTools, [{ type: "function", ...TOOL }]);
  const turn = fixture.messages.find(message => message.method === "turn/start").params;
  assert.equal(turn.model, CONFIG.model); assert.deepEqual(turn.environments, []);
  assert.deepEqual(turn.input[1], { type: "image", url: "data:image/png;base64,aW1hZ2U=" });
  const toolResult = fixture.messages.find(message => message.id === "server-1").result;
  assert.deepEqual(toolResult, { success: true, contentItems: [
    { type: "inputText", text: "Screenshot metadata." }, { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
  ] });
  assert.equal(JSON.stringify({ thread, turn, toolResult }).includes(KEY), false);
  await cleaned(fixture);
});

test("Codex accepts notifications before the turn/start response and validates their turn identity", async () => {
  const fixture = harness({ receive(message, { send, notify, finish }) {
    if (message.method !== "turn/start") return false;
    notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { type: "reasoning" } });
    finish();
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    return true;
  } });
  assert.deepEqual(await fixture.run(), { inputTokens: 0, outputTokens: 0 });
  await cleaned(fixture);
});

test("Codex handles the pinned config/read projection while retaining explicit disabled-tool overrides", async () => {
  const fixture = harness({ config: { ...RUNTIME_CONFIG, tools: { web_search: null } } });
  await fixture.run();
  assert.ok(fixture.captured.args.includes("tools={experimental_request_user_input={enabled=false},update_plan={enabled=false}}"));
  await cleaned(fixture);
});

test("Codex refuses any login or account state that falls back to a subscription", async () => {
  for (const method of ["account/login/start", "account/read"]) {
    const fixture = harness({ receive(message, { send }) {
      if (message.method !== method) return false;
      send({ id: message.id, result: method === "account/read" ? { account: { type: "chatgpt" } } : { type: "chatgpt" } });
      return true;
    } });
    await assert.rejects(fixture.run(), { code: "AGENT_RUNTIME_UNSAFE" });
    assert.equal(fixture.messages.some(message => message.method === "thread/start"), false);
    await cleaned(fixture);
  }
});

test("Codex refuses unsafe configuration, approval requests, undeclared tools, and native tools", async () => {
  const scenarios = [
    { config: { ...RUNTIME_CONFIG, forced_login_method: "chatgpt" }, code: "AGENT_RUNTIME_UNSAFE" },
    { config: { ...RUNTIME_CONFIG, features: { ...RUNTIME_CONFIG.features, shell_tool: true } }, code: "AGENT_RUNTIME_UNSAFE" },
    { config: { ...RUNTIME_CONFIG, mcp_servers: { injected: {} } }, code: "AGENT_RUNTIME_UNSAFE" },
    { turn: ({ send }) => send({ id: "approval", method: "item/commandExecution/requestApproval", params: {} }), code: "AGENT_TOOL_DENIED" },
    { turn: ({ tool }) => tool("unknown", { tool: "shell" }), code: "AGENT_TOOL_DENIED" },
    { turn: ({ tool }) => tool("foreign-thread", { threadId: "foreign" }), code: "AGENT_TOOL_DENIED" },
    { turn: ({ notify }) => notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution" } }), code: "AGENT_TOOL_DENIED" },
  ];
  for (const scenario of scenarios) {
    const fixture = harness(scenario);
    await assert.rejects(fixture.run({ callTool: () => assert.fail("Unauthorized calls must not reach the host") }), { code: scenario.code });
    await cleaned(fixture);
  }
});

test("Codex completion cannot hide protocol violations or authorize subsequent host actions", async () => {
  for (const turn of [
    ({ finish, notify }) => { finish(); notify("item/started", { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution" } }); },
    ({ finish, tool }) => { finish(); tool(); },
  ]) {
    const fixture = harness({ turn });
    await assert.rejects(fixture.run({ callTool: () => assert.fail("No action may begin after completion") }), { code: "AGENT_TOOL_DENIED" });
    await cleaned(fixture);
  }
  const premature = harness({ turn({ tool, finish }) { tool(); finish(); } });
  await assert.rejects(premature.run({ callTool: () => assert.fail("A failed protocol cannot start pending actions") }), { code: "AGENT_OUTPUT_INVALID" });
  await cleaned(premature);
});

test("Codex rejects conflicting tool identities and malformed usage without executing another action", async () => {
  const duplicate = harness({ turn({ tool }) { tool(); tool("conflict", { arguments: { changed: true } }); } });
  let calls = 0;
  await assert.rejects(duplicate.run({ callTool: async () => { calls++; return { content: [] }; } }), { code: "AGENT_OUTPUT_INVALID" });
  assert.ok(calls <= 1);
  await cleaned(duplicate);
  const usage = harness({ turn({ notify }) {
    notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { inputTokens: -1, outputTokens: 0 } } });
  } });
  await assert.rejects(usage.run(), { code: "AGENT_OUTPUT_INVALID" });
  await cleaned(usage);
});

test("Codex preserves fatal host tool failures and returns recoverable tool errors to the model", async () => {
  const fatal = new CiError({ code: "CAPTURE_FAILED", stage: "capture", message: "Capture failed.", nextAction: "Check simulator." });
  const fixture = harness({ turn: ({ tool }) => tool() });
  await assert.rejects(fixture.run({ callTool: async () => { throw fatal; } }), error => error === fatal);
  await cleaned(fixture);
  const recoverable = harness({ turn: ({ tool }) => tool(), result(message, { finish }) {
    assert.deepEqual(message.result, { success: false, contentItems: [{ type: "inputText", text: "Observe again." }] }); finish();
  } });
  await recoverable.run({ callTool: async () => ({ isError: true, content: [{ type: "text", text: "Observe again." }] }) });
  await cleaned(recoverable);
});

test("Codex classifies structured provider failures without exposing raw messages", async () => {
  for (const [info, code] of [["unauthorized", "AGENT_API_KEY_INVALID"], ["usageLimitExceeded", "AGENT_QUOTA_EXHAUSTED"],
    ["rateLimitExceeded", "AGENT_RATE_LIMITED"], [{ httpConnectionFailed: { httpStatusCode: 404 } }, "AGENT_MODEL_NOT_FOUND"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 503 } }, "AGENT_SERVICE_UNAVAILABLE"]]) {
    const fixture = harness({ turn: ({ finish }) => finish({ status: "failed", error: { codexErrorInfo: info, message: KEY } }) });
    await assert.rejects(fixture.run(), error => {
      assert.equal(error.code, code);
      assert.equal(JSON.stringify(serializeCiError(error)).includes(KEY), false);
      return true;
    });
    await cleaned(fixture);
  }
});

test("Codex cancellation closes stalled startup and waits for escalation before removing credentials", async () => {
  const controller = new AbortController();
  const fixture = harness({ ignoreTerm: true, receive: message => message.method === "initialize" });
  const pending = fixture.run({ signal: controller.signal });
  const cancelled = new CiError({ code: "AGENT_CANCELLED", stage: "agent", message: "Cancelled.", nextAction: "Retry." });
  const timer = setTimeout(() => controller.abort(cancelled), 30);
  try { await assert.rejects(pending, error => error === cancelled); } finally { clearTimeout(timer); }
  assert.equal(fixture.kills[0], "SIGTERM");
  assert.equal(fixture.kills.at(-1), "SIGKILL");
  await cleaned(fixture);
});

test("Codex deadline bounds a stalled model/tool loop and cleans the private home", async () => {
  const fixture = harness({ turn: ({ tool }) => tool() });
  await assert.rejects(fixture.run({ deadlineMs: Date.now() + 80, callTool: () => new Promise(() => {}) }), { code: "AGENT_BUDGET_EXCEEDED" });
  await cleaned(fixture);
  const expired = harness();
  await assert.rejects(expired.run({ deadlineMs: Date.now() - 1 }), { code: "AGENT_BUDGET_EXCEEDED" });
  assert.equal(expired.captured, undefined);
});

test("Codex transport failures abort an active host callback before process teardown completes", async () => {
  const fixture = harness({ turn: ({ tool }) => tool(), ignoreTerm: true });
  let toolSignal;
  await assert.rejects(fixture.run({ callTool: (_name, _input, signal) => {
    toolSignal = signal;
    fixture.child.stdout.write(`${JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: {} })}\n`);
    assert.equal(signal.aborted, true);
    assert.deepEqual(fixture.kills, []);
    return new Promise(() => {});
  } }), { code: "AGENT_TOOL_DENIED" });
  assert.equal(toolSignal.aborted, true);
  await cleaned(fixture);
});

test("Codex rejects malformed JSON and handles early child exit without waiting for its deadline", async () => {
  const malformed = harness({ receive(message) {
    if (message.method !== "initialize") return false;
    malformed.child.stdout.write("{private-invalid-json\n"); return true;
  } });
  await assert.rejects(malformed.run(), { code: "AGENT_OUTPUT_INVALID" });
  await cleaned(malformed);
  const exited = harness({ receive(message) {
    if (message.method !== "initialize") return false;
    exited.child.emit("close", 1, null); return true;
  } });
  await assert.rejects(exited.run(), { code: "AGENT_RUNTIME_UNAVAILABLE" });
  await assert.rejects(access(dirname(exited.captured.options.cwd)), { code: "ENOENT" });
});

test("Codex cleanup kills same-group descendants after their parent exits", { skip: process.platform === "win32" }, async () => {
  let descendant;
  let parent;
  const descendantScript = "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000);";
  const parentScript = `
    const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {stdio:['ignore','pipe','ignore']});
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    child.stdout.once('data', data => {
      send({method:'fixture/descendant',params:{pid:Number(String(data))}});
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') send({id:message.id,result:{}});
        else if (message.method === 'config/read') send({id:message.id,result:{config:${JSON.stringify(RUNTIME_CONFIG)}}});
        else if (message.method === 'account/login/start') send({id:message.id,result:{type:'apiKey'}});
        else if (message.method === 'account/read') send({id:message.id,result:{account:{type:'apiKey'}}});
        else if (message.method === 'thread/start') send({id:message.id,result:{thread:{id:'thread-1'}}});
        else if (message.method === 'turn/start') {
          send({id:message.id,result:{turn:{id:'turn-1'}}});
          send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
        }
      });
    });
    setInterval(()=>{},1000);
  `;
  try {
    await runCodexSession(CONFIG, { instructions: "Use no tools.", prompt: "Reply OK.", tools: [],
      callTool: () => assert.fail("This local process fixture must not call a tool"), deadlineMs: Date.now() + 5_000 }, ENV,
    { terminateGraceMs: 20, spawn: (_command, _args, options) => {
      parent = spawn(process.execPath, ["-e", parentScript], options);
      let buffer = "";
      parent.stdout.on("data", data => {
        buffer += data.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const message = JSON.parse(line);
          if (message.method === "fixture/descendant") descendant = message.params.pid;
        }
      });
      return parent;
    } });
    assert.ok(Number.isSafeInteger(descendant));
    assert.notEqual(parent.exitCode ?? parent.signalCode, null);
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { process.kill(descendant, 0); }
      catch (error) { if (error.code === "ESRCH") { stopped = true; break; } throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(stopped, true, "A descendant ignoring SIGTERM must not survive its parent");
  } finally { if (descendant) try { process.kill(descendant, "SIGKILL"); } catch {} }
});


const subscription = (behavior = {}) => harness({ subscription: true, config: { ...RUNTIME_CONFIG, forced_login_method: "chatgpt" },
  receive(message, { send }) {
    if (message.method !== "account/read") return false;
    send({ id: message.id, result: { account: { type: "chatgpt" } } }); return true;
  }, ...behavior });

async function userCodexHome(t) {
  const home = await mkdtemp(join(tmpdir(), "explore-test-codex-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "auth.json"), '{"tokens":"original"}', { mode: 0o600 });
  await writeFile(join(home, "config.toml"), '[mcp_servers.external]\ncommand = "external"\n');
  return home;
}

test("local Codex uses the subscription CLI without initiating API-key login", async () => {
  const fixture = subscription();
  const receipts = [];
  await fixture.run({ onUsage: receipt => receipts.push(receipt) });
  assert.equal(fixture.captured.command, "codex");
  assert.equal(dirname(fixture.captured.options.env.CODEX_HOME), dirname(fixture.captured.options.cwd));
  assert.equal(fixture.captured.options.env.OPENAI_API_KEY, undefined);
  assert.equal(fixture.messages.some(m => m.method === "account/login/start"), false);
  assert.equal(receipts[0].source, "codex-cli");
  assert.equal(receipts[0].accounting, "unknown");
  await cleaned(fixture);
});

test("local Codex runs in a private home holding only the user's login, never their MCP servers or plugins", async t => {
  const home = await userCodexHome(t);
  let runtime;
  const fixture = subscription({ env: { CODEX_HOME: home }, spawned(_child, captured) {
    runtime = readdirSync(captured.options.env.CODEX_HOME);
  } });
  await fixture.run();
  assert.notEqual(fixture.captured.options.env.CODEX_HOME, home);
  assert.deepEqual(runtime, ["auth.json"]);
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"tokens":"original"}');
  await cleaned(fixture);
});

test("local Codex writes a refreshed login back to the user's home, owner-only", async t => {
  const home = await userCodexHome(t);
  const fixture = subscription({ env: { CODEX_HOME: home }, spawned(_child, captured) {
    writeFileSync(join(captured.options.env.CODEX_HOME, "auth.json"), '{"tokens":"refreshed"}');
  } });
  await fixture.run();
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"tokens":"refreshed"}');
  assert.equal((await stat(join(home, "auth.json"))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(home)).sort(), ["auth.json", "config.toml"]);
  await cleaned(fixture);
});

test("local Codex keeps a login the user changed while the session ran", async t => {
  const home = await userCodexHome(t);
  const fixture = subscription({ env: { CODEX_HOME: home }, spawned(_child, captured) {
    writeFileSync(join(captured.options.env.CODEX_HOME, "auth.json"), '{"tokens":"refreshed"}');
    writeFileSync(join(home, "auth.json"), '{"tokens":"relogin"}');
  } });
  await fixture.run();
  assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"tokens":"relogin"}');
  await cleaned(fixture);
});

test("usage persistence failure cannot skip Codex subprocess cleanup", async () => {
  const fixture = harness();
  await assert.rejects(fixture.run({ onUsage() { throw new Error("receipt write failed"); } }), /receipt write failed/);
  await cleaned(fixture);
});
