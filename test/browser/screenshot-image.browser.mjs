import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { createBrowserVite } from "../helpers/browser-vite.mjs";

const firstSource = `expo-explore-asset:${"a".repeat(64)}.png`;
const secondSource = `expo-explore-asset:${"b".repeat(64)}.png`;
const thirdSource = `expo-explore-asset:${"c".repeat(64)}.png`;

function png(width, height, color) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data.set([...color, 255], index);
  }
  return PNG.sync.write(image);
}

const firstImage = png(2, 3, [40, 100, 160]);
const secondImage = png(4, 5, [160, 100, 40]);
const imageUrl = bytes => `data:image/png;base64,${bytes.toString("base64")}`;

const resolver = `
export const isEmbeddedArtifactUrl = value => value.startsWith("expo-explore-asset:");
export const releaseEmbeddedArtifactUrl = source => { window.releaseCalls.push(source); return true; };
export function resolveEmbeddedArtifactUrl(source, priority) {
  window.resolverCalls.push(source);
  window.resolverPriorities.push(priority);
  // A screenshot the report still holds decoded resolves at once.
  if (window.immediateScreenshots.has(source)) return Promise.resolve(window.immediateScreenshots.get(source));
  return new Promise((resolve, reject) => {
    const pending = window.pendingScreenshots.get(source) ?? [];
    pending.push({ resolve, reject });
    window.pendingScreenshots.set(source, pending);
  });
}
// \`window.shownReport\` stands in for the report the page shows; a hosted preview's target switch changes it.
export function leaseEmbeddedArtifactUrl(source, priority) {
  const report = window.shownReport;
  return { url: resolveEmbeddedArtifactUrl(source, priority),
    release: () => { window.releasedFrom.push(report); return releaseEmbeddedArtifactUrl(source); },
    current: () => window.shownReport === report };
}
`;

const entry = `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ScreenshotImage } from "/src/components/shared/screenshot-image.tsx";
// The Viewer's own rules hide a waiting screenshot and fade a ready one in.
if (window.fixture.styles) await import("/src/styles.css");

function Harness() {
  const [state, setState] = useState(window.fixture);
  useEffect(() => {
    window.updateScreenshot = changes => setState(previous => ({ ...previous, ...changes }));
    window.harnessReady = true;
  }, []);
  function loaded(event) {
    const image = event.currentTarget;
    window.imageLoads.push({ alt: image.alt, source: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight });
  }
  function failed(event) {
    const image = event.currentTarget;
    window.imageErrors.push({ alt: image.alt, source: image.dataset.screenshotSrc });
  }
  return <main style={{ position: "relative", height: state.layout === "scroll" ? 3300 : 300,
    width: 600, overflow: state.layout === "pan" ? "hidden" : undefined }}>
    {state.normalSource && <ScreenshotImage src={state.normalSource} alt="Hosted screenshot"
      width={24} height={18} decoding="async" onLoad={loaded} {...(state.holdPrevious ? { holdPrevious: true } : {})} />}
    <div data-testid="positioner" style={{ position: "absolute", left: 20,
      top: state.layout === "scroll" ? 3000 : 30,
      transform: state.layout === "pan" ? "translateX(2500px)" : undefined }}
      {...(state.instant ? { "data-screenshot-instant": "" } : {})}
      {...(state.thumbnail ? { className: "variant-thumbnail", "aria-selected": "false" } : {})}>
      {state.mounted !== false && <ScreenshotImage src={state.source} alt="Captured checkout"
        width={120} height={80} loading={state.loading} decoding="async" className="captured-image"
        data-screen="checkout" onLoad={loaded} onError={failed}
        {...(state.indicator ? { indicator: state.indicator } : {})}
        {...(state.holdPrevious ? { holdPrevious: true } : {})}
        {...(state.fallback ? { fallback: <span data-testid="fallback">No screenshot</span> } : {})} />}
    </div>
  </main>;
}
createRoot(document.getElementById("root")).render(<Harness />);
`;

