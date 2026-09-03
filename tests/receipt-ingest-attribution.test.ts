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
 * company-timezone — which this route calls on every request. Patching only
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

/**
 * What the LOCKED estimate read answers. A test sets `lockedEstimateProject`
 * to model every group in the request seeing the same (post-move) answer, or
 * loads `estimateProjectSequence` to model the project CHANGING partway
 * through the loop — group 1 sees one answer, group 2 sees another, from the
 * same request. The sequence is consumed in order and falls back to
 * `lockedEstimateProject` once exhausted.
 */
let lockedEstimateProject: string | null;
let estimateProjectSequence: (string | null)[];
let created: Record<string, unknown>[];

/**
 * A REAL mutex behind `pg_advisory_xact_lock`, so a concurrency claim can be
 * tested rather than asserted.
 *
 * Postgres serialises two transactions that ask for the same key and releases
 * at COMMIT/ROLLBACK; a fake that ignored the lock query would let both
 * deliveries run straight through and the test would pass on a route with no
 * lock at all. Each key gets a promise chain: the second acquirer waits for
 * the first to settle. `lockKeys` records what was asked for, so a test can
 * also prove the key is scoped to the FILE rather than to something coarser.
 */
const lockChain = new Map<string, Promise<void>>();
let lockKeys: string[];

async function acquireLock(key: string): Promise<() => void> {
    lockKeys.push(key);
    const prior = lockChain.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    lockChain.set(key, prior.then(() => mine));
    await prior;
    return release;
}

/**
 * Real Postgres only keeps what a transaction actually COMMITS — a throw
 * inside `prisma.$transaction` rolls back everything the callback wrote, not
 * just the statement that threw. The fake models that instead of trusting the
 * route: writes land in a per-call buffer and are merged into `created` only
 * if the callback resolves; a throw discards the buffer, exactly as ROLLBACK
 * would.
 */
