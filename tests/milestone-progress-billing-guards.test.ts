/**
 * A ProgressBillingLine points at its milestone by `scheduleId` — a plain
 * column, no FK (see prisma/schema.prisma) — and settlement pays that
 * milestone at its own amount. Before this guard, the three milestone
 * writers (`deleteInvoiceMilestoneCore`, `splitInvoiceMilestonesCore`,
 * `updatePendingMilestoneAmountsCore`) had no idea a progress billing existed
 * and could delete, blanket-replace or re-amount a milestone a Draft/Staged/
 * Sent billing already claims — orphaning the line or making the billing
 * settle a number nobody agreed to.
 *
 * These tests drive the real cores (no database: src/lib/prisma.ts reads
 * globalThis.prisma before it builds a client, same mechanism as
 * tests/qbo-parked-row-guards.test.ts) against a fake `progressBillingLine`
 * table that evaluates the guard's actual `where` clause rather than
 * returning canned per-test answers.
 */

import test from "node:test";
import assert from "node:assert/strict";

/** Run `fn` with globalThis.prisma swapped for a fake. */
async function withFakePrisma<T>(fake: any, fn: () => Promise<T>): Promise<T> {
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = fake;
    try {
        return await fn();
    } finally {
        (globalThis as any).prisma = previous;
    }
}

/** A Pending, otherwise-clean PaymentSchedule row — override what a test needs. */
function cleanSchedule(overrides: Record<string, unknown> = {}) {
    return {
        id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending",
        amount: 300, dueDate: null, sourceScheduleId: null, qbInvoiceId: null,
        qbSyncError: null, stripeSessionId: null, stripePaymentIntentId: null,
        ...overrides,
    };
}

type FakeLine = { scheduleId: string; billing: { code: string; status: string } };

/**
 * The fake `tx.progressBillingLine.findFirst`: evaluates the guard's actual
 * where clause (scheduleId in the given list, billing status not Void)
 * against an in-memory lines table, instead of returning a fixed answer.
 */
function fakeProgressBillingLineFindFirst(lines: FakeLine[]) {
    return async (args: any) => {
        const ids: string[] = args.where.scheduleId.in;
        const hit = lines.find((l) => ids.includes(l.scheduleId) && l.billing.status !== "Void");
        if (!hit) return null;
        return { scheduleId: hit.scheduleId, billing: { code: hit.billing.code, status: hit.billing.status } };
    };
}

// --- deleteInvoiceMilestoneCore ---------------------------------------------

test("delete: a milestone covered by a Staged progress billing is refused", async () => {
    const { deleteInvoiceMilestoneCore } = await import("../src/lib/billing-core");
    const row = cleanSchedule();
    let deleteManyCalled = false;
    let invoiceUpdateCalled = false;
    const tx = {
        paymentSchedule: {
            async findUnique() { return { ...row }; },
            async deleteMany() { deleteManyCalled = true; return { count: 1 }; },
        },
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update() { invoiceUpdateCalled = true; return {}; },
        },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-1", billing: { code: "INV-1-P1", status: "Staged" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => deleteInvoiceMilestoneCore("ps-1"),
            /"Rough-in" is on progress invoice INV-1-P1 \(Staged\)/,
        );
    });
    assert.equal(deleteManyCalled, false, "the CAS delete must not run");
    assert.equal(invoiceUpdateCalled, false, "the invoice must not be recomputed");
});

test("delete: a milestone covered by a Sent progress billing is refused", async () => {
    const { deleteInvoiceMilestoneCore } = await import("../src/lib/billing-core");
    const row = cleanSchedule();
    let deleteManyCalled = false;
    const tx = {
        paymentSchedule: {
            async findUnique() { return { ...row }; },
            async deleteMany() { deleteManyCalled = true; return { count: 1 }; },
        },
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update() { throw new Error("must not recompute the invoice"); },
        },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-1", billing: { code: "INV-1-P1", status: "Sent" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => deleteInvoiceMilestoneCore("ps-1"),
            /"Rough-in" is on progress invoice INV-1-P1 \(Sent\)/,
        );
    });
    assert.equal(deleteManyCalled, false);
});

