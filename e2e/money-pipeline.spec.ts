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
      // Outbox rows have no FK, so drop them by scheduleId before the schedules cascade away.
      const invScheduleIds = (await prisma.paymentSchedule.findMany({ where: { invoiceId: { in: invoices.map(i => i.id) } }, select: { id: true } })).map(s => s.id);
      const estScheduleIds = (await prisma.estimatePaymentSchedule.findMany({ where: { estimateId: IDS.estimate }, select: { id: true } })).map(s => s.id);
      await prisma.paymentNotification.deleteMany({ where: { scheduleId: { in: [...invScheduleIds, ...estScheduleIds] } } });
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

    // Outbox: the settle enqueued exactly one milestone-paid notification and the inline
    // drain delivered it (no email leaves CI — no client email / CompanySettings — so the
    // canonical notifier returns ok and the row is marked PROCESSED, not stuck PENDING).
    const notes = await prisma.paymentNotification.findMany({ where: { scheduleId: invCopy.id } });
    expect(notes, "one outbox row per settled milestone").toHaveLength(1);
    expect(notes[0].scheduleType).toBe("invoice");
    expect(notes[0].status, "inline drain delivered the notification").toBe("PROCESSED");
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

/**
 * Concurrency guard — the invoice-side lost update.
 *
 * Two payments settle DIFFERENT milestones of the SAME invoice at the same time.
 * Each recordPayment claims its own schedule row (no mutual block) and recomputes
 * Invoice.balanceDue from the sibling set. Without a parent-row lock, both read a
 * stale sibling set and sequentially overwrite balanceDue — one payment's effect is
 * silently lost, and because no deadlock fires, no retry masks it. The fix locks the
 * parent Estimate→Invoice rows FOR UPDATE before recomputing, serializing the two.
 *
 * This drives the REAL server action through two concurrent browser submissions, so
 * the two transactions genuinely overlap in the database. The assertion is the money
 * invariant: final balanceDue == totalAmount - sum(all Paid milestones). Pre-fix this
 * lands at 400 or 600 (one payment lost); post-fix it lands at 0.
 *
 * CI throwaway Postgres only — the same data.setup guard that protects the suite
 * above protects this block (it never runs when DATABASE_URL looks like Supabase).
 */
const C = {
  client: "mp2-e2e-client",
  project: "mp2-e2e-project",
  estimate: "mp2-e2e-estimate",
  invoice: "mp2-e2e-invoice",
  estDeposit: "mp2-e2e-eps-deposit",
  estFinal: "mp2-e2e-eps-final",
  invDeposit: "mp2-e2e-ps-deposit",
  invFinal: "mp2-e2e-ps-final",
};
const C_NAME = "Money Race Drill - MP2TEST";
const cPrisma = new PrismaClient();