const fakePrisma: any = {
    $transaction: async (fn: any) => {
        const buffer: Record<string, unknown>[] = [];
        const releases: (() => void)[] = [];
        const txClient = {
            ...fakePrisma,
            // The lock is taken ON THIS TRANSACTION and released when it
            // settles — the ordering the route depends on. The rows are
            // published to `created` BEFORE the release, because Postgres
            // makes a transaction's writes visible and drops its advisory
            // locks at the same instant: releasing first would let the loser
            // re-read an empty table and the dedupe would look broken when it
            // is not.
            $queryRawUnsafe: async (query: string, ...args: any[]) => {
                if (/pg_advisory_xact_lock/.test(query)) {
                    releases.push(await acquireLock(String(args[0])));
                    return [{ lock_result: null }];
                }
                return fakePrisma.$queryRawUnsafe(query, ...args);
            },
            expense: {
                ...fakePrisma.expense,
                create: async (args: { data: Record<string, unknown> }) => {
                    buffer.push(args.data);
                    return { id: `exp-${created.length + buffer.length}` };
                },
            },
        };
        try {
            const result = await fn(txClient);
            created.push(...buffer);
            return result;
        } finally {
            for (const release of releases) release();
        }
    },
    $queryRawUnsafe: async (query: string, ...args: any[]) => {
        if (/FROM "Estimate" WHERE id/.test(query) && /"projectId"/.test(query)) {
            const projectId = estimateProjectSequence.length > 0
                ? estimateProjectSequence.shift()!
                : lockedEstimateProject;
            return [{ projectId }];
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
        // The dedupe query, answered from what has actually COMMITTED. A
        // hard-coded null could never tell a first delivery from a second.
        findFirst: async (args: any) => {
            const needle = args?.where?.receiptUrl?.contains;
            if (typeof needle !== "string") return null;
            const hit = created.find(
                row => typeof row.receiptUrl === "string" && row.receiptUrl.includes(needle),
            );
            return hit ? { id: "exp-existing" } : null;
        },
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
        // EVERY specifier that resolves to our Prisma singleton, not just the
        // alias. 33 modules under src/lib import it as `./prisma`, and one of
        // them is company-timezone, which this route calls on every request.
        // Patching only the alias left that call on the REAL client: with a
        // populated .env it queried the live database, and in CI it hung for
        // four seconds before failing. `@prisma/client` is deliberately not
        // matched here.
        if (PRISMA_SPECIFIERS.has(id)) return { prisma: fakePrisma };
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
    estimateProjectSequence = [];
    created = [];
    lockKeys = [];
    lockChain.clear();
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

test("an estimate MOVED between the match and the insert writes nothing, and says so retryably", async () => {
    // Writing job-1 beside an estimate that is now on job-2 is the split. The
    // whole transaction aborts — not just this group — and the caller gets a
    // distinct retryable failure, so the Drive file stays unarchived and the
    // next run re-sends it against the current truth.
    lockedEstimateProject = "job-2";
    const res = await post(PAYLOAD);
    const body = await res.json();
    assert.equal(created.length, 0, "nothing was written on either job");
    assert.equal(res.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "attribution-race");
    assert.equal(body.retryable, true);
});

test("an estimate that lost its project is refused too, not written as half a pair", async () => {
    lockedEstimateProject = null;
    const res = await post(PAYLOAD);
    const body = await res.json();
    assert.equal(created.length, 0);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "attribution-race");
    assert.equal(body.retryable, true);
});

test("one moved group aborts the whole receipt, not just itself", async () => {
    // Every group in a document shares the estimate, so a move refuses all of
    // them atomically — nothing from either group lands half-written.
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
    assert.equal(body.ok, false);
    assert.equal(body.reason, "attribution-race");
    assert.equal(body.retryable, true);
});

// ── one delivery at a time, per Drive file (round 33, item 1) ──────────────

test("two concurrent deliveries of the same file ingest it exactly ONCE", async () => {
    // The bug this replaces: the dedupe read ran BEFORE the transaction, took
    // no lock, and was the whole decision. Two deliveries of the same Drive
    // file — the Apps Script retrying a request whose response was lost, or
    // two runs overlapping — both read "no expense carries this file id" and
    // both inserted every group. The receipt was booked twice on the same job,
    // with nothing in the data to tell the copies apart.
    //
    // The lock is real in this fake (see acquireLock), so this only passes if
    // the route actually takes it INSIDE the transaction and re-asks the
    // dedupe underneath it.
    const [first, second] = await Promise.all([post(PAYLOAD), post(PAYLOAD)]);
    const bodies = [await first.json(), await second.json()];

    assert.equal(created.length, 1, "one set of expenses, not two");
    assert.equal(bodies.filter(b => b.created === 1).length, 1, "exactly one delivery wrote");
    const loser = bodies.find(b => b.alreadyIngested);
    assert.ok(loser, "the loser gets the idempotent answer, not a second copy");
    assert.deepEqual(loser, { ok: true, alreadyIngested: true, created: 0 });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
});

test("the ingest lock is keyed on the DRIVE FILE, not on something coarser", async () => {
    // A lock on the project (or a constant) would serialise unrelated
    // receipts and still not identify this document; a lock on the whole
    // payload would change with every retry and guard nothing.
    await post(PAYLOAD);
    assert.deepEqual(lockKeys, ["receipt-ingest:drive-file-1"]);
});

test("two deliveries of DIFFERENT files do not block each other", async () => {
    await Promise.all([post(PAYLOAD), post({ ...PAYLOAD, fileId: "drive-file-2" })]);
    assert.equal(created.length, 2);
    assert.deepEqual(
        [...lockKeys].sort(),
        ["receipt-ingest:drive-file-1", "receipt-ingest:drive-file-2"],
    );
});

// ── a malformed group refuses the whole document (round 33, item 2) ────────

test("one malformed group writes NOTHING and names the group that failed", async () => {
    // The bug this replaces: the loop `continue`d past a malformed group from
    // inside the "atomic" transaction. Its valid sibling committed, the
    // response said ok with a plausible `created` count, and the file-level
    // dedupe then matched that sibling on every retry — so the malformed
    // group could never be re-offered and its money silently left the books.
    const res = await post({
        ...PAYLOAD,
        groups: [
            { category: "Plumbing", amount: 120.5 },
            { category: "Framing", amount: "not a number" },
            { category: "Demo", amount: 0 },
        ],
    });
    const body = await res.json();

    assert.equal(created.length, 0, "the valid sibling did NOT commit on its own");
    assert.equal(res.status, 422);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "invalid-group");
    assert.equal(body.retryable, true);
    assert.deepEqual(body.invalidGroups, [
        { index: 1, category: "Framing", reason: "amount is not a finite number" },
        { index: 2, category: "Demo", reason: "amount rounds to zero" },
    ]);
});

test("the SAME payload, corrected, ingests every group", async () => {
    // The other half of the contract: refusing the document has to leave it
    // re-sendable. Nothing was written, so the file-level dedupe does not
    // match and the corrected delivery lands all three groups.
    const refused = await post({
        ...PAYLOAD,
        groups: [
            { category: "Plumbing", amount: 120.5 },
            { category: "Framing", amount: "not a number" },
        ],
    });
    assert.equal(refused.status, 422);
    assert.equal(created.length, 0);

    const res = await post({
        ...PAYLOAD,
        groups: [
            { category: "Plumbing", amount: 120.5 },
            { category: "Framing", amount: 80 },
        ],
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.created, 2);
    assert.equal(created.length, 2);
});

test("a document whose ONLY group is unusable is refused, not answered 200", async () => {
    // This used to fall through to `{ ok: false, reason: "no-valid-groups" }`
    // with a 200 — a status the Apps Script reads as "handled", which archives
    // the file and retires the receipt unbooked.
    const res = await post({ ...PAYLOAD, groups: [{ category: "Plumbing", amount: 0 }] });
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.equal(body.reason, "invalid-group");
    assert.equal(created.length, 0);
});

test("attribution changing BETWEEN group 1 and group 2 rolls back group 1 too", async () => {
    // The bug this replaces: group 1 committed through its OWN transaction
    // before the estimate moved, group 2's transaction then saw the new
    // project and skipped itself — but group 1 was already written, and the
    // response still said `created > 0`, so a retry reported `alreadyIngested`
    // with group 2 permanently lost. Group 1's lock read answers "job-1" (a
    // match), group 2's answers "job-2" (a move) — both from the SAME
    // request, proving the transaction is one unit, not one per group.
    estimateProjectSequence = ["job-1", "job-2"];
    const res = await post({
        ...PAYLOAD,
        groups: [
            { category: "Plumbing", amount: 120.5 },
            { category: "Framing", amount: 80 },
        ],
    });
    const body = await res.json();
    assert.equal(created.length, 0, "group 1's write did not survive group 2's abort");
    assert.equal(res.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "attribution-race");
    assert.equal(body.retryable, true);
});
