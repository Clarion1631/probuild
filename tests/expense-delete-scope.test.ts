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

const fakePrisma = {
    expense: {
        findUnique: async () => storedExpense,
        deleteMany: async (args: unknown) => {
            deleteArgs = args;
            return { count: 1 };
        },
    },
};

let deleteExpense: (id: string, projectId: string) => Promise<void>;

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
});

beforeEach(() => {
    currentUser = { id: "u1", role: "MANAGER", permissions: { timeClock: true }, projectIds: ["job-1"] };
    // RE-ATTRIBUTED: it lives on job-1 now, its estimate still names job-2.
    storedExpense = {
        qbPurchaseId: null,
        invoiceId: null,
        invoicedAt: null,
        projectId: "job-1",
        estimate: { projectId: "job-2" },
    };
    deleteArgs = null;
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
    assert.deepEqual(deleteArgs, {
        where: { id: "e1", qbPurchaseId: null, invoiceId: null, invoicedAt: null },
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
