import assert from "node:assert/strict";
import test from "node:test";
import {
    decideLifecycle,
    evaluateReviewIssue,
    markReviewed,
    type ReviewIssueLifecycleClient,
    type ReviewIssueRow,
    type ReviewIssueState,
} from "../src/lib/review-alert-lifecycle";
import { hashReasonCodes, type ReasonCode } from "../src/lib/review-alert-reasons";

// Unified Money Register plan §4 "Lifecycle" (punch 1): an ORDERED decision
// tree, short-circuiting on first match, exhaustively tested here — Codex
// blocked twice on an earlier version that was neither total nor race-safe.

function state(overrides: Partial<ReviewIssueState> = {}): ReviewIssueState {
    return {
        id: "issue-1",
        version: 1,
        reasonHash: hashReasonCodes(["NO_RECEIPT"]),
        acknowledgedCodes: [],
        clearedAt: null,
        currentGeneration: 1,
        displayDetails: null,
        ...overrides,
    };
}

// ── Step 1: reason set empty ──────────────────────────────────────────────────

test("step 1: empty set + no existing issue → noop (nothing to create or clear)", () => {
    const decision = decideLifecycle(null, []);
    assert.equal(decision.step, 1);
    assert.equal(decision.action, "noop");
});

test("step 1: empty set + open existing issue → clear", () => {
    const decision = decideLifecycle(state({ clearedAt: null }), []);
    assert.equal(decision.step, 1);
    assert.equal(decision.action, "clear");
});

test("step 1: empty set + already-cleared issue → noop, not a duplicate clear", () => {
    const decision = decideLifecycle(state({ clearedAt: new Date("2026-01-01") }), []);
    assert.equal(decision.step, 1);
    assert.equal(decision.action, "noop");
});

test("step 1 takes priority over every other step regardless of ack/hash state", () => {
    // Fully acknowledged AND hash would otherwise match "touch" — set-empty still wins.
    const existing = state({ acknowledgedCodes: ["NO_RECEIPT"], reasonHash: hashReasonCodes(["NO_RECEIPT"]) });
    const decision = decideLifecycle(existing, []);
    assert.equal(decision.step, 1);
});

// ── Step 2: no issue exists ────────────────────────────────────────────────────

test("step 2: non-empty set + no existing issue → create at generation 1", () => {
    const decision = decideLifecycle(null, ["NO_RECEIPT"]);
    assert.equal(decision.step, 2);
    assert.equal(decision.action, "create");
    assert.equal(decision.openGeneration, 1);
});

// ── Step 3: cleared issue, set non-empty → reopen ─────────────────────────────

test("step 3: cleared issue regresses → reopen at currentGeneration + 1", () => {
    const existing = state({ clearedAt: new Date("2026-01-01"), currentGeneration: 3 });
    const decision = decideLifecycle(existing, ["NO_JOB_COST"]);
    assert.equal(decision.step, 3);
    assert.equal(decision.action, "reopen");
    assert.equal(decision.openGeneration, 4);
});

test("step 3 takes priority over step 4 even if the new codes happen to be a subset of stale ack data", () => {
    // Ack fields are supposed to be empty after a clear, but the ordered tree
    // must not depend on that invariant holding — a cleared issue always reopens.
    const existing = state({
        clearedAt: new Date("2026-01-01"),
        acknowledgedCodes: ["NO_RECEIPT"],
        currentGeneration: 1,
    });
    const decision = decideLifecycle(existing, ["NO_RECEIPT"]);
    assert.equal(decision.step, 3);
    assert.equal(decision.action, "reopen");
});

// ── Step 4: acknowledged superset → suppress ──────────────────────────────────

test("step 4: acknowledged codes are an exact match → suppress", () => {
    const existing = state({ acknowledgedCodes: ["NO_RECEIPT"], reasonHash: "stale-hash" });
    const decision = decideLifecycle(existing, ["NO_RECEIPT"]);
    assert.equal(decision.step, 4);
    assert.equal(decision.action, "suppress");
});

