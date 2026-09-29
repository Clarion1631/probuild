/**
 * deleteInvoiceCore must refuse while any non-Paid milestone carries Stripe state, and the shared
 * rule set (findInvoiceDeleteBlocker) must keep its priority order. Same fake-prisma harness as
 * tests/delete-invoice-qbo-guard.test.ts (no database).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { AMBIGUOUS_CREATE_MARKER } from "../src/lib/qbo-create-markers";

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
        id: "inv-1", code: "INV-A1", status: "Issued", qbInvoiceId: null, qbSyncMarker: null,
        projectId: "proj-1", payments: [] as any[], progressBillings: [] as any[],
        ...overrides,
    };
}

function milestone(name: string, overrides: Record<string, any> = {}) {
    return {
        id: `ps-${name}`, invoiceId: "inv-1", name, status: "Pending",
        qbInvoiceId: null, qbSyncError: null, stripeSessionId: null, stripePaymentIntentId: null,
        ...overrides,
    };
}

async function runDelete(invoiceRow: ReturnType<typeof baseInvoice>, opts: { hasChangeOrderBilling?: boolean } = {}) {
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

const OPEN_ONE = `Cannot delete this invoice: a Stripe checkout was started for milestone "Deposit", and ProBuild can't tell whether the customer can still pay through it. A payment that arrived after the invoice was deleted would not be recorded anywhere in ProBuild. ProBuild has no way to release a checkout yet, so the invoice can't be deleted.`;
const OPEN_MANY = `Cannot delete this invoice: Stripe checkouts were started for milestones "Deposit", "Rough-in", and ProBuild can't tell whether the customer can still pay through them. A payment that arrived after the invoice was deleted would not be recorded anywhere in ProBuild. ProBuild has no way to release a checkout yet, so the invoice can't be deleted.`;
const REVERSED_ONE = `Cannot delete this invoice: milestone "Deposit" was paid through Stripe and later marked unpaid in ProBuild (refunded, or the payment was undone). Deleting the invoice would remove ProBuild's only record of that Stripe charge. Check the charge in Stripe. ProBuild has no way to clear this link yet, so the invoice can't be deleted.`;

test("a pending milestone with only a checkout session refuses the delete", async () => {
    const { error, deleteCalled } = await runDelete(baseInvoice({ payments: [milestone("Deposit", { stripeSessionId: "cs_test_1" })] }));
    assert.ok(error);
    assert.equal(error.message, OPEN_ONE);
    assert.equal(deleteCalled, 0);
});

test("a pending milestone with only a PaymentIntent refuses the delete", async () => {
    const { error, deleteCalled } = await runDelete(baseInvoice({ payments: [milestone("Deposit", { stripePaymentIntentId: "pi_test_1" })] }));
    assert.ok(error);
    assert.equal(error.message, REVERSED_ONE);
    assert.equal(deleteCalled, 0);
});

test("a milestone with both Stripe ids reads as payment-reversed", async () => {
    const { error, deleteCalled } = await runDelete(baseInvoice({
        payments: [milestone("Deposit", { stripeSessionId: "cs_test_1", stripePaymentIntentId: "pi_test_1" })],
    }));
    assert.ok(error);
    assert.equal(error.message, REVERSED_ONE);
    assert.equal(deleteCalled, 0);
});

test("a Canceled milestone with a session still refuses", async () => {
    const { error, deleteCalled } = await runDelete(baseInvoice({ payments: [milestone("Deposit", { status: "Canceled", stripeSessionId: "cs_test_1" })] }));
    assert.ok(error);
    assert.equal(error.message, OPEN_ONE);
    assert.equal(deleteCalled, 0);
});

test("two session-only milestones use the plural checkout message", async () => {
    const { error } = await runDelete(baseInvoice({
        payments: [milestone("Deposit", { stripeSessionId: "cs_test_1" }), milestone("Rough-in", { stripeSessionId: "cs_test_2" })],
    }));
    assert.ok(error);
    assert.equal(error.message, OPEN_MANY);
});

test("five session-only milestones list three names and a count", async () => {
    const payments = ["A", "B", "C", "D", "E"].map((n) => milestone(n, { stripeSessionId: `cs_${n}` }));
    const { error } = await runDelete(baseInvoice({ payments }));
    assert.ok(error);
    assert.ok(error.message.includes('milestones "A", "B", "C" and 2 more'), error.message);
});

test("a reversed milestone wins over an open one and only it is named", async () => {
    const { error } = await runDelete(baseInvoice({
        payments: [milestone("Deposit", { stripePaymentIntentId: "pi_test_1" }), milestone("Rough-in", { stripeSessionId: "cs_test_2" })],
    }));
    assert.ok(error);
    assert.equal(error.message, REVERSED_ONE);
});

test("a Paid milestone with Stripe ids still reports recorded payments", async () => {
    const { error } = await runDelete(baseInvoice({
        payments: [milestone("Deposit", { status: "Paid", stripeSessionId: "cs_test_1", stripePaymentIntentId: "pi_test_1" })],
    }));
    assert.ok(error);
    assert.equal(error.message, "Cannot delete an invoice with recorded payments");
});

test("a QBO-linked milestone is reported before a Stripe one", async () => {
    const { error } = await runDelete(baseInvoice({
        payments: [milestone("Deposit", { qbInvoiceId: "qb-1" }), milestone("Rough-in", { stripeSessionId: "cs_test_1" })],
    }));
    assert.ok(error);
    assert.match(error.message, /already in QuickBooks/);
});

test("change-order billing is reported before a Stripe milestone", async () => {
    const { error } = await runDelete(baseInvoice({ payments: [milestone("Deposit", { stripeSessionId: "cs_test_1" })] }), { hasChangeOrderBilling: true });
    assert.ok(error);
    assert.equal(error.message, "Cannot delete an invoice with change-order billing. Void/rebill the change-order billing before trying again.");
});

test("a milestone fixture without any Stripe keys deletes", async () => {
    const { result, error, deleteCalled } = await runDelete(baseInvoice({
        payments: [{ id: "ps-1", invoiceId: "inv-1", name: "Deposit", status: "Pending", qbInvoiceId: null, qbSyncError: null }],
    }));
    assert.equal(error, undefined);
    assert.equal(deleteCalled, 1);
    assert.equal(result, "proj-1");
});

test("locks run Invoice, PaymentSchedule, ProgressBilling, then the read, and a refusal never deletes", async () => {
    const { calls, error, deleteCalled } = await runDelete(baseInvoice({ payments: [milestone("Deposit", { stripeSessionId: "cs_test_1" })] }));
    assert.ok(error);
    assert.equal(deleteCalled, 0);
    const idx = (needle: string) => calls.findIndex((c) => c.sql.includes(needle));
    const inv = idx('FROM "Invoice"');
    const ps = idx('FROM "PaymentSchedule"');
    const pb = idx('FROM "ProgressBilling"');
    const read = idx("read:invoice");
    assert.ok(inv >= 0 && inv < ps && ps < pb && pb < read, JSON.stringify(calls.map((c) => c.sql)));
    for (const i of [inv, ps, pb]) assert.deepEqual(calls[i].values, ["inv-1"]);
});

test("findInvoiceDeleteBlocker keeps the priority order and stays lazy on the change-order query", async () => {
    const { findInvoiceDeleteBlocker } = await import("../src/lib/billing-core");
    const inv: any = baseInvoice({
        status: "Paid",
        qbInvoiceId: "qb-3",
        payments: [
            milestone("Paid", { status: "Paid" }),
            milestone("Qbo", { qbInvoiceId: "qb-1" }),
            milestone("Reversed", { stripePaymentIntentId: "pi_test_1" }),
            milestone("Open", { stripeSessionId: "cs_test_1" }),
        ],
        progressBillings: [{ code: "INV-A1-P1", qbInvoiceId: "qb-2", qbSyncError: null }],
    });
    let coCalls = 0;
    let coAnswer = true;
    const co = async () => { coCalls++; return coAnswer; };
    const kinds: string[] = [];
    const step = async () => { const b = await findInvoiceDeleteBlocker(inv, co); kinds.push(b?.kind ?? "null"); };
    const drop = (name: string) => { inv.payments = inv.payments.filter((p: any) => p.name !== name); };

    await step();                                   // recorded-payments
    drop("Paid"); await step();                     // paid-status (invoice.status is Paid)
    assert.equal(coCalls, 0, "CO thunk must not run when a paid rule fires");
    inv.status = "Issued"; await step();            // change-order-billing
    assert.equal(coCalls, 1);
    coAnswer = false;
    await step();                                   // qbo-milestones
    drop("Qbo"); await step();                      // qbo-progress-billings
    inv.progressBillings = []; await step();        // qbo-invoice
    inv.qbInvoiceId = null; await step();           // stripe-payment-reversed
    drop("Reversed"); await step();                 // stripe-checkout-open
    drop("Open"); await step();                     // null
    assert.deepEqual(kinds, [
        "recorded-payments", "paid-status", "change-order-billing", "qbo-milestones",
        "qbo-progress-billings", "qbo-invoice", "stripe-payment-reversed", "stripe-checkout-open", "null",
    ]);
});

test("findInvoiceDeleteBlocker flags the invoice's own ambiguous marker", async () => {
    const { findInvoiceDeleteBlocker } = await import("../src/lib/billing-core");
    const b = await findInvoiceDeleteBlocker(baseInvoice({ qbSyncMarker: AMBIGUOUS_CREATE_MARKER }) as any, async () => false);
    assert.equal(b?.kind, "qbo-invoice");
});

test("invoiceDeleteBlockClause: exact strings, singular, plural and the cap", async () => {
    const { invoiceDeleteBlockClause: c } = await import("../src/lib/billing-core");
    const row = (label: string) => ({ label, qbInvoiceId: "qb", qbSyncError: null });
    assert.equal(c({ kind: "recorded-payments" }), "has recorded payments");
    assert.equal(c({ kind: "paid-status" }), "is paid or partially paid");
    assert.equal(c({ kind: "change-order-billing" }), "has change-order billing");
    assert.equal(c({ kind: "qbo-milestones", rows: [row("Deposit")] }), 'is linked or pending in QuickBooks (milestone "Deposit")');
    assert.equal(c({ kind: "qbo-milestones", rows: [row("A"), row("B")] }), 'is linked or pending in QuickBooks (milestones "A", "B")');
    assert.equal(c({ kind: "qbo-progress-billings", rows: [row("INV-A1-P1")] }), 'is linked or pending in QuickBooks (progress billing "INV-A1-P1")');
    assert.equal(c({ kind: "qbo-progress-billings", rows: [row("X"), row("Y")] }), 'is linked or pending in QuickBooks (progress billings "X", "Y")');
    assert.equal(c({ kind: "qbo-invoice", rows: [row("INV-A1")] }), "is linked or pending in QuickBooks");
    assert.equal(c({ kind: "stripe-payment-reversed", milestoneNames: ["Deposit"] }), 'has a Stripe payment that was later marked unpaid (milestone "Deposit")');
    assert.equal(c({ kind: "stripe-payment-reversed", milestoneNames: ["A", "B"] }), 'has Stripe payments that were later marked unpaid (milestones "A", "B")');
    assert.equal(c({ kind: "stripe-checkout-open", milestoneNames: ["Deposit"] }), 'has a Stripe checkout that may still be payable (milestone "Deposit")');
    assert.equal(c({ kind: "stripe-checkout-open", milestoneNames: ["A", "B"] }), 'has Stripe checkouts that may still be payable (milestones "A", "B")');
    assert.equal(
        c({ kind: "stripe-checkout-open", milestoneNames: ["A", "B", "C", "D", "E"] }),
        'has Stripe checkouts that may still be payable (milestones "A", "B", "C" and 2 more)',
    );
});

test("invoiceDeleteBlockMessage: plural reversed message", async () => {
    const { invoiceDeleteBlockMessage: m } = await import("../src/lib/billing-core");
    assert.equal(
        m({ kind: "stripe-payment-reversed", milestoneNames: ["Deposit", "Rough-in"] }),
        `Cannot delete this invoice: milestones "Deposit", "Rough-in" were paid through Stripe and later marked unpaid in ProBuild (refunded, or the payment was undone). Deleting the invoice would remove ProBuild's only record of those Stripe charges. Check the charges in Stripe. ProBuild has no way to clear these links yet, so the invoice can't be deleted.`,
    );
});

test("stripeDeleteState", async () => {
    const { stripeDeleteState: s } = await import("../src/lib/billing-core");
    assert.equal(s({ status: "Paid", stripeSessionId: "cs", stripePaymentIntentId: "pi" }), null);
    assert.equal(s({ status: "Pending", stripeSessionId: "cs" }), "checkout-open");
    assert.equal(s({ status: "Pending", stripePaymentIntentId: "pi" }), "payment-reversed");
    assert.equal(s({ status: "Pending", stripeSessionId: "cs", stripePaymentIntentId: "pi" }), "payment-reversed");
    assert.equal(s({ status: "Canceled", stripeSessionId: "cs" }), "checkout-open");
    assert.equal(s({ status: "Pending", stripeSessionId: null, stripePaymentIntentId: null }), null);
    assert.equal(s({ status: "Pending" }), null);
});

test("retainerDeleteClause", async () => {
    const { retainerDeleteClause: r } = await import("../src/lib/billing-core");
    assert.equal(r({ status: "Paid", amountPaid: 0 }), "is marked Paid");
    assert.equal(r({ status: "Partially Paid", amountPaid: 0 }), "is marked Partially Paid");
    assert.equal(r({ status: "Sent", amountPaid: 50 }), "has a recorded payment");
    assert.equal(r({ status: "Sent", amountPaid: "50.00" }), "has a recorded payment");
    assert.equal(r({ status: "Draft", amountPaid: 0 }), null);
    assert.equal(r({ status: "Sent", amountPaid: null }), null);
});
