import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto, createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PREVIEW_CIPHER, previewResponse, type PreviewEnvironment } from "../src/server/preview";
import { agentApiReply, agentIndexMarkdown, loadReport, prefersHtml, prefersMarkdown } from "../../src/report/agent-api";
import { readZipDirectory } from "../../src/report/zip-reader";

const subtle = webcrypto.subtle as SubtleCrypto;
const token = "abcdefghijklmnopqrstuvwxyz234567";
const origin = "https://acme-explore--k7f3z0d1q8.expo.app";
const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/viewer/assets/main.js"></script></body></html>';
const keyBytes: Uint8Array<ArrayBuffer> = webcrypto.getRandomValues(new Uint8Array(32));
const review = new Uint8Array(readFileSync(new URL("../../test/fixtures/example-review-artifact.zip", import.meta.url))) as Uint8Array<ArrayBuffer>;

async function sealed(plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(PREVIEW_CIPHER.ivBytes));
  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(PREVIEW_CIPHER.aad) }, key, plain));
  const out = new Uint8Array(iv.byteLength + cipher.byteLength);
  out.set(iv); out.set(cipher, iv.byteLength);
  return out;
}

/** A ZIP the way zipReportDirectory writes one: the JSON deflated, PNGs stored. */
function zip(files: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const method = name.endsWith(".json") ? 8 : 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const nameBytes = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + nameBytes.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, method, true); lv.setUint32(18, stored.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const header = new Uint8Array(46 + nameBytes.length), cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, method, true); cv.setUint32(20, stored.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    chunks.push(local, stored); central.push(header);
    offset += local.length + stored.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + 22);
  let cursor = 0;
  for (const part of [...chunks, ...central, end]) { out.set(part, cursor); cursor += part.length; }
  return out;
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pngSha = createHash("sha256").update(png).digest("hex");
const explorationReport = {
  kind: "explore.exploration-report",
  coverage: { screens: 2 },
  exploration: { app: { name: "Euxy", bundleId: "dev.expo.euxy", platform: "ios", version: "1.2.0" }, device: { model: "iPhone 16", osVersion: "18.0" }, model: { provider: "openai", model: "gpt-5" }, startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:10:00Z", stopReason: "budget", summary: "Mapped the sequencer." },
  map: {
    contract: "explore.map.v1",
    screens: [
      { id: "s-home", title: "Home", route: "/", start: true, terminal: false, depth: 0, visits: 3, variantIds: ["v1"], observationIds: ["o1"], elementIds: ["e1"] },
      { id: "s-settings", title: "Settings", route: "/settings", start: false, terminal: true, depth: 1, visits: 1, variantIds: [], observationIds: [], elementIds: [] },
    ],
    variants: [{ id: "v1", screenId: "s-home", key: "default", observationIds: ["o1"] }],
    observations: [{ id: "o1", screenId: "s-home", screenshotArtifactId: "a1" }],
    artifacts: [{ id: "a1", kind: "screenshot", path: `assets/${pngSha}.png`, sha256: pngSha, mimeType: "image/png", createdAt: "2026-10-01T00:00:01Z" }],
    elements: [{ id: "e1", screenId: "s-home", role: "button", label: "Open settings", actions: ["tap"], risk: "safe", actionable: true, bounds: { x: 0, y: 0, width: 10, height: 10 }, occurrence: 1, controller: "maestro", firstSeenObservationId: "o1", lastSeenObservationId: "o1", observationIds: ["o1"] }],
    actionAttempts: [],
    transitions: [{ id: "t1", fromScreenId: "s-home", toScreenId: "s-settings", actionKind: "tap", elementId: "e1", attemptIds: ["at1"] }],
    journeys: [{ id: "j1", title: "Open settings", screenIds: ["s-home", "s-settings"], transitionIds: ["t1"] }],
    frontier: [{ id: "f1", screenId: "s-settings", label: "Back", actionKind: "tap", risk: "safe", depth: 1, priority: 1, status: "pending" }],
    gaps: [{ id: "g1", kind: "authentication", status: "open", message: "Login wall", screenId: "s-settings", createdAt: "2026-10-01T00:05:00Z" }],
  },
};
const explorationZip = zip({ "exploration.json": new TextEncoder().encode(JSON.stringify(explorationReport)), [`assets/${pngSha}.png`]: png });

function deployment(files: Record<string, Uint8Array<ArrayBuffer>>, env: PreviewEnvironment, now?: () => number) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const body = files[url.pathname];
    return body ? new Response(body, { headers: { "content-length": String(body.byteLength) } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const options = { env, indexHtml: html, fetchImpl, subtle, cache: new Map(), ...(now ? { now } : {}) };
  return { calls, get: (path: string, accept?: string) => previewResponse(new Request(`${origin}/p/${token}${path}`, accept === undefined ? {} : { headers: { accept } }), options) };
}

const reviewEnv: PreviewEnvironment = { EXPLORE_PREVIEW_TOKEN: token, EXPLORE_PREVIEW_KEY: Buffer.from(keyBytes).toString("base64"), EXPLORE_PREVIEW_EXPIRES_AT: "2030-01-01T00:00:00Z", EXPLORE_PREVIEW_REPORT: "/_report/abcdefghijklmnop/report.zip.enc" };

test("the archive reader accepts the deployed layout and rejects everything else", async () => {
  assert.ok(readZipDirectory(review)?.has("review.json"));
  assert.equal(readZipDirectory(new TextEncoder().encode("PK\u0003\u0004 not an archive")), undefined);
  assert.equal(await loadReport(zip({ "notes.txt": png })), undefined);
  assert.equal(await loadReport(zip({ "review.json": new TextEncoder().encode('{"review":{"contract":"other"}}') })), undefined);
  assert.equal((await loadReport(review))?.kind, "pr-review");
  assert.equal((await loadReport(explorationZip))?.kind, "exploration");
});

test("the token page negotiates: browsers get the shell carrying the agent index, everything else gets Markdown", async () => {
  const site = deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: await sealed(review) }, reviewEnv);
  const browser = await site.get("?view=compare&screen=home", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get("content-type") ?? "", /^text\/html/);
  const shell = await browser.text();
  assert.ok(shell.startsWith("<!doctype html>"));
  assert.match(shell, /<div id="root"><section data-explore-agent-index style="[^"]*clip:rect\(0 0 0 0\)[^"]*"><h1>Expo Explore report: .* PR #\d+/);
  assert.match(shell, new RegExp(`href="${origin}/p/${token}/api/v1/screens\\?status=modified,accessibility-only,added,removed"`));
  assert.match(shell, /<\/section><\/div><script type="module"/);
  assert.equal(browser.headers.get("vary"), "Accept");
  assert.equal(browser.headers.get("link"), `<${origin}/p/${token}/api/v1>; rel="alternate"; type="application/json", <${origin}/p/${token}/llms.txt>; rel="alternate"; type="text/markdown"`);
  assert.equal(browser.headers.get("cache-control"), "private, no-store");
  assert.equal(browser.headers.get("x-robots-tag"), "noindex, nofollow");

  for (const accept of [undefined, "*/*", "text/markdown, text/html, */*", "application/json"]) {
    const response = await site.get("", accept);
    assert.equal(response.status, 200, String(accept));
    assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/, String(accept));
    const body = await response.text();
    assert.match(body, /^# Expo Explore report: /, String(accept));
    assert.match(body, /This link stops serving the report after 2030-01-01T00:00:00.000Z/);
    assert.ok(body.includes(`(${origin}/p/${token}/api/v1/screens?status=modified,accessibility-only,added,removed)`), body);
    assert.equal(response.headers.get("content-security-policy"), browser.headers.get("content-security-policy"));
  }
  const llms = await site.get("/llms.txt", "text/html");
  assert.match(llms.headers.get("content-type") ?? "", /^text\/markdown/);
  assert.equal(await llms.text(), await (await site.get("")).text());
  // The sealed file is decrypted and parsed once per isolate, not once per request.
  assert.deepEqual(site.calls, [`${origin}${reviewEnv.EXPLORE_PREVIEW_REPORT}`]);
});

test("the API serves a PR review: summary, filtered and paged screens, detail, transitions, assets, raw", async () => {
  const site = deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: await sealed(review) }, reviewEnv);
  const summary = await (await site.get("/api/v1")).json();
  assert.equal(summary.kind, "pr-review");
  assert.equal(summary.contract, "explore.review");
  assert.equal(typeof summary.pullRequest.number, "number");
  assert.equal(summary.platforms.length, 1);
  assert.ok(summary.screens.total > 0 && summary.screens.modified > 0, JSON.stringify(summary.screens));
  assert.equal(summary.links.screens, `${origin}/p/${token}/api/v1/screens`);
  assert.equal(summary.links.viewer, `${origin}/p/${token}`);
  assert.equal(summary.links.viewerChanges, `${origin}/p/${token}?focus=modified&inspect=diff`);
  const markdownSummary = await site.get("/api/v1/", "text/markdown");
  assert.match(await markdownSummary.text(), /^# Expo Explore report/);

  const all = await (await site.get("/api/v1/screens")).json();
  assert.equal(all.total, summary.screens.total);
  assert.equal(all.count, Math.min(50, all.total));
  const modified = await (await site.get("/api/v1/screens?status=modified&limit=2")).json();
  assert.equal(modified.total, summary.screens.modified);
  assert.equal(modified.count, Math.min(2, modified.total));
  assert.equal(modified.hasMore, modified.total > 2);
  if (modified.hasMore) {
    const next = await (await site.get(`/api/v1/screens?status=modified&limit=2&cursor=${modified.nextCursor}`)).json();
    assert.equal(next.items[0].id !== modified.items[0].id, true);
  }
  const item = modified.items[0];
  assert.equal(item.status, "modified");
  assert.equal(typeof item.route, "string");
  assert.equal(typeof item.review.description, "string");
  assert.equal(item.viewerUrl, `${origin}/p/${token}?view=compare&screen=${encodeURIComponent(item.id)}`);
  assert.match(item.headImage, new RegExp(`^${origin}/p/${token}/api/v1/assets/[a-f0-9]{64}$`));
  const table = await (await site.get("/api/v1/screens?status=modified", "text/markdown")).text();
  assert.match(table, /^# Screens \(\d+ of \d+\)\n\n\| Screen \| Status \| Review/);
  assert.ok(table.includes(item.route));

  const detail = await (await site.get(`/api/v1/screens/${item.id}`)).json();
  assert.equal(detail.id, item.id);
  assert.ok(Array.isArray(detail.navigation.out) && Array.isArray(detail.navigation.in) && detail.flows === undefined);
  assert.ok(Array.isArray(detail.head.sourceFiles));
  assert.equal((await site.get("/api/v1/screens/does-not-exist")).status, 404);
  assert.equal((await site.get("/api/v1/screens/../etc")).status, 404);
  assert.equal((await site.get("/api/v1/screens?limit=0")).status, 400);
  assert.equal((await site.get("/api/v1/screens?limit=201")).status, 400);
  assert.equal((await site.get("/api/v1/screens?cursor=-1")).status, 400);

  const transitions = await (await site.get("/api/v1/transitions")).json();
  assert.ok(transitions.total > 0 && typeof transitions.items[0].from === "string");
  const from = await (await site.get(`/api/v1/transitions?from=${encodeURIComponent(transitions.items[0].from)}`)).json();
  assert.ok(from.items.every((edge: { from: string }) => edge.from === transitions.items[0].from));
  const target = (await (await site.get(`/api/v1/screens/${transitions.items[0].to}`)).json()) as { id: string; route: string };
  const byId = await (await site.get(`/api/v1/transitions?to=${encodeURIComponent(target.id)}`)).json();
  const byRoute = await (await site.get(`/api/v1/transitions?to=${encodeURIComponent(target.route)}`)).json();
  assert.ok(byId.total > 0 && byId.total === byRoute.total);
  for (const missing of ["/api/v1/flows", "/api/v1/gaps", "/api/v1/frontier", "/api/v1/journeys", "/api/v1/nope", "/api/v1/screens/a/b", "/api/v2", "/api"]) {
    assert.equal((await site.get(missing)).status, 404, missing);
  }

  const sha = item.headImage.slice(-64);
  const asset = await site.get(`/api/v1/assets/${sha}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.equal(asset.headers.get("etag"), `"${sha}"`);
  const bytes = new Uint8Array(await asset.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
  assert.equal((await site.get(`/api/v1/assets/${"0".repeat(64)}`)).status, 404);
  assert.equal((await site.get(`/api/v1/assets/${sha.slice(1)}`)).status, 404);

  const raw = await site.get("/api/v1/raw");
  assert.equal(raw.status, 200);
  assert.equal((await raw.json()).review.contract, "explore.review", "raw is the file as written, review nested under `review`");
  assert.deepEqual(site.calls, [`${origin}${reviewEnv.EXPLORE_PREVIEW_REPORT}`]);
});

test("the API serves an exploration: screens with elements and transitions, journeys, gaps, frontier", async () => {
  const site = deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: await sealed(explorationZip) }, reviewEnv);
  const index = await (await site.get("")).text();
  assert.match(index, /^# Expo Explore exploration: Euxy \(ios\)/);
  assert.ok(index.includes("mapped 2 screens, 1 transitions, 1 elements; 1 coverage gaps. Stopped: budget. Mapped the sequencer."), index);
  const summary = await (await site.get("/api/v1")).json();
  assert.equal(summary.kind, "exploration");
  assert.deepEqual(summary.app, { name: "Euxy", bundleId: "dev.expo.euxy", platform: "ios", version: "1.2.0", device: "iPhone 16 18.0" });
  assert.deepEqual(summary.counts, { transitions: 1, elements: 1, journeys: 1, gaps: 1, frontier: 1 });
  const screens = await (await site.get("/api/v1/screens")).json();
  assert.equal(screens.total, 2);
  assert.deepEqual(screens.items[0], { id: "s-home", title: "Home", route: "/", start: true, terminal: false, depth: 0, visits: 3, variants: 1, elements: 1, transitionsOut: 1, transitionsIn: 0, screenshot: `${origin}/p/${token}/api/v1/assets/${pngSha}`, viewerUrl: `${origin}/p/${token}?screen=s-home` });
  const home = await (await site.get("/api/v1/screens/s-home")).json();
  assert.deepEqual(home.elements, [{ id: "e1", label: "Open settings", role: "button", bounds: { x: 0, y: 0, width: 10, height: 10 }, actions: ["tap"], risk: "safe", actionable: true }]);
  assert.deepEqual(home.transitions.out, [{ id: "t1", from: "s-home", to: "s-settings", actionKind: "tap", elementId: "e1", attempts: 1 }]);
  const settings = await (await site.get("/api/v1/screens/s-settings")).json();
  assert.deepEqual(settings.gaps, [{ id: "g1", kind: "authentication", status: "open", message: "Login wall", screenId: "s-settings" }]);
  assert.equal((await (await site.get("/api/v1/transitions?to=s-settings")).json()).total, 1);
  assert.deepEqual((await (await site.get("/api/v1/journeys")).json()).items, [{ id: "j1", title: "Open settings", screenIds: ["s-home", "s-settings"], transitionIds: ["t1"] }]);
  assert.equal((await (await site.get("/api/v1/gaps")).json()).total, 1);
  assert.equal((await (await site.get("/api/v1/frontier")).json()).items[0].label, "Back");
  assert.equal((await site.get("/api/v1/flows")).status, 404);
  const asset = await site.get(`/api/v1/assets/${pngSha}`);
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), png);
  assert.deepEqual(await (await site.get("/api/v1/raw")).json(), explorationReport);
});

test("expiry, platforms and wrong tokens behave like the report routes", async () => {
  const after = () => Date.parse("2030-01-01T00:00:00Z");
  const expired = deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: await sealed(review) }, reviewEnv, after);
  const shell = await expired.get("", "text/html");
  assert.equal(shell.status, 200);
  assert.equal(await shell.text(), html, "the expired shell carries no report data");
  assert.equal((await expired.get("/api/v1/screens/", "text/html")).status, 410);
  for (const path of ["", "/llms.txt", "/api/v1", "/api/v1/screens", `/api/v1/assets/${"a".repeat(64)}`]) {
    const response = await expired.get(path);
    assert.equal(response.status, 410, path);
    assert.deepEqual(await response.json(), { error: "expired", expiredAt: "2030-01-01T00:00:00.000Z" });
  }
  assert.deepEqual(expired.calls, []);

  const multiEnv: PreviewEnvironment = { ...reviewEnv, EXPLORE_PREVIEW_REPORT: undefined, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ platform: "ios", path: "/_report/abcdefghijklmnop/ios.zip.enc" }, { platform: "android", path: "/_report/abcdefghijklmnop/android.zip.enc" }]) };
  const multi = deployment({ "/_report/abcdefghijklmnop/ios.zip.enc": await sealed(review), "/_report/abcdefghijklmnop/android.zip.enc": await sealed(explorationZip) }, multiEnv);
  const ios = await (await multi.get("/api/v1")).json();
  assert.equal(ios.kind, "pr-review");
  assert.deepEqual(ios.platforms, ["ios", "android"]);
  assert.equal(ios.links.screens, `${origin}/p/${token}/api/v1/screens?platform=ios`);
  assert.equal(ios.links.viewer, `${origin}/p/${token}?platform=ios`);
  const android = await (await multi.get("/api/v1?platform=android")).json();
  assert.equal(android.kind, "exploration");
  assert.equal(android.links.screens, `${origin}/p/${token}/api/v1/screens?platform=android`);
  assert.equal((await (await multi.get("/api/v1/screens/s-home?platform=android")).json()).screenshot, `${origin}/p/${token}/api/v1/assets/${pngSha}?platform=android`);
  assert.match(await (await multi.get("?platform=android")).text(), /^# Expo Explore exploration/);
  assert.equal((await multi.get("/api/v1?platform=web")).status, 404);
  assert.equal((await multi.get("/api/v1?platform=ios&platform=android")).status, 404);
  assert.equal(multi.calls.length, 2, "each platform's report is decrypted once");

  const wrongToken = token.replace(/a/, "b");
  const site = deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: await sealed(review) }, reviewEnv);
  for (const path of [`/p/${wrongToken}/api/v1`, `/p/${wrongToken}/llms.txt`, `/p/${token}/API/v1`, `/p/${token}/api/v1//screens`]) {
    const response = await previewResponse(new Request(`${origin}${path}`), { env: reviewEnv, indexHtml: html, fetchImpl: fetch, subtle, cache: new Map() });
    assert.equal(response.status, 404, path);
  }
  assert.equal((await site.get("/api/v1", undefined)).status, 200);
});

test("Accept negotiation honours quality values and listing order, and wildcards never prefer HTML", () => {
  assert.equal(prefersHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), true);
  assert.equal(prefersHtml("text/markdown, text/html, */*"), false);
  assert.equal(prefersHtml("text/html, text/markdown, */*"), true);
  assert.equal(prefersHtml("text/markdown;q=0.1, text/html;q=0.9"), true);
  assert.equal(prefersHtml("text/html;q=0.1, text/markdown;q=0.9"), false);
  assert.equal(prefersHtml("text/html;q=0, */*"), false);
  assert.equal(prefersHtml("text/html;q=0.5, application/json"), false);
  assert.equal(prefersHtml("*/*"), false);
  assert.equal(prefersHtml("text/*"), false);
  assert.equal(prefersHtml(null), false);
  assert.equal(prefersHtml("application/xhtml+xml;q=0.9, text/markdown;q=0.8"), true);
  assert.equal(prefersMarkdown("text/markdown"), true);
  assert.equal(prefersMarkdown("application/json, text/markdown"), false);
  assert.equal(prefersMarkdown("application/json;q=0.5, text/markdown;q=0.9"), true);
  assert.equal(prefersMarkdown("text/markdown;q=0"), false);
  assert.equal(prefersMarkdown("*/*"), false);
});