test("per-code ack (punch 9): removing one acknowledged reason while the rest remain acked must NOT re-alert", () => {
    const existing = state({ acknowledgedCodes: ["NO_RECEIPT", "NO_JOB_COST"], reasonHash: "stale-hash" });
    // NO_JOB_COST got fixed; NO_RECEIPT (already acknowledged) remains.
    const decision = decideLifecycle(existing, ["NO_RECEIPT"]);
    assert.equal(decision.step, 4);
    assert.equal(decision.action, "suppress");
});

test("per-code ack: a genuinely NEW code not in the acknowledged set must fall through, never suppressed", () => {
    const existing = state({ acknowledgedCodes: ["NO_RECEIPT"], reasonHash: hashReasonCodes(["NO_RECEIPT"]) });
    const decision = decideLifecycle(existing, ["NO_RECEIPT", "AMOUNT_MISMATCH"]);
    assert.notEqual(decision.action, "suppress");
    assert.equal(decision.step, 6); // hash changed → supersede
});

test("step 4 takes priority over step 5/6 even when the hash also changed", () => {
    const existing = state({ acknowledgedCodes: ["NO_RECEIPT", "NO_JOB_COST"], reasonHash: "some-other-hash" });
    const decision = decideLifecycle(existing, ["NO_RECEIPT"]);
    assert.equal(decision.step, 4);
});

// ── Step 5: same hash → touch only ────────────────────────────────────────────

test("step 5: identical reason set as currently stored → touch, no new episode", () => {
    const codes: ReasonCode[] = ["NO_RECEIPT", "NO_JOB_COST"];
    const existing = state({ reasonHash: hashReasonCodes(codes), acknowledgedCodes: [] });
    const decision = decideLifecycle(existing, codes);
    assert.equal(decision.step, 5);
    assert.equal(decision.action, "touch");
});

test("step 5 is order-independent — codes supplied in a different order still hash the same", () => {
    const existing = state({ reasonHash: hashReasonCodes(["NO_JOB_COST", "NO_RECEIPT"]) });
    const decision = decideLifecycle(existing, ["NO_RECEIPT", "NO_JOB_COST"]);
    assert.equal(decision.action, "touch");
});

// ── Step 6: changed hash → supersede ──────────────────────────────────────────

test("step 6: hash changed, not fully acknowledged → supersede, generation + 1", () => {
    const existing = state({ reasonHash: "old-hash", currentGeneration: 2, acknowledgedCodes: [] });
    const decision = decideLifecycle(existing, ["AMOUNT_MISMATCH"]);
    assert.equal(decision.step, 6);
    assert.equal(decision.action, "supersede");
    assert.equal(decision.openGeneration, 3);
});

// ── decideLifecycle is total: every non-empty-set branch matches exactly one step ──

test("decideLifecycle is total across the full existing/ack/hash state space", () => {
    const codes: ReasonCode[] = ["NO_RECEIPT"];
    const matchingHash = hashReasonCodes(codes);
    const scenarios: Array<{ existing: ReviewIssueState | null; label: string }> = [
        { existing: null, label: "no issue" },
        { existing: state({ clearedAt: new Date(), reasonHash: "x" }), label: "cleared" },
        { existing: state({ acknowledgedCodes: codes, reasonHash: "x" }), label: "acked" },
        { existing: state({ reasonHash: matchingHash, acknowledgedCodes: [] }), label: "same hash" },
        { existing: state({ reasonHash: "different", acknowledgedCodes: [] }), label: "different hash" },
    ];
    for (const scenario of scenarios) {
        const decision = decideLifecycle(scenario.existing, codes);
        assert.ok([1, 2, 3, 4, 5, 6].includes(decision.step), scenario.label);
    }
});

// ── Prisma-backed evaluateReviewIssue, against an in-memory fake client ─────────

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as Record<string, unknown>)) {
            row[key] = (Number(row[key]) || 0) + (value as { increment: number }).increment;
        } else {
            row[key] = value;
        }
    }
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && !(value instanceof Date) && "in" in (value as Record<string, unknown>)) {
            return (value as { in: unknown[] }).in.includes(row[key]);
        }
        if (value && typeof value === "object" && !(value instanceof Date) && "lt" in (value as Record<string, unknown>)) {
            return (row[key] as Date) < (value as { lt: Date }).lt;
        }
        return row[key] === value;
    });
}

