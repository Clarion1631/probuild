import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { reconcileMilestoneToQbo } from "../src/lib/quickbooks-payments";
import {
    syncQboExpenses,
    upsertQboExpense,
    type QboExpensePersistenceClient,
    type QboExpenseSyncDependencies,
} from "../src/lib/qbo-expense-sync";

/**
 * Deterministic, DB-level coverage for reconcileMilestoneToQbo — the QBO→ProBuild
 * drift reconcile writer behind "Reconcile & Send". No live QuickBooks is needed:
 * we call the writer directly against the throwaway CI Postgres (data.setup.ts
 * guards prod) and assert the invoice-side milestone, the parent invoice totals,
 * and the mirrored estimate copy all land where they should.
 *
 * The project has no unit-test runner (Playwright only), so this lives as an
 * e2e spec that imports the server function directly — same pattern as
 * money-pipeline.spec.ts using PrismaClient against the test DB.
 */

const prisma = new PrismaClient();
const PFX = "rq-e2e";

type SeedOpts = {
    suffix: string;
    depositAmount?: number;
    finalAmount?: number;
    taxRate?: number;
    depositPaid?: boolean;
    linkDeposit?: boolean; // set the invoice deposit's sourceScheduleId to the estimate copy
};

// Seed a client+project+estimate+invoice with a linked deposit/final milestone pair.
// Returns the invoice-side deposit milestone id (the reconcile target).
async function seedLinked(opts: SeedOpts) {
    const {
        suffix,
        depositAmount = 600,
        finalAmount = 400,
        taxRate = 0,
        depositPaid = false,
        linkDeposit = true,
    } = opts;
    const total = depositAmount + finalAmount;
    const id = (k: string) => `${PFX}-${k}-${suffix}`;

    await prisma.client.upsert({
        where: { id: `${PFX}-client` },
        update: {},
        create: { id: `${PFX}-client`, name: "RQ Client", initials: "RQ" },
    });
    await prisma.project.upsert({
        where: { id: `${PFX}-project` },
        update: {},
        create: { id: `${PFX}-project`, name: "RQ Project", clientId: `${PFX}-client` },
    });

    await prisma.estimate.create({
        data: {
            id: id("est"),
            title: "RQ Estimate",
            code: `EST-RQ-${suffix}`,
            projectId: `${PFX}-project`,
            status: "Sent",
            taxExempt: taxRate <= 0,
            taxRatePercent: taxRate > 0 ? taxRate : null,
            totalAmount: total,
            balanceDue: total,
        },
    });
    await prisma.estimatePaymentSchedule.create({
        data: { id: id("eps-dep"), estimateId: id("est"), name: "RQ Deposit", amount: depositAmount, status: "Pending", order: 1 },
    });
    await prisma.estimatePaymentSchedule.create({
        data: { id: id("eps-fin"), estimateId: id("est"), name: "RQ Final", amount: finalAmount, status: "Pending", order: 2 },
    });

    const paid = depositPaid ? depositAmount : 0;
    await prisma.invoice.create({
        data: {
            id: id("inv"),
            code: `INV-RQ-${suffix}`,
            projectId: `${PFX}-project`,
            clientId: `${PFX}-client`,
            estimateId: id("est"),
            status: depositPaid ? "Partially Paid" : "Issued",
            taxRate,
            totalAmount: total,
            balanceDue: total - paid,
        },
    });
    await prisma.paymentSchedule.create({
        data: {
            id: id("ps-dep"),
            invoiceId: id("inv"),
            name: "RQ Deposit",
            amount: depositAmount,
            status: depositPaid ? "Paid" : "Pending",
            sourceScheduleId: linkDeposit ? id("eps-dep") : null,
        },
    });
    await prisma.paymentSchedule.create({
        data: {
            id: id("ps-fin"),
            invoiceId: id("inv"),
            name: "RQ Final",
            amount: finalAmount,
            status: "Pending",
            sourceScheduleId: id("eps-fin"),
        },
    });
    return { depositPsId: id("ps-dep"), depositEpsId: id("eps-dep"), invoiceId: id("inv"), estimateId: id("est") };
}

