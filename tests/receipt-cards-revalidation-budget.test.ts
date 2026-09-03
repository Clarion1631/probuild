import test, { before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { ReasonCode } from "../src/lib/review-alert-reasons";
import type { CardItemTruth } from "../src/lib/receipt-request-cards";

/**
 * `loadCardItemTruth`'s two DI seams (Codex PR #443 gate, finding 3 in
 * receipt-request-cards): a shared `cache` so recomputing one item's verdict
 * does not repeat the whole competing-component walk for every sibling in the
 * same component, and a `deadlineExceeded` check so a backlog of components
 * cannot blow the cron's `maxDuration = 60` ceiling.
 *
 * `@/lib/prisma` is replaced through the same scoped CJS require() patch the
 * rest of this repo uses — `mock.module` corrupts the require chain on the
 * Node 20 CI pins. `recompute` itself is passed in per-test, so none of this
 * touches the real `recomputeCodesFor` (and therefore no other database
 * query) at all.
 */

process.env.NEXTAUTH_SECRET ??= "test-secret";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

interface FakeIssueRow {
    id: string;
    targetKey: string;
    clearedAt: Date | null;
    reasonCodes: string;
    acknowledgedCodes: string;
    displayDetails: string | null;
}

let issues: FakeIssueRow[];

const fakePrisma = {
    reviewIssue: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
            const ids = new Set(where.id.in);
            return issues.filter(row => ids.has(row.id));
        },
    },
};

function row(id: string, targetKey: string): FakeIssueRow {
    return { id, targetKey, clearedAt: null, reasonCodes: "[]", acknowledgedCodes: "[]", displayDetails: null };
}

let loadCardItemTruth: (
    issueIds: string[],
    deps?: {
        cache?: Map<string, ReasonCode[]>;
        recompute?: (targetKey: string, cache?: Map<string, ReasonCode[]>) => Promise<ReasonCode[]>;
        deadlineExceeded?: () => boolean;
    },
) => Promise<Map<string, CardItemTruth>>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let prismaPatched = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") {
            prismaPatched = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { loadCardItemTruth?: unknown };
    try {
        mod = await import("../src/app/api/cron/receipt-request-cards/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.loadCardItemTruth !== "function") {
        throw new Error(
            `receipt-request-cards route did not load; the require patch ${prismaPatched ? "WAS" : "was NOT"} hit`,
        );
    }
    loadCardItemTruth = mod.loadCardItemTruth as typeof loadCardItemTruth;
});

// ── Memoization: a component's traversal happens ONCE per run ──────────────

test("ten items sharing ONE competing component share ONE recompute call", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `bl-${i}`);
    issues = ids.map(key => row(`ri-${key}`, key));

    let calls = 0;
    const cache = new Map<string, ReasonCode[]>();
    // Stands in for the real recomputeCodesFor: a miss walks the WHOLE
    // component and populates every member's verdict in the cache at once —
    // exactly the behavior finding 3 asks for.
    const recompute = async (targetKey: string, sharedCache?: Map<string, ReasonCode[]>): Promise<ReasonCode[]> => {
        if (sharedCache?.has(targetKey)) return sharedCache.get(targetKey)!;
        calls++;
        for (const key of ids) sharedCache?.set(key, []);
        return sharedCache?.get(targetKey) ?? [];
    };

    const truth = await loadCardItemTruth(issues.map(r => r.id), { cache, recompute });

    assert.equal(calls, 1, "only the FIRST item's miss actually recomputed; the other nine hit the cache");
    assert.equal(truth.size, 10);
    for (const t of truth.values()) assert.equal(t.evidenceSatisfied, true, "the cached [] verdict still reads as evidence found");
});

test("a cache shared across TWO SEPARATE loadCardItemTruth calls (two owners' cards) still recomputes the shared component once", async () => {
    // Mirrors the real caller: one `revalidationCache` created before the
    // owner loop, reused across every owner's `loadCardItemTruth` call.
    const cache = new Map<string, ReasonCode[]>();
    let calls = 0;
    const recompute = async (targetKey: string, sharedCache?: Map<string, ReasonCode[]>): Promise<ReasonCode[]> => {
        if (sharedCache?.has(targetKey)) return sharedCache.get(targetKey)!;
        calls++;
        sharedCache?.set("bl-shared-a", []);
        sharedCache?.set("bl-shared-b", []);
        return sharedCache?.get(targetKey) ?? [];
    };

    issues = [row("ri-a", "bl-shared-a")];
    await loadCardItemTruth(["ri-a"], { cache, recompute });

    issues = [row("ri-b", "bl-shared-b")];
    await loadCardItemTruth(["ri-b"], { cache, recompute });

    assert.equal(calls, 1, "the second owner's card reused the first owner's traversal of the same component");
});

