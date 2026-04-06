import { test, expect } from "@playwright/test";

const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";

// Bad currency: $079261 (Decimal serialization bug)
const BAD_CURRENCY = /\$0[0-9]{4,}/;

// ── Projects List ───────────────────────────────────────────────
test.describe("Projects List", () => {
  test("renders stats, table headers, and data rows", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "networkidle" });

    // Heading with project count
    await expect(
      page.locator("h1, h2").filter({ hasText: /All Projects/i })
    ).toBeVisible();

    // Stat cards render real labels
    await expect(page.getByText("Total Projects")).toBeVisible();
    await expect(page.getByText("In Progress")).toBeVisible();
    await expect(page.getByText("Total Revenue")).toBeVisible();

    // Table has expected columns
    await expect(page.locator("th").filter({ hasText: "Project Name" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Status" })).toBeVisible();

    // At least one data row (not stuck on loading / empty)
    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("Create Project button is visible and enabled", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "networkidle" });

    const btn = page.locator("button, a").filter({ hasText: "Create Project" });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test("project row links to project detail", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "networkidle" });

    const link = page.locator("tbody tr a").first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    await link.click();
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/projects/");
    await expect(page.getByText("Something went wrong")).not.toBeVisible();
  });

  test("no bad currency formatting", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "networkidle" });

    const body = await page.locator("body").innerText();
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency on /projects: ${amt}`).not.toMatch(BAD_CURRENCY);
    }
  });
});

// ── Leads List ──────────────────────────────────────────────────
test.describe("Leads List", () => {
  test("renders stats, tabs, search, and table", async ({ page }) => {
    await page.goto("/leads", { waitUntil: "networkidle" });

    await expect(
      page.locator("h1, h2").filter({ hasText: "Leads" })
    ).toBeVisible();

    // Stat cards
    await expect(page.getByText("Total Leads")).toBeVisible();
    await expect(page.getByText("Pipeline Value")).toBeVisible();

    // Tabs
    for (const tab of ["All", "New", "Hot", "Qualified", "Won", "Lost"]) {
      await expect(page.locator("button").filter({ hasText: tab }).first()).toBeVisible();
    }

    // Search bar
    await expect(page.locator("input[placeholder*='Search leads']")).toBeVisible();

    // Table header
    await expect(page.locator("th").filter({ hasText: "Lead Name" })).toBeVisible();
  });

  test("Add Lead button is visible and enabled", async ({ page }) => {
    await page.goto("/leads", { waitUntil: "networkidle" });

    const btn = page.locator("button").filter({ hasText: "Add Lead" });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test("tab click filters without crash", async ({ page }) => {
    await page.goto("/leads", { waitUntil: "networkidle" });

    const snoozed = page.locator("button").filter({ hasText: "Snoozed" });
    await expect(snoozed).toBeVisible();
    await snoozed.click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Something went wrong")).not.toBeVisible();
  });
});

// ── Global Estimates ────────────────────────────────────────────
test.describe("Global Estimates", () => {
  test("renders table with columns and data or empty state", async ({ page }) => {
    await page.goto("/estimates", { waitUntil: "networkidle" });

    await expect(
      page.locator("h1, h2").filter({ hasText: "Estimates" })
    ).toBeVisible();

    // Table columns
    await expect(page.locator("th").filter({ hasText: "Title" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Status" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Total" })).toBeVisible();

    // Data rows or explicit empty state — never stuck loading
    const rows = page.locator("tbody tr");
    const empty = page.getByText("No estimates found");
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("no bad currency formatting", async ({ page }) => {
    await page.goto("/estimates", { waitUntil: "networkidle" });

    const body = await page.locator("body").innerText();
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency on /estimates: ${amt}`).not.toMatch(BAD_CURRENCY);
    }
  });
});

