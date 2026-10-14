import { expect, test, type Page } from "@playwright/test";
import { emptyMap } from "../helpers/map-store-fixture.mjs";

const CAPTURED_AT = "2026-04-01T12:00:00.000Z";

function artifactSha(id: string) {
  return id.padEnd(64, "0").slice(0, 64);
}

function artifact(id: string, path: string) {
  return {
    id,
    kind: "screenshot" as const,
    path,
    sha256: artifactSha(id),
    bytes: 100,
    mimeType: "image/svg+xml",
    width: 390,
    height: 844,
    createdAt: CAPTURED_AT,
  };
}

function observation(id: string, screenId: string, variantId: string, screenshotArtifactId: string, capturedAt: string) {
  return {
    id,
    screenId,
    variantId,
    fingerprints: { combined: id, visual: id },
    capturedAt,
    surfaceScope: "app" as const,
    elementIds: [],
    elements: [],
    screenshotArtifactId,
  };
}

async function variantMapPayload() {
  const source = emptyMap("Variants");
  const screenA = {
    id: "screen-account",
    title: "Account home",
    start: true,
    terminal: false,
    depth: 0,
    firstSeenAt: CAPTURED_AT,
    lastSeenAt: "2026-04-01T12:02:00.000Z",
    visits: 2,
    variantIds: ["variant-account-primary", "variant-account-return"],
    observationIds: ["observation-account-primary", "observation-account-return"],
    elementIds: [],
  };
  const screenB = {
    ...screenA,
    id: "screen-settings",
    title: "Settings",
    start: false,
    visits: 1,
    variantIds: ["variant-settings"],
    observationIds: ["observation-settings"],
  };
  const map = {
    ...source,
    revision: 42,
    run: { ...source.run, id: "variant-images", name: "Variant image fixture" },
    artifacts: [
      artifact("artifact-account-primary", "variant-account-primary.svg"),
      artifact("artifact-account-return", "variant-account-return.svg"),
      artifact("artifact-settings", "variant-settings.svg"),
    ],
    screens: [screenA, screenB],
    variants: [
      {
        id: "variant-account-primary",
        screenId: screenA.id,
        key: "account-primary",
        firstSeenAt: CAPTURED_AT,
        lastSeenAt: CAPTURED_AT,
        observationIds: ["observation-account-primary"],
      },
      {
        id: "variant-account-return",
        screenId: screenA.id,
        key: "account-return",
        firstSeenAt: "2026-04-01T12:02:00.000Z",
        lastSeenAt: "2026-04-01T12:02:00.000Z",
        observationIds: ["observation-account-return"],
      },
      {
        id: "variant-settings",
        screenId: screenB.id,
        key: "settings",
        firstSeenAt: "2026-04-01T12:01:00.000Z",
        lastSeenAt: "2026-04-01T12:01:00.000Z",
        observationIds: ["observation-settings"],
      },
    ],
    observations: [
      observation(
        "observation-account-primary",
        screenA.id,
        "variant-account-primary",
        "artifact-account-primary",
        CAPTURED_AT,
      ),
      observation(
        "observation-settings",
        screenB.id,
        "variant-settings",
        "artifact-settings",
        "2026-04-01T12:01:00.000Z",
      ),
      observation(
        "observation-account-return",
        screenA.id,
        "variant-account-return",
        "artifact-account-return",
        "2026-04-01T12:02:00.000Z",
      ),
    ],
    elements: [],
    actionAttempts: [
      {
        id: "attempt-update-account",
        sourceScreenId: screenA.id,
        sourceObservationId: "observation-account-primary",
        targetScreenId: screenA.id,
        targetObservationId: "observation-account-return",
        action: { kind: "fill", label: "Enter account details" },
        outcome: "same-screen",
        risk: "safe",
        startedAt: CAPTURED_AT,
        completedAt: CAPTURED_AT,
      },
      {
        id: "attempt-open-settings",
        sourceScreenId: screenA.id,
        sourceObservationId: "observation-account-return",
        targetScreenId: screenB.id,
        targetObservationId: "observation-settings",
        action: { kind: "press", label: "Open settings" },
        outcome: "transition",
        risk: "safe",
        startedAt: CAPTURED_AT,
        completedAt: CAPTURED_AT,
      },
    ],
    transitions: [
      {
        id: "transition-update-account",
        fromScreenId: screenA.id,
        toScreenId: screenA.id,
        actionKind: "fill",
        firstObservedAt: CAPTURED_AT,
        lastObservedAt: CAPTURED_AT,
        attemptIds: ["attempt-update-account"],
      },
      {
        id: "transition-open-settings",
        fromScreenId: screenA.id,
        toScreenId: screenB.id,
        actionKind: "press",
        firstObservedAt: CAPTURED_AT,
        lastObservedAt: CAPTURED_AT,
        attemptIds: ["attempt-open-settings"],
      },
    ],
    journeys: [
      {
        id: "journey-account-settings",
        title: "Complete account setup",
        screenIds: [screenA.id, screenA.id, screenB.id],
        transitionIds: ["transition-update-account", "transition-open-settings"],
        attemptIds: ["attempt-update-account", "attempt-open-settings"],
      },
    ],
    frontier: [],
    gaps: [],
  };
  return {
    map,
    coverage: {
      screens: 2,
      variants: 3,
      observations: 3,
      elements: 0,
      transitions: 2,
      actions: { attempted: 2, succeeded: 2, noChange: 0, failed: 0, blocked: 0 },
      frontier: { pending: 0, claimed: 0, done: 0, skipped: 0, blocked: 0 },
      gaps: { open: 0, accepted: 0, resolved: 0 },
      completion: { eligible: true, blockers: [] },
      limits: source.run.limits,
    },
  };
}

