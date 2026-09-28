/**
 * Shared in-memory world for the offline change-order approval tests.
 *
 * Loads the REAL billing-core, payment-reminders, payment-notifications and the
 * co-billing-sweep route under a scoped CommonJS require() patch (mock.module()
 * is unusable: CI pins Node 20), with only Prisma, the email sender, SMS,
 * next/cache, next/server's after(), and QuickBooks faked. Every send is
 * recorded so a test can prove NOTHING reached the customer.
 *
 * The fake Prisma evaluates `where` clauses with SQL three-valued logic, so a
 * hold clause that is not NULL-safe fails here the same way it would in
 * PostgreSQL (NOT(TRUE AND NULL) is NULL, and a NULL row is filtered out).
 *
 * All fixture data is generic. The repo is public.
 */
import Module from "node:module";

export type Row = Record<string, any>;

export const CLIENT_EMAIL = "customer@example.test";
export const TEAM_EMAIL = "team@example.test";
export const OFFICE_EMAIL = "office@example.test";
export const NOW = new Date("2026-09-28T18:00:00.000Z");

// ── Three-valued where evaluation ──────────────────────────────────────────

type Tri = true | false | null;
const and3 = (values: Tri[]): Tri => (values.includes(false) ? false : values.includes(null) ? null : true);
const or3 = (values: Tri[]): Tri => (values.includes(true) ? true : values.includes(null) ? null : false);
const not3 = (value: Tri): Tri => (value === null ? null : !value);
const RELATIONS = new Set(["invoice", "project", "client", "estimate"]);

function cmp(rowValue: any, op: string, arg: any): Tri {
    const a = rowValue instanceof Date ? rowValue.getTime() : rowValue;
    const b = arg instanceof Date ? arg.getTime() : arg;
    switch (op) {
        case "equals": return a === null || a === undefined ? (b === null ? true : null) : a === b;
        case "not":
            if (b === null) return !(a === null || a === undefined);
            return a === null || a === undefined ? null : a !== b;
        case "in": return a === null || a === undefined ? null : (arg as any[]).includes(rowValue);
        case "notIn": return a === null || a === undefined ? null : !(arg as any[]).includes(rowValue);
        case "lt": return a === null || a === undefined ? null : a < b;
        case "lte": return a === null || a === undefined ? null : a <= b;
        case "gt": return a === null || a === undefined ? null : a > b;
        case "gte": return a === null || a === undefined ? null : a >= b;
        case "startsWith": return a === null || a === undefined ? null : String(a).startsWith(String(b));
        case "contains": return a === null || a === undefined ? null : String(a).includes(String(b));
        default: throw new Error(`fake where: unsupported operator ${op}`);
    }
}

export function evalWhere(row: Row, where: Row | undefined): Tri {
    if (!where) return true;
    const parts: Tri[] = [];
    for (const [key, cond] of Object.entries(where)) {
        if (key === "AND") parts.push(and3((Array.isArray(cond) ? cond : [cond]).map((c: Row) => evalWhere(row, c))));
        else if (key === "OR") parts.push(or3((cond as Row[]).map((c) => evalWhere(row, c))));
        else if (key === "NOT") parts.push(not3(and3((Array.isArray(cond) ? cond : [cond]).map((c: Row) => evalWhere(row, c)))));
        else if (RELATIONS.has(key) && typeof cond === "object" && cond !== null && !(cond instanceof Date)) continue;
        else if (cond === null) parts.push(row[key] === null || row[key] === undefined);
        else if (typeof cond !== "object" || cond instanceof Date) parts.push(cmp(row[key], "equals", cond) === null ? false : row[key] === cond || (cond instanceof Date && row[key] instanceof Date && row[key].getTime() === cond.getTime()));
        else parts.push(and3(Object.entries(cond).map(([op, arg]) => cmp(row[key], op, arg))));
    }
    return and3(parts);
}

