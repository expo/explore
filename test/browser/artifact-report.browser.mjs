import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { BlobReader, BlobWriter, Uint8ArrayReader, ZipReader, ZipWriter, Uint8ArrayWriter } from "@zip.js/zip.js";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { PNG } from "pngjs";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

// The file-drop and reload paths can take longer than expect's 5 s default on CI runners.
const expect = playwrightExpect.configure({ timeout: 15_000 });


const identity = { repo: "expo/example", run: "123", attempt: "2", artifact: "456" };
const fileName = "explore-review-123-2.zip";
const image = new PNG({ width: 32, height: 64 });
image.data.fill(255);
const png = PNG.sync.write(image);
const sha256 = createHash("sha256").update(png).digest("hex");
const path = `assets/${sha256}.png`;

function reportFixture() {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const timestamp = "2026-09-21T00:00:00.000Z";
  const route = { id: "home", route: "/home", routeFile: "app/home.tsx", sourceFiles: [],
    variant: "default", kind: "screen", provider: "expo-router", path: "/home", logicalPath: "app/home.tsx" };
  const review = {
    contract: "explore.review", mode: "all", createdAt: timestamp, runId: identity.run, runAttempt: identity.attempt,
    pullRequest: { repositoryId: "1", repository: identity.repo, number: 8, title: "Modify home",
      url: `https://github.com/${identity.repo}/pull/8`, base: { ref: "main", sha: baseSha },
      head: { ref: "feature/home", sha: headSha } },
    runtime: { projectId: "eas-project", buildId: "eas-head", gitCommit: headSha, appName: "Fixture" },
    surfaces: [{ id: "home", status: "modified", base: { ...route }, head: { ...route },
      baseOutcome: { status: "captured", attempts: 1, landing: "verified" },
      headOutcome: { status: "captured", attempts: 1, landing: "verified" },
      review: { status: "modified", description: "Home greeting was modified", facts: [
        { category: "text", templateId: "text.changed", bullet: "Greeting changed from Hello to Welcome" },
      ] } }],
  };
  for (const side of ["base", "head"]) review.surfaces[0][`${side}Image`] = {
    url: `https://artifact.expo-explore.invalid/${sha256}.png`, sha256, width: 32, height: 64,
    capturedAt: timestamp, sourceCommit: review.pullRequest[side].sha, buildId: `eas-${side}`,
  };
  return { kind: "explore.report", review, assets: [{ sha256, path }] };
}

async function archive(report = reportFixture(), extra = [], imageBytes = png) {
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  await writer.add("review.json", new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(report))), { level: 6 });
  if (report.assets.length) await writer.add(path, new Uint8ArrayReader(imageBytes), { level: 0 });
  for (const entry of extra) await writer.add(entry.name, new Uint8ArrayReader(entry.bytes), { level: 0 });
  return Buffer.from(await (await writer.close()).arrayBuffer());
}

/** The report ZIP as the preview Worker reads it: entry bytes by name, and the manifest it answers with. */
async function unzipped(bytes) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), { useWebWorkers: false });
  const files = new Map();
  for (const entry of await reader.getEntries()) files.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
  await reader.close();
  const file = files.has("review.json") ? "review.json" : "exploration.json";
  const entries = Object.fromEntries([...files].filter(([name]) => name.startsWith("assets/")).map(([name, data]) => [name, data.length]));
  const manifest = `{"format":"explore.preview-manifest/1","file":"${file}","entries":${JSON.stringify(entries)},"report":${new TextDecoder().decode(files.get(file))}}`;
  return { files, manifest };
}

/**
 * Serve `/r` like the hosted Viewer: the page alone, no report endpoint; the ZIP comes from the
 * reviewer. `reportIdentity: null` opens the bare page without a linked run.
 */
async function harness(t, bytes, { app = false, open = true, name = fileName, reportIdentity = identity,
  query = "&focus=modified&screen=home&inspect=diff", fault, preview } = {}) {
  const pagePath = preview ? `/p/${preview.token}` : "/r";
  // What the preview Worker serves from the decrypted ZIP: the manifest the Viewer opens, and each asset on request.
  const served = preview && bytes ? await unzipped(bytes) : undefined;
  // `archives` by query gives a target its own report; every other query gets `bytes`.
  const servedBy = Object.fromEntries(await Promise.all(Object.entries(preview?.archives ?? {}).map(async ([search, zip]) => [search, await unzipped(zip)])));
  const servedFor = search => servedBy[search] ?? served;
  const vite = await createBrowserVite(t, { configFile: false,
    root: fileURLToPath(new URL("../../viewer", import.meta.url)), logLevel: "error", esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "report-page-fixture", configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, "http://localhost");
        // A preview deployment's Worker: the decrypted report behind the token, or the same 404 as any other path.
        if (preview && url.pathname === `${pagePath}/manifest.json`) {
          preview.requests = (preview.requests ?? 0) + 1;
          preview.queries = [...(preview.queries ?? []), url.search];
          if (preview.status && preview.status !== 200) { response.statusCode = preview.status; return response.end(preview.body ?? "Not found"); }
          // A target the Worker cannot read (`failures` by query) answers with that status.
          if (preview.failures?.[url.search]) { response.statusCode = preview.failures[url.search]; return response.end("Unavailable"); }
          response.setHeader("content-type", "application/json");
          // A slow target (`delays` by query) keeps its manifest in flight while the reviewer moves on.
          // `padding` makes the manifest larger than the Viewer reads.
          const manifest = servedFor(url.search).manifest;
          const body = preview.padding ? " ".repeat(preview.padding) + manifest : manifest;
          return void setTimeout(() => response.end(body), preview.delays?.[url.search] ?? 0);
        }
        if (preview && url.pathname.startsWith(`${pagePath}/assets/`)) {
          // Screenshot URLs name no target: any report of the deployment may hold one.
          const name = url.pathname.slice(pagePath.length + 1);
          const asset = [served, ...Object.values(servedBy)].map(report => report.files.get(name)).find(Boolean);
          if (!asset) { response.statusCode = 404; return response.end("Not found"); }
          response.setHeader("content-type", "application/octet-stream");
          response.setHeader("content-length", String(asset.length));
          return response.end(asset);
        }
        if (preview?.listing && url.pathname === `${pagePath}/reports.json`) {
          response.setHeader("content-type", "application/json");
          return response.end(JSON.stringify(preview.listing));
        }
        if (url.pathname !== pagePath) return next();
        response.setHeader("content-type", "text/html");
        response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/favicon.svg" type="image/svg+xml"></head><body><div id="root"></div>
          <script type="module">${app ? 'import "/src/main.tsx";' : `
            import * as api from "/src/utils/artifact-report.ts";
            window.archiveApi = api;
            window.openReport = (bytes, identity, name, onProgress) => api.openReportBlob(
              new Blob([new Uint8Array(bytes)], { type: "application/zip" }), identity, { ...(name ? { fileName: name } : {}), ...(onProgress ? { onProgress } : {}) });
          `}</script></body></html>`);
      });
    } }] });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.createdUrls = [];
    window.revokedUrls = [];
    URL.createObjectURL = value => { const url = create(value); window.createdUrls.push(url); return url; };
    URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke(url); };
  });
  if (fault) await page.addInitScript(fault);
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const search = reportIdentity ? `?${new URLSearchParams(reportIdentity)}${query}` : query ? `?${query.replace(/^&/, "")}` : "";
  await page.goto(`${origin}${pagePath}${search}`);
  if (!app) await page.waitForFunction(() => window.archiveApi);
  else if (bytes && open && !preview) await chooseFile(page, bytes, name);
  return { page, errors, origin };
}

/** The file picker path: a Buffer becomes an in-memory file; a path uploads the file itself. */
async function chooseFile(page, file, name = fileName) {
  await page.locator(".report-drop-input").setInputFiles(typeof file === "string" ? file : { name, mimeType: "application/zip", buffer: file });
}

async function fileTransfer(page, files) {
  return page.evaluateHandle(files => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type ?? "application/zip" }));
    return transfer;
  }, files.map(file => ({ ...file, bytes: [...file.bytes] })));
}

/** The drag path: a synthetic DataTransfer dropped on any element of the page. */
async function dropFile(page, bytes, name = fileName, target = "body") {
  const dataTransfer = await fileTransfer(page, [{ bytes, name }]);
  await page.dispatchEvent(target, "dragenter", { dataTransfer });
  await page.dispatchEvent(target, "drop", { dataTransfer });
}

/** CI's findings for the screen in the Inspector sit in its What changed popover. */
async function showWhatChanged(page) {
  const button = page.locator(".right-panel").getByRole("button", { name: /^What changed/ });
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
}

/** The Changes list lives in a menu under the pill; ⌘B (Ctrl+B) opens it. */
async function openChangesMenu(page) {
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+KeyB");
  const menu = page.locator(".changes-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** `reportIdentity: null` opens without a linked run, like a bare `/r`. */
const tryOpen = (page, bytes, reportIdentity = identity, name = fileName) => page.evaluate(async ({ bytes, identity, name }) => {
  try { const archive = await window.openReport(bytes, identity ?? undefined, name); return { ok: true, identity: archive.identity }; }
  catch (error) { return { ok: false, code: error.code, message: error.message }; }
}, { bytes: [...bytes], identity: reportIdentity, name });

test("the pill shows the app's own icon when the report has one, and the Expo mark otherwise", { timeout: 60_000 }, async t => {
  const icon = new PNG({ width: 4, height: 4 });
  icon.data.fill(180);
  const iconBytes = PNG.sync.write(icon);
  const iconSha = createHash("sha256").update(iconBytes).digest("hex");
  const iconPath = `assets/${iconSha}.png`;
  const report = reportFixture();
  report.review.runtime.appIcon = { url: `https://artifact.expo-explore.invalid/${iconSha}.png`, sha256: iconSha, width: 4, height: 4 };
  report.assets.push({ sha256: iconSha, path: iconPath });
  const withIcon = await harness(t, await archive(report, [{ name: iconPath, bytes: iconBytes }]), { app: true });
  const logo = withIcon.page.locator(".left-panel-collapsed-pill").getByRole("button", { name: "Map", exact: true });
  await expect(logo.locator("img.panel-app-icon")).toHaveJSProperty("naturalWidth", 4);
  await expect(logo.locator(".expo-mark")).toHaveCount(0);
  // The tab shows it too, from a Blob URL: the ZIP's own reference is not one the browser can load.
  const tabIcon = withIcon.page.locator("link[rel='icon']");
  await expect(tabIcon).toHaveAttribute("href", /^blob:/);
  assert.equal(await tabIcon.evaluate(async link => (await (await fetch(link.href)).blob()).size), iconBytes.length);
  assert.deepEqual(withIcon.errors, []);

  const withoutIcon = await harness(t, await archive(), { app: true });
  const mark = withoutIcon.page.locator(".left-panel-collapsed-pill").getByRole("button", { name: "Map", exact: true });
  await expect(mark.locator(".expo-mark")).toHaveCount(1);
  await expect(mark.locator("img")).toHaveCount(0);
  assert.deepEqual(withoutIcon.errors, []);
});

test("a report link shows the drop screen: download link, expected file name, empty states, one panel, and the system theme", async t => {
  const { page, errors } = await harness(t, undefined, { app: true });
  const shell = page.locator(".report-loading-shell");
  await expect(shell).toHaveAttribute("data-loading-status", "awaiting");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(shell.locator(".left-panel")).toContainText("expo/example");
  await expect(shell.locator(".report-loading-skeleton")).toHaveCount(0);
  const drop = shell.locator(".report-drop");
  await expect(drop.getByRole("heading", { name: "Open this report", exact: true })).toBeVisible();
  // The drop card says where a report comes from; step 2 names the expected file.
  const steps = drop.getByRole("list", { name: "How to open a report" });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps.getByRole("listitem").nth(1).locator("code")).toHaveText("explore-review-123-2.zip");
  // Run and access details stay in the PR comment; the drop zone names the file.
  await expect(drop).not.toContainText("Explore reviewed");
  await expect(drop).not.toContainText("GitHub asks");
  await expect(drop).not.toContainText("nothing is uploaded");
  await expect(drop.locator("code")).toHaveText("explore-review-123-2.zip");
  // The file name is the only download link.
  await expect(drop.getByRole("link")).toHaveCount(1);
  const download = drop.getByRole("link", { name: "explore-review-123-2.zip", exact: true });
  await expect(download).toHaveAttribute("href", "https://github.com/expo/example/actions/runs/123/artifacts/456");
  await expect(download).toHaveAttribute("target", "_blank");
  await expect(drop.getByRole("button", { name: "Select a file", exact: true })).toBeVisible();
  await expect(drop.locator(".report-drop-input")).toHaveAttribute("accept", ".zip,application/zip,application/x-zip-compressed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Like the ready Viewer, the loading screen has only the top-left pill and no section rail.
  await expect(shell.getByRole("tab")).toHaveCount(0);
  await expect(shell.locator(".left-panel-collapsed-pill .panel-logo-mark")).toBeVisible();
  // The repository name sits on one line beside the logo, as the app name does once the report opens.
  const name = shell.locator(".left-panel-collapsed-pill strong");
  await expect(name).toHaveText("expo/example");
  const nameBox = await name.boundingBox();
  assert.ok(nameBox.height < 24 && nameBox.width > 80, JSON.stringify(nameBox));
  assert.deepEqual(errors, []);
});

test("the saved-report check shows the loading step and skeletons, then the drop screen replaces them", async t => {
  const { page, errors } = await harness(t, undefined, { app: true, fault: () => { caches.open = () => new Promise(() => {}); } });
  const shell = page.locator(".report-loading-shell");
  await expect(shell).toHaveAttribute("data-loading-status", "loading");
  const title = shell.locator(".report-loading-step.is-current");
  await expect(title).toHaveText("Checking saved report");
  assert.ok((await title.evaluate(element => getComputedStyle(element).animationName)).includes("step-in"));
  await expect(shell.locator(".report-loading-pill-skeleton")).toBeVisible();
  await expect(shell.locator(".report-drop")).toHaveCount(0);
  // Stalled storage is abandoned after its timeout; the report can still be dropped.
  await expect(shell).toHaveAttribute("data-loading-status", "awaiting");
  await expect(shell.locator(".report-loading-skeleton")).toHaveCount(0);
  await expect(shell.locator(".report-drop")).toBeVisible();
  assert.deepEqual(errors, []);
});

