import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentType } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReceiptQueueClient from "../src/app/manager/receipts/ReceiptQueueClient";
import ExpensesTab from "../src/app/projects/[id]/time-expenses/ExpensesTab";
import MoveToJobModal from "../src/app/projects/[id]/time-expenses/MoveToJobModal";
import { RECEIPT_EXPENSE_DOUBLE_NOTE } from "../src/lib/receipt-intake/booked-expense-rules";

const ImportedAwareReceiptQueueClient =
    ReceiptQueueClient as unknown as ComponentType<Record<string, unknown>>;

test("receipt audit surface renders QBO imports as finalized non-actionable records", () => {
    const markup = renderToStaticMarkup(createElement(ImportedAwareReceiptQueueClient, {
        expenses: [],
        projects: [],
        costCodes: [],
        importedExpenseCount: 142,
        importedExpenses: [{
            id: "expense-qbo-1",
            qbPurchaseId: "purchase-1",
            qbSyncedAt: "2026-07-29T12:00:00.000Z",
            description: "[QuickBooks import] Materials",
            amount: 321.45,
            vendor: "QBO UI Vendor",
            date: "2026-07-21T00:00:00.000Z",
            status: "Reviewed",
            estimate: {
                project: { id: "project-1", name: "Mueller Bathroom Remodel" },
            },
            costCode: null,
            createdAt: "2026-07-29T12:00:00.000Z",
        }],
    }));

    assert.match(markup, /Finalized in QuickBooks/);
    assert.match(markup, /QBO UI Vendor/);
    assert.match(markup, /\$321\.45/);
    assert.match(markup, /Mueller Bathroom Remodel/);
    assert.match(markup, /Showing 1 of 142/);
    assert.doesNotMatch(markup, />Approve</);
    assert.doesNotMatch(markup, />Reject</);
});

// ── receipt-booked guards, on the Time & Expenses tab (native-expense-guards-spec.md §6.6) ──

/** The `<tr>...</tr>` containing a marker string, so per-row assertions cannot cross rows. */
function rowContaining(markup: string, marker: string): string {
    const at = markup.indexOf(marker);
    assert.ok(at > -1, `"${marker}" not found in markup`);
    const start = markup.lastIndexOf("<tr", at);
    const end = markup.indexOf("</tr>", at) + "</tr>".length;
    assert.ok(start > -1 && end > "</tr>".length - 1, `no enclosing <tr> for "${marker}"`);
    return markup.slice(start, end);
}

test("ExpensesTab: a manual row keeps its Delete button and its upload control", () => {
    const markup = renderExpensesTab();
    const row = rowContaining(markup, "Manual Vendor");
    assert.match(row, /title="Delete"/);
    assert.match(row, /title="Upload receipt"/);
    assert.doesNotMatch(row, />Move to job</);
});

test("ExpensesTab: a receipt-booked row shows Move to job, and neither Delete nor Replace receipt", () => {
    const markup = renderExpensesTab();
    const row = rowContaining(markup, "Lowe&#x27;s");
    assert.match(row, />Move to job</);
    assert.doesNotMatch(row, /title="Delete"/);
    assert.doesNotMatch(row, /title="Replace receipt"/);
    assert.doesNotMatch(row, /title="Upload receipt"/);
    // The View-receipt link is unaffected — only the upload/replace control is hidden.
    assert.match(row, /title="View receipt"/);
});

test("ExpensesTab: the QBO row is unchanged — no Delete, no Move to job, upload control intact", () => {
    const markup = renderExpensesTab();
    const row = rowContaining(markup, "QBO Vendor");
    assert.match(row, /Finalized in QuickBooks/);
    assert.doesNotMatch(row, /title="Delete"/);
    assert.doesNotMatch(row, />Move to job</);
    assert.match(row, /title="Upload receipt"/, "QBO rows keep their existing upload control");
});

function renderExpensesTab(): string {
    const ImportedAwareExpensesTab = ExpensesTab as unknown as ComponentType<Record<string, unknown>>;
    return renderToStaticMarkup(createElement(ImportedAwareExpensesTab, {
        projectId: "job-1",
        onAddNew: () => {},
        currentUser: { id: "u1", role: "ADMIN", name: "Admin" },
        changeOrders: [],
        jobOptions: [
            { id: "job-1", name: "Mueller Remodel" },
            { id: "job-2", name: "Mesplay Kitchen" },
            { id: "shop-id", name: "Shop" },
        ],
        expenses: [
            {
                id: "exp-manual", amount: 100, vendor: "Manual Vendor", description: "Lumber",
                date: "2026-09-01T00:00:00.000Z", status: "Reviewed", receiptUrl: null,
                qbPurchaseId: null, costCode: null, costType: null, item: null, changeOrder: null,
                receiptIntake: null,
            },
            {
                id: "exp-receipt", amount: 146.32, vendor: "Lowe's", description: "Lowe's receipt",
                date: "2026-09-02T00:00:00.000Z", status: "Reviewed", receiptUrl: "https://cdn.test/receipt.pdf",
                qbPurchaseId: null, costCode: null, costType: null, item: null, changeOrder: null,
                receiptIntake: { id: "intake-1" },
            },
            {
                id: "exp-qbo", amount: 321.45, vendor: "QBO Vendor", description: "[QuickBooks import] Materials",
                date: "2026-09-03T00:00:00.000Z", status: "Reviewed", receiptUrl: null,
                qbPurchaseId: "purchase-1", costCode: null, costType: null, item: null, changeOrder: null,
                receiptIntake: null,
            },
        ],
    }));
}

test("MoveToJobModal: title, double note, Shop help, current job absent, Move disabled", () => {
    const ImportedAwareMoveToJobModal = MoveToJobModal as unknown as ComponentType<Record<string, unknown>>;
    const markup = renderToStaticMarkup(createElement(ImportedAwareMoveToJobModal, {
        expenseId: "exp-receipt",
        vendor: "Lowe's",
        amountLabel: "$146.32",
        dateLabel: "9/2/2026",
        changeOrderLabel: null,
        projectId: "job-1",
        jobOptions: [
            { id: "job-1", name: "Mueller Remodel" },
            { id: "job-2", name: "Mesplay Kitchen" },
            { id: "shop-id", name: "Shop" },
        ],
        onClose: () => {},
        onMoved: async () => {},
    }));

    assert.match(markup, />Move to another job</);
    // React escapes apostrophes as &#x27; when it serializes text content.
    const escapedNote = RECEIPT_EXPENSE_DOUBLE_NOTE
        .replace(/'/g, "&#x27;")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(markup, new RegExp(escapedNote));
    assert.match(markup, /Pick Shop if it isn&#x27;t a job cost\./);

    // The current job (job-1) is absent from the options; Shop is present.
    assert.doesNotMatch(markup, />Mueller Remodel</);
    assert.match(markup, />Mesplay Kitchen</);
    assert.match(markup, />Shop</);

    // Move is disabled until a job is picked.
    const moveAt = markup.indexOf(">Move<");
    assert.ok(moveAt > -1, "the Move button (not yet clicked, so not \"Moving…\") must render");
    const buttonStart = markup.lastIndexOf("<button", moveAt);
    assert.match(markup.slice(buttonStart, moveAt), /disabled/);
});
