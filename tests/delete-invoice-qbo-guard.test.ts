/**
 * `deleteInvoiceCore` (src/lib/billing-core.ts) must refuse a whole-invoice
 * delete when the invoice itself, any milestone, or any progress billing is
 * linked or pending in QuickBooks — see `isQboInvoiceLinkedOrPending` in
 * qbo-create-markers.ts, "the predicate EVERY money guard must use". Both
 * PaymentSchedule and ProgressBilling cascade-delete with their Invoice
 * (schema.prisma `onDelete: Cascade`), so skipping this check abandons a real,
 * collectible QuickBooks invoice with nothing left in ProBuild pointing at it
 * — a real incident left three QuickBooks invoices open after their ProBuild
 * invoice was deleted.
 *
 * Drives the real core (no database: src/lib/prisma.ts reads
 * globalThis.prisma before it builds a client), same fake-prisma pattern as
 * tests/qbo-parked-row-guards.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    CREATE_IN_FLIGHT_MARKER,
    AMBIGUOUS_CREATE_MARKER,
    PENDING_DELETION_MARKER,
    composeCreateMarker,
} from "../src/lib/qbo-create-markers";
import { PAID_PENDING_DELETION_FLAG } from "../src/lib/quickbooks-payments";

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

function baseInvoice(overrides: Record<string, any> = {}) {
    return {
        id: "inv-1",
        code: "INV-1",
        status: "Sent",
        totalAmount: 1000,
        balanceDue: 1000,
        qbInvoiceId: null,
        qbSyncMarker: null,
        projectId: "proj-1",
        payments: [] as any[],
        progressBillings: [] as any[],
        ...overrides,
    };
}

function milestoneRow(overrides: Record<string, any> = {}) {
    return {
        id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending",
        amount: 500, qbInvoiceId: null, qbSyncError: null,
        ...overrides,
    };
}

function billingRow(overrides: Record<string, any> = {}) {
    return {
        id: "pb-1", invoiceId: "inv-1", code: "INV-1-P1", status: "Draft",
        qbInvoiceId: null, qbSyncError: null,
        ...overrides,
    };
}

/**
 * Runs `deleteInvoiceCore` against a fake `tx` built from `invoiceRow`,
 * recording every `$queryRaw` call as `{ sql, values }` — text AND bound
 * parameters, so a test can assert not just that the child-row locks ran
 * before the read but that each one was bound to the right invoiceId — plus
 * the invoice read and any delete, so a test can assert a refusal never
 * reaches `tx.invoice.delete`.
 *
 * `opts.hasChangeOrderBilling` answers `assertInvoiceHasNoChangeOrderBilling`'s
 * `paymentSchedule.findFirst` query with a matching row (or null), so the
 * pre-existing change-order-billing refusal can be exercised here too.
 */
async function runDelete(
    invoiceRow: ReturnType<typeof baseInvoice>,
    opts: { hasChangeOrderBilling?: boolean } = {},
) {
    const { deleteInvoiceCore } = await import("../src/lib/billing-core");
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let deleteCalled = 0;
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            calls.push({ sql: strings.join("?"), values });
            return [];
        },
        invoice: {
            async findUnique() {
                calls.push({ sql: "read:invoice", values: [] });
                return invoiceRow;
            },
            async delete() {
                deleteCalled++;
                return invoiceRow;
            },
        },
        paymentSchedule: {
            async findFirst() {
                return opts.hasChangeOrderBilling ? { id: "co-ps-1" } : null;
            },
        },
    };

    let result: string | undefined;
    let error: any;
    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        try {
            result = await deleteInvoiceCore(invoiceRow.id);
        } catch (e) {
            error = e;
        }
    });
    return { result, error, deleteCalled, calls };
}

test("a linked milestone refuses the delete, names it, and the delete is never called", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbInvoiceId: "qb-99" })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /"Rough-in"/, "the error must name the milestone");
    assert.match(error.message, /already in QuickBooks/);
    assert.equal(deleteCalled, 0);
});

