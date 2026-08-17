import assert from "node:assert/strict";
import test from "node:test";
import {
    drainReviewAlerts,
    EPISODE_RATE_CEILING,
    type ReviewAlertOutboxClient,
    type ReviewAlertSender,
} from "../src/lib/review-alert-outbox";

// Unified Money Register plan §4 "Delivery" (punch 3): the drainer must
// mirror payment-outbox.ts's real claim/fence/retry mechanics — an earlier
// prose version wrote FAILED + nextAttemptAt but only ever claimed PENDING,
// permanently stranding every failure. These tests exercise exactly that
// failure mode plus stale-claim reclaim, claimToken fencing, and the
// rate-ceiling batch overflow, all against an in-memory fake store (no DB).

// ── Fake store ─────────────────────────────────────────────────────────────

interface FakeIssue {
    targetType: string;
    targetKey: string;
    clearedAt: Date | null;
}

interface FakeEpisode {
    [key: string]: unknown;
    id: string;
    issueId: string;
    generation: number;
    reasonCodes: string;
    displayDetails: string | null;
    status: string;
    claimToken: string | null;
    claimedAt: Date | null;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: Date | null;
    sentAt: Date | null;
    chatMessageName: string | null;
    batchId: string | null;
    createdAt: Date;
}

interface FakeBatch {
    [key: string]: unknown;
    id: string;
    status: string;
    claimToken: string | null;
    claimedAt: Date | null;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: Date | null;
    sentAt: Date | null;
    chatMessageName: string | null;
    createdAt: Date;
}

function matchWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, cond]) => {
        if (key === "OR") {
            return (cond as Record<string, unknown>[]).some(sub => matchWhere(row, sub));
        }
        if (cond === null) return row[key] == null;
        if (cond && typeof cond === "object") {
            if ("lt" in cond) return row[key] instanceof Date && (row[key] as Date) < (cond as { lt: Date }).lt;
            if ("lte" in cond) return row[key] instanceof Date && (row[key] as Date) <= (cond as { lte: Date }).lte;
            if ("in" in cond) return (cond as { in: unknown[] }).in.includes(row[key]);
        }
        return row[key] === cond;
    });
}

/** Real Prisma's `{ increment: n }` update helper — the fake must resolve it
 * the same way (a plain `Object.assign` would store the literal `{increment}`
 * object into the field instead of bumping it). */
function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as Record<string, unknown>)) {
            row[key] = (Number(row[key]) || 0) + (value as { increment: number }).increment;
        } else {
            row[key] = value;
        }
    }
}

