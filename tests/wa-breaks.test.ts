import test from "node:test";
import assert from "node:assert/strict";
import {
    exceedsMaxShift,
    OVERLAP_NOTE,
    overlappingEntryIds,
    settleDayPlan,
    applyNoAttestationNotice,
    staleDeferredReview,
    STALE_DEFERRED_NOTE,
    applyRestBreakAttestation,
    NO_ATTESTATION_NOTE,
    unionHours,
    canApproveMealSkip,
    checkMealSkipDecision,
    computeMealDeduction,
    countPunchedMeals,
    mealSkipApproverEmails,
    mealsRequiredForDay,
    paidHoursAfterEdit,
    REST_MISSED_NOTE,
} from "../src/lib/wa-breaks";

const T = (hhmm: string) => new Date(`2026-08-31T${hhmm}:00.000-07:00`);
const span = (from: string, to: string, mealDeductionHours: number | null = null) => ({
    startTime: T(from),
    endTime: T(to),
    mealDeductionHours,
});

test("mealsRequiredForDay: >5h needs one, >11h needs two, 5:00 exactly needs none, 5:01 needs one", () => {
    assert.equal(mealsRequiredForDay(4), 0);
    assert.equal(mealsRequiredForDay(5), 0);
    assert.equal(mealsRequiredForDay(5 + 1 / 60), 1);
    assert.equal(mealsRequiredForDay(8), 1);
    assert.equal(mealsRequiredForDay(11), 1);
    assert.equal(mealsRequiredForDay(11.5), 2);
});

test("countPunchedMeals: a ≥25-min gap counts, a short gap or overlap does not, order does not matter", () => {
    assert.equal(countPunchedMeals([span("07:00", "12:00"), span("12:30", "16:00")]), 1);
    assert.equal(countPunchedMeals([span("12:30", "16:00"), span("07:00", "12:00")]), 1);
    assert.equal(countPunchedMeals([span("07:00", "12:00"), span("12:10", "16:00")]), 0);
    assert.equal(countPunchedMeals([span("07:00", "12:00"), span("11:50", "16:00")]), 0);
    assert.equal(countPunchedMeals([span("07:00", "12:00"), span("12:30", "17:00"), span("17:30", "20:00")]), 2);
});

test("short day: no meal required, full pay", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "11:30"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(r.outcome, "NOT_REQUIRED");
    assert.equal(r.mealDeductionHours, 0);
    assert.equal(r.paidHours, 4.5);
    assert.equal(r.shiftHours, 4.5);
});

test("5h59m single entry EXPECTS a meal and is auto-deducted 30 min with no attestation", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "12:59"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
    assert.equal(r.mealDeductionHours, 0.5);
    assert.ok(Math.abs(r.paidHours - (5 + 59 / 60 - 0.5)) < 1e-9);
});

test("8h day, no punch, no attestation → auto-deducted; laborable hours are 7.5", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "15:00"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
    assert.equal(r.paidHours, 7.5);
});

test("8h day, worker attests worked-through → no deduction (paid), outcome WORKED_THROUGH", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "15:00"), mealSkipped: true, mealSkipStatus: null });
    assert.equal(r.outcome, "WORKED_THROUGH");
    assert.equal(r.mealDeductionHours, 0);
    assert.equal(r.paidHours, 8);
});

test("8h day, manager-approved skip → no deduction, WAIVED_APPROVED, and approval outranks attestation", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "15:00"), mealSkipped: true, mealSkipStatus: "APPROVED" });
    assert.equal(r.outcome, "WAIVED_APPROVED");
    assert.equal(r.paidHours, 8);
});

test("PENDING or DENIED request does NOT excuse the deduction", () => {
    for (const status of ["PENDING", "DENIED"]) {
        const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "15:00"), mealSkipped: undefined, mealSkipStatus: status });
        assert.equal(r.outcome, "AUTO_DEDUCTED", status);
    }
});

test("punched meal (gap ≥25 min between the day's entries) satisfies the meal — no deduction", () => {
    const r = computeMealDeduction({
        dayEntries: [span("07:00", "12:00")],
        closing: span("12:30", "16:00"),
        mealSkipped: undefined,
        mealSkipStatus: null,
    });
    assert.equal(r.outcome, "PUNCHED");
    assert.equal(r.mealDeductionHours, 0);
    assert.equal(r.paidHours, 3.5);
});

