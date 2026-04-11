import { defineConfig, devices } from "@playwright/test";

/**
 * Production QA config — runs ONLY qa-*.spec.ts files against the live Vercel deployment.
 * Usage: npx playwright test --config=playwright.config.prod.ts
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /qa-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "qa-report", open: "never" }],
    ["json", { outputFile: "qa-report/results.json" }],
  ],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "https://probuild-amber.vercel.app",
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "prod-setup",
      testMatch: /prod-auth\.setup\.ts/,
    },
    {
      name: "qa-chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/prod-user.json",
      },
      dependencies: ["prod-setup"],
    },
  ],
  // No webServer — we hit the live Vercel deployment
});
