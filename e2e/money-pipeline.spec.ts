import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveChangeOrderCore, deleteChangeOrderCore, updateChangeOrderCore } from "../src/lib/change-order-core";
import { sendChangeOrderToClientCore } from "../src/lib/billing-core";
import {
  persistOwnedSignature,
  type SignatureStorageBucket,
} from "../src/lib/signature-storage";
import {
  mirrorInvoiceSettleToEstimate,
  mirrorInvoiceUnsettleToEstimate,
  mirrorEstimateUnsettleToInvoice,
  findInvoiceMirrorOfEstimateSchedule,
} from "../src/lib/payment-mirror";
import {
  approveChangeOrderWithSignature,
  type ChangeOrderApprovalDependencies,
  type ChangeOrderSignatureCleanupEvent,
} from "../src/lib/change-order-approval";
import { coTaxFingerprint } from "../src/lib/co-tax";

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

test.describe("Change-order signature object ownership", () => {
  const signatureDataUrl = "data:image/png;base64,AA==";

  test("owned signature discard removes the exact uploaded path once across concurrent calls", async () => {
    const uploaded: string[] = [];
    const uploadOptions: Array<{ contentType: string; upsert: false }> = [];
    const removed: string[][] = [];
    const bucket: SignatureStorageBucket = {
      async upload(path, _body, options) {
        uploaded.push(path);
        uploadOptions.push(options);
        return { error: null };
      },
      async remove(paths) {
        removed.push([...paths]);
        return { error: null };
      },
    };

    const owned = await persistOwnedSignature(
      signatureDataUrl,
      "change-orders/test/client",
      {
        getBucket: () => bucket,
        now: () => 1_721_218_400_000,
        randomId: () => "owned-test-id",
      },
    );

    expect(uploaded).toEqual([
      "signatures/change-orders/test/client/1721218400000_owned-test-id.png",
    ]);
    expect(uploadOptions).toEqual([{ contentType: "image/png", upsert: false }]);
    expect(owned.url).toBe(
      "secure:signatures/change-orders/test/client/1721218400000_owned-test-id.png",
    );

    await Promise.all([owned.discard(), owned.discard(), owned.discard()]);

    expect(removed).toEqual([[uploaded[0]]]);
  });

  // The two tests that used to live here ("missing public URL compensating-deletes...",
  // "thrown public URL construction compensating-deletes...") exercised getPublicUrl()
  // failing after a successful upload. Now that the stored reference is derived locally
  // (toSecureRef(storagePath)) instead of asking Storage to construct an address, that
  // failure mode no longer exists — there's nothing left to compensate for.

  test("late upload success after deadline is removed before the error returns", async () => {
    let settleUpload!: (result: { error: unknown | null }) => void;
    const removed: string[][] = [];
    const bucket: SignatureStorageBucket = {
      upload() {
        return new Promise((resolve) => { settleUpload = resolve; });
      },
      async remove(paths) {
        removed.push([...paths]);
        return { error: null };
      },
    };

    const persistence = persistOwnedSignature(
      signatureDataUrl,
      "change-orders/test/client",
      {
        getBucket: () => bucket,
        now: () => 1_721_218_400_000,
        randomId: () => "late-success-id",
        uploadTimeoutMs: 1,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    settleUpload({ error: null });

    await expect(persistence).rejects.toThrow("Couldn't save your signature");
    expect(removed).toEqual([[
      "signatures/change-orders/test/client/1721218400000_late-success-id.png",
    ]]);
  });
});

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

  test("M2: conversion chain — lead Won, project Waiting to Start, linked invoice, sourceScheduleId mirrors", async () => {
    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: IDS.estimate } });
    expect(estimate.status, "estimate flips to Invoiced on signing").toBe("Invoiced");
    expect(estimate.approvedBy).toBe(SIGNER);
    expect(estimate.projectId, "conversion attaches a project").toBeTruthy();
    projectId = estimate.projectId!;

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: IDS.lead } });
    expect(lead.stage, "lead marked Won").toBe("Won");

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status, "projects are born Waiting to Start since c250526").toBe("Waiting to Start");
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