test("the linked-milestone message points at the delete-in-QuickBooks option by its exact label, not just Break QB Link", async () => {
    // The old wording ("Use Break QB Link on it first, then delete the
    // invoice") was misleading: Break QB Link's default is a LOCAL-ONLY
    // unlink that leaves the QuickBooks invoice untouched (InvoiceEditor.tsx's
    // confirm dialog, unchecked by default) — only checking "Also delete the
    // staged invoice in QuickBooks" removes it there too. A message that just
    // says "Break QB Link" would pass a user through the dialog with the box
    // still unchecked and the QuickBooks invoice would stay open.
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbInvoiceId: "qb-99" })] });
    const { error } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(
        error.message,
        /"Also delete the staged invoice in QuickBooks"/,
        "must name the exact checkbox label that actually deletes it in QuickBooks",
    );
    assert.match(error.message, /local-only unlink would still leave it open in QuickBooks/);
});

test("a bare create-in-flight milestone marker refuses the delete", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbSyncError: CREATE_IN_FLIGHT_MARKER })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /previous QuickBooks send ended without a confirmed result/);
    assert.equal(deleteCalled, 0);
});

test("a bare ambiguous-create milestone marker refuses the delete", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbSyncError: AMBIGUOUS_CREATE_MARKER })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /previous QuickBooks send ended without a confirmed result/);
    assert.equal(deleteCalled, 0);
});

test("a create-in-flight milestone marker with an identity suffix refuses the delete", async () => {
    const marker = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, {
        docNumber: "INV-1-2",
        privateNote: "ProBuild INV-1 - Rough-in",
    });
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbSyncError: marker })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /previous QuickBooks send ended without a confirmed result/);
    assert.equal(deleteCalled, 0);
});

test("an ambiguous-create milestone marker with an identity suffix refuses the delete", async () => {
    const marker = composeCreateMarker(AMBIGUOUS_CREATE_MARKER, {
        docNumber: "INV-1-2",
        privateNote: "ProBuild INV-1 - Rough-in",
    });
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbSyncError: marker })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /previous QuickBooks send ended without a confirmed result/);
    assert.equal(deleteCalled, 0);
});

test("the pending-milestone message describes what Break QB Link really does, including that it can end up linking an invoice", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbSyncError: CREATE_IN_FLIGHT_MARKER })] });
    const { error } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /"Break QB Link"/);
    assert.match(error.message, /asks QuickBooks whether an invoice exists and links it here if so/);
    assert.match(
        error.message,
        /"Also delete the staged invoice in QuickBooks"/,
        "must say the invoice still can't be deleted until that link is removed via the delete-in-QuickBooks option",
    );
});

// --- Break QB Link's queued-QuickBooks-deletion states ---------------------
//
// breakQBInvoiceLink (actions.ts) with "Also delete the staged invoice in
// QuickBooks" checked writes PENDING_DELETION_MARKER onto qbSyncError BEFORE
// the QuickBooks delete call, while qbInvoiceId stays set — it is only
// cleared afterward, atomically with the marker, by claimQBInvoiceUnlink. If
// that unlink CAS itself loses (a settle raced it), the row is left with
// qbInvoiceId still set and qbSyncError promoted to
// PAID_PENDING_DELETION_FLAG. Both cases must still refuse a whole-invoice
// delete — and today they do, purely because qbInvoiceId never got cleared.

test("a milestone with a queued QuickBooks deletion (PENDING_DELETION_MARKER) still refuses, via qbInvoiceId", async () => {
    const invoiceRow = baseInvoice({
        payments: [milestoneRow({ qbInvoiceId: "qb-99", qbSyncError: PENDING_DELETION_MARKER })],
    });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /"Rough-in"/);
    assert.match(error.message, /already in QuickBooks/, "qbInvoiceId is set, so this is the confirmed-link branch");
    assert.equal(deleteCalled, 0);
});

