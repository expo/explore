import { expect, test, type Locator, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExploreMap } from "../../src/types";
import { emptyMap } from "../helpers/map-store-fixture.mjs";
import { viewerMapFixture, viewerWorkspaceFixture, captureAliasFixture, fixtureImage, SCREEN_COUNT } from "../helpers/viewer-map-fixture.mjs";
import { createBuildWorkspaceFixture } from "../helpers/build-workspace-fixture.mjs";

// Most camera tests describe "Follow selection" (the camera moves to every focused screen), which
// is off by default. The default has a test of its own, which removes this setting again.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("expo-explore:follow-selection", "true"));
});

function scaleFromTransform(transform: string | null): number {
  const match = transform?.match(/scale\(([^)]+)\)/);
  if (!match) throw new Error(`Could not read graph scale from ${String(transform)}`);
  return Number(match[1]);
}

async function readCanvasCamera(viewport: Locator) {
  return viewport.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 };
  });
}

async function expectPanelFitMatchesPrimaryFit(page: Page, canvas: string) {
  const root = page.locator(`.${canvas}-canvas`);
  // The frame provider publishes only after the panel geometry has settled. Waiting past the
  // 280ms panel flight prevents this assertion's manual Fit from cancelling a queued auto-Fit.
  await page.waitForTimeout(360);
  await expect(root).not.toHaveClass(/canvas-focus-animating/);
  const viewport = root.locator(".react-flow__viewport");
  const automatic = await readCanvasCamera(viewport);
  await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
  await page.waitForTimeout(220);
  const manual = await readCanvasCamera(viewport);
  expect(Math.abs(manual.x - automatic.x), `${canvas} selected Fit x`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(manual.y - automatic.y), `${canvas} selected Fit y`).toBeLessThanOrEqual(0.5);
  expect(Math.abs(manual.zoom - automatic.zoom), `${canvas} selected Fit zoom`)
    .toBeLessThanOrEqual(0.001);
}

async function expectCanvasSelectedFrame(frame: Locator) {
  await expect(frame).toHaveClass(/\bis-selected\b/);
  // Selection preserves the screenshot's own border. Only a projected hover highlight adds
  // the accent overlay; a selected frame alone must not cover a Modified screen's status.
  const visual = await frame.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return {
      borderColor: style.borderTopColor,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
    };
  });
  expect(visual.borderColor).toBe("rgba(0, 0, 0, 0)");
  expect(visual.borderStyle).toBe("solid");
  expect(visual.borderWidth).toBe("2px");
}

async function expectAutoHideScrollbar(
  shell: Locator,
  body: Locator,
) {
  await expect(shell).toHaveClass(/\bauto-hide-scroll-area\b/);
  const didScroll = await body.evaluate((element) => {
    if (!(element instanceof HTMLElement)) return false;
    element.scrollTop = Math.min(80, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return element.scrollTop > 0;
  });
  expect(didScroll).toBe(true);
  await expect(shell).toHaveClass(/\bis-scrollable\b/);
  await expect(shell).toHaveClass(/\bis-scrolling\b/);
  const scrollbar = shell.locator(":scope > .auto-hide-scrollbar");
  await expect(scrollbar).toHaveCSS("opacity", "1");
  await expect(shell).not.toHaveClass(/\bis-scrolling\b/, { timeout: 1_500 });
  await expect(scrollbar).toHaveCSS("opacity", "0");
}

async function expectMapScreenSelectionDimming(
  page: Page,
  options: { hoverTargetCount?: number } = {},
) {
  const screens = page.locator(
    ".map-canvas .react-flow__node-screen:not(.canvas-node-exit)",
  );
  const selected = page.locator(
    ".map-canvas .react-flow__node-screen.selected:not(.canvas-node-exit)",
  );
  const dimmed = page.locator(
    ".map-canvas .react-flow__node-screen:not(.selected):not(.canvas-node-exit)",
  );
  await expect(page.locator(".map-canvas")).toHaveClass(/screen-selection-active/);
  await expect(selected).toHaveCount(1);
  await expect.poll(async () => dimmed.count()).toBe((await screens.count()) - 1);
  expect(await screens.evaluateAll(nodes => nodes.every(node => getComputedStyle(node).opacity === "1"))).toBe(true);

  await expect.poll(async () => {
    const [selectedOpacity, dimmedOpacity] = await Promise.all([
      selected.locator(":scope > .canvas-active-frame").evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
      dimmed.first().locator(":scope > .canvas-active-frame").evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
    ]);
    return dimmedOpacity < selectedOpacity;
  }).toBe(true);

  // Selection focus moves the canvas before hover affordances are exercised. Choose hover
  // targets only after that flight settles so a node cannot move underneath the minimap between
  // the hit-test below and Playwright's pointer action.
  await expect(page.locator(".map-canvas.canvas-focus-animating")).toHaveCount(0);

  const hoverableDimmedIndexes = await dimmed.evaluateAll((nodes) => nodes.flatMap((node, index) => {
    const bounds = node.getBoundingClientRect();
    const centerTarget = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    const nodeId = node.getAttribute("data-id");
    const hasDirectEdge = nodeId !== null && [...document.querySelectorAll(".react-flow__edge")]
      .some((edge) => {
        const label = edge.getAttribute("aria-label") ?? "";
        return label.startsWith(`Edge from ${nodeId} to `) || label.endsWith(` to ${nodeId}`);
      });
    return centerTarget !== null && node.contains(centerTarget) && hasDirectEdge ? [index] : [];
  }));
  const hoverTargetCount = options.hoverTargetCount ?? 1;
  expect(hoverableDimmedIndexes.length).toBeGreaterThanOrEqual(hoverTargetCount);
  let lastHoverTarget = dimmed.nth(hoverableDimmedIndexes[0]!);

  for (const index of hoverableDimmedIndexes.slice(0, hoverTargetCount)) {
    const hoverTarget = dimmed.nth(index);
    const hoverTargetId = await hoverTarget.getAttribute("data-id");
    expect(hoverTargetId).not.toBeNull();
    await hoverTarget.hover();
    await expect.poll(() => hoverTarget.locator(":scope > .canvas-active-frame").evaluate(
      (node) => Number.parseFloat(getComputedStyle(node).opacity),
    )).toBe(1);
    await expect(hoverTarget).toHaveCSS("filter", "none");
    const hoverSubject = page.locator(
      ".map-canvas .react-flow__node-screen.graph-node-hover-subject",
    );
    await expect(hoverSubject).toHaveCount(1);
    await expect(hoverSubject).toHaveAttribute("data-id", hoverTargetId!);
    const allEdges = page.locator(".map-canvas .react-flow__edge");
    const directEdgeCount = await allEdges.evaluateAll((edges, nodeId) => edges.filter((edge) => {
      const label = edge.getAttribute("aria-label") ?? "";
      return label.startsWith(`Edge from ${nodeId} to `) || label.endsWith(` to ${nodeId}`);
    }).length, hoverTargetId!);
    expect(directEdgeCount).toBeGreaterThan(0);
    // The hovered screen and every screen it shares an edge with stay bright; the rest recede.
    const neighbourIds = await allEdges.evaluateAll((edges, nodeId) => {
      const ids = new Set<string>([nodeId]);
      for (const edge of edges) {
        const match = /^Edge from (.+) to (.+)$/.exec(edge.getAttribute("aria-label") ?? "");
        if (!match) continue;
        if (match[1] === nodeId) ids.add(match[2]!);
        if (match[2] === nodeId) ids.add(match[1]!);
      }
      return [...ids].sort();
    }, hoverTargetId!);
    const brightNodes = page.locator(
      ".map-canvas .react-flow__node-screen.graph-node-hover-related",
    );
    await expect.poll(() => brightNodes.evaluateAll((nodes) => (
      nodes.map((node) => node.getAttribute("data-id") ?? "").sort()
    ))).toEqual(neighbourIds);
    const receded = page.locator(
      ".map-canvas .react-flow__node-screen:not(.graph-node-hover-related)",
    );
    if (await receded.count() > 0) {
      await expect.poll(() => receded.first().evaluate(
        (node) => Number.parseFloat(getComputedStyle(node).opacity),
      )).toBeGreaterThan(0.5);
    }
    const activeEdges = page.locator(
      ".map-canvas .react-flow__edge.graph-edge-hover-related",
    );
    await expect(activeEdges).toHaveCount(directEdgeCount);
    const activeEdgeLabels = await activeEdges.evaluateAll((edges) => (
      edges.map((edge) => edge.getAttribute("aria-label") ?? "")
    ));
    expect(activeEdgeLabels.every((label) => (
      label.startsWith(`Edge from ${hoverTargetId} to `)
      || label.endsWith(` to ${hoverTargetId}`)
    ))).toBe(true);
    lastHoverTarget = hoverTarget;
    if (index !== hoverableDimmedIndexes.slice(0, hoverTargetCount).at(-1)) {
      await page.mouse.move(1, 1);
      await page.waitForTimeout(160);
    }
  }

  await page.mouse.move(1, 1);
  await expect.poll(async () => {
    const [selectedOpacity, dimmedOpacity] = await Promise.all([
      selected.locator(":scope > .canvas-active-frame").evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
      lastHoverTarget.locator(":scope > .canvas-active-frame").evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity)),
    ]);
    return dimmedOpacity < selectedOpacity;
  }).toBe(true);
}

/** The camera chrome's theme button steps Auto → Dark → Light; press it until the page shows the option. */
async function chooseTheme(page: Page, option: "light" | "dark") {
  const root = page.locator("html");
  for (let presses = 0; presses < 3; presses += 1) {
    if (await root.getAttribute("data-theme") === option) return;
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.waitForTimeout(50);
  }
  await expect(root).toHaveAttribute("data-theme", option);
}

/** Bottom toolbar → persistent canvas view control. */
async function chooseCanvasView(
  page: Page,
  option: "Map" | "Screens",
) {
  await page.getByRole("toolbar", { name: "Canvas tools" })
    .getByRole("group", { name: "Canvas view" })
    .getByRole("button", { name: option, exact: true })
    .click();
}

type CanvasViewAnimationSnapshot = {
  animationName: string;
  pseudoElement: string | null;
  duration: number;
  delay: number;
  easing: string;
  startTime: number | null;
  keyframes: Array<{ opacity?: string; transform?: string }>;
};

async function captureCanvasViewAnimations(
  page: Page,
  option: "Map" | "Screens",
): Promise<CanvasViewAnimationSnapshot[]> {
  await page.evaluate(() => {
    const host = window as typeof window & {
      __canvasViewAnimations?: CanvasViewAnimationSnapshot[] | null;
    };
    const startViewTransition = document.startViewTransition?.bind(document);
    if (!startViewTransition) throw new Error("View Transitions are unavailable");
    host.__canvasViewAnimations = null;
    document.startViewTransition = ((update) => {
      document.startViewTransition = startViewTransition;
      const transition = startViewTransition(update);
      // At `ready` the pseudo-element animations exist but their start times may still be
      // pending; wait for each animation to leave its pending state before sampling.
      void transition.ready.then(() => {
        const animations = document.getAnimations().filter((animation) => (
          animation instanceof CSSAnimation
          && animation.effect instanceof KeyframeEffect
          && Boolean(animation.effect.pseudoElement)
        ));
        void Promise.all(animations.map((animation) => (
          animation.ready.catch(() => animation)
        ))).then(() => {
          host.__canvasViewAnimations = animations.flatMap((animation) => {
            if (!(animation instanceof CSSAnimation)) return [];
            const effect = animation.effect;
            if (!(effect instanceof KeyframeEffect) || !effect.pseudoElement) return [];
            const timing = effect.getTiming();
            const keyframes = effect.getKeyframes();
            return [{
            animationName: animation.animationName,
            pseudoElement: effect.pseudoElement,
            duration: Number(timing.duration),
            delay: timing.delay,
            // CSS animations carry animation-timing-function on their keyframes; the
            // effect-level easing is always reported as "linear".
            easing: keyframes[0]?.easing ?? timing.easing,
            startTime: typeof animation.startTime === "number" ? animation.startTime : null,
            keyframes: keyframes.map((frame) => ({
              ...(frame.opacity !== undefined ? { opacity: String(frame.opacity) } : {}),
              ...(frame.transform !== undefined ? { transform: String(frame.transform) } : {}),
            })),
            }];
          });
        });
      });
      return transition;
    }) as typeof document.startViewTransition;
  });

  await chooseCanvasView(page, option);
  await page.waitForFunction(() => Array.isArray(
    (window as typeof window & { __canvasViewAnimations?: unknown }).__canvasViewAnimations,
  ));
  return page.evaluate(() => (
    (window as typeof window & {
      __canvasViewAnimations: CanvasViewAnimationSnapshot[];
    }).__canvasViewAnimations
  ));
}

async function selectedScreenCenterDelta(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".app-content")?.getBoundingClientRect();
    const selected = document.querySelector<HTMLElement>([
      ".react-flow__node-screen.selected",
    ].join(","))?.getBoundingClientRect();
    if (!root || !selected) throw new Error("Selected screen geometry is unavailable");

    return {
      x: selected.left + selected.width / 2 - (root.left + root.right) / 2,
      y: selected.top + selected.height / 2 - (root.top + root.bottom) / 2,
    };
  });
}

async function expectSelectedScreenCentered(page: Page) {
  await expect.poll(async () => {
    const delta = await selectedScreenCenterDelta(page);
    return Math.max(Math.abs(delta.x), Math.abs(delta.y));
  }, { timeout: 3_000 }).toBeLessThanOrEqual(2);
}


/** The Changes list lives in the top-left pill's menu: open it (once) and return the menu. */
/** Opens the review's What changed popover in the Inspector and returns its list items. */
async function whatChangedItems(page: Page) {
  const button = page.locator(".right-panel").getByRole("button", { name: /^What changed/ });
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
  return page.getByRole("region", { name: "What changed on this screen" }).locator("li");
}

async function openChangesMenu(page: Page) {
  // The pill has no chip: ⌘B (Ctrl+B) opens the Changes menu, as Compare's title does there.
  const menu = page.locator(".changes-menu");
  // The Compare button appears once the changes are loaded; the shortcut needs them too.
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true })).toBeVisible();
  if (!(await menu.isVisible())) await page.keyboard.press("ControlOrMeta+KeyB");
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * A synthetic map served in place of the example. With `routes`, every screen records an
 * expo-router path, and screens 2 and 3 share one — as a modal or a logged-out state would.
 */
async function liveMapPayload(screenCount: number, revision: number, routes = false) {
  const source = emptyMap("Live refresh fixture");
  const capturedAt = new Date().toISOString();
  const screens = Array.from({ length: screenCount }, (_, index) => ({
    id: `live-screen-${index + 1}`,
    title: `Live screen ${index + 1}`,
    ...(routes
      ? { route: index === 1 || index === 2 ? "/(tabs)/live/shared" : `/(tabs)/live/${index + 1}` }
      : {}),
    start: index === 0,
    terminal: false,
    depth: 0,
    firstSeenAt: capturedAt,
    lastSeenAt: capturedAt,
    visits: 1,
    variantIds: [],
    observationIds: [],
    elementIds: [],
  }));
  const map = {
    ...source,
    revision,
    run: { ...source.run, name: "Live refresh fixture", updatedAt: capturedAt },
    artifacts: [],
    screens,
    variants: [],
    observations: [],
    elements: [],
    actionAttempts: [],
    transitions: [],
    journeys: [],
    frontier: [],
    gaps: [],
  };
  return {
    map,
    coverage: {
      screens: screenCount,
      variants: 0,
      observations: 0,
      elements: 0,
      transitions: 0,
      actions: { attempted: 0, succeeded: 0, noChange: 0, failed: 0, blocked: 0 },
      frontier: { pending: 0, claimed: 0, done: 0, skipped: 0, blocked: 0 },
      gaps: { open: 0, accepted: 0, resolved: 0 },
      completion: { eligible: true, blockers: [] },
      limits: source.run.limits,
    },
  };
}

/** Serves `payload` for the map and status endpoints until `current` is swapped. */
async function serveMap(page: Page, initial: Awaited<ReturnType<typeof liveMapPayload>>) {
  const state = { current: initial };
  // A standalone fixture must not inherit a catalog from a reused local viewer server.
  await page.route("**/api/workspace", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/workspace/status", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/map", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { ETag: `"${state.current.map.run.id}:${state.current.map.revision}"` },
      body: JSON.stringify(state.current),
    });
  });
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: state.current.map.run.id,
        revision: state.current.map.revision,
        coverage: state.current.coverage,
      }),
    });
  });
  return state;
}

function coverageForMap(map: ExploreMap) {
  return {
    screens: map.screens.length,
    variants: map.variants.length,
    observations: map.observations.length,
    elements: map.elements.length,
    transitions: map.transitions.length,
    actions: { attempted: 0, succeeded: 0, noChange: 0, failed: 0, blocked: 0 },
    frontier: { pending: 0, claimed: 0, done: 0, skipped: 0, blocked: 0 },
    gaps: { open: 0, accepted: 0, resolved: 0 },
    completion: { eligible: true, blockers: [] },
    limits: map.run.limits,
  };
}

function readyWhatChanged(facts: Array<Record<string, unknown>>) {
  return {
    status: "ready",
    needsReview: false,
    noVisibleChange: false,
    facts,
    visibleFacts: facts.slice(0, 5),
    collapsedCount: Math.max(0, facts.length - 5),
    reviewIssues: [],
  };
}

function reviewSurfaceFixture(
  sourceScreenId: string,
  status: "added" | "removed" | "changed" | "unchanged",
  facts: Array<Record<string, unknown>>,
  runtimeEvidenceRef: string,
) {
  return {
    id: sourceScreenId,
    sourceScreenId,
    status,
    whatChanged: readyWhatChanged(facts),
    runtimeEvidenceRef,
    sourceImpact: { kind: "direct", changedFileCount: 1 },
    needsReview: false,
  };
}

function runtimeReviewEvidence(options: {
  side: "base" | "head";
  logicalBuild: string;
  surfaceId: string;
  route: string;
  observationId: string;
  variantId: string;
  diagnostics?: "empty" | "sample-shortfall" | "unsafe-url";
}) {
  const capture = <T,>(value: T) => ({ origin: "capture-context", value });
  const eas = <T,>(value: T) => ({ origin: "eas-agent-device", value });
  const derived = <T,>(value: T) => ({ origin: "derived", value });
  const expectedSamples = options.diagnostics === "sample-shortfall" ? 3 : 1;
  const diagnostics = (() => {
    if (options.diagnostics === "empty") {
      return { diagnostics: { id: "diagnostics", entries: [] } };
    }
    if (options.diagnostics === "sample-shortfall") {
      return {
        diagnostics: {
          id: "diagnostics",
          entries: [{
            code: "capture.sample-shortfall",
            title: "Capture sample anomaly",
            value: "shortfall",
            origin: "derived",
          }],
        },
      };
    }
    if (options.diagnostics === "unsafe-url") {
      return {
        diagnostics: {
          id: "diagnostics",
          entries: [{
            code: "capture.sample-shortfall",
            title: "Capture sample anomaly",
            value: "https://example.test/private-runtime-data",
            origin: "derived",
          }],
        },
      };
    }
    return {};
  })();
  return {
    contract: "expo.explore.runtime-evidence.v0",
    groups: {
      screen: {
        id: "screen",
        side: capture(options.side),
        logicalBuild: capture(options.logicalBuild),
        route: capture(options.route),
        surfaceId: capture(options.surfaceId),
        variantId: capture(options.variantId),
        observationId: eas(options.observationId),
        surfaceScope: eas("app"),
        capturedAt: eas("2026-08-25T09:00:00.000Z"),
      },
      ui: {
        id: "ui",
        elementCount: derived(1),
        actionableCount: derived(1),
        roleCounts: derived([{ role: "button", count: 1 }]),
        landmarks: derived([]),
        snapshotQuality: derived("complete"),
        truncated: eas(false),
      },
      interaction: {
        id: "interaction",
        attempts: eas([]),
        outcomeCounts: derived({
          transition: 0,
          "same-screen": 0,
          "no-change": 0,
          failed: 0,
          blocked: 0,
          external: 0,
        }),
        transitionCount: derived(0),
      },
      capture: {
        id: "capture",
        samples: eas([{
          id: `${options.observationId}-sample`,
          observationId: options.observationId,
          variantId: options.variantId,
          capturedAt: "2026-08-25T09:00:00.000Z",
          widthPixels: 1179,
          heightPixels: 2556,
          pixelDensity: 3,
          fingerprints: {
            combined: `${options.observationId}-combined`,
            visual: `${options.observationId}-visual`,
          },
        }]),
        sampleCount: derived(1),
        stability: derived("single-sample"),
        dimensions: derived([{ widthPixels: 1179, heightPixels: 2556 }]),
        pixelDensities: derived([3]),
        coverage: derived({
          expected: expectedSamples,
          captured: 1,
          ratio: 1 / expectedSamples,
          complete: expectedSamples === 1,
        }),
      },
      environment: {
        id: "environment",
        profile: capture("explore"),
        fixturePersona: capture("free-cat-owner"),
        provider: eas("eas-simulator"),
        controller: eas("agent-device"),
        platform: eas("ios"),
        deviceModel: eas("iPhone 17"),
        osVersion: eas("26.5"),
        locale: eas("en-US"),
        orientation: eas("portrait"),
        colorScheme: eas("light"),
        sessionLifecycle: eas("stopped"),
      },
      ...diagnostics,
    },
  };
}

/** Serves the two real build shapes used by the reviewed comparison model. */
async function serveWorkspace(page: Page, options: { catalogName?: string } = {}) {
  const fixture = await createBuildWorkspaceFixture();
  const payload = {
    catalog: options.catalogName
      ? { ...fixture.catalog, name: options.catalogName }
      : fixture.catalog,
    builds: {
      "build-1.0.0": {
        map: fixture.baselineMap,
        coverage: coverageForMap(fixture.baselineMap),
      },
      "build-2.0.0": {
        map: fixture.currentMap,
        coverage: coverageForMap(fixture.currentMap),
      },
    },
    comparison: fixture.comparison,
    review: {
      contract: "expo.explore.review-workspace.v0",
      pullRequest: {
        repositoryId: "123456789",
        repository: "expo/explore-playground",
        number: 550,
        title: "Refine Example review surfaces across onboarding, cats, games, profile, and settings",
        url: "https://github.com/expo/explore-playground/pull/550",
        base: {
          ref: "pilot/explore-base",
          sha: "1111111111111111111111111111111111111111",
        },
        head: {
          ref: "pilot/explore-changes",
          sha: "2222222222222222222222222222222222222222",
        },
      },
      surfaces: {
        "current-profile": reviewSurfaceFixture(
          "current-profile",
          "changed",
          [
            {
              category: "visible-text",
              templateId: "visible-text.changed-short",
              bullet: "Changed button title from “A” to “B”.",
              subjectRole: "button",
              subjectLabel: "Continue",
              before: "A",
              after: "B",
              priority: 30,
              evidenceRefs: ["profile-base-label", "profile-head-label"],
            },
            {
              category: "element",
              templateId: "element.added",
              bullet: "Added button “Care guide”.",
              subjectRole: "button",
              subjectLabel: "Care guide",
              priority: 20,
              evidenceRefs: ["profile-head-label"],
            },
            {
              category: "visible-text",
              templateId: "visible-text.changed-long",
              bullet: "Updated body copy in “Profile introduction”.",
              subjectRole: "content",
              subjectLabel: "Profile introduction",
              before: "Previous profile introduction copy.",
              after: "Current profile introduction copy.",
              priority: 30,
              evidenceRefs: ["profile-base-label", "profile-head-label"],
            },
            {
              category: "interaction",
              templateId: "interaction.target-changed",
              bullet: "Changed “Care guide” action from “Profile” to “Cat Care Guide”.",
              subjectRole: "button",
              subjectLabel: "Care guide",
              before: "Profile",
              after: "Cat Care Guide",
              priority: 40,
              evidenceRefs: ["profile-head-action"],
            },
            {
              category: "accessibility",
              templateId: "accessibility.label-changed",
              bullet: "Changed accessibility label from “Open help” to “Open care guide”.",
              subjectRole: "button",
              subjectLabel: "Open care guide",
              before: "Open help",
              after: "Open care guide",
              priority: 50,
              evidenceRefs: ["profile-base-label", "profile-head-label"],
            },
            {
              category: "visual",
              templateId: "visual.landmark-changed",
              bullet: "Updated the visual appearance of “Profile hero”.",
              subjectRole: "landmark",
              subjectLabel: "Profile hero",
              priority: 60,
              evidenceRefs: ["profile-base-image", "profile-head-image"],
            },
            {
              category: "visible-text",
              templateId: "visible-text.changed-long",
              bullet: "Updated body copy in “Profile footer”.",
              subjectRole: "content",
              subjectLabel: "Profile footer",
              before: "Previous footer copy.",
              after: "Current footer copy.",
              priority: 30,
              evidenceRefs: ["profile-base-label", "profile-head-label"],
            },
          ],
          "profile-evidence",
        ),
        "current-added": reviewSurfaceFixture("current-added", "added", [{
            category: "screen",
            templateId: "screen.added",
            bullet: "Added screen “Cat Care Guide”.",
            subjectRole: "screen",
            subjectLabel: "Cat Care Guide",
            priority: 10,
            evidenceRefs: ["care-guide-head-image"],
          }], "care-guide-evidence"),
        "baseline-legacy": reviewSurfaceFixture("baseline-legacy", "removed", [{
            category: "screen",
            templateId: "screen.removed",
            bullet: "Removed screen “Sweet Bee”.",
            subjectRole: "screen",
            subjectLabel: "Sweet Bee",
            priority: 10,
            evidenceRefs: ["legacy-base-image"],
          }], "legacy-evidence"),
      },
      runtimeEvidence: {
        "profile-evidence": {
          contract: "expo.explore.runtime-evidence-comparison.v0",
          status: "modified",
          base: runtimeReviewEvidence({
            side: "base",
            logicalBuild: "1111111111111111111111111111111111111111",
            surfaceId: "baseline-profile",
            route: "/baseline-profile",
            observationId: "observation-build-1.0.0-baseline-profile-primary",
            variantId: "variant-observation-build-1.0.0-baseline-profile-primary",
            diagnostics: "sample-shortfall",
          }),
          head: runtimeReviewEvidence({
            side: "head",
            logicalBuild: "2222222222222222222222222222222222222222",
            surfaceId: "current-profile",
            route: "/current-profile",
            observationId: "observation-build-2.0.0-current-profile-reviewed",
            variantId: "variant-observation-build-2.0.0-current-profile-reviewed",
            diagnostics: "empty",
          }),
        },
        "care-guide-evidence": {
          contract: "expo.explore.runtime-evidence-comparison.v0",
          status: "added",
          head: runtimeReviewEvidence({
            side: "head",
            logicalBuild: "2222222222222222222222222222222222222222",
            surfaceId: "current-added",
            route: "/current-added",
            observationId: "observation-build-2.0.0-current-added-primary",
            variantId: "variant-observation-build-2.0.0-current-added-primary",
          }),
        },
        "legacy-evidence": {
          contract: "expo.explore.runtime-evidence-comparison.v0",
          status: "removed",
          base: runtimeReviewEvidence({
            side: "base",
            logicalBuild: "1111111111111111111111111111111111111111",
            surfaceId: "baseline-legacy",
            route: "/baseline-legacy",
            observationId: "observation-build-1.0.0-baseline-legacy-primary",
            variantId: "variant-observation-build-1.0.0-baseline-legacy-primary",
            diagnostics: "unsafe-url",
          }),
        },
      },
    },
  };
  const etag = '"workspace-e2e"';

  await page.route("**/api/workspace", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { ETag: etag },
      body: JSON.stringify(payload),
    });
  });
  await page.route("**/api/workspace/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { ETag: etag },
      body: JSON.stringify({
        currentBuildId: fixture.catalog.currentBuildId,
        defaultBaselineBuildId: fixture.catalog.defaultBaselineBuildId,
        builds: Object.fromEntries(Object.entries(payload.builds).map(([buildId, build]) => [
          buildId,
          {
            runId: build.map.run.id,
            revision: build.map.revision,
            coverage: build.coverage,
          },
        ])),
        comparison: {
          baselineBuildId: fixture.comparison.baselineBuildId,
          currentBuildId: fixture.comparison.currentBuildId,
          baselineRevision: fixture.comparison.baselineRevision,
          currentRevision: fixture.comparison.currentRevision,
        },
      }),
    });
  });
  await page.route("**/api/builds/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const buildId = decodeURIComponent(parts[3] ?? "");
    const artifactPath = parts.slice(5).map(decodeURIComponent).join("/");
    const buildRoot = buildId === "build-1.0.0"
      ? fixture.baselineRoot
      : buildId === "build-2.0.0"
        ? fixture.currentRoot
        : undefined;
    if (!buildRoot) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"Build not found"}',
      });
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body: await readFile(resolve(buildRoot, artifactPath)),
    });
  });

  return fixture;
}

