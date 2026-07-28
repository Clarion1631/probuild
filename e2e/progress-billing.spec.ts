import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import {
    createProgressBillingCore,
    updateProgressBillingCore,
    deleteProgressBillingCore,
    stageProgressBillingToQuickBooksCore,
} from "../src/lib/progress-billing";
import { settleProgressBillingPaidCore, pushMilestoneToQuickBooks } from "../src/lib/quickbooks-payments";

/**
 * Progress billing core regression net.
 *
 * Covers the session-free cores in src/lib/progress-billing.ts (+ the settle
 * helper in src/lib/quickbooks-payments.ts) directly against the throwaway CI
 * Postgres (same established pattern as e2e/milestone-rebalance.spec.ts —
 * actions.ts wrappers need a real Next.js request scope and come in the UI
 * pass).
 *
 * No live QuickBooks connection exists in this test DB (no Integration row),
 * so stageProgressBillingToQuickBooksCore's getFreshQBTokens() call always
 * throws QBNotConnectedError before any QBO network call or DB write — the
 * QBO staging test below asserts exactly that (rejection + DB unchanged),
 * never a live QBO call. settleProgressBillingPaidCore is exercised directly
 * (bypassing the QBO probe entirely) by simulating an already-Staged billing,
 * same pattern the "draft-only guard" test below uses.
 *
 * CONTRACT NOTE: `createProgressBillingCore` no longer takes `amountMode` /
 * `targetTotal` — every test below uses the current contract (`lines[].amount`
 * in the milestone's own units + optional `grossTotal`). Because the old
 * fields no longer exist, every test in this file already fails to even
 * *compile* against the pre-fix signature — on top of that, the tests in the
 * "consumption guard", "billing codes", and "rescale to zero" describe blocks
 * below exercise bugs that are independent of the contract change (the guard
 * simply didn't exist; the numbering was count-based) and would behave
 * incorrectly even if hand-adapted to the old contract.
 */

const prisma = new PrismaClient();
const PFX = "pb-e2e";
const num = (v: unknown) => Number(v);