function createFakeClient(issuesSeed: Record<string, FakeIssue>) {
    const issues = new Map(Object.entries(issuesSeed));
    const episodes: FakeEpisode[] = [];
    const batches: FakeBatch[] = [];
    let batchSeq = 0;
    let onBeforeBatchMembersRead: (() => void) | null = null;
    // Finding 1: the drainer checks the rollout gate before doing anything.
    // Every existing test in this file exercises normal draining, so the
    // fake defaults to "complete" (gate already satisfied) — tests that
    // specifically exercise the gate override this via `setGateStatus`.
    let gateStatus: "pending" | "in-progress" | "complete" = "complete";
    let gateClaimedAt: Date | null = null;

    function withInclude<T extends { issueId?: string }>(row: T, include?: Record<string, unknown>) {
        if (include && "issue" in include && row.issueId) {
            return { ...row, issue: issues.get(row.issueId) ?? null };
        }
        return row;
    }

    const client: ReviewAlertOutboxClient = {
        reviewAlertEpisode: {
            async findMany(args) {
                if (onBeforeBatchMembersRead && "batchId" in args.where) {
                    onBeforeBatchMembersRead();
                    onBeforeBatchMembersRead = null;
                }
                const rows = episodes
                    .filter(e => matchWhere(e, args.where))
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                    .slice(0, args.take);
                return rows.map(r => withInclude(r, args.include));
            },
            async updateMany(args) {
                let count = 0;
                for (const row of episodes) {
                    if (matchWhere(row, args.where)) {
                        applyData(row, args.data);
                        count++;
                    }
                }
                return { count };
            },
            async findUnique(args) {
                const row = episodes.find(e => e.id === args.where.id);
                return row ?? null;
            },
            async create(args) {
                const data = args.data as Partial<FakeEpisode>;
                const row: FakeEpisode = {
                    id: `episode-${episodes.length + 1}`,
                    issueId: "",
                    generation: 1,
                    reasonCodes: "[]",
                    displayDetails: null,
                    status: "PENDING",
                    claimToken: null,
                    claimedAt: null,
                    attempts: 0,
                    lastError: null,
                    nextAttemptAt: null,
                    sentAt: null,
                    chatMessageName: null,
                    batchId: null,
                    createdAt: new Date(Date.now() + episodes.length),
                    ...data,
                };
                episodes.push(row);
                return row;
            },
        },
        reviewAlertBatch: {
            async findMany(args) {
                return batches
                    .filter(b => matchWhere(b, args.where))
                    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                    .slice(0, args.take);
            },
            async updateMany(args) {
                let count = 0;
                for (const row of batches) {
                    if (matchWhere(row, args.where)) {
                        applyData(row, args.data);
                        count++;
                    }
                }
                return { count };
            },
            async findUnique(args) {
                return batches.find(b => b.id === args.where.id) ?? null;
            },
            async create() {
                const row: FakeBatch = {
                    id: `batch-${++batchSeq}`,
                    status: "PENDING",
                    claimToken: null,
                    claimedAt: null,
                    attempts: 0,
                    lastError: null,
                    nextAttemptAt: null,
                    sentAt: null,
                    chatMessageName: null,
                    createdAt: new Date(),
                };
                batches.push(row);
                return row;
            },
        },
        rolloutGate: {
            async upsert() {
                return { key: "review-alerts-baseline", status: gateStatus, claimToken: null, claimedAt: gateClaimedAt };
            },
            async updateMany() {
                return { count: 0 };
            },
        },
    };

    return {
        client,
        issues,
        episodes,
        batches,
        setGateStatus(status: "pending" | "in-progress" | "complete", claimedAt: Date | null = null) {
            gateStatus = status;
            gateClaimedAt = claimedAt;
        },
        addEpisode(partial: Partial<FakeEpisode> & { issueId: string }) {
            const row: FakeEpisode = {
                id: `episode-${episodes.length + 1}`,
                generation: 1,
                reasonCodes: "[]",
                displayDetails: null,
                status: "PENDING",
                claimToken: null,
                claimedAt: null,
                attempts: 0,
                lastError: null,
                nextAttemptAt: null,
                sentAt: null,
                chatMessageName: null,
                batchId: null,
                createdAt: new Date(Date.now() + episodes.length),
                ...partial,
            };
            episodes.push(row);
            return row;
        },
        setOnBeforeBatchMembersRead(fn: () => void) {
            onBeforeBatchMembersRead = fn;
        },
    };
}

function alwaysFailSender(): ReviewAlertSender {
    return {
        sendEpisode: async () => {
            throw new Error("simulated send failure");
        },
        sendBatch: async () => {
            throw new Error("simulated send failure");
        },
    };
}

