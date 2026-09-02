/**
 * Staging a progress billing must not be able to bill a client twice.
 *
 * Codex gate (round 27, items 1 + 2): the milestone rail got a durable
 * in-flight marker and a link write that lands BEFORE the pay-link fetch;
 * progress billings still had the old shape — a swallowed marker write, and a
 * pay-link timeout that abandoned a real, created invoice.
 *
 * These drive the REAL stageProgressBillingToQuickBooksCore against a fake
 * ProgressBilling table and a fake QuickBooks, so the claim/release/park
 * decisions are exercised rather than re-implemented in the test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { QBTimeoutError, createRouteDeadline, type QBTokens } from "../src/lib/quickbooks";
import {
    stageProgressBillingToQuickBooksCore,
    progressBillingPrivateNote,
    type ProgressBillingStageQbo,
} from "../src/lib/progress-billing";
import { QBAmbiguousCreateError } from "../src/lib/quickbooks-payments";

const TOKENS: QBTokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };

type Row = Record<string, any>;

function draftRow(overrides: Row = {}): Row {
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

/** In-memory ProgressBilling delegate: real WHERE matching, real count semantics. */
function makeDb(row: Row, opts?: { failUpdateNo?: number; loseClaimNo?: number }) {
    let updates = 0;
    const seen: any[] = [];
    return {
        row,
        updates: seen,
        db: {
            async findUnique(_args: any) {
                return { ...row };
            },
            async updateMany(args: any) {
                updates++;
                if (opts?.failUpdateNo === updates) throw new Error("database unavailable");
                seen.push(args);
                if (opts?.loseClaimNo === updates) return { count: 0 };
                const matches = Object.entries(args.where).every(([k, v]) => row[k] === v);
                if (!matches) return { count: 0 };
                Object.assign(row, args.data);
                return { count: 1 };
            },
        },
    };
}

interface QboCalls {
    created: any[];
    payLinks: string[];
    deleted: string[];
    tokens: number;
}

function makeQbo(behaviour?: {
    createThrows?: unknown;
    payLinkThrows?: unknown;
    payLink?: string | null;
    deleteResult?: boolean;
}): { qbo: ProgressBillingStageQbo; calls: QboCalls } {
    const calls: QboCalls = { created: [], payLinks: [], deleted: [], tokens: 0 };
    const qbo: ProgressBillingStageQbo = {
        async getTokens() {
            calls.tokens++;
            return TOKENS;
        },
        async resolveCustomerAndItem() {
            return { customerId: "42", itemId: "7" };
        },
        async createInvoice(_t, input) {
            calls.created.push(input);
            if (behaviour?.createThrows) throw behaviour.createThrows;
            return { qbId: "qb-1", total: input.amount };
        },
        async getPaymentLink(_t, qbId) {
            calls.payLinks.push(qbId);
            if (behaviour?.payLinkThrows) throw behaviour.payLinkThrows;
            return behaviour?.payLink ?? "https://pay.example/qb-1";
        },
        async deleteInvoice(_t, qbId) {
            calls.deleted.push(qbId);
            return behaviour?.deleteResult ?? true;
        },
    };
    return { qbo, calls };
}

const events: any[] = [];
const logEvent = (async (e: any) => {
    events.push(e);
}) as any;

const deadline = () => createRouteDeadline(30_000);

test("the happy path links the invoice, writes the pay link, and clears the marker", async () => {
    const { row, db } = makeDb(draftRow());
    const { qbo, calls } = makeQbo();

    const res = await stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent });

    assert.deepEqual(res, { success: true, qbInvoiceId: "qb-1", qbInvoiceLink: "https://pay.example/qb-1" });
    assert.equal(row.status, "Staged");
    assert.equal(row.qbInvoiceId, "qb-1");
    assert.equal(row.qbInvoiceLink, "https://pay.example/qb-1");
    assert.equal(row.qbSyncError, null);
    assert.equal(calls.deleted.length, 0, "nothing to compensate");
    // The PrivateNote is what the resolver later matches on — pin it.
    assert.equal(calls.created[0].privateNote, progressBillingPrivateNote("INV-00171", "INV-00171-P1"));
});

