import assert from "node:assert/strict";
import test from "node:test";
import {
    ensureRolloutBaseline,
    readRolloutGateState,
    rolloutStateFromRow,
    type RolloutGateClient,
    type RolloutGateRow,
    type ReviewTarget,
} from "../src/lib/review-alert-rollout";
import type { ReviewIssueLifecycleClient, ReviewIssueRow } from "../src/lib/review-alert-lifecycle";

// Unified Money Register plan §4 "Rollout" (Codex finding 1): the gate must
// be an actual GATE, not an advisory lease — a caller that doesn't hold
// "complete" must never be treated as "safe to evaluate/deliver".

function createFakeGateClient(initial: Partial<RolloutGateRow> = {}) {
    let row: RolloutGateRow = {
        key: "review-alerts-baseline",
        status: "pending",
        claimToken: null,
        claimedAt: null,
        ...initial,
    };
    const client: RolloutGateClient = {
        rolloutGate: {
            async upsert() {
                return row;
            },
            async updateMany(args) {
                const where = args.where as Record<string, unknown>;
                if (where.key !== row.key) return { count: 0 };
                if (typeof where.status === "string" && row.status !== where.status) return { count: 0 };
                if ("claimToken" in where && row.claimToken !== where.claimToken) return { count: 0 };
                if ("OR" in where) {
                    const clauses = where.OR as Array<Record<string, unknown>>;
                    const anyMatch = clauses.some(clause => {
                        if (clause.status !== row.status) return false;
                        if ("claimedAt" in clause) {
                            const cond = clause.claimedAt as { lt?: Date };
                            if (!row.claimedAt || !cond.lt || !(row.claimedAt < cond.lt)) return false;
                        }
                        return true;
                    });
                    if (!anyMatch) return { count: 0 };
                }
                row = { ...row, ...(args.data as Partial<RolloutGateRow>) } as RolloutGateRow;
                return { count: 1 };
            },
        },
    };
    return { client, getRow: () => row };
}

function createFakeLifecycleClient() {
    const issues = new Map<string, ReviewIssueRow & Record<string, unknown>>();
    let seq = 0;
    const client: ReviewIssueLifecycleClient = {
        reviewIssue: {
            async findUnique(args) {
                if ("id" in args.where) return issues.get(args.where.id) ?? null;
                const { targetType, targetKey } = args.where.targetType_targetKey;
                for (const row of issues.values()) {
                    if (row.targetType === targetType && row.targetKey === targetKey) return row;
                }
                return null;
            },
            async create(args) {
                const id = `issue-${++seq}`;
                const row = { id, clearedAt: null, acknowledgedAt: null, displayDetails: null, ...args.data } as ReviewIssueRow &
                    Record<string, unknown>;
                issues.set(id, row);
                return row;
            },
            async updateMany(args) {
                const row = issues.get(args.where.id as string);
                if (!row || row.version !== args.where.version) return { count: 0 };
                Object.assign(row, args.data);
                return { count: 1 };
            },
        },
        reviewAlertEpisode: {
            async create() {
                return {};
            },
            async updateMany() {
                return { count: 0 };
            },
        },
        async $transaction(fn) {
            return fn(client);
        },
    };
    return { client, issues };
}

test("rolloutStateFromRow: complete stays complete regardless of claimedAt", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    assert.equal(rolloutStateFromRow({ status: "complete", claimedAt: null }, now), "complete");
});

test("rolloutStateFromRow: pending is ready", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    assert.equal(rolloutStateFromRow({ status: "pending", claimedAt: null }, now), "ready");
});

test("rolloutStateFromRow: fresh in-progress claim stays in-progress", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    assert.equal(rolloutStateFromRow({ status: "in-progress", claimedAt: new Date("2026-01-01T00:09:00Z") }, now), "in-progress");
});

test("rolloutStateFromRow: STALE in-progress claim (crashed sweep) is reclaimable — reported as ready", () => {
    const now = new Date("2026-01-01T00:20:00Z"); // 11 minutes after the claim — stale threshold is 10
    assert.equal(rolloutStateFromRow({ status: "in-progress", claimedAt: new Date("2026-01-01T00:09:00Z") }, now), "ready");
});

test("readRolloutGateState reflects the stored row without side effects", async () => {
    const { client } = createFakeGateClient({ status: "complete" });
    const state = await readRolloutGateState(client, new Date("2026-01-01"));
    assert.equal(state, "complete");
});

test("ensureRolloutBaseline: first call runs the full sweep and completes the gate", async () => {
    const { client } = createFakeGateClient({ status: "pending" });
    const { client: lifecycleClient } = createFakeLifecycleClient();
    const targets: ReviewTarget[] = [{ targetType: "qbo-purchase", targetKey: "p-1", reasonCodes: ["NO_RECEIPT"], displayDetails: null }];

    const result = await ensureRolloutBaseline({
        client,
        lifecycleClient,
        computeReviewTargets: async () => targets,
        now: () => new Date("2026-01-01"),
    });

    assert.equal(result.state, "complete");
    assert.equal(result.ranBaseline, true);
    assert.equal(result.baselineCount, 1);
    assert.equal(result.catchUpCount, 1);
    assert.deepEqual(result.catchUpTargets, targets);
});

test("ensureRolloutBaseline: once complete, a later call is a cheap no-op — state complete, ranBaseline false", async () => {
    const { client } = createFakeGateClient({ status: "complete" });
    let computeCalls = 0;

    const result = await ensureRolloutBaseline({
        client,
        computeReviewTargets: async () => {
            computeCalls++;
            return [];
        },
        now: () => new Date("2026-01-01"),
    });

    assert.equal(result.state, "complete");
    assert.equal(result.ranBaseline, false);
    assert.equal(computeCalls, 0, "an already-complete gate must not re-sweep");
});

test("ensureRolloutBaseline: a caller that loses the claim reports in-progress, never runs the sweep", async () => {
    // Row is "in-progress" with a FRESH claimedAt — another worker holds it.
    const { client } = createFakeGateClient({ status: "in-progress", claimedAt: new Date("2026-01-01T00:09:59Z") });
    let computeCalls = 0;

    const result = await ensureRolloutBaseline({
        client,
        computeReviewTargets: async () => {
            computeCalls++;
            return [];
        },
        now: () => new Date("2026-01-01T00:10:00Z"),
    });

    assert.equal(result.state, "in-progress");
    assert.equal(result.ranBaseline, false);
    assert.equal(computeCalls, 0, "a lost claim must never touch the target set — this is the finding-1 bypass bug");
});

test("ensureRolloutBaseline: a crashed mid-baseline (stale claim) is reclaimed and finished", async () => {
    const { client } = createFakeGateClient({ status: "in-progress", claimedAt: new Date("2026-01-01T00:00:00Z") });
    const { client: lifecycleClient } = createFakeLifecycleClient();

    const result = await ensureRolloutBaseline({
        client,
        lifecycleClient,
        computeReviewTargets: async () => [],
        now: () => new Date("2026-01-01T00:15:00Z"), // 15 minutes later — past the 10-minute stale window
    });

    assert.equal(result.state, "complete");
    assert.equal(result.ranBaseline, true);
});
