// Percent complete — the pure formula behind earned revenue and earned margin
// (docs/plans/PHASE-4-EARNED-MARGIN-SPEC.md §3).
//
// No Prisma here. The database side lives in src/lib/percent-complete-db.ts and
// the nightly cron; this file holds only rules, so every one of them is unit
// tested without a database (same split as job-variance.ts / job-variance-db.ts).
//
// ── WHY A TRUST GATE ────────────────────────────────────────────────────────
// The weights come from the estimate's per-phase budgets. If most of the
// estimate carries no cost code, those weights describe a sliver of the job and
// a number built on them is a guess wearing a measurement's clothes. The same
// honesty rule that makes VarianceCoverage mandatory applies here: below the
// coverage floor we return null and the UI says "no % yet" rather than printing
// a confident wrong number. A job with no eligible estimate therefore has no
// percent complete, by design.

/** One coded phase's budget weight and its schedule progress. */
export interface PhaseProgressInput {
    costCodeId: string;
    /** PhaseVariance.totalBudget — leaf estimate items + approved CO items. */
    budget: number;
    /** ScheduleTasks resolving into this phase (type "task" only). */
    totalTasks: number;
    /** Of those, status === "Complete" (SCHEDULE_TASK_STATUSES). */
    doneTasks: number;
    /** Any DailyLog whose matched task resolves into this phase. */
    hasDailyLogMention: boolean;
}

/**
 * Minimum share of positive budget that must carry a cost code before the
 * weighted average means anything. Exactly at the floor counts as trusted.
 */
export const CODED_BUDGET_TRUST_FLOOR = 0.5;

/**
 * Progress credited to a phase that has budget and a daily-log mention but no
 * schedule tasks at all: work has evidently started, and nothing finer is
 * knowable. Deliberately coarse and deliberately one named constant — see the
 * spec's open question; changing it is a one-line change plus its test.
 */
export const TASKLESS_PHASE_WITH_LOG_PROGRESS = 0.5;

/** Points of drift between "auto now" and "auto when overridden" that flag a review. */
export const PERCENT_COMPLETE_DRIFT_POINTS = 5;

function positive(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Budget-weighted schedule progress for one project, 0-100, or null when the
 * estimate is too sparsely coded to weight honestly.
 *
 * Negative-budget phases (a discount or credit line netting a phase below zero
 * — `hasNegativeBudget` in job-variance.ts) contribute ZERO weight rather than
 * a negative one, which would otherwise let a credit line drag the whole job's
 * percentage around. `uncodedBudget` never gets weight either: it has no phase
 * and therefore no schedule tasks to measure. It only appears in the trust gate,
 * as the thing being measured against.
 */
export function computeAutoPercentComplete(input: {
    phases: PhaseProgressInput[];
    /** ProjectVariance.uncodedBudget — budgeted work whose estimate item has no cost code. */
    uncodedBudget: number;
}): number | null {
    const weighted = input.phases.map((phase) => ({ phase, weight: positive(phase.budget) }));
    const codedPositiveBudget = weighted.reduce((sum, row) => sum + row.weight, 0);
    if (codedPositiveBudget <= 0) return null;

    // Measured on positive dollars on both sides, so a negative uncoded total
    // (a credit line on an uncoded item) cannot shrink the denominator and fake
    // full coverage.
    const uncodedPositiveBudget = positive(input.uncodedBudget);
    const totalPositiveBudget = codedPositiveBudget + uncodedPositiveBudget;
    if (codedPositiveBudget / totalPositiveBudget < CODED_BUDGET_TRUST_FLOOR) return null;

    let progressSum = 0;
    for (const { phase, weight } of weighted) {
        if (weight === 0) continue;
        progressSum += (weight / codedPositiveBudget) * phaseProgress(phase);
    }

    return round2(Math.min(100, Math.max(0, progressSum * 100)));
}

/**
 * A single phase's 0..1 progress. Tasks are the measurement; a daily-log
 * mention is the only fallback, and it is a coarse one — see
 * TASKLESS_PHASE_WITH_LOG_PROGRESS.
 */
export function phaseProgress(phase: Pick<PhaseProgressInput, "totalTasks" | "doneTasks" | "hasDailyLogMention">): number {
    const total = Number.isFinite(phase.totalTasks) ? Math.max(0, Math.trunc(phase.totalTasks)) : 0;
    if (total === 0) {
        return phase.hasDailyLogMention ? TASKLESS_PHASE_WITH_LOG_PROGRESS : 0;
    }
    const done = Number.isFinite(phase.doneTasks) ? Math.max(0, Math.trunc(phase.doneTasks)) : 0;
    return Math.min(1, done / total);
}

/**
 * "The auto number has moved away from what this override was based on."
 *
 * DERIVED, never stored. Only meaningful under a manual override, and only once
 * we have both the current auto value and the snapshot taken when the override
 * was saved — comparing "auto now" against the MANUAL value itself would fire
 * the instant anyone disagreed with the machine, which is the whole point of an
 * override. Strictly greater than the threshold: exactly 5.00 points is not a
 * review, 5.01 is. Nothing here reverts anything; it only raises a flag for a
 * human (the Monday card and the UI badge).
 */
export function percentCompleteNeedsReview(input: {
    source: string | null | undefined;
    auto: number | null | undefined;
    autoAtOverride: number | null | undefined;
}): boolean {
    if (input.source !== "MANUAL") return false;
    const auto = input.auto;
    const at = input.autoAtOverride;
    if (typeof auto !== "number" || !Number.isFinite(auto)) return false;
    if (typeof at !== "number" || !Number.isFinite(at)) return false;
    return Math.abs(auto - at) > PERCENT_COMPLETE_DRIFT_POINTS;
}

/**
 * Clamp a human-entered percentage into 0-100 with 2dp, or null when unusable.
 *
 * Blank and null are null, NOT zero: `Number("")` and `Number(null)` are both 0,
 * and silently turning an empty box into "this job is 0% complete" is a claim
 * nobody made.
 */
export function normalizePercentCompleteInput(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return round2(Math.min(100, Math.max(0, n)));
}
