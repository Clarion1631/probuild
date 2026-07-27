import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    createProgressBillingCore,
    updateProgressBillingCore,
    deleteProgressBillingCore,
    stageProgressBillingToQuickBooksCore,
} from "../src/lib/progress-billing";

/**
 * Progress billing core regression net.
 *
 * Covers the session-free cores in src/lib/progress-billing.ts directly
 * against the throwaway CI Postgres (same established pattern as
 * e2e/milestone-rebalance.spec.ts — actions.ts wrappers need a real Next.js
 * request scope and come in the UI pass).
 *
 * No live QuickBooks connection exists in this test DB (no Integration row),
 * so stageProgressBillingToQuickBooksCore's getFreshQBTokens() call always
 * throws QBNotConnectedError before any QBO network call or DB write — the
 * QBO tests below assert exactly that (rejection + DB unchanged), never a
 * live QBO call.
 */

const prisma = new PrismaClient();
const PFX = "pb-e2e";
const num = (v: unknown) => Number(v);

async function afterAllCleanup() {
    try {
        await prisma.progressBillingLine.deleteMany({ where: { billing: { invoiceId: { startsWith: PFX } } } });
        await prisma.progressBilling.deleteMany({ where: { invoiceId: { startsWith: PFX } } });
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
        create: { id: `${PFX}-client`, name: "PB Client", initials: "PB" },
    });
    await prisma.project.upsert({
        where: { id: `${PFX}-project` },
        update: {},
        create: { id: `${PFX}-project`, name: "PB Project", clientId: `${PFX}-client` },
    });
}