test("choosing the report file opens it with the link's selection and keeps Modified filtering", { timeout: 60_000 }, async t => {
  const { page, errors } = await harness(t, await archive(), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  await showWhatChanged(page);
  await expect(page.getByText("Greeting changed from Hello to Welcome", { exact: true })).toBeVisible();
  assert.match(page.url(), /repo=expo%2Fexample&run=123&attempt=2&artifact=456/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  const screenshot = page.locator(".screens-page img[data-screenshot-src]").first();
  // The placeholder is the screenshot's size too, so wait for the screenshot itself.
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  await expect.poll(() => screenshot.evaluate(image => image.naturalWidth)).toBe(32);
  const screenshotUrl = await screenshot.getAttribute("src");
  assert.match(page.url(), /#\/screens/);
  // Leaving a canvas releases its screenshot, but the report keeps the decoded URL: coming back
  // reuses it instead of reading and hashing the image again.
  const created = await page.evaluate(() => window.createdUrls.length);
  await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.locator(".screens-page")).toHaveCount(0);
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await expect(screenshot).toHaveAttribute("src", screenshotUrl);
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  assert.equal(await page.evaluate(() => window.createdUrls.length), created);

  // The report is for review only: no simulator connection or AI account controls.
  for (const name of ["Live", "Connect", "AI Agent", "Settings"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  assert.deepEqual(errors, []);
});

test("dragging a file highlights the whole page and dropping it anywhere opens the report", async t => {
  const bytes = await archive();
  const { page, errors } = await harness(t, bytes, { app: true, open: false });
  const shell = page.locator(".report-loading-shell");
  await expect(shell).toHaveAttribute("data-loading-status", "awaiting");
  const transfer = await fileTransfer(page, [{ bytes, name: fileName }]);
  await page.dispatchEvent(".left-panel", "dragenter", { dataTransfer: transfer });
  await expect(shell).toHaveClass(/is-dragging/);
  // Moving between child elements nests enter/leave pairs; the highlight holds until the last leave.
  await page.dispatchEvent(".report-loading-canvas", "dragenter", { dataTransfer: transfer });
  await page.dispatchEvent(".left-panel", "dragleave", { dataTransfer: transfer });
  await expect(shell).toHaveClass(/is-dragging/);
  await page.dispatchEvent(".report-loading-canvas", "dragleave", { dataTransfer: transfer });
  await expect(shell).not.toHaveClass(/is-dragging/);
  const text = await page.evaluateHandle(() => { const transfer = new DataTransfer(); transfer.setData("text/plain", "hello"); return transfer; });
  await page.dispatchEvent("body", "dragenter", { dataTransfer: text });
  await expect(shell).not.toHaveClass(/is-dragging/);
  await page.dispatchEvent(".left-panel", "dragenter", { dataTransfer: transfer });
  await page.dispatchEvent(".left-panel", "drop", { dataTransfer: transfer });
  await expect(page.locator(".app-shell")).toBeVisible();
  await showWhatChanged(page);
  await expect(page.getByText("Greeting changed from Hello to Welcome", { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.querySelector(".is-dragging")), null);
  assert.deepEqual(errors, []);
});

test("a reload and a later per-screen link reopen the dropped report from the browser cache", async t => {
  const { page, errors, origin } = await harness(t, await archive(), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".report-drop")).toHaveCount(0);
  await showWhatChanged(page);
  await expect(page.getByText("Greeting changed from Hello to Welcome", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  const screenshot = page.locator(".screens-page img[data-screenshot-src]").first();
  // The placeholder is the screenshot's size too, so wait for the screenshot itself.
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  await expect.poll(() => screenshot.evaluate(image => image.naturalWidth)).toBe(32);
  // Comment links to one screen carry the same run identity, so they open without a new drop.
  await page.goto(`${origin}/r?${new URLSearchParams(identity)}&screen=home&inspect=diff`);
  await expect(page.locator(".app-shell")).toBeVisible();
  await showWhatChanged(page);
  await expect(page.getByText("Greeting changed from Hello to Welcome", { exact: true })).toBeVisible();
  // PR comment screen links name `view=compare`, so they open that change in Compare.
  await page.goto(`${origin}/r?${new URLSearchParams(identity)}&view=compare&screen=home`);
  await expect(page.getByRole("region", { name: "Compare /home" })).toBeVisible();
  await expect(page).toHaveURL(/#\/compare\/home$/);
  const keys = await page.evaluate(async () => (await (await caches.open("explore-reports")).keys())
    .map(key => new URL(key.url).pathname + new URL(key.url).search));
  assert.deepEqual(keys, ["/.explore/report-cache/v1?repo=expo%2Fexample&run=123&attempt=2"]);
  assert.equal(await page.evaluate(() => caches.has("explore-artifacts-public")), false);
  assert.deepEqual(errors, []);
});

test("the report of another run is refused by name, keeps the drop zone, and the right file then opens", async t => {
  const other = reportFixture();
  other.review.runAttempt = "1";
  const { page, errors } = await harness(t, await archive(other), { app: true, name: "explore-review-123-1.zip" });
  const shell = page.locator(".report-loading-shell");
  await expect(shell).toHaveAttribute("data-loading-status", "failed");
  const alert = shell.locator(".report-loading-error");
  await expect(alert).toContainText("Couldn’t open this report");
  await expect(alert).toContainText("This file is the report for expo/example run 123 attempt 1. This link expects expo/example run 123 attempt 2 (explore-review-123-2.zip).");
  // Skeletons promise arriving content; nothing is arriving after a refusal.
  await expect(shell.locator(".report-loading-skeleton")).toHaveCount(0);
  await expect(shell.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(shell.locator(".report-loading-actions").getByRole("link", { name: "Download report" }))
    .toHaveAttribute("href", "https://github.com/expo/example/actions/runs/123/artifacts/456");
  await expect(shell.getByRole("link", { name: "Open workflow run" })).toHaveAttribute("href", "https://github.com/expo/example/actions/runs/123");
  await expect(shell.getByRole("button", { name: "Select a file", exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
  await shell.getByRole("button", { name: "Try again" }).click();
  await expect(shell).toHaveAttribute("data-loading-status", "awaiting");
  await expect(shell.locator(".report-drop-file")).toBeVisible();
  await chooseFile(page, await archive());
  await expect(page.locator(".app-shell")).toBeVisible();
  // The refused file was never saved; the run's real report is.
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  assert.deepEqual(errors, []);
});

test("non-ZIP files, non-report ZIPs, empty drops, and multiple files are refused without object URLs", async t => {
  const { page, errors } = await harness(t, undefined, { app: true });
  const shell = page.locator(".report-loading-shell");
  const alert = shell.locator(".report-loading-error");
  await page.locator(".report-drop-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a zip") });
  await expect(alert).toContainText("“notes.txt” is not a ZIP file. Download the report artifact from GitHub Actions and drop that .zip.");
  const plain = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  await plain.add("readme.txt", new Uint8ArrayReader(new TextEncoder().encode("hello")));
  // A wrong file is replaced straight from the failed state.
  await chooseFile(page, Buffer.from(await (await plain.close()).arrayBuffer()), "other.zip");
  await expect(alert).toContainText("“other.zip” is not an Explore report: it has no review.json. Download explore-review-123-2.zip from the workflow run.");
  await dropFile(page, Buffer.alloc(0), "folder");
  await expect(alert).toContainText("“folder” is empty. Drop the .zip file itself, not an extracted folder.");
  const two = await fileTransfer(page, [{ bytes: Buffer.from([80, 75, 3, 4]), name: "a.zip" }, { bytes: Buffer.from([80, 75, 3, 4]), name: "b.zip" }]);
  await page.dispatchEvent("body", "dragenter", { dataTransfer: two });
  await page.dispatchEvent("body", "drop", { dataTransfer: two });
  await expect(shell.locator(".report-drop-message")).toHaveText("Drop one report ZIP at a time.");
  await expect(shell).toHaveAttribute("data-loading-status", "failed");
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
  assert.deepEqual(errors, []);
});

test("a corrupted saved report returns to the drop screen instead of failing", async t => {
  const { page, errors } = await harness(t, undefined, { app: true });
  await expect(page.locator(".report-drop")).toBeVisible();
  await page.evaluate(async identity => {
    const { putCachedArtifact } = await import("/src/utils/artifact-cache.ts");
    await putCachedArtifact(identity, { blob: new Blob(["corrupted archive"]), digest: `sha256:${"0".repeat(64)}`, expiresAt: Date.now() + 60_000 });
  }, identity);
  const count = () => page.evaluate(async () => (await (await caches.open("explore-reports")).keys()).length);
  assert.equal(await count(), 1);
  await page.reload();
  await expect(page.locator(".report-drop")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.equal(await count(), 0);
  assert.deepEqual(errors, []);
});

test("a hosted preview link downloads the report from its own token route, opens it with the link's selection, and shows no drop zone", { timeout: 60_000 }, async t => {
  const preview = { token: "abcdefghijklmnopqrstuvwxyz234567" };
  const { page, errors } = await harness(t, await archive(), { app: true, reportIdentity: null, preview });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true })).toBeVisible();
  await showWhatChanged(page);
  await expect(page.locator(".right-panel")).toContainText("Greeting changed from Hello to Welcome");
  await expect(page.locator(".report-drop")).toHaveCount(0);
  assert.equal(preview.requests, 1);
  assert.equal(new URL(page.url()).pathname, `/p/${preview.token}`);
  assert.deepEqual(errors, []);

  // The report is kept like a dropped one: a reload opens the cached copy, but the preview is asked again only if that fails.
  preview.status = 404;
  const expired = await harness(t, await archive(), { app: true, reportIdentity: null, preview: { ...preview, token: "bcdefghijklmnopqrstuvwxyz2345672" } });
  const shell = expired.page.locator(".report-loading-shell");
  await expect(shell).toHaveAttribute("data-loading-status", "failed");
  await expect(shell).toContainText("This preview link is not valid, or its deployment was deleted");
  await expect(expired.page.locator(".report-drop-input")).toHaveCount(0);
  assert.deepEqual(expired.errors, []);
});

test("a hosted run of several targets opens the linked target and switches between all of them in config order", { timeout: 60_000 }, async t => {
  const targets = [
    { id: "iphone", platform: "ios", label: "iPhone 17" },
    { id: "duo-closed", platform: "ios", label: "iPhone Duo (closed)" },
    { id: "duo-open", platform: "ios", label: "iPhone Duo (open)" },
    { id: "android", platform: "android", label: "Android" },
  ];
  const report = reportFixture();
  report.review.runtime = { ...report.review.runtime, platform: "ios", platforms: ["ios", "android"], target: targets[2], targets };
  const preview = { token: "defghijklmnopqrstuvwxyz234567234", listing: [
    { target: "iphone", platform: "ios", label: "iPhone 17", changes: 1 },
    { target: "duo-closed", platform: "ios", label: "iPhone Duo (closed)" },
    { target: "duo-open", platform: "ios", label: "iPhone Duo (open)", changes: 1 },
    { target: "android", platform: "android", label: "Android", changes: 2, device: "Pixel 9 16" },
  ] };
  const { page, errors } = await harness(t, await archive(report), { app: true, reportIdentity: null, preview, query: "&target=duo-open" });
  const button = page.getByRole("button", { name: "Device: iPhone Duo (open). Open another device's report" });
  await expect(button).toBeVisible();
  assert.equal(preview.queries[0], "?target=duo-open", "the Viewer asks the Worker for the linked target's report");
  await button.click();
  const items = page.getByRole("menu", { name: "Device" }).getByRole("menuitemradio");
  await expect(items).toHaveCount(4);
  assert.deepEqual(await items.evaluateAll(rows => rows.map(row => [row.querySelector(".menu-row-label")?.firstChild?.textContent, row.getAttribute("aria-checked")])),
    [["iPhone 17", "false"], ["iPhone Duo (closed)", "false"], ["iPhone Duo (open)", "true"], ["Android", "false"]]);
  await expect(items.nth(3)).toContainText("2 changes · Pixel 9 16");
  await expect(items.nth(1)).toContainText("Same review, other device");
  await page.evaluate(() => { window.__samePage = true; });
  await items.nth(3).click();
  await page.waitForURL(url => new URL(url).searchParams.get("platform") === "android");
  const next = new URL(page.url());
  assert.equal(next.searchParams.get("target"), null, "a target named after its platform is linked as before targets");
  // The switch stays on the page: the Worker is asked for the other target's manifest (the prefetch may already have), not for a new page.
  await expect.poll(() => preview.queries).toContain("?platform=android");
  await expect(page.locator(".app-shell")).toBeVisible();
  assert.equal(await page.evaluate(() => window.__samePage), true, "the switch stays on the page instead of reloading it");
  assert.deepEqual(errors, []);
});

test("a hosted report from before targets still switches platforms by ?platform=", { timeout: 60_000 }, async t => {
  const report = reportFixture();
  report.review.runtime = { ...report.review.runtime, platform: "android", platforms: ["ios", "android"] };
  const preview = { token: "efghijklmnopqrstuvwxyz2345672345", listing: [{ platform: "ios", changes: 3 }, { platform: "android" }] };
  const { page, errors } = await harness(t, await archive(report), { app: true, reportIdentity: null, preview, query: "&platform=android" });
  const button = page.getByRole("button", { name: "Platform: Android. Open another platform's report" });
  await expect(button).toBeVisible();
  assert.equal(preview.queries[0], "?platform=android");
  await button.click();
  const items = page.getByRole("menu", { name: "Platform" }).getByRole("menuitemradio");
  assert.deepEqual(await items.evaluateAll(rows => rows.map(row => [row.querySelector(".menu-row-label")?.firstChild?.textContent, row.getAttribute("aria-checked")])),
    [["iOS", "false"], ["Android", "true"]]);
  await expect(items.nth(0)).toContainText("3 changes");
  await page.evaluate(() => { window.__samePage = true; });
  await items.nth(0).click();
  await page.waitForURL(url => new URL(url).searchParams.get("platform") === "ios");
  await expect.poll(() => preview.queries).toContain("?platform=ios");
  await expect(page.locator(".app-shell")).toBeVisible();
  assert.equal(await page.evaluate(() => window.__samePage), true, "the switch stays on the page instead of reloading it");
  assert.deepEqual(errors, []);
});

/** A two-platform deployment whose iOS manifest is slow, opened on Android with the platform menu ready. */
async function slowSwitchHarness(t, token, delay) {
  const report = reportFixture();
  report.review.runtime = { ...report.review.runtime, platform: "android", platforms: ["ios", "android"] };
  const preview = { token, listing: [{ platform: "ios" }, { platform: "android" }], delays: { "?platform=ios": delay } };
  const opened = await harness(t, await archive(report), { app: true, reportIdentity: null, preview, query: "&platform=android" });
  await expect(opened.page.locator(".app-shell")).toBeVisible();
  const switchToIos = async () => {
    await opened.page.getByRole("button", { name: "Platform: Android. Open another platform's report" }).click();
    await opened.page.getByRole("menu", { name: "Platform" }).getByRole("menuitemradio").nth(0).click();
    await opened.page.waitForURL(url => new URL(url).searchParams.get("platform") === "ios");
  };
  return { ...opened, preview, switchToIos };
}

test("a switch the prefetch joins keeps the report it shows open", { timeout: 60_000 }, async t => {
  // The switch starts the iOS download before the prefetch does; the prefetch then waits on the same download.
  const { page, errors, preview, switchToIos } = await slowSwitchHarness(t, "fghijklmnopqrstuvwxyz23456723456", 2500);
  await switchToIos();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 10_000 });
  assert.equal(preview.queries.filter(query => query === "?platform=ios").length, 1, "the switch and the prefetch share one download");
  const screenshot = page.locator(".map-canvas img[data-screenshot-src]").first();
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  await expect.poll(() => screenshot.evaluate(image => image.naturalWidth)).toBe(32);
  assert.deepEqual(errors, []);
});

test("switching back to a prefetched target shows the screenshots it showed before, without decoding them again", { timeout: 60_000 }, async t => {
  const { page, errors, preview, switchToIos } = await slowSwitchHarness(t, "hijklmnopqrstuvwxyz2345672345672", 0);
  const screenshot = page.locator(".map-canvas img[data-screenshot-src]").first();
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  const shown = await screenshot.getAttribute("src");
  await expect.poll(() => preview.queries).toContain("?platform=ios");
  await page.waitForTimeout(250);
  await switchToIos();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  assert.equal(preview.queries.filter(query => query === "?platform=ios").length, 1, "the switch opens the prefetched report without a download");
  const created = await page.evaluate(() => window.createdUrls.length);
  await page.goBack();
  await page.waitForURL(url => new URL(url).searchParams.get("platform") === "android");
  await expect(screenshot).toHaveAttribute("data-screenshot-state", "ready");
  assert.equal(await screenshot.getAttribute("src"), shown, "the Android report kept the Blob URL it was showing");
  assert.equal(await page.evaluate(url => window.revokedUrls.includes(url), shown), false);
  assert.equal(await page.evaluate(() => window.createdUrls.length), created, "nothing was decoded again");
  assert.deepEqual(errors, []);
});

test("a target whose download fails leaves the report on screen and its link, and a toast says why", { timeout: 60_000 }, async t => {
  const report = reportFixture();
  report.review.runtime = { ...report.review.runtime, platform: "android", platforms: ["ios", "android"] };
  const preview = { token: "mnopqrstuvwxyz234567234567234567", listing: [{ platform: "ios" }, { platform: "android" }],
    failures: { "?platform=ios": 500 } };
  const { page, errors } = await harness(t, await archive(report), { app: true, reportIdentity: null, preview, query: "&platform=android" });
  const trigger = page.getByRole("button", { name: "Platform: Android. Open another platform's report" });
  await expect(trigger).toBeVisible();
  await page.evaluate(() => { window.__samePage = true; });
  const place = new URL(page.url()).hash;
  await trigger.click();
  await page.getByRole("menu", { name: "Platform" }).getByRole("menuitemradio").nth(0).click();
  await expect(page.locator(".app-toast")).toContainText("Couldn’t open iOS");
  await expect(page.locator(".app-toast")).toContainText("The report could not be downloaded (HTTP 500).");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".report-loading-shell")).toHaveCount(0);
  await expect(trigger).not.toHaveAttribute("aria-busy", /.*/);
  // The link is the Android report's again, at the place it was.
  await expect.poll(() => new URL(page.url()).searchParams.get("platform")).toBe("android");
  assert.equal(new URL(page.url()).hash, place);
  assert.equal(await page.evaluate(() => window.__samePage), true, "the failed switch stays on the page");
  assert.deepEqual(errors, []);
});

test("Forward onto a target still downloading keeps the preview link and its place in history", { timeout: 60_000 }, async t => {
  const { page, errors, switchToIos } = await slowSwitchHarness(t, "jklmnopqrstuvwxyz234567234567234", 3000);
  await page.evaluate(() => { window.location.hash = "#/map?inspect=diff"; });
  const androidUrl = page.url();
  await switchToIos();
  const iosUrl = page.url();
  await page.goBack();
  await page.waitForURL(androidUrl);
  await expect(page.locator(".app-shell")).toBeVisible();
  // iOS is not kept yet: its download is still in flight.
  await page.goForward();
  await page.waitForTimeout(200);
  assert.equal(page.url(), iosUrl, "Forward lands on the iOS link, not a rewritten /map");
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 10_000 });
  assert.equal(new URL(page.url()).pathname, new URL(iosUrl).pathname);
  assert.equal(new URL(page.url()).searchParams.get("platform"), "ios");
  await page.goBack();
  await page.waitForTimeout(200);
  assert.equal(page.url(), androidUrl, "Back restores the Android entry as it was");
  assert.deepEqual(errors, []);
});

test("a switch to a target whose screenshots have another shape lays the map out again for its cards, so none overlap", { timeout: 60_000 }, async t => {
  const targets = [
    { id: "iphone", platform: "ios", label: "iPhone 17" },
    { id: "duo-open", platform: "ios", label: "iPhone Duo (open)" },
  ];
  // Home leads to Settings and About, Settings on to Profile: three layers, so the map runs left to right with
  // Settings and About stacked, a card's height plus a gap apart. A Duo card is shorter than a phone's.
  const shaped = async (target, width, height) => {
    const picture = new PNG({ width, height });
    picture.data.fill(255);
    const capture = PNG.sync.write(picture);
    const report = reportFixture();
    const home = report.review.surfaces[0];
    for (const side of ["baseImage", "headImage"]) {
      Object.assign(home[side], { width, height, sha256: createHash("sha256").update(capture).digest("hex") });
    }
    const route = id => {
      const side = { ...home.head, id, route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`, logicalPath: `app/${id}.tsx` };
      return { id, status: "unchanged", base: { ...side }, head: side, baseImage: { ...home.baseImage }, headImage: { ...home.headImage },
        baseOutcome: { ...home.baseOutcome }, headOutcome: { ...home.headOutcome } };
    };
    report.review.surfaces.push(route("settings"), route("about"), route("profile"));
    const edge = (from, to) => ({ from, to, kind: "push", provenance: "source", sourceFile: `app/${from}.tsx` });
    const graph = { contract: "explore.navigation", edges: [edge("home", "settings"), edge("home", "about"), edge("settings", "profile")],
      modalSurfaceIds: [], unresolved: [] };
    report.review.navigation = { base: structuredClone(graph), head: graph };
    report.review.runtime = { ...report.review.runtime, platform: "ios", platforms: ["ios"], target: targets.find(entry => entry.id === target), targets };
    return Buffer.from((await imageArchive([capture], 0, report)).bytes);
  };
  const preview = { token: "klmnopqrstuvwxyz2345672345672345",
    listing: targets.map(({ id, platform, label }) => ({ target: id, platform, label })),
    archives: { "?target=iphone": await shaped("iphone", 130, 282) } };
  const { page, errors } = await harness(t, await shaped("duo-open", 233, 339), { app: true, reportIdentity: null, preview,
    query: "&target=duo-open" });
  const nodes = page.locator(".map-canvas .react-flow__node");
  await expect(nodes).toHaveCount(4);
  /** Overlaps between the cards' boxes on screen, and how tall the cards stand against their width. */
  const layout = () => nodes.evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect());
    let overlaps = 0;
    for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) {
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps += 1;
    }
    return { overlaps, shape: Math.round(boxes[0].height / boxes[0].width * 10) / 10 };
  });
  await expect.poll(layout).toEqual({ overlaps: 0, shape: 1.6 });

  await page.getByRole("button", { name: "Device: iPhone Duo (open). Open another device's report" }).click();
  await page.getByRole("menu", { name: "Device" }).getByRole("menuitemradio").nth(0).click();
  await expect(page.locator(".collapsed-platform").first()).toHaveText("iPhone 17");
  await expect.poll(layout, { timeout: 10_000 }).toEqual({ overlaps: 0, shape: 2.3 });
  assert.deepEqual(errors, []);
});

test("at a phone's width the header leaves out the app's name, then the pull request link, then fades the target's device; nothing overlaps", { timeout: 60_000 }, async t => {
  const targets = [{ id: "iphone", platform: "ios", label: "iPhone 17" }, { id: "duo-half", platform: "ios", label: "iPhone 17 Pro Max Duo (half-open, outer)" }];
  const icon = new PNG({ width: 4, height: 4 });
  icon.data.fill(180);
  const iconBytes = PNG.sync.write(icon);
  const iconSha = createHash("sha256").update(iconBytes).digest("hex");
  const report = reportFixture();
  // An icon to name the app once its name is left out; two appearances for the second chip; the longest target.
  report.review.runtime = {
    ...report.review.runtime, platform: "ios", platforms: ["ios"], target: targets[1], targets, colorSchemes: ["light", "dark"],
    appIcon: { url: `https://artifact.expo-explore.invalid/${iconSha}.png`, sha256: iconSha, width: 4, height: 4 },
  };
  report.assets.push({ sha256: iconSha, path: `assets/${iconSha}.png` });
  report.review.pullRequest.number = 1234;
  const { page, errors } = await harness(t, await archive(report, [{ name: `assets/${iconSha}.png`, bytes: iconBytes }]), { app: true });
  const pill = page.locator(".left-panel-collapsed-pill");
  const name = pill.locator(".collapsed-app-identity > strong");
  const target = pill.locator(".collapsed-target");
  const device = target.locator(".collapsed-platform-label-text");
  const pose = target.locator(".collapsed-platform-label-suffix");
  const pr = pill.locator(".collapsed-pr");
  /** The pill's shown controls: how many pairs overlap, how far any runs past the window, and the page's overflow. */
  const layout = () => pill.evaluate(element => {
    const shown = [...element.querySelectorAll("strong, .collapsed-platform, .collapsed-pr, .collapsed-search")]
      .filter(node => node.checkVisibility({ visibilityProperty: true }));
    const boxes = shown.map(node => node.getBoundingClientRect());
    let overlaps = 0;
    for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) if (a.left < b.right - 1 && b.left < a.right - 1) overlaps += 1;
    const chip = element.querySelector(".collapsed-target").getBoundingClientRect();
    const label = element.querySelector(".collapsed-target .collapsed-platform-label").getBoundingClientRect();
    return { overlaps, bleed: Math.max(0, Math.ceil(label.right - chip.right)), past: Math.max(0, ...boxes.map(box => Math.ceil(box.right - innerWidth))), overflow: document.documentElement.scrollWidth - innerWidth };
  });
  const clipped = locator => locator.evaluate(node => node.scrollWidth - node.offsetWidth > 1);
  const whole = async () => ({ device: !await clipped(device), pose: !await clipped(pose) });
  const dropped = () => pill.locator(".collapsed-app-identity").evaluate(node => node.dataset.drop ?? "");
  // The fit measures text: the Viewer's font must be in before the row's widths mean anything.
  await page.evaluate(() => document.fonts.ready);

  // A desktop window's pill is sized by its content and shows the whole row.
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(name).toBeVisible();
  await expect(target).toHaveText("iPhone 17 Pro Max Duo (half-open, outer)");
  await expect(pr).toHaveText("PR #1234");
  await expect(pr).toBeVisible();
  expect(await whole()).toEqual({ device: true, pose: true });
  expect(await dropped()).toBe("");
  await expect.poll(layout).toEqual({ overlaps: 0, bleed: 0, past: 0, overflow: 0 });

  // A small tablet has no room for the name beside Search: the row leaves it out (the icon still names the app) and
  // keeps the whole target and a shorter link.
  await page.setViewportSize({ width: 560, height: 932 });
  await expect(name).toBeHidden();
  await expect(pr).toHaveText("#1234");
  await expect(pr).toBeVisible();
  await expect(target).toHaveText("iPhone 17 Pro Max Duo (half-open, outer)");
  expect(await whole()).toEqual({ device: true, pose: true });
  await expect.poll(layout).toEqual({ overlaps: 0, bleed: 0, past: 0, overflow: 0 });
  const search = pill.getByRole("button", { name: "Search", exact: true });
  const finger = await search.boundingBox();
  assert.ok(finger.width >= 44 && finger.height >= 44, `Search is ${finger.width}×${finger.height}`);

  // A large phone's width leaves out the link too (Search keeps "Open pull request") before it touches the target.
  await page.setViewportSize({ width: 500, height: 844 });
  await expect(pr).toBeHidden();
  await expect(target).toHaveText("iPhone 17 Pro Max Duo (half-open, outer)");
  expect(await whole()).toEqual({ device: true, pose: true });
  await expect.poll(layout).toEqual({ overlaps: 0, bleed: 0, past: 0, overflow: 0 });
  await page.keyboard.press("ControlOrMeta+KeyK");
  const palette = page.getByRole("dialog", { name: "Search Explore" });
  await palette.getByRole("combobox", { name: "Search screens and commands" }).fill("pull request");
  await expect(palette.getByRole("option", { name: /^Open pull request #1234 on GitHub/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  // An iPhone's width fades the device's name; the pose stays whole and nothing overlaps.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(pill.locator(".collapsed-app-identity")).toHaveAttribute("data-drop", /squeeze/);
  await expect(pill.locator(".collapsed-app-identity")).not.toHaveAttribute("data-drop", /pose/);
  expect(await whole()).toEqual({ device: false, pose: true });
  await expect.poll(layout).toEqual({ overlaps: 0, bleed: 0, past: 0, overflow: 0 });

  // Narrower than the pose beside two chips: the pose fades too, inside its chip, never over the appearance chip.
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(pill.locator(".collapsed-app-identity")).toHaveAttribute("data-drop", /pose/);
  await expect(pill.locator(".collapsed-platform").nth(1)).toHaveText("Light");
  await expect.poll(layout).toEqual({ overlaps: 0, bleed: 0, past: 0, overflow: 0 });

  // Widened again, the row takes everything back: the desktop's pill is sized by its content and leaves nothing out
  // (its own width rule ellipsizes the name beside so long a target; the fit does not touch it).
  await page.setViewportSize({ width: 1180, height: 820 });
  await expect(name).toHaveCSS("visibility", "visible");
  await expect(name).toHaveCSS("position", "static");
  await expect(pr).toHaveText("PR #1234");
  await expect(pr).toBeVisible();
  expect(await whole()).toEqual({ device: true, pose: true });
  expect(await dropped()).toBe("");
  assert.deepEqual(errors, []);
});

test("a hosted manifest larger than the Viewer reads is refused before it is parsed", { timeout: 60_000 }, async t => {
  const preview = { token: "klmnopqrstuvwxyz2345672345672345", padding: 11 * 1024 * 1024 };
  const { page, errors } = await harness(t, await archive(), { app: true, reportIdentity: null, preview, query: "" });
  const shell = page.locator(".report-loading-shell");
  await expect(shell).toHaveAttribute("data-loading-status", "failed");
  await expect(shell).toContainText("This report's index is larger than the Viewer opens.");
  assert.deepEqual(errors, []);
});

test("D, ⌥1–⌥8 and ` switch targets from the keyboard, and the other report opens at the same place", { timeout: 60_000 }, async t => {
  const report = reportFixture();
  report.review.runtime = { ...report.review.runtime, platform: "android", platforms: ["ios", "android"] };
  const ios = reportFixture();
  ios.review.runtime = { ...ios.review.runtime, platform: "ios", platforms: ["ios", "android"] };
  const preview = { token: "ijklmnopqrstuvwxyz23456723456723", listing: [{ platform: "ios" }, { platform: "android" }],
    archives: { "?platform=ios": await archive(ios) } };
  // An Apple keyboard, where ⌥ digits reach the page (Linux browsers keep Alt+1–8 for their tabs).
  const { page, errors } = await harness(t, await archive(report), { app: true, reportIdentity: null, preview,
    query: "&platform=android&focus=modified&screen=home&inspect=diff",
    fault: () => { Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }); } });
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/map\/home\?/);
  const place = new URL(page.url()).hash;
  await page.evaluate(() => { window.__samePage = true; });
  const target = () => new URL(page.url()).searchParams.get("platform");
  // The other report swaps into the running Viewer (no loading screen between): the pill names it once it is up.
  const shown = async (label) => expect(page.locator(".collapsed-platform").first()).toHaveText(label);

  // ` returns to the last target; before there is one, it opens the next in the menu.
  await page.keyboard.press("Backquote");
  await expect.poll(target).toBe("ios");
  await shown("iOS");
  const carried = new URL(page.url()).hash;
  assert.equal(carried.split("?")[0], place.split("?")[0], "the other report opens at the same canvas and route");
  assert.equal(new URLSearchParams(carried.split("?")[1]).get("inspect"), "diff");
  assert.equal(new URLSearchParams(carried.split("?")[1]).get("screen"), null, "a screen id belongs to one report");
  await expect(page.locator(".map-canvas .is-selected")).toHaveCount(1);
  await page.keyboard.press("Backquote");
  await expect.poll(target).toBe("android");
  await shown("Android");

  // D opens the menu, which prints each target's ⌥ key.
  await page.keyboard.press("KeyD");
  const items = page.getByRole("menu", { name: "Platform" }).getByRole("menuitemradio");
  await expect(items).toHaveCount(2);
  assert.deepEqual(await items.evaluateAll(rows => rows.map(row => row.querySelector(".menu-row-shortcut")?.textContent)), ["⌥1", "⌥2"]);
  await page.keyboard.press("Escape");
  await expect(items).toHaveCount(0);

  await page.keyboard.press("Alt+Digit1");
  await expect.poll(target).toBe("ios");
  await shown("iOS");
  // The shown target's own key does nothing.
  await page.keyboard.press("Alt+Digit1");
  await page.keyboard.press("Alt+Digit2");
  await expect.poll(target).toBe("android");
  await shown("Android");
  assert.equal(await page.evaluate(() => window.__samePage), true, "every switch stays on the page");

  await page.keyboard.press("Shift+Slash");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toContainText("Another platform's report");
  await expect(dialog).toContainText("⌥1–⌥2");
  await expect(dialog).toContainText("Back to the last platform");
  assert.deepEqual(errors, []);
});

test("a target switch keeps the chosen appearance when the other report was captured in it, and its own otherwise", { timeout: 60_000 }, async t => {
  /** A report of `platform`, with every surface also captured in dark when `dark`. */
  const report = (platform, dark) => {
    const fixture = reportFixture();
    fixture.review.runtime = { ...fixture.review.runtime, platform, platforms: ["ios", "android"], ...(dark ? { colorSchemes: ["light", "dark"] } : {}) };
    if (dark) fixture.review.surfaces.push({ ...structuredClone(fixture.review.surfaces[0]), id: "home@dark", colorScheme: "dark" });
    return fixture;
  };
  const preview = { token: "klmnopqrstuvwxyz2345672345672345", listing: [{ platform: "ios" }, { platform: "android" }],
    archives: { "?platform=ios": await archive(report("ios", false)), "?platform=android": await archive(report("android", true)) } };
  const { page, errors } = await harness(t, await archive(report("android", true)), { app: true, reportIdentity: null, preview, query: "&platform=android" });
  const target = () => new URL(page.url()).searchParams.get("platform");
  const appearance = page.getByRole("button", { name: /^Appearance: / });
  await expect(appearance).toHaveText(/Light/);
  await page.keyboard.press("Shift+KeyT");
  await expect(appearance).toHaveText(/Dark/);
  // iOS was captured in light only: it shows light and offers no switch.
  await page.keyboard.press("Backquote");
  await expect.poll(target).toBe("ios");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(appearance).toHaveCount(0);
  // Back on Android, the choice still holds.
  await page.keyboard.press("Backquote");
  await expect.poll(target).toBe("android");
  await expect(appearance).toHaveText(/Dark/);
  // A reload of the tab keeps it as well.
  await page.reload();
  await expect(appearance).toHaveText(/Dark/);
  assert.deepEqual(errors, []);
});

test("going back during a switch shows the report the page was on, and the slow one does not replace it", { timeout: 60_000 }, async t => {
  const { page, errors, switchToIos } = await slowSwitchHarness(t, "ghijklmnopqrstuvwxyz234567234567", 3000);
  await switchToIos();
  await page.goBack();
  await page.waitForURL(url => new URL(url).searchParams.get("platform") === "android");
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 1500 });
  await page.locator(".app-shell").evaluate(shell => { shell.dataset.kept = "true"; });
  await page.waitForTimeout(3500);
  assert.equal(new URL(page.url()).searchParams.get("platform"), "android");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-kept", "true");
  assert.deepEqual(errors, []);
});

