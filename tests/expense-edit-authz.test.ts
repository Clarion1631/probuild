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
            // The route now scopes purely on the RESOLVED project — no
            // estimateId escape hatch — so the stub models exactly that.
            const item = estimateItems.find(candidate => candidate.id === args.where.id);
            if (!item) return null;
            return args.where.estimate?.projectId === item.projectId ? { id: item.id } : null;
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
        taxAtSource: true,
        taxDeductibleBase: null,
        needsTaxReview: false,
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
    // `needsTaxReview` rides along because answering IS clearing the flag —
    // still nothing outside the ProBuild-only set.
    assert.deepEqual(Object.keys(updateArgs?.data ?? {}), ["installedAtCustomer", "needsTaxReview"]);
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

test("PATCH can supply the tax a rejected OCR read left behind", async () => {
    // Booking now stores only the tax buildGroups accepted, so a check or a
    // nonsense read lands with none. Without this path the receipt could never
    // reach the filing report at all.
    storedExpense = { ...storedExpense, qbPurchaseId: "qb-1", taxAmount: null, taxAtSource: false };
    const res = await patch({ taxAmount: 16.55, taxAtSource: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, 16.55);
    assert.equal(updateArgs?.data.taxAtSource, true);
});

test("PATCH refuses an implausible tax rather than storing it", async () => {
    // The transposed-OCR shape: a $207.74 receipt "with" $207.74 of tax. 12% of
    // 207.74 is 24.93.
    storedExpense = { ...storedExpense, taxAmount: null, taxAtSource: false };
    const res = await patch({ taxAmount: 207.74 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /implausible/);
    assert.equal((await patch({ taxAmount: 24.93 })).status, 200, "the ceiling itself is allowed");
    assert.equal((await patch({ taxAmount: 24.94 })).status, 400);
    assert.equal((await patch({ taxAmount: -1 })).status, 400);
    assert.equal((await patch({ taxAmount: 0 })).status, 200, "zero tax is a real answer");
});

test("taxAtSource cannot claim tax that is not there", async () => {
    storedExpense = { ...storedExpense, taxAmount: null, taxAtSource: false };
    assert.equal((await patch({ taxAtSource: true })).status, 400);
    assert.equal((await patch({ taxAtSource: true, taxAmount: 10 })).status, 200);
    assert.equal((await patch({ taxAtSource: "yes" })).status, 400);
});

test("raising the tax re-checks an allocation this request never mentioned", async () => {
    // The ceiling is amount - tax, so a tax-only edit can invalidate a base
    // that was legal a moment ago.
    storedExpense = { ...storedExpense, taxDeductibleBase: 200 };
    assert.equal((await patch({ taxAmount: 20 })).status, 400, "207.74 - 20 = 187.74 < 200");
    assert.equal((await patch({ taxAmount: 5 })).status, 200, "207.74 - 5 = 202.74 >= 200");
});

test("the tax fields need financialReports too", async () => {
    currentUser = { id: "u6", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    assert.equal((await patch({ taxAmount: 10 })).status, 403);
    assert.equal((await patch({ taxAtSource: false })).status, 403);
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

// ── the needsTaxReview lifecycle (Codex round 7, item 3) ───────────────────

test("a human answer CLEARS needsTaxReview in the same write", async () => {
    // Two statements would leave a window where the report sees an answered
    // row it still refuses to count.
    storedExpense = { ...storedExpense, needsTaxReview: true };
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.installedAtCustomer, true);
    assert.equal(updateArgs?.data.needsTaxReview, false, "answered, so no longer awaiting one");
});

test("every tax field clears the flag, and a phase-only edit does not", async () => {
    storedExpense = { ...storedExpense, needsTaxReview: true };
    for (const body of [
        { taxAmount: 10 },
        { taxAtSource: false },
        { taxDeductibleBase: 50 },
        { installedAtCustomer: false },
    ]) {
        await patch(body);
        assert.equal(updateArgs?.data.needsTaxReview, false, JSON.stringify(body));
    }
    // A cost-code edit is not an answer to the tax question, so the row stays
    // flagged — otherwise re-phasing a receipt would quietly re-admit it to the
    // filing.
    await patch({ costCodeId: null });
    assert.equal(updateArgs?.data.needsTaxReview, undefined);
});

// ── the item link is judged on the RESOLVED job (item 4) ───────────────────

test("a re-attributed expense may take an item from its NEW job", async () => {
    storedExpense = {
        ...storedExpense,
        projectId: "job-1",
        estimateId: "est-job-2",
        estimate: { projectId: "job-2" },
    };
    estimateItems = [{ id: "item-new-job", estimateId: "est-job-1", projectId: "job-1" }];
    assert.equal((await call({ itemId: "item-new-job" })).status, 200);
});

test("...and NOT one from the job it left, even via its own estimate", async () => {
    // The `estimateId` escape hatch used to admit exactly this: for a
    // re-attributed row the estimate belongs to the job it left.
    storedExpense = {
        ...storedExpense,
        projectId: "job-1",
        estimateId: "est-job-2",
        estimate: { projectId: "job-2" },
    };
    estimateItems = [{ id: "item-old-job", estimateId: "est-job-2", projectId: "job-2" }];
    const res = await call({ itemId: "item-old-job" });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
});
