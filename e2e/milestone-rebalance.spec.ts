import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    updatePendingMilestoneAmountsCore,
    deleteInvoiceMilestoneCore,
    splitInvoiceMilestonesCore,
} from "../src/lib/billing-core";

/**
 * Milestone rebalance + QBO resync regression net.
 *
 * Covers the three session-free cores behind the "Edit amounts" / delete-extra
 * / split flows on the invoice editor (actions.ts wraps these with
 * `assertInvoicePermission()`, which needs a real Next.js request scope — see
 * `reconcile-to-qbo.spec.ts` for the established precedent of testing the
 * auth-free core directly against the throwaway CI Postgres).
 *
 * No live QuickBooks connection exists in this test DB (no Integration row),
 * so `getFreshQBTokens()` throws `QBNotConnectedError` for any row that carries
 * a `qbInvoiceId` — the QB-touching test below asserts the row KEEPS its link
 * (unlinking only ever happens after the old QBO invoice is confirmed deleted,
 * which can't be reached here) and a warning comes back; no live QBO call is
 * ever made.
 */

const prisma = new PrismaClient();
const PFX = "mr-e2e";
const num = (v: unknown) => Number(v);

async function afterAllCleanup() {
    try {
        await prisma.paymentSchedule.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.invoice.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.estimatePaymentSchedule.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.estimate.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.project.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.client.deleteMany({ where: { id: { startsWith: PFX } } });
    } finally {
        await prisma.$disconnect();
    }
}

async function ensureClientAndProject() {
    await prisma.client.upsert({
        where: { id: `${PFX}-client` },
        update: {},
        create: { id: `${PFX}-client`, name: "MR Client", initials: "MR" },
    });
    await prisma.project.upsert({
        where: { id: `${PFX}-project` },
        update: {},
        create: { id: `${PFX}-project`, name: "MR Project", clientId: `${PFX}-client` },
    });
}