test("delete: a milestone covered by a Draft progress billing is refused", async () => {
    const { deleteInvoiceMilestoneCore } = await import("../src/lib/billing-core");
    const row = cleanSchedule();
    let deleteManyCalled = false;
    const tx = {
        paymentSchedule: {
            async findUnique() { return { ...row }; },
            async deleteMany() { deleteManyCalled = true; return { count: 1 }; },
        },
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update() { throw new Error("must not recompute the invoice"); },
        },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-1", billing: { code: "INV-1-P1", status: "Draft" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => deleteInvoiceMilestoneCore("ps-1"),
            /"Rough-in" is on progress invoice INV-1-P1 \(Draft\)/,
        );
    });
    assert.equal(deleteManyCalled, false, "Draft counts as covered — it is staged later with the lines it already has");
});

test("delete: a milestone referenced only by a Void billing succeeds", async () => {
    const { deleteInvoiceMilestoneCore } = await import("../src/lib/billing-core");
    const row = cleanSchedule();
    let deleteManyCalled = false;
    let invoiceUpdateArgs: any = null;
    const tx = {
        paymentSchedule: {
            async findUnique() { return { ...row }; },
            async deleteMany() { deleteManyCalled = true; return { count: 1 }; },
        },
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update(args: any) { invoiceUpdateArgs = args; return {}; },
        },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-1", billing: { code: "INV-1-P1", status: "Void" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    const result = await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, () => deleteInvoiceMilestoneCore("ps-1"));

    assert.equal(deleteManyCalled, true, "a Void-only reference must not block the delete");
    assert.equal(result.success, true);
    assert.equal(invoiceUpdateArgs.data.totalAmount, 700);
    assert.equal(invoiceUpdateArgs.data.balanceDue, 700);
});

test("delete: a milestone not on any progress billing succeeds", async () => {
    const { deleteInvoiceMilestoneCore } = await import("../src/lib/billing-core");
    const row = cleanSchedule();
    let deleteManyCalled = false;
    let invoiceUpdateArgs: any = null;
    const tx = {
        paymentSchedule: {
            async findUnique() { return { ...row }; },
            async deleteMany() { deleteManyCalled = true; return { count: 1 }; },
        },
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update(args: any) { invoiceUpdateArgs = args; return {}; },
        },
        progressBillingLine: { findFirst: fakeProgressBillingLineFindFirst([]) },
        $queryRaw: async () => [],
    };

    const result = await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, () => deleteInvoiceMilestoneCore("ps-1"));

    assert.equal(deleteManyCalled, true);
    assert.equal(result.success, true);
    assert.equal(invoiceUpdateArgs.data.totalAmount, 700);
    assert.equal(invoiceUpdateArgs.data.balanceDue, 700);
});

// --- splitInvoiceMilestonesCore ---------------------------------------------

test("split: a non-Paid milestone covered by a Staged progress billing is refused", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    const currentRows = [
        cleanSchedule({ id: "ps-1", name: "Rough-in" }),
        cleanSchedule({ id: "ps-2", name: "Trim" }),
    ];
    let deleteManyCalled = false;
    let createManyCalled = false;
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 2000, balanceDue: 2000, status: "Sent" }; },
            async update() { throw new Error("must not recompute the invoice"); },
        },
        paymentSchedule: {
            async findFirst() { return null; }, // in-flight check + assertInvoiceHasNoChangeOrderBilling: neither applies here
            async findMany() { return currentRows.map(({ id, name }) => ({ id, name })); },
            async deleteMany() { deleteManyCalled = true; return { count: currentRows.length }; },
            async createMany() { createManyCalled = true; return { count: 2 }; },
        },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-1", billing: { code: "INV-1-P1", status: "Staged" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => splitInvoiceMilestonesCore("inv-1", [{ name: "New A", amount: 1000 }, { name: "New B", amount: 1000 }]),
            /"Rough-in" is on progress invoice INV-1-P1 \(Staged\)/,
        );
    });
    assert.equal(deleteManyCalled, false);
    assert.equal(createManyCalled, false);
});