interface FakeEpisode extends Record<string, unknown> {
    id: string;
    issueId: string;
    generation: number;
    status: string;
}

function createFakeClient() {
    const issues = new Map<string, ReviewIssueRow & Record<string, unknown>>();
    const episodes: FakeEpisode[] = [];
    let issueSeq = 0;
    let episodeSeq = 0;
    /** When set, the NEXT reviewIssue.updateMany call fails once (simulates a
     * concurrent writer winning the race), then behaves normally after. */
    let forceConflictOnce = false;
    /** When set, the NEXT reviewIssue.create call throws a P2002-shaped error
     * instead of creating — AND inserts a row itself first, simulating a
     * concurrent evaluator's create having already landed under the unique
     * constraint (finding 6a). */
    let forceCreateConflictOnce = false;

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
                const id = `issue-${++issueSeq}`;
                // Real Prisma defaults an omitted nullable column to SQL NULL
                // (surfaced as `null`, not `undefined`) — match that here so
                // `clearedAt === null` reads correctly on a freshly created
                // row, same as it would against a live database.
                const row = {
                    id,
                    clearedAt: null,
                    acknowledgedAt: null,
                    displayDetails: null,
                    ...args.data,
                } as ReviewIssueRow & Record<string, unknown>;
                if (forceCreateConflictOnce) {
                    forceCreateConflictOnce = false;
                    // The "concurrent winner"'s full transaction lands anyway —
                    // both the issue row AND its generation-1 episode, same as
                    // a real create() would have committed.
                    issues.set(id, row);
                    episodes.push({
                        id: `episode-${++episodeSeq}`,
                        issueId: id,
                        generation: (row.currentGeneration as number) ?? 1,
                        status: "PENDING",
                    });
                    const err = new Error("Unique constraint failed on the fields: (`targetType`,`targetKey`)") as Error & {
                        code?: string;
                    };
                    err.code = "P2002";
                    throw err;
                }
                issues.set(id, row);
                return row;
            },
            async updateMany(args) {
                if (forceConflictOnce) {
                    forceConflictOnce = false;
                    return { count: 0 };
                }
                const row = issues.get(args.where.id as string);
                if (!row || !matchesWhere(row, args.where)) return { count: 0 };
                applyData(row, args.data);
                return { count: 1 };
            },
        },
        reviewAlertEpisode: {
            async create(args) {
                const id = `episode-${++episodeSeq}`;
                const row = { id, status: "PENDING", ...args.data } as FakeEpisode;
                episodes.push(row);
                return row;
            },
            async updateMany(args) {
                let count = 0;
                for (const row of episodes) {
                    if (matchesWhere(row, args.where)) {
                        applyData(row, args.data);
                        count++;
                    }
                }
                return { count };
            },
        },
        async $transaction(fn) {
            return fn(client);
        },
    };

    return {
        client,
        issues,
        episodes,
        forceNextIssueUpdateConflict: () => {
            forceConflictOnce = true;
        },
        forceNextIssueCreateConflict: () => {
            forceCreateConflictOnce = true;
        },
    };
}

test("evaluateReviewIssue: create writes a PENDING generation-1 episode", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], { amountCents: -100 }, { client });

    assert.equal(issues.size, 1);
    const issue = [...issues.values()][0];
    assert.equal(issue.targetKey, "p-1");
    assert.equal(issue.currentGeneration, 1);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].generation, 1);
    assert.equal(episodes[0].status, "PENDING");
});

test("evaluateReviewIssue: rollout baseline mode opens a SUPPRESSED episode instead of PENDING", async () => {
    const { client, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, {
        client,
        episodeStatus: "SUPPRESSED",
    });
    assert.equal(episodes[0].status, "SUPPRESSED");
});

test("evaluateReviewIssue: clearing cancels open episodes and resets ack fields", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    const issueId = [...issues.values()][0].id;

    await evaluateReviewIssue("qbo-purchase", "p-1", [], null, { client });

    const issue = issues.get(issueId)!;
    assert.ok(issue.clearedAt);
    assert.equal(issue.acknowledgedCodes, "[]");
    assert.equal(episodes.find(e => e.issueId === issueId)?.status, "CANCELLED");
});

