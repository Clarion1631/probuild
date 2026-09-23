/**
 * Pins the shared receivable query (src/lib/receivables.ts) against literals
 * written out independently here, not built from the constants themselves.
 *
 * The fakes in the AR test suites return their fixture rows regardless of
 * what `where`/`select` the code under test actually sent (Codex round-1
 * finding) — so a regression that silently narrowed or widened
 * RECEIVABLE_INVOICE_WHERE or RECEIVABLE_INVOICE_SELECT could still pass
 * every fixture-parity test. This file is the guard for that gap: it checks
 * the constants' own shape, independent of any fake. The AR digest
 * (src/lib/billing-core.ts), the Open Invoices report
 * (src/lib/open-invoices-report.ts), and the company-financials AR aging
 * chart (src/lib/company-financials-charts.ts) all select their rows through
 * these two constants.
 *
 * src/lib/receivables.ts has no Prisma import at runtime (only a type-only
 * one), so it's imported directly, unpatched — same as tests/receivables.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RECEIVABLE_INVOICE_WHERE, RECEIVABLE_INVOICE_SELECT } from "../src/lib/receivables";

test("RECEIVABLE_INVOICE_WHERE matches its literal shape", () => {
    assert.deepStrictEqual(
        RECEIVABLE_INVOICE_WHERE,
        {
            status: { not: "Canceled" },
            OR: [
                { balanceDue: { gt: 0 } },
                { payments: { some: { status: "Pending" } } },
                { progressBillings: { some: { status: { in: ["Staged", "Sent"] } } } },
            ],
        },
        "RECEIVABLE_INVOICE_WHERE changed shape — the AR digest, Open Invoices, and the AR chart all select their rows through this constant and must be re-verified together",
    );
});

test("RECEIVABLE_INVOICE_SELECT matches its literal shape", () => {
    assert.deepStrictEqual(
        RECEIVABLE_INVOICE_SELECT,
        {
            status: true, balanceDue: true,
            issueDate: true, sentAt: true, createdAt: true,
            _count: { select: { payments: true } },
            payments: {
                where: { status: "Pending" },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true, name: true, amount: true, status: true, dueDate: true, createdAt: true,
                    qbInvoiceId: true, qbInvoiceSentAt: true, qbSyncError: true, qbSyncedAt: true,
                },
            },
            progressBillings: {
                where: { status: { in: ["Staged", "Sent"] } },
                select: {
                    id: true, code: true, status: true,
                    qbInvoiceId: true, qbSyncError: true, qbSyncedAt: true, qbInvoiceSentAt: true, sentAt: true, createdAt: true,
                    lines: { select: { scheduleId: true } },
                },
            },
        },
        "RECEIVABLE_INVOICE_SELECT changed shape — the AR digest, Open Invoices, and the AR chart all select their rows through this constant and must be re-verified together",
    );
});