/** Serves the export:web layout without any local viewer API routes. */
async function serveStaticWorkspace(page: Page) {
  const fixture = await createBuildWorkspaceFixture();
  const workspaceRequestCookies: string[] = [];
  const payload = {
    catalog: fixture.catalog,
    builds: {
      "build-1.0.0": {
        map: fixture.baselineMap,
        coverage: coverageForMap(fixture.baselineMap),
      },
      "build-2.0.0": {
        map: fixture.currentMap,
        coverage: coverageForMap(fixture.currentMap),
      },
    },
    comparison: fixture.comparison,
  };

  await page.route("**/runtime/workspace.json", async (route) => {
    workspaceRequestCookies.push(route.request().headers()["cookie"] ?? "");
    await route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(payload),
    });
  });
  await page.route("**/runtime/artifacts/**", async (route) => {
    const parts = new URL(route.request().url()).pathname
      .slice("/runtime/artifacts/".length)
      .split("/")
      .map(decodeURIComponent);
    const buildId = parts.shift();
    const buildRoot = buildId === "build-1.0.0"
      ? fixture.baselineRoot
      : buildId === "build-2.0.0"
        ? fixture.currentRoot
        : undefined;
    if (!buildRoot) {
      await route.fulfill({ status: 404, body: "Build not found" });
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body: await readFile(resolve(buildRoot, ...parts)),
    });
  });

  return { ...fixture, workspaceRequestCookies };
}

/** A generated comparison with enough flows and changes to exercise scrolling and camera Fits. */
async function serveSyntheticWorkspace(page: Page) {
  const fixture = viewerWorkspaceFixture();
  const { catalog, comparison } = fixture;
  const builds = {
    "build-1.0.0": { map: fixture.baselineMap, coverage: coverageForMap(fixture.baselineMap) },
    "build-2.0.0": { map: fixture.currentMap, coverage: coverageForMap(fixture.currentMap) },
  };
  const payload = { catalog, builds, comparison };
  const etag = '"synthetic-workspace-e2e"';
  await page.route("**/api/workspace", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { ETag: etag },
      body: JSON.stringify(payload),
    });
  });
  await page.route("**/api/workspace/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      headers: { ETag: etag },
      body: JSON.stringify({
        currentBuildId: catalog.currentBuildId,
        defaultBaselineBuildId: catalog.defaultBaselineBuildId,
        builds: Object.fromEntries(Object.entries(builds).map(([buildId, build]) => [
          buildId,
          { runId: build.map.run.id, revision: build.map.revision, coverage: build.coverage },
        ])),
        comparison: {
          baselineBuildId: comparison.baselineBuildId,
          currentBuildId: comparison.currentBuildId,
          baselineRevision: comparison.baselineRevision,
          currentRevision: comparison.currentRevision,
        },
      }),
    });
  });
  await page.route("**/api/builds/**", async route => {
    await route.fulfill({ contentType: "image/svg+xml", body: fixtureImage });
  });
  return payload;
}

test("renders the panel shell, inspects a screen, and pans from a fixed canvas node", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 863 });
  await page.goto("/map");

  await expect(page.getByRole("img", { name: "Expo" })).toBeVisible();
  await expect(page.locator(".collapsed-app-identity").getByText("Viewer fixture", { exact: true }))
    .toBeVisible();
  // A build without a pull request names no PR in the pill.
  await expect(page.locator(".collapsed-pr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pan", exact: true })).toHaveCount(0);
  await expect(page.locator(".graph-canvas .react-flow")).toHaveClass(/canvas-tool-pan/);

  const screenNode = page.locator(".map-canvas .react-flow__node-screen").first();
  await expect(screenNode).toBeVisible();
  const nodeBefore = await screenNode.evaluate((element) => (element as HTMLElement).style.transform);
  const viewport = page.locator(".react-flow__viewport");
  const viewportBefore = await viewport.getAttribute("style");
  const box = await screenNode.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + 54, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(viewportBefore);
  await expect.poll(() => screenNode.evaluate((element) => (element as HTMLElement).style.transform))
    .toBe(nodeBefore);

  await screenNode.locator(".screen-screenshot-target")
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("screen")).not.toBeNull();
  await expect(page.locator(".transition-row strong.transition-path").first()).toHaveText(/^\//);
  await expect(page.locator(".transition-row strong.transition-path").first()).toHaveCSS("text-align", "left");
  await expect(page.locator(".transition-row .diff-dot").first()).toBeVisible();
  await expect(page.locator(".transition-row .transition-copy small")).toHaveCount(0);
  await expect(page.locator(".transition-list")).toHaveCSS("border-top-width", "0px");
  await expect(page.locator(".transition-row").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  // Choosing the already-active canvas is a no-op and keeps this explicit selection.
  await chooseCanvasView(page, "Map");
  await expect(page).toHaveURL(/\/map\?screen=[^&]+$/);
  await expect(screenNode).toBeVisible();
});

test("filters Changes with status chips and opens selected changes in Screens", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");

  // Changes lives in the pill's menu; the menu stays open while the reader filters and finds.
  const menu = await openChangesMenu(page);
  const changes = menu.locator(".changes-panel");
  const heading = changes.locator(".changes-panel-heading");
  await expect(heading.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(heading.getByRole("searchbox")).toHaveCount(0);
  const defaultHeadingBox = await heading.boundingBox();
  expect(defaultHeadingBox).not.toBeNull();

  const findButton = heading.getByRole("button", { name: "Find changes" });
  await expect(heading.getByRole("heading", { name: "Changes" }).locator(".changes-panel-count")).toHaveText("6");
  await expect(findButton.locator("svg.lucide-search")).toHaveCount(1);
  await findButton.click();

  const routeSearch = heading.getByRole("searchbox", { name: "Find changed screens" });
  await expect(routeSearch).toHaveAttribute("placeholder", "Find…");
  await expect(routeSearch).toBeFocused();
  expect((await heading.boundingBox())!.height).toBe(defaultHeadingBox!.height);
  const findField = heading.locator(".panel-search");
  await expect(findField).toHaveCSS("height", "30px");
  await expect(findField).toHaveCSS("border-top-style", "solid");
  await expect(findField).toHaveCSS("border-top-width", "1px");
  await expect(findField).toHaveCSS("border-radius", "7px");
  await expect(findField).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(heading.getByRole("button", { name: "Close find" })
    .locator("svg.lucide-x")).toHaveCount(1);

  const [findInputBox, closeFindBox] = await Promise.all([
    findField.boundingBox(),
    heading.getByRole("button", { name: "Close find" }).boundingBox(),
  ]);
  expect(findInputBox).not.toBeNull();
  expect(closeFindBox).not.toBeNull();
  expect(closeFindBox!.x).toBeGreaterThanOrEqual(findInputBox!.x + findInputBox!.width);

  const rows = changes.locator(".changes-screen-list").getByRole("button");
  await expect(rows).toHaveCount(6);
  await expect(rows).toHaveText([
    "/current-added",
    "/current-merged",
    "/current-profile",
    "/current-split-a",
    "/current-split-b",
    "/baseline-legacy",
  ]);
  await expect(changes.locator(".changes-screen-status, .changes-screen-copy, .diff-dot"))
    .toHaveCount(0);
  await expect(changes.locator(".changes-screen-row strong")).toHaveCount(0);
  await expect(changes.locator(".changes-screen-row.diff-added svg.lucide-plus")).toHaveCount(1);
  await expect(changes.locator(".changes-screen-row.diff-modified .status-glyph-dot"))
    .toHaveCount(4);
  await expect(changes.locator(".changes-screen-row.diff-modified svg")).toHaveCount(0);
  await expect(changes.locator(".changes-screen-row.diff-removed svg.lucide-minus")).toHaveCount(1);
  const firstGlyph = changes.locator(".status-glyph").first();
  await expect(firstGlyph).toHaveCSS("width", "16px");
  await expect(firstGlyph).toHaveCSS("height", "16px");
  await expect(firstGlyph).toHaveCSS("border-top-width", "0px");
  await expect(firstGlyph).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect((await rows.first().boundingBox())!.height).toBeLessThanOrEqual(36);

  await routeSearch.fill("PROFILE");
  await expect(rows).toHaveText(["/current-profile"]);
  await expect(page).not.toHaveURL(/screen=current-profile/);
  await heading.getByRole("button", { name: "Clear find query" }).click();
  await expect(rows).toHaveCount(6);

  await heading.getByRole("button", { name: "Close find" }).click();
  await expect(heading.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(routeSearch).toHaveCount(0);
  await findButton.click();
  await expect(routeSearch).toBeFocused();

  // Each status with changes is a chip. None is pressed while the list shows everything.
  const chips = page.getByRole("group", { name: "Filter changes" }).getByRole("button");
  await expect(chips).toHaveText(["Added 1", "Modified 4", "Removed 1"]);
  for (const chip of await chips.all()) await expect(chip).toHaveAttribute("aria-pressed", "false");

  // The first chip narrows the list to its status; the others step back.
  const modifiedChip = chips.filter({ hasText: "Modified" });
  await modifiedChip.click();
  await expect(modifiedChip).toHaveAttribute("aria-pressed", "true");
  await expect(chips.filter({ hasText: "Added" })).toHaveAttribute("aria-pressed", "false");
  await expect(chips.filter({ hasText: "Added" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page).toHaveURL(/focus=modified/);
  await expect(rows).toHaveCount(4);
  await expect(rows).toHaveText([
    "/current-merged",
    "/current-profile",
    "/current-split-a",
    "/current-split-b",
  ]);
  await expect(changes.locator(".changes-screen-row:not(.diff-modified)")).toHaveCount(0);
  await expect(page.locator(".screens-page .screens-cell:not(.dimmed)"))
    .toHaveCount(4);
  await expect(page.locator(".screens-page .screens-cell.dimmed"))
    .toHaveCount(3);

  await routeSearch.fill("merged");
  await expect(rows).toHaveText(["/current-merged"]);
  await expect(page).toHaveURL(/focus=modified/);
  await heading.getByRole("button", { name: "Clear find query" }).click();

  const changedRow = rows.filter({ hasText: "/current-profile" });
  const urlBeforeRowHover = page.url();
  const selectedCells = page.locator(".screens-page .screens-cell:has(.screen-screenshot-card.selected)");
  const selectedBeforeRowHover = await selectedCells
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-screen-id")));
  await changedRow.hover();
  await page.waitForTimeout(180);
  expect(page.url()).toBe(urlBeforeRowHover);
  expect(await selectedCells
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-screen-id"))))
    .toEqual(selectedBeforeRowHover);

  await expect(page.locator(".right-panel")).toHaveCount(0);
  await changedRow.click();
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      screen: url.searchParams.get("screen"),
      inspect: url.searchParams.get("inspect"),
      focus: url.searchParams.get("focus"),
      detail: url.searchParams.get("detail"),
    };
  }).toEqual({
    pathname: "/screens",
    screen: "current-profile",
    inspect: null,
    focus: "modified",
    detail: null,
  });
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(page.locator(".right-panel").getByRole("region", { name: "Changes in /current-profile" }))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Screens", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(
    '.screens-page .screens-cell[data-screen-id="current-profile"] .screen-screenshot-card.selected',
  )).toBeVisible();

  await expect(page.locator(".map-controls")).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Map content" })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Layout direction" })).toHaveCount(0);
  await expect(page.getByText("Highlights", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Explore view" })).toHaveCount(0);
  await expect(page.locator(".map-browse")).toHaveCount(0);
});

test("loads a same-origin private workspace with its session and preserves runtime URLs", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{
    name: "explore_review_session",
    value: "private-review",
    url: new URL(baseURL!).origin,
    httpOnly: true,
  }]);
  const fixture = await serveStaticWorkspace(page);
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    // Local AI discovery is independent of the static workspace's data transport.
    if (pathname.startsWith("/api/") && !["/api/ai/capabilities", "/api/ai/providers"].includes(pathname)) apiRequests.push(pathname);
  });

  await page.goto("/map?workspace=%2Fruntime%2Fworkspace.json&artifacts=%2Fruntime%2Fartifacts");
  // The comparison loaded: the bottom bar offers Compare.
  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true })).toBeVisible();
  const currentScreenshot = page.locator(
    'img[src*="/runtime/artifacts/build-2.0.0/artifacts/screenshots/"]',
  ).first();
  await expect(currentScreenshot).toBeVisible();
  await expect(currentScreenshot).toHaveAttribute("src", /\?sha256=[a-f0-9]{64}$/);
  expect(fixture.workspaceRequestCookies).toEqual([
    expect.stringContaining("explore_review_session=private-review"),
  ]);
  expect(apiRequests).toEqual([]);

  const viewerOrigin = new URL(page.url()).origin;
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      workspace: url.searchParams.get("workspace"),
      artifacts: url.searchParams.get("artifacts"),
    };
  }).toEqual({
    pathname: "/screens",
    workspace: `${viewerOrigin}/runtime/workspace.json`,
    artifacts: `${viewerOrigin}/runtime/artifacts/`,
  });
  expect(apiRequests).toEqual([]);

  await chooseCanvasView(page, "Map");
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      parameters: [...url.searchParams.keys()].sort(),
      workspace: url.searchParams.get("workspace"),
      artifacts: url.searchParams.get("artifacts"),
    };
  }).toEqual({
    pathname: "/map",
    parameters: ["artifacts", "workspace"],
    workspace: `${viewerOrigin}/runtime/workspace.json`,
    artifacts: `${viewerOrigin}/runtime/artifacts/`,
  });
  expect(apiRequests).toEqual([]);
});