test("evaluateReviewIssue: clear→regression reopens at generation + 1 with a fresh PENDING episode", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    await evaluateReviewIssue("qbo-purchase", "p-1", [], null, { client }); // clear
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_JOB_COST"], null, { client }); // regression

    const issue = [...issues.values()][0];
    assert.equal(issue.clearedAt, null);
    assert.equal(issue.currentGeneration, 2);
    const gen2 = episodes.find(e => e.issueId === issue.id && e.generation === 2);
    assert.ok(gen2);
    assert.equal(gen2!.status, "PENDING");
});

test("evaluateReviewIssue: changed reason set supersedes the open episode and opens a new generation", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    await evaluateReviewIssue("qbo-purchase", "p-1", ["AMOUNT_MISMATCH"], null, { client });

    const issue = [...issues.values()][0];
    assert.equal(issue.currentGeneration, 2);
    const gen1 = episodes.find(e => e.generation === 1)!;
    const gen2 = episodes.find(e => e.generation === 2)!;
    assert.equal(gen1.status, "SUPERSEDED");
    assert.equal(gen2.status, "PENDING");
});

test("evaluateReviewIssue: an already-SENT episode is left alone by a supersede (punch 2)", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    episodes[0].status = "SENT"; // simulate the drainer having delivered it already

    await evaluateReviewIssue("qbo-purchase", "p-1", ["AMOUNT_MISMATCH"], null, { client });

    const gen1 = episodes.find(e => e.generation === 1)!;
    const gen2 = episodes.find(e => e.generation === 2)!;
    assert.equal(gen1.status, "SENT", "a delivered card is never retroactively superseded");
    assert.equal(gen2.status, "PENDING", "the new generation still opens regardless");
});

test("evaluateReviewIssue: same reason set on re-evaluation touches nothing (no new episode, version unchanged)", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    const versionBefore = [...issues.values()][0].version;

    const result = await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });

    assert.equal(result.decision.step, 5);
    assert.equal(episodes.length, 1);
    assert.equal([...issues.values()][0].version, versionBefore);
});

test("evaluateReviewIssue: a version conflict retries the WHOLE evaluation, not just the write", async () => {
    const { client, issues, forceNextIssueUpdateConflict } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    forceNextIssueUpdateConflict();

    // Would otherwise be a "supersede" updateMany that fails once, forcing a
    // re-read + re-decide before it succeeds on retry.
    const result = await evaluateReviewIssue("qbo-purchase", "p-1", ["AMOUNT_MISMATCH"], null, { client });

    assert.equal(result.applied, true);
    const issue = [...issues.values()][0];
    assert.equal(issue.currentGeneration, 2);
});

test("evaluateReviewIssue: mark-reviewed suppression survives one acknowledged code being removed, but a new code re-alerts", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT", "NO_JOB_COST"], null, { client });
    const issue = [...issues.values()][0];

    const ack = await markReviewed({ id: issue.id, version: issue.version, reasonHash: issue.reasonHash }, client);
    assert.deepEqual(ack, { ok: true });

    // NO_JOB_COST resolved; NO_RECEIPT (acknowledged) remains — must suppress.
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    assert.equal(episodes.length, 1, "still no new episode — the remaining code was already acknowledged");

    // A genuinely new code appears alongside the acknowledged one — must alert.
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT", "AMOUNT_MISMATCH"], null, { client });
    assert.equal(episodes.length, 2, "a new, unacknowledged code must re-alert");
});

test("markReviewed rejects a stale request by reasonHash, cannot repopulate ack fields after a clear", async () => {
    const { client, issues } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    const issue = [...issues.values()][0];
    const staleVersion = issue.version;
    const staleHash = issue.reasonHash;

    // The issue clears server-side (e.g. the purchase got fixed) between the
    // client loading the issue and submitting "mark reviewed".
    await evaluateReviewIssue("qbo-purchase", "p-1", [], null, { client });

    const result = await markReviewed({ id: issue.id, version: staleVersion, reasonHash: staleHash }, client);
    assert.deepEqual(result, { ok: false, reason: "conflict" });
    assert.equal(issues.get(issue.id)!.acknowledgedCodes, "[]", "ack fields were not repopulated");
});

