export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

type PayoutRow = {
    id: string;
    date: Date;
    vendorName: string;
    type: "Expense" | "Purchase Order";
    amount: number;
    projectName: string;
    projectId: string | null;
    paymentMethod: string | null;
    reference: string | null;
};

export default async function PayoutsReportPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user && process.env.NODE_ENV !== "development") {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    if (user && user.role !== "ADMIN" && user.role !== "MANAGER" && user.role !== "FINANCE") {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

    // Fetch expenses with project info via estimate
    const expenses = await prisma.expense.findMany({
        include: {
            estimate: {
                select: {
                    project: { select: { id: true, name: true } },
                },
            },
            purchaseOrder: {
                select: { code: true },
            },
        },
        orderBy: { date: "desc" },
    });

    // Fetch purchase orders (Sent or Received = committed payouts)
    const purchaseOrders = await prisma.purchaseOrder.findMany({
        where: { status: { in: ["Sent", "Received"] } },
        include: {
            project: { select: { id: true, name: true } },
            vendor: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    // Build unified rows
    const rows: PayoutRow[] = [];

    for (const exp of expenses) {
        rows.push({
            id: `exp-${exp.id}`,
            date: exp.date ?? exp.createdAt,
            vendorName: exp.vendor ?? "Unknown Vendor",
            type: "Expense",
            amount: Number(exp.amount),
            projectName: exp.estimate.project?.name ?? "No Project",
            projectId: exp.estimate.project?.id ?? null,
            paymentMethod: null,
            reference: exp.purchaseOrder?.code ?? null,
        });
    }

    for (const po of purchaseOrders) {
        rows.push({
            id: `po-${po.id}`,
            date: po.sentAt ?? po.createdAt,
            vendorName: po.vendor.name,
            type: "Purchase Order",
            amount: Number(po.totalAmount),
            projectName: po.project.name,
            projectId: po.project.id,
            paymentMethod: null,
            reference: po.code,
        });
    }

    // Sort by date descending
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Summary calculations
    const totalPayouts = rows.reduce((sum, r) => sum + r.amount, 0);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const thisMonthTotal = rows
        .filter((r) => new Date(r.date) >= thisMonthStart)
        .reduce((sum, r) => sum + r.amount, 0);

    const lastMonthTotal = rows
        .filter((r) => {
            const d = new Date(r.date);
            return d >= lastMonthStart && d <= lastMonthEnd;
        })
        .reduce((sum, r) => sum + r.amount, 0);

    // Average monthly: group by month, then average
    const monthlyTotals: Record<string, number> = {};
    for (const r of rows) {
        const key = `${new Date(r.date).getFullYear()}-${new Date(r.date).getMonth()}`;
        monthlyTotals[key] = (monthlyTotals[key] ?? 0) + r.amount;
    }
    const monthKeys = Object.keys(monthlyTotals);
    const avgMonthly = monthKeys.length > 0
        ? Object.values(monthlyTotals).reduce((a, b) => a + b, 0) / monthKeys.length
        : 0;

    const fmt = (n: number) =>
        n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Payouts</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    All outgoing payments: expenses, purchase orders, and subcontractor payments.
                </p>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Payouts</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(totalPayouts)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">This Month</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(thisMonthTotal)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Last Month</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(lastMonthTotal)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Avg Monthly</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(avgMonthly)}</p>
                </div>
            </div>

            {/* Table */}
            {rows.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">
                    No payouts recorded yet.
                </div>
            ) : (
                <div className="hui-card overflow-hidden">
                    <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                        <span className="text-sm font-semibold text-hui-textMain">
                            All Payouts
                        </span>
                        <span className="text-sm text-hui-textMuted">
                            {rows.length} transaction{rows.length !== 1 ? "s" : ""}
                        </span>
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
                            {rows.map((row) => (
                                <tr
                                    key={row.id}
                                    className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50"
                                >
                                    <td className="px-4 py-3 text-hui-textMuted">
                                        {new Date(row.date).toLocaleDateString("en-US", {
                                            month: "short",
                                            day: "numeric",
                                            year: "numeric",
                                        })}
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMain">{row.vendorName}</td>
                                    <td className="px-4 py-3">
                                        <span
                                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                                row.type === "Expense"
                                                    ? "bg-orange-100 text-orange-700"
                                                    : "bg-blue-100 text-blue-700"
                                            }`}
                                        >
                                            {row.type}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMain">
                                        {row.projectId ? (
                                            <Link
                                                href={`/projects/${row.projectId}`}
                                                className="hover:underline"
                                            >
                                                {row.projectName}
                                            </Link>
                                        ) : (
                                            <span className="text-hui-textMuted">{row.projectName}</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMuted font-mono text-xs">
                                        {row.reference ?? "—"}
                                    </td>
                                    <td className="px-4 py-3 text-right font-semibold text-hui-textMain">
                                        {fmt(row.amount)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
