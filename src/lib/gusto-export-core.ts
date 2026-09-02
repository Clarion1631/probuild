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
import { isKnownPayType } from "./pay-rate-guard";

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
    /** "HOURLY" | "SALARY" | null. NULL is UNANSWERED and blocks the export — see blockingEntries. */
    payType?: string | null;
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
    /** WA meal settlement outcome. A DEFERRED day never settled would export at FULL pay — it blocks. */
    mealOutcome: string | null;
    projectName: string | null;
    costCodeLabel: string | null;
};

export type BlockingReason = "open" | "needsReview" | "zeroDuration" | "deferred" | "unknownPayType";

export type BlockingEntry = {
    id: string;
    userId: string;
    userLabel: string;
    startTime: Date;
    reason: BlockingReason;
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

/**
 * "Still on the clock" — the ONE definition.
 *
 * endTime IS NULL alone is not it: a manual entry records paid hours directly
 * and leaves endTime null forever, so that test called every completed manual
 * entry an open punch. Open means nobody has said how long the shift was:
 * no end time AND no duration.
 *
 * Exported because the settlement planner has to agree with the export about
 * this. When they disagreed, the export blocked on a day the settle button
 * considered finished, and the period could never be cleared.
 */
export function isOpenEntry(entry: { endTime: Date | null; durationHours: number | null }): boolean {
    return entry.endTime == null && !(Number.isFinite(entry.durationHours) && (entry.durationHours ?? 0) > 0);
}


/** Hours -> integer hundredths of an hour. The CSV reports two decimals, so hundredths are the atom payroll actually pays in. */
export function toHundredths(hours: number): number {
    return Math.round((Number.isFinite(hours) ? hours : 0) * 100);
}

/** Hundredths back to hours, for display and for the CSV's toFixed(2). */
export function fromHundredths(hundredths: number): number {
    return hundredths / 100;
}

export type WeekAllocation<TEntry> = {
    entry: TEntry;
    regularHundredths: number;
    overtimeHundredths: number;
};

/**
 * Distribute a rounded TOTAL across its parts by largest remainder.
 *
 * Each part gets its floor; the units left over go to the parts with the
 * largest fractional remainders. That is the standard apportionment rule, and
 * it has the property this needs: the parts sum to the total EXACTLY, and no
 * part moves by more than one hundredth from its true value.
 *
 * Ties break on index, so the same input always produces the same output — the
 * export hash depends on it.
 */
function largestRemainder(values: number[], targetHundredths: number): number[] {
    const scaled = values.map((value) => value * 100);
    const floors = scaled.map((value) => Math.floor(value));
    let remaining = targetHundredths - floors.reduce((sum, value) => sum + value, 0);

    const order = scaled
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

    const out = [...floors];
    // `remaining` can be negative if the rounded total is below the sum of the
    // floors; take from the SMALLEST remainders in that case, symmetrically.
    let cursor = 0;
    while (remaining > 0 && order.length > 0) {
        out[order[cursor % order.length].index] += 1;
        remaining -= 1;
        cursor += 1;
    }
    cursor = 0;
    while (remaining < 0 && order.length > 0) {
        const target = order[order.length - 1 - (cursor % order.length)].index;
        out[target] -= 1;
        remaining += 1;
        cursor += 1;
    }
    return out;
}

/**
 * Turn a workweek's per-entry regular/OT splits into hundredths that ADD UP.
 *
 * The splits come from src/lib/overtime.ts and are taken as AUTHORITY — this
 * does not re-decide the 40-hour threshold, which entry crosses it, or how an
 * entry is divided. There is one implementation of the WA rule and it is not
 * this one. All that happens here is rounding.
 *
 * Why it is needed: the detail CSV prints each entry to two decimals and the
 * summary prints the employee total to two decimals. Rounding each of N entries
 * and rounding their true sum are different operations, so the two files did not
 * reconcile — five 8h01m punches show as 8.02 each (40.10) against a true total
 * of 40.08. The aggregate is rounded once, and the residue is apportioned across
 * the detail rows by largest remainder, so the columns add up to the number the
 * summary reports.
 */
export function allocateWeekHundredths<TEntry>(
    splits: Array<{ entry: TEntry; regularHours: number; overtimeHours: number }>
): WeekAllocation<TEntry>[] {
    if (splits.length === 0) return [];

    const regularTarget = toHundredths(splits.reduce((sum, split) => sum + split.regularHours, 0));
    const overtimeTarget = toHundredths(splits.reduce((sum, split) => sum + split.overtimeHours, 0));

    const regular = largestRemainder(splits.map((split) => split.regularHours), regularTarget);
    const overtime = largestRemainder(splits.map((split) => split.overtimeHours), overtimeTarget);

    return splits.map((split, index) => ({
        entry: split.entry,
        regularHundredths: regular[index],
        overtimeHundredths: overtime[index],
    }));
}


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
/**
 * Rows that are not ready to export.
 *
 * The window is the WORKWEEK ENVELOPE, not the pay period. An open or flagged
 * punch in the trailing partial week sits OUTSIDE the period but still decides
 * how much of the period's time is overtime, so exporting around it produces a
 * number that changes the moment it is closed. Callers pass the envelope that
 * src/lib/payroll-config.ts payrollLockEnvelope computes, which is the same
 * window the period lock freezes.
 */
export function blockingEntries(
    entries: Array<
        Pick<ExportEntry, "id" | "userId" | "startTime" | "endTime" | "needsReview" | "durationHours" | "mealOutcome">
    >,
    users: ExportUser[],
    /** Start of the WORKWEEK ENVELOPE (not the period). */
    windowStart: Date,
    /** End of the WORKWEEK ENVELOPE (not the period), exclusive. */
    windowEnd: Date,
    /** The PAY PERIOD itself. Narrower than the envelope — see the note below. */
    periodStart: Date,
    periodEnd: Date
): BlockingEntry[] {
    const byId = new Map(users.map((user) => [user.id, user]));

    // Who is actually being PAID by this run. The envelope deliberately reaches
    // back to the start of the workweek so the overtime split inside the period
    // is computed against the hours that already pushed that week toward 40 —
    // those extra days are CONTEXT, not payable rows.
    //
    // Blocking on a context row of somebody with no in-period hours froze the
    // export permanently: a former employee whose last shift landed in the tail
    // of a workweek, carrying needsReview or an unsettled DEFERRED meal, has
    // nobody left to fix it and no hours in this run to be wrong about. Their
    // row cannot change a single number in the file, so it cannot be a reason to
    // refuse to produce it.
    //
    // The moment that person HAS an in-period row, their context rows matter
    // again — the OT split for the week is built from both — so they block as
    // they always did.
    const paidThisPeriod = new Set<string>();
    for (const entry of entries) {
        if (inPeriod(entry, periodStart, periodEnd)) paidThisPeriod.add(entry.userId);
    }

    const blocking: BlockingEntry[] = [];
    for (const entry of entries) {
        if (!inPeriod(entry, windowStart, windowEnd)) continue;
        if (!inPeriod(entry, periodStart, periodEnd) && !paidThisPeriod.has(entry.userId)) continue;
        // Order matters only for which single reason is reported first; each
        // condition is independently disqualifying.
        //
        // zeroDuration: a CLOSED entry with no positive paid hours is dropped by
        // buildGustoExport, which is precisely why it has to be surfaced here.
        // Silently exporting fewer rows than the period contains is how a
        // missing shift reaches payroll unnoticed.
        //
        // deferred: a DEFERRED day is "meal not settled yet, paid in full". The
        // export settles what it can first; anything still DEFERRED afterwards
        // (the worker is mid-shift, or settlement failed) would export at FULL
        // pay with no meal deduction. Refuse rather than overpay.
        const reason: BlockingReason | null =
            isOpenEntry(entry)
                ? "open"
                : entry.needsReview
                  ? "needsReview"
                  : !(Number.isFinite(entry.durationHours) && entry.durationHours > 0)
                    ? "zeroDuration"
                    : entry.mealOutcome === "DEFERRED"
                      ? "deferred"
                      : null;
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
 * One blocker per worker who has hours IN THE PERIOD but no answer to "how does
 * Gusto pay this person".
 *
 * Guessing is a wrong paycheque either way: treat a salaried person as hourly
 * and Gusto pays them twice; treat an hourly person as salaried and they are
 * not paid at all. The env list (PAYROLL_SALARIED_EMAILS) cannot close this gap
 * because an absent email is indistinguishable from "hourly" — it fails open by
 * construction. So the export refuses until User.payType says.
 *
 * Scoped to the PERIOD, not the envelope: only people actually being paid for
 * this period need an answer.
 */
export function unknownPayTypeBlockers(
    entries: Array<Pick<ExportEntry, "id" | "userId" | "startTime">>,
    users: ExportUser[],
    periodStart: Date,
    periodEnd: Date
): BlockingEntry[] {
    const byId = new Map(users.map((user) => [user.id, user]));

    // Earliest in-period entry per worker, for a useful startTime on the blocker.
    const firstEntryFor = new Map<string, { id: string; startTime: Date }>();
    for (const entry of entries) {
        if (!inPeriod(entry, periodStart, periodEnd)) continue;
        const seen = firstEntryFor.get(entry.userId);
        if (!seen || entry.startTime < seen.startTime) {
            firstEntryFor.set(entry.userId, { id: entry.id, startTime: entry.startTime });
        }
    }

    // EVERY user on the roster, not only those with hours. A zero-hour worker is
    // in the summary csv as a 0.00 row, so the file makes a claim about them —
    // and whether they belong in it at all depends on their pay type. Checking
    // only the ones who punched let an unanswered account ship a row that says
    // "this person worked nothing", when they may be salaried and not belong in
    // the file, or hourly and genuinely owed nothing. Unknown is unknown.
    const blockers: BlockingEntry[] = [];
    for (const user of users) {
        // An UNRECOGNISED value counts as unknown, exactly like null — never as
        // a default.
        if (isKnownPayType(user.payType)) continue;
        const entry = firstEntryFor.get(user.id);
        blockers.push({
            id: entry?.id ?? `no-pay-type:${user.id}`,
            userId: user.id,
            userLabel: userLabel(user, user.id),
            startTime: entry?.startTime ?? periodStart,
            reason: "unknownPayType" as const,
        });
    }
    return blockers.sort((a, b) => a.userLabel.localeCompare(b.userLabel) || a.userId.localeCompare(b.userId));
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
    /** Workweek envelope for the READINESS check (defaults to the period). See blockingEntries. */
    envelopeStart?: Date;
    envelopeEnd?: Date;
}): GustoExport {
    const { entries, users, periodStart, periodEnd, timeZone } = input;
    const envelopeStart = input.envelopeStart ?? periodStart;
    const envelopeEnd = input.envelopeEnd ?? periodEnd;
    const employeeMappings = input.employeeMappings ?? {};
    const isSalaried = input.isSalaried ?? (() => false);

    // Countable = has real paid hours. endTime is not required: a manual entry
    // records durationHours directly (see blockingEntries on what "open" means).
    const closed = entries.filter((entry) => Number.isFinite(entry.durationHours) && entry.durationHours > 0);

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
        // bucketWorkweeks decides WHICH week each entry belongs to (the Mon-Sun
        // rule, in the company zone). The regular/OT allocation across the
        // entries of a week is then done in hundredths so the detail rows add up
        // to the summary exactly — see allocateWeekHundredths.
        const weeks = bucketWorkweeks(userEntries, timeZone);
        let regularHundredths = 0;
        let overtimeHundredths = 0;

        for (const week of weeks) {
            // week.entries carries overtime.ts's own per-entry split — computed
            // over the WHOLE workweek, which is what makes the OT classification
            // correct. Only the entries this period actually EMITS are then
            // rounded together: apportioning the residue over the whole week
            // could park a hundredth on a context entry that never reaches the
            // detail csv, and the two files would not add up.
            const emitted = week.entries.filter((split) => inPeriod(split.entry, periodStart, periodEnd));
            for (const allocation of allocateWeekHundredths(emitted)) {
                const item = allocation.entry;
                regularHundredths += allocation.regularHundredths;
                overtimeHundredths += allocation.overtimeHundredths;
                detail.push({
                    dayKey: dayKeyInTimeZone(item.startTime, timeZone),
                    user,
                    projectName: item.projectName ?? "",
                    costCodeLabel: item.costCodeLabel ?? "",
                    shiftHours: item.shiftHours,
                    mealDeductionHours: item.mealDeductionHours,
                    // Paid hours are the ALLOCATED hundredths, not the raw
                    // duration: a detail row that says 8.02 paid against 8.01
                    // regular + 0.00 overtime is a row that does not add up, and
                    // it is the row a bookkeeper reconciles by hand.
                    paidHours: fromHundredths(
                        allocation.regularHundredths + allocation.overtimeHundredths
                    ),
                    regularHours: fromHundredths(allocation.regularHundredths),
                    overtimeHours: fromHundredths(allocation.overtimeHundredths),
                    isEdited: item.isEdited,
                    startTime: item.startTime,
                    entryId: item.id,
                });
            }
        }
        // The summary is the SUM OF THE ALLOCATED HUNDREDTHS, not a separately
        // rounded total — that is what makes the two files reconcile.
        const regularHours = fromHundredths(regularHundredths);
        const overtimeHours = fromHundredths(overtimeHundredths);

        employees.push({
            user,
            gustoEmployeeId: employeeMappings[user.id] ?? "",
            salaried: isSalaried(user),
            regularHours,
            overtimeHours,
            // WA has no double time. Structural column — see invariant 1.
            doubleOvertimeHours: 0,
            totalHours: fromHundredths(regularHundredths + overtimeHundredths),
        });
    }

    // Label, then id: two people can share a display name, and an unstable
    // order would change the export hash for no real reason.
    employees.sort(
        (a, b) =>
            userLabel(a.user, a.user.id).localeCompare(userLabel(b.user, b.user.id)) ||
            a.user.id.localeCompare(b.user.id)
    );
    detail.sort(
        (a, b) =>
            a.startTime.getTime() - b.startTime.getTime() ||
            userLabel(a.user, a.user.id).localeCompare(userLabel(b.user, b.user.id)) ||
            a.entryId.localeCompare(b.entryId)
    );

    return {
        employees,
        detail,
        blocking: [
            ...blockingEntries(entries, users, envelopeStart, envelopeEnd, periodStart, periodEnd),
            ...unknownPayTypeBlockers(entries, users, periodStart, periodEnd),
        ],
    };
}

/**
 * Leading characters that make Excel / Sheets / Numbers treat a cell as a
 * FORMULA rather than text. A project name, a cost code, or an employee name is
 * attacker-influenced free text, and this file is opened by a bookkeeper on a
 * machine with access to payroll — CSV injection is a real path, not a
 * theoretical one. Quoting alone does NOT stop it: the spreadsheet strips the
 * quotes and then evaluates what is inside.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r\n]/;

/** RFC4180 field: always quoted (so a comma or newline in a project name can never shift a column), inner quotes doubled, formula leads defused with a leading apostrophe. */
function csvField(value: string | number | null | undefined): string {
    let text = value == null ? "" : String(value);
    if (CSV_FORMULA_LEAD.test(text)) text = `'${text}`;
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
    /** `${userId}|${dayKey}` for every OPEN punch, keyed by the day that punch started. */
    openPunchDayKeys: Iterable<string>;
    todayKey: string;
    /** True when that company-local day falls inside ANY locked period. */
    isDayLocked: (dayKey: string) => boolean;
}): Array<{ userId: string; dayKey: string }> {
    const open = new Set(input.openPunchDayKeys);
    const plan = new Map<string, { userId: string; dayKey: string }>();
    for (const row of input.unsettled) {
        if (!row.dayKey || row.dayKey === input.todayKey) continue;
        const key = `${row.userId}|${row.dayKey}`;
        // Scoped to the DAY, not the worker. The old company-wide "does this
        // person have any open punch" test meant a punch open right now
        // suppressed settlement of that worker's DEFERRED day weeks earlier —
        // which then exported at full pay with no meal deducted.
        if (open.has(key)) continue;
        if (input.isDayLocked(row.dayKey)) continue;
        plan.set(key, row);
    }
    return [...plan.values()];
}