const matches = (row: Row, where: Row | undefined) => evalWhere(row, where) === true;

// ── The world ──────────────────────────────────────────────────────────────

export type WorldOptions = {
    pricingType?: "FIXED" | "COST_PLUS";
    status?: string;
    scheduleAmounts?: number[]; // pre-tax CO schedule rows (must sum to the subtotal)
    itemUnitCosts?: number[];
    withInvoice?: boolean;
    signed?: boolean; // customer signed in the portal: approvalSource null, approvedBy set
};

export function makeWorld(options: WorldOptions = {}) {
    const itemCosts = options.itemUnitCosts ?? [1000];
    const subtotal = itemCosts.reduce((sum, value) => sum + value, 0);
    const state: {
        co: Row; items: Row[]; schedules: Row[]; estimate: Row; invoices: Row[]; milestones: Row[]; activity: Row[]; settings: Row;
    } = {
        co: {
            id: "co-1", code: "CO-00001", title: "Example change", status: options.status ?? "Sent",
            pricingType: options.pricingType ?? "FIXED", totalAmount: subtotal, updatedAt: new Date("2026-09-27T12:00:00.000Z"),
            projectId: "proj-1", estimateId: "est-1", markupPercent: options.pricingType === "COST_PLUS" ? 12 : null,
            approvedBy: options.signed ? "Customer A" : null, approvedAt: options.signed ? new Date("2026-09-28T17:00:00.000Z") : null,
            clientSignatureUrl: options.signed ? "https://example.test/sig.png" : null,
            approvalSource: null, approvalMethod: null, approvalNote: null,
        },
        items: itemCosts.map((unitCost, index) => ({ name: `Item ${index + 1}`, type: "Labor", quantity: 1, unitCost })),
        schedules: (options.scheduleAmounts ?? []).map((amount, index) => ({
            id: `cos-${index + 1}`, name: `Payment ${index + 1}`, amount, dueDate: null, order: index, createdAt: new Date(2026, 8, 1, 0, index),
        })),
        estimate: { taxExempt: false, taxRatePercent: 10, taxRateName: "Sales tax" },
        invoices: options.withInvoice === false ? [] : [{
            id: "inv-1", code: "INV-00001", status: "Issued", estimateId: "est-1", projectId: "proj-1",
            subtotal: 5000, taxAmount: 500, totalAmount: 5500, balanceDue: 5500,
        }],
        milestones: [],
        activity: [],
        settings: { timeZone: "America/Los_Angeles", notificationEmail: TEAM_EMAIL, email: OFFICE_EMAIL, companyName: "Test Co", notificationToggles: null, phone: null },
    };

    const emails: Array<{ to: string; subject: string; html: string; options?: Row }> = [];
    const sms: Array<{ to: string; body: string }> = [];
    const qbCalls: string[] = [];
    const fetchCalls: string[] = [];
    const revalidated: string[] = [];
    let seq = 0;

    const invoiceView = (inv: Row) => ({
        ...inv,
        project: { id: "proj-1", name: "Example Project", location: "Example Site", paymentRemindersEnabled: true },
        client: { id: "client-1", name: "Customer A", email: CLIENT_EMAIL },
        payments: state.milestones.filter((m) => m.invoiceId === inv.id),
    });
    const milestoneView = (m: Row) => ({ ...m, invoice: invoiceView(state.invoices.find((i) => i.id === m.invoiceId) ?? state.invoices[0]) });

    const applyData = (row: Row, data: Row) => {
        for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) row[key] = Number(row[key] ?? 0) + Number((value as Row).increment);
            else row[key] = value;
        }
    };
    const touch = (row: Row) => { row.updatedAt = new Date((row.updatedAt as Date).getTime() + 1000); };

    const models: Row = {
        changeOrder: {
            findUnique: async () => ({ ...state.co, project: { name: "Example Project" } }),
            findMany: async ({ where, take }: Row = {}) => [state.co].filter((row) => matches(row, where)).slice(0, take ?? 1000).map((row) => ({ ...row })),
            update: async ({ data }: Row) => { applyData(state.co, data); touch(state.co); return { ...state.co }; },
        },
        changeOrderItem: { findMany: async () => state.items.map((row) => ({ ...row })) },
        changeOrderPaymentSchedule: {
            count: async () => state.schedules.length,
            findMany: async () => state.schedules.map((row) => ({ ...row })),
        },
        estimate: { findUnique: async () => ({ ...state.estimate }) },
        estimatePaymentSchedule: { findMany: async () => [] },
        invoice: {
            findFirst: async () => (state.invoices[0] ? { id: state.invoices[0].id, code: state.invoices[0].code, status: state.invoices[0].status } : null),
            findUnique: async ({ where }: Row) => {
                const inv = state.invoices.find((row) => row.id === where.id);
                return inv ? invoiceView(inv) : null;
            },
            update: async ({ where, data }: Row) => {
                const inv = state.invoices.find((row) => row.id === where.id)!;
                applyData(inv, data);
                return { ...inv };
            },
        },
        paymentSchedule: {
            findMany: async ({ where, take }: Row = {}) => state.milestones.filter((row) => matches(row, where)).slice(0, take ?? 1000).map(milestoneView),
            findFirst: async ({ where }: Row = {}) => {
                const row = state.milestones.find((m) => matches(m, where));
                return row ? milestoneView(row) : null;
            },
            findUnique: async ({ where }: Row) => {
                const row = state.milestones.find((m) => m.id === where.id);
                return row ? milestoneView(row) : null;
            },
            create: async ({ data }: Row) => {
                seq += 1;
                const row = {
                    id: `ms-${seq}`, qbInvoiceSentAt: null, qbInvoiceId: null, qbInvoiceLink: null, lastReminderAt: null, receiptSentAt: null,
                    sourceScheduleId: null, paymentDate: null, paidAt: null, paymentMethod: null, referenceNumber: null, qbSyncError: null,
                    ...data,
                };
                state.milestones.push(row);
                return { ...row };
            },
            update: async ({ where, data }: Row) => {
                const row = state.milestones.find((m) => m.id === where.id)!;
                applyData(row, data);
                return { ...row };
            },
            updateMany: async ({ where, data }: Row) => {
                const hit = state.milestones.filter((m) => matches(m, where));
                for (const row of hit) applyData(row, data);
                return { count: hit.length };
            },
        },
        companySettings: { findUnique: async () => ({ ...state.settings }) },
        activityLog: {
            findFirst: async () => null,
            create: async ({ data }: Row) => { state.activity.push(data); return data; },
        },
    };

    const fakeTx = (): Row => ({
        ...models,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = strings.join("?");
            if (text.includes('FROM "PaymentSchedule"')) {
                const row = state.milestones.find((m) => m.id === values[0]);
                return row ? [{ sourceChangeOrderId: row.sourceChangeOrderId ?? null, qbInvoiceSentAt: row.qbInvoiceSentAt ?? null }] : [];
            }
            if (!text.includes('FROM "ChangeOrder"')) return [];
            const co = { ...state.co };
            return [co];
        },
    });

    const fakePrisma: Row = {
        ...models,
        $transaction: async (callback: (tx: Row) => Promise<unknown>) => {
            const snapshot = structuredClone({ co: state.co, milestones: state.milestones, invoices: state.invoices, activity: state.activity });
            try {
                return await callback(fakeTx());
            } catch (error) {
                state.co = snapshot.co;
                state.milestones = snapshot.milestones;
                state.invoices = snapshot.invoices;
                state.activity = snapshot.activity;
                throw error;
            }
        },
    };

    const sendNotification = async (to: string, subject: string, html: string, _attachments?: unknown, opts?: Row) => {
        emails.push({ to, subject, html, options: opts });
        return { success: true, id: "fake-email" };
    };

    /** Every address a customer could be reached on, across to/cc/bcc/replyTo. */
    const customerEmails = () => emails.filter((mail) => JSON.stringify([mail.to, mail.options]).includes(CLIENT_EMAIL));

    // Anything the fake does not model is an unexpected database read. The real QuickBooks
    // modules load lazily (dynamic import, not interceptable) and their first act is a settings
    // read through Prisma, so an access to an unmodeled model is recorded as a QuickBooks call.
    const guardedPrisma = new Proxy(fakePrisma, {
        get(target, prop) {
            if (prop in target) return target[prop as string];
            if (typeof prop === "symbol" || prop === "then") return undefined;
            return new Proxy({}, {
                get: (_model, method) => (..._args: unknown[]) => {
                    qbCalls.push(`unmodeled db access: ${String(prop)}.${String(method)}`);
                    throw new Error(`unexpected database access: ${String(prop)}.${String(method)}`);
                },
            });
        },
    });

    return { state, prisma: guardedPrisma, emails, sms, qbCalls, fetchCalls, revalidated, sendNotification, customerEmails };
}

