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
/**
 * What the LOCKED estimate read answers, when a test wants it to disagree with
 * the pre-transaction one (round 21, item 2). `undefined` means "the same
 * fixture the pre-read saw", which is every other test.
 */
let lockedEstimateProject: string | null | undefined;
/** Every project the phase invariant was asked about, in order. */
let phaseProjectIds: string[];
/** Company cost codes, and which job carries each as a phase. Empty by default. */
let costCodes: { id: string; code: string; isActive: boolean }[];
let phaseItems: { projectId: string; costCodeId: string }[];

const fakePrisma: any = {
    // The tax PATCH writes inside a transaction that first takes the shared
    // per-expense advisory lock.
    $transaction: async (fn: any) => fn(fakePrisma),
    // The locked re-resolve reads the ESTIMATE's project through raw SQL, so
    // the fake answers that one from the same fixture the resolver would see.
    $queryRawUnsafe: async (query: string, ...args: any[]) => {
        // The locked item check (round 21, item 2): "is this item on ANY
        // estimate of THAT job", asked on the transaction that writes the
        // link, about the project the locked re-resolve returned.
        if (/FROM "EstimateItem" item/.test(query)) {
            const [itemId, projectId] = args as string[];
            const item = estimateItems.find(candidate => candidate.id === itemId);
            return item && item.projectId === projectId ? [{ id: itemId }] : [];
        }
        if (/FROM "Project" WHERE id/.test(query) && /status/.test(query)) {
            phaseProjectIds.push(args[0] as string);
            return [{ id: args[0], status: "In Progress" }];
        }
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            if (lockedEstimateProject !== undefined) return [{ projectId: lockedEstimateProject }];
            const row = storedExpense as Record<string, any> | null;
            return [{ projectId: row?.estimate?.projectId ?? null }];
        }
        return [{ lock_result: null }];
    },
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
                // The PUT pins the whole tax CLASSIFICATION it judged, not just
                // the two figures — a provenance flipped under it means a
                // different person's answer is now on the row (round 35, item 1).
                "taxSource", "taxDeductibleBaseSource", "needsTaxReview",
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
        // The PRE-transaction phase gate reads a job's phases through
        // prismaPhaseDataSource. Empty by default, so a test that says nothing
        // about phases still gets the old "no code is a phase" behaviour.
        findMany: async (args: { where: Record<string, any> }) => {
            const projectId = args.where?.estimate?.projectId;
            return phaseItems
                .filter(phase => phase.projectId === projectId)
                .map(phase => ({
                    costCode: {
                        id: phase.costCodeId,
                        code: phase.costCodeId,
                        name: phase.costCodeId,
                        description: null,
                        isActive: true,
                    },
                }));
        },
    },
    project: {
        findUnique: async (args: { where: { id: string } }) => ({
            id: args.where.id,
            status: "In Progress",
        }),
    },
    costCode: {
        findUnique: async (args: { where: { id?: string; code?: string } }) => {
            const found = costCodes.find(candidate =>
                args.where.id ? candidate.id === args.where.id : candidate.code === args.where.code,
            );
            return found ? { ...found, name: found.code, description: null } : null;
        },
    },
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
    lockedEstimateProject = undefined;
    phaseProjectIds = [];
    costCodes = [];
    phaseItems = [];
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
    // `needsTaxReview` rides along because answering IS clearing the flag.
    // Neither provenance column does: `taxSource` governs `taxAmount` and
    // `taxDeductibleBaseSource` governs the base, and this request carries
    // neither figure (round 16, item 1; round 33, item 4).
    assert.deepEqual(
        Object.keys(updateArgs?.data ?? {}),
        ["installedAtCustomer", "needsTaxReview"],
    );
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
    const res = await patch({ taxAmount: 16.55 });
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

test("taxAtSource cannot claim tax that is not there — it cannot be claimed at all", async () => {
    // Round 20, item 1: the pair is no longer expressible. The flag is derived
    // from the figure, so "true with no tax" cannot be sent, let alone stored.
    storedExpense = { ...storedExpense, taxAmount: null, taxAtSource: false };
    assert.equal((await patch({ taxAtSource: true })).status, 400);
    assert.equal((await patch({ taxAmount: 10 })).status, 200);
    assert.equal(updateArgs?.data.taxAtSource, true, "derived from the figure");
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
    assert.equal((await patch({ taxAmount: null, taxKnown: true })).status, 403);
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
    // The predicate carries the job the actor was authorized against (round 19,
    // item 3), so a row that moved in the gap matches nothing.
    assert.deepEqual(deleteArgs, {
        where: { id: "e1", qbPurchaseId: null, projectId: "job-1" },
    });
});