test.describe.serial("Money pipeline: concurrent payments never lose a balance update", () => {
  // Reset both milestones (and the parent balances) to a clean pre-payment state so
  // the race starts from full balance every run/retry.
  async function seed() {
    await cPrisma.client.upsert({
      where: { id: C.client },
      update: {},
      create: { id: C.client, name: "MP2 Drill Client", initials: "M2" },
    });
    await cPrisma.project.upsert({
      where: { id: C.project },
      update: {},
      create: { id: C.project, name: C_NAME, clientId: C.client, status: "In Progress" },
    });
    await cPrisma.estimate.upsert({
      where: { id: C.estimate },
      update: { status: "Invoiced", totalAmount: 1000, balanceDue: 1000, statusBeforePayment: null },
      create: {
        id: C.estimate, title: C_NAME, code: "EST-MP2TEST", projectId: C.project,
        status: "Invoiced", taxExempt: true, totalAmount: 1000, balanceDue: 1000,
      },
    });
    await cPrisma.estimatePaymentSchedule.upsert({
      where: { id: C.estDeposit },
      update: { status: "Pending", paidAt: null, paymentDate: null, paymentMethod: null, referenceNumber: null },
      create: { id: C.estDeposit, estimateId: C.estimate, name: "MP2 Deposit", amount: 600, status: "Pending", order: 1 },
    });
    await cPrisma.estimatePaymentSchedule.upsert({
      where: { id: C.estFinal },
      update: { status: "Pending", paidAt: null, paymentDate: null, paymentMethod: null, referenceNumber: null },
      create: { id: C.estFinal, estimateId: C.estimate, name: "MP2 Final", amount: 400, status: "Pending", order: 2 },
    });
    await cPrisma.invoice.upsert({
      where: { id: C.invoice },
      update: { status: "Issued", totalAmount: 1000, balanceDue: 1000 },
      create: {
        id: C.invoice, code: "INV-MP2TEST", projectId: C.project, clientId: C.client,
        estimateId: C.estimate, status: "Issued", totalAmount: 1000, balanceDue: 1000,
        issueDate: new Date(),
      },
    });
    // Invoice-side copies mirror the estimate milestones (sourceScheduleId link) so
    // recordPayment settles both sides, exactly like a converted estimate.
    await cPrisma.paymentSchedule.upsert({
      where: { id: C.invDeposit },
      update: { status: "Pending", paidAt: null, paymentDate: null, paymentMethod: null, referenceNumber: null },
      create: { id: C.invDeposit, invoiceId: C.invoice, name: "MP2 Deposit", amount: 600, status: "Pending", sourceScheduleId: C.estDeposit },
    });
    await cPrisma.paymentSchedule.upsert({
      where: { id: C.invFinal },
      update: { status: "Pending", paidAt: null, paymentDate: null, paymentMethod: null, referenceNumber: null },
      create: { id: C.invFinal, invoiceId: C.invoice, name: "MP2 Final", amount: 400, status: "Pending", sourceScheduleId: C.estFinal },
    });
  }

  test.beforeAll(seed);

  test.afterAll(async () => {
    try {
      await cPrisma.activityLog.deleteMany({
        where: { OR: [{ entityId: { in: [C.estimate, C.invoice] } }, { projectId: C.project }] },
      });
      await cPrisma.paymentNotification.deleteMany({ where: { scheduleId: { in: [C.invDeposit, C.invFinal, C.estDeposit, C.estFinal] } } });
      await cPrisma.paymentSchedule.deleteMany({ where: { invoiceId: C.invoice } });
      await cPrisma.invoice.deleteMany({ where: { id: C.invoice } });
      await cPrisma.estimatePaymentSchedule.deleteMany({ where: { estimateId: C.estimate } });
      await cPrisma.estimate.deleteMany({ where: { id: C.estimate } });
      await cPrisma.project.deleteMany({ where: { id: C.project } });
      await cPrisma.client.deleteMany({ where: { id: C.client } });
    } finally {
      await cPrisma.$disconnect();
    }
  });

  test("C1: two concurrent milestone payments both land — no lost balance update", async ({ browser }) => {
    test.setTimeout(60_000);
    const invoiceUrl = `/projects/${C.project}/invoices/${C.invoice}`;

    // One authed context, two pages — they share the session cookie and hit the
    // real server action over separate connections, so the transactions overlap.
    const ctx = await browser.newContext({ storageState: "e2e/.auth/user.json" });

    // Stage each modal up to (but not including) the submit, so the two submits can
    // fire as close to simultaneously as possible.
    async function stage(rowText: string, checkNo: string) {
      const page = await ctx.newPage();
      await page.goto(invoiceUrl, { waitUntil: "networkidle" });
      const row = page.locator("tr", { hasText: rowText });
      await row.locator('button:has-text("Record Payment")').click();
      await page.locator('button:has-text("Check")').first().click();
      await page.locator('input[placeholder="e.g. 1234"]').fill(checkNo);
      return page;
    }

    const p1 = await stage("MP2 Deposit", "7001");
    const p2 = await stage("MP2 Final", "7002");

    // Fire both submits in parallel — the whole point of the test.
    await Promise.all([
      p1.locator('button:has-text("Record Payment")').last().click(),
      p2.locator('button:has-text("Record Payment")').last().click(),
    ]);

    // Wait until both invoice-side milestones have settled in the DB.
    await expect
      .poll(
        async () => {
          const copies = await cPrisma.paymentSchedule.findMany({ where: { invoiceId: C.invoice } });
          return copies.filter((s) => s.status === "Paid").length;
        },
        { timeout: 30_000, intervals: [500] }
      )
      .toBe(2);

    await ctx.close();

    // ── The money invariant: balanceDue == total - sum(all Paid) on BOTH sides ──
    const invoice = await cPrisma.invoice.findUniqueOrThrow({ where: { id: C.invoice } });
    const invCopies = await cPrisma.paymentSchedule.findMany({ where: { invoiceId: C.invoice } });
    const invPaid = invCopies.filter((s) => s.status === "Paid").reduce((sum, s) => sum + Number(s.amount), 0);
    const invExpectedBalance = Math.max(0, Math.round((Number(invoice.totalAmount) - invPaid) * 100) / 100);

    expect(invPaid, "both milestones counted as paid").toBe(1000);
    expect(Number(invoice.balanceDue), "invoice balanceDue == total - sum(paid), no lost update").toBe(invExpectedBalance);
    expect(Number(invoice.balanceDue)).toBe(0);
    expect(invoice.status).toBe("Paid");

    // Estimate mirror must reflect the same — both estimate copies settled, balance 0.
    const estimate = await cPrisma.estimate.findUniqueOrThrow({ where: { id: C.estimate } });
    const estCopies = await cPrisma.estimatePaymentSchedule.findMany({ where: { estimateId: C.estimate } });
    const estPaid = estCopies.filter((s) => s.status === "Paid").reduce((sum, s) => sum + Number(s.amount), 0);
    const estExpectedBalance = Math.max(0, Math.round((Number(estimate.totalAmount) - estPaid) * 100) / 100);

    expect(estPaid, "both estimate copies mirrored as paid").toBe(1000);
    expect(Number(estimate.balanceDue), "estimate balanceDue mirrors with no lost update").toBe(estExpectedBalance);
    expect(Number(estimate.balanceDue)).toBe(0);
    expect(estimate.status).toBe("Paid");

    // Outbox under concurrency: each settle enqueued its own notification and the inline
    // drains delivered both — exactly one PROCESSED row per invoice milestone, no dupes.
    const notes = await cPrisma.paymentNotification.findMany({
      where: { scheduleId: { in: [C.invDeposit, C.invFinal] } },
      orderBy: { scheduleId: "asc" },
    });
    expect(notes, "one outbox row per concurrent settle").toHaveLength(2);
    expect(notes.every((n) => n.scheduleType === "invoice")).toBe(true);
    expect(notes.every((n) => n.status === "PROCESSED"), "both delivered by the inline drain").toBe(true);
  });
});
