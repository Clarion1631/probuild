
import { nonVoidedTimeEntryWhere } from "@/lib/time-entry-void";
import { prisma } from "@/lib/prisma";
import { getParam, getAllParams, type SearchParamMap } from "@/lib/report-utils";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";

// "Shop" is the sanctioned overhead bucket. The id now lives in ONE place
// (src/lib/overhead-project.ts) so this page, the QBO expense sync, and the job
// variance report can never point at different projects.
import { OVERHEAD_PROJECT_ID } from "@/lib/overhead-project";
import {
    expenseForProjectWhere,
    expenseForProjectsWhere,
    resolveExpenseProjectId,
} from "@/lib/expense-attribution";

// Same parent-status gating as computeProjectFinancials (src/lib/project-financials.ts,
// includeUnissued: false) — Draft invoices/retainers are not receivables and must
// never show up as "collected" or as outstanding AR.
const INVOICE_PARENT_STATUSES = ["Issued", "Paid", "Overdue", "Partially Paid", "Sent"];
const RETAINER_STATUSES = ["Sent", "Paid", "Partially Paid"];

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type DateRangePreset = "3mo" | "6mo" | "ytd" | "12mo" | "all";

export const DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
    { value: "3mo", label: "Last 3 mo" },
    { value: "6mo", label: "Last 6 mo" },
    { value: "ytd", label: "YTD" },
    { value: "12mo", label: "Last 12 mo" },
    { value: "all", label: "All" },
];

export interface CompanyFinancialsChartFilters {
    preset: DateRangePreset;
    from: Date | null; // inclusive lower bound (UTC month boundary); null = no lower bound ("all")
    to: Date; // exclusive upper bound (UTC) — first of the month after the current UTC month
    projectIds: string[]; // selected job project ids (never includes the overhead project)
    includeOverhead: boolean;
}

/**
 * `allProjectIds` is the full set of selectable (In Progress, non-overhead) jobs —
 * also the default selection.
 *
 * projectId param semantics:
 * - Param entirely absent from the URL => default to all project ids.
 * - Param present with a single "none" sentinel => explicit empty selection
 *   (the filter bar writes this when the user deselects the last project —
 *   see company-financials-filters.tsx).
 * - Param present with real ids => that set, deduped and filtered to valid ids
 *   (an id list that's empty after filtering — e.g. all stale/invalid — is
 *   also treated as an explicit empty selection, not "all").
 */
export function parseCompanyFinancialsChartFilters(
    params: SearchParamMap,
    allProjectIds: string[]
): CompanyFinancialsChartFilters {
    const rawPreset = getParam(params, "range");
    const preset: DateRangePreset =
        rawPreset === "3mo" || rawPreset === "6mo" || rawPreset === "ytd" || rawPreset === "12mo" || rawPreset === "all"
            ? rawPreset
            : "6mo"; // default per spec

    // UTC-consistent month boundaries — never server-local time.
    const now = new Date();
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    let from: Date | null;
    switch (preset) {
        case "3mo": from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)); break;
        case "6mo": from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)); break;
        case "12mo": from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)); break;
        case "ytd": from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)); break;
        case "all": from = null; break;
    }

    const isAbsent = params["projectId"] === undefined;
    let projectIds: string[];
    if (isAbsent) {
        projectIds = allProjectIds;
    } else {
        const raw = getAllParams(params, "projectId");
        if (raw.length === 1 && raw[0] === "none") {
            projectIds = [];
        } else {
            const validIds = new Set(allProjectIds);
            projectIds = Array.from(new Set(raw.filter((id) => validIds.has(id))));
        }
    }

    const includeOverhead = getParam(params, "overhead") !== "0"; // default on

    return { preset, from, to, projectIds, includeOverhead };
}

// ---------------------------------------------------------------------------
// UTC month bucketing helpers
// ---------------------------------------------------------------------------

