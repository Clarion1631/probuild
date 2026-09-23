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
 *
 * Round-2 fix: the fake's Void exclusion used to be hardcoded in JS instead
 * of read from `args.where`, and the split tests fed `paymentSchedule`
 * canned per-test answers instead of a real table — either gap could have
 * let a changed production predicate, or a changed `deleteMany` scope, pass
 * silently. Every fake here now runs the actual `where` (and, for the split
 * table, `select`) through one generic matcher (`matchWhere`) shared by both
 * `progressBillingLine` and `paymentSchedule`.
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
 * Small generic where-matcher shared by every fake read/write in this file:
 * equality (including null), `{ in: [...] }`, `{ not: X }` (X a value or
 * null), and one level of nested relation object (e.g. `billing: { status:
 * { not: "Void" } }`, matched against `row.billing`). Throws on anything
 * else, so a changed production predicate this matcher can't evaluate fails
 * the test loudly instead of silently passing.
 */
function matchWhere(row: any, where: Record<string, unknown> | undefined): boolean {
    return Object.entries(where ?? {}).every(([key, cond]) => matchField((row ?? {})[key], cond));
}

function matchField(value: any, cond: any): boolean {
    if (cond === null || typeof cond !== "object") return value === cond;
    if ("in" in cond) return (cond as { in: unknown[] }).in.includes(value);
    if ("not" in cond) return value !== (cond as { not: unknown }).not;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        // Nested relation predicate, e.g. `billing: { status: { not: "Void" } }`
        // — recurse the same matcher against the related row.
        return matchWhere(value, cond as Record<string, unknown>);
    }
    throw new Error(`unsupported where condition: ${JSON.stringify(cond)}`);
}

/**
 * The fake `tx.progressBillingLine.findFirst`: evaluates the guard's actual
 * `where` clause via `matchWhere` against an in-memory lines table, instead
 * of hardcoding any part of the predicate (e.g. the Void exclusion) itself.
 */
function fakeProgressBillingLineFindFirst(lines: FakeLine[]) {
    return async (args: any) => {
        const hit = lines.find((l) => matchWhere(l, args.where));
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

type FakeScheduleRow = { id: string; invoiceId: string; name: string; status: string; amount: number };

/** Applies a Prisma `select` (flat `{ field: true }` — all this core sends) to a row. */
function project(row: FakeScheduleRow, select?: Record<string, boolean>): Partial<FakeScheduleRow> {
    if (!select) return { ...row };
    const out: Partial<FakeScheduleRow> = {};
    for (const key of Object.keys(select) as (keyof FakeScheduleRow)[]) {
        if (select[key]) (out as any)[key] = row[key];
    }
    return out;
}

/**
 * One in-memory `paymentSchedule` table backing the split tests: `findMany`
 * evaluates the real `where`/`select` the core sends, and `deleteMany`
 * evaluates its `where` and actually removes matching rows from the SAME
 * array `createMany` appends to — so a test can assert exactly which rows
 * survived, not just that a method was called. `findFirst` (the core's
 * separate in-flight-payment / change-order checks — a different guard with
 * its own OR/startsWith predicate, not what this file is pinning) stays a
 * plain "nothing in flight" stub, true of every row these fixtures create.
 */
function makeScheduleTable(rows: FakeScheduleRow[]) {
    const deleteManyCalls: any[] = [];
    const createManyCalls: any[] = [];
    let nextId = 1;
    return {
        rows,
        deleteManyCalls,
        createManyCalls,
        async findFirst() { return null; },
        async findMany(args: any) {
            return rows.filter((r) => matchWhere(r, args.where)).map((r) => project(r, args.select));
        },
        async deleteMany(args: any) {
            deleteManyCalls.push(args);
            const toDelete = rows.filter((r) => matchWhere(r, args.where));
            for (const row of toDelete) rows.splice(rows.indexOf(row), 1);
            return { count: toDelete.length };
        },
        async createMany(args: any) {
            createManyCalls.push(args);
            const added = args.data.map((d: any) => ({ status: "Pending", ...d, id: `new-${nextId++}` }));
            rows.push(...added);
            return { count: added.length };
        },
    };
}

test("split: a non-Paid milestone covered by a Staged progress billing is refused", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    const table = makeScheduleTable([
        { id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending", amount: 1000 },
        { id: "ps-2", invoiceId: "inv-1", name: "Trim", status: "Pending", amount: 1000 },
        { id: "ps-paid", invoiceId: "inv-1", name: "Deposit", status: "Paid", amount: 500 },
        { id: "ps-other", invoiceId: "inv-2", name: "Other job", status: "Pending", amount: 400 },
    ]);
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 2500, balanceDue: 2000, status: "Sent" }; },
            async update() { throw new Error("must not recompute the invoice"); },
        },
        paymentSchedule: table,
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
    assert.equal(table.deleteManyCalls.length, 0, "the CAS delete must not run");
    assert.equal(table.createManyCalls.length, 0);
    assert.deepEqual(table.rows.map((r) => r.id).sort(), ["ps-1", "ps-2", "ps-other", "ps-paid"], "no row touched");
});

