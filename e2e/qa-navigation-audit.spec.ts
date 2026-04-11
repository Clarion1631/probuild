import { test, expect } from "@playwright/test";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  setupConsoleErrorCollector,
  capture,
} from "./helpers/fail-loud";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
let consoleErrors: string[] = [];

test.describe("Workflow 9: Navigation Audit", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  // -----------------------------------------------------------------------
  // SIDEBAR NAVIGATION
  // -----------------------------------------------------------------------

  test("W9.1: All top-level sidebar pages load", async ({
    page,
  }, testInfo) => {
    const sidebarRoutes = [
      "/projects",
      "/leads",
      "/invoices",
      "/estimates",
      "/time-clock",
      "/templates",
    ];

    for (const route of sidebarRoutes) {
      await assertCleanNavigation(page, route, `sidebar-${route}`);
    }
    await capture(page, testInfo, 9, 1, "sidebar-pages-clean");
  });

  test("W9.2: Company section pages load", async ({ page }, testInfo) => {
    const companyRoutes = [
      "/company/team-members",
      "/company/subcontractors",
      "/company/vendors",
      "/company/cost-codes",
      "/company/catalogs",
      "/company/my-items",
    ];

    for (const route of companyRoutes) {
      await assertCleanNavigation(page, route, `company-${route}`);
    }
    await capture(page, testInfo, 9, 2, "company-pages-clean");
  });

  test("W9.3: Settings section pages load", async ({ page }, testInfo) => {
    const settingsRoutes = [
      "/settings/company",
      "/settings/contacts",
      "/settings/cost-codes",
      "/settings/calendar",
      "/settings/integrations",
      "/settings/payment-methods",
      "/settings/notifications",
      "/settings/sales-taxes",
      "/settings/language",
      "/settings/privacy",
    ];

    for (const route of settingsRoutes) {
      await assertCleanNavigation(page, route, `settings-${route}`);
    }
    await capture(page, testInfo, 9, 3, "settings-pages-clean");
  });

  test("W9.4: Manager section pages load", async ({ page }, testInfo) => {
    const managerRoutes = [
      "/manager/schedule",
      "/manager/receipts",
      "/manager/variance",
      "/manager/time-entries",
    ];

    for (const route of managerRoutes) {
      await assertCleanNavigation(page, route, `manager-${route}`);
    }
    await capture(page, testInfo, 9, 4, "manager-pages-clean");
  });

  test("W9.5: Reports section pages load", async ({ page }, testInfo) => {
    const reportRoutes = [
      "/reports",
      "/reports/payments",
      "/reports/open-invoices",
      "/reports/payouts",
      "/reports/transactions",
      "/reports/tax-liability",
      "/reports/time-billing",
      "/reports/global-tracker",
    ];

    for (const route of reportRoutes) {
      await assertCleanNavigation(page, route, `reports-${route}`);
    }
    await capture(page, testInfo, 9, 5, "reports-pages-clean");
  });

  test("W9.6: Template section pages load", async ({ page }, testInfo) => {
    const templateRoutes = [
      "/templates",
      "/templates/mood-boards",
      "/templates/schedules",
      "/templates/selections",
    ];

    for (const route of templateRoutes) {
      await assertCleanNavigation(page, route, `templates-${route}`);
    }
    await capture(page, testInfo, 9, 6, "template-pages-clean");
  });

  // -----------------------------------------------------------------------
  // PROJECT SUB-PAGES (the big one)
  // -----------------------------------------------------------------------

  test("W9.7: All project sub-pages load", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const projectSubPages = [
      `/projects/${PROJECT_ID}`,
      `/projects/${PROJECT_ID}/overview`,
      `/projects/${PROJECT_ID}/estimates`,
      `/projects/${PROJECT_ID}/invoices`,
      `/projects/${PROJECT_ID}/contracts`,
      `/projects/${PROJECT_ID}/change-orders`,
      `/projects/${PROJECT_ID}/purchase-orders`,
      `/projects/${PROJECT_ID}/schedule`,
      `/projects/${PROJECT_ID}/tasks`,
      `/projects/${PROJECT_ID}/takeoffs`,
      `/projects/${PROJECT_ID}/floor-plans`,
      `/projects/${PROJECT_ID}/dailylogs`,
      `/projects/${PROJECT_ID}/budget`,
      `/projects/${PROJECT_ID}/costing`,
      `/projects/${PROJECT_ID}/financial-overview`,
      `/projects/${PROJECT_ID}/selections`,
      `/projects/${PROJECT_ID}/mood-boards`,
      `/projects/${PROJECT_ID}/messages`,
      `/projects/${PROJECT_ID}/timeclock`,
      `/projects/${PROJECT_ID}/time-expenses`,
      `/projects/${PROJECT_ID}/files`,
      `/projects/${PROJECT_ID}/bid-packages`,
      `/projects/${PROJECT_ID}/retainers`,
      `/projects/${PROJECT_ID}/settings`,
      `/projects/${PROJECT_ID}/client-portal`,
    ];

    let failures: string[] = [];

    for (const route of projectSubPages) {
      try {
        await assertCleanNavigation(page, route, route);
      } catch (err: any) {
        failures.push(`${route}: ${err.message}`);
        await capture(
          page,
          testInfo,
          9,
          7,
          `FAIL-${route.split("/").pop()}`
        );
      }
    }

    await capture(page, testInfo, 9, 7, "project-subpages-done");

    if (failures.length > 0) {
      console.error("CRITICAL — Failed project sub-pages:", failures);
    }
    expect(
      failures,
      `${failures.length} project sub-page(s) failed:\n${failures.join("\n")}`
    ).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // PORTAL PAGES
  // -----------------------------------------------------------------------

  test("W9.8: Portal and sub-portal pages load", async ({
    page,
  }, testInfo) => {
    const portalRoutes = ["/portal", "/sub-portal"];

    for (const route of portalRoutes) {
      await assertCleanNavigation(page, route, `portal-${route}`);
    }
    await capture(page, testInfo, 9, 8, "portal-pages-clean");
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(`[${testInfo.title}] console errors:`, consoleErrors);
    }
  });
});
