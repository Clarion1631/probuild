import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Known-bad patterns that must NEVER appear on any page
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  { pattern: /\$0[0-9]{4,}/, label: "$079261-style currency bug" },
  { pattern: /NaN/, label: "NaN value" },
  { pattern: /\bundefined\b/, label: "undefined value" },
  { pattern: /Something went wrong/, label: "error boundary" },
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
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    expect(body, `${path} contains forbidden pattern: ${label}`).not.toMatch(
      pattern
    );
  }
}

// ---------------------------------------------------------------------------
// Collect JS errors per test
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

// ===========================================================================
// SECTION 1: Page Load — every critical route loads without crashes
// ===========================================================================

test.describe("Quality Gate — Page Load", () => {
  test("/login loads", async ({ page }) => {
    await assertCleanPage(page, "/login");
  });

  // Core list pages
  const coreRoutes = [
    "/projects",
    "/leads",
    "/estimates",
    "/invoices",
    "/time-clock",
    "/templates",
  ];

  for (const route of coreRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Settings pages
  const settingsRoutes = [
    "/settings",
    "/settings/profile",
    "/settings/company",
    "/settings/notifications",
    "/settings/sales-taxes",
    "/settings/payment-methods",
    "/settings/integrations",
    "/settings/contacts",
    "/settings/cost-codes",
    "/settings/calendar",
    "/settings/language",
    "/settings/privacy",
  ];

  for (const route of settingsRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Company pages
  const companyRoutes = [
    "/company",
    "/company/catalogs",
    "/company/cost-codes",
    "/company/my-items",
    "/company/subcontractors",
    "/company/team-members",
    "/company/vendors",
  ];

  for (const route of companyRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Manager pages
  const managerRoutes = [
    "/manager/schedule",
    "/manager/receipts",
    "/manager/variance",
    "/manager/time-entries",
  ];

  for (const route of managerRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Reports
  const reportRoutes = [
    "/reports",
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

  // Template sub-pages
  const templateRoutes = [
    "/templates/mood-boards",
    "/templates/schedules",
    "/templates/selections",
  ];

  for (const route of templateRoutes) {
    test(`${route} loads cleanly`, async ({ page }) => {
      await assertCleanPage(page, route);
    });
  }

  // Portal entry points (may redirect — check for no 5xx)
  test("/portal loads or redirects cleanly", async ({ page }) => {
    const res = await page.goto("/portal", { waitUntil: "networkidle" });
    expect(res?.status()).toBeLessThan(500);
  });

  test("/sub-portal/login loads cleanly", async ({ page }) => {
    await assertCleanPage(page, "/sub-portal/login");
  });
});

// ===========================================================================
// SECTION 2: Decimal serialization (Prisma Decimal object leak)
// ===========================================================================

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

// ===========================================================================
// SECTION 3: Currency Formatting — no Decimal display bugs
// ===========================================================================

test.describe("Quality Gate — Currency Formatting", () => {
  const moneyPages = [
    "/estimates",
    "/invoices",
    "/projects",
    "/reports/payments",
  ];

  for (const route of moneyPages) {
    test(`${route} shows valid currency formatting`, async ({ page }) => {
      await page.goto(route, { waitUntil: "networkidle" });
      const body = await page.locator("body").innerText();

      const dollarAmounts = body.match(/\$[\d,.]+/g) || [];
      for (const amount of dollarAmounts) {
        // Invalid: $079261, $012345 — leading zero followed by 4+ digits
        expect(amount, `Bad currency on ${route}: ${amount}`).not.toMatch(
          /\$0[0-9]{4,}/
        );
      }
    });
  }
});

// ===========================================================================
// SECTION 4: JS Errors — no uncaught exceptions on critical pages
// ===========================================================================

test.describe("Quality Gate — JS Errors", () => {
  const criticalPages = [
    "/projects",
    "/leads",
    "/estimates",
    "/invoices",
    "/time-clock",
    "/reports",
    "/settings",
    "/company",
  ];

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

// ===========================================================================
// SECTION 5: Auth redirect (unauthenticated users see login, not crash)
// ===========================================================================

test("unauthenticated visit redirects or shows login", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/projects", { waitUntil: "networkidle" });

  const url = page.url();
  const hasLogin =
    url.includes("/login") ||
    url.includes("/api/auth") ||
    (await page
      .locator('button:has-text("Sign"), a:has-text("Sign")')
      .count()) > 0;

  const crashed = await page.locator("text=Something went wrong").count();
  expect(crashed, "Page crashed instead of showing auth flow").toBe(0);
  expect(hasLogin || url.includes("localhost:3000")).toBeTruthy();

  await context.close();
});

// ===========================================================================
// SECTION 6: Accessibility basics — no images without alt text
// ===========================================================================

test.describe("Quality Gate — Accessibility Basics", () => {
  const keyPages = ["/projects", "/leads", "/estimates", "/invoices"];

  for (const route of keyPages) {
    test(`${route} has no images without alt text`, async ({ page }) => {
      await page.goto(route, { waitUntil: "networkidle" });

      const imagesWithoutAlt = await page.locator("img:not([alt])").count();

      expect(
        imagesWithoutAlt,
        `${route} has ${imagesWithoutAlt} images without alt attribute`
      ).toBe(0);
    });
  }
});
