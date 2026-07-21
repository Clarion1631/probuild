import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveInvoiceStatus, displayInvoiceStatus } from "../src/lib/invoice-lifecycle";
import { invoiceLifecycleMetrics } from "../src/lib/billing-core";

test.describe("canonical invoice status", () => {
    test("persists only the five canonical lifecycle states", () => {
        expect(deriveInvoiceStatus({ balanceDue: 100, paymentStatuses: ["Pending"] })).toBe("Draft");
        expect(deriveInvoiceStatus({ balanceDue: 100, issueDate: new Date(), paymentStatuses: ["Pending"] })).toBe("Issued");
        expect(deriveInvoiceStatus({ balanceDue: 50, issueDate: new Date(), paymentStatuses: ["Paid", "Pending"] })).toBe("Partially Paid");
        expect(deriveInvoiceStatus({ balanceDue: 50, totalAmount: 100, issueDate: new Date(), paymentStatuses: ["Pending"] })).toBe("Partially Paid");
        expect(deriveInvoiceStatus({ balanceDue: 0, issueDate: new Date(), paymentStatuses: ["Paid"] })).toBe("Paid");
        expect(deriveInvoiceStatus({ currentStatus: "Canceled", balanceDue: 100, issueDate: new Date(), paymentStatuses: ["Pending"] })).toBe("Canceled");
    });

    test("derives overdue only for reads and only after the full due day", () => {
        const now = new Date("2026-07-20T12:00:00.000Z");
        expect(displayInvoiceStatus({ status: "Issued", dueDates: [new Date("2026-07-18T00:00:00.000Z")], now })).toBe("Overdue");
        expect(displayInvoiceStatus({ status: "Issued", dueDates: [new Date("2026-07-20T00:00:00.000Z")], now })).toBe("Issued");
        expect(displayInvoiceStatus({ status: "Paid", dueDates: [new Date("2026-07-01T00:00:00.000Z")], now })).toBe("Paid");
        expect(displayInvoiceStatus({
            status: "Issued",
            payments: [{ status: "Canceled", dueDate: new Date("2026-07-01T00:00:00.000Z") }],
            now,
        })).toBe("Issued");
    });

    test("lifecycle radar requires a durable send attempt and exposes day counters", () => {
        expect(invoiceLifecycleMetrics(
            null,
            new Date("2026-07-18T12:00:00.000Z"),
            new Date("2026-07-19T12:00:00.000Z"),
            new Date("2026-07-20T12:00:00.000Z").getTime(),
        )).toMatchObject({ lifecycleBucket: "Not sent", daysSinceViewed: 1 });
        expect(invoiceLifecycleMetrics(
            { status: "delivered", sentAt: new Date("2026-07-15T12:00:00.000Z"), deliveredAt: new Date("2026-07-15T12:01:00.000Z"), lastError: null },
            new Date("2026-07-18T12:00:00.000Z"),
            new Date("2026-07-19T12:00:00.000Z"),
            new Date("2026-07-20T12:00:00.000Z").getTime(),
        )).toMatchObject({ lifecycleBucket: "Viewed not paid", daysSinceSent: 5, daysSinceFirstViewed: 2, daysSinceViewed: 1 });
    });

    test("the additive migration is atomic and backfills partial payment from balances", () => {
        const migration = readFileSync(resolve(__dirname, "..", "scripts", "apply-invoice-lifecycle.mjs"), "utf8");
        expect(migration).toContain("prisma.$transaction");
        expect(migration).toContain('"balanceDue" > 0 AND "balanceDue" < "totalAmount"');
        expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
        expect(migration).toContain("QBO_LEGACY_REALM_ID");
        expect(migration).toContain('SET "qbRealmId" = ${legacyQboRealmId}');
        expect(migration).not.toContain('SET "firstViewedAt"');

        const importer = readFileSync(resolve(__dirname, "..", "scripts", "import-houzz.mjs"), "utf8");
        expect(importer).toContain('"Partially Paid"');
    });
});
