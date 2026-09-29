/**
 * Portal "due" / Pay-button decision (isMilestoneBilled, milestonePayLink)
 * must agree with the AR digest / invoice email rule (computeInvoiceReceivable).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    computeInvoiceReceivable,
    isMilestoneBilled,
    milestonePayLink,
    type ReceivableInvoiceInput,
    type ReceivableMilestone,
} from "../src/lib/receivables";

const NOW = Date.parse("2026-09-21T15:00:00.000Z");
const D = new Date("2026-08-01T00:00:00.000Z");

function ms(over: Partial<ReceivableMilestone> = {}): ReceivableMilestone {
    return {
        id: "m1", name: "Progress Payment", amount: "1000.00", status: "Pending",
        dueDate: null, createdAt: D, qbInvoiceId: null, qbInvoiceSentAt: null,
        qbSyncError: null, qbSyncedAt: null, ...over,
    };
}

function digestBills(m: ReceivableMilestone): boolean {
    const inv: ReceivableInvoiceInput = {
        status: "Issued", balanceDue: "1000.00", issueDate: D, sentAt: D, createdAt: D,
        milestoneCount: 1, payments: [m], progressBillings: [],
    } as ReceivableInvoiceInput;
    return computeInvoiceReceivable(inv, NOW).items.some(it => it.id === m.id);
}

const cases: Array<[string, Partial<ReceivableMilestone>, boolean]> = [
    ["requested (emailed), no QBO", { qbInvoiceSentAt: D }, true],
    ["QBO live, never requested", { qbInvoiceId: "6059" }, true],
    ["requested and QBO live", { qbInvoiceId: "6059", qbInvoiceSentAt: D }, true],
    ["staged only: scheduled, no QBO, no request", {}, false],
    ["QBO voided, never requested", { qbInvoiceId: "6059", qbSyncError: "voided" }, false],
    ["QBO notFound, never requested", { qbInvoiceId: "6059", qbSyncError: "notFound" }, false],
    ["QBO voided but was requested", { qbInvoiceId: "6059", qbSyncError: "voided", qbInvoiceSentAt: D }, true],
    ["QBO live with pay-link-missing marker", { qbInvoiceId: "6059", qbSyncError: "paylink-missing" }, true],
    ["paid", { status: "Paid", qbInvoiceId: "6059", qbInvoiceSentAt: D }, false],
    ["canceled", { status: "Canceled", qbInvoiceId: "6059", qbInvoiceSentAt: D }, false],
];

for (const [name, over, expected] of cases) {
    test(`portal billed rule: ${name} -> ${expected}`, () => {
        const m = ms(over);
        assert.equal(isMilestoneBilled(m), expected);
        assert.equal(isMilestoneBilled(m), digestBills(m), "portal must match the AR digest rule");
    });
}

test("portal billed rule: accepts serialized (string) dates", () => {
    assert.equal(isMilestoneBilled({ status: "Pending", qbInvoiceSentAt: "2026-08-01T00:00:00.000Z" }), true);
    assert.equal(isMilestoneBilled({ status: "Pending" }), false);
});

test("milestonePayLink: link only when no sync-error marker", () => {
    assert.equal(milestonePayLink({ qbInvoiceLink: "https://pay.example/x", qbSyncError: null }), "https://pay.example/x");
    assert.equal(milestonePayLink({ qbInvoiceLink: "https://pay.example/x", qbSyncError: "voided" }), null);
    assert.equal(milestonePayLink({ qbInvoiceLink: null }), null);
});
