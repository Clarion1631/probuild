/**
 * Offline change-order approval against a REAL PostgreSQL, on real connections.
 *
 * tests/change-order-offline-approval-core.test.ts pins the logic with a fake
 * Prisma. Only a real database can show that (a) approval and billing commit or
 * roll back together, and (b) the CO row lock actually serializes an offline
 * approval against a portal signature and against a second offline click.
 *
 * Opt-in by URL like the other DB tests here, so a normal unit run can never
 * touch a developer database. The migrations CI job supplies both URLs (the app's
 * prisma singleton reads DATABASE_URL, the race helpers read PAYROLL_LOCK_TEST_URL).
 * Fixture data is generic; the repo is public.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const singletonUrl = process.env.DATABASE_URL;
const skip = !databaseUrl
    ? "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL"
    : !singletonUrl || new URL(singletonUrl).pathname !== new URL(databaseUrl).pathname
        ? "DATABASE_URL must point at the same disposable database (the app's prisma singleton reads it)"
        : false;

type Seeded = { clientId: string; projectId: string; estimateId: string; invoiceId: string | null; changeOrderId: string };

const ACTOR = { userId: "db-test-user", name: "Jordan Lee" };
const quiet = {
    logActivity: async () => {},
    applySchedule: async () => {},
    notifyTeam: (async () => ({ success: true })) as never,
    revalidatePath: () => {},
};

async function seed(db: PrismaClient, tag: string, opts: { withInvoice?: boolean } = {}): Promise<Seeded> {
    const client = await db.client.create({ data: { name: `Offline CO ${tag}`, initials: "OC" } });
    const project = await db.project.create({ data: { name: `Offline CO Project ${tag}`, clientId: client.id } });
    const estimate = await db.estimate.create({
        data: { title: `Offline CO Est ${tag}`, code: `EST-OC-${tag}`, projectId: project.id, totalAmount: 5000, balanceDue: 5000, taxRatePercent: 10, taxRateName: "Sales tax" },
    });
    const invoice = opts.withInvoice === false ? null : await db.invoice.create({
        data: {
            code: `INV-OC-${tag}`, projectId: project.id, clientId: client.id, estimateId: estimate.id,
            status: "Issued", subtotal: 5000, taxAmount: 500, totalAmount: 5500, balanceDue: 5500,
        },
    });
    const changeOrder = await db.changeOrder.create({
        data: {
            projectId: project.id, estimateId: estimate.id, code: `CO-OC-${tag}`, title: "Example change", status: "Sent",
            pricingType: "FIXED", totalAmount: 1000,
            items: { create: [{ name: "Example item", type: "Labor", quantity: 1, unitCost: 1000, total: 1000 }] },
            paymentSchedules: { create: [{ name: "Deposit", amount: 400, order: 0 }, { name: "Final", amount: 600, order: 1 }] },
        },
    });
    return { clientId: client.id, projectId: project.id, estimateId: estimate.id, invoiceId: invoice?.id ?? null, changeOrderId: changeOrder.id };
}

async function cleanup(db: PrismaClient, ids: Seeded) {
    const drop = (run: () => Promise<unknown>) => run().catch(() => {});
    await drop(() => db.paymentSchedule.deleteMany({ where: { sourceChangeOrderId: ids.changeOrderId } }));
    await drop(() => db.invoice.deleteMany({ where: { projectId: ids.projectId } }));
    await drop(() => db.changeOrder.deleteMany({ where: { id: ids.changeOrderId } }));
    await drop(() => db.estimate.deleteMany({ where: { id: ids.estimateId } }));
    await drop(() => db.project.deleteMany({ where: { id: ids.projectId } }));
    await drop(() => db.client.deleteMany({ where: { id: ids.clientId } }));
}

async function withWorld(tag: string, opts: { withInvoice?: boolean }, body: (db: PrismaClient, ids: Seeded) => Promise<void>) {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const ids = await seed(db, tag, opts);
    try {
        await body(db, ids);
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
    }
}

async function offline(ids: Seeded, db: PrismaClient) {
    const { approveChangeOrderOfflineCore } = await import("../src/lib/billing-core");
    const row = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId }, select: { updatedAt: true } });
    return approveChangeOrderOfflineCore(ids.changeOrderId, {
        method: "PHONE",
        approvedOn: new Date().toISOString().slice(0, 10),
        note: "internal",
        expectedUpdatedAt: row.updatedAt.toISOString(),
        actor: ACTOR,
    }, quiet);
}

const milestones = (db: PrismaClient, ids: Seeded) => db.paymentSchedule.findMany({ where: { sourceChangeOrderId: ids.changeOrderId }, orderBy: { createdAt: "asc" } });

test("approval and billing commit together, invoice totals incremented once", { skip }, async () => {
    await withWorld(`a${Date.now()}`, {}, async (db, ids) => {
        const result = await offline(ids, db);
        assert.equal(result.ok, true, JSON.stringify(result));
        const co = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId } });
        assert.equal(co.status, "Approved");
        assert.equal(co.approvalSource, "OFFLINE");
        assert.equal(co.approvalMethod, "PHONE");
        assert.equal(co.approvedBy, "Jordan Lee");
        assert.equal(co.clientSignatureUrl, null);
        const rows = await milestones(db, ids);
        assert.deepEqual(rows.map((row) => Number(row.amount)), [440, 660]);
        assert.ok(rows.every((row) => row.qbInvoiceSentAt === null && row.status === "Pending"));
        const invoice = await db.invoice.findUniqueOrThrow({ where: { id: ids.invoiceId! } });
        assert.equal(Number(invoice.totalAmount), 5500 + 1100);
        assert.equal(Number(invoice.balanceDue), 5500 + 1100);
    });
});

test("no invoice on the project: BILLING_FAILED, and nothing is left behind", { skip }, async () => {
    await withWorld(`b${Date.now()}`, { withInvoice: false }, async (db, ids) => {
        const result = await offline(ids, db);
        assert.equal(result.ok, false);
        assert.equal((result as { code: string }).code, "BILLING_FAILED");
        const co = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId } });
        assert.equal(co.status, "Sent", "the status write rolled back with the failed billing");
        assert.equal(co.approvedBy, null);
        assert.equal(co.approvedAt, null);
        assert.equal(co.approvalSource, null);
        assert.equal((await milestones(db, ids)).length, 0);
    });
});

test("a double call produces one approval and one set of milestones", { skip }, async () => {
    await withWorld(`c${Date.now()}`, {}, async (db, ids) => {
        const first = await offline(ids, db);
        const second = await offline(ids, db);
        assert.equal(first.ok, true);
        assert.equal(second.ok, false);
        assert.equal((second as { code: string }).code, "ALREADY_APPROVED");
        assert.equal((await milestones(db, ids)).length, 2);
    });
});

test("two offline approvals racing: one wins, one is ALREADY_APPROVED, one set of milestones", { skip }, async () => {
    await withWorld(`d${Date.now()}`, {}, async (db, ids) => {
        const { approveChangeOrderOfflineCore } = await import("../src/lib/billing-core");
        const row = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId }, select: { updatedAt: true } });
        const call = () => approveChangeOrderOfflineCore(ids.changeOrderId, {
            method: "TEXT", approvedOn: new Date().toISOString().slice(0, 10), expectedUpdatedAt: row.updatedAt.toISOString(), actor: ACTOR,
        }, quiet);
        const results = await Promise.all([call(), call()]);
        assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
        const loser = results.find((r) => !r.ok) as { code: string };
        assert.ok(["ALREADY_APPROVED", "STALE"].includes(loser.code), loser.code);
        assert.equal((await milestones(db, ids)).length, 2);
    });
});

test("offline approval racing a portal signature: exactly one Approved outcome", { skip }, async () => {
    await withWorld(`e${Date.now()}`, {}, async (db, ids) => {
        const { approveChangeOrderOfflineCore } = await import("../src/lib/billing-core");
        const { approveChangeOrderCore } = await import("../src/lib/change-order-core");
        const row = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId }, select: { updatedAt: true } });
        const [offlineResult, portalResult] = await Promise.allSettled([
            approveChangeOrderOfflineCore(ids.changeOrderId, {
                method: "EMAIL", approvedOn: new Date().toISOString().slice(0, 10), expectedUpdatedAt: row.updatedAt.toISOString(), actor: ACTOR,
            }, quiet),
            approveChangeOrderCore(ids.changeOrderId, { signatureName: "Customer A", clientSignatureUrl: "https://example.test/sig.png", approvedAt: new Date() }),
        ]);

        const offlineWon = offlineResult.status === "fulfilled" && offlineResult.value.ok === true;
        const portalWon = portalResult.status === "fulfilled" && portalResult.value !== null;
        assert.equal(Number(offlineWon) + Number(portalWon), 1, "exactly one approval wins");

        const co = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId } });
        assert.equal(co.status, "Approved");
        const rows = await milestones(db, ids);
        if (offlineWon) {
            assert.equal(portalResult.status, "rejected");
            assert.match(String((portalResult as PromiseRejectedResult).reason?.message), /must be Sent/);
            assert.equal(co.approvalSource, "OFFLINE");
            assert.equal(rows.length, 2);
        } else {
            assert.equal(offlineResult.status, "fulfilled");
            assert.equal((offlineResult as PromiseFulfilledResult<{ ok: boolean; code?: string }>).value.code, "ALREADY_APPROVED");
            assert.equal(co.approvalSource, null);
            assert.equal(co.approvedBy, "Customer A");
            assert.equal(rows.length, 0, "the portal core does not bill; the offline path added nothing");
        }
    });
});