async function fixture(t, options = {}) {
  const vite = await createBrowserVite(t, {
    configFile: false,
    root: fileURLToPath(new URL("../../viewer", import.meta.url)),
    logLevel: "error", esbuild: { jsx: "automatic" },
    plugins: [{
      name: "screenshot-image-fixture", enforce: "pre",
      resolveId(id, importer) {
        if (id === "/__screenshot_image.tsx") return id;
        if (importer?.endsWith("/components/shared/screenshot-image.tsx") && /(?:^|\/)embedded-report(?:\.ts)?$/.test(id)) {
          return "\0screenshot-image-resolver";
        }
      },
      load(id) {
        if (id === "/__screenshot_image.tsx") return entry;
        if (id === "\0screenshot-image-resolver") return resolver;
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/__normal.png") {
            response.setHeader("Content-Type", "image/png");
            response.end(firstImage);
            return;
          }
          // A hosted screenshot that takes a while to arrive.
          if (request.url === "/__slow.png") {
            response.setHeader("Content-Type", "image/png");
            setTimeout(() => response.end(secondImage), 600);
            return;
          }
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end('<!doctype html><html><head><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/__screenshot_image.tsx"></script></body></html>');
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "The image lifecycle must not produce browser errors"));
  await page.addInitScript(fixture => {
    window.fixture = fixture;
    window.resolverCalls = [];
    window.resolverPriorities = [];
    window.releaseCalls = [];
    window.shownReport = "android";
    window.releasedFrom = [];
    window.immediateScreenshots = new Map();
    if (fixture.observer === "manual") {
      // The test decides when the image enters or leaves the viewport, down to one task.
      const observers = [];
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target) { this.targets.push(target); }
        unobserve(target) { this.targets = this.targets.filter(value => value !== target); }
        disconnect() { this.targets = []; }
        takeRecords() { return []; }
      };
      window.setIntersecting = isIntersecting => {
        for (const observer of observers) {
          if (observer.targets.length) observer.callback(observer.targets.map(target => ({ target, isIntersecting })), observer);
        }
      };
    }
    window.imageLoads = [];
    window.imageErrors = [];
    window.pendingScreenshots = new Map();
    window.resolveScreenshot = (source, value) => {
      const pending = window.pendingScreenshots.get(source);
      if (!pending?.length) throw new Error("No pending screenshot resolution");
      window.pendingScreenshots.delete(source);
      for (const { resolve } of pending) resolve(value);
    };
    window.rejectScreenshot = source => {
      const pending = window.pendingScreenshots.get(source);
      if (!pending?.length) throw new Error("No pending screenshot resolution");
      window.pendingScreenshots.delete(source);
      for (const { reject } of pending) reject(new Error("Screenshot resolution failed"));
    };
    if (fixture.decode === "manual") {
      // The test settles each decode; one it never settles stands in for a decode that hangs.
      window.pendingDecodes = [];
      HTMLImageElement.prototype.decode = function () {
        return new Promise((resolve, reject) => window.pendingDecodes.push({ image: this, resolve, reject }));
      };
    }
  }, { source: firstSource, layout: "visible", ...options });
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => window.harnessReady);
  return { page, image: page.getByRole("img", { name: "Captured checkout", exact: true }) };
}

// Let native intersection delivery settle before asserting that no asset work began.
async function observePosition(image) {
  return image.evaluate(element => new Promise(resolve => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(entry.isIntersecting)));
    });
    observer.observe(element);
  }));
}

async function resolveImage(page, source, bytes = firstImage) {
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(source);
  await page.evaluate(({ source, value }) => window.resolveScreenshot(source, value), { source, value: imageUrl(bytes) });
}

async function expectDecoded(image, width, height) {
  await expect.poll(() => image.evaluate(element => ({ complete: element.complete, width: element.naturalWidth, height: element.naturalHeight })))
    .toEqual({ complete: true, width, height });
  await image.evaluate(element => element.decode());
}

/** A waiting image shows a transparent stand-in of its own size: never an `<img>` without a source. */
async function expectWaiting(image, state = "loading") {
  await expect(image).toHaveAttribute("data-screenshot-state", state);
  await expect(image).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  await expect.poll(() => image.evaluate(element => ({ complete: element.complete, width: element.naturalWidth, height: element.naturalHeight })))
    .toEqual({ complete: true, width: 120, height: 80 });
}

