import { expect, test, type Page } from "@playwright/test";

const STORAGE_KEY = "expo-explore:inspector-width";
const panel = (page: Page) => page.getByRole("complementary", { name: "Inspector panel" });
const handle = (page: Page) => page.getByRole("separator", { name: "Resize inspector" });
const panelWidth = async (page: Page) => (await panel(page).boundingBox())!.width;
const storedWidth = (page: Page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

/** Drags the panel's edge `dx` pixels (negative is left, which widens the panel). */
async function dragEdge(page: Page, dx: number) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y);
  await page.mouse.move(x + dx, y);
  await page.mouse.up();
}

test.describe("Inspector resize", () => {
  test("dragging the edge resizes the Inspector, and the width is kept for the next visit", async ({ page }) => {
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    // The 1280px test window takes the wide default.
    expect(await panelWidth(page)).toBe(400);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "400");

    await dragEdge(page, -150);
    await expect.poll(() => panelWidth(page)).toBe(550);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "550");
    expect(await storedWidth(page)).toBe("550");

    await page.reload();
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => panelWidth(page)).toBe(550);

    // Dragging back right narrows it, never below the minimum.
    await dragEdge(page, 400);
    await expect.poll(() => panelWidth(page)).toBe(320);
    expect(await storedWidth(page)).toBe("320");
  });

  test("the width stops at half the window, and a double-click restores the default", async ({ page }) => {
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    await dragEdge(page, -600);
    await expect.poll(() => panelWidth(page)).toBe(640);
    await expect(handle(page)).toHaveAttribute("aria-valuemax", "640");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "640");

    // The canvas toolbar moves left, out from under the wide panel, instead of being covered.
    const toolbar = page.getByRole("toolbar", { name: "Canvas tools" });
    await expect(toolbar).toBeVisible();
    await expect.poll(async () => {
      const toolbarBox = (await toolbar.boundingBox())!;
      const panelBox = (await panel(page).boundingBox())!;
      return panelBox.x - (toolbarBox.x + toolbarBox.width);
    }).toBeGreaterThanOrEqual(8);

    await handle(page).dblclick();
    await expect.poll(() => panelWidth(page)).toBe(400);
    expect(await storedWidth(page)).toBeNull();
  });

  test("arrow keys move the edge a step; Home and End take it to its limits", async ({ page }) => {
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    await handle(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => panelWidth(page)).toBe(416);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => panelWidth(page)).toBe(432);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => panelWidth(page)).toBe(416);
    await page.keyboard.press("End");
    await expect.poll(() => panelWidth(page)).toBe(640);
    await page.keyboard.press("Home");
    await expect.poll(() => panelWidth(page)).toBe(320);
    // The arrows resized the panel; they did not step the selected screen.
    expect(new URL(page.url()).searchParams.get("screen")).toBe("area-0-screen-1");
  });

  test("a saved width wider than half of a smaller window is held to half of it", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "760"), STORAGE_KEY);
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    expect(await panelWidth(page)).toBe(640);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "640");
  });

  test("a drag that ends where it started leaves the default width in place", async ({ page }) => {
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    const box = (await handle(page).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y);
    await expect.poll(() => panelWidth(page)).toBe(500);
    await page.mouse.move(x, y);
    await page.mouse.up();
    await expect.poll(() => panelWidth(page)).toBe(400);
    expect(await storedWidth(page)).toBeNull();
    // Still the default: a narrower window takes the narrow default, not the 400 the drag passed through.
    await page.setViewportSize({ width: 1100, height: 820 });
    await expect.poll(() => panelWidth(page)).toBe(320);
  });

  test("a saved width below the minimum is held to it", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "40"), STORAGE_KEY);
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    expect(await panelWidth(page)).toBe(320);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "320");
  });

  test.describe("in a window wider than two maximum panels", () => {
    test.use({ viewport: { width: 1700, height: 900 } });

    test("a saved width above the maximum is held to it", async ({ page }) => {
      await page.addInitScript((key) => localStorage.setItem(key, "5000"), STORAGE_KEY);
      await page.goto("/map?screen=area-0-screen-1");
      await expect(panel(page)).toBeVisible();
      // Half of this window is 850.
      expect(await panelWidth(page)).toBe(800);
      await expect(handle(page)).toHaveAttribute("aria-valuenow", "800");
    });
  });

  test("a key that cannot move the edge keeps the saved width", async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, "760"), STORAGE_KEY);
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    expect(await panelWidth(page)).toBe(640);
    await handle(page).focus();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    expect(await storedWidth(page)).toBe("760");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => panelWidth(page)).toBe(624);
    expect(await storedWidth(page)).toBe("624");
  });

  test("the separator's values follow the window", async ({ page }) => {
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    await handle(page).focus();
    await page.keyboard.press("End");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "640");
    await page.setViewportSize({ width: 1000, height: 820 });
    await expect.poll(() => panelWidth(page)).toBe(500);
    await expect(handle(page)).toHaveAttribute("aria-valuemax", "500");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "500");
    // Back in the wide window the saved width returns.
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect.poll(() => panelWidth(page)).toBe(640);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "640");
  });

  test("closing the Inspector mid-drag ends the drag", async ({ page }) => {
    await page.goto("/map?screen=area-0-screen-1");
    await expect(panel(page)).toBeVisible();
    const box = (await handle(page).boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y);
    await expect(page.locator("html")).toHaveClass(/inspector-resizing/);
    await page.keyboard.press("i");
    await expect(panel(page)).toHaveCount(0);
    await page.mouse.up();
    await expect(page.locator("html")).not.toHaveClass(/inspector-resizing/);
    // The width the drag reached is kept.
    await page.keyboard.press("i");
    await expect.poll(() => panelWidth(page)).toBe(500);
  });

  test.describe("in a narrow window", () => {
    test.use({ viewport: { width: 1180, height: 820 } });

    test("the Inspector starts at its narrow default, and a saved width is held to half the window", async ({ page }) => {
      await page.goto("/map?screen=area-0-screen-1");
      await expect(panel(page)).toBeVisible();
      expect(await panelWidth(page)).toBe(320);
      await expect(handle(page)).toHaveAttribute("aria-valuenow", "320");
      await page.evaluate((key) => localStorage.setItem(key, "760"), STORAGE_KEY);
      await page.reload();
      await expect(panel(page)).toBeVisible();
      expect(await panelWidth(page)).toBe(590);
      await expect(handle(page)).toHaveAttribute("aria-valuenow", "590");
    });
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the Inspector sheet has no resize edge", async ({ page }) => {
      await page.goto("/map?screen=area-0-screen-1");
      await expect(panel(page)).toBeVisible();
      await expect(handle(page)).toHaveCount(0);
    });
  });
});
