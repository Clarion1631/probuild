/**
 * deleteProjectsCore / deleteProjectsFailureMessage: a project delete cascades through invoices,
 * milestones, progress billings and retainers, so it must apply the same money rules
 * deleteInvoiceCore applies one invoice at a time, under the documented lock order. No database:
 * a fake tx records every statement (same pattern as tests/delete-invoice-qbo-guard.test.ts).
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

const PROJECT_TAIL = "Open each listed invoice or retainer to see what is holding it. To take a finished or lost job off the projects list without deleting it, set its status to Closed Complete or Closed Lost.";

function milestone(invoiceId: string, overrides: Record<string, any> = {}) {
    return {
        id: `ps-${invoiceId}`, invoiceId, name: "Deposit", status: "Pending",
        qbInvoiceId: null, qbSyncError: null, stripeSessionId: null, stripePaymentIntentId: null,
        ...overrides,
    };
}
function billing(invoiceId: string, overrides: Record<string, any> = {}) {
    return { id: `pb-${invoiceId}`, invoiceId, code: "INV-A1-P1", status: "Draft", qbInvoiceId: null, qbSyncError: null, ...overrides };
}
function invoice(id: string, code: string, projectId: string, overrides: Record<string, any> = {}) {
    return {
        id, code, projectId, status: "Issued", qbInvoiceId: null, qbSyncMarker: null,
        payments: [milestone(id)], progressBillings: [billing(id)],
        ...overrides,
    };
}
function retainer(id: string, code: string, projectId: string, overrides: Record<string, any> = {}) {
    return { id, code, status: "Draft", amountPaid: 0, projectId, clientId: "cli-1", ...overrides };
}

const PROJ_A = { id: "proj-a", name: "Project A" };
const PROJ_B = { id: "proj-b", name: "Project B" };

type DeleteWorld = {
    projects: Array<{ id: string; name: string }>;
    invoices: Array<Record<string, any>>;
    retainers: Array<Record<string, any>>;
    timeEntryCount?: number;
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

async function runDeleteProjects(projectIds: string[], world: DeleteWorld) {
    const { deleteProjectsCore } = await import("../src/lib/billing-core");
    const calls: Array<string | { sql: string; values: unknown[] }> = [];
    let txOptions: any;
    let deleteArgs: any;
    let deleteCount = 0;
    let invoiceFindManyArgs: any;
    let coBillingFindManyArgs: any;
    const tx = {
        $executeRawUnsafe: async (sql: string) => {
            if (sql.includes("pg_advisory_xact_lock_shared")) calls.push("payroll-lock");
            return 1;
        },
        $queryRawUnsafe: async () => [],
        payrollPeriod: { findMany: async () => [] },
        timeEntry: {
            count: async () => {
                calls.push("count:timeEntry");
                return world.timeEntryCount ?? 0;
            },
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
            const sql = strings.join("?");
            calls.push({ sql, values });
            const table = /FROM "(\w+)"/.exec(sql)?.[1] ?? "";
            world.onLock?.(table);
            const ids: string[] = Array.isArray(values[0]) ? values[0] : [];
            if (table === "Project") {
                return sortBy(world.projects.filter((p) => ids.includes(p.id)), [{ id: "asc" }]).map((p) => ({ id: p.id, name: p.name }));
            }
            if (table === "Invoice") {
                return sortBy(world.invoices.filter((i) => ids.includes(i.projectId)), [{ id: "asc" }]).map((i) => ({ id: i.id }));
            }
            if (table === "Retainer") {
                return sortBy(world.retainers.filter((r) => ids.includes(r.projectId)), [{ id: "asc" }])
                    .map((r) => ({ id: r.id, code: r.code, status: r.status, amountPaid: r.amountPaid, projectId: r.projectId }));
            }
            return [];
        },
        invoice: {
            findMany: async (args: any) => {
                calls.push("read:invoice");
                invoiceFindManyArgs = args;
                const ids: string[] = args.where.id.in;
                return sortBy(world.invoices.filter((i) => ids.includes(i.id)), args.orderBy);
            },
        },
        paymentSchedule: {
            findMany: async (args: any) => {
                calls.push("read:co-billing");
                coBillingFindManyArgs = args;
                const ids: string[] = args.where.invoiceId.in;
                return (world.coBilledInvoiceIds ?? []).filter((id) => ids.includes(id)).map((invoiceId) => ({ invoiceId }));
            },
        },
        project: {
            deleteMany: async (args: any) => {
                calls.push("delete:project");
                deleteArgs = args;
                deleteCount++;
                return { count: projectIds.length };
            },
        },
    };
    let error: any;
    await withFakePrisma(
        { $transaction: async (fn: any, opts: any) => { txOptions = opts; return fn(tx); } },
        async () => {
            try {
                await deleteProjectsCore(projectIds);
            } catch (e) {
                error = e;
            }
        },
    );
    return { error, calls, txOptions, deleteArgs, deleteCount, invoiceFindManyArgs, coBillingFindManyArgs };
}

const lockCalls = (calls: Array<any>) => calls.filter((c) => typeof c !== "string") as Array<{ sql: string; values: any[] }>;
const tableOf = (c: { sql: string }) => /FROM "(\w+)"/.exec(c.sql)?.[1];

function cleanWorld(): DeleteWorld {
    return {
        projects: [PROJ_A, PROJ_B],
        invoices: [invoice("inv-a1", "INV-A1", "proj-a"), invoice("inv-b1", "INV-B1", "proj-b")],
        retainers: [retainer("ret-a1", "RT-001", "proj-a")],
    };
}

test("the fixture table has 17 cases", () => {
    assert.equal(DELETE_BLOCKER_CASES.length, 17);
});

test("lock order and modes", async () => {
    const r = await runDeleteProjects(["proj-a", "proj-b"], cleanWorld());
    assert.equal(r.error, undefined);
    const names = r.calls.map((c) => (typeof c === "string" ? c : `lock:${tableOf(c)}`));
    assert.deepEqual(names, [
        "payroll-lock", "count:timeEntry",
        "lock:Project", "lock:ChangeOrder", "lock:Estimate", "lock:Invoice", "lock:PaymentSchedule", "lock:ProgressBilling", "lock:Retainer",
        "read:invoice", "read:co-billing", "delete:project",
    ]);
    const locks = lockCalls(r.calls);
    for (const l of locks) {
        assert.ok(l.sql.includes('ORDER BY "id"'), l.sql);
        if (tableOf(l) === "Estimate") {
            assert.ok(l.sql.trimEnd().endsWith("FOR NO KEY UPDATE"), l.sql);
        } else {
            assert.ok(l.sql.trimEnd().endsWith("FOR UPDATE"), l.sql);
            assert.ok(!l.sql.includes("NO KEY"), l.sql);
        }
    }
    const by = (t: string) => locks.find((l) => tableOf(l) === t)!;
    for (const t of ["Project", "ChangeOrder", "Estimate", "Invoice", "Retainer"]) {
        assert.deepEqual(by(t).values, [["proj-a", "proj-b"]], t);
    }
    assert.deepEqual(by("PaymentSchedule").values, [["inv-a1", "inv-b1"]]);
    assert.deepEqual(by("ProgressBilling").values, [["inv-a1", "inv-b1"]]);
});

test("query shape of the rule reads", async () => {
    const r = await runDeleteProjects(["proj-a"], cleanWorld());
    assert.deepEqual(r.invoiceFindManyArgs.orderBy, [{ projectId: "asc" }, { id: "asc" }]);
    assert.deepEqual(r.invoiceFindManyArgs.include, { payments: true, progressBillings: true });
    assert.deepEqual(r.coBillingFindManyArgs.where.OR, [
        { sourceChangeOrderId: { not: null } },
        { sourceCoScheduleId: { not: null } },
        { coBilling: { isNot: null } },
    ]);
});

test("ids are de-duplicated and sorted for the locks; the delete gets the original array", async () => {
    const input = ["proj-b", "proj-a", "proj-b"];
    const r = await runDeleteProjects(input, cleanWorld());
    assert.equal(r.error, undefined);
    assert.deepEqual(lockCalls(r.calls).find((l) => tableOf(l) === "Project")!.values, [["proj-a", "proj-b"]]);
    assert.deepEqual(r.deleteArgs, { where: { id: { in: input } } });
});

test("transaction options are exactly maxWait 5s and timeout 20s", async () => {
    const r = await runDeleteProjects(["proj-a"], cleanWorld());
    assert.deepEqual(r.txOptions, { maxWait: 5_000, timeout: 20_000 });
});

test("time entries win over everything and nothing else runs", async () => {
    const w = cleanWorld();
    w.timeEntryCount = 2;
    w.invoices[0].payments[0].status = "Paid";
    const r = await runDeleteProjects(["proj-a"], w);
    assert.equal(r.error?.name, "TimeEntriesExistError");
    assert.match(r.error.message, /2 time entries/);
    assert.equal(lockCalls(r.calls).length, 0);
    assert.equal(r.deleteCount, 0);
});

for (const c of DELETE_BLOCKER_CASES) {
    test(`blocker: ${c.name}`, async () => {
        const inv = invoice("inv-a1", "INV-A1", "proj-a");
        const ret = retainer("ret-a1", "RT-001", "proj-a");
        const world: World = { inv, milestone: inv.payments[0], billing: inv.progressBillings[0], retainer: ret, coBilledInvoiceIds: [] };
        c.apply(world);
        const r = await runDeleteProjects(["proj-a"], {
            projects: [PROJ_A], invoices: [inv], retainers: [ret], coBilledInvoiceIds: world.coBilledInvoiceIds,
        });
        assert.ok(r.error, "expected a refusal");
        assert.equal(r.error.name, "DeleteBlockedError");
        assert.equal(r.error.status, 409);
        assert.equal(r.error.code, "PROJECT_DELETE_BLOCKED");
        const code = c.subject === "invoice" ? "INV-A1" : "RT-001";
        assert.equal(
            r.error.message,
            `Cannot delete this project: ${c.subject} ${code} on "Project A" ${c.clause}. Nothing was deleted. ${PROJECT_TAIL}`,
        );
        assert.equal(r.deleteCount, 0);
    });
}

test("rows that are not blockers delete", async () => {
    for (const mutate of [
        (w: DeleteWorld) => { w.invoices[0].payments[0].qbSyncError = "voided"; },
        (w: DeleteWorld) => { w.retainers[0].status = "Sent"; w.retainers[0].amountPaid = 0; },
        (w: DeleteWorld) => { w.retainers[0].status = "Draft"; },
    ]) {
        const w = cleanWorld();
        mutate(w);
        const r = await runDeleteProjects(["proj-a"], w);
        assert.equal(r.error, undefined);
        assert.equal(r.deleteCount, 1);
    }
});

test("priority inside one invoice", async () => {
    const w = cleanWorld();
    w.invoices[0].payments = [milestone("inv-a1", { status: "Paid", stripeSessionId: "cs_test_1" })];
    let r = await runDeleteProjects(["proj-a"], w);
    assert.ok(r.error.message.includes(' on "Project A" has recorded payments.'), r.error.message);

    const w2 = cleanWorld();
    w2.invoices[0].payments = [
        milestone("inv-a1", { id: "ps-1", name: "Deposit", qbInvoiceId: "qb-1" }),
        milestone("inv-a1", { id: "ps-2", name: "Rough-in", stripeSessionId: "cs_test_1" }),
    ];
    r = await runDeleteProjects(["proj-a"], w2);
    assert.ok(r.error.message.includes('is linked or pending in QuickBooks (milestone "Deposit")'), r.error.message);
});

test("bulk: one blocked project refuses the whole batch and only it is named", async () => {
    const w = cleanWorld();
    w.invoices[1].payments[0].status = "Paid";
    const r = await runDeleteProjects(["proj-a", "proj-b"], w);
    assert.ok(r.error.message.startsWith('Cannot delete these projects: invoice INV-B1 on "Project B" has recorded payments.'), r.error.message);
    assert.ok(!r.error.message.includes("Project A"));
    assert.equal(r.deleteCount, 0);
});

test("entries are ordered invoices by (projectId, id), then retainers", async () => {
    const w: DeleteWorld = {
        projects: [PROJ_A, PROJ_B],
        invoices: [
            invoice("inv-b1", "INV-B1", "proj-b", { status: "Paid" }),
            invoice("inv-a1", "INV-A1", "proj-a", { status: "Paid" }),
        ],
        retainers: [retainer("ret-a1", "RT-001", "proj-a", { status: "Paid" })],
    };
    const r = await runDeleteProjects(["proj-a", "proj-b"], w);
    assert.ok(
        r.error.message.includes('invoice INV-A1 on "Project A" is paid or partially paid; invoice INV-B1 on "Project B" is paid or partially paid; retainer RT-001 on "Project A" is marked Paid'),
        r.error.message,
    );
});

test("seven blocked invoices list five and a count", async () => {
    const invoices = Array.from({ length: 7 }, (_, i) => invoice(`inv-a${i + 1}`, `INV-A${i + 1}`, "proj-a", { status: "Paid" }));
    const r = await runDeleteProjects(["proj-a"], { projects: [PROJ_A], invoices, retainers: [] });
    assert.ok(r.error.message.includes("; and 2 more. Nothing was deleted."), r.error.message);
    assert.equal((r.error.message.match(/invoice INV-A\d on/g) ?? []).length, 5);
    assert.ok(!r.error.message.includes("INV-A6 on"));
});

test("happy path deletes once with the original ids", async () => {
    const r = await runDeleteProjects(["proj-a", "proj-b"], cleanWorld());
    assert.equal(r.error, undefined);
    assert.equal(r.deleteCount, 1);
    assert.deepEqual(r.deleteArgs, { where: { id: { in: ["proj-a", "proj-b"] } } });
});

test("a project with no invoices takes no milestone locks and still checks retainers", async () => {
    const w: DeleteWorld = { projects: [PROJ_A], invoices: [], retainers: [retainer("ret-a1", "RT-001", "proj-a")] };
    const r = await runDeleteProjects(["proj-a"], w);
    assert.equal(r.error, undefined);
    const tables = lockCalls(r.calls).map(tableOf);
    assert.ok(!tables.includes("PaymentSchedule") && !tables.includes("ProgressBilling"));
    assert.ok(tables.includes("Retainer"));
    assert.ok(!r.calls.includes("read:invoice"));
    assert.equal(r.deleteCount, 1);

    w.retainers[0].status = "Paid";
    const blocked = await runDeleteProjects(["proj-a"], w);
    assert.ok(blocked.error.message.includes('retainer RT-001 on "Project A" is marked Paid'));
});

test("missing ids: the child locks bind only the projects that exist", async () => {
    const w = cleanWorld();
    w.projects = [PROJ_A];
    const r = await runDeleteProjects(["proj-a", "proj-gone"], w);
    assert.equal(r.error, undefined);
    const locks = lockCalls(r.calls);
    for (const t of ["ChangeOrder", "Estimate", "Invoice", "Retainer"]) {
        assert.deepEqual(locks.find((l) => tableOf(l) === t)!.values, [["proj-a"]], t);
    }
    assert.deepEqual(r.deleteArgs, { where: { id: { in: ["proj-a", "proj-gone"] } } });
});

test("empty selection takes no locks and deletes with an empty list", async () => {
    const r = await runDeleteProjects([], cleanWorld());
    assert.equal(r.error, undefined);
    assert.equal(lockCalls(r.calls).length, 0);
    assert.equal(r.deleteCount, 1);
    assert.deepEqual(r.deleteArgs, { where: { id: { in: [] } } });
});

test("the rules read rows as they are after the locks", async () => {
    const w = cleanWorld();
    w.onLock = (table) => { if (table === "PaymentSchedule") w.invoices[0].payments[0].stripeSessionId = "cs_test_1"; };
    let r = await runDeleteProjects(["proj-a"], w);
    assert.ok(r.error.message.includes('has a Stripe checkout that may still be payable (milestone "Deposit")'), r.error.message);
    assert.equal(r.deleteCount, 0);

    const w2 = cleanWorld();
    w2.onLock = (table) => { if (table === "Retainer") w2.retainers[0].status = "Paid"; };
    r = await runDeleteProjects(["proj-a"], w2);
    assert.ok(r.error.message.includes("is marked Paid"), r.error.message);
    assert.equal(r.deleteCount, 0);
});

test("deleteProjectsFailureMessage", async () => {
    const { deleteProjectsFailureMessage: f, DeleteBlockedError } = await import("../src/lib/billing-core");
    const { TimeEntriesExistError } = await import("../src/lib/payroll-parent-delete");
    assert.equal(f(new DeleteBlockedError(409, "X", "Refused for reasons"), 1), "Refused for reasons");
    const named = new Error("by name");
    named.name = "DeleteBlockedError";
    assert.equal(f(named, 1), "by name");

    const two = new TimeEntriesExistError(2);
    assert.equal(f(two, 1), two.message);
    assert.equal(f(two, 1), "Cannot delete: 2 time entries exist for this record. Payroll history is never deleted this way.");
    assert.equal(
        f(two, 3),
        "Cannot delete these projects: 2 time entries exist across the selected projects, and payroll history is never deleted this way. Deselect the projects that have time entries and try again. Nothing was deleted.",
    );
    assert.equal(
        f(new TimeEntriesExistError(1), 3),
        "Cannot delete these projects: 1 time entry exists across the selected projects, and payroll history is never deleted this way. Deselect the projects that have time entries and try again. Nothing was deleted.",
    );

    const original = console.error;
    let logged = 0;
    console.error = () => { logged++; };
    try {
        assert.equal(
            f(new Error("Invalid `tx.project.deleteMany()` invocation"), 2),
            "Could not delete the selected projects. Nothing was deleted. Try again, and tell support if it keeps failing.",
        );
    } finally {
        console.error = original;
    }
    assert.equal(logged, 1);
});

function slice(source: string, from: string, to: string): string {
    const start = source.indexOf(from);
    assert.ok(start >= 0, `missing ${from}`);
    const end = source.indexOf(to, start + from.length);
    assert.ok(end > start, `missing ${to}`);
    return source.slice(start, end);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

test("source pins: deleteProjects action", () => {
    const body = slice(read("src/lib/actions.ts"), "export async function deleteProjects", "\nexport ");
    const forbidden = body.indexOf('throw new Error("Forbidden")');
    const tryAt = body.indexOf("try {");
    const call = body.indexOf("await deleteProjectsCore(projectIds);");
    assert.ok(forbidden >= 0 && forbidden < tryAt && tryAt < call);
    const catchAt = body.indexOf("} catch (e) {");
    assert.ok(catchAt > call);
    assert.ok(body.indexOf("return { success: false as const, error: deleteProjectsFailureMessage(e, projectIds.length) };", catchAt) > catchAt);
    assert.doesNotMatch(body, /\.project\.deleteMany\(/);
});

test("source pins: ProjectsClient checks the result before touching state", () => {
    const src = read("src/app/projects/ProjectsClient.tsx");
    const slices = [
        slice(src, "async function handleDeleteSelected", "const filteredProjects"),
        slice(src, "async function handleDeleteProject", "async function handleStatusChange"),
    ];
    for (const s of slices) {
        const check = s.indexOf("if (!res.success)");
        assert.ok(check >= 0);
        assert.ok(check < s.indexOf("setProjects("));
        assert.ok(check < s.indexOf("toast.success("));
        assert.ok(s.includes("toast.error(res.error, { duration: 15000 })"));
    }
});

// Characterization test: passes today; exists so a future schema edit cannot quietly make receipts
// or payment evidence cascade away with a Project, Client or Invoice.
function cascadeReachable(schema: string, roots: string[]): Set<string> {
    const edges = new Map<string, Set<string>>(); // parent model -> models deleted with it
    let model: string | null = null;
    for (const line of schema.split(/\r?\n/)) {
        const open = /^model\s+(\w+)\s*\{/.exec(line);
        if (open) { model = open[1]; continue; }
        if (/^\s*\}\s*$/.test(line)) { model = null; continue; }
        if (!model) continue;
        const field = /^\s*\w+\s+(\w+)\[?\]?\??\s.*@relation\(.*onDelete:\s*Cascade/.exec(line);
        if (field) {
            const parent = field[1];
            if (!edges.has(parent)) edges.set(parent, new Set());
            edges.get(parent)!.add(model);
        }
    }
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
        const m = queue.shift()!;
        for (const child of edges.get(m) ?? []) {
            if (!seen.has(child)) { seen.add(child); queue.push(child); }
        }
    }
    return seen;
}

test("schema: no receipt or payment-evidence table is reachable by cascade from Project, Client or Invoice", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const forbidden = ["Expense", "ReceiptIntake", "DepositIngest", "StripeEvent", "PaymentNotification", "BankLine", "RefundEvent"];
    const reached = cascadeReachable(schema, ["Project", "Client", "Invoice"]);
    assert.ok(reached.has("Invoice"), "sanity: the walker follows Project -> Invoice");
    for (const m of forbidden) assert.ok(!reached.has(m), `${m} must not be reachable by onDelete: Cascade`);
    for (const m of ["Expense", "ReceiptIntake"]) {
        const block = new RegExp(String.raw`^model ${m} \{[\s\S]*?^\s*\}\s*$`, "m").exec(schema)?.[0] ?? "";
        assert.match(block, /^\s*project\s+Project\?.*onDelete: SetNull/m, `${m}.project must be onDelete: SetNull`);
    }
    // The walker can fail: flipping Expense.project to Cascade makes Expense reachable.
    const flipped = schema.replace(/^(model Expense \{[\s\S]*?\n\s*project\s+Project\?.*)onDelete: SetNull/m, "$1onDelete: Cascade");
    assert.notEqual(flipped, schema);
    assert.ok(cascadeReachable(flipped, ["Project", "Client", "Invoice"]).has("Expense"));
});
