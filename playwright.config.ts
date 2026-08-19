import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Expo-web specs need the mobile checkout + its static export — they run
  // via playwright.config.mobile.ts (npm run test:mobile-e2e), never here/CI.
  testIgnore: "**/mobile-app/**",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "data",
      testMatch: /data\.setup\.ts/,
    },
    {
      name: "setup",
      testMatch: /(^|[\\/])auth\.setup\.ts$/,
      // data first: on a fresh test DB the admin user must exist before login
      dependencies: ["data"],
    },
    {
      // A SECOND session: staff with partial project scope. The admin can never
      // exercise the scoped branches (accessibleProjectIds returns "ALL"), so
      // estimate-scope-labels.spec.ts needs its own storage state.
      name: "setup-scoped",
      testMatch: /(^|[\\/])auth-scoped\.setup\.ts$/,
      dependencies: ["data"],
    },
    {
      // A THIRD session: FINANCE staff with project access but no `contracts`
      // permission. See auth-finance.setup.ts and
      // e2e/contract-auth-runtime.spec.ts.
      name: "setup-finance",
      testMatch: /(^|[\\/])auth-finance\.setup\.ts$/,
      dependencies: ["data"],
    },
    {
      // A FOURTH session: EMPLOYEE staff with `contracts` + `leadAccess` but
      // scope reaching only one project. See auth-contract.setup.ts and
      // e2e/contract-auth-runtime.spec.ts.
      name: "setup-contract",
      testMatch: /(^|[\\/])auth-contract\.setup\.ts$/,
      dependencies: ["data"],
    },
    {
      name: "chromium",
      // The setup files are run by the setup projects above. Without this they
      // would ALSO run here as ordinary tests and rewrite the storage-state
      // files underneath the specs currently reading them.
      testIgnore: ["**/mobile-app/**", "**/*.setup.ts"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["data", "setup", "setup-scoped", "setup-finance", "setup-contract"],
    },
  ],
  webServer: {
    command: process.env.CI ? "npm run start" : "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // The test harness turning on its own test routes, which is the only
      // context that should ever enable them. Without this a LOCAL run 404s on
      // src/app/api/test-only/contract-actions and every dispatcher assertion
      // in e2e/contract-auth-runtime.spec.ts fails — that spec's FINANCE and
      // contract-staff blocks are meant to run locally, not only in CI.
      // ci.yml sets the same variable at job level; a server started by hand
      // (reuseExistingServer picks it up) will not have it, and the spec says
      // so in its failure message rather than passing vacuously.
      E2E_TEST_ROUTES: "1",
    },
  },
});
