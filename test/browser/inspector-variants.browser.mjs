import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

const screen = { id: "form", title: "Profile form", route: "/profile", variantIds: ["empty", "edited", "uncaptured"],
  observationIds: ["observation-empty", "observation-edited"], elementIds: [] };
const entry = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InspectorPanel } from '/src/components/panels/inspector.tsx';
import { indexMap } from '/src/utils/model.ts';
import '/src/styles.css';
const screen = ${JSON.stringify(screen)};
const map = { screens: [screen], variants: [
  { id: 'empty', screenId: 'form', name: 'Initial state', observationIds: ['observation-empty'] },
  { id: 'edited', screenId: 'form', name: 'After editing', observationIds: ['observation-edited'] },
  { id: 'uncaptured', screenId: 'form', name: 'Banner visible', observationIds: [] },
], observations: ['empty', 'edited'].map(id => ({ id: 'observation-' + id, screenId: 'form', variantId: id,
  capturedAt: '2026-09-15T00:00:00Z', screenshotArtifactId: 'image-' + id })),
artifacts: ['empty', 'edited'].map(id => ({ id: 'image-' + id, kind: 'screenshot', path: id + '.svg',
  sha256: (id === 'empty' ? 'a' : 'b').repeat(64), width: 200, height: 400 })),
elements: [], actionAttempts: [], transitions: [] };
if (new URLSearchParams(location.search).has('single')) map.observations = map.observations.slice(0, 1);
const index = indexMap(map);
const diff = { screens: new Map([['form', { status: 'modified', changeSummary: 'The form now shows a saved name.',
  beforeScreenshot: '/empty.svg', afterScreenshot: '/edited.svg', reviewerChanges: [], noVisibleChange: false }]]) };
function App() {
  const [variant, setVariant] = useState(new URLSearchParams(location.search).get('variant') ?? undefined);
  return <aside className="right-panel" style={{width:340,height:'100vh',overflowY:'auto'}}>
    <InspectorPanel screen={screen} index={index} diff={diff} selectedVariantId={variant}
      onSelectVariant={id => { setVariant(id); history.replaceState(null, '', '?variant=' + id); }}
      direction="out" onChangeDirection={()=>{}} onSelectScreen={()=>{}} />
  </aside>;
}
createRoot(document.getElementById('root')).render(<App />);
`;

test("changed-screen inspector shows only captured variants below What changed and selects their distinct images", { timeout: 30_000 }, async t => {
  const vite = await createBrowserVite(t, { configFile: false,
    root: fileURLToPath(new URL("../../viewer", import.meta.url)), logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{ name: "inspector-variants-fixture", resolveId: id => id === "/__variants.tsx" ? id : undefined,
      load: id => id === "/__variants.tsx" ? entry : undefined,
      configureServer(server) { server.middlewares.use((request, response, next) => {
        if (new URL(request.url, "http://localhost").pathname !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/__variants.tsx"></script>');
      }); } }], server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*.svg*", route => {
    const edited = route.request().url().includes("edited.svg");
    return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400">
      <rect width="200" height="400" fill="${edited ? "#e3f6e8" : "#f2f2f2"}"/><text x="15" y="70" font-size="16">${edited ? "Name: Jamie" : "Name:"}</text></svg>` });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  const variants = page.getByRole("region", { name: "Captured screen variants" });
  await expect(variants.getByRole("heading", { name: "Variants", exact: true })).toBeVisible();
  await expect(variants.locator(".section-title")).toHaveText("Variants");
  await expect(variants.locator(".variant-meta")).toHaveCount(0);
  assert.equal(await variants.evaluate(node => node.previousElementSibling?.textContent.includes("What changed")), true);
  const tabs = variants.getByRole("tab");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveText("Initial state");
  await expect(tabs.nth(1)).toHaveText("After editing");
  await expect(page.getByText("Banner visible", { exact: true })).toHaveCount(0);
  const preview = variants.locator(".variant-preview img");
  await expect(preview).toHaveAttribute("src", /\/empty\.svg\?sha256=a{64}$/);
  await tabs.nth(1).click();
  await expect(page).toHaveURL(/\?variant=edited$/);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0).locator("img")).toHaveCSS("opacity", "0.35");
  await expect(tabs.nth(1).locator("img")).toHaveCSS("opacity", "1");
  await expect(tabs.nth(1)).toHaveCSS("border-width", "2px");
  await expect(tabs.nth(1)).toHaveCSS("border-color", "rgb(5, 136, 240)");
  assert.equal(await tabs.nth(1).evaluate(node => getComputedStyle(node).backgroundColor),
    await tabs.nth(0).evaluate(node => getComputedStyle(node).backgroundColor), "Selection uses a border with the neutral thumbnail background");
  await expect(preview).toHaveAttribute("src", /\/edited\.svg\?sha256=b{64}$/);
  await expect(preview).toHaveAttribute("alt", "Profile form — After editing");
  await expect.poll(() => preview.evaluate(image => image.complete && image.naturalWidth)).toBe(200);
  await expect(page.locator('[data-diff-side="after"] img')).toHaveAttribute("src", "/edited.svg");
  await page.reload();
  await expect(preview).toHaveAttribute("src", /\/edited\.svg\?sha256=b{64}$/);
  await tabs.nth(1).press("ArrowLeft");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0).locator("img")).toHaveCSS("opacity", "1");
  await expect(tabs.nth(1).locator("img")).toHaveCSS("opacity", "0.35");
  await expect(preview).toHaveAttribute("src", /\/empty\.svg\?sha256=a{64}$/);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await expect(tabs.nth(0).locator("img")).toHaveCSS("opacity", "1");
  await expect(tabs.nth(1).locator("img")).toHaveCSS("opacity", "0.35");
  assert.notEqual(await tabs.nth(0).evaluate(node => getComputedStyle(node).borderColor),
    await tabs.nth(1).evaluate(node => getComputedStyle(node).borderColor), "The selected border remains distinct in dark mode");
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/?single`);
  await expect(page.getByRole("heading", { name: "What changed", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Captured screen variants" })).toHaveCount(0);
  await expect(page.locator('[data-diff-side="after"] img')).toBeVisible();
  assert.deepEqual(errors, []);
});