test("embedded screenshots resolve only when scrolling brings them near the viewport", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { layout: "scroll", loading: "lazy" });
  assert.equal(await observePosition(image), false);
  assert.deepEqual(await page.evaluate(() => window.resolverCalls), []);
  await expectWaiting(image);

  await image.scrollIntoViewIfNeeded();
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  assert.deepEqual(await page.evaluate(() => window.resolverCalls), [firstSource]);
  assert.deepEqual(await page.evaluate(() => window.resolverPriorities), ["lazy"], "Scrolled-in images wait behind eager ones");
  await expect.poll(() => page.evaluate(() => window.imageLoads.length)).toBe(1);
});

test("embedded screenshots respond to canvas panning without a scroll event", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { layout: "pan", loading: "lazy" });
  assert.equal(await observePosition(image), false);
  assert.deepEqual(await page.evaluate(() => window.resolverCalls), []);

  await page.getByTestId("positioner").evaluate(element => { element.style.transform = "translateX(0px)"; });
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.deepEqual(await page.evaluate(() => window.resolverCalls), [firstSource]);
});

test("eager screenshots resolve offscreen and preserve ordinary image attributes and load events", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { layout: "scroll", loading: "eager", normalSource: "/__normal.png" });
  assert.equal(await observePosition(image), false);
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("width", "120");
  await expect(image).toHaveAttribute("height", "80");
  await expect(image).toHaveAttribute("loading", "eager");
  await expect(image).toHaveAttribute("decoding", "async");
  await expect(image).toHaveAttribute("data-screen", "checkout");
  await expect(image).toHaveClass("captured-image");
  await expectDecoded(page.getByRole("img", { name: "Hosted screenshot", exact: true }), 2, 3);
  await expect.poll(() => page.evaluate(() => window.imageLoads.map(load => load.alt).sort()))
    .toEqual(["Captured checkout", "Hosted screenshot"]);
  assert.deepEqual(await page.evaluate(() => window.resolverCalls), [firstSource], "Ordinary URLs bypass embedded resolution");
  assert.deepEqual(await page.evaluate(() => window.resolverPriorities), ["eager"]);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("late resolutions cannot replace a newer screenshot or revive an unmounted image", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager" });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await resolveImage(page, secondSource, secondImage);
  await expectDecoded(image, 4, 5);
  await expect.poll(() => page.evaluate(() => window.imageLoads.length)).toBe(1);

  await resolveImage(page, firstSource);
  await observePosition(image);
  await expect(image).toHaveAttribute("src", imageUrl(secondImage));
  await expectDecoded(image, 4, 5);
  assert.equal(await page.evaluate(() => window.imageLoads.length), 1);

  await page.evaluate(source => window.updateScreenshot({ source }), thirdSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(thirdSource);
  await page.evaluate(() => window.updateScreenshot({ mounted: false }));
  await expect(image).toHaveCount(0);
  await resolveImage(page, thirdSource);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(image).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.imageLoads.length), 1);
});

test("resolver failures notify the active image once and ignore replaced or unmounted sources", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager" });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await page.evaluate(source => window.rejectScreenshot(source), firstSource);
  const expectedErrors = [{ alt: "Captured checkout", source: firstSource }];
  await expect.poll(() => page.evaluate(() => window.imageErrors)).toEqual(expectedErrors);
  await observePosition(image);
  // Without a fallback the failed image stays an empty frame, not a broken image.
  await expectWaiting(image, "failed");
  assert.equal(await page.evaluate(() => window.imageLoads.length), 0);

  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(secondSource);
  await page.evaluate(source => window.updateScreenshot({ source }), thirdSource);
  await resolveImage(page, thirdSource, secondImage);
  await expectDecoded(image, 4, 5);
  await page.evaluate(source => window.rejectScreenshot(source), secondSource);
  await observePosition(image);
  assert.deepEqual(await page.evaluate(() => window.imageErrors), expectedErrors);
  await expect(image).toHaveAttribute("src", imageUrl(secondImage));

  await page.evaluate(source => window.updateScreenshot({ source }), firstSource);
  await expect.poll(() => page.evaluate(source => window.resolverCalls.filter(value => value === source).length, firstSource)).toBe(2);
  await page.evaluate(() => window.updateScreenshot({ mounted: false }));
  await expect(image).toHaveCount(0);
  await page.evaluate(source => window.rejectScreenshot(source), firstSource);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.imageErrors), expectedErrors);
});

