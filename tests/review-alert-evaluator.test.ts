import assert from "node:assert/strict";
import test from "node:test";
import { ABSENCE_GRACE_MS, reconcileMissingTargets } from "../src/lib/review-alert-evaluator";
import { evaluateReviewIssue, type ReviewIssueLifecycleClient, type ReviewIssueRow } from "../src/lib/review-alert-lifecycle";
import type { ReasonCode } from "../src/lib/review-alert-reasons";

// Arbiter ruling on the review-alert reconciliation bug: `reconcileMissingTargets`
// used to clear a ReviewIssue IMMEDIATELY on one snapshot's absence, which (a)
// wiped acknowledgedCodes/acknowledgedAt on every transient gap and (b) always
// beat the ack-suppress step in the ordered tree, guaranteeing a duplicate Chat
// card on reopen. The fix: absence is tracked (`absentSince`), only acted on
// once continuously absent for ABSENCE_GRACE_MS, and only from a snapshot that
// passes a freshness (`stale`) and coverage (>=50% of open keys present) gate.

const TARGET_TYPE = "qbo-purchase";

interface FakeEpisode extends Record<string, unknown> {
    id: string;
    issueId: string;
    generation: number;
    status: string;
}

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (value && typeof value === "object" && !(value instanceof Date) && "in" in (value as Record<string, unknown>)) {
            return (value as { in: unknown[] }).in.includes(row[key]);
        }
        return row[key] === value;
    });
}

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as Record<string, unknown>)) {
            row[key] = (Number(row[key]) || 0) + (value as { increment: number }).increment;
        } else {
            row[key] = value;
        }
    }
}

type FakeIssueRow = ReviewIssueRow & Record<string, unknown> & { absentSince: Date | null };

/** One in-memory ReviewIssue store, exposed through TWO client shapes —
 * `openIssueClient` (the bookkeeping list/update reconcileMissingTargets uses
 * directly) and `lifecycleClient` (threaded through to evaluateReviewIssue for
 * the actual clear) — because in real Prisma both are the same table. Mirrors
 * the fake-client convention in tests/review-alert-lifecycle.test.ts and
 * tests/review-alert-rollout.test.ts (client/lifecycleClient split). */
function createFakeReconcileEnv() {
    const issues = new Map<string, FakeIssueRow>();
    const episodes: FakeEpisode[] = [];
    let issueSeq = 0;
    let episodeSeq = 0;

    const openIssueClient = {
        reviewIssue: {
            async findMany(args: { where: { targetType: string; clearedAt: null } }) {
                return [...issues.values()]
                    .filter(row => row.targetType === args.where.targetType && row.clearedAt === null)
                    .map(row => ({ targetKey: row.targetKey, absentSince: row.absentSince }));
            },
            async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
                let count = 0;
                for (const row of issues.values()) {
                    if (matchesWhere(row, args.where)) {
                        applyData(row, args.data);
                        count++;
                    }
                }
                return { count };
            },
        },
    };

    const lifecycleClient: ReviewIssueLifecycleClient = {
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
                const row = {
                    id,
                    clearedAt: null,
                    acknowledgedAt: null,
                    displayDetails: null,
                    absentSince: null,
                    ...args.data,
                } as FakeIssueRow;
                issues.set(id, row);
                return row;
            },
            async updateMany(args) {
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
            return fn(lifecycleClient);
        },
    };

    return { issues, episodes, openIssueClient, lifecycleClient };
}

async function seedOpenIssue(
    env: ReturnType<typeof createFakeReconcileEnv>,
    targetKey: string,
    now: Date,
    reasonCodes: ReasonCode[] = ["NO_RECEIPT"],
) {
    await evaluateReviewIssue(TARGET_TYPE, targetKey, reasonCodes, null, {
        client: env.lifecycleClient,
        now: () => now,
    });
    return [...env.issues.values()].find(row => row.targetKey === targetKey)!;
}

// ── absent once does NOT clear ──────────────────────────────────────────────

test("reconcileMissingTargets: a target absent for the first time is NOT cleared, only marked absentSince", async () => {
    const env = createFakeReconcileEnv();
    const now = new Date("2026-08-01T00:00:00Z");
    const issue = await seedOpenIssue(env, "p-1", now);
    await seedOpenIssue(env, "p-2", now); // present in the snapshot — keeps coverage at 50%, above the gate

    const cleared = await reconcileMissingTargets(new Set(["p-2"]), false, now, env.openIssueClient, env.lifecycleClient);

    assert.equal(cleared, 0);
    assert.equal(issue.clearedAt, null, "must not clear on first absence");
    assert.equal(issue.absentSince?.getTime(), now.getTime(), "absence is recorded for the age-out clock");
    assert.equal(issue.version, 1, "absentSince bookkeeping must not bump lifecycle version");
});

// ── absent past grace DOES clear ────────────────────────────────────────────

test("reconcileMissingTargets: a target continuously absent past ABSENCE_GRACE_MS is cleared", async () => {
    const env = createFakeReconcileEnv();
    const firstSeen = new Date("2026-08-01T00:00:00Z");
    const issue = await seedOpenIssue(env, "p-1", firstSeen);
    issue.absentSince = firstSeen; // simulate an earlier sweep having recorded the absence
    await seedOpenIssue(env, "p-2", firstSeen); // present in the snapshot — keeps coverage at 50%, above the gate

    const past = new Date(firstSeen.getTime() + ABSENCE_GRACE_MS + 1000);
    const cleared = await reconcileMissingTargets(new Set(["p-2"]), false, past, env.openIssueClient, env.lifecycleClient);

    assert.equal(cleared, 1);
    assert.ok(issue.clearedAt, "clears once continuously absent past the grace window");
    assert.equal(issue.acknowledgedCodes, "[]", "clear resets ack fields — expected lifecycle behavior once it actually fires");
    assert.equal(issue.absentSince, null, "absentSince bookkeeping is cleaned up in the same pass");
    const episode = env.episodes.find(e => e.issueId === issue.id);
    assert.equal(episode?.status, "CANCELLED");
});

