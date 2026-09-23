/**
 * PR #533 (`isLiveQboLink`, src/lib/receivables.ts, not yet merged) counts a
 * progress billing as "live" QuickBooks evidence unless its `qbSyncError` is
 * `voided`/`notFound` — but the payments poller only ever persisted those
 * states onto PaymentSchedule (the milestone claim, quickbooks-payments.ts
 * ~3412). A progress billing voided in QuickBooks kept reading as live
 * evidence in ProBuild forever. These drive the REAL `syncQuickBooksPayments`
 * against a fake `progressBilling` table whose `updateMany` evaluates the
 * WHERE for real (mirrors the pattern in tests/progress-billing-stage.test.ts),
 * so the CAS's marker allowlist is actually exercised, not re-implemented.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRouteDeadline } from "../src/lib/quickbooks";
import {
    stageProgressBillingToQuickBooksCore,
    type ProgressBillingStageDb,
    type ProgressBillingStageQbo,
} from "../src/lib/progress-billing";
import {
    AMBIGUOUS_CREATE_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    PAYLINK_PENDING_MARKER,
    PAYLINK_MISSING_MARKER,
    PENDING_DELETION_MARKER,
    COMPENSATION_CLAIMED_PREFIX,
} from "../src/lib/qbo-create-markers";

type Row = Record<string, any>;

function billingRow(overrides: Row = {}): Row {
    return {
        id: "pb-1",
        invoiceId: "inv-1",
        qbInvoiceId: "qb-1",
        qbSyncError: null,
        status: "Staged",
        code: "INV-1-P1",
        lines: [],
        invoice: { code: "INV-1", estimateId: null },
        ...overrides,
    };
}

/**
 * Prisma WHERE semantics, as far as the persist CAS actually uses them (`in`,
 * `startsWith`, `OR`, plain equality — including `null`). Same shape as
 * tests/progress-billing-stage.test.ts's matcher, so a where clause this test
 * cannot evaluate is a signal the source drifted from what both were written
 * against, not a gap to silently paper over.
 */
function matchWhere(row: any, where: any): boolean {
    const matchOne = (rowValue: any, cond: any): boolean => {
        if (cond !== null && typeof cond === "object") {
            if ("in" in cond) return (cond as any).in.includes(rowValue);
            if ("not" in cond) return rowValue !== (cond as any).not;
            if ("startsWith" in cond) {
                return typeof rowValue === "string" && rowValue.startsWith((cond as any).startsWith);
            }
            throw new Error(`unsupported condition: ${JSON.stringify(cond)}`);
        }
        return rowValue === cond;
    };
    return Object.entries(where ?? {}).every(([k, v]) =>
        k === "OR"
            ? (v as any[]).some((clause) => matchWhere(row, clause))
            : matchOne(row[k], v));
}

/** In-memory ProgressBilling delegate: real WHERE matching, real count semantics. */
function makeBillingTable(rows: Row[], updateCalls: any[]) {
    return {
        async count(args: any) {
            const gt = args?.where?.id?.gt;
            return (gt ? rows.filter((r) => r.id > gt) : rows).length;
        },
        async findMany(args: any) {
            const gt = args?.where?.id?.gt;
            const list = gt ? rows.filter((r) => r.id > gt) : rows;
            return list.slice(0, args?.take ?? list.length).map((r) => ({ ...r }));
        },
        async updateMany(args: any) {
            updateCalls.push(args);
            const matches = rows.filter((r) => matchWhere(r, args.where));
            for (const row of matches) Object.assign(row, args.data);
            return { count: matches.length };
        },
    };
}

/**
 * Drives the real `syncQuickBooksPayments` over a fake `globalThis.prisma`,
 * same seam as tests/qbo-payments-outage.test.ts's round-35 gate (`makeMixedRailPrisma`):
 * src/lib/prisma.ts reads `globalThis.prisma` before building a real client.
 * No milestones — Part B's rows are all on the progress-billing rail.
 */
