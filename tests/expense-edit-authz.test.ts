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

const fakePrisma: any = {
    // The tax PATCH writes inside a transaction that first takes the shared
    // per-expense advisory lock.
    $transaction: async (fn: any) => fn(fakePrisma),
    $queryRawUnsafe: async () => [{ lock_result: null }],
    expense: {
        findUnique: async () => storedExpense,
        update: async (args: { where: unknown; data: Record<string, unknown> }) => {
            updateArgs = args;
            return { id: "e1", ...args.data };
        },
        // The PATCH writes through a COMPARE-AND-SET on the values its
        // validation depended on, so the stub has to be able to MISS.
        updateMany: async (args: { where: Record<string, any>; data: Record<string, unknown> }) => {
            const row = storedExpense as Record<string, any> | null;
            if (!row) return { count: 0 };
            const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
            for (const key of [
                "amount", "taxAmount", "taxDeductibleBase",
                // The attribution the authorization rested on, plus the row
                // version that covers everything else.
                "projectId", "estimateId", "updatedAt",
            ]) {
                if (key in args.where && !eq(row[key], args.where[key])) return { count: 0 };
            }
            updateArgs = args;
            return { count: 1 };
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
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
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
    // `needsTaxReview` and `taxSource` ride along because answering IS
    // clearing the flag and recording who answered — still nothing outside the
    // ProBuild-only set.
    assert.deepEqual(
        Object.keys(updateArgs?.data ?? {}),
        ["installedAtCustomer", "needsTaxReview", "taxSource"],
    );
    assert.equal(updateArgs?.data.taxSource, "manual", "a person answered, and booking must not undo it");
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

// ── #5 PUT's strict allowlist ──────────────────────────────────────────────

test("PUT rejects EVERY tax-return field, by name", async () => {
    // A silent drop looks like a successful correction, and the caller would
    // believe a deduction was recorded that never was.
    for (const field of [
        "taxAmount", "taxAtSource", "needsTaxReview",
        "installedAtCustomer", "taxDeductibleBase", "taxSource",
    ]) {
        const res = await call({ [field]: field === "taxAtSource" ? true : 1 });
        assert.equal(res.status, 400, field);
        const body = await res.json();
        assert.equal(body.field, field, "the response names the offending field");
        assert.match(body.error, /PATCH/);
    }
    assert.equal(updateArgs, null, "and nothing is ever written");
});

test("PUT still accepts its own fields", async () => {
    assert.equal((await call({ vendor: "Fine", amount: "10.00" })).status, 200);
});

// ── #4 the PATCH is a compare-and-set on what it validated against ─────────

test("a PATCH whose row moved under it is refused, not applied", async () => {
    // The ceiling for taxDeductibleBase is amount - taxAmount, and a QBO
    // re-sync can move either between the read and the write. Writing anyway
    // would store a figure that was legal a moment ago and is not now.
    const res = await patch({ taxDeductibleBase: 50 });
    assert.equal(res.status, 200, "control: it writes when nothing moved");

    // Now make the CAS miss the way a concurrent sync would.
    const original = fakePrisma.expense.updateMany;
    (fakePrisma.expense as any).updateMany = async () => ({ count: 0 });
    try {
        const stale = await patch({ taxDeductibleBase: 50 });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, "STALE_EXPENSE");
    } finally {
        (fakePrisma.expense as any).updateMany = original;
    }
});

test("the CAS names the values the decision rested on", async () => {
    await patch({ taxDeductibleBase: 50 });
    const where = updateArgs?.where as Record<string, unknown>;
    assert.equal(where.id, "e1");
    assert.equal(where.amount, 207.74);
    assert.equal(where.taxAmount, 16.55);
    assert.equal(where.taxDeductibleBase, null);
});

// ── #1 deletion is authorized on the RESOLVED job ──────────────────────────

test("DELETE authorizes on the job the expense is actually on, not its estimate's", async () => {
    // A re-attributed expense: projectId says job-1, the estimate still says
    // job-2. Someone with access only to the OLD job must not be able to
    // destroy it, and someone with access to the new one must be able to.
    storedExpense = {
        ...storedExpense,
        projectId: "job-1",
        estimateId: "est-job-2",
        estimate: { projectId: "job-2" },
    };

    currentUser = { id: "u-old", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    assert.equal((await del()).status, 403, "the job it LEFT confers nothing");
    assert.equal(deleteArgs, null);

    currentUser = { id: "u-new", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    assert.equal((await del()).status, 200, "the job it is ON does");
});

// ── #2 the CAS covers the attribution the authorization rested on ──────────

test("a PATCH is refused when the row was RE-ATTRIBUTED under it", async () => {
    // Access was granted because of the project this row was on. If it moved,
    // the permission check that let the request through was answered about a
    // different job — so the write must not land, even though every money
    // value it validated is untouched.
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200, "control");

    const original = fakePrisma.expense.updateMany;
    fakePrisma.expense.updateMany = async (args: any) => {
        // Model the re-attribution: the row's projectId no longer matches.
        if (args.where.projectId === "job-1") return { count: 0 };
        return original(args);
    };
    try {
        const stale = await patch({ installedAtCustomer: true });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, "STALE_EXPENSE");
    } finally {
        fakePrisma.expense.updateMany = original;
    }
});

test("the CAS names projectId, estimateId and updatedAt", async () => {
    await patch({ installedAtCustomer: true });
    const where = updateArgs?.where as Record<string, unknown>;
    assert.equal(where.projectId, "job-1");
    assert.equal(where.estimateId, "est-job-1");
    assert.ok(where.updatedAt instanceof Date, "the row version pins everything else");
});

test("the tax PATCH writes under the shared per-expense lock", async () => {
    const locks: unknown[][] = [];
    const originalLock = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (...args: unknown[]) => { locks.push(args); return [{}]; };
    try {
        await patch({ installedAtCustomer: true });
        assert.equal(locks.length, 1, "exactly one lock, taken before the write");
        assert.match(String(locks[0][0]), /pg_advisory_xact_lock/);
        assert.equal(locks[0][1], "expense:e1", "namespaced per expense");
    } finally {
        fakePrisma.$queryRawUnsafe = originalLock;
    }
});

// ── PUT amount: one parse, one value (Codex round 13, item 8) ──────────────

test("a junk amount is REFUSED, not silently truncated", async () => {
    // "10junk" used to validate as NaN (passing every check that is not a
    // comparison) and then persist as 10 via parseFloat — a $207.74 receipt
    // quietly becoming a $10 one.
    const res = await call({ amount: "10junk" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, "amount");
    assert.equal(updateArgs, null, "nothing is written");
});

test("a negative amount is refused", async () => {
    const res = await call({ amount: -5 });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
});

test("ZERO is a real amount, not an omission", async () => {
    // `body.amount ? ...` dropped it, so a receipt could never be zeroed.
    const res = await call({ amount: 0 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.amount, 0);
});

test("the value validated is the value persisted", async () => {
    storedExpense = { ...(storedExpense as object), taxDeductibleBase: 100 } as Record<string, unknown>;
    // 100 of base + 16.55 of tax needs at least 116.55 of gross. 116.55 passes...
    const ok = await call({ amount: "116.55" });
    assert.equal(ok.status, 200);
    assert.equal(updateArgs?.data.amount, 116.55, "the parsed number, not a re-parse");
    // ...and a cent less is refused by the same number that would be written.
    updateArgs = null;
    const denied = await call({ amount: "116.54" });
    assert.equal(denied.status, 400);
    assert.equal(updateArgs, null);
});

test("an omitted amount leaves the stored one alone", async () => {
    const res = await call({ vendor: "Lowe's" });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.amount, undefined);
});