const COI = {
  client: "co-invariant-e2e-client",
  project: "co-invariant-e2e-project",
  estimate: "co-invariant-e2e-estimate",
  rawDraft: "co-invariant-raw-draft",
  draftApproval: "co-invariant-draft-approval",
  emptySent: "co-invariant-empty-sent",
  zeroSent: "co-invariant-zero-sent",
  validSent: "co-invariant-valid-sent",
  replaySent: "co-invariant-replay-sent",
  approved: "co-invariant-approved",
  race: "co-invariant-race",
  duplicate: "co-invariant-duplicate",
  duplicateItem: "co-invariant-duplicate-item",
  stale: "co-invariant-stale",
  staleItem: "co-invariant-stale-item",
  driftSend: "co-invariant-drift-send",
  driftSendItem: "co-invariant-drift-send-item",
  driftApproval: "co-invariant-drift-approval",
  driftApprovalItem: "co-invariant-drift-approval-item",
  approvedDelete: "co-invariant-approved-delete",
  unsigned: "co-invariant-unsigned",
  companySigned: "co-invariant-company-signed",
  companySignedItem: "co-invariant-company-signed-item",
  noOpSent: "co-invariant-no-op-sent",
  noOpSentItem: "co-invariant-no-op-sent-item",
  legacySignedDraft: "co-invariant-legacy-signed-draft",
};
const coInvariantPrisma = new PrismaClient();

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function createTrackedSignatureStore() {
  const objects = new Set<string>();
  let sequence = 0;
  const persistSignature: ChangeOrderApprovalDependencies["persistSignature"] = async (
    _value,
    keyPrefix,
  ) => {
    const url = `https://signature.test/${keyPrefix}/${++sequence}.png`;
    objects.add(url);
    let discarded = false;
    return {
      url,
      async discard() {
        if (discarded) return;
        objects.delete(url);
        discarded = true;
      },
    };
  };
  return { objects, persistSignature };
}

const approvalInput = (signatureName: string) => ({
  signatureName,
  signatureDataUrl: "data:image/png;base64,AA==",
  approvedAt: new Date(),
  expectedRevision: 0,
  expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
});

const approveAsInvariantPortalClient: typeof approveChangeOrderCore = (changeOrderId, approval) =>
  approveChangeOrderCore(changeOrderId, { ...approval, expectedClientId: COI.client });

