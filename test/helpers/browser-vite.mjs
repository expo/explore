import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

/** A port the operating system has just handed out on `host`. */
async function freePort(host) {
  const probe = createNetServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, host, resolve); });
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/**
 * Concurrent harnesses must not replace each other's optimized dependencies. Vite reads port 0 as
 * its default port and moves up from 5173 while that is taken, which would put a test next to a
 * developer's running Viewer, so a harness asking for port 0 gets a free port and keeps it.
 */
export async function createBrowserVite(test, options) {
  const cacheDir = await mkdtemp(join(tmpdir(), "explore-browser-vite-"));
  let server;
  test.after(async () => {
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  const requested = options.server;
  const port = requested?.port === 0 ? await freePort(requested.host ?? "127.0.0.1") : requested?.port;
  server = await createServer({ ...options, cacheDir,
    ...(requested ? { server: { ...requested, port, ...(requested.port === 0 ? { strictPort: true } : {}) } } : {}) });
  return server;
}