test("a waiting embedded screenshot keeps its size, draws no alt text, and hides its stand-in from load listeners", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager" });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await expectWaiting(image);
  await expect(image).toHaveAttribute("aria-busy", "true");
  // The accessible name stays while the pixels wait.
  await expect(image).toHaveAttribute("alt", "Captured checkout");
  const waiting = await image.boundingBox();
  assert.equal(await page.locator("img:not([src])").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.imageLoads), [], "The stand-in's load is not the screenshot's");

  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).not.toHaveAttribute("aria-busy", /.*/);
  assert.deepEqual(await image.boundingBox(), waiting, "Resolving does not move or resize the image");
  await expect.poll(() => page.evaluate(() => window.imageLoads.length)).toBe(1);
});

test("a spinner indicator shows over a waiting screenshot and leaves once its pixels load", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", indicator: "spinner" });
  const spinner = page.getByRole("status", { name: "Loading screenshot", exact: true });
  await expect(spinner).toHaveCount(1);
  await expectWaiting(image);
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  await expect(spinner).toHaveCount(0);
});

test("a screenshot that cannot be resolved or decoded shows the fallback, never a broken image", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", fallback: true, indicator: "spinner" });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await page.evaluate(source => window.rejectScreenshot(source), firstSource);
  await expect(page.getByTestId("fallback")).toHaveText("No screenshot");
  await expect(image).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.imageErrors), [{ alt: "Captured checkout", source: firstSource }]);

  // Bytes that pass the resolver but fail to decode end the same way.
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await expectWaiting(image);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(secondSource);
  await page.evaluate(source => window.resolveScreenshot(source, "data:image/png;base64,AAAA"), secondSource);
  await expect(page.getByTestId("fallback")).toHaveText("No screenshot");
  await expect(image).toHaveCount(0);
  assert.equal(await page.locator("img:not([src])").count(), 0);
  assert.equal(await page.evaluate(() => window.imageErrors.length), 2);
  assert.equal(await page.evaluate(() => window.imageLoads.length), 0);

  // Returning to a source that failed earlier tries it again.
  await page.evaluate(source => window.updateScreenshot({ source }), firstSource);
  await expect.poll(() => page.evaluate(source => window.resolverCalls.filter(value => value === source).length, firstSource)).toBe(2);
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  await expect(page.getByTestId("fallback")).toHaveCount(0);
});

/** A Blob URL the page owns, like the report's; revoking it stands in for the report evicting it. */
async function blobUrl(page, bytes) {
  return page.evaluate(bytes => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" })), [...bytes]);
}

test("returning to a screenshot before the next one resolves waits for a fresh URL, never the released one", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", fallback: true, indicator: "spinner" });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  const released = await blobUrl(page, firstImage);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url: released });
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");

  // A to B releases A's URL; while B still resolves, the report evicts and revokes it. Without `holdPrevious` (Compare,
  // the Inspector) nothing of A stays up under B's name and outlines: B waits with its spinner.
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(secondSource);
  await expectWaiting(image);
  await expect(page.getByRole("status", { name: "Loading screenshot" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.releaseCalls)).toEqual([firstSource]);
  await page.evaluate(url => URL.revokeObjectURL(url), released);

  // Back to A before B resolves: A waits for its new resolution instead of drawing the revoked URL.
  await page.evaluate(source => window.updateScreenshot({ source }), firstSource);
  await expect.poll(() => page.evaluate(source => window.resolverCalls.filter(value => value === source).length, firstSource)).toBe(2);
  await expectWaiting(image);
  await expect(image).toHaveAttribute("aria-busy", "true");
  const fresh = await blobUrl(page, firstImage);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url: fresh });
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("src", fresh);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  assert.deepEqual(await page.evaluate(() => window.imageErrors), []);
});

