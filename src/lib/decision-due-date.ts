// Compute-on-read due date derivation for Decisions (Phase 3 — Decision
// Templates + Schedule-Driven Due Dates,
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
//
// Override semantics, stated once and binding everywhere: the stored
// `dueDate` column is EXCLUSIVELY the admin override — nothing but
// setDecisionDueDateOverride ever writes it. effectiveDueDate is `dueDate`
// when set, INCLUDING when the linked task is dangling or the link is
// absent — a manual override remains fully effective even if its schedule
// task disappears. Only when `dueDate` is null does derivation from the
// linked schedule task apply; a dangling scheduleTaskId then yields null
// ("not linked", never an error). No triggers, no recalc jobs — a schedule
// shift just changes what this function returns on the next read.
//
// Plain module (no "server-only"/"use server" transitively) so it's
// importable directly by tests and by client components that render the
// urgency badge without a server round trip.
import { utcMidnight, daysBetweenUtc, dueDateLabel, subtractDaysUtc } from "./date-utils";

export type EffectiveDueDateInput = {
    dueDate: Date | string | null;
    scheduleTaskId: string | null;
    leadTimeDays: number | null;
};

/**
 * `taskStartDateById` should be populated from ONE batched query per page
 * load (`scheduleTask.findMany({ where: { projectId, id: { in: linkedIds } } })`)
 * — never a per-decision lookup (see loaders in actions.ts).
 */
export function computeEffectiveDueDate(
    decision: EffectiveDueDateInput,
    taskStartDateById: Map<string, Date | string>,
): Date | null {
    if (decision.dueDate) return new Date(decision.dueDate);
    if (!decision.scheduleTaskId) return null;
    if (decision.leadTimeDays === null || decision.leadTimeDays === undefined) return null;
    const startDate = taskStartDateById.get(decision.scheduleTaskId);
    if (!startDate) return null; // dangling scheduleTaskId — "not linked", never an error
    return subtractDaysUtc(new Date(startDate), decision.leadTimeDays);
}

export type DueDateUrgency = { label: string; className: string };

const OVERDUE_STYLE = "bg-red-100 text-red-700";
const DUE_SOON_STYLE = "bg-amber-100 text-amber-700";
const DUE_SOON_WINDOW_DAYS = 7;

/**
 * Urgency chip shown next to "Decide by <date>" — amber when due within
 * DUE_SOON_WINDOW_DAYS, red when overdue, null (no chip) otherwise. Callers
 * only render this for undecided decisions (Open/Flagged) — Decided/Ordered/
 * Received show nothing regardless of what this returns.
 */
export function dueDateUrgency(effectiveDueDate: Date | null, now: Date = new Date()): DueDateUrgency | null {
    if (!effectiveDueDate) return null;
    const daysUntil = daysBetweenUtc(now, effectiveDueDate);
    if (daysUntil < 0) return { label: dueDateLabel(daysUntil), className: OVERDUE_STYLE };
    if (daysUntil <= DUE_SOON_WINDOW_DAYS) return { label: dueDateLabel(daysUntil), className: DUE_SOON_STYLE };
    return null;
}

/** "Aug 15" — short, timezone-independent (UTC) calendar-date display. */
export function formatDueDateShort(d: Date): string {
    return utcMidnight(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