test("a milestone left PAID_PENDING_DELETION_FLAG still refuses, via qbInvoiceId", async () => {
    const invoiceRow = baseInvoice({
        payments: [milestoneRow({ qbInvoiceId: "qb-99", qbSyncError: PAID_PENDING_DELETION_FLAG })],
    });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /"Rough-in"/);
    assert.match(error.message, /already in QuickBooks/, "qbInvoiceId is set, so this is the confirmed-link branch");
    assert.equal(deleteCalled, 0);
});

test("the invoice's own qbInvoiceId refuses the delete", async () => {
    const invoiceRow = baseInvoice({ qbInvoiceId: "qb-inv-1" });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /"INV-1"/);
    assert.match(error.message, /already in QuickBooks/);
    assert.equal(deleteCalled, 0);
});

test("the invoice's own pending qbSyncMarker refuses the delete", async () => {
    const invoiceRow = baseInvoice({ qbSyncMarker: CREATE_IN_FLIGHT_MARKER });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /previous QuickBooks send ended without a confirmed result/);
    assert.equal(deleteCalled, 0);
});

test("a linked progress billing refuses the delete", async () => {
    const invoiceRow = baseInvoice({ progressBillings: [billingRow({ qbInvoiceId: "qb-pb-1" })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /"INV-1-P1"/);
    assert.match(error.message, /already in QuickBooks/);
    assert.equal(deleteCalled, 0);
});

test("a pending progress billing refuses the delete", async () => {
    const invoiceRow = baseInvoice({ progressBillings: [billingRow({ qbSyncError: AMBIGUOUS_CREATE_MARKER })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.match(error.message, /previous QuickBooks send ended without a confirmed result/);
    assert.equal(deleteCalled, 0);
});

test("the progress-billing and invoice-level messages never tell the user to resolve it in QuickBooks", async () => {
    // Fixing (or checking) a progress billing's or the invoice's own document
    // link in QuickBooks does NOT clear ProBuild's local qbInvoiceId/marker —
    // there is no in-app unlink control for either — so the delete would stay
    // blocked no matter what the user does in QuickBooks. The old wording
    // ("resolve it directly in QuickBooks") was misleading for exactly that
    // reason and must not reappear.
    const pbRow = baseInvoice({ progressBillings: [billingRow({ qbInvoiceId: "qb-pb-1" })] });
    const { error: pbError } = await runDelete(pbRow);
    assert.ok(pbError);
    assert.doesNotMatch(pbError.message, /resolve[^.]*QuickBooks/i);
    assert.match(pbError.message, /ProBuild has no way to unlink this yet/);
    assert.match(pbError.message, /ask an admin/);

    const pendingPbRow = baseInvoice({ progressBillings: [billingRow({ qbSyncError: AMBIGUOUS_CREATE_MARKER })] });
    const { error: pendingPbError } = await runDelete(pendingPbRow);
    assert.ok(pendingPbError);
    assert.doesNotMatch(pendingPbError.message, /resolve[^.]*QuickBooks/i);
    assert.match(pendingPbError.message, /ProBuild has no way to unlink this yet/);
    assert.match(pendingPbError.message, /ask an admin/);

    const invRow = baseInvoice({ qbInvoiceId: "qb-inv-1" });
    const { error: invError } = await runDelete(invRow);
    assert.ok(invError);
    assert.doesNotMatch(invError.message, /resolve[^.]*QuickBooks/i);
    assert.match(invError.message, /ProBuild has no way to unlink this yet/);
    assert.match(invError.message, /ask an admin/);

    const pendingInvRow = baseInvoice({ qbSyncMarker: CREATE_IN_FLIGHT_MARKER });
    const { error: pendingInvError } = await runDelete(pendingInvRow);
    assert.ok(pendingInvError);
    assert.doesNotMatch(pendingInvError.message, /resolve[^.]*QuickBooks/i);
    assert.match(pendingInvError.message, /ProBuild has no way to unlink this yet/);
    assert.match(pendingInvError.message, /ask an admin/);
});

test("a non-pending qbSyncError with no qbInvoiceId does not block the delete", async () => {
    // "voided" is a real state (see the PaymentSchedule.qbSyncError schema
    // comment: "voided" | "notFound", set by the sync poller) — it is NOT one
    // of the pending-create markers, so isQboInvoiceLinkedOrPending must read
    // it as unlinked, same as a plain failure string would.
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ qbSyncError: "voided", qbInvoiceId: null })] });
    const { error, result, deleteCalled } = await runDelete(invoiceRow);
    assert.equal(error, undefined, "must not be refused");
    assert.equal(deleteCalled, 1);
    assert.equal(result, "proj-1");
});

