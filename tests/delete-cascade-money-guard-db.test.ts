/**
 * deleteProjectsCore and deleteClientCore (src/lib/billing-core.ts), against a REAL PostgreSQL.
 *
 * tests/delete-projects-money-guard.test.ts and tests/delete-client-money-guard.test.ts drive the
 * guards with a fake `tx` that records SQL text and bound values. A fake cannot execute SQL, so
 * this file is the only proof that:
 *  - the set-based `ANY(${ids}::text[]) ... ORDER BY "id" FOR [NO KEY] UPDATE` statements run
 *    through Prisma on Postgres (a bad statement would break every project delete),
 *  - the PaymentSchedule lock really blocks create-session's lock-free `stripeSessionId` write,
 *  - the Estimate lock is held in the weaker FOR NO KEY UPDATE mode (an FK check, FOR KEY SHARE,
 *    is not blocked; FOR SHARE is).
 *
 * Interleavings are proven deterministically, like tests/delete-invoice-qbo-guard-db.test.ts: the
 * delete's connection is pinned to one known backend pid (`connection_limit=1`) and a THIRD
 * connection polls `pg_locks` until that pid holds an un-granted request, with a hard deadline.
 *
 * Opt-in by URL: a normal unit run must never be able to write to a developer database. CI's
 * `migrations` job supplies the URL from its Postgres service container.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DELETE_CASCADE_MONEY_GUARD_TEST_URL;
const skip = !databaseUrl && "set DELETE_CASCADE_MONEY_GUARD_TEST_URL to a disposable PostgreSQL URL";

/** Ids are fixed and suffixed so teardown can delete exactly what was made. */
const ID = {
    client: "cli-delcasctest",
    otherClient: "cli2-delcasctest",
    project: "proj-delcasctest",
    estimate: "est-delcasctest",
    changeOrder: "co-delcasctest",
    invoice: "inv-delcasctest",
    schedule: "ps-delcasctest",
    billing: "pb-delcasctest",
    retainer: "ret-delcasctest",
    driftInvoice: "inv2-delcasctest",
    driftSchedule: "ps2-delcasctest",
    driftRetainer: "ret2-delcasctest",
};

async function seed(db: PrismaClient) {
    await teardown(db);
    await db.client.create({ data: { id: ID.client, name: "Delete Cascade Test Client", initials: "DC" } });
    await db.client.create({ data: { id: ID.otherClient, name: "Delete Cascade Other Client", initials: "DO" } });
    await db.project.create({ data: { id: ID.project, name: "Delete Cascade Test Project", clientId: ID.client } });
    await db.estimate.create({
        data: { id: ID.estimate, title: "Delete Cascade Estimate", code: "EST-DELCASC", totalAmount: 0, balanceDue: 0, projectId: ID.project },
    });
    await db.changeOrder.create({
        data: { id: ID.changeOrder, projectId: ID.project, estimateId: ID.estimate, code: "CO-DELCASC", title: "Delete Cascade CO", status: "Draft" },
    });
    await db.invoice.create({
        data: { id: ID.invoice, code: "INV-DELCASC-1", projectId: ID.project, clientId: ID.client, totalAmount: 1000, balanceDue: 1000 },
    });
    await db.paymentSchedule.create({
        data: { id: ID.schedule, invoiceId: ID.invoice, name: "Rough-in", amount: 500, status: "Pending" },
    });
    await db.progressBilling.create({
        data: {
            id: ID.billing, invoiceId: ID.invoice, code: "INV-DELCASC-P1",
            description: "Rough-in complete", status: "Draft", subtotal: 500, total: 500,
        },
    });
    await db.retainer.create({
        data: { id: ID.retainer, code: "RT-DELCASC", projectId: ID.project, clientId: ID.client, status: "Draft", totalAmount: 0 },
    });
}

