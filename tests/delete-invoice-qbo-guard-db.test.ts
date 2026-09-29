/**
 * `deleteInvoiceCore`'s row locks (src/lib/billing-core.ts), against a REAL
 * PostgreSQL.
 *
 * tests/delete-invoice-qbo-guard.test.ts drives the guard with a fake `tx`
 * that can record lock order and bound parameters — but it cannot prove the
 * one thing that actually matters here: that Postgres blocks a concurrent,
 * LOCK-FREE QuickBooks claim on the ProgressBilling row.
 * `stageProgressBillingToQuickBooksCore` (progress-billing.ts) writes its
 * `qbSyncError` CAS with a bare `prisma.progressBilling.updateMany` — no
 * transaction, no lock of its own — so the only thing that can exclude it is
 * deleteInvoiceCore's own `SELECT ... FOR UPDATE` on that row. A fake `tx`
 * whose `$queryRaw` just records the call and returns is blind to that by
 * construction. See tests/qbo-client-lock-db.test.ts for the same shape of
 * proof on the Client row lock.
 *
 * The interleaving test below proves the block DETERMINISTICALLY rather than
 * with a fixed sleep: it pins the delete's connection to a single, known
 * Postgres backend pid (`connection_limit=1`) and polls `pg_locks` from a
 * THIRD, independent connection until that exact pid is reported holding an
 * un-granted lock request — with a hard deadline that FAILS the test if it
 * never happens, instead of a sleep that could resolve before the wait even
 * starts (a false pass) or never notice a guard that took no lock at all.
 *
 * Opt-in by URL, like tests/qbo-client-lock-db.test.ts: a normal unit run
 * must never be able to write to a developer database. CI's `migrations` job
 * supplies the URL from its Postgres service container — a dedicated step,
 * same shape as tests/qbo-client-lock-db.test.ts's.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { CREATE_IN_FLIGHT_MARKER, composeCreateMarker } from "../src/lib/qbo-create-markers";

const databaseUrl = process.env.DELETE_INVOICE_QBO_GUARD_TEST_URL;
const skip = !databaseUrl && "set DELETE_INVOICE_QBO_GUARD_TEST_URL to a disposable PostgreSQL URL";

/** Ids are fixed and prefixed so teardown can delete exactly what was made. */
const ID = {
    client: "cli-delinvtest",
    project: "proj-delinvtest",
    invoice: "inv-delinvtest",
    schedule: "ps-delinvtest",
    billing: "pb-delinvtest",
};

async function seed(db: PrismaClient) {
    await teardown(db);
    await db.client.create({ data: { id: ID.client, name: "Delete Invoice Lock Test Client", initials: "DI" } });
    await db.project.create({ data: { id: ID.project, name: "Delete Invoice Lock Test Project", clientId: ID.client } });
    await db.invoice.create({
        data: {
            id: ID.invoice, code: "INV-DELINVTEST", projectId: ID.project, clientId: ID.client,
            totalAmount: 1000, balanceDue: 1000,
        },
    });
    await db.paymentSchedule.create({
        data: { id: ID.schedule, invoiceId: ID.invoice, name: "Rough-in", amount: 500, status: "Pending" },
    });
    await db.progressBilling.create({
        data: {
            id: ID.billing, invoiceId: ID.invoice, code: "INV-DELINVTEST-P1",
            description: "Rough-in complete", status: "Draft", subtotal: 500, total: 500,
        },
    });
}

async function teardown(db: PrismaClient) {
    await db.progressBilling.deleteMany({ where: { id: ID.billing } });
    await db.paymentSchedule.deleteMany({ where: { id: ID.schedule } });
    await db.invoice.deleteMany({ where: { id: ID.invoice } });
    await db.project.deleteMany({ where: { id: ID.project } });
    await db.client.deleteMany({ where: { id: ID.client } });
}

/** Point the module-level `prisma` proxy (src/lib/prisma.ts) at the disposable database. */
async function withPrisma<T>(db: PrismaClient, fn: () => Promise<T>): Promise<T> {
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = db;
    try {
        return await fn();
    } finally {
        (globalThis as any).prisma = previous;
    }
}

/**
 * Poll `check` until it resolves true, or REJECT once `deadlineMs` elapses (or
 * `check` itself throws). A resolved promise here is proof the condition
 * became true; there is no unbounded loop and no fixed sleep — either of
 * those can hang forever or resolve without ever having proven anything.
 */
function waitFor(check: () => boolean | Promise<boolean>, deadlineMs: number, timeoutMessage: string): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const poll = async () => {
            let ok: boolean;
            try {
                ok = await check();
            } catch (e) {
                reject(e);
                return;
            }
            if (ok) {
                resolve();
                return;
            }
            if (Date.now() - startedAt > deadlineMs) {
                reject(new Error(timeoutMessage));
                return;
            }
            setTimeout(poll, 10);
        };
        poll();
    });
}

/** Set (or override) `connection_limit` on a Postgres connection URL. */
function withConnectionLimit(url: string, limit: number): string {
    const parsed = new URL(url);
    parsed.searchParams.set("connection_limit", String(limit));
    return parsed.toString();
}

