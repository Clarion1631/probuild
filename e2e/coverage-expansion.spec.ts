import { test, expect, type Page } from "@playwright/test";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";

const CRASH_REGEX =
  /Something went wrong|Internal Server Error|Application error/i;
const DECIMAL_REGEX = /\[object Object\]|Decimal\{|BigNumber/;
const FORBIDDEN_PATTERNS = [
  { pattern: /\$0[0-9]{4,}/, label: "$079261-style currency bug" },
  { pattern: /NaN/, label: "NaN value" },
];

async function assertCleanPage(page: Page, path: string) {
  const res = await page.goto(path, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  expect(
    res?.status(),
    `${path} returned HTTP ${res?.status()}`
  ).toBeLessThan(400);

  const body = await page.locator("body").innerText();
  expect(body, `${path} shows crash UI`).not.toMatch(CRASH_REGEX);
  expect(body, `${path} leaks Decimal objects`).not.toMatch(DECIMAL_REGEX);
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    expect(body, `${path} contains: ${label}`).not.toMatch(pattern);
  }
}

// ---------------------------------------------------------------------------
// Project sub-pages missing from full-workflow.spec.ts
// ---------------------------------------------------------------------------
test.describe("Coverage — Project Sub-pages", () => {
  test("overview loads", async ({ page }) => {
    const res = await page.goto(`/projects/${PROJECT_ID}/overview`, {
      waitUntil: "networkidle",
    });
    expect(res?.status()).toBeLessThan(500);
  });

  test("messages page loads", async ({ page }) => {
    await assertCleanPage(page, `/projects/${PROJECT_ID}/messages`);
  });

  test("settings page loads", async ({ page }) => {
    await assertCleanPage(page, `/projects/${PROJECT_ID}/settings`);
  });

  test("timeclock page loads", async ({ page }) => {
    await assertCleanPage(page, `/projects/${PROJECT_ID}/timeclock`);
  });
});

// ---------------------------------------------------------------------------
// Portal pages
// ---------------------------------------------------------------------------
test.describe("Coverage — Portal", () => {
  test("/portal loads or redirects", async ({ page }) => {
    const res = await page.goto("/portal", { waitUntil: "networkidle" });
    expect(res?.status()).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Sub-portal pages
// ---------------------------------------------------------------------------
test.describe("Coverage — Sub Portal", () => {
  test("/sub-portal redirects cleanly", async ({ page }) => {
    const res = await page.goto("/sub-portal", { waitUntil: "networkidle" });
    expect(res?.status()).toBeLessThan(500);
  });

  test("/sub-portal/login loads cleanly", async ({ page }) => {
    await assertCleanPage(page, "/sub-portal/login");
  });
});

// ---------------------------------------------------------------------------
// Lead sub-pages (discover ID from list)
// ---------------------------------------------------------------------------
test.describe("Coverage — Lead Sub-pages", () => {
  test("lead detail and sub-pages load", async ({ page }) => {
    await page.goto("/leads", { waitUntil: "networkidle" });
    const firstLink = page.locator('a[href*="/leads/"]').first();
    if ((await firstLink.count()) === 0) {
      test.skip();
      return;
    }
    const href = await firstLink.getAttribute("href");
    if (!href) {
      test.skip();
      return;
    }
    const leadId = href.split("/leads/")[1]?.split("/")[0]?.split("?")[0];
    if (!leadId) {
      test.skip();
      return;
    }

    await assertCleanPage(page, `/leads/${leadId}`);

    const subPages = [
      "contracts",
      "estimates",
      "files",
      "meetings",
      "notes",
      "schedule",
      "takeoffs",
      "tasks",
    ];
    for (const sub of subPages) {
      await assertCleanPage(page, `/leads/${leadId}/${sub}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Company detail pages (discover IDs from list)
// ---------------------------------------------------------------------------
test.describe("Coverage — Company Detail Pages", () => {
  test("team-member detail page loads", async ({ page }) => {
    await page.goto("/company/team-members", { waitUntil: "networkidle" });
    const link = page.locator('a[href*="/company/team-members/"]').first();
    if ((await link.count()) === 0) {
      test.skip();
      return;
    }
    const href = await link.getAttribute("href");
    if (href) await assertCleanPage(page, href);
  });

  test("subcontractor detail page loads", async ({ page }) => {
    await page.goto("/company/subcontractors", { waitUntil: "networkidle" });
    const link = page.locator('a[href*="/company/subcontractors/"]').first();
    if ((await link.count()) === 0) {
      test.skip();
      return;
    }
    const href = await link.getAttribute("href");
    if (href) await assertCleanPage(page, href);
  });
});
