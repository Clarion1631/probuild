import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentType } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReceiptQueueClient from "../src/app/manager/receipts/ReceiptQueueClient";
import ExpensesTab from "../src/app/projects/[id]/time-expenses/ExpensesTab";

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
                project: { id: "project-1", name: "Sample Job C" },
            },
            costCode: null,
            createdAt: "2026-07-29T12:00:00.000Z",
        }],
    }));

    assert.match(markup, /Finalized in QuickBooks/);
    assert.match(markup, /QBO UI Vendor/);
    assert.match(markup, /\$321\.45/);
    assert.match(markup, /Sample Job C/);
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

// `moveReceiptExpenseToJob` and `getExpenses` are server actions ExpensesTab
// imports directly (no DI seam), so a real click-through of Move cannot be
// exercised here without either a live DB or Node's flagged module-mock API
// (neither available to this suite's plain `tsx --test` invocation). Pin the
// wiring by source instead — same approach as the costCodes-scoping test
// below via TimeExpensesClient.tsx.
test("ExpensesTab: onMoved drops the moved expense from selectedIds, so Tag selected can't reach it", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src/app/projects/[id]/time-expenses/ExpensesTab.tsx"),
        "utf8",
    );
    const onMovedAt = source.indexOf("onMoved={");
    assert.ok(onMovedAt > -1, "ExpensesTab must wire an onMoved handler to MoveToJobModal");
    const onMovedBlock = source.slice(onMovedAt, source.indexOf("\n            )}", onMovedAt));
    assert.match(onMovedBlock, /setSelectedIds/, "onMoved must update selectedIds, not just refresh");
    assert.match(onMovedBlock, /moveTarget\.id/, "it must target the specific moved expense's id");
    assert.match(onMovedBlock, /\.delete\(/, "it must remove the id (not clear or re-add it)");
});

function renderExpensesTab(): string {
    const ImportedAwareExpensesTab = ExpensesTab as unknown as ComponentType<Record<string, unknown>>;
    return renderToStaticMarkup(createElement(ImportedAwareExpensesTab, {
        projectId: "job-1",
        onAddNew: () => {},
        currentUser: { id: "u1", role: "ADMIN", name: "Admin" },
        changeOrders: [],
        jobOptions: [
            { id: "job-1", name: "Sample Job A" },
            { id: "job-2", name: "Sample Job B" },
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

// MoveToJobModal's own rendering tests moved to tests/move-to-job-modal.test.tsx
// (Codex xhigh post-merge review of #534, R2/R3: it moved onto Radix Dialog for
// a real focus trap and inert background). That file exists ONLY because of a
// hard ordering constraint: @radix-ui/react-use-layout-effect decides, once,
// at module-IMPORT time, whether `globalThis.document` exists yet -- if not,
// it permanently falls back to a no-op for the rest of this process, and no
// jsdom global swapped in afterward can undo that. This file's own top-level
// `import ExpensesTab` pulls in MoveToJobModal (and so Radix) before any test
// here runs, in the plain Node environment with no document at all, so a
// dialog test placed here would silently render nothing forever. The dedicated
// file establishes a real jsdom `document` before MoveToJobModal is ever
// imported (dynamically, specifically so nothing else can load it first).
