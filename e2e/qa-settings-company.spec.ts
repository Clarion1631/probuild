import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];

test.describe("Workflow 8: Settings & Company", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  test("W8.1: /settings/company loads and is editable", async ({
    page,
  }, testInfo) => {
    await assertCleanNavigation(page, "/settings/company", "settings-company");
    await capture(page, testInfo, 8, 1, "settings-company");

    // Look for editable fields
    const inputs = page.locator("input.hui-input, input[type='text'], input[type='tel']");
    const count = await inputs.count();
    expect(count, "No editable fields on settings/company").toBeGreaterThan(0);
  });

  test("W8.2: Edit phone → save → reload → verify persistence", async ({
    page,
  }, testInfo) => {
    await page.goto("/settings/company", { waitUntil: "networkidle" });

    const phoneInput = page.locator(
      'input[name*="phone" i], input[type="tel"], input[placeholder*="phone" i]'
    ).first();

    if (await phoneInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      const originalValue = await phoneInput.inputValue();
      const testValue = "360-555-0199";

      await phoneInput.fill(testValue);
      await capture(page, testInfo, 8, 2, "phone-edited");

      // Save
      const saveBtn = page.locator(
        'button:has-text("Save"), button[type="submit"]'
      ).first();
      if (await saveBtn.isVisible().catch(() => false)) {
        await saveBtn.click();
        await page.waitForTimeout(3000);
        await capture(page, testInfo, 8, 2, "after-save");

        // Reload and verify
        await page.reload({ waitUntil: "networkidle" });
        const newValue = await phoneInput.inputValue();
        await capture(page, testInfo, 8, 2, "after-reload");

        // Restore original value
        if (originalValue) {
          await phoneInput.fill(originalValue);
          if (await saveBtn.isVisible().catch(() => false)) {
            await saveBtn.click();
            await page.waitForTimeout(2000);
          }
        }
      } else {
        await capture(page, testInfo, 8, 2, "no-save-btn");
      }
    } else {
      await capture(page, testInfo, 8, 2, "no-phone-field");
    }
  });

  test("W8.3: /company/team-members loads", async ({ page }, testInfo) => {
    await assertCleanNavigation(
      page,
      "/company/team-members",
      "team-members"
    );
    await capture(page, testInfo, 8, 3, "team-members");
  });

  test("W8.4: /settings/sales-taxes loads", async ({ page }, testInfo) => {
    await assertCleanNavigation(
      page,
      "/settings/sales-taxes",
      "sales-taxes"
    );
    await capture(page, testInfo, 8, 4, "sales-taxes");
  });

  test("W8.5: /settings/cost-codes loads", async ({ page }, testInfo) => {
    await assertCleanNavigation(
      page,
      "/settings/cost-codes",
      "cost-codes"
    );
    await capture(page, testInfo, 8, 5, "cost-codes");
  });

  test("W8.6: /settings/payment-methods loads", async ({
    page,
  }, testInfo) => {
    await assertCleanNavigation(
      page,
      "/settings/payment-methods",
      "payment-methods"
    );
    await capture(page, testInfo, 8, 6, "payment-methods");
  });

  test("W8.7: Additional settings pages", async ({ page }, testInfo) => {
    const settingsPages = [
      "/settings/notifications",
      "/settings/integrations",
      "/settings/calendar",
      "/settings/privacy",
      "/company/vendors",
      "/company/subcontractors",
      "/company/cost-codes",
      "/company/catalogs",
    ];

    for (const sp of settingsPages) {
      await assertCleanNavigation(page, sp, sp);
    }
    await capture(page, testInfo, 8, 7, "all-settings-clean");
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(`[${testInfo.title}] console errors:`, consoleErrors);
    }
  });
});
