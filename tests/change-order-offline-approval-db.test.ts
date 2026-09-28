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

// ── Reminder hold, on real SQL ──────────────────────────────────────────────

const DAY_MS = 86_400_000;
type Hook = { afterSelect: null | (() => Promise<void>) };
const hook: Hook = { afterSelect: null };
const remindedTo: string[] = [];
let sendPaymentReminders: ((opts?: { dryRun?: boolean }) => Promise<{ sent: number; skipped: number }>) | null = null;

/**
 * payment-reminders is loaded ONCE with a thin Prisma wrapper that delegates to the real client, plus a
 * recorder in place of the email sender. The wrapper's only trick is `hook.afterSelect`, which runs after the
 * candidate SELECT and before the claim, so a test can change a milestone in exactly that window.
 */
async function loadReminders() {
    if (sendPaymentReminders) return sendPaymentReminders;
    const { prisma: real } = await import("../src/lib/prisma");
    const bindOn = (target: object, prop: string | symbol) => {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
    };
    const wrapped = new Proxy(real, {
        get(target, prop) {
            if (prop !== "paymentSchedule") return bindOn(target, prop);
            const model = Reflect.get(target, prop) as unknown as Record<string, (...args: unknown[]) => unknown>;
            return new Proxy(model, {
                get(m, method) {
                    if (method !== "findMany") return bindOn(m, method);
                    return async (args: unknown) => {
                        const rows = await m.findMany(args);
                        const run = hook.afterSelect;
                        hook.afterSelect = null;
                        if (run) await run();
                        return rows;
                    };
                },
            });
        },
    });
    const { default: Module } = await import("node:module");
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") return { prisma: wrapped };
        if (id === "@/lib/email") return { sendNotification: async (to: string) => { remindedTo.push(to); return { success: true }; } };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    try {
        const mod = await import("../src/lib/payment-reminders");
        sendPaymentReminders = mod.sendPaymentReminders;
    } finally {
        Module.prototype.require = originalRequire;
    }
    return sendPaymentReminders!;
}

type ReminderWorld = { db: PrismaClient; email: string; ids: Seeded; invoiceId: string; offlineCoId: string; ordinary: string; derived: string };

async function reminderWorld(tag: string, body: (w: ReminderWorld) => Promise<void>) {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const email = `offline-co-${tag}@example.test`;
    const ids = await seed(db, tag);
    await db.client.update({ where: { id: ids.clientId }, data: { email } });
    await db.project.update({ where: { id: ids.projectId }, data: { paymentRemindersEnabled: true } });
    const offlineCo = await db.changeOrder.create({
        data: {
            projectId: ids.projectId, estimateId: ids.estimateId, code: `CO-OFF-${tag}`, title: "Offline example", status: "Approved",
            pricingType: "FIXED", totalAmount: 500, approvalSource: "OFFLINE", approvalMethod: "PHONE", approvedBy: "Jordan Lee", approvedAt: new Date(),
        },
    });
    const due = () => new Date(Date.now() + DAY_MS);
    const link = "https://example.test/pay";
    const ordinary = await db.paymentSchedule.create({ data: { invoiceId: ids.invoiceId!, name: "Ordinary deposit", amount: 100, dueDate: due(), qbInvoiceLink: link } });
    const derived = await db.paymentSchedule.create({
        data: { invoiceId: ids.invoiceId!, name: `${offlineCo.code} — Payment 1`, amount: 550, dueDate: due(), qbInvoiceLink: link, sourceChangeOrderId: offlineCo.id },
    });
    try {
        await body({ db, email, ids, invoiceId: ids.invoiceId!, offlineCoId: offlineCo.id, ordinary: ordinary.id, derived: derived.id });
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
    }
}

const reminded = (db: PrismaClient, id: string) => db.paymentSchedule.findUniqueOrThrow({ where: { id }, select: { lastReminderAt: true } }).then((r) => r.lastReminderAt !== null);

test("reminder hold (real SQL): ordinary unsent is reminded, offline-derived unsent is not, and it is after qbInvoiceSentAt is stamped", { skip }, async () => {
    const run = await loadReminders();
    await reminderWorld(`h1${Date.now()}`, async ({ db, ordinary, derived, email }) => {
        remindedTo.length = 0;
        await run();
        assert.equal(await reminded(db, ordinary), true, "an ordinary unrequested milestone keeps its reminders (the NULL trap)");
        assert.equal(await reminded(db, derived), false, "an offline-derived, never-requested milestone is held");
        assert.equal(remindedTo.filter((to) => to === email).length, 1, "exactly one email to the client: the ordinary milestone");

        await db.paymentSchedule.update({ where: { id: derived }, data: { qbInvoiceSentAt: new Date() } });
        await run();
        assert.equal(await reminded(db, derived), true, "once staff has sent it, normal reminder rules apply again");
    });
});

test("reminder claim (real SQL): a milestone linked to an offline CO after candidate selection is not claimed", { skip }, async () => {
    const run = await loadReminders();
    await reminderWorld(`h2${Date.now()}`, async ({ db, ordinary, ids, email }) => {
        // Only the ordinary milestone is under test; park the derived one so it cannot muddy the count.
        await db.paymentSchedule.updateMany({ where: { invoiceId: ids.invoiceId! , id: { not: ordinary } }, data: { dueDate: null } });
        remindedTo.length = 0;
        hook.afterSelect = async () => {
            // After the SELECT (and after the offline-id snapshot) an office approval lands: a new offline CO is
            // committed and the hand-made milestone is linked to it.
            const late = await db.changeOrder.create({
                data: {
                    projectId: ids.projectId, estimateId: ids.estimateId, code: `CO-LATE-${Date.now()}`, title: "Late offline", status: "Approved",
                    pricingType: "FIXED", totalAmount: 100, approvalSource: "OFFLINE", approvalMethod: "TEXT", approvedBy: "Jordan Lee", approvedAt: new Date(),
                },
            });
            await db.paymentSchedule.update({ where: { id: ordinary }, data: { sourceChangeOrderId: late.id } });
        };
        const result = await run();
        assert.equal(hook.afterSelect, null, "the hook ran between selection and claim");
        assert.equal(await reminded(db, ordinary), false, "the claim refused a milestone that is now offline-derived");
        assert.equal(remindedTo.filter((to) => to === email).length, 0, "nothing was emailed");
        assert.ok(result.skipped >= 1);
    });
});

test("a hand-made milestone reused by the approval is stamped with the change order's provenance", { skip }, async () => {
    await withWorld(`r${Date.now()}`, {}, async (db, ids) => {
        const { code } = await db.changeOrder.findUniqueOrThrow({ where: { id: ids.changeOrderId }, select: { code: true } });
        const manual = await db.paymentSchedule.create({
            data: { invoiceId: ids.invoiceId!, name: `${code} — Deposit`, amount: 440, pretaxAmount: 400, taxAmount: 40, status: "Paid", paymentDate: new Date(), paidAt: new Date() },
        });
        const result = await offline(ids, db);
        assert.equal(result.ok, true, JSON.stringify(result));
        const rows = await milestones(db, ids);
        assert.equal(rows.length, 2, "the manual milestone was reused, one new one created");
        const reused = rows.find((row) => row.id === manual.id)!;
        assert.equal(reused.sourceChangeOrderId, ids.changeOrderId);
        assert.ok(reused.sourceCoScheduleId, "the schedule link was attached too");
        assert.equal(Number(reused.amount), 440);
    });
});
