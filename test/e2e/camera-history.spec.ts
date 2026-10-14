import { expect, test, type Page } from "@playwright/test";

// These tests describe "Follow selection" (the camera moves to every focused screen), which is
// off by default. viewer.spec.ts covers the default.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("expo-explore:follow-selection", "true"));
});

// Screens is a page without a camera; the Map is the only canvas.
const VIEW_PATHS = {
  Map: "/map",
} as const;

function transformValue(style: string) {
  return style.match(/transform:\s*([^;]+)/)?.[1] ?? style;
}

async function waitForCamera(page: Page) {
  const viewport = page.locator(".react-flow__viewport");
  await expect(viewport).toBeVisible();
  await expect.poll(() => viewport.getAttribute("style")).not.toBeNull();
  // Canvas zoom commands use a 160ms transition. A quiet beat after that duration also lets the
  // phase:end callback persist the exact transform into this browser history entry.
  await page.waitForTimeout(220);
  return (await viewport.getAttribute("style"))!;
}

async function selectView(page: Page, view: keyof typeof VIEW_PATHS) {
  await page.getByRole("group", { name: "Canvas view" })
    .getByRole("button", { name: view, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${VIEW_PATHS[view].replace("/", "\\/")}(?:\\?|$)`));
  return waitForCamera(page);
}

async function moveCamera(page: Page, zoomSteps: number) {
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  for (let step = 0; step < zoomSteps; step += 1) {
    await page.keyboard.press("Equal");
    await page.waitForTimeout(190);
  }
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);
  return waitForCamera(page);
}

test("deterministically refits the Map overview on entry", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/map");
  await waitForCamera(page);
  const saved = await moveCamera(page, 2);

  // Leave for the Screens page and come back: the Map derives its overview from the destination
  // panel geometry instead of restoring the arbitrary camera saved during the previous visit.
  const leave = async () => {
    await page.getByRole("group", { name: "Canvas view" })
      .getByRole("button", { name: "Screens", exact: true })
      .click();
    await expect(page).toHaveURL(/\/screens(?:\?|$)/);
    await expect(page.locator(".screens-page")).toBeVisible();
  };
  await leave();
  const overview = await selectView(page, "Map");
  expect(overview).not.toBe(saved);

  // The same destination shell produces one stable, deterministic Map overview fit.
  await leave();
  await selectView(page, "Map");
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", overview);
});

test("reload ignores the saved camera and cuts to the URL-derived fit", async ({ page }) => {
  await page.goto("/map");
  const fitted = await waitForCamera(page);
  const saved = await moveCamera(page, 2);
  expect(saved).not.toBe(fitted);

  // This script runs before the reloaded app. Its first non-empty viewport transform is therefore
  // the first camera React Flow makes paintable, not a sample installed after hydration settled.
  await page.addInitScript(() => {
    const frames: string[] = [];
    (window as unknown as { __openingCameraFrames: string[] }).__openingCameraFrames = frames;
    (function tick() {
      const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
      const transform = viewport?.style.transform ?? "";
      if (transform && frames.at(-1) !== transform) frames.push(transform);
      requestAnimationFrame(tick);
    })();
  });
  await page.reload();
  const viewport = page.locator(".react-flow__viewport");
  await expect(viewport).toHaveAttribute("style", fitted);
  await page.waitForTimeout(450);
  await expect(viewport).toHaveAttribute("style", fitted);
  const frames = await page.evaluate(() => (
    window as unknown as { __openingCameraFrames: string[] }
  ).__openingCameraFrames);
  expect(frames.at(-1)).toBe(transformValue(fitted));
  // React Flow's hidden default transform may exist in the DOM for one frame, but the opening
  // camera must not animate through additional visible transforms.
  expect([...new Set(frames.slice(1))]).toEqual([transformValue(fitted)]);
});

