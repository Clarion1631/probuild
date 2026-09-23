/**
 * claimOwnerDay: the only place a card is ever SELECTED (cheap-sweep-restart-
 * spec.md §14.9; Codex round 2 blocker 1, and the claim-time race).
 *
 * The gate above reads `selectionAllowed` and snapshots `ownerEpochAtScan`
 * outside any lock, minutes before this runs. This transaction re-proves
 * certification and owner stability, under the §14.0 lock order, right before
 * the insert that actually claims the (owner, pacificDate) slot.
 *
 * A recording fake transaction, same style as tests/receipt-owner-assignment.
 * test.ts: each call is tagged by what it does, so the assertions read the
 * ORDER of operations, not any module's own SQL wording.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";
process.env.NEXTAUTH_SECRET ??= "fiction-not-a-real-secret";

import { claimOwnerDay } from "../src/app/api/cron/receipt-request-cards/route";
import { CYCLE_KEY, SWEEP_MARKER_KEY, formatSweepMarker, type SweepPhase } from "../src/lib/receipt-sweep-marker";
import { RECEIPT_EVIDENCE_EPOCH_KEY, RECEIPT_OWNER_EPOCH_KEY } from "../src/lib/receipt-evidence-lock";
import { BANK_LEDGER_EPOCH_KEY } from "../src/lib/bank-ledger-epoch";
import type { CardItem } from "../src/lib/receipt-request-cards";

// claimOwnerDay's own certification check captures `now: new Date()` fresh,
// inside the transaction — deliberately not injectable (§14.9 step 6), so a
// stale value from scan time can never pass as current. Fixtures are built
// relative to the real clock so this test is correct on whatever day it runs,
// rather than pinned to one fictional date.
const NOW = new Date();
const UTC_DAY = NOW.toISOString().slice(0, 10);
const PACIFIC_DAY = NOW.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const CYCLE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RECOGNITION_POLICY = "receipt-source-v1:off";
const BANK_EPOCH = "5";
const EVIDENCE_EPOCH = "9";
const OWNER_EPOCH = "3";

const ITEMS: CardItem[] = [{
    n: 1, fingerprint: "fp-1", date: "2026-09-01", vendor: "Lowes", cents: 1234, amount: "12.34",
    cardTail: "1234", issueId: "issue-1", targetKey: "bl-1",
}];

function markerJson(over: {
    phase?: SweepPhase; chaserCompletedAt?: string | null; blockedReason?: string | null; completedCycleId?: string | null;
} = {}): string {
    return formatSweepMarker({
        phase: over.phase ?? "done",
        chaserCompletedAt: over.chaserCompletedAt !== undefined ? over.chaserCompletedAt : NOW.toISOString(),
        blockedReason: over.blockedReason ?? null,
        completedCycleId: over.completedCycleId !== undefined ? over.completedCycleId : CYCLE_ID,
    });
}

function cycleJson(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
        id: CYCLE_ID, epoch: BANK_EPOCH, evidenceEpoch: EVIDENCE_EPOCH,
        recognitionPolicy: RECOGNITION_POLICY, plannerDay: UTC_DAY,
        ...over,
    });
}

interface FakeOptions {
    markerValue?: string | null;
    cycleValue?: string | null;
    ownerEpoch?: string;
    bankEpoch?: string;
    evidenceEpoch?: string;
    createError?: unknown;
    createResult?: { id: string };
}

/** `db.$transaction` calls straight through to a recording `tx` double. */
function fakeDb(options: FakeOptions = {}) {
    const calls: string[] = [];
    let transactionOptions: unknown;
    const tx = {
        $executeRaw: async (query: TemplateStringsArray, ..._values: unknown[]) => {
            const text = query.join("");
            if (text.includes("SET LOCAL")) calls.push("set-local");
            else if (text.includes("pg_advisory_xact_lock")) calls.push("lock");
            else calls.push(`executeRaw:${text}`);
            return undefined;
        },
        $queryRaw: async (_query: TemplateStringsArray, ...values: unknown[]) => {
            const key = values[0];
            if (key === RECEIPT_EVIDENCE_EPOCH_KEY) { calls.push("evidence-read"); return [{ value: options.evidenceEpoch ?? EVIDENCE_EPOCH }]; }
            if (key === BANK_LEDGER_EPOCH_KEY) { calls.push("ledger-lock"); return [{ value: options.bankEpoch ?? BANK_EPOCH }]; }
            if (key === RECEIPT_OWNER_EPOCH_KEY) { calls.push("owner-epoch-read"); return [{ value: options.ownerEpoch ?? OWNER_EPOCH }]; }
            throw new Error(`fakeDb: unexpected $queryRaw key ${String(key)}`);
        },
        automationSetting: {
            findUnique: async (args: { where: { key: string } }) => {
                if (args.where.key === SWEEP_MARKER_KEY) {
                    calls.push("marker-read");
                    return options.markerValue === null ? null : { value: options.markerValue ?? markerJson() };
                }
                if (args.where.key === CYCLE_KEY) {
                    calls.push("cycle-read");
                    return options.cycleValue === null ? null : { value: options.cycleValue ?? cycleJson() };
                }
                throw new Error(`fakeDb: unexpected automationSetting.findUnique key ${args.where.key}`);
            },
        },
        receiptRequestCard: {
            create: async (_args: unknown) => {
                calls.push("create");
                if (options.createError) throw options.createError;
                return options.createResult ?? { id: "card-1" };
            },
        },
    };
    const db = {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>, txOptions?: unknown) => {
            transactionOptions = txOptions;
            return fn(tx);
        },
    };
    return { db, calls, get transactionOptions() { return transactionOptions; } };
}

