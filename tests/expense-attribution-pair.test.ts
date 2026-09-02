/**
 * `projectId` and `estimateId` are ONE fact, and every creator wrote them from
 * two reads taken minutes apart (Codex round 20, item 3).
 *
 * The project is the answer and the estimate is where it came from. Resolving
 * the estimate's project, doing other work — a cost-code lookup, a receipt-file
 * check, a QBO round trip — and only then inserting both means an estimate
 * moved in that window is persisted alongside the OLD project: an expense on
 * two jobs at once, which `resolveExpenseProjectId` and every join through the
 * estimate answer differently, and no report can be right about.
 *
 * These drive the shared helpers against a scripted database, so each
 * interleaving is deterministic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    itemBelongsToEstimateTx,
    lockEstimateAttribution,
} from "../src/lib/expense-attribution";

function db(world: {
    estimateProject: string | null;
    items?: { id: string; estimateId: string }[];
    onLock?: () => void;
}) {
    const queries: string[] = [];
    const tx = {
        async $queryRawUnsafe(query: string, ...args: unknown[]) {
            queries.push(query.replace(/\s+/g, " ").trim());
            if (/FROM "Estimate" WHERE id/.test(query) && /FOR SHARE/.test(query)) {
                world.onLock?.();
                return [];
            }
            if (/FROM "Estimate" WHERE id/.test(query)) {
                return [{ projectId: world.estimateProject }];
            }
            if (/FROM "EstimateItem"/.test(query)) {
                const [itemId, estimateId] = args as string[];
                return (world.items ?? []).some(
                    item => item.id === itemId && item.estimateId === estimateId,
                )
                    ? [{ id: itemId }]
                    : [];
            }
            return [];
        },
    };
    return { tx, queries };
}

test("the pair comes back together, from a LOCKED estimate", async () => {
    const { tx, queries } = db({ estimateProject: "job-1" });
    assert.deepEqual(await lockEstimateAttribution(tx, "est-1"), {
        estimateId: "est-1",
        projectId: "job-1",
    });
    // The lock is taken BEFORE the read it protects — a read taken first
    // describes a moment the lock then fails to preserve.
    assert.match(queries[0], /FOR SHARE/);
    assert.ok(!/FOR SHARE/.test(queries[1]), "then the read");
});

test("an estimate with no project is not half a pair", async () => {
    // Callers must refuse: there is no job to attribute against, and writing
    // the estimate alone would leave a row nobody can resolve.
    const { tx } = db({ estimateProject: null });
    assert.equal(await lockEstimateAttribution(tx, "est-1"), null);
});

test("a MOVED estimate reports its new job, not the caller's stale one", async () => {
    // This is the whole point: the caller compares what it read earlier with
    // what this returns, and refuses when they differ.
    const { tx } = db({ estimateProject: "job-2" });
    const pair = await lockEstimateAttribution(tx, "est-1");
    assert.equal(pair?.projectId, "job-2");
    assert.notEqual(pair?.projectId, "job-1", "the pre-transaction answer is void");
});

test("the lock is taken even when the estimate has since vanished", async () => {
    const { tx, queries } = db({ estimateProject: null });
    await lockEstimateAttribution(tx, "gone");
    assert.match(queries[0], /FOR SHARE/);
});

// ── the line item is re-checked under the same lock ────────────────────────

test("an item on the estimate passes; one that was re-parented does not", async () => {
    const world = { estimateProject: "job-1", items: [{ id: "item-1", estimateId: "est-1" }] };
    const { tx } = db(world);
    assert.equal(await itemBelongsToEstimateTx(tx, "item-1", "est-1"), true);
    assert.equal(
        await itemBelongsToEstimateTx(tx, "item-1", "est-2"),
        false,
        "an item is only on one estimate",
    );
    assert.equal(await itemBelongsToEstimateTx(tx, "item-elsewhere", "est-1"), false);
});

test("the item check locks the row it answers about", async () => {
    // A re-parented item is how a cost code from another job reaches an
    // expense, so the answer has to hold until the write.
    const { tx, queries } = db({ estimateProject: "job-1", items: [{ id: "i", estimateId: "e" }] });
    await itemBelongsToEstimateTx(tx, "i", "e");
    assert.match(queries[0], /FROM "EstimateItem"/);
    assert.match(queries[0], /FOR SHARE/);
});
