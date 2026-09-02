/**
 * Percent-complete formula rules (src/lib/percent-complete.ts).
 *
 * Pure module, so these are plain table tests — no Prisma, no `mock.module()`
 * (CI pins Node 20, where mock.module corrupts the require chain; see
 * tests/job-variance-db.test.ts for the require()-patch pattern used where a
 * fake IS needed).
 *
 * The rules that actually matter, and why each has a case here:
 *   - The TRUST GATE. Weights come from the estimate's coded budget. On a
 *     sparsely coded estimate they describe a sliver of the job, so the answer
 *     is null, not a confident number. Exactly at the floor is trusted.
 *   - Negative-budget phases carry ZERO weight, so a credit line cannot drag
 *     the whole job's percentage around.
 *   - The task-less fallback is a coarse convention (half), not a measurement.
 *   - Drift is measured against the AUTO SNAPSHOT taken at override time, never
 *     against the manual value itself — otherwise disagreeing with the machine
 *     would instantly flag itself for review.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    CODED_BUDGET_TRUST_FLOOR,
    PERCENT_COMPLETE_DRIFT_POINTS,
    TASKLESS_PHASE_WITH_LOG_PROGRESS,
    computeAutoPercentComplete,
    normalizePercentCompleteInput,
    percentCompleteNeedsReview,
    phaseProgress,
    phasesMentionedInLogs,
    formatPercentCompleteDate,
    percentCompleteDraftValue,
} from "../src/lib/percent-complete";

function phase(over: Partial<Parameters<typeof phaseProgress>[0]> & { costCodeId?: string; budget?: number } = {}) {
    return {
        costCodeId: over.costCodeId ?? "cc-1",
        budget: over.budget ?? 1000,
        totalTasks: over.totalTasks ?? 0,
        doneTasks: over.doneTasks ?? 0,
        hasDailyLogMention: over.hasDailyLogMention ?? false,
    };
}

// ── (a) nothing to weight ───────────────────────────────────────────────────

test("no phases at all → null (a job with no eligible estimate has no percent)", () => {
    assert.equal(computeAutoPercentComplete({ phases: [], uncodedPositiveBudget: 0 }), null);
});

test("phases exist but carry zero positive budget → null", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 0, totalTasks: 4, doneTasks: 4 })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, null);
});

test("only uncoded budget → null, not 0%", () => {
    assert.equal(computeAutoPercentComplete({ phases: [], uncodedPositiveBudget: 50_000 }), null);
});

// ── (b) trust gate ──────────────────────────────────────────────────────────

test("coded budget below the 50% floor → null", () => {
    // 4,000 coded of 10,000 total = 40% coded.
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 2 })],
        uncodedPositiveBudget: 6_000,
    });
    assert.equal(result, null);
});

test("coded budget at EXACTLY the 50% floor → trusted, not null", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 5_000, totalTasks: 2, doneTasks: 2 })],
        uncodedPositiveBudget: 5_000,
    });
    assert.equal(result, 100);
});

test("the floor constant is the documented 50%", () => {
    assert.equal(CODED_BUDGET_TRUST_FLOOR, 0.5);
});

test("the gate takes GROSS uncoded dollars, so a credit cannot net away a hole", () => {
    // The caller passes ProjectVariance.uncodedPositiveBudget, which sums the
    // uncoded rows over positive dollars only. On a job with $4,000 coded and a
    // mixed +$6,000 / -$6,000 uncoded pair, the NET is $0 -- which would report
    // a two-thirds-uncoded estimate as fully coded and wave the weighting
    // through. The gross figure is $6,000 and the gate correctly refuses.
    const gross = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 1 })],
        uncodedPositiveBudget: 6_000,
    });
    assert.equal(gross, null);

    // What the NET would have produced, for contrast -- this is the bug.
    const netted = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 1 })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(netted, 50);
});

test("a garbage negative uncoded figure still degrades safely to zero", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 1 })],
        uncodedPositiveBudget: -6_000,
    });
    assert.equal(result, 50);
});

// ── (c)-(d) weighting ───────────────────────────────────────────────────────

test("one phase, every task Complete → 100", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 12_000, totalTasks: 5, doneTasks: 5 })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, 100);
});

test("two phases 75/25 by budget, the big one done and the small one untouched → 75", () => {
    const result = computeAutoPercentComplete({
        phases: [
            phase({ costCodeId: "cc-demo", budget: 7_500, totalTasks: 3, doneTasks: 3 }),
            phase({ costCodeId: "cc-frame", budget: 2_500, totalTasks: 4, doneTasks: 0 }),
        ],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, 75);
});

test("partial progress inside a phase is weighted, not rounded to done/not-done", () => {
    const result = computeAutoPercentComplete({
        phases: [
            phase({ costCodeId: "cc-demo", budget: 5_000, totalTasks: 4, doneTasks: 1 }),
            phase({ costCodeId: "cc-frame", budget: 5_000, totalTasks: 2, doneTasks: 1 }),
        ],
        uncodedPositiveBudget: 0,
    });
    // 0.5 * 0.25 + 0.5 * 0.5 = 0.375
    assert.equal(result, 37.5);
});

// ── (e) task-less fallback ──────────────────────────────────────────────────

test("phase with no tasks but a daily-log mention counts as half started", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 0, hasDailyLogMention: true })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, TASKLESS_PHASE_WITH_LOG_PROGRESS * 100);
    assert.equal(result, 50);
});

test("phase with no tasks and no mention counts as not started", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 0, hasDailyLogMention: false })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, 0);
});

test("a daily-log mention never overrides real task counts", () => {
    // The phase HAS tasks, none complete. The mention must not promote it to 50%.
    assert.equal(phaseProgress({ totalTasks: 4, doneTasks: 0, hasDailyLogMention: true }), 0);
});

// ── (f) negative budgets ────────────────────────────────────────────────────

test("a negative-budget phase carries zero weight and cannot move the result", () => {
    const withoutCredit = computeAutoPercentComplete({
        phases: [phase({ costCodeId: "cc-demo", budget: 10_000, totalTasks: 4, doneTasks: 1 })],
        uncodedPositiveBudget: 0,
    });
    const withCredit = computeAutoPercentComplete({
        phases: [
            phase({ costCodeId: "cc-demo", budget: 10_000, totalTasks: 4, doneTasks: 1 }),
            phase({ costCodeId: "cc-credit", budget: -4_000, totalTasks: 2, doneTasks: 2 }),
        ],
        uncodedPositiveBudget: 0,
    });
    assert.equal(withoutCredit, 25);
    assert.equal(withCredit, 25);
});

// ── (g) clamp + rounding ────────────────────────────────────────────────────

test("more done tasks than total tasks clamps at 100, never above", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 3, doneTasks: 9 })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, 100);
});

test("result is rounded to 2 decimal places", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 3, doneTasks: 1 })],
        uncodedPositiveBudget: 0,
    });
    // 1/3 → 33.333...% → 33.33
    assert.equal(result, 33.33);
});

test("non-finite task counts degrade to not-started rather than NaN", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: Number.NaN, doneTasks: Number.NaN })],
        uncodedPositiveBudget: 0,
    });
    assert.equal(result, 0);
});

// ── override / drift ────────────────────────────────────────────────────────

test("an AUTO project never needs review, however far the auto value moved", () => {
    assert.equal(
        percentCompleteNeedsReview({ source: "AUTO", auto: 90, autoAtOverride: 10 }),
        false
    );
});

test("no auto value at all → nothing to review, whatever the snapshot says", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: null, autoAtOverride: 10 }), false);
});

// A null baseline means the override predates the first auto value. It does NOT
// stay null: the nightly recalc seeds it, atomically in the same UPDATE, the
// first time it computes a real auto value for a manually-overridden job (see
// the seeding tests in tests/percent-complete-recalc-race.test.ts). So "no
// review yet" here is a statement about ordering, not a permanent blind spot.
test("no baseline yet → no review; the recalc seeds one rather than guessing", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 90, autoAtOverride: null }), false);
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 63, autoAtOverride: null }), false);
});

test("drift is ALWAYS auto-vs-auto, never auto-vs-manual", () => {
    // Both cases sit against a manual value of 60, which is deliberately not an
    // input to the rule at all.
    // 64 → 58 is SIX points of drift and must flag, even though it lands only
    // two points away from the manual value.
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 58, autoAtOverride: 64 }), true);
    // 62 → 66 is FOUR points of drift and must not flag, even though it sits
    // six points away from the manual value.
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 66, autoAtOverride: 62 }), false);
});

test("reset to auto clears the review flag (source AUTO, snapshot null)", () => {
    assert.equal(percentCompleteNeedsReview({ source: "AUTO", auto: 82, autoAtOverride: null }), false);
});

// ── override date formatting (time zone) ────────────────────────────────────

const PACIFIC = "America/Los_Angeles";

test("an evening Pacific override keeps its Pacific date, not the UTC next day", () => {
    // 2026-08-25 17:30 Pacific is 2026-08-26 00:30 UTC. The Monday card renders
    // on Vercel, whose local zone IS UTC, so the ambient getters reported 8/26
    // for an override the owner made on the 25th.
    const instant = new Date("2026-08-26T00:30:00Z");
    assert.equal(formatPercentCompleteDate(instant, PACIFIC), "8/25");
    assert.equal(formatPercentCompleteDate(instant, "UTC"), "8/26");
});

test("just after Pacific midnight rolls the date forward", () => {
    // 2026-08-26 00:15 Pacific = 07:15 UTC — same calendar day in both, and the
    // pair above plus this one bracket the boundary from either side.
    const instant = new Date("2026-08-26T07:15:00Z");
    assert.equal(formatPercentCompleteDate(instant, PACIFIC), "8/26");
});

test("the last second before Pacific midnight is still the earlier day", () => {
    // 2026-08-25 23:59:59 Pacific = 2026-08-26 06:59:59 UTC.
    assert.equal(formatPercentCompleteDate(new Date("2026-08-26T06:59:59Z"), PACIFIC), "8/25");
});

test("the date is DST-correct across a fall-back boundary", () => {
    // 2026-11-01 is the US DST end. 2026-11-01 18:00 Pacific (PST, UTC-8) is
    // 2026-11-02 02:00 UTC — a fixed -7 offset would have answered 11/1 here by
    // luck and 11/2 an hour later; the zone-aware formatter is right either way.
    assert.equal(formatPercentCompleteDate(new Date("2026-11-02T02:00:00Z"), PACIFIC), "11/1");
});

test("an ISO string and a Date give the same answer", () => {
    assert.equal(
        formatPercentCompleteDate("2026-08-26T00:30:00Z", PACIFIC),
        formatPercentCompleteDate(new Date("2026-08-26T00:30:00Z"), PACIFIC)
    );
});

test("no timestamp, or an unparseable one, formats to null rather than a fake date", () => {
    assert.equal(formatPercentCompleteDate(null, PACIFIC), null);
    assert.equal(formatPercentCompleteDate(undefined, PACIFIC), null);
    assert.equal(formatPercentCompleteDate("not a date", PACIFIC), null);
});

test("the month and day carry no leading zeros", () => {
    assert.equal(formatPercentCompleteDate(new Date("2026-01-05T18:00:00Z"), PACIFIC), "1/5");
});

// ── daily-log phase evidence (the task-less fallback) ───────────────────────

const PHASES = [
    { costCodeId: "cc-demo", code: "01-DEMO", name: "Demolition" },
    { costCodeId: "cc-elec", code: "04-ELEC", name: "Electrical" },
    { costCodeId: "cc-anon", code: "N/A", name: "Unbudgeted phase" },
];

test("a log naming a phase's cost code counts as evidence", () => {
    const found = phasesMentionedInLogs(["Started 04-ELEC rough-in today."], PHASES);
    assert.deepEqual([...found], ["cc-elec"]);
});

test("a log naming a phase by NAME counts too", () => {
    const found = phasesMentionedInLogs(["Demolition of the back wall finished."], PHASES);
    assert.deepEqual([...found], ["cc-demo"]);
});

test("matching is case-insensitive and spans several logs", () => {
    const found = phasesMentionedInLogs(["demolition started", "then ELECTRICAL rough-in"], PHASES);
    assert.deepEqual([...found].sort(), ["cc-demo", "cc-elec"]);
});

test("a phase nobody wrote about is not evidence", () => {
    const found = phasesMentionedInLogs(["Framing and cleanup."], PHASES);
    assert.equal(found.size, 0);
});

test("partial words do not match — 04-ELEC is not found inside a longer token", () => {
    const found = phasesMentionedInLogs(["ordered 04-ELECTRICALPANEL parts"], PHASES);
    assert.equal(found.has("cc-elec"), false);
});

test("anonymous placeholder phases are never matched", () => {
    // "Unbudgeted phase" / "N/A" are labels job-variance invents for a cost code
    // it could not name. Matching them would attach evidence to whichever phase
    // happened to be anonymous.
    const found = phasesMentionedInLogs(["N/A unbudgeted phase work"], PHASES);
    assert.equal(found.has("cc-anon"), false);
});

test("empty or blank logs produce no evidence", () => {
    assert.equal(phasesMentionedInLogs([], PHASES).size, 0);
    assert.equal(phasesMentionedInLogs(["", null, undefined, "   "], PHASES).size, 0);
});

test("a cost code containing regex metacharacters is matched literally", () => {
    const found = phasesMentionedInLogs(
        ["worked on 01+DEMO today"],
        [{ costCodeId: "cc-x", code: "01+DEMO", name: "Demo" }]
    );
    assert.equal(found.has("cc-x"), true);
    const notFound = phasesMentionedInLogs(
        ["worked on 01XDEMO today"],
        [{ costCodeId: "cc-x", code: "01+DEMO", name: "Demo" }]
    );
    assert.equal(notFound.has("cc-x"), false);
});

// ── manual input normalization ──────────────────────────────────────────────

test("manual input is clamped 0-100 and rounded to 2dp", () => {
    assert.equal(normalizePercentCompleteInput(60), 60);
    assert.equal(normalizePercentCompleteInput("60.5"), 60.5);
    assert.equal(normalizePercentCompleteInput(140), 100);
    assert.equal(normalizePercentCompleteInput(-3), 0);
    assert.equal(normalizePercentCompleteInput(33.336), 33.34);
});

// The edit box must be re-seeded from what the server STORED, or a clamped save
// leaves the input reading 140 beside a card reading 100% -- and the wrong one
// is the editable one. There is no DOM harness in this repo (no jsdom, no
// testing-library), so the round trip is covered at its seam: the exact
// normalization the action applies, then the exact string the input is re-seeded
// with. The component calls both of these and nothing else.
test("a clamped save re-seeds the input with the STORED value, not the typed one", () => {
    const typed = "140";
    const stored = normalizePercentCompleteInput(typed);
    assert.equal(stored, 100);
    assert.equal(percentCompleteDraftValue(stored), "100");
});

test("a rounded save re-seeds with the rounded value", () => {
    const stored = normalizePercentCompleteInput("33.336");
    assert.equal(stored, 33.34);
    assert.equal(percentCompleteDraftValue(stored), "33.34");
});

test("a below-range save re-seeds at zero", () => {
    const stored = normalizePercentCompleteInput("-3");
    assert.equal(stored, 0);
    assert.equal(percentCompleteDraftValue(stored), "0");
});

test("resetting to an auto value of null empties the box rather than writing \"null\"", () => {
    assert.equal(percentCompleteDraftValue(null), "");
    assert.equal(percentCompleteDraftValue(undefined), "");
});

test("an in-range save re-seeds with itself", () => {
    const stored = normalizePercentCompleteInput("60");
    assert.equal(percentCompleteDraftValue(stored), "60");
});

test("unusable manual input is null, never 0 (0% is a claim, blank is not)", () => {
    assert.equal(normalizePercentCompleteInput(""), null);
    assert.equal(normalizePercentCompleteInput("abc"), null);
    assert.equal(normalizePercentCompleteInput(null), null);
    assert.equal(normalizePercentCompleteInput(undefined), null);
});
