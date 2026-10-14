import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

const entry = `
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InspectorPanel } from '/src/components/panels/inspector.tsx';
import { indexMap } from '/src/utils/model.ts';
import '/src/styles.css';
const screens = [
  ['profile', '/profile', 'Profile'], ['route-a', '/zeta', 'First by ID and title'],
  ['mixed', '/delta', 'Mixed'], ['observed', '/bravo', 'Observed'],
  ['route-z', '/alpha', 'Last by ID and title'], ['removed:base:old', '/charlie', 'Previous'],
  ['baseline-context:base:alpha', '/alpha', 'Previous route with the same displayed path'],
  ['incoming-mixed', '/echo', 'Incoming mixed'], ['incoming-observed', '/bravo-in', 'Incoming observed'],
  ['incoming-source', '/aardvark', 'Incoming source'],
  ['baseline-context:base:intro', '/beta-intro', 'Previous incoming'],
].map(([id, route, title]) => ({ id, title, route, variantIds: [], observationIds: [], elementIds: [] }));
const link = (from, to, kind, sourceFile) => ({ from, to, kind, sourceFile, provenance: 'source' });
const graph = edges => ({ contract: 'explore.navigation', edges, modalSurfaceIds: [], unresolved: [] });
const current = [
  link('profile', 'route-a', 'navigate', 'app/profile.tsx'),
  link('profile', 'mixed', 'replace', 'app/profile.tsx'),
  link('profile', 'route-z', 'push', 'app/profile.tsx'),
  link('profile', 'route-z', 'push', 'components/menu.tsx'),
  link('profile', 'mixed', 'push', 'components/actions.tsx'),
  link('incoming-mixed', 'profile', 'navigate', 'app/onboarding.tsx'),
  link('incoming-source', 'profile', 'redirect', 'app/index.tsx'),
];
const previous = [
  current[3], link('profile', 'removed:base:old', 'dismissTo', 'app/legacy-profile.tsx'),
  current[0], link('profile', 'baseline-context:base:alpha', 'tab', 'app/old-tabs.tsx'),
  current[2], link('profile', 'mixed', 'push', 'legacy/mixed.tsx'),
  current[5], link('baseline-context:base:intro', 'profile', 'replace', 'legacy/index.tsx'),
];
const recorded = [
  ['mixed-tap', 'profile', 'mixed', 'tap'], ['observed-tap', 'profile', 'observed', 'tap'],
  ['mixed-swipe', 'profile', 'mixed', 'swipe'], ['incoming-tap', 'incoming-mixed', 'profile', 'tap'],
  ['incoming-back', 'incoming-observed', 'profile', 'back'], ['same-screen', 'profile', 'profile', 'tap'],
];
const hasSource = !location.search.includes('no-source');
const map = { screens, variants: [], observations: [], artifacts: [], elements: [],
  actionAttempts: recorded.map(([id, , , kind]) => ({ id: 'attempt-' + id, action: { kind, label: id } })),
  transitions: recorded.map(([id, fromScreenId, toScreenId, actionKind]) => ({
    id, fromScreenId, toScreenId, actionKind, attemptIds: ['attempt-' + id],
  })),
  ...(hasSource ? { sourceNavigation: graph(current), baselineSourceNavigation: graph(previous) } : {}) };
const index = indexMap(map);
window.fixtureCounts = { transitions: index.transitions.size, attempts: index.attempts.size,
  outgoing: index.outgoing.get('profile').length, incoming: index.incoming.get('profile')?.length ?? 0 };
window.fixtureIndexSnapshot = () => JSON.stringify({
  transitions: [...index.transitions.values()], attempts: [...index.attempts.values()],
  outgoing: [...index.outgoing].map(([id, transitions]) => [id, transitions.map(item => item.id)]),
  incoming: [...index.incoming].map(([id, transitions]) => [id, transitions.map(item => item.id)]),
  source: index.sourceNavigation, previous: index.baselineSourceNavigation,
});
window.fixtureBefore = window.fixtureIndexSnapshot();
const diff = { screens: new Map(['removed:base:old', 'baseline-context:base:alpha'].map(id => [id, { status: 'removed' }])) };
function App() {
  const [direction, setDirection] = useState('out');
  const [selected, setSelected] = useState('');
  return <aside className="right-panel" style={{width:340,height:'100vh',overflowY:'auto'}}>
    <output aria-label="Selected destination">{selected}</output>
    <InspectorPanel screen={screens[0]} index={index} diff={diff} direction={direction} onChangeDirection={setDirection}
      onSelectVariant={()=>{}} onSelectScreen={setSelected} />
  </aside>;
}
createRoot(document.getElementById('root')).render(<App />);
`;