test("split: a Paid milestone covered by a Paid progress billing does not block the split", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    // ps-1 is Paid, so it's excluded from the non-Paid rows the deleteMany
    // below removes — the guard must never even consider it, even though a
    // (Paid, non-Void) billing references it.
    const nonPaidRows = [cleanSchedule({ id: "ps-2", name: "Trim" })];
    let deleteManyCalled = false;
    let createManyCalled = false;
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 2000, balanceDue: 1000, status: "Partially Paid" }; },
            async update() { return {}; },
        },
        paymentSchedule: {
            async findFirst() { return null; },
            async findMany() { return nonPaidRows.map(({ id, name }) => ({ id, name })); },
            async deleteMany() { deleteManyCalled = true; return { count: nonPaidRows.length }; },
            async createMany() { createManyCalled = true; return { count: 1 }; },
        },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-1", billing: { code: "INV-1-P1", status: "Paid" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, () =>
        splitInvoiceMilestonesCore("inv-1", [{ name: "New Trim", amount: 1000 }]),
    );

    assert.equal(deleteManyCalled, true);
    assert.equal(createManyCalled, true);
});

test("split: an invoice with no progress billings at all succeeds", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    const currentRows = [cleanSchedule({ id: "ps-1", name: "Rough-in" })];
    let deleteManyCalled = false;
    let createManyCalled = false;
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update() { return {}; },
        },
        paymentSchedule: {
            async findFirst() { return null; },
            async findMany() { return currentRows.map(({ id, name }) => ({ id, name })); },
            async deleteMany() { deleteManyCalled = true; return { count: 1 }; },
            async createMany() { createManyCalled = true; return { count: 1 }; },
        },
        progressBillingLine: { findFirst: fakeProgressBillingLineFindFirst([]) },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, () =>
        splitInvoiceMilestonesCore("inv-1", [{ name: "New A", amount: 1000 }]),
    );

    assert.equal(deleteManyCalled, true);
    assert.equal(createManyCalled, true);
});

// --- updatePendingMilestoneAmountsCore --------------------------------------
//
// Every row here carries qbInvoiceId: null, so the preflight
// (prisma.paymentSchedule.findMany, filtered qbInvoiceId: { not: null })
// always sees nothing and `affected` stays empty — the post-commit QBO
// re-stage loop is skipped entirely and no QBO client is ever touched.

test("rebalance: a milestone covered by a Staged progress billing refuses an amount change", async () => {
    const { updatePendingMilestoneAmountsCore } = await import("../src/lib/billing-core");
    const existingRows = [
        cleanSchedule({ id: "ps-a", name: "A", amount: 100 }),
        cleanSchedule({ id: "ps-b", name: "B", amount: 100 }),
    ];
    let updateCalled = false;
    let estimateUpdateManyCalled = false;
    const tx = {
        invoice: { async findUnique() { return { estimateId: null }; } },
        paymentSchedule: {
            async findMany() { return existingRows.map((r) => ({ ...r })); },
            async update() { updateCalled = true; return {}; },
        },
        estimatePaymentSchedule: { async updateMany() { estimateUpdateManyCalled = true; return { count: 0 }; } },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-a", billing: { code: "INV-1-P1", status: "Staged" } },
            ]),
        },
        $queryRaw: async () => [],
    };
    const fakePrisma = {
        paymentSchedule: { async findMany() { return []; } }, // preflight: no QB-linked rows
        $transaction: async (fn: any) => fn(tx),
    };

    await withFakePrisma(fakePrisma, async () => {
        await assert.rejects(
            () => updatePendingMilestoneAmountsCore("inv-1", [
                { scheduleId: "ps-a", name: "A", amount: 50 },
                { scheduleId: "ps-b", name: "B", amount: 150 },
            ]),
            /"A" is on progress invoice INV-1-P1 \(Staged\)/,
        );
    });
    assert.equal(updateCalled, false, "no paymentSchedule.update must run");
    assert.equal(estimateUpdateManyCalled, false, "no estimatePaymentSchedule.updateMany must run");
});