test("DELETE of a FALLBACK-attributed row pins the estimate's job", async () => {
    // With no `projectId` of its own the answer lives on the estimate, which
    // somebody can re-point while this request decides. The delete says so.
    storedExpense = {
        ...(storedExpense as object), projectId: null, estimateId: "est-job-1",
    } as Record<string, unknown>;
    assert.equal((await del()).status, 200);
    assert.deepEqual(deleteArgs, {
        where: {
            id: "e1",
            qbPurchaseId: null,
            projectId: null,
            estimate: { is: { projectId: "job-1" } },
        },
    });
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

test("a full answer CLEARS needsTaxReview in the same write", async () => {
    // Two statements would leave a window where the report sees an answered
    // row it still refuses to count. Round 14 made the answer that justifies
    // clearing it an explicit one: the ack plus both figures.
    storedExpense = { ...storedExpense, needsTaxReview: true };
    const res = await patch({
        taxReviewAck: true, taxAmount: 16.55, taxDeductibleBase: 50, installedAtCustomer: true,
    });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.installedAtCustomer, true);
    assert.equal(updateArgs?.data.needsTaxReview, false, "answered, so no longer awaiting one");
});

test("no single tax field clears the flag on its own", async () => {
    // Round 14: each of these is a partial answer, and the flag says the WHOLE
    // classification is in doubt. They are accepted and the flag stands.
    storedExpense = { ...storedExpense, needsTaxReview: true };
    for (const body of [
        { taxAmount: 10 },
        { taxAmount: null, taxKnown: true },
        { taxDeductibleBase: 50 },
        { installedAtCustomer: false },
    ]) {
        const res = await patch(body);
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(updateArgs?.data.needsTaxReview, undefined, JSON.stringify(body));
    }
    // A cost-code edit is not an answer to the tax question either, and it does
    // not even carry the provenance stamp.
    await patch({ costCodeId: null });
    assert.equal(updateArgs?.data.needsTaxReview, undefined);
    // On an UNflagged row the same edits clear nothing because there is
    // nothing to clear, but the column is still written false as before.
    storedExpense = { ...storedExpense, needsTaxReview: false };
    await patch({ taxAmount: 10 });
    assert.equal(updateArgs?.data.needsTaxReview, false);
});

test("a non-string, non-null costCodeId is refused, not silently cleared", async () => {
    // `typeof body.costCodeId === "string"` used to fall through to `null`
    // for any other type — a number, a boolean, an array, an object — which
    // silently stripped a real attribution off a malformed request instead
    // of rejecting it.
    for (const value of [123, false, [], {}, ["cc-frame"]]) {
        const res = await patch({ costCodeId: value as unknown as string });
        assert.equal(res.status, 400, `costCodeId: ${JSON.stringify(value)}`);
        assert.equal(updateArgs, null, `costCodeId: ${JSON.stringify(value)} must not write`);
    }
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
        // Round 33, item 4. The second provenance column is refused for the
        // same reason as the first: accepting it here would let a caller
        // stamp "manual" on a base nobody typed, which is the value booking
        // treats as untouchable.
        "taxDeductibleBaseSource",
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

// ── clearing a review flag is its own decision (Codex round 14, item 1) ─────

test("an installedAtCustomer-only PATCH on a FLAGGED row leaves the flag up", async () => {
    // The flag means the gross moved under the whole classification, not just
    // under the field this request happens to touch. Clearing it here would
    // certify a tax amount and a split nobody re-checked, and put the row
    // straight back into the excise report.
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.installedAtCustomer, true, "the edit still lands");
    assert.equal(updateArgs?.data.needsTaxReview, undefined, "but the flag is untouched");
});

test("a full acknowledgement clears the flag", async () => {
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({
        taxReviewAck: true, taxAmount: 16.55, taxDeductibleBase: 100, installedAtCustomer: true,
    });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.needsTaxReview, false);
    assert.equal(updateArgs?.data.taxSource, "manual");
});

test("an acknowledgement that OMITS taxAmount is refused, not half-applied", async () => {
    // Round 18: a request that says nothing about tax has nothing to certify.
    // Supplying only the amount IS enough (the base is computed), so the
    // refusal is specifically about the key being absent.
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({ taxReviewAck: true, taxDeductibleBase: 50 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "TAX_REVIEW_INCOMPLETE");
    assert.equal(updateArgs, null, "nothing is written");
});

test("on a FLAGGED row an ack needs BOTH keys, not just the tax", async () => {
    // Round 19, item 1. The flag says the whole classification is in doubt, and
    // the two figures ARE the classification — certifying one while staying
    // silent about the other is the half-answer the flag exists to prevent.
    // Tested through the API, not the modal: the modal is one caller of many.
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const only = await patch({ taxReviewAck: true, taxAmount: 16.55 });
    assert.equal(only.status, 400);
    assert.equal((await only.json()).code, "TAX_REVIEW_INCOMPLETE");
    assert.equal(updateArgs, null as typeof updateArgs, "nothing is written, so the flag stands");

    // An explicit null counts as present for either key.
    const both = await patch({ taxReviewAck: true, taxAmount: 16.55, taxDeductibleBase: null });
    assert.equal(both.status, 200);
    assert.equal(updateArgs?.data.needsTaxReview, false);
    assert.equal(updateArgs?.data.taxSource, "manual");
    // ...and the blank base is STORED as the whole pre-tax total rather than
    // left as a null whose meaning every reader has to remember.
    assert.equal(updateArgs?.data.taxDeductibleBase, 191.19, "207.74 - 16.55");
});

test("on an UNflagged row the tax figure alone is still a complete edit", async () => {
    // The both-keys rule is about clearing a FLAG. An ordinary correction is
    // not a certification and does not need one.
    const res = await patch({ taxReviewAck: true, taxAmount: 16.55 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, "manual");
});

test("an UNflagged row does not need an acknowledgement", async () => {
    // The ack exists to make clearing a flag deliberate. Requiring it of
    // ordinary edits would just teach people to send it always.
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.needsTaxReview, false);
});

test("taxReviewAck on its own has nothing to write", async () => {
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({ taxReviewAck: false });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Nothing to update/);
});

test("a non-boolean taxReviewAck is refused", async () => {
    const res = await patch({ taxReviewAck: "yes", taxAmount: 1, taxDeductibleBase: 1 });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /taxReviewAck/);
});