test("Inspector merges source and recorded routes into one sorted Transition list with shared direction controls", { timeout: 30_000 }, async t => {
  const vite = await createBrowserVite(t, { configFile: false,
    root: fileURLToPath(new URL("../../viewer", import.meta.url)), logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{ name: "inspector-source-navigation-fixture", resolveId: id => id === "/__source-navigation.tsx" ? id : undefined,
      load: id => id === "/__source-navigation.tsx" ? entry : undefined,
      configureServer(server) { server.middlewares.use((request, response, next) => {
        if (new URL(request.url, "http://localhost").pathname !== "/") return next();
        response.setHeader("Content-Type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/__source-navigation.tsx"></script>');
      }); } }], server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  await page.goto(url);
  const section = page.locator(".transition-section");
  const rows = section.locator(".transition-row");
  const rowForPath = path => rows.filter({ has: page.locator(".transition-path", { hasText: path }) });
  const rowForKind = (row, kind) => row.filter({ has: page.locator(".transition-kind", { hasText: kind }) });
  const assertIndexUnchanged = async () => {
    assert.deepEqual(await page.evaluate(() => window.fixtureCounts), { transitions: 6, attempts: 6, outgoing: 3, incoming: 2 });
    assert.equal(await page.evaluate(() => window.fixtureIndexSnapshot() === window.fixtureBefore), true);
  };
  const assertBadgesLeftOfPaths = async () => {
    const geometry = await rows.evaluateAll(items => items.flatMap(row => {
      const path = row.querySelector(".transition-path").getBoundingClientRect();
      return [...row.querySelectorAll(".transition-kind")].map(badge => {
        const box = badge.getBoundingClientRect();
        return { kind: badge.textContent, right: box.right, left: box.left, height: box.height, pathLeft: path.left };
      });
    }));
    assert.ok(geometry.length > 0);
    for (const badge of geometry) {
      assert.ok(badge.right <= badge.pathLeft, `${badge.kind} badge must precede the route path`);
      assert.ok(badge.right > badge.left && badge.height > 0 && badge.height <= 24, `${badge.kind} badge must remain compact`);
    }
  };
  await expect(section).toHaveCount(1);
  await expect(section.getByRole("heading", { name: "Transition", exact: true })).toBeVisible();
  await expect(page.locator(".source-navigation-section")).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Transition direction" })).toHaveCount(1);
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(section.getByRole("radio", { name: "Out 6", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(section.getByRole("radio", { name: "In 4", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(rows).toHaveCount(6);
  await expect(rows.locator(".transition-path")).toHaveText(["/alpha", "/alpha", "/bravo", "/charlie", "/delta", "/zeta"]);
  // No destination has a screenshot: each thumbnail shows the variant thumbnails' ImageOff glyph.
  await expect(rows.locator(".transition-thumb svg.lucide-image-off")).toHaveCount(6);
  await expect(rows.locator(".transition-thumb svg.lucide-box")).toHaveCount(0);
  await assertBadgesLeftOfPaths();
  assert.doesNotMatch(await section.innerText(), /\bRemoved\b/);

  const alpha = rowForKind(rowForPath(/^\/alpha$/), /^push$/);
  await expect(alpha).toHaveCount(1);
  await expect(alpha).toHaveAttribute("data-navigation-provenance", "source");
  await expect(alpha.locator(".transition-kind")).toHaveText(["push"]);
  const alphaDescription = "Declared in app/profile.tsx (push)\nDeclared in components/menu.tsx (push)";
  await alpha.hover();
  await expect(page.locator(".tooltip")).toHaveText(alphaDescription);
  await expect(alpha).toHaveAccessibleDescription(alphaDescription);
  await alpha.click();
  await expect(page.getByLabel("Selected destination")).toHaveText("route-z");

  const mixed = rowForPath(/^\/delta$/);
  await expect(mixed).toHaveCount(1);
  await expect(mixed).toHaveAttribute("data-navigation-provenance", "mixed");
  await expect(mixed.locator(".transition-kind")).toHaveText(["push", "replace"]);
  await mixed.hover();
  await expect(page.locator(".tooltip")).toContainText("2 recorded transitions (swipe, tap)");
  await expect(page.locator(".tooltip")).toContainText("Declared in app/profile.tsx (replace)");
  await expect(page.locator(".tooltip")).toContainText("Declared in components/actions.tsx (push)");
  await expect(page.locator(".tooltip")).toContainText("Previously declared in legacy/mixed.tsx (push)");
  await expect(mixed).toHaveAccessibleDescription(/2 recorded transitions/);
  const observed = rowForPath(/^\/bravo$/);
  await expect(observed).toHaveAttribute("data-navigation-provenance", "observed");
  await expect(observed.locator(".transition-kind")).toHaveText(["tap"]);

  const previous = rowForPath(/^\/charlie$/);
  await expect(previous.locator(".transition-kind")).toHaveText(["dismissTo"]);
  await previous.hover();
  await expect(page.locator(".tooltip")).toHaveText("Previously declared in app/legacy-profile.tsx (dismissTo)");
  await expect(previous).toHaveAccessibleDescription("Previously declared in app/legacy-profile.tsx (dismissTo)");
  await previous.click();
  await expect(page.getByLabel("Selected destination")).toHaveText("removed:base:old");
  await rowForKind(rowForPath(/^\/alpha$/), /^tab$/).click();
  await expect(page.getByLabel("Selected destination")).toHaveText("baseline-context:base:alpha");

  await section.getByRole("radio", { name: "In 4", exact: true }).click();
  await expect(section.getByRole("radio", { name: "In 4", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(section.getByRole("radio", { name: "Out 6", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(rows).toHaveCount(4);
  await expect(rows.locator(".transition-path")).toHaveText(["/aardvark", "/beta-intro", "/bravo-in", "/echo"]);
  await expect(rowForPath(/^\/aardvark$/).locator(".transition-kind")).toHaveText(["redirect"]);
  await expect(rowForPath(/^\/bravo-in$/)).toHaveAttribute("data-navigation-provenance", "observed");
  await expect(rowForPath(/^\/bravo-in$/).locator(".transition-kind")).toHaveText(["back"]);
  await expect(rowForPath(/^\/echo$/)).toHaveAttribute("data-navigation-provenance", "mixed");
  await expect(rowForPath(/^\/echo$/).locator(".transition-kind")).toHaveText(["navigate"]);
  const previousIncoming = rowForPath(/^\/beta-intro$/);
  await previousIncoming.hover();
  await expect(page.locator(".tooltip")).toHaveText("Previously declared in legacy/index.tsx (replace)");
  await previousIncoming.click();
  await expect(page.getByLabel("Selected destination")).toHaveText("baseline-context:base:intro");
  await assertBadgesLeftOfPaths();
  assert.doesNotMatch(await section.innerText(), /\bRemoved\b/);
  await assertIndexUnchanged();

  await page.goto(url + "?no-source");
  await expect(section).toHaveCount(1);
  await expect(section.getByRole("radio", { name: "Out 2", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(section.getByRole("radio", { name: "In 2", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(rows.locator(".transition-path")).toHaveText(["/bravo", "/delta"]);
  await expect(rows.locator(".transition-kind")).toHaveText(["tap", "swipe", "tap"]);
  await expect(section.locator(".transition-row[data-navigation-provenance='source']")).toHaveCount(0);
  assert.deepEqual(await rows.evaluateAll(items => items.map(row => row.dataset.navigationProvenance)), ["observed", "observed"]);
  await section.getByRole("radio", { name: "In 2", exact: true }).click();
  await expect(rows.locator(".transition-path")).toHaveText(["/bravo-in", "/echo"]);
  await expect(page.locator(".source-navigation-section")).toHaveCount(0);
  await assertIndexUnchanged();
  await page.goto(url);
  await expect(rows).toHaveCount(6);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    const chipStyles = await rows.locator(".transition-kind").evaluateAll(chips => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      const rgb = color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const panel = rgb(getComputedStyle(document.querySelector(".right-panel")).backgroundColor);
      return chips.map(chip => {
        const style = getComputedStyle(chip);
        return { panel, background: rgb(style.backgroundColor), borderWidth: style.borderTopWidth,
          borderStyle: style.borderTopStyle, radius: parseFloat(style.borderTopLeftRadius) };
      });
    });
    for (const chip of chipStyles) {
      assert.equal(chip.background[3], 255, `${theme} chip background must be opaque`);
      assert.ok(chip.background.slice(0, 3).every((channel, index) => Math.abs(channel - chip.panel[index]) >= 18),
        `${theme} chip background must be visibly distinct from the panel`);
      assert.equal(chip.borderWidth, "1px");
      assert.equal(chip.borderStyle, "solid");
      assert.ok(chip.radius >= 4);
    }
    await assertBadgesLeftOfPaths();
    if (process.env.EXPLORE_UI_EVIDENCE_DIR) {
      await mkdir(process.env.EXPLORE_UI_EVIDENCE_DIR, { recursive: true });
      await section.screenshot({ path: join(process.env.EXPLORE_UI_EVIDENCE_DIR, `transition-chips-${theme}.png`) });
    }
  }
  assert.deepEqual(errors, []);
});