test.describe.serial("Money pipeline: change-order lifecycle invariants", () => {
  test.beforeAll(async () => {
    await coInvariantPrisma.client.upsert({
      where: { id: COI.client },
      update: {},
      create: { id: COI.client, name: "CO Invariant Client", initials: "CI" },
    });
    await coInvariantPrisma.project.upsert({
      where: { id: COI.project },
      update: {},
      create: { id: COI.project, name: "CO Invariant Project", clientId: COI.client, status: "In Progress" },
    });
    await coInvariantPrisma.estimate.upsert({
      where: { id: COI.estimate },
      update: {},
      create: {
        id: COI.estimate,
        title: "CO Invariant Estimate",
        code: "EST-CO-INVARIANT",
        projectId: COI.project,
        status: "Approved",
        taxExempt: true,
        totalAmount: 1000,
        balanceDue: 1000,
      },
    });

    const ids = [
      COI.rawDraft, COI.draftApproval, COI.emptySent, COI.zeroSent, COI.validSent, COI.replaySent,
      COI.approved, COI.race, COI.duplicate, COI.stale, COI.driftSend,
      COI.driftApproval, COI.approvedDelete, COI.unsigned, COI.companySigned,
      COI.noOpSent, COI.legacySignedDraft,
    ];
    await coInvariantPrisma.changeOrderAutomationJob.deleteMany({ where: { changeOrderId: { in: ids } } });
    await coInvariantPrisma.changeOrder.deleteMany({ where: { id: { in: ids } } });

    async function createChangeOrder(id: string, status: string, totalAmount: number, withItem: boolean, itemId?: string) {
      await coInvariantPrisma.changeOrder.create({
        data: {
          id,
          code: `CO-${id}`,
          title: `Title ${id}`,
          description: `Description ${id}`,
          projectId: COI.project,
          estimateId: COI.estimate,
          status,
          totalAmount,
          balanceDue: totalAmount,
          ...(status === "Sent" ? { sentAt: new Date("2026-07-17T12:00:00.000Z") } : {}),
          ...(status === "Sent" ? {
            termsTaxExempt: true,
            termsTaxRateName: null,
            termsTaxRatePercent: 0,
          } : {}),
          ...(withItem
            ? {
                items: {
                  create: {
                    ...(itemId ? { id: itemId } : {}),
                    name: "Invariant item",
                    quantity: 1,
                    unitCost: totalAmount,
                    total: totalAmount,
                    order: 0,
                  },
                },
              }
            : {}),
        },
      });
    }

    await createChangeOrder(COI.rawDraft, "Draft", 100, true);
    await createChangeOrder(COI.draftApproval, "Draft", 100, true);
    await createChangeOrder(COI.emptySent, "Sent", 100, false);
    await createChangeOrder(COI.zeroSent, "Sent", 0, true);
    await createChangeOrder(COI.validSent, "Sent", 100, true);
    await createChangeOrder(COI.replaySent, "Sent", 100, true);
    await createChangeOrder(COI.approved, "Approved", 100, true);
    await createChangeOrder(COI.race, "Sent", 100, true);
    await createChangeOrder(COI.duplicate, "Draft", 100, true, COI.duplicateItem);
    await createChangeOrder(COI.stale, "Sent", 100, true, COI.staleItem);
    await createChangeOrder(COI.driftSend, "Sent", 110, true, COI.driftSendItem);
    await createChangeOrder(COI.driftApproval, "Sent", 110, true, COI.driftApprovalItem);
    await createChangeOrder(COI.approvedDelete, "Approved", 100, true);
    await createChangeOrder(COI.unsigned, "Sent", 100, true);
    await createChangeOrder(COI.companySigned, "Sent", 100, true, COI.companySignedItem);
    await createChangeOrder(COI.noOpSent, "Sent", 100, true, COI.noOpSentItem);
    await createChangeOrder(COI.legacySignedDraft, "Draft", 100, true);
    await coInvariantPrisma.changeOrderItem.updateMany({
      where: { id: { in: [COI.driftSendItem, COI.driftApprovalItem] } },
      data: { unitCost: 100, total: 100 },
    });
    await coInvariantPrisma.changeOrder.update({
      where: { id: COI.companySigned },
      data: { companySignedBy: "Company Signer", companySignedAt: new Date(), companySignatureUrl: "data:image/png;base64,AA==" },
    });
    await coInvariantPrisma.changeOrder.update({
      where: { id: COI.legacySignedDraft },
      data: { companySignedBy: "Legacy Company Signer", companySignedAt: new Date(), companySignatureUrl: "data:image/png;base64,AA==" },
    });
  });

  test.afterAll(async () => {
    try {
      await coInvariantPrisma.changeOrderAutomationJob.deleteMany({ where: { changeOrder: { projectId: COI.project } } });
      await coInvariantPrisma.changeOrder.deleteMany({ where: { projectId: COI.project } });
      await coInvariantPrisma.estimate.deleteMany({ where: { id: COI.estimate } });
      await coInvariantPrisma.project.deleteMany({ where: { id: COI.project } });
      await coInvariantPrisma.client.deleteMany({ where: { id: COI.client } });
    } finally {
      await coInvariantPrisma.$disconnect();
    }
  });

  test("CO1: generic updates cannot perform Draft -> Sent", async () => {
    const message = await rejectionMessage(updateChangeOrderCore(COI.rawDraft, { status: "Sent", expectedRevision: 0 }));
    expect(message).toContain("Send for Approval");
    const co = await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.rawDraft } });
    expect(co.status).toBe("Draft");
    expect(co.sentAt).toBeNull();
  });

  test("CO2: invalid status removes the unused signature object", async () => {
    const approvalSignatures = createTrackedSignatureStore();
    const message = await rejectionMessage(approveChangeOrderWithSignature(
      COI.draftApproval,
      approvalInput("Invariant Signer"),
      { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
    ));
    expect(message).toContain("must be Sent");
    expect(approvalSignatures.objects).toEqual(new Set());
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.draftApproval } })).status).toBe("Draft");
  });

  test("CO3: approval requires at least one item", async () => {
    const message = await rejectionMessage(approveAsInvariantPortalClient(COI.emptySent, {
      signatureName: "Invariant Signer",
      clientSignatureUrl: "data:image/png;base64,AA==",
      approvedAt: new Date(),
      expectedRevision: 0,
      expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
    }));
    expect(message).toContain("priced item");
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.emptySent } })).status).toBe("Sent");
  });

  test("CO4: invalid subtotal removes the unused signature object", async () => {
    const approvalSignatures = createTrackedSignatureStore();
    const message = await rejectionMessage(approveChangeOrderWithSignature(
      COI.zeroSent,
      approvalInput("Zero Signer"),
      { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
    ));
    expect(message).toContain("positive subtotal");
    expect(approvalSignatures.objects).toEqual(new Set());
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.zeroSent } })).status).toBe("Sent");
  });

  test("CO5: concurrent losing approvals remove every unused signature object", async () => {
    const approvalSignatures = createTrackedSignatureStore();
    const attempts = await Promise.allSettled([
      approveChangeOrderWithSignature(
        COI.validSent,
        approvalInput("First Signer"),
        { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
      ),
      approveChangeOrderWithSignature(
        COI.validSent,
        approvalInput("Second Signer"),
        { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
      ),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);

    const co = await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.validSent } });
    expect(co.status).toBe("Approved");
    expect(co.clientSignatureUrl).toBeTruthy();
    expect(approvalSignatures.objects).toEqual(new Set([co.clientSignatureUrl!]));
  });

  test("CO5A: replay removes only the replay upload", async () => {
    const approvalSignatures = createTrackedSignatureStore();
    const first = await approveChangeOrderWithSignature(
      COI.replaySent,
      approvalInput("Original Signer"),
      { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
    );
    expect(first?.transitioned).toBe(true);
    const committed = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.replaySent },
    });
    expect(approvalSignatures.objects).toEqual(new Set([committed.clientSignatureUrl!]));

    const message = await rejectionMessage(approveChangeOrderWithSignature(
      COI.replaySent,
      approvalInput("Replay Signer"),
      { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
    ));

    expect(message).toContain("must be Sent");
    expect(approvalSignatures.objects).toEqual(new Set([committed.clientSignatureUrl!]));
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.replaySent },
    })).clientSignatureUrl).toBe(committed.clientSignatureUrl);
  });

  test("CO5B: transaction failure removes the attempt and preserves the original error", async () => {
    const approvalSignatures = createTrackedSignatureStore();
    const transactionError = new Error("injected transaction failure");
    let caught: unknown;
    try {
      await approveChangeOrderWithSignature(
        COI.rawDraft,
        approvalInput("Failed Transaction Signer"),
        {
          persistSignature: approvalSignatures.persistSignature,
          approveCore: async () => { throw transactionError; },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(transactionError);
    expect(approvalSignatures.objects).toEqual(new Set());
  });

  test("CO5C: missing change order removes the attempt before returning null", async () => {
    const approvalSignatures = createTrackedSignatureStore();
    const result = await approveChangeOrderWithSignature(
      "co-invariant-missing",
      approvalInput("Missing Signer"),
      { persistSignature: approvalSignatures.persistSignature, approveCore: approveAsInvariantPortalClient },
    );
    expect(result).toBeNull();
    expect(approvalSignatures.objects).toEqual(new Set());
  });

  test("CO5D: cleanup failure telemetry is sanitized and the primary error wins", async () => {
    const primaryError = new Error("primary approval failure");
    const events: ChangeOrderSignatureCleanupEvent[] = [];
    let caught: unknown;
    try {
      await approveChangeOrderWithSignature(
        COI.rawDraft,
        approvalInput("Sensitive Customer Name"),
        {
          persistSignature: async () => ({
            url: "https://signature.test/private-object.png",
            discard: async () => {
              throw Object.assign(new Error("private-object.png"), {
                code: "storage_delete_failed",
                status: 503,
              });
            },
          }),
          approveCore: async () => { throw primaryError; },
          reportCleanupFailure: (event) => events.push(event),
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(primaryError);
    expect(events).toEqual([{
      operation: "discard-rejected-change-order-signature",
      changeOrderId: COI.rawDraft,
      errorType: "Error",
      errorCode: "storage_delete_failed",
      status: 503,
    }]);
    expect(JSON.stringify(events)).not.toContain("private-object");
    expect(JSON.stringify(events)).not.toContain("Sensitive Customer Name");
  });

  test("CO5E: throwing cleanup reporter cannot replace the primary error", async () => {
    const primaryError = new Error("primary approval failure");
    let reporterCalls = 0;
    let caught: unknown;
    try {
      await approveChangeOrderWithSignature(
        COI.rawDraft,
        approvalInput("Reporter Failure Signer"),
        {
          persistSignature: async () => ({
            url: "https://signature.test/private-object.png",
            discard: async () => { throw new Error("cleanup failed"); },
          }),
          approveCore: async () => { throw primaryError; },
          reportCleanupFailure: () => {
            reporterCalls += 1;
            throw new Error("telemetry backend failed");
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(primaryError);
    expect(reporterCalls).toBe(1);
  });

  test("CO6: Approved scope metadata is immutable", async () => {
    const original = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.approved },
      include: { items: true },
    });
    const titleMessage = await rejectionMessage(updateChangeOrderCore(COI.approved, { title: "Mutated signed title", expectedRevision: original.revision }));
    expect(titleMessage).toContain("signed scope is locked");
    const descriptionMessage = await rejectionMessage(updateChangeOrderCore(COI.approved, { description: "Mutated signed description", expectedRevision: original.revision }));
    expect(descriptionMessage).toContain("signed scope is locked");
    const itemsMessage = await rejectionMessage(updateChangeOrderCore(COI.approved, {
      expectedRevision: original.revision,
      items: [{ id: original.items[0].id, name: "Mutated item", quantity: 2, unitCost: 100, order: 0 }],
    }));
    expect(itemsMessage).toContain("signed scope is locked");

    const after = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.approved },
      include: { items: true },
    });
    expect(after.title).toBe(original.title);
    expect(after.description).toBe(original.description);
    expect(after.items).toEqual(original.items);
  });

  test("CO7: approval validation serializes with a concurrent item repricing", async () => {
    let releaseWriter!: () => void;
    const writerMayCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let writerLocked!: () => void;
    const writerHasLock = new Promise<void>((resolve) => { writerLocked = resolve; });

    const writer = coInvariantPrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ChangeOrder" WHERE "id" = ${COI.race} FOR UPDATE`;
      await tx.changeOrderItem.deleteMany({ where: { changeOrderId: COI.race } });
      await tx.changeOrder.update({ where: { id: COI.race }, data: { totalAmount: 0, balanceDue: 0 } });
      writerLocked();
      await writerMayCommit;
    }, { timeout: 15_000 });

    await writerHasLock;
    const approval = approveAsInvariantPortalClient(COI.race, {
      signatureName: "Racing Signer",
      clientSignatureUrl: "data:image/png;base64,AA==",
      approvedAt: new Date(),
      expectedRevision: 0,
      expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
    });
    try {
      await expect.poll(async () => {
        const rows = await coInvariantPrisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count"
          FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND state = 'active'
            AND query LIKE '%FROM "ChangeOrder"%FOR UPDATE%'`;
        return rows[0]?.count ?? 0;
      }, { timeout: 5_000, intervals: [25, 50, 100] }).toBeGreaterThan(0);
    } finally {
      releaseWriter();
    }
    await writer;

    const message = await rejectionMessage(approval);
    expect(message).toMatch(/priced item|positive subtotal/);
    const co = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.race },
      include: { items: true },
    });
    expect(co.status).toBe("Sent");
    expect(co.items).toHaveLength(0);
    expect(Number(co.totalAmount)).toBe(0);
  });

  test("CO8: duplicate item IDs cannot inflate the stored subtotal", async () => {
    const message = await rejectionMessage(updateChangeOrderCore(COI.duplicate, {
      expectedRevision: 0,
      items: [
        { id: COI.duplicateItem, name: "Invariant item", quantity: 1, unitCost: 100, order: 0 },
        { id: COI.duplicateItem, name: "Invariant item", quantity: 1, unitCost: 100, order: 1 },
      ],
    }));
    expect(message).toContain("Duplicate change-order item ID");

    const co = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.duplicate },
      include: { items: true },
    });
    expect(co.items).toHaveLength(1);
    expect(Number(co.items[0].total)).toBe(100);
    expect(Number(co.totalAmount)).toBe(100);
    expect(Number(co.balanceDue)).toBe(100);
  });

  test("CO9: editing Sent scope demotes it to Draft and invalidates a stale approval", async () => {
    const updated = await updateChangeOrderCore(COI.stale, {
      expectedRevision: 0,
      title: "Repriced after client render",
      items: [{ id: COI.staleItem, name: "Invariant item", quantity: 1, unitCost: 200, order: 0 }],
    });
    expect(updated.status).toBe("Draft");
    expect(updated.sentAt).toBeNull();
    expect(Number(updated.totalAmount)).toBe(200);

    const message = await rejectionMessage(approveAsInvariantPortalClient(COI.stale, {
      signatureName: "Stale-page Signer",
      clientSignatureUrl: "data:image/png;base64,AA==",
      approvedAt: new Date(),
      expectedRevision: 0,
      expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
    }));
    expect(message).toContain("must be Sent");
  });

  test("CO10: guarded send rejects stored subtotal drift from rendered items", async () => {
    const result = await sendChangeOrderToClientCore(COI.driftSend, {
      expectedRevision: 0,
      expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error).toContain("out of sync");
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.driftSend } })).status).toBe("Sent");
  });

  test("CO11: approval rejects stored subtotal drift from rendered items", async () => {
    const message = await rejectionMessage(approveAsInvariantPortalClient(COI.driftApproval, {
      signatureName: "Drift Signer",
      clientSignatureUrl: "data:image/png;base64,AA==",
      approvedAt: new Date(),
      expectedRevision: 0,
      expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
    }));
    expect(message).toContain("out of sync");
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.driftApproval } })).status).toBe("Sent");
  });

  test("CO12: signed change orders cannot be deleted", async () => {
    const message = await rejectionMessage(deleteChangeOrderCore(COI.approvedDelete));
    expect(message).toContain("Only unsigned Draft change orders can be deleted");
    expect(await coInvariantPrisma.changeOrder.findUnique({ where: { id: COI.approvedDelete } })).not.toBeNull();
  });

  test("CO13: approval requires a persisted client signature", async () => {
    const message = await rejectionMessage(approveAsInvariantPortalClient(COI.unsigned, {
      signatureName: "Unsigned Signer",
      clientSignatureUrl: null,
      approvedAt: new Date(),
      expectedRevision: 0,
      expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true }),
    }));
    expect(message).toContain("signature is required");
    expect((await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.unsigned } })).status).toBe("Sent");
  });

  test("CO14: company-countersigned scope is immutable before client approval", async () => {
    const message = await rejectionMessage(updateChangeOrderCore(COI.companySigned, {
      expectedRevision: 0,
      items: [{ id: COI.companySignedItem, name: "Mutated after company signature", quantity: 1, unitCost: 200, order: 0 }],
    }));
    expect(message).toContain("signed scope is locked");
    const co = await coInvariantPrisma.changeOrder.findUniqueOrThrow({ where: { id: COI.companySigned } });
    expect(co.status).toBe("Sent");
    expect(Number(co.totalAmount)).toBe(100);
  });

  test("CO15: a no-op save preserves Sent status and its delivery timestamp", async () => {
    const before = await coInvariantPrisma.changeOrder.findUniqueOrThrow({
      where: { id: COI.noOpSent },
      include: { items: true },
    });
    const updated = await updateChangeOrderCore(COI.noOpSent, {
      expectedRevision: before.revision,
      title: before.title,
      description: before.description,
      items: before.items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        type: item.type,
        quantity: item.quantity,
        unitCost: Number(item.unitCost),
        order: item.order,
        costCodeId: item.costCodeId,
        costTypeId: item.costTypeId,
      })),
    });

    expect(updated.status).toBe("Sent");
    expect(updated.sentAt?.toISOString()).toBe(before.sentAt?.toISOString());
  });

  test("CO16: a legacy company-signed Draft cannot be deleted", async () => {
    const message = await rejectionMessage(deleteChangeOrderCore(COI.legacySignedDraft));
    expect(message).toContain("Only unsigned Draft change orders can be deleted");
    expect(await coInvariantPrisma.changeOrder.findUnique({ where: { id: COI.legacySignedDraft } })).not.toBeNull();
  });

  test("CO17: the server action delegates signature ownership to the coordinator", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/actions.ts"), "utf8");
    const start = source.indexOf("export async function approveChangeOrder(");
    const end = source.indexOf("\nexport async function ", start + 1);
    const actionSource = source.slice(start, end === -1 ? undefined : end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(actionSource).toContain("await approveChangeOrderWithSignature(");
    expect(actionSource).not.toContain("await persistSignature(");
    expect(actionSource).not.toContain("await approveChangeOrderCore(");
  });
});

/**
 * Stripe-rail mirror regression â€” the invoice-side Stripe rails (webhook settle,
 * portal `verifyStripeSession` fallback, and the two full-refund branches) did no
 * mirroring at all, so a client paying a Stripe invoice left the estimate copy
 * showing unpaid. These tests drive the shared helpers those rails now call
 * (`src/lib/payment-mirror.ts`) directly against real rows: the webhook itself
 * cannot be exercised here because it needs a signed Stripe payload.
 */
const S = {
  client: "mp3-e2e-client",
  project: "mp3-e2e-project",
  estimate: "mp3-e2e-estimate",
  invoice: "mp3-e2e-invoice",
  estDeposit: "mp3-e2e-eps-deposit",
  invDeposit: "mp3-e2e-ps-deposit",
  estAmbigA: "mp3-e2e-eps-ambig-a",
  estAmbigB: "mp3-e2e-eps-ambig-b",
  estAmbigDecoy: "mp3-e2e-eps-ambig-decoy",
  invAmbig: "mp3-e2e-ps-ambig",
  // S5/S6 live on their OWN estimate+invoice pair so their paid milestone
  // can't move the balances S1-S4 assert on.
  estimate2: "mp3-e2e-estimate-2",
  invoice2: "mp3-e2e-invoice-2",
  estOther: "mp3-e2e-eps-other",
  invOtherCharge: "mp3-e2e-ps-other-charge",
};
const S_NAME = "Stripe Mirror Drill - MP3TEST";
const sPrisma = new PrismaClient();
const INTENT = "pi_mp3_e2e_intent";
const OTHER_INTENT = "pi_mp3_e2e_other_intent";

test.describe.serial("Money pipeline: Stripe rails mirror both sides", () => {
  test.beforeAll(async () => {
    await sPrisma.client.upsert({
      where: { id: S.client },
      update: {},
      create: { id: S.client, name: "MP3 Drill Client", initials: "M3" },
    });
    await sPrisma.project.upsert({
      where: { id: S.project },
      update: {},
      create: { id: S.project, name: S_NAME, clientId: S.client, status: "In Progress" },
    });
    await sPrisma.estimate.upsert({
      where: { id: S.estimate },
      update: { status: "Invoiced", totalAmount: 1000, balanceDue: 1000, statusBeforePayment: null },
      create: {
        id: S.estimate, title: S_NAME, code: "EST-MP3TEST", projectId: S.project,
        status: "Invoiced", taxExempt: true, totalAmount: 1000, balanceDue: 1000,
      },
    });
    await sPrisma.invoice.upsert({
      where: { id: S.invoice },
      update: { status: "Issued", totalAmount: 1000, balanceDue: 1000 },
      create: {
        id: S.invoice, code: "INV-MP3TEST", projectId: S.project, clientId: S.client,
        estimateId: S.estimate, status: "Issued", totalAmount: 1000, balanceDue: 1000,
        issueDate: new Date(),
      },
    });
    // Linked pair (the normal converted-estimate shape).
    await sPrisma.estimatePaymentSchedule.upsert({
      where: { id: S.estDeposit },
      update: { status: "Pending", paidAt: null, paymentDate: null, paymentMethod: null, stripeSessionId: null, stripePaymentIntentId: null },
      create: { id: S.estDeposit, estimateId: S.estimate, name: "MP3 Deposit", amount: 600, status: "Pending", order: 1 },
    });
    await sPrisma.paymentSchedule.upsert({
      where: { id: S.invDeposit },
      update: { status: "Pending", paidAt: null, paymentDate: null },
      create: { id: S.invDeposit, invoiceId: S.invoice, name: "MP3 Deposit", amount: 600, status: "Pending", sourceScheduleId: S.estDeposit },
    });
    // Two UNLINKED estimate rows with the same name+amount: the legacy fallback
    // must refuse to guess between them. A THIRD same-name row with a different
    // amount sits alongside them — with the old `take: 2` window that row could
    // displace one of the real matches and make an ambiguous pair look unique,
    // so its presence is what makes this case a regression test.
    for (const id of [S.estAmbigA, S.estAmbigB]) {
      await sPrisma.estimatePaymentSchedule.upsert({
        where: { id },
        update: { status: "Pending", paidAt: null, paymentDate: null },
        create: { id, estimateId: S.estimate, name: "MP3 Ambiguous", amount: 200, status: "Pending", order: 3 },
      });
    }
    await sPrisma.estimatePaymentSchedule.upsert({
      where: { id: S.estAmbigDecoy },
      update: { status: "Pending", paidAt: null, paymentDate: null },
      create: { id: S.estAmbigDecoy, estimateId: S.estimate, name: "MP3 Ambiguous", amount: 999, status: "Pending", order: 2 },
    });
    await sPrisma.paymentSchedule.upsert({
      where: { id: S.invAmbig },
      update: { status: "Pending", paidAt: null, paymentDate: null },
      create: { id: S.invAmbig, invoiceId: S.invoice, name: "MP3 Ambiguous", amount: 200, status: "Pending" },
    });
    // Second pair, fully paid by a single charge. Its ONLY linked invoice clone
    // starts out settled through a DIFFERENT charge — refunding this milestone's
    // charge must not release it (S5), and once the clone does belong to this
    // charge the refund must unwind it (S6).
    await sPrisma.estimate.upsert({
      where: { id: S.estimate2 },
      update: { status: "Invoiced", totalAmount: 200, balanceDue: 0, statusBeforePayment: null },
      create: {
        id: S.estimate2, title: `${S_NAME} 2`, code: "EST-MP3TEST-2", projectId: S.project,
        status: "Invoiced", taxExempt: true, totalAmount: 200, balanceDue: 0,
      },
    });
    await sPrisma.invoice.upsert({
      where: { id: S.invoice2 },
      update: { status: "Paid", totalAmount: 200, balanceDue: 0 },
      create: {
        id: S.invoice2, code: "INV-MP3TEST-2", projectId: S.project, clientId: S.client,
        estimateId: S.estimate2, status: "Paid", totalAmount: 200, balanceDue: 0,
        issueDate: new Date(),
      },
    });
    await sPrisma.estimatePaymentSchedule.upsert({
      where: { id: S.estOther },
      update: { status: "Paid", stripePaymentIntentId: INTENT },
      create: {
        id: S.estOther, estimateId: S.estimate2, name: "MP3 Other", amount: 200,
        status: "Paid", order: 1, stripePaymentIntentId: INTENT,
      },
    });
    await sPrisma.paymentSchedule.upsert({
      where: { id: S.invOtherCharge },
      update: { status: "Paid", stripePaymentIntentId: OTHER_INTENT },
      create: {
        id: S.invOtherCharge, invoiceId: S.invoice2, name: "MP3 Other", amount: 200,
        status: "Paid", sourceScheduleId: S.estOther, stripePaymentIntentId: OTHER_INTENT,
      },
    });
  });

  test.afterAll(async () => {
    try {
      await sPrisma.paymentSchedule.deleteMany({ where: { invoiceId: { in: [S.invoice, S.invoice2] } } });
      await sPrisma.invoice.deleteMany({ where: { id: { in: [S.invoice, S.invoice2] } } });
      await sPrisma.estimatePaymentSchedule.deleteMany({ where: { estimateId: { in: [S.estimate, S.estimate2] } } });
      await sPrisma.estimate.deleteMany({ where: { id: { in: [S.estimate, S.estimate2] } } });
      await sPrisma.project.deleteMany({ where: { id: S.project } });
      await sPrisma.client.deleteMany({ where: { id: S.client } });
    } finally {
      await sPrisma.$disconnect();
    }
  });

  test("S1: settling the invoice copy mirrors onto the estimate milestone", async () => {
    const now = new Date();
    // Stand in for what the Stripe rail's own transaction does before it mirrors:
    // claim the invoice-side row and recompute the invoice. The assertion below is
    // that the ESTIMATE ends up agreeing with that invoice, which is the invariant.
    await sPrisma.paymentSchedule.update({
      where: { id: S.invDeposit },
      data: { status: "Paid", paidAt: now, paymentDate: now, stripePaymentIntentId: INTENT },
    });
    await sPrisma.invoice.update({
      where: { id: S.invoice },
      data: { balanceDue: 400, status: "Partially Paid" },
    });
    const payment = await sPrisma.paymentSchedule.findUniqueOrThrow({ where: { id: S.invDeposit } });

    const mirrored = await sPrisma.$transaction((tx) =>
      mirrorInvoiceSettleToEstimate(tx, {
        estimateId: S.estimate,
        payment,
        data: { paymentDate: now, paidAt: now, paymentMethod: "card", stripePaymentIntentId: INTENT },
      }),
    );

    expect(mirrored, "the estimate copy was claimed").toBe(true);
    const estCopy = await sPrisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: S.estDeposit } });
    expect(estCopy.status, "estimate milestone mirrors the Stripe invoice payment").toBe("Paid");

    const estimate = await sPrisma.estimate.findUniqueOrThrow({ where: { id: S.estimate } });
    const invoice = await sPrisma.invoice.findUniqueOrThrow({ where: { id: S.invoice } });
    expect(Number(estimate.balanceDue), "estimate balance drops by the paid milestone").toBe(400);
    expect(Number(estimate.balanceDue), "the two documents agree on what is owed")
      .toBe(Number(invoice.balanceDue));
    expect(estimate.status).toBe("Partially Paid");
    expect(estimate.statusBeforePayment, "pre-payment status captured for undo").toBe("Invoiced");
  });

  test("S2: mirroring is at-most-once â€” a replay claims nothing and moves no balance", async () => {
    const now = new Date();
    const payment = await sPrisma.paymentSchedule.findUniqueOrThrow({ where: { id: S.invDeposit } });
    const before = await sPrisma.estimate.findUniqueOrThrow({ where: { id: S.estimate } });

    const mirrored = await sPrisma.$transaction((tx) =>
      mirrorInvoiceSettleToEstimate(tx, {
        estimateId: S.estimate,
        payment,
        data: { paymentDate: now, paidAt: now, paymentMethod: "card", stripePaymentIntentId: INTENT },
      }),
    );

    expect(mirrored, "an already-Paid mirror is not re-claimed").toBe(false);
    const after = await sPrisma.estimate.findUniqueOrThrow({ where: { id: S.estimate } });
    expect(Number(after.balanceDue)).toBe(Number(before.balanceDue));
  });

  test("S3: a full refund unwinds the estimate mirror and keeps its Stripe ids", async () => {
    const payment = await sPrisma.paymentSchedule.findUniqueOrThrow({ where: { id: S.invDeposit } });

    const unwound = await sPrisma.$transaction((tx) =>
      mirrorInvoiceUnsettleToEstimate(tx, { estimateId: S.estimate, payment }),
    );

    expect(unwound, "the estimate copy was released").toBe(true);
    const estCopy = await sPrisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: S.estDeposit } });
    expect(estCopy.status).toBe("Pending");
    // The Stripe ids MUST survive the reset: they are how a redelivered refund
    // re-finds this exact row. Clearing them would let a duplicate delivery land
    // on a different clone sharing the intent and unset a real payment.
    expect(estCopy.stripePaymentIntentId, "the charge link survives the reset").toBe(INTENT);

    const estimate = await sPrisma.estimate.findUniqueOrThrow({ where: { id: S.estimate } });
    expect(Number(estimate.balanceDue), "estimate balance restored in full").toBe(1000);
    expect(estimate.status, "pre-payment status restored").toBe("Invoiced");
    expect(estimate.statusBeforePayment).toBeNull();
  });

  test("S4: an ambiguous unlinked pair is left alone rather than guessed at", async () => {
    const now = new Date();
    const payment = await sPrisma.paymentSchedule.findUniqueOrThrow({ where: { id: S.invAmbig } });

    const mirrored = await sPrisma.$transaction((tx) =>
      mirrorInvoiceSettleToEstimate(tx, {
        estimateId: S.estimate,
        payment,
        data: { paymentDate: now, paidAt: now, paymentMethod: "card" },
      }),
    );

    expect(mirrored, "two identical candidates must not resolve to one").toBe(false);
    const rows = await sPrisma.estimatePaymentSchedule.findMany({
      where: { id: { in: [S.estAmbigA, S.estAmbigB, S.estAmbigDecoy] } },
    });
    expect(rows.every((r) => r.status === "Pending"), "no candidate was touched").toBe(true);
  });

  test("S5: refunding an estimate milestone never releases a clone paid by another charge", async () => {
    const schedule = await sPrisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: S.estOther } });

    const mirror = await sPrisma.$transaction((tx) =>
      findInvoiceMirrorOfEstimateSchedule(tx, schedule),
    );

    expect(mirror, "the sole linked clone carries a different PaymentIntent").toBeNull();
    const clone = await sPrisma.paymentSchedule.findUniqueOrThrow({ where: { id: S.invOtherCharge } });
    expect(clone.status, "the other charge's payment stays Paid").toBe("Paid");
  });

  test("S6: refunding an estimate milestone unwinds its invoice clone and balance", async () => {
    // Re-point the clone at THIS charge, which is the ordinary settled pair.
    await sPrisma.paymentSchedule.update({
      where: { id: S.invOtherCharge },
      data: { stripePaymentIntentId: INTENT, status: "Paid" },
    });
    const schedule = await sPrisma.estimatePaymentSchedule.findUniqueOrThrow({ where: { id: S.estOther } });

    const unwound = await sPrisma.$transaction(async (tx) => {
      const mirror = await findInvoiceMirrorOfEstimateSchedule(tx, schedule);
      expect(mirror?.id, "the same-charge clone is the mirror").toBe(S.invOtherCharge);
      return mirror ? await mirrorEstimateUnsettleToInvoice(tx, mirror) : false;
    });

    expect(unwound, "the invoice clone was released").toBe(true);
    const clone = await sPrisma.paymentSchedule.findUniqueOrThrow({ where: { id: S.invOtherCharge } });
    expect(clone.status).toBe("Pending");
    const invoice = await sPrisma.invoice.findUniqueOrThrow({ where: { id: S.invoice2 } });
    expect(Number(invoice.balanceDue), "invoice balance restored by the refunded amount").toBe(200);
    expect(invoice.status).toBe("Issued");
  });
});
