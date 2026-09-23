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
 *
 * Round-2 fix: `findMany`/`count` used to ignore `where` and `select`
 * entirely and hand the row handler every field on every row regardless of
 * what the production query actually asked for — so removing `qbSyncError`
 * from `billingSelect`, or narrowing `billingWhere`, would have passed here
 * silently. Both now run through the same generic `matchWhere`/`project`
 * used by `updateMany`, and new cases pin the CAS's two race protections
 * (the link or status changing between the read and the write) and the
 * per-row error path when the write itself fails.
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
 * Prisma WHERE semantics, as far as the poller's queries against
 * `progressBilling` actually use them: equality (including `null`), `in`,
 * `not`, `startsWith`, `OR`, `gt`/`lte` (the `id` cursor pagination
 * `count`/`findMany` send), and one level of nested relation object (a
 * project-scoped run's `invoice: { projectId: ... }`, matched against the
 * row's `invoice`). Same shape as tests/progress-billing-stage.test.ts's
 * matcher plus the cursor/relation forms this file's `count`/`findMany` also
 * need. Throws on anything else, so a where clause this test cannot evaluate
 * is a signal the source drifted from what both were written against, not a
 * gap to silently paper over.
 */
/** The only operator keys this matcher understands. */
const SUPPORTED_OPERATORS = new Set(["in", "not", "startsWith", "gt", "lte"]);

function matchWhere(row: any, where: any): boolean {
    const matchOne = (rowValue: any, cond: any): boolean => {
        if (cond === null || typeof cond !== "object") return rowValue === cond;
        const keys = Object.keys(cond);
        const isOperatorObject = keys.some((key) => SUPPORTED_OPERATORS.has(key));
        if (isOperatorObject) {
            // Every key must be one this matcher understands — a condition
            // mixing a supported operator with an unsupported one used to
            // fall through whichever branch matched first and silently
            // ignore the rest.
            const unsupported = keys.filter((key) => !SUPPORTED_OPERATORS.has(key));
            if (unsupported.length > 0) {
                throw new Error(`unsupported condition: ${JSON.stringify(cond)}`);
            }
            // All present operators evaluated together (AND), not "whichever
            // is checked first wins" — a condition combining e.g. `in` and
            // `gt` used to have one silently ignored.
            return keys.every((key) => {
                if (key === "in") return (cond.in as unknown[]).includes(rowValue);
                if (key === "not") {
                    // Only a primitive or null is a real equality check; an
                    // object here used to become `rowValue !== someObject`,
                    // object-identity inequality, which is true for almost
                    // any `rowValue` — silently passing a condition this
                    // matcher cannot actually evaluate.
                    const not = cond.not;
                    if (not !== null && typeof not === "object") {
                        throw new Error(`unsupported condition: ${JSON.stringify(cond)}`);
                    }
                    return rowValue !== not;
                }
                if (key === "startsWith") {
                    return typeof rowValue === "string" && rowValue.startsWith(cond.startsWith);
                }
                if (key === "gt") return rowValue > cond.gt;
                // key === "lte"
                return rowValue <= cond.lte;
            });
        }
        if (rowValue !== null && typeof rowValue === "object" && !Array.isArray(rowValue)) {
            // Nested relation predicate, e.g. `invoice: { projectId: "..." }` —
            // recurse the same matcher against the related row.
            return matchWhere(rowValue, cond);
        }
        throw new Error(`unsupported condition: ${JSON.stringify(cond)}`);
    };
    return Object.entries(where ?? {}).every(([k, v]) =>
        k === "OR"
            ? (v as any[]).some((clause) => matchWhere(row, clause))
            : matchOne(row[k], v));
}

/** Applies a Prisma `select` (including one level of nested `{ select }`) to a row. */
function project(row: any, select?: Record<string, any>): any {
    if (!select) return { ...row };
    const out: any = {};
    for (const [key, spec] of Object.entries(select)) {
        if (spec === true) {
            out[key] = row[key];
        } else if (spec && typeof spec === "object" && "select" in (spec as any)) {
            const value = row[key];
            const nestedSelect = (spec as any).select;
            out[key] = Array.isArray(value)
                ? value.map((v: any) => project(v, nestedSelect))
                : (value == null ? value : project(value, nestedSelect));
        }
    }
    return out;
}

/**
 * In-memory ProgressBilling delegate: `count`/`findMany` evaluate the real
 * `where` and honor `select` (round-2 fix — they used to hand back every
 * field on every row regardless of what was asked for); `updateMany`
 * evaluates `where` for real and applies real count semantics.
 * `opts.failWhereIdIs` makes `updateMany` throw for the one billing whose
 * `where.id` matches it (checked after the call is recorded, before any row
 * is touched) — used to pin the per-row error path below.
 */
function makeBillingTable(rows: Row[], updateCalls: any[], opts?: { failWhereIdIs?: string }) {
    return {
        async count(args: any) {
            return rows.filter((r) => matchWhere(r, args?.where)).length;
        },
        async findMany(args: any) {
            const matched = rows.filter((r) => matchWhere(r, args?.where));
            return matched.slice(0, args?.take ?? matched.length).map((r) => project(r, args?.select));
        },
        async updateMany(args: any) {
            updateCalls.push(args);
            if (opts?.failWhereIdIs && args.where?.id === opts.failWhereIdIs) {
                throw new Error("database unavailable");
            }
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
    tableOpts?: { failWhereIdIs?: string },
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
        progressBilling: makeBillingTable(billings, updateCalls, tableOpts),
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

// --- CAS protections ---------------------------------------------------------

test("CAS protection: the link changing during the probe makes the write match zero rows", async () => {
    const billings = [billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: null, status: "Staged" })];
    const { updateCalls } = await runPoller(billings, async () => {
        // A concurrent writer re-links this billing to a different QBO invoice
        // after the row was read (findMany already handed "qb-1" to the row
        // handler) but before the CAS write below runs.
        billings[0].qbInvoiceId = "qb-9-different";
        return { state: "voided" };
    });

    assert.equal(updateCalls.length, 1, "the CAS is still attempted");
    assert.equal(updateCalls[0].where.qbInvoiceId, "qb-1", "pinned to the link the probe actually checked");
    assert.equal(billings[0].qbInvoiceId, "qb-9-different", "the row keeps its new link");
    assert.equal(billings[0].qbSyncError, null, "the stale-link CAS matched zero rows and left qbSyncError alone");
});

test("CAS protection: the status changing to Paid during the probe makes the write match zero rows", async () => {
    const billings = [billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: null, status: "Staged" })];
    const { updateCalls } = await runPoller(billings, async () => {
        // A settlement landed on this billing while the probe was in flight.
        billings[0].status = "Paid";
        return { state: "voided" };
    });

    assert.equal(updateCalls.length, 1, "the CAS is still attempted");
    assert.equal(billings[0].status, "Paid", "the row keeps its new status");
    assert.equal(billings[0].qbSyncError, null, "the stale-status CAS matched zero rows and left qbSyncError alone");
});

