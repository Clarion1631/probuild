/**
 * PUT /api/expenses/[id] — authorization and the deduction-base invariant
 * (Codex PR #442 round 3, items 3, 4 and 5).
 *
 * The route checked only that SOMEBODY was signed in. Once it started accepting
 * `installedAtCustomer` and `taxDeductibleBase`, that meant any authenticated
 * user who knew an expense id could edit the numbers on a state excise return.
 *
 * Prisma, next-auth and the permission reader are patched at require() time —
 * the same shape as tests/job-variance-db.test.ts. No mock.module: CI is
 * Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

interface FakeUser {
    id: string;
    role: string;
    permissions: Record<string, boolean> | null;
    projectIds: string[];
}

let currentUser: FakeUser | null;
let storedExpense: Record<string, unknown> | null;
let updateArgs: { where: unknown; data: Record<string, unknown> } | null;
let estimateItems: { id: string; estimateId: string; projectId: string | null }[];

const fakePrisma = {
    expense: {
        findUnique: async () => storedExpense,
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
            updateArgs = args;
            return { id: "e1", ...args.data };
        },
        deleteMany: async (args: unknown) => {
            deleteArgs = args;
            return { count: 1 };
        },
    },
    estimateItem: {
        findFirst: async (args: { where: Record<string, any> }) => {
            const { id, OR } = args.where;
            const item = estimateItems.find(candidate => candidate.id === id);
            if (!item) return null;
            const branches = (OR ?? []) as Record<string, any>[];
            const ok = branches.some(branch =>
                branch.estimateId !== undefined
                    ? branch.estimateId === item.estimateId
                    : branch.estimate?.projectId === item.projectId,
            );
            return ok ? { id: item.id } : null;
        },
        findUnique: async (args: { where: { id: string } }) => {
            const item = estimateItems.find(candidate => candidate.id === args.where.id);
            return item ? { id: item.id } : null;
        },
    },
    costCode: { findUnique: async () => null },
};

type Handler = (req: any, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let PUT: Handler;
let PATCH: Handler;
let DELETE: Handler;
let deleteArgs: unknown;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        if (id === "@/lib/permissions") {
            return {
                getCurrentUserWithPermissions: async () => currentUser,
                hasPermission: (user: FakeUser | null, key: string) =>
                    !!user && (user.role === "ADMIN" || user.permissions?.[key] === true),
                canAccessProject: (user: FakeUser, projectId: string) =>
                    user.role === "ADMIN" || user.projectIds.includes(projectId),
            };
        }
        if (id === "next-auth/next") return { getServerSession: async () => ({ user: { email: "x@y.z" } }) };
        if (id === "@/lib/auth") return { authOptions: {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/app/api/expenses/[id]/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.PUT !== "function") throw new Error("expense-edit-authz: mocks did not apply");
    PUT = mod.PUT;
    PATCH = mod.PATCH;
    DELETE = mod.DELETE;
});

beforeEach(() => {
    currentUser = { id: "u1", role: "MANAGER", permissions: { timeClock: true, financialReports: true }, projectIds: ["job-1"] };
    storedExpense = {
        qbPurchaseId: null,
        amount: 207.74,
        taxAmount: 16.55,
        taxDeductibleBase: null,
        estimateId: "est-job-1",
        projectId: "job-1",
        estimate: { projectId: "job-1" },
    };
    updateArgs = null;
    deleteArgs = null;
    estimateItems = [
        { id: "item-own", estimateId: "est-job-1", projectId: "job-1" },
        { id: "item-elsewhere", estimateId: "est-job-2", projectId: "job-2" },
    ];
});

function call(body: Record<string, unknown>) {
    return PUT({ json: async () => body } as any, { params: Promise.resolve({ id: "e1" }) });
}

function patch(body: Record<string, unknown>) {
    return PATCH({ json: async () => body } as any, { params: Promise.resolve({ id: "e1" }) });
}

function del() {
    return DELETE({} as any, { params: Promise.resolve({ id: "e1" }) });
}

// ── item 3: authorization ──────────────────────────────────────────────────

test("a signed-in user with no access to the job cannot edit the expense", async () => {
    currentUser = { id: "u2", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["other-job"] };
    const res = await call({ vendor: "Nope" });
    assert.equal(res.status, 403);
    assert.equal(updateArgs, null, "and nothing is written");
});

test("a user without the timeClock permission cannot edit an expense at all", async () => {
    currentUser = { id: "u3", role: "FIELD_CREW", permissions: {}, projectIds: ["job-1"] };
    const res = await call({ vendor: "Nope" });
    assert.equal(res.status, 403);
    assert.equal(updateArgs, null);
});

test("no session at all is 401, not 403", async () => {
    currentUser = null;
    assert.equal((await call({ vendor: "Nope" })).status, 401);
});

test("an expense with no resolvable project fails CLOSED", async () => {
    storedExpense = { ...storedExpense, projectId: null, estimate: { projectId: null } };
    const res = await call({ vendor: "Nope" });
    assert.equal(res.status, 403, "no scope to authorize against means nobody may edit it");
});

test("PUT refuses the tax fields outright — PATCH is their single writer", async () => {
    for (const body of [{ installedAtCustomer: true }, { taxDeductibleBase: 50 }]) {
        const res = await call(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match((await res.json()).error, /PATCH/);
    }
    assert.equal(updateArgs, null);
});

test("PUT is a PARTIAL update: omitted fields keep their values", async () => {
    // It used to write `body.vendor || null` unconditionally, so any request
    // that did not resend every field wiped the ones it left out.
    const res = await call({ amount: "100.00" });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.vendor, undefined);
    assert.equal(updateArgs?.data.date, undefined);
    assert.equal(updateArgs?.data.description, undefined);
    assert.equal(updateArgs?.data.itemId, undefined);
    // ...while an explicitly-sent null still clears.
    await call({ vendor: null });
    assert.equal(updateArgs?.data.vendor, null);
});

// ── item 3: the tax-correction PATCH ───────────────────────────────────────

test("PATCH reaches a QBO-managed row — the population the report is made of", async () => {
    // Every pipeline expense carries a qbPurchaseId, so PUT's mutability guard
    // excluded exactly the rows this correction path exists for.
    storedExpense = { ...storedExpense, qbPurchaseId: "qb-123" };
    const res = await patch({ installedAtCustomer: true, taxDeductibleBase: 50 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.installedAtCustomer, true);
    assert.equal(updateArgs?.data.taxDeductibleBase, 50);
});

test("PATCH touches NOTHING but the three ProBuild-only columns", async () => {
    await patch({ installedAtCustomer: true });
    assert.deepEqual(Object.keys(updateArgs?.data ?? {}), ["installedAtCustomer"]);
    // A caller sending a QBO-synced field is told, not silently ignored.
    const res = await patch({ amount: "1.00" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only edits/);
});

test("PATCH needs financialReports for the tax fields, and project access always", async () => {
    currentUser = { id: "u4", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    assert.equal((await patch({ installedAtCustomer: true })).status, 403);
    currentUser = { id: "u5", role: "MANAGER", permissions: { timeClock: true, financialReports: true }, projectIds: ["other"] };
    assert.equal((await patch({ installedAtCustomer: true })).status, 403);
    currentUser = null;
    assert.equal((await patch({ installedAtCustomer: true })).status, 401);
});

test("PATCH can set installedAtCustomer back to unknown, and rejects a non-tri-state", async () => {
    assert.equal((await patch({ installedAtCustomer: null })).status, 200);
    assert.equal(updateArgs?.data.installedAtCustomer, null);
    assert.equal((await patch({ installedAtCustomer: "yes" })).status, 400);
});

test("PATCH enforces the deduction ceiling", async () => {
    // 207.74 gross − 16.55 tax = 191.19.
    assert.equal((await patch({ taxDeductibleBase: 191.20 })).status, 400);
    assert.equal((await patch({ taxDeductibleBase: 191.19 })).status, 200);
});

// ── item 8: DELETE gets the same gate ──────────────────────────────────────

test("DELETE is authorized like PUT, not merely authenticated", async () => {
    currentUser = { id: "u2", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["other-job"] };
    assert.equal((await del()).status, 403);
    assert.equal(deleteArgs, null, "and nothing is deleted");

    currentUser = { id: "u3", role: "FIELD_CREW", permissions: {}, projectIds: ["job-1"] };
    assert.equal((await del()).status, 403, "no timeClock permission");

    currentUser = null;
    assert.equal((await del()).status, 401);
});

test("DELETE fails closed on an expense with no resolvable project", async () => {
    storedExpense = { ...storedExpense, projectId: null, estimate: { projectId: null } };
    assert.equal((await del()).status, 403);
    assert.equal(deleteArgs, null);
});

test("DELETE still works for someone who may actually do it", async () => {
    assert.equal((await del()).status, 200);
    assert.deepEqual(deleteArgs, { where: { id: "e1", qbPurchaseId: null } });
});

// ── item 4: the invariant is about the RESULTING row ───────────────────────

test("LOWERING the amount cannot strand an impossible base", async () => {
    // The other door into the same illegal state: this request never mentions
    // taxDeductibleBase, so the old check did not run at all.
    storedExpense = { ...storedExpense, taxDeductibleBase: 150 };
    const res = await call({ amount: "100.00" });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
    const body = await res.json();
    assert.match(body.error, /deduction base/i);
});

test("lowering the amount is fine when the resulting row still holds", async () => {
    storedExpense = { ...storedExpense, taxDeductibleBase: 50 };
    assert.equal((await call({ amount: "100.00" })).status, 200);
});

test("a PATCH base is judged against the row's real amount", async () => {
    storedExpense = { ...storedExpense, amount: 60, taxAmount: 5 };
    assert.equal((await patch({ taxDeductibleBase: 56 })).status, 400);
    assert.equal((await patch({ taxDeductibleBase: 55 })).status, 200);
});

// ── item 5: the item link may not cross jobs ───────────────────────────────

test("a line item from another project is refused", async () => {
    const res = await call({ itemId: "item-elsewhere" });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
});

test("a line item on this job's estimate is accepted", async () => {
    assert.equal((await call({ itemId: "item-own" })).status, 200);
    assert.equal(updateArgs?.data.itemId, "item-own");
});
