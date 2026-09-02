import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/utils";
import { getSessionOrDev } from "@/lib/auth";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { computeProjectFinancials, type ProjectFinancials } from "@/lib/project-financials";
import { OVERHEAD_PROJECT_ID } from "@/lib/overhead-project";
import { parseCompanyFinancialsChartFilters, getCompanyFinancialsChartData } from "@/lib/company-financials-charts";
import CompanyFinancialsFilters from "./components/company-financials-filters";
import CashFlowByMonthChart from "./components/cash-flow-by-month-chart";
import SpendByProjectChart from "./components/spend-by-project-chart";
import ArAgingChart from "./components/ar-aging-chart";
import OverheadRatioChart from "./components/overhead-ratio-chart";

export const dynamic = "force-dynamic";

// "Shop" is the sanctioned overhead bucket — its id now comes from the shared
// lib/overhead-project module (this file used to carry its own inline copy of
// the same env-var-with-fallback expression, which could drift from the QBO
// sync's and the variance report's). Its costs (expenses + labor) are company
// overhead, kept separate from job profitability rather than dragging down any
// individual project's margin.

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
    const valueColor =
        tone === "pos" ? "text-green-700" : tone === "neg" ? "text-red-600" : "text-hui-textMain";
    return (
        <div className="hui-card p-5">
            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${valueColor}`}>{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}

function ChartPanel({
    title,
    subtitle,
    isEmpty,
    height = 320,
    className,
    children,
}: {
    title: string;
    subtitle: string;
    isEmpty: boolean;
    height?: number;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={`hui-card p-5 ${className ?? ""}`}>
            <h2 className="text-base font-semibold text-hui-textMain mb-1">{title}</h2>
            <p className="text-xs text-hui-textMuted mb-3">{subtitle}</p>
            {isEmpty ? (
                <div className="flex items-center justify-center text-sm text-hui-textMuted" style={{ height }}>
                    No data in this range.
                </div>
            ) : (
                children
            )}
        </div>
    );
}

interface JobRow {
    id: string;
    name: string;
    client: string;
    // Logistics/shop buckets are not client jobs. They stay in the EXISTING
    // cash tiles and totals exactly as before, but are excluded from every
    // Phase 4 figure, matching activeJobWhere() in percent-complete-db.ts --
    // which is what the nightly recalc and both Monday digests use.
    isLogistics: boolean;
    fin: ProjectFinancials;
    laborCost: number;
    jobCost: number; // expenses + labor
    marginDollars: number; // collected - expenses - labor
    marginPercent: number | null; // null when nothing collected — a % of $0 is undefined, not 0
}

async function buildRow(project: { id: string; name: string; isLogistics?: boolean; client: { name: string } }): Promise<JobRow> {
    const fin = await computeProjectFinancials(project.id);
    const laborCost = fin.totalTimeCost;
    const jobCost = fin.currentOutgoing + laborCost;
    const marginDollars = fin.currentIncoming - jobCost;
    const marginPercent = fin.currentIncoming > 0 ? (marginDollars / fin.currentIncoming) * 100 : null;
    return {
        id: project.id,
        name: project.name,
        client: project.client.name,
        isLogistics: !!project.isLogistics,
        fin,
        laborCost,
        jobCost,
        marginDollars,
        marginPercent,
    };
}

export default async function CompanyFinancialsPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    const user = await getCurrentUserWithPermissions();
    const devAllowed = await canUseDevAuthFallback();
    if ((!user || !hasPermission(user, "financialReports")) && !devAllowed) {
        return <div className="p-8 text-red-500">Access denied. This report requires the Financial Reports permission.</div>;
    }

    const [jobProjects, overheadProject] = await Promise.all([
        prisma.project.findMany({
            where: { status: "In Progress", id: { not: OVERHEAD_PROJECT_ID } },
            select: { id: true, name: true, isLogistics: true, client: { select: { name: true } } },
            orderBy: { name: "asc" },
        }),
        prisma.project.findUnique({
            where: { id: OVERHEAD_PROJECT_ID },
            select: { id: true, name: true, isLogistics: true, client: { select: { name: true } } },
        }),
    ]);

    const params = await searchParams;
    const allProjectIds = jobProjects.map((p) => p.id);
    const chartFilters = parseCompanyFinancialsChartFilters(params, allProjectIds);

    const [jobRows, chartData] = await Promise.all([
        Promise.all(jobProjects.map(buildRow)),
        getCompanyFinancialsChartData(chartFilters, jobProjects),
    ]);
    jobRows.sort((a, b) => a.marginDollars - b.marginDollars); // worst first

    const cashFlowEmpty = chartData.cashFlow.length === 0;
    const spendEmpty = chartData.spendByProject.data.length === 0;
    const arEmpty = chartData.arAging.every((b) => b.amount === 0);
    const overheadRatioEmpty =
        chartData.overheadRatio.length === 0 || chartData.overheadRatio.every((p) => p.ratio === null);

    const overheadRow = overheadProject ? await buildRow(overheadProject) : null;
    const overheadTotal = overheadRow ? overheadRow.jobCost : 0;

    const totals = jobRows.reduce(
        (acc, r) => ({
            invoiced: acc.invoiced + r.fin.invoicedTotal,
            paid: acc.paid + r.fin.currentIncoming,
            outstanding: acc.outstanding + r.fin.clientOwes,
            forecasted: acc.forecasted + r.fin.totalForecastedIncoming,
            expenses: acc.expenses + r.fin.currentOutgoing,
            labor: acc.labor + r.laborCost,
            jobCost: acc.jobCost + r.jobCost,
            margin: acc.margin + r.marginDollars,
        }),
        { invoiced: 0, paid: 0, outstanding: 0, forecasted: 0, expenses: 0, labor: 0, jobCost: 0, margin: 0 }
    );

    const netPosition = totals.margin - overheadTotal;
    const blendedMarginPercent = totals.paid > 0 ? (netPosition / totals.paid) * 100 : null;

    // ── Earned margin roll-up (Phase 4) ─────────────────────────────────────
    // Only jobs that HAVE a percent complete contribute. A job whose estimate is
    // too sparsely coded to weight returns null from the formula, and summing it
    // as $0 would understate the total while looking like a measurement — the
    // tile's subtitle carries the denominator instead.
    const earnedMarginJobs = jobRows.filter((r) => !r.isLogistics);
    const jobsWithPercent = earnedMarginJobs.filter((r) => r.fin.earnedMargin !== null);
    const earnedMarginTotal = jobsWithPercent.reduce((sum, r) => sum + (r.fin.earnedMargin ?? 0), 0);

    // Dollar-weighted, not an average of per-job ratios: a $50 job with a
    // receipt and a $50,000 job without one is not "50% complete".
    const receiptDollars = earnedMarginJobs.reduce(
        (acc, r) => ({
            withReceipt: acc.withReceipt + r.fin.receiptedExpenseDollarsAbs,
            total: acc.total + r.fin.expenseDollarsAbs,
        }),
        { withReceipt: 0, total: 0 }
    );
    const receiptCompletenessPercent =
        receiptDollars.total > 0 ? (receiptDollars.withReceipt / receiptDollars.total) * 100 : null;

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-xl font-bold text-hui-textMain">Company Financials</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Are we profitable, and is cash flow good? {jobRows.length} job{jobRows.length === 1 ? "" : "s"} in progress, plus Shop overhead.
                    Job-level incoming/outgoing figures are the same numbers shown on each project&apos;s Financial Overview page — margin here also nets out labor cost.
                </p>
            </div>

            {/* Company summary tiles — seven now, wrapping to two rows on md */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                    label="Total Incoming"
                    value={formatCurrency(totals.paid)}
                    sub={`${formatCurrency(totals.forecasted)} forecasted`}
                />
                <StatCard
                    label="Total Job Costs"
                    value={formatCurrency(totals.jobCost)}
                    sub={`${formatCurrency(totals.expenses)} expenses + ${formatCurrency(totals.labor)} labor`}
                />
                <StatCard
                    label="Overhead (Shop)"
                    value={formatCurrency(overheadTotal)}
                    sub={overheadRow ? `${formatCurrency(overheadRow.fin.currentOutgoing)} expenses + ${formatCurrency(overheadRow.laborCost)} labor` : "No Shop project found"}
                />
                <StatCard
                    label="Net Position"
                    value={formatCurrency(netPosition)}
                    sub="Job margin − overhead"
                    tone={netPosition >= 0 ? "pos" : "neg"}
                />
                <StatCard
                    label="Blended Margin"
                    value={blendedMarginPercent === null ? "—" : `${blendedMarginPercent.toFixed(1)}%`}
                    sub="Net position ÷ total incoming"
                    tone={blendedMarginPercent === null ? undefined : blendedMarginPercent >= 0 ? "pos" : "neg"}
                />
                <StatCard
                    label="Earned Margin"
                    value={jobsWithPercent.length === 0 ? "—" : formatCurrency(earnedMarginTotal)}
                    sub={`${jobsWithPercent.length} of ${earnedMarginJobs.length} job${earnedMarginJobs.length === 1 ? "" : "s"} have a % complete; includes labor`}
                    tone={jobsWithPercent.length === 0 ? undefined : earnedMarginTotal >= 0 ? "pos" : "neg"}
                />
                <StatCard
                    label="Receipt Completeness"
                    value={receiptCompletenessPercent === null ? "—" : `${receiptCompletenessPercent.toFixed(0)}%`}
                    sub={
                        receiptCompletenessPercent === null
                            ? "No job expenses recorded"
                            : `${formatCurrency(receiptDollars.withReceipt)} of ${formatCurrency(receiptDollars.total)} of expense dollars`
                    }
                />
            </div>

            {/* KPI chart filters */}
            <CompanyFinancialsFilters
                presetValue={chartFilters.preset}
                selectedProjectIds={chartFilters.projectIds}
                allProjects={jobProjects.map((p) => ({ id: p.id, name: p.name }))}
                includeOverhead={chartFilters.includeOverhead}
            />

            {/* KPI charts */}
            <ChartPanel
                title="Cash flow by month"
                subtitle="Collected vs. job costs and overhead, with net position."
                isEmpty={cashFlowEmpty}
            >
                <CashFlowByMonthChart data={chartData.cashFlow} includeOverhead={chartFilters.includeOverhead} />
            </ChartPanel>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ChartPanel
                    title="Spend by project"
                    subtitle="Top 5 projects by all-time spend, plus everything else."
                    isEmpty={spendEmpty}
                    className="md:col-span-2"
                >
                    <SpendByProjectChart series={chartData.spendByProject.series} data={chartData.spendByProject.data} />
                </ChartPanel>
                <ChartPanel title="AR aging" subtitle="Outstanding balances as of today." isEmpty={arEmpty}>
                    <ArAgingChart data={chartData.arAging} />
                </ChartPanel>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ChartPanel
                    title="Overhead ratio"
                    subtitle="Overhead spend ÷ money in, per month."
                    isEmpty={overheadRatioEmpty}
                    height={220}
                >
                    <OverheadRatioChart data={chartData.overheadRatio} />
                </ChartPanel>
            </div>

            {/* Jobs table */}
            <div className="hui-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-hui-border bg-slate-50">
                            <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project</th>
                            <th className="text-left px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Client</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Invoiced</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Paid</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Outstanding</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Expenses</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Labor</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Margin $</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Margin %</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">% Compl.</th>
                            <th className="text-right px-4 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Earned Margin</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {jobRows.map((r) => (
                            <tr key={r.id} className="hover:bg-slate-50 transition">
                                <td className="px-4 py-3">
                                    <Link href={`/projects/${r.id}/financial-overview`} className="font-medium text-hui-textMain hover:text-hui-primary">
                                        {r.name}
                                    </Link>
                                </td>
                                <td className="px-4 py-3 text-hui-textMuted">{r.client}</td>
                                <td className="px-4 py-3 text-right text-hui-textMuted">{formatCurrency(r.fin.invoicedTotal)}</td>
                                <td className="px-4 py-3 text-right font-medium text-hui-textMain">{formatCurrency(r.fin.currentIncoming)}</td>
                                <td className="px-4 py-3 text-right text-hui-textMuted">{formatCurrency(r.fin.clientOwes)}</td>
                                <td className="px-4 py-3 text-right text-hui-textMuted">{formatCurrency(r.fin.currentOutgoing)}</td>
                                <td className="px-4 py-3 text-right text-hui-textMuted">{formatCurrency(r.laborCost)}</td>
                                <td className={`px-4 py-3 text-right font-semibold ${r.marginDollars >= 0 ? "text-green-700" : "text-red-600"}`}>
                                    {formatCurrency(r.marginDollars)}
                                </td>
                                <td className={`px-4 py-3 text-right font-semibold ${r.marginDollars >= 0 ? "text-green-700" : "text-red-600"}`}>
                                    {r.marginPercent === null ? "—" : `${r.marginPercent.toFixed(1)}%`}
                                </td>
                                {/* An em dash, never 0 — "we can't measure this yet" is not "no progress".
                                    A logistics bucket gets one too: it is not a job, so percent
                                    complete and earned margin do not apply to it at all. */}
                                <td className="px-4 py-3 text-right text-hui-textMuted whitespace-nowrap">
                                    {r.isLogistics || r.fin.percentComplete === null ? (
                                        "—"
                                    ) : (
                                        <>
                                            {r.fin.percentComplete.toFixed(0)}%
                                            {r.fin.percentCompleteSource === "MANUAL" && (
                                                <span className="ml-1 text-[10px] font-semibold text-hui-textMuted" title="Set by hand">M</span>
                                            )}
                                            {r.fin.percentCompleteNeedsReview && (
                                                <span
                                                    className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle"
                                                    title="The automatic estimate has moved more than 5 points since this was set by hand — worth a look"
                                                />
                                            )}
                                        </>
                                    )}
                                </td>
                                <td className={`px-4 py-3 text-right font-semibold ${r.isLogistics || r.fin.earnedMargin === null ? "text-hui-textMuted" : r.fin.earnedMargin >= 0 ? "text-green-700" : "text-red-600"}`}>
                                    {r.isLogistics || r.fin.earnedMargin === null ? "—" : formatCurrency(r.fin.earnedMargin)}
                                </td>
                            </tr>
                        ))}
                        {jobRows.length === 0 && (
                            <tr>
                                <td colSpan={11} className="py-12 text-center text-hui-textMuted">No projects with status &quot;In Progress&quot;.</td>
                            </tr>
                        )}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-hui-border bg-slate-50 font-semibold text-hui-textMain">
                            <td className="px-4 py-3" colSpan={2}>Job total</td>
                            <td className="px-4 py-3 text-right">{formatCurrency(totals.invoiced)}</td>
                            <td className="px-4 py-3 text-right">{formatCurrency(totals.paid)}</td>
                            <td className="px-4 py-3 text-right">{formatCurrency(totals.outstanding)}</td>
                            <td className="px-4 py-3 text-right">{formatCurrency(totals.expenses)}</td>
                            <td className="px-4 py-3 text-right">{formatCurrency(totals.labor)}</td>
                            <td className={`px-4 py-3 text-right ${totals.margin >= 0 ? "text-green-700" : "text-red-600"}`}>{formatCurrency(totals.margin)}</td>
                            <td className="px-4 py-3 text-right">{totals.paid > 0 ? `${((totals.margin / totals.paid) * 100).toFixed(1)}%` : "—"}</td>
                            {/* Percent complete does not sum — the count of jobs that have one does. */}
                            <td className="px-4 py-3 text-right text-xs font-normal text-hui-textMuted">{jobsWithPercent.length}/{earnedMarginJobs.length}</td>
                            <td className={`px-4 py-3 text-right ${jobsWithPercent.length === 0 ? "" : earnedMarginTotal >= 0 ? "text-green-700" : "text-red-600"}`}>
                                {jobsWithPercent.length === 0 ? "—" : formatCurrency(earnedMarginTotal)}
                            </td>
                        </tr>

                        {/* Overhead — kept visually and numerically separate from job profitability */}
                        {overheadRow && (
                            <tr className="border-t border-hui-border bg-amber-50/70 text-amber-900">
                                <td className="px-4 py-3">
                                    <Link href={`/projects/${overheadRow.id}/financial-overview`} className="font-medium hover:underline">
                                        {overheadRow.name}
                                    </Link>
                                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full align-middle">
                                        Overhead
                                    </span>
                                </td>
                                <td className="px-4 py-3">{overheadRow.client}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(overheadRow.fin.invoicedTotal)}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(overheadRow.fin.currentIncoming)}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(overheadRow.fin.clientOwes)}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(overheadRow.fin.currentOutgoing)}</td>
                                <td className="px-4 py-3 text-right">{formatCurrency(overheadRow.laborCost)}</td>
                                <td className="px-4 py-3 text-right font-semibold">−{formatCurrency(overheadRow.jobCost)}</td>
                                <td className="px-4 py-3"></td>
                                {/* The overhead bucket is not a job: percent complete and earned margin do not apply to it. */}
                                <td className="px-4 py-3"></td>
                                <td className="px-4 py-3"></td>
                            </tr>
                        )}

                        <tr className={`font-bold ${netPosition >= 0 ? "text-green-700" : "text-red-700"} bg-slate-50 border-t border-hui-border`}>
                            <td className="px-4 py-3" colSpan={9}>Net position (job margin − overhead)</td>
                            <td className="px-4 py-3 text-right" colSpan={2}>{formatCurrency(netPosition)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