test("report links name their target: ?target=, ?platform= from before targets, and the artifact file name", async t => {
  const { page } = await harness(t, undefined, { reportIdentity: null, query: "" });
  const result = await page.evaluate(() => {
    const api = window.archiveApi;
    const attempt = fn => { try { return fn(); } catch (error) { return `error: ${error.message}`; } };
    const preview = "http://x/p/abcdefghijklmnopqrstuvwxyz234567";
    const manifest = page => api.previewManifestUrl(api.previewToken(page), api.reportTarget(page));
    return {
      target: manifest(new URL(`${preview}?target=duo-open`)),
      platform: manifest(new URL(`${preview}?platform=android`)),
      none: manifest(new URL(preview)),
      asset: api.previewAssetUrl("abcdefghijklmnopqrstuvwxyz234567", `assets/${"a".repeat(64)}.png`),
      both: attempt(() => api.reportTarget(new URL(`${preview}?target=duo-open&platform=ios`))),
      invalid: attempt(() => api.reportTarget(new URL(`${preview}?target=Duo`))),
      reserved: attempt(() => api.reportTarget(new URL(`${preview}?target=report`))),
      identity: api.artifactIdentity(new URL("http://x/r?repo=expo/example&run=1&attempt=2&target=duo-open")),
      legacy: api.artifactIdentity(new URL("http://x/r?repo=expo/example&run=1&attempt=2&platform=android")),
      fileName: api.reportFileName({ run: "1", attempt: "2", target: "duo-open" }),
      legacyFileName: api.reportFileName({ run: "1", attempt: "2", target: "ios" }),
    };
  });
  assert.deepEqual(result, {
    target: "/p/abcdefghijklmnopqrstuvwxyz234567/manifest.json?target=duo-open",
    platform: "/p/abcdefghijklmnopqrstuvwxyz234567/manifest.json?platform=android",
    none: "/p/abcdefghijklmnopqrstuvwxyz234567/manifest.json",
    // A screenshot is a static file named by its content, the same for every target.
    asset: `/p/abcdefghijklmnopqrstuvwxyz234567/assets/${"a".repeat(64)}.png`,
    both: "error: This report link needs one target, such as ios or android.",
    invalid: "error: This report link needs one target, such as ios or android.",
    reserved: "error: This report link needs one target, such as ios or android.",
    identity: { repo: "expo/example", run: "1", attempt: "2", target: "duo-open" },
    legacy: { repo: "expo/example", run: "1", attempt: "2", target: "android" },
    fileName: "explore-review-1-2-duo-open.zip",
    legacyFileName: "explore-review-1-2-ios.zip",
  });
});

