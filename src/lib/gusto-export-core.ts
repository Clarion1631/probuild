// Gusto hours export — pure computation half (Phase 5 spec G3).
//
// No prisma, no next-auth, no Next.js request objects: this module takes rows
// and returns CSV text, so the arithmetic can be pinned by golden-file tests.
// The prisma wiring lives in gusto-export-db.ts and the route/page on top of it.
//
// THREE INVARIANTS, all of them load-bearing:
//
//  1. OVERTIME IS NEVER RE-DERIVED HERE. bucketWorkweeks() in src/lib/overtime.ts
//     is the single WA overtime implementation (weekly, over 40h per Mon-Sun
//     workweek in the company time zone, 1.5x, entry attributed to the week its
//     startTime falls in). This module only buckets and sums what it returns.
//     WA has no daily overtime and no general double-time, so the Double
//     Overtime column is structurally 0.00 — it exists for CSV shape, not math.
//  2. MEALS ARE NEVER RE-DEDUCTED. `durationHours` is already PAID hours: the
//     WA meal deduction was applied at clock-out (src/lib/wa-breaks.ts) and is
//     re-settled on every edit. `shiftHours` is the raw span and
//     `mealDeductionHours` the deduction, both carried into the DETAIL csv for
//     reconciliation only. Subtracting either from durationHours would double
//     the deduction.
//  3. A WORKWEEK IS WIDER THAN A PAY PERIOD. Callers hand us the FULL Mon-Sun
//     workweeks overlapping [periodStart, periodEnd) — otherwise a period that
//     opens mid-week cannot know the week was already past 40 hours. Only
//     entries whose startTime is inside the period count toward the period's
//     totals; the rest were fetched to get the threshold right.
//
// Salaried staff (spec section 7 risk 3) are excluded from the SUMMARY csv —
// Gusto pays them a salary, so exporting hours would pay them twice — but kept
// in the DETAIL csv, because job costing still needs those hours.

import { bucketWorkweeks, type OvertimeTimeEntry } from "./overtime";
import { dayKeyInTimeZone } from "./tz-date";

/**
 * Gusto's hours-import header. ASSUMPTION (spec section 7 risk 1): this is
 * believed to match the Gusto Plus/Premium hours template. The parallel run in
 * spec section 4 validates it against the real thing. It is ONE constant on
 * purpose — renaming a column when the truth arrives is a one-line change.
 */
export const GUSTO_SUMMARY_CSV_HEADER = [
    "Employee Name",
    "Email",
    "Gusto Employee ID",
    "Regular Hours",
    "Overtime Hours",
    "Double Overtime Hours",
    "PTO Hours",
    "Sick Hours",
] as const;

/** ProBuild's own reconciliation export — not a Gusto format, so shape it for humans. */
export const GUSTO_DETAIL_CSV_HEADER = [
    "Date",
    "Employee",
    "Email",
    "Project",
    "Cost Code",
    "Shift Hours",
    "Meal Deduction Hours",
    "Paid Hours",
    "Regular Hours",
    "Overtime Hours",
    "Edited",
] as const;

export type ExportUser = {
    id: string;
    name: string | null;
    email: string;
};

export type ExportEntry = OvertimeTimeEntry & {
    id: string;
    userId: string;
    startTime: Date;
    endTime: Date | null;
    /** PAID hours — the meal deduction is already out of this. Never re-deduct. */
    durationHours: number;
    shiftHours: number | null;
    mealDeductionHours: number | null;
    needsReview: boolean;
    isEdited: boolean;
    projectName: string | null;
    costCodeLabel: string | null;
};

export type BlockingEntry = {
    id: string;
    userId: string;
    userLabel: string;
    startTime: Date;
    reason: "open" | "needsReview";
};

export type EmployeeTotals = {
    user: ExportUser;
    gustoEmployeeId: string;
    salaried: boolean;
    regularHours: number;
    overtimeHours: number;
    doubleOvertimeHours: number;
    totalHours: number;
};

export type DetailRow = {
    dayKey: string;
    user: ExportUser;
    projectName: string;
    costCodeLabel: string;
    shiftHours: number | null;
    mealDeductionHours: number | null;
    paidHours: number;
    regularHours: number;
    overtimeHours: number;
    isEdited: boolean;
    startTime: Date;
    entryId: string;
};

