import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tsImport } from "tsx/esm/api";

const { createCiAgentSession } = await tsImport("../../src/capture/agent/session.ts", import.meta.url);

// The native process can contact only this local fixture, never an API account or the internet.
test("pinned Claude rejects unknown ordinary tools and corrects them within its own loop", {
  skip: process.platform !== "darwin", timeout: 30_000,
}, async () => {
  const requests = [];
  const calls = [];
  const errors = [];
  const responses = [
    { name: "mcp__explore_ci__open", input: { url: "fixture://account" } },
    { name: "Bash", input: { command: "printf FORBIDDEN_EXECUTION" } },
    { name: "mcp__explore_ci__act", input: { action: "open", url: "fixture://account" } },
    { name: "mcp__explore_ci__observe", input: {} },
  ];
  const server = createServer((request, response) => void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!request.url.startsWith("/v1/messages")) { response.writeHead(404); response.end("{}"); return; }
    assert.equal(request.headers["x-api-key"], "fixture-no-real-account");
    const body = JSON.parse(Buffer.concat(chunks));
    if (request.url.includes("count_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":10}'); return; }
    requests.push(body);
    const tool = responses.shift();
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: tool
        ? { type: "tool_use", id: `tool_${requests.length}`, name: tool.name, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) }
        : { type: "text_delta", text: "The fixture is complete." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  })().catch(error => { errors.push(error); response.writeHead(500); response.end("{}"); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const session = createCiAgentSession({ provider: "anthropic", model: "claude-fixture-model" }, {
    env: { ANTHROPIC_API_KEY: "fixture-no-real-account" },
    claude: { queryFactory: ({ prompt, options }) => query({ prompt, options: { ...options,
      env: { ...options.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
      spawnClaudeCodeProcess: child => {
        const policy = `(version 1)(allow default)(deny network*)
          (allow network-outbound (remote ip "localhost:${port}"))
          (deny file-read* (require-all (subpath ${JSON.stringify(homedir())}) (require-not (subpath ${JSON.stringify(dirname(child.command))}))))`;
        return options.spawnClaudeCodeProcess({ ...child, command: "/usr/bin/sandbox-exec", args: ["-p", policy, child.command, ...child.args] });
      },
    } }) },
  });
  try {
    await session.run({ instructions: "Use only the supplied tools.", prompt: "Inspect the fixture.", deadlineMs: Date.now() + 25_000, maxTurns: 8,
      tools: [
        { name: "act", description: "Perform a fixture action.", inputSchema: { type: "object", properties: {
          action: { type: "string", const: "open" }, url: { type: "string" },
        }, required: ["action", "url"], additionalProperties: false } },
        { name: "observe", description: "Observe the fixture.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      ],
      callTool: async (name, input) => { calls.push({ name, input }); return { content: [{ type: "text", text: "Fixture result." }] }; },
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [{ name: "act", input: { action: "open", url: "fixture://account" } }, { name: "observe", input: {} }]);
    assert.equal(requests.length, 5);
    for (const [index, name] of ["mcp__explore_ci__open", "Bash"].entries()) {
      const result = requests[index + 1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === "tool_result" && block.tool_use_id === `tool_${index + 1}`);
      assert.equal(result.is_error, true);
      assert.match(JSON.stringify(result.content), /No such tool available/);
      assert.ok(JSON.stringify(result.content).includes(name));
    }
    for (const request of requests) assert.deepEqual(request.tools.map(tool => tool.name).sort(), ["mcp__explore_ci__act", "mcp__explore_ci__observe"]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
