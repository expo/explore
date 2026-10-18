import assert from "node:assert/strict";
import test from "node:test";
import { previewConfig, previewResponse, type PreviewEnvironment } from "../src/server/preview";

const token = "abcdefghijklmnopqrstuvwxyz234567";
const html = '<!doctype html><script type="module" src="/viewer/assets/main.js"></script>';
const env: PreviewEnvironment = { EXPLORE_PREVIEW_TOKEN: token, EXPLORE_PREVIEW_REPORT: `/p/${token}/targets/report.json` };
const origin = "https://acme-explore--k7f3z0d1q8.expo.app";
/** The manifest route streams the static file through unparsed, so a stand-in names the report it is. */
const standIn = (name: string) => new TextEncoder().encode(`manifest of ${name}`);

function staticFiles(files: Record<string, Uint8Array>): typeof fetch {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const body = files[url.pathname];
    return body ? new Response(body as BodyInit, { headers: { "content-length": String(body.byteLength) } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  (impl as typeof fetch & { calls: string[] }).calls = calls;
  return impl;
}
const options = (environment: PreviewEnvironment, files: Record<string, Uint8Array>) =>
  ({ env: environment, indexHtml: html, fetchImpl: staticFiles(files), cache: new Map(), loading: new Map() });

test("the configuration is read strictly, and a report's manifest must sit under the deployment's own token", () => {
  assert.deepEqual(previewConfig(env), { token, reports: [{ target: "ios", platform: "ios", path: env.EXPLORE_PREVIEW_REPORT }] });
  const otherToken = token.replace(/a/, "b");
  for (const broken of [
    { EXPLORE_PREVIEW_TOKEN: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" }, { EXPLORE_PREVIEW_TOKEN: token.slice(1) }, { EXPLORE_PREVIEW_TOKEN: undefined },
    { EXPLORE_PREVIEW_REPORT: "/report.json" }, { EXPLORE_PREVIEW_REPORT: `/p/${otherToken}/targets/report.json` },
    { EXPLORE_PREVIEW_REPORT: `/p/${token}/targets/../report.json` }, { EXPLORE_PREVIEW_REPORT: `/p/${token}/targets/ios.json` },
    { EXPLORE_PREVIEW_REPORT: "/_report/abcdefghijklmnop/report.zip.enc" },
  ]) assert.equal(previewConfig({ ...env, ...broken }), undefined, JSON.stringify(broken));
});

test("the token page serves the Viewer shell, and the manifest route answers the target's static manifest", async () => {
  const files = { [env.EXPLORE_PREVIEW_REPORT!]: standIn("report") };
  const page = await previewResponse(new Request(`${origin}/p/${token}?view=compare&screen=home#/map`), options(env, files));
  assert.equal(page.status, 200);
  // A stand-in is not a manifest the index can read, so the shell is the plain Viewer.
  assert.equal(await page.text(), html);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/`), options(env, files))).status, 200);

  const manifest = await previewResponse(new Request(`${origin}/p/${token}/manifest.json`), options(env, files));
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(manifest.headers.get("cache-control"), "private, no-store");
  assert.equal(await manifest.text(), "manifest of report");
});

test("everything else is the same 404: wrong token, other paths, other methods, a missing manifest; a failing fetch is a 503", async () => {
  const files = { [env.EXPLORE_PREVIEW_REPORT!]: standIn("report") };
  const wrongToken = token.replace(/a/, "b");
  for (const path of [`/p/${wrongToken}`, `/p/${wrongToken}/manifest.json`, `/p/${token.toUpperCase()}`, `/p/${token}/viewer/assets/main.js`,
    `/p/${token}/report.zip`, `/p/${token}/assets/${"0".repeat(64)}.png`, `/p/${token}/targets/report.json`, `/p/${token}/manifest.json/`,
    `/p/${token}x`, "/p", "/p/", "/", `/P/${token}`]) {
    const response = await previewResponse(new Request(origin + path), options(env, files));
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "Not found", path);
    assert.equal(response.headers.get("cache-control"), "private, no-store", path);
  }
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
    assert.equal((await previewResponse(new Request(`${origin}/p/${token}`, { method }), options(env, files))).status, 404, method);
  }
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/manifest.json`), options(env, {}))).status, 404, "a deployment missing its manifest");
  const failing = { ...options(env, files), fetchImpl: (async () => new Response("upstream", { status: 502 })) as typeof fetch };
  const unavailable = await previewResponse(new Request(`${origin}/p/${token}/manifest.json`), failing);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "1");
  const throwing = { ...options(env, files), fetchImpl: (async () => { throw new TypeError("network"); }) as typeof fetch };
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/manifest.json`), throwing)).status, 503);
});

test("a multi-platform deployment serves reports.json, one manifest per platform, and rejects loose configuration", async () => {
  const reports = [
    { platform: "ios", path: `/p/${token}/targets/ios.json`, changes: 3, device: "iPhone 17 Pro 26.0" },
    { platform: "android", path: `/p/${token}/targets/android.json`, changes: 0, device: "Pixel 7 15" },
  ];
  const { EXPLORE_PREVIEW_REPORT: _single, ...rest } = env;
  const multi: PreviewEnvironment = { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify(reports) };
  const files = { [reports[0]!.path]: standIn("ios"), [reports[1]!.path]: standIn("android") };
  // A listing from before targets names each report by its platform, which is then its target.
  assert.deepEqual(previewConfig(multi)?.reports, reports.map(entry => ({ target: entry.platform, ...entry })));

  const list = await previewResponse(new Request(`${origin}/p/${token}/reports.json`), options(multi, files));
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await list.json(), [{ target: "ios", platform: "ios", changes: 3, device: "iPhone 17 Pro 26.0" }, { target: "android", platform: "android", changes: 0, device: "Pixel 7 15" }]);

  const manifest = async (query: string) => {
    const response = await previewResponse(new Request(`${origin}/p/${token}/manifest.json${query}`), options(multi, files));
    return response.status === 200 ? await response.text() : response.status;
  };
  assert.equal(await manifest(""), "manifest of ios");
  assert.equal(await manifest("?platform=ios"), "manifest of ios");
  assert.equal(await manifest("?platform=android"), "manifest of android");
  for (const query of ["?platform=web", "?platform=ios&platform=android", "?platform="]) assert.equal(await manifest(query), 404, query);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/reports.json/`), options(multi, files))).status, 404);
  // Single-report deployments still answer reports.json (one iOS entry) and ignore an unknown platform.
  const single = options(env, { [env.EXPLORE_PREVIEW_REPORT!]: standIn("report") });
  assert.deepEqual(await (await previewResponse(new Request(`${origin}/p/${token}/reports.json`), single)).json(), [{ target: "ios", platform: "ios" }]);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/manifest.json?platform=android`), single)).status, 404);

  const loose: Array<[string, unknown]> = [
    ["both variables", { ...multi, EXPLORE_PREVIEW_REPORT: env.EXPLORE_PREVIEW_REPORT }],
    ["invalid JSON", { ...rest, EXPLORE_PREVIEW_REPORTS: "{" }],
    ["empty list", { ...rest, EXPLORE_PREVIEW_REPORTS: "[]" }],
    ["duplicate platform", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([reports[0], reports[0]]) }],
    ["unknown platform", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ platform: "web", path: reports[0]!.path }]) }],
    ["foreign path", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ platform: "ios", path: "https://example.invalid/x" }]) }],
    ["another token's path", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], path: `/p/${token.replace(/a/, "b")}/targets/ios.json` }]) }],
    ["extra key", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], url: "x" }]) }],
    ["bad changes", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], changes: -1 }]) }],
    ["markup device", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], device: "<b>x</b>" }]) }],
  ];
  for (const [name, value] of loose) {
    assert.equal(previewConfig(value as PreviewEnvironment), undefined, name);
    assert.equal((await previewResponse(new Request(`${origin}/p/${token}`), options(value as PreviewEnvironment, files))).status, 404, name);
  }
});

test("a deployment of several targets, three of them iOS, selects by ?target= and still by ?platform=", async () => {
  const targets = [
    { target: "iphone", platform: "ios", label: "iPhone 17", path: `/p/${token}/targets/iphone.json`, changes: 1 },
    { target: "duo-closed", platform: "ios", label: "iPhone Duo (closed)", path: `/p/${token}/targets/duo-closed.json` },
    { target: "duo-open", platform: "ios", label: "iPhone Duo (open)", path: `/p/${token}/targets/duo-open.json`, device: "iPhone Duo 26.0" },
    { target: "android", platform: "android", label: "Android", path: `/p/${token}/targets/android.json` },
  ];
  const { EXPLORE_PREVIEW_REPORT: _single, ...rest } = env;
  const multi: PreviewEnvironment = { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify(targets) };
  const files = Object.fromEntries(targets.map(entry => [entry.path, standIn(entry.target)]));
  assert.deepEqual(previewConfig(multi)?.reports, targets);
  assert.deepEqual(await (await previewResponse(new Request(`${origin}/p/${token}/reports.json`), options(multi, files))).json(), targets.map(({ path: _path, ...entry }) => entry));
  const served = async (query: string) => {
    const response = await previewResponse(new Request(`${origin}/p/${token}/manifest.json${query}`), options(multi, files));
    return response.status === 200 ? (await response.text()).replace("manifest of ", "") : response.status;
  };
  assert.equal(await served(""), "iphone", "the first listed");
  assert.equal(await served("?target=duo-open"), "duo-open");
  assert.equal(await served("?target=android"), "android");
  assert.equal(await served("?platform=android"), "android", "an old link names the target after its platform");
  assert.equal(await served("?platform=ios"), "iphone", "with no target named ios, the first iOS target");
  for (const query of ["?target=web", "?target=duo-open&target=iphone", "?target=duo-open&platform=ios", "?target=", "?target=Duo-Open"]) {
    assert.equal(await served(query), 404, query);
  }

  const eight = Array.from({ length: 8 }, (_, index) => ({ target: `t${index}`, platform: "ios", path: `/p/${token}/targets/t${index}.json` }));
  assert.equal(previewConfig({ ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify(eight) })?.reports.length, 8);
  const loose: Array<[string, unknown]> = [
    ["nine targets", [...eight, { target: "t8", platform: "ios", path: `/p/${token}/targets/t8.json` }]],
    ["duplicate target", [targets[0], { ...targets[1], target: "iphone", path: targets[0]!.path }]],
    ["invalid id", [{ ...targets[0], target: "iPhone", path: `/p/${token}/targets/iPhone.json` }]],
    ["reserved id", [{ ...targets[0], target: "report", path: `/p/${token}/targets/report.json` }]],
    ["install id", [{ ...targets[0], target: "install-x", path: `/p/${token}/targets/install-x.json` }]],
    ["path of another target", [{ ...targets[0], path: targets[1]!.path }]],
    ["null target", [{ ...targets[0], target: null }]],
    ["markup label", [{ ...targets[0], label: "<b>x</b>" }]],
    ["empty label", [{ ...targets[0], label: " " }]],
    ["long label", [{ ...targets[0], label: "x".repeat(81) }]],
  ];
  for (const [name, value] of loose) assert.equal(previewConfig({ ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify(value) }), undefined, name);
});
