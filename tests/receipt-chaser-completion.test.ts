/**
 * The read-only chaser completion proof on /api/health/pipeline.
 *
 * Everything synthetic: fictional UUIDs, fictional fingerprints, a fake
 * `findMany`-only database that throws on any other access, a fixed injected
 * clock, and a fictional discard-port DATABASE_URL (the Prisma client factory
 * only validates the URL shape at import; nothing here connects).
 *
 * The suite pins four things: the proof asks the SAME predicates the sweep's
 * continuation pass and the cards cron ask; two bounded reads over eight fixed
 * keys are the only database access; anything malformed, moved, failed or
 * day-crossed yields no predicates rather than a manufactured certification;
 * and nothing secret-shaped (cursor contents, raw setting text, webhook URL,
 * user ids, non-grammar policy text) is ever echoed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.DATABASE_URL ??= "postgresql://fiction:fiction@127.0.0.1:9/test?pgbouncer=true";
process.env.NEXTAUTH_SECRET ??= "fiction-not-a-real-secret";

import {
    CHASER_COMPLETION_KEYS,
    CHASER_COMPLETION_LIMITATIONS,
    FULL_RUN_REQUESTED_KEY,
    KNOWN_BLOCKED_REASONS,
    LINE_CURSOR_KEY,
    OPEN_CURSOR_KEY,
    bankPullOf,
    classifySettingRows,
    cycleShapeOf,
    epochOf,
    fingerprintProofOf,
    loadChaserCompletion,
    markerShapeOf,
    policyProofOf,
    projectCardDeliveryConfig,
    readChaserSettings,
    runtimeRecognitionPolicy,
    sha256Hex,
    unavailableChaserCompletion,
    type ChaserCompletionDb,
    type ChaserCompletionDiagnostic,
    type ChaserCompletionReason,
    type RuntimePolicyInput,
} from "../src/lib/receipt-chaser-completion";
import {
    CYCLE_KEY,
    SWEEP_MARKER_KEY,
    continuationNeedsWork,
    cycleCertified,
    cycleStillValid,
    formatSweepMarker,
    shouldResumeSweep,
    type SweepCycle,
    type SweepMarker,
} from "../src/lib/receipt-sweep-marker";
import { BANK_LEDGER_EPOCH_KEY } from "../src/lib/bank-ledger-epoch";
import { RECEIPT_EVIDENCE_EPOCH_KEY } from "../src/lib/receipt-evidence-lock";
import { BANK_PULL_CHASER_WINDOW_HOURS, BANK_PULL_LAST_SUCCESS_KEY } from "../src/lib/pipeline-health";
import { CARD_OWNERS_ASKED } from "../src/lib/receipt-request-cards";
import { receiptRecognitionPolicy } from "../src/lib/receipt-source-recognition";
import { reviewedReceiptFactsFingerprint } from "../src/server/receipt-reviewed-source-facts";
import { reviewedReceiptPairsFingerprint } from "../src/server/receipt-reviewed-pair-facts";
import * as sweepRoute from "../src/app/api/cron/receipt-requests/route";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

// ── Fixtures ────────────────────────────────────────────────────────────────

const CYCLE_ID = "6ff94e26-c8da-4684-a76e-9baaa7ca4361";
const OTHER_CYCLE_ID = "0b6c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4";
const FACTS = "a".repeat(64);
const PAIRS = "b".repeat(64);
const OTHER_FACTS = "c".repeat(64);
const V1_OFF = "receipt-source-v1:off";
const v3 = (facts: string, pairs: string) => `receipt-source-v3:on:${facts}:pair:${pairs}`;
const RUNTIME_OFF: RuntimePolicyInput = { policy: V1_OFF, recognitionEnabled: false, reviewedFactsFingerprint: "absent", reviewedPairsFingerprint: "absent" };
const RUNTIME_ON: RuntimePolicyInput = { policy: v3(FACTS, PAIRS), recognitionEnabled: true, reviewedFactsFingerprint: FACTS, reviewedPairsFingerprint: PAIRS };
/** 2026-09-10 08:00 Pacific. */
const NOW = new Date("2026-09-10T15:00:00Z");
const COMPLETED_AT = "2026-09-10T14:06:00Z";
const PULL_AT = "2026-09-10T02:05:00Z";
const WEBHOOK = "https://chat.googleapis.com/v1/spaces/SYNTHSPACE/messages?key=k&token=t";
/** A synthetic env object; the repo's ProcessEnv augmentation requires NODE_ENV, which these readers never consult. */
const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const DELIVERY_ENV = env({
    RECEIPT_REQUEST_CARDS_ENABLED: "true",
    RECEIPTS_CHAT_WEBHOOK: WEBHOOK,
    RECEIPT_OWNER_CHAT_USERS: JSON.stringify({ CJ: "users/111000111", Richard: "users/222000222" }),
});

type Values = Record<string, string | null | undefined>;

function certifiedValues(overrides: Values = {}): Values {
    return {
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: COMPLETED_AT, blockedReason: null, completedCycleId: CYCLE_ID }),
        [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy }),
        [BANK_LEDGER_EPOCH_KEY]: "7",
        [RECEIPT_EVIDENCE_EPOCH_KEY]: "9",
        [BANK_PULL_LAST_SUCCESS_KEY]: PULL_AT,
        ...overrides,
    };
}

