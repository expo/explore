import { expect, test, type Page } from "@playwright/test";

type ViewportMatrix = {
  x: number;
  y: number;
  zoom: number;
};

async function viewportMatrix(page: Page): Promise<ViewportMatrix> {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}

async function minimapViewportAppearance(page: Page) {
  return page.getByTestId("canvas-minimap").locator(".canvas-minimap-visible-mask")
    .evaluate((minimap) => {
      const mask = minimap.querySelector("path");
      const viewport = minimap.querySelector(".canvas-minimap-visible-viewport");
      const panel = minimap.parentElement?.querySelector(".canvas-minimap.react-flow__panel");
      if (!mask || !viewport || !panel) throw new Error("Expected minimap viewport indicator");
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Expected a 2D canvas context");
      const alpha = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3]! / 255;
      };
      return {
        maskAlpha: alpha(getComputedStyle(mask).fill),
        panelZIndex: Number(getComputedStyle(panel).zIndex),
        viewportZIndex: Number(getComputedStyle(minimap).zIndex),
        viewportFillAlpha: alpha(getComputedStyle(viewport).fill),
        viewportStroke: getComputedStyle(viewport).stroke,
      };
    });
}

test("keeps the minimap enabled when a retired hidden preference is stored", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "expo-explore:show-minimap:v1",
      JSON.stringify({ version: 1, value: false }),
    );
  });
  await page.goto("/map");
  const minimap = page.getByTestId("canvas-minimap");
  await expect(minimap).toBeVisible();
  await page.reload();
  await expect(minimap).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: "Minimap" })).toHaveCount(0);
});

test("pans by minimap click and drag without changing zoom", async ({ page }) => {
  await page.goto("/map");
  const minimap = page.getByTestId("canvas-minimap");
  await expect(minimap).toBeVisible();
  const box = await minimap.boundingBox();
  expect(box).not.toBeNull();

  const opening = await viewportMatrix(page);
  await page.mouse.click(box!.x + 20, box!.y + 20);
  await expect.poll(async () => viewportMatrix(page)).not.toEqual(opening);
  const clicked = await viewportMatrix(page);
  expect(clicked.zoom).toBeCloseTo(opening.zoom, 5);

  const dragStart = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 28, dragStart.y + 12, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => viewportMatrix(page)).not.toEqual(clicked);
  const dragged = await viewportMatrix(page);
  expect(dragged.zoom).toBeCloseTo(opening.zoom, 5);

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(100);
  expect((await viewportMatrix(page)).zoom).toBeCloseTo(opening.zoom, 5);
});

test("keeps the current viewport indicator prominent in both themes", async ({ page }) => {
  await page.goto("/map");
  await expect(page.getByTestId("canvas-minimap")).toBeVisible();
  const light = await minimapViewportAppearance(page);
  expect(light.maskAlpha).toBeGreaterThanOrEqual(0.69);
  expect(light.viewportZIndex).toBeGreaterThan(light.panelZIndex);
  expect(light.viewportFillAlpha).toBeGreaterThanOrEqual(0.05);
  expect(light.viewportStroke).not.toBe("none");

  await page.locator("html").evaluate((root) => root.setAttribute("data-theme", "dark"));
  const dark = await minimapViewportAppearance(page);
  expect(dark.maskAlpha).toBeGreaterThanOrEqual(0.47);
  expect(dark.viewportFillAlpha).toBeGreaterThanOrEqual(0.07);
  expect(dark.viewportStroke).not.toBe("none");
});

test("keeps dark minimap nodes legible and uses the compact responsive size", async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 820 });
  await page.addInitScript(() => {
    localStorage.setItem("expo-explore:theme", "dark");
  });
  await page.goto("/map");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const minimap = page.getByTestId("canvas-minimap");
  await expect(minimap).toBeVisible();

  const appearance = await minimap.evaluate((shell) => {
    const item = shell.querySelector<SVGElement>(
      ".canvas-minimap-node--item:not(.selected)",
    );
    // The Map's minimap draws screens; group panels only appeared on the retired Screens canvas.
    const group = shell.querySelector<SVGElement>(".canvas-minimap-node--group");
    if (!item) throw new Error("Expected minimap item nodes");

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Expected a 2D canvas context");
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return { red: red / 255, green: green / 255, blue: blue / 255, alpha: alpha / 255 };
    };
    const composite = (
      foreground: ReturnType<typeof rgba>,
      background: ReturnType<typeof rgba>,
      opacity = 1,
    ) => {
      const alpha = foreground.alpha * opacity;
      return {
        red: foreground.red * alpha + background.red * (1 - alpha),
        green: foreground.green * alpha + background.green * (1 - alpha),
        blue: foreground.blue * alpha + background.blue * (1 - alpha),
        alpha: 1,
      };
    };
    const luminance = (color: ReturnType<typeof rgba>) => {
      const channel = (value: number) => (
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      );
      return 0.2126 * channel(color.red)
        + 0.7152 * channel(color.green)
        + 0.0722 * channel(color.blue);
    };

    const shellStyle = getComputedStyle(shell);
    const pageBackground = rgba(getComputedStyle(document.documentElement).getPropertyValue("--screen"));
    const background = composite(rgba(shellStyle.backgroundColor), pageBackground);
    const itemStyle = getComputedStyle(item);
    const itemColor = composite(
      rgba(itemStyle.fill),
      background,
      Number(itemStyle.opacity),
    );
    const light = Math.max(luminance(background), luminance(itemColor));
    const dark = Math.min(luminance(background), luminance(itemColor));
    return {
      contrast: (light + 0.05) / (dark + 0.05),
      groupOpacity: group ? Number(getComputedStyle(group).opacity) : 0,
    };
  });

  expect(appearance.contrast).toBeGreaterThanOrEqual(4);
  expect(appearance.groupOpacity).toBeLessThanOrEqual(0.4);

  const compactBox = await minimap.boundingBox();
  expect(compactBox?.width).toBe(128);
  expect(compactBox?.height).toBe(84);
});
