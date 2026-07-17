export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { parsePayoutsFilters, queryPayoutsData } from "@/lib/payouts-report";
import { formatLocalDateString } from "@/lib/report-utils";
import PayoutsFiltersForm from "./PayoutsFiltersForm";

export default async function PayoutsReportPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user && process.env.NODE_ENV !== "development") return <div className="p-8 text-red-500">Access Denied.</div>;
    if (user && user.role !== "ADMIN" && user.role !== "MANAGER" && user.role !== "FINANCE") return <div className="p-8 text-red-500">Access Denied.</div>;

    const params = await searchParams;
    const filters = parsePayoutsFilters(params);

    const [{ rows, summary }, projects] = await Promise.all([
        queryPayoutsData(filters),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
    const dateLabel = `${formatLocalDateString(filters.from)} → ${formatLocalDateString(filters.to)}`;

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Payouts</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    Outgoing payments: expenses and purchase orders · {dateLabel}
                </p>
            </div>

            <PayoutsFiltersForm filters={filters} projects={projects} />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Payouts</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(summary.total)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Expenses</p>
                    <p className="text-2xl font-bold text-orange-600 mt-1">{fmt(summary.expenses)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Purchase Orders</p>
                    <p className="text-2xl font-bold text-blue-600 mt-1">{fmt(summary.pos)}</p>
                </div>
            </div>

            {rows.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No payouts in this period.</div>
            ) : (
                <div className="hui-card overflow-hidden">
                    <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                        <span className="text-sm font-semibold text-hui-textMain">All Payouts</span>
                        <span className="text-sm text-hui-textMuted">{rows.length} transaction{rows.length !== 1 ? "s" : ""}</span>
                    </div>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                <th className="px-4 py-2">Date</th>
                                <th className="px-4 py-2">Vendor / Sub</th>
                                <th className="px-4 py-2">Type</th>
                                <th className="px-4 py-2">Project</th>
                                <th className="px-4 py-2">Reference</th>
                                <th className="px-4 py-2 text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => (
                                <tr key={row.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                    <td className="px-4 py-3 text-hui-textMuted">
                                        {new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMain">{row.vendorName}</td>
                                    <td className="px-4 py-3">
                                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${row.type === "Expense" ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"}`}>
                                            {row.type}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMain">
                                        {row.projectId ? (
                                            <Link href={`/projects/${row.projectId}`} className="hover:underline">{row.projectName}</Link>
                                        ) : (
                                            <span className="text-hui-textMuted">{row.projectName}</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMuted font-mono text-xs">{row.reference ?? "—"}</td>
                                    <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{fmt(row.amount)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