/** A second invoice and retainer on the SAME project whose clientId names another client. */
async function seedDrift(db: PrismaClient) {
    await db.invoice.create({
        data: { id: ID.driftInvoice, code: "INV-DELCASC-2", projectId: ID.project, clientId: ID.otherClient, totalAmount: 100, balanceDue: 100 },
    });
    await db.paymentSchedule.create({
        data: { id: ID.driftSchedule, invoiceId: ID.driftInvoice, name: "Deposit", amount: 100, status: "Pending" },
    });
    await db.retainer.create({
        data: { id: ID.driftRetainer, code: "RT-DELCASC-2", projectId: ID.project, clientId: ID.otherClient, status: "Draft", totalAmount: 0 },
    });
}

async function teardown(db: PrismaClient) {
    await db.progressBilling.deleteMany({ where: { id: ID.billing } });
    await db.paymentSchedule.deleteMany({ where: { id: { in: [ID.schedule, ID.driftSchedule] } } });
    await db.invoice.deleteMany({ where: { id: { in: [ID.invoice, ID.driftInvoice] } } });
    await db.retainer.deleteMany({ where: { id: { in: [ID.retainer, ID.driftRetainer] } } });
    await db.changeOrder.deleteMany({ where: { id: ID.changeOrder } });
    await db.estimate.deleteMany({ where: { id: ID.estimate } });
    await db.project.deleteMany({ where: { id: ID.project } });
    await db.client.deleteMany({ where: { id: { in: [ID.client, ID.otherClient] } } });
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

/** Poll `check` until true, or reject once `deadlineMs` elapses. No unbounded loop, no fixed sleep. */
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

function withConnectionLimit(url: string, limit: number): string {
    const parsed = new URL(url);
    parsed.searchParams.set("connection_limit", String(limit));
    return parsed.toString();
}

function newClient(url = databaseUrl!) {
    return new PrismaClient({ datasources: { db: { url } } });
}

async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    return undefined;
}

const exists = async (db: PrismaClient, model: string, id: string) =>
    !!(await (db as any)[model].findUnique({ where: { id } }));

