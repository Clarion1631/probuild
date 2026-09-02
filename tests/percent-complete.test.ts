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
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: null, autoAtOverride: 10, manual: 60 }), false);
});

// No snapshot happens when the override was saved before the cron had ever
// produced an auto value. Returning false there would leave that job silently
// unreviewable forever — which is the case where the machine catching up
// matters MOST, because the human was working with no machine estimate at all.
test("no snapshot → drift falls back to comparing auto against the manual value", () => {
    assert.equal(
        percentCompleteNeedsReview({ source: "MANUAL", auto: 90, autoAtOverride: null, manual: 60 }),
        true
    );
    assert.equal(
        percentCompleteNeedsReview({ source: "MANUAL", auto: 63, autoAtOverride: null, manual: 60 }),
        false
    );
});

test("no snapshot: the fallback uses the same strictly-greater 5-point threshold", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 65, autoAtOverride: null, manual: 60 }), false);
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 65.01, autoAtOverride: null, manual: 60 }), true);
});

test("no snapshot AND no manual value → still nothing to compare", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 90, autoAtOverride: null, manual: null }), false);
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 90, autoAtOverride: null }), false);
});

test("a real snapshot always wins over the manual fallback", () => {
    // Snapshot says the auto value has not moved (60 → 62), even though the
    // manual value sits far away at 5. The snapshot is the baseline; no review.
    assert.equal(
        percentCompleteNeedsReview({ source: "MANUAL", auto: 62, autoAtOverride: 60, manual: 5 }),
        false
    );
});

test("drift of exactly 5.00 points does NOT flag a review", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 65, autoAtOverride: 60 }), false);
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 55, autoAtOverride: 60 }), false);
    assert.equal(PERCENT_COMPLETE_DRIFT_POINTS, 5);
});

test("drift of 5.01 points flags a review, in either direction", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 65.01, autoAtOverride: 60 }), true);
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 54.99, autoAtOverride: 60 }), true);
});

test("drift is measured against the auto SNAPSHOT, not the manual value", () => {
    // Manual 60 while auto has always read 20: the human simply disagrees with
    // the machine, which is the entire point of an override. Not a review.
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 20, autoAtOverride: 20 }), false);
});

test("reset to auto clears the review flag (source AUTO, snapshot null)", () => {
    assert.equal(percentCompleteNeedsReview({ source: "AUTO", auto: 82, autoAtOverride: null }), false);
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

test("unusable manual input is null, never 0 (0% is a claim, blank is not)", () => {
    assert.equal(normalizePercentCompleteInput(""), null);
    assert.equal(normalizePercentCompleteInput("abc"), null);
    assert.equal(normalizePercentCompleteInput(null), null);
    assert.equal(normalizePercentCompleteInput(undefined), null);
});
