/**
 * The existing-invoice pay-link repair, under concurrency.
 *
 * Codex gate (round 36, item 4): `pushMilestoneToQuickBooks` took the
 * already-linked branch, read the row, spent two QuickBooks round trips, and
 * then wrote with `update({ where: { id } })` — pinned to the row's identity
 * and nothing else. Both of the things that can legitimately happen during
 * those round trips are destructive against that write:
 *
 *   • a break-link clears `qbInvoiceId`, and the stale write stamps
 *     `paylink-pending` onto a row that no longer has a QuickBooks invoice, so
 *     the sweep queues work against nothing;
 *   • a fresh send claims the row with a `create-in-flight` marker, and the
 *     stale write erases the only durable record that another sender's POST
 *     ever left the building.
 *
 * The repair now claims BEFORE the remote call (CAS-pinned to the exact
 * `{ qbInvoiceId, qbSyncError }` pair it read, so a moved row costs no
 * QuickBooks call at all) and finalises with the same pin.
 *
 * Driven through the real function with a fake Prisma (src/lib/prisma.ts reads
 * globalThis.prisma before building a client) and a fake QuickBooks over global
 * fetch — `mock.module` corrupts the require chain on Node 20, which CI pins.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    pushMilestoneToQuickBooks,
    isQBMilestoneRowMovedError,
    PAYLINK_PENDING_MARKER,
    CREATE_IN_FLIGHT_MARKER,
    composeCreateMarker,
} from "../src/lib/quickbooks-payments";
import { createRouteDeadline, type QBTokens } from "../src/lib/quickbooks";

const TOKENS: QBTokens = { accessToken: "a", refreshToken: "r", realmId: "realm-1" };
const PAY_LINK = "https://connect.intuit.com/pay/abc";

interface Row {
    id: string;
    status: string;
    qbInvoiceId: string | null;
    qbInvoiceLink: string | null;
    qbSyncError: string | null;
    qbPaymentId: string | null;
    name: string;
    invoiceId: string;
}

function row(overrides: Partial<Row> = {}): Row {
    return {
        id: "ps-1",
        status: "Pending",
        qbInvoiceId: "qb-9",
        qbInvoiceLink: null,
        qbSyncError: null,
        qbPaymentId: null,
        name: "Rough-in",
        invoiceId: "inv-1",
        ...overrides,
    };
}

/**
 * `onRead` fires after the row has been handed to the push and before anything
 * is written — the window a concurrent unlink or re-send lands in.
 */
function makePrisma(state: Row, onRead?: () => void) {
    const writes: any[] = [];
    return {
        writes,
        client: {
            paymentSchedule: {
                async findUnique() {
                    const snapshot = {
                        ...state,
                        invoice: {
                            code: "INV-00171",
                            clientId: "cl-1",
                            taxRate: 8.9,
                            client: { id: "cl-1", name: "Mesplay", email: null, qbCustomerId: "42" },
                            project: { id: "proj-1", name: "Mesplay Kitchen" },
                            payments: [{ id: "ps-1", createdAt: new Date() }],
                        },
                    };
                    onRead?.();
                    return snapshot;
                },
                async updateMany(args: any) {
                    writes.push(args);
                    const matches = Object.entries(args.where).every(([k, v]) => (state as any)[k] === v);
                    if (!matches) return { count: 0 };
                    Object.assign(state, args.data);
                    return { count: 1 };
                },
                async update(args: any) {
                    // Present so an accidental return to the un-CAS'd write is a
                    // LOUD failure rather than a silent pass.
                    writes.push(args);
                    throw new Error("pushMilestoneToQuickBooks must not update this row by id alone");
                },
            },
            progressBillingLine: {
                async findFirst() { return null; },
            },
        },
    };
}

