export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import {
    groupRowsByMonth,
    parseSalesTaxFilters,
    querySalesTaxData,
    stringifySalesTaxFilters,
    type SalesTaxFilters,
} from "@/lib/sales-tax-report";
import SalesTaxFiltersForm from "./SalesTaxFiltersForm";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SalesTaxReportPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");
    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user || (user.role !== "ADMIN" && user.role !== "FINANCE")) {
        return <div className="p-8 text-red-500">Access Denied. Requires ADMIN or FINANCE role.</div>;
    }

    const params = await searchParams;
    const filters = parseSalesTaxFilters(params);

    const [{ rows, summary }, clients, projects] = await Promise.all([
        querySalesTaxData(filters),
        prisma.client.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    const monthly = groupRowsByMonth(rows);
    const csvHref = `/api/reports/sales-tax/export?${stringifySalesTaxFilters(filters)}`;

    const fromLabel = filters.from.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const toLabel = filters.to.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Sales Tax Report</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        {filters.basis === "cash" ? "Cash basis — tax on received payments" : "Accrual basis — tax on issued invoices"} · {fromLabel} → {toLabel}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <a href={csvHref} className="hui-btn hui-btn-secondary text-sm">Export CSV</a>
                    <Link href="/reports" className="hui-btn hui-btn-secondary text-sm">← All Reports</Link>
                </div>
            </div>

            <SalesTaxFiltersForm
                filters={filters}
                clients={clients}
                projects={projects}
            />

            {/* Summary cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <SummaryCard label={filters.basis === "cash" ? "Total Received" : "Total Invoiced"} value={formatCurrency(summary.gross)} sub={`${summary.count} ${filters.basis === "cash" ? "payments" : "invoices"}`} />
                <SummaryCard label="Taxable Subtotal" value={formatCurrency(summary.subtotal)} />
                <SummaryCard label={filters.basis === "cash" ? "Tax Collected" : "Tax Owed"} value={formatCurrency(summary.tax)} accent="amber" />
                <SummaryCard label="Effective Rate" value={summary.subtotal > 0 ? `${((summary.tax / summary.subtotal) * 100).toFixed(2)}%` : "—"} sub="blended across period" />
            </div>

            {/* Monthly rollup */}
            <div className="hui-card overflow-hidden">
                <div className="px-4 py-3 border-b border-hui-border bg-hui-surface">
                    <span className="text-sm font-semibold text-hui-textMain">Monthly Breakdown</span>
                </div>
                {monthly.length === 0 ? (
                    <div className="p-12 text-center text-sm text-hui-textMuted">No matching records for this period.</div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                <th className="px-4 py-2">Month</th>
                                <th className="px-4 py-2 text-right">Count</th>
                                <th className="px-4 py-2 text-right">Gross</th>
                                <th className="px-4 py-2 text-right">Taxable Subtotal</th>
                                <th className="px-4 py-2 text-right">Sales Tax</th>
                            </tr>
                        </thead>
                        <tbody>
                            {monthly.map(m => (
                                <tr key={m.key} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                    <td className="px-4 py-3 font-medium text-hui-textMain">{m.month}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-hui-textMuted">{m.count}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(m.gross)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-hui-textMuted">{formatCurrency(m.subtotal)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-amber-600">{formatCurrency(m.tax)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="bg-slate-50 border-t-2 border-hui-border">
                            <tr className="font-semibold">
                                <td className="px-4 py-3 text-hui-textMain">Total</td>
                                <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{summary.count}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(summary.gross)}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(summary.subtotal)}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-amber-600">{formatCurrency(summary.tax)}</td>
                            </tr>
                        </tfoot>
                    </table>
                )}
            </div>

            {/* Detail table */}
            <div className="hui-card overflow-hidden">
                <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                    <span className="text-sm font-semibold text-hui-textMain">Detail</span>
                    <span className="text-xs text-hui-textMuted">{rows.length} {rows.length === 1 ? "row" : "rows"}</span>
                </div>
                {rows.length === 0 ? (
                    <div className="p-12 text-center text-sm text-hui-textMuted">No matching records.</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                    <th className="px-4 py-2">{filters.basis === "cash" ? "Date Paid" : "Issue Date"}</th>
                                    <th className="px-4 py-2">Document</th>
                                    <th className="px-4 py-2">Client</th>
                                    <th className="px-4 py-2">Project</th>
                                    {filters.basis === "cash" && <th className="px-4 py-2">Method</th>}
                                    {filters.basis === "cash" && <th className="px-4 py-2">Reference</th>}
                                    <th className="px-4 py-2 text-right">Gross</th>
                                    <th className="px-4 py-2 text-right">Taxable</th>
                                    <th className="px-4 py-2 text-right">Sales Tax</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                        <td className="px-4 py-3 text-hui-textMuted whitespace-nowrap">
                                            {r.date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                        </td>
                                        <td className="px-4 py-3 font-mono text-xs">
                                            <Link href={r.href} className="text-hui-primary hover:underline">
                                                {r.documentCode}
                                            </Link>
                                            {r.documentKind === "estimate" && (
                                                <span className="ml-1 text-[10px] uppercase text-hui-textMuted">est</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">{r.clientName || "—"}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{r.projectName || "—"}</td>
                                        {filters.basis === "cash" && (
                                            <td className="px-4 py-3 text-hui-textMuted capitalize">{r.method || "—"}</td>
                                        )}
                                        {filters.basis === "cash" && (
                                            <td className="px-4 py-3 text-hui-textMuted">{r.referenceNumber || "—"}</td>
                                        )}
                                        <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(r.gross)}</td>
                                        <td className="px-4 py-3 text-right tabular-nums text-hui-textMuted">{formatCurrency(r.taxableSubtotal)}</td>
                                        <td className="px-4 py-3 text-right tabular-nums font-medium text-amber-600">
                                            {r.isExempt
                                                ? <span className="text-hui-textMuted">—</span>
                                                : formatCurrency(r.tax)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: "amber" | "emerald" }) {
    const color = accent === "amber" ? "text-amber-600" : accent === "emerald" ? "text-emerald-600" : "text-hui-textMain";
    return (
        <div className="hui-card p-4">
            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}