// ── signed expenses: refunds carry negative tax (Codex round 16, item 3) ───

test("a -$50 refund accepts -$4 of tax", async () => {
    storedExpense = {
        ...(storedExpense as object),
        amount: -50, taxAmount: null, taxDeductibleBase: null,
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: -4 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, -4);
    assert.equal(updateArgs?.data.taxAtSource, true, "derived, not supplied");
});

test("...and refuses +$4 with a 400, not a constraint violation", async () => {
    // A positive tax on a negative expense is a dropped minus sign. Caught in
    // the handler, so the caller is told why — the database CHECK behind it
    // would surface as a 500 with nothing to act on.
    storedExpense = {
        ...(storedExpense as object),
        amount: -50, taxAmount: null, taxDeductibleBase: null,
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: 4 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "TAX_SIGN_MISMATCH");
    assert.equal(updateArgs, null, "nothing is written");
});

test("a refund's tax is still bounded by magnitude", async () => {
    storedExpense = {
        ...(storedExpense as object),
        amount: -50, taxAmount: null, taxDeductibleBase: null,
    } as Record<string, unknown>;
    assert.equal((await patch({ taxAmount: -6 })).status, 200, "12% of $50");
    updateArgs = null;
    const tooBig = await patch({ taxAmount: -45 });
    assert.equal(tooBig.status, 400);
    assert.match((await tooBig.json()).error, /implausible/);
    assert.equal(updateArgs, null);
});

test("a purchase still refuses a negative tax", async () => {
    storedExpense = {
        ...(storedExpense as object),
        amount: 207.74, taxAmount: null, taxDeductibleBase: null,
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: -4 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "TAX_SIGN_MISMATCH");
});

// ── provenance is per decision (Codex round 16, item 1) ────────────────────

test("answering ONLY installedAtCustomer does not claim the tax figures", async () => {
    // Stamping "manual" here would freeze the tax columns out of the pipeline
    // on the strength of an answer to a different question.
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, undefined);
});

test("an EXPLICIT null tax is a manual 'no tax' decision, in its own state", async () => {
    // Round 18: the four states are null (unreviewed), "ocr", "manual" (a
    // person's figure) and "manual-none" (a person's "there is no tax here").
    // The last is the one a null `taxAmount` cannot express on its own, which
    // is the entire reason the column exists.
    const res = await patch({ taxAmount: null, taxKnown: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, null, "the clear lands");
    assert.equal(updateArgs?.data.taxSource, "manual-none");
    // With no tax, the whole receipt is the pre-tax total, and it is stored.
    assert.equal(updateArgs?.data.taxDeductibleBase, 207.74);
});

test("an OMITTED tax key leaves the provenance alone", async () => {
    // The request said nothing about tax, so nobody decided anything and a
    // later OCR read may still fill it.
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, undefined);
});

test("supplying taxAmount stamps manual; a base-only edit does not", async () => {
    // Codex round 31: `taxSource` governs `taxAmount` specifically. A
    // `taxDeductibleBase`-only edit is not an answer about the tax figure
    // itself, and stamping "manual" here would permanently block an OCR
    // read from ever filling `taxAmount` on a row nobody actually spoke to
    // (book.ts refuses to touch a human-sourced row).
    await patch({ taxAmount: 16.55 });
    assert.equal(updateArgs?.data.taxSource, "manual");
    const afterAmount = updateArgs;
    await patch({ taxDeductibleBase: 50 });
    assert.notEqual(updateArgs, afterAmount, "a second write happened");
    assert.equal(updateArgs?.data.taxDeductibleBase, 50, "the base edit still lands");
    assert.equal(updateArgs?.data.taxSource, undefined, "taxSource is left untouched");
});

test("a phase-only edit touches neither the flag nor the provenance", async () => {
    await patch({ costCodeId: null });
    assert.equal(updateArgs?.data.taxSource, undefined);
    assert.equal(updateArgs?.data.taxDeductibleBaseSource, undefined);
    assert.equal(updateArgs?.data.needsTaxReview, undefined);
});

// ── provenance is PER FIELD (round 33, item 4) ─────────────────────────────

test("a base-only edit stamps the BASE's provenance, and only that", async () => {
    // The hole one column left. A base-only edit correctly leaves `taxSource`
    // alone — so an OCR read may still fill `taxAmount` on a row nobody has
    // spoken to about tax — but that left the human's base with no provenance
    // at all, and booking then stamped `taxSource: "ocr"` over the whole row.
    await patch({ taxDeductibleBase: 50 });
    assert.equal(updateArgs?.data.taxDeductibleBase, 50);
    assert.equal(updateArgs?.data.taxDeductibleBaseSource, "manual", "the field they answered");
    assert.equal(updateArgs?.data.taxSource, undefined, "the field they did not");
});