test("a bare /r opens any report and takes its identity from review.json", async t => {
  const { page, errors, origin } = await harness(t, undefined, { app: true, reportIdentity: null, query: "" });
  const drop = page.locator(".report-drop");
  await expect(drop.getByRole("heading", { name: "Open a report", exact: true })).toBeVisible();
  await expect(drop.getByRole("link")).toHaveCount(0);
  await expect(drop.locator("code").first()).toHaveText("explore-review-<id>.zip");
  await expect(page.locator(".left-panel")).toContainText("Explore");
  await chooseFile(page, await archive());
  await expect(page.locator(".app-shell")).toBeVisible();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/r");
  // The run named inside the report keys the saved copy, so its comment links open without a drop.
  await page.goto(`${origin}/r?${new URLSearchParams(identity)}`);
  await expect(page.locator(".app-shell")).toBeVisible();
  assert.deepEqual(errors, []);
});

test("oversized files are refused before hashing, and archives reject path traversal", async t => {
  const { page } = await harness(t);
  const invalid = await tryOpen(page, await archive(reportFixture(), [{ name: "../escape.txt", bytes: new Uint8Array([1]) }]));
  assert.equal(invalid.ok, false);
  assert.match(invalid.message, /invalid or unsupported|Unsafe filename/);
  const oversized = await page.evaluate(async identity => {
    let hashed = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = (...args) => { hashed++; return digest(...args); };
    const file = new File([new Uint8Array([80, 75, 3, 4])], "huge.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: 257 * 1024 * 1024 });
    try { await window.archiveApi.openReportFile(file, identity); return "accepted"; }
    catch (error) { return { code: error.code, message: error.message, hashed }; }
  }, identity);
  assert.deepEqual(oversized, { code: "too-large", message: "“huge.zip” is larger than the 256 MiB this browser can open.", hashed: 0 });
});

test("artifact archive indexes images without inflating them, reports its phases, and releases shared verified image URLs", async t => {
  const { page, errors } = await harness(t);
  const result = await page.evaluate(async ({ bytes, identity }) => {
    const phases = [];
    const archive = await window.openReport(bytes, identity, "explore-review-123-2.zip", progress => phases.push(progress.phase));
    const before = window.createdUrls.length;
    const sha = archive.data.publicReview.surfaces[0].headImage.sha256;
    const reference = archive.reference(sha);
    const [first, second] = await Promise.all([archive.resolve(reference), archive.resolve(reference)]);
    const bytesRead = [...new Uint8Array(await (await fetch(first)).arrayBuffer())];
    archive.release(reference);
    const retained = !window.revokedUrls.includes(first);
    archive.release(reference);
    // The last release keeps the URL for a quick return rather than revoking it.
    const kept = !window.revokedUrls.includes(first);
    const again = await archive.resolve(reference);
    archive.release(reference);
    return { phases, identity: archive.identity, before, shared: first === second, retained, kept,
      reused: again === first, created: window.createdUrls.length - before, bytes: bytesRead };
  }, { bytes: [...await archive()], identity });
  assert.deepEqual(result.phases, ["verifying", "opening"]);
  assert.deepEqual(result.identity, identity);
  assert.equal(result.before, 0);
  assert.equal(result.shared, true);
  assert.equal(result.retained, true);
  assert.equal(result.kept, true);
  assert.equal(result.reused, true);
  assert.equal(result.created, 1);
  assert.deepEqual(Buffer.from(result.bytes), png);
  // The opened ZIP is saved for the run it belongs to and reopens through the cache with its own phases.
  const cached = await page.evaluate(async identity => {
    const phases = [];
    const archive = await window.archiveApi.openCachedReport(identity, progress => phases.push(`${progress.phase}${progress.cached ? ":cached" : ""}`));
    return { phases, route: archive?.data.publicReview.surfaces[0].head.route };
  }, identity);
  assert.deepEqual(cached, { phases: ["cache", "verifying:cached", "opening:cached"], route: "/home" });
  assert.deepEqual(errors, []);
});

/** A report whose image index holds `count` distinct screenshots; its one surface shows the first. */
async function multiImageArchive(count) {
  return imageArchive(Array.from({ length: count }, (_, index) => {
    const picture = new PNG({ width: 8, height: 16 });
    for (let offset = 0; offset < picture.data.length; offset += 4) picture.data.set([index, 255 - index, (index * 37) % 256, 255], offset);
    return PNG.sync.write(picture);
  }));
}

/**
 * `count` distinct screenshots of exactly `byteLength` bytes each. The archive checks only an
 * image's signature and hash, so a PNG signature over zeros stands in; it deflates to almost nothing.
 */
async function largeImageArchive(count, byteLength) {
  return imageArchive(Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.alloc(byteLength);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, index]);
    return bytes;
  }), 6);
}

async function imageArchive(pictures, level = 0, report = reportFixture()) {
  const images = pictures.map(bytes => ({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") }));
  for (const side of ["baseImage", "headImage"]) report.review.surfaces[0][side].sha256 = images[0].sha256;
  report.assets = images.map(({ sha256 }) => ({ sha256, path: `assets/${sha256}.png` }));
  const writer = new ZipWriter(new BlobWriter("application/zip"), { useWebWorkers: false });
  await writer.add("review.json", new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(report))), { level: 6 });
  for (const { bytes, sha256 } of images) await writer.add(`assets/${sha256}.png`, new Uint8ArrayReader(bytes), { level });
  const zip = Buffer.from(await (await writer.close()).arrayBuffer());
  return { bytes: [...zip], shas: images.map(image => image.sha256), ranges: await entryRanges(zip) };
}

/** Each screenshot's byte range in the ZIP, from its local header to the next entry: `{ sha256: [start, end] }`. */
async function entryRanges(zip) {
  const reader = new ZipReader(new BlobReader(new Blob([zip])));
  const entries = (await reader.getEntries()).sort((a, b) => a.offset - b.offset);
  await reader.close();
  return Object.fromEntries(entries.flatMap((entry, index) => {
    const sha256 = /^assets\/([a-f0-9]{64})\.png$/.exec(entry.filename)?.[1];
    return sha256 ? [[sha256, [entry.offset, entries[index + 1]?.offset ?? zip.length]]] : [];
  }));
}

/**
 * Page helpers: every later screenshot hash waits for `next()` or `all()`, and `hashed()` records,
 * in call order, which screenshot each hash belongs to. `reads()` counts ZIP reads, and
 * `readsWithin([start, end])` those that start inside one entry's byte range.
 */
const decodeProbe = () => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
  const slice = Blob.prototype.slice;
  const reads = [];
  Blob.prototype.slice = function (...args) { reads.push(args[0] ?? 0); return slice.apply(this, args); };
  const held = [];
  const hashed = [];
  crypto.subtle.digest = (algorithm, data) => {
    const entry = { sha256: undefined };
    hashed.push(entry);
    void digest(algorithm, data).then(value => { entry.sha256 = hex(value); });
    return new Promise(resolve => held.push(() => resolve(digest(algorithm, data))));
  };
  const until = async check => { for (let tries = 0; !check(); tries++) {
    if (tries > 400) throw new Error("The decode queue stalled");
    await new Promise(resolve => setTimeout(resolve, 5));
  } };
  return {
    reads: () => reads.length,
    readsWithin: ([start, end]) => reads.filter(offset => offset >= start && offset < end).length,
    hashed: () => hashed.map(entry => entry.sha256),
    held: () => held.length,
    next: () => held.shift()(),
    all: () => held.splice(0).forEach(release => release()),
    until,
  };
};

test("a screenshot released while it waits for a decode slot is skipped before any of it is read or hashed", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const { bytes, shas, ranges } = await multiImageArchive(6);
  const result = await page.evaluate(async ({ bytes, identity, shas, ranges, probe }) => {
    const archive = await window.openReport(bytes, identity);
    const decodes = new Function(`return (${probe})()`)();
    const references = shas.map(sha => archive.reference(sha));
    const running = references.slice(0, 4).map(reference => archive.resolve(reference));
    await decodes.until(() => decodes.held() === 4);
    const readsWhileBusy = decodes.reads();
    const skippedReadsBefore = decodes.readsWithin(ranges[shas[4]]);
    const skipped = archive.resolve(references[4]).then(() => "resolved", error => error.message);
    archive.release(references[4]);
    // Released and requested again before its turn: it keeps its place and decodes normally.
    const kept = archive.resolve(references[5]);
    archive.release(references[5]);
    const again = archive.resolve(references[5]);
    decodes.next();
    await decodes.until(() => decodes.held() === 4);
    decodes.all();
    await Promise.all(running);
    return { skipped: await skipped, keptShared: await kept === await again, hashed: decodes.hashed(),
      readsSinceBusy: decodes.reads() - readsWhileBusy, skippedReadsBefore,
      readsForSkipped: decodes.readsWithin(ranges[shas[4]]), readsForKept: decodes.readsWithin(ranges[shas[5]]),
      created: window.createdUrls.length };
  }, { bytes, identity, shas, ranges, probe: decodeProbe.toString() });
  assert.equal(result.skipped, "This screenshot is no longer in use.");
  assert.equal(result.keptShared, true);
  assert.deepEqual(result.hashed, [...shas.slice(0, 4), shas[5]], "The released screenshot was never hashed");
  assert.equal(result.skippedReadsBefore, 0);
  assert.equal(result.readsForSkipped, 0, "Not one byte of the released screenshot's entry was read");
  assert.ok(result.readsForKept > 0, "The re-requested screenshot was read");
  assert.equal(result.readsSinceBusy, result.readsForKept, "Every read after the first four belongs to the re-requested screenshot");
  assert.equal(result.created, 5);
  assert.deepEqual(errors, []);
});

test("eager screenshot requests are decoded before earlier lazy ones, and a repeat eager request promotes a waiting one", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const { bytes, shas } = await multiImageArchive(9);
  const order = await page.evaluate(async ({ bytes, identity, shas, probe }) => {
    const archive = await window.openReport(bytes, identity);
    const decodes = new Function(`return (${probe})()`)();
    const references = shas.map(sha => archive.reference(sha));
    const requests = references.slice(0, 4).map(reference => archive.resolve(reference, "lazy"));
    await decodes.until(() => decodes.held() === 4);
    requests.push(archive.resolve(references[4], "lazy"), archive.resolve(references[5], "lazy"),
      archive.resolve(references[6], "eager"), archive.resolve(references[7], "lazy"),
      archive.resolve(references[8], "eager"), archive.resolve(references[5], "eager"));
    // Free one slot at a time so each waiting screenshot starts alone.
    for (let started = 4; started < 9; started++) {
      decodes.next();
      await decodes.until(() => decodes.hashed().length > started && decodes.hashed()[started]);
    }
    decodes.all();
    await Promise.all(requests);
    return decodes.hashed().slice(4).map(sha => shas.indexOf(sha));
  }, { bytes, identity, shas, probe: decodeProbe.toString() });
  assert.deepEqual(order, [6, 8, 5, 4, 7]);
  assert.deepEqual(errors, []);
});

test("released screenshot URLs stay in a bounded cache, are evicted least recently released first, and are revoked on close", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const limit = await page.evaluate(() => window.archiveApi.RETAINED_SCREENSHOTS);
  assert.equal(limit, 32);
  const { bytes, shas } = await multiImageArchive(limit + 3);
  const result = await page.evaluate(async ({ bytes, identity, shas, limit }) => {
    const archive = await window.openReport(bytes, identity);
    const references = shas.map(sha => archive.reference(sha));
    const revoked = url => window.revokedUrls.includes(url);
    const urls = [];
    // Screenshot 0 stays in use throughout: filling the cache past its limit never revokes it.
    urls[0] = await archive.resolve(references[0]);
    for (let index = 1; index <= limit + 1; index++) {
      urls[index] = await archive.resolve(references[index]);
      archive.release(references[index]);
    }
    const afterFill = { inUse: revoked(urls[0]), oldest: revoked(urls[1]), rest: urls.slice(2).filter(revoked).length };
    // Returning to a kept screenshot reuses its URL and makes it the most recent again.
    const created = window.createdUrls.length;
    const reused = await archive.resolve(references[2]) === urls[2];
    archive.release(references[2]);
    urls[limit + 2] = await archive.resolve(references[limit + 2]);
    archive.release(references[limit + 2]);
    const afterReturn = { created: window.createdUrls.length - created, reused, returned: revoked(urls[2]), next: revoked(urls[3]) };
    archive.release(references[0]);
    const releasedInUse = revoked(urls[0]);
    archive.dispose();
    return { afterFill, afterReturn, releasedInUse, allRevoked: urls.every(revoked), revocations: window.revokedUrls.length, total: window.createdUrls.length };
  }, { bytes, identity, shas, limit });
  assert.deepEqual(result.afterFill, { inUse: false, oldest: true, rest: 0 });
  assert.deepEqual(result.afterReturn, { created: 1, reused: true, returned: false, next: true });
  assert.equal(result.releasedInUse, false);
  assert.equal(result.allRevoked, true);
  assert.equal(result.revocations, result.total, "Every Blob URL is revoked exactly once");
  assert.deepEqual(errors, []);
});

test("released screenshot URLs are also bounded by their total size, least recently released first", { timeout: 60_000 }, async t => {
  const { page, errors } = await harness(t);
  const limit = await page.evaluate(() => window.archiveApi.RETAINED_SCREENSHOT_BYTES);
  assert.equal(limit, 128 * 1024 * 1024);
  // Four of these fit in the limit; a fifth does not, while the count limit is far away.
  const { bytes, shas } = await largeImageArchive(6, 30 * 1024 * 1024);
  const result = await page.evaluate(async ({ bytes, identity, shas }) => {
    const archive = await window.openReport(bytes, identity);
    const references = shas.map(sha => archive.reference(sha));
    const urls = [];
    const revoked = () => urls.map(url => window.revokedUrls.includes(url));
    const visit = async index => {
      urls[index] = await archive.resolve(references[index]);
      archive.release(references[index]);
    };
    for (let index = 0; index < 4; index++) await visit(index);
    const afterFour = revoked();
    await visit(4);
    const afterFifth = revoked();
    // A screenshot in use again leaves the cache with its bytes, so the cache takes one more.
    const created = window.createdUrls.length;
    const reused = await archive.resolve(references[1]) === urls[1];
    await visit(5);
    const whileInUse = revoked();
    archive.release(references[1]);
    const afterReturn = revoked();
    archive.dispose();
    return { afterFour, afterFifth, reused, whileInUse, afterReturn, created: window.createdUrls.length - created,
      allRevoked: revoked().every(Boolean), revocations: window.revokedUrls.length, total: window.createdUrls.length };
  }, { bytes, identity, shas });
  assert.deepEqual(result.afterFour, [false, false, false, false]);
  assert.deepEqual(result.afterFifth, [true, false, false, false, false]);
  assert.equal(result.reused, true);
  assert.deepEqual(result.whileInUse, [true, false, false, false, false, false]);
  assert.deepEqual(result.afterReturn, [true, false, true, false, false, false]);
  assert.equal(result.created, 1);
  assert.equal(result.allRevoked, true);
  assert.equal(result.revocations, result.total, "Every Blob URL is revoked exactly once");
  assert.deepEqual(errors, []);
});

test("closing a report mid-decode rejects waiting and running screenshots without creating Blob URLs", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const { bytes, shas } = await multiImageArchive(6);
  const result = await page.evaluate(async ({ bytes, identity, shas, probe }) => {
    const archive = await window.openReport(bytes, identity);
    const decodes = new Function(`return (${probe})()`)();
    const outcome = promise => promise.then(() => "resolved", error => error.message);
    const requests = shas.map(sha => outcome(archive.resolve(archive.reference(sha))));
    await decodes.until(() => decodes.held() === 4);
    archive.dispose();
    const waiting = await Promise.all(requests.slice(4));
    decodes.all();
    const running = await Promise.all(requests.slice(0, 4));
    const late = await outcome(archive.resolve(archive.reference(shas[0])));
    return { waiting, running, late, hashed: decodes.hashed().length, created: window.createdUrls.length };
  }, { bytes, identity, shas, probe: decodeProbe.toString() });
  assert.deepEqual(result.waiting, Array(2).fill("This report was closed."));
  assert.deepEqual(result.running, Array(4).fill("This report was closed."));
  assert.equal(result.late, "This report screenshot is unavailable.");
  assert.equal(result.hashed, 4);
  assert.equal(result.created, 0);
  assert.deepEqual(errors, []);
});

test("a screenshot released while it decodes is kept for a quick return instead of being thrown away", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const { bytes, shas } = await multiImageArchive(1);
  const result = await page.evaluate(async ({ bytes, identity, shas, probe }) => {
    const archive = await window.openReport(bytes, identity);
    const decodes = new Function(`return (${probe})()`)();
    const reference = archive.reference(shas[0]);
    const first = archive.resolve(reference);
    await decodes.until(() => decodes.held() === 1);
    archive.release(reference);
    // A second release of a load nobody holds changes nothing.
    archive.release(reference);
    decodes.all();
    const url = await first;
    const kept = !window.revokedUrls.includes(url);
    const again = await archive.resolve(reference);
    return { kept, reused: again === url, hashed: decodes.hashed().length, created: window.createdUrls.length };
  }, { bytes, identity, shas, probe: decodeProbe.toString() });
  assert.deepEqual(result, { kept: true, reused: true, hashed: 1, created: 1 });
  assert.deepEqual(errors, []);
});