async function runPoller(
    billings: Row[],
    probeInvoice: (qbInvoiceId: string) => Promise<any>,
): Promise<{ result: any; updateCalls: any[] }> {
    const previousNextauth = process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET = "test-nextauth-secret";
    const { encryptObject } = await import("../src/lib/crypto");
    const settings = encryptObject({
        quickbooks: { connected: true, accessToken: "a", refreshToken: "r", realmId: "realm-1", serviceItemId: "7" },
    });

    const updateCalls: any[] = [];
    const noMilestones = {
        async count() { return 0; },
        async findMany() { return []; },
        async updateMany() { return { count: 0 }; },
    };
    const client = {
        integration: { async findUnique() { return { settings }; }, async upsert() { return {}; } },
        paymentSchedule: noMilestones,
        progressBilling: makeBillingTable(billings, updateCalls),
        automationEvent: { async create() { return {}; } },
    };

    const previousPrisma = (globalThis as any).prisma;
    const previousEnv = {
        mock: process.env.E2E_QBO_MOCK,
        playwright: process.env.PLAYWRIGHT_TEST_SECRET,
        vercel: process.env.VERCEL,
    };
    (globalThis as any).prisma = client;
    // Same E2E mock gate as the round-35 test: canned tokens, no network I/O,
    // so the preflight token refresh is not part of what this exercises.
    process.env.E2E_QBO_MOCK = "1";
    process.env.PLAYWRIGHT_TEST_SECRET = "pw";
    delete process.env.VERCEL;
    try {
        const { syncQuickBooksPayments } = await import("../src/lib/quickbooks-payments");
        const cursors = new Map<string, string>();
        const result = await syncQuickBooksPayments(undefined, {
            source: "cron",
            qboClient: {
                probeInvoice,
                async getPayment() { return null; },
                async verifyConnection() {},
            },
            cursorStore: {
                async get(key) { return cursors.get(key) ?? null; },
                async set(key, value) { cursors.set(key, value); },
            },
        });
        return { result, updateCalls };
    } finally {
        (globalThis as any).prisma = previousPrisma;
        for (const [key, value] of Object.entries({
            NEXTAUTH_SECRET: previousNextauth,
            E2E_QBO_MOCK: previousEnv.mock,
            PLAYWRIGHT_TEST_SECRET: previousEnv.playwright,
            VERCEL: previousEnv.vercel,
        })) {
            if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
            else (process.env as Record<string, string>)[key] = value;
        }
    }
}

test("voided is persisted onto a Staged billing with no prior marker, and the run still reports the error", async () => {
    const billings = [billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: null, status: "Staged" })];
    const { result, updateCalls } = await runPoller(billings, async () => ({ state: "voided" }));

    assert.equal(billings[0].qbSyncError, "voided");
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0].data, { qbSyncError: "voided" });
    assert.ok(
        result.errors.some((e: string) => e === "INV-1/INV-1-P1: QBO invoice voided"),
        "the run result must still list the error",
    );
});

test("notFound is persisted onto a Sent billing", async () => {
    const billings = [billingRow({ id: "pb-2", qbInvoiceId: "qb-2", qbSyncError: null, status: "Sent" })];
    const { updateCalls } = await runPoller(billings, async () => ({ state: "notFound" }));

    assert.equal(billings[0].qbSyncError, "notFound");
    assert.equal(updateCalls.length, 1);
});

test("a pay-link marker (bare, attempt-suffixed, or exhausted) is replaced by voided", async () => {
    const billings = [
        billingRow({ id: "pb-pending", qbInvoiceId: "qb-1", qbSyncError: PAYLINK_PENDING_MARKER, status: "Staged" }),
        billingRow({ id: "pb-pending-n", qbInvoiceId: "qb-2", qbSyncError: `${PAYLINK_PENDING_MARKER}:2`, status: "Staged" }),
        billingRow({ id: "pb-missing", qbInvoiceId: "qb-3", qbSyncError: PAYLINK_MISSING_MARKER, status: "Staged" }),
    ];
    await runPoller(billings, async () => ({ state: "voided" }));

    assert.equal(billings[0].qbSyncError, "voided", "bare paylink-pending");
    assert.equal(billings[1].qbSyncError, "voided", "paylink-pending:<n>");
    assert.equal(billings[2].qbSyncError, "voided", "paylink-missing");
});

