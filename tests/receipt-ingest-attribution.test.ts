/**
 * The Drive ingest writes the attribution PAIR from one locked read
 * (Codex PR #442 round 21, item 1).
 *
 * The route matches a Drive folder name to a project, takes that project's
 * newest estimate, and then does real work per group — a phase lookup, a date
 * resolution, an insert. It used to write `projectId: project.id` next to an
 * `estimateId` nobody had looked at since the match, so an estimate moved to
 * another job in that window produced an expense claiming two jobs at once:
 * `resolveExpenseProjectId` answers with the column, every join through the
 * estimate answers with the other job, and no report can be right about it.
 *
 * Prisma is patched at require() time — the same shape as
 * tests/expense-edit-authz.test.ts. No mock.module: CI is Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

/** What the LOCKED estimate read answers. A test moves this to model a race. */
let lockedEstimateProject: string | null;
let created: Record<string, unknown>[];

const fakePrisma: any = {
    $transaction: async (fn: any) => fn(fakePrisma),
    $queryRawUnsafe: async (query: string, ...args: any[]) => {
        if (/FROM "Estimate" WHERE id/.test(query) && /"projectId"/.test(query)) {
            return [{ projectId: lockedEstimateProject }];
        }
        // The phase invariant. It is not what these tests are about, so it
        // answers "yes, an active phase of this job" throughout.
        if (/FROM "Project" WHERE id/.test(query) && /status/.test(query)) {
            return [{ id: args[0], status: "In Progress" }];
        }
        if (/FROM "CostCode" WHERE id/.test(query)) {
            return [{ id: args[0], code: "03-PLUMB", isActive: true }];
        }
        if (/FROM "EstimateItem"/.test(query)) return [{ ok: 1 }];
        return [{ lock_result: null }];
    },
    expense: {
        findFirst: async () => null,
        create: async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return { id: `exp-${created.length}` };
        },
    },
    project: {
        findMany: async () => [
            { id: "job-1", name: "Berg ADU", estimates: [{ id: "est-1" }] },
        ],
    },
    companySettings: { findUnique: async () => ({ timeZone: "America/Los_Angeles" }) },
};

let POST: (req: Request) => Promise<Response>;

before(async () => {
    process.env.RECEIPT_INGEST_SECRET = "test-secret";
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        if (id === "@/lib/project-phases") {
            return {
                // One phase on this job, so a matched category produces a code
                // and the create carries one.
                resolveProjectPhaseCodes: async () => [
                    { id: "cc-plumb", code: "03-PLUMB", name: "Plumbing" },
                ],
            };
        }
        if (id === "@/lib/project-phases-db") return { prismaPhaseDataSource: {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/app/api/integrations/receipt-ingest/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.POST !== "function") throw new Error("receipt-ingest: mocks did not apply");
    POST = mod.POST;
});

beforeEach(() => {
    lockedEstimateProject = "job-1";
    created = [];
});

function post(body: Record<string, unknown>) {
    return POST(
        new Request("https://probuild.test/api/integrations/receipt-ingest", {
            method: "POST",
            headers: { "x-ingest-key": "test-secret", "content-type": "application/json" },
            body: JSON.stringify(body),
        }),
    );
}

const PAYLOAD = {
    projectName: "Berg ADU",
    vendor: "Home Depot",
    date: "2026-08-14",
    fileId: "drive-file-1",
    groups: [{ category: "Plumbing", amount: 120.5 }],
};

test("the pair is written from the LOCKED estimate, together", async () => {
    // The control: nothing moved, so the row is created exactly as before.
    const res = await post(PAYLOAD);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
        ok: true, created: 1, projectId: "job-1", projectName: "Berg ADU", warnings: [],
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].projectId, "job-1");
    assert.equal(created[0].estimateId, "est-1");
});

test("an estimate MOVED between the match and the insert creates nothing", async () => {
    // Writing job-1 beside an estimate that is now on job-2 is the split. The
    // group is skipped and the caller is told, so the Drive file stays
    // unarchived and the next run re-sends it against the current truth.
    lockedEstimateProject = "job-2";
    const res = await post(PAYLOAD);
    const body = await res.json();
    assert.equal(created.length, 0, "nothing was written on either job");
    assert.equal(body.ok, false);
    assert.equal(body.reason, "no-valid-groups");
});

test("an estimate that lost its project is refused too, not written as half a pair", async () => {
    lockedEstimateProject = null;
    const res = await post(PAYLOAD);
    assert.equal(created.length, 0);
    assert.equal((await res.json()).ok, false);
});

test("one moved group does not silently drop the others", async () => {
    // Every group in a document shares the estimate, so a move refuses all of
    // them — and each refusal is REPORTED rather than counted as a success.
    lockedEstimateProject = "job-2";
    const res = await post({
        ...PAYLOAD,
        groups: [
            { category: "Plumbing", amount: 120.5 },
            { category: "Framing", amount: 80 },
        ],
    });
    const body = await res.json();
    assert.equal(created.length, 0);
    assert.equal(body.ok, false, "zero valid groups is not a successful ingest");
});