for (const [label, body, message] of [
  ["an older public review", { contract: "expo.explore.public-review.v1", surfaces: [] },
    "This report uses an older format. Open the latest Explore review from your pull request."],
  ["an empty response", null,
    "This link did not return a valid Explore workspace. Open the latest Explore review from your pull request."],
  ["a malformed workspace", { catalog: { currentBuildId: "missing" }, builds: {} },
    "This link did not return a valid Explore workspace. Open the latest Explore review from your pull request."],
  ["an invalid JSON response", "<html>This is not a workspace</html>",
    "This link did not return a valid Explore workspace. Open the latest Explore review from your pull request."],
] as const) {
  test(`explains ${label} without exposing internal workspace errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/runtime/invalid-workspace.json", route => route.fulfill({
      status: 200, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    await page.goto("/map?workspace=%2Fruntime%2Finvalid-workspace.json");
    await expect(page.getByRole("heading", { name: "Couldn’t open this map", exact: true })).toBeVisible();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("currentBuildId");
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test("does not send viewer cookies to a cross-origin static workspace", async ({ page, baseURL }) => {
  await page.context().addCookies([{
    name: "explore_review_session",
    value: "private-review",
    url: new URL(baseURL!).origin,
    httpOnly: true,
  }]);
  const fixture = await serveStaticWorkspace(page);
  // The local authenticated host intentionally locks `connect-src` to itself. Strip that host-only
  // policy for this public-export scenario so Chromium can exercise the viewer's cross-origin
  // fetch credential mode rather than rejecting the request before it leaves the page.
  await page.route("**/map?**", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["content-security-policy"];
    await route.fulfill({ response, headers });
  });
  const publicOrigin = "http://127.0.0.1:4999";
  const workspaceUrl = `${publicOrigin}/runtime/workspace.json`;
  const artifactsUrl = `${publicOrigin}/runtime/artifacts`;

  await page.goto(
    `/map?workspace=${encodeURIComponent(workspaceUrl)}&artifacts=${encodeURIComponent(artifactsUrl)}`,
  );

  await expect(page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true })).toBeVisible();
  await expect(page.locator(
    'img[src*="127.0.0.1:4999/runtime/artifacts/build-2.0.0/artifacts/screenshots/"]',
  ).first()).toBeVisible();
  expect(fixture.workspaceRequestCookies).toEqual([""]);
});

test("the logo returns to the Map root", async ({ page }) => {
  await page.goto("/screens?screen=settings-root");
  await page.locator(".left-panel-collapsed-pill").getByRole("button", { name: "Map", exact: true }).click();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator(".map-canvas")).toBeVisible();
});

for (const canvas of ["map", "screens"] as const) {
  test(`keeps Changes screen navigation inside ${canvas}`, async ({ page }) => {
    await serveWorkspace(page);
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.goto(`/${canvas}`);

    // Picking a row closes the menu and inspects the screen in place.
    const changes = await openChangesMenu(page);
    await changes.getByRole("button", {
      name: "Open current profile, Modified, /current-profile",
      exact: true,
    }).click();

    await expect.poll(() => {
      const url = new URL(page.url());
      return {
        pathname: url.pathname,
        screen: url.searchParams.get("screen"),
        inspect: url.searchParams.get("inspect"),
      };
    }).toEqual({
      pathname: `/${canvas}`,
      screen: "current-profile",
      inspect: null,
    });
    await expect(page.getByRole("group", { name: "Canvas view" }).getByRole("button", {
      name: canvas === "map" ? "Map" : "Screens",
      exact: true,
    })).toHaveAttribute("aria-pressed", "true");

    const selected = canvas === "map"
      ? page.locator('.map-canvas .react-flow__node-screen[data-id="current-profile"].selected')
      : page.locator(
        '.screens-page .screens-cell[data-screen-id="current-profile"] .screen-screenshot-card.selected',
      );
    await expect(selected).toBeVisible();
    await expect(selected.locator(".screen-screenshot-target"))
      .toHaveAttribute("aria-pressed", "true");
    // The Map centres its camera on the screen; the Screens page scrolls its card into view.
    if (canvas === "map") await expectSelectedScreenCentered(page);
    else await expect(selected).toBeInViewport();
    await expect(page.locator(".right-panel")).toBeVisible();
    await expect(changes).toHaveCount(0);
    await expect(page.locator(".right-panel").getByRole("region", { name: "Changes in /current-profile" }))
      .toBeVisible();
    await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text"))
      .toHaveText("/current-profile");
  });
}

test("← and → step through the Screens cards in page order, with focus, and leave the tree's arrows alone", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");
  const grid = page.getByRole("main", { name: "Screens" });
  await grid.getByRole("button", { name: /^All/ }).click();
  const cells = grid.locator(".screens-grid .screens-cell");
  const ids = await cells.evaluateAll(elements => elements.map(element => element.getAttribute("data-screen-id")!));
  expect(ids.length).toBeGreaterThan(2);
  const card = (id: string) => grid.locator(`.screens-cell[data-screen-id="${id}"] .screen-screenshot-card`);
  const target = (id: string) => grid.locator(`.screens-cell[data-screen-id="${id}"] .screen-screenshot-target`);

  // With nothing selected, → starts at the first card.
  await expect(grid.locator(".screen-screenshot-card.selected")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(card(ids[0]!)).toHaveClass(/selected/);
  await expect(target(ids[0]!)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card(ids[1]!)).toHaveClass(/selected/);
  await expect(target(ids[1]!)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card(ids[2]!)).toHaveClass(/selected/);
  await page.keyboard.press("ArrowLeft");
  await expect(card(ids[1]!)).toHaveClass(/selected/);
  await expect(card(ids[2]!)).not.toHaveClass(/selected/);

  // ↓ and ↑ move a row, to the card in the same column.
  const tops = await cells.evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().top)));
  const columns = tops.filter(top => top === tops[0]).length;
  if (ids.length > 1 + columns) {
    await page.keyboard.press("ArrowDown");
    await expect(card(ids[1 + columns]!)).toHaveClass(/selected/);
    await expect(target(ids[1 + columns]!)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(card(ids[1]!)).toHaveClass(/selected/);
  }

  // Held, → keeps stepping, as in Compare, and stops on release.
  const selectedAt = async () => ids.indexOf((await grid.locator(".screens-cell:has(.screen-screenshot-card.selected)").getAttribute("data-screen-id"))!);
  const from = await selectedAt();
  await page.keyboard.down("ArrowRight");
  await expect.poll(selectedAt, { timeout: 4000 }).toBeGreaterThanOrEqual(Math.min(ids.length - 1, from + 3));
  await page.keyboard.up("ArrowRight");
  const released = await selectedAt();
  await page.waitForTimeout(500);
  expect(await selectedAt()).toBe(released);

  // Return opens the pick in the Inspector, from the card or from anywhere on the page.
  const inspector = page.getByRole("complementary", { name: "Inspector panel" });
  await expect(inspector).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(inspector).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Enter");
  await expect(inspector).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();

  // In the tree, ← and → fold and unfold rows; they do not step the cards.
  const picked = await selectedAt();
  const row = grid.locator(".screens-tree-row").first();
  await row.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(card(ids[picked]!)).toHaveClass(/selected/);
});

test("→ steps the Screens cards right after Screens is opened from the toolbar, and from a pick that Changed hides", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/map");
  await page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Screens", exact: true }).click();
  const grid = page.getByRole("main", { name: "Screens" });
  const cells = grid.locator(".screens-grid .screens-cell");
  await expect(cells.first()).toBeVisible();
  // Focus is still on the toolbar's Screens button.
  await page.keyboard.press("ArrowRight");
  await expect(cells.first().locator(".screen-screenshot-card")).toHaveClass(/selected/);

  // Pick a screen that Changed hides, then show Changed: → goes to the next changed card after it in the tree.
  await grid.getByRole("button", { name: /^All/ }).click();
  const all = await cells.evaluateAll(elements => elements.map(element => element.getAttribute("data-screen-id")!));
  await grid.getByRole("button", { name: /^Changed/ }).click();
  const changed = await cells.evaluateAll(elements => elements.map(element => element.getAttribute("data-screen-id")!));
  const hidden = all.find((id, position) => !changed.includes(id) && all.slice(position + 1).some(next => changed.includes(next)));
  test.skip(!hidden, "the fixture has no unchanged screen before a changed one");
  await grid.getByRole("button", { name: /^All/ }).click();
  await grid.locator(`.screens-cell[data-screen-id="${hidden}"] .screen-screenshot-target`).click();
  await grid.getByRole("button", { name: /^Changed/ }).click();
  const expected = all.slice(all.indexOf(hidden!) + 1).find(id => changed.includes(id))!;
  await page.keyboard.press("ArrowRight");
  await expect(grid.locator(`.screens-cell[data-screen-id="${expected}"] .screen-screenshot-card`)).toHaveClass(/selected/);
});

test("reuses the Map screenshot card in Screens, with the route under the screenshot at the card's left edge", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");

  for (const view of ["Screens"] as const) {
    await chooseCanvasView(page, view);
    const card = page.locator(".screens-page .screens-cell .screen-screenshot-card").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".screen-node-title")).toHaveText(/^\//);
    await expect(card.locator(".screen-node-title")).toHaveCSS("text-align", "left");
    await expect(card.locator(".screen-node-image")).toBeVisible();
    const layout = await card.evaluate((element) => {
      const heading = element.querySelector<HTMLElement>(".screen-node-heading")!;
      const title = element.querySelector<HTMLElement>(".screen-node-title")!;
      const image = element.querySelector<HTMLElement>(".screen-node-image")!;
      const headingBounds = heading.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      return {
        flexDirection: getComputedStyle(element).flexDirection,
        headingBeforeImage: Boolean(
          heading.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
        headingTop: heading.getBoundingClientRect().top,
        imageTop: image.getBoundingClientRect().top,
        titleLeftDelta: Math.abs(titleBounds.left - headingBounds.left - parseFloat(getComputedStyle(heading).paddingLeft)),
      };
    });
    expect(layout.flexDirection).toBe("column");
    // The card is the Map's, so the heading still comes first in the markup; Screens shows it as the card's footer.
    expect(layout.headingBeforeImage).toBe(true);
    expect(layout.headingTop).toBeGreaterThan(layout.imageTop);
    expect(layout.titleLeftDelta).toBeLessThan(1);

  }
});

test("opens the Inspector when a canvas screenshot is selected", async ({ page }) => {
  await page.goto("/map");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(page).toHaveTitle(/^Viewer fixture · iOS · Explore$/);
  // A report without an app icon keeps the Expo mark the page shipped with.
  await expect(page.locator("link[rel='icon']")).toHaveAttribute("href", /\/favicon\.svg$/);
  await page.locator(".map-canvas .react-flow__node-screen .screen-screenshot-target").first().click();
  await expect(page.locator(".right-panel")).toBeVisible();
  // The tab leads with the selected screen.
  await expect(page).toHaveTitle(/^.+ · Viewer fixture · iOS · Explore$/);
  await expect(page.locator(
    ".map-canvas .react-flow__node-screen.selected .canvas-active-frame.is-selected",
  )).toHaveCount(1);
  await expectCanvasSelectedFrame(page.locator(
    ".map-canvas .react-flow__node-screen.selected .canvas-active-frame.is-selected",
  ));

  await chooseCanvasView(page, "Screens");
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(page.locator(".screens-page .screen-screenshot-card.selected")).toHaveCount(0);
  await page.locator(".screens-page .screen-screenshot-target").first().click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(page.locator(
    ".screens-page .screens-cell .canvas-active-frame.is-selected",
  )).toHaveCount(1);

  await chooseCanvasView(page, "Map");
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(page.locator(".map-canvas .react-flow__node.selected")).toHaveCount(0);
  await page.locator(".map-canvas .react-flow__node-screen .screen-screenshot-target").first().click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(page.locator(
    ".map-canvas .react-flow__node-screen.selected .canvas-active-frame.is-selected",
  )).toHaveCount(1);
});

test("Esc closes the Inspector first, then deselects; arrows and hjkl walk the map from the selection", async ({ page }) => {
  await page.goto("/map");
  const selected = page.locator(".map-canvas .react-flow__node-screen.selected");
  await page.locator(".map-canvas .react-flow__node-screen .screen-screenshot-target").first().click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(selected).toHaveCount(1);
  const first = await selected.getAttribute("data-id");

  await page.keyboard.press("Escape");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(selected).toHaveAttribute("data-id", first!);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);
  await expect(page).toHaveURL(/\/map$/);

  // Nothing selected: ↓ enters the map at its top, as → enters Screens at its first card; held, it
  // keeps walking down from there and stops where it is on release.
  await page.keyboard.down("ArrowDown");
  await expect(selected).toHaveCount(1);
  const entered = await selected.getAttribute("data-id");
  await expect.poll(() => selected.getAttribute("data-id"), { timeout: 4000 }).not.toBe(entered);
  await page.keyboard.up("ArrowDown");
  const walkedTo = await selected.getAttribute("data-id");
  await page.waitForTimeout(500);
  await expect(selected).toHaveAttribute("data-id", walkedTo!);
  await page.keyboard.press("Escape");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);

  await page.locator(".map-canvas .react-flow__node-screen .screen-screenshot-target").first().click();
  await expect(selected).toHaveAttribute("data-id", first!);
  await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveCount(1);
  const child = await selected.getAttribute("data-id");
  expect(child).not.toBe(first);
  await expect(page).toHaveURL(new RegExp(`screen=${encodeURIComponent(child!)}`));
  await page.keyboard.press("k");
  await expect(selected).toHaveAttribute("data-id", first!);
  await page.keyboard.press("j");
  await expect(selected).toHaveAttribute("data-id", child!);
});

test("a held key stops when Esc, another key or a dialog takes the keyboard; a menu keeps its own arrows", async ({ page }) => {
  await page.goto("/map");
  const selected = page.locator(".map-canvas .react-flow__node-screen.selected");
  const inspector = page.locator(".right-panel");
  const search = page.getByRole("dialog", { name: "Search Explore" });
  const viewport = page.locator(".map-canvas .react-flow__viewport");
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // Nothing selected and a menu open: ← and → on its item are the menu's, not the map's.
  await expect(selected).toHaveCount(0);
  await page.locator(".zoom-button").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(selected).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Esc mid-walk closes the Inspector, and the walk does not reopen it on its next step.
  await page.locator(".map-canvas .react-flow__node-screen .screen-screenshot-target").first().click();
  await expect(inspector).toBeVisible();
  await page.keyboard.down("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(inspector).toHaveCount(0);
  await page.keyboard.up("ArrowDown");

  // ⌘K mid-walk opens Search, and the selection behind it stays where it was.
  await page.keyboard.down("ArrowDown");
  await page.keyboard.press(`${mod}+k`);
  await expect(search).toBeVisible();
  const behind = await selected.getAttribute("data-id");
  await page.waitForTimeout(800);
  await expect(selected).toHaveAttribute("data-id", behind!);
  await page.keyboard.up("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);

  // A held + glides past the tap's one step and stops where it is on release.
  const zoomNow = async () => (await readCanvasCamera(viewport)).zoom;
  const before = await zoomNow();
  await page.keyboard.down("Equal");
  await expect.poll(zoomNow, { timeout: 4000 }).toBeGreaterThan(before * 1.2 * 1.2);
  await page.keyboard.up("Equal");
  const released = await zoomNow();
  await page.waitForTimeout(300);
  expect(await zoomNow()).toBeCloseTo(released, 3);

  // Held −, then a click opens Search: the glide stops rather than zoom behind the dialog.
  await page.keyboard.down("Minus");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(search).toBeVisible();
  await page.waitForTimeout(400);
  const atOpen = await zoomNow();
  await page.waitForTimeout(800);
  expect(await zoomNow()).toBeCloseTo(atOpen, 3);
  await page.keyboard.up("Minus");
});

test("a drag that starts on a transition edge pans the map", async ({ page }) => {
  await page.goto("/map");
  const viewport = page.locator(".map-canvas .react-flow__viewport");
  await expect(page.locator(".map-canvas .react-flow__edge").first()).toBeAttached();
  // A point on an edge where the pointer-down lands on the edge itself, not the pane or a card.
  const point = await page.evaluate(() => {
    for (const path of document.querySelectorAll<SVGGeometryElement>(".map-canvas .react-flow__edge path")) {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM();
      if (!length || !matrix) continue;
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const at = path.getPointAtLength(length * t);
        const x = matrix.a * at.x + matrix.c * at.y + matrix.e;
        const y = matrix.b * at.x + matrix.d * at.y + matrix.f;
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest(".react-flow__edge")) return { x, y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  const before = await viewport.getAttribute("style");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.down();
  await page.mouse.move(point!.x + 90, point!.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);
});

test("collapses the Inspector when a screen is cleared but still allows an empty manual Inspector", async ({ page }) => {
  await page.goto("/screens");
  await page.locator(".screens-page .screen-screenshot-target").first().click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("screen")).toBe(true);

  // A click on the page around the cards clears the selection, as the canvas pane did.
  await page.locator(".screens-page").click({ position: { x: 4, y: 400 } });
  await expect.poll(() => new URL(page.url()).searchParams.has("screen")).toBe(false);
  await expect(page.locator(".right-panel")).toHaveCount(0);

  await page.getByRole("button", { name: "Expand inspector" }).click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("screen")).toBe(false);
});

test("primary project titles and screen paths remain readable", async ({ page }) => {
  const payload = await liveMapPayload(2, 100);
  payload.map.run.name = "Chime iOS — Mobbin April 2026 complete reference map";
  payload.map.screens[0]!.title = "Requesting a completed form — Direct deposit account setup";
  await serveMap(page, payload);
  await page.goto("/screens");

  const projectTitle = page.locator(".collapsed-app-identity > strong");
  await expect(projectTitle).toHaveText(payload.map.run.name);
  const projectTitleLayout = await projectTitle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  // A long name stays on one line and ends in an ellipsis; the title attribute keeps all of it.
  expect(projectTitleLayout.whiteSpace).toBe("nowrap");
  expect(projectTitleLayout.textOverflow).toBe("ellipsis");
  expect(projectTitleLayout.scrollWidth).toBeGreaterThan(projectTitleLayout.clientWidth);
  expect(projectTitleLayout.clientHeight).toBeLessThan(projectTitleLayout.lineHeight * 1.5);
  // The hover text keeps the full name (and the capture device after it).
  expect(await projectTitle.getAttribute("title")).toContain(payload.map.run.name);

  const tileTitle = page.locator(".screens-cell .screen-node-title")
    .filter({ hasText: "/requesting-a-completed-form" });
  await expect(tileTitle).toHaveText("/requesting-a-completed-form");
  const tileTitleLayout = await tileTitle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(tileTitleLayout.whiteSpace).toBe("nowrap");
  expect(tileTitleLayout.textOverflow).toBe("ellipsis");
  expect(tileTitleLayout.scrollWidth).toBeLessThanOrEqual(tileTitleLayout.clientWidth + 1);
  expect(tileTitleLayout.clientHeight).toBeLessThanOrEqual(tileTitleLayout.lineHeight * 1.5);

  await page.locator(".screens-cell")
    .filter({ has: page.locator(".screen-node-title", { hasText: "/requesting-a-completed-form" }) })
    .locator(".screen-screenshot-target").click();
  const screenTitle = page.locator(".inspector-mode-copy .screen-path-text");
  await expect(screenTitle).toHaveText("/requesting-a-completed-form");
  const screenTitleLayout = await screenTitle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(screenTitleLayout.whiteSpace).toBe("nowrap");
  expect(screenTitleLayout.textOverflow).toBe("ellipsis");
  expect(screenTitleLayout.clientHeight).toBeLessThanOrEqual(screenTitleLayout.lineHeight * 1.5);
});

test("a long route ends in an ellipsis instead of shrinking its screenshot", async ({ page }) => {
  const payload = await liveMapPayload(2, 100);
  // An opaque deep-link token is one long route that a tile cannot fit on one line.
  const longRoute = "/p/AQAC-AYHb25lRHJvcxAxMby1GaSBCb3VuY2UEAMAAAAAADUAaQAZBgRLaWNrEAIEAAAAADcAXA";
  payload.map.screens[1]!.route = longRoute;
  await serveMap(page, payload);
  await page.goto("/screens");

  const tile = (path: string) => page.locator(".screens-page .screens-cell").filter({
    has: page.locator(".screen-node-title", { hasText: path }),
  });
  const longTitle = tile(longRoute).locator(".screen-node-title");
  await expect(longTitle).toHaveText(longRoute);
  const layout = await longTitle.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  });
  expect(layout.whiteSpace).toBe("nowrap");
  expect(layout.textOverflow).toBe("ellipsis");
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
  expect(layout.clientHeight).toBeLessThanOrEqual(layout.lineHeight * 1.5);
  // The hover text keeps the whole route.
  expect(await longTitle.getAttribute("title")).toContain(longRoute);

  // The heading stays one line, so the screenshot keeps the size of its short-route neighbour.
  const imageHeight = async (path: string) =>
    (await tile(path).locator(".screen-node-image").boundingBox())!.height;
  expect(Math.abs(await imageHeight(longRoute) - await imageHeight("/live-screen-1"))).toBeLessThan(1);
});

test("text-heavy surfaces expose their full copy instead of applying ellipsis", async ({ page }) => {
  await serveWorkspace(page);
  const auditedSelector = [
    ".canvas-group-copy strong",
    ".toggle-label",
    ".focus-label",
    ".what-changed-item",
    ".what-changed-empty",
    ".evidence-entries dd",
    ".transition-copy strong",
    ".menu-row-label",
  ].join(",");

  const audit = async () => page.locator(auditedSelector).evaluateAll((elements) => (
    elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return [];
      const horizontallyClipped = element.scrollWidth > element.clientWidth + 1;
      const hidesText = style.textOverflow === "ellipsis"
        || (style.overflow === "hidden" && horizontallyClipped);
      return hidesText ? [{ className: element.className, text: element.textContent }] : [];
    })
  ));

  await page.goto("/map");
  await page.locator(".react-flow__node-screen .screen-screenshot-target").first().click();
  expect(await audit()).toEqual([]);

  for (const path of ["/screens"]) {
    await page.goto(path);
    expect(await audit(), path).toEqual([]);
  }

  await page.goto("/map");
  await page.locator(".react-flow__node-screen .screen-screenshot-target").first().click();
  // A changed screen opens the sidebar review in the Inspector, on the Map as on Screens.
  await (await openChangesMenu(page)).locator(".changes-screen-row.diff-modified").first().click();
  await expect(page.locator(".right-panel .sidebar-review")).toBeVisible();
  expect(await audit(), "sidebar review").toEqual([]);
  await page.goto("/screens");
  await (await openChangesMenu(page)).locator(".changes-screen-row.diff-modified").first().click();
  // The review's What changed is off when CI has no finding for the screen; open it when on.
  const whatChanged = page.locator(".right-panel").getByRole("button", { name: /^What changed/ });
  await expect(whatChanged).toBeVisible();
  if (await whatChanged.isEnabled()) await expect((await whatChangedItems(page)).first()).toBeVisible();
  expect(await audit()).toEqual([]);

});

test("by default a click on a visible screen selects it without moving the camera", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("expo-explore:follow-selection"));
  await page.goto("/map");
  const viewport = page.locator(".map-canvas .react-flow__viewport");
  const screens = page.locator(".map-canvas .react-flow__node-screen");
  await expect(screens.first()).toBeVisible();
  await expect(page.locator(".map-canvas")).not.toHaveClass(/canvas-focus-animating/);
  await page.waitForTimeout(900);
  const before = await readCanvasCamera(viewport);
  const entryUrl = page.url();
  await page.locator(".map-canvas .react-flow__node-screen:not(.selected)").first().click();
  await expect.poll(() => page.url()).not.toBe(entryUrl);
  await page.waitForTimeout(600);
  expect(await readCanvasCamera(viewport)).toEqual(before);
  // The setting lives in the Zoom menu; on, the camera follows the next selection.
  await page.getByRole("button", { name: /^Zoom — / }).click();
  await page.getByRole("menuitemcheckbox", { name: "Follow selection" }).click();
  await page.keyboard.press("Escape");
  await screens.nth(1).click();
  await expect.poll(async () => JSON.stringify(await readCanvasCamera(viewport))).not.toBe(JSON.stringify(before));
});

test("keeps persistent canvas chrome out of the sliding canvas snapshot", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/map");
  await expect(page.locator(".canvas-minimap-shell")).toBeVisible();
  await expect(page.locator(".right-float")).toBeVisible();

  const transitionNames = await page.locator([
    ".canvas-minimap-shell",
    ".app-content > .canvas-camera-controls",
    ".canvas-toolbar",
    ".right-float",
  ].join(",")).evaluateAll((elements) => elements.map((element) => ({
    className: element.className,
    viewTransitionName: getComputedStyle(element).viewTransitionName,
  })));
  expect(transitionNames).toEqual(expect.arrayContaining([
    expect.objectContaining({ viewTransitionName: "canvas-minimap" }),
    expect.objectContaining({ viewTransitionName: "canvas-camera-controls" }),
    expect.objectContaining({ viewTransitionName: "canvas-toolbar" }),
    expect.objectContaining({ viewTransitionName: "right-floating-controls" }),
  ]));

  const animations = await captureCanvasViewAnimations(page, "Screens");
  const minimapAnimations = animations.filter((animation) => (
    animation.pseudoElement?.includes("(canvas-minimap)")
  ));
  // Screens is a page without a minimap, so the Map's fades out and nothing fades in.
  expect(minimapAnimations.map((animation) => animation.animationName).sort()).toEqual([
    "canvas-chrome-crossfade-out",
  ]);
  for (const animation of minimapAnimations) {
    expect(animation.duration).toBe(200);
    expect(animation.delay).toBe(0);
    expect(animation.easing).toBe("linear");
    expect(animation.keyframes.every((frame) => frame.transform === undefined)).toBe(true);
  }

  const movingPersistentChrome = animations.filter((animation) => (
    animation.pseudoElement?.includes("(canvas-camera-controls)")
    || animation.pseudoElement?.includes("(canvas-toolbar)")
    || animation.pseudoElement?.includes("(right-floating-controls)")
  ));
  expect(movingPersistentChrome).toEqual([]);
});

test("centres selected screens after panel changes and makes the primary Fit selection-aware", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await serveSyntheticWorkspace(page);

  // Screens is a page without a camera; the Map is the canvas whose Fit follows the selection.
  for (const canvas of ["map"] as const) {
    await page.goto(`/${canvas}`);
    await page.locator(`.${canvas}-canvas .screen-screenshot-target`).first().click();
    await expect(page.locator(".right-panel")).toBeVisible();
    await expectSelectedScreenCentered(page);
    // Inspector-only navigation clears the transient focus command while retaining selection.
    // Panel Fits must still resolve the route-selected node rather than falling back to overview.
    await page.getByRole("radiogroup", { name: "Transition direction", exact: true })
      .getByRole("radio", { name: /^Out\b/ }).click();

    await page.getByRole("button", { name: "Close inspector" }).click();
    await expect(page.locator(".right-panel")).toHaveCount(0);
    await expectSelectedScreenCentered(page);
    await expectPanelFitMatchesPrimaryFit(page, canvas);

    await page.getByRole("button", { name: "Expand inspector" }).click();
    await expect(page.locator(".right-panel")).toBeVisible();
    await expectSelectedScreenCentered(page);
    await expectPanelFitMatchesPrimaryFit(page, canvas);
    await page.getByRole("button", { name: "Close inspector" }).click();
    await expect(page.locator(".right-panel")).toHaveCount(0);
    await expectPanelFitMatchesPrimaryFit(page, canvas);

    const pane = page.locator(`.${canvas}-canvas .react-flow__pane`);
    const paneBox = await pane.boundingBox();
    expect(paneBox).not.toBeNull();
    const point = {
      x: paneBox!.x + paneBox!.width * 0.6,
      y: paneBox!.y + paneBox!.height * 0.55,
    };
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(point.x + 130, point.y + 54, { steps: 4 });
    await page.mouse.up({ button: "middle" });
    await expect.poll(async () => {
      const delta = await selectedScreenCenterDelta(page);
      return Math.max(Math.abs(delta.x), Math.abs(delta.y));
    }).toBeGreaterThan(20);

    await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
    await expectSelectedScreenCentered(page);
  }
});

test("has no Flows canvas: the view control is Map and Screens, and retired Flow links land on Map", async ({ page }) => {
  await page.goto("/map");
  const views = page.getByRole("group", { name: "Canvas view" }).getByRole("button");
  await expect(views).toHaveText(["Map", "Screens", "Compare"]);
  await expect(page.getByRole("button", { name: "Flows", exact: true })).toHaveCount(0);
  await page.keyboard.press("f");
  await expect(page).toHaveURL(/\/map$/);
  await page.goto("/flows?flow=derived-apps");
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator(".map-canvas")).toBeVisible();
  await page.goto("/#workspace/flows");
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator(".flows-canvas, .canvas-group-select, .phone-flow-picker")).toHaveCount(0);
});

test("canonicalizes retired Graph deep links to Map without exposing a destination", async ({ page }) => {
  await page.goto("/graph?screen=settings-root&detail=branch&area=retired&branch=retired");

  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      screen: url.searchParams.get("screen"),
      detail: url.searchParams.get("detail"),
      area: url.searchParams.get("area"),
      branch: url.searchParams.get("branch"),
    };
  }).toEqual({
    pathname: "/map",
    screen: "settings-root",
    detail: null,
    area: null,
    branch: null,
  });
  await expect(page.getByRole("group", { name: "Canvas view" }).getByRole("button", { name: "Map", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Graph", exact: true })).toHaveCount(0);
  await expect(page.locator(".screen-node.selected")).toBeVisible();
  await expect(page.locator(".right-panel .inspector-mode-copy")).toBeVisible();
});

test("fits the visible Map screenshot frame to the capture's intrinsic ratio", async ({ page }) => {
  await serveSyntheticWorkspace(page);
  await page.goto("/map?screen=area-0-screen-1");

  const selected = page.locator(".map-canvas .react-flow__node-screen.selected");
  const image = selected.locator(".screen-node-image img");
  await expect(image).toBeVisible();
  await expectMapScreenSelectionDimming(page);
  const pathStyle = await selected.locator(".screen-node-title").evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const headingBounds = element.parentElement?.getBoundingClientRect();
    return {
      textAlign: style.textAlign,
      fontWeight: Number.parseInt(style.fontWeight, 10),
      center: bounds.left + bounds.width / 2,
      headingCenter: headingBounds ? headingBounds.left + headingBounds.width / 2 : 0,
    };
  });
  expect(pathStyle.textAlign).toBe("center");
  expect(pathStyle.fontWeight).toBeGreaterThanOrEqual(700);
  expect(pathStyle.center).toBeCloseTo(pathStyle.headingCenter, 0);
  await expect.poll(() => image.evaluate((element) => (
    (element as HTMLImageElement).naturalWidth > 0
  ))).toBe(true);

  const metrics = await selected.evaluate((node) => {
    const slot = node.querySelector<HTMLElement>(".screen-node-image");
    const screenshot = slot?.querySelector<HTMLImageElement>("img");
    if (!slot || !screenshot) throw new Error("Selected Map screen has no screenshot frame");
    const slotStyle = getComputedStyle(slot);
    const imageStyle = getComputedStyle(screenshot);
    const slotRect = slot.getBoundingClientRect();
    const imageRect = screenshot.getBoundingClientRect();
    return {
      slotWidth: slotRect.width,
      imageWidth: imageRect.width,
      contentWidth: Number.parseFloat(imageStyle.width) - Number.parseFloat(imageStyle.borderLeftWidth) - Number.parseFloat(imageStyle.borderRightWidth)
        - Number.parseFloat(imageStyle.paddingLeft) - Number.parseFloat(imageStyle.paddingRight),
      contentHeight: Number.parseFloat(imageStyle.height) - Number.parseFloat(imageStyle.borderTopWidth) - Number.parseFloat(imageStyle.borderBottomWidth)
        - Number.parseFloat(imageStyle.paddingTop) - Number.parseFloat(imageStyle.paddingBottom),
      naturalRatio: screenshot.naturalWidth / screenshot.naturalHeight,
      objectFit: imageStyle.objectFit,
      slotBorder: Number.parseFloat(slotStyle.borderLeftWidth),
      imageBorder: Number.parseFloat(imageStyle.borderLeftWidth),
      slotBackground: slotStyle.backgroundColor,
    };
  });

  // The stable graph slot can remain wider than a portrait capture, but no coloured frame may
  // occupy that remainder. Compare the image's content box: adding the status border to both
  // dimensions changes the outer ratio, even when the uncropped bitmap fits exactly.
  expect(metrics.imageWidth).toBeLessThan(metrics.slotWidth);
  expect(metrics.contentWidth / metrics.contentHeight).toBeCloseTo(metrics.naturalRatio, 3);
  expect(metrics.objectFit).toBe("contain");
  expect(metrics.slotBorder).toBe(0);
  expect(metrics.imageBorder).toBeGreaterThan(0);
  expect(metrics.slotBackground).toBe("rgba(0, 0, 0, 0)");
});

test("fits a landscape Map capture at render time without app-specific dimensions", async ({ page }) => {
  const source = viewerMapFixture() as ExploreMap;
  await serveMap(page, {
    map: source,
    coverage: coverageForMap(source),
  } as Awaited<ReturnType<typeof liveMapPayload>>);
  await page.route("**/api/artifacts/**", async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#5b8def"/></svg>',
    });
  });
  await page.goto("/map");

  const image = page.locator(".map-canvas .screen-node-image img").first();
  await expect(image).toBeVisible();
  const metrics = await image.evaluate((element) => {
    const screenshot = element as HTMLImageElement;
    const slot = screenshot.closest<HTMLElement>(".screen-node-image")!;
    const imageStyle = getComputedStyle(screenshot);
    return {
      contentWidth: Number.parseFloat(imageStyle.width) - Number.parseFloat(imageStyle.borderLeftWidth) - Number.parseFloat(imageStyle.borderRightWidth)
        - Number.parseFloat(imageStyle.paddingLeft) - Number.parseFloat(imageStyle.paddingRight),
      contentHeight: Number.parseFloat(imageStyle.height) - Number.parseFloat(imageStyle.borderTopWidth) - Number.parseFloat(imageStyle.borderBottomWidth)
        - Number.parseFloat(imageStyle.paddingTop) - Number.parseFloat(imageStyle.paddingBottom),
      naturalRatio: screenshot.naturalWidth / screenshot.naturalHeight,
      slotBackground: getComputedStyle(slot).backgroundColor,
      imageBorder: Number.parseFloat(imageStyle.borderLeftWidth),
    };
  });

  expect(metrics.naturalRatio).toBe(2);
  expect(metrics.contentWidth / metrics.contentHeight).toBeCloseTo(metrics.naturalRatio, 3);
  expect(metrics.slotBackground).toBe("rgba(0, 0, 0, 0)");
  expect(metrics.imageBorder).toBeGreaterThan(0);
});

test("keeps current Map and Screens projections overlap-free without deleting screen nodes", async ({ page }) => {
  test.setTimeout(60_000);
  const currentMap = viewerMapFixture() as ExploreMap;
  await serveMap(page, {
    map: currentMap,
    coverage: coverageForMap(currentMap),
  } as Awaited<ReturnType<typeof liveMapPayload>>);

  const overlapCount = (selector: string) => page.locator(selector).evaluateAll((nodes) => {
    const boxes = nodes.map((node) => node.getBoundingClientRect()).filter((box) => (
      box.width > 0 && box.height > 0
    ));
    let overlaps = 0;
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left]!;
        const b = boxes[right]!;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
          && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps += 1;
      }
    }
    return overlaps;
  });

  await page.goto("/map");
  await expect(page.locator(".react-flow__node-screen")).toHaveCount(SCREEN_COUNT);
  await expect.poll(() => overlapCount(".react-flow__node-screen:visible")).toBe(0);

  // Screens is a page: every screen keeps a card, and no two cards overlap with or without the Inspector.
  await chooseCanvasView(page, "Screens");
  await expect(page).toHaveURL(/\/screens/);
  await expect(page.locator(".screens-page .screens-cell")).toHaveCount(SCREEN_COUNT);
  await expect.poll(() => overlapCount(".screens-page .screens-cell")).toBe(0);
  await page.getByRole("button", { name: "Expand inspector" }).click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect.poll(() => overlapCount(".screens-page .screens-cell")).toBe(0);
});

test("keeps removed Comments and Insights surfaces out of the default viewer", async ({ page }) => {
  await page.goto("/map");
  await expect(page.locator(".left-panel-collapsed-pill")).toBeVisible();
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Comments", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "UX Report" })).toHaveCount(0);
  await expect(page.locator("[data-comment-layer], [data-comment-marker], .comment-row"))
    .toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => (
    key.startsWith("expo-explore:collaboration:") || key.startsWith("expo-explore:comments:")
  )))).toEqual([]);

  await page.goto("/map?panel=insights&inspect=comments&comment=legacy-thread&scope=screen");
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      panel: url.searchParams.get("panel"),
      inspect: url.searchParams.get("inspect"),
      comment: url.searchParams.get("comment"),
      scope: url.searchParams.get("scope"),
    };
  }).toEqual({ panel: null, inspect: null, comment: null, scope: null });
  await expect(page).toHaveURL(/\/map$/);
});

test("canonicalizes the legacy Workspace route to Changes and reports the exact change total", async ({ page }) => {
  const fixture = await serveWorkspace(page);
  await page.goto("/map?panel=workspace");

  await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull();
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByText("Workspace", { exact: true })).toHaveCount(0);

  const expectedChanges = fixture.comparison.entries.reduce((total, entry) => {
    if (entry.status === "unchanged") return total;
    return total + (entry.currentScreenIds.length || entry.baselineScreenIds.length);
  }, 0);
  const menu = await openChangesMenu(page);
  await expect(menu.locator(".changes-panel-title .changes-panel-count")).toHaveText(String(expectedChanges));

  // Without a baseline there is nothing to count. Compare still opens, and the view says why it is empty.
  await page.goto("/map?baseline=none");
  await expect(page).toHaveURL(/baseline=none/);
  const compare = page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true });
  await expect(compare).not.toHaveAttribute("aria-disabled", "true");
  await compare.click();
  await expect(page).toHaveURL(/\/compare\?/);
  await expect(page.getByRole("heading", { name: "Nothing to compare" })).toBeVisible();
  await expect(page.getByText("This report has no baseline build to compare against.")).toBeVisible();
});

test("shows the minimap on the Map without a visibility preference", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "expo-explore:show-minimap:v1",
      JSON.stringify({ version: 1, value: false }),
    );
  });
  await page.goto("/map");

  const minimap = page.getByTestId("canvas-minimap");
  await expect(minimap).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Minimap" })).toHaveCount(0);
  // Screens is a page that scrolls, so it has no minimap; the Map brings it back.
  await chooseCanvasView(page, "Screens");
  await expect(minimap).toHaveCount(0);
  await chooseCanvasView(page, "Map");
  await expect(minimap).toBeVisible();
  await page.reload();
  await expect(minimap).toBeVisible();
});

test("keeps minimap and canvas chrome inside the responsive visible frame", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await page.goto("/map");
  await page.getByRole("button", { name: "Expand inspector" }).click();

  const minimap = page.getByTestId("canvas-minimap");
  const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
  const camera = page.getByRole("group", { name: "Canvas camera controls" });
  const inspector = page.locator(".right-panel");
  await expect(minimap).toBeVisible();
  await expect(toolbar).toBeVisible();
  await expect(camera).toBeVisible();

  const [rootBox, minimapBox, toolbarBox, cameraBox, inspectorBox] = await Promise.all([
    page.locator(".app-content").boundingBox(),
    minimap.boundingBox(),
    toolbar.boundingBox(),
    camera.boundingBox(),
    inspector.boundingBox(),
  ]);
  for (const box of [rootBox, minimapBox, toolbarBox, cameraBox, inspectorBox]) {
    expect(box).not.toBeNull();
  }
  for (const box of [minimapBox!, cameraBox!]) {
    expect(box.x + box.width).toBeLessThanOrEqual(inspectorBox!.x + 1);
  }
  expect(Math.abs(
    toolbarBox!.x + toolbarBox!.width / 2 - page.viewportSize()!.width / 2,
  )).toBeLessThanOrEqual(1);
  expect(minimapBox!.y + minimapBox!.height + 11).toBeLessThanOrEqual(toolbarBox!.y);
  expect(minimapBox!.width).toBeCloseTo(168, 0);
  expect(minimapBox!.height).toBeCloseTo(112, 0);

  const viewport = page.locator(".react-flow__viewport");
  // The Inspector expansion above starts a refit flight; sample the camera once it has settled.
  await expect.poll(async () => {
    const before = await viewport.getAttribute("style");
    await page.waitForTimeout(280);
    return (await viewport.getAttribute("style")) === before;
  }).toBe(true);
  const cameraBeforeTheme = await viewport.getAttribute("style");
  const maskBeforePanel = await minimap.locator(".canvas-minimap-visible-mask path").getAttribute("d");
  const lightBackground = await minimap.evaluate((element) => getComputedStyle(element).backgroundColor);
  await chooseTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(viewport).toHaveAttribute("style", cameraBeforeTheme!);
  await expect.poll(() => minimap.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(lightBackground);

  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => minimap.locator(".canvas-minimap-visible-mask path").getAttribute("d"))
    .not.toBe(maskBeforePanel);

  await page.setViewportSize({ width: 860, height: 820 });
  await expect(minimap).toBeVisible();
  const compactBox = await minimap.boundingBox();
  expect(compactBox).not.toBeNull();
  expect(compactBox!.width).toBeCloseTo(128, 0);
  expect(compactBox!.height).toBeCloseTo(84, 0);

  // With no side panel, the narrowest canvas layout (820px; below it the phone layout takes
  // over) has room for all of the chrome, and the minimap still clears the toolbar.
  await page.setViewportSize({ width: 820, height: 820 });
  await expect(minimap).toBeVisible();
  await expect(toolbar).toBeVisible();
  await expect(camera).toBeVisible();
  const [narrowMinimapBox, narrowToolbarBox] = await Promise.all([minimap.boundingBox(), toolbar.boundingBox()]);
  // At this width the minimap sits beside the toolbar; it may also sit above it. Either way the
  // two do not overlap.
  const apart = narrowMinimapBox!.y + narrowMinimapBox!.height <= narrowToolbarBox!.y
    || narrowMinimapBox!.x >= narrowToolbarBox!.x + narrowToolbarBox!.width;
  expect(apart).toBe(true);

  // A phone-width window keeps the map but drops the canvas chrome.
  await page.setViewportSize({ width: 375, height: 820 });
  await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
  await expect(minimap).toBeHidden();
  await expect(toolbar).toBeHidden();
  await expect(camera).toBeHidden();
});

test("animates panel Fits once in both directions", async ({ page }) => {
  test.setTimeout(30_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/map");

  const viewport = page.locator(".map-canvas .react-flow__viewport");
  await expect(page.locator(".react-flow__node-screen").first()).toBeVisible();
  await page.waitForTimeout(450);

  const exerciseToggle = async (
    buttonName: string,
    expectLayout: () => Promise<unknown>,
  ) => {
    const startingTransform = await viewport.evaluate(
      (element) => (element as HTMLElement).style.transform,
    );
    await page.evaluate(() => {
      const viewportElement = document.querySelector<HTMLElement>(
        ".map-canvas .react-flow__viewport",
      );
      const canvasElement = document.querySelector<HTMLElement>(".map-canvas");
      const nodeElement = document.querySelector<HTMLElement>(
        ".map-canvas .react-flow__node",
      );
      if (!viewportElement || !canvasElement || !nodeElement) {
        throw new Error("Map camera or continuity anchor is unavailable");
      }
      const nodeId = nodeElement.dataset.id;
      const state = {
        samples: [{ elapsed: 0, transform: viewportElement.style.transform }],
        objectSamples: [] as Array<{
          elapsed: number;
          rootLeft: number;
          nodeCenterX: number;
          connected: boolean;
          sameElement: boolean;
        }>,
      };
      const startedAt = performance.now();
      const sampleObject = () => {
        const rootRect = canvasElement.getBoundingClientRect();
        const nodeRect = nodeElement.getBoundingClientRect();
        const elapsed = performance.now() - startedAt;
        state.objectSamples.push({
          elapsed,
          rootLeft: rootRect.left,
          nodeCenterX: nodeRect.left + nodeRect.width / 2,
          connected: nodeElement.isConnected,
          sameElement: nodeId !== undefined
            && document.querySelector(
              `.map-canvas .react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
            ) === nodeElement,
        });
        if (elapsed < 500) requestAnimationFrame(sampleObject);
      };
      sampleObject();
      let previous = viewportElement.style.transform;
      const observer = new MutationObserver(() => {
        const transform = viewportElement.style.transform;
        if (!transform || transform === previous) return;
        previous = transform;
        state.samples.push({ elapsed: performance.now() - startedAt, transform });
      });
      observer.observe(viewportElement, { attributes: true, attributeFilter: ["style"] });
      (window as unknown as {
        __panelFitCamera: typeof state;
        __panelFitCameraObserver: MutationObserver;
      }).__panelFitCamera = state;
      (window as unknown as {
        __panelFitCameraObserver: MutationObserver;
      }).__panelFitCameraObserver = observer;
    });

    await page.getByRole("button", { name: buttonName, exact: true }).click();
    await expectLayout();
    await page.waitForTimeout(520);
    const samples = await page.evaluate(() => {
      const scope = window as unknown as {
        __panelFitCamera: {
          samples: Array<{ elapsed: number; transform: string }>;
          objectSamples: Array<{
            elapsed: number;
            rootLeft: number;
            nodeCenterX: number;
            connected: boolean;
            sameElement: boolean;
          }>;
        };
      };
      return {
        camera: scope.__panelFitCamera.samples.slice(),
        objects: scope.__panelFitCamera.objectSamples.slice(),
      };
    });

    expect(samples.camera.length).toBeGreaterThanOrEqual(2);
    expect(samples.camera[0]?.transform).toBe(startingTransform);
    expect(samples.camera.at(-1)?.transform).not.toBe(startingTransform);
    expect(samples.camera.length).toBeGreaterThan(5);
    expect(samples.camera.slice(1, -1).some((sample) => (
      sample.transform !== startingTransform
      && sample.transform !== samples.camera.at(-1)?.transform
    ))).toBe(true);
    const motionSamples = samples.camera.slice(1);
    const idleGaps = motionSamples.slice(1).filter((sample, index) => (
      sample.elapsed - motionSamples[index]!.elapsed > 180
    ));
    expect(idleGaps).toEqual([]);

    // The same rendered object must survive the layout change, remain in its start-to-end
    // corridor, and be inverse-translated on the exact frame where a flex panel moves the canvas
    // root. This catches a 272px screen-space teleport that viewport-transform sampling misses.
    expect(samples.objects.length).toBeGreaterThan(5);
    expect(samples.objects.every((sample) => sample.connected && sample.sameElement)).toBe(true);
    const startObject = samples.objects[0]!;
    const endObject = samples.objects.at(-1)!;
    const corridor = {
      min: Math.min(startObject.nodeCenterX, endObject.nodeCenterX) - 2,
      max: Math.max(startObject.nodeCenterX, endObject.nodeCenterX) + 2,
    };
    expect(samples.objects.every((sample) => (
      sample.nodeCenterX >= corridor.min && sample.nodeCenterX <= corridor.max
    ))).toBe(true);
    const firstRootShift = samples.objects.findIndex((sample) => (
      Math.abs(sample.rootLeft - startObject.rootLeft) > 0.5
    ));
    if (firstRootShift > 0) {
      expect(Math.abs(
        samples.objects[firstRootShift]!.nodeCenterX
          - samples.objects[firstRootShift - 1]!.nodeCenterX,
      )).toBeLessThanOrEqual(2);
    }
    const peakScreenSpeed = Math.max(...samples.objects.slice(1).map((sample, index) => {
      const previous = samples.objects[index]!;
      // Under load two rAF callbacks can fire back-to-back while the eased flight advances a
      // full frame step; floor the gap at a 60fps frame so only a real teleport trips the
      // limit (a 272px teleport still reads as 17px/ms).
      const elapsed = Math.max(16, sample.elapsed - previous.elapsed);
      return Math.abs(sample.nodeCenterX - previous.nodeCenterX) / elapsed;
    }));
    expect(peakScreenSpeed).toBeLessThanOrEqual(3);

    const settledTransform = samples.camera.at(-1)!.transform;
    await expect.poll(() => viewport.evaluate(
      (element) => (element as HTMLElement).style.transform,
    )).toBe(settledTransform);
    await page.waitForTimeout(450);
    const tail = await page.evaluate(() => {
      const scope = window as unknown as {
        __panelFitCamera: { samples: Array<{ elapsed: number; transform: string }> };
        __panelFitCameraObserver: MutationObserver;
      };
      scope.__panelFitCameraObserver.disconnect();
      return {
        count: scope.__panelFitCamera.samples.length,
        transform: document.querySelector<HTMLElement>(
          ".map-canvas .react-flow__viewport",
        )?.style.transform,
      };
    });
    expect(tail).toEqual({ count: samples.camera.length, transform: settledTransform });
  };

  await exerciseToggle("Expand inspector", () => (
    expect(page.locator(".right-panel")).toBeVisible()
  ));
  await exerciseToggle("Close inspector", () => (
    expect(page.locator(".right-panel")).toHaveCount(0)
  ));
});