export type GustoExport = {
    employees: EmployeeTotals[];
    detail: DetailRow[];
    blocking: BlockingEntry[];
};

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

function userLabel(user: ExportUser | undefined, fallbackId: string): string {
    return user?.name?.trim() || user?.email || fallbackId;
}

function inPeriod(entry: { startTime: Date }, periodStart: Date, periodEnd: Date): boolean {
    const at = entry.startTime.getTime();
    return at >= periodStart.getTime() && at < periodEnd.getTime();
}

/**
 * Entries inside the period that are not ready to export: still open, or
 * flagged for review. "Approved" for export means CLOSED and NOT FLAGGED —
 * there is no separate approved state on TimeEntry. Managers clear flags on
 * /manager/time-entries first.
 *
 * Only entries inside [periodStart, periodEnd) can block; the surrounding
 * workweek days were fetched for the 40h threshold and are not being exported.
 */
export function blockingEntries(
    entries: Array<Pick<ExportEntry, "id" | "userId" | "startTime" | "endTime" | "needsReview">>,
    users: ExportUser[],
    periodStart: Date,
    periodEnd: Date
): BlockingEntry[] {
    const byId = new Map(users.map((user) => [user.id, user]));
    const blocking: BlockingEntry[] = [];
    for (const entry of entries) {
        if (!inPeriod(entry, periodStart, periodEnd)) continue;
        const reason = entry.endTime == null ? "open" : entry.needsReview ? "needsReview" : null;
        if (!reason) continue;
        blocking.push({
            id: entry.id,
            userId: entry.userId,
            userLabel: userLabel(byId.get(entry.userId), entry.userId),
            startTime: entry.startTime,
            reason,
        });
    }
    return blocking.sort(
        (a, b) => a.startTime.getTime() - b.startTime.getTime() || a.id.localeCompare(b.id)
    );
}

/**
 * Per-employee regular/OT totals and the per-entry detail rows, for the period
 * [periodStart, periodEnd). `entries` must span the FULL workweeks overlapping
 * the period (invariant 3 above); only CLOSED entries with positive paid hours
 * are counted.
 */
export function buildGustoExport(input: {
    entries: ExportEntry[];
    users: ExportUser[];
    periodStart: Date;
    periodEnd: Date;
    timeZone: string;
    /** userId -> Gusto employee id, from the Gusto integration settings. */
    employeeMappings?: Record<string, string>;
    /** Predicate for "paid a salary in Gusto" — excluded from the SUMMARY csv only. */
    isSalaried?: (user: ExportUser) => boolean;
}): GustoExport {
    const { entries, users, periodStart, periodEnd, timeZone } = input;
    const employeeMappings = input.employeeMappings ?? {};
    const isSalaried = input.isSalaried ?? (() => false);

    const closed = entries.filter(
        (entry) => entry.endTime != null && Number.isFinite(entry.durationHours) && entry.durationHours > 0
    );

    const byUser = new Map<string, ExportEntry[]>();
    for (const entry of closed) {
        const bucket = byUser.get(entry.userId);
        if (bucket) bucket.push(entry);
        else byUser.set(entry.userId, [entry]);
    }

    const employees: EmployeeTotals[] = [];
    const detail: DetailRow[] = [];

    for (const user of users) {
        const userEntries = byUser.get(user.id) ?? [];
        // OT comes from the shared lib over WHOLE workweeks; the period filter
        // is applied to the resulting per-entry splits, never to its input.
        const weeks = bucketWorkweeks(userEntries, timeZone);
        let regularHours = 0;
        let overtimeHours = 0;

        for (const week of weeks) {
            for (const split of week.entries) {
                if (!inPeriod(split.entry, periodStart, periodEnd)) continue;
                regularHours += split.regularHours;
                overtimeHours += split.overtimeHours;
                detail.push({
                    dayKey: dayKeyInTimeZone(split.entry.startTime, timeZone),
                    user,
                    projectName: split.entry.projectName ?? "",
                    costCodeLabel: split.entry.costCodeLabel ?? "",
                    shiftHours: split.entry.shiftHours,
                    mealDeductionHours: split.entry.mealDeductionHours,
                    paidHours: split.entry.durationHours,
                    regularHours: split.regularHours,
                    overtimeHours: split.overtimeHours,
                    isEdited: split.entry.isEdited,
                    startTime: split.entry.startTime,
                    entryId: split.entry.id,
                });
            }
        }

        employees.push({
            user,
            gustoEmployeeId: employeeMappings[user.id] ?? "",
            salaried: isSalaried(user),
            regularHours: round2(regularHours),
            overtimeHours: round2(overtimeHours),
            // WA has no double time. Structural column — see invariant 1.
            doubleOvertimeHours: 0,
            totalHours: round2(regularHours + overtimeHours),
        });
    }

    employees.sort((a, b) => userLabel(a.user, a.user.id).localeCompare(userLabel(b.user, b.user.id)));
    detail.sort(
        (a, b) =>
            a.startTime.getTime() - b.startTime.getTime() ||
            userLabel(a.user, a.user.id).localeCompare(userLabel(b.user, b.user.id)) ||
            a.entryId.localeCompare(b.entryId)
    );

    return {
        employees,
        detail,
        blocking: blockingEntries(entries, users, periodStart, periodEnd),
    };
}

