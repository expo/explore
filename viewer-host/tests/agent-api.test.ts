import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { previewResponse, type PreviewEnvironment } from "../src/server/preview";
import { agentApiReply, agentIndexMarkdown, loadReport, prefersHtml, prefersMarkdown } from "../../src/report/agent-api";
import { manifestBody, MAX_MANIFEST_BYTES, reportFromManifest } from "../../src/report/preview-manifest";
import { readZipDirectory } from "../../src/report/zip-reader";

const token = "abcdefghijklmnopqrstuvwxyz234567";
const origin = "https://acme-explore--k7f3z0d1q8.expo.app";
const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/viewer/assets/main.js"></script></body></html>';
const review = new Uint8Array(readFileSync(new URL("../../test/fixtures/example-review-artifact.zip", import.meta.url))) as Uint8Array<ArrayBuffer>;


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

/** A hosted preview as ci:deploy writes it: each target's manifest at its path, and every asset once under the token. */
async function deployment(reports: Record<string, Uint8Array>, env: PreviewEnvironment) {
  const files: Record<string, Uint8Array> = {};
  for (const [path, archive] of Object.entries(reports)) {
    const loaded = (await loadReport(archive))!;
    files[path] = new TextEncoder().encode(manifestBody(loaded));
    for (const name of loaded.entries.keys()) if (name.startsWith("assets/") && !name.endsWith("/")) files[`/p/${token}/${name}`] = (await loaded.read(name, 64 * 1024 * 1024))!;
  }
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const body = files[url.pathname];
    return body ? new Response(body as BodyInit, { headers: { "content-length": String(body.byteLength) } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  const options = { env, indexHtml: html, fetchImpl, cache: new Map(), loading: new Map() };
  return { calls, files, cache: options.cache, get: (path: string, accept?: string) => previewResponse(new Request(`${origin}/p/${token}${path}`, accept === undefined ? {} : { headers: { accept } }), options) };
}

const reviewEnv: PreviewEnvironment = { EXPLORE_PREVIEW_TOKEN: token, EXPLORE_PREVIEW_REPORT: `/p/${token}/targets/report.json` };

test("the archive reader accepts the deployed layout and rejects everything else", async () => {
  assert.ok(readZipDirectory(review)?.has("review.json"));
  assert.equal(readZipDirectory(new TextEncoder().encode("PK\u0003\u0004 not an archive")), undefined);
  assert.equal(await loadReport(zip({ "notes.txt": png })), undefined);
  assert.equal(await loadReport(zip({ "review.json": new TextEncoder().encode('{"review":{"contract":"other"}}') })), undefined);
  assert.equal((await loadReport(review))?.kind, "pr-review");
  assert.equal((await loadReport(explorationZip))?.kind, "exploration");
});

test("the token page negotiates: browsers get the shell carrying the agent index, everything else gets Markdown", async () => {
  const site = await deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: review }, reviewEnv);
  const browser = await site.get("?view=compare&screen=home", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  assert.equal(browser.status, 200);
  assert.match(browser.headers.get("content-type") ?? "", /^text\/html/);
  const shell = await browser.text();
  assert.ok(shell.startsWith("<!doctype html>"));
  assert.match(shell, /<div id="root"><section data-explore-agent-index style="[^"]*clip:rect\(0 0 0 0\)[^"]*"><h1>Expo Explore report: .* PR #\d+/);
  assert.match(shell, new RegExp(`href="${origin}/p/${token}/api/v1/screens\\?status=modified,accessibility-only,added,removed"`));
  assert.match(shell, /<\/section><\/div><link rel="preload" [^>]*><script type="module"/);
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
    assert.ok(!body.includes("stops serving"), "a hosted preview lasts as long as its deployment; the index names no expiry");
    assert.ok(body.includes(`(${origin}/p/${token}/api/v1/screens?status=modified,accessibility-only,added,removed)`), body);
    assert.equal(response.headers.get("content-security-policy"), browser.headers.get("content-security-policy"));
  }
  const llms = await site.get("/llms.txt", "text/html");
  assert.match(llms.headers.get("content-type") ?? "", /^text\/markdown/);
  assert.equal(await llms.text(), await (await site.get("")).text());
  // The static manifest is fetched and parsed once per isolate, not once per request.
  assert.deepEqual(site.calls, [`${origin}${reviewEnv.EXPLORE_PREVIEW_REPORT}`]);
});

test("the API serves a PR review: summary, filtered and paged screens, detail, transitions, assets, raw", async () => {
  const site = await deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: review }, reviewEnv);
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
  const rawBytes = new Uint8Array(await raw.arrayBuffer());
  assert.deepEqual(rawBytes, (await loadReport(review))!.raw, "raw is review.json byte for byte, as the ZIP held it");
  assert.equal(JSON.parse(new TextDecoder().decode(rawBytes)).review.contract, "explore.review");
  // The manifest once, and the one screenshot asked for, read from the same static file the Viewer loads.
  assert.deepEqual(site.calls, [`${origin}${reviewEnv.EXPLORE_PREVIEW_REPORT}`, `${origin}/p/${token}/assets/${sha}.png`]);
});