test("artifact loader rejects a report bound to a different run before exposing screenshots", async t => {
  const report = reportFixture();
  report.review.runAttempt = "1";
  const { page } = await harness(t);
  const result = await tryOpen(page, await archive(report));
  assert.equal(result.code, "mismatch");
  assert.equal(result.message, "This file is the report for expo/example run 123 attempt 1. This link expects expo/example run 123 attempt 2 (explore-review-123-2.zip).");
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
  assert.equal(await page.evaluate(async () => (await (await caches.open("explore-reports")).keys()).length), 0);
  // Without a linked run, the same file opens and names its own run.
  const bare = await tryOpen(page, await archive(report), null, "explore-review-123-1.zip");
  assert.deepEqual(bare, { ok: true, identity: { repo: "expo/example", run: "123", attempt: "1" } });
});

test("artifact image hashes are verified on demand and failed images create no Blob URL", async t => {
  const damaged = Buffer.from(png);
  damaged[damaged.length - 1] ^= 1;
  const { page } = await harness(t);
  const result = await page.evaluate(async ({ bytes, identity }) => {
    const archive = await window.openReport(bytes, identity);
    try { await archive.resolve(archive.reference(archive.data.publicReview.surfaces[0].headImage.sha256)); return "accepted"; }
    catch (error) { return error.message; }
  }, { bytes: [...await archive(reportFixture(), [], damaged)], identity });
  assert.match(result, /checksum/);
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
});

/** Hold every screenshot hash (not the report's) until the test lets them finish. */
const holdScreenshotHashes = (byteLength = png.length) => `(() => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const held = [];
  window.releaseScreenshotHashes = () => held.splice(0).forEach(release => release());
  crypto.subtle.digest = (algorithm, data) => data.byteLength !== ${byteLength} ? digest(algorithm, data)
    : new Promise(resolve => held.push(() => resolve(digest(algorithm, data))));
})();`;

test("a screenshot still being verified shows the Inspector spinner and quiet canvas frames, never a broken image", async t => {
  const { page, errors } = await harness(t, await archive(), { app: true, fault: holdScreenshotHashes() });
  await expect(page.locator(".app-shell")).toBeVisible();
  // The Inspector's review shows Before and After in two frames.
  const sides = page.locator(".sidebar-review .compare-frame");
  await expect(sides).toHaveCount(2);
  for (const side of await sides.all()) {
    await expect(side.getByRole("status", { name: "Loading screenshot", exact: true })).toBeVisible();
    const image = side.locator("img");
    await expect(image).toHaveAttribute("data-screenshot-state", "loading");
    await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  }
  const canvasImage = page.locator(".map-canvas img[data-screenshot-src]").first();
  await expect(canvasImage).toHaveAttribute("data-screenshot-state", "loading");
  // The canvas frame stays: the waiting image keeps its box, border and background, in the
  // screenshot's own recorded size.
  const frame = await canvasImage.evaluate(image => ({ width: image.getBoundingClientRect().width,
    border: getComputedStyle(image).borderTopWidth, ring: getComputedStyle(image).boxShadow !== "none",
    complete: image.complete, natural: [image.naturalWidth, image.naturalHeight] }));
  assert.ok(frame.width > 0, `The waiting canvas image keeps its frame: ${JSON.stringify(frame)}`);
  // A changed screen keeps the 1px border and draws its emphasis as an outside ring.
  assert.deepEqual([frame.border, frame.ring, frame.complete, frame.natural], ["1px", true, true, [32, 64]]);
  assert.equal(await page.locator("img:not([src])").count(), 0, "No image waits without a source");
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);

  await page.evaluate(() => window.releaseScreenshotHashes());
  for (const side of await sides.all()) {
    await expect(side.locator("img")).toHaveAttribute("data-screenshot-state", "ready");
    await expect(side.locator("img")).toHaveAttribute("src", /^blob:/);
    await expect(side.getByRole("status")).toHaveCount(0);
  }
  await expect(canvasImage).toHaveAttribute("src", /^blob:/);
  assert.deepEqual(errors, []);
});

test("a waiting canvas screenshot takes the shape of the screenshot it waits for on the Map and Screens", { timeout: 60_000 }, async t => {
  // A 20:9 capture: neither the Map slot's own proportions nor the default phone ratio.
  const picture = new PNG({ width: 360, height: 800 });
  picture.data.fill(255);
  const capture = PNG.sync.write(picture);
  const report = reportFixture();
  const home = report.review.surfaces[0];
  for (const side of ["baseImage", "headImage"]) Object.assign(home[side], { width: 360, height: 800 });
  const empty = { contract: "explore.navigation", edges: [], modalSurfaceIds: [], unresolved: [] };
  report.review.navigation = { base: structuredClone(empty), head: empty };
  const { bytes } = await imageArchive([capture], 0, report);
  const { page, errors } = await harness(t, Buffer.from(bytes), { app: true, fault: holdScreenshotHashes(capture.length) });
  await expect(page.locator(".app-shell")).toBeVisible();
  const canvasView = name => page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name, exact: true });
  // Layout boxes, which the canvas zoom does not scale.
  const frame = async (canvas, state) => {
    const image = page.locator(`${canvas} .screen-node-image img[data-screenshot-src]`);
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute("data-screenshot-state", state);
    return image.evaluate(element => ({ left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight }));
  };
  for (const [view, canvas] of [["Map", ".map-canvas"], ["Screens", ".screens-page"]]) {
    if (view !== "Map") {
      // The decoded screenshot is kept, so each view waits afresh after a reload from the report cache.
      await canvasView(view).click();
      // The switch commits inside a view transition; reload only once it has.
      await expect(canvasView(view)).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await expect(page.locator(".app-shell")).toBeVisible();
      await expect(canvasView(view)).toHaveAttribute("aria-pressed", "true");
    }
    const waiting = await frame(canvas, "loading");
    assert.ok(waiting.width > 0 && waiting.height > waiting.width, `${view}: ${JSON.stringify(waiting)}`);
    await page.evaluate(() => window.releaseScreenshotHashes());
    assert.deepEqual(await frame(canvas, "ready"), waiting, `The ${view} frame does not move or resize when its screenshot loads`);
  }
  assert.deepEqual(errors, []);
});

test("a canvas screen without a readable screenshot is framed like the screenshot it stands in for on the Map and Screens", { timeout: 60_000 }, async t => {
  // Home records a 20:9 capture whose bytes fail verification. Profile shares those bytes but
  // records a 390 x 845 phone capture, the size a screen without one is framed at; About has none.
  const damaged = Buffer.from(png);
  damaged[damaged.length - 1] ^= 1;
  const report = reportFixture();
  const home = report.review.surfaces[0];
  for (const side of ["baseImage", "headImage"]) Object.assign(home[side], { width: 360, height: 800 });
  const route = id => ({ ...home.head, id, route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`, logicalPath: `app/${id}.tsx` });
  const phone = image => ({ ...image, width: 390, height: 845 });
  report.review.surfaces.push(
    { id: "profile", status: "unchanged", base: route("profile"), head: route("profile"),
      baseImage: phone(home.baseImage), headImage: phone(home.headImage),
      baseOutcome: { ...home.baseOutcome }, headOutcome: { ...home.headOutcome } },
    { id: "about", status: "unchanged", base: route("about"), head: route("about") });
  const empty = { contract: "explore.navigation", edges: [], modalSurfaceIds: [], unresolved: [] };
  report.review.navigation = { base: structuredClone(empty), head: empty };
  const { page, errors } = await harness(t, await archive(report, [], damaged), { app: true, fault: holdScreenshotHashes() });
  await expect(page.locator(".app-shell")).toBeVisible();
  const canvasView = name => page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name, exact: true });
  // Layout boxes, which the canvas zoom does not scale.
  const frame = locator => locator.evaluate(element => ({ left: element.offsetLeft, top: element.offsetTop,
    width: element.offsetWidth, height: element.offsetHeight }));
  for (const [view, canvas] of [["Map", ".map-canvas"], ["Screens", ".screens-page"]]) {
    if (view !== "Map") {
      // A failed screenshot is tried afresh after a reload, so each view waits for it again.
      await canvasView(view).click();
      // The switch commits inside a view transition; reload only once it has.
      await expect(canvasView(view)).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await expect(page.locator(".app-shell")).toBeVisible();
      await expect(canvasView(view)).toHaveAttribute("aria-pressed", "true");
    }
    const card = path => page.locator(`${canvas} :is(.react-flow__node, .screens-cell)`).filter({ hasText: path }).locator(".screen-node-image");
    const waiting = card("/home").locator("img[data-screenshot-src]");
    await expect(waiting).toHaveAttribute("data-screenshot-state", "loading");
    const before = await frame(waiting);
    if (view !== "Map") {
      // The Map draws only the focused Home. On the inventories, no screenshot reads as one more
      // phone screenshot beside the others, not a full-width slot.
      await expect(card("/profile").locator("img")).toHaveAttribute("data-screenshot-state", "loading");
      const missing = card("/about").locator(".image-placeholder");
      await expect(missing).toHaveText("No screenshot");
      assert.deepEqual(await frame(missing), await frame(card("/profile").locator("img")), `${view}: About is framed like Profile`);
      // A Screens cell is as wide as its screenshot, so the placeholder may fill it but never overflow it.
      assert.ok((await frame(missing)).width <= await card("/about").evaluate(slot => slot.clientWidth), `${view}: About keeps inside its slot`);
    }
    await page.evaluate(() => window.releaseScreenshotHashes());
    const failed = card("/home").locator(".image-placeholder");
    await expect(failed).toHaveText("No screenshot");
    assert.deepEqual(await frame(failed), before, `The ${view} frame does not move or resize when its screenshot fails`);
  }
  assert.deepEqual(errors, []);
});

test("a screenshot that fails verification shows No screenshot in the Inspector and on the canvas", async t => {
  const damaged = Buffer.from(png);
  damaged[damaged.length - 1] ^= 1;
  const { page, errors } = await harness(t, await archive(reportFixture(), [], damaged), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  // The Inspector's review shows Before and After in two frames.
  const sides = page.locator(".sidebar-review .compare-frame");
  await expect(sides).toHaveCount(2);
  for (const side of await sides.all()) {
    await expect(side.locator(".screenshot-placeholder")).toHaveText("No screenshot");
    await expect(side.locator("img")).toHaveCount(0);
  }
  const node = page.locator(".map-canvas .screen-node-image").first();
  await expect(node.locator(".image-placeholder")).toHaveText("No screenshot");
  await expect(node.locator("img")).toHaveCount(0);
  assert.equal(await node.locator(".image-placeholder").evaluate(element => getComputedStyle(element).borderTopStyle), "solid");
  assert.equal(await page.locator("img:not([src])").count(), 0);
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
  assert.deepEqual(errors, []);
});

test("transition thumbnails without a readable screenshot show the variant thumbnails' ImageOff glyph", async t => {
  const damaged = Buffer.from(png);
  damaged[damaged.length - 1] ^= 1;
  const report = reportFixture();
  const home = report.review.surfaces[0];
  // One destination shares Home's screenshot, which fails verification; the other has none.
  const route = (id, images) => {
    const side = { ...home.head, id, route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`, logicalPath: `app/${id}.tsx` };
    return { id, status: "unchanged", base: { ...side }, head: side,
      ...(images ? { baseImage: { ...home.baseImage }, headImage: { ...home.headImage },
        baseOutcome: { ...home.baseOutcome }, headOutcome: { ...home.headOutcome } } : {}) };
  };
  report.review.surfaces.push(route("settings", true), route("about", false));
  const graph = { contract: "explore.navigation", edges: ["settings", "about"].map(to => ({ from: "home", to, kind: "push",
    provenance: "source", sourceFile: "app/home.tsx" })), modalSurfaceIds: [], unresolved: [] };
  report.review.navigation = { base: structuredClone(graph), head: graph };
  const { page, errors } = await harness(t, await archive(report, [], damaged), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  const thumbs = page.locator(".inspector .transition-row .transition-thumb");
  await expect(thumbs).toHaveCount(2);
  await expect(page.locator(".inspector .transition-path")).toHaveText(["/about", "/settings"]);
  for (const thumb of await thumbs.all()) {
    await expect(thumb.locator("svg.lucide-image-off")).toHaveCount(1);
    await expect(thumb.locator("img")).toHaveCount(0);
    await expect(thumb.locator("svg.lucide-box")).toHaveCount(0);
  }
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
  assert.deepEqual(errors, []);
});

test("a docs-only report with zero images and no EAS build has no screens to show, and its link to a route says why", async t => {
  const report = reportFixture();
  report.review.mode = "changes";
  report.review.runtime.projectId = "";
  report.review.runtime.buildId = "";
  const surface = report.review.surfaces[0];
  surface.status = "unchanged";
  for (const key of ["review", "baseOutcome", "headOutcome", "baseImage", "headImage"]) delete surface[key];
  const graph = { contract: "explore.navigation", edges: [], modalSurfaceIds: [], unresolved: [] };
  report.review.navigation = { base: structuredClone(graph), head: graph };
  report.assets = [];
  const { page, errors } = await harness(t, await archive(report), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  // The change reaches no screen, so the one route was never captured: the Map and Screens say so instead of an empty page.
  const empty = page.locator(".map-empty");
  await expect(empty.getByRole("heading")).toHaveText("No screens were captured");
  // The link names /home, and the Inspector says why it has no screenshot: the icon above a short label and the report's
  // reason for the gap, centred in a phone-shaped preview frame.
  const placeholder = page.locator(".inspector .inspector-preview .screenshot-placeholder");
  await expect(placeholder.locator("span")).toHaveText("No screenshot");
  await expect(placeholder.locator(".screenshot-placeholder-detail")).toHaveText("Not compared; no capture was recorded");
  const layout = await placeholder.evaluate(node => {
    const box = element => element.getBoundingClientRect();
    const frame = box(node.closest(".inspector-preview"));
    const icon = box(node.querySelector("svg"));
    const label = box(node.querySelector("span"));
    const detail = box(node.querySelector(".screenshot-placeholder-detail"));
    return { frameRatio: frame.width / frame.height, iconSize: [icon.width, icon.height], iconAboveLabel: icon.bottom <= label.top,
      iconOffset: Math.abs(icon.left + icon.width / 2 - (frame.left + frame.width / 2)),
      labelOffset: Math.abs(label.left + label.width / 2 - (frame.left + frame.width / 2)),
      verticalOffset: Math.abs((icon.top + detail.bottom) / 2 - (frame.top + frame.height / 2)),
      labelSize: getComputedStyle(node.querySelector("span")).fontSize };
  });
  assert.deepEqual(layout.iconSize, [20, 20]);
  assert.equal(layout.iconAboveLabel, true);
  assert.ok(layout.iconOffset < 1 && layout.labelOffset < 1 && layout.verticalOffset < 1, JSON.stringify(layout));
  assert.ok(Math.abs(layout.frameRatio - 9 / 19.5) < 0.01, `A missing screenshot keeps the phone frame: ${layout.frameRatio}`);
  assert.equal(layout.labelSize, "12px");
  await expect(page.getByText("No screenshot captured")).toHaveCount(0);
  // With no compared changes the pill has no Changes chip, so no list or filter claims any.
  await expect(page.locator(".collapsed-change-count")).toHaveCount(0);
  await expect(page.locator(".changes-screen-row")).toHaveCount(0);
  await expect(page.locator(".diff-frame.diff-modified, .diff-frame.diff-unchanged")).toHaveCount(0);
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await expect(empty.getByRole("heading")).toHaveText("No screens were captured");
  await expect(page.locator(".screens-cell, .screens-tree-row")).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.createdUrls.length), 0);
  assert.deepEqual(errors, []);
});

/** A report with Home (modified) and Profile (not compared) captured, a new route named in exploration.exclude, and a redirect. */
function omittedRoutesReport() {
  const report = reportFixture();
  const home = report.review.surfaces[0];
  const route = (id, path, extra = {}) => ({ ...home.head, id, route: path, path, routeFile: `app/${id}.tsx`, logicalPath: `app/${id}.tsx`, ...extra });
  const redirect = route("start", "/start", { kind: "redirect", redirectTo: "/home" });
  report.review.surfaces.push(
    { id: "profile", status: "unchanged", base: route("profile", "/profile"), head: route("profile", "/profile"),
      baseImage: { ...home.baseImage }, headImage: { ...home.headImage }, baseOutcome: { ...home.baseOutcome }, headOutcome: { ...home.headOutcome } },
    { id: "channel", status: "added", excluded: true, base: null, head: route("channel", "/c/[channel]") },
    { id: "start", status: "unchanged", base: { ...redirect }, head: redirect });
  return report;
}

