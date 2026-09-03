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
import { lockClientRow, lockMoneyParents } from "../src/lib/tx-retry";
import { finalizeMilestoneLinkUnderLock } from "../src/lib/quickbooks-payments";
import { finalizeProgressBillingLinkUnderLock } from "../src/lib/progress-billing";
import { milestoneIssuanceHash, milestoneTaxSplit, progressBillingIssuanceHash } from "../src/lib/qbo-issuance";

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
    derived: "ps-locktest-derived",
    billing: "pb-locktest",
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
    // A SECOND milestone whose tax split is DERIVED from the invoice rate
    // rather than stored on the row. milestoneTaxSplit prefers the row columns
    // when both are set, so the schedule above cannot feel a rate change at
    // all — this one is the row a rate edit actually re-prices.
    await db.paymentSchedule.create({
        data: {
            id: ID.derived, invoiceId: ID.invoice, name: "Finish",
            amount: 1089, status: "Pending",
            dueDate: new Date("2026-10-15T00:00:00.000Z"),
            qbSyncError: IN_FLIGHT,
        },
    });
    await db.progressBilling.create({
        data: {
            id: ID.billing, invoiceId: ID.invoice, code: "INV-LOCKTEST-P1",
            description: "Rough-in complete", status: "Draft",
            subtotal: 1000, taxRate: 8.9, taxAmount: 89, total: 1089,
            qbSyncError: IN_FLIGHT,
        },
    });
    return marker;
}

/**
 * The in-flight claim both link decisions below pin. A real create writes this
 * before its POST; these tests start from the moment after it returned.
 */
const IN_FLIGHT = "create-in-flight:@1|INV-LOCKTEST-1|ProBuild lock test";

/** The hash the marker carries for the stored-split milestone. */
function milestoneHash(customerId: string) {
    return milestoneIssuanceHash({
        status: "Pending", qbPaymentId: null, amount: 1089,
        dueDate: new Date("2026-09-15T00:00:00.000Z"),
        tax: milestoneTaxSplit({ pretaxAmount: 1000, taxAmount: 89, amount: 1089, invoiceTaxRate: 8.9 }),
        customerId,
    });
}

/** ...and for the derived-split one, which moves with the invoice rate. */
function derivedMilestoneHash(customerId: string, taxRate: number) {
    return milestoneIssuanceHash({
        status: "Pending", qbPaymentId: null, amount: 1089,
        dueDate: new Date("2026-10-15T00:00:00.000Z"),
        tax: milestoneTaxSplit({ pretaxAmount: null, taxAmount: null, amount: 1089, invoiceTaxRate: taxRate }),
        customerId,
    });
}

function billingHash(customerId: string) {
    return progressBillingIssuanceHash({
        status: "Draft", subtotal: 1000, total: 1089, taxAmount: 89,
        description: "Rough-in complete", customerId,
    });
}

/** Point the module-level `prisma` proxy at the disposable database. */
async function withPrisma<T>(db: PrismaClient, fn: () => Promise<T>): Promise<T> {
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = db;
    try {
        return await fn();
    } finally {
        (globalThis as any).prisma = previous;
    }
}

function linkMilestone(db: PrismaClient, scheduleId: string, issuanceHash: string, dueDate: Date) {
    return withPrisma(db, () => finalizeMilestoneLinkUnderLock(
        { id: scheduleId, invoiceId: ID.invoice, amount: 1089, dueDate, name: scheduleId === ID.derived ? "Finish" : "Rough-in" },
        { qbId: "qb-created-1", payLink: null, preLinked: false, inFlightMarker: IN_FLIGHT, clientId: ID.client, issuanceHash },
    ));
}

function linkBilling(db: PrismaClient, issuanceHash: string, taxAmount = 89) {
    return withPrisma(db, () => finalizeProgressBillingLinkUnderLock({
        billingId: ID.billing, invoiceId: ID.invoice, clientId: ID.client,
        qbId: "qb-created-2", inFlightMarker: IN_FLIGHT, issuanceHash,
        pinned: { subtotal: 1000, total: 1089, taxAmount, description: "Rough-in complete" },
    }));
}

/**
 * Hold a write on one parent open on a SECOND connection, run `attempt` on the
 * first, and prove it WAITED rather than sailing past the lock.
 *
 * The waiting is the whole point: an assertion that only checked the verdict
 * would pass just as happily against a decision that took no lock at all and
 * simply happened to re-read after the other transaction committed.
 */
async function whileHolding<T>(
    other: PrismaClient,
    hold: (tx: any) => Promise<void>,
    attempt: () => Promise<T>,
): Promise<T> {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let open = false;
    const holder = other.$transaction(async (tx) => {
        await hold(tx);
        open = true;
        await held;
    }, { timeout: 20_000, maxWait: 20_000 });
    while (!open) await new Promise((r) => setTimeout(r, 10));

    let settled = false;
    const running = attempt().then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    assert.equal(settled, false, "the link decision must WAIT on the lock — finishing here means it took none");

    release();
    await holder;
    return await running;
}