async function afterAllCleanup() {
    try {
        await prisma.progressBillingLine.deleteMany({ where: { billing: { invoiceId: { startsWith: PFX } } } });
        await prisma.progressBilling.deleteMany({ where: { invoiceId: { startsWith: PFX } } });
        await prisma.paymentSchedule.deleteMany({ where: { invoiceId: { startsWith: PFX } } });
        await prisma.paymentSchedule.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.invoice.deleteMany({ where: { id: { startsWith: PFX } } });
        await prisma.changeOrder.deleteMany({ where: { id: { startsWith: PFX } } });
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

test.describe.serial("createProgressBillingCore — core cases", () => {
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
            }),
        ).rejects.toThrow(/exceeds/i);

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

    test("NEW-VINTAGE (pre-tax) job: subtotal + tax(8.8%) = total, from a pre-tax raw line amount", async () => {
        await ensureClientAndProject();
        const suffix = "pretax-taxmath";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB PreTax", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 1088, balanceDue: 1088, taxInclusiveMilestones: false },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 1088, balanceDue: 1088, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Progress", amount: 1000, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "PreTax billing",
            lines: [{ scheduleId: psId, description: "Progress", amount: 1000 }], // pre-tax: new-vintage units
        });

        expect(num(billing.subtotal)).toBe(1000);
        expect(num(billing.taxAmount)).toBe(88); // round(1000 * 8.8 / 100)
        expect(num(billing.total)).toBe(1088);
        expect(num(billing.subtotal) + num(billing.taxAmount)).toBe(num(billing.total));
    });

    test('LEGACY vintage, no grossTotal: split is GROSS and the remainder is correct (the $108/$100 case)', async () => {
        // The live Mesplay case: a $25,000 check against a $39,998.25 milestone
        // whose amount already includes 8.8% tax. Under the new contract the
        // line amount for a legacy milestone IS the gross amount the client is
        // paying — no amountMode/targetTotal needed. The milestone must be
        // carved at the GROSS $25,000 (leaving $14,998.25), while the billing
        // line records the PRE-TAX $22,977.94 for QuickBooks. Splitting by the
        // pre-tax figure instead (the pre-round-2 "$108 milestone billed '$100
        // preTax' actually charged $108 but left $8 owed" bug) would silently
        // leave the client short by the tax.
        await ensureClientAndProject();
        const suffix = "legacy-gross-mirror";
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
            lines: [{ scheduleId: psId, description: "Mechanical Trades", amount: 25000 }], // gross: legacy units, no grossTotal supplied
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

    test("NEW vintage split creates a real estimate-side mirror (sourceScheduleId + split remainder)", async () => {
        // Same shape, new-vintage estimate: milestone amounts exclude tax, so
        // the pre-tax line amount is what comes out of the milestone and tax
        // rides on top. Unlike a stale pre-round-2 test, this one wires up a
        // real EstimatePaymentSchedule + sourceScheduleId so the mirror split
        // is actually asserted, not just the invoice-side numbers.
        await ensureClientAndProject();
        const suffix = "pretax-mirror";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const epsId = `${PFX}-eps-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB PreTax Mirror", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 40000, balanceDue: 40000, taxInclusiveMilestones: false },
        });
        await prisma.estimatePaymentSchedule.create({
            data: { id: epsId, estimateId, name: "Mechanical", amount: 40000, status: "Pending", order: 1 },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 40000, balanceDue: 40000, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psId, invoiceId, name: "Mechanical", amount: 40000, status: "Pending", sourceScheduleId: epsId },
        });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Progress payment",
            lines: [{ scheduleId: psId, description: "Mechanical", amount: 25000 }], // pre-tax: new-vintage units
        });

        expect(num(billing.total)).toBe(27200); // round(25000 * 1.088)
        expect(num(billing.subtotal)).toBe(25000);
        expect(num(billing.taxAmount)).toBe(2200);

        // Carved at the PRE-TAX amount this time.
        const billed = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(billed!.amount)).toBe(25000);
        const remainder = await prisma.paymentSchedule.findFirst({
            where: { invoiceId, name: { contains: "(remaining)" } },
        });
        expect(num(remainder!.amount)).toBe(15000);
        expect(num(billed!.amount) + num(remainder!.amount)).toBe(40000);

        // The estimate-side mirror: original reduced, remainder created, linked.
        const estOriginal = await prisma.estimatePaymentSchedule.findUnique({ where: { id: epsId } });
        expect(num(estOriginal!.amount)).toBe(25000);
        const estRemainder = await prisma.estimatePaymentSchedule.findFirst({
            where: { estimateId, name: { contains: "(remaining)" } },
        });
        expect(estRemainder).not.toBeNull();
        expect(num(estRemainder!.amount)).toBe(15000);
        expect(remainder!.sourceScheduleId).toBe(estRemainder!.id);
    });

    test('unit-mismatch rejected: lines summing to $100 with grossTotal: 50 throws', async () => {
        await ensureClientAndProject();
        const suffix = "unit-mismatch";
        const invoiceId = `${PFX}-inv-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 0, balanceDue: 0, taxRate: 0 },
        });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Mismatched units",
                lines: [{ description: "Custom line", amount: 100 }],
                grossTotal: 50,
            }),
        ).rejects.toThrow(/they must match/i);

        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(0);
    });

    test('explicit grossTotal matching the lines: 33000 @ 8.8%, total is exactly 33000, subtotal+tax=total, lines sum to subtotal', async () => {
        await ensureClientAndProject();
        const suffix = "grosstotal-match";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psAId = `${PFX}-ps-a-${suffix}`;
        const psBId = `${PFX}-ps-b-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 33000, balanceDue: 33000, taxRate: 8.8 },
        });
        // Both lines bill the milestone in FULL (raw amount === milestone amount)
        // so no split occurs — this test isolates the grossTotal/tax math from
        // the auto-split mechanic (covered separately above).
        await prisma.paymentSchedule.create({ data: { id: psAId, invoiceId, name: "Progress A", amount: 20000, status: "Pending" } });
        await prisma.paymentSchedule.create({ data: { id: psBId, invoiceId, name: "Progress B", amount: 13000, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Target total billing",
            lines: [
                { scheduleId: psAId, description: "Progress A", amount: 20000 },
                { scheduleId: psBId, description: "Progress B", amount: 13000 },
            ],
            grossTotal: 33000,
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
            taxExempt: true,
        });

        expect(billing.taxExempt).toBe(true);
        // billing.taxRate always holds the invoice's REAL rate (item F.2) —
        // taxExempt only zeroes the tax/total computation, not the stored rate.
        expect(num(billing.taxRate)).toBe(8.8);
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
            }),
        ).rejects.toThrow(/break the quickbooks link/i);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(ps!.qbInvoiceId).toBe("fake-qbo-legacy"); // untouched
        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(0);
    });

    test("a rescaled line that would round to $0.00 is rejected", async () => {
        // Two custom lines, weights [0.01, 99.99]. A synthetic, unrealistically
        // high tax rate (999%) shrinks the pre-tax subtotal far enough below
        // the raw total that the tiny line's proportional share of the
        // subtotal rounds to $0.00 — exactly the case the "every persisted
        // line amount must be > 0" guard exists for.
        await ensureClientAndProject();
        const suffix = "rescale-zero";
        const invoiceId = `${PFX}-inv-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 0, balanceDue: 0, taxRate: 999 },
        });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Rounds to zero",
                lines: [
                    { description: "Tiny", amount: 0.01 },
                    { description: "Big", amount: 99.99 },
                ],
            }),
        ).rejects.toThrow(/\$0\.00 or less/i);

        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(0);
    });
});

