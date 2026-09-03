/**
 * The Client row lock, against a REAL PostgreSQL.
 *
 * `tests/qbo-ambiguous-create.test.ts` drives the same resolver with a fake
 * database, and that fake can be made to enforce the ordering rules — but it
 * cannot prove the one thing that matters here: that Postgres actually blocks.
 * The bug this closes was precisely a lock that was never taken, and a fake
 * whose `$transaction` just calls the callback is blind to that by
 * construction.
 *
 * So this test runs two REAL transactions against a disposable database:
 *
 *   remap  : lockClientRow(FOR UPDATE) + UPDATE Client.qbCustomerId, held open
 *   resolve: the ambiguous-create recovery, started while that is held
 *
 * and asserts that the resolve WAITS, then sees the committed remap and
 * refuses. Before the fix it read `Invoice.client.qbCustomerId` through the
 * relation, took no Client lock at all, and committed the link against a
 * customer the row no longer bills.
 *
 * Opt-in by URL, like tests/migration-history-blind-spots.test.ts: a normal
 * unit run must never be able to write to a developer database. CI's
 * `migrations` job supplies the URL from its Postgres service container.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { resolveAmbiguousInvoiceCreateCore } from "../src/lib/qbo-ambiguous-create";
import { AMBIGUOUS_CREATE_MARKER, CREATE_IN_FLIGHT_STALE_MS, composeCreateMarker, ambiguousCreateFingerprint } from "../src/lib/qbo-create-markers";
import { lockClientRow } from "../src/lib/tx-retry";

const databaseUrl = process.env.QBO_CLIENT_LOCK_TEST_URL;
const skip = !databaseUrl && "set QBO_CLIENT_LOCK_TEST_URL to a disposable PostgreSQL URL";

const REALM = "realm-lock-test";
const ORIGINAL_CUSTOMER = "4242";
const REMAPPED_CUSTOMER = "9999";
const TOKENS = { accessToken: "a", refreshToken: "r", realmId: REALM };
const ADMIN = { id: "u-lock", email: "admin@example.test", role: "ADMIN" };
/** How long the remap holds its lock before committing. */
const HOLD_MS = 400;

/** Ids are fixed and prefixed so teardown can delete exactly what was made. */
const ID = {
    client: "cli-locktest",
    project: "proj-locktest",
    estimate: "est-locktest",
    invoice: "inv-locktest",
    schedule: "ps-locktest",
};

async function seed(db: PrismaClient) {
    await teardown(db);
    await db.client.create({
        data: { id: ID.client, name: "Lock Test Client", initials: "LT", qbCustomerId: ORIGINAL_CUSTOMER },
    });
    await db.project.create({ data: { id: ID.project, name: "Lock Test Project", clientId: ID.client } });
    await db.estimate.create({
        data: {
            id: ID.estimate, title: "Lock Test", code: "EST-LOCKTEST",
            totalAmount: 1089, balanceDue: 1089, projectId: ID.project,
        },
    });
    await db.invoice.create({
        data: {
            id: ID.invoice, code: "INV-LOCKTEST", projectId: ID.project,
            clientId: ID.client, estimateId: ID.estimate, taxRate: 8.9,
        },
    });
    // The marker carries the customer the create POST addressed. That is the
    // value the resolve is about to compare the LIVE mapping against.
    const marker = composeCreateMarker(
        AMBIGUOUS_CREATE_MARKER,
        {
            docNumber: "INV-LOCKTEST-1",
            privateNote: "ProBuild lock test",
            realmId: REALM,
            customerId: ORIGINAL_CUSTOMER,
        },
        new Date(Date.now() - CREATE_IN_FLIGHT_STALE_MS - 60_000),
    );
    await db.paymentSchedule.create({
        data: {
            id: ID.schedule, invoiceId: ID.invoice, name: "Rough-in",
            amount: 1089, pretaxAmount: 1000, taxAmount: 89,
            status: "Pending", dueDate: new Date("2026-09-15T00:00:00.000Z"),
            qbSyncError: marker,
        },
    });
    return marker;
}

async function teardown(db: PrismaClient) {
    await db.paymentSchedule.deleteMany({ where: { id: ID.schedule } });
    await db.invoice.deleteMany({ where: { id: ID.invoice } });
    await db.estimate.deleteMany({ where: { id: ID.estimate } });
    await db.project.deleteMany({ where: { id: ID.project } });
    await db.client.deleteMany({ where: { id: ID.client } });
}

/**
 * The recovery, clearing on a confirmed "QuickBooks has nothing".
 *
 * The CLEAR path is used rather than the link because it needs no candidate
 * invoice to match, while going through exactly the same
 * `writeUnderParentLocks` transaction — same locks, same re-read, same
 * compare-and-set. What it releases is a row that may be freely re-sent, so a
 * customer that moved underneath it is every bit as dangerous.
 */
function resolve(db: PrismaClient, marker: string) {
    return resolveAmbiguousInvoiceCreateCore(
        {
            kind: "milestone",
            id: ID.schedule,
            decision: "confirmed-none",
            reason: "Checked QuickBooks by hand",
            actor: ADMIN,
            expectedState: ambiguousCreateFingerprint({ qbSyncError: marker, qbInvoiceId: null }),
        },
        {
            db: db as any,
            getTokens: async () => TOKENS,
            findInvoices: async () => [],
            logEvent: (async () => {}) as any,
        },
    );
}

test("the recovery CLEARS when nothing touches the client (control)", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        const marker = await seed(db);
        const res = await resolve(db, marker);
        assert.equal(res.ok, true, JSON.stringify(res));
        const row = await db.paymentSchedule.findUnique({ where: { id: ID.schedule } });
        assert.equal(row?.qbSyncError, null, "the marker is gone — the row can be sent again");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a customer remap committing between the read and the write BLOCKS the recovery, then is refused", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        const marker = await seed(db);

        // The remap: lock, write, and HOLD the transaction open. Its update is
        // invisible to any other reader until it commits, which is exactly the
        // interleaving — the recovery's pre-flight read still sees the original
        // mapping and decides to proceed.
        let release: () => void = () => {};
        const held = new Promise<void>((r) => { release = r; });
        let remapOpen = false;
        const remap = other.$transaction(
            async (tx) => {
                await lockClientRow(tx, ID.client, "update");
                await tx.client.update({ where: { id: ID.client }, data: { qbCustomerId: REMAPPED_CUSTOMER } });
                remapOpen = true;
                await held;
            },
            { timeout: 20_000, maxWait: 20_000 },
        );
        while (!remapOpen) await new Promise((r) => setTimeout(r, 10));

        let settled = false;
        const recovery = resolve(db, marker).then((r) => { settled = true; return r; });

        await new Promise((r) => setTimeout(r, HOLD_MS));
        assert.equal(
            settled,
            false,
            "the recovery must WAIT on the Client row lock — if it finished here it never took one",
        );

        release();
        await remap;
        const res = await recovery;

        assert.equal(res.ok, false, "a resolve decided against a customer that has moved must not commit");
        assert.equal(!res.ok && res.refusal, "mismatch");
        const row = await db.paymentSchedule.findUnique({ where: { id: ID.schedule } });
        assert.equal(row?.qbSyncError, marker, "still parked — nothing was released");
        assert.equal(row?.qbInvoiceId, null, "and nothing was linked");
        const client = await db.client.findUnique({ where: { id: ID.client } });
        assert.equal(client?.qbCustomerId, REMAPPED_CUSTOMER, "the remap is the write that won");
    } finally {
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
    }
});