test("rebalance: renaming/re-dating a covered milestone without changing its amount is not blocked", async () => {
    const { updatePendingMilestoneAmountsCore } = await import("../src/lib/billing-core");
    const existingRows = [
        cleanSchedule({ id: "ps-a", name: "A", amount: 100 }),
        cleanSchedule({ id: "ps-b", name: "B", amount: 50 }),
        cleanSchedule({ id: "ps-c", name: "C", amount: 80 }),
    ];
    const updateCalls: any[] = [];
    const tx = {
        invoice: { async findUnique() { return { estimateId: null }; } },
        paymentSchedule: {
            async findMany() { return existingRows.map((r) => ({ ...r })); },
            async update(args: any) { updateCalls.push(args); return {}; },
        },
        estimatePaymentSchedule: { async updateMany() { throw new Error("no row here has a sourceScheduleId"); } },
        progressBillingLine: {
            // A is covered (Staged) but its amount will not change.
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-a", billing: { code: "INV-1-P1", status: "Staged" } },
            ]),
        },
        $queryRaw: async () => [],
    };
    const fakePrisma = {
        paymentSchedule: { async findMany() { return []; } },
        $transaction: async (fn: any) => fn(tx),
    };

    const result = await withFakePrisma(fakePrisma, () =>
        updatePendingMilestoneAmountsCore("inv-1", [
            { scheduleId: "ps-a", name: "A (revised)", amount: 100, dueDate: "2027-01-01" },
            { scheduleId: "ps-b", name: "B", amount: 80 },
            { scheduleId: "ps-c", name: "C", amount: 50 },
        ]),
    );

    assert.equal(result.success, true);
    const aUpdate = updateCalls.find((c) => c.where.id === "ps-a");
    assert.equal(aUpdate.data.amount, 100, "A keeps its amount");
    assert.equal(aUpdate.data.name, "A (revised)");
    assert.equal(updateCalls.length, 3);
});

test("rebalance: a milestone covered by a Draft progress billing refuses an amount change", async () => {
    const { updatePendingMilestoneAmountsCore } = await import("../src/lib/billing-core");
    const existingRows = [
        cleanSchedule({ id: "ps-a", name: "A", amount: 100 }),
        cleanSchedule({ id: "ps-b", name: "B", amount: 100 }),
    ];
    let updateCalled = false;
    const tx = {
        invoice: { async findUnique() { return { estimateId: null }; } },
        paymentSchedule: {
            async findMany() { return existingRows.map((r) => ({ ...r })); },
            async update() { updateCalled = true; return {}; },
        },
        estimatePaymentSchedule: { async updateMany() { return { count: 0 }; } },
        progressBillingLine: {
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-a", billing: { code: "INV-1-P2", status: "Draft" } },
            ]),
        },
        $queryRaw: async () => [],
    };
    const fakePrisma = {
        paymentSchedule: { async findMany() { return []; } },
        $transaction: async (fn: any) => fn(tx),
    };

    await withFakePrisma(fakePrisma, async () => {
        await assert.rejects(
            () => updatePendingMilestoneAmountsCore("inv-1", [
                { scheduleId: "ps-a", name: "A", amount: 120 },
                { scheduleId: "ps-b", name: "B", amount: 80 },
            ]),
            /"A" is on progress invoice INV-1-P2 \(Draft\)/,
        );
    });
    assert.equal(updateCalled, false, "Draft counts as covered — it is staged later with the lines it already has");
});