test("the API serves an exploration: screens with elements and transitions, journeys, gaps, frontier", async () => {
  const site = await deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: explorationZip }, reviewEnv);
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

test("platforms and wrong tokens behave like the report routes", async () => {
  const multiEnv: PreviewEnvironment = { ...reviewEnv, EXPLORE_PREVIEW_REPORT: undefined, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ platform: "ios", path: `/p/${token}/targets/ios.json` }, { platform: "android", path: `/p/${token}/targets/android.json` }]) };
  const multi = await deployment({ [`/p/${token}/targets/ios.json`]: review, [`/p/${token}/targets/android.json`]: explorationZip }, multiEnv);
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
  assert.equal(multi.calls.length, 2, "each platform's manifest is fetched once");

  const wrongToken = token.replace(/a/, "b");
  const site = await deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: review }, reviewEnv);
  for (const path of [`/p/${wrongToken}/api/v1`, `/p/${wrongToken}/llms.txt`, `/p/${token}/API/v1`, `/p/${token}/api/v1//screens`]) {
    const response = await previewResponse(new Request(`${origin}${path}`), { env: reviewEnv, indexHtml: html, fetchImpl: fetch, cache: new Map() });
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

test("a deployment of several targets keeps each target in its links and names the others in the index", async () => {
  const listing = [
    { target: "iphone", platform: "ios", label: "iPhone 17", path: `/p/${token}/targets/iphone.json` },
    { target: "duo-open", platform: "ios", label: "iPhone Duo (open)", path: `/p/${token}/targets/duo-open.json` },
    { target: "android", platform: "android", label: "Android", path: `/p/${token}/targets/android.json` },
  ];
  const targetsEnv: PreviewEnvironment = { ...reviewEnv, EXPLORE_PREVIEW_REPORT: undefined, EXPLORE_PREVIEW_REPORTS: JSON.stringify(listing) };
  const site = await deployment({ [listing[0]!.path]: review, [listing[1]!.path]: review, [listing[2]!.path]: explorationZip }, targetsEnv);
  const duo = await (await site.get("/api/v1?target=duo-open")).json();
  assert.equal(duo.kind, "pr-review");
  assert.deepEqual(duo.platforms, ["ios", "android"], "distinct platforms, as before targets");
  assert.equal(duo.target, "duo-open");
  assert.deepEqual(duo.targets.map((target: { id: string; current?: boolean }) => [target.id, target.current ?? false]), [["iphone", false], ["duo-open", true], ["android", false]]);
  assert.equal(duo.targets[2].viewer, `${origin}/p/${token}?platform=android`, "a target named after its platform keeps ?platform=");
  assert.equal(duo.targets[0].summary, `${origin}/p/${token}/api/v1?target=iphone`);
  assert.equal(duo.links.screens, `${origin}/p/${token}/api/v1/screens?target=duo-open`);
  assert.equal(duo.links.viewer, `${origin}/p/${token}?target=duo-open`);
  const first = await (await site.get("/api/v1")).json();
  assert.equal(first.target, "iphone");
  assert.equal(first.links.viewer, `${origin}/p/${token}?target=iphone`);
  const index = await (await site.get("?target=duo-open")).text();
  assert.match(index, /^# Expo Explore report: .+ \(iPhone Duo \(open\)\)$/m);
  assert.ok(index.includes(`- [iPhone 17](${origin}/p/${token}?target=iphone) (ios)`), index);
  assert.ok(index.includes(`- [Android](${origin}/p/${token}?platform=android) (android)`), index);
  assert.ok(!index.includes(`- [iPhone Duo (open)]`), "the index does not list its own target among the others");
  assert.equal((await (await site.get("/api/v1?platform=android")).json()).kind, "exploration");
  assert.equal((await site.get("/api/v1?target=pixel")).status, 404);
});

test("the manifest route answers each target's static manifest, the shell preloads it, and screenshots are not the Worker's", async () => {
  const site = await deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: review }, reviewEnv);
  const shell = await (await site.get("", "text/html")).text();
  assert.ok(shell.includes(`<link rel="preload" href="/p/${token}/manifest.json" as="fetch" crossorigin><script type="module"`), shell.slice(0, 400));
  const linked = await (await site.get("?target=ios&view=compare", "text/html")).text();
  assert.ok(linked.includes(`<link rel="preload" href="/p/${token}/manifest.json?platform=ios" as="fetch" crossorigin>`), linked.slice(0, 400));

  const manifest = await site.get("/manifest.json");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(manifest.headers.get("cache-control"), "private, no-store");
  assert.equal(await manifest.text(), new TextDecoder().decode(site.files[reviewEnv.EXPLORE_PREVIEW_REPORT!]), "the static manifest, byte for byte");
  // Screenshots are static files EAS Hosting serves itself; a path the deployment does not hold is the Worker's 404.
  for (const path of ["/assets/" + "0".repeat(64) + ".png", "/report.zip", "/targets/report.json"]) {
    assert.equal((await site.get(path)).status, 404, path);
  }
});