test("markReviewed returns not-found for an unknown id", async () => {
    const { client } = createFakeClient();
    const result = await markReviewed({ id: "does-not-exist", version: 1, reasonHash: "x" }, client);
    assert.deepEqual(result, { ok: false, reason: "not-found" });
});

// ── Finding 6: optimistic concurrency incomplete ────────────────────────────

test("evaluateReviewIssue: a concurrent 'no issue' create (P2002) is retried, not thrown", async () => {
    const { client, issues, episodes, forceNextIssueCreateConflict } = createFakeClient();
    forceNextIssueCreateConflict();

    // Two evaluators both see "no issue exists" for the same target and both
    // decide "create". The one whose write actually lands first (simulated
    // here) wins under the DB's real unique constraint; the loser must retry
    // the WHOLE evaluation rather than blow up.
    const result = await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });

    assert.equal(issues.size, 1, "no duplicate issue row from the retry");
    // The "concurrent winner" row was created with the SAME data this call
    // was about to write, so on re-read it has the identical reasonHash —
    // the retry routes through step 5 (touch), not step 2 (create) again.
    assert.equal(result.decision.step, 5);
    assert.equal(episodes.length, 1, "exactly one episode — from the simulated winner's create, not a duplicate");
});

test("evaluateReviewIssue: a version-conflict retry recomputes codes from fresh source data, not the stale snapshot", async () => {
    const { client, issues, forceNextIssueUpdateConflict } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    forceNextIssueUpdateConflict();

    // Caller's ORIGINAL snapshot says AMOUNT_MISMATCH — stale. Between this
    // call's read and its write, a concurrent evaluator committed a REAL
    // clear (fresher QBO data said the purchase now passes). recomputeCodes
    // must be consulted on the retry so the stale AMOUNT_MISMATCH is never
    // applied on top of the newer clear.
    let recomputeCalls = 0;
    const result = await evaluateReviewIssue("qbo-purchase", "p-1", ["AMOUNT_MISMATCH"], null, {
        client,
        recomputeCodes: async () => {
            recomputeCalls++;
            return [];
        },
    });

    assert.equal(recomputeCalls, 1, "recomputeCodes must be called on the retry attempt, not the first");
    assert.equal(result.decision.step, 1, "the RECOMPUTED (empty) codes drive the retry's decision");
    assert.equal(result.decision.action, "clear");
    const issue = [...issues.values()][0];
    assert.ok(issue.clearedAt, "cleared using the freshly recomputed codes, not the stale AMOUNT_MISMATCH snapshot");
});

// ── Finding 7: mark-reviewed must fence the currently-open episode ─────────

test("markReviewed suppresses the current generation's queued (non-SENT) episode so it cannot still post", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], null, { client });
    const issue = [...issues.values()][0];
    assert.equal(episodes[0].status, "PENDING");

    const result = await markReviewed({ id: issue.id, version: issue.version, reasonHash: issue.reasonHash }, client);
    assert.deepEqual(result, { ok: true });

    assert.equal(episodes[0].status, "SUPPRESSED", "the still-queued episode must be fenced, not left PENDING to be delivered anyway");
});

// ── Finding 9: display details must not go stale on an unchanged reason ────

test("evaluateReviewIssue: touch with unchanged codes but CHANGED displayDetails updates display only, no new episode", async () => {
    const { client, issues, episodes } = createFakeClient();
    await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], { amountCents: -100 }, { client });
    const versionBefore = [...issues.values()][0].version;

    const result = await evaluateReviewIssue("qbo-purchase", "p-1", ["NO_RECEIPT"], { amountCents: -150 }, { client });

    assert.equal(result.decision.step, 5);
    assert.equal(result.applied, true, "a display-only write still counts as applied");
    assert.equal(episodes.length, 1, "no new episode opens for a display-only change — episode snapshots stay immutable");
    const issue = [...issues.values()][0];
    assert.equal(issue.version, versionBefore + 1, "display-only write is still version-guarded");
    assert.equal(issue.displayDetails, JSON.stringify({ amountCents: -150 }));
});
