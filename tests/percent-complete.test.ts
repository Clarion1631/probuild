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
    assert.equal(computeAutoPercentComplete({ phases: [], uncodedBudget: 0 }), null);
});

test("phases exist but carry zero positive budget → null", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 0, totalTasks: 4, doneTasks: 4 })],
        uncodedBudget: 0,
    });
    assert.equal(result, null);
});

test("only uncoded budget → null, not 0%", () => {
    assert.equal(computeAutoPercentComplete({ phases: [], uncodedBudget: 50_000 }), null);
});

// ── (b) trust gate ──────────────────────────────────────────────────────────

test("coded budget below the 50% floor → null", () => {
    // 4,000 coded of 10,000 total = 40% coded.
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 2 })],
        uncodedBudget: 6_000,
    });
    assert.equal(result, null);
});

test("coded budget at EXACTLY the 50% floor → trusted, not null", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 5_000, totalTasks: 2, doneTasks: 2 })],
        uncodedBudget: 5_000,
    });
    assert.equal(result, 100);
});

test("the floor constant is the documented 50%", () => {
    assert.equal(CODED_BUDGET_TRUST_FLOOR, 0.5);
});

test("a NEGATIVE uncoded budget cannot shrink the denominator into fake coverage", () => {
    // Coded 4,000 against 6,000 uncoded is below the floor. If a -6,000 credit
    // on an uncoded line were netted in, the denominator would collapse and the
    // job would read "fully coded". Positive dollars on both sides prevents it.
    const belowFloor = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 1 })],
        uncodedBudget: 6_000,
    });
    assert.equal(belowFloor, null);

    const negativeUncoded = computeAutoPercentComplete({
        phases: [phase({ budget: 4_000, totalTasks: 2, doneTasks: 1 })],
        uncodedBudget: -6_000,
    });
    assert.equal(negativeUncoded, 50);
});

// ── (c)-(d) weighting ───────────────────────────────────────────────────────

test("one phase, every task Complete → 100", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 12_000, totalTasks: 5, doneTasks: 5 })],
        uncodedBudget: 0,
    });
    assert.equal(result, 100);
});

test("two phases 75/25 by budget, the big one done and the small one untouched → 75", () => {
    const result = computeAutoPercentComplete({
        phases: [
            phase({ costCodeId: "cc-demo", budget: 7_500, totalTasks: 3, doneTasks: 3 }),
            phase({ costCodeId: "cc-frame", budget: 2_500, totalTasks: 4, doneTasks: 0 }),
        ],
        uncodedBudget: 0,
    });
    assert.equal(result, 75);
});

test("partial progress inside a phase is weighted, not rounded to done/not-done", () => {
    const result = computeAutoPercentComplete({
        phases: [
            phase({ costCodeId: "cc-demo", budget: 5_000, totalTasks: 4, doneTasks: 1 }),
            phase({ costCodeId: "cc-frame", budget: 5_000, totalTasks: 2, doneTasks: 1 }),
        ],
        uncodedBudget: 0,
    });
    // 0.5 * 0.25 + 0.5 * 0.5 = 0.375
    assert.equal(result, 37.5);
});

// ── (e) task-less fallback ──────────────────────────────────────────────────

test("phase with no tasks but a daily-log mention counts as half started", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 0, hasDailyLogMention: true })],
        uncodedBudget: 0,
    });
    assert.equal(result, TASKLESS_PHASE_WITH_LOG_PROGRESS * 100);
    assert.equal(result, 50);
});

test("phase with no tasks and no mention counts as not started", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 0, hasDailyLogMention: false })],
        uncodedBudget: 0,
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
        uncodedBudget: 0,
    });
    const withCredit = computeAutoPercentComplete({
        phases: [
            phase({ costCodeId: "cc-demo", budget: 10_000, totalTasks: 4, doneTasks: 1 }),
            phase({ costCodeId: "cc-credit", budget: -4_000, totalTasks: 2, doneTasks: 2 }),
        ],
        uncodedBudget: 0,
    });
    assert.equal(withoutCredit, 25);
    assert.equal(withCredit, 25);
});

// ── (g) clamp + rounding ────────────────────────────────────────────────────

test("more done tasks than total tasks clamps at 100, never above", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 3, doneTasks: 9 })],
        uncodedBudget: 0,
    });
    assert.equal(result, 100);
});

test("result is rounded to 2 decimal places", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: 3, doneTasks: 1 })],
        uncodedBudget: 0,
    });
    // 1/3 → 33.333...% → 33.33
    assert.equal(result, 33.33);
});

test("non-finite task counts degrade to not-started rather than NaN", () => {
    const result = computeAutoPercentComplete({
        phases: [phase({ budget: 1_000, totalTasks: Number.NaN, doneTasks: Number.NaN })],
        uncodedBudget: 0,
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

test("a MANUAL project with no auto snapshot cannot drift (nothing to compare to)", () => {
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: 90, autoAtOverride: null }), false);
    assert.equal(percentCompleteNeedsReview({ source: "MANUAL", auto: null, autoAtOverride: 10 }), false);
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
