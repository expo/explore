// The Vite server behind `npm run ci:local:view`: the Viewer's sources, with `/r` opening one report
// ZIP before the app starts. Kept apart from view.mjs so a test can start it without arguments.
import { createServer as createNetServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export const VIEWER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../viewer');
const ZIP_PATH = '/__local-report.zip';
const BOOTSTRAP_ID = '/__local-report.ts';

// A module Vite serves, not an inline script: after a source edit, Vite imports report-source.ts
// as report-source.ts?t=<edit>. An inline script keeps the bare URL, so it would open the report in
// a second instance of the module and the app would find none. Served here, the bootstrap's
// imports get the same timestamps as the app's.
const BOOTSTRAP = `import { REPORT_SOURCE } from "/src/utils/report-source.ts";
const response = await fetch(${JSON.stringify(ZIP_PATH)});
await REPORT_SOURCE.openFile(new File([await response.blob()], "report.zip"));
await import("/src/main.tsx");
`;

/** A port the operating system has just handed out on 127.0.0.1. */
async function freePort() {
  const probe = createNetServer();
  await new Promise((resolvePort, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolvePort); });
  const { port } = probe.address();
  await new Promise(done => probe.close(done));
  return port;
}

/**
 * Serve the Viewer with `bytes` as the report `/r` opens. `port: 'free'` takes a port from the
 * system and holds Vite to it; Vite reads port 0 as its default and moves up from 5173, which would
 * put a script's server next to a developer's running Viewer. `watch: false` keeps a long-running
 * check's tab alive: with watching, editing any Viewer source reloads the page (this server has no
 * Fast Refresh), which drops the tab's Live pairing with the CLI. `cacheDir` moves Vite's optimized
 * dependencies out of node_modules/.vite, which every checkout sharing node_modules writes, so a
 * test cannot replace another server's.
 */
export async function startReportViewer({ bytes, watch = true, port = 0, cacheDir }) {
  const listenPort = port === 'free' ? await freePort() : port;
  // esbuild's automatic JSX runtime adds react/jsx-dev-runtime imports that Vite's dependency scan
  // never sees. Found on the first request instead, it makes Vite reload the page once.
  const server = await createServer({ configFile: false, root: VIEWER_ROOT, logLevel: 'warn', esbuild: { jsx: 'automatic' },
    optimizeDeps: { include: ['react/jsx-dev-runtime'] }, ...(cacheDir ? { cacheDir } : {}),
    server: { host: '127.0.0.1', port: listenPort, ...(port === 'free' ? { strictPort: true } : {}), ...(watch ? {} : { hmr: false, watch: null }) }, plugins: [{ name: 'local-ci-report',
      resolveId: id => id === BOOTSTRAP_ID ? id : undefined,
      load: id => id === BOOTSTRAP_ID ? BOOTSTRAP : undefined,
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url, 'http://localhost').pathname;
          if (path === ZIP_PATH) { res.setHeader('content-type', 'application/zip'); res.end(bytes); return; }
          if (path !== '/r') return next();
          res.setHeader('content-type', 'text/html');
          res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${BOOTSTRAP_ID}"></script></body></html>`);
        });
      } }] });
  await server.listen();
  return { server, url: `http://127.0.0.1:${server.httpServer.address().port}/r` };
}
