import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoErrorToasts,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];
let createdTimeEntryId: string | undefined;

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
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    const PHASE_ID = "e2e-mob-cc-dryw";

    createdTimeEntryId = undefined;
    await page.goto("/time-clock", { waitUntil: "networkidle" });
    await capture(page, testInfo, 4, 2, "before-clock-in");

    // This fixture has approved estimate phases. Choose it explicitly: the phase-only
    // clock-in contract rejects a generic project-only punch.
    const projectSelect = page.locator("select").first();
    await expect(projectSelect, "project selector is visible").toBeVisible();
    await projectSelect.selectOption(PROJECT_ID);

    const phaseSelect = page
      .locator("label")
      .filter({ hasText: "Phase" })
      .locator("..")
      .locator("select");
    await expect(phaseSelect, "phase selector appears after project selection").toBeVisible();
    await expect(
      phaseSelect.locator(`option[value="${PHASE_ID}"]`),
      "fixture phase is loaded before clock-in"
    ).toHaveCount(1);
    await phaseSelect.selectOption(PHASE_ID);

    const clockInBtn = page.getByRole("button", { name: "Clock In", exact: true });
    await expect(clockInBtn, "clock-in button is enabled after phase selection").toBeEnabled();
    const [clockInResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/time-entries" &&
          response.request().method() === "POST"
      ),
      clockInBtn.click(),
    ]);
    expect(clockInResponse.ok(), "clock-in request succeeds").toBe(true);
    const clockedInEntry = (await clockInResponse.json()) as { id?: string };
    expect(clockedInEntry.id, "clock-in response returns the created entry ID").toEqual(expect.any(String));
    createdTimeEntryId = clockedInEntry.id;
    await expect(page.getByText("Status: Clocked In", { exact: true })).toBeVisible();
    await capture(page, testInfo, 4, 2, "clocked-in");

    await page.waitForTimeout(3000);

    const clockOutBtn = page.getByRole("button", { name: "Clock Out", exact: true });
    await expect(clockOutBtn, "clock-out button is enabled").toBeEnabled();
    const [clockOutResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/time-entries" &&
          response.request().method() === "PUT"
      ),
      clockOutBtn.click(),
    ]);
    expect(clockOutResponse.ok(), "clock-out request succeeds").toBe(true);
    await expect(page.getByText("Status: Clocked Out", { exact: true })).toBeVisible();
    await capture(page, testInfo, 4, 2, "clocked-out");
    await assertNoErrorToasts(page, "after-clock-out");
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

  test.afterEach(async ({ page }, testInfo) => {
    if (createdTimeEntryId) {
      try {
        const cleanup = await page.evaluate(async (id) => {
          const response = await fetch(`/api/time-entries/${id}`, { method: "DELETE" });
          return { ok: response.ok, status: response.status };
        }, createdTimeEntryId);
        expect(cleanup.ok, `delete test time entry (${cleanup.status})`).toBe(true);
      } finally {
        createdTimeEntryId = undefined;
      }
    }

    if (consoleErrors.length > 0) {
      console.warn(
        `[${testInfo.title}] console errors:`,
        consoleErrors
      );
    }
  });
});
