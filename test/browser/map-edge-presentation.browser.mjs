import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

const acceptanceDirectory = process.env.EXPLORE_UI_EVIDENCE_DIR
  ?? join(tmpdir(), "explore-map-edge-presentation");

const entry = `
import { createRoot } from 'react-dom/client';
import { Handle, MarkerType, Position } from '@xyflow/react';
import { CanvasStage } from '/src/components/canvas/stage.tsx';
import { CanvasVisibleFrameProvider } from '/src/components/canvas/visible-frame-provider.tsx';
import { ScreenScreenshotCard } from '/src/components/canvas/screen-screenshot-card.tsx';
import { TransitionEdge } from '/src/components/canvas/transition-edge.tsx';
import '/src/styles.css';
import '@xyflow/react/dist/style.css';

function ScreenNode({ data, selected }) {
  return <ScreenScreenshotCard className="screen-node" title={data.title} path={data.path}
    screenshot={data.screenshot} selected={selected} ariaLabel={'Open ' + data.title}
    imageWidth={184} imageHeight={372} loading="eager" onClick={() => { window.selectedScreen = data.id; }}
    leading={<Handle type="target" position={Position.Left} className="graph-handle" />}
    trailing={<Handle type="source" position={Position.Right} className="graph-handle" />} />;
}
const nodes = ['home', 'profile', 'complete'].map((id, position) => ({
  id, type: 'screen', position: { x: 40 + position * 390, y: 140 }, width: 184, height: 420,
  data: { id, title: id[0].toUpperCase() + id.slice(1), path: '/' + id, screenshot: '/__screen/' + id + '.svg' },
}));
const edges = [{ id: 'source-replace', source: 'home', target: 'complete', type: 'transition', zIndex: 9000,
  data: { label: 'Source: replace', active: false, primary: false, dimmed: false, transitionCount: 0,
    sourceOnly: true, tooltip: 'Source navigation\\nreplace · app/home.tsx' },
}, { id: 'source-push', source: 'home', target: 'complete', type: 'transition', selected: true, zIndex: 10000,
  markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent)', width: 16, height: 16 },
  data: { label: 'Source: push', active: true, primary: true, dimmed: false, transitionCount: 0,
    sourceOnly: true, tooltip: 'Source navigation\\npush · app/home.tsx' },
}];
createRoot(document.getElementById('root')).render(<>
  <header className="fixture-heading"><strong>Map connections</strong><span>Selected source arrows stay behind screenshots.</span></header>
  <CanvasVisibleFrameProvider layoutKey={1}>
    <div className="connection-canvas-surface map-surface">
      <CanvasStage ariaLabel="Map arrow presentation" className="map-canvas" nodes={nodes} edges={edges}
        nodeTypes={{ screen: ScreenNode }} edgeTypes={{ transition: TransitionEdge }}
        initialViewport={{ x: 75, y: 0, zoom: 1 }} viewportIdentity="map-edge-fixture"
        tool="select" layoutIdentity="map-edge-fixture" />
    </div>
  </CanvasVisibleFrameProvider>
</>);
`;

function differentPixels(leftBuffer, rightBuffer, inset = 0) {
  const left = PNG.sync.read(leftBuffer);
  const right = PNG.sync.read(rightBuffer);
  assert.equal(left.width, right.width);
  assert.equal(left.height, right.height);
  let different = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    const x = index / 4 % left.width;
    const y = Math.floor(index / 4 / left.width);
    if (x < inset || y < inset || x >= left.width - inset || y >= left.height - inset) continue;
    if (left.data[index] !== right.data[index]
      || left.data[index + 1] !== right.data[index + 1]
      || left.data[index + 2] !== right.data[index + 2]
      || left.data[index + 3] !== right.data[index + 3]) different += 1;
  }
  return different;
}