function baseInput(overrides: Partial<Parameters<typeof claimOwnerDay>[1]> = {}): Parameters<typeof claimOwnerDay>[1] {
    return {
        owner: "CJ", date: PACIFIC_DAY, items: ITEMS, overflow: 0, overflowExact: true,
        claimedAt: NOW, claimToken: "token-1", ownerEpochAtScan: OWNER_EPOCH, recognitionPolicy: RECOGNITION_POLICY,
        ...overrides,
    };
}

test("claimed: SET LOCAL, lock, evidence read, ledger lock, marker, cycle, owner epoch, then create — in order", async () => {
    const fake = fakeDb();
    const result = await claimOwnerDay(fake.db as never, baseInput());
    assert.deepEqual(result, { kind: "claimed", id: "card-1" });
    assert.deepEqual(fake.calls, [
        "set-local", "lock", "evidence-read", "ledger-lock", "marker-read", "cycle-read", "owner-epoch-read", "create",
    ]);
    assert.deepEqual(fake.transactionOptions, { timeout: 8_000, maxWait: 1_000 });
});

test("each failed certification condition refuses with 'certification', and create is never reached", async () => {
    const cases: Array<[string, FakeOptions]> = [
        ["marker phase is not done", { markerValue: markerJson({ phase: "lines" }) }],
        ["marker is blocked", { markerValue: markerJson({ blockedReason: "bank-pull-stale" }) }],
        ["the completion is for a different cycle", { markerValue: markerJson({ completedCycleId: "not-this-cycle" }) }],
        ["the bank epoch moved under the cycle", { bankEpoch: "999" }],
        ["the evidence epoch moved under the cycle", { evidenceEpoch: "999" }],
        ["there is no cycle at all", { cycleValue: null }],
        ["the cycle has undecided lines (blocker 2)", { cycleValue: cycleJson({ undecidedLines: ["bl-undecided-1"] }) }],
        ["the cycle's plannerDay is missing (a legacy cycle)", { cycleValue: cycleJson({ plannerDay: undefined }) }],
    ];
    for (const [label, options] of cases) {
        const fake = fakeDb(options);
        const result = await claimOwnerDay(fake.db as never, baseInput());
        assert.deepEqual(result, { kind: "refused", reason: "certification" }, label);
        assert.ok(!fake.calls.includes("create"), `${label}: create must not run`);
        assert.ok(!fake.calls.includes("owner-epoch-read"), `${label}: the owner epoch is not even read once certification fails`);
    }
});

test("the owner epoch moved since the scan: refused with 'owner-moved' (Codex round 2 blocker 1)", async () => {
    const fake = fakeDb({ ownerEpoch: "a-different-epoch" });
    const result = await claimOwnerDay(fake.db as never, baseInput({ ownerEpochAtScan: OWNER_EPOCH }));
    assert.deepEqual(result, { kind: "refused", reason: "owner-moved" });
    assert.deepEqual(fake.calls, [
        "set-local", "lock", "evidence-read", "ledger-lock", "marker-read", "cycle-read", "owner-epoch-read",
    ], "certification passed and the owner epoch WAS read, but no create followed");
});

test("a unique-constraint violation on the insert gives 'taken'", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique constraint failed", { code: "P2002", clientVersion: "test" });
    const fake = fakeDb({ createError: p2002 });
    const result = await claimOwnerDay(fake.db as never, baseInput());
    assert.deepEqual(result, { kind: "taken" });
});

test("a thrown lock timeout (or any other transaction failure) gives refused/tx-failed, never a throw", async () => {
    const db = { $transaction: async () => { throw new Error("canceling statement due to lock timeout"); } };
    const result = await claimOwnerDay(db as never, baseInput());
    assert.deepEqual(result, { kind: "refused", reason: "tx-failed" });
});

test("a non-P2002 error from the insert itself also refuses with tx-failed, not taken", async () => {
    const fake = fakeDb({ createError: new Error("connection reset") });
    const result = await claimOwnerDay(fake.db as never, baseInput());
    assert.deepEqual(result, { kind: "refused", reason: "tx-failed" });
});