function fakeQuickBooks(opts: { payLinkStatus?: number; statusStatus?: number } = {}): typeof fetch {
    return (async (url: string) => {
        const body = url.includes("include=invoiceLink")
            ? { Invoice: { Id: "qb-9", InvoiceLink: PAY_LINK } }
            : { Invoice: { Id: "qb-9", Balance: 1089, TotalAmt: 1089, LinkedTxn: [] } };
        const status = url.includes("include=invoiceLink")
            ? (opts.payLinkStatus ?? 200)
            : (opts.statusStatus ?? 200);
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
}

async function withFakes<T>(prismaClient: unknown, fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const prev = { prisma: (globalThis as any).prisma, fetch: globalThis.fetch };
    (globalThis as any).prisma = prismaClient;
    globalThis.fetch = fetchImpl;
    try {
        return await run();
    } finally {
        (globalThis as any).prisma = prev.prisma;
        globalThis.fetch = prev.fetch;
    }
}

const push = () => pushMilestoneToQuickBooks("ps-1", TOKENS, createRouteDeadline(30_000));

test("the happy repair claims, fetches, and clears its own marker", async () => {
    const state = row();
    const db = makePrisma(state);
    let calls = 0;
    const result = await withFakes(
        db.client,
        (async (url: string) => { calls++; return fakeQuickBooks()(url as any); }) as unknown as typeof fetch,
        push,
    );

    assert.equal(result.payLink, PAY_LINK);
    assert.equal(state.qbInvoiceLink, PAY_LINK);
    // The claim it wrote is retracted once the read answered — a row that had
    // no marker must not be left carrying one it never earned.
    assert.equal(state.qbSyncError, null);
    assert.equal(calls, 2, "pay link + status");
    // Both writes are CAS'd on the link that was read, never on the id alone.
    assert.equal(db.writes.length, 2);
    for (const write of db.writes) assert.equal(write.where.qbInvoiceId, "qb-9");
});

test("a concurrent UNLINK between the read and the repair writes nothing, and costs no QuickBooks call", async () => {
    const state = row();
    // The break-link lands in the window the old code wrote straight through.
    const db = makePrisma(state, () => { state.qbInvoiceId = null; state.qbInvoiceLink = null; });
    let calls = 0;
    const error = await withFakes(
        db.client,
        (async (url: string) => { calls++; return fakeQuickBooks()(url as any); }) as unknown as typeof fetch,
        () => push().then(() => null, (e) => e),
    );

    assert.ok(isQBMilestoneRowMovedError(error), `expected row-moved, got ${(error as Error)?.name}`);
    assert.equal(state.qbSyncError, null, "no paylink-pending stamped onto an unlinked row");
    assert.equal(calls, 0, "refused before spending a QuickBooks call");
    // The claim was attempted and lost; nothing else was written.
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].where.qbInvoiceId, "qb-9");
});

test("a fresh create claim landing in the same window is not overwritten", async () => {
    const marker = composeCreateMarker(
        CREATE_IN_FLIGHT_MARKER,
        { docNumber: "INV-00171-2", privateNote: "ProBuild INV-00171 - Rough-in - Mesplay Kitchen", realmId: "realm-1", customerId: "42" },
    );
    const state = row();
    const db = makePrisma(state, () => { state.qbInvoiceId = null; state.qbSyncError = marker; });
    const error = await withFakes(db.client, fakeQuickBooks(), () => push().then(() => null, (e) => e));

    assert.ok(isQBMilestoneRowMovedError(error));
    assert.equal(state.qbSyncError, marker, "the other sender's in-flight claim survives untouched");
});

test("a transient pay-link failure leaves paylink-pending — but only on the row it read", async () => {
    const state = row();
    const db = makePrisma(state);
    const result = await withFakes(db.client, fakeQuickBooks({ payLinkStatus: 503 }), push);

    assert.equal(result.payLink, null);
    assert.equal(state.qbSyncError, PAYLINK_PENDING_MARKER, "left for sweepPendingPayLinks");
    assert.equal(state.qbInvoiceId, "qb-9");
    // Written by the CLAIM, before the remote call — so it can only ever land
    // on the row that was still linked at claim time.
    assert.equal(db.writes.length, 1);
    assert.equal(db.writes[0].where.qbInvoiceId, "qb-9");
    assert.equal(db.writes[0].where.qbSyncError, null);
});

test("a pre-existing voided flag is kept, not replaced by the claim", async () => {
    // Overwriting a real diagnosis with `paylink-pending` would lose it
    // whenever the status read below cannot reach the invoice.
    const state = row({ qbSyncError: "voided" });
    const db = makePrisma(state);
    await withFakes(db.client, fakeQuickBooks({ payLinkStatus: 503 }), push);

    assert.equal(state.qbSyncError, "voided");
});

test("a reachable invoice still clears a stale voided flag", async () => {
    const state = row({ qbSyncError: "notFound" });
    const db = makePrisma(state);
    await withFakes(db.client, fakeQuickBooks(), push);

    assert.equal(state.qbSyncError, null);
    assert.equal(state.qbInvoiceLink, PAY_LINK);
});