test("a ZIP's directory records are not assets: the manifest the Viewer validates names files only", async () => {
  const withDirectory = zip({ "exploration.json": new TextEncoder().encode(JSON.stringify(explorationReport)), "assets/": new Uint8Array(), [`assets/${pngSha}.png`]: png });
  assert.ok(readZipDirectory(withDirectory)!.has("assets/"));
  assert.deepEqual(JSON.parse(manifestBody((await loadReport(withDirectory))!)).entries, { [`assets/${pngSha}.png`]: png.byteLength });
  assert.equal(JSON.parse(manifestBody((await loadReport(withDirectory))!, "abc")).deployment, "abc", "a deployment stamps the manifests it writes");
});

test("a static file the Worker cannot fetch this time answers 503, which the Viewer retries; one that is not there is a 404", async () => {
  const flaky = (status: number) => (path: string) => previewResponse(new Request(`${origin}/p/${token}${path}`), {
    env: reviewEnv, indexHtml: html, cache: new Map(), loading: new Map(), fetchImpl: (async () => new Response("upstream", { status })) as typeof fetch });
  for (const path of ["/manifest.json", "/api/v1", "/llms.txt"]) {
    const response = await flaky(502)(path);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await flaky(404)(path)).status, 404, path);
  }
  // The shell still opens; the Viewer then asks for the manifest and shows why it cannot.
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}`, { headers: { accept: "text/html" } }), {
    env: reviewEnv, indexHtml: html, cache: new Map(), loading: new Map(), fetchImpl: (async () => new Response("upstream", { status: 502 })) as typeof fetch })).status, 200);
  const garbage = { env: reviewEnv, indexHtml: html, cache: new Map(), loading: new Map(),
    fetchImpl: (async () => new Response("not a manifest", { status: 200 })) as typeof fetch };
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/api/v1`), garbage)).status, 404, "a file that is not a manifest of a report");
});

test("the shell and the agent API share one fetch of a manifest, kept within the cache's bytes; the manifest route only passes it through", async () => {
  const listing = ["iphone", "duo-open"].map(target => ({ target, platform: "ios", label: target, path: `/p/${token}/targets/${target}.json` }));
  const env: PreviewEnvironment = { ...reviewEnv, EXPLORE_PREVIEW_REPORT: undefined, EXPLORE_PREVIEW_REPORTS: JSON.stringify(listing) };
  const site = await deployment(Object.fromEntries(listing.map(entry => [entry.path, explorationZip])), env);
  // Requests that arrive together wait for one fetch.
  assert.deepEqual((await Promise.all([site.get("/api/v1?target=iphone"), site.get("/llms.txt?target=iphone"), site.get("?target=iphone", "text/html")])).map(response => response.status), [200, 200, 200]);
  assert.equal(site.calls.length, 1);
  // Kept now, so the Viewer's manifest request is answered from memory.
  assert.equal((await site.get("/manifest.json?target=iphone")).status, 200);
  assert.equal(site.calls.length, 1);
  // Not kept (a prefetch of another target): streamed through each time, never parsed.
  assert.equal((await site.get("/manifest.json?target=duo-open")).status, 200);
  assert.equal((await site.get("/manifest.json?target=duo-open")).status, 200);
  assert.equal(site.calls.length, 3);
});

