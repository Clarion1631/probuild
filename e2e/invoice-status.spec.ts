import { test, expect } from "@playwright/test";
import { deriveInvoiceStatus, displayInvoiceStatus } from "../src/lib/invoice-lifecycle";

test.describe("canonical invoice status", () => {
    test("persists only the five canonical lifecycle states", () => {
        expect(deriveInvoiceStatus({ balanceDue: 100, paymentStatuses: ["Pending"] })).toBe("Draft");
        expect(deriveInvoiceStatus({ balanceDue: 100, issueDate: new Date(), paymentStatuses: ["Pending"] })).toBe("Issued");
        expect(deriveInvoiceStatus({ balanceDue: 50, issueDate: new Date(), paymentStatuses: ["Paid", "Pending"] })).toBe("Partially Paid");
        expect(deriveInvoiceStatus({ balanceDue: 0, issueDate: new Date(), paymentStatuses: ["Paid"] })).toBe("Paid");
        expect(deriveInvoiceStatus({ currentStatus: "Canceled", balanceDue: 100, issueDate: new Date(), paymentStatuses: ["Pending"] })).toBe("Canceled");
    });

    test("derives overdue only for reads and only after the full due day", () => {
        const now = new Date("2026-07-20T12:00:00.000Z");
        expect(displayInvoiceStatus({ status: "Issued", dueDates: [new Date("2026-07-18T00:00:00.000Z")], now })).toBe("Overdue");
        expect(displayInvoiceStatus({ status: "Issued", dueDates: [new Date("2026-07-20T00:00:00.000Z")], now })).toBe("Issued");
        expect(displayInvoiceStatus({ status: "Paid", dueDates: [new Date("2026-07-01T00:00:00.000Z")], now })).toBe("Paid");
    });
});
