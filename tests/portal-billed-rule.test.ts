/**
 * Portal "due" / Pay-button decision (isMilestoneBilled, milestonePayLink)
 * must agree with the AR digest / invoice email rule (computeInvoiceReceivable).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    billedMilestoneIds,
    computeInvoiceReceivable,
    milestonePayLink,
    type ReceivableInvoiceInput,
    type ReceivableMilestone,
    type ReceivableProgressBilling,
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

function pb(over: Partial<ReceivableProgressBilling> = {}, scheduleIds: string[] = ["m1"]): ReceivableProgressBilling {
    return {
        id: "pb1", code: "INV-P1", status: "Staged", qbInvoiceId: "9001", qbSyncError: null,
        qbSyncedAt: D, qbInvoiceSentAt: null, sentAt: null, createdAt: D,
        lines: scheduleIds.map(scheduleId => ({ scheduleId })), ...over,
    };
}

function digestBills(m: ReceivableMilestone, pbs: ReceivableProgressBilling[]): boolean {
    const inv: ReceivableInvoiceInput = {
        status: "Issued", balanceDue: "1000.00", issueDate: D, sentAt: D, createdAt: D,
        milestoneCount: 1, payments: [m], progressBillings: pbs,
    } as ReceivableInvoiceInput;
    return computeInvoiceReceivable(inv, NOW).items.some(it => it.id === m.id);
}

const cases: Array<[string, Partial<ReceivableMilestone>, ReceivableProgressBilling[], boolean]> = [
    ["requested (emailed), no QBO", { qbInvoiceSentAt: D }, [], true],
    ["QBO live, never requested", { qbInvoiceId: "6059" }, [], true],
    ["requested and QBO live", { qbInvoiceId: "6059", qbInvoiceSentAt: D }, [], true],
    ["scheduled: no QBO, no request", {}, [], false],
    ["QBO voided, never requested", { qbInvoiceId: "6059", qbSyncError: "voided" }, [], false],
    ["QBO notFound, never requested", { qbInvoiceId: "6059", qbSyncError: "notFound" }, [], false],
    ["QBO pending-deletion marker, never requested", { qbInvoiceId: "6059", qbSyncError: "pending-deletion" }, [], false],
    ["QBO voided but was requested", { qbInvoiceId: "6059", qbSyncError: "voided", qbInvoiceSentAt: D }, [], true],
    ["QBO live with pay-link-missing marker", { qbInvoiceId: "6059", qbSyncError: "paylink-missing" }, [], true],
    ["paid", { status: "Paid", qbInvoiceId: "6059", qbInvoiceSentAt: D }, [], false],
    ["canceled", { status: "Canceled", qbInvoiceId: "6059", qbInvoiceSentAt: D }, [], false],
    ["processing", { status: "Processing", qbInvoiceId: "6059", qbInvoiceSentAt: D }, [], false],
    ["zero amount, requested", { amount: "0.00", qbInvoiceSentAt: D }, [], false],
    ["negative amount, requested", { amount: "-5.00", qbInvoiceSentAt: D }, [], false],
    ["rounds-to-zero amount, requested", { amount: "0.004", qbInvoiceSentAt: D }, [], false],
    ["covered by Staged live progress billing", {}, [pb()], true],
    ["covered by Sent live progress billing", {}, [pb({ status: "Sent", sentAt: D })], true],
    ["covered by Paid progress billing", {}, [pb({ status: "Paid" })], false],
    ["covered by Void progress billing", {}, [pb({ status: "Void" })], false],
    ["covered by Draft progress billing", {}, [pb({ status: "Draft" })], false],
    ["covered by billing with voided QBO", {}, [pb({ qbSyncError: "voided" })], false],
    ["covered by billing without a QBO invoice", {}, [pb({ qbInvoiceId: null })], false],
    ["covered by billing with pending-deletion marker", {}, [pb({ qbSyncError: "pending-deletion" })], false],
    ["billing covers a different milestone", {}, [pb({}, ["other"])], false],
    ["paid milestone on a live billing", { status: "Paid" }, [pb()], false],
    ["zero amount on a live billing", { amount: "0" }, [pb()], false],
];

for (const [name, over, pbs, expected] of cases) {
    test(`portal billed rule: ${name} -> ${expected}`, () => {
        const m = ms(over);
        const portal = billedMilestoneIds([m], pbs).includes(m.id);
        assert.equal(portal, expected);
        assert.equal(portal, digestBills(m, pbs), "portal must match the AR digest rule");
    });
}

test("portal billed rule: accepts serialized (string) dates", () => {
    assert.deepEqual(
        billedMilestoneIds([{ id: "a", amount: "5", status: "Pending", qbInvoiceSentAt: "2026-08-01T00:00:00.000Z" }], []),
        ["a"],
    );
    assert.deepEqual(billedMilestoneIds([{ id: "a", amount: "5", status: "Pending" }], []), []);
});

test("milestonePayLink: only for a billed Pending row with no sync-error marker", () => {
    const link = "https://pay.example/x";
    assert.equal(milestonePayLink({ status: "Pending", qbInvoiceLink: link, qbSyncError: null }, true), link);
    assert.equal(milestonePayLink({ status: "Pending", qbInvoiceLink: link, qbSyncError: "voided" }, true), null);
    assert.equal(milestonePayLink({ status: "Pending", qbInvoiceLink: link }, false), null, "unbilled row never gets a link");
    for (const status of ["Paid", "Canceled", "Processing"]) {
        assert.equal(milestonePayLink({ status, qbInvoiceLink: link }, true), null, `${status} row never gets a link`);
    }
    assert.equal(milestonePayLink({ status: "Pending", qbInvoiceLink: null }, true), null);
});