test("refits every unselected canvas when the Inspector opens or closes", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await serveSyntheticWorkspace(page);

  // Screens is a page without a camera; only the Map refits.
  for (const canvas of ["map"] as const) {
    await page.goto(`/${canvas}`);
    await expect.poll(() => {
      const url = new URL(page.url());
      return [url.searchParams.has("screen"), url.searchParams.has("flow")];
    }).toEqual([false, false]);
    await page.waitForTimeout(420);

    const viewport = page.locator(`.${canvas}-canvas .react-flow__viewport`);
    const exerciseInspector = async (
      buttonName: "Expand inspector" | "Close inspector",
    ) => {
      await page.evaluate((canvasName) => {
        const viewportElement = document.querySelector<HTMLElement>(
          `.${canvasName}-canvas .react-flow__viewport`,
        );
        if (!viewportElement) throw new Error(`${canvasName} camera is unavailable`);
        const values = [viewportElement.style.transform];
        const observer = new MutationObserver(() => {
          const value = viewportElement.style.transform;
          if (values.at(-1) !== value) values.push(value);
        });
        observer.observe(viewportElement, { attributes: true, attributeFilter: ["style"] });
        const host = window as typeof window & {
          __overviewPanelCamera?: { values: string[]; observer: MutationObserver };
        };
        host.__overviewPanelCamera = { values, observer };
      }, canvas);

      await page.getByRole("button", { name: buttonName, exact: true }).click();
      if (buttonName === "Expand inspector") {
        await expect(page.locator(".right-panel")).toBeVisible();
      } else {
        await expect(page.locator(".right-panel")).toHaveCount(0);
      }
      await page.waitForTimeout(420);
      const values = await page.evaluate(() => {
        const host = window as typeof window & {
          __overviewPanelCamera: { values: string[]; observer: MutationObserver };
        };
        host.__overviewPanelCamera.observer.disconnect();
        return host.__overviewPanelCamera.values;
      });
      // CI's software renderer commits far fewer camera frames per flight than a local run.
      expect(values.length, `${canvas} ${buttonName}`).toBeGreaterThan(2);
      expect(values.at(-1), `${canvas} ${buttonName}`).not.toBe(values[0]);
      expect(values.slice(1, -1).some((value) => (
        value !== values[0] && value !== values.at(-1)
      )), `${canvas} ${buttonName}`).toBe(true);

      const automatic = values.at(-1)!;
      await page.getByRole("button", { name: "Fit canvas", exact: true }).click();
      await page.waitForTimeout(360);
      await expect.poll(() => viewport.evaluate(
        (element) => (element as HTMLElement).style.transform,
      ), { message: `${canvas} ${buttonName}` }).toBe(automatic);
    };

    await exerciseInspector("Expand inspector");
    await exerciseInspector("Close inspector");
  }
});

test("starts the opening Inspector Fit immediately and settles in one flight", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/map");
  await expect(page.locator(".map-canvas")).not.toHaveClass(/canvas-camera-initializing/);
  await page.waitForTimeout(220);

  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".app-content");
    const viewport = document.querySelector<HTMLElement>(
      ".map-canvas .react-flow__viewport",
    );
    if (!root || !viewport) throw new Error("Map camera is unavailable");
    const startedAt = performance.now();
    const samples: Array<{
      elapsed: number;
      width: number;
      panelVisible: boolean;
      x: number;
      y: number;
      zoom: number;
    }> = [];
    const sample = () => {
      const panel = document.querySelector<HTMLElement>(".right-panel");
      const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      samples.push({
        elapsed: performance.now() - startedAt,
        width: root.getBoundingClientRect().width,
        panelVisible: Boolean(panel && panel.getBoundingClientRect().width > 1),
        x: matrix.m41,
        y: matrix.m42,
        zoom: matrix.a,
      });
    };
    let panelVisibleAt: number | undefined;
    const tick = () => requestAnimationFrame(() => {
      // A direct RAF callback still runs before paint. The timeout observes what the reader
      // actually saw in that frame, including a stale camera briefly clipped by the panel.
      setTimeout(() => {
        sample();
        // The click arming this window arrives over the wire, so anchor the 520ms recording
        // to the panel actually appearing; give a slow runner up to 5s for that to happen.
        const now = performance.now();
        if (panelVisibleAt === undefined && samples[samples.length - 1]!.panelVisible) {
          panelVisibleAt = now;
        }
        const done = panelVisibleAt !== undefined
          ? now - panelVisibleAt >= 520
          : now - startedAt >= 5_000;
        if (!done) tick();
      }, 0);
    });
    sample();
    tick();
    (window as typeof window & { __inspectorPaintSamples?: typeof samples })
      .__inspectorPaintSamples = samples;
  });

  await page.getByRole("button", { name: "Expand inspector" }).click();
  await expect(page.locator(".right-panel")).toBeVisible();
  await page.waitForTimeout(600);
  const samples = await page.evaluate(() => (
    (window as typeof window & {
      __inspectorPaintSamples: Array<{
        elapsed: number;
        width: number;
        panelVisible: boolean;
        x: number;
        y: number;
        zoom: number;
      }>;
    }).__inspectorPaintSamples
  ));
  expect(samples.length).toBeGreaterThan(8);
  const initial = samples[0]!;
  const visible = samples.filter((sample) => sample.panelVisible);
  expect(visible.length).toBeGreaterThan(5);
  expect(visible[0]!.width).toBeLessThan(initial.width - 300);
  const settled = samples.at(-1)!;
  expect(Math.max(
    Math.abs(settled.x - initial.x),
    Math.abs(settled.y - initial.y),
    Math.abs(settled.zoom - initial.zoom) * 1_000,
  )).toBeGreaterThan(1);
  const moving = visible.filter((sample) => (
    Math.max(
      Math.abs(sample.x - initial.x),
      Math.abs(sample.y - initial.y),
      Math.abs(sample.zoom - initial.zoom) * 1_000,
    ) > 0.05
    && Math.max(
      Math.abs(sample.x - settled.x),
      Math.abs(sample.y - settled.y),
      Math.abs(sample.zoom - settled.zoom) * 1_000,
    ) > 0.05
  ));
  expect(moving.length).toBeGreaterThan(2);
  expect(moving[0]!.elapsed - visible[0]!.elapsed).toBeLessThan(80);
});

test("aligns the pill, camera controls, and collapsed Inspector chrome on one center line", async ({ page }) => {
  await page.goto("/map?screen=settings-root");
  await page.getByRole("button", { name: "Close inspector" }).click();

  const pill = page.locator(".left-panel-collapsed-pill");
  const camera = page.getByRole("group", { name: "Canvas camera controls" });
  const inspector = page.locator(".right-float");
  const share = camera.getByRole("button", { name: "Toggle theme", exact: true });
  await expect(pill).toBeVisible();
  await expect(camera).toBeVisible();
  await expect(inspector).toBeVisible();

  const [pillBox, cameraBox, inspectorBox, shareBox] = await Promise.all([
    pill.boundingBox(),
    camera.boundingBox(),
    inspector.boundingBox(),
    share.boundingBox(),
  ]);
  expect(pillBox).not.toBeNull();
  expect(cameraBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(shareBox).not.toBeNull();

  expect(Math.abs(pillBox!.y - 14)).toBeLessThanOrEqual(1);
  expect(Math.abs(pillBox!.height - 42)).toBeLessThanOrEqual(1);
  expect(Math.abs(cameraBox!.y - 14)).toBeLessThanOrEqual(1);
  expect(Math.abs(cameraBox!.height - 42)).toBeLessThanOrEqual(1);
  expect(Math.abs(inspectorBox!.y - 14)).toBeLessThanOrEqual(1);
  expect(Math.abs(inspectorBox!.height - 42)).toBeLessThanOrEqual(1);
  expect(Math.abs(shareBox!.height - 32)).toBeLessThanOrEqual(1);

  const centerLine = cameraBox!.y + cameraBox!.height / 2;
  for (const box of [pillBox!, inspectorBox!]) {
    expect(Math.abs(box.y + box.height / 2 - centerLine)).toBeLessThanOrEqual(1);
  }
});

test("floats the pill over the canvas and remembers the Inspector across a reload", async ({ page }) => {
  await page.goto("/map");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand inspector" }).click();
  // The pill and the Inspector share one panel surface.
  const expandedPanelBackground = await page.locator(".left-panel-collapsed-pill").evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(page.locator(".right-panel"))
    .toHaveCSS("background-color", expandedPanelBackground);
  const expandedCameraShadow = await page.getByRole("group", { name: "Canvas camera controls" })
    .evaluate((element) => getComputedStyle(element).boxShadow);
  expect(expandedCameraShadow).not.toBe("none");
  const collapsedPanel = page.locator(".left-panel.collapsed");
  await expect(collapsedPanel).toBeVisible();
  await expect(collapsedPanel.getByRole("button", { name: "Map", exact: true })).toBeVisible();
  await expect(collapsedPanel.locator(".collapsed-app-identity strong")).toBeVisible();
  // There is no sidebar to open: the pill is the only left chrome.
  await expect(page.getByRole("button", { name: /^(Expand|Collapse) panel$/ })).toHaveCount(0);
  const [collapsedBox, canvasBox] = await Promise.all([
    collapsedPanel.boundingBox(),
    page.locator(".app-content").boundingBox(),
  ]);
  expect(collapsedBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(collapsedBox!.x).toBeCloseTo(12, 0);
  // The pill fits its content, up to 420px.
  expect(collapsedBox!.width).toBeGreaterThan(120);
  expect(collapsedBox!.width).toBeLessThanOrEqual(420);
  expect(collapsedBox!.height).toBeCloseTo(42, 0);
  await expect(page.locator(".left-panel-collapsed-pill")).toHaveCSS("border-top-width", "0px");
  await expect(page.locator(".left-panel-collapsed-pill"))
    .toHaveCSS("background-color", expandedPanelBackground);
  expect(canvasBox!.x).toBeCloseTo(0, 0);
  await expect(page.locator(".right-panel")).toBeVisible();

  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.locator(".right-panel")).toHaveCount(0);
  const canvasActions = page.getByRole("toolbar", { name: "Canvas actions" });
  const cameraControls = page.getByRole("group", { name: "Canvas camera controls" });
  const canvasToolbar = page.getByRole("toolbar", { name: "Canvas tools" });
  const minimap = page.getByTestId("canvas-minimap");
  await expect(canvasActions).toBeVisible();
  await expect(cameraControls).toBeVisible();
  await expect(canvasToolbar).toBeVisible();
  await expect(minimap).toBeVisible();
  await expect(canvasActions).toHaveCSS("background-color", expandedPanelBackground);
  await expect(cameraControls).toHaveCSS("background-color", expandedPanelBackground);
  await expect(canvasActions).toHaveCSS("border-top-width", "0px");
  await expect(cameraControls).toHaveCSS("border-top-width", "0px");
  await expect(cameraControls.locator(".camera-control-divider").first()).toBeHidden();
  const [actionsBox, cameraBox] = await Promise.all([
    canvasActions.boundingBox(),
    cameraControls.boundingBox(),
  ]);
  expect(actionsBox).not.toBeNull();
  expect(cameraBox).not.toBeNull();
  const toolbarJoin = actionsBox!.x - (cameraBox!.x + cameraBox!.width);
  expect(toolbarJoin).toBeGreaterThanOrEqual(-1.5);
  expect(toolbarJoin).toBeLessThanOrEqual(0.5);
  const [leftShadow, rightShadow, toolbarShadow, toolbarBox, minimapBox] = await Promise.all([
    page.locator(".left-panel-collapsed-pill").evaluate((element) => getComputedStyle(element).boxShadow),
    cameraControls.evaluate((element) => getComputedStyle(element, "::before").boxShadow),
    canvasToolbar.evaluate((element) => getComputedStyle(element).boxShadow),
    canvasToolbar.boundingBox(),
    minimap.boundingBox(),
  ]);
  expect(leftShadow).not.toBe("none");
  expect(rightShadow).toBe(leftShadow);
  expect(rightShadow).toBe(expandedCameraShadow);
  expect(toolbarShadow).toBe(leftShadow);
  expect(toolbarBox).not.toBeNull();
  expect(minimapBox).not.toBeNull();
  expect(page.viewportSize()!.height - (toolbarBox!.y + toolbarBox!.height)).toBeCloseTo(14, 0);
  expect(minimapBox!.y + minimapBox!.height).toBeCloseTo(toolbarBox!.y + toolbarBox!.height, 0);

  await page.reload();
  await expect(page.locator(".left-panel.collapsed")).toBeVisible();
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand inspector" }).click();
  await expect(page.locator(".right-panel")).toBeVisible();
});

test("keeps stateful shell control geometry stable across visual state changes", async ({ page }) => {
  const geometry = async (control: Locator, iconSelector = "svg") => {
    await expect(control).toBeVisible();
    return control.evaluate((element, selector) => {
      const controlBox = element.getBoundingClientRect();
      const icon = element.querySelector<SVGElement>(selector);
      if (!icon) throw new Error(`Missing state icon: ${selector}`);
      const iconBox = icon.getBoundingClientRect();
      return {
        control: { width: controlBox.width, height: controlBox.height },
        icon: { width: iconBox.width, height: iconBox.height },
      };
    }, iconSelector);
  };

  await page.goto("/map");
  // The pill's mark and the app name share one centre line.
  const pillAlignment = await page.locator(".left-panel-collapsed-pill").evaluate((pill) => {
    const center = (element: Element | null) => {
      if (!element) throw new Error("The pill is incomplete");
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return {
      pill: center(pill),
      logo: center(pill.querySelector(".panel-logo-button")),
      name: center(pill.querySelector(".collapsed-app-identity > strong")),
    };
  });
  expect(Math.abs(pillAlignment.logo - pillAlignment.pill)).toBeLessThanOrEqual(1);
  expect(Math.abs(pillAlignment.name - pillAlignment.pill)).toBeLessThanOrEqual(1);

  const rightClosed = await geometry(page.getByRole("button", { name: "Expand inspector" }));
  await expect(page.getByRole("button", { name: "Expand inspector" })
    .locator("svg.lucide-panel-right")).toHaveCount(1);
  await page.getByRole("button", { name: "Expand inspector" }).click();
  const rightOpen = await geometry(page.getByRole("button", { name: "Close inspector" }));
  // Open, the same button shows an X that closes the Inspector.
  await expect(page.getByRole("button", { name: "Close inspector" })
    .locator("svg.lucide-x")).toHaveCount(1);
  expect(rightOpen).toEqual(rightClosed);

  const themeButton = page.getByRole("button", { name: "Toggle theme" });
  const lightTheme = await geometry(themeButton);
  await themeButton.click();
  const darkTheme = await geometry(themeButton);
  expect(darkTheme).toEqual(lightTheme);
});

test("migrates the legacy shared panel preference once into the Inspector preference", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("expo-explore:panel-collapsed", "true"));
  await page.goto("/map");
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => ({
    legacy: localStorage.getItem("expo-explore:panel-collapsed"),
    right: localStorage.getItem("expo-explore:right-panel-collapsed"),
  }))).toEqual({ legacy: null, right: "true" });

  await page.getByRole("button", { name: "Expand inspector" }).click();
  await expect(page.locator(".right-panel")).toBeVisible();
});

