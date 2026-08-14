import { test } from "node:test";
import assert from "node:assert/strict";
import { requiresPhaseForClockIn, checkLogisticsClockOutNotes, applyMealSkippedWaiver } from "../src/lib/logistics-time-entry";

// ── requiresPhaseForClockIn ────────────────────────────────────────────────

test("normal project with no cost code or estimate item requires a phase", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: false, hasEstimateItem: false }),
        true
    );
});

test("normal project with a cost code does not require a phase", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: true, hasEstimateItem: false }),
        false
    );
});

test("normal project with an estimate item does not require a phase", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: false, hasCostCode: false, hasEstimateItem: true }),
        false
    );
});

test("logistics project never requires a phase, even with neither set", () => {
    assert.equal(
        requiresPhaseForClockIn({ isLogistics: true, hasCostCode: false, hasEstimateItem: false }),
        false
    );
});

// ── checkLogisticsClockOutNotes ────────────────────────────────────────────

test("not setting endTime -> always ok regardless of logistics/notes", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: false,
        existingNotes: null,
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, true);
});

test("non-logistics project clock-out -> ok even with no notes", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: false,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, true);
});

test("logistics clock-out with no existing notes and none supplied -> rejected", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, false);
});

test("logistics clock-out with only whitespace notes -> rejected", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: "   ",
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, false);
});

test("logistics clock-out with existing notes already on the entry -> ok, notes untouched", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: "Drove to shop, loaded materials",
        suppliedNotes: undefined,
    });
    assert.equal(result.ok, true);
    assert.equal(result.notes, undefined);
});

test("logistics clock-out with notes supplied in this request -> ok, notes trimmed for persistence", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: "  Picked up lumber from the yard  ",
    });
    assert.equal(result.ok, true);
    assert.equal(result.notes, "Picked up lumber from the yard");
});

test("logistics clock-out with only whitespace supplied notes -> rejected", () => {
    const result = checkLogisticsClockOutNotes({
        isLogistics: true,
        settingEndTime: true,
        existingNotes: null,
        suppliedNotes: "   ",
    });
    assert.equal(result.ok, false);
});

// ── applyMealSkippedWaiver ──────────────────────────────────────────────

const WAIVER_NOTE = "Worked through WA meal break (voluntary waiver recorded at clock-out)";

test("mealSkipped true on a clock-out persists it and sets needsReview + reviewReason", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: true,
        settingEndTime: true,
        existingReviewReason: null,
    });
    assert.deepEqual(result, { mealSkipped: true, needsReview: true, reviewReason: WAIVER_NOTE });
});

test("mealSkipped false on a clock-out persists false and does not touch needsReview/reviewReason", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: false,
        settingEndTime: true,
        existingReviewReason: null,
    });
    assert.deepEqual(result, { mealSkipped: false });
});

test("mealSkipped absent on a clock-out leaves everything untouched", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: undefined,
        settingEndTime: true,
        existingReviewReason: null,
    });
    assert.deepEqual(result, {});
});

test("non-boolean mealSkipped is ignored rather than coerced", () => {
    for (const value of ["true", 1, 0, "false", null, {}, []]) {
        const result = applyMealSkippedWaiver({
            mealSkipped: value,
            settingEndTime: true,
            existingReviewReason: null,
        });
        assert.deepEqual(result, {}, `expected no-op for ${JSON.stringify(value)}`);
    }
});

test("mealSkipped true appends to an existing reviewReason instead of clobbering it", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: true,
        settingEndTime: true,
        existingReviewReason: "Flagged for missing GPS ping",
    });
    assert.equal(result.reviewReason, `Flagged for missing GPS ping; ${WAIVER_NOTE}`);
});

test("mealSkipped true on a non-clock-out edit (settingEndTime: false) is ignored entirely", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: true,
        settingEndTime: false,
        existingReviewReason: null,
    });
    assert.deepEqual(result, {});
});

// ── applyMealSkippedWaiver idempotency ────────────────────────────────────

test("mealSkipped true repeated on an already-recorded waiver does not duplicate the reason", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: true,
        settingEndTime: true,
        existingReviewReason: WAIVER_NOTE,
    });
    assert.deepEqual(result, { mealSkipped: true, needsReview: true, reviewReason: WAIVER_NOTE });
});

test("mealSkipped true repeated alongside another reason does not duplicate the waiver note", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: true,
        settingEndTime: true,
        existingReviewReason: `Flagged for missing GPS ping; ${WAIVER_NOTE}`,
    });
    assert.deepEqual(result, {
        mealSkipped: true,
        needsReview: true,
        reviewReason: `Flagged for missing GPS ping; ${WAIVER_NOTE}`,
    });
});

test("mealSkipped false removes only the waiver reason, preserving another reason and its review flag", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: false,
        settingEndTime: true,
        existingReviewReason: `Flagged for missing GPS ping; ${WAIVER_NOTE}`,
    });
    assert.deepEqual(result, { mealSkipped: false, reviewReason: "Flagged for missing GPS ping" });
    assert.equal("needsReview" in result, false);
});

test("mealSkipped false removes the waiver reason and clears needsReview when nothing else justifies it", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: false,
        settingEndTime: true,
        existingReviewReason: WAIVER_NOTE,
    });
    assert.deepEqual(result, { mealSkipped: false, reviewReason: "", needsReview: false });
});

test("mealSkipped false with no waiver reason present leaves everything untouched (an unrelated reason isn't disturbed)", () => {
    const result = applyMealSkippedWaiver({
        mealSkipped: false,
        settingEndTime: true,
        existingReviewReason: "Flagged for missing GPS ping",
    });
    assert.deepEqual(result, { mealSkipped: false });
});
