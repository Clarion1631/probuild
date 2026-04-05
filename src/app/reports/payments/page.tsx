export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function PaymentsReportPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const payments = await prisma.paymentSchedule.findMany({
        where: { status: "Paid" },
        include: {
            invoice: {
                select: {
                    id: true,
                    code: true,
                    project: { select: { id: true, name: true } },
                    client: { select: { id: true, name: true } },
                },
            },
        },
        orderBy: { paidAt: "desc" },
    });

    const totalCollected = payments.reduce((sum, p) => sum + p.amount, 0);

    // Group by month
    const byMonth: Record<string, typeof payments> = {};
    for (const p of payments) {
        const d = p.paidAt ?? p.paymentDate ?? p.createdAt;
        const key = new Date(d).toLocaleString("en-US", { month: "long", year: "numeric" });
        if (!byMonth[key]) byMonth[key] = [];
        byMonth[key].push(p);
    }
    const months = Object.keys(byMonth);

    const fmt = (n: number | any) => Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Payments Received</h1>
                <p className="text-sm text-hui-textMuted mt-1">All collected payments, grouped by month.</p>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Collected</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{fmt(totalCollected)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Payments</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{payments.length}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Avg Payment</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{payments.length ? fmt(totalCollected / payments.length) : "$0"}</p>
                </div>
            </div>

            {/* By month */}
            {payments.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No payments recorded yet.</div>
            ) : (
                months.map(month => (
                    <div key={month} className="hui-card overflow-hidden">
                        <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                            <span className="text-sm font-semibold text-hui-textMain">{month}</span>
                            <span className="text-sm text-hui-textMuted">{fmt(byMonth[month].reduce((s, p) => s + p.amount, 0))}</span>
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
                                {byMonth[month].map(p => {
                                    const paidDate = p.paidAt ?? p.paymentDate;
                                    return (
                                        <tr key={p.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                            <td className="px-4 py-3 text-hui-textMuted text-xs">{p.name}</td>
                                            <td className="px-4 py-3 font-mono text-xs">
                                                <Link href={`/projects/${p.invoice.project.id}/invoices/${p.invoice.id}`} className="text-hui-primary hover:underline">
                                                    {p.invoice.code}
                                                </Link>
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMain">
                                                <Link href={`/projects/${p.invoice.project.id}`} className="hover:underline">{p.invoice.project.name}</Link>
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">{p.invoice.client.name}</td>
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {paidDate ? new Date(paidDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted capitalize">{p.paymentMethod ?? "—"}</td>
                                            <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{fmt(p.amount)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                ))
            )}
        </div>
    );
}