test("a public report's excluded route and redirect are not among its screens: Screens, its counts, find, search and the changes leave them out", { timeout: 60_000 }, async t => {
  const { page, errors } = await harness(t, await archive(omittedRoutesReport()), { app: true, query: "&screen=home" });
  await expect(page.locator(".map-canvas .react-flow__node")).toHaveCount(2);
  // The excluded route is new in this change, but it was never captured: it is not a change to review.
  const menu = await openChangesMenu(page);
  await expect(menu.getByRole("group", { name: "Filter changes" }).getByRole("button")).toHaveText(["Modified 1"]);
  await expect(menu.getByText("/c/[channel]")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Screens", exact: true }).click();
  const cells = page.locator(".screens-page .screens-cell");
  await expect(cells).toHaveCount(2);
  await expect(page.locator(".screens-tree-row[data-screen-id]")).toHaveCount(2);
  for (const id of ["channel", "start"]) await expect(page.locator(`[data-screen-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator(".screens-filter .screens-chip")).toHaveText(["Changed1", "All2"]);
  // ← and → step through the two screens and no others.
  await page.locator(".screens-page").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".screens-cell .screen-screenshot-card.selected")).toHaveCount(1);
  const picked = async () => page.locator(".screens-cell:has(.screen-screenshot-card.selected)").getAttribute("data-screen-id");
  const first = await picked();
  await page.keyboard.press("ArrowRight");
  await expect.poll(picked).not.toBe(first);
  const second = await picked();
  await page.keyboard.press("ArrowRight");
  await expect.poll(picked).toBe(second);
  assert.deepEqual([first, second].sort(), ["home", "profile"]);

  // `/` finds the report's screens only.
  await page.keyboard.press("/");
  const find = page.getByRole("searchbox", { name: "Find screens" });
  await expect(find).toBeFocused();
  for (const query of ["channel", "start"]) {
    await find.fill(query);
    await expect(page.locator(".screens-find-empty")).toHaveText(`No screens match “${query}”`);
    await expect(cells).toHaveCount(0);
  }
  await find.fill("profile");
  await expect(cells).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // So does the command palette's screen search.
  await page.keyboard.press("ControlOrMeta+KeyK");
  const palette = page.getByRole("dialog", { name: "Search Explore" });
  const box = palette.getByRole("combobox", { name: "Search screens and commands" });
  await expect(box).toBeFocused();
  await box.fill("/c/");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await box.fill("/st");
  await expect(palette.getByRole("option")).toHaveCount(0);
  await box.fill("/pro");
  await expect(palette.getByRole("option")).toHaveText([/\/profile/]);
  assert.deepEqual(errors, []);
});

test("a link to an excluded route opens it in the Inspector, which says why it has no screenshot, on the Map and on Screens", { timeout: 60_000 }, async t => {
  const { page, errors } = await harness(t, await archive(omittedRoutesReport()), { app: true, query: "&screen=channel" });
  const detail = page.locator(".inspector .inspector-preview .screenshot-placeholder-detail");
  await expect(detail).toHaveText("Excluded by exploration.exclude; never captured");
  await expect(page.locator(".map-canvas .react-flow__node")).toHaveCount(2);
  await expect(page.locator(".map-canvas .react-flow__node.selected")).toHaveCount(0);
  // The same link on Screens, opened afresh: no card is picked, and the Inspector explains the route.
  await page.goto(page.url().replace("#/map/", "#/screens/"));
  await page.reload();
  await expect(page.locator(".screens-page .screens-cell")).toHaveCount(2);
  await expect(page.locator(".screens-cell .screen-screenshot-card.selected")).toHaveCount(0);
  await expect(detail).toHaveText("Excluded by exploration.exclude; never captured");
  assert.deepEqual(errors, []);
});

test("unverified capture diagnostics stay separate from verified Needs review, and source changes nobody compared are not changes", async t => {
  const report = reportFixture();
  const home = report.review.surfaces[0];
  const uncertain = structuredClone(home);
  uncertain.id = "uncertain";
  for (const side of ["base", "head"]) {
    uncertain[side] = { ...uncertain[side], id: uncertain.id, route: "/uncertain", path: "/uncertain",
      routeFile: "app/uncertain.tsx", logicalPath: "uncertain" };
  }
  uncertain.review = { status: "needs-review", description: "Accessibility elements from the verified captures could not be paired" };
  report.review.surfaces.push(uncertain);
  delete home.review;
  home.baseOutcome.landing = "unverified";
  home.headOutcome.landing = "unverified";
  home.baseOutcome.reason = "Destination landing was not verified";
  home.headOutcome.reason = "Destination landing was not verified";
  for (const [id, status] of [["candidate", "modified"], ["untouched", "unchanged"]]) {
    const route = { ...home.head, id, route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`, logicalPath: id };
    report.review.surfaces.push({ id, status, base: { ...route }, head: { ...route } });
  }
  const { page, errors } = await harness(t, await archive(report), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await expect(page.locator(".screens-page .diff-frame.diff-needs-review")).toHaveCount(1);
  // The unverified /home and the never-captured /candidate changed in source only: not compared, like /untouched.
  await expect(page.locator(".screens-page .diff-frame.diff-source-affected")).toHaveCount(0);
  await expect(page.locator(".screens-page .diff-frame.diff-not-compared")).toHaveCount(3);
  await expect(page.locator(".screens-page .diff-frame.diff-modified")).toHaveCount(0);
  const menu = await openChangesMenu(page);
  const chips = menu.getByRole("group", { name: "Filter changes" }).getByRole("button");
  await expect(chips).toHaveText(["Modified 0", "No visible change 1"]);
  assert.deepEqual(errors, []);
});

test("an existing report with operational verdicts opens as diagnostics without false change conclusions", async t => {
  const report = reportFixture();
  const home = report.review.surfaces[0];
  home.review = { status: "needs-review", description: "Base screenshot captured; destination route was not verified", facts: [
    { category: "text", templateId: "old", bullet: "Untrusted previous screen text" },
  ] };
  home.visual = { verdict: "unchanged", reason: "matched", threshold: 0.1, tool: "agent-device@0.20.2" };
  for (const side of ["base", "head"]) {
    home[`${side}Outcome`].landing = "unverified";
    home[`${side}Outcome`].reason = "Observed /login instead of /home";
  }
  const untouched = structuredClone(home);
  untouched.id = "untouched";
  untouched.status = "unchanged";
  untouched.review = { status: "unchanged", description: "Old comparison of unverified screenshots" };
  for (const side of ["base", "head"]) untouched[side] = { ...untouched[side], id: untouched.id,
    route: "/untouched", path: "/untouched", routeFile: "app/untouched.tsx", logicalPath: "untouched" };
  report.review.surfaces.push(untouched);
  for (const status of ["added", "removed"]) {
    const route = { ...home.head, id: status, route: `/${status}`, path: `/${status}`,
      routeFile: `app/${status}.tsx`, logicalPath: status };
    const side = status === "added" ? "head" : "base";
    report.review.surfaces.push({ id: status, status, base: status === "removed" ? route : null,
      head: status === "added" ? route : null,
      [`${side}Outcome`]: { status: "failed", attempts: 1, landing: "unverified", reason: `${side} simulator disconnected` },
      review: { status: "needs-review", description: `${side} capture unavailable` } });
  }
  const { page, errors } = await harness(t, await archive(report), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await expect(page.locator(".screens-page .diff-frame.diff-source-affected")).toHaveCount(0);
  await expect(page.locator(".screens-page .diff-frame.diff-not-compared")).toHaveCount(2);
  await expect(page.locator(".screens-page .diff-frame.diff-unavailable")).toHaveCount(1, "an added route whose capture failed has nothing to show");
  await expect(page.locator(".screens-page .diff-frame.diff-removed")).toHaveCount(1);
  await expect(page.locator(".diff-frame.diff-needs-review, .diff-frame.diff-modified, .diff-frame.diff-unchanged, .diff-frame.diff-added")).toHaveCount(0);
  await expect(page.getByText("Untrusted previous screen text", { exact: true })).toHaveCount(0);
  const diagnostics = await page.evaluate(async () => {
    const { activeArtifactReport } = await import("/src/utils/artifact-report.ts");
    const { publicReviewProjection, publicReviewToWorkspace } = await import("/src/public/public-workspace.ts");
    const review = activeArtifactReport.data.publicReview;
    const projection = publicReviewProjection(review);
    const workspace = publicReviewToWorkspace(review);
    return { surfaces: review.surfaces.map(surface => ({ id: surface.id, review: surface.review, visual: surface.visual })),
      capture: projection.runtimeEvidence['public:home'].current.groups.capture,
      gaps: Object.values(workspace.builds).flatMap(build => build.map.gaps) };
  });
  assert.equal(diagnostics.surfaces.find(surface => surface.id === 'home').review, undefined);
  assert.equal(diagnostics.surfaces.find(surface => surface.id === 'home').visual, undefined);
  assert.equal(diagnostics.capture.find(row => row.label === 'Landing').value, 'Unverified');
  assert.equal(diagnostics.capture.find(row => row.label === 'Capture reason').value, 'Observed /login instead of /home');
  assert.equal(diagnostics.capture.some(row => row.label === 'Review status'), false);
  assert.equal(diagnostics.gaps.filter(gap => gap.status === 'open').length, 6);
  assert.deepEqual(errors, []);
});

// example-review-artifact.zip is the unmodified `explore-review-35721157511-1` GitHub Actions
// artifact of expo/explore-playground PR #1, kept here as a local test fixture.
// example-simulator-screenshot.png is its Settings head image (assets/23652a69….png).
const RECORDED_ARTIFACT = new URL("../fixtures/example-review-artifact.zip", import.meta.url);
const RECORDED_IDENTITY = { repo: "expo/explore-playground", run: "35721157511", attempt: "1", artifact: "10692082776" };
const RECORDED_DIGEST = "7e4964bac68d9a7dcd8c69ab308551af32c6abee1c81cc9feb6ede6a04ed4e7d";

test("a recorded pull-request artifact opens its verified verdicts and every screenshot", { timeout: 60_000 }, async t => {
  const bytes = await readFile(RECORDED_ARTIFACT);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), RECORDED_DIGEST, "the fixture must stay the exact GitHub artifact");
  const { page, errors } = await harness(t, undefined, { app: true, reportIdentity: RECORDED_IDENTITY, query: "" });
  await expect(page.locator(".report-drop code")).toHaveText("explore-review-35721157511-1.zip");
  await chooseFile(page, fileURLToPath(RECORDED_ARTIFACT));
  await expect(page.locator(".app-shell")).toBeVisible();
  const pr = page.getByRole("link", { name: "PR #1 on GitHub" });
  await expect(pr).toHaveText("PR #1");
  // The pill shows the number; its tooltip carries the title.
  await pr.hover();
  await expect(page.locator(".tooltip")).toContainText("Add cats care guide, retire Sweet Bee, refresh share label");
  const menu = await openChangesMenu(page);
  for (const route of ["/cats/care-guide", "/cats", "/games", "/settings", "/games/sweet-bee"]) {
    await expect(menu.getByText(route, { exact: true })).toBeVisible();
  }

  // Its two redirect declarations (/ and /scan/select-photo) were never captured: they are not among its screens.
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  const frames = page.locator(".screens-page .diff-frame");
  await expect(frames).toHaveCount(33);
  for (const [status, count] of [["modified", 3], ["added", 1], ["removed", 1], ["unchanged", 28], ["not-compared", 0]]) {
    await expect(page.locator(`.screens-page .diff-frame.diff-${status}`)).toHaveCount(count);
  }
  const screenshots = page.locator(".screens-page img[data-screenshot-src]");
  await expect(screenshots).toHaveCount(33);
  await expect.poll(() => screenshots.first().evaluate(image => [image.naturalWidth, image.naturalHeight])).toEqual([402, 874]);

  // A chip shows each status that has changes; statuses without any stay out of the way.
  await expect((await openChangesMenu(page)).getByRole("group", { name: "Filter changes" }).getByRole("button"))
    .toHaveText(["Added 1", "Modified 3", "Removed 1"]);
  assert.deepEqual(errors, []);
});

test("local run ZIP opens and reloads without a fabricated GitHub identity", async t => {
  const report = reportFixture();
  const local = { origin: "local", repo: "local/example", run: "auth-run-1", attempt: "1" };
  report.review.runId = local.run; report.review.runAttempt = local.attempt;
  const { base, head, title } = report.review.pullRequest;
  report.review.pullRequest = { origin: "local", repository: local.repo, runId: local.run, base, head, title };
  const { page, errors } = await harness(t, await archive(report), { app: true, reportIdentity: local });
  await expect(page.locator(".app-shell")).toBeVisible();
  // A local run has no pull request to link: the pill says "Local" and its tooltip names the run.
  const localRun = page.locator(".left-panel-collapsed-pill .collapsed-pr");
  await expect(localRun).toHaveText("Local");
  await localRun.hover();
  await expect(page.locator(".tooltip")).toContainText(title);
  await expect(page.locator(".tooltip")).toContainText(`${head.ref} → ${base.ref}`);
  await expect(page.locator('a[href*="github.com/local/"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(localRun).toHaveText("Local");
  assert.deepEqual(errors, []);
});

test("the Inspector stacks Before over After for a landscape screenshot; Swipe and Flip keep one frame", async t => {
  // An opened iPhone Duo's inner display, as a screenshot: wider than tall.
  const picture = new PNG({ width: 951, height: 669 });
  picture.data.fill(255);
  const capture = PNG.sync.write(picture);
  const report = reportFixture();
  for (const side of ["baseImage", "headImage"]) Object.assign(report.review.surfaces[0][side], { width: 951, height: 669 });
  const { bytes } = await imageArchive([capture], 0, report);
  const { page, errors } = await harness(t, Buffer.from(bytes), { app: true, fault: holdScreenshotHashes(capture.length) });
  await expect(page.locator(".app-shell")).toBeVisible();
  const stage = page.locator(".sidebar-review-stage");
  const box = locator => locator.evaluate(element => {
    const { left, top, width, height } = element.getBoundingClientRect();
    return { left, top, width, height };
  });
  const frames = page.locator(".sidebar-review .compare-frame");
  await expect(frames).toHaveCount(2);
  // The report's recorded size shapes the pair before the screenshots load: no side-by-side flash.
  await expect(frames.first().locator("img")).toHaveAttribute("data-screenshot-state", "loading");
  await expect(stage).toHaveClass(/landscape/);
  const waiting = await Promise.all([box(frames.nth(0)), box(frames.nth(1))]);
  await page.evaluate(() => window.releaseScreenshotHashes());
  await expect(frames.first().locator("img")).toHaveAttribute("data-screenshot-state", "ready");
  await expect(stage).toHaveClass(/landscape/);
  const [before, after] = await Promise.all([box(frames.nth(0)), box(frames.nth(1))]);
  assert.deepEqual([before, after], waiting, "The frames do not move or resize when the screenshots load");
  const panel = await box(stage);
  // Each frame takes the review's width; After sits under Before, not beside it.
  assert.ok(Math.abs(before.width - panel.width) <= 2, `Before spans the panel: ${JSON.stringify({ before, panel })}`);
  assert.ok(Math.abs(after.width - panel.width) <= 2, `After spans the panel: ${JSON.stringify({ after, panel })}`);
  assert.ok(after.top >= before.top + before.height, `After is under Before: ${JSON.stringify({ before, after })}`);
  assert.ok(Math.abs(before.width / before.height - 951 / 669) < 0.02, `The frame keeps the screenshot's shape: ${JSON.stringify(before)}`);
  // Swipe and Flip show one frame the panel's width, as before.
  for (const mode of ["Swipe", "Flip"]) {
    await page.locator(".sidebar-review-modes").getByRole("button", { name: mode, exact: true }).click();
    const frame = await box(page.locator(".sidebar-review :is(.visual-swipe, .compare-frame)").first());
    assert.ok(Math.abs(frame.width - panel.width) <= 2, `${mode} spans the panel: ${JSON.stringify({ frame, panel })}`);
  }
  await page.locator(".sidebar-review-modes").getByRole("button", { name: "Split", exact: true }).click();
  await expect(frames).toHaveCount(2);
  assert.deepEqual(errors, []);
});

test("the Inspector keeps a portrait pair side by side", async t => {
  const { page, errors } = await harness(t, await archive(), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  const frames = page.locator(".sidebar-review .compare-frame");
  await expect(frames).toHaveCount(2);
  await expect(frames.first().locator("img")).toHaveAttribute("data-screenshot-state", "ready");
  await expect(page.locator(".sidebar-review-stage")).not.toHaveClass(/landscape/);
  const box = locator => locator.evaluate(element => {
    const { left, top, width } = element.getBoundingClientRect();
    return { left, top, width };
  });
  const [before, after] = await Promise.all([box(frames.nth(0)), box(frames.nth(1))]);
  assert.equal(after.top, before.top, `Before and After share a row: ${JSON.stringify({ before, after })}`);
  assert.ok(after.left >= before.left + before.width, `After is beside Before: ${JSON.stringify({ before, after })}`);
  assert.deepEqual(errors, []);
});

/** A white PNG of `width` × `height`, and the asset entry and record fields a report gives it. */
function sizedCapture(width, height) {
  const picture = new PNG({ width, height });
  picture.data.fill(255);
  const bytes = PNG.sync.write(picture);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256: digest, path: `assets/${digest}.png`,
    record: { url: `https://artifact.expo-explore.invalid/${digest}.png`, sha256: digest, width, height } };
}

test("the Inspector takes a pair's shape from After, whichever side loads last", async t => {
  // A screen that turned landscape: Before is the 32×64 portrait fixture, After is landscape.
  const landscape = sizedCapture(951, 669);
  const report = reportFixture();
  Object.assign(report.review.surfaces[0].headImage, landscape.record);
  report.assets.push({ sha256: landscape.sha256, path: landscape.path });
  // Before's screenshot is held until After's has loaded, so it loads last.
  const { page, errors } = await harness(t, await archive(report, [{ name: landscape.path, bytes: landscape.bytes }]),
    { app: true, fault: holdScreenshotHashes(png.length) });
  await expect(page.locator(".app-shell")).toBeVisible();
  const stage = page.locator(".sidebar-review-stage");
  const frames = page.locator(".sidebar-review .compare-frame");
  await expect(frames).toHaveCount(2);
  await expect(frames.nth(1).locator("img")).toHaveAttribute("data-screenshot-state", "ready");
  await expect(stage).toHaveClass(/landscape/);
  await page.evaluate(() => window.releaseScreenshotHashes());
  await expect(frames.nth(0).locator("img")).toHaveAttribute("data-screenshot-state", "ready");
  await expect(stage).toHaveClass(/landscape/);
  const ratio = await frames.nth(0).evaluate(element => element.getBoundingClientRect().width / element.getBoundingClientRect().height);
  assert.ok(Math.abs(ratio - 951 / 669) < 0.02, `Both frames keep After's shape: ${ratio}`);
  assert.deepEqual(errors, []);
});

test("Swipe takes the loaded screenshot's shape when it differs from the recorded one", async t => {
  // The record says portrait; the screenshot is landscape. Swipe's frame follows the image, as
  // Split's and Flip's do, so a capture whose size the report does not hold is not cropped.
  const landscape = sizedCapture(951, 669);
  const { bytes } = await imageArchive([landscape.bytes]);
  const { page, errors } = await harness(t, Buffer.from(bytes), { app: true, fault: holdScreenshotHashes(landscape.bytes.length) });
  await expect(page.locator(".app-shell")).toBeVisible();
  // Swipe is chosen before any screenshot loads, so only Swipe's images report a size.
  await page.locator(".sidebar-review-modes").getByRole("button", { name: "Swipe", exact: true }).click();
  const swipe = page.locator(".sidebar-review .visual-swipe");
  await expect(swipe).toBeVisible();
  await page.evaluate(() => window.releaseScreenshotHashes());
  await expect(swipe.locator("img.visual-swipe-after")).toHaveAttribute("data-screenshot-state", "ready");
  await expect.poll(() => swipe.evaluate(element => {
    const { width, height } = element.getBoundingClientRect();
    return Math.abs(width / height - 951 / 669) < 0.02;
  })).toBe(true);
  assert.deepEqual(errors, []);
});

test("a near-square landscape pair in a short window keeps both halves on screen, centred", async t => {
  // An unfolded foldable's inner display on its side: barely wider than tall.
  const foldable = sizedCapture(960, 800);
  const report = reportFixture();
  for (const side of ["baseImage", "headImage"]) Object.assign(report.review.surfaces[0][side], { width: 960, height: 800 });
  const { bytes } = await imageArchive([foldable.bytes], 0, report);
  const { page, errors } = await harness(t, Buffer.from(bytes), { app: true });
  await page.setViewportSize({ width: 1440, height: 760 });
  await expect(page.locator(".app-shell")).toBeVisible();
  const stage = page.locator(".sidebar-review-stage");
  await expect(stage).toHaveClass(/landscape/);
  const frames = page.locator(".sidebar-review .compare-frame");
  await expect(frames).toHaveCount(2);
  await expect(frames.nth(1).locator("img")).toHaveAttribute("data-screenshot-state", "ready");
  const box = locator => locator.evaluate(element => {
    const { left, top, width, height, bottom } = element.getBoundingClientRect();
    return { left, top, width, height, bottom };
  });
  const [before, after, panel] = await Promise.all([box(frames.nth(0)), box(frames.nth(1)), box(stage)]);
  const viewport = page.viewportSize();
  assert.ok(after.top >= before.top + before.height, `After is under Before: ${JSON.stringify({ before, after })}`);
  assert.ok(before.top >= 0 && after.bottom <= viewport.height, `Both halves are on screen: ${JSON.stringify({ before, after, viewport })}`);
  for (const frame of [before, after]) {
    assert.ok(frame.width < panel.width - 2, `The frame is held under the panel's width: ${JSON.stringify({ frame, panel })}`);
    assert.ok(Math.abs(frame.left + frame.width / 2 - (panel.left + panel.width / 2)) <= 1, `The frame is centred: ${JSON.stringify({ frame, panel })}`);
    assert.ok(Math.abs(frame.width / frame.height - 960 / 800) < 0.02, `The frame keeps the screenshot's shape: ${JSON.stringify(frame)}`);
  }
  assert.deepEqual(errors, []);
});

/** A capture in a colour of its own, so every side of every screen is a screenshot of its own. */
function tintedCapture(seed) {
  const picture = new PNG({ width: 32, height: 64 });
  for (let offset = 0; offset < picture.data.length; offset += 4) picture.data.set([(seed * 53) % 256, (seed * 101 + 40) % 256, (seed * 151 + 90) % 256, 255], offset);
  const bytes = PNG.sync.write(picture);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256: digest, path: `assets/${digest}.png`, reference: `expo-explore-asset:${digest}.png`,
    record: { url: `https://artifact.expo-explore.invalid/${digest}.png`, sha256: digest, width: 32, height: 64 } };
}

/**
 * `count` modified screens, screen-1 to screen-<count>, each with a Before and an After of its own. `seed` gives
 * another target its own captures. `screens[i]` holds screen-(i + 1)'s `before` and `after`. `sameAfter: { i: j }`
 * gives the screen at index i the After of the one at index j.
 */
async function changedScreensArchive(count, { seed = 1, runtime, sameAfter = {} } = {}) {
  const report = reportFixture();
  const home = report.review.surfaces[0];
  const route = id => ({ ...home.head, id, route: `/${id}`, path: `/${id}`, routeFile: `app/${id}.tsx`, logicalPath: `app/${id}.tsx` });
  const extra = [];
  const screens = [];
  report.assets = [];
  report.review.surfaces = Array.from({ length: count }, (_, index) => {
    const id = `screen-${index + 1}`;
    const before = tintedCapture(seed * 100 + index * 2);
    const after = sameAfter[index] !== undefined ? screens[sameAfter[index]].after : tintedCapture(seed * 100 + index * 2 + 1);
    screens.push({ id, before, after });
    for (const capture of [before, after]) {
      if (report.assets.some(asset => asset.sha256 === capture.sha256)) continue;
      report.assets.push({ sha256: capture.sha256, path: capture.path });
      extra.push({ name: capture.path, bytes: capture.bytes });
    }
    return { ...structuredClone(home), id, base: route(id), head: route(id),
      baseImage: { ...home.baseImage, ...before.record }, headImage: { ...home.headImage, ...after.record } };
  });
  const empty = { contract: "explore.navigation", edges: [], modalSurfaceIds: [], unresolved: [] };
  report.review.navigation = { base: structuredClone(empty), head: empty };
  if (runtime) report.review.runtime = { ...report.review.runtime, ...runtime };
  return { bytes: await archive(report, extra), screens };
}

/** Records each screenshot request (reference, priority, when) and release on the page's report archives. */
async function recordScreenshotReads(page) {
  await page.evaluate(async () => {
    const { ArtifactReportArchive } = await import("/src/utils/artifact-report.ts");
    window.reads = [];
    window.releases = [];
    const { resolve, release } = ArtifactReportArchive.prototype;
    ArtifactReportArchive.prototype.resolve = function (reference, priority) {
      window.reads.push({ reference, priority: priority ?? "lazy", at: performance.now() });
      return resolve.call(this, reference, priority);
    };
    ArtifactReportArchive.prototype.release = function (reference) {
      window.releases.push({ reference, at: performance.now() });
      return release.call(this, reference);
    };
  });
}

/** How many uses of each screenshot the shown report counts, by reference. */
const screenshotUses = page => page.evaluate(async () => {
  const { activeArtifactReport } = await import("/src/utils/artifact-report.ts");
  return Object.fromEntries([...activeArtifactReport.loads.values()].map(load => [`expo-explore-asset:${load.sha256}.png`, load.users]));
});

/** How many mounted images show each screenshot, by reference. */
const mountedScreenshots = page => page.evaluate(() => {
  const counts = {};
  for (const image of document.querySelectorAll("img[data-screenshot-src]")) counts[image.dataset.screenshotSrc] = (counts[image.dataset.screenshotSrc] ?? 0) + 1;
  return counts;
});

/** Every use the report counts belongs to an image on the page; nothing else holds a screenshot. */
async function expectBalancedUses(page, message) {
  await expect.poll(async () => {
    const uses = await screenshotUses(page);
    const mounted = await mountedScreenshots(page);
    return Object.entries(uses).filter(([reference, users]) => users > (mounted[reference] ?? 0));
  }, { message }).toEqual([]);
}

test("Compare reads the next screen's screenshots once it rests on a screen, never while an arrow is held, and they are released when it moves on", { timeout: 90_000 }, async t => {
  const { bytes, screens } = await changedScreensArchive(9);
  const { page, errors } = await harness(t, bytes, { app: true, open: false, query: "&view=compare&screen=screen-1" });
  await recordScreenshotReads(page);
  await chooseFile(page, bytes);
  const compare = page.locator(".compare-section");
  await expect(compare.locator(".compare-frame img")).toHaveCount(2);
  for (const image of await compare.locator(".compare-frame img").all()) await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  const position = compare.locator(".compare-nav-position");
  await expect(position).toHaveText(/^1 of 9$/);
  const shownAt = await page.evaluate(() => Math.min(...window.reads.filter(read => read.priority === "eager").map(read => read.at)));

  // Resting on screen-1, its neighbour in the direction of travel (screen-2) is read, after the settle delay, as a
  // prefetch that leaves the next step's slots free.
  const prefetchesOf = screen => page.evaluate(references => window.reads.filter(read => read.priority === "prefetch" && references.includes(read.reference)),
    [screen.before.reference, screen.after.reference]);
  await expect.poll(async () => (await prefetchesOf(screens[1])).length).toBe(2);
  assert.ok((await prefetchesOf(screens[1]))[0].at - shownAt >= 240, "Nothing is read before Compare rests on the screen");
  assert.equal((await page.evaluate(() => window.reads.filter(read => read.priority === "prefetch"))).length, 2, "Only the neighbour is read");
  await expect.poll(() => screenshotUses(page)).toMatchObject({ [screens[1].before.reference]: 1, [screens[1].after.reference]: 1 });

  // The step finds its pictures decoded: nothing new is decoded for them.
  await expect.poll(() => page.evaluate(() => window.createdUrls.length)).toBe(4);
  await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText(/^2 of 9$/);
  for (const image of await compare.locator(".compare-frame img").all()) await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  assert.equal(await page.evaluate(() => window.createdUrls.length), 4, "The prefetched screenshots were shown without a new decode");

  // A held arrow steps past several screens; nothing is read for a neighbour until it is released.
  await expect.poll(async () => (await prefetchesOf(screens[2])).length).toBe(2);
  const downAt = await page.evaluate(() => performance.now());
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => Number((await position.textContent()).split(" ")[0]), { timeout: 4000 }).toBeGreaterThanOrEqual(6);
  // The stage is marked while the key repeats, so the screenshots it passes appear without a fade.
  await expect(compare.locator(".compare-stage")).toHaveAttribute("data-screenshot-instant", "");
  await page.waitForTimeout(150);
  const upAt = await page.evaluate(() => performance.now());
  await page.keyboard.up("ArrowRight");
  await expect(compare.locator(".compare-stage")).not.toHaveAttribute("data-screenshot-instant", /.*/);
  const heldPrefetches = await page.evaluate(({ downAt, upAt }) => window.reads.filter(read => read.priority === "prefetch" && read.at > downAt && read.at <= upAt), { downAt, upAt });
  assert.deepEqual(heldPrefetches, [], "No neighbour was read while the arrow was held");
  const landed = Number((await position.textContent()).split(" ")[0]);
  const next = screens[landed];
  if (next) await expect.poll(async () => (await prefetchesOf(next)).length).toBe(2);

  // Leaving Compare lets go of every screenshot it, and its prefetch, held.
  await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Screens", exact: true }).click();
  await expect(page.locator(".screens-page")).toBeVisible();
  await expect(compare).toHaveCount(0);
  await expectBalancedUses(page, "Every use left after Compare belongs to an image on Screens");
  const uses = await screenshotUses(page);
  for (const screen of screens) assert.equal(uses[screen.before.reference] ?? 0, 0, `${screen.id}'s Before is no longer in use`);
  assert.deepEqual(errors, []);
});

test("a prefetch never holds a slot the screen the reviewer steps to needs, whichever way the step goes", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const { bytes, shas } = await multiImageArchive(8);
  const result = await page.evaluate(async ({ bytes, identity, shas, probe }) => {
    const archive = await window.openReport(bytes, identity);
    const decodes = new Function(`return (${probe})()`)();
    const [shown, shownToo, ahead, aheadToo, behind, behindToo, later, laterToo] = shas.map(sha => archive.reference(sha));
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    // The screen on show is still being read when Compare rests on it: its neighbour's prefetches wait.
    const visible = [archive.resolve(shown, "eager"), archive.resolve(shownToo, "eager")];
    await decodes.until(() => decodes.held() === 2);
    const waited = [archive.resolve(ahead, "prefetch"), archive.resolve(aheadToo, "prefetch")].map(read => read.then(() => "read", error => error.message));
    await settle();
    const heldWhileShownReads = decodes.held();
    // The reviewer steps the other way before they start: they are dropped, unread.
    archive.release(ahead);
    archive.release(aheadToo);
    const stepped = [archive.resolve(behind, "eager"), archive.resolve(behindToo, "eager")];
    await decodes.until(() => decodes.held() === 4);
    decodes.all();
    await Promise.all([...visible, ...stepped]);
    const dropped = await Promise.all(waited);

    // Resting on that screen, its own neighbour's prefetches start, in the slots its reads have finished with.
    const running = [archive.resolve(later, "prefetch"), archive.resolve(laterToo, "prefetch")];
    await decodes.until(() => decodes.held() === 2);
    // The reviewer steps the other way while they run: they keep their slots, and the screen stepped to starts at once.
    archive.release(later);
    archive.release(laterToo);
    archive.release(shown);
    archive.release(shownToo);
    const back = [archive.resolve(shown, "eager"), archive.resolve(shownToo, "eager")];
    await settle();
    const heldAfterStep = decodes.held();
    decodes.all();
    await Promise.all([...running, ...back]);
    return { heldWhileShownReads, dropped, heldAfterStep, hashed: decodes.hashed() };
  }, { bytes, identity, shas, probe: decodeProbe.toString() });
  assert.equal(result.heldWhileShownReads, 2, "The prefetches waited while the shown screen was still being read");
  assert.deepEqual(result.dropped, ["This screenshot is no longer in use.", "This screenshot is no longer in use."]);
  assert.ok(!result.hashed.includes(shas[2]) && !result.hashed.includes(shas[3]), "A prefetch let go before it started was never read");
  assert.equal(result.heldAfterStep, 2, "The screen stepped to was read at once, beside the running prefetches");
  assert.deepEqual(errors, []);
});