test("screens count and filter by what changed visibly: a source change with matching captures is unchanged, even from an older report", async () => {
  const surface = (id: string, status: string, review: { status: string; description: string }) =>
    ({ id, status, sourceScope: "screen", head: { route: `/${id}`, kind: "screen" }, base: { route: `/${id}`, kind: "screen" }, review });
  const report = { kind: "explore.report", review: { contract: "explore.review", pullRequest: { origin: "local", repository: "a/b", title: "HEAD vs main", base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "HEAD", sha: "b".repeat(40) } },
    runtime: { platform: "ios" }, surfaces: [
      surface("tempo", "modified", { status: "modified", description: "Added text “Beat pulse”." }),
      surface("enable-midi", "modified", { status: "needs-review", description: "Source changed; no visible difference was captured." }),
      surface("lane-editor", "modified", { status: "needs-review", description: "Visual comparison was inconclusive" }),
    ] }, assets: [] };
  const loaded = (await loadReport(zip({ "review.json": new TextEncoder().encode(JSON.stringify(report)) })))!;
  const context = { pageUrl: "http://127.0.0.1:1/p/t", platforms: ["ios"], expiresAt: null };
  const summary = JSON.parse((await agentApiReply(context, loaded, "", new URLSearchParams(), "application/json")).body as string);
  assert.deepEqual(summary.screens, { total: 3, modified: 1, unchanged: 1, "needs-review": 1 });
  const modified = JSON.parse((await agentApiReply(context, loaded, "/screens", new URLSearchParams("status=modified"), "application/json")).body as string);
  assert.deepEqual(modified.items.map((item: { id: string }) => item.id), ["tempo"]);
  const all = JSON.parse((await agentApiReply(context, loaded, "/screens", new URLSearchParams(), "application/json")).body as string);
  const midi = all.items.find((item: { id: string }) => item.id === "enable-midi");
  assert.deepEqual([midi.status, midi.sourceStatus], ["unchanged", "modified"], "its source status is still there");
});

