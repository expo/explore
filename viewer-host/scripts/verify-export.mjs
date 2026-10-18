import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  assertSameViewerBundle,
  inspectViewerBundle,
} from "./viewer-bundle.mjs";

// `--variant preview` checks dist-preview, the per-review deployment that `ci:deploy` seals a
// token, key, and expiry into; the default checks dist, the central report page.
const variant = process.argv.includes("--variant") ? process.argv[process.argv.indexOf("--variant") + 1] : "central";
if (!["central", "preview"].includes(variant)) throw new Error(`Unknown export variant: ${variant}`);
const preview = variant === "preview";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const hostRoot = resolve(scriptDirectory, "..");
const distRoot = join(hostRoot, preview ? "dist-preview" : "dist");
const staged = await inspectViewerBundle(join(hostRoot, "public", "viewer"), "Staged Viewer");
const exported = await inspectViewerBundle(join(distRoot, "client", "viewer"), "Exported Viewer");
assertSameViewerBundle(staged, exported, "Exported Viewer");

const routesPath = join(distRoot, "server", "_expo", "routes.json");
const routes = JSON.parse(await readFile(routesPath, "utf8"));
const expectedApiRoutes = new Set(preview ? ["/index", "/p/[token]", "/p/[token]/[...rest]"] : ["/index", "/r"]);
const actualApiRoutes = new Set(routes.apiRoutes?.map(route => route.page));
if (
  actualApiRoutes.size !== expectedApiRoutes.size
  || [...expectedApiRoutes].some(route => !actualApiRoutes.has(route))
) throw new Error("Expo export does not contain exactly the Viewer API routes");
if (routes.middleware?.file) throw new Error("Expo export must not carry server middleware; reports never pass through this host");