test("a new source keeps the picture before it on screen until it decodes; returning to the first waits for a fresh URL, never reloading the released one", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", fallback: true, holdPrevious: true });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  const released = await blobUrl(page, firstImage);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url: released });
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");

  // A to B releases A's URL, but A's picture stays up (nothing blanks while every screenshot of a report swaps at once);
  // while B still resolves, the report evicts and revokes the URL behind it, which the decoded picture survives.
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(secondSource);
  await expect(image).toHaveAttribute("src", released);
  await expect(image).toHaveAttribute("data-screenshot-state", "loading");
  await expect(image).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => page.evaluate(() => window.releaseCalls)).toEqual([firstSource]);
  await page.evaluate(url => URL.revokeObjectURL(url), released);

  // Back to A before B resolves: A keeps the picture and waits for its new resolution instead of reloading the revoked URL.
  await page.evaluate(source => window.updateScreenshot({ source }), firstSource);
  await expect.poll(() => page.evaluate(source => window.resolverCalls.filter(value => value === source).length, firstSource)).toBe(2);
  await expect(image).toHaveAttribute("src", released);
  await expect(image).toHaveAttribute("aria-busy", "true");
  const fresh = await blobUrl(page, firstImage);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url: fresh });
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("src", fresh);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(page.getByTestId("fallback")).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.imageErrors), []);
});

test("a held picture is not handed on past a source that failed: the next source waits on its own stand-in", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", fallback: true, holdPrevious: true });
  const first = await blobUrl(page, firstImage);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url: first });
  await expectDecoded(image, 2, 3);

  // A to B, which cannot be read: B's fallback, with A's picture gone with it.
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(secondSource);
  await expect(image).toHaveAttribute("src", first);
  await page.evaluate(source => window.rejectScreenshot(source), secondSource);
  await expect(page.getByTestId("fallback")).toHaveText("No screenshot");

  // On to C: A's picture does not come back under C while C resolves.
  await page.evaluate(source => window.updateScreenshot({ source }), thirdSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toContain(thirdSource);
  await expectWaiting(image);
});

test("a target switch that drops a screenshot still waiting asks the report shown next, which holds the same one", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", fallback: true });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);

  // The Viewer swaps in the other target's report; the same screenshot keeps its source, so this image stays mounted.
  // Trimming the report it waited on rejects the wait.
  await page.evaluate(source => { window.shownReport = "ios"; window.rejectScreenshot(source); }, firstSource);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource, firstSource]);
  await expect(image).toHaveAttribute("data-screenshot-state", "loading");
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  assert.deepEqual(await page.evaluate(() => window.imageErrors), []);

  // Let go after switching back, it releases to the report that resolved it, not the one shown.
  await page.evaluate(() => { window.shownReport = "android"; window.updateScreenshot({ mounted: false }); });
  await expect.poll(() => page.evaluate(() => window.releasedFrom)).toEqual(["ios"]);
});

test("a fresh URL for a screenshot that failed to decode gives it another try", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { layout: "pan", loading: "lazy" });
  const positioner = page.getByTestId("positioner");
  const pan = offset => positioner.evaluate((element, offset) => { element.style.transform = `translateX(${offset}px)`; }, offset);
  await pan(0);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await page.evaluate(source => window.resolveScreenshot(source, "data:image/png;base64,AAAA"), firstSource);
  await expect(image).toHaveAttribute("data-screenshot-state", "failed");

  // Panning away releases it; panning back resolves it again, and this time its bytes decode.
  await pan(2500);
  await expect.poll(() => page.evaluate(() => window.releaseCalls)).toEqual([firstSource]);
  await pan(0);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource, firstSource]);
  await resolveImage(page, firstSource);
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).not.toHaveAttribute("aria-busy", /.*/);
});

test("an image that leaves and re-enters the viewport within one render is ready without a new load event", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "lazy", observer: "manual" });
  await page.evaluate(() => window.setIntersecting(true));
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  const url = await blobUrl(page, firstImage);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url });
  await expectDecoded(image, 2, 3);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect.poll(() => page.evaluate(() => window.imageLoads.length)).toBe(1);

  // The report kept the released URL, so the second resolution returns it at once: React commits
  // the same `src`, and the browser fires no load event for it.
  await page.evaluate(({ source, url }) => {
    window.immediateScreenshots.set(source, url);
    window.setIntersecting(false);
    window.setIntersecting(true);
  }, { source: firstSource, url });
  await expect.poll(() => page.evaluate(() => window.resolverCalls.length)).toBe(2);
  assert.deepEqual(await page.evaluate(() => window.releaseCalls), [firstSource]);
  await expect(image).toHaveAttribute("src", url);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).not.toHaveAttribute("aria-busy", /.*/);
  assert.equal(await page.evaluate(() => window.imageLoads.length), 1, "No second load event fired");
});