test("an unlinked invoice deletes, and its milestones and progress billings cascade with it", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        const { deleteInvoiceCore } = await import("../src/lib/billing-core");
        const projectId = await withPrisma(db, () => deleteInvoiceCore(ID.invoice));
        assert.equal(projectId, ID.project);
        assert.equal(await db.invoice.findUnique({ where: { id: ID.invoice } }), null, "the invoice is gone");
        assert.equal(await db.paymentSchedule.findUnique({ where: { id: ID.schedule } }), null, "the milestone cascaded away");
        assert.equal(await db.progressBilling.findUnique({ where: { id: ID.billing } }), null, "the progress billing cascaded away");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a linked milestone refuses the delete, and nothing is deleted", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await db.paymentSchedule.update({ where: { id: ID.schedule }, data: { qbInvoiceId: "qb-real-1" } });
        const { deleteInvoiceCore } = await import("../src/lib/billing-core");

        let err: unknown;
        try {
            await withPrisma(db, () => deleteInvoiceCore(ID.invoice));
        } catch (e) {
            err = e;
        }
        assert.ok(err, "expected a refusal");
        assert.match((err as Error).message, /Rough-in/);

        assert.ok(await db.invoice.findUnique({ where: { id: ID.invoice } }), "the invoice must survive");
        assert.ok(await db.paymentSchedule.findUnique({ where: { id: ID.schedule } }), "the milestone must survive");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a concurrent, lock-free progress-billing claim blocks the delete, then the delete refuses once the claim lands", { skip }, async () => {
    // Pinned to exactly ONE physical connection: with only one connection in
    // the pool, pg_backend_pid() read on `db` below is GUARANTEED to be the
    // same backend deleteInvoiceCore's own internal transaction runs on —
    // there is nothing else for Prisma to hand that transaction.
    const db = new PrismaClient({ datasources: { db: { url: withConnectionLimit(databaseUrl!, 1) } } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    // A THIRD, independent connection: the only thing that can prove Postgres
    // itself queued deleteInvoiceCore's backend as a lock waiter.
    const probe = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });

    // `held` settles the claim transaction below: resolving lets its callback
    // return normally (COMMIT); rejecting throws inside it (ROLLBACK). A
    // promise settles once, so whichever of commitClaim/abortClaim runs first
    // decides the outcome — the other is then a harmless no-op.
    let commitClaim: () => void = () => {};
    let abortClaim: (_reason: unknown) => void = () => {};
    let claim: Promise<unknown> = Promise.resolve();
    let deletion: Promise<unknown> = Promise.resolve();
    try {
        await seed(db);
        const { deleteInvoiceCore } = await import("../src/lib/billing-core");
        const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

        // stageProgressBillingToQuickBooksCore's real claim is a bare
        // prisma.progressBilling.updateMany — no transaction, no lock of its
        // own. Reproduced here as a plain UPDATE inside an explicit
        // transaction so it can be HELD OPEN: Postgres takes the row lock the
        // instant the UPDATE runs, committed or not, which is the real
        // mechanism the fake-tx unit tests cannot exercise.
        const marker = composeCreateMarker(CREATE_IN_FLIGHT_MARKER, {
            docNumber: "INV-DELINVTEST-P1",
            privateNote: "ProBuild INV-DELINVTEST-P1",
        });

        const held = new Promise<void>((resolve, reject) => { commitClaim = resolve; abortClaim = reject; });
        let claimOpen = false;
        claim = other.$transaction(async (tx) => {
            await tx.progressBilling.update({ where: { id: ID.billing }, data: { qbSyncError: marker } });
            claimOpen = true;
            await held;
        }, { timeout: 20_000, maxWait: 20_000 });
        // Bounded readiness signal — not the unbounded poll this used to be —
        // so a claim whose UPDATE never lands fails the test instead of
        // hanging it.
        await waitFor(() => claimOpen, 10_000, "the claim's UPDATE never ran within 10s");

        deletion = withPrisma(db, () => deleteInvoiceCore(ID.invoice));

        // THE DETERMINISTIC BARRIER. Only once a THIRD connection confirms
        // Postgres reports backend `pid` (deleteInvoiceCore's own connection,
        // pinned above) holding an un-granted lock request do we know it is
        // actually queued behind the claim's row lock — proof, not a guess
        // from timing. Fails the test outright if that never happens.
        await waitFor(
            async () => {
                const rows = await probe.$queryRaw<Array<{ count: number }>>`
                    SELECT count(*)::int AS count FROM pg_locks WHERE pid = ${pid} AND granted = false
                `;
                return (rows[0]?.count ?? 0) > 0;
            },
            10_000,
            "deleteInvoiceCore never showed up waiting on the ProgressBilling row lock within 10s",
        );

        commitClaim();
        const [claimOutcome, deletionOutcome] = await Promise.allSettled([claim, deletion]);

        if (claimOutcome.status === "rejected") {
            throw new Error(`the claim transaction itself failed: ${claimOutcome.reason}`);
        }
        assert.equal(deletionOutcome.status, "rejected", "expected the delete to be refused once the claim's marker is visible");
        const deleteError = deletionOutcome.status === "rejected" ? deletionOutcome.reason : undefined;
        assert.match((deleteError as Error).message, /previous QuickBooks send ended without a confirmed result/);

        assert.ok(await db.invoice.findUnique({ where: { id: ID.invoice } }), "the invoice must survive");
        assert.ok(await db.progressBilling.findUnique({ where: { id: ID.billing } }), "the progress billing must survive");
    } finally {
        // A no-op if commitClaim already settled `held` above. What actually
        // fires this is anything earlier in the try block throwing (the
        // lock-wait barrier's deadline, a seed failure, ...): it rolls the
        // claim transaction BACK instead of leaving it open, and draining
        // both promises here — via allSettled, so neither rejection escapes
        // unhandled — means nothing is left running behind this test.
        abortClaim(new Error("delete-invoice-qbo-guard-db test cleanup: releasing the held claim transaction"));
        await Promise.allSettled([claim, deletion]);
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
        await probe.$disconnect();
    }
});
