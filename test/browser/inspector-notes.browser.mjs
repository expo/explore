import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

const note = "The primary button now says “Create account” and explains the next step.";
const fact = "Changed button title from “Continue” to “Create account”.";
const entry = `
import { createRoot } from 'react-dom/client';
import { InspectorPanel } from '/src/components/panels/inspector.tsx';
import { indexMap } from '/src/utils/model.ts';
import '/src/styles.css';
const params = new URLSearchParams(location.search);
const screen = { id: 'signup', title: 'Sign up', route: '/signup', variantIds: ['default'],
  observationIds: ['capture'], elementIds: [] };
const map = { screens: [screen], variants: [{ id: 'default', screenId: 'signup', name: 'Default', observationIds: ['capture'] }],
  observations: [{ id: 'capture', screenId: 'signup', variantId: 'default', capturedAt: '2026-09-24T00:00:00Z', screenshotArtifactId: 'image' }],
  artifacts: [{ id: 'image', kind: 'screenshot', path: 'capture.svg', sha256: 'a'.repeat(64), width: 200, height: 400 }],
  elements: [], actionAttempts: [], transitions: [] };
const status = params.get('status') ?? 'modified';
const screenDiff = { status, changeSummary: 'Changed the primary action.', beforeScreenshot: '/before.svg', afterScreenshot: '/after.svg',
  reviewerChanges: params.has('legacy') ? [] : [{ id: 'fact', category: 'visible-text', templateId: 'visible-text.changed',
    bullet: ${JSON.stringify(fact)}, priority: 0, evidenceRefs: [] }],
  noVisibleChange: status === 'unchanged', runtimeEvidenceRefs: [],
  ...(params.has('note') ? { note: status === 'unchanged' ? 'No visible change.' : ${JSON.stringify(note)} } : {}) };
window.fixtureDiff = screenDiff;
const diff = { screens: new Map([['signup', screenDiff]]) };
createRoot(document.getElementById('root')).render(
  <aside className="right-panel" style={{width:340,height:'100vh',overflowY:'auto'}}>
    <InspectorPanel screen={screen} index={indexMap(map)} diff={diff} direction="out"
      onChangeDirection={()=>{}} onSelectVariant={()=>{}} onSelectScreen={()=>{}} />
  </aside>);
`;

test("inspector notes replace existing explanation text and preserve unchanged screenshot layout", { timeout: 30_000 }, async t => {
  const vite = await createBrowserVite(t, { configFile: false,
    root: fileURLToPath(new URL("../../viewer", import.meta.url)), logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{ name: "inspector-notes-fixture", resolveId: id => id === "/__notes.tsx" ? id : undefined,
      load: id => id === "/__notes.tsx" ? entry : undefined,
      configureServer(server) { server.middlewares.use((request, response, next) => {
        if (new URL(request.url, "http://localhost").pathname !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/__notes.tsx"></script>');
      }); } }], server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*.svg*", route => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="#eee"/></svg>' }));
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  await page.goto(url);
  await expect(page.locator(".what-changed-item")).toHaveText([fact]);
  await expect(page.locator(".inspector-diff-compare")).toHaveCount(1);
  await page.goto(`${url}?note`);
  await expect(page.locator(".what-changed-item")).toHaveText([note]);
  await expect(page.getByRole("heading", { name: "What changed", exact: true })).toHaveCount(1);
  await expect(page.locator(".inspector-diff-compare")).toHaveCount(1);
  assert.equal(await page.evaluate(() => window.fixtureDiff.reviewerChanges[0].bullet), fact);
  assert.equal(await page.evaluate(() => window.fixtureDiff.status), "modified");
  await page.goto(`${url}?legacy`);
  await expect(page.locator(".what-changed-item")).toHaveText(["Changed the primary action."]);
  for (const status of ["unchanged", "not-compared"]) {
    await page.goto(`${url}?note&status=${status}`);
    await expect(page.locator(".what-changed-item")).toHaveText([status === "unchanged" ? "No visible change." : note]);
    await expect(page.locator(".inspector-diff-compare")).toHaveCount(0);
    await expect(page.locator(".screenshot-diff-frame")).toHaveCount(1);
    assert.equal(await page.evaluate(() => window.fixtureDiff.status), status);
  }
  await page.goto(`${url}?status=unchanged`);
  await expect(page.locator(".screenshot-diff-frame")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "What changed", exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
});