function alwaysOkSender(): ReviewAlertSender {
    return {
        sendEpisode: async () => ({ chatMessageName: "spaces/x/messages/1" }),
        sendBatch: async () => ({ chatMessageName: "spaces/x/messages/batch" }),
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("retry as PENDING until MAX_ATTEMPTS, terminal FAILED only after the cap", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    store.addEpisode({ issueId: "issue-1" });

    let now = new Date("2026-01-01T00:00:00Z");
    const maxAttempts = 3;
    const retryBackoffMs = 1000;

    for (let i = 1; i <= maxAttempts; i++) {
        await drainReviewAlerts({
            client: store.client,
            sender: alwaysFailSender(),
            now,
            maxAttempts,
            retryBackoffMs,
            staleClaimMs: 5 * 60_000,
        });
        const row = store.episodes[0];
        assert.equal(row.attempts, i);
        if (i < maxAttempts) {
            assert.equal(row.status, "PENDING", `attempt ${i} of ${maxAttempts} must retry as PENDING, not FAILED`);
            assert.ok(row.nextAttemptAt);
        } else {
            assert.equal(row.status, "FAILED", "only the cap-reaching attempt is terminal");
        }
        // Advance past the retry backoff so the next run's due-retry predicate picks it up.
        now = new Date(now.getTime() + retryBackoffMs + 1);
    }

    // One more run after FAILED must not re-claim it — it's terminal.
    const finalRun = await drainReviewAlerts({ client: store.client, sender: alwaysFailSender(), now });
    assert.equal(finalRun.episodes.processed + finalRun.episodes.retried + finalRun.episodes.failed, 0);
});

test("a crashed worker's stale CLAIMED episode is reclaimed and delivered", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    const staleClaimedAt = new Date("2026-01-01T00:00:00Z");
    store.addEpisode({ issueId: "issue-1", status: "CLAIMED", claimedAt: staleClaimedAt, claimToken: "dead-worker-token" });

    const now = new Date(staleClaimedAt.getTime() + 10 * 60_000); // 10 minutes later
    const result = await drainReviewAlerts({
        client: store.client,
        sender: alwaysOkSender(),
        now,
        staleClaimMs: 5 * 60_000, // stale after 5 minutes — this row is 10 minutes stale
    });

    assert.equal(result.episodes.processed, 1);
    assert.equal(store.episodes[0].status, "SENT");
});

test("a fresh CLAIMED episode (not stale) is left alone", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    const now = new Date("2026-01-01T00:10:00Z");
    store.addEpisode({ issueId: "issue-1", status: "CLAIMED", claimedAt: new Date(now.getTime() - 30_000), claimToken: "active-worker" });

    const result = await drainReviewAlerts({ client: store.client, sender: alwaysOkSender(), now, staleClaimMs: 5 * 60_000 });

    assert.equal(result.episodes.processed, 0);
    assert.equal(store.episodes[0].status, "CLAIMED");
});

test("completion is fenced by claimToken — a reclaim mid-delivery is not overwritten by the original worker's completion", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    store.addEpisode({ issueId: "issue-1" });

    // A sender whose delivery, as a side effect, simulates a DIFFERENT
    // drainer having reclaimed this exact row (a new claimToken written)
    // before our own completion write runs.
    const sender: ReviewAlertSender = {
        sendEpisode: async () => {
            store.episodes[0].claimToken = "someone-elses-token";
            store.episodes[0].status = "CLAIMED";
            return { chatMessageName: "spaces/x/messages/1" };
        },
        sendBatch: async () => ({ chatMessageName: "" }),
    };

    const result = await drainReviewAlerts({ client: store.client, sender, now: new Date("2026-01-01") });

    // Our completion write matched on the OLD claimToken and must no-op.
    assert.equal(result.episodes.processed, 0);
    assert.equal(store.episodes[0].status, "CLAIMED", "the reclaiming worker's state must not be clobbered");
    assert.equal(store.episodes[0].claimToken, "someone-elses-token");
});

test("rate ceiling: overflow beyond EPISODE_RATE_CEILING moves to one batch, drained through the same path", async () => {
    const issuesSeed: Record<string, FakeIssue> = {};
    const total = EPISODE_RATE_CEILING + 2;
    for (let i = 1; i <= total; i++) {
        issuesSeed[`issue-${i}`] = { targetType: "qbo-purchase", targetKey: `p-${i}`, clearedAt: null };
    }
    const store = createFakeClient(issuesSeed);
    for (let i = 1; i <= total; i++) {
        store.addEpisode({ issueId: `issue-${i}` });
    }

    const result = await drainReviewAlerts({ client: store.client, sender: alwaysOkSender(), now: new Date("2026-01-01") });

    // Finding 4: the summary batch card itself counts against the shared
    // 10-send budget — 9 individual + 1 summary = 10, not 10 + 1 = 11. With
    // 12 due episodes, 3 overflow into the batch, not 2.
    assert.equal(result.batchedOverflow, 3);
    assert.equal(result.episodes.processed, EPISODE_RATE_CEILING - 1);
    const sentIndividually = store.episodes.filter(e => e.status === "SENT" && !e.batchId).length;
    assert.equal(sentIndividually, EPISODE_RATE_CEILING - 1);
    const batched = store.episodes.filter(e => e.batchId !== null);
    assert.equal(batched.length, 3);
    assert.equal(store.batches.length, 1);
    assert.equal(store.batches[0].status, "SENT");
    const totalNetworkSends = result.episodes.processed + result.episodes.retried + result.episodes.failed +
        result.batch.processed + result.batch.retried + result.batch.failed;
    assert.ok(totalNetworkSends <= EPISODE_RATE_CEILING, `total sends ${totalNetworkSends} must not exceed the ${EPISODE_RATE_CEILING}-card ceiling`);
});

