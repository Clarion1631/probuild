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
 * Opt-in by URL, like tests/qbo-client-lock-db.test.ts: a normal unit run
 * must never be able to write to a developer database. CI's `migrations` job
 * supplies the URL from its Postgres service container — see this file's
 * final comment block for what still needs wiring up before that happens.
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

/** How long the concurrent claim holds its row lock before committing. */
const HOLD_MS = 400;

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
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const other = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        const { deleteInvoiceCore } = await import("../src/lib/billing-core");

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

        let release: () => void = () => {};
        const held = new Promise<void>((r) => { release = r; });
        let claimOpen = false;
        const claim = other.$transaction(async (tx) => {
            await tx.progressBilling.update({ where: { id: ID.billing }, data: { qbSyncError: marker } });
            claimOpen = true;
            await held;
        }, { timeout: 20_000, maxWait: 20_000 });
        while (!claimOpen) await new Promise((r) => setTimeout(r, 10));

        let settled = false;
        const deletion = withPrisma(db, () => deleteInvoiceCore(ID.invoice))
            .then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });

        await new Promise((r) => setTimeout(r, HOLD_MS));
        assert.equal(
            settled, false,
            "deleteInvoiceCore must WAIT on the ProgressBilling row lock — finishing here means it took none",
        );

        release();
        await claim;

        let err: unknown;
        try {
            await deletion;
        } catch (e) {
            err = e;
        }
        assert.ok(err, "expected a refusal, now that the claim's marker is visible");
        assert.match((err as Error).message, /previous QuickBooks send ended without a confirmed result/);

        assert.ok(await db.invoice.findUnique({ where: { id: ID.invoice } }), "the invoice must survive");
        assert.ok(await db.progressBilling.findUnique({ where: { id: ID.billing } }), "the progress billing must survive");
    } finally {
        await teardown(db);
        await db.$disconnect();
        await other.$disconnect();
    }
});

/**
 * NOT YET WIRED TO RUN FOR REAL IN CI.
 *
 * This file is opt-in by DELETE_INVOICE_QBO_GUARD_TEST_URL, same shape as
 * tests/qbo-client-lock-db.test.ts — but that file gets its URL from a
 * DEDICATED `.github/workflows/ci.yml` step in the `migrations` job
 * (`npx tsx --test tests/qbo-client-lock-db.test.ts`, env
 * `QBO_CLIENT_LOCK_TEST_URL: ...`), which is the only job with a Postgres
 * service container. This file is listed in package.json's `test:unit`
 * instead (as asked), but `test:unit` only ever runs from the `build` job
 * (ci.yml: "Hermetic pure-logic suites — no DB, no network, so they belong in
 * this job rather than the Postgres one"), which has no Postgres service and
 * never sets DELETE_INVOICE_QBO_GUARD_TEST_URL. So as CI is wired today, this
 * file's `skip` guard is always true in CI and all three tests above report
 * "skipped", not "passed" — the same is already true of roughly a dozen other
 * *-db.test.ts files package.json lists inside test:unit (e.g.
 * tax-at-source-report-db.test.ts, the payroll-*-lock-db.test.ts cluster).
 * Making it actually run for real needs a step like qbo-client-lock-db's
 * added to the `migrations` job — not done here, since editing the shared CI
 * workflow is outside what this task asked for. Flagged rather than silently
 * left implicit, so the gap is a decision rather than a surprise.
 */