async function serveVariantMap(page: Page) {
  const payload = await variantMapPayload();
  // Keep the fixture standalone even when a developer reuses a running catalog server.
  await page.route("**/api/workspace", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/workspace/status", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/map", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.route("**/api/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        runId: payload.map.run.id,
        revision: payload.map.revision,
        coverage: payload.coverage,
      }),
    });
  });
  await page.route("**/api/artifacts/**", async (route) => {
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844"><rect width="390" height="844" fill="#7c3aed"/></svg>',
    });
  });
}

test("presents repeated screen states as one screen and keeps their variants in the Inspector", async ({ page }) => {
  await serveVariantMap(page);

  await page.goto("/screens");
  const flowImages = page.locator(".screens-page .screens-cell img");
  await expect(flowImages).toHaveCount(2);
  await expect(flowImages.nth(0)).toHaveAttribute(
    "src",
    `/api/artifacts/variant-account-primary.svg?sha256=${artifactSha("artifact-account-primary")}`,
  );
  await expect(flowImages.nth(1)).toHaveAttribute(
    "src",
    `/api/artifacts/variant-settings.svg?sha256=${artifactSha("artifact-settings")}`,
  );

  const flowTiles = page.locator(".screens-page .screens-cell");
  await expect(flowTiles).toHaveCount(2);

  await flowTiles.nth(0).getByRole("button", { name: "Account home", exact: true }).click();
  await expect(page).toHaveURL(
    /\/screens\?screen=screen-account(?:&variant=variant-account-primary)?$/,
  );
  await expect(page.getByRole("tablist", { name: "Right panel view" })).toHaveCount(0);
  await expect(page.locator(".right-panel .screen-variant-carousel")).toBeVisible();
  const variantTabs = page.getByRole("tablist", { name: "Account home screen variants" })
    .getByRole("tab");
  await expect(variantTabs).toHaveCount(2);
  await expect(variantTabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(flowTiles.nth(0).locator(".screen-screenshot-card")).toHaveClass(/\bselected\b/);
  await expect(flowTiles.locator(".screen-screenshot-card.selected")).toHaveCount(1);

  await variantTabs.nth(1).click();
  await expect(page).toHaveURL(
    /\/screens\?screen=screen-account&variant=variant-account-return$/,
  );
  await expect(variantTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(flowTiles.nth(0).locator(".screen-screenshot-card")).toHaveClass(/\bselected\b/);
  await expect(flowTiles.locator(".screen-screenshot-card.selected")).toHaveCount(1);

  // Map now derives its detail projection from the selected screen instead of exposing the
  // retired Highlights content switch. A deep link also verifies the cold-focus contract.
  await page.goto("/map?screen=screen-account");
  const mapCard = page.locator('.react-flow__node-screen.selected[data-id="screen-account"]');
  await expect(mapCard.locator("img")).toHaveAttribute(
    "src",
    `/api/artifacts/variant-account-primary.svg?sha256=${artifactSha("artifact-account-primary")}`,
  );
  await expect(mapCard.getByText("Start", { exact: true })).toHaveCount(0);
  await expect(mapCard.getByText("End", { exact: true })).toHaveCount(0);
  await expect(mapCard.getByText("2 variants", { exact: true })).toHaveCount(0);

  await page.goto("/screens");
  const inventoryCard = page.locator(".screens-page")
    .getByRole("button", { name: "Account home", exact: true });
  await expect(inventoryCard.locator("img")).toHaveAttribute(
    "src",
    `/api/artifacts/variant-account-primary.svg?sha256=${artifactSha("artifact-account-primary")}`,
  );
  await expect(page.locator(".screens-page").getByText("2 variants", { exact: true })).toHaveCount(0);

});
