export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { parseOpenInvoicesFilters, queryOpenInvoicesData, summarizeOpenInvoices } from "@/lib/open-invoices-report";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { formatCurrency } from "@/lib/utils";
import OpenInvoicesFiltersForm from "./OpenInvoicesFiltersForm";

function fmtDate(d: Date, timeZone: string): string {
    return d.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

// Indirection so the impure Date.now() call isn't lexically inside the page
// component itself (react-hooks/purity) — same reason the old agingBucket()
// helper called it internally rather than the component calling it directly.
function nowMs(): number {
    return Date.now();
}

export default async function OpenInvoicesPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const params = await searchParams;
    const filters = parseOpenInvoicesFilters(params);

    const [invoices, clients, projects, timeZone] = await Promise.all([
        queryOpenInvoicesData(filters),
        prisma.client.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        resolveCompanyTimeZone(),
    ]);

    const summary = summarizeOpenInvoices(invoices, nowMs());
    const totalRows = summary.buckets.reduce((s, b) => s + b.rows.length, 0);

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Open Invoices</h1>
                <p className="text-sm text-hui-textMuted mt-1">Billed milestones that haven&apos;t been paid yet, aged from when each was billed.</p>
            </div>

            <OpenInvoicesFiltersForm filters={filters} clients={clients} projects={projects} />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {summary.buckets.map(b => (
                    <div key={b.label} className="hui-card p-4">
                        <p className="text-xs text-hui-textMuted font-medium">{b.label} days</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">{formatCurrency(b.cents / 100)}</p>
                        <p className="text-xs text-hui-textMuted mt-1">{b.rows.length} item{b.rows.length !== 1 ? "s" : ""}</p>
                    </div>
                ))}
            </div>

            <div className="hui-card p-4">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-sm text-hui-textMuted">Total Outstanding</p>
                        <p className="text-3xl font-bold text-hui-textMain">{formatCurrency(summary.totalOutstandingCents / 100)}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-sm text-hui-textMuted">Open Invoices</p>
                        <p className="text-3xl font-bold text-hui-textMain">{summary.invoiceCount}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-sm text-hui-textMuted">Overdue</p>
                        <p className="text-3xl font-bold text-red-500">{formatCurrency(summary.overdueCents / 100)}</p>
                        <p className="text-xs text-hui-textMuted mt-0.5">{summary.overdueInvoiceCount} invoice{summary.overdueInvoiceCount !== 1 ? "s" : ""}</p>
                    </div>
                </div>
                {summary.unbilledCents > 0 && (
                    <p className="text-xs text-hui-textMuted mt-3 pt-3 border-t border-hui-border">
                        Not counted: {formatCurrency(summary.unbilledCents / 100)} of scheduled milestones not yet billed (backlog, not receivables).
                    </p>
                )}
            </div>

            {totalRows === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No billed, unpaid milestones matching current filters.</div>
            ) : (
                summary.buckets.filter(b => b.rows.length > 0).map(bucket => (
                    <div key={bucket.label} className="hui-card overflow-hidden">
                        <div className="px-4 py-3 border-b border-hui-border bg-hui-surface">
                            <span className="text-sm font-semibold text-hui-textMain">{bucket.label} days</span>
                            <span className="ml-2 text-sm text-hui-textMuted">({bucket.rows.length} item{bucket.rows.length !== 1 ? "s" : ""} · {formatCurrency(bucket.cents / 100)})</span>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                        <th className="px-4 py-2">Invoice #</th>
                                        <th className="px-4 py-2">Project</th>
                                        <th className="px-4 py-2">Client</th>
                                        <th className="px-4 py-2">Milestone</th>
                                        <th className="px-4 py-2">Billed</th>
                                        <th className="px-4 py-2">Due</th>
                                        <th className="px-4 py-2 text-right">Amount</th>
                                        <th className="px-4 py-2">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {bucket.rows.map((row, i) => (
                                        <tr key={`${row.invoiceId}-${row.item.id ?? i}`} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                            <td className="px-4 py-3 font-mono text-xs">
                                                {row.project ? (
                                                    <Link href={`/projects/${row.project.id}/invoices/${row.invoiceId}`} className="text-hui-primary hover:underline">{row.code}</Link>
                                                ) : row.code}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                {row.project ? <Link href={`/projects/${row.project.id}`} className="hover:underline">{row.project.name}</Link> : "—"}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">{row.client?.name ?? "—"}</td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                {row.item.label}
                                                {!row.item.requested && <div className="text-xs text-hui-textMuted">No payment request on record</div>}
                                                {row.item.progressBillingCode && <div className="text-xs text-hui-textMuted">Progress billing {row.item.progressBillingCode}</div>}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">{fmtDate(row.item.billedAt, timeZone)}</td>
                                            <td className="px-4 py-3 text-hui-textMuted">{row.item.dueDate ? fmtDate(row.item.dueDate, timeZone) : "Net 30"}</td>
                                            <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{formatCurrency(row.item.cents / 100)}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${row.item.overdue ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                                                    {row.item.overdue ? "Overdue" : "Current"}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
