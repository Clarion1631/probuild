export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

const TAX_RATE = 0.088; // 8.8% Washington state sales tax

export default async function TaxLiabilityPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (user && user.role !== "ADMIN" && user.role !== "FINANCE") {
        return <div className="p-8 text-red-500">Access Denied. Requires ADMIN or FINANCE role.</div>;
    }

    // Get all invoices with payments
    const invoices = await prisma.invoice.findMany({
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
            payments: true,
        },
        orderBy: { createdAt: "desc" },
    });

    // Calculate tax on each invoice and group by month
    type MonthData = {
        month: string;
        invoiceCount: number;
        totalRevenue: number;
        taxCollected: number;
        paidRevenue: number;
        paidTax: number;
    };

    const byMonth: Record<string, MonthData> = {};

    let grandTotalRevenue = 0;
    let grandTaxCollected = 0;
    let grandPaidRevenue = 0;
    let grandPaidTax = 0;

    for (const inv of invoices) {
        const d = inv.issueDate ?? inv.createdAt;
        const key = new Date(d).toLocaleString("en-US", { month: "long", year: "numeric" });

        if (!byMonth[key]) {
            byMonth[key] = { month: key, invoiceCount: 0, totalRevenue: 0, taxCollected: 0, paidRevenue: 0, paidTax: 0 };
        }

        const total = Number(inv.totalAmount) || 0;
        const taxOnInvoice = total * TAX_RATE;

        byMonth[key].invoiceCount++;
        byMonth[key].totalRevenue += total;
        byMonth[key].taxCollected += taxOnInvoice;

        grandTotalRevenue += total;
        grandTaxCollected += taxOnInvoice;

        // Check paid amounts
        const paidAmount = inv.payments
            .filter(p => p.status === "Paid")
            .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

        if (paidAmount > 0) {
            const paidTax = paidAmount * TAX_RATE;
            byMonth[key].paidRevenue += paidAmount;
            byMonth[key].paidTax += paidTax;
            grandPaidRevenue += paidAmount;
            grandPaidTax += paidTax;
        }
    }

    const months = Object.values(byMonth);

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Tax Liability Report</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Sales tax collected vs owed, grouped by month. Rate: {(TAX_RATE * 100).toFixed(1)}%</p>
                </div>
                <Link href="/reports" className="hui-btn hui-btn-secondary text-sm">
                    ← All Reports
                </Link>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">Total Revenue</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(grandTotalRevenue)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.length} invoices</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">Tax Owed</p>
                    <p className="text-2xl font-bold text-amber-600 mt-1">{fmt(grandTaxCollected)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">on all invoiced revenue</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">Paid Revenue</p>
                    <p className="text-2xl font-bold text-hui-primary mt-1">{fmt(grandPaidRevenue)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">collected so far</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider">Tax on Paid</p>
                    <p className="text-2xl font-bold text-emerald-600 mt-1">{fmt(grandPaidTax)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">owed on collected revenue</p>
                </div>
            </div>

            {/* Monthly Breakdown */}
            {months.length === 0 ? (
                <div className="hui-card p-12 text-center">
                    <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
                    </svg>
                    <h3 className="text-lg font-semibold text-slate-600 mb-1">No invoices found</h3>
                    <p className="text-sm text-slate-400">Create invoices to start tracking tax liability.</p>
                </div>
            ) : (
                <div className="hui-card overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 border-b border-hui-border">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Month</th>
                                <th className="px-6 py-3 text-right text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Invoices</th>
                                <th className="px-6 py-3 text-right text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Revenue</th>
                                <th className="px-6 py-3 text-right text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Tax Owed</th>
                                <th className="px-6 py-3 text-right text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Paid Revenue</th>
                                <th className="px-6 py-3 text-right text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Tax on Paid</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {months.map(m => (
                                <tr key={m.month} className="hover:bg-slate-50 transition">
                                    <td className="px-6 py-4 font-medium text-hui-textMain">{m.month}</td>
                                    <td className="px-6 py-4 text-right tabular-nums text-hui-textMuted">{m.invoiceCount}</td>
                                    <td className="px-6 py-4 text-right tabular-nums text-hui-textMain">{fmt(m.totalRevenue)}</td>
                                    <td className="px-6 py-4 text-right tabular-nums font-medium text-amber-600">{fmt(m.taxCollected)}</td>
                                    <td className="px-6 py-4 text-right tabular-nums text-hui-textMain">{fmt(m.paidRevenue)}</td>
                                    <td className="px-6 py-4 text-right tabular-nums font-medium text-emerald-600">{fmt(m.paidTax)}</td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot className="bg-slate-50 border-t-2 border-hui-border">
                            <tr className="font-semibold">
                                <td className="px-6 py-3 text-hui-textMain">Total</td>
                                <td className="px-6 py-3 text-right tabular-nums text-hui-textMain">{invoices.length}</td>
                                <td className="px-6 py-3 text-right tabular-nums text-hui-textMain">{fmt(grandTotalRevenue)}</td>
                                <td className="px-6 py-3 text-right tabular-nums text-amber-600">{fmt(grandTaxCollected)}</td>
                                <td className="px-6 py-3 text-right tabular-nums text-hui-textMain">{fmt(grandPaidRevenue)}</td>
                                <td className="px-6 py-3 text-right tabular-nums text-emerald-600">{fmt(grandPaidTax)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}
        </div>
    );
}
