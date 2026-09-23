import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    isChaseCandidate,
    blockingUndecidedLines,
    RECEIPT_REQUEST_GRACE_DAYS,
} from "../src/lib/receipt-requests";
import { classifyReceiptRequirement } from "../src/lib/receipt-policy";
import {
    sweepCompletionDecision,
    BANK_PULL_STALE_REASON,
    PULL_MOVED_REASON,
    UNDECIDED_LINES_REASON,
} from "../src/app/api/cron/receipt-requests/route";
import {
    cardSelectionCertified,
    mergeUndecidedLines,
    type SweepMarker,
    type SweepCycle,
} from "../src/lib/receipt-sweep-marker";

// cheap-sweep-restart-spec.md §14.3 and §14.6 (Codex round 2 blocker 2).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

const NOW = new Date("2026-09-22T09:00:00Z");

type CandidateLine = { id: string; postedDate: string; amountCents: number; rawDescriptor: string; checkNumber: string | null };

const line = (over: Partial<CandidateLine> = {}): CandidateLine => ({
    id: "bl-1",
    postedDate: "2026-09-15", // 7 days before NOW — well past the 3-day grace window
    amountCents: -5_000,
    rawDescriptor: "LOWES #02516 POS DEB C#8516",
    checkNumber: null,
    ...over,
});