test.describe.serial("createProgressBillingCore — consumption guard", () => {
    test.afterAll(afterAllCleanup);

    test("double-billing rejected: bill a milestone in FULL, then a second billing referencing the same milestone throws", async () => {
        // A full bill never triggers AUTO-SPLIT, so the milestone's `amount`
        // stays unchanged after billing #1 — without the consumption guard, a
        // second billing referencing the same still-Pending row would be
        // allowed to bill it again for up to that same (unchanged) amount.
        await ensureClientAndProject();
        const suffix = "double-full";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });

        await createProgressBillingCore(invoiceId, {
            description: "First billing",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
        });

        // The milestone is still "Pending" with amount unchanged (no split
        // occurred) — a second reference must be rejected as already-committed.
        const afterFirst = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(afterFirst!.status).toBe("Pending");
        expect(num(afterFirst!.amount)).toBe(500);

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Second billing (double bill)",
                lines: [{ scheduleId: psId, description: "Deposit again", amount: 500 }],
            }),
        ).rejects.toThrow(/already billed/i);

        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(1); // only the first one exists
    });

    test("rejects re-billing a milestone's already-consumed original row after a partial split", async () => {
        // Bill $400 of a $1,000 milestone (partial split: original reduced to
        // 400, a new $600 remainder row created — see the PARTIAL-bill test
        // above). A second billing referencing the SAME (now-$400) original
        // row for $300 would pass the plain "does this exceed the row's
        // current amount" check (300 <= 400) — that's the residual double-dip
        // bug the consumption guard closes: the original row's whole current
        // amount was already committed by the first billing, so nothing is
        // left to bill against it (available = 400 - 400 = 0).
        //
        // (The task's own illustrative "$700 against the same milestone"
        // number is NOT used here: $700 already exceeds the reduced row's
        // amount (400) under the OLD plain over-bill check too, so it would
        // throw for an unrelated reason and wouldn't demonstrate this guard.)
        await ensureClientAndProject();
        const suffix = "double-partial";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 1000, balanceDue: 1000, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Progress 1", amount: 1000, status: "Pending" } });

        await createProgressBillingCore(invoiceId, {
            description: "Partial billing",
            lines: [{ scheduleId: psId, description: "Progress 1 (partial)", amount: 400 }],
        });

        const afterSplit = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(afterSplit!.amount)).toBe(400); // reduced to the billed portion

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Re-bill the already-consumed original row",
                lines: [{ scheduleId: psId, description: "Progress 1 (again)", amount: 300 }],
            }),
        ).rejects.toThrow(/already billed/i);

        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(1); // only the first one exists

        // The legitimate remainder ($600) is untouched and still billable —
        // proves the guard is scoped to the specific committed row, not the
        // whole milestone family.
        const remainder = await prisma.paymentSchedule.findFirst({ where: { invoiceId, name: { contains: "(remaining)" } } });
        expect(num(remainder!.amount)).toBe(600);
    });

    test("a changeOrderId line is rejected — change orders bill through approval, not progress billing", async () => {
        // billChangeOrderCore (src/lib/billing-core.ts) already bills an
        // approved change order by adding a normal PaymentSchedule milestone
        // to the invoice (handleChangeOrderApproved calls it on approval).
        // Letting a progress-billing line ALSO reference a changeOrderId would
        // be a second rail for the same money, so it's rejected outright.
        await ensureClientAndProject();
        const suffix = "co-rejected";
        const invoiceId = `${PFX}-inv-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 0, balanceDue: 0, taxRate: 0 },
        });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "CO line attempt",
                // `changeOrderId` is no longer part of the typed contract — cast
                // to simulate a caller (e.g. stale UI code) still sending one.
                lines: [{ description: "Extra tile work", amount: 500, changeOrderId: `${PFX}-co-fake` } as never],
            }),
        ).rejects.toThrow(/billed by approving them/i);

        const billings = await prisma.progressBilling.findMany({ where: { invoiceId } });
        expect(billings.length).toBe(0);
        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(0); // no phantom growth from the rejected line
    });
});

test.describe.serial("createProgressBillingCore — custom lines", () => {
    test.afterAll(afterAllCleanup);

    test("a custom line materializes a Pending milestone and raises the invoice total", async () => {
        await ensureClientAndProject();
        const suffix = "materialize";
        const invoiceId = `${PFX}-inv-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 0, balanceDue: 0, taxRate: 0 },
        });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Extras billing",
            lines: [{ description: "Extra demo work", amount: 250 }], // custom — no scheduleId
        });

        expect(billing.lines.length).toBe(1);
        const customLine = billing.lines[0];
        expect(customLine.scheduleId).not.toBeNull();

        const customSchedule = await prisma.paymentSchedule.findUnique({ where: { id: customLine.scheduleId! } });
        expect(customSchedule!.name).toBe("Extra demo work");
        expect(num(customSchedule!.amount)).toBe(250);
        expect(customSchedule!.status).toBe("Pending");
        expect(customSchedule!.sourceScheduleId).toBeNull();

        // Milestone-referencing lines never move invoice totals — but this is
        // a custom line, so the invoice grows by exactly what was added.
        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.totalAmount)).toBe(250);
        expect(num(invoice!.balanceDue)).toBe(250);
    });
});