test("a manifest is parsed once and keeps the report's own bytes; another key order still opens; one the Viewer would refuse does not", async () => {
  const loaded = (await loadReport(review))!;
  const read = async () => undefined;
  const written = new TextEncoder().encode(manifestBody(loaded, "stamp"));
  const parsed = reportFromManifest(written, read)!;
  assert.equal(parsed.kind, "pr-review");
  assert.deepEqual(parsed.raw, loaded.raw);
  assert.equal(parsed.raw.buffer, written.buffer, "the report's bytes are a view of the manifest, not a copy");
  assert.equal(parsed.entries.size, [...loaded.entries.keys()].filter(name => name.startsWith("assets/")).length);
  // Another writer's layout: parsed whole, the report re-serialized.
  const reordered = JSON.parse(new TextDecoder().decode(written));
  const other = reportFromManifest(new TextEncoder().encode(JSON.stringify({ report: reordered.report, format: reordered.format, file: reordered.file, entries: reordered.entries })), read)!;
  assert.equal(other.kind, "pr-review");
  assert.deepEqual(other.json, parsed.json);
  // A nested `"report"` key before the report's own is not where the report starts.
  const nested = `{"format":"explore.preview-manifest/1","extra":{"a":1,"report":2},"file":"review.json","entries":{},"report":${new TextDecoder().decode(loaded.raw)}}`;
  const fromNested = reportFromManifest(new TextEncoder().encode(nested), read)!;
  assert.equal(fromNested.kind, "pr-review");
  assert.deepEqual(fromNested.json, parsed.json);
  for (const bad of ['{"format":"explore.preview-manifest/1","file":"review.json","entries":{"../x":1},"report":{}}', '{"format":"other","file":"review.json","entries":{},"report":{}}', "not json"]) {
    assert.equal(reportFromManifest(new TextEncoder().encode(bad), read), undefined, bad);
  }
  assert.equal(reportFromManifest(new Uint8Array(MAX_MANIFEST_BYTES + 1), read), undefined, "larger than the Viewer opens");
});

test("an agent's screenshot the Worker cannot fetch this time is a 503; one the report does not hold is a 404", async () => {
  const site = await deployment({ [reviewEnv.EXPLORE_PREVIEW_REPORT!]: review }, reviewEnv);
  const loaded = (await loadReport(review))!;
  const name = [...loaded.entries.keys()].find(entry => /^assets\/[a-f0-9]{64}\.png$/.test(entry))!;
  const sha = name.slice(7, 71);
  const manifest = site.files[reviewEnv.EXPLORE_PREVIEW_REPORT!]!;
  const failing = (status: number) => previewResponse(new Request(`${origin}/p/${token}/api/v1/assets/${sha}`), { env: reviewEnv, indexHtml: html, cache: new Map(), loading: new Map(),
    fetchImpl: (async (input: RequestInfo | URL) => String(input).endsWith(".json") ? new Response(manifest as BodyInit) : new Response("upstream", { status })) as typeof fetch });
  const unavailable = await failing(502);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "unavailable");
  assert.equal((await failing(404)).status, 404);
});

test("kept manifests count their parsed size against the cache: the oldest goes when the next would not fit", async () => {
  const big = (label: string) => zip({ "exploration.json": new TextEncoder().encode(JSON.stringify({ ...explorationReport, padding: label.repeat(6 * 1024 * 1024) })), [`assets/${pngSha}.png`]: png });
  const listing = ["first", "second"].map(target => ({ target, platform: "ios", label: target, path: `/p/${token}/targets/${target}.json` }));
  const env: PreviewEnvironment = { ...reviewEnv, EXPLORE_PREVIEW_REPORT: undefined, EXPLORE_PREVIEW_REPORTS: JSON.stringify(listing) };
  const site = await deployment({ [listing[0]!.path]: big("a"), [listing[1]!.path]: big("b") }, env);
  assert.equal((await site.get("/api/v1?target=first")).status, 200);
  assert.deepEqual([...site.cache.keys()], [`${origin}${listing[0]!.path}`]);
  // Two 6 MB manifests are about 36 MB once parsed, over the 32 MB the isolate keeps.
  assert.equal((await site.get("/api/v1?target=second")).status, 200);
  assert.deepEqual([...site.cache.keys()], [`${origin}${listing[1]!.path}`]);
});
