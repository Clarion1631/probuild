/**
 * A parked row is not an unlinked row.
 *
 * Codex gate follow-up: `qbSyncError = "create-in-flight" | "ambiguous-create"`
 * means an invoice MAY already exist in QuickBooks while `qbInvoiceId` is still
 * null. Every money guard that only asked "is there a qbInvoiceId?" therefore
 * let such a row be deleted, repriced, re-split or swept into a progress
 * billing — each of which abandons or contradicts an invoice the client can
 * still pay.
 *
 * `isQboInvoiceLinkedOrPending` is the one predicate they all share now. These
 * tests drive the real cores (no database: src/lib/prisma.ts reads
 * globalThis.prisma before it builds a client), plus a source tripwire so a new
 * bare-`qbInvoiceId` guard can't quietly reopen the hole.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    isQboInvoiceLinkedOrPending,
    isBlockedByAmbiguousCreate,
    QBResolveRequiredError,
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    PAYLINK_PENDING_MARKER,
} from "../src/lib/qbo-create-markers";

test("the shared predicate treats a parked row as linked", () => {
    const linked = { qbInvoiceId: "qb-1", qbSyncError: null };
    const parked = { qbInvoiceId: null, qbSyncError: AMBIGUOUS_CREATE_MARKER };
    const inFlight = { qbInvoiceId: null, qbSyncError: CREATE_IN_FLIGHT_MARKER };
    const clean = { qbInvoiceId: null, qbSyncError: null };
    // paylink-pending rows ARE linked — they carry an id — so the marker itself
    // must not be treated as "may exist".
    const pendingLink = { qbInvoiceId: "qb-2", qbSyncError: PAYLINK_PENDING_MARKER };

    assert.equal(isQboInvoiceLinkedOrPending(linked), true);
    assert.equal(isQboInvoiceLinkedOrPending(parked), true);
    assert.equal(isQboInvoiceLinkedOrPending(inFlight), true);
    assert.equal(isQboInvoiceLinkedOrPending(pendingLink), true);
    assert.equal(isQboInvoiceLinkedOrPending(clean), false);
    assert.equal(isBlockedByAmbiguousCreate({ qbSyncError: PAYLINK_PENDING_MARKER }), false);
});

/** Run `fn` with globalThis.prisma swapped for a fake. */
async function withFakePrisma<T>(fake: any, fn: () => Promise<T>): Promise<T> {
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = fake;
    try {
        return await fn();
    } finally {
        (globalThis as any).prisma = previous;
    }
}

test("deleting a parked milestone is refused, and the row survives", async () => {
    const { deleteInvoiceMilestoneCore } = await import("../src/lib/billing-core");
    const parked = {
        id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending",
        amount: 1000, sourceScheduleId: null, qbInvoiceId: null,
        qbSyncError: AMBIGUOUS_CREATE_MARKER, stripeSessionId: null, stripePaymentIntentId: null,
    };
    let deleted = false;
    const tx = {
        paymentSchedule: {
            async findUnique() { return { ...parked }; },
            async delete() { deleted = true; return parked; },
        },
        invoice: { async findUnique() { return { id: "inv-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; } },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => deleteInvoiceMilestoneCore("ps-1"),
            (e: unknown) => e instanceof QBResolveRequiredError,
        );
    });
    assert.equal(deleted, false);
});

test("a parked milestone cannot be swept into a progress billing", async () => {
    const { createProgressBillingCore } = await import("../src/lib/progress-billing");
    const parked = {
        id: "ps-1", invoiceId: "inv-1", name: "Rough-in", status: "Pending",
        amount: 1000, sourceScheduleId: null, qbInvoiceId: null,
        qbSyncError: CREATE_IN_FLIGHT_MARKER, stripeSessionId: null, stripePaymentIntentId: null,
    };
    const tx = {
        invoice: {
            async findUnique(args: any) {
                if (args.select?.estimateId) return { estimateId: null };
                return { id: "inv-1", code: "INV-1", taxRate: 8.9, status: "Sent", totalAmount: 1000, balanceDue: 1000 };
            },
        },
        estimate: { async findUnique() { return null; } },
        paymentSchedule: {
            async findUnique() { return { ...parked }; },
            async updateMany() { throw new Error("must not claim a parked milestone"); },
            async create() { throw new Error("must not split a parked milestone"); },
        },
        progressBillingLine: { async findMany() { return []; } },
        progressBilling: { async findMany() { return []; } },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => createProgressBillingCore("inv-1", {
                description: "Rough-in complete",
                lines: [{ scheduleId: "ps-1", description: "Rough-in", amount: 1000 }],
            }),
            (e: unknown) => e instanceof QBResolveRequiredError,
        );
    });
});