/** RFC4180 field: always quoted (so a comma or newline in a project name can never shift a column), inner quotes doubled. */
function csvField(value: string | number | null | undefined): string {
    const text = value == null ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
}

function csvLines(rows: Array<Array<string | number | null | undefined>>): string {
    // LF, not CRLF: the old /api/gusto/export used LF and both Gusto and Excel
    // accept it. Keeping one line ending also keeps the golden-file test honest
    // on a Windows checkout.
    return rows.map((row) => row.map(csvField).join(",")).join("\n") + "\n";
}

function hours(value: number | null | undefined): string {
    return (value ?? 0).toFixed(2);
}

/** One row per NON-SALARIED employee. PTO/Sick are 0.00 — ProBuild does not track them; they are entered directly in Gusto. */
export function toSummaryCsv(employees: EmployeeTotals[]): string {
    const rows: Array<Array<string | number | null | undefined>> = [[...GUSTO_SUMMARY_CSV_HEADER]];
    for (const employee of employees) {
        if (employee.salaried) continue;
        rows.push([
            employee.user.name ?? "",
            employee.user.email,
            employee.gustoEmployeeId,
            hours(employee.regularHours),
            hours(employee.overtimeHours),
            hours(employee.doubleOvertimeHours),
            "0.00",
            "0.00",
        ]);
    }
    return csvLines(rows);
}

/** One row per exported entry, salaried staff included (job costing needs their hours). */
export function toDetailCsv(detail: DetailRow[]): string {
    const rows: Array<Array<string | number | null | undefined>> = [[...GUSTO_DETAIL_CSV_HEADER]];
    for (const row of detail) {
        rows.push([
            row.dayKey,
            row.user.name ?? "",
            row.user.email,
            row.projectName,
            row.costCodeLabel,
            row.shiftHours == null ? "" : row.shiftHours.toFixed(2),
            hours(row.mealDeductionHours),
            hours(row.paidHours),
            hours(row.regularHours),
            hours(row.overtimeHours),
            row.isEdited ? "yes" : "no",
        ]);
    }
    return csvLines(rows);
}

/**
 * DEFERRED-day settlement plan, carried over from the deleted
 * /api/gusto/export route. A lunch punch or task switch the worker never
 * followed with a clock-in leaves the day unsettled (DEFERRED, paid in full);
 * payroll must not export that as-is.
 *
 * Two exclusions and one refusal, all deliberate:
 *  - never settle TODAY, and never settle a worker who has an open punch right
 *    now (they may simply be at lunch) — settling would export a mid-shift
 *    value that the evening clock-out then re-plans;
 *  - never settle anything at all for a LOCKED period. Re-downloading a locked
 *    period is a read-only recompute; a settlement write there would silently
 *    change hours that were already paid.
 */
export function planDeferredSettlements(input: {
    unsettled: Array<{ userId: string; dayKey: string }>;
    openPunchUserIds: Iterable<string>;
    todayKey: string;
    locked: boolean;
}): Array<{ userId: string; dayKey: string }> {
    if (input.locked) return [];
    const open = new Set(input.openPunchUserIds);
    const plan = new Map<string, { userId: string; dayKey: string }>();
    for (const row of input.unsettled) {
        if (!row.dayKey || row.dayKey === input.todayKey) continue;
        if (open.has(row.userId)) continue;
        plan.set(`${row.userId}|${row.dayKey}`, row);
    }
    return [...plan.values()];
}