test.describe.serial("updatePendingMilestoneAmountsCore", () => {
    test.afterAll(afterAllCleanup);

    test("rejects a mismatched total", async () => {
        await ensureClientAndProject();
        const suffix = "mismatch";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psA = `${PFX}-ps-a-${suffix}`;
        const psB = `${PFX}-ps-b-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.paymentSchedule.create({ data: { id: psA, invoiceId, name: "Deposit", amount: 400, status: "Pending" } });
        await prisma.paymentSchedule.create({ data: { id: psB, invoiceId, name: "Final", amount: 600, status: "Pending" } });

        await expect(
            updatePendingMilestoneAmountsCore(invoiceId, [
                { scheduleId: psA, name: "Deposit", amount: 400 },
                { scheduleId: psB, name: "Final", amount: 500 }, // 900 total, not 1000
            ]),
        ).rejects.toThrow();

        const a = await prisma.paymentSchedule.findUnique({ where: { id: psA } });
        const b = await prisma.paymentSchedule.findUnique({ where: { id: psB } });
        expect(num(a!.amount)).toBe(400); // unchanged
        expect(num(b!.amount)).toBe(600); // unchanged
    });

    test("successful rebalance updates rows + estimate mirrors and leaves totalAmount/balanceDue unchanged", async () => {
        await ensureClientAndProject();
        const suffix = "success";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const epsA = `${PFX}-eps-a-${suffix}`;
        const epsB = `${PFX}-eps-b-${suffix}`;
        const psA = `${PFX}-ps-a-${suffix}`;
        const psB = `${PFX}-ps-b-${suffix}`;

        // Both rows are estimate-mirrored: rebalancing may only move money WITHIN
        // a pool (mirrored ↔ mirrored), so a fully-mirrored schedule is the
        // canonical happy path (this matches Mesplay/Berg's real shape).
        await prisma.estimate.create({
            data: { id: estimateId, title: "MR Estimate", code: `EST-MR-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.estimatePaymentSchedule.create({
            data: { id: epsA, estimateId, name: "Deposit", percentage: 40, amount: 400, status: "Pending", order: 1 },
        });
        await prisma.estimatePaymentSchedule.create({
            data: { id: epsB, estimateId, name: "Final", percentage: 60, amount: 600, status: "Pending", order: 2 },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psA, invoiceId, name: "Deposit", amount: 400, status: "Pending", sourceScheduleId: epsA, dueDate: new Date("2026-01-01") },
        });
        await prisma.paymentSchedule.create({
            data: { id: psB, invoiceId, name: "Final", amount: 600, status: "Pending", sourceScheduleId: epsB },
        });

        const res = await updatePendingMilestoneAmountsCore(invoiceId, [
            { scheduleId: psA, name: "Deposit (revised)", amount: 350, dueDate: "2026-02-01" },
            { scheduleId: psB, name: "Final", amount: 650 },
        ]);
        expect(res.success).toBe(true);
        expect(res.warnings).toEqual([]);

        const a = await prisma.paymentSchedule.findUnique({ where: { id: psA } });
        const b = await prisma.paymentSchedule.findUnique({ where: { id: psB } });
        expect(a!.name).toBe("Deposit (revised)");
        expect(num(a!.amount)).toBe(350);
        expect(a!.dueDate?.toISOString().slice(0, 10)).toBe("2026-02-01");
        expect(num(b!.amount)).toBe(650);

        // Estimate-side mirrors follow, percentage cleared (no longer a fixed share).
        const eps = await prisma.estimatePaymentSchedule.findUnique({ where: { id: epsA } });
        expect(eps!.name).toBe("Deposit (revised)");
        expect(num(eps!.amount)).toBe(350);
        expect(eps!.percentage).toBeNull();
        const epsB2 = await prisma.estimatePaymentSchedule.findUnique({ where: { id: epsB } });
        expect(num(epsB2!.amount)).toBe(650);
        expect(epsB2!.percentage).toBeNull();

        // Invoice total/balance are untouched by a rebalance.
        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(1000);
        expect(num(invoice!.balanceDue)).toBe(1000);
    });

    test("rejects a submitted row that is already Paid", async () => {
        await ensureClientAndProject();
        const suffix = "paidrow";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psPaid = `${PFX}-ps-paid-${suffix}`;
        const psPending = `${PFX}-ps-pending-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Partially Paid", totalAmount: 1000, balanceDue: 600 },
        });
        await prisma.paymentSchedule.create({ data: { id: psPaid, invoiceId, name: "Deposit", amount: 400, status: "Paid" } });
        await prisma.paymentSchedule.create({ data: { id: psPending, invoiceId, name: "Final", amount: 600, status: "Pending" } });

        await expect(
            updatePendingMilestoneAmountsCore(invoiceId, [
                { scheduleId: psPaid, name: "Deposit", amount: 350 },
                { scheduleId: psPending, name: "Final", amount: 650 },
            ]),
        ).rejects.toThrow(/not Pending/i);

        const paid = await prisma.paymentSchedule.findUnique({ where: { id: psPaid } });
        expect(num(paid!.amount)).toBe(400); // unchanged
    });

    test("QB-linked row: aborts with NO changes when QuickBooks is unreachable (preflight)", async () => {
        await ensureClientAndProject();
        const suffix = "qblinked";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psQB = `${PFX}-ps-qb-${suffix}`;
        const psOther = `${PFX}-ps-other-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psQB, invoiceId, name: "Deposit", amount: 400, status: "Pending", qbInvoiceId: "fake-qbo-1", qbInvoiceLink: "https://qbo.example/fake-1" },
        });
        await prisma.paymentSchedule.create({ data: { id: psOther, invoiceId, name: "Final", amount: 600, status: "Pending" } });

        // The preflight must verify the staged QBO invoice is reachable and
        // payment-free BEFORE any DB write. This env has no QuickBooks
        // connection, so the whole rebalance aborts and NOTHING changes — a
        // payment sitting unpulled on the old QBO invoice can therefore never be
        // settled against a silently repriced milestone.
        await expect(
            updatePendingMilestoneAmountsCore(invoiceId, [
                { scheduleId: psQB, name: "Deposit", amount: 350 },
                { scheduleId: psOther, name: "Final", amount: 650 },
            ]),
        ).rejects.toThrow(/QuickBooks is unreachable/i);

        const qbRow = await prisma.paymentSchedule.findUnique({ where: { id: psQB } });
        const other = await prisma.paymentSchedule.findUnique({ where: { id: psOther } });
        expect(num(qbRow!.amount)).toBe(400); // untouched
        expect(qbRow!.qbInvoiceId).toBe("fake-qbo-1");
        expect(qbRow!.qbInvoiceLink).toBe("https://qbo.example/fake-1");
        expect(num(other!.amount)).toBe(600); // untouched

        // A rebalance that does NOT touch the QB-linked row's content sails
        // through without needing QuickBooks at all.
        const res = await updatePendingMilestoneAmountsCore(invoiceId, [
            { scheduleId: psQB, name: "Deposit", amount: 400 },
            { scheduleId: psOther, name: "Final", amount: 600 },
        ]);
        expect(res.success).toBe(true);
        expect(res.warnings).toEqual([]);
    });

    test("rejects moving money between estimate-mirrored rows and extras", async () => {
        await ensureClientAndProject();
        const suffix = "crosspool";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const eps = `${PFX}-eps-${suffix}`;
        const psMirrored = `${PFX}-ps-m-${suffix}`;
        const psExtra = `${PFX}-ps-x-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "MR Estimate", code: `EST-MR-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 400, balanceDue: 400 },
        });
        await prisma.estimatePaymentSchedule.create({ data: { id: eps, estimateId, name: "Deposit", amount: 400, status: "Pending", order: 1 } });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.paymentSchedule.create({ data: { id: psMirrored, invoiceId, name: "Deposit", amount: 400, status: "Pending", sourceScheduleId: eps } });
        await prisma.paymentSchedule.create({ data: { id: psExtra, invoiceId, name: "Extra", amount: 600, status: "Pending" } });

        // Invoice-wide total is preserved (1000) but $50 slides from the mirrored
        // row to the extra — that would desync the estimate schedule from the
        // estimate total, so it must be rejected.
        await expect(
            updatePendingMilestoneAmountsCore(invoiceId, [
                { scheduleId: psMirrored, name: "Deposit", amount: 350 },
                { scheduleId: psExtra, name: "Extra", amount: 650 },
            ]),
        ).rejects.toThrow(/estimate-linked/i);

        const m = await prisma.paymentSchedule.findUnique({ where: { id: psMirrored } });
        const x = await prisma.paymentSchedule.findUnique({ where: { id: psExtra } });
        expect(num(m!.amount)).toBe(400); // unchanged
        expect(num(x!.amount)).toBe(600); // unchanged
    });
});

