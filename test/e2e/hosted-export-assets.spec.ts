import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = process.env.PLAYWRIGHT_HOSTED_CLIENT_ROOT
  ? resolve(process.env.PLAYWRIGHT_HOSTED_CLIENT_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../viewer-host/dist/client");
const origin = "http://127.0.0.1:4399";
const recordedReport = fileURLToPath(new URL("../fixtures/example-review-artifact.zip", import.meta.url));
const contentTypes: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml",
};

// The root is the report page; /r is its address in earlier pull-request comments.
for (const reportPath of ["/", "/r"]) test(`exported report page ${reportPath} opens a dropped report and resolves Viewer assets beneath its hosted base`, async ({ page }) => {
  // Serve only actual exported files. A root-relative asset request must fail,
  // matching EAS Hosting instead of the root-mounted local Viewer server.
  const missingAssets: string[] = [];
  const hostRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) {
      hostRequests.push(path);
      return route.fulfill({ status: 404 });
    }
    const file = resolve(clientRoot, path === "/" || path === "/r" ? "viewer/index.html" : `.${path}`);
    if (!file.startsWith(clientRoot + sep)) return route.fulfill({ status: 404 });
    try {
      return await route.fulfill({ body: await readFile(file), contentType: contentTypes[extname(file)] ?? "application/octet-stream" });
    } catch {
      missingAssets.push(path);
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto(`${origin}${reportPath}`);
  await page.locator(".report-drop-input").setInputFiles(recordedReport);
  await expect(page.locator(".app-shell")).toBeVisible();
  // The canvas cursors are the Viewer's remaining public assets. Decode one at the hosted path.
  expect(await page.evaluate(async src => {
    const image = new Image(); image.src = src; await image.decode(); return image.naturalWidth > 0;
  }, `${origin}/viewer/cursors/hand.svg`)).toBe(true);
  expect(missingAssets).toEqual([]);
  expect(hostRequests).toEqual([]);
  expect(errors).toEqual([]);
});