function rowsOf(values: Values): Array<{ key: string; value: string }> {
    return Object.entries(values)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** `findMany` on `automationSetting` and nothing else: any other model or method throws. */
function fakeDb(reads: Array<Array<{ key: unknown; value: unknown }> | Error>, calls: unknown[] = []): ChaserCompletionDb {
    let i = 0;
    const findMany = async (args: unknown) => {
        calls.push(args);
        const next = reads[Math.min(i++, reads.length - 1)];
        if (next instanceof Error) throw next;
        return next;
    };
    const forbid = (allowed: string) => ({
        get(target: Record<string, unknown>, prop: string | symbol) {
            if (typeof prop === "symbol" || prop === "then") return undefined;
            if (prop !== allowed) throw new Error(`forbidden access: ${String(prop)}`);
            return target[prop];
        },
    });
    const automationSetting = new Proxy({ findMany }, forbid("findMany"));
    return new Proxy({ automationSetting }, forbid("automationSetting")) as unknown as ChaserCompletionDb;
}

interface LoadOptions {
    runtime?: RuntimePolicyInput;
    clocks?: Date[];
    env?: NodeJS.ProcessEnv;
    second?: Values;
    calls?: unknown[];
}

async function load(values: Values, options: LoadOptions = {}): Promise<ChaserCompletionDiagnostic> {
    const first = rowsOf(values);
    const reads = [first, options.second ? rowsOf(options.second) : first];
    const clocks = options.clocks ?? [NOW];
    let tick = 0;
    return loadChaserCompletion(fakeDb(reads, options.calls), {
        now: () => clocks[Math.min(tick++, clocks.length - 1)],
        runtime: options.runtime ?? RUNTIME_ON,
        env: options.env ?? DELIVERY_ENV,
    });
}

const json = (value: unknown) => JSON.stringify(value);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// ── The certified current state ─────────────────────────────────────────────

test("a completed, unblocked, unchanged current cycle proves every named predicate", async () => {
    const calls: unknown[] = [];
    const result = await load(certifiedValues(), { calls });
    assert.equal(result.status, "stable");
    assert.equal(result.reason, null);
    assert.equal(result.scope, "receipt-chaser-completion");
    assert.equal(result.readOnly, true);
    assert.equal(result.businessActionsPerformed, false);
    assert.equal(result.capturedAt, NOW.toISOString());
    assert.equal(result.pacificDay, "2026-09-10");
    assert.deepEqual(result.snapshot, {
        startedAt: NOW.toISOString(), startPacificDay: "2026-09-10",
        firstReadOk: true, secondReadOk: true, readsEqual: true, dayBoundaryCrossed: false,
        rowsPresent: {
            receiptRequestsPhase: true, receiptRequestsCycle: true, receiptRequestsCursor: false, receiptRequestsOpenIssueCursor: false,
            receiptRequestsFullRunRequested: false, bankLedgerEpoch: true, receiptEvidenceEpoch: true, bankRegisterPullLastSuccess: true,
        },
    });
    assert.deepEqual(result.predicates, {
        phaseDone: true, unblocked: true, completionIsCurrentCycle: true, completionTimeValid: true,
        epochsUnchanged: true, cyclePolicyMatchesRuntime: true, cycleStillValid: true, cycleCertified: true,
        completedForPacificDay: true, fullRunOwed: false, continuationNeedsWork: false,
    });
    assert.deepEqual(result.marker, {
        present: true, shape: "json", phase: "done", chaserCompletedAt: "2026-09-10T14:06:00.000Z", completedAtValid: true,
        completedCycleId: CYCLE_ID, blocked: false, blockedReason: null,
    });
    assert.equal(result.cycle?.id, CYCLE_ID);
    assert.equal(result.cycle?.epoch, "7");
    assert.equal(result.cycle?.evidenceEpoch, "9");
    assert.deepEqual(result.currentEpochs, { bankLedger: { state: "measured", value: "7" }, receiptEvidence: { state: "measured", value: "9" } });
    assert.deepEqual(result.fullRun, { owed: false });
    assert.deepEqual(result.cursors, { linePresent: false, openIssuePresent: false });
    assert.deepEqual(result.bankPull, { state: "fresh", lastSuccessAt: "2026-09-10T02:05:00.000Z", fresh: true, windowHours: BANK_PULL_CHASER_WINDOW_HOURS });
    assert.deepEqual(result.keys, [...CHASER_COMPLETION_KEYS]);
    assert.deepEqual(result.limitations, [...CHASER_COMPLETION_LIMITATIONS]);
    assert.equal(calls.length, 2, "exactly two reads");
});

test("the eight fixed keys, in the sweep's own names, are the only thing ever queried", async () => {
    assert.deepEqual([...CHASER_COMPLETION_KEYS], [
        "receiptRequestsPhase", "receiptRequestsCycle", "receiptRequestsCursor", "receiptRequestsOpenIssueCursor",
        "receiptRequestsFullRunRequested", "bankLedgerEpoch", "receiptEvidenceEpoch", "bankRegisterPullLastSuccess",
    ]);
    const calls: unknown[] = [];
    await load(certifiedValues(), { calls });
    for (const call of calls) {
        assert.deepEqual(call, {
            where: { key: { in: [...CHASER_COMPLETION_KEYS] } },
            orderBy: { key: "asc" },
            take: 9,
            select: { key: true, value: true },
        });
    }
    // The fake throws on any model or method other than automationSetting.findMany,
    // so a stable result is itself the proof that nothing else was touched.
});

// ── Each way the current cycle is NOT certified, reported separately ────────

test("a completion stamped for a different cycle id is not this cycle's completion", async () => {
    const result = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: COMPLETED_AT, blockedReason: null, completedCycleId: OTHER_CYCLE_ID }),
    }));
    assert.equal(result.status, "stable");
    assert.equal(result.predicates?.completionIsCurrentCycle, false);
    assert.equal(result.predicates?.cycleCertified, false);
    assert.equal(result.predicates?.completedForPacificDay, false);
    assert.equal(result.predicates?.continuationNeedsWork, true, "a persisted uncertified cycle is work in progress");
    assert.equal(result.predicates?.epochsUnchanged, true, "the other predicates still stand on their own");
});

test("bank or evidence epoch drift invalidates the cycle but not the day-keyed card prerequisite", async () => {
    for (const drift of [{ [BANK_LEDGER_EPOCH_KEY]: "8" }, { [RECEIPT_EVIDENCE_EPOCH_KEY]: "10" }]) {
        const result = await load(certifiedValues(drift));
        assert.equal(result.status, "stable");
        assert.equal(result.predicates?.epochsUnchanged, false);
        assert.equal(result.predicates?.cycleStillValid, false);
        assert.equal(result.predicates?.cycleCertified, false);
        assert.equal(result.predicates?.continuationNeedsWork, true);
        assert.equal(result.predicates?.cyclePolicyMatchesRuntime, true);
        // The cards cron asks chaserCompletedFor + policy, not epochs; reported as it is.
        assert.equal(result.predicates?.completedForPacificDay, true);
    }
});

