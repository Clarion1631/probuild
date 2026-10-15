/**
 * Pure tests for the "New change order" estimate picker ordering and billing
 * target. Hermetic: no database, no network. Names are generic (public repo).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    buildChangeOrderEstimateOptions,
    type ChangeOrderEstimateRow,
} from "../src/lib/change-order-estimate-options";

function row(
    id: string,
    over: { status?: string; created?: string; invoice?: [string, string] } = {},
): ChangeOrderEstimateRow {
    return {
        id,
        code: `EST-${id}`,
        title: `Estimate ${id}`,
        status: over.status ?? "Draft",
        createdAt: new Date(over.created ?? "2026-01-01T00:00:00Z"),
        newestInvoice: over.invoice ? { code: over.invoice[0], createdAt: new Date(over.invoice[1]) } : null,
    };
}

test("empty input gives no options and a null default", () => {
    const out = buildChangeOrderEstimateOptions([], { code: "INV-1" });
    assert.deepEqual(out.options, []);
    assert.equal(out.defaultEstimateId, null);
});

test("the estimate with its own invoice is the default even when a newer estimate has none", () => {
    const rows = [
        row("newer-approved", { status: "Approved", created: "2026-03-01T00:00:00Z" }),
        row("newer-draft", { created: "2026-04-01T00:00:00Z" }),
        row("main", { status: "Approved", created: "2026-01-01T00:00:00Z", invoice: ["INV-1", "2026-02-01T00:00:00Z"] }),
    ];
    const out = buildChangeOrderEstimateOptions(rows, { code: "INV-1" });
    assert.equal(out.defaultEstimateId, "main");
    assert.deepEqual(out.options.map((o) => o.id), ["main", "newer-approved", "newer-draft"]);
});

test("two invoiced estimates: the newer invoice wins", () => {
    const rows = [
        row("a", { invoice: ["INV-1", "2026-02-01T00:00:00Z"], created: "2026-05-01T00:00:00Z" }),
        row("b", { invoice: ["INV-2", "2026-03-01T00:00:00Z"], created: "2026-01-01T00:00:00Z" }),
    ];
    const out = buildChangeOrderEstimateOptions(rows, { code: "INV-2" });
    assert.deepEqual(out.options.map((o) => o.id), ["b", "a"]);
    assert.equal(out.defaultEstimateId, "b");
});

test("no invoices: newest Approved beats a newer non-Approved; newest wins among non-Approved", () => {
    const rows = [
        row("draft-old", { created: "2026-01-01T00:00:00Z" }),
        row("sent-new", { status: "Sent", created: "2026-04-01T00:00:00Z" }),
        row("approved-old", { status: "Approved", created: "2026-02-01T00:00:00Z" }),
        row("approved-newer", { status: "Approved", created: "2026-03-01T00:00:00Z" }),
    ];
    const out = buildChangeOrderEstimateOptions(rows, null);
    assert.deepEqual(out.options.map((o) => o.id), ["approved-newer", "approved-old", "sent-new", "draft-old"]);
    assert.equal(out.defaultEstimateId, "approved-newer");
});

test("billsTo uses own invoice, else project fallback, else null", () => {
    const rows = [
        row("own", { invoice: ["INV-7", "2026-02-01T00:00:00Z"] }),
        row("none", { created: "2026-02-01T00:00:00Z" }),
    ];
    const withProject = buildChangeOrderEstimateOptions(rows, { code: "INV-9" });
    const own = withProject.options.find((o) => o.id === "own")!;
    const none = withProject.options.find((o) => o.id === "none")!;
    assert.equal(own.invoiceCode, "INV-7");
    assert.equal(own.billsToInvoiceCode, "INV-7");
    assert.equal(own.billsToProjectFallback, false);
    assert.equal(none.invoiceCode, null);
    assert.equal(none.billsToInvoiceCode, "INV-9");
    assert.equal(none.billsToProjectFallback, true);

    const noProject = buildChangeOrderEstimateOptions(rows, null);
    const bare = noProject.options.find((o) => o.id === "none")!;
    assert.equal(bare.billsToInvoiceCode, null);
    assert.equal(bare.billsToProjectFallback, false);
});

test("ties break deterministically and the input array is not mutated", () => {
    const rows = [row("b"), row("a")];
    const snapshot = rows.map((r) => r.id);
    const out = buildChangeOrderEstimateOptions(rows, null);
    assert.deepEqual(rows.map((r) => r.id), snapshot);
    assert.deepEqual(out.options.map((o) => o.id), ["a", "b"]);
});
