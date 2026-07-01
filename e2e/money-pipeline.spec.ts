import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Money-pipeline regression net — born from the June 2026 lifecycle audit.
 *
 * Guards the invariants that audit established (and the bugs it fixed):
 *  1. Signing a LEAD estimate auto-runs the full conversion chain:
 *     lead → Won, project → In Progress, invoice Issued + linked via estimateId.
 *  2. Invoice milestones are cloned WITH sourceScheduleId links to their
 *     estimate originals (the durable mirror identity).
 *  3. Recording a payment on the invoice settles the ESTIMATE copy too
 *     (bidirectional mirror), updates both balances/statuses, and captures
 *     statusBeforePayment for undo.
 *  4. Exactly ONE activity event per lifecycle moment (the duplicate-logger
 *     class: sent_estimate and signed_estimate each had two writers once).
 *  5. Undo (unrecord) releases BOTH sides and restores the pre-payment status.
 *  6. The estimate Activity feed renders the chain (signed → invoice created).
 *
 * Runs against the throwaway CI Postgres (data.setup.ts guards prod). The
 * fixture client has NO email and the CI DB has no CompanySettings row, so
 * no real emails can leave this spec. QuickBooks pushes fail soft (no
 * Integration row) — the QBO settle mirror itself is exercised in prod drills,
 * not here.
 */

const IDS = {
  client: "mp-e2e-client",
  lead: "mp-e2e-lead",
  estimate: "mp-e2e-estimate",
  depositMilestone: "mp-e2e-eps-deposit",
  finalMilestone: "mp-e2e-eps-final",
};
const LEAD_NAME = "Money Pipeline Drill - MPTEST";
const SIGNER = "E2E Money Signer";

const prisma = new PrismaClient();

// Discovered during the run (conversion creates these)
let projectId: string;
let invoiceId: string;