/** True once `pid` has an un-granted lock request, seen from a THIRD connection. */
function waitingOn(probe: PrismaClient, pid: number, what: string) {
    return waitFor(
        async () => {
            const rows = await probe.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_locks WHERE pid = ${pid} AND granted = false
            `;
            return (rows[0]?.count ?? 0) > 0;
        },
        10_000,
        `the delete never showed up waiting on ${what} within 10s`,
    );
}

test("a clean project deletes with its invoices, retainers and change orders; the estimate survives detached", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        const { deleteProjectsCore } = await import("../src/lib/billing-core");
        await withPrisma(db, () => deleteProjectsCore([ID.project]));
        assert.equal(await exists(db, "project", ID.project), false);
        assert.equal(await exists(db, "invoice", ID.invoice), false);
        assert.equal(await exists(db, "paymentSchedule", ID.schedule), false);
        assert.equal(await exists(db, "progressBilling", ID.billing), false);
        assert.equal(await exists(db, "retainer", ID.retainer), false);
        assert.equal(await exists(db, "changeOrder", ID.changeOrder), false);
        const estimate = await db.estimate.findUnique({ where: { id: ID.estimate } });
        assert.ok(estimate, "the estimate survives");
        assert.equal(estimate!.projectId, null);
        assert.equal(await exists(db, "client", ID.client), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a project with an open Stripe checkout refuses and nothing is deleted", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        await db.paymentSchedule.update({ where: { id: ID.schedule }, data: { stripeSessionId: "cs_test_delcasc" } });
        const { deleteProjectsCore } = await import("../src/lib/billing-core");
        const err = await rejection(withPrisma(db, () => deleteProjectsCore([ID.project])));
        assert.ok(err, "expected a refusal");
        assert.match(err.message, /has a Stripe checkout that may still be payable/);
        assert.equal(await exists(db, "project", ID.project), true);
        assert.equal(await exists(db, "invoice", ID.invoice), true);
        assert.equal(await exists(db, "paymentSchedule", ID.schedule), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a project with a Paid retainer refuses", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        await db.retainer.update({ where: { id: ID.retainer }, data: { status: "Paid" } });
        const { deleteProjectsCore } = await import("../src/lib/billing-core");
        const err = await rejection(withPrisma(db, () => deleteProjectsCore([ID.project])));
        assert.ok(err, "expected a refusal");
        assert.match(err.message, /retainer RT-DELCASC on "[^"]+" is marked Paid/);
        assert.equal(await exists(db, "project", ID.project), true);
        assert.equal(await exists(db, "retainer", ID.retainer), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a concurrent, lock-free checkout write blocks the project delete, which then refuses", { skip }, async () => {
    const db = newClient(withConnectionLimit(databaseUrl!, 1));
    const other = newClient();
    const probe = newClient();
    let commit: () => void = () => {};
    let abort: (_reason: unknown) => void = () => {};
    let writer: Promise<unknown> = Promise.resolve();
    let deletion: Promise<unknown> = Promise.resolve();
    try {
        await seed(db);
        const { deleteProjectsCore } = await import("../src/lib/billing-core");
        const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

        // create-session's real write is a bare prisma.paymentSchedule.update. Held open here.
        const held = new Promise<void>((resolve, reject) => { commit = resolve; abort = reject; });
        let open = false;
        writer = other.$transaction(async (tx) => {
            await tx.paymentSchedule.update({ where: { id: ID.schedule }, data: { stripeSessionId: "cs_test_delcasc" } });
            open = true;
            await held;
        }, { timeout: 20_000, maxWait: 20_000 });
        await waitFor(() => open, 10_000, "the writer's UPDATE never ran within 10s");

        deletion = withPrisma(db, () => deleteProjectsCore([ID.project]));
        await waitingOn(probe, pid, "the PaymentSchedule row lock");

        commit();
        const [writerOutcome, deletionOutcome] = await Promise.allSettled([writer, deletion]);
        if (writerOutcome.status === "rejected") throw new Error(`the writer transaction failed: ${writerOutcome.reason}`);
        assert.equal(deletionOutcome.status, "rejected", "expected the delete to be refused once the session id is visible");
        assert.match((deletionOutcome as PromiseRejectedResult).reason.message, /has a Stripe checkout that may still be payable/);
        assert.equal(await exists(db, "project", ID.project), true);
        assert.equal(await exists(db, "invoice", ID.invoice), true);
        assert.equal(await exists(db, "paymentSchedule", ID.schedule), true);
    } finally {
        abort(new Error("delete-cascade-money-guard-db test cleanup"));
        await Promise.allSettled([writer, deletion]);
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
        await probe.$disconnect();
    }
});

test("the project delete holds the Estimate row in FOR NO KEY UPDATE: FK checks pass, FOR SHARE waits", { skip }, async () => {
    const db = newClient(withConnectionLimit(databaseUrl!, 1));
    const other = newClient();
    const probe = newClient();
    let commit: () => void = () => {};
    let abort: (_reason: unknown) => void = () => {};
    let holder: Promise<unknown> = Promise.resolve();
    let deletion: Promise<unknown> = Promise.resolve();
    try {
        await seed(db);
        const { deleteProjectsCore } = await import("../src/lib/billing-core");
        const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;

        // Hold the Invoice row so the delete stops AFTER it took the Project, ChangeOrder and Estimate locks.
        const held = new Promise<void>((resolve, reject) => { commit = resolve; abort = reject; });
        let open = false;
        holder = other.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${ID.invoice} FOR UPDATE`;
            open = true;
            await held;
        }, { timeout: 20_000, maxWait: 20_000 });
        await waitFor(() => open, 10_000, "the holder's Invoice lock never landed within 10s");

        deletion = withPrisma(db, () => deleteProjectsCore([ID.project]));
        await waitingOn(probe, pid, "the Invoice row lock");

        // An FK check takes FOR KEY SHARE on the estimate: must not be blocked.
        await probe.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
            await tx.$queryRaw`SELECT 1 FROM "Estimate" WHERE "id" = ${ID.estimate} FOR KEY SHARE`;
        });
        // FOR SHARE conflicts with FOR NO KEY UPDATE: proves the estimate lock is really held.
        const shareErr = await rejection(probe.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
            await tx.$queryRaw`SELECT 1 FROM "Estimate" WHERE "id" = ${ID.estimate} FOR SHARE`;
        }));
        assert.ok(shareErr, "expected FOR SHARE to time out against the delete's estimate lock");
        assert.match(String(shareErr.message ?? shareErr) + String(shareErr.code ?? ""), /55P03|lock timeout/i);

        commit();
        const [holderOutcome, deletionOutcome] = await Promise.allSettled([holder, deletion]);
        if (holderOutcome.status === "rejected") throw new Error(`the holder transaction failed: ${holderOutcome.reason}`);
        assert.equal(deletionOutcome.status, "fulfilled", `expected the delete to finish: ${(deletionOutcome as any).reason}`);
        assert.equal(await exists(db, "project", ID.project), false);
    } finally {
        abort(new Error("delete-cascade-money-guard-db test cleanup"));
        await Promise.allSettled([holder, deletion]);
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
        await probe.$disconnect();
    }
});