test("runtime policy drift: a v1:off cycle under a v3 runtime, and a legacy cycle under each", async () => {
    const stored = await load(certifiedValues({ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: V1_OFF }) }));
    assert.equal(stored.status, "stable");
    assert.equal(stored.predicates?.cyclePolicyMatchesRuntime, false);
    assert.equal(stored.predicates?.epochsUnchanged, true);
    assert.equal(stored.predicates?.cycleStillValid, false);
    assert.equal(stored.predicates?.cycleCertified, false);
    assert.equal(stored.predicates?.continuationNeedsWork, true);

    const legacyCycle = { [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9" }) };
    const legacyUnderOff = await load(certifiedValues(legacyCycle), { runtime: RUNTIME_OFF });
    assert.equal(legacyUnderOff.status, "stable");
    assert.equal(legacyUnderOff.cycle?.recognitionPolicy?.grammar, "legacy-absent");
    assert.equal(legacyUnderOff.cycle?.recognitionPolicy?.recorded, false);
    assert.equal(legacyUnderOff.cycle?.recognitionPolicy?.policy, null);
    assert.equal(legacyUnderOff.cycle?.recognitionPolicy?.effectiveDigest, sha(V1_OFF));
    assert.equal(legacyUnderOff.runtimePolicy.digest, sha(V1_OFF));
    assert.equal(legacyUnderOff.predicates?.cyclePolicyMatchesRuntime, true, "absent matches only v1:off");
    assert.equal(legacyUnderOff.predicates?.cycleCertified, true);

    const legacyUnderOn = await load(certifiedValues(legacyCycle), { runtime: RUNTIME_ON });
    assert.equal(legacyUnderOn.predicates?.cyclePolicyMatchesRuntime, false, "a v3 runtime rejects a legacy cycle");
    assert.equal(legacyUnderOn.predicates?.cycleCertified, false);
    assert.equal(legacyUnderOn.predicates?.continuationNeedsWork, true);
});

test("an owed full run overrides even a certified completion", async () => {
    for (const intent of ["2026-09-10T13:00:00Z", "1"]) {
        const result = await load(certifiedValues({ [FULL_RUN_REQUESTED_KEY]: intent }));
        assert.equal(result.status, "stable");
        assert.equal(result.predicates?.fullRunOwed, true);
        assert.equal(result.predicates?.cycleCertified, true);
        assert.equal(result.predicates?.continuationNeedsWork, true);
        assert.ok(!json(result).includes("13:00:00"), "the intent's own value is not echoed");
    }
    // The sweep reads `!!row?.value`: a present-but-empty row is not an owed run.
    const cleared = await load(certifiedValues({ [FULL_RUN_REQUESTED_KEY]: "" }));
    assert.equal(cleared.predicates?.fullRunOwed, false);
    assert.equal(cleared.snapshot.rowsPresent?.receiptRequestsFullRunRequested, true);
});

test("a prior-day completion is a continuation no-op but not today's card prerequisite", async () => {
    const result = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: "2026-09-09T14:06:00Z", blockedReason: null, completedCycleId: CYCLE_ID }),
    }));
    assert.equal(result.status, "stable");
    assert.equal(result.predicates?.cycleCertified, true);
    assert.equal(result.predicates?.continuationNeedsWork, false);
    assert.equal(result.predicates?.completedForPacificDay, false);
});

test("a future or unparseable completion stamp never certifies", async () => {
    const nextDay = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: "2026-09-11T14:00:00Z", blockedReason: null, completedCycleId: CYCLE_ID }),
    }));
    assert.equal(nextDay.predicates?.completionTimeValid, false);
    assert.equal(nextDay.predicates?.cycleCertified, false);
    assert.equal(nextDay.predicates?.completedForPacificDay, false);
    assert.equal(nextDay.predicates?.continuationNeedsWork, true);

    // Same Pacific day but still ahead of the clock: the cards cron's date
    // check passes on its own, the continuation's non-future check does not.
    const laterToday = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: "2026-09-10T16:00:00Z", blockedReason: null, completedCycleId: CYCLE_ID }),
    }));
    assert.equal(laterToday.predicates?.completedForPacificDay, true);
    assert.equal(laterToday.predicates?.completionTimeValid, false);
    assert.equal(laterToday.predicates?.cycleCertified, false);

    const garbage = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: "whenever", blockedReason: null, completedCycleId: CYCLE_ID }),
    }));
    assert.equal(garbage.status, "stable");
    assert.equal(garbage.marker?.completedAtValid, false);
    assert.equal(garbage.marker?.chaserCompletedAt, null);
    assert.equal(garbage.predicates?.completionTimeValid, false);
    assert.equal(garbage.predicates?.cycleCertified, false);
    assert.equal(garbage.predicates?.completedForPacificDay, false);
    assert.ok(!json(garbage).includes("whenever"));
});

test("a blocked marker reports the known reason; an unknown reason is 'other', never echoed", async () => {
    const blocked = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "lines", chaserCompletedAt: null, blockedReason: "bank-pull-stale", completedCycleId: null }),
    }));
    assert.equal(blocked.status, "stable");
    assert.deepEqual([blocked.marker?.blocked, blocked.marker?.blockedReason, blocked.marker?.phase], [true, "bank-pull-stale", "lines"]);
    assert.equal(blocked.predicates?.unblocked, false);
    assert.equal(blocked.predicates?.phaseDone, false);
    assert.equal(blocked.predicates?.cycleCertified, false);
    assert.equal(blocked.predicates?.completedForPacificDay, false);
    assert.equal(blocked.predicates?.continuationNeedsWork, true);

    const unknown = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: COMPLETED_AT, blockedReason: "weird-internal-detail", completedCycleId: CYCLE_ID }),
    }));
    assert.equal(unknown.marker?.blockedReason, "other");
    assert.ok(!json(unknown).includes("weird-internal-detail"));
});

test("cursor presence is reported, cursor contents are not", async () => {
    const result = await load(certifiedValues({ [LINE_CURSOR_KEY]: "2026-09-10|bl-terminal-cleanup", [OPEN_CURSOR_KEY]: "" }));
    assert.equal(result.status, "stable");
    assert.deepEqual(result.cursors, { linePresent: true, openIssuePresent: false });
    assert.equal(result.predicates?.cycleCertified, true);
    assert.equal(result.predicates?.continuationNeedsWork, false, "a certified unchanged cycle stays idle whatever the cursors say");
    assert.ok(!json(result).includes("bl-terminal"));

    const parked = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: null, blockedReason: null, completedCycleId: null }),
        [CYCLE_KEY]: null,
        [OPEN_CURSOR_KEY]: "ri-parked",
    }));
    assert.equal(parked.predicates?.continuationNeedsWork, true, "a parked cursor with no cycle still resumes");
    assert.ok(!json(parked).includes("ri-parked"));
});