test("split: a Paid milestone covered by a Paid progress billing does not block the split", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    // ps-1 is Paid, so it's excluded from the non-Paid rows the deleteMany
    // below removes — the guard must never even consider it, even though a
    // (Paid, non-Void) billing references it.
    const table = makeScheduleTable([
        { id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Paid", amount: 1000 },
        { id: "ps-2", invoiceId: "inv-1", name: "Trim", status: "Pending", amount: 1000 },
        { id: "ps-other", invoiceId: "inv-2", name: "Other job", status: "Pending", amount: 400 },
    ]);
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 2000, balanceDue: 1000, status: "Partially Paid" }; },
            async update() { return {}; },
        },
        paymentSchedule: table,
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

    assert.equal(table.deleteManyCalls.length, 1);
    assert.equal(table.createManyCalls.length, 1);
    assert.equal(table.rows.find((r) => r.id === "ps-2"), undefined, "the Pending row was removed");
    assert.deepEqual(
        table.rows.map((r) => r.id).sort(),
        ["new-1", "ps-1", "ps-other"],
        "Paid row and the other invoice's row survive; the new row was added",
    );
    const paid = table.rows.find((r) => r.id === "ps-1")!;
    assert.equal(paid.status, "Paid");
    assert.equal(paid.amount, 1000, "the Paid row keeps its own amount");
});

test("split: an invoice with no progress billings at all succeeds", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    const table = makeScheduleTable([
        { id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending", amount: 1000 },
        { id: "ps-paid", invoiceId: "inv-1", name: "Deposit", status: "Paid", amount: 300 },
        { id: "ps-other", invoiceId: "inv-2", name: "Other job", status: "Pending", amount: 400 },
    ]);
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1300, balanceDue: 1000, status: "Sent" }; },
            async update() { return {}; },
        },
        paymentSchedule: table,
        progressBillingLine: { findFirst: fakeProgressBillingLineFindFirst([]) },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, () =>
        splitInvoiceMilestonesCore("inv-1", [{ name: "New A", amount: 1000 }]),
    );

    assert.equal(table.deleteManyCalls.length, 1);
    assert.equal(table.createManyCalls.length, 1);
    assert.deepEqual(table.rows.map((r) => r.id).sort(), ["new-1", "ps-other", "ps-paid"]);
});

test("split: a Pending milestone of a different invoice covered by a Staged billing does not block this invoice's split", async () => {
    const { splitInvoiceMilestonesCore } = await import("../src/lib/billing-core");
    const table = makeScheduleTable([
        { id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending", amount: 1000 },
        { id: "ps-2", invoiceId: "inv-2", name: "Other Rough-in", status: "Pending", amount: 500 },
    ]);
    const tx = {
        invoice: {
            async findUnique() { return { id: "inv-1", projectId: "proj-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; },
            async update() { return {}; },
        },
        paymentSchedule: table,
        progressBillingLine: {
            // ps-2 belongs to inv-2, not the invoice being split — the guard's
            // row set must be scoped to this invoice's own toRemove rows.
            findFirst: fakeProgressBillingLineFindFirst([
                { scheduleId: "ps-2", billing: { code: "INV-2-P1", status: "Staged" } },
            ]),
        },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, () =>
        splitInvoiceMilestonesCore("inv-1", [{ name: "New A", amount: 1000 }]),
    );

    assert.equal(table.deleteManyCalls.length, 1, "inv-1's split must proceed despite inv-2's covered milestone");
    assert.deepEqual(
        table.rows.map((r) => r.id).sort(),
        ["new-1", "ps-2"],
        "ps-1 replaced; the other invoice's covered milestone is untouched",
    );
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
