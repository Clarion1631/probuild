import { defineConfig, devices } from "@playwright/test";

// Expo-web launch gate for the ProBuild mobile app. Runs LOCALLY (not in this
// repo's CI — the mobile checkout lives in a separate repository):
//
//   set MOBILE_APP_DIR=C:\...\gtr-probuild-mobile
//   npm run test:mobile-e2e
//
// Serves the mobile app's static Expo web export on :19006 with /api proxied
// to the Next dev server (e2e/mobile-app/serve-mobile-web.mjs) — the same
// same-origin shape production uses. Same hermetic-DB rules as the main
// suite: point DATABASE_URL at a throwaway Postgres per docs/TESTING.md.
//
// workers: 1 on purpose — the mobile-app specs share one crew user/project
// and mutate punches, entries, comments, and expenses; parallel workers would
// race the fixtures. This is a pre-launch gate, not a speed benchmark.
export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/mobile-app/**/*.spec.ts",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: "list",
    timeout: 45_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: "http://localhost:19006",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        ...devices["Desktop Chrome"],
    },
    projects: [
        {
            name: "data",
            testMatch: /data\.setup\.ts/,
        },
        {
            name: "mobile-web",
            dependencies: ["data"],
        },
    ],
    webServer: [
        {
            command: "npm run dev",
            url: "http://localhost:3000",
            reuseExistingServer: true,
            timeout: 120_000,
        },
        {
            command: "node e2e/mobile-app/serve-mobile-web.mjs",
            url: "http://localhost:19006",
            reuseExistingServer: true,
            timeout: 30_000,
        },
    ],
});