// ── Global Invoices ─────────────────────────────────────────────
test.describe("Global Invoices", () => {
  test("renders stats, tabs, search, and table", async ({ page }) => {
    await page.goto("/invoices", { waitUntil: "networkidle" });

    await expect(
      page.locator("h1, h2").filter({ hasText: /All Invoices/i })
    ).toBeVisible();

    // Stat cards
    await expect(page.getByText("Total Invoiced")).toBeVisible();
    await expect(page.getByText("Collected")).toBeVisible();
    await expect(page.getByText("Outstanding")).toBeVisible();

    // Tabs
    for (const tab of ["All", "Draft", "Paid", "Overdue"]) {
      await expect(page.locator("button").filter({ hasText: tab }).first()).toBeVisible();
    }

    // Table columns
    await expect(page.locator("th").filter({ hasText: "Invoice #" })).toBeVisible();
    await expect(page.locator("th").filter({ hasText: "Total" })).toBeVisible();

    // Search
    await expect(page.locator("input[placeholder*='Search invoices']")).toBeVisible();
  });

  test("no bad currency formatting", async ({ page }) => {
    await page.goto("/invoices", { waitUntil: "networkidle" });

    const body = await page.locator("body").innerText();
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency on /invoices: ${amt}`).not.toMatch(BAD_CURRENCY);
    }
  });
});

// ── Project Estimates ───────────────────────────────────────────
test.describe("Project Estimates", () => {
  test("renders stat cards, New Estimate button, and rows", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/estimates`, {
      waitUntil: "networkidle",
    });

    // Stat cards
    await expect(page.getByText("Total Approved")).toBeVisible();
    await expect(page.getByText("Total Value")).toBeVisible();
    await expect(page.getByText("Win Rate")).toBeVisible();

    // CTA button
    const btn = page.locator("button").filter({ hasText: "New Estimate" });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();

    // Data rows or empty state
    const rows = page.locator("tbody tr");
    const empty = page.getByText("No estimates yet");
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 10_000 });
  });

  test("clicking an estimate navigates to editor", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/estimates`, {
      waitUntil: "networkidle",
    });

    const link = page.locator("tbody tr a").first();
    if ((await link.count()) > 0) {
      await link.click();
      await page.waitForURL(/estimates\//, { timeout: 10_000 });
      expect(page.url()).toContain("/estimates/");
      await expect(page.getByText("Something went wrong")).not.toBeVisible();
    }
  });
});

// ── Estimate Editor ─────────────────────────────────────────────
test.describe("Estimate Editor", () => {
  test("loads real editor UI (not crash screen)", async ({ page }) => {
    await page.goto(
      `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`,
      { waitUntil: "networkidle" }
    );

    // Editor must have recognizable UI elements
    const hasEditor =
      (await page.locator('input[placeholder*="Estimate"]').count()) > 0 ||
      (await page.locator("button").filter({ hasText: "Builder" }).count()) > 0 ||
      (await page.locator('[data-testid="estimate-editor"]').count()) > 0;
    expect(hasEditor, "Estimate editor UI not found").toBeTruthy();

    await expect(page.getByText("Something went wrong")).not.toBeVisible();
  });

  test("no bad currency in editor", async ({ page }) => {
    await page.goto(
      `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`,
      { waitUntil: "networkidle" }
    );

    const body = await page.locator("body").innerText();
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency in estimate editor: ${amt}`).not.toMatch(
        BAD_CURRENCY
      );
    }
  });
});

// ── Project Schedule ────────────────────────────────────────────
test.describe("Project Schedule", () => {
  test("renders schedule heading and content", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`, {
      waitUntil: "networkidle",
    });

    await expect(
      page.locator("h1, h2, h3").filter({ hasText: "Schedule" })
    ).toBeVisible();

    await expect(page.getByText("Something went wrong")).not.toBeVisible();

    // Should not be stuck loading forever
    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(50);
  });
});

// ── Project Invoices ────────────────────────────────────────────
test.describe("Project Invoices", () => {
  test("renders stats, table or empty state, and CTA", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/invoices`, {
      waitUntil: "networkidle",
    });

    // Heading
    await expect(
      page.locator("h1, h2, h3").filter({ hasText: "Invoices" })
    ).toBeVisible();

    // Stat cards
    await expect(page.getByText("Total Invoiced")).toBeVisible();
    await expect(page.getByText("Balance Due")).toBeVisible();

    // Rows or empty state
    const rows = page.locator("tbody tr");
    const empty = page.getByText(/Create an invoice/i);
    await expect(rows.first().or(empty)).toBeVisible({ timeout: 10_000 });

    // New Invoice button
    const btn = page.locator("button").filter({ hasText: "New Invoice" });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test("no bad currency formatting", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/invoices`, {
      waitUntil: "networkidle",
    });

    const body = await page.locator("body").innerText();
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency on project invoices: ${amt}`).not.toMatch(
        BAD_CURRENCY
      );
    }
  });
});