// ═══ Equivalence: isChaseCandidate vs. an independent oracle ══════════════
//
// The oracle re-implements the OLD inline `matchable` filter
// (receipt-requests.ts, pre-§14.3) on its own, rather than importing
// `isChaseCandidate` itself — otherwise the test would just be asserting a
// function equals itself. It still calls the real, exported
// `classifyReceiptRequirement`, because the day-math (`dayNumber`/`toYmd`)
// is the only piece of the old filter that was ever private to
// receipt-requests.ts; the policy call was always shared.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function oracleDayNumber(ymd: string): number | null {
    if (!YMD.test(ymd)) return null;
    const t = Date.parse(`${ymd}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    if (new Date(t).toISOString().slice(0, 10) !== ymd) return null; // rejects e.g. "2026-02-30"
    return Math.round(t / 86_400_000);
}

function oracleToYmd(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function oracleIsChaseCandidate(candidate: CandidateLine, now: Date, resolvedKeys: ReadonlySet<string>): boolean {
    if (resolvedKeys.has(candidate.id)) return false;
    if (candidate.amountCents >= 0) return false;
    const verdict = classifyReceiptRequirement({
        amountCents: candidate.amountCents,
        rawDescriptor: candidate.rawDescriptor,
        checkNumber: candidate.checkNumber ?? null,
    });
    if (verdict.requirement !== "receipt_expected") return false;
    const day = oracleDayNumber(candidate.postedDate);
    const todayDay = oracleDayNumber(oracleToYmd(now));
    if (day === null || todayDay === null) return false;
    return todayDay - day >= RECEIPT_REQUEST_GRACE_DAYS;
}

/** Deterministic PRNG (mulberry32) — same seed, same 500 lines, every run. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const DESCRIPTOR_POOL = [
    "LOWES #02516 POS DEB C#8516",
    "HOME DEPOT 4521 POS C#6098",
    "AMAZON.COM AMZN.COM/BILL C#4297",
    "CHEVRON GAS STATION C#8516",
    "STATE FARM INSURANCE",
    "GUSTO PAYROLL FEE",
    "INDIVIDUAL LOAN PAYMENTS ACH",
    "CAPITAL ONE ONLINE PMT",
    "TRAN FEE MONTHLY",
    "NETFLIX.COM SUBSCRIPTION",
    "CHECK PAID #1042",
    "RANDOM MERCHANT LLC C#4297",
    "",
];

test("isChaseCandidate matches an independent oracle over 500 seeded random lines", () => {
    const rand = mulberry32(20260922);
    let sawTrue = 0;
    let sawFalse = 0;
    for (let i = 0; i < 500; i++) {
        const dayOffset = Math.floor(rand() * 21) - 10; // -10..+10 days from NOW
        const postedMs = NOW.getTime() - dayOffset * 86_400_000;
        let postedDate = new Date(postedMs).toISOString().slice(0, 10);
        // Occasionally corrupt the date to exercise the unparseable branch.
        if (rand() < 0.1) postedDate = "2026-02-30";
        if (rand() < 0.05) postedDate = "not-a-date";

        const candidate: CandidateLine = {
            id: `bl-${i}`,
            postedDate,
            amountCents: rand() < 0.5 ? -Math.floor(rand() * 100_000) - 1 : Math.floor(rand() * 100_000),
            rawDescriptor: DESCRIPTOR_POOL[Math.floor(rand() * DESCRIPTOR_POOL.length)],
            checkNumber: rand() < 0.15 ? String(Math.floor(rand() * 9000) + 1000) : null,
        };
        const resolvedKeys = new Set<string>(rand() < 0.2 ? [candidate.id] : []);

        const actual = isChaseCandidate(candidate, NOW, resolvedKeys);
        const expected = oracleIsChaseCandidate(candidate, NOW, resolvedKeys);
        assert.equal(actual, expected, `mismatch for ${JSON.stringify(candidate)} (resolved=${resolvedKeys.has(candidate.id)})`);
        if (actual) sawTrue++; else sawFalse++;
    }
    // A fuzz test that never varies its own outcome is not exercising anything.
    assert.ok(sawTrue > 0 && sawFalse > 0, `expected both true and false outcomes, saw true=${sawTrue} false=${sawFalse}`);
});

// ═══ blockingUndecidedLines matrix ══════════════════════════════════════

test("blockingUndecidedLines", async t => {
    await t.test("a line with an open issue is not blocking", () => {
        const eligible = line({ id: "bl-open" });
        const result = blockingUndecidedLines({
            lines: [eligible],
            undecidedIds: [eligible.id],
            openIssueKeys: new Set([eligible.id]),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("a credit line is not blocking", () => {
        const credit = line({ id: "bl-credit", amountCents: 5_000 });
        const result = blockingUndecidedLines({
            lines: [credit],
            undecidedIds: [credit.id],
            openIssueKeys: new Set(),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("a policy-exempt descriptor is not blocking", () => {
        const exempt = line({ id: "bl-exempt", rawDescriptor: "STATE FARM INSURANCE" });
        assert.equal(classifyReceiptRequirement(exempt).requirement, "no_receipt_expected");
        const result = blockingUndecidedLines({
            lines: [exempt],
            undecidedIds: [exempt.id],
            openIssueKeys: new Set(),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("a line inside the grace window is not blocking", () => {
        const young = line({ id: "bl-young", postedDate: "2026-09-21" }); // 1 day before NOW
        const result = blockingUndecidedLines({
            lines: [young],
            undecidedIds: [young.id],
            openIssueKeys: new Set(),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("a resolved line is not blocking", () => {
        const resolved = line({ id: "bl-resolved" });
        const result = blockingUndecidedLines({
            lines: [resolved],
            undecidedIds: [resolved.id],
            openIssueKeys: new Set(),
            resolvedKeys: new Set([resolved.id]),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("an id with no row in lines is not blocking", () => {
        const result = blockingUndecidedLines({
            lines: [line({ id: "bl-known" })],
            undecidedIds: ["bl-missing"],
            openIssueKeys: new Set(),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("an eligible line with no open issue is blocking", () => {
        const eligible = line({ id: "bl-eligible" });
        const result = blockingUndecidedLines({
            lines: [eligible],
            undecidedIds: [eligible.id],
            openIssueKeys: new Set(),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, [eligible.id]);
    });

    await t.test("the result is sorted and deduped", () => {
        const a = line({ id: "bl-a" });
        const b = line({ id: "bl-b" });
        const result = blockingUndecidedLines({
            lines: [b, a],
            undecidedIds: ["bl-b", "bl-a", "bl-b"],
            openIssueKeys: new Set(),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, ["bl-a", "bl-b"]);
    });

    // ═══ Codex round 1, B2: the open-issue exemption requires a CURRENT owner ═══

    await t.test("an open issue whose stored owner no longer matches today's descriptor is blocking", () => {
        // Default descriptor's card tail (C#8516) derives "CJ" today — see
        // CARD_OWNERS in receipt-policy.ts. "unassigned" models the stored
        // details from before a ledger correction changed the card tail.
        const corrected = line({ id: "bl-stale" });
        const result = blockingUndecidedLines({
            lines: [corrected],
            undecidedIds: [corrected.id],
            openIssueKeys: new Set([corrected.id]),
            openIssueDerivedOwners: new Map([[corrected.id, "unassigned"]]),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, [corrected.id]);
    });

    await t.test("an open issue whose stored owner still matches today's descriptor stays exempt", () => {
        const fresh = line({ id: "bl-fresh" }); // derives "CJ", same as stored below
        const result = blockingUndecidedLines({
            lines: [fresh],
            undecidedIds: [fresh.id],
            openIssueKeys: new Set([fresh.id]),
            openIssueDerivedOwners: new Map([[fresh.id, "CJ"]]),
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });

    await t.test("an open issue with no entry in openIssueDerivedOwners stays exempt (backward compatible: trust the exemption, as before B2)", () => {
        const noEntry = line({ id: "bl-no-entry" });
        const result = blockingUndecidedLines({
            lines: [noEntry],
            undecidedIds: [noEntry.id],
            openIssueKeys: new Set([noEntry.id]),
            // openIssueDerivedOwners omitted entirely — mirrors a caller that
            // has not been updated, or an issue this run's caller chose not
            // to look up (e.g. it carries an ownerOverride).
            resolvedKeys: new Set(),
            now: NOW,
        });
        assert.deepEqual(result, []);
    });
});

// ═══ §14.6: undecidedBlocking holds "done" back ═════════════════════════

test("sweepCompletionDecision: undecidedBlocking holds a done phase at lines", () => {
    assert.deepEqual(
        sweepCompletionDecision({ computedPhase: "done", bankPullStale: false, undecidedBlocking: true }),
        { phase: "lines", complete: false, blockedReason: UNDECIDED_LINES_REASON },
    );
});

test("sweepCompletionDecision: a stale pull and a moved pull each outrank undecided lines", () => {
    assert.deepEqual(
        sweepCompletionDecision({ computedPhase: "done", bankPullStale: true, undecidedBlocking: true }).blockedReason,
        BANK_PULL_STALE_REASON,
    );
    assert.deepEqual(
        sweepCompletionDecision({ computedPhase: "done", bankPullStale: false, ledgerMoved: true, undecidedBlocking: true }).blockedReason,
        PULL_MOVED_REASON,
    );
});

test("sweepCompletionDecision: undecidedBlocking false or absent does not hold a done phase", () => {
    assert.equal(sweepCompletionDecision({ computedPhase: "done", bankPullStale: false, undecidedBlocking: false }).phase, "done");
    assert.equal(sweepCompletionDecision({ computedPhase: "done", bankPullStale: false }).phase, "done");
});

test("source pin: certifiable requires !undecidedBlocking", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    assert.match(sweep, /const undecidedBlocking = \(cycle\.undecidedLines\?\.length \?\? 0\) > 0;/);
    assert.match(sweep, /const certifiable = computedPhase === "done" && !bankPullStale && !undecidedBlocking;/);
});

test("source pin: in the line pass, writeCycle( follows blockingUndecidedLines( and precedes the checkpoint callback", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    const blockingAt = sweep.indexOf("blockingUndecidedLines(");
    const writeCycleAt = sweep.indexOf("await writeCycle(cycle);", blockingAt);
    // The checkpoint callback is runCheckpointedUnits' second argument, where
    // the line-pass cursor advances.
    const checkpointAt = sweep.indexOf("cursor = page[page.length - 1].key;", blockingAt);
    assert.ok(blockingAt > 0, "blockingUndecidedLines is called in the line pass");
    assert.ok(writeCycleAt > blockingAt, "writeCycle follows blockingUndecidedLines");
    assert.ok(checkpointAt > writeCycleAt, "writeCycle precedes the checkpoint callback, so the cursor never passes an unrecorded line");
});

// These two pin the path an undecided line's id travels from processBatch's
// return through to pageUndecided, so it can reach blockingUndecidedLines
// above. Neither is exercised by the equivalence/matrix tests above (which
// call blockingUndecidedLines directly) or by the line-pass pin (which only
// orders blockingUndecidedLines/writeCycle/the checkpoint) — dropping either
// line leaves every one of those green while silently reopening blocker 2.

test("source pin: processBatch's final return carries undecidedIds, not just a count", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    assert.match(sweep,
        /return \{ summary, undecided: plan\.undecided\.length \+ unresolved\.length, undecidedIds: \[\.\.\.plan\.undecided, \.\.\.unresolved\], replan: false \};/,
        "a line whose component would not load must still be nameable, not just counted");
});

test("source pin: the line pass collects every batch outcome's undecidedIds into pageUndecided", () => {
    const sweep = read("src/app/api/cron/receipt-requests/route.ts");
    assert.match(sweep,
        /pageUndecided\.push\(\.\.\.\(outcome\.undecidedIds \?\? \[\]\)\);/,
        "an outcome's undecidedIds must reach pageUndecided, or blockingUndecidedLines never sees them");
});

// ═══ Codex round 2, B2 remaining gap: the OPEN-ISSUE pass's undecided outcomes
// must gate certification too, not just the line pass's ═══════════════════
//
// The line pass only ever sees the ~60-day window (`windowLines`); an issue
// that goes undecided ONLY through the open-issue pass — which walks every
// open issue regardless of age — used to feed nothing but a counter
// (`openUndecided`). These two model that exact case end to end: run
// blockingUndecidedLines the way `recordUndecidedBlocking` does, merge the
// result into a cycle exactly like it does, then ask cardSelectionCertified
// the question a card scan actually asks.

function certifiedFor(cycle: SweepCycle): boolean {
    const marker: SweepMarker = {
        phase: "done",
        chaserCompletedAt: "2026-09-22T14:00:00Z", // 7am PDT on 9/22 — today, Pacific
        blockedReason: null,
        completedCycleId: cycle.id,
    };
    return cardSelectionCertified({
        marker, cycle,
        bankEpoch: cycle.epoch, evidenceEpoch: cycle.evidenceEpoch,
        recognitionPolicy: cycle.recognitionPolicy,
        now: new Date("2026-09-22T15:00:00Z"),
        pacificDate: "2026-09-22",
    });
}

test("an open-issue-pass line undecided with a stale owner blocks certification", () => {
    // 70 days old: well outside the line pass's ~60-day window, so only the
    // open-issue pass — which walks every open issue regardless of age —
    // would ever reach a verdict (or fail to reach one) for this line.
    const old = line({ id: "bl-open-issue-stale", postedDate: "2026-07-14" });
    const blocking = blockingUndecidedLines({
        lines: [old],
        undecidedIds: [old.id],
        openIssueKeys: new Set([old.id]),
        // The stored details predate a ledger correction: "unassigned" no
        // longer matches what today's descriptor (card tail C#8516) derives.
        openIssueDerivedOwners: new Map([[old.id, "unassigned"]]),
        resolvedKeys: new Set(),
        now: NOW,
    });
    assert.deepEqual(blocking, [old.id], "a stale-owner undecided line is blocking");

    // Exactly what recordUndecidedBlocking does with a non-empty result.
    const cycle: SweepCycle = {
        id: "cycle-open-stale", epoch: "5", evidenceEpoch: "11",
        recognitionPolicy: "receipt-source-v1:off",
        plannerDay: "2026-09-22",
        undecidedLines: mergeUndecidedLines(undefined, blocking),
    };
    assert.equal(certifiedFor(cycle), false,
        "a cycle carrying a stale-owner undecided line from the open-issue pass must not certify");
});

test("an open-issue-pass line undecided with a fresh owner does not block certification", () => {
    const fresh = line({ id: "bl-open-issue-fresh", postedDate: "2026-07-14" });
    const blocking = blockingUndecidedLines({
        lines: [fresh],
        undecidedIds: [fresh.id],
        openIssueKeys: new Set([fresh.id]),
        // "CJ" is exactly what card tail C#8516 derives today — the stored
        // owner is current, so the open-issue exemption still holds.
        openIssueDerivedOwners: new Map([[fresh.id, "CJ"]]),
        resolvedKeys: new Set(),
        now: NOW,
    });
    assert.deepEqual(blocking, [], "a fresh-owner undecided line is not blocking");

    const cycle: SweepCycle = {
        id: "cycle-open-fresh", epoch: "5", evidenceEpoch: "11",
        recognitionPolicy: "receipt-source-v1:off",
        plannerDay: "2026-09-22",
        // recordUndecidedBlocking never merges when blocking is empty, but
        // merging an empty array is a no-op either way — assert both to make
        // that equivalence explicit.
        undecidedLines: mergeUndecidedLines(undefined, blocking),
    };
    assert.deepEqual(cycle.undecidedLines, [], "an empty blocking result leaves undecidedLines empty");
    assert.equal(certifiedFor(cycle), true,
        "a fresh-owner undecided line from the open-issue pass must not block an otherwise-certified cycle");
});
