import type { IncomingMessage } from "node:http";
import type { Plugin, ProxyOptions } from "vite";

/** Check the original browser request, before proxy cookies or origins are rewritten. */
export function isTrustedLocalRequest(request: IncomingMessage): boolean {
  const port = request.socket.localPort;
  const remote = request.socket.remoteAddress;
  if (!port || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "")) return false;
  const host = request.headers.host?.toLowerCase();
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return false;
  for (const name of ["host", "origin", "sec-fetch-site"]) {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
    }
    if (count > 1) return false;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/** Must run before Vite's proxy middleware can add the bundled viewer's private cookie. */
export function apiProxyBoundaryPlugin(): Plugin {
  return {
    name: "explore-api-proxy-boundary",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api")) { next(); return; }
        if (!isTrustedLocalRequest(request)) {
          response.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
          response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: false, error: "Untrusted viewer request" }));
          request.resume();
          return;
        }
        next();
      });
    },
  };
}

export function viewerApiProxy(options: { target: string; sessionCookie?: string }): ProxyOptions {
  const origin = new URL(options.target).origin;
  return {
    target: options.target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (outgoing, incoming) => {
        // Defense in depth: these still refer to the original browser headers.
        if (!isTrustedLocalRequest(incoming)) { outgoing.destroy(); return; }
        if (options.sessionCookie) outgoing.setHeader("cookie", options.sessionCookie);
        if (incoming.headers.origin !== undefined) outgoing.setHeader("origin", origin);
      });
    },
  };
}
