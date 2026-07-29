import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentType } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReceiptQueueClient from "../src/app/manager/receipts/ReceiptQueueClient";

const ImportedAwareReceiptQueueClient =
    ReceiptQueueClient as unknown as ComponentType<Record<string, unknown>>;

test("receipt audit surface renders QBO imports as finalized non-actionable records", () => {
    const markup = renderToStaticMarkup(createElement(ImportedAwareReceiptQueueClient, {
        expenses: [],
        projects: [],
        costCodes: [],
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
    assert.doesNotMatch(markup, />Approve</);
    assert.doesNotMatch(markup, />Reject</);
});