test("a taxAmount-only edit stamps the TAX's provenance, and only that", async () => {
    // The mirror image. The base column is untouched here, so its provenance
    // must be too — a row whose base was filled by something else keeps
    // whatever it already said.
    await patch({ taxAmount: 16.55, taxDeductibleBase: 50 });
    const both = updateArgs;
    assert.equal(both?.data.taxSource, "manual");
    assert.equal(both?.data.taxDeductibleBaseSource, "manual", "this request wrote a base too");

    // ...and with the base left out entirely and one already on the row, the
    // server does not recompute it, so nothing about the base is written.
    storedExpense = { ...(storedExpense as object), taxDeductibleBase: 50 } as Record<string, unknown>;
    await patch({ taxAmount: 16.55 });
    assert.equal(updateArgs?.data.taxSource, "manual");
    assert.equal(updateArgs?.data.taxDeductibleBase, undefined, "the base is not rewritten");
    assert.equal(updateArgs?.data.taxDeductibleBaseSource, undefined, "so its source is not either");
});

test("the SERVER-computed base is a human's answer, and is stamped as one", async () => {
    // "Blank means the whole pre-tax total" written out. The person edited the
    // tax and left the base empty meaning "all of it"; the row stores
    // `amount - tax` so it says so outright. That figure came from them, not
    // from a receipt read, and the provenance has to agree or the next booking
    // pass would treat it as fillable.
    await patch({ taxAmount: 16.55 });
    assert.equal(updateArgs?.data.taxDeductibleBase, 191.19, "amount - tax, stored");
    assert.equal(updateArgs?.data.taxDeductibleBaseSource, "manual");
});

test("clearing the base back to blank clears its provenance too", async () => {
    // A blank is an absence, not a decision. Leaving "manual" standing over a
    // null base would lock the column out of the pipeline forever on the
    // strength of a figure nobody is claiming any more.
    storedExpense = {
        ...(storedExpense as object), taxDeductibleBase: 50, taxDeductibleBaseSource: "manual",
    } as Record<string, unknown>;
    await patch({ taxDeductibleBase: null });
    assert.equal(updateArgs?.data.taxDeductibleBase, null);
    assert.equal(updateArgs?.data.taxDeductibleBaseSource, null);
    assert.equal(updateArgs?.data.taxSource, undefined, "still not an answer about the tax");
});

test("'I do not know' retracts BOTH provenances, not just one", async () => {
    // The retraction leaves no human answer standing anywhere on the row. A
    // base source left saying "manual" over a base that is now null is the
    // same half-retracted shape the taxSource clear exists to prevent.
    storedExpense = {
        ...(storedExpense as object),
        taxAmount: 16.55, taxSource: "manual",
        taxDeductibleBase: 50, taxDeductibleBaseSource: "manual",
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: null, taxKnown: false });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, null);
    assert.equal(updateArgs?.data.taxDeductibleBase, null);
    assert.equal(updateArgs?.data.taxDeductibleBaseSource, null);
});

// ── an acknowledgement must carry real figures (round 17, item 2) ──────────

test("a FLAGGED no-tax workflow: ack + null clears the flag as manual-none", async () => {
    // The whole point of the flag is that a person looks again. "I looked, and
    // this receipt has no sales tax" is one of the two answers they can reach,
    // and refusing it would leave the row flagged forever.
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({
        taxReviewAck: true, taxAmount: null, taxKnown: true, taxDeductibleBase: null,
    });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, null);
    assert.equal(updateArgs?.data.taxSource, "manual-none");
    assert.equal(updateArgs?.data.needsTaxReview, false, "answered, so no longer waiting");
    assert.equal(updateArgs?.data.taxDeductibleBase, 207.74, "the whole receipt, stored");
});

test("an ack whose figures point the wrong way is refused", async () => {
    // Coherent means sign and magnitude, the same rules the writes enforce.
    storedExpense = {
        ...(storedExpense as object), needsTaxReview: true, amount: 207.74,
    } as Record<string, unknown>;
    const res = await patch({ taxReviewAck: true, taxAmount: -16.55, taxDeductibleBase: 50 });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
});

test("an ack whose base exceeds the receipt is refused", async () => {
    storedExpense = {
        ...(storedExpense as object), needsTaxReview: true, amount: 207.74,
    } as Record<string, unknown>;
    const res = await patch({ taxReviewAck: true, taxAmount: 16.55, taxDeductibleBase: 500 });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
});

