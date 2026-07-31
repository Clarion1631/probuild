import { prisma } from "@/lib/prisma";
import { getParam, getAllParams, type SearchParamMap } from "@/lib/report-utils";

// "Shop" is the sanctioned overhead bucket — same env var as the company
// financials rollup page and the QBO expense sync, so all three can never
// point at different projects.
const OVERHEAD_PROJECT_ID =
    process.env.QBO_EXPENSE_OVERHEAD_PROJECT_ID || "cmpd6xca1009x1iizdf4suln3";

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
    from: Date | null; // inclusive lower bound; null = no lower bound ("all")
    to: Date; // exclusive upper bound — first of the month after the current month
    projectIds: string[]; // selected job project ids (never includes the overhead project)
    includeOverhead: boolean;
}

/**
 * `allProjectIds` is the full set of selectable (In Progress, non-overhead) jobs.
 * It is also the default selection: no `projectId` params in the URL means "all".
 * If a user unchecks every project the filter bar simply stops writing any
 * `projectId` params (see company-financials-filters.tsx), which round-trips
 * back to this same "all" default rather than an empty dashboard.
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

    const now = new Date();
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    let from: Date | null;
    switch (preset) {
        case "3mo": from = new Date(now.getFullYear(), now.getMonth() - 2, 1); break;
        case "6mo": from = new Date(now.getFullYear(), now.getMonth() - 5, 1); break;
        case "12mo": from = new Date(now.getFullYear(), now.getMonth() - 11, 1); break;
        case "ytd": from = new Date(now.getFullYear(), 0, 1); break;
        case "all": from = null; break;
    }

    const validIds = new Set(allProjectIds);
    const rawIds = getAllParams(params, "projectId").filter((id) => validIds.has(id));
    const projectIds = rawIds.length > 0 ? rawIds : allProjectIds;

    const includeOverhead = getParam(params, "overhead") !== "0"; // default on

    return { preset, from, to, projectIds, includeOverhead };
}

// ---------------------------------------------------------------------------
// Date bucketing helpers
// ---------------------------------------------------------------------------

function monthStart(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function monthKey(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(d: Date): string {
    return d.toLocaleString("en-US", { month: "short" });
}
function monthFullLabel(d: Date): string {
    return d.toLocaleString("en-US", { month: "short", year: "numeric" });
}

// Safety cap (10 years) so a bad/ancient date can't blow up the "All" range loop.
const MAX_MONTH_BUCKETS = 120;

function buildMonthBuckets(from: Date | null, to: Date, fallbackDates: Date[]): Date[] {
    let start = from ? monthStart(from) : null;
    if (!start) {
        if (fallbackDates.length === 0) return []; // "All" range with zero records anywhere
        start = monthStart(fallbackDates.reduce((min, d) => (d < min ? d : min)));
    }
    const end = monthStart(to);
    const buckets: Date[] = [];
    let cur = start;
    while (cur < end && buckets.length < MAX_MONTH_BUCKETS) {
        buckets.push(cur);
        cur = addMonths(cur, 1);
    }
    return buckets;
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
    overhead: number;
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

const AR_BUCKET_ORDER = ["Not yet due", "1-30", "31-60", "61-90", "90+", "No due date"] as const;
const AR_BUCKET_COLORS: Record<(typeof AR_BUCKET_ORDER)[number], string> = {
    "Not yet due": "#fcd34d",
    "1-30": "#fbbf24",
    "31-60": "#f59e0b",
    "61-90": "#d97706",
    "90+": "#92400e",
    "No due date": "#a8a29e",
};

function ageBucket(dueDate: Date | null, today: Date): (typeof AR_BUCKET_ORDER)[number] {
    if (!dueDate) return "No due date";
    const diffDays = Math.floor((today.getTime() - dueDate.getTime()) / 86400000);
    if (diffDays <= 0) return "Not yet due";
    if (diffDays <= 30) return "1-30";
    if (diffDays <= 60) return "31-60";
    if (diffDays <= 90) return "61-90";
    return "90+";
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

    const [
        paidSchedules,
        paidRetainers,
        jobExpenses,
        timeEntries,
        overheadExpenses,
        unpaidSchedules,
        openRetainers,
        allTimeExpensesForRanking,
    ] = await Promise.all([
        prisma.paymentSchedule.findMany({
            where: { status: "Paid", invoice: { projectId: { in: projectIds } } },
            select: { amount: true, paymentDate: true, dueDate: true, invoice: { select: { createdAt: true } } },
        }),
        prisma.retainer.findMany({
            where: { projectId: { in: projectIds }, amountPaid: { gt: 0 } },
            select: { amountPaid: true, createdAt: true },
        }),
        prisma.expense.findMany({
            where: { estimate: { projectId: { in: projectIds } } },
            select: { amount: true, date: true, createdAt: true, estimate: { select: { projectId: true } } },
        }),
        prisma.timeEntry.findMany({
            where: { projectId: { in: projectIds } },
            select: { laborCost: true, burdenCost: true, startTime: true },
        }),
        includeOverhead
            ? prisma.expense.findMany({
                  where: { estimate: { projectId: OVERHEAD_PROJECT_ID } },
                  select: { amount: true, date: true, createdAt: true },
              })
            : Promise.resolve([] as { amount: unknown; date: Date | null; createdAt: Date }[]),
        prisma.paymentSchedule.findMany({
            where: { status: { notIn: ["Paid", "Canceled"] }, invoice: { projectId: { in: projectIds } } },
            select: { amount: true, dueDate: true },
        }),
        prisma.retainer.findMany({
            where: { projectId: { in: projectIds }, balanceDue: { gt: 0 } },
            select: { balanceDue: true, dueDate: true },
        }),
        prisma.expense.findMany({
            where: { estimate: { projectId: { in: jobProjects.map((p) => p.id) } } },
            select: { amount: true, estimate: { select: { projectId: true } } },
        }),
    ]);

    // ---- Fallback dates for "All" range bucket-building ----
    const allDates: Date[] = [];
    for (const p of paidSchedules) allDates.push(p.paymentDate ?? p.dueDate ?? p.invoice.createdAt);
    for (const r of paidRetainers) allDates.push(r.createdAt);
    for (const e of jobExpenses) allDates.push(e.date ?? e.createdAt);
    for (const t of timeEntries) allDates.push(t.startTime);
    for (const e of overheadExpenses) allDates.push(e.date ?? e.createdAt);

    const buckets = buildMonthBuckets(from, to, allDates);
    const bucketKeys = buckets.map(monthKey);
    const bucketIndex = new Map(bucketKeys.map((k, i) => [k, i]));

    // ---- Chart A: Cash flow by month ----
    const collected = new Array(buckets.length).fill(0);
    const jobExpenseByMonth = new Array(buckets.length).fill(0);
    const laborByMonth = new Array(buckets.length).fill(0);
    const overheadByMonth = new Array(buckets.length).fill(0);

    for (const p of paidSchedules) {
        const d = p.paymentDate ?? p.dueDate ?? p.invoice.createdAt;
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
    const allTimeTotals = new Map<string, number>();
    for (const e of allTimeExpensesForRanking) {
        const pid = e.estimate.projectId;
        if (!pid) continue; // Estimate.projectId is nullable on this schema
        allTimeTotals.set(pid, (allTimeTotals.get(pid) ?? 0) + Number(e.amount));
    }
    const topProjectIds = [...allTimeTotals.entries()]
        .sort((a, b) => b[1] - a[1])
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
        const pid = e.estimate.projectId;
        if (!pid) continue; // Estimate.projectId is nullable on this schema
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
    const today = new Date();
    const arTotals: Partial<Record<(typeof AR_BUCKET_ORDER)[number], number>> = {};
    for (const s of unpaidSchedules) {
        const bucket = ageBucket(s.dueDate, today);
        arTotals[bucket] = (arTotals[bucket] ?? 0) + Number(s.amount);
    }
    for (const r of openRetainers) {
        const bucket = ageBucket(r.dueDate, today);
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
