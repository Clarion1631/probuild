// Launch-gate runner: build the mobile app's Expo web export, then run the
// mobile-app Playwright suite against it. See playwright.config.mobile.ts.
//
//   set MOBILE_APP_DIR=C:\...\gtr-probuild-mobile   (required)
//   npm run test:mobile-e2e
//
//   SKIP_MOBILE_BUILD=1  reuse an existing apps/mobile/dist export
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const mobileDir = process.env.MOBILE_APP_DIR;
if (!mobileDir || !existsSync(mobileDir)) {
    console.error("Set MOBILE_APP_DIR to the gtr-probuild-mobile checkout path.");
    process.exit(1);
}
const appDir = path.join(mobileDir, "apps", "mobile");

if (process.env.SKIP_MOBILE_BUILD !== "1") {
    console.log(`Building Expo web export in ${appDir} ...`);
    const build = spawnSync("npx", ["expo", "export", "--platform", "web"], {
        cwd: appDir,
        stdio: "inherit",
        shell: true,
    });
    if (build.status !== 0) process.exit(build.status ?? 1);
} else if (!existsSync(path.join(appDir, "dist", "index.html"))) {
    console.error("SKIP_MOBILE_BUILD=1 but no dist/index.html export exists.");
    process.exit(1);
}

const test = spawnSync("npx", ["playwright", "test", "-c", "playwright.config.mobile.ts"], {
    stdio: "inherit",
    shell: true,
    env: process.env,
});
process.exit(test.status ?? 1);
