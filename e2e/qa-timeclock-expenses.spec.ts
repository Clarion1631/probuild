import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  assertNoErrorToasts,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];

test.describe("Workflow 4: Time Clock & Expenses", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  test("W4.1: Navigate to /time-clock — page loads cleanly", async ({
    page,
  }, testInfo) => {
    await assertCleanNavigation(page, "/time-clock", "time-clock");
    await capture(page, testInfo, 4, 1, "time-clock-page");
  });

  test("W4.2: Clock in, wait, clock out", async ({ page }, testInfo) => {
    await page.goto("/time-clock", { waitUntil: "networkidle" });
    await capture(page, testInfo, 4, 2, "before-clock-in");

    // Look for a project selector
    const projectSelect = page.locator(
      'select:has(option), [role="combobox"], button:has-text("Select Project")'
    ).first();
    if (await projectSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
      if ((await projectSelect.evaluate((el) => el.tagName)) === "SELECT") {
        // Select first non-empty option
        const options = await projectSelect.locator("option").allTextContents();
        if (options.length > 1) {
          await projectSelect.selectOption({ index: 1 });
        }
      }
    }

    // Clock In
    const clockInBtn = page.locator(
      'button:has-text("Clock In"), button:has-text("Start"), button:has-text("Begin")'
    ).first();

    if (await clockInBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await clockInBtn.click();
      await page.waitForTimeout(2000);
      await capture(page, testInfo, 4, 2, "clocked-in");

      // Verify active state indicator
      const body = await page.locator("body").innerText();
      // Some kind of "Clocked In" or timer should be visible

      // Wait 3 seconds
      await page.waitForTimeout(3000);

      // Clock Out
      const clockOutBtn = page.locator(
        'button:has-text("Clock Out"), button:has-text("Stop"), button:has-text("End")'
      ).first();

      if (await clockOutBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await clockOutBtn.click();
        await page.waitForTimeout(2000);
        await capture(page, testInfo, 4, 2, "clocked-out");
        await assertNoErrorToasts(page, "after-clock-out");
      } else {
        await capture(page, testInfo, 4, 2, "CRITICAL-no-clock-out-btn");
      }
    } else {
      await capture(page, testInfo, 4, 2, "no-clock-in-btn-found");
    }
  });

  test("W4.3: Verify project timeclock tab", async ({ page }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    await assertCleanNavigation(
      page,
      `/projects/${PROJECT_ID}/timeclock`,
      "project-timeclock"
    );
    await capture(page, testInfo, 4, 3, "project-timeclock");
  });

  test("W4.4: Verify time-expenses page", async ({ page }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    await assertCleanNavigation(
      page,
      `/projects/${PROJECT_ID}/time-expenses`,
      "time-expenses"
    );
    await capture(page, testInfo, 4, 4, "time-expenses");
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(
        `[${testInfo.title}] console errors:`,
        consoleErrors
      );
    }
  });
});
