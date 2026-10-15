import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExplorePlatform } from "../config/explore-config.js";

/**
 * Serve review reports on this machine the way a hosted report serves them: the built Viewer at `/p/<token>`, each
 * platform's report at `/p/<token>/report.zip?platform=…`, and the platform list at `/p/<token>/reports.json`. The
 * Viewer already knows this layout, so nothing in it changes. Loopback only; anything else answers 404.
 */
export type LocalReport = { platform: ExplorePlatform; zip: Uint8Array; changes?: number; device?: string };
export type LocalReportServer = { server: Server; url: string; close: () => Promise<void> };

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json; charset=utf-8", ".cur": "image/x-icon" };
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export async function startLocalReportServer(options: { reports: LocalReport[]; port?: number; viewerRoot?: string; token?: string }): Promise<LocalReportServer> {
  if (!options.reports.length) throw new Error("There is no report to serve");
  const viewerRoot = resolve(options.viewerRoot ?? fileURLToPath(new URL("../viewer/", import.meta.url)));
  await stat(resolve(viewerRoot, "index.html"));
  const token = options.token ?? [...randomBytes(32)].map(byte => BASE32[byte % 32]).join("");
  const page = `/p/${token}`;
  const listing = JSON.stringify(options.reports.map(report => ({ platform: report.platform,
    ...(report.changes === undefined ? {} : { changes: report.changes }), ...(report.device ? { device: report.device } : {}) })));
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const send = (status: number, body: Uint8Array | string, type = "text/plain; charset=utf-8") => {
        response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(body);
      };
      if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Method not allowed");
      if (url.pathname === page || url.pathname === `${page}/`) return send(200, await readFile(resolve(viewerRoot, "index.html")), TYPES[".html"]);
      if (url.pathname === `${page}/report.zip`) {
        const platform = url.searchParams.get("platform");
        const report = platform ? options.reports.find(candidate => candidate.platform === platform) : options.reports[0];
        return report ? send(200, report.zip, "application/zip") : send(404, "Not found");
      }
      if (url.pathname === `${page}/reports.json` && options.reports.length > 1) return send(200, listing, TYPES[".json"]);
      // The Viewer's own assets, at the absolute paths its index.html names; never anything outside the build.
      if (/^\/(assets|fonts|cursors)\/[A-Za-z0-9._/-]+$/.test(url.pathname) || url.pathname === "/favicon.svg") {
        const file = resolve(viewerRoot, `.${url.pathname}`);
        if (!file.startsWith(viewerRoot + sep)) return send(404, "Not found");
        try { return send(200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream"); }
        catch { return send(404, "Not found"); }
      }
      send(404, "Not found");
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(options.port ?? 0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The local report server has no port");
  return { server, url: `http://127.0.0.1:${address.port}${page}`,
    close: () => new Promise<void>(done => server.close(() => done())) };
}