test("one billing's updateMany failing still reports its error and lets another billing in the run persist", async () => {
    const billings = [
        billingRow({ id: "pb-1", qbInvoiceId: "qb-1", qbSyncError: null, status: "Staged", code: "INV-1-P1", invoice: { code: "INV-1", estimateId: null } }),
        billingRow({ id: "pb-2", qbInvoiceId: "qb-2", qbSyncError: null, status: "Staged", code: "INV-2-P1", invoice: { code: "INV-2", estimateId: null } }),
    ];
    const { result, updateCalls } = await runPoller(
        billings,
        async () => ({ state: "voided" }),
        { failWhereIdIs: "pb-1" },
    );

    assert.equal(updateCalls.length, 2, "both billings were attempted");
    assert.equal(billings[0].qbSyncError, null, "pb-1's write failed — its row is untouched");
    assert.equal(billings[1].qbSyncError, "voided", "pb-2 in the same run is still processed and persisted");
    // runQboRowLoop's onRowError formats a thrown row error as "<invoice
    // code>/<billing code>: <message>" — the normal "QBO invoice voided" push
    // never runs for pb-1, since the throw unwinds out of the row handler
    // before reaching it.
    assert.ok(
        result.errors.includes("INV-1/INV-1-P1: database unavailable"),
        "the failed billing's row error is recorded",
    );
    assert.ok(
        result.errors.includes("INV-2/INV-2-P1: QBO invoice voided"),
        "the other billing's normal error is still recorded",
    );
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

// --- R3-1: the pay-link write pins the marker it read -----------------------

/**
 * A Draft billing about to be staged, in the same shape
 * `tests/progress-billing-stage.test.ts`'s `draftRow` uses — the stage core
 * reads `invoice.clientId` and `invoice.client.qbCustomerId` off it.
 */
function stageDraftRow(overrides: Row = {}): Row {
    return {
        id: "pb-1",
        code: "INV-00171-P1",
        description: "Rough-in complete",
        status: "Draft",
        subtotal: 1000,
        taxAmount: 89,
        total: 1089,
        qbInvoiceId: null,
        qbInvoiceLink: null,
        qbSyncedAt: null,
        qbSyncError: null,
        invoice: {
            id: "inv-1",
            code: "INV-00171",
            clientId: "client-1",
            client: { id: "client-1", name: "Mesplay", email: "c@example.com", qbCustomerId: "42" },
        },
        ...overrides,
    };
}

/**
 * A `ProgressBillingStageDb` backed by ONE in-memory row. `updateMany`
 * evaluates the real WHERE through `matchWhere` above — the same matcher the
 * poller fakes in this file use — and mutates the row on a match, so these
 * tests drive the stage core's actual CAS predicates (including the R3
 * pay-link pin) rather than a simplified stand-in. Same idiom as
 * `tests/progress-billing-stage.test.ts`'s `makeDb`.
 */
function makeStageDb(row: Row): ProgressBillingStageDb {
    return {
        async findUnique() { return { ...row }; },
        async updateMany(args: any) {
            if (!matchWhere(row, args.where)) return { count: 0 };
            Object.assign(row, args.data);
            return { count: 1 };
        },
    };
}

/**
 * A `ProgressBillingStageQbo` whose create always succeeds (echoing back a
 * matching document, so nothing here trips the create/tax/date mismatch
 * refusal) and whose `getPaymentLink` is the one seam these tests drive.
 */
function makeStageQbo(getPaymentLink: ProgressBillingStageQbo["getPaymentLink"]): ProgressBillingStageQbo {
    return {
        async getTokens() { return { accessToken: "a", refreshToken: "r", realmId: "realm-1" }; },
        async resolveCustomerAndItem() { return { customerId: "42", itemId: "7" }; },
        async createInvoice(_t, input) {
            return {
                qbId: "qb-1",
                total: input.amount,
                document: {
                    id: "qb-1",
                    docNumber: input.docNumber,
                    privateNote: input.privateNote,
                    total: input.amount,
                    customerId: input.customerId,
                    txnDate: input.txnDate,
                    itemIds: [input.itemId],
                    totalTax: input.tax?.taxAmount ?? null,
                },
            };
        },
        getPaymentLink,
        async deleteInvoice() { return true; },
    };
}

const stageLogEvent = (async () => {}) as any;

test("R3-1: the poller voids the row while getPaymentLink() is in flight — a returned URL must not resurrect it", async () => {
    const row = stageDraftRow();
    const db = makeStageDb(row);
    const qbo = makeStageQbo(async () => {
        // The payments poller persists 'voided' while this call is still
        // awaiting QuickBooks for the pay link.
        row.qbSyncError = "voided";
        return "https://pay.example/x";
    });

    const res = await stageProgressBillingToQuickBooksCore("pb-1", createRouteDeadline(30_000), { db, qbo, logEvent: stageLogEvent });

    assert.equal(res.success, true, "the billing is still correctly staged and linked");
    assert.equal(res.qbInvoiceLink, null, "the stale link this call fetched is not reported as persisted");
    assert.equal(row.qbSyncError, "voided", "the poller's flag wins over this call's stale pay-link answer");
    assert.equal(row.qbInvoiceLink, null, "qbInvoiceLink was never written over the void");
});

test("R3-1: the poller voids the row while getPaymentLink() is in flight — a null answer must not downgrade it to a retry marker", async () => {
    const row = stageDraftRow();
    const db = makeStageDb(row);
    const qbo = makeStageQbo(async () => {
        row.qbSyncError = "voided";
        return null;
    });

    const res = await stageProgressBillingToQuickBooksCore("pb-1", createRouteDeadline(30_000), { db, qbo, logEvent: stageLogEvent });

    assert.equal(res.success, true);
    assert.equal(res.qbInvoiceLink, null);
    assert.equal(row.qbSyncError, "voided", "must not become paylink-pending:1");
});

test("R3-1: the pay-link sweep finishes first — its persisted link must not be overwritten by this call's own, different answer", async () => {
    const row = stageDraftRow();
    const db = makeStageDb(row);
    const qbo = makeStageQbo(async () => {
        // sweepPendingPayLinks reads its own answer and persists it while
        // this call is still awaiting QuickBooks for a (different) one.
        row.qbSyncError = null;
        row.qbInvoiceLink = "https://sweep.example/y";
        return "https://pay.example/different-answer";
    });

    const res = await stageProgressBillingToQuickBooksCore("pb-1", createRouteDeadline(30_000), { db, qbo, logEvent: stageLogEvent });

    assert.equal(res.success, true);
    assert.equal(res.qbInvoiceLink, "https://sweep.example/y", "reports the sweep's persisted link, not this call's stale answer");
    assert.equal(row.qbSyncError, null, "the sweep's cleared marker is kept");
    assert.equal(row.qbInvoiceLink, "https://sweep.example/y", "the sweep's link is kept, not overwritten");
});

// R3-1, nothing changed during the call (marker cleared, link written): already
// covered by tests/progress-billing-stage.test.ts's "the happy path links the
// invoice, writes the pay link, and clears the marker" — that test drives the
// same CAS with the new `qbSyncError: PAYLINK_PENDING_MARKER` pin in its WHERE
// and still passes, since nothing moves the marker mid-call there.