test.describe.serial("deleteInvoiceMilestoneCore", () => {
    test.afterAll(afterAllCleanup);

    test("rejects a mirrored row (sourceScheduleId set)", async () => {
        await ensureClientAndProject();
        const suffix = "mirrored";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const eps = `${PFX}-eps-${suffix}`;
        const ps = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "MR Estimate", code: `EST-MR-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.estimatePaymentSchedule.create({ data: { id: eps, estimateId, name: "Deposit", amount: 500, status: "Pending", order: 1 } });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.paymentSchedule.create({ data: { id: ps, invoiceId, name: "Deposit", amount: 500, status: "Pending", sourceScheduleId: eps } });

        await expect(deleteInvoiceMilestoneCore(ps)).rejects.toThrow(/linked to the estimate/i);

        const row = await prisma.paymentSchedule.findUnique({ where: { id: ps } });
        expect(row).not.toBeNull(); // not deleted
    });

    test("rejects a QuickBooks-linked row", async () => {
        await ensureClientAndProject();
        const suffix = "qblinked";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const ps = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.paymentSchedule.create({ data: { id: ps, invoiceId, name: "Extra", amount: 500, status: "Pending", qbInvoiceId: "fake-qbo-2" } });

        await expect(deleteInvoiceMilestoneCore(ps)).rejects.toThrow(/QuickBooks invoice staged/i);

        const row = await prisma.paymentSchedule.findUnique({ where: { id: ps } });
        expect(row).not.toBeNull(); // not deleted
    });

    test("deletes a pending extra and decrements the invoice total/balance", async () => {
        await ensureClientAndProject();
        const suffix = "delete-success";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psPaid = `${PFX}-ps-paid-${suffix}`;
        const psExtra = `${PFX}-ps-extra-${suffix}`;

        // 400 already paid, 600 pending extra with nothing else outstanding —
        // deleting the extra should fully settle the invoice (balance → 0, Paid).
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Partially Paid", totalAmount: 1000, balanceDue: 600 },
        });
        await prisma.paymentSchedule.create({ data: { id: psPaid, invoiceId, name: "Deposit", amount: 400, status: "Paid" } });
        await prisma.paymentSchedule.create({ data: { id: psExtra, invoiceId, name: "Extra Charge", amount: 600, status: "Pending" } });

        const res = await deleteInvoiceMilestoneCore(psExtra);
        expect(res.success).toBe(true);
        expect(res.invoiceId).toBe(invoiceId);

        const deleted = await prisma.paymentSchedule.findUnique({ where: { id: psExtra } });
        expect(deleted).toBeNull();

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(400);
        expect(num(invoice!.balanceDue)).toBe(0);
        expect(invoice!.status).toBe("Paid");
    });

    test("keeps a Draft invoice Draft when deleting its only pending extra", async () => {
        await ensureClientAndProject();
        const suffix = "delete-draft";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psExtra = `${PFX}-ps-extra-${suffix}`;

        // No payments at all — a zero balance reached purely by deletion must not
        // read as "Paid".
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Draft", totalAmount: 600, balanceDue: 600 },
        });
        await prisma.paymentSchedule.create({ data: { id: psExtra, invoiceId, name: "Extra Charge", amount: 600, status: "Pending" } });

        const res = await deleteInvoiceMilestoneCore(psExtra);
        expect(res.success).toBe(true);

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(0);
        expect(num(invoice!.balanceDue)).toBe(0);
        expect(invoice!.status).toBe("Draft");
    });
});

test.describe.serial("splitInvoiceMilestonesCore partially-paid total fix", () => {
    test.afterAll(afterAllCleanup);

    test("totalAmount = paid + newTotal, balanceDue = newTotal", async () => {
        await ensureClientAndProject();
        const suffix = "split-partial";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psPaid = `${PFX}-ps-paid-${suffix}`;
        const psPending = `${PFX}-ps-pending-${suffix}`;

        // 400 paid, 600 pending (old total 1000). Re-split the pending portion
        // into a NEW total of 700 (not equal to the old pending total) so the
        // fix is unambiguous: the old buggy code would have produced
        // totalAmount=700 (dropping the paid 400) and balanceDue=300
        // (max(0, 700-400)) instead of the correct 1100 / 700.
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-MR-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Partially Paid", totalAmount: 1000, balanceDue: 600 },
        });
        await prisma.paymentSchedule.create({ data: { id: psPaid, invoiceId, name: "Deposit", amount: 400, status: "Paid" } });
        await prisma.paymentSchedule.create({ data: { id: psPending, invoiceId, name: "Final", amount: 600, status: "Pending" } });

        const projectId = await splitInvoiceMilestonesCore(invoiceId, [
            { name: "Progress 1", amount: 350 },
            { name: "Progress 2", amount: 350 },
        ]);
        expect(projectId).toBe(`${PFX}-project`);

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(1100); // paid(400) + newTotal(700)
        expect(num(invoice!.balanceDue)).toBe(700); // exactly the fresh pending total
        expect(invoice!.status).toBe("Partially Paid");

        // Paid row survives untouched; pending rows were replaced.
        const paid = await prisma.paymentSchedule.findUnique({ where: { id: psPaid } });
        expect(paid).not.toBeNull();
        expect(num(paid!.amount)).toBe(400);

        const remaining = await prisma.paymentSchedule.findMany({ where: { invoiceId, status: "Pending" } });
        expect(remaining.length).toBe(2);
        expect(remaining.reduce((sum, r) => sum + num(r.amount), 0)).toBe(700);
    });
});
