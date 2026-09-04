/**
 * The AI receipt parse writes the attribution PAIR from one locked read
 * (Codex PR #442 round 21, item 1).
 *
 * The route picks the project's newest estimate, then makes a model call that
 * takes seconds. It used to insert `projectId` (the caller's) next to that
 * estimate without looking at it again, so an estimate moved to another job
 * while the model was reading the image produced an expense on two jobs at
 * once. This row is a convenience — a Pending draft for a bookkeeper — so a
 * wrong one costs more than none: the disagreement creates nothing and says so.
 *
 * Prisma, auth, storage and the Anthropic SDK are patched at require() time.
 * No mock.module: CI is Node 20.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

/**
 * The route reaches Prisma through specifiers this file's require() patch does
 * not intercept (`./prisma` from inside src/lib), so a real client is
 * constructed at import time. It never connects: every query here is faked.
 * But constructing it DEMANDS the variable, and CI has no `.env` to fall back
 * on.
 *
 * `pgbouncer=true` is REQUIRED, not decoration: src/lib/prisma.ts refuses a
 * URL without it (the Supabase transaction pooler needs it, and shipping
 * without it once took the site down). The bare value other tests use is
 * enough for them because they never reach that module.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?pgbouncer=true";

/**
 * EVERY specifier that resolves to the Prisma singleton, not just the alias.
 *
 * 33 modules under src/lib import it as `./prisma`, and one of them is
 * company-timezone — which this route calls to date the expense. Patching only
 * `@/lib/prisma` left that call on the REAL client: with a populated `.env` it
 * queried the live database, and in CI it hung for four seconds and then
 * failed. `@prisma/client` is deliberately NOT in this set.
 */
const PRISMA_SPECIFIERS = new Set([
    "@/lib/prisma",
    "./prisma",
    "../prisma",
    "../lib/prisma",
]);

/** What the LOCKED estimate read answers. A test moves this to model a race. */
let lockedEstimateProject: string | null;
let created: Record<string, unknown>[];

const fakePrisma: any = {
    // The receipt-evidence lock and its epoch bump (PR #443 gate rounds
    // 42/45): every Expense writer takes them, and nothing in this suite
    // depends on their result — only that they are answerable.
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ value: "1" }],
    $transaction: async (fn: any) => fn(fakePrisma),
    $queryRawUnsafe: async (query: string) => {
        if (/FROM "Estimate" WHERE id/.test(query) && /"projectId"/.test(query)) {
            return [{ projectId: lockedEstimateProject }];
        }
        return [{ lock_result: null }];
    },
    estimate: { findFirst: async () => ({ id: "est-1" }) },
    expense: {
        create: async (args: { data: Record<string, unknown> }) => {
            created.push(args.data);
            return { id: `exp-${created.length}` };
        },
    },
    companySettings: { findUnique: async () => ({ timeZone: "America/Los_Angeles" }) },
};

const PARSED = {
    vendor: "Home Depot",
    date: "2026-08-14",
    total: 120.5,
    confidence: 0.94,
};

let POST: (req: any) => Promise<Response>;

before(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        // EVERY specifier that resolves to our Prisma singleton, not just the
        // alias. 33 modules under src/lib import it as `./prisma`, and one of
        // them is company-timezone, which this route calls on every request.
        // Patching only the alias left that call on the REAL client: with a
        // populated .env it queried the live database, and in CI it hung for
        // four seconds before failing. `@prisma/client` is deliberately not
        // matched here.
        if (PRISMA_SPECIFIERS.has(id)) return { prisma: fakePrisma };
        if (id === "@/lib/mobile-auth") {
            return {
                authenticateMobileOrSession: async () => ({ ok: true, user: { id: "u1" } }),
                userCanAccessProject: async () => true,
            };
        }
        if (id === "@/lib/supabase") return { getSupabase: () => null, STORAGE_BUCKET: "bucket" };
        if (id === "@anthropic-ai/sdk") {
            class FakeAnthropic {
                messages = {
                    create: async () => ({
                        content: [{ type: "text", text: JSON.stringify(PARSED) }],
                    }),
                };
            }
            return { __esModule: true, default: FakeAnthropic };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/app/api/receipts/parse/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.POST !== "function") throw new Error("receipts/parse: mocks did not apply");
    POST = mod.POST;
});

beforeEach(() => {
    lockedEstimateProject = "job-1";
    created = [];
});

function post(body: Record<string, unknown>) {
    return POST({
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
    });
}

const BODY = {
    // A 1x1 PNG is not needed: the JSON path trusts the declared mimeType and
    // hands the bytes straight to the (faked) model.
    imageBase64: "AAAA",
    mimeType: "image/png",
    projectId: "job-1",
};

test("the pair is written from the LOCKED estimate, together", async () => {
    const res = await post(BODY);
    const body = await res.json();
    assert.equal(body.expenseCreated, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].projectId, "job-1");
    assert.equal(created[0].estimateId, "est-1");
});

test("an estimate MOVED during the model call creates nothing, and says why", async () => {
    lockedEstimateProject = "job-2";
    const res = await post(BODY);
    const body = await res.json();
    assert.equal(created.length, 0, "no row on either job");
    assert.equal(body.expenseCreated, false);
    assert.equal(body.expenseSkipReason, "estimate-moved");
    // The PARSE still succeeds — the caller gets its fields and can retry the
    // expense by hand. A race on a draft row is not a failed read.
    assert.equal(body.success, true);
    assert.equal(body.vendor, "Home Depot");
});

test("an estimate that lost its project is refused too", async () => {
    lockedEstimateProject = null;
    const body = await (await post(BODY)).json();
    assert.equal(created.length, 0);
    assert.equal(body.expenseSkipReason, "estimate-moved");
});
