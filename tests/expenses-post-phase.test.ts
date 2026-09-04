/**
 * POST /api/expenses — what the request SAID about the phase (round 42, item 3).
 *
 * `parseCostCodeIdEdit` keeps `clear` and `untouched` apart because they are
 * different facts, and this route threw the distinction away: both became a
 * null code with a NULL provenance, which is the state every automated pass
 * reads as "no human has spoken, a machine may write". A crew member who
 * deliberately picked NO phase on the phone had the QBO suggester put its regex
 * guess on the row minutes later — the clear-then-overwrite failure round 36
 * fixed for the edit path, still live on the create path.
 *
 * This is a REAL route test, not a source-text assertion. Prisma, mobile auth
 * and the cost-coding readers are patched at require() time, the same shape
 * tests/expense-edit-authz.test.ts uses. No mock.module: CI is Node 20.
 * `NEXTAUTH_SECRET` is set before the import because `mobile-auth` throws at
 * module load without one.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

process.env.NEXTAUTH_SECRET ||= "expenses-post-phase-test-secret";

let created: Record<string, unknown> | null = null;
let allowedPhase = true;

const fakePrisma: any = {
    // The receipt-evidence lock and its epoch bump (PR #443 gate rounds
    // 42/45): every Expense writer takes them, and nothing in this suite
    // depends on their result — only that they are answerable.
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ value: "1" }],
    $transaction: async (fn: any) => fn(fakePrisma),
    $queryRawUnsafe: async (query: string) => {
        // The locked attribution pair, read back off the estimate.
        if (/SELECT "projectId" FROM "Estimate"/.test(query)) return [{ projectId: "job-1" }];
        // The phase invariant's proof query and its lock scans.
        if (/SELECT 1 AS ok/.test(query)) return [{ ok: 1 }];
        if (/FROM "Project" WHERE id/.test(query)) return [{ id: "job-1", status: "In Progress" }];
        if (/FROM "CostCode" WHERE id/.test(query)) return [{ id: "cc-frame", code: "02-FRAME", isActive: true }];
        if (/FROM "EstimateItem" WHERE id/.test(query)) return [{ id: "item-own" }];
        return [];
    },
    estimate: { findUnique: async () => ({ projectId: "job-1" }), findFirst: async () => ({ id: "est-job-1" }) },
    estimateItem: { findFirst: async () => ({ id: "item-own" }) },
    expense: {
        create: async (args: any) => {
            created = args.data;
            return { id: "exp-1", ...args.data };
        },
    },
};

let POST: (req: any) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") return { prisma: fakePrisma };
        if (id === "@/lib/mobile-auth") {
            return {
                authenticateMobileOrSession: async () => ({
                    ok: true,
                    user: { id: "u1", role: "ADMIN", permissions: {}, projectIds: ["job-1"] },
                }),
                userCanAccessProject: async () => true,
            };
        }
        if (id === "@/lib/cost-coding") {
            return {
                resolveCostCode: async (_src: unknown, input: { costCodeId: string }) => ({
                    ok: true, costCodeId: input.costCodeId, costTypeId: null,
                }),
            };
        }
        if (id === "@/lib/project-phases") {
            return {
                isCostCodeAllowedForProject: async () => allowedPhase,
                PHASE_ELIGIBLE_ESTIMATE_STATUSES: ["Approved"],
                SAFETY_COST_CODE: "99-SAFETY",
                shouldIncludeSafetyPhase: () => false,
            };
        }
        if (id === "@/lib/company-timezone") {
            return {
                resolveCompanyTimeZone: async () => "America/Los_Angeles",
                dateOnlyInTimeZone: (value: string) => new Date(`${value}T12:00:00.000Z`),
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/app/api/expenses/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.POST !== "function") throw new Error("expenses-post-phase: mocks did not apply");
    POST = mod.POST;
});

beforeEach(() => {
    created = null;
    allowedPhase = true;
});

const post = (body: Record<string, unknown>) =>
    POST({ json: async () => ({ estimateId: "est-job-1", amount: 25, ...body }) } as never);

test("an explicit costCodeId:null is a person saying NO phase", async () => {
    // THE CASE FROM THE REVIEW. Recorded as `manual-none`, which is in
    // HUMAN_COST_CODE_SOURCES, so notHumanCodedExpenseWhere() holds the QBO
    // suggester and the backfill off it.
    const res = await post({ costCodeId: null });
    assert.equal(res.status, 200);
    assert.equal(created?.costCodeId, null);
    assert.equal(created?.costCodeSource, "manual-none", "the decision is recorded as one");
});

test("an OMITTED costCodeId is unclassified, and stays machine-writable", async () => {
    // The control, and the reason this route tolerates a missing key at all:
    // legacy mobile builds and the no-photo path send nothing, and silence
    // means "nobody was asked", never "somebody said none".
    const res = await post({});
    assert.equal(res.status, 200);
    assert.equal(created?.costCodeId, null);
    assert.equal(created?.costCodeSource, null, "no human has spoken here");
});

test("a real phase is still captured as a person's answer", async () => {
    const res = await post({ costCodeId: "cc-frame" });
    assert.equal(res.status, 200);
    assert.equal(created?.costCodeId, "cc-frame");
    assert.equal(created?.costCodeSource, "capture");
});

test("an empty string is a clear, like every other handler reads it", async () => {
    for (const value of ["", "   "]) {
        created = null;
        const res = await post({ costCodeId: value });
        assert.equal(res.status, 200, JSON.stringify(value));
        const row = created as Record<string, unknown> | null;
        assert.equal(row?.costCodeId, null);
        assert.equal(row?.costCodeSource, "manual-none");
    }
});

test("a malformed costCodeId is a 400, and writes nothing", async () => {
    for (const value of [123, false, [], { id: "cc-frame" }]) {
        created = null;
        const res = await post({ costCodeId: value });
        assert.equal(res.status, 400, JSON.stringify(value));
        assert.equal((await res.json()).field, "costCodeId");
        assert.equal(created, null);
    }
});

test("a phase that is not on the job is refused, not silently dropped", async () => {
    allowedPhase = false;
    const res = await post({ costCodeId: "cc-frame" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "PHASE_NOT_ON_PROJECT");
    assert.equal(created, null);
});
