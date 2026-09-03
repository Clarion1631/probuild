/**
 * `deleteExpense` — the SINGLE-expense server action (Codex round 10, item 3).
 *
 * The earlier divergent-attribution test covered the DELETE route, not this
 * path, and this one had its own copy of the bug: it authorized against
 * `expense.estimate.projectId`. For a re-attributed expense that names the job
 * it LEFT, so the check both admitted someone whose access is to the old job
 * and refused the crew who now own the row.
 *
 * Prisma, next-auth and the permission reader are patched at require() time —
 * same shape as tests/job-variance-db.test.ts. No mock.module: CI is Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

interface FakeUser {
    id: string;
    role: string;
    permissions: Record<string, boolean>;
    projectIds: string[];
}

let currentUser: FakeUser | null;
let storedExpense: Record<string, unknown> | null;
let deleteArgs: unknown;

/**
 * The ORDER of everything the batch does, one entry per statement — the only
 * way to see that every parent is reached before the first Expense row is
 * touched, which is what round 46 item 3 is about.
 */
let opLog: string[] = [];
let batchRows: Record<string, unknown>[] = [];
let findManyArgs: any = null;

const fakePrisma: any = {
    // The delete now runs in a transaction that re-resolves a fallback-
    // attributed row's job from the LOCKED estimate (round 20, item 4).
    $transaction: async (fn: any) => fn(fakePrisma),
    $queryRawUnsafe: async (query: string, ...values: unknown[]) => {
        const table = query.match(/FROM "(\w+)"/)?.[1];
        if (/^SELECT "projectId" FROM "Estimate"/.test(query)) {
            opLog.push(`resolve:${values[0]}`);
            const known = batchRows.find(row => (row as any).estimateId === values[0]) as any;
            const row = storedExpense as Record<string, any> | null;
            return [{ projectId: known ? known.estimate?.projectId ?? null : row?.estimate?.projectId ?? null }];
        }
        if (/FOR SHARE/.test(query)) opLog.push(`lock:${table}[${values.flat(2).map(String).join(",")}]`);
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            const row = storedExpense as Record<string, any> | null;
            return [{ projectId: row?.estimate?.projectId ?? null }];
        }
        return [{}];
    },
    expense: {
        findUnique: async () => storedExpense,
        findMany: async (args: unknown) => {
            findManyArgs = args;
            return batchRows;
        },
        deleteMany: async (args: unknown) => {
            deleteArgs = args;
            opLog.push(`delete:${(args as any)?.where?.id}`);
            return { count: 1 };
        },
    },
};

let deleteExpense: (id: string, projectId: string) => Promise<void>;
let deleteExpenses: (ids: string[]) => Promise<{ deleted: number }>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let hit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") { hit = true; return { prisma: fakePrisma }; }
        if (id === "@/lib/permissions") {
            return {
                getCurrentUserWithPermissions: async () => currentUser,
                hasPermission: (user: FakeUser | null, key: string) =>
                    !!user && (user.role === "ADMIN" || user.permissions?.[key] === true),
                canAccessProject: (user: FakeUser, projectId: string) =>
                    user.role === "ADMIN" || user.projectIds.includes(projectId),
            };
        }
        if (id === "next/cache") return { revalidatePath: () => {} };
        if (id === "next-auth/next") return { getServerSession: async () => ({ user: { email: "x@y.z" } }) };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/lib/time-expense-actions");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.deleteExpense !== "function") {
        throw new Error(`expense-delete-scope: mocks did not apply (require patch ${hit ? "WAS" : "was NOT"} hit)`);
    }
    deleteExpense = mod.deleteExpense;
    deleteExpenses = mod.deleteExpenses;
});

