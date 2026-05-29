/**
 * Labor-cost engine — single source of truth for turning a clock-in/out window into
 * payable hours and costed dollars, applying Washington State L&I meal-break rules.
 *
 * WA L&I (WAC 296-126-092): employees working MORE THAN 5 hours are entitled to a 30-minute
 * meal period, which is UNPAID when the employee is fully relieved of duty. Rest breaks
 * (10 min per 4h) are PAID and are NOT deducted here. If the worker attests the meal was
 * skipped/interrupted, the time is PAID (no deduction) and the entry is flagged for a
 * manager to verify (a missed/interrupted meal can carry premium/owed pay).
 *
 * `durationHours` is stored as PAYABLE hours (after any meal deduction); the deduction is
 * recorded separately so gross = payable + mealDeductionHours is always recoverable.
 */

export const WA_MEAL_BREAK_HOURS = 0.5; // 30-minute unpaid meal
export const WA_MEAL_THRESHOLD_HOURS = 5; // applies to shifts OVER 5 hours

export type LaborCostInput = {
    start: Date;
    end: Date;
    hourlyRate: number;
    burdenRate: number;
    /** Worker attested the meal was not taken/was interrupted → pay it and flag for review. */
    mealSkipped?: boolean;
};

export type LaborCostResult = {
    grossHours: number; // raw wall-clock
    mealDeductionHours: number; // 0 or WA_MEAL_BREAK_HOURS
    payableHours: number; // grossHours - mealDeductionHours
    laborCost: number; // rounded to cents
    burdenCost: number; // rounded to cents
    needsReview: boolean;
    reviewReason: string | null;
};

/**
 * Round to cents, half-up. Corrects binary-float representation drift so values that should
 * sit exactly on a half-cent round up rather than being pulled down — e.g. 10.075 → 10.08,
 * 1.005 → 1.01 (naive `Math.round(n*100)/100` returns 10.07 / 1.00). The epsilon scales with
 * magnitude so it stays effective for large dollar amounts.
 */
export function roundMoney(n: number): number {
    if (!Number.isFinite(n)) return 0;
    const sign = n < 0 ? -1 : 1;
    const cents = Math.abs(n) * 100;
    const rounded = Math.round(cents + Math.max(1e-9, cents * 1e-9));
    return (sign * rounded) / 100;
}

export function computeLaborCost(input: LaborCostInput): LaborCostResult {
    const { start, end, hourlyRate, burdenRate, mealSkipped = false } = input;

    let grossHours = (end.getTime() - start.getTime()) / 3_600_000;
    if (!Number.isFinite(grossHours) || grossHours < 0) grossHours = 0;

    const mealRequired = grossHours > WA_MEAL_THRESHOLD_HOURS;
    const mealDeductionHours = mealRequired && !mealSkipped ? WA_MEAL_BREAK_HOURS : 0;
    const payableHours = Math.max(0, grossHours - mealDeductionHours);

    const rate = Number.isFinite(hourlyRate) ? hourlyRate : 0;
    const burden = Number.isFinite(burdenRate) ? burdenRate : 0;

    const needsReview = mealRequired && mealSkipped;
    const reviewReason = needsReview
        ? "Meal break skipped on a shift over 5h — verify and confirm any premium/owed pay (WA L&I)."
        : null;

    return {
        grossHours,
        mealDeductionHours,
        payableHours,
        laborCost: roundMoney(payableHours * rate),
        burdenCost: roundMoney(payableHours * burden),
        needsReview,
        reviewReason,
    };
}