const num = (v: unknown) => Number(v);

test.describe.serial("reconcileMilestoneToQbo", () => {
    test.afterAll(async () => {
        try {
            await prisma.expense.deleteMany({ where: { qbPurchaseId: { startsWith: `${PFX}-qbo-` } } });
            await prisma.paymentSchedule.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.invoice.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.estimatePaymentSchedule.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.estimate.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.project.deleteMany({ where: { id: { startsWith: PFX } } });
            await prisma.client.deleteMany({ where: { id: { startsWith: PFX } } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("higher QBO total (600→648): invoice + estimate both move up", async () => {
        const s = await seedLinked({ suffix: "higher" });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(res.ok).toBe(true);
        expect(res.estimateTouched).toBe(true);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
        const eps = await prisma.estimatePaymentSchedule.findUnique({ where: { id: s.depositEpsId } });
        const est = await prisma.estimate.findUnique({ where: { id: s.estimateId } });

        expect(num(ps!.amount)).toBe(648);
        expect(num(inv!.totalAmount)).toBe(1048);
        expect(num(inv!.balanceDue)).toBe(1048); // nothing paid
        expect(num(eps!.amount)).toBe(648);
        expect(num(est!.totalAmount)).toBe(1048);
        expect(num(est!.balanceDue)).toBe(1048);
    });

    test("lower QBO total (600→550, discount): symmetric move down", async () => {
        const s = await seedLinked({ suffix: "lower" });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 550);
        expect(res.ok).toBe(true);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
        const eps = await prisma.estimatePaymentSchedule.findUnique({ where: { id: s.depositEpsId } });
        const est = await prisma.estimate.findUnique({ where: { id: s.estimateId } });

        expect(num(ps!.amount)).toBe(550);
        expect(num(inv!.totalAmount)).toBe(950);
        expect(num(eps!.amount)).toBe(550);
        expect(num(est!.totalAmount)).toBe(950);
    });

    test("tax-inclusive invoice (rate 8): subtotal + tax reconcile to the new total", async () => {
        const s = await seedLinked({ suffix: "tax", taxRate: 8 });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(res.ok).toBe(true);

        const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
        expect(num(inv!.totalAmount)).toBe(1048);
        // deriveInvoiceTaxFields(1048, 8): tax = round(1048*8/108) = 77.63, subtotal = 970.37
        expect(num(inv!.taxAmount)).toBeCloseTo(77.63, 2);
        expect(num(inv!.subtotal)).toBeCloseTo(970.37, 2);
        expect(num(inv!.subtotal) + num(inv!.taxAmount)).toBeCloseTo(1048, 2);
    });

    test("paid milestone is refused (ok:false) and nothing is written", async () => {
        const s = await seedLinked({ suffix: "paid", depositPaid: true });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(res.ok).toBe(false);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
        expect(num(ps!.amount)).toBe(600); // unchanged
        expect(num(inv!.totalAmount)).toBe(1000); // unchanged
    });

    test("refuses a $0 / voided QBO total (ok:false, no writes)", async () => {
        const s = await seedLinked({ suffix: "zero" });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 0);
        expect(res.ok).toBe(false);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
        expect(num(ps!.amount)).toBe(600); // unchanged
        expect(num(inv!.totalAmount)).toBe(1000); // unchanged
    });

    test("mirror fallback: no sourceScheduleId, single name+amount match → mirrors", async () => {
        const s = await seedLinked({ suffix: "fallback1", linkDeposit: false });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(res.ok).toBe(true);
        expect(res.estimateTouched).toBe(true);

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        const eps = await prisma.estimatePaymentSchedule.findUnique({ where: { id: s.depositEpsId } });
        expect(num(ps!.amount)).toBe(648);
        expect(num(eps!.amount)).toBe(648); // matched via name "RQ Deposit" + old amount 600
    });

    test("mirror fallback: ambiguous match (2 candidates) → invoice reconciles, estimate untouched", async () => {
        const s = await seedLinked({ suffix: "fallback2", linkDeposit: false });
        // Add a SECOND unpaid estimate milestone with the same name + amount → ambiguous.
        await prisma.estimatePaymentSchedule.create({
            data: { id: `${PFX}-eps-dup-fallback2`, estimateId: s.estimateId, name: "RQ Deposit", amount: 600, status: "Pending", order: 3 },
        });
        const res = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(res.ok).toBe(true);
        expect(res.estimateTouched).toBe(false); // conservative: don't guess between 2 candidates

        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        const eps1 = await prisma.estimatePaymentSchedule.findUnique({ where: { id: s.depositEpsId } });
        const eps2 = await prisma.estimatePaymentSchedule.findUnique({ where: { id: `${PFX}-eps-dup-fallback2` } });
        expect(num(ps!.amount)).toBe(648); // invoice still reconciled
        expect(num(eps1!.amount)).toBe(600); // both estimate copies untouched
        expect(num(eps2!.amount)).toBe(600);
    });

    test("idempotent: re-running with the same QBO total is a no-op", async () => {
        const s = await seedLinked({ suffix: "idem" });
        const first = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(first.ok).toBe(true);
        const second = await reconcileMilestoneToQbo(s.depositPsId, 648);
        expect(second.ok).toBe(true);

        const inv = await prisma.invoice.findUnique({ where: { id: s.invoiceId } });
        const ps = await prisma.paymentSchedule.findUnique({ where: { id: s.depositPsId } });
        expect(num(ps!.amount)).toBe(648); // not doubled
        expect(num(inv!.totalAmount)).toBe(1048); // not 1096
    });

    test("an imported finalized QBO expense is auditable on the linked active job", async ({ page }) => {
        test.setTimeout(60_000);
        const seeded = await seedLinked({ suffix: "qbo-expense-ui" });
        const project = await prisma.project.findUniqueOrThrow({
            where: { id: `${PFX}-project` },
            select: {
                id: true,
                name: true,
                status: true,
                estimates: {
                    where: { archivedAt: null },
                    select: { id: true, createdAt: true },
                },
            },
        });
        const dependencies: QboExpenseSyncDependencies = {
            getTokens: async () => ({
                accessToken: "e2e-access",
                refreshToken: "e2e-refresh",
                realmId: "e2e-realm",
            }),
            readPurchases: async () => ({
                purchases: [{
                    qbPurchaseId: `${PFX}-qbo-purchase-ui`,
                    syncToken: "0",
                    txnDate: "2026-07-21",
                    total: 321.45,
                    vendor: "QBO UI Vendor",
                    customerName: project.name,
                    customerId: null,
                    accountName: "Washington Trust Checking",
                    memo: "QBO UI materials",
                }],
                skipped: [],
                removed: [],
                deactivations: [],
            }),
            listProjects: async () => [{
                ...project,
                qbCustomerId: null,
            }],
            upsertExpense: write =>
                upsertQboExpense(
                    prisma as unknown as QboExpensePersistenceClient,
                    write,
                ),
            deactivateExpense: async () => "unchanged",
            now: () => new Date("2026-07-29T12:00:00.000Z"),
        };

        const result = await syncQboExpenses(
            { since: new Date("2026-01-01T00:00:00.000Z") },
            dependencies,
        );
        expect(result).toEqual({ imported: 1, updated: 0, removed: 0, skipped: [] });

        await page.goto(`/projects/${PFX}-project/time-expenses`);
        await page.getByRole("button", { name: /Expenses \(/ }).click();

        const row = page.getByRole("row").filter({ hasText: "QBO UI Vendor" });
        await expect(row).toContainText("QBO UI Vendor");
        await expect(row).toContainText("$321.45");
        await expect(row).toContainText("7/21/2026");
        await expect(row).toContainText("QuickBooks import");
        await expect(row).toContainText("Finalized in QuickBooks");
        await expect(row.getByRole("checkbox")).toBeDisabled();

        // Keep the value referenced so the seed helper's linked estimate/invoice
        // remains part of this test's setup and standard teardown path.
        expect(seeded.estimateId).toContain("qbo-expense-ui");
    });
});