// ── reappear before grace leaves ack + generation untouched ────────────────

test("reconcileMissingTargets: reappearing before grace leaves acknowledgedCodes intact and opens no new generation", async () => {
    const env = createFakeReconcileEnv();
    const firstSeen = new Date("2026-08-01T00:00:00Z");
    const issue = await seedOpenIssue(env, "p-1", firstSeen);
    issue.acknowledgedCodes = JSON.stringify(["NO_RECEIPT"]);
    issue.absentSince = firstSeen; // recorded absent by an earlier sweep, still well within grace
    const versionBefore = issue.version;
    const generationBefore = issue.currentGeneration;
    const episodeCountBefore = env.episodes.length;

    const soonAfter = new Date(firstSeen.getTime() + 30 * 60_000); // 30 minutes later, grace is 6h
    const cleared = await reconcileMissingTargets(
        new Set(["p-1"]), // reappeared in this snapshot
        false,
        soonAfter,
        env.openIssueClient,
        env.lifecycleClient,
    );

    assert.equal(cleared, 0);
    assert.equal(issue.clearedAt, null);
    assert.equal(issue.absentSince, null, "recovered — absence bookkeeping is cleared");
    assert.equal(issue.acknowledgedCodes, JSON.stringify(["NO_RECEIPT"]), "ack survives a transient absence untouched");
    assert.equal(issue.version, versionBefore, "recovery is bookkeeping only — no lifecycle write, no version bump");
    assert.equal(issue.currentGeneration, generationBefore, "no new generation opens on recovery");
    assert.equal(env.episodes.length, episodeCountBefore, "no new episode created");
});

// ── stale snapshot skips reconciliation entirely ────────────────────────────

test("reconcileMissingTargets: a stale snapshot skips reconciliation entirely — no clear, no absentSince write", async () => {
    const env = createFakeReconcileEnv();
    const now = new Date("2026-08-01T00:00:00Z");
    const issue = await seedOpenIssue(env, "p-1", now);

    const cleared = await reconcileMissingTargets(new Set(), true, now, env.openIssueClient, env.lifecycleClient);

    assert.equal(cleared, 0);
    assert.equal(issue.absentSince, null, "a stale snapshot must not even start the age-out clock");
    assert.equal(issue.clearedAt, null);
});

// ── low-coverage snapshot skips reconciliation entirely ─────────────────────

test("reconcileMissingTargets: fewer than half of open issue keys present skips reconciliation entirely (misconfiguration circuit breaker)", async () => {
    const env = createFakeReconcileEnv();
    const now = new Date("2026-08-01T00:00:00Z");
    const issueA = await seedOpenIssue(env, "p-1", now);
    const issueB = await seedOpenIssue(env, "p-2", now);
    await seedOpenIssue(env, "p-3", now);
    await seedOpenIssue(env, "p-4", now);
    // Coverage gate only engages at >= COVERAGE_GATE_MIN_OPEN_ISSUES (5) open
    // issues — a 5th is seeded here so this fixture still exercises the gate.
    await seedOpenIssue(env, "p-5", now);
    // Only 1 of 5 open issue keys present (20%) — below the 50% coverage gate,
    // e.g. a wrong bank-account id or a structurally-valid empty QBO report.
    const presentKeys = new Set(["p-1"]);

    const cleared = await reconcileMissingTargets(presentKeys, false, now, env.openIssueClient, env.lifecycleClient);

    assert.equal(cleared, 0);
    assert.equal(issueA.absentSince, null, "gate trips before any bookkeeping write, even for the present key's sibling");
    assert.equal(issueB.absentSince, null, "gate trips for absent keys too — nothing is written this sweep");
});

// ── coverage gate floor: a lone open issue must still age out ──────────────

test("reconcileMissingTargets: below COVERAGE_GATE_MIN_OPEN_ISSUES, a single absent-past-grace issue is cleared despite 0% coverage", async () => {
    const env = createFakeReconcileEnv();
    const firstSeen = new Date("2026-08-01T00:00:00Z");
    const issue = await seedOpenIssue(env, "p-1", firstSeen);
    issue.absentSince = firstSeen; // simulate an earlier sweep having recorded the absence

    const past = new Date(firstSeen.getTime() + ABSENCE_GRACE_MS + 1000);
    // Only 1 open issue total, present in 0 of 1 (0% coverage) — with the
    // 50%-of-open-issues gate applied unconditionally this would strand the
    // issue open forever. Below the floor, the gate must not apply.
    const cleared = await reconcileMissingTargets(new Set(), false, past, env.openIssueClient, env.lifecycleClient);

    assert.equal(cleared, 1, "the coverage gate must not apply below the floor, so this lone target ages out");
    assert.ok(issue.clearedAt, "clears once continuously absent past the grace window");
    assert.equal(issue.absentSince, null, "absentSince bookkeeping is cleaned up in the same pass");
});
