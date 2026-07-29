// Evidence layer: how recently did reality confirm what the board claims?
//
// Everything here is a PURE fold over rows the dashboard query already loads
// (plus three cheap aggregates). Nothing fetches per task — the board serializer
// contract is that per-chip data is small scalars folded from batched queries,
// the same shape as `materialCountsByTask` in schedule-core.
//
// The central distinction is direct vs indirect evidence. A bound time punch or
// a completed punch item means a person physically worked that task. A comment,
// a material status change, or a project-level daily log means somebody in the
// office touched something nearby. Collapsing the two would let one daily log
// on a kitchen job mark all four overlapping tasks "confirmed" off a note that
// only mentioned cabinets.

import { toCompanyDayKey, daysBetweenDayKeys } from "./company-day";

export { toCompanyDayKey, daysBetweenDayKeys };

export interface TaskEvidenceSignals {
    /** Newest bound TimeEntry.startTime for this task. Direct. */
    lastTimeEntryAt?: Date | string | null;
    /** Newest TaskPunchItem.completedAt for this task. Direct. */
    lastPunchItemCompletedAt?: Date | string | null;
    /** Newest TaskComment.createdAt. Indirect — often a manager, not the field. */
    lastCommentAt?: Date | string | null;
    /** Newest TaskMaterial.statusChangedAt. Indirect — usually the shop, not the site. */
    lastMaterialStatusAt?: Date | string | null;
    /** Newest DailyLog.date on the parent PROJECT. Indirect: no task linkage exists. */
    lastProjectDailyLogAt?: Date | string | null;
}

export interface TaskEvidence {
    lastDirectEvidenceAt: string | null;
    lastIndirectEvidenceAt: string | null;
}

/** Task shape the classifiers need. Mirrors DashboardTaskRow's relevant fields. */
export interface EvidenceTaskInput extends TaskEvidence {
    id: string;
    startDate: string;
    endDate: string;
    status: string;
    type: string;
    parentId: string | null;
}

export type EvidenceState =
    /** Active leaf with direct evidence inside the freshness window. */
    | "confirmed"
    /** Active leaf, direct evidence older than the window. */
    | "stale"
    /** Active leaf, no direct evidence has ever landed. */
    | "unknown"
    /** Evidence and board state disagree — a human should look. */
    | "needsReview"
    /** Not an active leaf work task: parents, milestones, appointments, done work. */
    | "notApplicable";

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return typeof value === "string" ? value : value.toISOString();
}

function newest(...values: (Date | string | null | undefined)[]): string | null {
    let best: string | null = null;
    for (const value of values) {
        const iso = toIso(value);
        if (iso && (!best || iso > best)) best = iso;
    }
    return best;
}

/** Fold raw signals into the two scalars each task chip carries. */
export function foldTaskEvidence(signals: TaskEvidenceSignals): TaskEvidence {
    return {
        lastDirectEvidenceAt: newest(signals.lastTimeEntryAt, signals.lastPunchItemCompletedAt),
        lastIndirectEvidenceAt: newest(
            signals.lastCommentAt,
            signals.lastMaterialStatusAt,
            signals.lastProjectDailyLogAt,
        ),
    };
}

/**
 * A task is judged on evidence only if the schedule says it is work in flight
 * on this day.
 *
 * Phase parents span every child, so they would inherit any child's freshness;
 * milestones and appointments are single points, not work someone logs hours
 * against; Complete work needs no confirmation.
 *
 * Eligibility follows the SCHEDULE, not the status field. Gating on
 * `status === "In Progress"` was the obvious reading, but a survey of production
 * found all 307 schedule tasks sitting at "Not Started" — nobody advances task
 * status, which is the same neglect this layer exists to expose. Status-gated
 * eligibility would report zero forever. "The dates say this should be happening
 * today and nothing confirms it" is both answerable and worth showing.
 *
 * The window is half-open (`start <= day < end`), matching isTaskActiveOnDay —
 * inlined rather than imported because dispatch-exceptions imports from here.
 */
export function isEvidenceEligible(
    task: EvidenceTaskInput,
    parentIds: ReadonlySet<string>,
    dayKey: string,
): boolean {
    if (task.type !== "task") return false;
    if (parentIds.has(task.id)) return false;
    if (task.status === "Complete") return false;
    return task.startDate.slice(0, 10) <= dayKey && dayKey < task.endDate.slice(0, 10);
}

/**
 * Contradictions between evidence and board state.
 *
 * These are the cases where the board is provably out of sync — not merely
 * unconfirmed. They must raise "needs review" rather than count as freshness,
 * otherwise the coverage readout gets greener the more wrong the board is.
 */