test("items that do not need revalidation (cleared/resolved/acknowledged) never touch the cache", async () => {
    issues = [
        { id: "ri-cleared", targetKey: "bl-cleared", clearedAt: new Date(), reasonCodes: "[]", acknowledgedCodes: "[]", displayDetails: null },
        { id: "ri-resolved", targetKey: "bl-resolved", clearedAt: null, reasonCodes: "[]", acknowledgedCodes: "[]", displayDetails: JSON.stringify({ resolution: "memo-signed" }) },
    ];
    let calls = 0;
    const recompute = async (): Promise<ReasonCode[]> => { calls++; return []; };
    const truth = await loadCardItemTruth(["ri-cleared", "ri-resolved"], { recompute });
    assert.equal(calls, 0, "cheaper checks already answered both — no query was ever needed");
    assert.equal(truth.get("ri-cleared")!.evidenceSatisfied, false);
    assert.equal(truth.get("ri-resolved")!.evidenceSatisfied, false);
});

// ── The revalidation deadline: err toward NOT sending, once the budget is gone ──

test("once the revalidation deadline is already exceeded, no item is recomputed and every one is marked revalidationSkipped", async () => {
    issues = [row("ri-1", "bl-1"), row("ri-2", "bl-2")];
    let calls = 0;
    const recompute = async (): Promise<ReasonCode[]> => { calls++; return []; };
    const truth = await loadCardItemTruth(["ri-1", "ri-2"], { recompute, deadlineExceeded: () => true });

    assert.equal(calls, 0, "no real recompute ran once the budget was already gone");
    assert.equal(truth.get("ri-1")!.revalidationSkipped, true);
    assert.equal(truth.get("ri-2")!.revalidationSkipped, true);
    // Not marked evidence-found — an unverified item must not read as answered.
    assert.equal(truth.get("ri-1")!.evidenceSatisfied, false);
});

test("a deadline that trips MID-RUN still recomputes earlier items and skips only what's left", async () => {
    issues = [row("ri-1", "bl-1"), row("ri-2", "bl-2"), row("ri-3", "bl-3")];
    let calls = 0;
    let exceeded = false;
    const recompute = async (): Promise<ReasonCode[]> => {
        calls++;
        exceeded = true; // the budget runs out DURING the first item's work
        return [];
    };
    const truth = await loadCardItemTruth(["ri-1", "ri-2", "ri-3"], { recompute, deadlineExceeded: () => exceeded });

    assert.equal(calls, 1, "only the item that started before the deadline tripped actually recomputed");
    assert.equal(truth.get("ri-1")!.revalidationSkipped, undefined);
    assert.equal(truth.get("ri-1")!.evidenceSatisfied, true);
    assert.equal(truth.get("ri-2")!.revalidationSkipped, true);
    assert.equal(truth.get("ri-3")!.revalidationSkipped, true);
});

test("rebuildCardItems drops a revalidationSkipped item with reason revalidation-deadline", async () => {
    const { rebuildCardItems } = await import("../src/lib/receipt-request-cards");
    const items = [{ n: 1, fingerprint: "pb-bl-1", date: "2026-08-16", vendor: "LOWES", cents: 12_345, amount: "123.45", cardTail: "8516", issueId: "ri-1", targetKey: "bl-1" }];
    const truth = new Map<string, CardItemTruth>([
        ["ri-1", { clearedAt: null, acknowledged: false, resolved: false, evidenceSatisfied: false, owner: "CJ", revalidationSkipped: true }],
    ]);
    const rebuilt = rebuildCardItems(items, truth, "CJ");
    assert.deepEqual(rebuilt.items, []);
    assert.deepEqual(rebuilt.dropped, [{ issueId: "ri-1", reason: "revalidation-deadline" }]);
});
