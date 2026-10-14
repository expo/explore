import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { PREVIEW_CIPHER, previewConfig, previewResponse, type PreviewEnvironment } from "../src/server/preview";

const subtle = webcrypto.subtle as SubtleCrypto;
const token = "abcdefghijklmnopqrstuvwxyz234567";
const html = '<!doctype html><script type="module" src="/viewer/assets/main.js"></script>';
const report: Uint8Array<ArrayBuffer> = new TextEncoder().encode("PK\u0003\u0004 a small report archive stand-in");

async function sealed(keyBytes: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer> = report): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(PREVIEW_CIPHER.ivBytes));
  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(PREVIEW_CIPHER.aad) }, key, plain));
  const out = new Uint8Array(iv.byteLength + cipher.byteLength);
  out.set(iv); out.set(cipher, iv.byteLength);
  return out;
}

const keyBytes: Uint8Array<ArrayBuffer> = webcrypto.getRandomValues(new Uint8Array(32));
const env: PreviewEnvironment = {
  EXPLORE_PREVIEW_TOKEN: token,
  EXPLORE_PREVIEW_KEY: Buffer.from(keyBytes).toString("base64"),
  EXPLORE_PREVIEW_EXPIRES_AT: "2030-01-01T00:00:00Z",
  EXPLORE_PREVIEW_REPORT: "/_report/abcdefghijklmnop/report.zip.enc",
};
const origin = "https://acme-explore--k7f3z0d1q8.expo.app";

test("after the sealed expiry the exact token still opens the Viewer and the report routes answer 410 with the instant; no expiry means never", async () => {
  const options = { env, indexHtml: html, fetchImpl: staticFiles({ [env.EXPLORE_PREVIEW_REPORT!]: await sealed(keyBytes) }), subtle };
  const before = { ...options, now: () => Date.parse("2029-12-31T23:59:59Z") };
  const after = { ...options, now: () => Date.parse("2030-01-01T00:00:00Z") };
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}`), before)).status, 200);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip`), before)).status, 200);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}`, { headers: { accept: "text/html" } }), after)).status, 200, "a browser still gets the shell, which explains the expiry");
  for (const path of ["", "/report.zip", "/reports.json", "/report.zip?platform=ios"]) {
    const response = await previewResponse(new Request(`${origin}/p/${token}${path}`), after);
    assert.equal(response.status, 410, path);
    assert.equal(response.headers.get("cache-control"), "private, no-store", path);
    assert.deepEqual(await response.json(), { error: "expired", expiredAt: "2030-01-01T00:00:00.000Z" }, path);
  }
  const wrongToken = token.replace(/a/, "b");
  assert.equal((await previewResponse(new Request(`${origin}/p/${wrongToken}/report.zip`), after)).status, 404, "a wrong token never learns about the expiry");
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}`, { method: "POST" }), after)).status, 404);
  const never = { ...after, env: { ...env, EXPLORE_PREVIEW_EXPIRES_AT: undefined } };
  assert.equal(previewConfig(never.env)?.expiresAt, null);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip`), never)).status, 200);
});

function staticFiles(files: Record<string, Uint8Array<ArrayBuffer>>): typeof fetch {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    const body = files[url.pathname];
    return body ? new Response(body, { headers: { "content-length": String(body.byteLength) } }) : new Response("missing", { status: 404 });
  }) as typeof fetch;
  (impl as typeof fetch & { calls: string[] }).calls = calls;
  return impl;
}

test("the sealed configuration is read strictly", () => {
  assert.ok(previewConfig(env));
  for (const broken of [
    { EXPLORE_PREVIEW_TOKEN: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" }, { EXPLORE_PREVIEW_TOKEN: token.slice(1) }, { EXPLORE_PREVIEW_TOKEN: undefined },
    { EXPLORE_PREVIEW_KEY: Buffer.alloc(16).toString("base64") }, { EXPLORE_PREVIEW_KEY: "not base64!" },
    { EXPLORE_PREVIEW_EXPIRES_AT: "soon" }, { EXPLORE_PREVIEW_REPORT: "/report.zip.enc" }, { EXPLORE_PREVIEW_REPORT: "/_report/../x/report.zip.enc" },
  ]) assert.equal(previewConfig({ ...env, ...broken }), undefined, JSON.stringify(broken));
});

test("the token page serves the Viewer shell and the report route streams the decrypted report", async () => {
  const fetchImpl = staticFiles({ [env.EXPLORE_PREVIEW_REPORT!]: await sealed(keyBytes) });
  const page = await previewResponse(new Request(`${origin}/p/${token}?view=compare&screen=home#/map`), { env, indexHtml: html, fetchImpl, subtle });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), html);
  assert.equal(page.headers.get("cache-control"), "private, no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const slash = await previewResponse(new Request(`${origin}/p/${token}/`), { env, indexHtml: html, fetchImpl, subtle });
  assert.equal(slash.status, 200);

  const zip = await previewResponse(new Request(`${origin}/p/${token}/report.zip`), { env, indexHtml: html, fetchImpl, subtle });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.equal(zip.headers.get("content-length"), String(report.byteLength));
  assert.deepEqual(new Uint8Array(await zip.arrayBuffer()), report);
  // Only the sealed report file is ever fetched, whether for the shell's inline index or the zip route.
  const calls = (fetchImpl as typeof fetch & { calls: string[] }).calls;
  assert.ok(calls.length >= 1 && calls.every(call => call === `${origin}${env.EXPLORE_PREVIEW_REPORT}`), calls.join());
});