test("a pay-link timeout leaves the invoice LINKED and pending, not abandoned", async () => {
    // The regression: the pay-link read is a second remote call. A timeout there
    // used to leave the row unlinked, so the next stage created a second
    // collectible invoice for the same money.
    const { row, db } = makeDb(draftRow());
    const { qbo, calls } = makeQbo({ payLinkThrows: new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice/qb-1") });

    const res = await stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent });

    assert.deepEqual(res, { success: true, qbInvoiceId: "qb-1", qbInvoiceLink: null });
    assert.equal(row.qbInvoiceId, "qb-1", "the created invoice is recorded");
    assert.equal(row.status, "Staged");
    assert.equal(row.qbSyncError, "paylink-pending", "the sweep finishes the link");
    assert.equal(calls.deleted.length, 0, "a linked row must never have its invoice deleted");
});

test("a marker write that fails aborts BEFORE the invoice POST", async () => {
    // An unwritten marker is exactly the invisible-crash case the marker guards,
    // so it must abort rather than proceed unguarded.
    const { row, db } = makeDb(draftRow(), { failUpdateNo: 1 });
    const { qbo, calls } = makeQbo();

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        /database unavailable/,
    );
    assert.equal(calls.created.length, 0, "no invoice was created");
    assert.equal(row.qbInvoiceId, null);
});

test("losing the in-flight CAS refuses the stage without posting", async () => {
    // Another stager claimed the row between our read and our write.
    const { row, db } = makeDb(draftRow(), { loseClaimNo: 1 });
    const { qbo, calls } = makeQbo();

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        (e: unknown) => e instanceof QBAmbiguousCreateError,
    );
    assert.equal(calls.created.length, 0, "we must not race a peer into two invoices");
    assert.equal(row.qbInvoiceId, null);
});

test("a row already parked ambiguous refuses before spending a QBO call", async () => {
    const { db } = makeDb(draftRow({ qbSyncError: "ambiguous-create" }));
    const { qbo, calls } = makeQbo();

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        (e: unknown) => e instanceof QBAmbiguousCreateError,
    );
    assert.equal(calls.tokens, 0, "not even a token refresh");
});

test("an in-flight marker refuses too — a peer may be mid-POST right now", async () => {
    const { db } = makeDb(draftRow({ qbSyncError: "create-in-flight" }));
    const { qbo, calls } = makeQbo();

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        (e: unknown) => e instanceof QBAmbiguousCreateError,
    );
    assert.equal(calls.created.length, 0);
});

test("a definitive refusal releases the claim — QuickBooks created nothing", async () => {
    const { row, db } = makeDb(draftRow());
    const { qbo } = makeQbo({ createThrows: new Error("QB milestone invoice create failed (400): Duplicate Document Number") });

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        /Duplicate Document Number/,
    );
    assert.equal(row.qbSyncError, null, "the billing is freely re-stageable");
    assert.equal(row.qbInvoiceId, null);
});

test("an unknown outcome parks the row ambiguous and records why", async () => {
    events.length = 0;
    const { row, db } = makeDb(draftRow());
    const { qbo } = makeQbo({ createThrows: new QBTimeoutError("QuickBooks request timed out after 20000ms: /v3/company/x/invoice") });

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        (e: unknown) => e instanceof QBAmbiguousCreateError,
    );
    assert.equal(row.qbSyncError, "ambiguous-create");
    assert.equal(row.qbInvoiceId, null, "we never learned an id to record");
    assert.equal(events.at(-1)?.reason, "ambiguous-create");
    assert.equal(events.at(-1)?.source, "progress-billing-stage");
});

test("a lost link claim compensates the invoice it created", async () => {
    // The row changed mid-stage (e.g. its description was edited), so the QBO
    // invoice no longer describes it. Nothing points at it: delete it.
    const { row, db } = makeDb(draftRow(), { loseClaimNo: 2 });
    const { qbo, calls } = makeQbo();

    await assert.rejects(
        () => stageProgressBillingToQuickBooksCore("pb-1", deadline(), { db, qbo, logEvent }),
        /changed while staging/,
    );
    assert.deepEqual(calls.deleted, ["qb-1"]);
    assert.equal(row.qbInvoiceId, null);
});
