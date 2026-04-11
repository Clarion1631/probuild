import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  assertCurrencyValues,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];

test.describe("Workflow 7: Client Portal", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  test("W7.1: Navigate to /portal — no crash", async ({
    page,
  }, testInfo) => {
    await assertCleanNavigation(page, "/portal", "client-portal");
    await capture(page, testInfo, 7, 1, "portal-home");
    await assertCurrencyValues(page, "portal-home");
  });

  test("W7.2: Click into a project from portal", async ({
    page,
  }, testInfo) => {
    await page.goto("/portal", { waitUntil: "networkidle" });

    const projectLink = page.locator('a[href*="/portal/projects/"]').first();
    if (await projectLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await projectLink.click();
      await page.waitForLoadState("networkidle");
      await assertNoCrashUI(page, "portal-project-detail");
      await assertCurrencyValues(page, "portal-project");
      await capture(page, testInfo, 7, 2, "portal-project-detail");
    } else {
      await capture(page, testInfo, 7, 2, "no-portal-projects");
    }
  });

  test("W7.3: Check portal estimate view", async ({ page }, testInfo) => {
    await page.goto("/portal", { waitUntil: "networkidle" });

    // Look for estimate links
    const estLink = page.locator('a[href*="/portal/estimates/"]').first();
    if (await estLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await estLink.click();
      await page.waitForLoadState("networkidle");
      await assertNoCrashUI(page, "portal-estimate");
      await assertCurrencyValues(page, "portal-estimate");
      await capture(page, testInfo, 7, 3, "portal-estimate");
    } else {
      // Navigate to project first, then look for estimates
      const projectLink = page.locator('a[href*="/portal/projects/"]').first();
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click();
        await page.waitForLoadState("networkidle");
        await capture(page, testInfo, 7, 3, "portal-project-for-estimate");
        await assertCurrencyValues(page, "portal-project-estimates");
      } else {
        await capture(page, testInfo, 7, 3, "no-portal-estimates");
      }
    }
  });

  test("W7.4: Check portal invoice view", async ({ page }, testInfo) => {
    const invoiceLink = page.locator('a[href*="/portal/invoices/"]').first();
    await page.goto("/portal", { waitUntil: "networkidle" });

    // Navigate through project to find invoices
    const projectLink = page.locator('a[href*="/portal/projects/"]').first();
    if (await projectLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await projectLink.click();
      await page.waitForLoadState("networkidle");

      const invLink = page.locator('a[href*="/portal/invoices/"]').first();
      if (await invLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await invLink.click();
        await page.waitForLoadState("networkidle");
        await assertNoCrashUI(page, "portal-invoice");
        await assertCurrencyValues(page, "portal-invoice");
        await capture(page, testInfo, 7, 4, "portal-invoice");
      } else {
        await capture(page, testInfo, 7, 4, "no-portal-invoices-found");
      }
    }
  });

  test("W7.5: Check sub-portal", async ({ page }, testInfo) => {
    await assertCleanNavigation(page, "/sub-portal", "sub-portal");
    await capture(page, testInfo, 7, 5, "sub-portal");
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(`[${testInfo.title}] console errors:`, consoleErrors);
    }
  });
});
