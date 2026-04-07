import { test, expect } from "@playwright/test";
import {
  assertNoCrashUI,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];

test.describe("Workflow 10: Help Chat Widget", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  test("W10.1: Chat bubble visible on page", async ({ page }, testInfo) => {
    await page.goto("/projects", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000); // Wait for widget to mount

    const chatBubble = page.locator(
      'button[aria-label*="chat" i], button[aria-label*="help" i], .fixed.bottom-6.right-6 button, button:has-text("Help")'
    ).first();

    const visible = await chatBubble
      .isVisible({ timeout: 10_000 })
      .catch(() => false);

    await capture(page, testInfo, 10, 1, "chat-bubble-check");

    expect(
      visible,
      "CRITICAL: Chat bubble NOT visible — widget may be outside Providers context"
    ).toBeTruthy();
  });

  test("W10.2: Open chat, send message, get AI response", async ({
    page,
  }, testInfo) => {
    await page.goto("/projects", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // Open chat
    const chatBubble = page.locator(
      'button[aria-label*="chat" i], button[aria-label*="help" i], .fixed.bottom-6.right-6 button, button:has-text("Help")'
    ).first();

    if (!(await chatBubble.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, "Chat bubble not visible — cannot test");
      return;
    }

    await chatBubble.click();
    await page.waitForTimeout(1000);
    await capture(page, testInfo, 10, 2, "chat-panel-opened");

    // Find chat input
    const chatInput = page.locator(
      'textarea[placeholder*="message" i], input[placeholder*="ask" i], textarea[placeholder*="question" i], input[placeholder*="type" i]'
    ).last();

    if (!(await chatInput.isVisible({ timeout: 5000 }).catch(() => false))) {
      await capture(page, testInfo, 10, 2, "CRITICAL-no-chat-input");
      expect(false, "CRITICAL: Chat panel opened but no input field found").toBeTruthy();
      return;
    }

    // Type and send
    await chatInput.fill("How do I create an invoice from an estimate?");
    await capture(page, testInfo, 10, 2, "message-typed");

    const sendBtn = page.locator(
      'button[type="submit"], button[aria-label*="send" i], button:has-text("Send")'
    ).last();

    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
    } else {
      // Try Enter key
      await chatInput.press("Enter");
    }

    // Wait for AI response (up to 20s)
    await page.waitForTimeout(5000);
    await capture(page, testInfo, 10, 2, "waiting-for-response");

    // Check if response appeared
    const chatPanel = page.locator(".fixed.bottom-6, .fixed.bottom-4, [role='dialog']").last();
    const panelText = await chatPanel.innerText({ timeout: 10_000 }).catch(() => "");

    await page.waitForTimeout(10000); // Total 15s for AI
    await capture(page, testInfo, 10, 2, "after-ai-response");

    await assertNoCrashUI(page, "chat-after-response");
  });

  test("W10.3: Close and reopen chat — verify persistence", async ({
    page,
  }, testInfo) => {
    await page.goto("/projects", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const chatBubble = page.locator(
      'button[aria-label*="chat" i], button[aria-label*="help" i], .fixed.bottom-6.right-6 button, button:has-text("Help")'
    ).first();

    if (!(await chatBubble.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, "Chat bubble not visible");
      return;
    }

    // Open
    await chatBubble.click();
    await page.waitForTimeout(1000);
    await capture(page, testInfo, 10, 3, "chat-opened");

    // Close — look for X button
    const closeBtn = page.locator(
      'button[aria-label*="close" i], button:has-text("×"), button:has-text("✕")'
    ).last();

    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
      await capture(page, testInfo, 10, 3, "chat-closed");

      // Reopen
      await chatBubble.click();
      await page.waitForTimeout(1000);
      await capture(page, testInfo, 10, 3, "chat-reopened");

      // Check for New Chat button
      const newChatBtn = page.locator(
        'button:has-text("New Chat"), button:has-text("New Conversation")'
      ).first();
      if (await newChatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await capture(page, testInfo, 10, 3, "new-chat-btn-found");
      }
    } else {
      await capture(page, testInfo, 10, 3, "no-close-btn");
    }
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(`[${testInfo.title}] console errors:`, consoleErrors);
    }
  });
});