export type World = ReturnType<typeof makeWorld>;

// ── Module loading under the require patch ─────────────────────────────────

type Loaded = {
    billing: Row; reminders: Row; notifications: Row; sweep: Row; restore: () => void;
};

let current: World | null = null;
export function setWorld(world: World) { current = world; }

function qbProxy(id: string): unknown {
    return new Proxy({}, {
        get(_target, prop) {
            if (prop === "__esModule") return false;
            if (typeof prop === "symbol" || prop === "then") return undefined;
            return (...args: unknown[]) => {
                current?.qbCalls.push(`${id}.${String(prop)}`);
                void args;
                throw new Error(`QuickBooks must not be reached (${id}.${String(prop)})`);
            };
        },
    });
}

export async function loadModules(): Promise<Loaded> {
    const originalRequire = Module.prototype.require;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
        current?.fetchCalls.push(String(input));
        throw new Error("network must not be reached");
    }) as typeof fetch;

    const prismaProxy = new Proxy({}, { get: (_target, prop) => (current as World).prisma[prop as string] });
    const patched: Record<string, unknown> = {
        "@/lib/prisma": { prisma: prismaProxy },
        "./prisma": { prisma: prismaProxy },
        "./email": { sendNotification: (...args: unknown[]) => (current as World).sendNotification(...(args as [string, string, string])) },
        "@/lib/email": { sendNotification: (...args: unknown[]) => (current as World).sendNotification(...(args as [string, string, string, unknown, Row])) },
        "./sms": { sendSMS: async (to: string, body: string) => { (current as World).sms.push({ to, body }); return { success: true }; } },
        "@/lib/sms": { sendSMS: async (to: string, body: string) => { (current as World).sms.push({ to, body }); return { success: true }; } },
        "next/cache": { revalidatePath: (path: string) => { current?.revalidated.push(path); } },
        "./quickbooks-payments": qbProxy("quickbooks-payments"),
        "@/lib/quickbooks-payments": qbProxy("quickbooks-payments"),
    };
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id in patched) return patched[id];
        if (id === "next/server") {
            const real = originalRequire.call(this, id) as Row;
            return { ...real, after: () => {} };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const restore = () => {
        Module.prototype.require = originalRequire;
        globalThis.fetch = originalFetch;
    };
    try {
        const [billing, reminders, notifications, sweep] = await Promise.all([
            import("../../src/lib/billing-core"),
            import("../../src/lib/payment-reminders"),
            import("../../src/lib/payment-notifications"),
            import("../../src/app/api/cron/co-billing-sweep/route"),
        ]);
        return { billing, reminders, notifications, sweep, restore };
    } catch (error) {
        restore();
        throw error;
    }
}
