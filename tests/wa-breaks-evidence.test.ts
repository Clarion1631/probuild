import test from "node:test";
import assert from "node:assert/strict";
import { applyNoAttestationNotice, computeMealDeduction, settleDayPlan, stripSettlementNotes, NO_ATTESTATION_NOTE, countPunchedMeals } from "../src/lib/wa-breaks";
const entry = (id: string, start: string, end: string, extra = {}) => ({ id, startTime: new Date(`2026-09-08T${start}:00-07:00`), endTime: new Date(`2026-09-08T${end}:00-07:00`), mealDeductionHours: 0, mealOutcome: null, mealSkipStatus: null, reviewReason: null, ...extra });
test("missing and malformed answers pay the full shift and require review", () => {
 for (const mealSkipped of [undefined, null, "false"]) {
  const result = computeMealDeduction({dayEntries: [], closing: entry("a", "07:00", "15:00"), mealSkipped, mealSkipStatus: null});
  assert.equal(result.paidHours, 8);
  const plan = settleDayPlan({entries: [entry("a", "07:00", "15:00")], closing: {id: "a", mealSkipped}});
  assert.equal(plan[0].paidHours, 8); assert.equal(plan[0].needsReview, true);
 }
});
test("generic review never manufactures affirmative evidence from a legacy unanswered deduction", () => {
 const reviewReason = stripSettlementNotes(NO_ATTESTATION_NOTE);
 const plan = settleDayPlan({entries: [entry("a", "07:00", "15:00", {mealOutcome: "AUTO_DEDUCTED", reviewReason})]});
 assert.equal(plan[0].paidHours, 8); assert.equal(plan[0].needsReview, true);
});
test("a gap alone is not meal evidence; 25 and 29 minutes are not full meals", () => {
 for (const minute of [25, 29]) assert.equal(countPunchedMeals([entry("a", "07:00", "12:00"), entry("b", `12:${minute}`, "16:00")]), 0);
 const plan = settleDayPlan({entries: [entry("a", "07:00", "12:00"), entry("b", "12:30", "16:00")]});
 assert.equal(plan[1].needsReview, true); assert.notEqual(plan[1].mealOutcome, "PUNCHED");
});
test("long shifts need additional-meal review rather than a second automatic deduction", () => {
 const plan = settleDayPlan({entries: [entry("a", "06:00", "18:00")], closing:{id:"a",mealSkipped:false}});
 assert.equal(plan[0].mealDeductionHours, 0); assert.equal(plan[0].needsReview, true);
});
test("worked-through answer remains paid even with approval and a gap", () => {
 const plan = settleDayPlan({entries: [entry("a", "07:00", "12:00", {mealSkipStatus:"APPROVED"}), entry("b", "12:30", "16:00")],closing:{id:"b",mealSkipped:true}});
 assert.equal(plan[1].mealOutcome, "WORKED_THROUGH"); assert.equal(plan[1].mealDeductionHours,0);
});

test("confirmed punched meal evidence survives settlement and generic review without a later double deduction", () => {
 const original = [entry("a", "07:00", "12:00"), entry("b", "12:30", "16:00")];
 const first = settleDayPlan({entries: original, closing: {id:"b", mealSkipped:false}});
 const stored = original.map(row => ({...row, ...first.find(update => update.id === row.id), reviewReason: stripSettlementNotes(first.find(update => update.id === row.id)?.reviewReason)}));
 const next = settleDayPlan({entries: stored});
 assert.equal(next[1].mealOutcome,"PUNCHED"); assert.equal(next[1].mealDeductionHours,0); assert.notEqual(next[1].needsReview,true);
});

test("repeated settlement after refunding a legacy unanswered deduction stays paid", () => {
 const row = entry("a", "07:00", "15:00", {mealOutcome:"AUTO_DEDUCTED", reviewReason:NO_ATTESTATION_NOTE});
 const first = settleDayPlan({entries:[row]})[0];
 const second = settleDayPlan({entries:[{...row,...first,reviewReason:stripSettlementNotes(first.reviewReason)}]})[0];
 assert.equal(second.paidHours,8);assert.equal(second.needsReview,true);
});


test("approved waiver does not erase an explicit taken-meal answer if approval later changes", () => {
 const evidence = applyNoAttestationNotice({outcome:"WAIVED_APPROVED",mealSkipped:false,existingReviewReason:null});
 const plan = settleDayPlan({entries:[entry("a","07:00","12:00"),entry("b","12:30","16:00",{mealOutcome:"WAIVED_APPROVED",mealSkipStatus:"DENIED",reviewReason:evidence.reviewReason})]});
 assert.equal(plan[1].mealOutcome,"PUNCHED");assert.equal(plan[1].mealDeductionHours,0);
});
