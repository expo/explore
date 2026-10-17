import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExplorePlatform } from "../config/explore-config.js";
import type { RunTarget } from "../types.js";
import { reportTarget } from "./saved-runs.js";
import { AGENT_API_VERSION, agentApiReply, agentIndexMarkdown, loadReport, prefersHtml, type AgentContext, type LoadedReport } from "./agent-api.js";

/**
 * Serve review reports on this machine the way a hosted report serves them: the built Viewer at `/p/<token>`, each
 * target's report at `/p/<token>/report.zip?target=…` (or `?platform=…`), and the list at `/p/<token>/reports.json`. The
 * Viewer already knows this layout, so nothing in it changes. An agent on this machine gets what it gets from a hosted
 * link: the Markdown index when it fetches `/p/<token>` without asking for HTML, `/p/<token>/llms.txt`, and the JSON
 * API at `/p/<token>/api/v1/...` (agent-api.ts, shared with the hosted Worker). Loopback only; anything else answers 404.
 */
/** A report to serve; without a target, it is the one named for its platform. */
export type LocalReport = { platform: ExplorePlatform; target?: RunTarget; zip: Uint8Array; changes?: number; device?: string };
export type LocalReportServer = { server: Server; url: string; close: () => Promise<void> };

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json; charset=utf-8", ".cur": "image/x-icon" };
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const AGENT_ROUTE = /^(?:\/llms\.txt|\/api\/v1(?:\/[A-Za-z0-9._:@-]{1,200}){0,2}\/?)$/;

export async function startLocalReportServer(options: { reports: LocalReport[]; port?: number; viewerRoot?: string; token?: string }): Promise<LocalReportServer> {
  if (!options.reports.length) throw new Error("There is no report to serve");
  const viewerRoot = resolve(options.viewerRoot ?? fileURLToPath(new URL("../viewer/", import.meta.url)));
  await stat(resolve(viewerRoot, "index.html"));
  const token = options.token ?? [...randomBytes(32)].map(byte => BASE32[byte % 32]).join("");
  const page = `/p/${token}`;
  // The hosted listing's shape and key order (preview-deploy.ts), without the hosted file paths.
  const listing = JSON.stringify(options.reports.map(report => ({ target: reportTarget(report).id, platform: report.platform, label: reportTarget(report).label,
    ...(report.changes === undefined ? {} : { changes: report.changes }), ...(report.device ? { device: report.device } : {}) })));
  const loaded = new Map<LocalReport, Promise<LoadedReport | undefined>>();
  let pageUrl = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const send = (status: number, body: Uint8Array | string, type = "text/plain; charset=utf-8", headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
        response.end(body);
      };
      if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Method not allowed");
      // `?target=` picks one of several reports; `?platform=`, from links made before targets, the target named for it, else
      // the first of that platform; neither, the first. An unknown one matches nothing.
      const targets = url.searchParams.getAll("target"), platforms = url.searchParams.getAll("platform");
      const report = targets.length + platforms.length > 1 ? undefined
        : targets.length ? options.reports.find(candidate => reportTarget(candidate).id === targets[0])
        : platforms.length ? options.reports.find(candidate => reportTarget(candidate).id === platforms[0]) ?? options.reports.find(candidate => candidate.platform === platforms[0])
        : options.reports[0];
      const accept = request.headers.accept ?? null;
      const isPage = url.pathname === page || url.pathname === `${page}/`;
      const agentPath = url.pathname.startsWith(`${page}/`) ? url.pathname.slice(page.length) : "";
      if ((isPage && !prefersHtml(accept)) || AGENT_ROUTE.test(agentPath)) {
        if (!report) return send(404, "Not found");
        if (!loaded.has(report)) loaded.set(report, loadReport(report.zip));
        const content = await loaded.get(report);
        if (!content) return send(404, "Not found");
        const context: AgentContext = { pageUrl, platform: report.platform, platforms: [...new Set(options.reports.map(entry => entry.platform))], expiresAt: null,
          target: reportTarget(report).id, targets: options.reports.map(entry => { const { id, platform, label } = reportTarget(entry); return { id, platform, label }; }) };
        const link = { link: `<${pageUrl}/api/${AGENT_API_VERSION}>; rel="alternate"; type="application/json", <${pageUrl}/llms.txt>; rel="alternate"; type="text/markdown"`, vary: "Accept" };
        if (isPage || agentPath === "/llms.txt") return send(200, agentIndexMarkdown(context, content), "text/markdown; charset=utf-8", link);
        const reply = await agentApiReply(context, content, agentPath.slice("/api/v1".length).replace(/\/$/, ""), url.searchParams, accept);
        const body = typeof reply.body === "string" ? reply.body : new Uint8Array(await new Response(reply.body).arrayBuffer());
        return send(reply.status, body, reply.contentType, { vary: "Accept", ...reply.headers });
      }
      if (isPage) return send(200, await readFile(resolve(viewerRoot, "index.html")), TYPES[".html"]);
      if (url.pathname === `${page}/report.zip`) return report ? send(200, report.zip, "application/zip") : send(404, "Not found");
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
  pageUrl = `http://127.0.0.1:${address.port}${page}`;
  return { server, url: pageUrl,
    close: () => new Promise<void>(done => server.close(() => done())) };
}
