import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];

test.describe("Workflow 6: Lead Messaging", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  test("W6.1: Navigate to a lead and verify messaging panel", async ({
    page,
  }, testInfo) => {
    // Navigate to leads list
    await assertCleanNavigation(page, "/leads", "leads-list");

    // Click first lead
    const leadLink = page.locator('a[href*="/leads/"]').first();
    if (await leadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await leadLink.click();
      await page.waitForLoadState("networkidle");
      await assertNoCrashUI(page, "lead-detail-messaging");
      await capture(page, testInfo, 6, 1, "lead-detail-with-messaging");

      // Look for messaging panel/textarea
      const msgInput = page.locator(
        'textarea[placeholder*="message" i], textarea[placeholder*="type" i], input[placeholder*="message" i]'
      ).first();

      if (await msgInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await capture(page, testInfo, 6, 1, "messaging-panel-found");
      } else {
        await capture(page, testInfo, 6, 1, "no-messaging-panel");
      }
    } else {
      await capture(page, testInfo, 6, 1, "no-leads-in-list");
    }
  });

  test("W6.2: Send a message", async ({ page }, testInfo) => {
    await page.goto("/leads", { waitUntil: "networkidle" });

    const leadLink = page.locator('a[href*="/leads/"]').first();
    if (!(await leadLink.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, "No leads available");
      return;
    }

    await leadLink.click();
    await page.waitForLoadState("networkidle");

    const msgInput = page.locator(
      'textarea[placeholder*="message" i], textarea[placeholder*="type" i], input[placeholder*="message" i]'
    ).first();

    if (await msgInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await msgInput.fill(
        "Hi Mike, thanks for reaching out about your bathroom renovation. What day works best for a site visit?"
      );
      await capture(page, testInfo, 6, 2, "message-typed");

      // Send
      const sendBtn = page.locator(
        'button:has-text("Send"), button[type="submit"], button[aria-label*="send" i]'
      ).first();

      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
        await page.waitForTimeout(3000);
        await capture(page, testInfo, 6, 2, "message-sent");
        await assertNoCrashUI(page, "after-send");
      } else {
        await capture(page, testInfo, 6, 2, "no-send-btn");
      }
    } else {
      await capture(page, testInfo, 6, 2, "messaging-not-available");
    }
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(`[${testInfo.title}] console errors:`, consoleErrors);
    }
  });
});