test("drives the shell from the keyboard, and says so on hover", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/map");
  const compareButton = page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Compare", exact: true });
  await expect(compareButton).toBeVisible();
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // The panel has no sections, so the old section digits are inert.
  const changesUrl = page.url();
  for (const key of ["1", "2", "3"]) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(changesUrl);
  }
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);

  // A held modifier shows, on each button it makes a chord with, the key that completes it: ⇧ puts
  // 1 on Fit canvas, ⌘ (Ctrl elsewhere) puts K on Search. Released, the hints go.
  const hints = page.locator(".key-hint");
  await expect(hints).toHaveCount(0);
  await page.keyboard.down("Shift");
  await expect(page.getByRole("button", { name: "Fit canvas" }).locator(".key-hint")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Center canvas" }).locator(".key-hint")).toHaveText("2");
  await expect(page.getByRole("button", { name: "Search", exact: true }).locator(".key-hint")).toHaveCount(0);
  await page.keyboard.up("Shift");
  await expect(hints).toHaveCount(0);
  await page.keyboard.down(mod);
  await expect(page.getByRole("button", { name: "Search", exact: true }).locator(".key-hint")).toHaveText("K");
  await expect(page.getByRole("button", { name: "Fit canvas" }).locator(".key-hint")).toHaveCount(0);
  await page.keyboard.up(mod);
  await expect(hints).toHaveCount(0);
  // Focus that moves into a field by mouse, with ⇧ still down, takes the hints with it.
  await page.keyboard.down("Shift");
  await expect(page.getByRole("button", { name: "Fit canvas" }).locator(".key-hint")).toHaveText("1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Search Explore" })).toBeVisible();
  await expect(hints).toHaveCount(0);
  await page.keyboard.up("Shift");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search Explore" })).toHaveCount(0);

  // ⌘B opens and closes the Changes menu.
  await page.keyboard.press(`${mod}+b`);
  await expect(page.locator(".changes-menu")).toBeVisible();
  await page.keyboard.press("3");
  await expect(page.locator(".changes-menu")).toBeVisible();
  await expect(page).toHaveURL(changesUrl);
  await page.keyboard.press(`${mod}+b`);
  await expect(page.locator(".changes-menu")).toHaveCount(0);

  // Initials move between canvases. Pan and object selection are contextual, not toolbar modes.
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.locator(".right-panel")).toHaveCount(0);
  // Every canvas keeps the same shell default: the Inspector closed.
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.locator(".right-panel")).toHaveCount(0);
  const beforeRetiredGraphShortcut = page.url();
  await page.keyboard.press("g");
  await expect(page).toHaveURL(beforeRetiredGraphShortcut);
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pan", exact: true })).toHaveCount(0);
  const beforeRemovedMoveShortcut = page.url();
  await page.keyboard.press("v");
  await expect(page).toHaveURL(beforeRemovedMoveShortcut);
  await expect(page.locator(".graph-canvas .react-flow")).toHaveClass(/canvas-tool-pan/);

  // Every remaining shortcut is discoverable: the tooltip prints the key next to the label.
  await compareButton.hover();
  await expect(page.locator(".tooltip-key")).toHaveText("C");
  await page.getByRole("button", { name: "Expand inspector" }).hover();
  await expect(page.locator(".tooltip-key")).toHaveText("I");
  // The theme button names the mode in force, and T is its key.
  const themeButton = page.getByRole("button", { name: "Toggle theme" });
  await themeButton.hover();
  await expect(page.locator(".tooltip-content")).toContainText("Theme: Auto");
  await expect(page.locator(".tooltip-key")).toHaveText("T");
  await page.mouse.move(0, 0);
  const initialTheme = await page.locator("html").getAttribute("data-theme");
  expect(initialTheme === "light" || initialTheme === "dark").toBe(true);
  const otherTheme = initialTheme === "dark" ? "light" : "dark";
  // T flips between dark and light from whatever Auto showed, and never steps back to Auto.
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", otherTheme);
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-theme", initialTheme!);
  await themeButton.hover();
  await expect(page.locator(".tooltip-content")).toContainText(initialTheme === "dark" ? "Theme: Dark" : "Theme: Light");
  await page.mouse.move(0, 0);
  // The retired theme and inspector chords no longer answer.
  await page.keyboard.press(`${mod}+Alt+t`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", initialTheme!);
  await page.keyboard.press("Shift+3");
  await expect(page.locator("html")).toHaveAttribute("data-theme", initialTheme!);
  await page.keyboard.press(`${mod}+Shift+b`);
  await expect(page.locator(".right-panel")).toHaveCount(0);

  await page.keyboard.press(`${mod}+Alt+b`);
  await expect(page.locator(".right-panel")).toHaveCount(0);

  // I shows and hides the Inspector.
  await page.keyboard.press("i");
  await expect(page.locator(".right-panel")).toBeVisible();
  await page.keyboard.press("i");
  await expect(page.locator(".right-panel")).toHaveCount(0);

  // The Viewer has no Settings dialog; ⌘, opens nothing.
  await page.keyboard.press(`${mod}+Comma`);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Removed shortcuts remain inert and typing remains typing.
  const beforeRemovedShortcuts = page.url();
  await page.keyboard.press("3");
  await page.keyboard.press("Shift+c");
  await expect(page).toHaveURL(beforeRemovedShortcuts);
  await expect(page.getByRole("searchbox", { name: "Search comments" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toHaveCount(0);

  // C opens Compare on a changed screen; M returns to the map.
  await page.keyboard.press("c");
  await expect(page).toHaveURL(/\/compare/);
  await expect(page.getByRole("region", { name: /^Compare / })).toBeVisible();
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/\/map/);
});

test("keeps fixed objects and canvas pan after a reload", async ({ page }) => {
  await page.goto("/map");
  await expect(page.getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pan", exact: true })).toHaveCount(0);
  await expect(page.locator(".graph-canvas .react-flow")).toHaveClass(/canvas-tool-pan/);
  await expect(page.locator(".react-flow__pane")).toHaveCSS("cursor", /hand\.svg/);

  await page.reload();
  await expect(page.locator(".graph-canvas .react-flow")).toHaveClass(/canvas-tool-pan/);
  await expect(page.locator(".react-flow__pane")).toHaveCSS("cursor", /hand\.svg/);
});

test("delays the first tooltip, then shows subsequent tooltips instantly", async ({ page }) => {
  await page.goto("/map");
  const menu = page.locator(".left-panel-collapsed-pill").getByRole("button", { name: "Map", exact: true });
  const changes = page.getByRole("button", { name: "Expand inspector" });
  const tooltip = page.locator(".tooltip");

  await menu.hover();
  await page.waitForTimeout(150);
  await expect(tooltip).toHaveCount(0);
  await expect(tooltip).toHaveText("Map");
  await expect(tooltip).not.toHaveAttribute("data-instant", "");

  await changes.hover();
  await expect(tooltip).toContainText("Expand inspector", { timeout: 150 });
  await expect(tooltip).toHaveAttribute("data-instant", "");
  await expect(tooltip).toHaveCSS("animation-name", "none");

  await page.mouse.move(500, 500);
  await page.waitForTimeout(350);
  await changes.hover();
  await page.waitForTimeout(150);
  await expect(tooltip).toHaveCount(0);
  await expect(tooltip).toContainText("Expand inspector");
  await expect(tooltip).not.toHaveAttribute("data-instant", "");
});

test("follows system theme and polls lightweight status instead of the full map", async ({ page }) => {
  let mapRequests = 0;
  let statusRequests = 0;
  let screenshotRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/map") mapRequests += 1;
    if (pathname === "/api/status") statusRequests += 1;
    if (pathname.startsWith("/api/artifacts/")) screenshotRequests += 1;
  });

  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/map");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.waitForTimeout(500);
  const initialScreenshotRequests = screenshotRequests;
  expect(initialScreenshotRequests).toBeGreaterThan(0);
  expect(initialScreenshotRequests).toBeLessThanOrEqual(
    await page.locator(".react-flow__node-screen").count(),
  );

  await chooseTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("expo-explore:theme"))).toBe("light");
  // The button shows the mode in force (Light), not the next one.
  await expect(page.getByRole("button", { name: "Toggle theme" })
    .locator("svg.lucide-sun")).toBeVisible();

  await page.waitForTimeout(5_500);
  expect(mapRequests).toBe(1);
  expect(statusRequests).toBeGreaterThanOrEqual(1);
  expect(screenshotRequests).toBe(initialScreenshotRequests);
});

test("Screens adds the screens a live map gains", async ({ page }) => {
  const initial = await liveMapPayload(2, 100);
  const expanded = await liveMapPayload(30, 101);
  const served = await serveMap(page, initial);

  await page.goto("/screens");
  await expect(page.locator(".screens-page .screens-cell")).toHaveCount(2);
  served.current = expanded;
  await expect(page.locator(".screens-page .screens-cell")).toHaveCount(30, { timeout: 7_000 });
});

test("zooms Map inspection up to 25600% without exceeding the ceiling", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/map");
  await expect(page.locator(".map-canvas.canvas-projection-animating")).toHaveCount(0);
  await expect(page.locator(".right-float")).toBeVisible();

  await page.keyboard.press("Shift+0");
  await expect(page.getByRole("button", { name: "Zoom — 100%" })).toBeVisible();
  // The public `+` shortcut uses the same 1.2x camera step as the Zoom menu. Let each short
  // transition settle so the sequence reaches, rather than repeatedly interrupts, the ceiling.
  for (let step = 0; step < 36; step += 1) {
    await page.keyboard.press("=");
    await page.waitForTimeout(170);
  }
  const zoom = page.getByRole("button", { name: "Zoom — 25600%" });
  await expect(zoom).toBeVisible();
  const viewport = page.locator(".react-flow__viewport");
  expect(scaleFromTransform(await viewport.getAttribute("style"))).toBe(256);

  // Additional input is clamped, and the wider percentage remains inside the persistent header.
  await page.keyboard.press("=");
  await page.waitForTimeout(170);
  await expect(zoom).toBeVisible();
  expect(scaleFromTransform(await viewport.getAttribute("style"))).toBe(256);
  const zoomBox = await zoom.boundingBox();
  const shareBox = await page.locator(".right-float").boundingBox();
  expect(zoomBox).not.toBeNull();
  expect(shareBox).not.toBeNull();
  expect(zoomBox!.x + zoomBox!.width).toBeLessThanOrEqual(shareBox!.x);

  await page.keyboard.press("Shift+0");
  await expect(page.getByRole("button", { name: "Zoom — 100%" })).toBeVisible();
});