test("a member cancelled between batching and payload build is excluded from the batch send", async () => {
    const issuesSeed: Record<string, FakeIssue> = {};
    const total = EPISODE_RATE_CEILING + 2;
    for (let i = 1; i <= total; i++) {
        issuesSeed[`issue-${i}`] = { targetType: "qbo-purchase", targetKey: `p-${i}`, clearedAt: null };
    }
    const store = createFakeClient(issuesSeed);
    for (let i = 1; i <= total; i++) {
        store.addEpisode({ issueId: `issue-${i}` });
    }

    let sentPayloadIds: string[] = [];
    const sender: ReviewAlertSender = {
        sendEpisode: async () => ({ chatMessageName: "spaces/x/messages/1" }),
        sendBatch: async payload => {
            sentPayloadIds = payload.episodes.map(e => e.issueId);
            return { chatMessageName: "spaces/x/messages/batch" };
        },
    };

    // Simulate the lifecycle cancelling ONE of the three overflow members
    // (finding 4: 12 due episodes → 9 individual + 3 overflow) — via
    // review-alert-lifecycle.ts's clear/supersede branches, a batched
    // episode flips to CANCELLED/SUPERSEDED — right as the batch payload is
    // about to be built (the freshest possible read), before `sendBatch` runs.
    store.setOnBeforeBatchMembersRead(() => {
        const overflowMember = store.episodes.find(e => e.batchId !== null);
        if (overflowMember) overflowMember.status = "CANCELLED";
    });

    await drainReviewAlerts({ client: store.client, sender, now: new Date("2026-01-01") });

    assert.equal(sentPayloadIds.length, 2, "the cancelled member must not appear in the sent payload");
});

// ── Finding 1: the drainer must independently enforce the rollout gate ─────

test("drain is blocked entirely while the rollout gate is not complete", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    store.addEpisode({ issueId: "issue-1" });
    store.setGateStatus("in-progress", new Date("2026-01-01T00:09:00Z")); // fresh claim, not stale

    const result = await drainReviewAlerts({
        client: store.client,
        sender: alwaysOkSender(),
        now: new Date("2026-01-01T00:10:00Z"),
    });

    assert.equal(result.blockedByRollout, true);
    assert.equal(result.episodes.processed, 0);
    assert.equal(store.episodes[0].status, "PENDING", "nothing was claimed or sent while the gate is incomplete");
});

test("drain proceeds normally once the rollout gate is complete", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    store.addEpisode({ issueId: "issue-1" });
    store.setGateStatus("complete");

    const result = await drainReviewAlerts({ client: store.client, sender: alwaysOkSender(), now: new Date("2026-01-01") });

    assert.equal(result.blockedByRollout, false);
    assert.equal(result.episodes.processed, 1);
});

// ── Finding 2: clear/supersede must fence CLAIMED completion ───────────────

test("a CANCELLED episode cannot be resurrected by a late failure completion", async () => {
    const store = createFakeClient({ "issue-1": { targetType: "qbo-purchase", targetKey: "p-1", clearedAt: null } });
    store.addEpisode({ issueId: "issue-1" });

    // Sender simulates the lifecycle clearing the issue (which cancels this
    // exact episode) WHILE the send is in flight — review-alert-lifecycle.ts's
    // clear/supersede branches only ever change `status`, never rotate
    // `claimToken`. The send itself then fails.
    const sender: ReviewAlertSender = {
        sendEpisode: async () => {
            store.episodes[0].status = "CANCELLED";
            throw new Error("simulated send failure after the cancel landed");
        },
        sendBatch: async () => ({ chatMessageName: "" }),
    };

    await drainReviewAlerts({ client: store.client, sender, now: new Date("2026-01-01") });

    assert.equal(
        store.episodes[0].status,
        "CANCELLED",
        "the failure completion must NOT rewrite CANCELLED back to PENDING and retry a stale alert",
    );
});

