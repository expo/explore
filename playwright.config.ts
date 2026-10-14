import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4327);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  outputDir: join(tmpdir(), "expo-explore-playwright-results"),
  testDir: "./test/e2e",
  testIgnore: "hosted-export-assets.spec.ts",
  fullyParallel: true,
  // Tests only read the fixture server and mock mutations with page.route, so they can share it.
  // CI shards instead of adding workers: the camera tests count animation frames, and a second
  // worker on a 4-vCPU runner starves them.
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1180, height: 820 },
  },
  webServer: {
    // General viewer tests must never read the developer's real provider credentials.
    // The dedicated AI browser suite supplies its own isolated HTTP fixture.
    command: `node test/helpers/viewer-map-server.mjs ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