test("keeps browser zoom gestures scoped to the canvas boundary", async ({ page }) => {
  // The comparison link below only renders for a build-comparison workspace.
  await serveWorkspace(page);
  await page.goto("/map");
  const viewport = page.locator(".react-flow__viewport");
  const pane = page.locator(".react-flow__pane");
  await expect(pane).toBeVisible();

  const initialScale = scaleFromTransform(await viewport.getAttribute("style"));
  const canvasKeyPrevented = await pane.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Equal",
      key: "+",
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(canvasKeyPrevented).toBe(true);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeGreaterThan(initialScale);

  await page.waitForTimeout(180);
  const settledStyle = await viewport.getAttribute("style");
  // The pill's pull request link is a chrome link outside the canvas.
  const comparisonLink = page.getByRole("link", { name: "PR #550 on GitHub" });
  await comparisonLink.hover();
  const panelKeyPrevented = await comparisonLink.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Minus",
      key: "-",
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(panelKeyPrevented).toBe(false);
  await page.waitForTimeout(180);
  await expect(viewport).toHaveAttribute(
    "style",
    new RegExp(settledStyle!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  // Hover and focus are independent canvas ownership paths. A panel link may retain keyboard
  // focus while the pointer returns to the canvas; the canvas then owns the zoom chord.
  await comparisonLink.focus();
  await pane.hover();
  const beforeHoverChord = scaleFromTransform(await viewport.getAttribute("style"));
  const hoverChordPrevented = await comparisonLink.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Equal",
      key: "+",
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(hoverChordPrevented).toBe(true);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeGreaterThan(beforeHoverChord);
  await page.waitForTimeout(180);

  const metaResetPrevented = await pane.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit0",
      key: "0",
      metaKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(metaResetPrevented).toBe(true);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(1, 2);
  await page.waitForTimeout(180);

  const metaMinusPrevented = await pane.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Minus",
      key: "-",
      metaKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(metaMinusPrevented).toBe(true);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeLessThan(1);
  await page.waitForTimeout(180);

  const repeatedChordPrevented = await pane.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Equal",
      key: "+",
      ctrlKey: true,
      repeat: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(repeatedChordPrevented).toBe(true);
  await page.waitForTimeout(180);

  // A plain wheel scrolls the canvas like a document; only the chord below zooms.
  const beforePlainWheel = await viewport.getAttribute("style");
  const plainWheelPrevented = await pane.evaluate((element) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
      deltaY: 120,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(plainWheelPrevented).toBe(true);
  await expect.poll(async () => await viewport.getAttribute("style")).not.toBe(beforePlainWheel);
  expect(scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(scaleFromTransform(beforePlainWheel), 5);
  await page.waitForTimeout(180);

  const beforePinch = scaleFromTransform(await viewport.getAttribute("style"));
  const canvasWheelPrevented = await pane.evaluate((element) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
      ctrlKey: true,
      deltaY: -40,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(canvasWheelPrevented).toBe(true);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeGreaterThan(beforePinch);
  await page.waitForTimeout(180);

  const beforeCommandWheel = scaleFromTransform(await viewport.getAttribute("style"));
  const commandWheelPrevented = await pane.evaluate((element) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 400,
      clientY: 300,
      metaKey: true,
      deltaY: 40,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(commandWheelPrevented).toBe(true);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeLessThan(beforeCommandWheel);

  // A text field in the Changes menu keeps the browser's own zoom keys.
  const menu = await openChangesMenu(page);
  await menu.getByRole("button", { name: "Find changes" }).click();
  const search = page.getByRole("searchbox", { name: "Find changed screens" });
  await search.hover();
  const inputKeyPrevented = await search.evaluate((element) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit0",
      key: "0",
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(inputKeyPrevented).toBe(false);
});

test("normalizes Command-wheel cadence and keeps the pointer anchored", async ({ page }) => {
  await page.goto("/map");
  const pane = page.locator(".react-flow__pane");
  const viewport = page.locator(".react-flow__viewport");
  await expect(pane).toBeVisible();

  const burst = async (gapMs: number) => pane.evaluate(async (element, gap) => {
    const canvas = element.closest<HTMLElement>(".react-flow");
    const viewportElement = canvas?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!canvas || !viewportElement) throw new Error("Canvas viewport is unavailable");
    const bounds = canvas.getBoundingClientRect();
    const clientX = bounds.left + bounds.width * 0.32;
    const clientY = bounds.top + bounds.height * 0.41;
    const read = () => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(viewportElement).transform);
      const screenX = clientX - bounds.left;
      const screenY = clientY - bounds.top;
      return {
        zoom: matrix.a,
        worldX: (screenX - matrix.m41) / matrix.a,
        worldY: (screenY - matrix.m42) / matrix.a,
      };
    };
    const before = read();
    let prevented = true;
    for (let index = 0; index < 20; index += 1) {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: -5,
        clientX,
        clientY,
      });
      element.dispatchEvent(event);
      prevented &&= event.defaultPrevented;
      if (gap > 0) await new Promise((resolve) => window.setTimeout(resolve, gap));
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const after = read();
    return {
      prevented,
      before,
      after,
      worldDrift: Math.hypot(
        after.worldX - before.worldX,
        after.worldY - before.worldY,
      ),
    };
  }, gapMs);

  await page.keyboard.press("Shift+0");
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(1, 3);
  const dense = await burst(0);

  await page.keyboard.press("Shift+0");
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(1, 3);
  const sparse = await burst(40);

  expect(dense.prevented).toBe(true);
  expect(sparse.prevented).toBe(true);
  expect(dense.after.zoom).toBeGreaterThan(dense.before.zoom);
  expect(sparse.after.zoom).toBeGreaterThan(sparse.before.zoom);
  expect(dense.after.zoom).toBeCloseTo(sparse.after.zoom, 5);
  expect(dense.worldDrift).toBeLessThan(0.1);
  expect(sparse.worldDrift).toBeLessThan(0.1);
});

test("restores the fitted camera after internal navigation on the Map", async ({ page }) => {
  test.setTimeout(30_000);
  const viewport = page.locator(".react-flow__viewport");

  const assertRoundTrip = async (config: {
    root: "/map";
    target: string;
    destination: RegExp;
  }) => {
    await page.goto(config.root);
    const target = page.locator(config.target).first();
    await expect(target).toBeVisible();
    await page.waitForTimeout(120);
    const fitted = await viewport.getAttribute("style");
    expect(fitted).not.toBeNull();

    await target.click();
    await expect(page).toHaveURL(config.destination);
    await expect.poll(() => viewport.getAttribute("style"), { timeout: 3_000 })
      .not.toBe(fitted);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${config.root.replace("/", "\\/")}$`));
    await expect.poll(() => viewport.getAttribute("style"), { timeout: 3_000 })
      .toBe(fitted);
    // No delayed focus or projection owner may move the camera after restoration.
    await page.waitForTimeout(360);
    await expect(viewport).toHaveAttribute("style", fitted!);
  };

  await assertRoundTrip({
    root: "/map",
    target: ".react-flow__node-screen .screen-screenshot-target",
    destination: /\/map(\/.+|\?.*screen=)/,
  });
});

test("keeps theme and full screen in the persistent canvas controls, not the inspector header", async ({ page }) => {
  await page.goto("/map");
  // Collapsed inspector: the camera controls and the panel toggle form one toolbar.
  const collapsedCamera = page.getByRole("group", { name: "Canvas camera controls" });
  await expect(collapsedCamera.getByRole("button", { name: "Toggle theme", exact: true })).toBeVisible();
  await expect(collapsedCamera.getByRole("button", { name: "Enter full screen", exact: true })).toBeVisible();
  await expect(page.locator(".right-float button")).toHaveCount(1);
  await expect(page.locator(".right-float button")).toHaveAccessibleName("Expand inspector");
  await page.getByRole("button", { name: "Expand inspector" }).click();
  await expect(page.getByRole("button", { name: /Share/ })).toHaveCount(0);
  await expect(page.locator(".right-head button")).toHaveCount(1);
  await expect(page.locator(".right-head button")).toHaveAccessibleName("Close inspector");
  const fit = page.getByRole("button", { name: "Fit canvas", exact: true });
  await expect(fit).toBeVisible();
  await expect(fit).toHaveText("");
  const center = page.getByRole("button", { name: "Center canvas", exact: true });
  await expect(center).toBeVisible();
  await center.hover();
  await expect(page.locator(".tooltip")).toContainText("Center canvas");
  await expect(page.locator(".tooltip-key")).toHaveText(/(?:⇧2|Shift\+2)/);
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0);
  const cameraControls = page.getByRole("group", { name: "Canvas camera controls" });
  await expect(cameraControls).toBeVisible();
  await expect(cameraControls).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(cameraControls).toHaveCSS("border-top-width", "1px");
  await expect(cameraControls.locator(".camera-control-divider")).toHaveCount(3);
  const cameraButtons = cameraControls.getByRole("button");
  await expect(cameraButtons).toHaveCount(5);
  await expect(cameraButtons.nth(3)).toHaveAccessibleName("Toggle theme");
  await expect(cameraButtons.nth(4)).toHaveAccessibleName("Enter full screen");
  for (const button of await cameraButtons.all()) {
    await expect(button).toHaveCSS("border-top-width", "0px");
    await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  }
  await expect(page.locator(".app-content > .canvas-camera-controls")).toHaveCount(1);
  await expect(page.locator(".right-panel .canvas-camera-controls, .right-float .canvas-camera-controls"))
    .toHaveCount(0);
  const zoomButton = cameraControls.getByRole("button", { name: /^Zoom — / });
  await expect(zoomButton).toBeVisible();
  await expect(zoomButton.locator("svg")).toHaveCount(0);

  const viewport = page.locator(".react-flow__viewport");
  await page.keyboard.press("Shift+0");
  const beforeFit = await viewport.getAttribute("style");
  await fit.click();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(beforeFit);

  // Center is deliberately not another fit command: panning changes the position, then the
  // control recenters the visible content while preserving the current inspection scale.
  await page.waitForTimeout(180);
  const fitted = await viewport.getAttribute("style");
  const pane = page.locator(".react-flow__pane");
  const paneBox = await pane.boundingBox();
  if (!paneBox) throw new Error("Canvas pane is not measurable");
  const panPoint = await pane.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let row = 1; row < 9; row += 1) {
      for (let column = 1; column < 9; column += 1) {
        const x = box.left + box.width * column / 10;
        const y = box.top + box.height * row / 10;
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
    }
    return undefined;
  });
  if (!panPoint) throw new Error("Canvas has no exposed pan target");
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down();
  await page.mouse.move(panPoint.x + 120, panPoint.y + 72, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(fitted);
  const panned = await viewport.getAttribute("style");
  const pannedScale = scaleFromTransform(panned);
  await center.click();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(panned);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(pannedScale, 6);

  // The keyboard shortcut performs the same scale-preserving camera action.
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down();
  await page.mouse.move(panPoint.x - 96, panPoint.y - 56, { steps: 4 });
  await page.mouse.up();
  const shortcutPanned = await viewport.getAttribute("style");
  await page.locator(".graph-canvas").hover();
  await page.keyboard.press("Shift+2");
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(shortcutPanned);
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(pannedScale, 6);

  // The theme toggle changes the page theme without changing the route.
  const canonical = page.url();
  const themeBefore = await page.locator("html").getAttribute("data-theme");
  await cameraControls.getByRole("button", { name: "Toggle theme", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", themeBefore!);
  await expect(page).toHaveURL(canonical);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto(canonical);
  await expect(page).toHaveURL(canonical);
  await expect(page.getByRole("heading", { name: "UX Report" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comments", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toHaveCount(0);
});

test("a screen's URL reopens on that screen, and back undoes the move, not the highlight", async ({ page }) => {
  await page.goto("/map");
  const node = page.locator(".react-flow__node-screen").first();
  await expect(node).toBeVisible();
  await node.locator(".screen-screenshot-target")
    .evaluate((element) => (element as HTMLButtonElement).click());
  const url = page.url();
  expect(new URL(url).searchParams.get("screen")).toBeTruthy();
  const title = await page.locator(".right-panel .inspector-mode-copy .screen-path-text").innerText();

  // Highlighting a second screen rewrites the entry; moving to Screens adds an unselected view.
  const nextScreen = page.locator(".react-flow__node-screen:not(.selected)").first();
  await expect(nextScreen).toBeVisible();
  await nextScreen.locator(".screen-screenshot-target")
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page).not.toHaveURL(url);
  await chooseCanvasView(page, "Screens");
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.locator(".screen-screenshot-card.selected, .react-flow__node.selected")).toHaveCount(0);
  await expect(page.locator(".right-panel")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/map\?screen=/);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.locator(".screen-screenshot-card.selected, .react-flow__node.selected")).toHaveCount(0);

  // Opening the first link lands on that screen, selected and inspected.
  await page.goto(url);
  await expect(page).toHaveURL(url);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(1);
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text")).toHaveText(title);
});

/**
 * Every distinct viewport transform from now on, so a flight can be told from a cut. The
 * recorder outlives the click that starts the camera, which a sampler racing it would miss.
 */
async function recordCamera(page: Page) {
  await page.evaluate(() => {
    const frames: string[] = [];
    (window as unknown as { __cameraFrames: string[] }).__cameraFrames = frames;
    (function tick() {
      const viewport = document.querySelector(".react-flow__viewport");
      const transform = viewport instanceof HTMLElement ? viewport.style.transform : "";
      if (transform && frames[frames.length - 1] !== transform) frames.push(transform);
      requestAnimationFrame(tick);
    })();
  });
  return async () => {
    // Focus flights are 280ms; wait for a still beat before reading.
    let frames: string[] = [];
    await expect.poll(async () => {
      const next = await page.evaluate(
        () => (window as unknown as { __cameraFrames: string[] }).__cameraFrames.slice(),
      );
      const settled = next.length === frames.length;
      frames = next;
      return settled && frames.length > 0;
    }, { timeout: 5000, intervals: [200, 200, 200, 200, 200] }).toBe(true);
    return frames;
  };
}

test("a low-zoom canvas click zooms and pans continuously into the screen", async ({ page }) => {
  await serveMap(page, await liveMapPayload(3, 1));
  await page.goto("/map");
  await expect(page.locator(".react-flow__node-screen").first()).toBeVisible();
  const viewport = page.locator(".react-flow__viewport");

  // Start near the reported 25% case. Waiting after every key keeps React Flow's animated zoom
  // steps from interrupting one another and makes the starting scale deterministic.
  await page.keyboard.press("Shift+0");
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeCloseTo(1, 1);
  for (let step = 0; step < 8; step += 1) {
    const before = scaleFromTransform(await viewport.getAttribute("style"));
    await page.keyboard.press("-");
    await page.waitForTimeout(180);
    expect(scaleFromTransform(await viewport.getAttribute("style"))).toBeLessThan(before - 0.001);
  }
  await expect.poll(async () => scaleFromTransform(await viewport.getAttribute("style")))
    .toBeLessThan(0.3);

  const read = await recordCamera(page);
  // Simulate expensive node work near the landing. The camera may finish later, but must not
  // catch the missed time up in one oversized final step.
  await page.evaluate(() => {
    window.setTimeout(() => {
      const until = performance.now() + 70;
      while (performance.now() < until) { /* block one render beat intentionally */ }
    }, 320);
  });
  await page.locator(".react-flow__node-screen:not(.selected)").first()
    .locator(".screen-screenshot-target").click();
  const frames = await read();
  const scales = frames.map(scaleFromTransform);
  const start = scales[0]!;
  const end = scales.at(-1)!;

  // A cut would leave two frames; the flight draws its way there. The frame count depends on
  // the runner: CI's software renderer commits well under half the frames of a local run.
  expect(frames.length).toBeGreaterThan(4);
  expect(start).toBeLessThan(0.3);
  // The click opens the Inspector, so the landing is the selection fit of the narrowed frame
  // rather than a fixed focus zoom; assert a large zoom-in and the centred landing itself.
  expect(end).toBeGreaterThan(0.6);
  await expectSelectedScreenCentered(page);
  // A large zoom-in is one monotonic transition with no pull-back or second phase.
  expect(Math.min(...scales)).toBeGreaterThanOrEqual(start - 0.001);
  for (let frame = 1; frame < scales.length; frame += 1) {
    expect(scales[frame]!).toBeGreaterThanOrEqual(scales[frame - 1]! - 0.001);
  }
  const zoomSteps = scales.slice(1).map((scale, index) => scale - scales[index]!);
  // The blocked render beat may skip frames mid-flight, but the landing must not catch the
  // missed time up in one oversized final step.
  expect(zoomSteps.at(-1)!).toBeLessThanOrEqual((end - start) * 0.35);
  // The landing decelerates: the last step is clearly smaller than the flight's largest one.
  expect(zoomSteps.at(-1)!).toBeLessThan(Math.max(...zoomSteps) * 0.75);
});

test("the merged inspector keeps direction state and canonicalizes legacy Review links", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");
  await page.locator(".screens-page .screens-cell").first()
    .locator(".screen-screenshot-target").click();
  await page.getByRole("radio", { name: /^In\b/ }).click();
  await expect(page).toHaveURL(/dir=in/);
  const sessionUrl = page.url();

  // Session and Diff are one view now: no tab strip, the status badge leads the screen path.
  await expect(page.getByRole("tablist", { name: "Right panel view" })).toHaveCount(0);
  const sessionStatus = page.locator(".right-panel .inspector-diff-status");
  await expect(sessionStatus).toHaveAttribute("aria-label", /^(Added|Modified|Removed|Unchanged)$/);
  expect(await sessionStatus.evaluate((status) => (
    status.nextElementSibling?.classList.contains("screen-path-text") ?? false
  ))).toBe(true);
  await expect(page.locator(".right-panel .inspector")).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.getByRole("radio", { name: /^In\b/ })).toHaveAttribute("aria-checked", "true");

  // A legacy Review link still canonicalizes its inspector parameter and lands on the same screen.
  const legacyReviewUrl = new URL(sessionUrl);
  legacyReviewUrl.searchParams.set("inspect", "review");
  await page.goto(legacyReviewUrl.toString());
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      screen: url.searchParams.get("screen"),
      inspect: url.searchParams.get("inspect"),
      direction: url.searchParams.get("dir"),
    };
  }).toEqual({
    screen: new URL(sessionUrl).searchParams.get("screen"),
    inspect: "diff",
    direction: "in",
  });
  await expect(page.locator(".right-panel .inspector")).toBeVisible();
  await expect(page.getByRole("radio", { name: /^In\b/ })).toHaveAttribute("aria-checked", "true");

  // Without a baseline there is nothing to diff: the parameter drops and one screenshot remains.
  const noBaselineUrl = new URL(page.url());
  noBaselineUrl.searchParams.set("baseline", "none");
  await page.goto(noBaselineUrl.toString());
  await expect(page).toHaveURL(/baseline=none/);
  await expect(page).not.toHaveURL(/inspect=diff/);
  await expect(page.locator(".right-panel .inspector-diff-compare")).toHaveCount(0);
  await expect(page.locator(".right-panel .inspector-preview")).toBeVisible();
});

test("removes Changes from the DOM and accessibility tree without a baseline", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/map?baseline=none");
  await expect(page).toHaveURL(/baseline=none/);

  const views = ["Screens", "Map"] as const;
  for (const view of views) {
    await chooseCanvasView(page, view);
    await expect(page.getByRole("region", { name: "Review", exact: true, includeHidden: true }))
      .toHaveCount(0);
    await expect(page.locator(".changes-panel")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Filter changes", includeHidden: true }))
      .toHaveCount(0);
  }
});

test("screen variants use an accessible carousel and restore from the URL", async ({ page }) => {
  await page.goto("/map?screen=settings-root");

  const carousel = page.locator(".screen-variant-carousel");
  const preview = carousel.locator(".variant-preview");
  const tabs = page.getByRole("tablist", { name: "Settings screen variants" }).getByRole("tab");
  await expect(carousel).toBeVisible();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(carousel.locator(".variant-meta")).toHaveCount(0);
  await expect(tabs.nth(0).locator("img")).toHaveCSS("opacity", "1");
  await expect(tabs.nth(1).locator("img")).toHaveCSS("opacity", "0.35");
  await expect(tabs.nth(0)).toHaveCSS("border-width", "2px");
  await expect(tabs.nth(0)).toHaveCSS("border-color", "rgb(5, 136, 240)");

  // Navigation sits beside the evidence, not over app content.
  const previewBox = await preview.boundingBox();
  const previousBox = await page.getByRole("button", { name: "Previous screen variant" }).boundingBox();
  const nextBox = await page.getByRole("button", { name: "Next screen variant" }).boundingBox();
  expect(previewBox).not.toBeNull();
  expect(previousBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  expect(previousBox!.x + previousBox!.width).toBeLessThanOrEqual(previewBox!.x);
  expect(nextBox!.x).toBeGreaterThanOrEqual(previewBox!.x + previewBox!.width);

  // Keyboard focus remains unambiguous without drawing a border around icon actions. The
  // selected thumbnail retains its border while keyboard focus adds a brightness cue.
  await tabs.nth(0).focus();
  await page.keyboard.press("Shift+Tab");
  const nextButton = page.getByRole("button", { name: "Next screen variant" });
  await expect(nextButton).toBeFocused();
  await expect(nextButton).toHaveCSS("outline-width", "0px");
  await expect(nextButton).toHaveCSS("filter", "brightness(1.08)");
  await expect(nextButton).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.press("Tab");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveCSS("outline-width", "0px");
  await expect(tabs.nth(0)).toHaveCSS("filter", "brightness(1.16)");

  const firstScreenshot = await preview.getByRole("img").getAttribute("src");
  const strip = carousel.locator(".variant-thumbnails");
  const stripBox = await strip.boundingBox();
  const firstTabBox = await tabs.nth(0).boundingBox();
  const lastTabBox = await tabs.nth(1).boundingBox();
  expect(stripBox).not.toBeNull();
  expect(firstTabBox).not.toBeNull();
  expect(lastTabBox).not.toBeNull();
  expect((firstTabBox!.x + lastTabBox!.x + lastTabBox!.width) / 2)
    .toBeCloseTo(stripBox!.x + stripBox!.width / 2, 0);
  await strip.evaluate((element) => {
    element.style.width = "58px";
    element.scrollLeft = 0;
  });
  const inspectorScroll = page.locator(".right-scroll");
  await expectAutoHideScrollbar(page.locator(".right-scroll-shell"), inspectorScroll);
  const inspectorScrollTop = await inspectorScroll.evaluate((element) => {
    element.scrollTop = Math.min(300, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(inspectorScrollTop).toBeGreaterThan(0);

  // A direct DOM click avoids Playwright scrolling the off-screen button for the test. Selecting
  // the clipped thumbnail should move only the horizontal strip, never the Inspector itself.
  await nextButton.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(carousel.locator(".variant-meta")).toHaveCount(0);
  await expect(tabs.nth(0).locator("img")).toHaveCSS("opacity", "0.35");
  await expect(tabs.nth(1).locator("img")).toHaveCSS("opacity", "1");
  await expect(page).toHaveURL(/variant=variant-[^&]+/);
  await expect.poll(() => preview.getByRole("img").getAttribute("src")).not.toBe(firstScreenshot);
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(() => inspectorScroll.evaluate((element) => element.scrollTop)).toBe(inspectorScrollTop);
  await strip.evaluate((element) => element.style.removeProperty("width"));

  const selectedUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(selectedUrl);
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  await tabs.nth(1).focus();
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

  // A new screen cannot inherit the previous screen's selected state.
  await page.locator(".transition-row .transition-path").filter({ hasText: "/general" }).click();
  await expect(page).not.toHaveURL(/variant=/);
  await expect(page.getByRole("tablist", { name: "General screen variants" }).getByRole("tab").first())
    .toHaveAttribute("aria-selected", "true");

  // A screen with one state remains the simple single-image inspector.
  await page.goto("/map?screen=action-button");
  await expect(page.locator(".variant-preview")).toBeVisible();
  await expect(page.locator(".screen-variant-carousel")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /screen variant/i })).toHaveCount(0);

  // Stale deep links are canonicalised as soon as the map can validate them.
  await page.goto("/map?screen=action-button&variant=variant-does-not-belong-here");
  await expect(page).not.toHaveURL(/variant=/);
});

test("Changes rows open screen selections in the Screens Diff inspector", async ({ page }) => {
  await serveWorkspace(page, { catalogName: "Example pull request" });
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.goto("/screens");

  await expect(page.locator(".collapsed-app-identity > strong")).toHaveText("Example pull request");
  // The app title opens the repository in a new tab; the PR number opens the pull request.
  const repositoryLink = page.getByRole("link", { name: "Example pull request repository on GitHub" });
  await expect(repositoryLink).toHaveAttribute("href", "https://github.com/expo/explore-playground");
  await expect(repositoryLink).toHaveAttribute("target", "_blank");
  await expect(repositoryLink).toHaveAttribute("rel", /noopener/);

  const comparisonLink = page.getByRole("link", { name: "PR #550 on GitHub" });
  await expect(comparisonLink).toHaveAttribute(
    "href",
    "https://github.com/expo/explore-playground/pull/550",
  );
  await expect(comparisonLink).toHaveText("PR #550");
  // The pill only has room for the number; the title and branches wait in its tooltip.
  await comparisonLink.hover();
  await expect(page.locator(".tooltip")).toContainText(
    "Refine Example review surfaces across onboarding, cats, games, profile, and settings",
  );
  await expect(page.locator(".tooltip")).toContainText("pilot/explore-changes → pilot/explore-base");
  await page.mouse.move(640, 400);

  const menu = await openChangesMenu(page);
  await expect(menu.getByRole("group", { name: "Filter changes" }).getByRole("button"))
    .toHaveText(["Added 1", "Modified 4", "Removed 1"]);

  const addedRow = page.getByRole("button", {
    name: "Open current added, Added, /current-added",
    exact: true,
  });
  const changedRow = page.getByRole("button", {
    name: "Open current profile, Modified, /current-profile",
    exact: true,
  });
  const removedRow = page.getByRole("button", {
    name: "Open baseline legacy, Removed, /baseline-legacy",
    exact: true,
  });

  expect(await addedRow.getAttribute("aria-haspopup")).toBeNull();
  expect(await addedRow.getAttribute("aria-expanded")).toBeNull();
  expect(await addedRow.getAttribute("aria-controls")).toBeNull();
  const urlBeforeHover = page.url();
  const selectedBeforeHover = await page.locator(".screens-page .screens-cell:has(.screen-screenshot-card.selected)")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-screen-id")));
  await addedRow.hover();
  await page.waitForTimeout(180);
  expect(page.url()).toBe(urlBeforeHover);
  await expect(page.getByRole("tablist", { name: "Right panel view" })).toHaveCount(0);
  await expect(page.locator(".right-panel .inspector-diff")).toHaveCount(0);
  expect(await page.locator(".screens-page .screens-cell:has(.screen-screenshot-card.selected)")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-screen-id"))))
    .toEqual(selectedBeforeHover);
  await addedRow.focus();
  await page.waitForTimeout(180);
  expect(page.url()).toBe(urlBeforeHover);
  await expect(page.locator(".right-panel .inspector-diff")).toHaveCount(0);

  await expect(page.locator(".right-panel")).toHaveCount(0);
  await addedRow.click();

  // A changed screen opens the sidebar review: Compare at Inspector size. A one-sided screen shows
  // only the side that exists, and its label says why the other is missing.
  const diffPanel = page.locator(".right-panel .inspector-diff");
  const review = diffPanel.getByRole("region", { name: /^Changes in / });
  const before = review.locator('[data-side="before"]');
  const after = review.locator('[data-side="after"]');

  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      screen: url.searchParams.get("screen"),
      inspect: url.searchParams.get("inspect"),
    };
  }).toEqual({ pathname: "/screens", screen: "current-added", inspect: null });
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Right panel view" })).toHaveCount(0);
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text"))
    .toHaveText("/current-added");
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Added");
  await expect(review).toHaveAccessibleName("Changes in /current-added");
  // A new screen shows its one screenshot with no Before or After: nothing to compare.
  await expect(before).toHaveCount(0);
  await expect(review.getByRole("button", { name: /^(Before|After)$/ })).toHaveCount(0);
  await expect(review.locator(".compare-side-label-reserved")).toBeHidden();
  await expect(review.getByText(/not in baseline/)).toHaveCount(0);
  await expect(after.locator("img")).toHaveAttribute(
    "src",
    /^\/api\/builds\/build-2\.0\.0\/artifacts\/artifacts\/screenshots\/current-added-primary\.svg\?sha256=[a-f0-9]{64}$/,
  );
  await expect.poll(() => after.locator("img").evaluate((image) => (
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  ))).toBe(true);
  // Findings are statements under What changed, not controls; the heading folds them away.
  const addedFacts = await whatChangedItems(page);
  await expect(addedFacts).toHaveText(["Added screen “Cat Care Guide”."]);
  await expect(page.getByRole("region", { name: "What changed on this screen" }).getByRole("button")).toHaveCount(0);
  await page.locator(".right-panel .what-changed-toggle").click();
  await expect(addedFacts).toHaveCount(0);
  await expect(diffPanel.locator(".screenshot-diff-figure figcaption")).toHaveCount(0);

  // Opening a row closed the menu; reopen it for the next row.
  await openChangesMenu(page);
  await changedRow.click();
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      screen: url.searchParams.get("screen"),
      inspect: url.searchParams.get("inspect"),
    };
  }).toEqual({ pathname: "/screens", screen: "current-profile", inspect: null });
  await expect(page.locator(
    '.screens-page .screens-cell[data-screen-id="current-profile"] .screen-screenshot-card.selected',
  )).toBeVisible();
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text"))
    .toHaveText("/current-profile");
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Modified");
  await expect(before.locator("img")).toHaveAttribute(
    "src",
    /^\/api\/builds\/build-1\.0\.0\/artifacts\/artifacts\/screenshots\/baseline-profile-primary\.svg\?sha256=[a-f0-9]{64}$/,
  );
  await expect(after.locator("img")).toHaveAttribute(
    "src",
    /^\/api\/builds\/build-2\.0\.0\/artifacts\/artifacts\/screenshots\/current-profile-reviewed\.svg\?sha256=[a-f0-9]{64}$/,
  );
  await expect(review.locator(".screenshot-placeholder")).toHaveCount(0);
  await expect(review.locator(".compare-side-label")).toHaveText(["Before", "After"]);
  // What changed lists every finding, then folds away again.
  const changedFacts = await whatChangedItems(page);
  await expect(changedFacts.filter({ hasText: "Changed button title from “A” to “B”." })).toHaveCount(1);
  await expect(changedFacts).toHaveCount(7);
  await page.locator(".right-panel .what-changed-toggle").click();
  await expect(changedFacts).toHaveCount(0);

  await expect.poll(() => after.locator("img").evaluate((image) => (
    image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
  ))).toBe(true);
  const diffMetrics = await page.locator(".right-panel").evaluate((panel) => {
    const preview = panel.querySelector<HTMLElement>('[data-side="after"] .compare-frame');
    const visual = panel.querySelector<HTMLElement>(".sidebar-review");
    if (!preview || !visual) throw new Error("Diff screenshot geometry is unavailable");
    const style = getComputedStyle(visual);
    return {
      panelWidth: panel.getBoundingClientRect().width,
      screenshotWidth: preview.getBoundingClientRect().width,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
    };
  });
  // The comparison shares the header's 14px inset; both sides stay inside the panel.
  expect(diffMetrics.paddingLeft).toBe(14);
  expect(diffMetrics.paddingRight).toBe(14);
  expect(diffMetrics.screenshotWidth * 2).toBeLessThanOrEqual(diffMetrics.panelWidth - 28);

  await page.setViewportSize({ width: 1180, height: 820 });
  await expect.poll(() => page.locator(".right-panel").evaluate(
    (panel) => panel.getBoundingClientRect().width,
  )).toBe(320);
  await expect(diffPanel).toBeVisible();
  const responsiveDiffWidth = await after.locator(".compare-frame").evaluate(
    (preview) => preview.getBoundingClientRect().width,
  );
  expect(responsiveDiffWidth * 2).toBeLessThanOrEqual(320 - 28);

  // Opening a row closed the menu; reopen it for the next row.
  await openChangesMenu(page);
  await removedRow.click();
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname,
      screen: url.searchParams.get("screen"),
      inspect: url.searchParams.get("inspect"),
    };
  }).toEqual({
    pathname: "/screens",
    screen: "removed:build-1.0.0:screen:baseline-legacy",
    inspect: null,
  });
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text"))
    .toHaveText("/baseline-legacy");
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Removed");
  await expect(before.locator("img")).toHaveAttribute(
    "src",
    /^\/api\/builds\/build-1\.0\.0\/artifacts\/artifacts\/screenshots\/baseline-legacy-primary\.svg\?sha256=[a-f0-9]{64}$/,
  );
  // A removed screen shows its one screenshot with no Before or After: nothing to compare.
  await expect(after).toHaveCount(0);
  await expect(review.getByRole("button", { name: /^(Before|After)$/ })).toHaveCount(0);
  await expect(review.locator(".compare-side-label-reserved")).toBeHidden();
  await expect(review.getByText(/not in this PR/)).toHaveCount(0);
  await expect(await whatChangedItems(page)).toHaveText(["Removed screen “Sweet Bee”."]);
  await expect(page.getByRole("tablist", { name: "Runtime evidence groups" })).toHaveCount(0);
});

test("reload max-fits the comparison overview with the Inspector collapsed", async ({ page }) => {
  test.setTimeout(90_000);
  await serveSyntheticWorkspace(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/map");
  await expect(page.locator(".react-flow__node-screen")).toHaveCount(SCREEN_COUNT);
  await expect(page.getByRole("button", { name: "Expand inspector" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".react-flow__node-screen")).toHaveCount(SCREEN_COUNT);
  await expect(page.getByRole("button", { name: "Expand inspector" })).toBeVisible();

  const viewport = page.locator(".map-canvas .react-flow__viewport");
  await expect(viewport).toBeVisible();
  await expect(page.locator(".map-canvas.canvas-projection-animating")).toHaveCount(0);
  const metrics = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".app-content")?.getBoundingClientRect();
    const flow = document.querySelector<HTMLElement>(".map-canvas")?.getBoundingClientRect();
    const viewportElement = document.querySelector<HTMLElement>(
      ".map-canvas .react-flow__viewport",
    );
    const nodeRects = [...document.querySelectorAll<HTMLElement>(
      ".map-canvas .react-flow__node",
    )].map((node) => node.getBoundingClientRect());
    if (!root || !flow || !viewportElement || nodeRects.length === 0) {
      throw new Error("Comparison overview geometry is unavailable");
    }
    const bounds = nodeRects.reduce((union, rect) => ({
      left: Math.min(union.left, rect.left),
      top: Math.min(union.top, rect.top),
      right: Math.max(union.right, rect.right),
      bottom: Math.max(union.bottom, rect.bottom),
    }), {
      left: Number.POSITIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    });
    const matrix = new DOMMatrixReadOnly(getComputedStyle(viewportElement).transform);
    const renderedWidth = bounds.right - bounds.left;
    const renderedHeight = bounds.bottom - bounds.top;
    const worldWidth = renderedWidth / matrix.a;
    const worldHeight = renderedHeight / matrix.a;
    const paddedScale = 1 - 0.04 * 2;
    const expectedZoom = Math.min(
      root.width * paddedScale / worldWidth,
      root.height * paddedScale / worldHeight,
      0.9,
    );
    const expectedOccupancy = Math.max(
      worldWidth * expectedZoom / root.width,
      worldHeight * expectedZoom / root.height,
    );
    return {
      nodeCount: nodeRects.length,
      zoom: matrix.a,
      expectedZoom,
      expectedOccupancy,
      widthOccupancy: renderedWidth / root.width,
      heightOccupancy: renderedHeight / root.height,
      centerDeltaX: (bounds.left + bounds.right - root.left - root.right) / 2,
      centerDeltaY: (bounds.top + bounds.bottom - root.top - root.bottom) / 2,
    };
  });

  expect(metrics.nodeCount).toBe(SCREEN_COUNT);
  expect(metrics.expectedZoom).toBeLessThanOrEqual(0.9);
  expect(metrics.zoom).toBeCloseTo(metrics.expectedZoom, 3);
  const occupancy = Math.max(metrics.widthOccupancy, metrics.heightOccupancy);
  expect(occupancy).toBeCloseTo(metrics.expectedOccupancy, 2);
  expect(Math.abs(metrics.centerDeltaX)).toBeLessThan(1);
  expect(Math.abs(metrics.centerDeltaY)).toBeLessThan(1);

  const settledTransform = await viewport.getAttribute("style");
  await page.waitForTimeout(450);
  await expect(viewport).toHaveAttribute("style", settledTransform!);
});

test("synthetic comparisons preserve search, fixed change headers, and before/after evidence", async ({ page }) => {
  await serveSyntheticWorkspace(page);
  await page.setViewportSize({ width: 1180, height: 600 });
  await page.goto("/map");
  await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", { name: "Search Explore" });
  await search.getByRole("combobox").fill("/general");
  await expect(search.getByRole("option").filter({ hasText: "/general" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  const menu = await openChangesMenu(page);
  await expect(menu.locator(".changes-panel-title .changes-panel-count")).toHaveText("31");
  const metrics = await menu.locator(".changes-panel").evaluate(async panel => {
    const header = panel.querySelector<HTMLElement>(".changes-panel-heading")!;
    const body = panel.querySelector<HTMLElement>(".changes-panel-body")!;
    const row = panel.querySelector<HTMLElement>(".changes-screen-row")!;
    const headerTop = header.getBoundingClientRect().top;
    const rowTop = row.getBoundingClientRect().top;
    body.scrollTop = 120;
    await new Promise<void>(done => requestAnimationFrame(() => done()));
    return { scrollTop: body.scrollTop, headerDelta: header.getBoundingClientRect().top - headerTop,
      rowDelta: row.getBoundingClientRect().top - rowTop };
  });
  expect(metrics).toEqual({ scrollTop: 120, headerDelta: 0, rowDelta: -120 });
  const shell = page.locator(".changes-panel-scroll-shell");
  await expect(shell).toHaveClass(/is-scrollable/);
  await expect(shell).toHaveClass(/is-scrolling/);
  await expect(page.locator(".changes-panel-scrollbar")).toHaveCSS("opacity", "1");
  await expect(shell).not.toHaveClass(/is-scrolling/, { timeout: 1500 });
  await page.goto("/map?screen=area-0-screen-1&inspect=diff");
  // A changed screen opens the sidebar review, with both builds side by side.
  const review = page.locator(".right-panel").getByRole("region", { name: /^Changes in / });
  await expect(page.locator(".right-panel .inspector-diff-status")).toHaveAttribute("aria-label", "Modified");
  await expect(review.locator(".compare-side-label")).toHaveText(["Before", "After"]);
  for (const [side, build] of [["before", "1.0.0"], ["after", "2.0.0"]]) {
    const image = review.locator(`[data-side="${side}"] .compare-frame img`);
    await expect(image).toHaveAttribute("src", new RegExp(`/api/builds/build-${build}/artifacts/`));
    await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(390);
  }
  await page.goto("/map?screen=area-0-screen-1&baseline=none&inspect=diff");
  await expect(page).not.toHaveURL(/inspect=diff/);
  await expect(page.locator(".collapsed-change-count")).toHaveCount(0);
  await expect(page.locator(".changes-panel")).toHaveCount(0);
  await expect(page.locator(".diff-frame.diff-modified")).toHaveCount(0);
});

/**
 * The merged inspector presents a changed screen's comparison first. Otherwise check the
 * carousel selection through its accessible tabs, without a visible position counter.
 */
async function expectVariantOrComparison(page: Page, position: string) {
  const inspector = page.locator(".right-panel .inspector");
  await expect(inspector).toBeVisible();
  if (await inspector.locator(".inspector-diff-compare").count()) {
    await expect(inspector.getByRole("group", { name: "Before to after comparison" })).toBeVisible();
    return;
  }
  const [selectedPosition, total] = position.split(" / ").map(Number);
  const tabs = inspector.locator('.variant-thumbnails [role="tab"]');
  await expect(tabs).toHaveCount(total!);
  await expect(tabs.nth(selectedPosition! - 1)).toHaveAttribute("aria-selected", "true");
}

test("capture and route-family deep links restore their representative and exact variant", async ({ page }) => {
  const map = captureAliasFixture() as ExploreMap;
  const evidence = viewerMapFixture().artifacts[0];
  map.artifacts = [evidence];
  for (const observation of map.observations) observation.screenshotArtifactId = evidence.id;
  await serveMap(page, { map, coverage: coverageForMap(map) } as Awaited<ReturnType<typeof liveMapPayload>>);
  await page.route("**/api/artifacts/**", route => route.fulfill({ contentType: "image/svg+xml", body: fixtureImage }));
  for (const [source, variant, position] of [["/map/mobbin/screens/2", "variant-capture-2", "2 / 3"],
    ["/screens/mobbin/screens/3", "variant-capture-3", "3 / 3"],
    ["/screens?screen=home-loaded", "variant-capture-3", "3 / 3"]]) {
    await page.goto(source);
    await expectVariantOrComparison(page, position);
    await expect.poll(() => ({ pathname: new URL(page.url()).pathname, variant: new URL(page.url()).searchParams.get("variant") }))
      .toEqual({ pathname: source.startsWith("/map") ? "/map/mobbin/screens/1" : "/screens/mobbin/screens/1", variant });
    await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text")).toHaveText("/home");
  }
  await expect(page.locator(".screens-page").getByRole("button", { name: "Home — Empty", exact: true })).toHaveCount(1);
});

test("normalizes removed comment inspector links to Session without losing the screen", async ({ page }) => {
  await page.goto("/map?screen=settings-root&inspect=comments&comment=legacy-thread&scope=screen");
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      screen: url.searchParams.get("screen"),
      inspect: url.searchParams.get("inspect"),
      comment: url.searchParams.get("comment"),
      scope: url.searchParams.get("scope"),
    };
  }).toEqual({ screen: "settings-root", inspect: null, comment: null, scope: null });
  await expect(page.locator(".right-panel .inspector")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Right panel view" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Comments" })).toHaveCount(0);
});

test("links from before path routing still open", async ({ page }) => {
  await page.goto("/#workspace/screens");
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.locator(".screens-page .screens-cell").first()).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/map$/);
  await page.goto("/#insights");
  await expect(page).toHaveURL(/\/map$/);
  await expect(page.getByRole("heading", { name: "UX Report" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Insights", exact: true })).toHaveCount(0);
});

test("a screen family's expo-router route is the URL path", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { __copiedDeepLink?: string }).__copiedDeepLink = value;
        },
      },
    });
  });
  const payload = await liveMapPayload(4, 100, true);
  payload.map.journeys = [{
    id: "live-route-journey",
    title: "Live route journey",
    screenIds: ["live-screen-1", "live-screen-2"],
    transitionIds: [],
    attemptIds: [],
  }];
  await serveMap(page, payload);
  await page.goto("/screens");
  const nodeFor = (id: string) => page.locator(`.screens-page .screens-cell[data-screen-id="${id}"] .screen-screenshot-card`);

  await nodeFor("live-screen-1").locator(".screen-screenshot-target").click();
  await expect(page).toHaveURL(/\/screens\/\(tabs\)\/live\/1$/);
  await page.goto(page.url());
  const inspectorPath = page.locator(".right-panel")
    .getByRole("button", { name: "Copy deep link /(tabs)/live/1" });
  await expect(inspectorPath).toHaveText("/(tabs)/live/1");
  await inspectorPath.click();
  await expect(page.getByText("Copied deep link", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => (window as unknown as { __copiedDeepLink?: string }).__copiedDeepLink,
  )).toBe("/(tabs)/live/1");
  await expect(nodeFor("live-screen-1")).toHaveClass(/selected/);
  await expect(page.locator(".right-panel")).toContainText("/(tabs)/live/1");

  // Two raw captures share a route, so only the representative is rendered and either id lands
  // on the same logical screen.
  await page.goto("/screens");
  await nodeFor("live-screen-2").locator(".screen-screenshot-target")
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page).toHaveURL(/\/screens\/\(tabs\)\/live\/shared$/);
  await expect(nodeFor("live-screen-3")).toHaveCount(0);
  await page.goto("/screens?screen=live-screen-3");
  await expect(page).toHaveURL(/\/screens\/\(tabs\)\/live\/shared$/);
  await expect(nodeFor("live-screen-2")).toHaveClass(/selected/);
  await expect(nodeFor("live-screen-3")).toHaveCount(0);
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text")).toHaveText("/(tabs)/live/shared");
  await page.goto("/map/(tabs)/live/shared");
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text")).toHaveText("/(tabs)/live/shared");

  // An id alone gains its route once the map is known.
  await page.goto("/screens?screen=live-screen-4");
  await expect(page).toHaveURL(/\/screens\/\(tabs\)\/live\/4$/);
  await expect(page.locator(".right-panel .inspector-mode-copy .screen-path-text")).toHaveText("/(tabs)/live/4");
});

test("PR tooltips stay inside the viewport and track their trigger", async ({ page }) => {
  await serveWorkspace(page, { catalogName: "Example pull request" });
  await page.goto("/screens");
  const link = page.getByRole("link", { name: "PR #550 on GitHub" });
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 760 });
    await link.hover();
    const tooltip = page.locator(".tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("pilot/explore-changes → pilot/explore-base");
    const box = await tooltip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8);
    expect(box!.y).toBeGreaterThanOrEqual(8);
    expect(box!.y + box!.height).toBeLessThanOrEqual(752);
    await page.mouse.move(width - 2, 758);
  }
  // At phone widths the pill is the header, and it keeps the PR link beside the app name.
  await page.setViewportSize({ width: 420, height: 760 });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", /\/pull\/550$/);
  await page.setViewportSize({ width: 900, height: 760 });
  // Exercise the opposite edge and vertical flip without depending on another screen layout.
  await link.locator("..").evaluate(element => {
    Object.assign((element as HTMLElement).style, { position: "fixed", left: "600px", top: "710px", width: "190px" });
  });
  await link.hover();
  const tooltip = page.locator(".tooltip");
  await expect(tooltip).toHaveClass(/tooltip-top/);
  const box = await tooltip.boundingBox();
  // The pill's backdrop filter makes it the fixed containing block, so read the moved trigger.
  const linkBox = await link.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(900 - 8);
  expect(box!.y + box!.height).toBeLessThan(linkBox!.y);
});

test("pull-request comment deep links open the Changes filter and a surface's Diff inspector and keep the workspace", async ({ page }) => {
  await serveStaticWorkspace(page);
  // The local authenticated host locks `connect-src` to itself; drop it for the public-export scenario.
  await page.route("**/map?**", async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    delete headers["content-security-policy"];
    await route.fulfill({ response, headers });
  });
  const workspaceUrl = "http://127.0.0.1:4999/runtime/workspace.json";
  const artifactsUrl = "http://127.0.0.1:4999/runtime/artifacts";
  const base = `/map?workspace=${encodeURIComponent(workspaceUrl)}&artifacts=${encodeURIComponent(artifactsUrl)}`;
  const rows = page.locator(".changes-panel .changes-screen-list").getByRole("button");
  const chips = page.getByRole("group", { name: "Filter changes" });
  const checked = (label: string) => chips.getByRole("button", { name: new RegExp(`^${label}`) }).getAttribute("aria-pressed");

  // "Open Explore": the review opens on the Map with every status; the list is one click away.
  await page.goto(base);
  await openChangesMenu(page);
  await expect(rows).toHaveCount(6);
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(workspaceUrl);

  // A count link: only that status is selected in the filter and listed.
  await page.goto(`${base}&focus=added&inspect=diff`);
  await openChangesMenu(page);
  await expect(rows).toHaveText(["/current-added"]);
  expect(await checked("Added")).toBe("true");
  expect(await checked("Modified")).toBe("false");
  expect(await checked("Removed")).toBe("false");

  await page.goto(`${base}&focus=modified&inspect=diff`);
  await openChangesMenu(page);
  await expect(rows).toHaveCount(4);
  await expect(page.locator(".changes-panel .changes-screen-row:not(.diff-modified)")).toHaveCount(0);

  await page.goto(`${base}&focus=removed&inspect=diff`);
  await openChangesMenu(page);
  await expect(rows).toHaveText(["/baseline-legacy"]);
  await page.keyboard.press("Escape");

  // A screenshot's route link: the surface is selected and the sidebar review shows both sides.
  await page.goto(`${base}&screen=current-profile&inspect=diff`);
  const review = page.locator(".right-panel").getByRole("region", { name: "Changes in /current-profile" });
  await expect(review).toBeVisible();
  await expect(review.locator(".compare-frame img")).toHaveCount(2);
  await expect(page).toHaveURL(/inspect=diff/);
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(workspaceUrl);

  // Internal navigation keeps the workspace so every later link still resolves the same review.
  await page.getByRole("button", { name: "Screens", exact: true }).click();
  await expect(page).toHaveURL(/\/screens\?/);
  expect(new URL(page.url()).searchParams.get("workspace")).toBe(workspaceUrl);
});

test("desktop Compare: one command bar with the modes in it, even gaps to both bars", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 });
  await serveWorkspace(page);
  await page.goto("/compare?screen=current-profile");
  const compare = page.locator(".compare-section");
  const bar = compare.locator(".compare-bar");
  await expect(bar).toBeVisible();

  // The bar holds the screen, its place in the review and what to look for; the toolbar no pager.
  await expect(bar.locator(".compare-nav-route")).toHaveText("/current-profile");
  await expect(bar.locator(".compare-nav-position")).toHaveText(/^\d+ of \d+$/);
  await expect(bar.getByRole("button", { name: "Highlight changes" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "What changed" })).toBeVisible();
  // Every control in the bar fits its own box and none overlaps the next.
  const overlaps = await bar.evaluate((element) => {
    // The mode switch's highlight layer repeats its buttons over themselves; only the real ones count.
    const controls = [...element.querySelectorAll<HTMLElement>("button:not(.toggle-overlay *), .compare-nav-position")];
    const spills = controls.filter((control) => control.scrollWidth > control.clientWidth + 1).map((control) => control.textContent);
    const boxes = controls.map((control) => control.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    const crossings = boxes.slice(1).filter((box, index) => box.left < boxes[index]!.right - 1).length;
    return { spills, crossings };
  });
  expect(overlaps).toEqual({ spills: [], crossings: 0 });
  const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
  await expect(toolbar.getByRole("button", { name: /changed screen/ })).toHaveCount(0);
  // The bottom toolbar keeps the width it has on every other section: Compare's controls are in its own bar.
  const toolbarWidth = (await toolbar.boundingBox())!.width;
  await page.goto("/screens");
  await expect.poll(async () => Math.round(Math.abs((await toolbar.boundingBox())!.width - toolbarWidth))).toBeLessThanOrEqual(1);
  await page.goBack();
  await expect(bar).toBeVisible();
  await expect(compare.locator(".compare-footer")).toHaveCount(0);

  // Split, Swipe, Flip in that order, in Compare's own bar; the bottom toolbar has none.
  const modes = bar.getByRole("group", { name: "Comparison mode" }).getByRole("button");
  await expect(modes).toHaveText(["Split", "Swipe", "Flip"]);
  await expect(toolbar.getByRole("group", { name: "Comparison mode" })).toHaveCount(0);

  // The screenshots keep the same gap to the bar above and the toolbar below.
  await modes.first().click();
  await expect(modes.first()).toHaveAttribute("aria-pressed", "true");
  const gaps = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      top: box(".compare-side-label").top - box(".compare-bar").bottom,
      bottom: box(".canvas-toolbar").top - box(".compare-frame").bottom,
    };
  });
  expect(Math.abs(gaps.top - gaps.bottom)).toBeLessThanOrEqual(2);

  // ‹ › step through changed screens, as ← and → do.
  const position = bar.locator(".compare-nav-position");
  const before = Number((await position.textContent())!.split(" ")[0]);
  await bar.getByRole("button", { name: "Next changed screen" }).click();
  await expect(position).toHaveText(new RegExp(`^${before + 1} of `));
  await page.keyboard.press("ArrowLeft");
  await expect(position).toHaveText(new RegExp(`^${before} of `));

  // Holding → keeps stepping, each step sooner than the last; releasing stops where it is.
  const current = async () => Number((await position.textContent())!.split(" ")[0]);
  const total = Number((await position.textContent())!.split(" of ")[1]);
  await page.keyboard.down("ArrowRight");
  await expect(position).toHaveText(new RegExp(`^${before + 1} of `));
  await expect.poll(current, { timeout: 4000 }).toBeGreaterThanOrEqual(Math.min(total, before + 3));
  await page.keyboard.up("ArrowRight");
  const held = await current();
  await page.waitForTimeout(600);
  await expect(position).toHaveText(new RegExp(`^${held} of `));
  await page.keyboard.down("ArrowLeft");
  await expect.poll(current, { timeout: 6000 }).toBe(1);
  await page.keyboard.up("ArrowLeft");
  for (let step = 1; step < before; step += 1) await page.keyboard.press("ArrowRight");
  await expect(position).toHaveText(new RegExp(`^${before} of `));

  // In Swipe, [ and ] nudge the divider; held, ] keeps going until it is released or at the edge.
  await page.keyboard.press("2");
  const divider = compare.getByRole("slider");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("BracketLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "45");
  const dividerAt = async () => Number(await divider.getAttribute("aria-valuenow"));
  await page.keyboard.down("BracketRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await expect.poll(dividerAt, { timeout: 4000 }).toBeGreaterThanOrEqual(65);
  await page.keyboard.up("BracketRight");
  const dividerHeld = await dividerAt();
  await page.waitForTimeout(600);
  expect(await dividerAt()).toBe(dividerHeld);
  await page.keyboard.down("BracketRight");
  await expect.poll(dividerAt, { timeout: 8000 }).toBe(100);
  await page.keyboard.up("BracketRight");
  await page.keyboard.press("1");

  // The bar keeps one size whatever the route, so Next stays under the pointer: it can be clicked
  // again and again through screens whose routes differ in length.
  const nextButton = bar.getByRole("button", { name: "Next changed screen" });
  const nextBox = async () => {
    const box = (await nextButton.boundingBox())!;
    return `${Math.round(box.x)},${Math.round(box.y)}`;
  };
  await page.goto("/compare?screen=current-added");
  const places = new Set([await nextBox()]);
  while (await nextButton.isEnabled()) {
    const route = await bar.locator(".compare-nav-route").textContent();
    await nextButton.click();
    await expect(bar.locator(".compare-nav-route")).not.toHaveText(route!);
    places.add(await nextBox());
  }
  expect([...places]).toHaveLength(1);
  await page.goto("/compare?screen=current-profile");

  // What changed opens as a popover under the bar: findings as bullets; Esc closes it.
  await bar.getByRole("button", { name: "What changed" }).click();
  const popover = page.getByRole("dialog", { name: "What changed" });
  await expect(popover.getByRole("region", { name: "What changed on this screen" }).locator("li").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  // A desktop window keeps the pill on the bar's row, clear of the bar. A tablet (820–1180px) keeps
  // the desktop design but leaves the pill out, so the bar has the top row to itself.
  const pill = page.locator(".left-panel-collapsed-pill");
  const barTop = async () => Math.round((await page.locator(".compare-bar").boundingBox())!.y);
  const desktopTop = await barTop();
  await expect(pill).toBeVisible();
  const [pillBox, barBox] = await Promise.all([pill.boundingBox(), page.locator(".compare-bar").boundingBox()]);
  expect(Math.abs(pillBox!.y + pillBox!.height / 2 - (barBox!.y + barBox!.height / 2))).toBeLessThanOrEqual(4);
  expect(barBox!.x).toBeGreaterThan(pillBox!.x + pillBox!.width);
  for (const width of [1100, 860]) {
    await page.setViewportSize({ width, height: 760 });
    await expect(pill).toBeHidden();
    await expect.poll(barTop).toBe(desktopTop);
  }
  await page.setViewportSize({ width: 1100, height: 760 });

  // A new screen shows its one screenshot with no Before or After: nothing to compare. Their row
  // stays, unseen, so the frame starts where a compared screen's does. The mode switch is off with
  // no mode current, and back on a comparable screen the chosen mode is as it was.
  const frameTop = async () => (await compare.locator(".compare-frame").first().boundingBox())!.y;
  const comparedTop = await frameTop();
  await page.goto("/compare?screen=current-added");
  for (const button of await modes.all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }
  await expect(compare.getByRole("button", { name: /^(Before|After)$/ })).toHaveCount(0);
  await expect(compare.locator(".compare-side-label-reserved")).toHaveCount(1);
  await expect(compare.locator(".compare-side-label-reserved")).toBeHidden();
  expect(Math.abs((await frameTop()) - comparedTop)).toBeLessThanOrEqual(1);
  await expect(compare.getByText(/not in baseline|There is no Before/)).toHaveCount(0);
  await bar.getByRole("button", { name: "What changed" }).click();
  await expect(popover).toContainText("This screen is new in this PR.");
  await page.keyboard.press("Escape");
  await page.goto("/compare?screen=current-profile");
  await expect(modes.first()).toHaveAttribute("aria-pressed", "true");
  await expect(modes.first()).toBeEnabled();
});

test("the toolbar names every section and changes width smoothly between them", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveWorkspace(page);
  await page.goto("/map");
  await page.waitForTimeout(800);
  const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
  for (const target of ["Screens", "Compare", "Map", "Compare", "Screens"]) {
    const samples = await page.evaluate(async (name) => {
      const bar = document.querySelector<HTMLElement>(".canvas-toolbar")!;
      const button = [...bar.querySelectorAll<HTMLButtonElement>(".toolbar-button")].find((b) => b.getAttribute("aria-label") === name)!;
      const label = button.querySelector<HTMLElement>(".toolbar-view-label")!;
      const out: { t: number; w: number; reveal: number; opacity: number }[] = [];
      const start = performance.now();
      const full = label.querySelector("span")!.scrollWidth;
      button.click();
      await new Promise<void>((resolve) => {
        const tick = () => {
          const t = performance.now() - start;
          out.push({ t: Math.round(t), w: Math.round(bar.getBoundingClientRect().width), reveal: +(label.getBoundingClientRect().width / full).toFixed(2), opacity: +(+getComputedStyle(label).opacity).toFixed(2) });
          if (t < 500) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      return out;
    }, target);
    const widths = samples.map((s) => s.w);
    const steps = widths.slice(1).map((w, i) => Math.abs(w - widths[i]!));
    // No frame jumps (leaving Compare once dropped 170px in one frame; frames can be slow on CI).
    expect(Math.max(...steps), `${target}: ${widths.join(",")}`).toBeLessThan(100);
    // Every section keeps its name in view, open or not.
    expect(samples.filter((s) => s.reveal < 0.99 || s.opacity < 0.99)).toEqual([]);
    await expect(toolbar.getByRole("button", { name: target, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(300);
  }
});

/* ── Phone layout ─────────────────────────────────────────────────────────────
   Below 820px the canvases become lists, the Inspector a bottom sheet and the toolbar a tab bar.
   An iPhone 15 in Safari leaves 393 × 659 for the page. */
test.describe("phone layout", () => {
  test.use({ viewport: { width: 393, height: 659 }, hasTouch: true, isMobile: true });

  async function expectNoHorizontalOverflow(page: Page) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }

  /** The visible text under `scope` whose size is off the phone type scale (see phone.css), as "size text". */
  async function offScaleText(page: Page, scope: string) {
    // title 22, headline 17, field 16, body 15 (mono 14), subhead 13 (mono 12), caption 11, micro 10.
    const scale = ["22px", "17px", "16px", "15px", "14px", "13px", "12px", "11px", "10px"];
    return page.evaluate(({ selector, sizes }) => {
      const off: string[] = [];
      for (const root of document.querySelectorAll(selector)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode.textContent?.trim();
          const element = walker.currentNode.parentElement;
          // Map cards zoom with the canvas; their type is not the page's.
          if (!text || !element || element.closest(".react-flow__node")) continue;
          if (element.getBoundingClientRect().width === 0) continue;
          const size = getComputedStyle(element).fontSize;
          if (!sizes.includes(size)) off.push(`${size} ${text.slice(0, 24)}`);
        }
      }
      return off;
    }, { selector: scope, sizes: scale });
  }

  test("every phone view sets its text on the phone type scale", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/screens");
    await expect(page.locator(".screens-page .screens-filter")).toBeVisible();
    expect(await offScaleText(page, "body")).toEqual([]);
    // Changed / All are the neutral chips of the Changes menu, not a filled primary button.
    const changed = page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Changed/ });
    await expect(changed).toHaveAttribute("aria-pressed", "true");
    expect(await changed.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--selected").trim())
        .then((hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`));

    await page.goto("/compare?screen=current-profile");
    await expect(page.locator(".phone-compare")).toBeVisible();
    expect(await offScaleText(page, "body")).toEqual([]);
    await page.locator(".compare-nav-picker").tap();
    await expect(page.locator(".changes-menu")).toBeVisible();
    expect(await offScaleText(page, ".changes-menu")).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "What changed" }).tap();
    await expect(page.getByRole("dialog", { name: "What changed" })).toBeVisible();
    expect(await offScaleText(page, ".phone-sheet")).toEqual([]);

    await page.goto("/map?screen=current-profile");
    const inspector = page.getByRole("complementary", { name: "Inspector panel" });
    await expect(inspector).toBeVisible();
    await inspector.locator(".what-changed-toggle").tap();
    expect(await offScaleText(page, ".right-panel")).toEqual([]);

    await page.goto("/map");
    await page.getByRole("button", { name: "Search", exact: true }).tap();
    await page.keyboard.type("c");
    await expect(page.locator(".search-command-section-label").first()).toBeVisible();
    expect(await offScaleText(page, ".search-command")).toEqual([]);
    // iOS zooms into any field under 16px.
    expect(await page.locator(".search-command-input-row input").evaluate((element) => getComputedStyle(element).fontSize))
      .toBe("16px");
  });

  test("the Map tab is the map itself: no area list; a screen opens the Inspector full screen, and so does Search", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    const tabs = page.getByRole("navigation", { name: "Views" });
    await expect(tabs).toBeVisible();
    // Desktop chrome is gone: the floating toolbar with its shortcuts button, the camera controls
    // and the minimap.
    await expect(page.getByRole("toolbar", { name: "Canvas tools" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expect(page.locator(".canvas-camera-controls")).toHaveCount(0);
    await expect(tabs.getByRole("button", { name: /Compare/ })).toBeEnabled();

    await expect(page.getByRole("main", { name: "Areas" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /area list|map canvas/ })).toHaveCount(0);
    const screens = page.locator(".map-canvas .react-flow__node-screen");
    await expect(screens.first()).toBeVisible();
    await expect(page).toHaveURL(/\/map$/);
    await expectNoHorizontalOverflow(page);

    // The Inspector covers the map, so the first tap only selects the screen: it gets its ring and
    // the Open hint, the URL names it, and the map stays. The second tap opens the Inspector as a
    // full-screen view over the map, not a bottom sheet.
    const target = screens.first().locator(".screen-screenshot-target");
    await target.evaluate((element) => (element as HTMLButtonElement).click());
    const inspector = page.getByRole("complementary", { name: "Inspector panel" });
    await expect(screens.first().locator(".screen-screenshot-card")).toHaveClass(/selected/);
    await expect(page).toHaveURL(/screen=/);
    await expect(screens.first().locator(".screen-open-hint")).toBeVisible();
    await expect(inspector).toHaveCount(0);
    await target.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(inspector).toBeVisible();
    await expect.poll(async () => (await inspector.boundingBox())?.width).toBe(393);
    await expect.poll(async () => (await inspector.boundingBox())?.height).toBe(659);
    expect(await inspector.evaluate((element) => [getComputedStyle(element).position, getComputedStyle(element).top])).toEqual(["fixed", "0px"]);
    await inspector.getByRole("button", { name: "Close inspector" }).tap();
    await expect(inspector).toHaveCount(0);

    // Search is full screen too, closed by its X.
    await page.getByRole("button", { name: "Search", exact: true }).tap();
    const search = page.getByRole("dialog", { name: /Search/ });
    await expect(search).toBeVisible();
    await expect.poll(async () => (await search.boundingBox())?.height).toBe(659);
    expect(await search.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("0px");
    await page.getByRole("button", { name: "Close search" }).tap();
    await expect(search).toHaveCount(0);
  });

  test("Fit starts a column of screens below the floating chrome", async ({ page }) => {
    // A hub with more destinations than the map is deep lays out as a column on the phone.
    const payload = await liveMapPayload(6, 1);
    const at = new Date().toISOString();
    payload.map.transitions = payload.map.screens.slice(1).map((screen, index) => ({
      id: `tr-${index}`, fromScreenId: payload.map.screens[0]!.id, toScreenId: screen.id, actionKind: "tap" as const,
      firstObservedAt: at, lastObservedAt: at, attemptIds: [],
    }));
    payload.coverage.transitions = payload.map.transitions.length;
    await serveMap(page, payload);
    await page.goto("/map");
    const first = page.locator(".map-canvas .react-flow__node-screen").first();
    await expect(first).toBeVisible();
    const chrome = await page.locator(".left-panel-collapsed-pill").boundingBox();
    expect(chrome).not.toBeNull();
    // Anchored just under the chrome, not centred in the canvas.
    const below = chrome!.y + chrome!.height;
    await expect.poll(async () => (await first.boundingBox())?.y ?? 0).toBeGreaterThanOrEqual(below);
    await expect.poll(async () => (await first.boundingBox())?.y ?? 0).toBeLessThanOrEqual(below + 40);
  });

  test("Screens is a two-column grid in sections, changed screens first", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Screens" }).tap();
    await expect(page).toHaveURL(/\/screens/);
    const grid = page.getByRole("main", { name: "Screens" });
    const cells = grid.locator(".screens-cell");
    await expect(cells.first()).toBeVisible();
    // Two columns: each screenshot is close to half the window wide.
    const cell = await cells.first().boundingBox();
    expect(cell?.width).toBeGreaterThan(160);
    expect(cell?.width).toBeLessThan(185);
    // The sections are one tap away: a jump bar under the heading and the whole tree in a sheet.
    await expect(grid.getByRole("navigation", { name: "Sections" })).toBeVisible();
    await grid.getByRole("button", { name: "Tree" }).tap();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    const changedCount = await cells.count();
    await grid.getByRole("button", { name: /^All/ }).tap();
    await expect.poll(() => cells.count()).toBeGreaterThan(changedCount);
    // Scrolled, the jump bar rests right under the top bar, not a bar's height below it.
    await grid.evaluate(main => main.scrollTo(0, 600));
    const pill = await page.locator(".phone-layout .left-panel.collapsed").boundingBox();
    const jump = await grid.getByRole("navigation", { name: "Sections" }).boundingBox();
    expect(Math.abs(jump!.y - pill!.y - pill!.height)).toBeLessThanOrEqual(2);
    // A card's status pill scrolled under the bar paints below it, not over it. Hit testing cannot
    // see the pill (pointer-events: none), so this reads the pixels.
    const under = await page.evaluate(async () => {
      const main = document.querySelector(".screens-page")!;
      const bar = document.querySelector(".screens-jump")!;
      const label = document.querySelectorAll(".screens-cell .diff-label")[1] as HTMLElement;
      const b = bar.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      main.scrollTop += l.top + l.height / 2 - (b.top + b.height / 2);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = label.getBoundingClientRect();
      const [red, green, blue] = getComputedStyle(label).backgroundColor.match(/[\d.]+/g)!.map(Number);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, pill: [red, green, blue] };
    });
    const shot = PNG.sync.read(await page.screenshot({ clip: { x: under.x - 2, y: under.y - 2, width: 5, height: 5 } }));
    const pixels: number[][] = [];
    for (let i = 0; i < shot.data.length; i += 4) pixels.push([shot.data[i], shot.data[i + 1], shot.data[i + 2]]);
    const pillColoured = pixels.filter(p => Math.hypot(p[0] - under.pill[0], p[1] - under.pill[1], p[2] - under.pill[2]) < 40);
    expect(pillColoured).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });

  test("a screen picked from search shows on Screens even when Changed hides it", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/screens");
    const grid = page.getByRole("main", { name: "Screens" });
    const cells = grid.locator(".screens-cell");
    const ids = () => cells.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-screen-id")!));
    await expect(grid.getByRole("button", { name: /^Changed/ })).toHaveAttribute("aria-pressed", "true");
    const changed = new Set(await ids());
    await grid.getByRole("button", { name: /^All/ }).tap();
    await expect.poll(async () => (await ids()).length).toBeGreaterThan(changed.size);
    const unchanged = (await ids()).find((id) => !changed.has(id))!;
    const title = (await grid.locator(`.screens-cell[data-screen-id="${unchanged}"] .screen-node-title`).textContent())!.trim();
    await grid.getByRole("button", { name: /^Changed/ }).tap();
    await expect(grid.locator(`.screens-cell[data-screen-id="${unchanged}"]`)).toHaveCount(0);

    await page.getByRole("button", { name: "Search", exact: true }).tap();
    const search = page.getByRole("dialog", { name: /Search/ });
    await search.getByRole("combobox").fill(title);
    await search.getByRole("option").filter({ hasText: title }).first().tap();
    const cell = grid.locator(`.screens-cell[data-screen-id="${unchanged}"]`);
    await expect(cell).toBeInViewport();
    await expect(cell.locator(".screen-screenshot-card")).toHaveClass(/selected/);
    await expect(grid.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
    // The pick shows the screen on Screens; the Inspector, which would cover the page and the pill, stays closed.
    await expect(page.getByRole("complementary", { name: "Inspector panel" })).toBeHidden();

    // Picking the selected screen again brings it back after scrolling away.
    await grid.evaluate((element) => { element.scrollTop = element.scrollTop > 400 ? 0 : element.scrollHeight; });
    await expect(cell).not.toBeInViewport();
    await page.getByRole("button", { name: "Search", exact: true }).tap();
    await search.getByRole("combobox").fill(title);
    await search.getByRole("option").filter({ hasText: title }).first().tap();
    await expect(cell).toBeInViewport();
  });

  test("a screen without a screenshot keeps a screenshot-shaped frame", async ({ page }) => {
    // Like a screen the source names but CI never captured: the map records no screenshots.
    const stripScreenshots = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripScreenshots);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== "screenshotArtifactId")
        .map(([key, entry]) => [key, stripScreenshots(entry)]));
    };
    await page.route((url) => url.pathname === "/api/map" || url.pathname === "/api/workspace", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      await route.fulfill({ response, json: stripScreenshots(await response.json()) });
    });
    await page.goto("/screens");
    const placeholder = page.getByRole("main", { name: "Screens" }).locator(".screens-cell .image-placeholder").first();
    await expect(placeholder).toBeVisible();
    const box = (await placeholder.boundingBox())!;
    expect(box.width).toBeGreaterThan(100);
    expect(box.height / box.width).toBeGreaterThan(1.8);
  });

  test("a tap near either side of Compare steps through the screens; a tap in the middle still flips", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /Compare/ }).tap();
    const compare = page.locator(".phone-compare");
    const flip = compare.getByRole("button", { name: /^Flip/ });
    const next = compare.getByRole("button", { name: "Next changed screen" });
    const previous = compare.getByRole("button", { name: "Previous changed screen" });
    while (await flip.isDisabled() && await next.isEnabled()) {
      const before = page.url();
      await next.tap();
      await expect.poll(() => page.url()).not.toBe(before);
    }
    const position = compare.locator(".compare-nav-position");
    const at = Number((await position.textContent())!.split(" ")[0]);
    const stage = (await compare.locator(".phone-compare-stage").boundingBox())!;
    const middle = stage.y + stage.height / 2;

    // The middle of a Flip frame shows the other side and stays on the screen.
    const frame = compare.locator(".compare-flip-frame");
    const side = await frame.getAttribute("aria-label");
    await page.touchscreen.tap(stage.x + stage.width / 2, middle);
    await expect(frame).not.toHaveAttribute("aria-label", side!);
    await expect(position).toHaveText(new RegExp(`^${at} of `));

    // Either side steps, as the header's steps do, and does not flip.
    expect(await next.isEnabled() || await previous.isEnabled()).toBe(true);
    if (await next.isEnabled()) {
      await page.touchscreen.tap(stage.x + 8, middle);
      if (at > 1) await expect(position).toHaveText(new RegExp(`^${at - 1} of `));
      await page.touchscreen.tap(stage.x + stage.width - 8, middle);
      await expect(position).toHaveText(new RegExp(`^${at === 1 ? 2 : at} of `));
    } else {
      await page.touchscreen.tap(stage.x + 8, middle);
      await expect(position).toHaveText(new RegExp(`^${at - 1} of `));
    }
  });

  test("Compare is full screen, opens in Flip and steps from the header", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /Compare/ }).tap();
    await expect(page).toHaveURL(/\/compare/);
    const compare = page.locator(".phone-compare");
    await expect(compare).toBeVisible();
    // The tab bar stays, like on every view; the pill gives Compare its height back, and there is no Back button.
    await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
    await expect(page.locator(".left-panel-collapsed-pill")).toHaveCount(0);
    await expect(compare.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // Step to the first screen with both a Before and an After. Each tap moves the URL on.
    const flip = compare.getByRole("button", { name: /^Flip/ });
    const next = compare.getByRole("button", { name: "Next changed screen" });
    while (await flip.isDisabled() && await next.isEnabled()) {
      const before = page.url();
      await next.tap();
      await expect.poll(() => page.url()).not.toBe(before);
    }
    // Taps never leave a tooltip open.
    await expect(page.locator(".tooltip")).toHaveCount(0);
    // A phone opens in Flip; desktop keeps its own remembered mode.
    await expect(flip).toHaveAttribute("aria-pressed", "true");

    // A comparable screen shows one frame, as tall as the room between the chrome allows, inside the stage.
    const frame = compare.locator(".compare-frame").first();
    await expect(frame).toBeVisible();
    const frameBox = (await frame.boundingBox())!;
    expect(frameBox.width).toBeGreaterThan(120);
    const stageBox = (await compare.locator(".phone-compare-stage").boundingBox())!;
    expect(frameBox.y + frameBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height + 1);
    const tabs = (await page.getByRole("navigation", { name: "Views" }).boundingBox())!;
    expect(frameBox.y + frameBox.height).toBeLessThan(tabs.y);
    // The mode switch is compact so the frame gets the height, and Flip's one frame is centred.
    const modes = (await compare.locator(".phone-compare-modes .toggle-group").boundingBox())!;
    expect(modes.height).toBeLessThanOrEqual(40);
    const compareBox = (await compare.boundingBox())!;
    expect(Math.abs(frameBox.x + frameBox.width / 2 - (compareBox.x + compareBox.width / 2))).toBeLessThanOrEqual(2);

    // The steps live in the header, beside the picker; there is no bottom row.
    const header = compare.locator(".phone-compare-head");
    await expect(header.getByRole("button", { name: "Next changed screen" })).toBeVisible();
    await expect(compare.locator(".phone-compare-foot")).toHaveCount(0);
    const headerBox = (await header.boundingBox())!;
    expect(headerBox.height).toBeLessThanOrEqual(58);
    // One line names the screen by its route; the position sits between the steps that change it.
    const steps = header.getByRole("group", { name: "Step through changed screens" });
    const position = steps.locator(".compare-nav-position");
    await expect(position).toHaveText(/^\d+ of \d+$/);
    const before = Number((await position.textContent())!.split(" ")[0]);
    if (await steps.getByRole("button", { name: "Next changed screen" }).isEnabled()) {
      await steps.getByRole("button", { name: "Next changed screen" }).tap();
      await expect(position).toHaveText(new RegExp(`^${before + 1} of `));
      await steps.getByRole("button", { name: "Previous changed screen" }).tap();
      await expect(position).toHaveText(new RegExp(`^${before} of `));
    }

    // Every mode names Before and After in a row above the screenshot, as Flip does.
    for (const name of [/^Swipe/, /^Split/]) {
      await compare.getByRole("button", { name }).tap();
      const label = compare.locator(".compare-side-label").first();
      await expect(label).toBeVisible();
      const firstFrame = compare.locator(".compare-frame, .visual-swipe").first();
      expect((await label.boundingBox())!.y).toBeLessThan((await firstFrame.boundingBox())!.y);
      await expect(compare.locator(".compare-side-tag, .visual-swipe-label")).toHaveCount(0);
    }
    await flip.tap();

    // What changed is an icon button; its sheet takes half the screen over a scrim that closes it.
    const facts = header.getByRole("button", { name: "What changed" });
    if (await facts.isEnabled()) {
      await facts.tap();
      const sheet = page.getByRole("dialog", { name: "What changed" });
      await expect(sheet).toBeVisible();
      const viewport = page.viewportSize()!;
      await expect.poll(async () => (await sheet.boundingBox())?.y).toBeGreaterThan(viewport.height * 0.45);
      await sheet.getByRole("button", { name: "Close" }).tap();
      await expect(sheet).toHaveCount(0);
      await facts.tap();
      await expect(sheet).toBeVisible();
      await page.mouse.click(viewport.width / 2, 40);
      await expect(sheet).toHaveCount(0);
    }

    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Map" }).tap();
    await expect(page).toHaveURL(/\/map/);
    await expect(page.locator(".map-canvas")).toBeVisible();
  });

  test("Compare shows a new screen in Flip, and its menu and sheet scroll on a short screen", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /Compare/ }).tap();
    const compare = page.locator(".phone-compare");
    const header = compare.locator(".phone-compare-head");
    const next = header.getByRole("button", { name: "Next changed screen" });

    // A screen with one screenshot opens in Flip: its missing side is dimmed and nothing notes it.
    const added = header.getByRole("img", { name: "Added" });
    // The picker's glyph names the screen's status once the diff is in; stepping before that
    // would walk past the added screen (the first) and never come back.
    await expect(header.locator(".compare-nav-picker [role='img']")).toBeVisible();
    while (await added.count() === 0 && await next.isEnabled()) {
      const before = page.url();
      await next.tap();
      await expect.poll(() => page.url()).not.toBe(before);
    }
    await expect(added).toBeVisible();
    // Nothing to compare: the mode switch is off as a whole, with no mode current.
    const phoneModes = compare.getByRole("group", { name: "Comparison mode" }).getByRole("button");
    for (const button of await phoneModes.all()) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-pressed", "false");
    }
    await expect(compare.locator(".compare-side-label-reserved")).toBeHidden();
    await expect(compare.locator(".compare-frame")).toHaveCount(1);
    await expect(compare.getByText(/not in baseline/)).toHaveCount(0);

    // The picker marks the screen with the glyph its row has in the Changes menu.
    await expect(header.locator(".status-icon")).toHaveCount(0);
    await page.setViewportSize({ width: 393, height: 380 });
    await header.locator(".compare-nav-picker").tap();
    const menuList = page.locator(".changes-menu .changes-panel-body");
    await expect(menuList).toBeVisible();
    const menuBox = (await page.locator(".changes-menu").boundingBox())!;
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(380);
    const menuScroll = await menuList.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { overflow: element.scrollHeight > element.clientHeight, top: element.scrollTop };
    });
    expect(menuScroll.overflow).toBe(true);
    expect(menuScroll.top).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".changes-menu")).toHaveCount(0);

    // The What changed sheet keeps its head and scrolls its findings (this screen has seven).
    await page.goto("/compare?screen=current-profile");
    const facts = header.getByRole("button", { name: "What changed" });
    await expect(facts).toBeEnabled();
    await facts.tap();
    const sheet = page.getByRole("dialog", { name: "What changed" });
    await expect(sheet).toBeVisible();
    const body = sheet.locator(".phone-sheet-body");
    const sheetScroll = await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { overflow: element.scrollHeight > element.clientHeight, top: element.scrollTop };
    });
    expect(sheetScroll.overflow).toBe(true);
    expect(sheetScroll.top).toBeGreaterThan(0);
    // Measured once the slide-in has finished.
    await expect.poll(async () => {
      const box = (await sheet.boundingBox())!;
      return box.y + box.height;
    }).toBeLessThanOrEqual(381);
  });

  test("the Inspector's modes are one tab group across the panel; its header highlights and opens in Compare; What changed folds", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: /Compare/ }).tap();
    const compare = page.locator(".phone-compare");
    const flip = compare.getByRole("button", { name: /^Flip/ });
    const next = compare.getByRole("button", { name: "Next changed screen" });
    while (await flip.isDisabled() && await next.isEnabled()) {
      const before = page.url();
      await next.tap();
      await expect.poll(() => page.url()).not.toBe(before);
    }
    const id = new URL(page.url()).searchParams.get("screen");
    await page.goto(`/map?screen=${id}`);
    const bar = page.getByRole("complementary", { name: "Inspector panel" }).locator(".sidebar-review-modes");
    await expect(bar).toBeVisible();
    await expect.poll(async () => (await bar.locator(".toggle-group").boundingBox())?.height).toBe(36);
    // One pass, so the sliding-in panel cannot move between two measurements.
    const rows = await bar.evaluate((element) => Array.from(element.querySelectorAll(".toggle-row")).map((row) => {
      const rowBox = row.getBoundingClientRect();
      return Array.from(row.querySelectorAll(".toggle-button")).map((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top - rowBox.top, height: box.height - rowBox.height };
      });
    }));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) for (const button of row) expect(button).toEqual({ top: 0, height: 0 });
    // Flip's one frame is centred in the stage, and the findings under it start folded.
    const panel = page.getByRole("complementary", { name: "Inspector panel" });
    const offCentre = await panel.locator(".sidebar-review-stage.mode-flip").evaluate((stage) => {
      const frame = stage.querySelector(".compare-frame");
      if (!frame) return null;
      const a = stage.getBoundingClientRect(), b = frame.getBoundingClientRect();
      return Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2);
    });
    expect(offCentre).not.toBeNull();
    expect(offCentre!).toBeLessThanOrEqual(1);

    // The modes are one tab group across the panel's content, centred over the screenshots.
    const [panelBox, modesBox, stageBox] = await Promise.all([
      panel.boundingBox(),
      bar.getByRole("group", { name: "Comparison mode" }).boundingBox(),
      panel.locator(".sidebar-review-stage").boundingBox(),
    ]);
    expect(Math.abs(modesBox!.x + modesBox!.width / 2 - (panelBox!.x + panelBox!.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(modesBox!.width - stageBox!.width)).toBeLessThanOrEqual(2);

    // The Inspector shows the picked screen: no stepper through screens; the close button leads
    // the header, and Highlight changes then Open in Compare close it.
    await expect(panel.getByRole("group", { name: "Step through screens" })).toHaveCount(0);
    const header = panel.locator(".right-head");
    const [closeBox, highlightBox, openBox] = await Promise.all([
      header.getByRole("button", { name: "Close inspector" }).boundingBox(),
      header.getByRole("button", { name: "Highlight changes" }).boundingBox(),
      header.getByRole("button", { name: "Open in Compare" }).boundingBox(),
    ]);
    expect(closeBox!.x).toBeLessThan(60);
    expect(highlightBox!.x).toBeLessThan(openBox!.x);
    expect(highlightBox!.x).toBeGreaterThan(closeBox!.x + closeBox!.width);

    // What changed is an accordion under the screenshots, folded until asked for.
    const toggle = panel.locator(".what-changed-toggle");
    const region = panel.getByRole("region", { name: "What changed on this screen" });
    await expect(region).toHaveCount(0);
    // The fixture's screen may list no findings, in which case there is nothing to fold out.
    if (await toggle.isEnabled()) {
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.tap();
      await expect(region).toBeVisible();
    }
  });

  test("the search button sits in the pill and stays put when the view changes", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    const search = page.locator(".left-panel-collapsed-pill").getByRole("button", { name: "Search", exact: true });
    await expect(search).toBeVisible();
    await expect(page.locator(".phone-top-actions")).toHaveCount(0);
    // A finger's hit area, at the pill's trailing edge.
    const box = (await search.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // The pill is persistent chrome with its own view-transition name, so switching views never fades it.
    await expect(page.locator(".left-panel.collapsed")).toHaveCSS("view-transition-name", "app-pill");
    const handle = await search.elementHandle();
    await page.getByRole("navigation", { name: "Views" }).getByRole("button", { name: "Screens" }).tap();
    await expect(page).toHaveURL(/\/screens/);
    expect(await search.evaluate((node, before) => node === before, handle)).toBe(true);
    await expect(search).toHaveCSS("opacity", "1");
  });

  test("a flicked map keeps gliding after the finger lifts and settles; a slow drag stops dead", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    const viewport = page.locator(".map-canvas .react-flow__viewport");
    await expect(page.locator(".map-canvas .react-flow__node-screen").first()).toBeVisible();
    await page.waitForTimeout(400);
    const cdp = await page.context().newCDPSession(page);
    const pan = async (pxPerFrame: number, pauseBeforeLift = 0) => {
      const start = { x: 300, y: 380 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...start, id: 1 }] });
      for (let frame = 1; frame <= 10; frame += 1) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove", touchPoints: [{ x: start.x - pxPerFrame * frame, y: start.y, id: 1 }],
        });
        await page.waitForTimeout(12);
      }
      if (pauseBeforeLift) await page.waitForTimeout(pauseBeforeLift);
      const lifted = await readCanvasCamera(viewport);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      return lifted;
    };

    // A flick: the map carries on in the finger's direction and comes to rest.
    const flicked = await pan(24);
    await page.waitForTimeout(250);
    const gliding = await readCanvasCamera(viewport);
    expect(gliding.x).toBeLessThan(flicked.x - 20);
    expect(Math.abs(gliding.y - flicked.y)).toBeLessThan(1);
    await page.waitForTimeout(250);
    const later = await readCanvasCamera(viewport);
    expect(later.x).toBeLessThan(gliding.x - 5);
    // Decelerating: the second quarter second covers less ground than the first.
    expect(flicked.x - gliding.x).toBeGreaterThan(gliding.x - later.x);
    // ...and comes to rest: two reads a quarter second apart agree.
    await expect.poll(async () => {
      const first = await readCanvasCamera(viewport);
      await page.waitForTimeout(250);
      return (await readCanvasCamera(viewport)).x === first.x;
    }, { timeout: 6000 }).toBe(true);

    // A slow drag, and a flick whose finger rested before lifting, stop where the finger stopped.
    const dragged = await pan(1.5);
    await page.waitForTimeout(300);
    expect(await readCanvasCamera(viewport)).toEqual(dragged);
    const rested = await pan(24, 250);
    await page.waitForTimeout(300);
    expect(await readCanvasCamera(viewport)).toEqual(rested);
  });

  test("the layout follows the window width, not the device", async ({ page }) => {
    await serveWorkspace(page);
    await page.goto("/map");
    await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
    // 820px is the first desktop width: the same touch device gets the canvases there.
    await page.setViewportSize({ width: 820, height: 800 });
    await expect(page.getByRole("toolbar", { name: "Canvas tools" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Views" })).toHaveCount(0);
    await expect(page.locator(".map-canvas")).toBeVisible();
    await page.setViewportSize({ width: 819, height: 800 });
    await expect(page.getByRole("navigation", { name: "Views" })).toBeVisible();
    await expect(page.locator(".map-canvas")).toBeVisible();
  });
});

test("the theme is Auto until the toggle picks one: it follows the system, then steps Dark → Light → Auto and keeps the pick", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/map");
  const html = page.locator("html");
  const button = page.getByRole("button", { name: "Toggle theme" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(button).toHaveAttribute("data-theme-preference", "system");
  await button.hover();
  await expect(page.locator(".tooltip-content")).toContainText("Theme: Auto (system)");
  // Auto tracks the system while it is in force.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).toHaveAttribute("data-theme", "light");

  await button.click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(button).toHaveAttribute("data-theme-preference", "dark");
  await expect(page.locator(".tooltip-content")).toContainText("Theme: Dark");
  await button.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(button).toHaveAttribute("data-theme-preference", "light");
  await button.click();
  await expect(button).toHaveAttribute("data-theme-preference", "system");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");

  // A picked theme outlives a reload and ignores the system.
  await button.click();
  await expect(button).toHaveAttribute("data-theme-preference", "dark");
  await button.click();
  await expect(button).toHaveAttribute("data-theme-preference", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Toggle theme" })).toHaveAttribute("data-theme-preference", "light");
});

test("/ finds screens on the Screens page: the tree and the grid narrow to the query, Enter picks the first match, Esc clears then closes", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");
  const grid = page.getByRole("main", { name: "Screens" });
  const cells = grid.locator(".screens-grid .screens-cell");
  const treeRows = grid.locator(".screens-tree-row[data-screen-id]");
  await expect(cells.first()).toBeVisible();
  const all = await cells.count();
  const titles = await cells.locator(".screen-node-title").allTextContents();
  // A query that keeps some screens and drops others: the last path segment of a route only some routes share.
  const query = titles.map(title => title.split("/").filter(Boolean).at(-1) ?? "")
    .find(segment => segment && titles.filter(title => title.includes(segment)).length < titles.length)!;
  expect(query).toBeTruthy();

  // Opening the field does not move the tree under it: the head keeps one height in every state.
  const heading = grid.locator(".screens-tree h2");
  const headingTop = (await heading.boundingBox())!.y;
  await page.keyboard.press("/");
  const field = grid.getByRole("searchbox", { name: "Find screens" });
  await expect(field).toBeFocused();
  expect((await heading.boundingBox())!.y).toBe(headingTop);
  await field.fill(query);
  const matching = titles.filter(title => title.toLowerCase().includes(query.toLowerCase()));
  await expect(cells).toHaveCount(matching.length);
  for (const title of await cells.locator(".screen-node-title").allTextContents()) expect(title.toLowerCase()).toContain(query.toLowerCase());
  await expect(treeRows).toHaveCount(matching.length);
  // Every row stays open while finding, so the fold-all control steps aside.
  await expect(grid.locator(".screens-tree-fold-all")).toHaveCount(0);

  // The results are the field's: ↓ and ↑ step the pick through them while typing can go on; Return opens the pick.
  await field.press("ArrowDown");
  await expect(cells.nth(0).locator(".screen-screenshot-card")).toHaveClass(/selected/);
  await expect(field).toBeFocused();
  if (matching.length > 1) {
    await field.press("ArrowDown");
    await expect(cells.nth(1).locator(".screen-screenshot-card")).toHaveClass(/selected/);
    await field.press("ArrowUp");
    await expect(cells.nth(0).locator(".screen-screenshot-card")).toHaveClass(/selected/);
  }
  await expect(page.getByRole("complementary", { name: "Inspector panel" })).toBeHidden();
  await field.press("Enter");
  await expect(page.getByRole("complementary", { name: "Inspector panel" })).toBeVisible();
  await expect(cells.first().locator(".screen-screenshot-card")).toHaveClass(/selected/);
  await expect(cells).toHaveCount(matching.length);
  await expect(field).toBeFocused();

  await field.fill("no-such-route-anywhere");
  await expect(grid.getByRole("status").filter({ hasText: "No screens match" }).first()).toBeVisible();
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(cells).toHaveCount(all);
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(grid.getByRole("button", { name: "Find a screen" })).toBeVisible();

  // From the Map, "/" opens Screens with the field focused.
  await chooseCanvasView(page, "Map");
  await expect(page.getByRole("main", { name: "Screens" })).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(page.getByRole("main", { name: "Screens" }).getByRole("searchbox", { name: "Find screens" })).toBeFocused();
});

test("a / from the Map opens the find once: Screens opened again from the toolbar comes up without it", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/map");
  await page.keyboard.press("/");
  const grid = page.getByRole("main", { name: "Screens" });
  const field = grid.getByRole("searchbox", { name: "Find screens" });
  await expect(field).toBeFocused();
  await field.press("Escape");
  await expect(field).toHaveCount(0);

  await chooseCanvasView(page, "Map");
  await chooseCanvasView(page, "Screens");
  await expect(grid.locator(".screens-grid .screens-cell").first()).toBeVisible();
  await expect(grid.getByRole("button", { name: "Find a screen" })).toBeVisible();
  await expect(field).toHaveCount(0);
});

test("the find's keys stay in its field: Return on the clear button clears, and Return while composing text opens nothing", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");
  const grid = page.getByRole("main", { name: "Screens" });
  const inspector = page.getByRole("complementary", { name: "Inspector panel" });
  await expect(grid.locator(".screens-grid .screens-cell").first()).toBeVisible();
  await page.keyboard.press("/");
  const field = grid.getByRole("searchbox", { name: "Find screens" });
  await field.fill("/");
  await field.press("Tab");
  await expect(grid.getByRole("button", { name: "Clear find query" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("");
  await expect(inspector).toBeHidden();

  await field.fill("/");
  // An input method's Return confirms the composed text; it is not the find's Return.
  await field.evaluate((input) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(200);
  await expect(inspector).toBeHidden();
});

test("a find inside Changed that only matches other screens says so and offers All", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");
  const grid = page.getByRole("main", { name: "Screens" });
  const cells = grid.locator(".screens-grid .screens-cell");
  const titles = () => cells.locator(".screen-node-title").allTextContents();
  await expect(cells.first()).toBeVisible();
  const all = await titles();
  await grid.getByRole("button", { name: /^Changed/ }).click();
  await expect.poll(async () => (await titles()).length).toBeLessThan(all.length);
  const changed = (await titles()).map(title => title.toLowerCase());
  const query = all.find(title => !changed.some(other => other.includes(title.toLowerCase())));
  test.skip(!query, "every unchanged screen's title is part of a changed one's");

  await page.keyboard.press("/");
  const field = grid.getByRole("searchbox", { name: "Find screens" });
  await field.fill(query!);
  await expect(grid.getByRole("status").filter({ hasText: `No changed screens match “${query}”` }).first()).toBeVisible();
  await grid.getByRole("button", { name: /^Show all/ }).click();
  await expect(cells.filter({ hasText: query! }).first()).toBeVisible();
  await expect(field).toBeFocused();
  await field.press("Escape");
  await field.press("Escape");
  await expect(grid.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
});

test("a find left on when the window narrows to the phone layout does not filter the phone's screens", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/screens");
  const grid = page.getByRole("main", { name: "Screens" });
  const cells = grid.locator(".screens-grid .screens-cell");
  await expect(cells.first()).toBeVisible();
  await grid.getByRole("button", { name: /^All/ }).click();
  const all = await cells.count();
  await page.keyboard.press("/");
  await grid.getByRole("searchbox", { name: "Find screens" }).fill("no-such-route-anywhere");
  await expect(cells).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cells).toHaveCount(all);
});

test("⌘K is a command palette: suggested commands lead, word queries rank commands first and run on Enter, route queries rank screens first", async ({ page }) => {
  await serveWorkspace(page);
  await page.goto("/map");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+KeyK`);
  const palette = page.getByRole("dialog", { name: "Search Explore" });
  await expect(palette).toBeVisible();
  const box = palette.getByRole("combobox", { name: "Search screens and commands" });
  await expect(box).toBeFocused();

  // The empty palette suggests what to do next on this canvas, not the screen inventory.
  const suggested = palette.getByRole("group", { name: "Suggested" });
  await expect(suggested.getByRole("option").filter({ hasText: "Next changed screen" })).toBeVisible();
  expect(await palette.getByRole("option").count()).toBeLessThanOrEqual(7);

  // A word query ranks commands first; each prints the key that also runs it.
  await box.fill("dark");
  await expect(palette.getByRole("option").first()).toContainText("Theme: Dark");
  await box.fill("fit");
  const fit = palette.getByRole("option").filter({ hasText: "Fit the canvas" });
  await expect(fit).toBeVisible();
  await expect(fit.locator("kbd")).toBeVisible();

  // Enter runs the command.
  await box.fill("dark");
  await box.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // A route-shaped query ranks screens first, with the commands after them.
  await page.keyboard.press(`${mod}+KeyK`);
  await box.fill("/");
  await expect(palette.getByRole("option").first().locator("code")).toBeVisible();
  await expect(palette.getByRole("group", { name: "Screens" })).toBeVisible();

  // A navigation command.
  await box.fill("screens");
  await expect(palette.getByRole("option").first()).toHaveText(/^Screens/);
  await box.press("Enter");
  await expect(page.getByRole("main", { name: "Screens" })).toBeVisible();
});
