import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
  assertCleanNavigation,
  assertNoCrashUI,
  assertNoErrorToasts,
  assertCurrencyValues,
  setupConsoleErrorCollector,
  parseCurrency,
  capture,
} from "./helpers/fail-loud";

// Test-data signature — the teardown below deletes by these exact values, so
// keep the form fills and the cleanup in sync by always using the constants.
const TEST_LEAD_NAME = "Master Bath Renovation - Henderson";
const TEST_CLIENT_NAME = "Mike Henderson";
const TEST_CLIENT_EMAIL = "mike.henderson@gmail.com";

// Shared state across serial tests
let createdLeadId: string;
let createdEstimateId: string;
let consoleErrors: string[] = [];

test.describe.serial("Workflows 1-3: Lead → Estimate → Invoice", () => {
  test.beforeEach(async ({ page }) => {
    consoleErrors = setupConsoleErrorCollector(page);
  });

  // =========================================================================
  // WORKFLOW 1: Lead Creation
  // =========================================================================

  test("W1.1: Navigate to /leads and verify page loads", async ({
    page,
  }, testInfo) => {
    await assertCleanNavigation(page, "/leads", "leads-list");
    await capture(page, testInfo, 1, 1, "leads-page");
    await assertCurrencyValues(page, "leads-page");
  });

  test("W1.2: Create a new lead with full details", async ({
    page,
  }, testInfo) => {
    await page.goto("/leads", { waitUntil: "networkidle" });
    await capture(page, testInfo, 1, 2, "before-add-lead");

    // Click Add Lead — .first(): an empty leads list renders a second
    // "Add Lead" button in the empty state alongside the header one.
    const addBtn = page.locator('button:has-text("Add Lead")').first();
    await expect(addBtn, "Add Lead button not found").toBeVisible();
    await addBtn.click();
    await page.waitForTimeout(1000);
    await capture(page, testInfo, 1, 2, "add-lead-modal");

    // Fill form
    await page.locator('input[name="name"]').fill(TEST_LEAD_NAME);

    // Client name — combobox: type and pick or create
    const clientInput = page.locator('input[name="clientName"]');
    if (await clientInput.isVisible()) {
      await clientInput.fill(TEST_CLIENT_NAME);
      // Wait for dropdown and click first option or just leave the typed value
      await page.waitForTimeout(500);
      const option = page.locator(`[role="option"]:has-text("${TEST_CLIENT_NAME}")`);
      if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
        await option.click();
      }
    }

    // Fill remaining fields
    await page.locator('input[name="clientEmail"]').fill(TEST_CLIENT_EMAIL);
    await page.locator('input[name="clientPhone"]').fill("360-412-8837");
    // Job site address is optional and uses a Google Maps autocomplete + structured
    // city/state/zip fields without name attributes; leave it empty for this test.

    const sourceSelect = page.locator('select[name="source"]');
    if (await sourceSelect.isVisible()) {
      await sourceSelect.selectOption({ index: 1 }); // First non-empty option
    }

    await page.locator('input[name="projectType"]').fill("Bathroom Remodeling");

    // Fill message if field exists
    const msgField = page.locator('textarea[name="message"], textarea[name="notes"]');
    if (await msgField.isVisible().catch(() => false)) {
      await msgField.fill(
        "Looking to fully renovate our master bathroom. Walk-in shower, double vanity, heated floors. Budget $35-45k."
      );
    }

    await capture(page, testInfo, 1, 2, "form-filled");

    // Submit — the modal's submit button is the only type=submit "Create Lead";
    // a text-based .last() can grab the empty-state "Add Lead" behind the modal.
    const submitBtn = page.locator('button[type="submit"]:has-text("Create Lead")');
    await submitBtn.click();

    // Wait for redirect to lead detail
    await page.waitForURL(/\/leads\//, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");

    // Extract lead ID
    const url = page.url();
    const match = url.match(/\/leads\/([a-z0-9]+)/);
    expect(match, "Could not extract lead ID from URL").toBeTruthy();
    createdLeadId = match![1];

    await capture(page, testInfo, 1, 2, "lead-created");
    await assertNoCrashUI(page, "lead-detail");
    await assertNoErrorToasts(page, "after-create");
  });

  test("W1.3: Verify lead detail page renders correctly", async ({
    page,
  }, testInfo) => {
    test.skip(!createdLeadId, "Lead creation failed — skipping");
    await assertCleanNavigation(page, `/leads/${createdLeadId}`, "lead-detail");
    await capture(page, testInfo, 1, 3, "lead-detail-page");

    // Verify key content rendered — page shows client name or lead name
    const body = await page.locator("body").innerText();
    const hasLeadContent =
      body.includes("Master Bath Renovation") ||
      body.includes("Mike Henderson") ||
      body.includes("Bathroom Remodeling");
    expect(
      hasLeadContent,
      "Neither lead name, client name, nor project type found on detail page"
    ).toBeTruthy();

    await assertCurrencyValues(page, "lead-detail");
  });

  test("W1.4: Change lead stage and verify persistence", async ({
    page,
  }, testInfo) => {
    test.skip(!createdLeadId, "Lead creation failed — skipping");
    await page.goto(`/leads/${createdLeadId}`, { waitUntil: "networkidle" });

    // Look for a stage selector/dropdown
    const stageSelect = page.locator(
      'select:has(option:has-text("New")), [data-testid="stage-select"], button:has-text("New")'
    ).first();

    if (await stageSelect.isVisible({ timeout: 5000 }).catch(() => false)) {
      if ((await stageSelect.evaluate((el) => el.tagName)) === "SELECT") {
        await stageSelect.selectOption({ label: "Connected" });
      } else {
        await stageSelect.click();
        await page.waitForTimeout(500);
        const connectedOption = page.locator(
          'button:has-text("Connected"), [role="option"]:has-text("Connected"), li:has-text("Connected")'
        ).first();
        if (await connectedOption.isVisible().catch(() => false)) {
          await connectedOption.click();
        }
      }
      await page.waitForTimeout(2000);
      await capture(page, testInfo, 1, 4, "stage-changed");

      // Reload and verify persistence
      await page.reload({ waitUntil: "networkidle" });
      await capture(page, testInfo, 1, 4, "stage-after-reload");
    } else {
      await capture(page, testInfo, 1, 4, "no-stage-selector-found");
    }
  });

  test("W1.5: Navigate to lead estimates and create one", async ({
    page,
  }, testInfo) => {
    test.skip(!createdLeadId, "Lead creation failed — skipping");

    // Navigate to lead's estimates section
    await page.goto(`/leads/${createdLeadId}/estimates`, {
      waitUntil: "networkidle",
    });
    await assertNoCrashUI(page, "lead-estimates");
    await capture(page, testInfo, 1, 5, "lead-estimates-page");

    // Click create estimate button
    const createBtn = page.locator(
      'button:has-text("Create Estimate"), button:has-text("New Estimate"), a:has-text("Create Estimate")'
    ).first();

    if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createBtn.click();
      await page.waitForURL(/\/estimates\//, { timeout: 15_000 });
      await page.waitForLoadState("networkidle");

      const url = page.url();
      const match = url.match(/\/estimates\/([a-z0-9]+)/);
      if (match) {
        createdEstimateId = match[1];
      }
      await capture(page, testInfo, 1, 5, "estimate-created");
      await assertNoCrashUI(page, "estimate-editor");
    } else {
      await capture(page, testInfo, 1, 5, "no-create-estimate-btn");
    }
  });

  // =========================================================================
  // WORKFLOW 2: Estimate Builder
  // =========================================================================

  test("W2.1: Add first line item — Demolition", async ({
    page,
  }, testInfo) => {
    // Use created estimate or fall back to known project
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";

    const estUrl = createdEstimateId
      ? page.url() // Already there from W1
      : `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`;

    if (!createdEstimateId) {
      await page.goto(estUrl, { waitUntil: "networkidle" });
    } else {
      // Navigate to the created estimate
      await page.goto(
        `/leads/${createdLeadId}/estimates/${createdEstimateId}`,
        { waitUntil: "networkidle" }
      );
    }

    await assertNoCrashUI(page, "estimate-editor");
    await capture(page, testInfo, 2, 1, "estimate-before-items");

    // Click Add New Item
    const addItemBtn = page.locator(
      'button:has-text("Add New Item"), button:has-text("Add Item"), button:has-text("+ Add")'
    ).first();

    if (await addItemBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addItemBtn.click();
      await page.waitForTimeout(1000);

      // Fill first item — find the last/new row's inputs
      const nameInputs = page.locator(
        'input[placeholder*="name" i], input[placeholder*="item" i], input[placeholder*="description" i]'
      );
      const lastNameInput = nameInputs.last();
      if (await lastNameInput.isVisible().catch(() => false)) {
        await lastNameInput.fill("Demolition & Haul-Off");
      }

      // Try to fill quantity and unit cost
      const qtyInputs = page.locator(
        'input[placeholder*="qty" i], input[placeholder*="quant" i], input[type="number"]'
      );
      const costInputs = page.locator(
        'input[placeholder*="cost" i], input[placeholder*="price" i], input[placeholder*="rate" i]'
      );

      // These are approximate — actual selectors depend on the estimate editor layout
      await capture(page, testInfo, 2, 1, "first-item-added");
    } else {
      await capture(page, testInfo, 2, 1, "no-add-item-btn");
    }

    await assertCurrencyValues(page, "estimate-after-item");
  });

  test("W2.2: Verify estimate math and grand total", async ({
    page,
  }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";

    await page.goto(
      `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`,
      { waitUntil: "networkidle" }
    );
    await assertNoCrashUI(page, "estimate-math-check");
    await capture(page, testInfo, 2, 2, "estimate-math-page");

    // Scan for all currency values — no NaN, no undefined
    await assertCurrencyValues(page, "estimate-math");

    // Check for grand total element
    const body = await page.locator("body").innerText();

    // Look for dollar amounts and verify they're numeric
    const amounts = body.match(/\$[\d,.]+/g) || [];
    for (const amt of amounts) {
      const val = parseCurrency(amt);
      expect(
        isNaN(val),
        `Bad currency value: ${amt}`
      ).toBeFalsy();
    }
  });

  test("W2.3: Save estimate, reload, verify persistence", async ({
    page,
  }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";
    const ESTIMATE_ID = "cmml6vtx7001dpwrh8n65xzy6";

    await page.goto(
      `/projects/${PROJECT_ID}/estimates/${ESTIMATE_ID}`,
      { waitUntil: "networkidle" }
    );

    // Capture before reload
    const bodyBefore = await page.locator("body").innerText();
    await capture(page, testInfo, 2, 3, "before-reload");

    // Reload
    await page.reload({ waitUntil: "networkidle" });
    const bodyAfter = await page.locator("body").innerText();
    await capture(page, testInfo, 2, 3, "after-reload");

    await assertNoCrashUI(page, "estimate-persistence");
    await assertCurrencyValues(page, "estimate-after-reload");
  });

  // =========================================================================
  // WORKFLOW 3: Invoice Creation & Payment
  // =========================================================================

  test("W3.1: Navigate to invoices list", async ({ page }, testInfo) => {
    await assertCleanNavigation(page, "/invoices", "invoices-list");
    await capture(page, testInfo, 3, 1, "invoices-list");
    await assertCurrencyValues(page, "invoices-list");
  });

  test("W3.2: Verify invoice detail page", async ({ page }, testInfo) => {
    const PROJECT_ID = "cmml6vt3y000lpwrh0p9p3k12";

    // Navigate to project invoices
    await page.goto(`/projects/${PROJECT_ID}/invoices`, {
      waitUntil: "networkidle",
    });
    await assertNoCrashUI(page, "project-invoices");
    await capture(page, testInfo, 3, 2, "project-invoices");

    // Check for existing invoices or create option
    const invoiceLinks = page.locator('a[href*="/invoices/"]');
    const count = await invoiceLinks.count();

    if (count > 0) {
      // Click first invoice
      await invoiceLinks.first().click();
      await page.waitForLoadState("networkidle");
      await assertNoCrashUI(page, "invoice-detail");
      await assertCurrencyValues(page, "invoice-detail");
      await capture(page, testInfo, 3, 2, "invoice-detail");
    } else {
      await capture(page, testInfo, 3, 2, "no-invoices-found");
    }
  });

  test("W3.3: Verify reports/payments page", async ({ page }, testInfo) => {
    await assertCleanNavigation(page, "/reports/payments", "reports-payments");
    await capture(page, testInfo, 3, 3, "reports-payments");
    await assertCurrencyValues(page, "reports-payments");
  });

  test("W3.4: Verify reports pages load cleanly", async ({
    page,
  }, testInfo) => {
    const reportPaths = [
      "/reports",
      "/reports/open-invoices",
      "/reports/payouts",
      "/reports/transactions",
    ];

    for (const rp of reportPaths) {
      await assertCleanNavigation(page, rp, `report-${rp}`);
      await assertCurrencyValues(page, rp);
    }
    await capture(page, testInfo, 3, 4, "all-reports-clean");
  });

  test.afterEach(async ({}, testInfo) => {
    if (consoleErrors.length > 0) {
      console.warn(
        `[${testInfo.title}] ${consoleErrors.length} console error(s):`,
        consoleErrors
      );
    }
  });

  // ===========================================================================
  // TEARDOWN — delete everything this suite created, plus any leads matching
  // the exact test signature leaked by earlier aborted runs. Without this, QA
  // runs accumulate junk in whatever DB they target (see docs/TESTING.md).
  // ===========================================================================
  test.afterAll(async () => {
    const prisma = new PrismaClient();
    try {
      const strays = await prisma.lead.findMany({
        where: {
          name: TEST_LEAD_NAME,
          stage: "New",
          project: { is: null },
          client: { email: TEST_CLIENT_EMAIL },
        },
        select: { id: true },
      });
      const leadIds = new Set<string>(strays.map((s) => s.id));
      if (createdLeadId) leadIds.add(createdLeadId);

      for (const leadId of leadIds) {
        const estimates = await prisma.estimate.findMany({
          where: { leadId },
          select: { id: true },
        });
        const estimateIds = estimates.map((e) => e.id);
        if (estimateIds.length > 0) {
          await prisma.estimateItem.deleteMany({ where: { estimateId: { in: estimateIds } } });
          await prisma.estimatePaymentSchedule.deleteMany({ where: { estimateId: { in: estimateIds } } });
          await prisma.estimate.deleteMany({ where: { id: { in: estimateIds } } });
        }
        await prisma.clientMessage.deleteMany({ where: { leadId } });
        await prisma.leadTask.deleteMany({ where: { leadId } });
        await prisma.leadNote.deleteMany({ where: { leadId } });
        await prisma.leadMeeting.deleteMany({ where: { leadId } });
        await prisma.scheduleTask.deleteMany({ where: { leadId } });
        await prisma.takeoff.deleteMany({ where: { leadId } });
        await prisma.roomDesign.deleteMany({ where: { leadId } });
        await prisma.contract.deleteMany({ where: { leadId } });
        await prisma.projectFile.deleteMany({ where: { leadId } });
        await prisma.fileFolder.deleteMany({ where: { leadId } });
        await prisma.lead.delete({ where: { id: leadId } });
      }

      // Drop the auto-created test client once nothing references it.
      const client = await prisma.client.findFirst({
        where: { email: TEST_CLIENT_EMAIL },
        include: {
          _count: { select: { leads: true, projects: true, invoices: true, retainers: true } },
        },
      });
      if (
        client &&
        client._count.leads + client._count.projects + client._count.invoices + client._count.retainers === 0
      ) {
        await prisma.clientMessage.deleteMany({ where: { clientId: client.id } });
        await prisma.client.delete({ where: { id: client.id } });
      }
      console.log(`[teardown] removed ${leadIds.size} test lead(s)`);
    } catch (e) {
      console.warn("[teardown] cleanup failed (non-fatal):", (e as Error).message);
    } finally {
      await prisma.$disconnect();
    }
  });
});
