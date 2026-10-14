import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

const identity = { repo: "Expo/Example", run: "123", attempt: "2" };
const namespace = "explore-reports";
const legacyNamespace = "explore-artifacts-public";
const day = 24 * 60 * 60 * 1000;

async function harness(t) {
  const vite = await createBrowserVite(t, {
    configFile: false,
    root: fileURLToPath(new URL("../../viewer", import.meta.url)),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{ name: "artifact-cache-fixture", configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (new URL(request.url, "http://localhost").pathname !== "/cache-test") return next();
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><meta charset="utf-8"><script type="module">
          import * as api from "/src/utils/artifact-cache.ts";
          window.writeArtifact = async (identity, bytes = [80, 75, 3, 4], expiresAt = Date.now() + 86400000) => {
            const blob = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
            const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
            const digest = "sha256:" + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
            await api.putCachedArtifact(identity, { blob, digest, expiresAt });
            return { digest, expiresAt };
          };
          window.cacheApi = api;
        </script>`);
      });
    } }],
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const errors = [];
  async function open(fault) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    if (fault) await page.addInitScript(fault => {
      if (fault === "unavailable") {
        Object.defineProperty(window, "caches", { value: undefined, configurable: true });
      } else if (fault === "getter throws") {
        Object.defineProperty(window, "caches", { get() { throw new DOMException("Storage denied", "SecurityError"); }, configurable: true });
      } else if (fault === "open rejects") {
        caches.open = () => Promise.reject(new DOMException("Storage denied", "SecurityError"));
      } else if (fault === "open hangs") {
        caches.open = () => new Promise(() => {});
      } else {
        const open = caches.open.bind(caches);
        caches.open = async (...args) => {
          const cache = await open(...args);
          if (fault === "quota") cache.put = () => Promise.reject(new DOMException("Cache full", "QuotaExceededError"));
          if (fault === "put hangs") cache.put = () => new Promise(() => {});
          if (fault === "match hangs") cache.match = () => new Promise(() => {});
          return cache;
        };
      }
    }, fault);
    await page.goto(`${origin}/cache-test`);
    await page.waitForFunction(() => window.cacheApi);
    return page;
  }
  return { open, errors };
}

test("artifact cache preserves compressed bytes across reload and normalizes repository casing", async t => {
  const { open, errors } = await harness(t);
  const page = await open();
  const bytes = [80, 75, 3, 4, 0, 128, 254, 255];
  const written = await page.evaluate(({ identity, bytes }) => window.writeArtifact(identity, bytes), { identity, bytes });
  await page.reload();
  await page.waitForFunction(() => window.cacheApi);
  const restored = await page.evaluate(async ({ identity, namespace }) => {
    const value = await window.cacheApi.getCachedArtifact({ ...identity, repo: identity.repo.toLowerCase() });
    const keys = await (await caches.open(namespace)).keys();
    return { bytes: [...new Uint8Array(await value.blob.arrayBuffer())], digest: value.digest,
      expiresAt: value.expiresAt, keys: keys.map(key => new URL(key.url).pathname + new URL(key.url).search) };
  }, { identity, namespace });
  assert.deepEqual(restored.bytes, bytes);
  assert.equal(restored.digest, written.digest);
  assert.equal(restored.expiresAt, written.expiresAt);
  assert.deepEqual(restored.keys, ["/.explore/report-cache/v1?repo=expo%2Fexample&run=123&attempt=2"]);
  assert.deepEqual(errors, []);
});

test("artifact cache isolates repository, run and attempt, ignores the artifact id, and deletion is identity scoped", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async identity => {
    await window.writeArtifact({ ...identity, artifact: "456" });
    const other = { ...identity, attempt: "3" };
    const variants = [{ ...identity, repo: "Expo/Other" }, { ...identity, run: "124" }, other];
    const misses = await Promise.all(variants.map(async value => !await window.cacheApi.getCachedArtifact(value)));
    // One run attempt has one report, so a link with another (or no) artifact id reuses the saved ZIP.
    const artifactIgnored = !!await window.cacheApi.getCachedArtifact({ ...identity, artifact: "999" }) && !!await window.cacheApi.getCachedArtifact(identity);
    await window.writeArtifact(other);
    await window.cacheApi.deleteCachedArtifact({ ...identity, repo: identity.repo.toUpperCase() });
    return { misses, artifactIgnored, deleted: !await window.cacheApi.getCachedArtifact(identity), retained: !!await window.cacheApi.getCachedArtifact(other) };
  }, identity);
  assert.deepEqual(result, { misses: [true, true, true], artifactIgnored: true, deleted: true, retained: true });
});

test("artifact cache keeps one report per platform of a run and both survive the prune of a later write", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async identity => {
    const ios = { ...identity, platform: "ios" };
    const android = { ...identity, platform: "android" };
    const { digest: iosDigest } = await window.writeArtifact(ios, [80, 75, 3, 4, 1]);
    const { digest: androidDigest } = await window.writeArtifact(android, [80, 75, 3, 4, 2]);
    // Storing another report prunes every key it does not recognise; platform keys must be recognised.
    await window.writeArtifact({ ...identity, run: "999" });
    const [iosHit, androidHit, unsuffixed] = await Promise.all([ios, android, identity].map(value => window.cacheApi.getCachedArtifact(value)));
    return {
      ios: iosHit?.digest === iosDigest, android: androidHit?.digest === androidDigest, distinct: iosHit?.digest !== androidHit?.digest,
      unsuffixedMisses: !unsuffixed,
      invalid: !await window.cacheApi.getCachedArtifact({ ...identity, platform: "web" }),
    };
  }, identity);
  assert.deepEqual(result, { ios: true, android: true, distinct: true, unsuffixedMisses: true, invalid: true });
});

test("artifact cache removes the retired public download cache the first time it is used", async t => {
  const { open, errors } = await harness(t);
  const page = await open();
  await page.evaluate(async legacyNamespace => {
    await (await caches.open(legacyNamespace)).put("/.explore/artifact-cache/public?repo=expo%2Fexample&run=1&attempt=1&artifact=1", new Response("old"));
    await (await caches.open("another-feature-cache")).put("/other", new Response("keep"));
  }, legacyNamespace);
  await page.reload();
  await page.waitForFunction(() => window.cacheApi);
  assert.equal(await page.evaluate(legacyNamespace => caches.has(legacyNamespace), legacyNamespace), true);
  await page.evaluate(identity => window.cacheApi.getCachedArtifact(identity), identity);
  await page.waitForFunction(legacyNamespace => caches.has(legacyNamespace).then(present => !present), legacyNamespace);
  assert.equal(await page.evaluate(() => caches.has("another-feature-cache")), true);
  assert.deepEqual(errors, []);
});

test("artifact cache prunes unexpected internal keys without changing another cache namespace", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async ({ identity, namespace }) => {
    await window.writeArtifact(identity);
    const cache = await caches.open(namespace);
    const [canonical] = await cache.keys();
    const response = await cache.match(canonical);
    const unrelated = await caches.open("another-feature-cache");
    await unrelated.put(canonical, new Response("other feature data"));
    const badKeys = [
      "/unrelated-path",
      canonical.url + "&focus=modified",
      canonical.url.replace("expo%2Fexample", "Expo%2FExample"),
      canonical.url + "&run=999",
    ];
    for (const key of badKeys) await cache.put(key, response.clone());
    for (const run of ["1", "2", "3", "4", "5"]) await window.writeArtifact({ ...identity, run });
    await window.cacheApi.deleteCachedArtifact({ ...identity, run: "5" });
    return {
      invalidRemoved: await Promise.all(badKeys.map(async key => !await cache.match(key))),
      unrelatedBytes: await (await unrelated.match(canonical)).text(),
      unrelatedCount: (await unrelated.keys()).length,
      ownCount: (await cache.keys()).length,
    };
  }, { identity, namespace });
  assert.deepEqual(result, { invalidRemoved: [true, true, true, true], unrelatedBytes: "other feature data",
    unrelatedCount: 1, ownCount: 3 });
});

test("artifact cache retains four recently used reports and evicts the least recently read report", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async ({ identity, namespace }) => {
    let now = Date.now();
    Date.now = () => now;
    for (let number = 1; number <= 4; number++) {
      now += 1000;
      await window.writeArtifact({ ...identity, run: String(number) });
    }
    now += 1000;
    await window.cacheApi.getCachedArtifact({ ...identity, run: "1" });
    now += 1000;
    await window.writeArtifact({ ...identity, run: "5" });
    const present = await Promise.all([1, 2, 3, 4, 5].map(async number =>
      !!await window.cacheApi.getCachedArtifact({ ...identity, run: String(number) })));
    return { present, count: (await (await caches.open(namespace)).keys()).length };
  }, { identity, namespace });
  assert.deepEqual(result, { present: [true, false, true, true, true], count: 4 });
});

test("artifact cache evicts large archives when their combined size would exceed 256 MiB", { timeout: 20_000 }, async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async ({ identity, namespace }) => {
    const megabyte = new Uint8Array(1024 * 1024);
    const blob = new Blob(Array.from({ length: 90 }, () => megabyte), { type: "application/zip" });
    const digest = `sha256:${"a".repeat(64)}`;
    for (const run of ["1", "2", "3"]) {
      await window.cacheApi.putCachedArtifact({ ...identity, run }, { blob, digest, expiresAt: Date.now() + 86400000 });
    }
    const cache = await caches.open(namespace);
    const keys = await cache.keys();
    const records = await Promise.all(keys.map(async key => ({
      run: new URL(key.url).searchParams.get("run"),
      bytes: (await (await cache.match(key)).blob()).size,
    })));
    return records.sort((a, b) => a.run.localeCompare(b.run));
  }, { identity, namespace });
  assert.deepEqual(result, [{ run: "2", bytes: 90 * 1024 * 1024 }, { run: "3", bytes: 90 * 1024 * 1024 }]);
});

test("artifact cache honors server expiry and caps local retention at seven days", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async ({ identity, day, namespace }) => {
    const startedAt = Date.now();
    let now = startedAt;
    Date.now = () => now;
    const early = { ...identity, run: "1" };
    const long = { ...identity, run: "2" };
    await window.writeArtifact(early, [1], startedAt + day);
    await window.writeArtifact(long, [2], startedAt + 30 * day);
    const earlyExpiry = (await window.cacheApi.getCachedArtifact(early)).expiresAt - startedAt;
    const cappedExpiry = (await window.cacheApi.getCachedArtifact(long)).expiresAt - startedAt;
    now = startedAt + day;
    const earlyExpired = !await window.cacheApi.getCachedArtifact(early);
    const longRetained = !!await window.cacheApi.getCachedArtifact(long);
    now = startedAt + 7 * day;
    const longExpired = !await window.cacheApi.getCachedArtifact(long);
    return { earlyExpiry, cappedExpiry, earlyExpired, longRetained, longExpired,
      remaining: (await (await caches.open(namespace)).keys()).length };
  }, { identity, day, namespace });
  assert.deepEqual(result, { earlyExpiry: day, cappedExpiry: 7 * day, earlyExpired: true,
    longRetained: true, longExpired: true, remaining: 0 });
});

test("artifact cache evicts records with corrupt byte counts, digests or expiry metadata", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async ({ identity, namespace }) => {
    const cache = await caches.open(namespace);
    const mutations = [
      ["X-Explore-Cache-Bytes", "999"],
      ["X-Explore-Cache-Bytes", "invalid"],
      ["X-Explore-Cache-Digest", "sha256:broken"],
      ["X-Explore-Cache-Digest", null],
      ["X-Explore-Cache-Expires-At", "invalid"],
      ["X-Explore-Cache-Stored-At", null],
    ];
    const results = [];
    for (const [name, value] of mutations) {
      await window.writeArtifact(identity);
      const [key] = await cache.keys();
      const response = await cache.match(key);
      const headers = new Headers(response.headers);
      if (value === null) headers.delete(name); else headers.set(name, value);
      await cache.put(key, new Response(await response.blob(), { headers }));
      results.push({ miss: !await window.cacheApi.getCachedArtifact(identity), removed: !await cache.match(key) });
    }
    return results;
  }, { identity, namespace });
  assert.deepEqual(result, Array.from({ length: 6 }, () => ({ miss: true, removed: true })));
});

test("artifact cache refuses invalid identities, digests and already expired records", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async ({ identity, namespace }) => {
    const invalid = [{ ...identity, repo: "expo/.." }, { ...identity, repo: "expo/one/two" },
      { ...identity, run: "0" }, { ...identity, attempt: "01" }, { ...identity, run: "1e3" }];
    for (const value of invalid) await window.writeArtifact(value);
    const misses = await Promise.all(invalid.map(async value => !await window.cacheApi.getCachedArtifact(value)));
    const blob = new Blob(["not a ZIP; this layer checks storage metadata only"]);
    for (const digest of ["sha256:bad", `sha256:${"A".repeat(64)}`, "", "md5:1234"]) {
      await window.cacheApi.putCachedArtifact(identity, { blob, digest, expiresAt: Date.now() + 10000 });
    }
    await window.writeArtifact(identity, [1], Date.now() - 1);
    return { misses, count: (await (await caches.open(namespace)).keys()).length };
  }, { identity, namespace });
  assert.deepEqual(result, { misses: [true, true, true, true, true], count: 0 });
});

test("artifact cache remains optional when browser storage is unavailable, denied, full or stalled", { timeout: 40_000 }, async t => {
  const { open, errors } = await harness(t);
  for (const fault of ["unavailable", "getter throws", "open rejects", "quota", "open hangs", "put hangs", "match hangs"]) {
    await t.test(fault, async () => {
      const page = await open(fault);
      const result = await page.evaluate(async identity => {
        const startedAt = performance.now();
        await window.writeArtifact(identity);
        const value = await window.cacheApi.getCachedArtifact(identity);
        await window.cacheApi.deleteCachedArtifact(identity);
        return { miss: value === undefined, elapsed: performance.now() - startedAt };
      }, identity);
      assert.equal(result.miss, true);
      assert.ok(result.elapsed < 8000, `Optional cache must not stall loading (${fault}: ${result.elapsed} ms)`);
      await page.context().close();
    });
  }
  assert.deepEqual(errors, []);
});

test("artifact cache still serves an existing report when updating its usage exceeds storage quota", async t => {
  const { open } = await harness(t);
  const page = await open();
  const result = await page.evaluate(async identity => {
    const written = await window.writeArtifact(identity, [80, 75, 255]);
    const open = caches.open.bind(caches);
    caches.open = async (...args) => {
      const cache = await open(...args);
      cache.put = () => Promise.reject(new DOMException("Cache full", "QuotaExceededError"));
      return cache;
    };
    const cached = await window.cacheApi.getCachedArtifact(identity);
    return { digestMatches: cached.digest === written.digest, bytes: [...new Uint8Array(await cached.blob.arrayBuffer())] };
  }, identity);
  assert.deepEqual(result, { digestMatches: true, bytes: [80, 75, 255] });
});

test("concurrent artifact writes from separate tabs keep four intact reports in one bounded cache", async t => {
  const { open } = await harness(t);
  const page = await open();
  const secondPage = await page.context().newPage();
  await secondPage.goto(page.url());
  await secondPage.waitForFunction(() => window.cacheApi);
  await Promise.all([page, secondPage].map((tab, offset) => tab.evaluate(async ({ identity, offset }) => {
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      window.writeArtifact({ ...identity, run: String(offset * 8 + index + 1) })));
  }, { identity, offset })));
  const result = await page.evaluate(async ({ namespace }) => {
    const cache = await caches.open(namespace);
    const keys = await cache.keys();
    const lengths = await Promise.all(keys.map(async key => Number((await cache.match(key)).headers.get("X-Explore-Cache-Bytes"))));
    const hits = await Promise.all(keys.map(async key => {
      const storedIdentity = Object.fromEntries(new URL(key.url).searchParams);
      return !!await window.cacheApi.getCachedArtifact(storedIdentity);
    }));
    return { count: keys.length, bytes: lengths.reduce((total, bytes) => total + bytes, 0), hits };
  }, { namespace });
  assert.equal(result.count, 4);
  assert.ok(result.bytes <= 256 * 1024 * 1024);
  assert.deepEqual(result.hits, [true, true, true, true]);
});
