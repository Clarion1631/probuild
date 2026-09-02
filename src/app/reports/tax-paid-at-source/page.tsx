export const dynamic = "force-dynamic";
import Link from "next/link";
import { getSessionOrDev } from "@/lib/auth";
import { canUseDevAuthFallback, getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { formatCurrency } from "@/lib/utils";
import { formatMoneyDate } from "@/lib/payment-date";
import {
    TAX_REPORT_AMOUNT_NOTE,
    TAX_REPORT_FOOTNOTE,
    groupTaxAtSource,
    parseTaxAtSourceFilters,
    queryTaxAtSourceRows,
    stringifyTaxAtSourceFilters,
} from "@/lib/tax-at-source-report";
import TaxAtSourceFiltersForm from "./TaxAtSourceFiltersForm";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TaxPaidAtSourcePage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    // Same gate as the sibling company-financials report: the permission, not a
    // role list, so Justin can grant it to a bookkeeper without making them an
    // admin.
    const user = await getCurrentUserWithPermissions();
    const devAllowed = await canUseDevAuthFallback();
    if ((!user || !hasPermission(user, "financialReports")) && !devAllowed) {
        return <div className="p-8 text-red-500">Access denied. This report requires the Financial Reports permission.</div>;
    }

    const filters = parseTaxAtSourceFilters(await searchParams);
    const rows = await queryTaxAtSourceRows(filters);
    const { months, summary } = groupTaxAtSource(rows);
    const csvHref = `/api/reports/tax-paid-at-source/export?${stringifyTaxAtSourceFilters(filters)}`;

    const dateLabel = (value: Date) =>
        value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const inclusiveTo = new Date(filters.to.getTime());
    inclusiveTo.setDate(inclusiveTo.getDate() - 1);

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Tax Paid at Source</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Material tax paid at the register and installed at a customer job · {dateLabel(filters.from)} → {dateLabel(inclusiveTo)}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <a href={csvHref} className="hui-btn hui-btn-secondary text-sm">Export CSV</a>
                    <Link href="/reports" className="hui-btn hui-btn-secondary text-sm">← All Reports</Link>
                </div>
            </div>

            <TaxAtSourceFiltersForm filters={filters} />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <SummaryCard label="Receipts" value={String(summary.count)} sub="installed at a customer job" />
                <SummaryCard label="Taxable Amount" value={formatCurrency(summary.deductionBase)} sub="deduction base" />
                <SummaryCard label="Tax Paid at Source" value={formatCurrency(summary.tax)} accent="amber" />
            </div>

            <div className="hui-card overflow-hidden">
                <div className="px-4 py-3 border-b border-hui-border bg-hui-surface">
                    <span className="text-sm font-semibold text-hui-textMain">By Month and Job</span>
                </div>
                {months.length === 0 ? (
                    <div className="p-12 text-center text-sm text-hui-textMuted">
                        No receipts in this period carry sales tax flagged as installed at a customer job.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                    <th className="px-4 py-2">Month</th>
                                    <th className="px-4 py-2">Job</th>
                                    <th className="px-4 py-2 text-right">Receipts</th>
                                    <th className="px-4 py-2 text-right">Taxable Amount</th>
                                    <th className="px-4 py-2 text-right">Tax Paid at Source</th>
                                </tr>
                            </thead>
                            <tbody>
                                {months.map(month => (
                                    <>
                                        {month.jobs.map((job, index) => (
                                            <tr key={`${month.key}-${job.projectId ?? "none"}`} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                                <td className="px-4 py-3 font-medium text-hui-textMain">
                                                    {index === 0 ? month.label : ""}
                                                </td>
                                                <td className="px-4 py-3 text-hui-textMuted">{job.projectName}</td>
                                                <td className="px-4 py-3 text-right tabular-nums text-hui-textMuted">{job.count}</td>
                                                <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(job.deductionBase)}</td>
                                                <td className="px-4 py-3 text-right tabular-nums font-medium text-amber-600">{formatCurrency(job.tax)}</td>
                                            </tr>
                                        ))}
                                        <tr key={`${month.key}-total`} className="border-b border-hui-border bg-hui-surface/60 font-medium">
                                            <td className="px-4 py-2 text-hui-textMuted text-xs uppercase tracking-wide">{month.label} total</td>
                                            <td className="px-4 py-2" />
                                            <td className="px-4 py-2 text-right tabular-nums text-hui-textMain">{month.count}</td>
                                            <td className="px-4 py-2 text-right tabular-nums text-hui-textMain">{formatCurrency(month.deductionBase)}</td>
                                            <td className="px-4 py-2 text-right tabular-nums text-amber-600">{formatCurrency(month.tax)}</td>
                                        </tr>
                                    </>
                                ))}
                            </tbody>
                            <tfoot className="bg-slate-50 border-t-2 border-hui-border">
                                <tr className="font-semibold">
                                    <td className="px-4 py-3 text-hui-textMain" colSpan={2}>Total</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{summary.count}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(summary.deductionBase)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums text-amber-600">{formatCurrency(summary.tax)}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                )}
            </div>

            <div className="hui-card overflow-hidden">
                <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                    <span className="text-sm font-semibold text-hui-textMain">Detail</span>
                    <span className="text-xs text-hui-textMuted">{rows.length} {rows.length === 1 ? "receipt" : "receipts"}</span>
                </div>
                {rows.length === 0 ? (
                    <div className="p-12 text-center text-sm text-hui-textMuted">No matching receipts.</div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                    <th className="px-4 py-2">Date</th>
                                    <th className="px-4 py-2">Vendor</th>
                                    <th className="px-4 py-2">Job</th>
                                    <th className="px-4 py-2">Invoice</th>
                                    <th className="px-4 py-2 text-right">Receipt Total</th>
                                    <th className="px-4 py-2 text-right">Taxable Amount</th>
                                    <th className="px-4 py-2 text-right">Tax</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => (
                                    <tr key={row.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                        <td className="px-4 py-3 text-hui-textMuted whitespace-nowrap">
                                            {formatMoneyDate(row.date, { month: "short", day: "numeric", year: "numeric" }, "en-US")}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">{row.vendor || "—"}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">{row.projectName}</td>
                                        <td className="px-4 py-3 font-mono text-xs text-hui-textMuted">{row.reference || "—"}</td>
                                        <td className="px-4 py-3 text-right tabular-nums text-hui-textMuted">{formatCurrency(row.receiptTotal)}</td>
                                        <td className="px-4 py-3 text-right tabular-nums text-hui-textMain">{formatCurrency(row.deductionBase)}</td>
                                        <td className="px-4 py-3 text-right tabular-nums font-medium text-amber-600">{formatCurrency(row.tax)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <p className="text-xs text-hui-textMuted leading-relaxed">
                {TAX_REPORT_FOOTNOTE} {TAX_REPORT_AMOUNT_NOTE} Receipts imported from QuickBooks before the
                receipt pipeline recorded tax carry no tax figure and are not included.
            </p>
        </div>
    );
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: "amber" }) {
    const color = accent === "amber" ? "text-amber-600" : "text-hui-textMain";
    return (
        <div className="hui-card p-4">
            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">{label}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            {sub && <p className="text-xs text-hui-textMuted mt-1">{sub}</p>}
        </div>
    );
}
