// Pure validation rules for the logistics-job time-clock feature. Kept free of
// Prisma/Next imports so they can be unit-tested directly (mirrors
// src/lib/overtime.ts's convention) — the routes that call these
// (src/app/api/time-entries/route.ts POST, src/app/api/time-entries/[id]/route.ts
// PATCH) do the DB lookups and just pass in the resolved values.

/**
 * Clock-in: a normal (non-logistics) project must have a phase attached —
 * either a resolved estimate item or a cost code. A logistics project (shop,
 * travel, admin time) has no estimate to attach to, so both may be null there.
 */
export function requiresPhaseForClockIn(input: {
    isLogistics: boolean;
    hasCostCode: boolean;
    hasEstimateItem: boolean;
}): boolean {
    if (input.isLogistics) return false;
    return !input.hasCostCode && !input.hasEstimateItem;
}

export interface LogisticsClockOutNotesInput {
    isLogistics: boolean;
    /** True only when this request is actually setting a (non-null) endTime. */
    settingEndTime: boolean;
    existingNotes: string | null | undefined;
    /** undefined = the request body did not include a `notes` field at all. */
    suppliedNotes: string | undefined;
}

export interface LogisticsClockOutNotesResult {
    ok: boolean;
    /** Trimmed notes to persist, when the request supplied any — undefined means "don't touch the stored value". */
    notes?: string;
}

/**
 * Clock-out: a logistics job carries no cost-code/estimate-item context on the
 * entry, so notes are the only record of what was actually done. Require a
 * non-empty note — already on the entry, or supplied in this request — before
 * a logistics entry can be closed out.
 */
export function checkLogisticsClockOutNotes(
    input: LogisticsClockOutNotesInput,
): LogisticsClockOutNotesResult {
    const trimmedSupplied = input.suppliedNotes !== undefined ? input.suppliedNotes.trim() : undefined;

    if (!input.settingEndTime || !input.isLogistics) {
        return { ok: true, notes: trimmedSupplied };
    }

    const effective = trimmedSupplied !== undefined ? trimmedSupplied : (input.existingNotes ?? "").trim();
    return { ok: effective.length > 0, notes: trimmedSupplied };
}

export interface MealSkippedWaiverInput {
    /** Raw value from the request body — only `true`/`false` are honored, anything else is ignored. */
    mealSkipped: unknown;
    /** True only when this request is actually setting a (non-null) endTime (a clock-out). */
    settingEndTime: boolean;
    existingReviewReason: string | null | undefined;
}

export interface MealSkippedWaiverResult {
    /** Fields to merge into the update — omitted keys mean "don't touch the stored value". */
    mealSkipped?: boolean;
    needsReview?: boolean;
    reviewReason?: string;
}

const MEAL_WAIVER_NOTE = "Worked through WA meal break (voluntary waiver recorded at clock-out)";

/**
 * WA meal-break voluntary waiver attestation: mobile's clock-out modal asks
 * shifts over 5 hours whether the worker took their 30-minute break, and
 * sends `mealSkipped: true` when they voluntarily worked through it. Only
 * ever applies on an actual clock-out (a mutation that sets endTime) — other
 * edits must never touch mealSkipped/needsReview/reviewReason — and a
 * non-boolean value is ignored rather than coerced. Pay math and
 * mealDeductionHours are untouched: meal breaks clock the worker out on
 * mobile, so worked-through time is already paid in full by design.
 */
export function applyMealSkippedWaiver(input: MealSkippedWaiverInput): MealSkippedWaiverResult {
    if (!input.settingEndTime) return {};
    if (input.mealSkipped !== true && input.mealSkipped !== false) return {};

    if (input.mealSkipped === false) {
        return { mealSkipped: false };
    }

    return {
        mealSkipped: true,
        needsReview: true,
        reviewReason: input.existingReviewReason
            ? `${input.existingReviewReason}; ${MEAL_WAIVER_NOTE}`
            : MEAL_WAIVER_NOTE,
    };
}