// ── Finding 3: terminal batch failure must not strand members ──────────────

test("a batch that terminally FAILS requeues its members instead of stranding them at BATCHED forever", async () => {
    const issuesSeed: Record<string, FakeIssue> = {};
    const total = EPISODE_RATE_CEILING + 2;
    for (let i = 1; i <= total; i++) {
        issuesSeed[`issue-${i}`] = { targetType: "qbo-purchase", targetKey: `p-${i}`, clearedAt: null };
    }
    const store = createFakeClient(issuesSeed);
    for (let i = 1; i <= total; i++) {
        store.addEpisode({ issueId: `issue-${i}` });
    }

    // Individual episodes send fine; the fresh overflow batch's send always
    // fails, and with maxAttempts=1 goes terminal FAILED on its very first
    // attempt.
    const sender: ReviewAlertSender = {
        sendEpisode: async () => ({ chatMessageName: "spaces/x/messages/1" }),
        sendBatch: async () => {
            throw new Error("simulated batch send failure");
        },
    };

    const result = await drainReviewAlerts({
        client: store.client,
        sender,
        now: new Date("2026-01-01"),
        maxAttempts: 1,
    });

    assert.equal(store.batches[0].status, "FAILED");
    assert.equal(result.batch.failed, 1);
    const strandedAtBatched = store.episodes.filter(e => e.status === "BATCHED");
    assert.equal(strandedAtBatched.length, 0, "no member may be left stuck at BATCHED under a terminally-failed batch");
    const requeued = store.episodes.filter(e => e.status === "PENDING" && e.batchId === null);
    assert.equal(requeued.length, 3, "the batch's members are requeued as PENDING with batchId cleared");
});

// ── Finding 4: one shared 10-card send budget per run ───────────────────────

test("old-batch draining shares the same per-run budget as individual episodes, never adding to it", async () => {
    const issuesSeed: Record<string, FakeIssue> = {};
    for (let i = 1; i <= 5; i++) {
        issuesSeed[`issue-${i}`] = { targetType: "qbo-purchase", targetKey: `p-${i}`, clearedAt: null };
    }
    const store = createFakeClient(issuesSeed);
    for (let i = 1; i <= 5; i++) {
        store.addEpisode({ issueId: `issue-${i}` }); // 5 due individual episodes — no overflow this run
    }
    // 8 pre-existing OLD PENDING batches, left over from an earlier,
    // budget-exhausted run.
    for (let i = 0; i < 8; i++) {
        store.batches.push({
            id: `old-batch-${i}`,
            status: "PENDING",
            claimToken: null,
            claimedAt: null,
            attempts: 0,
            lastError: null,
            nextAttemptAt: null,
            sentAt: null,
            chatMessageName: null,
            createdAt: new Date(Date.now() - 1000 + i),
        });
    }

    const result = await drainReviewAlerts({ client: store.client, sender: alwaysOkSender(), now: new Date("2026-01-01") });

    assert.equal(result.episodes.processed, 5);
    const totalNetworkSends =
        result.episodes.processed +
        result.episodes.retried +
        result.episodes.failed +
        result.batch.processed +
        result.batch.retried +
        result.batch.failed;
    assert.ok(
        totalNetworkSends <= EPISODE_RATE_CEILING,
        `total sends ${totalNetworkSends} must not exceed the ${EPISODE_RATE_CEILING}-card ceiling`,
    );
    const sentOldBatches = store.batches.filter(b => b.status === "SENT").length;
    assert.equal(sentOldBatches, 5, "only 5 of the 8 old batches get a slot this run — the shared budget, not a separate one");
});