/** The image's opacity and state in each of the next `frames` frames, from the frame after `change` runs. */
async function framesAfter(page, change, frames = 4, selector = "img[alt='Captured checkout']") {
  return page.evaluate(({ change, frames, selector }) => new Promise(resolve => {
    const samples = [];
    new Function(change)();
    const sample = () => {
      const image = document.querySelector(selector);
      samples.push(image ? { source: image.dataset.screenshotSrc ?? image.getAttribute("src"),
        state: image.dataset.screenshotState, opacity: getComputedStyle(image).opacity } : undefined);
      if (samples.length < frames) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }), { change, frames, selector });
}

/** The reveal animation on the image, paused and sought to `at` milliseconds: its opacity there. */
async function revealOpacityAt(image, at) {
  return image.evaluate((element, at) => {
    const [animation] = element.getAnimations().filter(animation => animation.animationName === "screenshot-reveal");
    if (!animation) return undefined;
    animation.pause();
    animation.currentTime = at;
    return Number(getComputedStyle(element).opacity);
  }, at);
}

test("a waiting screenshot is hidden from its first frame, and one that fills its empty frame fades in", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true });
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await expect(image).toHaveCSS("opacity", "0");
  await resolveImage(page, firstSource);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).toHaveAttribute("data-screenshot-reveal", "");
  assert.equal(await revealOpacityAt(image, 0), 0, "The fade starts from nothing");
  const midway = await revealOpacityAt(image, 80);
  assert.ok(midway > 0 && midway < 1, `Halfway through the fade the picture is partly shown (${midway})`);
  await image.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
  await expect(image).toHaveCSS("opacity", "1");

  // Another source: the picture before is hidden in the very frame the new source lands, never faded out.
  const samples = await framesAfter(page, `window.updateScreenshot({ source: ${JSON.stringify(secondSource)} })`);
  const landed = samples.filter(sample => sample?.source === secondSource);
  assert.ok(landed.length > 0, "The new source landed within a few frames");
  assert.deepEqual(landed.map(sample => sample.opacity), landed.map(() => "0"));
  assert.deepEqual(samples.filter(sample => sample?.source !== secondSource).map(sample => sample.opacity),
    samples.filter(sample => sample?.source !== secondSource).map(() => "1"), "Until then, the shown picture is the one it names");
  assert.deepEqual(await image.evaluate(element => element.getAnimations().map(animation => animation.constructor.name)), [],
    "Nothing animates the hiding");
});

test("a loaded screenshot is shown only once it has decoded, or after a short wait for a decode that hangs", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true, decode: "manual" });
  await resolveImage(page, firstSource);
  // The caller hears the load at once (Compare takes its shape from it); the picture waits for its pixels.
  await expect.poll(() => page.evaluate(() => window.imageLoads.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.pendingDecodes.length)).toBe(1);
  await page.waitForTimeout(100);
  await expect(image).toHaveAttribute("data-screenshot-state", "loading");
  await expect(image).toHaveCSS("opacity", "0");
  await page.evaluate(() => window.pendingDecodes.shift().resolve());
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).toHaveAttribute("data-screenshot-reveal", "");

  // A decode that never settles: shown anyway, with its fade.
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await resolveImage(page, secondSource, secondImage);
  await expect.poll(() => page.evaluate(() => window.pendingDecodes.length)).toBe(1);
  const loadedAt = await page.evaluate(() => performance.now());
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  const waited = await page.evaluate(() => performance.now()) - loadedAt;
  assert.ok(waited >= 200, `The hung decode was waited for before the picture was shown (${Math.round(waited)}ms)`);
  await expect(image).toHaveAttribute("data-screenshot-reveal", "");
  assert.equal(await image.evaluate(element => element.naturalWidth), 4);
});

