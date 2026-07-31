// Shared UTC calendar-date helpers. Extracted from payment-reminders.ts so
// decision-due-date.ts (Phase 3 — schedule-driven due dates,
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md) can
// reuse the exact same "due in N days" math instead of re-deriving it.
// dueDate/effectiveDueDate may carry an arbitrary time-of-day depending on how
// it was entered, but "due in N days" is a calendar-day concept, not a 24h-
// tick concept — comparing raw millisecond deltas would put a date due at
// 11pm today a day off from one due at 1am today depending on when the
// comparison runs. Everything below normalizes to UTC midnight before
// diffing.
export const DAY_MS = 24 * 60 * 60 * 1000;

export function utcMidnight(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function daysBetweenUtc(from: Date, to: Date): number {
    return Math.round((utcMidnight(to).getTime() - utcMidnight(from).getTime()) / DAY_MS);
}

export function dueDateLabel(daysUntil: number): string {
    if (daysUntil > 1) return `due in ${daysUntil} days`;
    if (daysUntil === 1) return "due tomorrow";
    if (daysUntil === 0) return "due today";
    const daysOverdue = Math.abs(daysUntil);
    return `${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;
}

/** UTC-midnight calendar subtraction: `days` calendar days before `d`. */
export function subtractDaysUtc(d: Date, days: number): Date {
    return new Date(utcMidnight(d).getTime() - days * DAY_MS);
}