test("a coherent ack still clears the flag", async () => {
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({ taxReviewAck: true, taxAmount: 16.55, taxDeductibleBase: 50 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.needsTaxReview, false);
});

// ── signed credits, end to end (round 17, item 1) ──────────────────────────

test("a refund accepts a NEGATIVE deduction base, and refuses a positive one", async () => {
    storedExpense = {
        ...(storedExpense as object), amount: -50, taxAmount: -4, taxDeductibleBase: null,
    } as Record<string, unknown>;
    const ok = await patch({ taxDeductibleBase: -40 });
    assert.equal(ok.status, 200);
    assert.equal(updateArgs?.data.taxDeductibleBase, -40);

    updateArgs = null;
    const wrongWay = await patch({ taxDeductibleBase: 40 });
    assert.equal(wrongWay.status, 400);
    assert.equal((await wrongWay.json()).code, "BASE_SIGN_MISMATCH");
    assert.equal(updateArgs, null);
});

test("a refund's base is bounded by the pre-tax MAGNITUDE", async () => {
    storedExpense = {
        ...(storedExpense as object), amount: -50, taxAmount: -4, taxDeductibleBase: null,
    } as Record<string, unknown>;
    assert.equal((await patch({ taxDeductibleBase: -46 })).status, 200, "-50 + 4 of tax");
    updateArgs = null;
    const tooBig = await patch({ taxDeductibleBase: -47 });
    assert.equal(tooBig.status, 400);
    assert.equal(updateArgs, null);
});

// ── the four taxSource states, end to end (Codex round 18, item 2) ─────────

test("a BLANK base on an ordinary tax edit is stored, not left null", async () => {
    // "Null means the whole pre-tax total" is a rule every reader has to
    // remember; the server writes what the person meant instead.
    const res = await patch({ taxAmount: 16.55 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxDeductibleBase, 191.19);
});

test("an EXPLICIT base is honoured, not overwritten by the computed one", async () => {
    const res = await patch({ taxAmount: 16.55, taxDeductibleBase: 100 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxDeductibleBase, 100, "a mixed receipt keeps its split");
});

test("a REFUND's blank base is computed with the sign intact", async () => {
    storedExpense = {
        ...(storedExpense as object), amount: -50, taxAmount: null, taxDeductibleBase: null,
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: -4 });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxDeductibleBase, -46);
});

test("an installedAtCustomer-only edit computes nothing and claims nothing", async () => {
    // It is not a tax figure, so it neither stamps provenance nor invents a
    // deduction base for a row nobody has priced.
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, undefined);
    assert.equal(updateArgs?.data.taxDeductibleBase, undefined);
});

// ── the three tax states in the payload (Codex round 19, item 2) ───────────

test("an OMITTED taxAmount touches nothing", async () => {
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, undefined);
    assert.equal(updateArgs?.data.taxSource, undefined);
});

test("'tax unknown' is not a decision: provenance and flag both stand", async () => {
    // `{ taxAmount: null, taxKnown: false }` is where the row already is. It
    // must not stamp a human provenance (which would lock OCR out of a receipt
    // nobody has read) and must not clear a review.
    storedExpense = {
        ...(storedExpense as object), needsTaxReview: true, taxSource: "ocr",
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: null, taxKnown: false });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, null, "the figure is cleared");
    // Round 20, item 2 sharpened this: "unknown" is a RETRACTION, so it takes
    // the provenance back to null rather than merely leaving it alone — a row
    // with a human provenance and no human answer behind it is the state that
    // locks the pipeline out forever.
    assert.equal(updateArgs?.data.taxSource, null, "back to unreviewed");
    assert.equal(updateArgs?.data.needsTaxReview, undefined, "and the row still waits");
    assert.equal(updateArgs?.data.taxDeductibleBase, null, "no base for an unpriced row");
});