test("a client that still has a project refuses with CLIENT_HAS_PROJECTS", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        const { deleteClientCore, isDeleteBlockedError } = await import("../src/lib/billing-core");
        const err = await rejection(withPrisma(db, () => deleteClientCore(ID.client)));
        assert.ok(err && isDeleteBlockedError(err), "expected a DeleteBlockedError");
        assert.equal(err.status, 409);
        assert.equal(err.code, "CLIENT_HAS_PROJECTS");
        assert.equal(await exists(db, "client", ID.client), true);
        assert.equal(await exists(db, "project", ID.project), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a drifted client with clean money deletes with its invoice and retainer; everything else survives", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        await seedDrift(db);
        const { deleteClientCore } = await import("../src/lib/billing-core");
        await withPrisma(db, () => deleteClientCore(ID.otherClient));
        assert.equal(await exists(db, "client", ID.otherClient), false);
        assert.equal(await exists(db, "invoice", ID.driftInvoice), false);
        assert.equal(await exists(db, "paymentSchedule", ID.driftSchedule), false);
        assert.equal(await exists(db, "retainer", ID.driftRetainer), false);
        assert.equal(await exists(db, "project", ID.project), true);
        assert.equal(await exists(db, "invoice", ID.invoice), true);
        assert.equal(await exists(db, "retainer", ID.retainer), true);
        assert.equal(await exists(db, "client", ID.client), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a drifted client with a Paid milestone refuses", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        await seedDrift(db);
        await db.paymentSchedule.update({ where: { id: ID.driftSchedule }, data: { status: "Paid" } });
        const { deleteClientCore } = await import("../src/lib/billing-core");
        const err = await rejection(withPrisma(db, () => deleteClientCore(ID.otherClient)));
        assert.ok(err, "expected a refusal");
        assert.equal(err.status, 409);
        assert.equal(err.code, "CLIENT_DELETE_BLOCKED");
        assert.match(err.message, /has recorded payments/);
        assert.equal(await exists(db, "client", ID.otherClient), true);
        assert.equal(await exists(db, "invoice", ID.driftInvoice), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("a drifted client with a Partially Paid retainer refuses", { skip }, async () => {
    const db = newClient();
    try {
        await seed(db);
        await seedDrift(db);
        await db.retainer.update({ where: { id: ID.driftRetainer }, data: { status: "Partially Paid" } });
        const { deleteClientCore } = await import("../src/lib/billing-core");
        const err = await rejection(withPrisma(db, () => deleteClientCore(ID.otherClient)));
        assert.ok(err, "expected a refusal");
        assert.equal(err.status, 409);
        assert.equal(err.code, "CLIENT_DELETE_BLOCKED");
        assert.match(err.message, /retainer \S+ is marked Partially Paid/);
        assert.equal(await exists(db, "client", ID.otherClient), true);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});