for (const route of routes.apiRoutes) {
  const bundle = await readFile(join(distRoot, "server", route.file), "utf8");
  if (
    !/(?:\.OPTIONS=|["']OPTIONS["'])/.test(bundle)
    || !bundle.includes("Access-Control-Allow-Origin")
    || /Access-Control-Allow-Origin.{0,40}["']\*/.test(bundle)
  ) throw new Error(`Exported API route does not enforce strict CORS: ${route.page}`);
  if (/api\.github\.com|EXPLORE_ARTIFACT_|EXPLORE_GITHUB_CLIENT/.test(bundle)) {
    throw new Error(`Exported route still references GitHub report delivery: ${route.page}`);
  }
}

const stagedHtml = await readFile(join(staged.root, "index.html"), "utf8");

function loadRoute(page, env, extraGlobals = {}) {
  const route = routes.apiRoutes.find(candidate => candidate.page === page);
  const module = { exports: {} };
  runInNewContext(readFileSyncText(join(distRoot, "server", route.file)),
    { module, Request, Response, Headers, URL, URLSearchParams, TextEncoder, atob, process: { env }, ...extraGlobals });
  return module.exports;
}
const sources = new Map();
for (const route of routes.apiRoutes) sources.set(join(distRoot, "server", route.file), await readFile(join(distRoot, "server", route.file), "utf8"));
function readFileSyncText(path) { return sources.get(path); }

if (!preview) {
  // The root is the report page; /r is its address in earlier pull-request comments. Both serve
  // the complete staged Viewer, with no redirect, and refuse a partial report identity.
  for (const [page, path] of [["/index", "/"], ["/r", "/r"]]) {
    const handlers = loadRoute(page, {});
    for (const search of ["?repo=expo%2Fexplore&run=1&attempt=1&artifact=2&focus=modified", ""]) {
      const response = await handlers.GET(new Request(`https://viewer.example.com${path}${search}`));
      if (response.status !== 200 || await response.text() !== stagedHtml || response.headers.has("location")) {
        throw new Error(`Report page ${path}${search} must serve the complete staged Viewer without a redirect`);
      }
    }
    if ((await handlers.GET(new Request(`https://viewer.example.com${path}?repo=expo%2Fexplore&run=1`))).status !== 400) {
      throw new Error(`Report page ${path} must reject a partial report identity`);
    }
  }

  const reportPage = loadRoute("/r", {});
  for (const path of ["/r/private-review", "/map?panel=live", "/api/private", "/api/public/reviews/latest", "/api/ai/capabilities", "/missing"]) {
    if ((await reportPage.GET(new Request(`https://viewer.example.com${path}`))).status !== 404) {
      throw new Error(`Report page route incorrectly accepts ${path}`);
    }
  }
} else {
  // A preview deployment answers only its own token and serves the report decrypted from its own
  // static ciphertext until it expires (then the report route says 410); everything else is the same 404.
  const token = "abcdefghijklmnopqrstuvwxyz234567";
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const reportPath = "/_report/abcdefghijklmnop/report.zip.enc";
  // A recorded PR review, so the exported Worker is seen to inflate the archive and answer the agent API.
  const plain = new Uint8Array(await readFile(new URL("../../test/fixtures/example-review-artifact.zip", import.meta.url)));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("expo-explore-preview/1") }, key, plain));
  const sealed = new Uint8Array(iv.byteLength + cipher.byteLength);
  sealed.set(iv); sealed.set(cipher, iv.byteLength);
  const env = {
    EXPLORE_PREVIEW_TOKEN: token,
    EXPLORE_PREVIEW_KEY: Buffer.from(keyBytes).toString("base64"),
    EXPLORE_PREVIEW_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    EXPLORE_PREVIEW_REPORT: reportPath,
  };
  const origin = "https://acme-explore--deploy.expo.app";
  const fetched = [];
  const fetchStub = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    fetched.push(url.href);
    return url.pathname === reportPath ? new Response(sealed) : new Response("missing", { status: 404 });
  };
  const globals = { fetch: fetchStub, crypto: webcrypto, TextDecoder, Blob, DecompressionStream };

  const index = loadRoute("/index", env, globals);
  for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
    if ((await index[method](new Request(`${origin}/`, { method }))).status !== 404) throw new Error(`Preview root must answer 404 to ${method}`);
  }
  for (const page of ["/p/[token]", "/p/[token]/[...rest]"]) {
    const handlers = loadRoute(page, env, globals);
    for (const path of [`/p/${token}`, `/p/${token}/`, `/p/${token}?view=compare&screen=home`]) {
      const response = await handlers.GET(new Request(origin + path, { headers: { accept: "text/html,*/*;q=0.8" } }));
      const body = await response.text();
      const preload = `<link rel="preload" href="/p/${token}/manifest.json" as="fetch" crossorigin>`;
      if (response.status !== 200 || response.headers.get("cache-control") !== "private, no-store" || !body.includes("<section data-explore-agent-index")
        || !body.includes(preload) || body.replace(preload, "").replace(/<div id="root">.*<\/div>/s, '<div id="root"></div>') !== stagedHtml) {
        throw new Error(`Preview page ${path} must serve the complete staged Viewer carrying the agent index`);
      }
      const markdown = await handlers.GET(new Request(origin + path));
      if (markdown.status !== 200 || !markdown.headers.get("content-type").startsWith("text/markdown") || !(await markdown.text()).startsWith("# Expo Explore report")) {
        throw new Error(`Preview page ${path} must serve the Markdown index when HTML is not requested`);
      }
    }
    const summary = await handlers.GET(new Request(`${origin}/p/${token}/api/v1`));
    if (summary.status !== 200 || (await summary.json()).kind !== "pr-review") throw new Error(`Preview route ${page} must answer the agent API summary`);
    const changed = await handlers.GET(new Request(`${origin}/p/${token}/api/v1/screens?status=modified`));
    if (changed.status !== 200 || !((await changed.json()).total > 0)) throw new Error(`Preview route ${page} must list modified screens`);
    if (!(await (await handlers.GET(new Request(`${origin}/p/${token}/llms.txt`))).text()).startsWith("# Expo Explore report")) throw new Error(`Preview route ${page} must serve llms.txt`);
    const zip = await handlers.GET(new Request(`${origin}/p/${token}/report.zip`));
    if (zip.status !== 200 || zip.headers.get("content-type") !== "application/zip"
      || Buffer.compare(Buffer.from(await zip.arrayBuffer()), Buffer.from(plain)) !== 0) {
      throw new Error(`Preview report route ${page} must stream the decrypted report`);
    }
    for (const path of [`/p/${token.replace("a", "b")}`, `/p/${token.replace("a", "b")}/report.zip`, `/p/${token.replace("a", "b")}/api/v1`, `/p/${token}/viewer/index.html`, `/p/${token}/other`, `/p/${token}/api/v1/other`, `/p/${token}/api/v2`, "/p/", `/P/${token}`]) {
      if ((await handlers.GET(new Request(origin + path))).status !== 404) throw new Error(`Preview route ${page} incorrectly accepts ${path}`);
    }
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      if ((await handlers[method](new Request(`${origin}/p/${token}`, { method }))).status !== 404) throw new Error(`Preview route ${page} must answer 404 to ${method}`);
    }
    const expired = loadRoute(page, { ...env, EXPLORE_PREVIEW_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() }, globals);
    if ((await expired.GET(new Request(`${origin}/p/${token}`, { headers: { accept: "text/html" } }))).status !== 200) throw new Error(`Preview route ${page} must keep opening the Viewer after expiry`);
    for (const path of [`/p/${token}`, `/p/${token}/report.zip`, `/p/${token}/api/v1`, `/p/${token}/llms.txt`]) {
      if ((await expired.GET(new Request(origin + path))).status !== 410) throw new Error(`Preview route ${page} must answer 410 for ${path} after expiry`);
    }
    const unsealed = loadRoute(page, {}, globals);
    if ((await unsealed.GET(new Request(`${origin}/p/${token}`))).status !== 404) throw new Error(`Preview route ${page} must refuse to serve without a sealed configuration`);
  }
  if (fetched.some(href => !href.endsWith(reportPath))) throw new Error("Preview routes fetched something other than the sealed report path");
}

process.stdout.write(
  `Verified exported ${variant} Viewer (${exported.files.length} files, ${exported.totalBytes} bytes) and ${actualApiRoutes.size} API routes\n`,
);
