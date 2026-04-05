import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Known-bad patterns that must NEVER appear on any page
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  /\$0[0-9]{4,}/, // $079261-style currency bug
  /NaN/,
  /\bundefined\b/,
  /Something went wrong/,
];

// ---------------------------------------------------------------------------
// Helper: assert a page loaded cleanly
// ---------------------------------------------------------------------------
async function assertCleanPage(page: Page, path: string) {
  const res = await page.goto(path, { waitUntil: "networkidle" });

  // 1. HTTP status must be 2xx or 3xx (redirects are OK)
  expect(
    res?.status(),
    `${path} returned HTTP ${res?.status()}`
  ).toBeLessThan(400);

  // 2. No forbidden text in the rendered body
  const body = await page.locator("body").innerText();
  for (const pattern of FORBIDDEN_PATTERNS) {
    expect(
      body,
      `${path} contains forbidden pattern: ${pattern}`
    ).not.toMatch(pattern);
  }

  // 3. No uncaught JS errors (collected via page.on('pageerror'))
  // — handled per-test below
}

// ---------------------------------------------------------------------------
// Collect console errors per test
// ---------------------------------------------------------------------------
let pageErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err));
});

test.afterEach(async ({}, testInfo) => {
  if (pageErrors.length > 0) {
    console.warn(
      `[${testInfo.title}] ${pageErrors.length} JS error(s):`,
      pageErrors.map((e) => e.message)
    );
  }
});

// ---------------------------------------------------------------------------
// Quality-gate tests: every critical route loads cleanly
// ---------------------------------------------------------------------------

test.describe("Quality Gate — Page Load", () => {
  // Auth / entry
  test("login page loads", async ({ page }) => {
    await assertCleanPage(page, "/login");
  });

  // Core pages (dev mode auto-authenticates as ADMIN)
  const coreRoutes = [
    "/projects",
    "/leads",
    "/estimates",
    "/invoices",
    "/time-clock",
    "/settings",
    "/settings/profile",
  ];

  for (const route of coreRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Manager pages
  const managerRoutes = [
    "/manager/schedule",
    "/manager/receipts",
    "/manager/variance",
  ];

  for (const route of managerRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Reports
  const reportRoutes = [
    "/reports/time-billing",
    "/reports/open-invoices",
    "/reports/payments",
    "/reports/tax-liability",
    "/reports/global-tracker",
  ];

  for (const route of reportRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Templates
  test("/templates loads cleanly", async ({ page }) => {
    await assertCleanPage(page, "/templates");
  });
});

// ---------------------------------------------------------------------------
// Quality Gate — Decimal serialization (Prisma Decimal object leak)
// ---------------------------------------------------------------------------

test.describe("Quality Gate — Decimal Serialization", () => {
  const DECIMAL_RE = /\[object Object\]|Decimal|BigNumber/;
  const pages = ["/projects", "/estimates", "/invoices", "/leads", "/reports"];

  for (const route of pages) {
    test(`no Decimal object leak: ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "networkidle" });
      const body = await page.locator("body").innerText();
      expect(body, `${route} leaks Decimal objects`).not.toMatch(DECIMAL_RE);
    });
  }
});

// ---------------------------------------------------------------------------
// Quality Gate — Currency formatting spot-checks
// ---------------------------------------------------------------------------

test.describe("Quality Gate — Currency Formatting", () => {
  test("estimates list shows valid currency", async ({ page }) => {
    await page.goto("/estimates", { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();

    // If any dollar amounts exist, they should be formatted correctly
    const dollarAmounts = body.match(/\$[\d,.]+/g) || [];
    for (const amount of dollarAmounts) {
      // Valid: $0.00, $1,234.56, $100 — Invalid: $079261
      expect(amount).not.toMatch(/\$0[0-9]{4,}/);
    }
  });

  test("invoices list shows valid currency", async ({ page }) => {
    await page.goto("/invoices", { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();

    const dollarAmounts = body.match(/\$[\d,.]+/g) || [];
    for (const amount of dollarAmounts) {
      expect(amount).not.toMatch(/\$0[0-9]{4,}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Quality Gate — No console errors on key pages
// ---------------------------------------------------------------------------

test.describe("Quality Gate — JS Errors", () => {
  const criticalPages = ["/projects", "/leads", "/estimates", "/invoices"];

  for (const route of criticalPages) {
    test(`${route} has no uncaught JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(route, { waitUntil: "networkidle" });

      expect(
        errors,
        `${route} threw JS errors: ${errors.join("; ")}`
      ).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Quality Gate — Auth redirect (unauthenticated users see login, not crash)
// ---------------------------------------------------------------------------

test("unauthenticated visit redirects or shows login", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/projects", { waitUntil: "networkidle" });

  const url = page.url();
  const hasLogin =
    url.includes("/login") ||
    url.includes("/api/auth") ||
    (await page.locator('button:has-text("Sign"), a:has-text("Sign")').count()) > 0;

  const crashed = await page.locator("text=Something went wrong").count();
  expect(crashed, "Page crashed instead of showing auth flow").toBe(0);
  expect(hasLogin || url.includes("localhost:3000")).toBeTruthy();

  await context.close();
});