test("already voided, probe voided again: no write at all", async () => {
    const billings = [billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: "voided", status: "Staged" })];
    const { updateCalls } = await runPoller(billings, async () => ({ state: "voided" }));

    assert.equal(updateCalls.length, 0);
    assert.equal(billings[0].qbSyncError, "voided");
});

test("voided is relabeled to notFound when the probe now disagrees", async () => {
    const billings = [billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: "voided", status: "Sent" })];
    const { updateCalls } = await runPoller(billings, async () => ({ state: "notFound" }));

    assert.equal(updateCalls.length, 1);
    assert.equal(billings[0].qbSyncError, "notFound");
});

test("a compensation claim, pending-deletion, ambiguous-create, or create-in-flight marker is never overwritten", async () => {
    const billings = [
        billingRow({ id: "pb-comp", qbInvoiceId: "qb-1", qbSyncError: `${COMPENSATION_CLAIMED_PREFIX}tok1`, status: "Staged" }),
        billingRow({ id: "pb-del", qbInvoiceId: "qb-2", qbSyncError: PENDING_DELETION_MARKER, status: "Staged" }),
        billingRow({ id: "pb-amb", qbInvoiceId: "qb-3", qbSyncError: AMBIGUOUS_CREATE_MARKER, status: "Sent" }),
        billingRow({ id: "pb-flight", qbInvoiceId: "qb-4", qbSyncError: CREATE_IN_FLIGHT_MARKER, status: "Staged" }),
    ];
    const originals = billings.map((b) => b.qbSyncError);
    await runPoller(billings, async () => ({ state: "voided" }));

    billings.forEach((b, i) => assert.equal(b.qbSyncError, originals[i], `${b.id} must be untouched`));
});

test("probe ok never writes qbSyncError (regression)", async () => {
    const billings = [billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: null, status: "Staged" })];
    const { updateCalls } = await runPoller(billings, async () => ({ state: "ok", balance: 5, total: 10, paymentTxnIds: [] }));

    assert.equal(updateCalls.length, 0);
    assert.equal(billings[0].qbSyncError, null);
});

// --- Re-push safety --------------------------------------------------------

test("re-push safety: a Staged billing carrying a persisted voided marker still refuses staging and never calls QuickBooks", async () => {
    // stageProgressBillingToQuickBooksCore's entry guard refuses ANY billing
    // whose status is not Draft, before it ever looks at qbSyncError or calls
    // QuickBooks — this pins that a persisted 'voided' cannot open a hole in
    // it. Same injectable-deps idiom as tests/progress-billing-stage.test.ts.
    const row = {
        id: "pb-1",
        code: "INV-00171-P1",
        description: "Rough-in complete",
        status: "Staged",
        subtotal: 1000,
        taxAmount: 89,
        total: 1089,
        qbInvoiceId: "qb-9",
        qbInvoiceLink: "https://pay.example/qb-9",
        qbSyncedAt: new Date(),
        qbSyncError: "voided",
        invoice: {
            id: "inv-1",
            code: "INV-00171",
            clientId: "client-1",
            client: { id: "client-1", name: "Mesplay", email: "c@example.com", qbCustomerId: "42" },
        },
    };
    const db: ProgressBillingStageDb = {
        async findUnique() { return { ...row }; },
        async updateMany() { throw new Error("must not write — the row must be refused before any write"); },
    };
    const created: any[] = [];
    const qbo: ProgressBillingStageQbo = {
        async getTokens() { throw new Error("must not fetch tokens"); },
        async resolveCustomerAndItem() { throw new Error("must not resolve the customer"); },
        async createInvoice(_t, input) { created.push(input); throw new Error("must not create"); },
        async getPaymentLink() { throw new Error("must not fetch a pay link"); },
        async deleteInvoice() { throw new Error("must not delete"); },
    };
    const logEvent = (async () => {}) as any;

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", createRouteDeadline(30_000), { db, qbo, logEvent }),
        (e: unknown) => e instanceof Error
            && e.message === 'This billing is "Staged" — only Draft billings can be staged to QuickBooks',
    );
    assert.equal(created.length, 0, "the QuickBooks create must never be reached");
});