test("statuses follow the Viewer: accessibility-only, unavailable for a failed or misattributed capture, not-compared for the rest", async () => {
  const side = (id: string) => ({ route: `/${id}`, kind: "screen" });
  const verified = { status: "captured", landing: "verified", attempts: 1 };
  const surface = (id: string, verdict: string) => ({ id, status: "modified", sourceScope: "screen", head: side(id), base: side(id),
    headImage: { sha256: "c".repeat(64) }, baseImage: { sha256: "c".repeat(64) }, headOutcome: verified, baseOutcome: verified,
    review: { status: "modified", description: "Added button “Edit tempo”." }, visual: { verdict, reason: "matched", threshold: 0.1, tool: "agent-device" } });
  const report = { kind: "explore.report", review: { contract: "explore.review", pullRequest: { origin: "local", repository: "a/b", title: "HEAD vs main", base: { ref: "main", sha: "a".repeat(40) }, head: { ref: "HEAD", sha: "b".repeat(40) } },
    runtime: { platform: "ios" }, surfaces: [surface("tempo", "modified"), surface("device-picker", "unchanged"),
      // Its source changed but nothing was compared: not a change Explore saw.
      { id: "c-explore", status: "modified", sourceScope: "screen", head: side("c/_explore"), base: side("c/_explore") },
      // Its head capture failed, and another landed on the wrong screen: both unavailable, as the Viewer says.
      { id: "cards", status: "modified", sourceScope: "screen", head: side("cards"), base: side("cards"), baseImage: { sha256: "c".repeat(64) },
        baseOutcome: verified, headOutcome: { status: "failed", attempts: 1, landing: "unverified" } },
      { id: "login", status: "modified", sourceScope: "screen", head: side("login"), base: side("login"), ...{ baseImage: { sha256: "c".repeat(64) }, headImage: { sha256: "c".repeat(64) } },
        baseOutcome: verified, headOutcome: { status: "captured", attempts: 2, landing: "unverified", observed: { reason: "landing-mismatch", route: "/home", attempts: 2 } } }] }, assets: [] };
  const loaded = (await loadReport(zip({ "review.json": new TextEncoder().encode(JSON.stringify(report)) })))!;
  const context = { pageUrl: "http://127.0.0.1:1/p/t", platforms: ["ios"], expiresAt: null };
  const summary = JSON.parse((await agentApiReply(context, loaded, "", new URLSearchParams(), "application/json")).body as string);
  assert.deepEqual(summary.screens, { total: 5, modified: 1, "accessibility-only": 1, "not-compared": 1, unavailable: 2 });
  const unavailable = JSON.parse((await agentApiReply(context, loaded, "/screens", new URLSearchParams("status=unavailable"), "application/json")).body as string);
  assert.deepEqual(unavailable.items.map((item: { id: string }) => item.id), ["cards", "login"]);
  // The index sentence names every status, so its parts add up to the total.
  assert.match(agentIndexMarkdown(context, loaded), /5 screens: 1 modified, 1 accessibility only \(screenshots match, the accessibility tree does not\), 2 unavailable, 1 not compared\./);
  assert.match(summary.links.changed, /status=modified,accessibility-only,added,removed/);
  const only = JSON.parse((await agentApiReply(context, loaded, "/screens", new URLSearchParams("status=accessibility-only"), "application/json")).body as string);
  assert.deepEqual(only.items.map((item: { id: string; status: string; sourceStatus: string }) => [item.id, item.status, item.sourceStatus]), [["device-picker", "accessibility-only", "modified"]]);
});
