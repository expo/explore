// Live-reload development harness for the viewer.
//
// With EXPLORE_REPORT, serves that report ZIP (any `explore` review or exploration report, e.g. a
// hosted report's download) at /r from the Viewer's sources. With EXPLORE_DIR, runs the bundled viewer
// server (so /api/map, /api/status and /api/artifacts serve an exploration directory)
// and a Vite dev server with HMR in front of it.
// The viewer server's loopback/session checks are left exactly as they are in production; we
// borrow one session cookie here and hand it to the Vite proxy through the environment.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mapDir = process.env.EXPLORE_DIR;
const reportZip = process.env.EXPLORE_REPORT;
const apiPort = Number(process.env.EXPLORE_API_PORT ?? 4319);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const devPort = Number(process.env.EXPLORE_DEV_PORT ?? 5199);

const children = [];
let shuttingDown = false;

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) shutdown(code ?? 0);
  });
  return child;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(children.map(child => new Promise(done => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", done);
    child.kill("SIGTERM");
  })));
  process.exit(code);
}

async function waitForViewerSession() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await fetch(`${apiOrigin}/api/health`);
      if (health.ok) {
        const index = await fetch(`${apiOrigin}/`);
        const cookie = index.headers.get("set-cookie")?.split(";", 1)[0];
        if (cookie) return cookie;
      }
    } catch {
      // Still booting.
    }
    await new Promise((wake) => setTimeout(wake, 250));
  }
  throw new Error(`Viewer server never became ready on ${apiOrigin}`);
}

function buildOnce(script) {
  return new Promise((done, fail) => {
    const build = spawn("npm", ["run", script], { cwd: root, stdio: "inherit" });
    build.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${script} exited ${code}`))));
  });
}

if (!mapDir) {
  if (!reportZip) {
    console.error("Set EXPLORE_REPORT=<report.zip> to open a report (an `explore` review or exploration ZIP), or EXPLORE_DIR=<exploration directory> to serve a map.");
    process.exit(2);
  }
  const { readFile } = await import("node:fs/promises");
  const { startReportViewer } = await import("../test/ci/lib/report-viewer.mjs");
  const { server, url } = await startReportViewer({ bytes: await readFile(reportZip), port: devPort });
  console.log(`Report Viewer: ${url}`);
  let closing;
  const stop = () => { process.exitCode = 0; closing ??= server.close().catch(error => { console.error(error); process.exitCode = 1; }); return closing; };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);
} else {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  if (!existsSync(join(root, "dist", "cli.js"))) {
    console.log("[explore] dist/cli.js missing — building the CLI first…");
    await buildOnce("build:cli");
  }

  // The viewer server refuses to start without a bundle on disk, even though Vite serves the
  // app in dev. One build is enough; Vite takes over from there.
  if (!existsSync(join(root, "dist", "viewer", "index.html"))) {
    console.log("[explore] dist/viewer missing — building the viewer bundle once…");
    await buildOnce("build:viewer");
  }

  console.log(`[explore] serving map data from ${mapDir} on ${apiOrigin}`);
  run("node", ["dist/cli.js", "view", "--dir", mapDir, "--no-open", "--port", String(apiPort)]);

  const cookie = await waitForViewerSession();
  console.log(`[explore] dev viewer with HMR → http://127.0.0.1:${devPort}/`);
  run("node_modules/.bin/vite", ["--config", "viewer/vite.config.ts", "--host", "127.0.0.1"], {
    EXPLORE_DEV_COOKIE: cookie,
    EXPLORE_API_ORIGIN: apiOrigin,
    EXPLORE_DEV_PORT: String(devPort),
  });
}