beforeEach(() => {
    currentUser = { id: "u1", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    // RE-ATTRIBUTED: it lives on job-1 now, its estimate still names job-2.
    storedExpense = {
        qbPurchaseId: null,
        invoiceId: null,
        invoicedAt: null,
        projectId: "job-1",
        estimateId: "est-job-2",
        estimate: { projectId: "job-2" },
    };
    deleteArgs = null;
    opLog = [];
    findManyArgs = null;
    batchRows = [];
});

async function attempt(projectId: string): Promise<string | null> {
    try {
        await deleteExpense("e1", projectId);
        return null;
    } catch (error) {
        return (error as Error).message;
    }
}

test("the job the expense is ON can delete it", async () => {
    assert.equal(await attempt("job-1"), null);
    // The predicate carries the job the actor was authorized against (round 20,
    // item 4), so a row that moves in the gap matches nothing.
    assert.deepEqual(deleteArgs, {
        where: {
            id: "e1", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
            projectId: "job-1",
        },
    });
});

test("the job it LEFT cannot — not even from that job's own page", async () => {
    // Reading the estimate would have said "job-2" and allowed this.
    currentUser = { id: "u2", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    assert.equal(await attempt("job-2"), "Forbidden");
    assert.equal(deleteArgs, null, "and nothing is deleted");
});

test("access to the new job is still required, not just the right projectId", async () => {
    currentUser = { id: "u3", role: "FIELD_CREW", permissions: { timeClock: true }, projectIds: ["somewhere-else"] };
    assert.equal(await attempt("job-1"), "Forbidden");
    assert.equal(deleteArgs, null);
});

test("an unattributed expense falls back to its estimate's job", async () => {
    // The resolver's other branch: nothing to prefer, so the estimate decides.
    storedExpense = { ...storedExpense, projectId: null };
    currentUser = { id: "u4", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    assert.equal(await attempt("job-2"), null);
    // ...and the estimate is pinned in the predicate, so a re-point loses.
    assert.deepEqual((deleteArgs as any).where.estimate, { is: { projectId: "job-2" } });
});

test("an estimate re-pointed under a fallback DELETE is refused", async () => {
    // The locked read is the first thing that can see the move; the actor was
    // authorized for job-2 and the row now belongs to somebody else.
    storedExpense = { ...storedExpense, projectId: null };
    currentUser = { id: "u7", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-2"] };
    const original = fakePrisma.$queryRawUnsafe;
    fakePrisma.$queryRawUnsafe = async (query: string) => {
        if (/FROM "Estimate"/.test(query) && /"projectId"/.test(query)) {
            return [{ projectId: "job-3" }];
        }
        return [{}];
    };
    try {
        assert.equal(await attempt("job-2"), "Forbidden");
        assert.equal(deleteArgs, null, "nothing is destroyed under a stale permission");
    } finally {
        fakePrisma.$queryRawUnsafe = original;
    }
});

test("a row with no job at all cannot be deleted here", async () => {
    storedExpense = { ...storedExpense, projectId: null, estimate: { projectId: null } };
    currentUser = { id: "u5", role: "ADMIN", permissions: {}, projectIds: [] };
    assert.equal(await attempt("job-1"), "Forbidden", "no scope to authorize against");
});

test("the timeClock permission is still required", async () => {
    currentUser = { id: "u6", role: "FIELD_CREW", permissions: {}, projectIds: ["job-1"] };
    assert.equal(await attempt("job-1"), "Forbidden");
});

// ── the BATCH (Codex round 46, item 3) ─────────────────────────────────────

/**
 * TWO ROWS, TWO ESTIMATES — the shape that makes the interleaving visible.
 * Both are fallback-attributed, so each one's job is re-resolved from its own
 * estimate under lock, which is the parent acquisition that used to sit
 * BETWEEN the deletes.
 */
function twoRowBatch() {
    batchRows = [
        { id: "e-a", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
          projectId: null, estimateId: "est-a", estimate: { projectId: "job-1" } },
        { id: "e-b", qbPurchaseId: null, invoiceId: null, invoicedAt: null,
          projectId: null, estimateId: "est-b", estimate: { projectId: "job-1" } },
    ];
}

test("the batch takes EVERY parent before it touches any expense", async () => {
    // The bug: lock row A's parents, delete row A — which takes that Expense
    // exclusively and, through the foreign keys, a KEY SHARE on its Project
    // and Estimate — and only THEN reach for row B's parents. That is
    // Expense -> Estimate inside one transaction, the declared order
    // backwards, and against anything holding an estimate while touching an
    // expense it is a cycle. tests/attribution-lock-order-db.test.ts drives
    // the same sequence against a real Postgres and shows the 40P01.
    twoRowBatch();
    currentUser = { id: "u8", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    const result = await deleteExpenses(["e-a", "e-b"]);

    assert.equal(result.deleted, 2);
    const firstDelete = opLog.findIndex(entry => entry.startsWith("delete:"));
    assert.ok(firstDelete > 0, `something has to be locked first: ${opLog.join(" ")}`);
    const idsIn = (entries: string[]) =>
        new Set(entries.flatMap(entry => (entry.match(/\[(.*)\]/)?.[1] ?? "").split(",").filter(Boolean)));
    const before = idsIn(opLog.slice(0, firstDelete).filter(entry => entry.startsWith("lock:")));
    const after = opLog.slice(firstDelete).filter(entry => entry.startsWith("lock:"));

    // A NEW parent may not be reached after an Expense has been written. The
    // per-row `resolveExpenseProjectUnderLock` still re-locks each estimate as
    // it goes and that is fine — re-acquiring a share lock this transaction
    // already holds takes no new lock at all, which is exactly why the ids are
    // checked rather than the statements.
    const fresh = [...idsIn(after)].filter(id => !before.has(id));
    assert.deepEqual(fresh, [], `these parents were first reached AFTER a delete: ${opLog.join(" ")}`);
    assert.deepEqual(
        after.filter(entry => entry.startsWith("lock:Project")),
        [],
        `and no Project row may be reached after a delete: ${opLog.join(" ")}`,
    );
});

test("...and both rows' estimates are named in that ONE acquisition", async () => {
    // Locking only the first row's parents would satisfy the ordering check
    // above while leaving the second row's estimate to be reached after the
    // first delete, so the ids matter as much as the position.
    twoRowBatch();
    currentUser = { id: "u9", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    await deleteExpenses(["e-a", "e-b"]);
    // BEFORE the first delete, not merely somewhere in the transaction: the
    // per-row re-resolve reaches every estimate eventually, so a check that
    // only asks "was it locked at all" passes against the un-fixed code.
    const firstDelete = opLog.findIndex(entry => entry.startsWith("delete:"));
    const upfront = opLog.slice(0, firstDelete).join(" ");
    assert.match(upfront, /est-a/, `est-a is locked up front: ${opLog.join(" ")}`);
    assert.match(upfront, /est-b/, `est-b is locked up front: ${opLog.join(" ")}`);
});

test("the batch is read in ASCENDING id order, so two of them cannot invert", async () => {
    // Expense-vs-Expense, with no parent table involved: two people deleting
    // overlapping selections take the same rows exclusively, and an unordered
    // `findMany` lets the server hand them back in different orders. Pinning
    // the read order is the whole fix — the loop preserves it.
    twoRowBatch();
    currentUser = { id: "u10", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    await deleteExpenses(["e-b", "e-a"]);

    assert.deepEqual(findManyArgs?.orderBy, { id: "asc" }, "the read is ordered");
    assert.deepEqual(
        opLog.filter(entry => entry.startsWith("delete:")),
        ["delete:e-a", "delete:e-b"],
        "and the writes follow that order, not the caller's argument order",
    );
});