test("an empty settings table is an idle, uncertified state — missing epochs are not measured zeros", async () => {
    const result = await load({});
    assert.equal(result.status, "stable");
    assert.equal(result.marker?.shape, "absent");
    assert.equal(result.marker?.phase, "done");
    assert.equal(result.cycle?.present, false);
    assert.equal(result.cycle?.recognitionPolicy, null);
    assert.deepEqual(result.currentEpochs, { bankLedger: { state: "missing", value: null }, receiptEvidence: { state: "missing", value: null } });
    assert.equal(result.bankPull?.state, "missing");
    assert.equal(result.predicates?.cycleCertified, false);
    assert.equal(result.predicates?.completedForPacificDay, false);
    assert.equal(result.predicates?.epochsUnchanged, false);
    assert.equal(result.predicates?.cyclePolicyMatchesRuntime, false);
    assert.equal(result.predicates?.continuationNeedsWork, false);
});

// ── Time is the clock reading AFTER the second read ────────────────────────

test("a bank-pull stamp that expires while the rows are read is stale at the answer", async () => {
    const atStart = new Date("2026-09-11T02:04:59Z"); // 23:59:59 after the pull
    const atEnd = new Date("2026-09-11T02:05:01Z");   // 24:00:01 after the pull
    assert.equal(bankPullOf(PULL_AT, atStart, BANK_PULL_CHASER_WINDOW_HOURS).fresh, true, "control: fresh at the first clock reading");
    assert.equal(sweepRoute.bankPullFresh(PULL_AT, atStart), true);
    assert.equal(sweepRoute.bankPullFresh(PULL_AT, atEnd), false);

    const result = await load(certifiedValues(), { clocks: [atStart, atEnd] });
    assert.equal(result.status, "stable");
    assert.equal(result.snapshot.readsEqual, true);
    assert.equal(result.snapshot.startedAt, atStart.toISOString());
    assert.equal(result.capturedAt, atEnd.toISOString());
    assert.deepEqual(result.bankPull, { state: "stale", lastSuccessAt: "2026-09-10T02:05:00.000Z", fresh: false, windowHours: BANK_PULL_CHASER_WINDOW_HOURS });
    assert.equal(result.predicates?.cycleCertified, true, "freshness is a separate signal, not a term of certification");
});

test("a completion stamped between the two clock readings is judged at the end, consistently", async () => {
    const atStart = new Date("2026-09-10T15:00:00Z");
    const atEnd = new Date("2026-09-10T15:01:00Z");
    const result = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: "2026-09-10T15:00:30Z", blockedReason: null, completedCycleId: CYCLE_ID }),
    }), { clocks: [atStart, atEnd] });
    assert.equal(result.capturedAt, atEnd.toISOString());
    assert.equal(result.predicates?.completionTimeValid, true);
    assert.equal(result.predicates?.cycleCertified, true);
    assert.equal(cycleCertified({
        marker: { phase: "done", chaserCompletedAt: "2026-09-10T15:00:30Z", blockedReason: null, completedCycleId: CYCLE_ID },
        cycle: { id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy },
        bankEpoch: "7", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy, now: atStart,
    }), false, "control: at the first reading it was still in the future");
});

test("a Pacific day boundary crossed between the first read and the answer makes the proof unstable", async () => {
    const result = await load(certifiedValues(), { clocks: [new Date("2026-09-11T06:59:59Z"), new Date("2026-09-11T07:00:01Z")] });
    assert.equal(result.status, "unstable");
    assert.equal(result.reason, "day-boundary-crossed");
    assert.equal(result.snapshot.startPacificDay, "2026-09-10");
    assert.equal(result.pacificDay, "2026-09-11");
    assert.equal(result.snapshot.dayBoundaryCrossed, true);
    assert.equal(result.predicates, null);
});

// ── Moved, failed, over-bound or malformed reads never certify ─────────────

test("a change to ANY decision-relevant setting between the reads is unstable, row presence included", async () => {
    const base = certifiedValues({ [LINE_CURSOR_KEY]: "cursor-a", [OPEN_CURSOR_KEY]: "cursor-b", [FULL_RUN_REQUESTED_KEY]: "intent" });
    const changed: Record<string, string | null> = {
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "lines", chaserCompletedAt: null, blockedReason: null, completedCycleId: null }),
        [CYCLE_KEY]: JSON.stringify({ id: OTHER_CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy }),
        [LINE_CURSOR_KEY]: "cursor-a2",
        [OPEN_CURSOR_KEY]: "cursor-b2",
        [FULL_RUN_REQUESTED_KEY]: "",
        [BANK_LEDGER_EPOCH_KEY]: "8",
        [RECEIPT_EVIDENCE_EPOCH_KEY]: "10",
        [BANK_PULL_LAST_SUCCESS_KEY]: "2026-09-10T03:05:00Z",
    };
    for (const key of CHASER_COMPLETION_KEYS) {
        for (const [label, second] of [["value changed", { ...base, [key]: changed[key] }], ["row removed", { ...base, [key]: null }]] as const) {
            const result = await load(base, { second });
            assert.equal(result.status, "unstable", `${key}: ${label}`);
            assert.equal(result.reason, "reads-differ", `${key}: ${label}`);
            assert.equal(result.snapshot.readsEqual, false);
            assert.equal(result.predicates, null, `${key}: ${label}`);
        }
    }
    const added = await load(certifiedValues(), { second: certifiedValues({ [OPEN_CURSOR_KEY]: "appeared" }) });
    assert.equal(added.reason, "reads-differ", "a row appearing between the reads is a change too");
    assert.ok(!json(added).includes("appeared"));
});

