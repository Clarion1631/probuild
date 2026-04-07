import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

let consoleErrors: string[] = [];

test.describe("Workflow 5: Schedule & Task Management", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  test("W5.1: Navigate to /manager/schedule", async ({ page }, testInfo) => {
    await assertCleanNavigation(page, "/manager/schedule", "manager-schedule");
    await capture(page, testInfo, 5, 1, "manager-schedule");
  });

  test("W5.2: Verify project schedule (Gantt)", async ({
    page,
  }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    await assertCleanNavigation(
      page,
      `/projects/${PROJECT_ID}/schedule`,
      "project-schedule"
    );
    await capture(page, testInfo, 5, 2, "project-gantt");
    await assertNoCrashUI(page, "gantt-chart");
  });

  test("W5.3: Verify project tasks page", async ({ page }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    await assertCleanNavigation(
      page,
      `/projects/${PROJECT_ID}/tasks`,
      "project-tasks"
    );
    await capture(page, testInfo, 5, 3, "project-tasks");
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(`[${testInfo.title}] console errors:`, consoleErrors);
    }
  });
});