test("Switch Task split (4h + 4h, 10-min gap) still owes ONE meal, deducted on the closing entry", () => {
    const r = computeMealDeduction({
        dayEntries: [span("07:00", "11:00")],
        closing: span("11:10", "15:10"),
        mealSkipped: undefined,
        mealSkipStatus: null,
    });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
    assert.equal(r.mealDeductionHours, 0.5);
    assert.equal(r.paidHours, 3.5);
});

test("a deduction already taken on an earlier entry today is not taken twice", () => {
    const r = computeMealDeduction({
        dayEntries: [span("07:00", "13:00", 0.5)],
        closing: span("13:05", "16:00"),
        mealSkipped: undefined,
        mealSkipStatus: null,
    });
    assert.equal(r.outcome, "PUNCHED");
    assert.equal(r.mealDeductionHours, 0);
});

test("11.5h day owes a SECOND meal; with one punched, the second is auto-deducted", () => {
    const r = computeMealDeduction({
        dayEntries: [span("06:00", "12:00")],
        closing: span("12:30", "18:00"),
        mealSkipped: undefined,
        mealSkipStatus: null,
    });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
    assert.equal(r.mealDeductionHours, 0.5);
    assert.equal(r.paidHours, 5);
});

test("11.5h in ONE entry, nothing punched → both meals (1.0h) deducted", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("06:00", "17:30"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
    assert.equal(r.mealDeductionHours, 1);
    assert.equal(r.paidHours, 10.5);
});

test("deduction is capped at the closing entry's own length — a 10-min closing punch never goes negative", () => {
    const r = computeMealDeduction({
        dayEntries: [span("07:00", "13:00")],
        closing: span("13:02", "13:12"),
        mealSkipped: undefined,
        mealSkipStatus: null,
    });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
    assert.ok(Math.abs(r.mealDeductionHours - 10 / 60) < 1e-9);
    assert.equal(r.paidHours, 0);
});

test("non-boolean mealSkipped is ignored (treated as no attestation)", () => {
    const r = computeMealDeduction({ dayEntries: [], closing: span("07:00", "15:00"), mealSkipped: "true", mealSkipStatus: null });
    assert.equal(r.outcome, "AUTO_DEDUCTED");
});

test("paidHoursAfterEdit keeps the stored deduction and never goes negative", () => {
    assert.equal(paidHoursAfterEdit(8, 0.5), 7.5);
    assert.equal(paidHoursAfterEdit(8, null), 8);
    assert.equal(paidHoursAfterEdit(0.25, 0.5), 0);
});