async function teardown(db: PrismaClient) {
    await db.progressBilling.deleteMany({ where: { id: ID.billing } });
    await db.paymentSchedule.deleteMany({ where: { id: { in: [ID.schedule, ID.derived] } } });
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

/**
 * Round 38 gate, finding 1. The link decision on BOTH rails used to validate
 * only child columns. The QuickBooks customer lives on Client and the tax rate
 * on Invoice, so a remap or a rate edit landing between the create and the link
 * left every pinned predicate matching while the invoice already sitting in
 * QuickBooks billed the wrong party, or split the liability the wrong way.
 *
 * These are the same two-connection shape as the recovery test above: the fake
 * databases in the unit suites can model the RULE but cannot prove Postgres
 * blocks, and "a lock that was never taken" is precisely the failure.
 */
test("milestone link: an unchanged row links (control)", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await db.paymentSchedule.update({ where: { id: ID.schedule }, data: { qbSyncError: IN_FLIGHT } });
        const res = await linkMilestone(db, ID.schedule, milestoneHash(ORIGINAL_CUSTOMER), new Date("2026-09-15T00:00:00.000Z"));
        assert.equal(res.outcome, "linked");
        const row = await db.paymentSchedule.findUnique({ where: { id: ID.schedule } });
        assert.equal(row?.qbInvoiceId, "qb-created-1");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("milestone link: a customer remap between create and link BLOCKS, then refuses", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await db.paymentSchedule.update({ where: { id: ID.schedule }, data: { qbSyncError: IN_FLIGHT } });
        const res = await whileHolding(
            other,
            async (tx) => {
                await lockClientRow(tx, ID.client, "update");
                await tx.client.update({ where: { id: ID.client }, data: { qbCustomerId: REMAPPED_CUSTOMER } });
            },
            () => linkMilestone(db, ID.schedule, milestoneHash(ORIGINAL_CUSTOMER), new Date("2026-09-15T00:00:00.000Z")),
        );
        assert.equal(res.outcome, "mismatch", "this invoice now bills somebody else");
        const row = await db.paymentSchedule.findUnique({ where: { id: ID.schedule } });
        assert.equal(row?.qbInvoiceId, null, "nothing was linked — the caller compensates instead");
        assert.equal(row?.qbSyncError, IN_FLIGHT, "and the claim is still ours to compensate against");
    } finally {
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
    }
});

test("milestone link: an invoice tax-rate change between create and link BLOCKS, then refuses", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        // Same dollars, different liability split: this milestone stores no
        // pretax/tax columns, so its split is derived from the parent rate.
        const issued = derivedMilestoneHash(ORIGINAL_CUSTOMER, 8.9);
        const res = await whileHolding(
            other,
            async (tx) => {
                await lockMoneyParents(tx, { invoiceId: ID.invoice });
                await tx.invoice.update({ where: { id: ID.invoice }, data: { taxRate: 0 } });
            },
            () => linkMilestone(db, ID.derived, issued, new Date("2026-10-15T00:00:00.000Z")),
        );
        assert.equal(res.outcome, "mismatch");
        const row = await db.paymentSchedule.findUnique({ where: { id: ID.derived } });
        assert.equal(row?.qbInvoiceId, null);
    } finally {
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
    }
});

test("progress-billing link: an unchanged billing links (control)", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        const res = await linkBilling(db, billingHash(ORIGINAL_CUSTOMER));
        assert.equal(res.outcome, "linked");
        const row = await db.progressBilling.findUnique({ where: { id: ID.billing } });
        assert.equal(row?.qbInvoiceId, "qb-created-2");
        assert.equal(row?.status, "Staged");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("progress-billing link: a customer remap between create and link BLOCKS, then refuses", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        const res = await whileHolding(
            other,
            async (tx) => {
                await lockClientRow(tx, ID.client, "update");
                await tx.client.update({ where: { id: ID.client }, data: { qbCustomerId: REMAPPED_CUSTOMER } });
            },
            () => linkBilling(db, billingHash(ORIGINAL_CUSTOMER)),
        );
        assert.equal(res.outcome, "mismatch");
        const row = await db.progressBilling.findUnique({ where: { id: ID.billing } });
        assert.equal(row?.qbInvoiceId, null, "nothing was linked — the stage compensates instead");
        assert.equal(row?.status, "Draft", "and it stays re-stageable once a human has decided");
    } finally {
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
    }
});

test("progress-billing link: the CAS now pins taxAmount too", { skip }, async () => {
    // The billing carries its own tax column rather than deriving one from the
    // parent, so a rate edit reaches this rail as a change to THAT column. It
    // was the one money field the link predicate had been missing: the payload
    // tax line is { preTaxAmount: subtotal, taxAmount }, so it can move while
    // subtotal and total both stay put.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await db.progressBilling.update({ where: { id: ID.billing }, data: { taxAmount: 0, subtotal: 1089 } });
        const res = await linkBilling(db, billingHash(ORIGINAL_CUSTOMER));
        assert.equal(res.outcome, "mismatch", "the issuance guard sees it first");
        const row = await db.progressBilling.findUnique({ where: { id: ID.billing } });
        assert.equal(row?.qbInvoiceId, null);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});
