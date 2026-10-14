/** Private stdio MCP bridge launched only by the local Claude process. */
import { createInterface } from "node:readline";

const endpoint = process.env.EXPLORE_CI_MCP_ENDPOINT;
const token = process.env.EXPLORE_CI_MCP_TOKEN;
if (!endpoint || !token || new URL(endpoint).hostname !== "127.0.0.1") throw new Error("Missing local tool host");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("MCP request too large");
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  try {
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "explore", version: "1.0.0" } };
    else if (message.method === "ping") result = {};
    else if (message.method === "tools/list" || message.method === "tools/call") {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ method: message.method, params: message.params }), signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok) throw new Error("Tool host unavailable");
      result = await response.json();
    } else throw new Error("Unsupported MCP method");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Explore tool request failed" } })}\n`);
  }
}
