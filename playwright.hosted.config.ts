import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "hosted-export-assets.spec.ts",
  outputDir: join(tmpdir(), "expo-explore-host-assets-results"),
  workers: 1,
  retries: 0,
  reporter: "line",
  use: { browserName: "chromium", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
});