test("a failed read is unavailable, with no predicates and no error text", async () => {
    const boom = new Error("db exploded host=secret-internal");
    const first = await loadChaserCompletion(fakeDb([boom]), { now: () => NOW, runtime: RUNTIME_ON, env: DELIVERY_ENV });
    assert.equal(first.status, "unavailable");
    assert.equal(first.reason, "read-failed");
    assert.deepEqual([first.snapshot.firstReadOk, first.snapshot.secondReadOk, first.predicates, first.marker], [false, false, null, null]);
    assert.ok(!json(first).includes("secret-internal"));

    const second = await loadChaserCompletion(fakeDb([rowsOf(certifiedValues()), boom]), { now: () => NOW, runtime: RUNTIME_ON, env: DELIVERY_ENV });
    assert.equal(second.status, "unavailable");
    assert.equal(second.reason, "read-failed");
    assert.deepEqual([second.snapshot.firstReadOk, second.snapshot.secondReadOk, second.predicates], [true, false, null]);
    assert.ok(!json(second).includes("secret-internal"));
});

test("over-bound, duplicated, unexpected or non-string rows are refused before any parsing", async () => {
    const good = rowsOf(certifiedValues());
    assert.deepEqual(classifySettingRows([...good, ...rowsOf({ [LINE_CURSOR_KEY]: "a", [OPEN_CURSOR_KEY]: "b", [FULL_RUN_REQUESTED_KEY]: "c" }), { key: "bankLedgerEpoch", value: "7" }]), { ok: false, reason: "rows-over-bound" });
    assert.deepEqual(classifySettingRows([...good, { key: BANK_LEDGER_EPOCH_KEY, value: "7" }]), { ok: false, reason: "duplicate-key" });
    assert.deepEqual(classifySettingRows([{ key: "somethingElse", value: "x" }]), { ok: false, reason: "unexpected-key" });
    assert.deepEqual(classifySettingRows([{ key: BANK_LEDGER_EPOCH_KEY, value: 7 }]), { ok: false, reason: "value-not-string" });
    assert.deepEqual(await readChaserSettings(fakeDb([{ not: "an array" } as unknown as Array<{ key: unknown; value: unknown }>])), { ok: false, reason: "read-failed" });
    const duplicated = await loadChaserCompletion(fakeDb([[...good, { key: BANK_LEDGER_EPOCH_KEY, value: "7" }]]), { now: () => NOW, runtime: RUNTIME_ON, env: DELIVERY_ENV });
    assert.equal(duplicated.status, "unavailable");
    assert.equal(duplicated.reason, "duplicate-key");
});

test("malformed marker, cycle or current epochs are unavailable with nothing echoed", async () => {
    const cases: Array<[Values, ChaserCompletionReason, string]> = [
        [{ [SWEEP_MARKER_KEY]: "{not json secret-marker" }, "marker-malformed", "secret-marker"],
        [{ [SWEEP_MARKER_KEY]: '["done"]' }, "marker-malformed", '["done"]'],
        [{ [SWEEP_MARKER_KEY]: '{"phase":"junk-phase","chaserCompletedAt":"2026-09-10T14:06:00Z"}' }, "marker-malformed", "junk-phase"],
        [{ [SWEEP_MARKER_KEY]: '{"phase":"done","chaserCompletedAt":42}' }, "marker-malformed", "42"],
        [{ [CYCLE_KEY]: "garbage-cycle-text" }, "cycle-malformed", "garbage-cycle-text"],
        [{ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7" }) }, "cycle-malformed", '"epoch":"7"}'],
        [{ [BANK_LEDGER_EPOCH_KEY]: "abc-epoch" }, "bank-ledger-epoch-malformed", "abc-epoch"],
        [{ [BANK_LEDGER_EPOCH_KEY]: "" }, "bank-ledger-epoch-malformed", "\"value\":\"\""],
        [{ [RECEIPT_EVIDENCE_EPOCH_KEY]: "007" }, "receipt-evidence-epoch-malformed", "007"],
    ];
    for (const [override, reason, forbidden] of cases) {
        const result = await load(certifiedValues(override));
        assert.equal(result.status, "unavailable", reason);
        assert.equal(result.reason, reason);
        assert.equal(result.predicates, null, reason);
        assert.ok(!json(result).includes(forbidden), `${reason} must not echo ${forbidden}`);
    }
    const emptyEpoch = await load(certifiedValues({ [BANK_LEDGER_EPOCH_KEY]: "" }));
    assert.equal(emptyEpoch.currentEpochs?.bankLedger.state, "malformed", "an empty epoch row is not a measured zero");
});

test("fail closed: identities or policies the proof cannot show never yield a stable certification", async () => {
    // Astra draft review: the sweep's parsers accept any non-empty string for
    // these, so matching non-UUID ids certified while both were suppressed.
    const cases: Array<[Values, ChaserCompletionReason, string]> = [
        [{
            [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "done", chaserCompletedAt: COMPLETED_AT, blockedReason: null, completedCycleId: "not-a-uuid" }),
            [CYCLE_KEY]: JSON.stringify({ id: "not-a-uuid", epoch: "7", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy }),
        }, "marker-cycle-id-malformed", "not-a-uuid"],
        [{
            [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "lines", chaserCompletedAt: null, blockedReason: null, completedCycleId: null }),
            [CYCLE_KEY]: JSON.stringify({ id: "cycle-token-xyz", epoch: "7", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy }),
        }, "cycle-id-malformed", "cycle-token-xyz"],
        [{ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "seven", evidenceEpoch: "9", recognitionPolicy: RUNTIME_ON.policy }) }, "cycle-epoch-malformed", "seven"],
        [{ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: "unexpected-policy" }) }, "cycle-policy-malformed", "unexpected-policy"],
        [{ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: `receipt-source-v3:on:sk_live_SECRET:pair:${PAIRS}` }) }, "cycle-policy-malformed", "sk_live"],
    ];
    for (const [override, reason, forbidden] of cases) {
        const result = await load(certifiedValues(override));
        assert.equal(result.status, "unavailable", reason);
        assert.equal(result.reason, reason);
        assert.equal(result.predicates, null, reason);
        assert.ok(!json(result).includes(forbidden), `${reason} must not echo ${forbidden}`);
        // A non-UUID identity is suppressed; a well-formed id next to a malformed epoch or policy is still shown.
        assert.equal(result.cycle?.id ?? null, reason.endsWith("id-malformed") ? null : CYCLE_ID, reason);
    }
    // The equivalent shared-predicate answer is deliberately unchanged for the sweep.
    const marker: SweepMarker = { phase: "done", chaserCompletedAt: COMPLETED_AT, blockedReason: null, completedCycleId: "not-a-uuid" };
    const cycle: SweepCycle = { id: "not-a-uuid", epoch: "0", evidenceEpoch: "0", recognitionPolicy: V1_OFF };
    assert.equal(cycleCertified({ marker, cycle, bankEpoch: "0", evidenceEpoch: "0", recognitionPolicy: V1_OFF, now: NOW }), true);

    const runtimeMalformed = await load(certifiedValues(), { runtime: { ...RUNTIME_ON, policy: "sk_live_RUNTIME_SECRET", reviewedFactsFingerprint: "sk_live_F" } });
    assert.equal(runtimeMalformed.status, "unavailable");
    assert.equal(runtimeMalformed.reason, "runtime-policy-malformed");
    assert.deepEqual(runtimeMalformed.runtimePolicy, { recognitionEnabled: true, grammar: "malformed", policy: null, digest: null, reviewedFacts: null, reviewedPairs: null });
    assert.ok(!json(runtimeMalformed).includes("sk_live"));
    assert.deepEqual(fingerprintProofOf("sk_live_F"), { state: "malformed", fingerprint: null });

    // Legitimate incomplete shapes stay live: no completion yet, legacy policy absent.
    const inFlight = await load(certifiedValues({
        [SWEEP_MARKER_KEY]: formatSweepMarker({ phase: "lines", chaserCompletedAt: null, blockedReason: null, completedCycleId: null }),
    }));
    assert.equal(inFlight.status, "stable");
    assert.equal(inFlight.predicates?.continuationNeedsWork, true);
});

