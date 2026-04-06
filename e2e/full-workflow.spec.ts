import { test, expect } from "@playwright/test";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";

const CRASH_REGEX = /Something went wrong|Internal Server Error|Application error/i;
const DECIMAL_REGEX = /\[object Object\]|Decimal\{|BigNumber/;

async function assertPageLoads(page: any, path: string, label: string) {
  const response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 30000 });
  const status = response?.status() ?? 0;
  expect(status, `${label} returned ${status}`).toBeLessThan(500);

  const body = await page.content();
  expect(body, `${label} shows crash UI`).not.toMatch(CRASH_REGEX);
  expect(body, `${label} leaks Decimal objects`).not.toMatch(DECIMAL_REGEX);
}

// ── Planning Pages ───────────────────────────────────────────────
test.describe("Planning Pages", () => {
  test("contracts page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/contracts`, "Contracts");
  });
  test("estimates list loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/estimates`, "Estimates List");
  });
  test("estimate editor loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`, "Estimate Editor");
  });
  test("takeoffs page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/takeoffs`, "Takeoffs");
  });
  test("floor-plans page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/floor-plans`, "Floor Plans");
  });
  test("mood-boards page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/mood-boards`, "Mood Boards");
  });
  test("selections page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/selections`, "Selections");
  });
  test("bid-packages page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/bid-packages`, "Bid Packages");
  });
});

// ── Management Pages ─────────────────────────────────────────────
test.describe("Management Pages", () => {
  test("files page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/files`, "Files");
  });
  test("schedule page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/schedule`, "Schedule");
  });
  test("tasks page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/tasks`, "Tasks");
  });
  test("client-portal page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/client-portal`, "Client Portal");
  });
  test("daily logs page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/dailylogs`, "Daily Logs");
  });
  test("time-expenses page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/time-expenses`, "Time & Expenses");
  });
});

// ── Finance Pages ────────────────────────────────────────────────
test.describe("Finance Pages", () => {
  test("invoices page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/invoices`, "Invoices");
  });
  test("purchase-orders page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/purchase-orders`, "Purchase Orders");
  });
  test("change-orders page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/change-orders`, "Change Orders");
  });
  test("retainers page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/retainers`, "Retainers");
  });
  test("budget page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/budget`, "Budget");
  });
  test("financial-overview page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/financial-overview`, "Financial Overview");
  });
  test("costing page loads", async ({ page }) => {
    await assertPageLoads(page, `/projects/${PROJECT_ID}/costing`, "Costing");
  });
});

// ── Top-Level Pages ──────────────────────────────────────────────
test.describe("Top-Level Pages", () => {
  test("projects list loads", async ({ page }) => {
    await assertPageLoads(page, "/projects", "Projects");
  });
  test("leads page loads", async ({ page }) => {
    await assertPageLoads(page, "/leads", "Leads");
  });
  test("estimates page loads", async ({ page }) => {
    await assertPageLoads(page, "/estimates", "Estimates");
  });
  test("invoices page loads", async ({ page }) => {
    await assertPageLoads(page, "/invoices", "Invoices");
  });
  test("reports page loads", async ({ page }) => {
    await assertPageLoads(page, "/reports", "Reports");
  });
  test("settings page loads", async ({ page }) => {
    await assertPageLoads(page, "/settings", "Settings");
  });
  test("company page loads", async ({ page }) => {
    await assertPageLoads(page, "/company", "Company");
  });
  test("templates page loads", async ({ page }) => {
    await assertPageLoads(page, "/templates", "Templates");
  });
});
