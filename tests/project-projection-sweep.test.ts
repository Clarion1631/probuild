import assert from "node:assert/strict";
import test from "node:test";

test("projection sweep is hard-capped and uses one as-of instant", async () => {
    const sweepModule = await import("@/lib/project-projection-sweep").catch(() => null);
    assert.ok(sweepModule, "expected the projection sweep module to exist");

    const selectedIds = Array.from({ length: 105 }, (_, index) => `project-${index}`);
    const recomputed: Array<{ projectId: string; asOf: Date; staleBefore: Date }> = [];
    let selectedWith: { staleBefore: Date; limit: number } | null = null;
    const asOf = new Date("2026-08-26T18:37:00.000Z");
    const result = await sweepModule.runProjectProjectionSweep({
        listStaleProjectIds: async input => {
            selectedWith = input;
            return selectedIds;
        },
        recomputeProject: async input => {
            recomputed.push(input);
            return "recomputed" as const;
        },
    }, { asOf, limit: 500 });

    assert.deepEqual(selectedWith, {
        staleBefore: new Date("2026-08-26T00:00:00.000Z"),
        limit: 100,
    });
    assert.equal(recomputed.length, 100);
    assert.ok(recomputed.every(call => call.asOf === asOf));
    assert.ok(recomputed.every(call => call.staleBefore.toISOString() === "2026-08-26T00:00:00.000Z"));
    assert.deepEqual(result, { selected: 100, recomputed: 100, skipped: 0, failed: 0, hasMore: true });
});

test("projection sweep continues after one project fails", async () => {
    const { runProjectProjectionSweep } = await import("@/lib/project-projection-sweep");
    const result = await runProjectProjectionSweep({
        listStaleProjectIds: async () => ["good", "skip", "bad", "also-good"],
        recomputeProject: async ({ projectId }) => {
            if (projectId === "skip") return "skipped" as const;
            if (projectId === "bad") throw new Error("fixture failure");
            return "recomputed" as const;
        },
    }, { asOf: new Date("2026-08-26T18:37:00.000Z") });

    assert.deepEqual(result, { selected: 4, recomputed: 2, skipped: 1, failed: 1, hasMore: false });
});