test("Flip reads a screen's Before only once its After has loaded, and flipping reads nothing new", { timeout: 90_000 }, async t => {
  const { bytes, screens } = await changedScreensArchive(4);
  const { page, errors } = await harness(t, bytes, { app: true, open: false, query: "&view=compare&screen=screen-1" });
  await page.addInitScript(() => localStorage.setItem("expo-explore:compare-mode", "flip"));
  await page.reload();
  await recordScreenshotReads(page);
  await chooseFile(page, bytes);
  const frame = page.locator(".compare-section .compare-flip-frame");
  await expect(frame.locator(".compare-flip-layer")).toHaveCount(2);
  for (const image of await frame.locator("img").all()) await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  // The side off screen is hidden, its spinner with it.
  await expect(frame.locator(".compare-flip-layer[data-side='before']")).toHaveAttribute("aria-hidden", "true");
  await expect(frame.locator(".compare-flip-layer[data-side='before']")).toHaveCSS("visibility", "hidden");

  // The next screen's After is held back: its Before is not read meanwhile, and only After's layer is mounted.
  await page.evaluate(after => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
    window.heldAfter = [];
    crypto.subtle.digest = async (algorithm, data) => {
      const value = await digest(algorithm, data);
      if (hex(value) === after) await new Promise(resolve => window.heldAfter.push(resolve));
      return value;
    };
  }, screens[1].after.sha256);
  const readsOf = reference => page.evaluate(reference => window.reads.filter(read => read.reference === reference && read.priority !== "prefetch").length, reference);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".compare-section .compare-nav-position")).toHaveText(/^2 of 4$/);
  await expect(frame.locator(".compare-flip-layer")).toHaveCount(1);
  await page.waitForTimeout(150);
  assert.equal(await readsOf(screens[1].before.reference), 0, "Before is not read while After loads");
  await page.evaluate(() => window.heldAfter.splice(0).forEach(release => release()));
  await expect(frame.locator(".compare-flip-layer")).toHaveCount(2);
  for (const image of await frame.locator("img").all()) await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  // StrictMode mounts each image's lease twice in development.
  assert.ok(await readsOf(screens[1].before.reference) > 0, "Before is read once After has loaded");

  // Flipping swaps the two decoded sides at once.
  const reads = await page.evaluate(() => window.reads.length);
  await page.keyboard.press("KeyX");
  await expect(frame.locator(".compare-flip-layer[data-side='before']")).not.toHaveAttribute("aria-hidden", /.*/);
  await expect(frame.locator(".compare-flip-layer[data-side='after']")).toHaveCSS("visibility", "hidden");
  await expect(frame.locator(".compare-flip-layer[data-side='before'] img")).toHaveCSS("opacity", "1");
  await page.keyboard.press("KeyX");
  await expect(frame.locator(".compare-flip-layer[data-side='after']")).not.toHaveAttribute("aria-hidden", /.*/);
  assert.equal(await page.evaluate(() => window.reads.length), reads, "A flip reads nothing");
  assert.deepEqual(errors, []);
});

