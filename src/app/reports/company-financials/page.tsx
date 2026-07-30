import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/utils";
import { getSessionOrDev } from "@/lib/auth";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { computeProjectFinancials, type ProjectFinancials } from "@/lib/project-financials";

export const dynamic = "force-dynamic";

// "Shop" is the sanctioned overhead bucket — shares the sync's env var so the
// two features can never point at different projects. Its costs (expenses +
// labor) are company overhead, kept separate from job profitability rather
// than dragging down any individual project's margin.
const OVERHEAD_PROJECT_ID =
    process.env.QBO_EXPENSE_OVERHEAD_PROJECT_ID || "cmpd6xca1009x1iizdf4suln3";

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

interface JobRow {
    id: string;
    name: string;
    client: string;
    fin: ProjectFinancials;
    laborCost: number;
    jobCost: number; // expenses + labor
    marginDollars: number; // collected - expenses - labor
    marginPercent: number | null; // null when nothing collected — a % of $0 is undefined, not 0
}

async function buildRow(project: { id: string; name: string; client: { name: string } }): Promise<JobRow> {
    const fin = await computeProjectFinancials(project.id);
    const laborCost = fin.totalTimeCost;
    const jobCost = fin.currentOutgoing + laborCost;
    const marginDollars = fin.currentIncoming - jobCost;
    const marginPercent = fin.currentIncoming > 0 ? (marginDollars / fin.currentIncoming) * 100 : null;
    return {
        id: project.id,
        name: project.name,
        client: project.client.name,
        fin,
        laborCost,
        jobCost,
        marginDollars,
        marginPercent,
    };
}

export default async function CompanyFinancialsPage() {
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
            select: { id: true, name: true, client: { select: { name: true } } },
            orderBy: { name: "asc" },
        }),
        prisma.project.findUnique({
            where: { id: OVERHEAD_PROJECT_ID },
            select: { id: true, name: true, client: { select: { name: true } } },
        }),
    ]);

    const jobRows = await Promise.all(jobProjects.map(buildRow));
    jobRows.sort((a, b) => a.marginDollars - b.marginDollars); // worst first

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

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-xl font-bold text-hui-textMain">Company Financials</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Are we profitable, and is cash flow good? {jobRows.length} job{jobRows.length === 1 ? "" : "s"} in progress, plus Shop overhead.
                    Job-level incoming/outgoing figures are the same numbers shown on each project&apos;s Financial Overview page — margin here also nets out labor cost.
                </p>
            </div>

            {/* Company summary tiles */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
                            </tr>
                        ))}
                        {jobRows.length === 0 && (
                            <tr>
                                <td colSpan={9} className="py-12 text-center text-hui-textMuted">No projects with status &quot;In Progress&quot;.</td>
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
                            </tr>
                        )}

                        <tr className={`font-bold ${netPosition >= 0 ? "text-green-700" : "text-red-700"} bg-slate-50 border-t border-hui-border`}>
                            <td className="px-4 py-3" colSpan={7}>Net position (job margin − overhead)</td>
                            <td className="px-4 py-3 text-right" colSpan={2}>{formatCurrency(netPosition)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}