test("Map keeps selected elevated arrows behind screenshots without rendering navigation labels", { timeout: 30_000 }, async t => {
  const vite = await createBrowserVite(t, {
    configFile: false, root: fileURLToPath(new URL("../../viewer", import.meta.url)),
    logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{
      name: "map-edge-presentation-fixture",
      resolveId: id => id === "/__map-edge-presentation.tsx" ? id : undefined,
      load: id => id === "/__map-edge-presentation.tsx" ? entry : undefined,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (new URL(request.url, "http://localhost").pathname !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(`<html data-theme="dark"><style>
            html,body,#root{height:100%;width:100%;margin:0;background:#111113}
            #root{display:flex;flex-direction:column}.app-content{flex:1;min-height:0}
            .fixture-heading{height:76px;box-sizing:border-box;padding:20px 36px;display:flex;align-items:center;gap:18px;color:#f4f4f5;font:14px system-ui;border-bottom:1px solid #282a2e}
            .fixture-heading span{color:#a1a1aa;font-size:12px}
            </style><div id="root"></div><script type="module" src="/__map-edge-presentation.tsx"></script></html>`);
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 850 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/__screen/*.svg", route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1).replace(".svg", "");
    const title = id[0].toUpperCase() + id.slice(1);
    return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="184" height="372" viewBox="0 0 184 372">
      <rect width="184" height="372" fill="#19232d"/><text x="16" y="28" fill="#e6edf3" font-family="Arial" font-size="9">9:41</text>
      <text x="16" y="68" fill="#ffffff" font-family="Arial" font-size="21" font-weight="bold">${title}</text>
      <rect x="16" y="88" width="152" height="192" rx="14" fill="#263745"/>
      <circle cx="45" cy="120" r="14" fill="#8fbfc6"/><rect x="69" y="111" width="74" height="6" rx="3" fill="#d2e8ec"/>
      <rect x="69" y="124" width="49" height="5" rx="2" fill="#74939e"/>
      <rect x="30" y="154" width="122" height="5" rx="2" fill="#6a8794"/>
      <rect x="30" y="168" width="95" height="5" rx="2" fill="#6a8794"/>
      <rect x="30" y="240" width="108" height="5" rx="2" fill="#6a8794"/>
      <rect x="16" y="302" width="152" height="36" rx="10" fill="#85c7bd"/>
      <text x="92" y="325" text-anchor="middle" fill="#122b2b" font-family="Arial" font-size="11" font-weight="bold">Continue</text>
      <rect x="65" y="360" width="54" height="3" rx="2" fill="#d6dee4"/>
    </svg>` });
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  const selectedEdge = page.locator('.react-flow__edge[data-id="source-push"]');
  const crossingPath = selectedEdge.locator(".transition-edge-path");
  const sourceHitArea = selectedEdge.locator('.transition-edge-hitarea[data-navigation-provenance="source"]');
  const profileImage = page.locator('.react-flow__node[data-id="profile"] .screen-node-image img');
  await expect(selectedEdge).toHaveClass(/selected/);
  await expect(profileImage).toBeVisible();
  await expect.poll(() => profileImage.evaluate(image => image.complete && image.naturalWidth)).toBe(184);
  await expect(page.locator(".canvas-camera-initializing")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  let previousViewport;
  let stableViewportChecks = 0;
  await expect.poll(async () => {
    const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
    stableViewportChecks = viewport === previousViewport ? stableViewportChecks + 1 : 0;
    previousViewport = viewport;
    return stableViewportChecks;
  }, { intervals: [50, 100, 150] }).toBeGreaterThanOrEqual(3);

  const geometry = await crossingPath.evaluate(path => {
    const point = fraction => {
      const local = path.getPointAtLength(path.getTotalLength() * fraction);
      const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM());
      return { x: screen.x, y: screen.y };
    };
    const crossing = point(0.5);
    const outside = point(0.22);
    const hit = document.elementFromPoint(crossing.x, crossing.y);
    const svg = path.closest("svg");
    return {
      crossing, outside, hitTag: hit?.tagName, hitScreen: hit?.closest(".react-flow__node")?.getAttribute("data-id"),
      inlineSvgZIndex: svg.style.zIndex, computedSvgZIndex: getComputedStyle(svg).zIndex,
      edgeContainerZIndex: getComputedStyle(svg.parentElement).zIndex,
      labelCount: document.querySelectorAll(".transition-edge-label").length,
    };
  });
  assert.equal(geometry.inlineSvgZIndex, "10000", "the test must exercise React Flow's elevated ancestor SVG");
  const imageBox = await profileImage.boundingBox();
  assert.ok(geometry.crossing.x > imageBox.x && geometry.crossing.x < imageBox.x + imageBox.width);
  assert.ok(geometry.crossing.y > imageBox.y && geometry.crossing.y < imageBox.y + imageBox.height);
  assert.equal(geometry.hitScreen, "profile", `screenshot must win the crossing hit test: ${JSON.stringify(geometry)}`);

  const outsideClip = {
    x: Math.floor(geometry.outside.x - 16), y: Math.floor(geometry.outside.y - 9), width: 32, height: 18,
  };
  const imageWithArrows = await profileImage.screenshot({ animations: "disabled" });
  const outsideWithArrows = await page.screenshot({ clip: outsideClip, animations: "disabled" });
  // Hide only the arrow layer as a control. Production styles and screenshot cards stay intact.
  await page.locator(".map-surface .react-flow__edges").evaluate(node => { node.style.visibility = "hidden"; });
  const imageWithoutArrows = await profileImage.screenshot({ animations: "disabled" });
  const outsideWithoutArrows = await page.screenshot({ clip: outsideClip, animations: "disabled" });
  await page.locator(".map-surface .react-flow__edges").evaluate(node => { node.style.removeProperty("visibility"); });
  // The image's outermost antialiased pixels may blend with the arrow behind its rounded frame.
  // Its opaque interior must remain byte-for-byte identical with and without the arrows.
  assert.equal(differentPixels(imageWithArrows, imageWithoutArrows, 2), 0,
    "selected source arrows must not paint any pixels across the opaque screenshot interior");
  assert.ok(differentPixels(outsideWithArrows, outsideWithoutArrows) > 5,
    "the arrow outside the screenshot must remain visibly rendered");

  await expect(page.locator(".transition-edge-label")).toHaveCount(0);
  assert.doesNotMatch(await page.locator(".map-surface").innerText(), /source:\s*(push|replace)/i);
  await expect(sourceHitArea.locator("title")).toHaveText("Source navigation\npush · app/home.tsx");
  await expect(page.locator('.react-flow__edge[data-id="source-replace"] title')).toHaveText("Source navigation\nreplace · app/home.tsx");
  await page.mouse.move(geometry.outside.x, geometry.outside.y + 4);
  assert.equal(await sourceHitArea.evaluate((node, point) => (
    document.elementFromPoint(point.x, point.y + 4) === node
  ), geometry.outside), true, "source metadata must remain reachable by hovering the arrow");
  await expect(page.locator(".transition-edge-label")).toHaveCount(0);
  await expect(sourceHitArea.locator("title")).toHaveText("Source navigation\npush · app/home.tsx");
  await page.mouse.move(1320, 30);
  const dimmedComparisons = [];
  for (const presentation of ["muted", "selection"]) {
    await page.evaluate(mode => {
      const profile = document.querySelector('.react-flow__node[data-id="profile"]');
      const canvas = document.querySelector(".map-canvas");
      profile.classList.toggle("graph-node-muted", mode === "muted");
      canvas.classList.toggle("screen-selection-active", mode === "selection");
    }, presentation);
    const dimmedWithArrows = await profileImage.screenshot({ animations: "disabled" });
    await page.locator(".map-surface .react-flow__edges").evaluate(node => { node.style.visibility = "hidden"; });
    const dimmedWithoutArrows = await profileImage.screenshot({ animations: "disabled" });
    await page.locator(".map-surface .react-flow__edges").evaluate(node => { node.style.removeProperty("visibility"); });
    dimmedComparisons.push({
      presentation,
      interiorPixelsChanged: differentPixels(dimmedWithArrows, dimmedWithoutArrows, 2),
      dimAppearancePixelsChanged: differentPixels(imageWithoutArrows, dimmedWithoutArrows, 2),
    });
    assert.equal(await profileImage.evaluate((image, point) => (
      document.elementFromPoint(point.x, point.y)?.closest('.react-flow__node[data-id="profile"]') === image.closest(".react-flow__node")
    ), geometry.crossing), true, `${presentation} screenshot must still win the overlapping hit test`);
  }
  for (const comparison of dimmedComparisons) {
    assert.equal(comparison.interiorPixelsChanged, 0,
      `${comparison.presentation} screenshots must remain opaque over crossing arrows`);
    assert.ok(comparison.dimAppearancePixelsChanged > 100,
      `${comparison.presentation} must preserve the visibly dimmed screenshot appearance`);
  }
  await page.evaluate(() => {
    document.querySelector('.react-flow__node[data-id="profile"]').classList.remove("graph-node-muted");
    document.querySelector(".map-canvas").classList.remove("screen-selection-active");
  });
  await page.getByRole("button", { name: "Open Profile", exact: true }).click();
  assert.equal(await page.evaluate(() => window.selectedScreen), "profile");
  await expect(page.locator(".transition-edge-label")).toHaveCount(0);
  await page.mouse.move(1320, 30);
  await mkdir(acceptanceDirectory, { recursive: true });
  await page.screenshot({ path: join(acceptanceDirectory, "map-edges-dark.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    inlineSvgZIndex: geometry.inlineSvgZIndex, computedSvgZIndex: geometry.computedSvgZIndex,
    edgeContainerZIndex: geometry.edgeContainerZIndex, crossingHitScreen: geometry.hitScreen,
    screenshotInteriorPixelsChanged: differentPixels(imageWithArrows, imageWithoutArrows, 2),
    outsideArrowPixelsChanged: differentPixels(outsideWithArrows, outsideWithoutArrows),
    dimmedComparisons,
  }));
});