test("a Map card's backing draws the frame its screenshot waits and fades in over, and steps aside for No screenshot", { timeout: 60_000 }, async t => {
  const { page, errors } = await harness(t, await archive(), { app: true, fault: holdScreenshotHashes() });
  await expect(page.locator(".app-shell")).toBeVisible();
  const slot = page.locator(".map-canvas .screen-node-image").first();
  const image = slot.locator("img[data-screenshot-src]");
  const backing = slot.locator(".screenshot-backing");
  await expect(image).toHaveAttribute("data-screenshot-state", "loading");
  await expect(image).toHaveCSS("opacity", "0");
  await expect(backing).toHaveCSS("visibility", "visible");
  const frames = () => slot.evaluate(element => {
    const box = node => { const { left, top, width, height } = node.getBoundingClientRect(); return [left, top, width, height].map(value => Math.round(value * 10) / 10); };
    const style = node => { const { borderTopColor, borderTopWidth, borderTopLeftRadius, backgroundColor, boxShadow } = getComputedStyle(node); return { borderTopColor, borderTopWidth, borderTopLeftRadius, backgroundColor, boxShadow }; };
    const [img, backing] = [element.querySelector("img"), element.querySelector(".screenshot-backing")];
    return { image: box(img), backing: box(backing), imageStyle: style(img), backingStyle: style(backing) };
  });
  // The link selects Home, so the frame carries the selection ring past the Modified status.
  await expect(page.locator(".map-canvas .react-flow__node-screen.selected")).toHaveCount(1);
  // The ring follows the canvas zoom, and the backing's ring eases to it as the opening camera settles.
  await expect.poll(async () => { const { backingStyle, imageStyle } = await frames(); return backingStyle.boxShadow === imageStyle.boxShadow; }).toBe(true);
  const waiting = await frames();
  assert.deepEqual(waiting.backing, waiting.image, "The backing sits exactly where the image does");
  assert.deepEqual(waiting.backingStyle, waiting.imageStyle, "and draws the same frame: fill, border, radius, status and ring");
  assert.match(waiting.backingStyle.boxShadow, /rgb\(5, 136, 240\)/);

  await page.evaluate(() => window.releaseScreenshotHashes());
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).toHaveAttribute("data-screenshot-reveal", "");
  assert.deepEqual((await frames()).image, waiting.image, "Loading moved nothing");
  // Once the picture has faded in, the backing hides.
  await expect(backing).toHaveCSS("visibility", "hidden");
  await expect(image).toHaveCSS("opacity", "1");
  assert.deepEqual(errors, []);
});

test("a Map card whose screenshot cannot be read shows No screenshot in one frame, its backing hidden", async t => {
  const damaged = Buffer.from(png);
  damaged[damaged.length - 1] ^= 1;
  const { page, errors } = await harness(t, await archive(reportFixture(), [], damaged), { app: true });
  await expect(page.locator(".app-shell")).toBeVisible();
  const slot = page.locator(".map-canvas .screen-node-image").first();
  await expect(slot.locator(".image-placeholder")).toHaveText("No screenshot");
  await expect(slot.locator(".screenshot-backing")).toHaveCSS("visibility", "hidden");
  assert.deepEqual(errors, []);
});

test("on a phone, a Screens card's screenshot keeps its height while it loads and once it has", { timeout: 60_000 }, async t => {
  const { bytes } = await changedScreensArchive(2);
  const { page, errors } = await harness(t, bytes, { app: true, open: false, fault: holdScreenshotHashes(tintedCapture(100).bytes.length) });
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseFile(page, bytes);
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.goto(`${page.url().split("#")[0]}#/screens`);
  const slot = page.locator(".screens-cell .screen-node-image.has-screenshot").first();
  await expect(slot).toBeVisible();
  const height = () => slot.evaluate(element => [element.getBoundingClientRect().height, element.querySelector("img").getBoundingClientRect().height]);
  const [waiting, waitingImage] = await height();
  assert.ok(waiting > 100 && Math.abs(waiting - waitingImage) < 1, `The waiting screenshot holds the slot open: ${waiting}, ${waitingImage}`);
  // The image is the frame here, and hidden while it loads: its backing draws the same frame in its place.
  await expect(slot.locator("img")).toHaveCSS("opacity", "0");
  const backing = slot.locator(".screenshot-backing");
  await expect(backing).toHaveCSS("visibility", "visible");
  const frames = await slot.evaluate(element => {
    const box = node => { const { left, top, width, height } = node.getBoundingClientRect(); return [left, top, width, height].map(value => Math.round(value)); };
    const style = node => { const { borderTopColor, borderTopWidth, borderTopLeftRadius, backgroundColor, boxShadow } = getComputedStyle(node); return { borderTopColor, borderTopWidth, borderTopLeftRadius, backgroundColor, boxShadow }; };
    const [img, backing] = [element.querySelector("img"), element.querySelector(".screenshot-backing")];
    return { image: box(img), backing: box(backing), imageStyle: style(img), backingStyle: style(backing) };
  });
  assert.deepEqual(frames.backing, frames.image);
  assert.deepEqual(frames.backingStyle, frames.imageStyle, "The backing draws the image's frame: border, fill, radius, status and ring");
  assert.notEqual(frames.backingStyle.backgroundColor, "rgba(0, 0, 0, 0)");
  // Selected, the backing carries the image's ring while the screenshot still loads (a changed screen's is its status).
  await page.goto(`${page.url().split("#")[0]}#/screens?screen=screen-1`);
  const selected = page.locator(".screens-cell .screen-screenshot-card.selected .screen-node-image");
  await expect(selected.locator("img")).toHaveAttribute("data-screenshot-state", "loading");
  const rings = await selected.evaluate(element => [element.querySelector("img"), element.querySelector(".screenshot-backing")]
    .map(node => getComputedStyle(node).boxShadow));
  assert.equal(rings[1], rings[0]);
  assert.notEqual(rings[1], "none");
  await page.evaluate(() => window.releaseScreenshotHashes());
  await expect(slot.locator("img")).toHaveAttribute("data-screenshot-state", "ready");
  assert.deepEqual(await height(), [waiting, waitingImage]);
  assert.deepEqual(errors, []);
});

test("a target switch blanks every card whose screenshot differs, never showing the other target's picture, and switching back reuses the kept pictures", { timeout: 90_000 }, async t => {
  const runtime = { platform: "android", platforms: ["ios", "android"] };
  const android = await changedScreensArchive(3, { seed: 1, runtime });
  const ios = await changedScreensArchive(3, { seed: 2, runtime: { ...runtime, platform: "ios" } });
  const preview = { token: "pqrstuvwxyz234567234567234567234", listing: [{ platform: "ios" }, { platform: "android" }],
    archives: { "?platform=ios": ios.bytes } };
  const { page, errors } = await harness(t, android.bytes, { app: true, reportIdentity: null, preview, query: "&platform=android" });
  await expect(page.locator(".app-shell")).toBeVisible();
  const cards = page.locator(".map-canvas img[data-screenshot-src]");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) await expect(card).toHaveAttribute("data-screenshot-state", "ready");
  const shown = await cards.evaluateAll(images => Object.fromEntries(images.map(image => [image.getAttribute("src"), image.dataset.screenshotSrc])));
  // Hold iOS's screenshots back so the switch is caught while they load.
  await page.evaluate(sizes => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    window.heldIos = [];
    window.releaseIos = () => window.heldIos.splice(0).forEach(release => release());
    window.holdIos = true;
    crypto.subtle.digest = (algorithm, data) => window.holdIos && sizes.includes(data.byteLength)
      ? new Promise(resolve => window.heldIos.push(() => resolve(digest(algorithm, data)))) : digest(algorithm, data);
  }, ios.screens.flatMap(screen => [screen.before.bytes.length, screen.after.bytes.length]));
  // Every frame from the switch on: no card shows a picture under another screenshot's name, and a waiting one is hidden.
  await page.evaluate(shown => {
    window.staleFrames = [];
    window.sampling = true;
    const sample = () => {
      for (const image of document.querySelectorAll(".map-canvas img[data-screenshot-src]")) {
        const source = shown[image.getAttribute("src")];
        const opacity = Number(getComputedStyle(image).opacity);
        if (source && source !== image.dataset.screenshotSrc && opacity > 0) window.staleFrames.push({ source, named: image.dataset.screenshotSrc, opacity });
        if (image.dataset.screenshotState === "loading" && opacity > 0) window.staleFrames.push({ waiting: image.dataset.screenshotSrc, opacity });
      }
      if (window.sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, shown);
  await page.getByRole("button", { name: "Platform: Android. Open another platform's report" }).click();
  await page.getByRole("menu", { name: "Platform" }).getByRole("menuitemradio").nth(0).click();
  await page.waitForURL(url => new URL(url).searchParams.get("platform") === "ios");
  await expect(cards.first()).toHaveAttribute("data-screenshot-src", ios.screens[0].after.reference);
  for (const card of await cards.all()) await expect(card).toHaveAttribute("data-screenshot-state", "loading");
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.holdIos = false; window.releaseIos(); });
  for (const card of await cards.all()) await expect(card).toHaveAttribute("data-screenshot-state", "ready");
  await page.evaluate(() => { window.sampling = false; });
  assert.deepEqual(await page.evaluate(() => window.staleFrames), [], "No frame showed Android's picture on iOS's cards, or a waiting picture");
  await expectBalancedUses(page, "After the switch, the iOS report counts only the cards' uses");

  // Back to Android: its kept pictures come back without a new decode.
  const created = await page.evaluate(() => window.createdUrls.length);
  await page.goBack();
  await page.waitForURL(url => new URL(url).searchParams.get("platform") === "android");
  for (const card of await cards.all()) await expect(card).toHaveAttribute("data-screenshot-state", "ready");
  const back = await cards.evaluateAll(images => Object.fromEntries(images.map(image => [image.getAttribute("src"), image.dataset.screenshotSrc])));
  assert.deepEqual(back, shown, "Android's cards show the Blob URLs they showed before");
  assert.equal(await page.evaluate(() => window.createdUrls.length), created, "nothing was decoded again");
  await expectBalancedUses(page, "After switching back, the Android report counts only the cards' uses");
  assert.deepEqual(errors, []);
});

test("a prefetch the reviewer steps onto starts at once when a slot is free, instead of waiting for a running read", { timeout: 20_000 }, async t => {
  const { page, errors } = await harness(t);
  const { bytes, shas } = await multiImageArchive(4);
  const result = await page.evaluate(async ({ bytes, identity, shas, probe }) => {
    const archive = await window.openReport(bytes, identity);
    const decodes = new Function(`return (${probe})()`)();
    const [shown, shownToo, next, nextToo] = shas.map(sha => archive.reference(sha));
    // The screen on show is still being read after the rest: the next screen's prefetches wait behind the reserve.
    const visible = [archive.resolve(shown, "eager"), archive.resolve(shownToo, "eager")];
    await decodes.until(() => decodes.held() === 2);
    const prefetched = [archive.resolve(next, "prefetch"), archive.resolve(nextToo, "prefetch")];
    await new Promise(resolve => setTimeout(resolve, 30));
    const heldBeforeStep = decodes.held();
    // The reviewer steps onto that screen: its reads start in the two free slots, beside the running ones.
    const stepped = [archive.resolve(next, "eager"), archive.resolve(nextToo, "eager")];
    await new Promise(resolve => setTimeout(resolve, 30));
    const heldAfterStep = decodes.held();
    decodes.all();
    await Promise.all([...visible, ...prefetched, ...stepped]);
    return { heldBeforeStep, heldAfterStep, shared: await prefetched[0] === await stepped[0] };
  }, { bytes, identity, shas, probe: decodeProbe.toString() });
  assert.equal(result.heldBeforeStep, 2, "The prefetches waited behind the reserve");
  assert.equal(result.heldAfterStep, 4, "Stepped onto, they started at once");
  assert.equal(result.shared, true);
  assert.deepEqual(errors, []);
});

test("a prefetch read that never finishes does not stop Compare reading the next screens ahead", { timeout: 90_000 }, async t => {
  const { bytes, screens } = await changedScreensArchive(5);
  const { page, errors } = await harness(t, bytes, { app: true, open: false, query: "&view=compare&screen=screen-1" });
  await recordScreenshotReads(page);
  // Screen-2's Before never finishes verifying.
  await page.evaluate(stuck => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
    crypto.subtle.digest = async (algorithm, data) => {
      const value = await digest(algorithm, data);
      if (hex(value) === stuck) await new Promise(() => {});
      return value;
    };
  }, screens[1].before.sha256);
  await chooseFile(page, bytes);
  const compare = page.locator(".compare-section");
  await expect(compare.locator(".compare-frame img[data-screenshot-state='ready']")).toHaveCount(2);
  const prefetchesOf = screen => page.evaluate(references => window.reads.filter(read => read.priority === "prefetch" && references.includes(read.reference)).length,
    [screen.before.reference, screen.after.reference]);
  await expect.poll(() => prefetchesOf(screens[1])).toBe(2);
  await page.keyboard.press("ArrowRight");
  await expect(compare.locator(".compare-nav-position")).toHaveText(/^2 of 5$/);
  await expect.poll(() => prefetchesOf(screens[2])).toBe(2);
  await page.keyboard.press("ArrowRight");
  await expect(compare.locator(".compare-nav-position")).toHaveText(/^3 of 5$/);
  await expect.poll(() => prefetchesOf(screens[3])).toBe(2);
  assert.deepEqual(errors, []);
});

/** Opens Compare in Flip at `screen`, recording screenshot reads. */
async function openFlip(t, bytes, screen) {
  const opened = await harness(t, bytes, { app: true, open: false, query: `&view=compare&screen=${screen}` });
  await opened.page.addInitScript(() => localStorage.setItem("expo-explore:compare-mode", "flip"));
  await opened.page.reload();
  await recordScreenshotReads(opened.page);
  return opened;
}

/** Holds back verifying the screenshot with this hash until `window.releaseHeld()`. */
const holdScreenshot = (page, sha256) => page.evaluate(held => {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
  const waiting = [];
  window.releaseHeld = () => waiting.splice(0).forEach(release => release());
  crypto.subtle.digest = async (algorithm, data) => {
    const value = await digest(algorithm, data);
    if (hex(value) === held) await new Promise(resolve => waiting.push(resolve));
    return value;
  };
}, sha256);

test("Flip reads the next screen's Before when a step keeps the After it shows, which fires no load", { timeout: 90_000 }, async t => {
  // Screen-2 keeps screen-1's After beside a Before of its own.
  const { bytes, screens } = await changedScreensArchive(3, { sameAfter: { 1: 0 } });
  const { page, errors } = await openFlip(t, bytes, "screen-1");
  await chooseFile(page, bytes);
  const frame = page.locator(".compare-section .compare-flip-frame");
  await expect(frame.locator(".compare-flip-layer img[data-screenshot-state='ready']")).toHaveCount(2);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".compare-section .compare-nav-position")).toHaveText(/^2 of 3$/);
  await expect(frame.locator(".compare-flip-layer[data-side='before'] img")).toHaveAttribute("data-screenshot-src", screens[1].before.reference);
  await expect(frame.locator(".compare-flip-layer img[data-screenshot-state='ready']")).toHaveCount(2);
  assert.deepEqual(errors, []);
});

test("Flip stepped from Before shows the next screen's After from its first frame and reads its Before only once After is ready", { timeout: 90_000 }, async t => {
  const { bytes, screens } = await changedScreensArchive(3);
  const { page, errors } = await openFlip(t, bytes, "screen-1");
  await chooseFile(page, bytes);
  const frame = page.locator(".compare-section .compare-flip-frame");
  await expect(frame.locator(".compare-flip-layer img[data-screenshot-state='ready']")).toHaveCount(2);
  await page.keyboard.press("KeyX");
  await expect(frame).toHaveAttribute("data-side", "before");
  await holdScreenshot(page, screens[1].after.sha256);
  // Every frame from the step: which side the frame shows, and which layers are mounted.
  await page.evaluate(() => {
    window.flipFrames = [];
    const sample = () => {
      const element = document.querySelector(".compare-flip-frame");
      window.flipFrames.push({ route: document.querySelector(".compare-nav-route")?.textContent, side: element?.dataset.side,
        layers: [...(element?.querySelectorAll(".compare-flip-layer") ?? [])].map(layer => layer.dataset.side).join(",") });
      if (window.flipFrames.length < 20) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => window.flipFrames.length)).toBe(20);
  const stepped = (await page.evaluate(() => window.flipFrames)).filter(sample => sample.route === "/screen-2");
  assert.ok(stepped.length > 0);
  assert.deepEqual([...new Set(stepped.map(sample => `${sample.side}:${sample.layers}`))], ["after:after"],
    "From its first frame screen-2 shows After alone");
  const readsOf = reference => page.evaluate(reference => window.reads.filter(read => read.reference === reference && read.priority !== "prefetch").length, reference);
  assert.equal(await readsOf(screens[1].before.reference), 0, "Before waits for After");
  await page.evaluate(() => window.releaseHeld());
  await expect(frame.locator(".compare-flip-layer img[data-screenshot-state='ready']")).toHaveCount(2);
  assert.deepEqual(errors, []);
});