export function findContradiction(task: EvidenceTaskInput): string | null {
    const direct = task.lastDirectEvidenceAt;
    if (!direct) return null;
    // Company-local day, NOT the UTC prefix: a 7pm PDT punch serializes as the
    // next UTC day, which would fire a false "past the end date" on the very
    // last active day of a task.
    const directDay = toCompanyDayKey(direct);
    const endDay = task.endDate.slice(0, 10);
    const startDay = task.startDate.slice(0, 10);
    if (!directDay) return null;

    // No rule on status === "Not Started": in this company that is the resting
    // state of every task, so flagging it would make the contradiction bucket
    // meaningless. Work genuinely ahead of plan is caught by the start-date rule
    // below, which is the same signal without the false positives.
    if (task.status === "Complete" && directDay >= endDay) return "Field activity after this was marked complete";
    // End-exclusive: a task ending on the 28th is active through the 27th. Work
    // on or after the end day means the job is running past its planned window.
    if (directDay >= endDay) return "Still active past the scheduled end date";
    if (directDay < startDay) return "Field activity before the scheduled start date";
    return null;
}

/**
 * Classify one task. `dayKey` and `staleAfterDays` are passed in rather than
 * read from the clock so this stays pure and testable, matching the convention
 * dispatch-exceptions.ts already uses.
 */
export function classifyTaskEvidence(
    task: EvidenceTaskInput,
    parentIds: ReadonlySet<string>,
    dayKey: string,
    staleAfterDays = 2,
): EvidenceState {
    if (findContradiction(task)) return "needsReview";
    if (!isEvidenceEligible(task, parentIds, dayKey)) return "notApplicable";
    if (!task.lastDirectEvidenceAt) return "unknown";

    const evidenceDay = toCompanyDayKey(task.lastDirectEvidenceAt);
    if (!evidenceDay) return "unknown";
    const age = daysBetweenDayKeys(evidenceDay, dayKey);
    // Negative age = evidence dated in the future. That's a clock or data fault,
    // not confirmation — without this guard it would satisfy `<= staleAfterDays`
    // and read as the freshest possible state.
    if (age < 0) return "needsReview";
    return age <= staleAfterDays ? "confirmed" : "stale";
}

export interface EvidenceCoverage {
    /** Active leaf tasks that evidence should exist for. */
    eligible: number;
    confirmed: number;
    stale: number;
    unknown: number;
    needsReview: number;
    /** Punches that couldn't be tied to a task — evidence we collected but can't use. */
    unboundPunches: number;
}

export const EMPTY_COVERAGE: EvidenceCoverage = {
    eligible: 0, confirmed: 0, stale: 0, unknown: 0, needsReview: 0, unboundPunches: 0,
};

/**
 * Roll tasks into the counts shown on the board.
 *
 * Deliberately NOT a single "% true" score. Recent activity proves someone
 * worked, not that dates, crew, or status are correct — a percentage would read
 * healthy while the schedule was wrong. Counts force the ambiguity into view.
 */
export function summarizeEvidenceCoverage(
    tasks: readonly EvidenceTaskInput[],
    parentIds: ReadonlySet<string>,
    dayKey: string,
    options: { staleAfterDays?: number; unboundPunches?: number } = {},
): EvidenceCoverage {
    const coverage: EvidenceCoverage = { ...EMPTY_COVERAGE, unboundPunches: options.unboundPunches ?? 0 };
    for (const task of tasks) {
        const state = classifyTaskEvidence(task, parentIds, dayKey, options.staleAfterDays);
        if (state === "notApplicable") continue;
        // needsReview covers ineligible tasks too (hours on Not Started work), so
        // it is counted without being gated on eligibility.
        if (state === "needsReview") {
            coverage.needsReview += 1;
            if (isEvidenceEligible(task, parentIds, dayKey)) coverage.eligible += 1;
            continue;
        }
        coverage.eligible += 1;
        coverage[state] += 1;
    }
    return coverage;
}

export function sumEvidenceCoverage(parts: readonly EvidenceCoverage[]): EvidenceCoverage {
    return parts.reduce<EvidenceCoverage>((acc, part) => ({
        eligible: acc.eligible + part.eligible,
        confirmed: acc.confirmed + part.confirmed,
        stale: acc.stale + part.stale,
        unknown: acc.unknown + part.unknown,
        needsReview: acc.needsReview + part.needsReview,
        unboundPunches: acc.unboundPunches + part.unboundPunches,
    }), { ...EMPTY_COVERAGE });
}