test.describe.serial("createProgressBillingCore", () => {
    test.afterAll(afterAllCleanup);

    test("rejects over-billing a milestone; DB unchanged", async () => {
        await ensureClientAndProject();
        const suffix = "overbill";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Overbill attempt",
                lines: [{ scheduleId: psId, description: "Deposit", amount: 600 }],
                amountMode: "preTax",
            }),
        ).rejects.toThrow(/exceeds the milestone/i);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(ps!.amount)).toBe(500); // unchanged
        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(0); // nothing created
    });

    test("bills a milestone in FULL: no split, one line, milestone stays Pending, invoice totals unchanged", async () => {
        await ensureClientAndProject();
        const suffix = "full";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Full deposit billing",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
            amountMode: "preTax",
        });

        expect(billing.lines.length).toBe(1);
        expect(billing.lines[0].scheduleId).toBe(psId);
        expect(num(billing.lines[0].amount)).toBe(500);
        expect(billing.status).toBe("Draft");
        expect(billing.code).toBe(`INV-PB-${suffix}-P1`);

        // No split: still exactly one PaymentSchedule row for this invoice, unchanged.
        const schedules = await prisma.paymentSchedule.findMany({ where: { invoiceId } });
        expect(schedules.length).toBe(1);
        expect(schedules[0].status).toBe("Pending");
        expect(num(schedules[0].amount)).toBe(500);

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(500);
        expect(num(invoice!.balanceDue)).toBe(500);
    });

    test("PARTIAL bill auto-splits the milestone and mirrors the estimate side; no row deleted", async () => {
        await ensureClientAndProject();
        const suffix = "partial";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const epsId = `${PFX}-eps-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB Estimate", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.estimatePaymentSchedule.create({
            data: { id: epsId, estimateId, name: "Progress 1", amount: 1000, status: "Pending", order: 2 },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 1000, balanceDue: 1000, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psId, invoiceId, name: "Progress 1", amount: 1000, status: "Pending", sourceScheduleId: epsId, dueDate: new Date("2026-03-01") },
        });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Partial progress billing",
            lines: [{ scheduleId: psId, description: "Progress 1 (partial)", amount: 400 }],
            amountMode: "preTax",
        });

        expect(billing.lines.length).toBe(1);
        expect(billing.lines[0].scheduleId).toBe(psId); // original (now-reduced) row, not the remainder
        expect(num(billing.lines[0].amount)).toBe(400);

        // Original invoice-side milestone reduced to the billed amount.
        const original = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(original).not.toBeNull(); // not deleted
        expect(num(original!.amount)).toBe(400);
        expect(original!.status).toBe("Pending");

        // A NEW remainder row absorbs the rest.
        const allSchedules = await prisma.paymentSchedule.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });
        expect(allSchedules.length).toBe(2); // nothing deleted, one new row
        const remainder = allSchedules.find((s) => s.id !== psId)!;
        expect(remainder.name).toBe("Progress 1 (remaining)");
        expect(remainder.status).toBe("Pending");
        expect(num(remainder.amount)).toBe(600);
        expect(remainder.dueDate?.toISOString()).toBe(new Date("2026-03-01").toISOString());
        // The two pieces sum to the original.
        expect(num(original!.amount) + num(remainder.amount)).toBe(1000);

        // Estimate-side mirror split the same way.
        const estOriginal = await prisma.estimatePaymentSchedule.findUnique({ where: { id: epsId } });
        expect(estOriginal).not.toBeNull(); // not deleted
        expect(num(estOriginal!.amount)).toBe(400);

        const allEst = await prisma.estimatePaymentSchedule.findMany({ where: { estimateId }, orderBy: { createdAt: "asc" } });
        expect(allEst.length).toBe(2); // nothing deleted, one new row
        const estRemainder = allEst.find((e) => e.id !== epsId)!;
        expect(estRemainder.name).toBe("Progress 1 (remaining)");
        expect(num(estRemainder.amount)).toBe(600);
        expect(estRemainder.order).toBe(2); // same order as the original
        expect(estRemainder.percentage).toBeNull();
        expect(num(estOriginal!.amount) + num(estRemainder.amount)).toBe(1000);

        // The new invoice-side remainder row points at the new estimate-side row.
        expect(remainder.sourceScheduleId).toBe(estRemainder.id);

        // Invoice totalAmount/balanceDue are untouched by a split.
        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(1000);
        expect(num(invoice!.balanceDue)).toBe(1000);
    });

    test('amountMode "preTax" math: subtotal + tax(8.8%) = total', async () => {
        await ensureClientAndProject();
        const suffix = "pretax";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 1000, balanceDue: 1000, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Progress", amount: 1000, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "PreTax billing",
            lines: [{ scheduleId: psId, description: "Progress", amount: 1000 }],
            amountMode: "preTax",
        });

        expect(num(billing.subtotal)).toBe(1000);
        expect(num(billing.taxAmount)).toBe(88); // round(1000 * 8.8 / 100)
        expect(num(billing.total)).toBe(1088);
        expect(num(billing.subtotal) + num(billing.taxAmount)).toBe(num(billing.total));
    });

    test("targetTotal + partial split on a LEGACY tax-inclusive job splits by the gross amount", async () => {
        // The live Mesplay case: a $25,000 check against a $39,998.25 milestone
        // whose amount already includes 8.8% tax. The milestone must be carved at
        // the GROSS $25,000 (leaving $14,998.25), while the billing line records
        // the PRE-TAX $22,977.94 for QuickBooks. Splitting by the pre-tax figure
        // instead would silently leave the client short by the tax.
        await ensureClientAndProject();
        const suffix = "legacy-split";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const epsId = `${PFX}-eps-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB Legacy", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 39998.25, balanceDue: 39998.25, taxInclusiveMilestones: true },
        });
        await prisma.estimatePaymentSchedule.create({
            data: { id: epsId, estimateId, name: "Mechanical Trades", amount: 39998.25, status: "Pending", order: 1 },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 39998.25, balanceDue: 39998.25, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psId, invoiceId, name: "Mechanical Trades", amount: 39998.25, status: "Pending", sourceScheduleId: epsId },
        });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Progress payment (check 1585)",
            lines: [{ scheduleId: psId, description: "Mechanical Trades", amount: 25000 }],
            amountMode: "targetTotal",
            targetTotal: 25000,
        });

        // Client pays exactly the check amount; tax is stated inside it.
        expect(num(billing.total)).toBe(25000);
        expect(num(billing.subtotal)).toBe(22977.94);
        expect(num(billing.taxAmount)).toBe(2022.06);
        expect(num(billing.lines[0].amount)).toBe(22977.94); // pre-tax, feeds QuickBooks

        // Milestone carved at the GROSS amount, remainder preserved, nothing lost.
        const billed = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(billed!.amount)).toBe(25000);
        const remainder = await prisma.paymentSchedule.findFirst({
            where: { invoiceId, name: { contains: "(remaining)" } },
        });
        expect(num(remainder!.amount)).toBe(14998.25);
        expect(num(billed!.amount) + num(remainder!.amount)).toBe(39998.25);

        // Estimate mirror split the same way, and the invoice totals never moved.
        const estOriginal = await prisma.estimatePaymentSchedule.findUnique({ where: { id: epsId } });
        expect(num(estOriginal!.amount)).toBe(25000);
        const estRemainder = await prisma.estimatePaymentSchedule.findFirst({
            where: { estimateId, name: { contains: "(remaining)" } },
        });
        expect(num(estRemainder!.amount)).toBe(14998.25);
        expect(remainder!.sourceScheduleId).toBe(estRemainder!.id);

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(39998.25);
        expect(num(invoice!.balanceDue)).toBe(39998.25);
    });

    test("targetTotal + partial split on a PRE-TAX job splits by the pre-tax amount", async () => {
        // Same shape, new-vintage estimate: milestone amounts exclude tax, so the
        // pre-tax line amount is what comes out of the milestone and tax rides on top.
        await ensureClientAndProject();
        const suffix = "pretax-split";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB PreTax", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 40000, balanceDue: 40000, taxInclusiveMilestones: false },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 40000, balanceDue: 40000, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Mechanical", amount: 40000, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Progress payment",
            lines: [{ scheduleId: psId, description: "Mechanical", amount: 25000 }],
            amountMode: "targetTotal",
            targetTotal: 25000,
        });

        expect(num(billing.total)).toBe(25000);
        expect(num(billing.subtotal)).toBe(22977.94);

        // Carved at the PRE-TAX amount this time.
        const billed = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(billed!.amount)).toBe(22977.94);
        const remainder = await prisma.paymentSchedule.findFirst({
            where: { invoiceId, name: { contains: "(remaining)" } },
        });
        expect(num(remainder!.amount)).toBe(17022.06);
        expect(num(billed!.amount) + num(remainder!.amount)).toBe(40000);
    });

    test('amountMode "targetTotal" with 33000 @ 8.8%: total is exactly 33000, subtotal+tax=total, lines sum to subtotal', async () => {
        await ensureClientAndProject();
        const suffix = "target";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psAId = `${PFX}-ps-a-${suffix}`;
        const psBId = `${PFX}-ps-b-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 33000, balanceDue: 33000, taxRate: 8.8 },
        });
        // Both lines bill the milestone in FULL (raw amount === milestone amount)
        // so no split occurs — this test isolates the targetTotal tax/rescale
        // math from the auto-split mechanic (covered separately above).
        await prisma.paymentSchedule.create({ data: { id: psAId, invoiceId, name: "Progress A", amount: 20000, status: "Pending" } });
        await prisma.paymentSchedule.create({ data: { id: psBId, invoiceId, name: "Progress B", amount: 13000, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Target total billing",
            lines: [
                { scheduleId: psAId, description: "Progress A", amount: 20000 },
                { scheduleId: psBId, description: "Progress B", amount: 13000 },
            ],
            amountMode: "targetTotal",
            targetTotal: 33000,
        });

        expect(num(billing.total)).toBe(33000);
        expect(num(billing.subtotal)).toBe(30330.88); // round(33000 / 1.088)
        expect(num(billing.taxAmount)).toBe(2669.12); // round(33000 - 30330.88)
        expect(num(billing.subtotal) + num(billing.taxAmount)).toBe(num(billing.total));

        const lineSum = billing.lines.reduce((s, l) => s + num(l.amount), 0);
        expect(Math.round(lineSum * 100) / 100).toBe(num(billing.subtotal));

        // No split occurred (both lines billed their milestone in full).
        const psA = await prisma.paymentSchedule.findUnique({ where: { id: psAId } });
        const psB = await prisma.paymentSchedule.findUnique({ where: { id: psBId } });
        expect(num(psA!.amount)).toBe(20000);
        expect(num(psB!.amount)).toBe(13000);
        const allSchedules = await prisma.paymentSchedule.findMany({ where: { invoiceId } });
        expect(allSchedules.length).toBe(2); // no remainder rows created
    });

    test("taxExempt: true forces taxRate 0 / taxAmount 0 / total === subtotal, overriding the invoice's rate", async () => {
        await ensureClientAndProject();
        const suffix = "exempt";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 750, balanceDue: 750, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Progress", amount: 750, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Exempt billing",
            lines: [{ scheduleId: psId, description: "Progress", amount: 750 }],
            amountMode: "preTax",
            taxExempt: true,
        });

        expect(billing.taxExempt).toBe(true);
        expect(num(billing.taxRate)).toBe(0);
        expect(num(billing.taxAmount)).toBe(0);
        expect(num(billing.total)).toBe(num(billing.subtotal));
        expect(num(billing.subtotal)).toBe(750);
    });

    test("rejects a milestone carrying a legacy qbInvoiceId with the Break-QB-Link message", async () => {
        await ensureClientAndProject();
        const suffix = "qblinked";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending", qbInvoiceId: "fake-qbo-legacy" },
        });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Should be rejected",
                lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
                amountMode: "preTax",
            }),
        ).rejects.toThrow(/break the quickbooks link/i);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(ps!.qbInvoiceId).toBe("fake-qbo-legacy"); // untouched
        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(0);
    });
});

test.describe.serial("updateProgressBillingCore / deleteProgressBillingCore", () => {
    test.afterAll(afterAllCleanup);

    async function createDraftBilling(suffix: string) {
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });
        const billing = await createProgressBillingCore(invoiceId, {
            description: "Original description",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
            amountMode: "preTax",
        });
        return { invoiceId, psId, billing };
    }

    test("draft-only guard rejects update/delete once a QuickBooks invoice is staged", async () => {
        await ensureClientAndProject();
        const { billing } = await createDraftBilling("guard");

        // Simulate a staged billing directly (no live QuickBooks in this test DB).
        await prisma.progressBilling.update({
            where: { id: billing.id },
            data: { status: "Staged", qbInvoiceId: "fake-qbo-staged" },
        });

        await expect(updateProgressBillingCore(billing.id, { description: "New description" })).rejects.toThrow(/only draft billings/i);
        await expect(deleteProgressBillingCore(billing.id)).rejects.toThrow(/only draft billings/i);

        const stillThere = await prisma.progressBilling.findUnique({ where: { id: billing.id } });
        expect(stillThere).not.toBeNull();
        expect(stillThere!.description).toBe("Original description"); // unchanged
    });

    test("updates description/taxExempt on a Draft billing and recomputes tax", async () => {
        await ensureClientAndProject();
        const suffix = "update";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Original description",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
            amountMode: "preTax",
        });
        expect(num(billing.taxAmount)).toBe(44); // round(500 * 8.8 / 100)

        const updated = await updateProgressBillingCore(billing.id, { description: "Revised description", taxExempt: true });
        expect(updated.description).toBe("Revised description");
        expect(updated.taxExempt).toBe(true);
        expect(num(updated.taxAmount)).toBe(0);
        expect(num(updated.total)).toBe(num(updated.subtotal));
    });

    test("delete leaves an already-applied split intact", async () => {
        await ensureClientAndProject();
        const suffix = "delete-split";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 1000, balanceDue: 1000, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Progress 1", amount: 1000, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Partial to be deleted",
            lines: [{ scheduleId: psId, description: "Progress 1 (partial)", amount: 350 }],
            amountMode: "preTax",
        });

        const beforeDelete = await prisma.paymentSchedule.findMany({ where: { invoiceId } });
        expect(beforeDelete.length).toBe(2); // split already applied

        const res = await deleteProgressBillingCore(billing.id);
        expect(res.success).toBe(true);

        const gone = await prisma.progressBilling.findUnique({ where: { id: billing.id } });
        expect(gone).toBeNull();
        const goneLines = await prisma.progressBillingLine.findMany({ where: { billingId: billing.id } });
        expect(goneLines.length).toBe(0);

        // The split's two milestone pieces are untouched by the delete.
        const afterDelete = await prisma.paymentSchedule.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });
        expect(afterDelete.length).toBe(2);
        expect(num(afterDelete[0].amount)).toBe(350);
        expect(afterDelete[0].status).toBe("Pending");
        expect(afterDelete[1].name).toBe("Progress 1 (remaining)");
        expect(num(afterDelete[1].amount)).toBe(650);
        expect(afterDelete[1].status).toBe("Pending");
    });
});

test.describe.serial("stageProgressBillingToQuickBooksCore (no live QuickBooks in this test DB)", () => {
    test.afterAll(afterAllCleanup);

    test("rejects with QuickBooks-not-connected; billing stays Draft with no qbInvoiceId", async () => {
        await ensureClientAndProject();
        const suffix = "stage";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });
        const billing = await createProgressBillingCore(invoiceId, {
            description: "Stage attempt",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
            amountMode: "preTax",
        });

        // No Integration row exists in this test DB → getFreshQBTokens() throws
        // before any QBO network call or DB write is attempted.
        await expect(stageProgressBillingToQuickBooksCore(billing.id)).rejects.toThrow(/quickbooks is not connected/i);

        const stillDraft = await prisma.progressBilling.findUnique({ where: { id: billing.id } });
        expect(stillDraft!.status).toBe("Draft");
        expect(stillDraft!.qbInvoiceId).toBeNull();
    });
});