// ── Exact policy proof ──────────────────────────────────────────────────────

test("the exact stored and runtime policies are shown with deterministic digests; different packets are distinguishable", async () => {
    const matching = await load(certifiedValues());
    assert.deepEqual(matching.runtimePolicy, {
        recognitionEnabled: true, grammar: "v3-on", policy: RUNTIME_ON.policy, digest: sha(RUNTIME_ON.policy),
        reviewedFacts: { state: "pinned", fingerprint: FACTS }, reviewedPairs: { state: "pinned", fingerprint: PAIRS },
    });
    assert.deepEqual(matching.cycle?.recognitionPolicy, {
        recorded: true, grammar: "v3-on", policy: RUNTIME_ON.policy, digest: sha(RUNTIME_ON.policy), effectiveDigest: sha(RUNTIME_ON.policy),
        reviewedFacts: { state: "pinned", fingerprint: FACTS }, reviewedPairs: { state: "pinned", fingerprint: PAIRS },
    });
    assert.equal(matching.cycle?.recognitionPolicy?.effectiveDigest, matching.runtimePolicy.digest);
    assert.equal(matching.predicates?.cyclePolicyMatchesRuntime, true);
    assert.equal(sha256Hex(RUNTIME_ON.policy), sha(RUNTIME_ON.policy));

    const otherPacket = v3(OTHER_FACTS, PAIRS);
    const differing = await load(certifiedValues({ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: otherPacket }) }));
    assert.equal(differing.status, "stable");
    assert.equal(differing.cycle?.recognitionPolicy?.policy, otherPacket);
    assert.equal(differing.cycle?.recognitionPolicy?.digest, sha(otherPacket));
    assert.notEqual(differing.cycle?.recognitionPolicy?.digest, differing.runtimePolicy.digest);
    assert.equal(differing.cycle?.recognitionPolicy?.reviewedFacts?.fingerprint, OTHER_FACTS);
    assert.equal(differing.runtimePolicy.reviewedFacts?.fingerprint, FACTS);
    assert.equal(differing.predicates?.cyclePolicyMatchesRuntime, false);
    assert.equal(differing.predicates?.cycleCertified, false);

    const retired = await load(certifiedValues({ [CYCLE_KEY]: JSON.stringify({ id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: `receipt-source-v2:on:${FACTS}` }) }));
    assert.equal(retired.status, "stable");
    assert.equal(retired.cycle?.recognitionPolicy?.grammar, "v2-on");
    assert.equal(retired.cycle?.recognitionPolicy?.reviewedPairs, null);
    assert.equal(retired.predicates?.cyclePolicyMatchesRuntime, false, "v3 retires every v2 certificate");
});

test("policy grammar is a strict whitelist; fingerprints are absent, invalid or 64-hex", () => {
    assert.deepEqual(policyProofOf(V1_OFF), { grammar: "v1-off", policy: V1_OFF, digest: sha(V1_OFF), reviewedFacts: null, reviewedPairs: null });
    assert.equal(policyProofOf(v3("absent", "invalid")).reviewedFacts?.state, "absent");
    assert.equal(policyProofOf(v3("absent", "invalid")).reviewedPairs?.state, "invalid");
    for (const bad of ["", "receipt-source-v1:on", "receipt-source-v3:on:abc:pair:def", v3(FACTS.toUpperCase(), PAIRS), `${v3(FACTS, PAIRS)} `, "receipt-source-v4:on:absent"]) {
        assert.deepEqual(policyProofOf(bad), { grammar: "malformed", policy: null, digest: null, reviewedFacts: null, reviewedPairs: null }, bad);
    }
    assert.deepEqual(fingerprintProofOf("absent"), { state: "absent", fingerprint: "absent" });
    assert.deepEqual(fingerprintProofOf("invalid"), { state: "invalid", fingerprint: "invalid" });
    assert.deepEqual(fingerprintProofOf(FACTS), { state: "pinned", fingerprint: FACTS });
    assert.deepEqual(fingerprintProofOf(FACTS.toUpperCase()), { state: "malformed", fingerprint: null });
});

test("the runtime policy is derived by the sweep's own function from the flag and both packet fingerprints", () => {
    const on = runtimeRecognitionPolicy(env({ RECEIPT_SOURCE_RECOGNITION_ENABLED: "true" }));
    assert.equal(on.policy, receiptRecognitionPolicy(true, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint));
    assert.deepEqual([on.recognitionEnabled, on.reviewedFactsFingerprint, on.reviewedPairsFingerprint], [true, reviewedReceiptFactsFingerprint, reviewedReceiptPairsFingerprint]);
    for (const flagEnv of [{}, { RECEIPT_SOURCE_RECOGNITION_ENABLED: "TRUE" }, { RECEIPT_SOURCE_RECOGNITION_ENABLED: "1" }] as Record<string, string>[]) {
        const off = runtimeRecognitionPolicy(env(flagEnv));
        assert.equal(off.policy, V1_OFF);
        assert.equal(off.recognitionEnabled, false);
    }
});

