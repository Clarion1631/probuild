/**
 * deleteClientCore: Invoice and Retainer cascade from Client, so a client delete must apply the
 * same money rules as deleteInvoiceCore, under the documented lock order (Invoice before Client).
 * No database: a fake tx records every statement.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DELETE_BLOCKER_CASES, type World } from "./fixtures/delete-blockers";

async function withFakePrisma<T>(fake: any, fn: () => Promise<T>): Promise<T> {
    const previous = (globalThis as any).prisma;
    (globalThis as any).prisma = fake;
    try {
        return await fn();
    } finally {
        (globalThis as any).prisma = previous;
    }
}

function milestone(invoiceId: string, overrides: Record<string, any> = {}) {
    return {
        id: `ps-${invoiceId}`, invoiceId, name: "Deposit", status: "Pending",
        qbInvoiceId: null, qbSyncError: null, stripeSessionId: null, stripePaymentIntentId: null,
        ...overrides,
    };
}
function billing(invoiceId: string) {
    return { id: `pb-${invoiceId}`, invoiceId, code: "INV-A1-P1", status: "Draft", qbInvoiceId: null, qbSyncError: null };
}
function driftInvoice(overrides: Record<string, any> = {}) {
    return {
        id: "inv-c1", code: "INV-C1", projectId: "proj-a", clientId: "cli-1", status: "Issued",
        qbInvoiceId: null, qbSyncMarker: null,
        payments: [milestone("inv-c1")], progressBillings: [billing("inv-c1")],
        ...overrides,
    };
}
function retainer(overrides: Record<string, any> = {}) {
    return { id: "ret-a1", code: "RT-001", status: "Draft", amountPaid: 0, projectId: "proj-a", clientId: "cli-1", ...overrides };
}

type ClientWorld = {
    client?: { id: string } | null;
    invoicesAtPeek: Array<Record<string, any>>;
    invoicesAfterLock?: Array<Record<string, any>>;
    retainers?: Array<Record<string, any>>;
    projectCount?: number;
    leadCount?: number;
    coBilledInvoiceIds?: string[];
    onLock?: (table: string) => void;
};

function sortBy<T extends Record<string, any>>(rows: T[], orderBy: Array<Record<string, "asc" | "desc">> | undefined): T[] {
    const keys = (orderBy ?? []).map((o) => Object.keys(o)[0]);
    return [...rows].sort((x, y) => {
        for (const k of keys) {
            if (x[k] < y[k]) return -1;
            if (x[k] > y[k]) return 1;
        }
        return 0;
    });
}

async function runDeleteClient(clientId: string, world: ClientWorld) {
    const { deleteClientCore } = await import("../src/lib/billing-core");
    const calls: Array<string | { sql: string; values: any[] }> = [];
    let idOnlyReads = 0;
    let deleteCount = 0;
    const tx = {
        invoice: {
            findMany: async (args: any) => {
                if (args.select) {
                    idOnlyReads++;
                    const rows = idOnlyReads === 1 ? world.invoicesAtPeek : (world.invoicesAfterLock ?? world.invoicesAtPeek);
                    calls.push(idOnlyReads === 1 ? "peek:invoice" : "reread:invoice");
                    return rows.map((i) => ({ id: i.id }));
                }
                calls.push("read:invoice");
                const ids: string[] = args.where.id.in;
                const pool = world.invoicesAfterLock ?? world.invoicesAtPeek;
                return sortBy(pool.filter((i) => ids.includes(i.id)), args.orderBy);
            },
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
            const sql = strings.join("?");
            calls.push({ sql, values });
            const table = /FROM "(\w+)"/.exec(sql)?.[1] ?? "";
            world.onLock?.(table);
            if (table === "Retainer") {
                return sortBy((world.retainers ?? []).filter((r) => r.clientId === values[0]), [{ id: "asc" }])
                    .map((r) => ({ id: r.id, code: r.code, status: r.status, amountPaid: r.amountPaid, projectId: r.projectId }));
            }
            return [];
        },
        client: {
            findUnique: async ({ where }: any) => {
                calls.push("read:client");
                return world.client === undefined ? { id: where.id } : world.client;
            },
            delete: async () => { calls.push("delete:client"); deleteCount++; return {}; },
        },
        project: { count: async () => { calls.push("count:project"); return world.projectCount ?? 0; } },
        lead: { count: async () => { calls.push("count:lead"); return world.leadCount ?? 0; } },
        paymentSchedule: {
            findMany: async (args: any) => {
                calls.push("read:co-billing");
                const ids: string[] = args.where.invoiceId.in;
                return (world.coBilledInvoiceIds ?? []).filter((id) => ids.includes(id)).map((invoiceId) => ({ invoiceId }));
            },
        },
    };
    let error: any;
    await withFakePrisma({ $transaction: async (fn: any) => fn(tx) }, async () => {
        try {
            await deleteClientCore(clientId);
        } catch (e) {
            error = e;
        }
    });
    return { error, calls, deleteCount };
}

const tableOf = (c: any) => (typeof c === "string" ? undefined : /FROM "(\w+)"/.exec(c.sql)?.[1]);
const lockOf = (calls: any[], table: string) => calls.find((c) => tableOf(c) === table);
const indexOfLock = (calls: any[], table: string) => calls.findIndex((c) => tableOf(c) === table);

test("lock order: peek, Invoice, Client, re-read, counts, children, rules, delete", async () => {
    const r = await runDeleteClient("cli-1", { invoicesAtPeek: [driftInvoice()], retainers: [retainer()] });
    assert.equal(r.error, undefined);
    const names = r.calls.map((c) => (typeof c === "string" ? c : `lock:${tableOf(c)}`));
    assert.deepEqual(names, [
        "peek:invoice", "lock:Invoice", "lock:Client", "read:client", "reread:invoice", "count:project", "count:lead",
        "lock:PaymentSchedule", "lock:ProgressBilling", "lock:Retainer", "read:invoice", "read:co-billing", "delete:client",
    ]);
    const inv = lockOf(r.calls, "Invoice");
    assert.deepEqual(inv.values, [["inv-c1"]]);
    assert.ok(inv.sql.trimEnd().endsWith("FOR UPDATE"));
    const cli = lockOf(r.calls, "Client");
    assert.deepEqual(cli.values, ["cli-1"]);
    assert.ok(cli.sql.trimEnd().endsWith("FOR UPDATE"));
    const ret = lockOf(r.calls, "Retainer");
    assert.deepEqual(ret.values, ["cli-1"]);
    assert.ok(ret.sql.trimEnd().endsWith("FOR UPDATE"));
    assert.equal(r.deleteCount, 1);
});

test("no invoices: no invoice-level locks, the client and retainer locks still run", async () => {
    const r = await runDeleteClient("cli-1", { invoicesAtPeek: [] });
    assert.equal(r.error, undefined);
    for (const t of ["Invoice", "PaymentSchedule", "ProgressBilling"]) assert.equal(indexOfLock(r.calls, t), -1, t);
    assert.ok(indexOfLock(r.calls, "Client") >= 0);
    assert.ok(indexOfLock(r.calls, "Retainer") >= 0);
    assert.equal(r.deleteCount, 1);
});

test("a missing client is a 404", async () => {
    const r = await runDeleteClient("cli-1", { invoicesAtPeek: [], client: null });
    assert.equal(r.error.name, "DeleteBlockedError");
    assert.equal(r.error.status, 404);
    assert.equal(r.error.code, "CLIENT_NOT_FOUND");
    assert.equal(r.error.message, "Client not found");
    assert.equal(r.deleteCount, 0);
});

test("an invoice that appears after the peek refuses with CLIENT_CHANGED", async () => {
    const r = await runDeleteClient("cli-1", { invoicesAtPeek: [], invoicesAfterLock: [driftInvoice()] });
    assert.equal(r.error.status, 409);
    assert.equal(r.error.code, "CLIENT_CHANGED");
    assert.equal(r.error.message, "This client's invoices changed while it was being deleted. Nothing was deleted. Refresh and try again.");
    for (const t of ["PaymentSchedule", "ProgressBilling", "Retainer"]) assert.equal(indexOfLock(r.calls, t), -1, t);
    assert.equal(r.deleteCount, 0);
});

test("projects and leads refuse with the exact texts", async () => {
    const cases: Array<[number, number, string]> = [
        [2, 0, "This client still has 2 projects. A client can only be deleted once it has no projects or leads. Nothing was deleted."],
        [0, 1, "This client still has 1 lead. A client can only be deleted once it has no projects or leads. Nothing was deleted."],
        [1, 2, "This client still has 1 project and 2 leads. A client can only be deleted once it has no projects or leads. Nothing was deleted."],
    ];
    for (const [projectCount, leadCount, message] of cases) {
        const r = await runDeleteClient("cli-1", { invoicesAtPeek: [], projectCount, leadCount });
        assert.equal(r.error.status, 409);
        assert.equal(r.error.code, "CLIENT_HAS_PROJECTS");
        assert.equal(r.error.message, message);
        assert.equal(r.deleteCount, 0);
    }
});

for (const c of DELETE_BLOCKER_CASES) {
    test(`blocker: ${c.name}`, async () => {
        const inv = driftInvoice();
        const ret = retainer();
        const world: World = { inv, milestone: inv.payments[0], billing: inv.progressBillings[0], retainer: ret, coBilledInvoiceIds: [] };
        c.apply(world);
        const r = await runDeleteClient("cli-1", {
            invoicesAtPeek: [inv], retainers: [ret], coBilledInvoiceIds: world.coBilledInvoiceIds,
        });
        assert.ok(r.error, "expected a refusal");
        assert.equal(r.error.status, 409);
        assert.equal(r.error.code, "CLIENT_DELETE_BLOCKED");
        const code = c.subject === "invoice" ? "INV-C1" : "RT-001";
        assert.equal(
            r.error.message,
            `Cannot delete this client: ${c.subject} ${code} ${c.clause}. Nothing was deleted. Open each listed invoice or retainer to see what is holding it.`,
        );
        assert.equal(r.deleteCount, 0);
    });
}

test("a clean drift invoice and a Draft retainer delete", async () => {
    const r = await runDeleteClient("cli-1", { invoicesAtPeek: [driftInvoice()], retainers: [retainer()] });
    assert.equal(r.error, undefined);
    assert.equal(r.deleteCount, 1);
});

test("blocked invoice and blocked retainer share one message, invoice first", async () => {
    const r = await runDeleteClient("cli-1", {
        invoicesAtPeek: [driftInvoice({ status: "Paid" })],
        retainers: [retainer({ status: "Paid" })],
    });
    assert.equal(
        r.error.message,
        "Cannot delete this client: invoice INV-C1 is paid or partially paid; retainer RT-001 is marked Paid. Nothing was deleted. Open each listed invoice or retainer to see what is holding it.",
    );
});

test("the rules read rows as they are after the locks", async () => {
    const inv = driftInvoice();
    let r = await runDeleteClient("cli-1", {
        invoicesAtPeek: [inv],
        onLock: (t) => { if (t === "PaymentSchedule") inv.payments[0].status = "Paid"; },
    });
    assert.ok(r.error, "expected a refusal");
    assert.ok(r.error.message.includes("has recorded payments"));

    const ret = retainer();
    r = await runDeleteClient("cli-1", {
        invoicesAtPeek: [],
        retainers: [ret],
        onLock: (t) => { if (t === "Retainer") ret.status = "Paid"; },
    });
    assert.ok(r.error, "expected a refusal");
    assert.ok(r.error.message.includes("retainer RT-001 is marked Paid"));
});

test("source pins: the route", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/api/clients/[id]/route.ts"), "utf8");
    assert.ok(src.includes('import { deleteClientCore, isDeleteBlockedError } from "@/lib/billing-core";'));
    assert.ok(!src.includes("prisma.client.delete("));
    const handler = src.slice(src.indexOf("export async function DELETE"));
    const guard = handler.indexOf("await requireManagerSession()");
    assert.ok(guard >= 0 && guard < handler.indexOf("deleteClientCore("));
    assert.ok(handler.includes("isDeleteBlockedError(error)"));
    assert.ok(handler.includes("status: error.status"));
});