test("a parked progress billing cannot be edited", async () => {
    // Round 29 gate: updateProgressBillingCore only checked status/qbInvoiceId,
    // so an ambiguous row (still Draft, still qbInvoiceId: null) could be
    // edited while QuickBooks may already hold a real invoice for the OLD
    // content.
    const { updateProgressBillingCore } = await import("../src/lib/progress-billing");
    const parked = {
        id: "pb-1", invoiceId: "inv-1", code: "INV-1-P1", status: "Draft",
        description: "Rough-in complete", taxExempt: false,
        qbInvoiceId: null, qbSyncError: AMBIGUOUS_CREATE_MARKER,
    };
    let updated = false;
    const tx = {
        progressBilling: {
            async findUnique(args: any) {
                if (args.select?.invoiceId) return { invoiceId: "inv-1" };
                return { ...parked };
            },
            async update() { updated = true; return parked; },
        },
        invoice: { async findUnique() { return { id: "inv-1", totalAmount: 1000, balanceDue: 1000, status: "Sent" }; } },
        $queryRaw: async () => [],
    };

    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        await assert.rejects(
            () => updateProgressBillingCore("pb-1", { description: "Rough-in complete (revised)" }),
            (e: unknown) => e instanceof QBResolveRequiredError,
        );
    });
    assert.equal(updated, false, "the parked row must survive unedited");
});

// --- Source tripwire -------------------------------------------------------

/**
 * Every place that decides something from `qbInvoiceId` must also account for
 * the pending-create markers. Deliberate exceptions are listed here WITH a
 * reason, so adding one is a visible choice rather than an omission.
 */
const ALLOWED_BARE_QB_INVOICE_ID: { file: string; line: string; why: string }[] = [
    {
        file: "src/lib/billing-core.ts",
        line: "if (res.qbInvoiceId) {",
        why: "reads the RESULT of a push that just succeeded — not a guard on stored state",
    },
    {
        file: "src/lib/billing-core.ts",
        line: "if (qbInvoiceId) {",
        why: "local variable holding the id this loop just pushed — not a guard on stored state",
    },
];

const MARKER_TOKENS = [
    "isQboInvoiceLinkedOrPending",
    "isBlockedByAmbiguousCreate",
    "PENDING_CREATE_MARKERS",
    "CREATE_IN_FLIGHT_MARKER",
    "AMBIGUOUS_CREATE_MARKER",
    "PAYLINK_PENDING_MARKER",
    "qbSyncError",
];

test("no money guard reads qbInvoiceId without accounting for the pending markers", () => {
    const files = [
        "src/lib/billing-core.ts",
        "src/lib/progress-billing.ts",
        "src/lib/actions.ts",
        "src/lib/quickbooks-payments.ts",
    ];
    const WINDOW = 25;
    const offenders: string[] = [];

    for (const file of files) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((raw, index) => {
            const line = raw.trim();
            const isGuard = /^if \([A-Za-z_.]*\.?qbInvoiceId\)/.test(line) || /qbInvoiceId: null[,}]?$/.test(line);
            if (!isGuard) return;
            if (ALLOWED_BARE_QB_INVOICE_ID.some((a) => a.file === file && a.line === line)) return;
            const window = lines.slice(Math.max(0, index - WINDOW), index + WINDOW).join("\n");
            if (!MARKER_TOKENS.some((token) => window.includes(token))) {
                offenders.push(`${file}:${index + 1}  ${line}`);
            }
        });
    }

    assert.deepEqual(
        offenders,
        [],
        `these read qbInvoiceId with no pending-create marker in sight — a parked row would slip through:\n${offenders.join("\n")}`,
    );
});
