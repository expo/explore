import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createViteServer } from "vite";
import { tsImport } from "tsx/esm/api";

const { apiProxyBoundaryPlugin, viewerApiProxy } = await tsImport("../../viewer/vite-api-proxy.ts", import.meta.url);
const publicHost = "public-host.example";

async function vite(t, options) {
  const root = await mkdtemp(join(tmpdir(), "explore-vite-api-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Proxy test viewer</title>");
  const server = await createViteServer({
    configFile: false, root, logLevel: "silent", plugins: options.plugins,
    server: { host: "127.0.0.1", port: 0, allowedHosts: [publicHost], proxy: options.proxy ?? {} },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port };
}

function raw(viewer, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port: viewer.port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

test("normal Vite validates original headers before proxy credentials and rewrites a valid local Origin", async (t) => {
  const proxied = [];
  const upstream = createServer((incoming, response) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.once("end", () => {
      proxied.push({ method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const viewer = await vite(t, {
    plugins: [apiProxyBoundaryPlugin()],
    proxy: { "/api": viewerApiProxy({ target, sessionCookie: "private-viewer=secret" }) },
  });
  for (const headers of [
    { host: "attacker.invalid" }, { host: publicHost },
    { origin: "https://attacker.invalid" }, { origin: "null" }, { origin: target },
    { origin: `http://localhost:${viewer.port}` }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
    { host: publicHost, "x-forwarded-host": `127.0.0.1:${viewer.port}`, origin: `http://127.0.0.1:${viewer.port}` },
  ]) {
    for (const path of ["/api/workspace", "/api/map"]) {
      const result = await raw(viewer, path, { method: "POST", headers: { cookie: "forged=value", "content-type": "application/json", ...headers }, body: "{}" });
      assert.equal(result.status, 403, JSON.stringify({ path, headers }));
    }
  }
  assert.deepEqual(proxied, []);
  const valid = await raw(viewer, "/api/workspace", {
    method: "POST", headers: { origin: `http://127.0.0.1:${viewer.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}",
  });
  assert.equal(valid.status, 200);
  assert.equal(proxied.length, 1);
  assert.equal(proxied[0].headers.cookie, "private-viewer=secret");
  assert.equal(proxied[0].headers.origin, target);
  assert.equal(proxied[0].headers.host, new URL(target).host);
  assert.equal(proxied[0].method, "POST");
  assert.equal(proxied[0].body, "{}");
  assert.equal((await raw(viewer, "/api/health")).status, 200);
  assert.equal(proxied[1].headers.origin, undefined);
});