test.describe.serial("createProgressBillingCore — billing codes", () => {
    test.afterAll(afterAllCleanup);

    test("billing codes do not repeat after deleting a middle draft", async () => {
        await ensureClientAndProject();
        const suffix = "codes-reuse";
        const invoiceId = `${PFX}-inv-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 0, balanceDue: 0, taxRate: 0 },
        });

        const b1 = await createProgressBillingCore(invoiceId, { description: "First", lines: [{ description: "Line A", amount: 100 }] });
        const b2 = await createProgressBillingCore(invoiceId, { description: "Second", lines: [{ description: "Line B", amount: 100 }] });
        expect(b1.code).toBe(`INV-PB-${suffix}-P1`);
        expect(b2.code).toBe(`INV-PB-${suffix}-P2`);

        await deleteProgressBillingCore(b1.id); // delete the middle/first draft, leaving only b2

        const b3 = await createProgressBillingCore(invoiceId, { description: "Third", lines: [{ description: "Line C", amount: 100 }] });

        // Count-based numbering (pre-fix) would see 1 remaining billing and
        // generate "-P2" again, colliding with b2's existing code.
        expect(b3.code).toBe(`INV-PB-${suffix}-P3`);
        expect(b3.code).not.toBe(b2.code);
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

    test("updates the description on a Draft billing; money is untouched", async () => {
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
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }], // gross (legacy, no estimate)
        });
        expect(num(billing.subtotal)).toBe(459.56); // round(500 / 1.088)
        expect(num(billing.taxAmount)).toBe(40.44); // round(500 - 459.56)
        expect(num(billing.taxRate)).toBe(8.8); // real rate stored even though not exempt

        const updated = await updateProgressBillingCore(billing.id, { description: "Revised description" });
        expect(updated.description).toBe("Revised description");
        expect(num(updated.subtotal)).toBe(459.56);
        expect(num(updated.taxAmount)).toBe(40.44);
        expect(num(updated.total)).toBe(500);
    });

    test("refuses to flip taxExempt on an existing draft (would desync QuickBooks from the milestone)", async () => {
        // Round-2 blocker: un-exempting recomputed the billing's total ($500 →
        // $544) while the milestone it carved stayed at $500, so QuickBooks would
        // charge $544 and settlement would only ever credit $500.
        await ensureClientAndProject();
        const suffix = "update-exempt";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Exempt billing",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
            taxExempt: true,
        });
        expect(billing.taxExempt).toBe(true);
        expect(num(billing.total)).toBe(500);

        await expect(
            updateProgressBillingCore(billing.id, { taxExempt: false }),
        ).rejects.toThrow(/delete this draft/i);

        // Nothing moved.
        const after = await prisma.progressBilling.findUnique({ where: { id: billing.id } });
        expect(after!.taxExempt).toBe(true);
        expect(num(after!.total)).toBe(500);
        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(ps!.amount)).toBe(500);
    });

    test("records splitAmount per line so a fully-billed milestone can't be re-billed for a rounding cent", async () => {
        // Round-2 blocker: the guard rebuilt gross from the rounded pre-tax amount
        // ($1.05 → $0.96 → $1.04) and left a cent claimable on a milestone that
        // was already billed in full.
        await ensureClientAndProject();
        const suffix = "cent";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psA = `${PFX}-ps-a-${suffix}`;
        const psB = `${PFX}-ps-b-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 2.05, balanceDue: 2.05, taxRate: 8.8 },
        });
        await prisma.paymentSchedule.create({ data: { id: psA, invoiceId, name: "Tiny A", amount: 1.0, status: "Pending" } });
        await prisma.paymentSchedule.create({ data: { id: psB, invoiceId, name: "Tiny B", amount: 1.05, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Two tiny lines",
            lines: [
                { scheduleId: psA, description: "Tiny A", amount: 1.0 },
                { scheduleId: psB, description: "Tiny B", amount: 1.05 },
            ],
        });

        // splitAmount is stored in milestone (gross) units, exactly as billed.
        const lineB = billing.lines.find((l) => l.scheduleId === psB)!;
        expect(num(lineB.splitAmount)).toBe(1.05);

        // Both milestones are fully consumed — no cent left to claim.
        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Sneak a cent",
                lines: [{ scheduleId: psB, description: "Tiny B again", amount: 0.01 }],
            }),
        ).rejects.toThrow(/already billed/i);
    });

    test("refuses to bill a milestone whose estimate mirror row no longer exists — even on a FULL bill", async () => {
        // The mirror check used to sit behind the full-bill early exit, so a full
        // bill skipped it entirely and its settle-time mirror would later no-op,
        // leaving the estimate showing the milestone still owed.
        await ensureClientAndProject();
        const suffix = "dangling-full";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB Dangling Full", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 1000, balanceDue: 1000, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({
            data: { id: psId, invoiceId, name: "Orphaned mirror", amount: 1000, status: "Pending", sourceScheduleId: `${PFX}-eps-gone-${suffix}` },
        });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Full bill against a dangling mirror",
                lines: [{ scheduleId: psId, description: "Orphaned mirror", amount: 1000 }], // FULL
            }),
        ).rejects.toThrow(/no longer exists/i);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(ps!.amount)).toBe(1000); // untouched
    });

    test("legacy per-milestone QuickBooks staging refuses a milestone already claimed by a progress billing", async () => {
        // Closes the double-collection hole: a FULL bill leaves the milestone
        // Pending and unlinked, which is exactly the state pushMilestoneToQuickBooks
        // otherwise accepts — it would create a SECOND collectible QBO invoice for
        // money a progress billing already covers.
        await ensureClientAndProject();
        const suffix = "legacy-guard";
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 500, balanceDue: 500, taxRate: 0 },
        });
        await prisma.paymentSchedule.create({ data: { id: psId, invoiceId, name: "Deposit", amount: 500, status: "Pending" } });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Covers the deposit",
            lines: [{ scheduleId: psId, description: "Deposit", amount: 500 }],
        });

        // The milestone is deliberately still Pending + unlinked after a full bill.
        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(ps!.status).toBe("Pending");
        expect(ps!.qbInvoiceId).toBeNull();

        // The legacy rail must refuse it, naming the billing that owns it. This
        // throws before any QuickBooks call, so it holds even with no QBO connection.
        await expect(pushMilestoneToQuickBooks(psId)).rejects.toThrow(
            new RegExp(`already covered by progress invoice ${billing.code}`, "i"),
        );
    });

    test("refuses to bill a milestone whose estimate mirror row no longer exists", async () => {
        await ensureClientAndProject();
        const suffix = "dangling";
        const estimateId = `${PFX}-est-${suffix}`;
        const invoiceId = `${PFX}-inv-${suffix}`;
        const psId = `${PFX}-ps-${suffix}`;

        await prisma.estimate.create({
            data: { id: estimateId, title: "PB Dangling", code: `EST-PB-${suffix}`, projectId: `${PFX}-project`, status: "Approved", totalAmount: 1000, balanceDue: 1000 },
        });
        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, estimateId, status: "Issued", totalAmount: 1000, balanceDue: 1000, taxRate: 0 },
        });
        // sourceScheduleId is not an FK — point it at a row that does not exist.
        await prisma.paymentSchedule.create({
            data: { id: psId, invoiceId, name: "Orphaned mirror", amount: 1000, status: "Pending", sourceScheduleId: `${PFX}-eps-gone-${suffix}` },
        });

        await expect(
            createProgressBillingCore(invoiceId, {
                description: "Partial against a dangling mirror",
                lines: [{ scheduleId: psId, description: "Orphaned mirror", amount: 400 }],
            }),
        ).rejects.toThrow(/no longer exists/i);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: psId } });
        expect(num(ps!.amount)).toBe(1000); // untouched
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
        });

        // No Integration row exists in this test DB → getFreshQBTokens() throws
        // before any QBO network call or DB write is attempted.
        await expect(stageProgressBillingToQuickBooksCore(billing.id)).rejects.toThrow(/quickbooks is not connected/i);

        const stillDraft = await prisma.progressBilling.findUnique({ where: { id: billing.id } });
        expect(stillDraft!.status).toBe("Draft");
        expect(stillDraft!.qbInvoiceId).toBeNull();
    });
});