test("'tax unknown' cannot acknowledge a review", async () => {
    storedExpense = { ...(storedExpense as object), needsTaxReview: true } as Record<string, unknown>;
    const res = await patch({
        taxReviewAck: true, taxAmount: null, taxKnown: false, taxDeductibleBase: null,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "TAX_UNKNOWN");
    assert.equal(updateArgs, null);
});

test("'no tax on this receipt' IS a decision", async () => {
    const res = await patch({ taxAmount: null, taxKnown: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, "manual-none");
});

test("a FIGURE is a decision, whatever taxKnown says", async () => {
    const res = await patch({ taxAmount: 16.55, taxKnown: true });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, "manual");
});

test("a non-boolean taxKnown is refused", async () => {
    const res = await patch({ taxAmount: null, taxKnown: "no" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /taxKnown/);
});

test("NaN and Infinity are refused for both figures", async () => {
    // JSON cannot carry either, but a client that serializes them lands
    // `null` or a string — and `Number("Infinity")` is Infinity.
    for (const value of ["Infinity", "-Infinity", "NaN", "abc"]) {
        const tax = await patch({ taxAmount: value });
        assert.equal(tax.status, 400, `taxAmount: ${value}`);
        const base = await patch({ taxDeductibleBase: value });
        assert.equal(base.status, 400, `taxDeductibleBase: ${value}`);
    }
});

test("JSON values that coerce to zero are refused, not silently booked as $0", async () => {
    // `Number(false)`, `Number("")` and `Number([])` are all `0` — a real
    // person entering zero tax sends the NUMBER 0, not one of these. Coercing
    // them would certify a figure nobody actually answered.
    for (const value of [false, "", [], {}, true, [16.55]]) {
        const tax = await patch({ taxAmount: value as unknown as number });
        assert.equal(tax.status, 400, `taxAmount: ${JSON.stringify(value)}`);
        assert.equal(updateArgs, null, `taxAmount: ${JSON.stringify(value)} must not write`);
        const base = await patch({ taxDeductibleBase: value as unknown as number });
        assert.equal(base.status, 400, `taxDeductibleBase: ${JSON.stringify(value)}`);
        assert.equal(updateArgs, null, `taxDeductibleBase: ${JSON.stringify(value)} must not write`);
    }
});

test("a review acknowledgement rejects a non-number figure the same way", async () => {
    // The `coherent()` check inside the ack path had the same `Number(value)`
    // hole — `false` and `""` are both "coherent" once coerced to 0.
    storedExpense = { ...storedExpense, needsTaxReview: true };
    const res = await patch({ taxReviewAck: true, taxAmount: false as unknown as number, taxDeductibleBase: 50 });
    assert.equal(res.status, 400);
    assert.equal(updateArgs, null);
});

// ── a fallback-attributed row can change jobs mid-request (round 19, item 3) ─

test("an estimate re-pointed between the check and the WRITE is refused", async () => {
    // The row has no `projectId` of its own, so its job comes from the
    // estimate — and somebody moves that estimate while this PATCH decides. The
    // authorization above was granted for job-1; the write must not land on
    // whatever the row belongs to now.
    storedExpense = {
        ...(storedExpense as object), projectId: null, estimateId: "est-1",
        estimate: { projectId: "job-1" },
    } as Record<string, unknown>;
    const original = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (query: string) => {
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            // The move lands as the lock is taken: the locked read is the FIRST
            // one that can see it, which is the whole point of taking it.
            return [{ projectId: "job-2" }];
        }
        return [{ lock_result: null }];
    };
    try {
        const res = await patch({ installedAtCustomer: true });
        assert.equal(res.status, 403, "the actor has no access to job-2");
        assert.equal(updateArgs, null as typeof updateArgs, "and nothing is written");
    } finally {
        fakePrisma.$queryRawUnsafe = original;
    }
});

test("a fallback-attributed PATCH pins the estimate's job in its predicate", async () => {
    storedExpense = {
        ...(storedExpense as object), projectId: null, estimateId: "est-1",
        estimate: { projectId: "job-1" },
    } as Record<string, unknown>;
    const res = await patch({ installedAtCustomer: true });
    assert.equal(res.status, 200);
    const where = updateArgs?.where as Record<string, any>;
    assert.equal(where.projectId, null);
    assert.deepEqual(where.estimate, { is: { projectId: "job-1" } });
});

test("a fallback-attributed PUT is refused when the estimate moves", async () => {
    storedExpense = {
        ...(storedExpense as object), projectId: null, estimateId: "est-1",
        estimate: { projectId: "job-1" }, qbPurchaseId: null,
    } as Record<string, unknown>;
    const original = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (query: string) => {
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) return [{ projectId: "job-2" }];
        return [{ lock_result: null }];
    };
    try {
        // 403, not 409: the actor has no access to the job this row is on NOW,
        // which is a fact about them rather than about the row. The 409 case is
        // a lost predicate — same request, still-authorized actor.
        const res = await call({ vendor: "Lowe's" });
        assert.equal(res.status, 403);
    } finally {
        fakePrisma.$queryRawUnsafe = original;
    }
});

test("a fallback-attributed DELETE is refused when the estimate moves", async () => {
    storedExpense = {
        ...(storedExpense as object), projectId: null, estimateId: "est-1",
        estimate: { projectId: "job-1" },
    } as Record<string, unknown>;
    const original = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (query: string) => {
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) return [{ projectId: "job-2" }];
        return [{ lock_result: null }];
    };
    try {
        const res = await del();
        assert.equal(res.status, 403);
        assert.equal(deleteArgs, null, "nothing is destroyed under a stale permission");
    } finally {
        fakePrisma.$queryRawUnsafe = original;
    }
});

// ── taxAtSource is DERIVED, never supplied (Codex round 20, item 1) ────────

test("a request that SETS taxAtSource is refused, either way round", async () => {
    // Two writers for one truth is how they came to disagree. Both directions
    // are the same mistake: `true` with no amount is a claim about nothing,
    // `false` with a figure is a deduction dropped from the filing.
    for (const value of [true, false]) {
        const res = await patch({ taxAmount: 16.55, taxAtSource: value });
        assert.equal(res.status, 400, String(value));
        assert.equal((await res.json()).code, "TAX_AT_SOURCE_DERIVED");
        assert.equal(updateArgs, null as typeof updateArgs, "nothing is written");
    }
});

test("the server derives the flag from the figure it stores", async () => {
    await patch({ taxAmount: 16.55 });
    assert.equal(updateArgs?.data.taxAtSource, true);

    await patch({ taxAmount: null, taxKnown: true });
    assert.equal(updateArgs?.data.taxAtSource, false, "no tax, no claim");

    storedExpense = { ...(storedExpense as object), amount: -50 } as Record<string, unknown>;
    await patch({ taxAmount: -4 });
    assert.equal(updateArgs?.data.taxAtSource, true, "a refund's tax was still charged");
});

// ── "unknown" RETRACTS a human answer (Codex round 20, item 2) ─────────────

test("marking a MANUAL row unknown clears the provenance and both figures", async () => {
    // Otherwise the row keeps a human provenance with no human answer behind
    // it, and no automated read is ever allowed to fill it again.
    storedExpense = {
        ...(storedExpense as object), taxSource: "manual",
        taxAmount: 16.55, taxDeductibleBase: 191.19,
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: null, taxKnown: false });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxAmount, null);
    assert.equal(updateArgs?.data.taxDeductibleBase, null);
    assert.equal(updateArgs?.data.taxSource, null, "back to unreviewed");
    assert.equal(updateArgs?.data.taxAtSource, false);
});