test("everything else is the same 404: wrong token, other paths, other methods, bad ciphertext, missing file", async () => {
  const good = await sealed(keyBytes);
  const files = { [env.EXPLORE_PREVIEW_REPORT!]: good };
  const options = { env, indexHtml: html, fetchImpl: staticFiles(files), subtle };
  const wrongToken = token.replace(/a/, "b");
  for (const path of [`/p/${wrongToken}`, `/p/${wrongToken}/report.zip`, `/p/${token.toUpperCase()}`, `/p/${token}/viewer/assets/main.js`,
    `/p/${token}/other.zip`, `/p/${token}/report.zip/`, `/p/${token}x`, "/p", "/p/", "/", "/_report/abcdefghijklmnop/report.zip.enc", `/P/${token}`]) {
    const response = await previewResponse(new Request(origin + path), options);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "Not found", path);
    assert.equal(response.headers.get("cache-control"), "private, no-store", path);
  }
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
    assert.equal((await previewResponse(new Request(`${origin}/p/${token}`, { method }), options)).status, 404, method);
  }

  const otherKey: Uint8Array<ArrayBuffer> = webcrypto.getRandomValues(new Uint8Array(32));
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip`), { ...options, fetchImpl: staticFiles({ [env.EXPLORE_PREVIEW_REPORT!]: await sealed(otherKey) }) })).status, 404);
  const tampered = Uint8Array.from(good); tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip`), { ...options, fetchImpl: staticFiles({ [env.EXPLORE_PREVIEW_REPORT!]: tampered }) })).status, 404);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip`), { ...options, fetchImpl: staticFiles({}) })).status, 404);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip`), { ...options, env: { ...env, EXPLORE_PREVIEW_KEY: undefined } })).status, 404);
});

test("a multi-platform deployment serves reports.json, one report per platform, and rejects loose configuration", async () => {
  const android: Uint8Array<ArrayBuffer> = new TextEncoder().encode("PK\u0003\u0004 android report stand-in");
  const reports = [
    { platform: "ios", path: "/_report/abcdefghijklmnop/ios.zip.enc", changes: 3, device: "iPhone 17 Pro 26.0" },
    { platform: "android", path: "/_report/abcdefghijklmnop/android.zip.enc", changes: 0, device: "Pixel 7 15" },
  ];
  const { EXPLORE_PREVIEW_REPORT: _single, ...rest } = env;
  const multi: PreviewEnvironment = { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify(reports) };
  const fetchImpl = staticFiles({ [reports[0]!.path]: await sealed(keyBytes), [reports[1]!.path]: await sealed(keyBytes, android) });
  const options = { env: multi, indexHtml: html, fetchImpl, subtle };
  assert.deepEqual(previewConfig(multi)?.reports, reports);

  const list = await previewResponse(new Request(`${origin}/p/${token}/reports.json`), options);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(list.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await list.json(), [{ platform: "ios", changes: 3, device: "iPhone 17 Pro 26.0" }, { platform: "android", changes: 0, device: "Pixel 7 15" }]);

  const first = await previewResponse(new Request(`${origin}/p/${token}/report.zip`), options);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), report);
  const ios = await previewResponse(new Request(`${origin}/p/${token}/report.zip?platform=ios`), options);
  assert.deepEqual(new Uint8Array(await ios.arrayBuffer()), report);
  const second = await previewResponse(new Request(`${origin}/p/${token}/report.zip?platform=android`), options);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), android);
  for (const path of ["/report.zip?platform=web", "/report.zip?platform=ios&platform=android", "/reports.json/", "/report.zip?platform="]) {
    assert.equal((await previewResponse(new Request(`${origin}/p/${token}${path}`), options)).status, 404, path);
  }
  // Single-report deployments still answer reports.json (one iOS entry) and ignore an unknown platform.
  const single = { env, indexHtml: html, fetchImpl: staticFiles({ [env.EXPLORE_PREVIEW_REPORT!]: await sealed(keyBytes) }), subtle };
  assert.deepEqual(await (await previewResponse(new Request(`${origin}/p/${token}/reports.json`), single)).json(), [{ platform: "ios" }]);
  assert.equal((await previewResponse(new Request(`${origin}/p/${token}/report.zip?platform=android`), single)).status, 404);

  const loose: Array<[string, unknown]> = [
    ["both variables", { ...multi, EXPLORE_PREVIEW_REPORT: env.EXPLORE_PREVIEW_REPORT }],
    ["invalid JSON", { ...rest, EXPLORE_PREVIEW_REPORTS: "{" }],
    ["empty list", { ...rest, EXPLORE_PREVIEW_REPORTS: "[]" }],
    ["duplicate platform", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([reports[0], reports[0]]) }],
    ["unknown platform", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ platform: "web", path: reports[0]!.path }]) }],
    ["foreign path", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ platform: "ios", path: "https://example.invalid/x" }]) }],
    ["extra key", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], url: "x" }]) }],
    ["bad changes", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], changes: -1 }]) }],
    ["markup device", { ...rest, EXPLORE_PREVIEW_REPORTS: JSON.stringify([{ ...reports[0], device: "<b>x</b>" }]) }],
  ];
  for (const [name, value] of loose) {
    assert.equal(previewConfig(value as PreviewEnvironment), undefined, name);
    assert.equal((await previewResponse(new Request(`${origin}/p/${token}`), { ...options, env: value as PreviewEnvironment })).status, 404, name);
  }
});