test("REVIEW #1: 'Clock out for lunch' at 5.5h is an intermediate close — DEFERRED, nothing deducted; the resumed half sees a PUNCHED meal", () => {
    const first = computeMealDeduction({ dayEntries: [], closing: span("06:30", "12:00"), mealSkipped: undefined, mealSkipStatus: null, deferMeal: true });
    assert.equal(first.outcome, "DEFERRED");
    assert.equal(first.mealDeductionHours, 0);
    assert.equal(first.paidHours, 5.5);
    const second = computeMealDeduction({ dayEntries: [span("06:30", "12:00", 0)], closing: span("12:30", "16:00"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(second.outcome, "PUNCHED");
    assert.equal(second.paidHours, 3.5);
});

test("REVIEW #1: Switch Task at 5h+ is DEFERRED; the final close settles the whole day (attestation honored)", () => {
    const mid = computeMealDeduction({ dayEntries: [], closing: span("07:00", "12:30"), mealSkipped: undefined, mealSkipStatus: null, deferMeal: true });
    assert.equal(mid.outcome, "DEFERRED");
    const finalAuto = computeMealDeduction({ dayEntries: [span("07:00", "12:30", 0)], closing: span("12:32", "15:30"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(finalAuto.outcome, "AUTO_DEDUCTED");
    assert.equal(finalAuto.mealDeductionHours, 0.5);
    const finalAttested = computeMealDeduction({ dayEntries: [span("07:00", "12:30", 0)], closing: span("12:32", "15:30"), mealSkipped: true, mealSkipStatus: null });
    assert.equal(finalAttested.outcome, "WORKED_THROUGH");
    assert.equal(finalAttested.mealDeductionHours, 0);
});

test("REVIEW #4: overlapping duplicate punches are merged — an 8h day with a duplicate row owes ONE meal, not two", () => {
    assert.equal(unionHours([span("07:00", "15:00"), span("07:00", "15:00")]), 8);
    assert.equal(unionHours([span("07:00", "12:00"), span("11:00", "15:00")]), 8);
    assert.equal(unionHours([span("07:00", "12:00"), span("12:30", "15:00")]), 7.5);
    const r = computeMealDeduction({ dayEntries: [span("07:00", "15:00", 0.5)], closing: span("07:00", "15:00"), mealSkipped: undefined, mealSkipStatus: null });
    assert.equal(r.outcome, "PUNCHED");
    assert.equal(r.mealDeductionHours, 0);
});

test("REVIEW #5: a deduction capped short by a tiny close leaves a REMAINDER, not a fresh full 30 minutes", () => {
    const tiny = computeMealDeduction({ dayEntries: [span("07:00", "13:00", 0)], closing: span("13:02", "13:12"), mealSkipped: undefined, mealSkipStatus: null });
    assert.ok(Math.abs(tiny.mealDeductionHours - 10 / 60) < 1e-9);
    const next = computeMealDeduction({
        dayEntries: [span("07:00", "13:00", 0), span("13:02", "13:12", 10 / 60)],
        closing: span("13:15", "16:00"),
        mealSkipped: undefined,
        mealSkipStatus: null,
    });
    assert.equal(next.outcome, "AUTO_DEDUCTED");
    assert.ok(Math.abs(next.mealDeductionHours - (0.5 - 10 / 60)) < 1e-9);
});

test("REVIEW #2 belt-and-braces: an AUTO_DEDUCTED close with no yes/no captured is flagged for review, once", () => {
    const first = applyNoAttestationNotice({ outcome: "AUTO_DEDUCTED", mealSkipped: undefined, existingReviewReason: null });
    assert.deepEqual(first, { needsReview: true, reviewReason: NO_ATTESTATION_NOTE });
    const again = applyNoAttestationNotice({ outcome: "AUTO_DEDUCTED", mealSkipped: undefined, existingReviewReason: NO_ATTESTATION_NOTE });
    assert.deepEqual(again, { needsReview: true });
    assert.deepEqual(applyNoAttestationNotice({ outcome: "AUTO_DEDUCTED", mealSkipped: false, existingReviewReason: null }), {});
    assert.deepEqual(applyNoAttestationNotice({ outcome: "PUNCHED", mealSkipped: undefined, existingReviewReason: null }), {});
});

test("rest attestation: true flags with the note once (idempotent), false removes it and clears only when nothing else remains", () => {
    const first = applyRestBreakAttestation({ restBreaksMissed: true, settingEndTime: true, existingReviewReason: null });
    assert.deepEqual(first, { restBreaksMissed: true, needsReview: true, reviewReason: REST_MISSED_NOTE });

    const again = applyRestBreakAttestation({ restBreaksMissed: true, settingEndTime: true, existingReviewReason: REST_MISSED_NOTE });
    assert.equal(again.reviewReason, REST_MISSED_NOTE);

    const composed = applyRestBreakAttestation({ restBreaksMissed: true, settingEndTime: true, existingReviewReason: "GPS off-site" });
    assert.equal(composed.reviewReason, `GPS off-site; ${REST_MISSED_NOTE}`);

    const cleared = applyRestBreakAttestation({ restBreaksMissed: false, settingEndTime: true, existingReviewReason: `GPS off-site; ${REST_MISSED_NOTE}` });
    assert.deepEqual(cleared, { restBreaksMissed: false, reviewReason: "GPS off-site" });

    const fullyCleared = applyRestBreakAttestation({ restBreaksMissed: false, settingEndTime: true, existingReviewReason: REST_MISSED_NOTE });
    assert.deepEqual(fullyCleared, { restBreaksMissed: false, reviewReason: "", needsReview: false });
});

test("rest attestation is a no-op on a plain edit or a non-boolean value", () => {
    assert.deepEqual(applyRestBreakAttestation({ restBreaksMissed: true, settingEndTime: false, existingReviewReason: null }), {});
    assert.deepEqual(applyRestBreakAttestation({ restBreaksMissed: "yes", settingEndTime: true, existingReviewReason: null }), {});
});

test("approver list: env overrides the default, case-insensitive; empty env falls back to the named defaults", () => {
    assert.deepEqual(mealSkipApproverEmails(""), [
        "cj@goldentouchremodeling.com",
        "rlord@goldentouchremodeling.com",
        "jadkins@goldentouchremodeling.com",
        "justin@constructionio.com",
    ]);
    assert.deepEqual(mealSkipApproverEmails(" A@x.com , b@X.com "), ["a@x.com", "b@x.com"]);
});

test("canApproveMealSkip: needs a manager/admin role AND an approver email", () => {
    const list = ["cj@goldentouchremodeling.com"];
    assert.equal(canApproveMealSkip({ role: "MANAGER", email: "CJ@goldentouchremodeling.com" }, list), true);
    assert.equal(canApproveMealSkip({ role: "FIELD_CREW", email: "cj@goldentouchremodeling.com" }, list), false);
    assert.equal(canApproveMealSkip({ role: "MANAGER", email: "office@goldentouchremodeling.com" }, list), false);
    assert.equal(canApproveMealSkip({ role: "ADMIN", email: null }, list), false);
});

test("checkMealSkipDecision: approval needs PENDING + open entry + signed waiver; denial only needs PENDING", () => {
    const signed = new Date("2026-08-29T00:00:00Z");
    assert.deepEqual(checkMealSkipDecision({ decision: "APPROVED", currentStatus: "PENDING", entryClosed: false, waiverSignedAt: signed }), { ok: true });
    assert.deepEqual(checkMealSkipDecision({ decision: "APPROVED", currentStatus: "PENDING", entryClosed: false, waiverSignedAt: null }), { ok: false, code: "WAIVER_NOT_SIGNED" });
    assert.deepEqual(checkMealSkipDecision({ decision: "APPROVED", currentStatus: "PENDING", entryClosed: true, waiverSignedAt: signed }), { ok: false, code: "ENTRY_CLOSED" });
    assert.deepEqual(checkMealSkipDecision({ decision: "APPROVED", currentStatus: "APPROVED", entryClosed: false, waiverSignedAt: signed }), { ok: false, code: "NOT_PENDING" });
    assert.deepEqual(checkMealSkipDecision({ decision: "DENIED", currentStatus: "PENDING", entryClosed: true, waiverSignedAt: null }), { ok: true });
});

test("REVIEW r2 #1: a DEFERRED close 2h+ old with no later entry is flagged on the next clock-in, once; fresh or settled closes are not", () => {
    const now = new Date("2026-08-10T20:00:00.000Z");
    const stale = { mealOutcome: "DEFERRED", endTime: new Date("2026-08-10T12:00:00.000Z"), needsReview: false, reviewReason: null };
    assert.deepEqual(staleDeferredReview({ latest: stale, now }), { needsReview: true, reviewReason: STALE_DEFERRED_NOTE });
    assert.equal(staleDeferredReview({ latest: { ...stale, reviewReason: STALE_DEFERRED_NOTE }, now }), null);
    assert.equal(staleDeferredReview({ latest: { ...stale, endTime: new Date("2026-08-10T19:00:00.000Z") }, now }), null);
    assert.equal(staleDeferredReview({ latest: { ...stale, mealOutcome: "AUTO_DEDUCTED" }, now }), null);
    assert.equal(staleDeferredReview({ latest: null, now }), null);
});

const E = (id: string, from: string, to: string, extra: Partial<{ mealOutcome: string | null; mealSkipStatus: string | null; reviewReason: string | null }> = {}) => ({
    id,
    startTime: T(from),
    endTime: T(to),
    mealOutcome: extra.mealOutcome ?? null,
    mealSkipStatus: extra.mealSkipStatus ?? null,
    reviewReason: extra.reviewReason ?? null,
});

test("settleDayPlan: single 8h entry, took lunch → AUTO_DEDUCTED 0.5 on it, paid 7.5, no flag", () => {
    const plan = settleDayPlan({ entries: [E("a", "07:00", "15:00")], closing: { id: "a", mealSkipped: false } });
    assert.deepEqual(plan, [{ id: "a", shiftHours: 8, mealDeductionHours: 0.5, paidHours: 7.5, mealOutcome: "AUTO_DEDUCTED" }]);
});

test("settleDayPlan: REFUND — an earlier row deducted at its close is refunded once a later punched meal covers the day", () => {
    const plan = settleDayPlan({
        entries: [E("a", "06:30", "12:00", { mealOutcome: "AUTO_DEDUCTED" }), E("b", "12:30", "16:00")],
        closing: { id: "b", mealSkipped: undefined },
    });
    assert.deepEqual(plan.map((u) => [u.id, u.mealDeductionHours, u.mealOutcome]), [["a", 0, "DEFERRED"], ["b", 0, "PUNCHED"]]);
});

test("settleDayPlan: Switch Task day (3h + 3h, 5-min gap) owes one meal on the LAST row; unanswered → flagged there", () => {
    const plan = settleDayPlan({ entries: [E("a", "07:00", "10:00"), E("b", "10:05", "13:05")], closing: { id: "b", mealSkipped: undefined } });
    const b = plan.find((u) => u.id === "b")!;
    assert.equal(b.mealOutcome, "AUTO_DEDUCTED");
    assert.equal(b.mealDeductionHours, 0.5);
    assert.equal(b.needsReview, true);
    assert.ok(b.reviewReason?.includes("no lunch answer"));
    assert.equal(plan.find((u) => u.id === "a")!.mealDeductionHours, 0);
});

test("settleDayPlan: the closing request's fresh answer wins; a stored WORKED_THROUGH on any row makes the day WORKED_THROUGH", () => {
    const fresh = settleDayPlan({ entries: [E("a", "07:00", "15:00")], closing: { id: "a", mealSkipped: true } });
    assert.equal(fresh[0].mealOutcome, "WORKED_THROUGH");
    assert.equal(fresh[0].mealDeductionHours, 0);
    const stored = settleDayPlan({ entries: [E("a", "07:00", "12:00", { mealOutcome: "WORKED_THROUGH" }), E("b", "12:05", "15:00")], closing: null });
    assert.equal(stored.find((u) => u.id === "b")!.mealOutcome, "WORKED_THROUGH");
});

test("settleDayPlan: an APPROVED skip anywhere in the day → WAIVED_APPROVED, nothing deducted, no flag", () => {
    const plan = settleDayPlan({ entries: [E("a", "07:00", "11:00", { mealSkipStatus: "APPROVED" }), E("b", "11:05", "15:00")], closing: { id: "b", mealSkipped: undefined } });
    const b = plan.find((u) => u.id === "b")!;
    assert.equal(b.mealOutcome, "WAIVED_APPROVED");
    assert.equal(b.mealDeductionHours, 0);
    assert.equal(b.needsReview, undefined);
});

test("settleDayPlan: a short last row spills the deduction backwards; a sibling shortened below 5h drops it entirely", () => {
    const spill = settleDayPlan({ entries: [E("a", "07:00", "13:00"), E("b", "13:02", "13:12")], closing: { id: "b", mealSkipped: false } });
    assert.ok(Math.abs(spill.find((u) => u.id === "b")!.mealDeductionHours - 10 / 60) < 1e-9);
    assert.ok(Math.abs(spill.find((u) => u.id === "a")!.mealDeductionHours - (0.5 - 10 / 60)) < 1e-9);
    const shrunk = settleDayPlan({ entries: [E("a", "07:00", "09:00"), E("b", "09:05", "11:30", { mealOutcome: "AUTO_DEDUCTED" })], closing: null });
    assert.deepEqual(shrunk.map((u) => [u.id, u.mealDeductionHours, u.mealOutcome]), [["a", 0, "DEFERRED"], ["b", 0, "NOT_REQUIRED"]]);
});

test("settleDayPlan: 11.5h with one punched meal owes the second on the last row", () => {
    const plan = settleDayPlan({ entries: [E("a", "06:00", "12:00"), E("b", "12:30", "18:00")], closing: { id: "b", mealSkipped: false } });
    assert.equal(plan.find((u) => u.id === "b")!.mealDeductionHours, 0.5);
    assert.equal(plan.find((u) => u.id === "b")!.paidHours, 5);
});

test("settleDayPlan (r3): a closing answer for a row NOT on this day is ignored — the day's last row still gets the no-answer flag", () => {
    const plan = settleDayPlan({ entries: [E("a", "07:00", "10:00"), E("b", "10:05", "13:05")], closing: { id: "moved-away", mealSkipped: false } });
    assert.equal(plan.find((u) => u.id === "b")!.needsReview, true);
});

test("settleDayPlan (r3): a re-plan that no longer owes an unanswered deduction retires the settlement notes and clears the flag only when nothing else remains", () => {
    const refunded = settleDayPlan({
        entries: [E("a", "06:30", "12:00", { mealOutcome: "AUTO_DEDUCTED", reviewReason: NO_ATTESTATION_NOTE }), E("b", "12:30", "16:00")],
        closing: null,
    });
    assert.deepEqual(refunded.find((u) => u.id === "a")!.reviewReason, "");
    assert.equal(refunded.find((u) => u.id === "a")!.needsReview, false);
    const keepsOthers = settleDayPlan({
        entries: [E("a", "06:30", "12:00", { mealOutcome: "AUTO_DEDUCTED", reviewReason: `GPS off-site; ${NO_ATTESTATION_NOTE}` }), E("b", "12:30", "16:00")],
        closing: null,
    });
    assert.equal(keepsOthers.find((u) => u.id === "a")!.reviewReason, "GPS off-site");
    assert.equal(keepsOthers.find((u) => u.id === "a")!.needsReview, undefined);
});

test("staleDeferredReview (codex r3 #3): a DEFERRED close on a DIFFERENT company day is stale even if under 2h old", () => {
    const now = new Date("2026-08-11T07:30:00.000Z");
    const late = { mealOutcome: "DEFERRED", endTime: new Date("2026-08-11T06:30:00.000Z"), needsReview: false, reviewReason: null };
    assert.equal(staleDeferredReview({ latest: late, now, latestDayKey: "2026-08-10", todayKey: "2026-08-10" }), null);
    assert.deepEqual(staleDeferredReview({ latest: late, now, latestDayKey: "2026-08-10", todayKey: "2026-08-11" }), { needsReview: true, reviewReason: STALE_DEFERRED_NOTE });
});

test("settleDayPlan (codex r3 #5): two rows ending at the same instant — flag and deduction land on the SAME row", () => {
    const plan = settleDayPlan({ entries: [E("a", "07:00", "15:00"), E("b", "14:00", "15:00")], closing: null });
    // Both rows overlap (so both carry OVERLAP_NOTE); the NO-ANSWER note and the deduction must share one row.
    const flagged = plan.filter((u) => (u.reviewReason ?? "").includes(NO_ATTESTATION_NOTE));
    const deducted = plan.filter((u) => u.mealDeductionHours > 0);
    assert.equal(flagged.length, 1);
    assert.equal(deducted.length, 1);
    assert.equal(flagged[0].id, deducted[0].id);
});

test("codex r6 #1: overlapping duplicate rows are BOTH flagged with the overlap note; abutting rows are not", () => {
    const dup = settleDayPlan({ entries: [E("a", "07:00", "15:00"), E("b", "07:00", "15:00")], closing: { id: "b", mealSkipped: false } });
    for (const u of dup) {
        assert.equal(u.needsReview, true, u.id);
        assert.ok(u.reviewReason?.includes(OVERLAP_NOTE), u.id);
    }
    assert.deepEqual([...overlappingEntryIds([E("a", "07:00", "12:00"), E("b", "12:00", "15:00")])], []);
    const clean = settleDayPlan({ entries: [E("a", "07:00", "12:00", { reviewReason: OVERLAP_NOTE }), E("b", "12:30", "15:00")], closing: null });
    assert.equal(clean.find((u) => u.id === "a")!.reviewReason, "");
    assert.equal(clean.find((u) => u.id === "a")!.needsReview, false);
});

test("codex r6 #3: a derived WAIVED_APPROVED outcome is NOT approval evidence — only mealSkipStatus APPROVED is", () => {
    const plan = settleDayPlan({ entries: [E("a", "07:00", "11:00", { mealOutcome: "WAIVED_APPROVED" }), E("b", "11:05", "15:00")], closing: { id: "b", mealSkipped: false } });
    assert.equal(plan.find((u) => u.id === "b")!.mealOutcome, "AUTO_DEDUCTED");
    assert.equal(plan.find((u) => u.id === "b")!.mealDeductionHours, 0.5);
});

test("exceedsMaxShift (codex r8 #4): exactly 24h is allowed, 24h + 1 min is not; a normal overnight shift passes", () => {
    const start = new Date("2026-08-10T15:00:00.000Z");
    assert.equal(exceedsMaxShift(start, new Date(start.getTime() + 24 * 3_600_000)), false);
    assert.equal(exceedsMaxShift(start, new Date(start.getTime() + 24 * 3_600_000 + 60_000)), true);
    assert.equal(exceedsMaxShift(new Date("2026-08-10T22:00:00-07:00"), new Date("2026-08-11T06:30:00-07:00")), false);
    // The incident: 8:51 AM -> next-day 7:50 PM
    assert.equal(exceedsMaxShift(new Date("2026-08-18T08:51:00-07:00"), new Date("2026-08-19T19:50:00-07:00")), true);
});