test("...and the same from MANUAL-NONE", async () => {
    storedExpense = {
        ...(storedExpense as object), taxSource: "manual-none",
        taxAmount: null, taxDeductibleBase: 207.74,
    } as Record<string, unknown>;
    const res = await patch({ taxAmount: null, taxKnown: false });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.taxSource, null);
    assert.equal(updateArgs?.data.taxDeductibleBase, null);
});

// ── both re-checks answer about the LOCKED job (round 21, item 2) ───────────

test("the phase is validated against the job the LOCK found, not the pre-read one", async () => {
    // A fallback-attributed row (no projectId of its own) resolves through its
    // estimate, and the estimate can move between the authorization and the
    // write. The route re-resolves under lock and then validated the phase
    // against the value it had read BEFORE the transaction — the one thing the
    // re-resolve exists to distrust.
    storedExpense = {
        ...storedExpense,
        projectId: null,
        estimateId: "est-job-1",
        estimate: { projectId: "job-1" },
    };
    lockedEstimateProject = "job-2";
    currentUser = {
        id: "u1", role: "MANAGER",
        permissions: { timeClock: true, financialReports: true },
        projectIds: ["job-1", "job-2"],
    };
    // The PRE-transaction gate passes: cc-frame really is a phase of job-1,
    // which is the job the route read before it took the lock. That is the
    // point — a stale check that says yes is the one that gets through.
    costCodes = [{ id: "cc-frame", code: "02-FRAME", isActive: true }];
    phaseItems = [{ projectId: "job-1", costCodeId: "cc-frame" }];
    await call({ costCodeId: "cc-frame" });
    assert.deepEqual(
        phaseProjectIds, ["job-2"],
        "asked about the job it is on now, never the job it left",
    );
});

test("the item link is re-checked against the LOCKED job", async () => {
    // Same staleness, the other column: the pre-transaction check passed
    // against job-1's estimates, and the row is written onto job-2.
    storedExpense = {
        ...storedExpense,
        projectId: null,
        estimateId: "est-job-1",
        estimate: { projectId: "job-1" },
    };
    lockedEstimateProject = "job-2";
    currentUser = {
        id: "u1", role: "MANAGER",
        permissions: { timeClock: true, financialReports: true },
        projectIds: ["job-1", "job-2"],
    };
    const res = await call({ itemId: "item-own" });
    assert.equal(res.status, 400, "item-own is on job-1, and the row is now on job-2");
    assert.equal(updateArgs, null, "nothing was written");
});

test("...and the SAME request succeeds when nothing moved", async () => {
    // The control. Without it the test above passes on a route that refuses
    // every itemId — the 400 has to come from the disagreement, not from the
    // locked check being unsatisfiable.
    storedExpense = {
        ...storedExpense,
        projectId: null,
        estimateId: "est-job-1",
        estimate: { projectId: "job-1" },
    };
    lockedEstimateProject = "job-1";
    currentUser = {
        id: "u1", role: "MANAGER",
        permissions: { timeClock: true, financialReports: true },
        projectIds: ["job-1", "job-2"],
    };
    assert.equal((await call({ itemId: "item-own" })).status, 200);
    assert.equal(updateArgs?.data.itemId, "item-own");
});


// ── PUT cannot leave an invalid tax classification (Codex round 35, item 1) ─

/**
 * A CLASSIFIED receipt: a person answered the tax questions, and the excise
 * report reads the answers. Every test below starts here and changes only the
 * GROSS — the field PUT owns and PATCH refuses — because that is the whole
 * shape of the bug: the two invariants that make a classification valid
 * (`taxDeductibleBase <= amount - taxAmount`, and tax within 12% of the gross)
 * are RATIOS OF THE AMOUNT, and this route was the one writer of the amount
 * that checked neither.
 */
function classifiedRow(overrides: Record<string, unknown> = {}) {
    storedExpense = {
        ...(storedExpense as object),
        amount: 207.74,
        taxAmount: 16.55,
        taxAtSource: true,
        taxDeductibleBase: 50,
        taxSource: "manual",
        taxDeductibleBaseSource: "manual",
        needsTaxReview: false,
        ...overrides,
    } as Record<string, unknown>;
}

test("lowering the gross past the tax's plausibility band FLAGS the row", async () => {
    // THE CASE FROM THE REVIEW. $207.74 with $16.55 of tax and a $50 deduction
    // base, edited down to $100: the base still fits under the pre-tax ceiling,
    // so the only check this route had said yes — and left $16.55 of tax on a
    // $100 receipt, 16.6%, past the 12% band that BOTH writers of that column
    // refuse. A figure no writer would have accepted, standing on the row as a
    // certified deduction.
    classifiedRow();
    const res = await call({ amount: "100.00" });
    assert.equal(res.status, 200, "the amount edit itself is legitimate work");
    assert.equal(updateArgs?.data.amount, 100, "and it lands");
    assert.equal(
        updateArgs?.data.needsTaxReview, true,
        "but the classification it invalidated is sent back to a person",
    );
});

test("a financialReports user whose edit leaves the tax plausible is NOT flagged", async () => {
    // $16.55 on $200 is 8.3% — inside the band, base still under the ceiling,
    // and the actor is entitled to certify tax figures. Flagging here would
    // teach a bookkeeper that the flag means nothing.
    classifiedRow();
    const res = await call({ amount: "200.00" });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.amount, 200);
    assert.equal(updateArgs?.data.needsTaxReview, undefined, "nothing to re-check");
});