test("an invoice with nothing linked deletes exactly once", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow()], progressBillings: [billingRow()] });
    const { error, result, deleteCalled } = await runDelete(invoiceRow);
    assert.equal(error, undefined, "must not be refused");
    assert.equal(deleteCalled, 1);
    assert.equal(result, "proj-1");
});

test("a Paid milestone still refuses with the original message, before the QBO guard", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow({ status: "Paid" })] });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.equal(error.message, "Cannot delete an invoice with recorded payments");
    assert.equal(deleteCalled, 0);
});

test("a Paid invoice status still refuses with the original message, before the QBO guard", async () => {
    const invoiceRow = baseInvoice({ status: "Paid" });
    const { error, deleteCalled } = await runDelete(invoiceRow);
    assert.ok(error, "expected a refusal");
    assert.equal(error.message, "Cannot delete a paid or partially paid invoice");
    assert.equal(deleteCalled, 0);
});

test("change-order billing still refuses with the existing message, before the QBO guard", async () => {
    // Even an invoice with nothing QBO-linked must still be refused here —
    // assertInvoiceHasNoChangeOrderBilling runs first, unchanged.
    const invoiceRow = baseInvoice({ payments: [milestoneRow()], progressBillings: [billingRow()] });
    const { error, deleteCalled } = await runDelete(invoiceRow, { hasChangeOrderBilling: true });
    assert.ok(error, "expected a refusal");
    assert.equal(
        error.message,
        "Cannot delete an invoice with change-order billing. Void/rebill the change-order billing before trying again.",
    );
    assert.equal(deleteCalled, 0);
});

test("the Invoice, PaymentSchedule and ProgressBilling locks run in order, each bound to the invoiceId, before the read", async () => {
    const invoiceRow = baseInvoice({ payments: [milestoneRow()], progressBillings: [billingRow()] });
    const { calls, error } = await runDelete(invoiceRow);
    assert.equal(error, undefined);

    const invoiceLockIndex = calls.findIndex((c) => c.sql.includes('"Invoice"') && c.sql.includes("FOR UPDATE"));
    const psLockIndex = calls.findIndex((c) => c.sql.includes('"PaymentSchedule"') && c.sql.includes("FOR UPDATE"));
    const pbLockIndex = calls.findIndex((c) => c.sql.includes('"ProgressBilling"') && c.sql.includes("FOR UPDATE"));
    const readIndex = calls.findIndex((c) => c.sql === "read:invoice");

    assert.notEqual(invoiceLockIndex, -1, "expected the Invoice parent lock lockMoneyParents issues");
    assert.notEqual(psLockIndex, -1, "expected a PaymentSchedule FOR UPDATE lock");
    assert.notEqual(pbLockIndex, -1, "expected a ProgressBilling FOR UPDATE lock");
    assert.notEqual(readIndex, -1, "expected the invoice to be read");

    assert.ok(invoiceLockIndex < psLockIndex, "the Invoice parent lock must run before the PaymentSchedule lock");
    assert.ok(psLockIndex < pbLockIndex, "the PaymentSchedule lock must run before the ProgressBilling lock");
    assert.ok(pbLockIndex < readIndex, "the ProgressBilling lock must run before the invoice read");

    assert.deepEqual(calls[invoiceLockIndex].values, [invoiceRow.id], "the Invoice lock must be bound to the invoiceId");
    assert.deepEqual(calls[psLockIndex].values, [invoiceRow.id], "the PaymentSchedule lock must be bound to the invoiceId");
    assert.deepEqual(calls[pbLockIndex].values, [invoiceRow.id], "the ProgressBilling lock must be bound to the invoiceId");
});