// ── Delivery configuration: presence and shape only ────────────────────────

test("delivery readiness is webhook present AND valid AND both asked owners mapped; nothing sensitive is echoed", async () => {
    assert.deepEqual(CARD_OWNERS_ASKED, ["CJ", "Richard"]);
    const full = projectCardDeliveryConfig(DELIVERY_ENV);
    assert.deepEqual(full, {
        reminderEnabled: true, webhookPresent: true, webhookValid: true,
        ownerMapping: { present: true, owners: { CJ: true, Richard: true }, complete: true },
        deliveryConfigured: true,
    });
    const absent = projectCardDeliveryConfig(env({}));
    assert.deepEqual(absent, {
        reminderEnabled: false, webhookPresent: false, webhookValid: false,
        ownerMapping: { present: false, owners: { CJ: false, Richard: false }, complete: false },
        deliveryConfigured: false,
    });
    for (const [label, mapping] of [
        ["not json", "not json"],
        ["array", '["users/111000111"]'],
        ["email instead of user id", JSON.stringify({ CJ: "cj@example.com", Richard: "users/222000222" })],
        ["partial", JSON.stringify({ CJ: "users/111000111" })],
        ["Justin only", JSON.stringify({ Justin: "users/555000111" })],
    ] as const) {
        const partial = projectCardDeliveryConfig({ ...DELIVERY_ENV, RECEIPT_OWNER_CHAT_USERS: mapping });
        assert.equal(partial.ownerMapping.present, true, label);
        assert.equal(partial.ownerMapping.complete, false, label);
        assert.equal(partial.deliveryConfigured, false, `${label}: webhook alone is not readiness`);
        assert.equal(partial.webhookValid, true, label);
    }
    assert.equal(projectCardDeliveryConfig({ ...DELIVERY_ENV, RECEIPT_OWNER_CHAT_USERS: JSON.stringify({ CJ: "cj@example.com", Richard: "users/222000222" }) }).ownerMapping.owners.Richard, true);
    const badHost = projectCardDeliveryConfig({ ...DELIVERY_ENV, RECEIPTS_CHAT_WEBHOOK: "https://evil.example.com/v1/spaces/x" });
    assert.deepEqual([badHost.webhookPresent, badHost.webhookValid, badHost.ownerMapping.complete, badHost.deliveryConfigured], [true, false, true, false]);
    for (const flag of ["TRUE", "1", "yes", ""]) {
        assert.equal(projectCardDeliveryConfig({ ...DELIVERY_ENV, RECEIPT_REQUEST_CARDS_ENABLED: flag }).reminderEnabled, false, `flag ${JSON.stringify(flag)}`);
    }

    const result = await load(certifiedValues(), { env: DELIVERY_ENV });
    assert.deepEqual(result.delivery, full);
    const text = json(result);
    for (const secret of ["users/111000111", "users/222000222", "chat.googleapis.com", "token=t", "key=k", "@", "SYNTHSPACE"]) {
        assert.ok(!text.includes(secret), `must not echo ${secret}`);
    }
    for (const raw of [certifiedValues()[SWEEP_MARKER_KEY]!, certifiedValues()[CYCLE_KEY]!]) {
        assert.ok(!text.includes(raw), "raw setting text is never echoed");
    }
});

// ── The pieces, and their agreement with the sweep ──────────────────────────

test("bank-pull freshness agrees with the sweep's bankPullFresh at every boundary", () => {
    const now = new Date("2026-09-02T13:00:00Z");
    const table: Array<[string | null, string]> = [
        [null, "missing"], ["", "missing"], ["whenever", "malformed"], ["2026-09-03T00:00:00Z", "future"],
        ["2026-09-01T13:00:00Z", "fresh"], ["2026-09-01T12:59:59Z", "stale"], ["2026-09-02T02:05:00Z", "fresh"], ["2026-09-01T02:05:00Z", "stale"],
    ];
    for (const [value, state] of table) {
        const ours = bankPullOf(value, now, BANK_PULL_CHASER_WINDOW_HOURS);
        assert.equal(ours.state, state, String(value));
        assert.equal(ours.fresh, sweepRoute.bankPullFresh(value, now), String(value));
    }
});

test("epoch and marker shape classification", () => {
    assert.deepEqual(epochOf(null), { state: "missing", value: null, effective: "0" });
    assert.deepEqual(epochOf("0"), { state: "measured", value: "0", effective: "0" });
    assert.deepEqual(epochOf("12"), { state: "measured", value: "12", effective: "12" });
    assert.deepEqual(epochOf(""), { state: "malformed", value: null, effective: "" });
    assert.deepEqual(epochOf("007"), { state: "malformed", value: null, effective: "007" });
    assert.equal(markerShapeOf(null), "absent");
    assert.equal(markerShapeOf(""), "absent");
    assert.equal(markerShapeOf("lines"), "legacy-phase");
    assert.equal(markerShapeOf(formatSweepMarker({ phase: "done", chaserCompletedAt: null, blockedReason: null, completedCycleId: null })), "json");
    assert.equal(markerShapeOf("{bad"), "malformed");
    assert.equal(markerShapeOf('{"phase":"done","completedCycleId":7}'), "malformed");
    assert.equal(cycleShapeOf(null), "absent");
    assert.equal(cycleShapeOf("x"), "malformed");
    assert.equal(cycleShapeOf(JSON.stringify({ id: CYCLE_ID, epoch: "1", evidenceEpoch: "2" })), "json");
    const legacy = unavailableChaserCompletion("read-failed", NOW, { runtime: RUNTIME_OFF, delivery: projectCardDeliveryConfig(env({})) });
    assert.deepEqual([legacy.status, legacy.reason, legacy.predicates, legacy.marker, legacy.cycle], ["unavailable", "read-failed", null, null, null]);
});