test.describe.serial("settleProgressBillingPaidCore", () => {
    test.afterAll(afterAllCleanup);

    test("settling a custom-only billing reduces invoice.balanceDue and marks its materialized milestone Paid", async () => {
        // Drives the settle helper directly against a simulated Staged billing
        // (no live QuickBooks connection in this test DB — same pattern as the
        // "draft-only guard" test above). Proves that a custom line's
        // materialized PaymentSchedule (see the "materialize" describe block)
        // settles through the exact same rail as any other milestone, with no
        // special case.
        await ensureClientAndProject();
        const suffix = "settle";
        const invoiceId = `${PFX}-inv-${suffix}`;

        await prisma.invoice.create({
            data: { id: invoiceId, code: `INV-PB-${suffix}`, projectId: `${PFX}-project`, clientId: `${PFX}-client`, status: "Issued", totalAmount: 0, balanceDue: 0, taxRate: 0 },
        });

        const billing = await createProgressBillingCore(invoiceId, {
            description: "Custom-only billing",
            lines: [{ description: "Deposit (custom)", amount: 500 }],
        });

        const afterCreate = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(afterCreate!.totalAmount)).toBe(500);
        expect(num(afterCreate!.balanceDue)).toBe(500);

        const scheduleId = billing.lines[0].scheduleId!;
        expect(scheduleId).toBeTruthy();

        // Simulate staging (no live QuickBooks in this test DB).
        await prisma.progressBilling.update({
            where: { id: billing.id },
            data: { status: "Staged", qbInvoiceId: "fake-qbo-settle" },
        });

        const settled = await settleProgressBillingPaidCore(billing.id, {
            paidAt: new Date("2026-07-27"),
            referenceNumber: "REF-1",
            qbPaymentId: "fake-payment-1",
        });
        expect(settled).toBe(true);

        const billingAfter = await prisma.progressBilling.findUnique({ where: { id: billing.id } });
        expect(billingAfter!.status).toBe("Paid");
        expect(billingAfter!.qbPaymentId).toBe("fake-payment-1");

        const schedule = await prisma.paymentSchedule.findUnique({ where: { id: scheduleId } });
        expect(schedule!.status).toBe("Paid");
        expect(schedule!.paymentMethod).toBe("quickbooks");
        expect(schedule!.referenceNumber).toBe("REF-1");

        const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        expect(num(invoice!.balanceDue)).toBe(0);
        expect(invoice!.status).toBe("Paid");

        // Idempotent: settling again (e.g. a re-run poller) is a no-op.
        const settledAgain = await settleProgressBillingPaidCore(billing.id, {
            paidAt: new Date(),
            referenceNumber: "REF-2",
            qbPaymentId: "fake-payment-2",
        });
        expect(settledAgain).toBe(false);
    });
});
