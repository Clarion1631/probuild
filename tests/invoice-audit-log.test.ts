/**
 * Audit trail for invoice CREATE and DELETE.
 *
 * Added after INV-00321 (2026-08-20/24): a duplicate invoice was created from
 * an estimate, sent, then deleted, and nobody could say who did either — the
 * activity log recorded `sent_invoice` but nothing for create/delete.
 *
 * Two layers, following the pattern of tests/deposit-sweep.test.ts:
 *
 *  1. billing-core.ts's `createInvoiceFromEstimateCore` (the shared core used
 *     by the UI action, the estimate-signing flow, and the MCP connector) —
 *     against a fake Prisma, with only "./prisma", "next/cache" and
 *     "./activity-log" patched via the scoped CJS require() trick (`mock.module`
 *     is unusable — CI pins Node 20).
 *
 *  2. actions.ts's `deleteInvoice` (the UI server action) — same technique,
 *     with "next-auth" also patched so the call authenticates as a fake ADMIN
 *     staff user without a real session.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Row = Record<string, any>;

// ── Shared fake-Prisma store ────────────────────────────────────────────────

function makeStore() {
    return {
        users: [] as Row[],
        estimates: [] as Row[],
        estimatePaymentSchedules: [] as Row[],
        projects: [] as Row[],
        invoices: [] as Row[],
        paymentSchedules: [] as Row[],
        activityLogRows: [] as Row[],
        invoiceNumberSeq: 300,
        /** One-shot hook fired right after invoice.create() inserts a row —
         *  used to simulate a concurrent request's invoice landing in the
         *  window between this call and the "who won" re-query. */
        onInvoiceCreated: null as ((row: Row) => void) | null,
    };
}

/** Reads back an activityLog row the way a caller of logActivity sees it —
 *  metadata round-tripped through JSON, same as the real writer. */
function readActivityLog(store: ReturnType<typeof makeStore>): Row[] {
    return store.activityLogRows.map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null }));
}

function makeFakePrisma(store: ReturnType<typeof makeStore>) {
    const self: Row = {
        user: {
            findUnique: async ({ where }: Row) =>
                store.users.find((u) => u.email === String(where.email).toLowerCase()) ?? null,
        },
        estimate: {
            findUnique: async ({ where }: Row) => store.estimates.find((e) => e.id === where.id) ?? null,
        },
        estimatePaymentSchedule: {
            findMany: async ({ where }: Row) =>
                store.estimatePaymentSchedules.filter((s) => s.estimateId === where.estimateId),
        },
        project: {
            findUnique: async ({ where }: Row) => store.projects.find((p) => p.id === where.id) ?? null,
        },
        companySettings: {
            findUnique: async () => null,
        },
        activityLog: {
            create: async ({ data }: Row) => {
                const row = { id: `al-${store.activityLogRows.length + 1}`, createdAt: new Date(), ...data };
                store.activityLogRows.push(row);
                return { ...row };
            },
        },
        invoice: {
            create: async ({ data }: Row) => {
                store.invoiceNumberSeq += 1;
                const row = {
                    id: `inv-${store.invoiceNumberSeq}`,
                    number: store.invoiceNumberSeq,
                    createdAt: new Date(),
                    sentAt: null,
                    qbInvoiceId: null,
                    ...data,
                };
                store.invoices.push(row);
                if (store.onInvoiceCreated) {
                    const hook = store.onInvoiceCreated;
                    store.onInvoiceCreated = null;
                    hook(row);
                }
                return { ...row };
            },
            update: async ({ where, data }: Row) => {
                const row = store.invoices.find((i) => i.id === where.id);
                if (!row) throw new Error("fake prisma: invoice.update matched nothing");
                Object.assign(row, data);
                return { ...row };
            },
            findFirst: async ({ where }: Row) => {
                const hits = store.invoices.filter((i) => (where.estimateId ? i.estimateId === where.estimateId : true));
                return hits[0] ?? null;
            },
            findMany: async ({ where }: Row) =>
                store.invoices
                    .filter((i) => (where?.estimateId ? i.estimateId === where.estimateId : true))
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)),
            deleteMany: async ({ where }: Row) => {
                const before = store.invoices.length;
                store.invoices = store.invoices.filter((i) => {
                    const match =
                        i.id === where.id &&
                        (where.status === undefined || i.status === where.status) &&
                        (where.sentAt === null ? i.sentAt == null : true);
                    return !match;
                });
                return { count: before - store.invoices.length };
            },
            findUnique: async ({ where, include }: Row) => {
                const row = store.invoices.find((i) => i.id === where.id);
                if (!row) return null;
                if (include?.payments) {
                    return { ...row, payments: store.paymentSchedules.filter((p) => p.invoiceId === row.id) };
                }
                return { ...row };
            },
            delete: async ({ where }: Row) => {
                store.invoices = store.invoices.filter((i) => i.id !== where.id);
                return {};
            },
        },
        paymentSchedule: {
            create: async ({ data }: Row) => {
                const row = { id: `ps-${store.paymentSchedules.length + 1}`, createdAt: new Date(), ...data };
                store.paymentSchedules.push(row);
                return { ...row };
            },
            findFirst: async () => null, // no CO-billing milestones in these fixtures
        },
        $queryRaw: async () => [],
        $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(self),
    };
    return self;
}

