import test from "node:test";
import assert from "node:assert/strict";
import { applyNoAttestationNotice, computeMealDeduction, settleDayPlan, stripSettlementNotes, NO_ATTESTATION_NOTE, countPunchedMeals, recordedMealAnswer, MEAL_DERIVED_NOTE } from "../src/lib/wa-breaks";
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

for (const answer of [false, true]) test(`a derived outcome is not the moved punch's answer (worked through: ${answer})`, () => {
 const a = entry("a", "07:00", "15:00");
 const b = entry("b", "15:00", "16:00");
 const firstA = settleDayPlan({entries:[a], closing:{id:"a",mealSkipped:answer}})[0];
 const combined = settleDayPlan({entries:[{...a,...firstA},b],closing:{id:"b",mealSkipped:undefined}});
 const storedB = {...b,...combined.find(row=>row.id==="b")};
 assert.equal(storedB.mealOutcome,answer ? "WORKED_THROUGH" : "AUTO_DEDUCTED");
 assert.equal(recordedMealAnswer(storedB),undefined);
 storedB.reviewReason = stripSettlementNotes(storedB.reviewReason);
 assert.match(storedB.reviewReason,new RegExp(MEAL_DERIVED_NOTE));
 const moved = {...storedB,startTime:new Date("2026-09-09T07:00:00-07:00"),endTime:new Date("2026-09-09T15:00:00-07:00")};
 const next = settleDayPlan({entries:[moved]})[0];
 assert.equal(next.paidHours,8);
 assert.equal(next.mealDeductionHours,0);
 assert.equal(next.mealOutcome,"MEAL_REVIEW");
 assert.equal(next.needsReview,true);
 assert.doesNotMatch(next.reviewReason ?? "",/Worker confirmed an uninterrupted/);
 const originalDayAgain = settleDayPlan({entries:[{...a,...firstA,...combined.find(row=>row.id==="a")} ]})[0];
 assert.equal(originalDayAgain.mealDeductionHours,answer ? 0 : 0.5,"the real answer stays on its original punch");
});



for (const answer of [false, true]) test(`an explicit owner answer replaces a derived marker (worked through: ${answer})`, () => {
 const row = entry("b","07:00","15:00",{mealOutcome:"AUTO_DEDUCTED",reviewReason:MEAL_DERIVED_NOTE});
 const notice = applyNoAttestationNotice({outcome:answer ? "WORKED_THROUGH" : "AUTO_DEDUCTED",mealSkipped:answer,existingReviewReason:row.reviewReason});
 const saved = {...row,...notice,mealOutcome:answer ? "WORKED_THROUGH" : "AUTO_DEDUCTED"};
 assert.equal(recordedMealAnswer(saved),answer);
 assert.doesNotMatch(saved.reviewReason ?? "",new RegExp(MEAL_DERIVED_NOTE));
 const plan = settleDayPlan({entries:[saved]})[0];
 assert.equal(plan.mealDeductionHours,answer ? 0 : 0.5);
});

test("an affirmative answer clears meal-only review while preserving independent review reasons", () => {
 for (const other of ["", "GPS requires review"]) {
  const notice = applyNoAttestationNotice({outcome:"MEAL_REVIEW",mealSkipped:undefined,existingReviewReason:other});
  const row = entry("a","07:00","15:00",{mealOutcome:"MEAL_REVIEW",reviewReason:notice.reviewReason});
  const plan = settleDayPlan({entries:[row],closing:{id:"a",mealSkipped:false}})[0];
  assert.equal(plan.mealDeductionHours,0.5);
  if (!other) assert.equal(plan.needsReview,false);
  else { assert.match(plan.reviewReason ?? "",/GPS requires review/); assert.notEqual(plan.needsReview,false); }
 }
});