test("the shared continuation predicate is the sweep's own function, and cycleCertified is exactly its certified clause", () => {
    assert.equal(sweepRoute.continuationNeedsWork, continuationNeedsWork, "the route re-exports the shared function");
    assert.equal(sweepRoute.shouldResumeSweep, shouldResumeSweep);
    const marker: SweepMarker = { phase: "done", chaserCompletedAt: COMPLETED_AT, blockedReason: null, completedCycleId: CYCLE_ID };
    const cycle: SweepCycle = { id: CYCLE_ID, epoch: "7", evidenceEpoch: "9", recognitionPolicy: V1_OFF };
    const variants = [
        { marker, cycle },
        { marker: { ...marker, phase: "lines" as const }, cycle },
        { marker: { ...marker, blockedReason: "bank-pull-stale" }, cycle },
        { marker: { ...marker, completedCycleId: OTHER_CYCLE_ID }, cycle },
        { marker: { ...marker, chaserCompletedAt: "2026-09-11T14:00:00Z" }, cycle },
        { marker: { ...marker, chaserCompletedAt: "nope" }, cycle },
        { marker, cycle: { ...cycle, epoch: "8" } },
        { marker, cycle: { ...cycle, recognitionPolicy: RUNTIME_ON.policy } },
        { marker, cycle: null },
        { marker: { phase: "done" as const, chaserCompletedAt: null }, cycle: null },
    ];
    for (const variant of variants) {
        for (const recognitionPolicy of [undefined, V1_OFF, RUNTIME_ON.policy]) {
            for (const [fullRunOwed, lineCursor, openCursor] of [[false, null, null], [true, null, null], [false, "c", null], [false, null, "o"]] as const) {
                const input = { ...variant, bankEpoch: "7", evidenceEpoch: "9", recognitionPolicy, now: NOW, fullRunOwed, lineCursor, openCursor };
                const completedAt = input.marker.chaserCompletedAt ? Date.parse(input.marker.chaserCompletedAt) : NaN;
                const certified = input.cycle !== null && input.marker.phase === "done" && !input.marker.blockedReason
                    && input.marker.completedCycleId === input.cycle.id && Number.isFinite(completedAt) && completedAt <= NOW.getTime()
                    && cycleStillValid(input.cycle, input.bankEpoch, input.evidenceEpoch, input.recognitionPolicy);
                assert.equal(cycleCertified(input), certified);
                const expected = fullRunOwed ? true : certified ? false : input.cycle !== null || shouldResumeSweep(input.marker.phase, lineCursor, openCursor);
                assert.equal(continuationNeedsWork(input), expected);
            }
        }
    }
});

// ── Source pins: the route, the keys, and the absence of writes ─────────────

test("the health route gates before it reads, short-circuits before the QBO probe, and leaves outcomes=only alone", () => {
    const src = read("src/app/api/health/pipeline/route.ts");
    const at = (needle: string) => { const index = src.indexOf(needle); assert.ok(index >= 0, `missing marker: ${needle}`); return index; };
    const auth = at("hasCronSecret(request)");
    const unauthorized = at('{ status: 401 }');
    const forbidden = at('{ status: 403 }');
    const outcomesOnly = at('get("outcomes") === "only"');
    const chaserOnly = at('get("chaser") === "only"');
    const chaserLoad = at("await loadChaserCompletionDiagnostic()");
    const health = at("await getPipelineHealth()");
    assert.ok(auth < unauthorized && unauthorized < forbidden && forbidden < outcomesOnly, "auth, then 401/403, then the query branches");
    assert.ok(outcomesOnly < chaserOnly && chaserOnly < chaserLoad && chaserLoad < health, "chaser=only short-circuits before the health sweep");
    assert.match(src, /NextResponse\.json\(\{ receiptOutcomes \}, \{ headers: noStore \}\)/, "outcomes=only body unchanged");
    assert.match(src, /NextResponse\.json\(\{ chaserCompletion \}, \{ headers: noStore \}\)/);
    assert.match(src, /NextResponse\.json\(\{ \.\.\.health, receiptOutcomes, chaserCompletion \}, \{ headers: noStore \}\)/, "appended, not merged into health.ok");
    assert.equal(src.split("await loadChaserCompletionDiagnostic()").length - 1, 2, "loaded once per branch, after auth");
    assert.doesNotMatch(src, /cron\/receipt-requests/, "the health route never imports the sweep");
});

test("the diagnostic module reads findMany only, imports no cron route, and hardcodes no schedule", () => {
    const src = read("src/lib/receipt-chaser-completion.ts");
    assert.doesNotMatch(src, /cron\/receipt-requests|cron\/receipt-request-cards/);
    assert.doesNotMatch(src, /automationSetting\.(?!findMany\b)\w+/, "no automationSetting method other than findMany");
    assert.doesNotMatch(src, /\$transaction|\$executeRaw|\$queryRaw|pg_advisory|upsert\(|findUnique|findFirst|updateMany|deleteMany|\.create\(|\.delete\(/);
    assert.doesNotMatch(src, /every-15|15-minute|:15\b|every 15/);
    assert.match(src, /take: CHASER_COMPLETION_KEYS\.length \+ 1/);
});

test("restated sweep constants and read semantics are pinned to the route's own source", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    assert.match(sweep, new RegExp(`const CURSOR_KEY = "${LINE_CURSOR_KEY}";`));
    assert.match(sweep, new RegExp(`const OPEN_CURSOR_KEY = "${OPEN_CURSOR_KEY}";`));
    assert.match(sweep, new RegExp(`const FULL_RUN_REQUESTED_KEY = "${FULL_RUN_REQUESTED_KEY}";`));
    assert.match(sweep, /return !!row\?\.value;/, "full-run intent is any non-empty value");
    assert.match(sweep, /return row\?\.value \? row\.value : null;/, "cursor presence is any non-empty value");
    for (const reason of KNOWN_BLOCKED_REASONS) assert.match(sweep, new RegExp(`_REASON = "${reason}";`), reason);
    assert.match(sweep, /export \{ shouldResumeSweep, continuationNeedsWork \} from "@\/lib\/receipt-sweep-marker";/);
    assert.match(read("src/lib/bank-ledger-epoch.ts"), /rows\[0\]\?\.value \?\? BANK_LEDGER_EPOCH_ZERO/, "a missing epoch row reads as zero for the sweep");
    assert.match(read("src/lib/receipt-evidence-lock.ts"), /rows\[0\]\?\.value \?\? RECEIPT_EVIDENCE_EPOCH_ZERO/);
});
