/**
 * CONVERTING A LEAD MOVES ITS ESTIMATES — AND MUST NOT ORPHAN THEIR EXPENSES.
 *
 * `convertLeadToProjectCore` is the ONE path in this codebase that changes an
 * existing `Estimate.projectId`; everything else that looks like a move is
 * really a create (`duplicateEstimate`). `Expense.projectId` is write-once and
 * `Estimate.projectId` is not, so before this guard an estimate carrying
 * expenses pinned to another job could be moved out from under them: the rows
 * kept claiming job A while the estimate, the billing paths and the phase
 * cascade all followed job B — one expense on two jobs, which no variance or
 * profitability report can be right about.
 *
 * Prisma and the side-effect modules are patched at require() time — same shape
 * as tests/expense-delete-scope.test.ts. No mock.module: CI is Node 20. The
 * patch stays installed for the whole file because the conversion's Drive and
 * access-grant calls are DYNAMIC imports, resolved when it runs rather than
 * when it loads.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { isEstimateAttributionPairConflict } from "../src/lib/expense-attribution";

interface FakeExpense {
    estimateId: string;
    projectId: string | null;
}

let estimatesOnLead: { id: string }[];
let expenses: FakeExpense[];
let locked: string[];
let movedIds: string[] | null;
let movedTo: string | null;

const noopMany = { updateMany: async () => ({ count: 0 }) };

const tx: any = {
    project: { create: async () => ({ id: "job-new", name: "Hoppe Hall Bath" }) },
    estimate: {
        findMany: async () => estimatesOnLead,
        updateMany: async (args: any) => {
            movedIds = args.where?.id?.in ?? null;
            movedTo = args.data?.projectId ?? null;
            return { count: movedIds?.length ?? 0 };
        },
    },
    lead: { update: async () => ({}) },
    roomDesign: noopMany,
    contract: noopMany,
    projectFile: noopMany,
    fileFolder: noopMany,
    scheduleTask: noopMany,
    takeoff: noopMany,
    clientMessage: noopMany,
    // The FOR UPDATE locks lockMoneyParentsMany takes, in the order it takes them.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        assert.match(strings.join("?"), /FOR UPDATE/);
        locked.push(String(values[0]));
        return [];
    },
    // The grouped conflict count, modelled from `expenses`.
    $queryRawUnsafe: async (_query: string, ids: string[], target: string) => {
        const groups = new Map<string, { estimateId: string; projectId: string; expenses: number }>();
        for (const expense of expenses) {
            if (!ids.includes(expense.estimateId)) continue;
            if (expense.projectId === null || expense.projectId === target) continue;
            const key = expense.estimateId + "|" + expense.projectId;
            const found = groups.get(key);
            if (found) found.expenses += 1;
            else groups.set(key, { estimateId: expense.estimateId, projectId: expense.projectId, expenses: 1 });
        }
        return [...groups.values()];
    },
};

const fakePrisma: any = {
    lead: {
        findUnique: async () => ({
            id: "lead-1",
            name: "Hoppe Hall Bath",
            clientId: "client-1",
            location: "1 Main St",
            client: { email: "c@example.com" },
        }),
        update: async () => ({}),
    },
    // Not already converted — the idempotency guard must fall through.
    project: { findUnique: async () => null, update: async () => ({}) },
    fileFolder: { create: async () => ({}) },
    // The conversion's tail work. `auto-grant-project-access` and
    // `google-drive` are DYNAMIC imports, which esbuild leaves as real
    // `import()` calls — those bypass the require patch entirely, so the
    // modules load for real and read this fake through their own
    // `require("@/lib/prisma")`. No eligible users means auto-grant returns
    // before it writes anything, and Drive with no token returns its mock.
    userPermission: { findMany: async () => [] },
    projectAccess: { createMany: async () => ({ count: 0 }) },
    $transaction: async (fn: any) => (typeof fn === "function" ? fn(tx) : []),
};

let convertLeadToProjectCore: (leadId: string) => Promise<{ id: string }>;
let originalRequire: typeof Module.prototype.require;

before(async () => {
    originalRequire = Module.prototype.require;
    let hit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") { hit = true; return { prisma: fakePrisma }; }
        if (id === "./geocode" || id === "@/lib/geocode") {
            return { geocodeJobSiteAddress: async () => null };
        }
        if (id === "./project-folders" || id === "@/lib/project-folders") {
            return { ensureStandardFolders: async () => {} };
        }
        if (id === "@/lib/auto-grant-project-access") {
            return { autoGrantProjectAccessToEligibleUsers: async () => {} };
        }
        if (id === "./google-drive" || id === "@/lib/google-drive") {
            return { createProjectDriveFolder: async () => ({ success: false }) };
        }
        if (id === "next/cache") return { revalidatePath: () => {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const mod: any = await import("../src/lib/lead-conversion-core");
    if (typeof mod.convertLeadToProjectCore !== "function") {
        throw new Error("lead-conversion: mocks did not apply (require patch " + (hit ? "WAS" : "was NOT") + " hit)");
    }
    convertLeadToProjectCore = mod.convertLeadToProjectCore;
});

after(() => {
    Module.prototype.require = originalRequire;
});

beforeEach(() => {
    estimatesOnLead = [{ id: "est-1" }];
    expenses = [];
    locked = [];
    movedIds = null;
    movedTo = null;
});

test("the conversion is REFUSED when a linked expense is pinned to another job", async () => {
    // The estimate is still on the lead, but two expenses booked through it
    // already name job-old. Moving it would strand them there.
    expenses = [
        { estimateId: "est-1", projectId: "job-old" },
        { estimateId: "est-1", projectId: "job-old" },
    ];
    await assert.rejects(
        () => convertLeadToProjectCore("lead-1"),
        (error: unknown) => {
            assert.ok(isEstimateAttributionPairConflict(error), "a typed conflict the route maps to 409");
            const message = (error as Error).message;
            assert.match(message, /est-1/);
            assert.match(message, /job-old/);
            assert.match(message, /2 expense\(s\)/);
            assert.match(message, /Re-attribute those expenses/);
            return true;
        },
    );
    assert.equal(movedIds, null, "nothing was moved");
});

test("the conversion proceeds when nothing is linked", async () => {
    const project = await convertLeadToProjectCore("lead-1");
    assert.equal(project.id, "job-new");
    assert.deepEqual(movedIds, ["est-1"], "and it moves the ids it checked, not a leadId re-scan");
    assert.equal(movedTo, "job-new");
});

test("an expense with no project of its own does NOT block — the move answers it", async () => {
    // A NULL projectId resolves THROUGH the estimate, so the conversion is what
    // finally gives it a job. Blocking on it would make every ordinary lead
    // conversion with a booked expense impossible.
    expenses = [{ estimateId: "est-1", projectId: null }];
    await convertLeadToProjectCore("lead-1");
    assert.deepEqual(movedIds, ["est-1"]);
});

test("an expense already on the target job does not block", async () => {
    expenses = [{ estimateId: "est-1", projectId: "job-new" }];
    await convertLeadToProjectCore("lead-1");
    assert.deepEqual(movedIds, ["est-1"]);
});

test("every estimate being moved is LOCKED first, in ascending id order", async () => {
    // A count taken without the lock is a count a concurrent booking can
    // falsify between the check and the move. Ascending ids is the same rule
    // lockMoneyParentsMany gives every other money path, so a conversion and a
    // milestone settle cannot deadlock against each other.
    estimatesOnLead = [{ id: "est-b" }, { id: "est-a" }];
    await convertLeadToProjectCore("lead-1");
    assert.deepEqual(locked, ["est-a", "est-b"], "sorted by the guard, not by the read");
    // The move covers exactly the set that was locked and counted. Its ORDER is
    // the read order — only the lock acquisition has to be sorted.
    assert.deepEqual([...(movedIds ?? [])].sort(), ["est-a", "est-b"]);
});

test("a lead with no estimates converts without touching the estimate table", async () => {
    estimatesOnLead = [];
    await convertLeadToProjectCore("lead-1");
    assert.deepEqual(locked, []);
    assert.equal(movedIds, null, "no id-less updateMany that would match every row");
});
