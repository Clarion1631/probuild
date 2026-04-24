export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { parsePaymentsFilters, queryPaymentsData } from "@/lib/payments-report";
import { formatLocalDateString } from "@/lib/report-utils";
import PaymentsFiltersForm from "./PaymentsFiltersForm";

export default async function PaymentsReportPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const params = await searchParams;
    const filters = parsePaymentsFilters(params);

    const [{ rows, summary }, clients, projects] = await Promise.all([
        queryPaymentsData(filters),
        prisma.client.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    const byMonth: Record<string, typeof rows> = {};
    for (const r of rows) {
        const key = new Date(r.date).toLocaleString("en-US", { month: "long", year: "numeric" });
        if (!byMonth[key]) byMonth[key] = [];
        byMonth[key].push(r);
    }
    const months = Object.keys(byMonth);

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
    const dateLabel = `${formatLocalDateString(filters.from)} → ${formatLocalDateString(filters.to)}`;

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Payments Received</h1>
                <p className="text-sm text-hui-textMuted mt-1">Collected payments grouped by month · {dateLabel}</p>
            </div>

            <PaymentsFiltersForm filters={filters} clients={clients} projects={projects} />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Collected</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{fmt(summary.total)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Payments</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{summary.count}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Avg Payment</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{summary.count ? fmt(summary.avg) : "$0"}</p>
                </div>
            </div>

            {rows.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No payments in this period.</div>
            ) : (
                months.map(month => (
                    <div key={month} className="hui-card overflow-hidden">
                        <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                            <span className="text-sm font-semibold text-hui-textMain">{month}</span>
                            <span className="text-sm text-hui-textMuted">{fmt(byMonth[month].reduce((s, r) => s + r.amount, 0))}</span>
                        </div>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                    <th className="px-4 py-2">Payment</th>
                                    <th className="px-4 py-2">Invoice</th>
                                    <th className="px-4 py-2">Project</th>
                                    <th className="px-4 py-2">Client</th>
                                    <th className="px-4 py-2">Date Paid</th>
                                    <th className="px-4 py-2">Method</th>
                                    <th className="px-4 py-2 text-right">Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {byMonth[month].map(r => (
                                    <tr key={r.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                        <td className="px-4 py-3 text-hui-textMuted text-xs">{r.name}</td>
                                        <td className="px-4 py-3 font-mono text-xs">
                                            <Link href={`/projects/${r.projectId}/invoices/${r.invoiceId}`} className="text-hui-primary hover:underline">
                                                {r.invoiceCode}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">
                                            <Link href={`/projects/${r.projectId}`} className="hover:underline">{r.projectName}</Link>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">{r.clientName}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">
                                            {new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted capitalize">{r.paymentMethod ?? "—"}</td>
                                        <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{fmt(r.amount)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ))
            )}
        </div>
    );
}