function monthStart(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addMonths(d: Date, n: number): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function monthKey(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(d: Date): string {
    return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}
function monthFullLabel(d: Date): string {
    return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// Safety cap (10 years) so a bad/ancient date can't blow up the "All" range —
// clamped to the most RECENT N months (never silently drops recent data).
const MAX_MONTH_BUCKETS = 120;

function buildMonthBuckets(from: Date | null, to: Date, fallbackDates: Date[]): Date[] {
    let start = from ? monthStart(from) : null;
    if (!start) {
        if (fallbackDates.length === 0) return []; // "All" range with zero records anywhere
        start = monthStart(fallbackDates.reduce((min, d) => (d < min ? d : min)));
    }
    const end = monthStart(to);
    const earliestAllowed = addMonths(end, -MAX_MONTH_BUCKETS);
    if (start < earliestAllowed) start = earliestAllowed;

    const buckets: Date[] = [];
    let cur = start;
    while (cur < end) {
        buckets.push(cur);
        cur = addMonths(cur, 1);
    }
    return buckets;
}

// ---------------------------------------------------------------------------
// Company-timezone day math (AR aging only — dates are stored at company-local
// noon; elapsed-86400s math can shift a row across a bucket boundary around
// DST transitions, so bucket by normalized company-calendar-day difference).
// ---------------------------------------------------------------------------

function companyDayNumber(date: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) / 86400000;
}

// ---------------------------------------------------------------------------
// Chart data shapes
// ---------------------------------------------------------------------------

export interface MonthMeta {
    month: string; // "2026-03" — stable sort/grouping key
    monthLabel: string; // "Mar" — axis label
    monthFull: string; // "Mar 2026" — tooltip label (disambiguates multi-year ranges)
}

export interface CashFlowMonthPoint extends MonthMeta {
    collected: number;
    jobCosts: number; // expenses + labor
    overhead: number; // Shop expenses + Shop labor
    net: number;
}

export interface SpendSeriesMeta {
    id: string; // project id, or "other"
    name: string;
    color: string;
}

export type SpendByProjectMonthPoint = MonthMeta & Record<string, number | string>;

export interface ArAgingBucket {
    bucket: string;
    amount: number;
    color: string;
}

export interface OverheadRatioMonthPoint extends MonthMeta {
    ratio: number | null; // percent; null when money in is $0 that month
}

export interface CompanyFinancialsChartData {
    cashFlow: CashFlowMonthPoint[];
    spendByProject: { series: SpendSeriesMeta[]; data: SpendByProjectMonthPoint[] };
    arAging: ArAgingBucket[];
    overheadRatio: OverheadRatioMonthPoint[];
}

// Fixed, never-cycled hue order for the top spend-by-project series. The spec
// listed 6 hexes here (…#4d7c0f) but the aggregation rule is "top 5 projects +
// Other" (5 fixed project slots) — only the first 5 are used. #4d7c0f is
// unused; flagged for the orchestrator in case 6 project series were intended.
const TOP_PROJECT_COLORS = ["#2563eb", "#d97706", "#0d9488", "#9333ea", "#db2777"];
const OTHER_COLOR = "#78716c";

const AR_BUCKET_ORDER = ["Not yet due", "1-30", "31-60", "61-90", "91+", "No due date"] as const;
const AR_BUCKET_COLORS: Record<(typeof AR_BUCKET_ORDER)[number], string> = {
    "Not yet due": "#fcd34d",
    "1-30": "#fbbf24",
    "31-60": "#f59e0b",
    "61-90": "#d97706",
    "91+": "#92400e",
    "No due date": "#a8a29e",
};

function ageBucket(dueDate: Date | null, todayDayNumber: number, timeZone: string): (typeof AR_BUCKET_ORDER)[number] {
    if (!dueDate) return "No due date";
    const diffDays = todayDayNumber - companyDayNumber(dueDate, timeZone);
    if (diffDays <= 0) return "Not yet due";
    if (diffDays <= 30) return "1-30";
    if (diffDays <= 60) return "31-60";
    if (diffDays <= 90) return "61-90";
    return "91+";
}

// A date-range predicate approximating `effectiveDate = a ?? b` at the SQL
// level (COALESCE-equivalent via OR branches), so history outside the selected
// range is never fetched. Omitted entirely for the "All" preset (from = null).
function coalescedDateRange2(from: Date | null, to: Date, a: string, b: string) {
    if (!from) return {};
    return {
        OR: [
            { [a]: { gte: from, lt: to } },
            { [a]: null, [b]: { gte: from, lt: to } },
        ],
    };
}

// Same idea for a 3-column coalesce (`a ?? b ?? c`).
function coalescedDateRange3(from: Date | null, to: Date, a: string, b: string, c: string) {
    if (!from) return {};
    return {
        OR: [
            { [a]: { gte: from, lt: to } },
            { [a]: null, [b]: { gte: from, lt: to } },
            { [a]: null, [b]: null, [c]: { gte: from, lt: to } },
        ],
    };
}

// ---------------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------------

export async function getCompanyFinancialsChartData(
    filters: CompanyFinancialsChartFilters,
    jobProjects: { id: string; name: string }[]
): Promise<CompanyFinancialsChartData> {
    const { from, to, projectIds, includeOverhead } = filters;
    const inRange = (d: Date) => (!from || d >= from) && d < to;
    const allJobIds = jobProjects.map((p) => p.id);

    const [
        paidSchedules,
        paidRetainers,
        jobExpenses,
        timeEntries,
        overheadExpenses,
        overheadTimeEntries,
        unpaidSchedules,
        openRetainers,
        allTimeDirectTotals,
        allTimeLegacyTotals,
        timeZone,
    ] = await Promise.all([
        // Collected: paid schedules whose PARENT invoice isn't Draft (item 2),
        // bucketed by the schedule's own paymentDate ?? paidAt ?? createdAt —
        // never dueDate (a plan, not a collection) and never invoice.createdAt.
        prisma.paymentSchedule.findMany({
            where: {
                status: "Paid",
                invoice: { projectId: { in: projectIds }, status: { in: INVOICE_PARENT_STATUSES } },
                ...coalescedDateRange3(from, to, "paymentDate", "paidAt", "createdAt"),
            },
            select: { amount: true, paymentDate: true, paidAt: true, createdAt: true },
        }),
        prisma.retainer.findMany({
            where: {
                projectId: { in: projectIds },
                status: { in: RETAINER_STATUSES },
                amountPaid: { gt: 0 },
                ...(from ? { createdAt: { gte: from, lt: to } } : {}),
            },
            select: { amountPaid: true, createdAt: true },
        }),
        prisma.expense.findMany({
            where: {
                // Under AND, not spread: coalescedDateRange2 returns this
                // object's `OR` key, and a second `OR` would replace it and
                // silently fetch the whole of history.
                AND: [expenseForProjectsWhere(projectIds)],
                ...coalescedDateRange2(from, to, "date", "createdAt"),
            },
            select: {
                amount: true, date: true, createdAt: true,
                projectId: true,
                estimate: { select: { projectId: true } },
            },
        }),
        prisma.timeEntry.findMany({
            where: nonVoidedTimeEntryWhere({
                projectId: { in: projectIds },
                ...(from ? { startTime: { gte: from, lt: to } } : {}),
            }),
            select: { laborCost: true, burdenCost: true, startTime: true },
        }),
        includeOverhead
            ? prisma.expense.findMany({
                  where: {
                      AND: [expenseForProjectWhere(OVERHEAD_PROJECT_ID)],
                      ...coalescedDateRange2(from, to, "date", "createdAt"),
                  },
                  select: { amount: true, date: true, createdAt: true },
              })
            : Promise.resolve([] as { amount: unknown; date: Date | null; createdAt: Date }[]),
        // Overhead must match the page's own definition: Shop expenses + Shop labor.
        includeOverhead
            ? prisma.timeEntry.findMany({
                  where: nonVoidedTimeEntryWhere({
                      projectId: OVERHEAD_PROJECT_ID,
                      ...(from ? { startTime: { gte: from, lt: to } } : {}),
                  }),
                  select: { laborCost: true, burdenCost: true, startTime: true },
              })
            : Promise.resolve([] as { laborCost: unknown; burdenCost: unknown; startTime: Date }[]),
        // AR aging (snapshot, no date-range filter) — same parent-status gate as "collected".
        prisma.paymentSchedule.findMany({
            where: {
                status: { notIn: ["Paid", "Canceled"] },
                invoice: { projectId: { in: projectIds }, status: { in: INVOICE_PARENT_STATUSES } },
            },
            select: { amount: true, dueDate: true },
        }),
        prisma.retainer.findMany({
            where: { projectId: { in: projectIds }, status: { in: RETAINER_STATUSES }, balanceDue: { gt: 0 } },
            select: { balanceDue: true, dueDate: true },
        }),
        // All-time top-5 ranking universe, AS TWO AGGREGATES.
        //
        // It was a SQL `groupBy(["estimateId"])`, which Phase 3 made wrong
        // rather than merely dated: grouping by estimateId resolves a row's job
        // through its estimate, while the monthly series below resolves it
        // through `resolveExpenseProjectId`, so a re-attributed expense ranked
        // under its OLD job and was plotted under its new one — the same money
        // in two places on one page.
        //
        // The first fix fetched every expense row and bucketed them with the
        // resolver. That was correct and unbounded: an all-time, all-jobs read
        // that grows forever, to produce five numbers.
        //
        // The resolver's rule is a UNION of two disjoint sets — rows that carry
        // a `projectId`, and legacy rows that do not and answer through their
        // estimate — so it is expressible as two grouped sums with no overlap
        // between them, merged in memory. `projectId: null` in the second
        // predicate is what makes them disjoint, and it is the same precedence
        // `resolveExpenseProjectId` applies row by row.
        prisma.expense.groupBy({
            by: ["projectId"],
            where: { projectId: { in: allJobIds } },
            _sum: { amount: true },
        }),
        prisma.expense.groupBy({
            by: ["estimateId"],
            where: { projectId: null, estimate: { projectId: { in: allJobIds } } },
            _sum: { amount: true },
        }),
        resolveCompanyTimeZone(),
    ]);

    // ---- Fallback dates for "All" range bucket-building ----
    const allDates: Date[] = [];
    for (const p of paidSchedules) allDates.push(p.paymentDate ?? p.paidAt ?? p.createdAt);
    for (const r of paidRetainers) allDates.push(r.createdAt);
    for (const e of jobExpenses) allDates.push(e.date ?? e.createdAt);
    for (const t of timeEntries) allDates.push(t.startTime);
    for (const e of overheadExpenses) allDates.push(e.date ?? e.createdAt);
    for (const t of overheadTimeEntries) allDates.push(t.startTime);

    const buckets = buildMonthBuckets(from, to, allDates);
    const bucketKeys = buckets.map(monthKey);
    const bucketIndex = new Map(bucketKeys.map((k, i) => [k, i]));

    // ---- Chart A: Cash flow by month ----
    const collected = new Array(buckets.length).fill(0);
    const jobExpenseByMonth = new Array(buckets.length).fill(0);
    const laborByMonth = new Array(buckets.length).fill(0);
    const overheadByMonth = new Array(buckets.length).fill(0); // Shop expenses + Shop labor

    for (const p of paidSchedules) {
        const d = p.paymentDate ?? p.paidAt ?? p.createdAt;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx !== undefined) collected[idx] += Number(p.amount);
    }
    // Retainer has no per-payment date on this schema, and no `updatedAt`
    // column either (checked prisma/schema.prisma) — createdAt is the closest
    // available proxy for "when it was paid". Flagged for the orchestrator.
    for (const r of paidRetainers) {
        const d = r.createdAt;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx !== undefined) collected[idx] += Number(r.amountPaid);
    }
    for (const e of jobExpenses) {
        const d = e.date ?? e.createdAt;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx !== undefined) jobExpenseByMonth[idx] += Number(e.amount);
    }
    for (const t of timeEntries) {
        // TimeEntry has no generic "date" column — startTime is the closest fit.
        const d = t.startTime;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx !== undefined) laborByMonth[idx] += (Number(t.laborCost) || 0) + (Number(t.burdenCost) || 0);
    }
    for (const e of overheadExpenses) {
        const d = e.date ?? e.createdAt;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx !== undefined) overheadByMonth[idx] += Number(e.amount);
    }
    for (const t of overheadTimeEntries) {
        const d = t.startTime;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx !== undefined) overheadByMonth[idx] += (Number(t.laborCost) || 0) + (Number(t.burdenCost) || 0);
    }

    const cashFlow: CashFlowMonthPoint[] = buckets.map((d, i) => {
        const jobCosts = jobExpenseByMonth[i] + laborByMonth[i];
        const overhead = overheadByMonth[i];
        return {
            month: bucketKeys[i],
            monthLabel: monthLabel(d),
            monthFull: monthFullLabel(d),
            collected: collected[i],
            jobCosts,
            overhead,
            net: collected[i] - jobCosts - overhead,
        };
    });

    // ---- Chart B: Spend by project by month ----
    // Ranking universe is ALL selectable jobs (jobProjects), all-time, ignoring
    // the current date-range/project filters — this is what keeps a project's
    // color stable no matter how the filters change.
    // Same precedence as the monthly series below — that agreement is the
    // whole point, and it is what the regression test pins. Here it is spelled
    // as the union of the two disjoint groups read above rather than as a
    // per-row call, because five numbers do not justify loading the ledger.
    const allTimeTotals = new Map<string, number>();
    const addAllTime = (projectId: string | null, amount: unknown) => {
        if (!projectId) return; // both sides can be null on this schema
        allTimeTotals.set(projectId, (allTimeTotals.get(projectId) ?? 0) + Number(amount ?? 0));
    };
    for (const group of allTimeDirectTotals) {
        addAllTime(group.projectId ?? null, group._sum?.amount);
    }
    // The legacy half answers through its estimate, so the estimate ids it
    // grouped by are resolved in ONE lookup. An estimate that has since lost
    // its project contributes nothing, exactly as the row-by-row resolver
    // returned null for it.
    const legacyEstimateIds = allTimeLegacyTotals
        .map((group) => group.estimateId)
        .filter((id): id is string => Boolean(id));
    const legacyProjectByEstimate = legacyEstimateIds.length
        ? new Map(
              (
                  await prisma.estimate.findMany({
                      where: { id: { in: legacyEstimateIds } },
                      select: { id: true, projectId: true },
                  })
              ).map((estimate) => [estimate.id, estimate.projectId]),
          )
        : new Map<string, string | null>();
    for (const group of allTimeLegacyTotals) {
        addAllTime(legacyProjectByEstimate.get(group.estimateId ?? "") ?? null, group._sum?.amount);
    }
    const topProjectIds = [...allTimeTotals.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) // tie-break by id: stable across reloads
        .slice(0, 5)
        .map(([id]) => id);
    const nameById = new Map(jobProjects.map((p) => [p.id, p.name]));
    const series: SpendSeriesMeta[] = topProjectIds.map((id, i) => ({
        id,
        name: nameById.get(id) ?? id,
        color: TOP_PROJECT_COLORS[i],
    }));
    series.push({ id: "other", name: "Other", color: OTHER_COLOR });
    const topSet = new Set(topProjectIds);

    const spendByMonth: Record<string, number>[] = buckets.map(() => ({}));
    for (const e of jobExpenses) {
        const d = e.date ?? e.createdAt;
        if (!inRange(d)) continue;
        const idx = bucketIndex.get(monthKey(d));
        if (idx === undefined) continue;
        const pid = resolveExpenseProjectId(e);
        if (!pid) continue; // both sides can be null on this schema
        const key = topSet.has(pid) ? pid : "other";
        spendByMonth[idx][key] = (spendByMonth[idx][key] ?? 0) + Number(e.amount);
    }
    const spendByProjectData: SpendByProjectMonthPoint[] = buckets.map((d, i) => {
        const point: SpendByProjectMonthPoint = {
            month: bucketKeys[i],
            monthLabel: monthLabel(d),
            monthFull: monthFullLabel(d),
        };
        for (const s of series) point[s.id] = spendByMonth[i][s.id] ?? 0;
        return point;
    });

    // ---- Chart C: AR aging — as-of-today snapshot, not date-range filtered ----
    // (Like the stat tiles/jobs table, "what's outstanding right now" is a
    // position statement, not a trend — only the project filter applies.)
    // Bucketed by normalized company-calendar-day difference: dates are stored
    // at company-local noon, so elapsed-86400s math can misfire across DST.
    const todayDayNumber = companyDayNumber(new Date(), timeZone);
    const arTotals: Partial<Record<(typeof AR_BUCKET_ORDER)[number], number>> = {};
    for (const s of unpaidSchedules) {
        const bucket = ageBucket(s.dueDate, todayDayNumber, timeZone);
        arTotals[bucket] = (arTotals[bucket] ?? 0) + Number(s.amount);
    }
    for (const r of openRetainers) {
        const bucket = ageBucket(r.dueDate, todayDayNumber, timeZone);
        arTotals[bucket] = (arTotals[bucket] ?? 0) + Number(r.balanceDue);
    }
    const arAging: ArAgingBucket[] = AR_BUCKET_ORDER.map((bucket) => ({
        bucket,
        amount: arTotals[bucket] ?? 0,
        color: AR_BUCKET_COLORS[bucket],
    }));

    // ---- Chart D: Overhead ratio by month ----
    const overheadRatio: OverheadRatioMonthPoint[] = includeOverhead
        ? buckets.map((d, i) => ({
              month: bucketKeys[i],
              monthLabel: monthLabel(d),
              monthFull: monthFullLabel(d),
              ratio: collected[i] > 0 ? (overheadByMonth[i] / collected[i]) * 100 : null,
          }))
        : [];

    return {
        cashFlow,
        spendByProject: { series, data: spendByProjectData },
        arAging,
        overheadRatio,
    };
}