test("a screenshot the report still holds decoded fades in when it is shown again", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true });
  const url = await blobUrl(page, firstImage);
  await expect.poll(() => page.evaluate(() => window.resolverCalls)).toEqual([firstSource]);
  await page.evaluate(({ source, url }) => window.resolveScreenshot(source, url), { source: firstSource, url });
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");

  // Shown again (Compare stepping back to it, a view mounting again) while the report still holds its decoded URL.
  await page.evaluate(() => window.updateScreenshot({ mounted: false }));
  await expect(image).toHaveCount(0);
  await page.evaluate(({ source, url }) => {
    window.immediateScreenshots.set(source, url);
    window.updateScreenshot({ mounted: true });
  }, { source: firstSource, url });
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).toHaveAttribute("data-screenshot-reveal", "");
  assert.equal(await revealOpacityAt(image, 0), 0);
});

test("an ordinary URL is a new image for each source and never shows the one before while it loads", { timeout: 30_000 }, async t => {
  const { page } = await fixture(t, { loading: "eager", styles: true, normalSource: "/__normal.png" });
  const hosted = page.getByRole("img", { name: "Hosted screenshot", exact: true });
  await expect(hosted).toHaveAttribute("data-screenshot-state", "ready");
  await expect(hosted).toHaveAttribute("data-screenshot-reveal", "");
  await hosted.evaluate(element => { element.dataset.first = "true"; });

  const samples = await framesAfter(page, "window.updateScreenshot({ normalSource: '/__slow.png' })", 6, "img[alt='Hosted screenshot']");
  const landed = samples.filter(sample => sample?.source === "/__slow.png");
  assert.ok(landed.length > 0);
  assert.deepEqual(landed.map(sample => [sample.state, sample.opacity]), landed.map(() => ["loading", "0"]));
  await expect(hosted).not.toHaveAttribute("data-first", /.*/);
  await expect(hosted).toHaveAttribute("data-screenshot-state", "ready");
  await expect(hosted).toHaveAttribute("data-screenshot-reveal", "");
  await expectDecoded(hosted, 4, 5);
});

test("a held picture stays shown while its replacement loads, and the replacement appears without a fade", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true, holdPrevious: true, fallback: true });
  await resolveImage(page, firstSource);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await page.evaluate(source => window.updateScreenshot({ source }), secondSource);
  await expect(image).toHaveAttribute("data-screenshot-held", "");
  await expect(image).toHaveCSS("opacity", "1");
  await resolveImage(page, secondSource, secondImage);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expectDecoded(image, 4, 5);
  await expect(image).not.toHaveAttribute("data-screenshot-reveal", /.*/);
  await expect(image).not.toHaveAttribute("data-screenshot-held", /.*/);
  assert.deepEqual(await image.evaluate(element => element.getAnimations().length), 0);
});

test("inside an instant stage a picture appears at once", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true, instant: true });
  await resolveImage(page, firstSource);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await expect(image).not.toHaveAttribute("data-screenshot-reveal", /.*/);
  await expect(image).toHaveCSS("opacity", "1");
});

test("with reduced motion a screenshot appears without a fade", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true, reducedMotion: true });
  await resolveImage(page, firstSource);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  // The Viewer's reduced-motion rule leaves every transition a hundredth of a millisecond long; the fade is gone.
  assert.deepEqual(await image.evaluate(element => element.getAnimations().map(animation => animation.animationName).filter(Boolean)), []);
  await expect(image).toHaveCSS("opacity", "1");
});

test("an unselected variant thumbnail that changes source hides at once, despite its own dimmed opacity and its transition", { timeout: 30_000 }, async t => {
  const { page, image } = await fixture(t, { loading: "eager", styles: true, thumbnail: true });
  await resolveImage(page, firstSource);
  await expect(image).toHaveAttribute("data-screenshot-state", "ready");
  await image.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));
  await expect(image).toHaveCSS("opacity", "0.35");
  const samples = await framesAfter(page, `window.updateScreenshot({ source: ${JSON.stringify(secondSource)} })`);
  const landed = samples.filter(sample => sample?.source === secondSource);
  assert.ok(landed.length > 0);
  assert.deepEqual(landed.map(sample => sample.opacity), landed.map(() => "0"));
});