test("a timeClock user may change the gross, but may not keep a classification", async () => {
    // The PATCH demands `financialReports` to touch these columns at all. Left
    // alone, this route was the way around that: change the gross — which
    // `timeClock` allows — and the classification silently follows the new
    // number into the excise report, certified by nobody who could certify it.
    currentUser = { id: "u-crew", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["job-1"] };
    classifiedRow();
    const res = await call({ amount: "200.00" });
    assert.equal(res.status, 200, "changing a receipt's total is still their work");
    assert.equal(
        updateArgs?.data.needsTaxReview, true,
        "the figures they cannot certify are re-opened, even though they still fit",
    );
});

test("an UNCLASSIFIED row is never flagged — there is nothing to re-certify", async () => {
    // No figure, no provenance: nobody has answered anything about this
    // receipt's tax, so an amount edit invalidates nothing. Flagging it would
    // fill the queue with rows that have no question waiting on them.
    currentUser = { id: "u-crew", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["job-1"] };
    classifiedRow({
        taxAmount: null, taxAtSource: false, taxDeductibleBase: null,
        taxSource: null, taxDeductibleBaseSource: null,
    });
    const res = await call({ amount: "100.00" });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.needsTaxReview, undefined);
});

test("an amount edit that changes nothing does not flag a classified row", async () => {
    // The trigger is the GROSS MOVING, not the key being present. A PUT that
    // re-sends the same total (every "save" from a form that posts all its
    // fields) must not re-open a classification nobody disturbed.
    currentUser = { id: "u-crew", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["job-1"] };
    classifiedRow();
    const res = await call({ amount: "207.74", vendor: "Lowe's" });
    assert.equal(res.status, 200);
    assert.equal(updateArgs?.data.needsTaxReview, undefined);
});

test("the PUT writes under the shared per-expense lock", async () => {
    // The PATCH has taken it since round 17. This handler is the OTHER writer
    // of the values every tax invariant is built from, and took nothing.
    const locks: unknown[][] = [];
    const originalLock = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (...args: unknown[]) => { locks.push(args); return [{}]; };
    try {
        await call({ amount: "100.00" });
        assert.equal(locks.length, 1, "exactly one lock, taken before the write");
        assert.match(String(locks[0][0]), /pg_advisory_xact_lock/);
        assert.equal(locks[0][1], "expense:e1", "the same key the PATCH uses");
    } finally {
        fakePrisma.$queryRawUnsafe = originalLock;
    }
});

test("the PUT's CAS pins the tax classification it judged", async () => {
    classifiedRow();
    await call({ amount: "200.00" });
    const where = updateArgs?.where as Record<string, unknown>;
    assert.equal(where.amount, 207.74, "the gross the verdict was measured against");
    assert.equal(where.taxAmount, 16.55);
    assert.equal(where.taxDeductibleBase, 50);
    assert.equal(where.taxSource, "manual");
    assert.equal(where.taxDeductibleBaseSource, "manual");
    assert.equal(where.needsTaxReview, false, "including the flag it may be about to raise");
});

test("a concurrent PATCH between the locked read and the write is refused", async () => {
    // Models a writer that did NOT take the lock — the case the predicate
    // exists for. The tax is raised after this request has read and judged it,
    // so the write would land a verdict about figures that are no longer there.
    classifiedRow();
    assert.equal((await call({ amount: "200.00" })).status, 200, "control");

    classifiedRow();
    const originalFind = fakePrisma.expense.findUnique;
    fakePrisma.expense.findUnique = async (args: any) => {
        const snapshot = storedExpense;
        // The locked re-read is the one that asks for the provenance columns.
        if (args?.select?.taxSource) {
            storedExpense = { ...(storedExpense as object), taxAmount: 20 } as Record<string, unknown>;
        }
        return snapshot;
    };
    try {
        const stale = await call({ amount: "200.00" });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json()).code, "EXPENSE_REATTRIBUTED");
    } finally {
        fakePrisma.expense.findUnique = originalFind;
    }
});

test("a deduction base that stopped fitting under the lock is refused, not written", async () => {
    // The pre-transaction ceiling check passed against the row as it was READ.
    // A concurrent PATCH that writes a bigger base makes the same amount edit
    // violate `Expense_taxDeductibleBase_check` — which Postgres answers with a
    // constraint error and a 500. The locked re-check answers it as a 400 that
    // names the remedy.
    classifiedRow({ taxDeductibleBase: 10 });
    const preRead = storedExpense;
    const locked = { ...(storedExpense as object), taxDeductibleBase: 50 } as Record<string, unknown>;
    const originalFind = fakePrisma.expense.findUnique;
    fakePrisma.expense.findUnique = async (args: any) =>
        args?.select?.taxSource ? locked : preRead;
    try {
        // ceiling = 60.00 - 16.55 = 43.45. A base of 10 fits; the 50 the lock
        // finds does not.
        const res = await call({ amount: "60.00" });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, "BASE_ABOVE_CEILING");
        assert.equal(updateArgs, null, "and nothing is written");
    } finally {
        fakePrisma.expense.findUnique = originalFind;
    }
});