// ── Load billing-core.ts under the patch ────────────────────────────────────

let failNextActivityLog = false;
const throwingFakeActivityLog = {
    logActivity: async (entry: Row) => {
        actionsActivityLogCalls.push(entry);
        if (failNextActivityLog) {
            failNextActivityLog = false;
            throw new Error("simulated activity-log outage");
        }
    },
};
const actionsActivityLogCalls: Row[] = [];

let billingStore: ReturnType<typeof makeStore>;
let createInvoiceFromEstimateCore: (estimateId: string, actor?: Row) => Promise<Row>;
let createInvoiceFromEstimateGuarded: (estimateId: string, mcpActor?: Row) => Promise<Row>;

let actionsStore: ReturnType<typeof makeStore>;
let deleteInvoice: (invoiceId: string) => Promise<Row>;
const sessionEmail = "pm@example.com";

before(async () => {
    const originalRequire = Module.prototype.require;

    // --- billing-core.ts ---
    // logActivityLazy() dynamically `await import("./activity-log")`s at CALL
    // time, which resolves through Node's real ESM loader, not
    // Module.prototype.require — so patching that specifier here wouldn't stick
    // past this before() block. Instead: patch "./prisma" for BOTH
    // billing-core.ts and activity-log.ts to the same fake, and import
    // activity-log.ts once, right here, while the patch is live — ESM caches by
    // resolved file, so its later `import("./activity-log")` from inside
    // billing-core.ts reuses this already-evaluated instance (prisma binding and
    // all) instead of re-loading for real.
    billingStore = makeStore();
    const billingFakePrisma = makeFakePrisma(billingStore);
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "./prisma" || id === "@/lib/prisma") return { prisma: billingFakePrisma };
        if (id === "next/cache") return { revalidatePath: () => {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    let billingMod: Row;
    try {
        await import("../src/lib/activity-log");
        billingMod = await import("../src/lib/billing-core");
    } finally {
        Module.prototype.require = originalRequire;
    }
    createInvoiceFromEstimateCore = billingMod.createInvoiceFromEstimateCore;
    createInvoiceFromEstimateGuarded = billingMod.createInvoiceFromEstimateGuarded;

    // --- actions.ts ---
    // deleteInvoice's `logActivity` is a STATIC top-level import in actions.ts
    // (`import { logActivity } from "./activity-log"`), bound once when the
    // module loads — so patching it here for the duration of this import is
    // enough; no dynamic-import workaround needed for this side.
    actionsStore = makeStore();
    const actionsFakePrisma = makeFakePrisma(actionsStore);
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "./prisma" || id === "@/lib/prisma") return { prisma: actionsFakePrisma };
        if (id === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn };
        if (id === "next/server") return { after: () => {} };
        if (id === "next-auth" || id === "next-auth/next") return { getServerSession: async () => ({ user: { email: sessionEmail } }) };
        if (id === "./activity-log") return throwingFakeActivityLog;
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;
    let actionsMod: Row;
    try {
        actionsMod = await import("../src/lib/actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    deleteInvoice = actionsMod.deleteInvoice;

    // deleteInvoice's CO-billing guard dynamically imports "./billing-core" and
    // calls assertInvoiceHasNoChangeOrderBilling(tx, ...) — it only touches the
    // `tx` argument the caller passes in (never the module's own `prisma`
    // singleton), so it's safe that the cached billing-core.ts instance (from
    // the section above) is bound to the OTHER fake prisma.

    actionsStore.users.push({
        id: "user-1",
        email: sessionEmail,
        name: "Pat Manager",
        role: "ADMIN",
        status: "ACTIVE",
        permissions: null,
        projectAccess: [],
        assignedProjects: [],
    });
});

// ── 1. created_invoice — create-from-estimate ───────────────────────────────

test("createInvoiceFromEstimateCore logs created_invoice with estimate + milestone metadata", async () => {
    billingStore.activityLogRows.length = 0;
    billingStore.estimates.push({
        id: "est-1",
        code: "EST-00099",
        projectId: "proj-1",
        totalAmount: 10000,
        taxRatePercent: 8.5,
        taxExempt: false,
    });
    billingStore.projects.push({ id: "proj-1", clientId: "client-1" });
    billingStore.estimatePaymentSchedules.push(
        { id: "eps-1", estimateId: "est-1", order: 1, name: "Deposit", amount: 5000, status: "Pending" },
        { id: "eps-2", estimateId: "est-1", order: 2, name: "Final", amount: 5000, status: "Pending" },
    );

    const result = await createInvoiceFromEstimateCore("est-1", {
        source: "mcp",
        actorType: "SYSTEM",
        actorName: "SYSTEM:justin-ai",
        actorUserId: null,
    });

    const entry = readActivityLog(billingStore).find((c) => c.action === "created_invoice");
    assert.ok(entry, "created_invoice was logged");
    assert.equal(entry.projectId, "proj-1");
    assert.equal(entry.entityId, result.id);
    assert.equal(entry.actorType, "SYSTEM");
    assert.equal(entry.actorName, "SYSTEM:justin-ai");
    assert.equal(entry.metadata.estimateCode, "EST-00099");
    assert.equal(entry.metadata.estimateId, "est-1");
    assert.equal(entry.metadata.milestoneCount, 2);
    assert.equal(entry.metadata.source, "mcp");
    assert.ok(entry.metadata.total > 0);
});

test("createInvoiceFromEstimateGuarded logs deleted_invoice for a race-duplicate cleanup", async () => {
    billingStore.activityLogRows.length = 0;
    billingStore.estimates.push({
        id: "est-2",
        code: "EST-00100",
        projectId: "proj-2",
        totalAmount: 4000,
        taxRatePercent: 0,
        taxExempt: true,
    });
    billingStore.projects.push({ id: "proj-2", clientId: "client-2" });
    // Simulate a concurrent request's invoice landing right after OUR create
    // call — same window createInvoiceFromEstimateGuarded's own comment
    // describes. It sorts first by createdAt, so it wins and ours gets deleted.
    billingStore.onInvoiceCreated = () => {
        billingStore.invoices.push({
            id: "inv-winner",
            code: "INV-00050",
            projectId: "proj-2",
            clientId: "client-2",
            estimateId: "est-2",
            status: "Draft",
            totalAmount: 4000,
            balanceDue: 4000,
            subtotal: 4000,
            taxRate: 0,
            taxAmount: 0,
            createdAt: new Date(Date.now() - 60_000),
            sentAt: null,
        });
    };

    const result = await createInvoiceFromEstimateGuarded("est-2", { actorName: "SYSTEM:richard-ai" });

    assert.equal(result.ok, true);
    assert.equal(result.invoiceCode, "INV-00050");

    const entry = readActivityLog(billingStore).find((c) => c.action === "deleted_invoice");
    assert.ok(entry, "deleted_invoice was logged for the compensating delete");
    assert.equal(entry.actorName, "SYSTEM:richard-ai");
    assert.equal(entry.metadata.hadBeenSent, false);
    assert.equal(entry.metadata.source, "mcp");
    assert.equal(entry.metadata.reason, "concurrent-duplicate-cleanup");
});

// ── 2. deleted_invoice — UI delete, sent milestone, and logging-failure resilience ──

test("deleteInvoice logs deleted_invoice with hadBeenSent true and the full milestone snapshot", async () => {
    actionsActivityLogCalls.length = 0;
    failNextActivityLog = false;
    actionsStore.invoices.push({
        id: "inv-321",
        code: "INV-00321",
        projectId: "proj-9",
        clientId: "client-9",
        estimateId: null,
        status: "Issued",
        totalAmount: 8000,
        balanceDue: 8000,
        sentAt: new Date("2026-08-20"),
        createdAt: new Date("2026-08-20"),
    });
    actionsStore.paymentSchedules.push(
        {
            id: "ps-321-a",
            invoiceId: "inv-321",
            name: "Deposit",
            amount: 4000,
            status: "Pending",
            qbInvoiceSentAt: new Date("2026-08-21"),
            qbInvoiceId: "qbo-abc",
        },
        {
            id: "ps-321-b",
            invoiceId: "inv-321",
            name: "Final",
            amount: 4000,
            status: "Pending",
            qbInvoiceSentAt: null,
            qbInvoiceId: null,
        },
    );

    const result = await deleteInvoice("inv-321");

    assert.equal(result.success, true, JSON.stringify(result));

    const entry = actionsActivityLogCalls.find((c) => c.action === "deleted_invoice" && c.entityId === "inv-321");
    assert.ok(entry, "deleted_invoice was logged");
    assert.equal(entry.actorType, "TEAM");
    assert.equal(entry.actorName, "Pat Manager");
    assert.equal(entry.metadata.hadBeenSent, true);
    assert.equal(entry.metadata.code, "INV-00321");
    assert.equal(entry.metadata.source, "ui");
    assert.equal(entry.metadata.milestones.length, 2);
    const deposit = entry.metadata.milestones.find((m: Row) => m.name === "Deposit");
    assert.equal(deposit.qbInvoiceId, "qbo-abc");
    assert.ok(deposit.lastEmailedAt);

    assert.equal(actionsStore.invoices.find((i) => i.id === "inv-321"), undefined, "invoice row was actually deleted");
});

test("deleteInvoice still deletes the invoice when the activity log write fails", async () => {
    actionsStore.invoices.push({
        id: "inv-999",
        code: "INV-00999",
        projectId: "proj-10",
        clientId: "client-10",
        estimateId: null,
        status: "Draft",
        totalAmount: 1500,
        balanceDue: 1500,
        sentAt: null,
        createdAt: new Date(),
    });

    failNextActivityLog = true;
    const result = await deleteInvoice("inv-999");

    assert.equal(result.success, true, "a logging failure must never block the delete");
    assert.equal(actionsStore.invoices.find((i) => i.id === "inv-999"), undefined, "invoice row was still deleted");
});