// ── Project Budget ──────────────────────────────────────────────
test.describe("Project Budget", () => {
  test("renders summary cards with real content", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/budget`, {
      waitUntil: "networkidle",
    });

    await expect(page.getByText("Something went wrong")).not.toBeVisible();

    // Budget content should be present (not empty / not loading)
    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(100);

    // Currency check
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency on budget: ${amt}`).not.toMatch(BAD_CURRENCY);
    }
  });
});

// ── Financial Overview ──────────────────────────────────────────
test.describe("Financial Overview", () => {
  test("renders heading and financial cards", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/financial-overview`, {
      waitUntil: "networkidle",
    });

    await expect(
      page.locator("h1, h2, h3").filter({ hasText: "Financial Overview" })
    ).toBeVisible();

    await expect(page.getByText("Cash Flow")).toBeVisible();
    await expect(page.getByText("Incoming Payments")).toBeVisible();
    await expect(page.getByText("Outgoing Payments")).toBeVisible();

    await expect(page.getByText("Something went wrong")).not.toBeVisible();

    // Currency check
    const body = await page.locator("body").innerText();
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      expect(amt, `Bad currency: ${amt}`).not.toMatch(BAD_CURRENCY);
    }
  });
});

// ── Reports Hub ─────────────────────────────────────────────────
test.describe("Reports Hub", () => {
  test("renders all report sections with View Report links", async ({ page }) => {
    await page.goto("/reports", { waitUntil: "networkidle" });

    await expect(
      page.locator("h1, h2").filter({ hasText: "Reports" })
    ).toBeVisible();

    // Section headings
    for (const section of ["Payments", "Tax & Compliance", "Project Financials", "Time & Labor"]) {
      await expect(page.getByText(section).first()).toBeVisible();
    }

    // View Report links/buttons exist
    const viewBtns = page.locator("a, button").filter({ hasText: "View Report" });
    expect(await viewBtns.count()).toBeGreaterThan(0);
  });

  test("clicking View Report navigates without crash", async ({ page }) => {
    await page.goto("/reports", { waitUntil: "networkidle" });

    const link = page.locator("a").filter({ hasText: "View Report" }).first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForLoadState("networkidle");

    expect(page.url()).toContain("/reports/");
    await expect(page.getByText("Something went wrong")).not.toBeVisible();
  });
});

// ── Settings ────────────────────────────────────────────────────
test.describe("Settings", () => {
  test("loads settings page with real content", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });

    await expect(page.getByText("Something went wrong")).not.toBeVisible();

    // Should render settings or redirect to company settings
    const hasContent =
      (await page.getByText("Company Settings").count()) > 0 ||
      (await page.getByText("Settings").count()) > 0;
    expect(hasContent, "Settings page has no content").toBeTruthy();
  });
});

// ── Company ─────────────────────────────────────────────────────
test.describe("Company", () => {
  test("loads company page with real content", async ({ page }) => {
    await page.goto("/company", { waitUntil: "networkidle" });

    await expect(page.getByText("Something went wrong")).not.toBeVisible();

    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(100);
  });
});

// ── Cross-Page Navigation ───────────────────────────────────────
test.describe("Navigation", () => {
  test("sidebar Leads link navigates correctly", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "networkidle" });

    const link = page.locator("a[href='/leads']").first();
    if ((await link.count()) > 0) {
      await link.click();
      await page.waitForURL("**/leads**", { timeout: 10_000 });
      await expect(page.getByText("Something went wrong")).not.toBeVisible();
      await expect(
        page.locator("h1, h2").filter({ hasText: "Leads" })
      ).toBeVisible();
    }
  });

  test("sidebar Invoices link navigates correctly", async ({ page }) => {
    await page.goto("/projects", { waitUntil: "networkidle" });

    const link = page.locator("a[href='/invoices']").first();
    if ((await link.count()) > 0) {
      await link.click();
      await page.waitForURL("**/invoices**", { timeout: 10_000 });
      await expect(page.getByText("Something went wrong")).not.toBeVisible();
      await expect(
        page.locator("h1, h2").filter({ hasText: /Invoices/i })
      ).toBeVisible();
    }
  });
});