test.describe.serial("Money pipeline: sign → convert → invoice → mirror → undo", () => {
  test.beforeAll(async () => {
    // Client deliberately has NO email — receipts/notifications must no-op in CI.
    await prisma.client.upsert({
      where: { id: IDS.client },
      update: {},
      create: { id: IDS.client, name: "MP Drill Client", initials: "MD" },
    });
    await prisma.lead.upsert({
      where: { id: IDS.lead },
      update: { stage: "Estimate Sent" },
      create: { id: IDS.lead, name: LEAD_NAME, clientId: IDS.client, stage: "Estimate Sent" },
    });
    await prisma.estimate.upsert({
      where: { id: IDS.estimate },
      update: {},
      create: {
        id: IDS.estimate,
        title: LEAD_NAME,
        code: "EST-MPTEST",
        leadId: IDS.lead,
        status: "Sent",
        sentAt: new Date(),
        taxExempt: true,
        totalAmount: 1000,
        balanceDue: 1000,
      },
    });
    await prisma.estimatePaymentSchedule.upsert({
      where: { id: IDS.depositMilestone },
      update: { status: "Pending" },
      create: { id: IDS.depositMilestone, estimateId: IDS.estimate, name: "MP Deposit", amount: 600, status: "Pending", order: 1 },
    });
    await prisma.estimatePaymentSchedule.upsert({
      where: { id: IDS.finalMilestone },
      update: { status: "Pending" },
      create: { id: IDS.finalMilestone, estimateId: IDS.estimate, name: "MP Final", amount: 400, status: "Pending", order: 2 },
    });
  });

  test.afterAll(async () => {
    // Surgical teardown — only rows this spec created (or conversion created from them).
    try {
      const invoices = await prisma.invoice.findMany({ where: { estimateId: IDS.estimate }, select: { id: true } });
      const entityIds = [IDS.estimate, IDS.lead, ...invoices.map(i => i.id)];
      await prisma.activityLog.deleteMany({
        where: { OR: [{ entityId: { in: entityIds } }, { leadId: IDS.lead }, ...(projectId ? [{ projectId }] : [])] },
      });
      await prisma.invoice.deleteMany({ where: { estimateId: IDS.estimate } });
      await prisma.estimate.deleteMany({ where: { id: IDS.estimate } });
      if (projectId) await prisma.project.deleteMany({ where: { id: projectId, name: LEAD_NAME } });
      await prisma.lead.deleteMany({ where: { id: IDS.lead } });
      await prisma.client.deleteMany({ where: { id: IDS.client } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("M1: client signs the estimate on the portal (canvas + legal name)", async ({ page }) => {
    test.setTimeout(120_000); // signing runs capture + PDF + conversion pipeline

    await page.goto(`/portal/estimates/${IDS.estimate}`, { waitUntil: "networkidle" });

    await page.locator('button:has-text("Sign & Approve Estimate")').click();

    // Draw a signature stroke on the pad
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();

    await page.locator('input[placeholder="e.g. John A. Doe"]').fill(SIGNER);
    await page.locator('button:has-text("Sign & Approve")').last().click();

    // The UI optimistically shows the signed block DURING the client-side PDF
    // capture — before approveEstimate has run. Asserting on it ends the test,
    // which closes the page and kills the in-flight approval. The real
    // completion signal is the database write, so poll that (capture + PDF +
    // conversion pipeline can take a while in CI).
    await expect
      .poll(
        async () =>
          (await prisma.estimate.findUnique({ where: { id: IDS.estimate }, select: { status: true } }))?.status,
        { timeout: 100_000, intervals: [2_000] }
      )
      .toBe("Invoiced");
  });

  test("M2: conversion chain — lead Won, project In Progress, linked invoice, sourceScheduleId mirrors", async () => {
    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: IDS.estimate } });
    expect(estimate.status, "estimate flips to Invoiced on signing").toBe("Invoiced");
    expect(estimate.approvedBy).toBe(SIGNER);
    expect(estimate.projectId, "conversion attaches a project").toBeTruthy();
    projectId = estimate.projectId!;

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: IDS.lead } });
    expect(lead.stage, "lead marked Won").toBe("Won");

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("In Progress");
    expect(project.clientId).toBe(IDS.client);

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { estimateId: IDS.estimate } });
    invoiceId = invoice.id;
    expect(invoice.status).toBe("Issued");
    expect(Number(invoice.totalAmount)).toBe(1000);

    const copies = await prisma.paymentSchedule.findMany({ where: { invoiceId }, orderBy: { amount: "desc" } });
    expect(copies).toHaveLength(2);
    const depositCopy = copies.find(c => c.name === "MP Deposit");
    const finalCopy = copies.find(c => c.name === "MP Final");
    expect(depositCopy?.sourceScheduleId, "deposit copy carries its mirror link").toBe(IDS.depositMilestone);
    expect(finalCopy?.sourceScheduleId, "final copy carries its mirror link").toBe(IDS.finalMilestone);

    // Exactly-one-writer guard (signed_estimate once had two writers)
    const signedEvents = await prisma.activityLog.count({
      where: { entityType: "estimate", entityId: IDS.estimate, action: "signed_estimate" },
    });
    expect(signedEvents, "signing logs exactly one activity event").toBe(1);
  });

  test("M3: record a check on the invoice — estimate copy settles too (mirror)", async ({ page }) => {
    await page.goto(`/projects/${projectId}/invoices/${invoiceId}`, { waitUntil: "networkidle" });

    const depositRow = page.locator("tr", { hasText: "MP Deposit" });
    await depositRow.locator('button:has-text("Record Payment")').click();

    // Modal: pick Check, enter the check number, submit (.last() = the modal's
    // submit; the per-row buttons come earlier in the DOM).
    await page.locator('button:has-text("Check")').first().click();
    await page.locator('input[placeholder="e.g. 1234"]').fill("9001");
    await page.locator('button:has-text("Record Payment")').last().click();

    await expect(depositRow.locator("text=Paid").first()).toBeVisible({ timeout: 15_000 });

    // Invoice side
    const invCopy = await prisma.paymentSchedule.findFirstOrThrow({ where: { invoiceId, name: "MP Deposit" } });
    expect(invCopy.status).toBe("Paid");
    expect(invCopy.paymentMethod).toBe("check");
    expect(invCopy.referenceNumber).toBe("9001");

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("Partially Paid");
    expect(Number(invoice.balanceDue)).toBe(400);

    // Estimate side — THE mirror assertion
    const estCopy = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: IDS.depositMilestone } });
    expect(estCopy.status, "estimate milestone mirrors the invoice payment").toBe("Paid");
    expect(estCopy.paymentMethod).toBe("check");
    expect(estCopy.referenceNumber).toBe("9001");

    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: IDS.estimate } });
    expect(estimate.status).toBe("Partially Paid");
    expect(Number(estimate.balanceDue)).toBe(400);
    expect(estimate.statusBeforePayment, "pre-payment status captured for undo").toBe("Invoiced");

    // Exactly one payment_received activity event
    const payEvents = await prisma.activityLog.count({
      where: { entityType: "invoice", entityId: invoiceId, action: "payment_received" },
    });
    expect(payEvents).toBe(1);
  });

  test("M4: undo the payment — both sides release, statuses restore", async ({ page }) => {
    page.on("dialog", d => d.accept());
    await page.goto(`/projects/${projectId}/invoices/${invoiceId}`, { waitUntil: "networkidle" });

    const depositRow = page.locator("tr", { hasText: "MP Deposit" });
    await depositRow.locator('button:has-text("Undo")').click();

    // Undo is guarded by the heavy confirmation modal: type UNDO, then confirm.
    await page.getByPlaceholder("UNDO").fill("UNDO");
    await page.locator('button:has-text("Undo Payment")').click();

    await expect(depositRow.locator('button:has-text("Record Payment")')).toBeVisible({ timeout: 15_000 });

    const invCopy = await prisma.paymentSchedule.findFirstOrThrow({ where: { invoiceId, name: "MP Deposit" } });
    expect(invCopy.status).toBe("Pending");

    const estCopy = await prisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: IDS.depositMilestone } });
    expect(estCopy.status, "mirror unwinds on undo").toBe("Pending");

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe("Issued");
    expect(Number(invoice.balanceDue)).toBe(1000);

    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: IDS.estimate } });
    expect(estimate.status, "estimate restored to its pre-payment status").toBe("Invoiced");
    expect(estimate.statusBeforePayment).toBeNull();
    expect(Number(estimate.balanceDue)).toBe(1000);

    // The audit trail is append-only: undoing the payment must NOT erase the
    // payment_received event from history.
    const payEvents = await prisma.activityLog.count({
      where: { entityType: "invoice", entityId: invoiceId, action: "payment_received" },
    });
    expect(payEvents, "history survives the undo").toBe(1);
  });

  test("M5: estimate Activity feed shows the lifecycle", async ({ page }) => {
    await page.goto(`/projects/${projectId}/estimates/${IDS.estimate}`, { waitUntil: "networkidle" });

    await page.locator('button[title="More actions"]').click();
    await page.locator('button:has-text("Show Sidebar")').click();
    await page.locator('button:has-text("Activity")').click();

    await expect(page.locator(`text=Signed by ${SIGNER}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=/Invoice INV-\\d+ created/")).toBeVisible();
  });
});
