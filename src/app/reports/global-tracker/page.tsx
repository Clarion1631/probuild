export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function GlobalTrackerPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const projects = await prisma.project.findMany({
        orderBy: { createdAt: "desc" },
        include: {
            client: { select: { name: true } },
            estimates: { select: { totalAmount: true, status: true } },
            invoices: { select: { totalAmount: true, balanceDue: true, status: true } },
            scheduleTasks: { select: { id: true, status: true } },
            dailyLogs: { select: { createdAt: true } },
            changeOrders: { select: { createdAt: true } },
        },
    });

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    type Row = {
        id: string;
        name: string;
        client: string;
        status: string;
        budget: number;
        invoiced: number;
        paid: number;
        balance: number;
        schedPct: number | null;
        lastActivity: Date | null;
    };

    const rows: Row[] = projects.map(p => {
        const budget = p.estimates.reduce((s, e) => s + Number(e.totalAmount), 0);
        const invoiced = p.invoices.reduce((s, i) => s + Number(i.totalAmount), 0);
        const balance = p.invoices.reduce((s, i) => s + Number(i.balanceDue), 0);
        const paid = invoiced - balance;

        const tasks = p.scheduleTasks;
        const schedPct = tasks.length > 0
            ? Math.round((tasks.filter(t => t.status === "Complete").length / tasks.length) * 100)
            : null;

        const dates: Date[] = [
            ...p.dailyLogs.map(d => new Date(d.createdAt)),
            ...p.changeOrders.map(d => new Date(d.createdAt)),
        ];
        const lastActivity = dates.length > 0 ? dates.reduce((a, b) => a > b ? a : b) : null;

        return {
            id: p.id,
            name: p.name,
            client: p.client.name,
            status: p.status,
            budget,
            invoiced,
            paid,
            balance,
            schedPct,
            lastActivity,
        };
    });

    const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
    const totalInvoiced = rows.reduce((s, r) => s + r.invoiced, 0);
    const totalPaid = rows.reduce((s, r) => s + r.paid, 0);
    const totalBalance = rows.reduce((s, r) => s + r.balance, 0);

    const statusColor = (s: string) => {
        if (s === "In Progress") return "bg-blue-100 text-blue-700";
        if (s === "Closed") return "bg-gray-100 text-gray-600";
        if (s === "Paid Ready to Start") return "bg-green-100 text-green-700";
        return "bg-gray-100 text-gray-600";
    };

    return (
        <div className="max-w-7xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Global Project Tracker</h1>
                <p className="text-sm text-hui-textMuted mt-1">Cross-project financial and schedule overview.</p>
            </div>

            {/* Summary stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Budget</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(totalBudget)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Invoiced</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(totalInvoiced)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Collected</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">{fmt(totalPaid)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Outstanding</p>
                    <p className="text-2xl font-bold text-yellow-600 mt-1">{fmt(totalBalance)}</p>
                </div>
            </div>

            {/* Table */}
            <div className="hui-card overflow-hidden">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border bg-hui-surface">
                            <th className="px-4 py-3">Project</th>
                            <th className="px-4 py-3">Client</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3 text-right">Budget</th>
                            <th className="px-4 py-3 text-right">Invoiced</th>
                            <th className="px-4 py-3 text-right">Collected</th>
                            <th className="px-4 py-3 text-right">Balance</th>
                            <th className="px-4 py-3">Schedule</th>
                            <th className="px-4 py-3">Last Activity</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={r.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                <td className="px-4 py-3 font-medium">
                                    <Link href={`/projects/${r.id}`} className="text-hui-primary hover:underline">{r.name}</Link>
                                </td>
                                <td className="px-4 py-3 text-hui-textMuted">{r.client}</td>
                                <td className="px-4 py-3">
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(r.status)}`}>
                                        {r.status}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-right text-hui-textMuted">{r.budget > 0 ? fmt(r.budget) : "—"}</td>
                                <td className="px-4 py-3 text-right text-hui-textMuted">{r.invoiced > 0 ? fmt(r.invoiced) : "—"}</td>
                                <td className="px-4 py-3 text-right text-green-600 font-medium">{r.paid > 0 ? fmt(r.paid) : "—"}</td>
                                <td className="px-4 py-3 text-right text-hui-textMain font-semibold">{r.balance > 0 ? fmt(r.balance) : "—"}</td>
                                <td className="px-4 py-3">
                                    {r.schedPct !== null ? (
                                        <div className="flex items-center gap-2">
                                            <div className="flex-1 h-1.5 bg-hui-border rounded-full overflow-hidden min-w-[60px]">
                                                <div className="h-full bg-hui-primary rounded-full" style={{ width: `${r.schedPct}%` }} />
                                            </div>
                                            <span className="text-xs text-hui-textMuted whitespace-nowrap">{r.schedPct}%</span>
                                        </div>
                                    ) : (
                                        <span className="text-xs text-hui-textMuted">—</span>
                                    )}
                                </td>
                                <td className="px-4 py-3 text-xs text-hui-textMuted">
                                    {r.lastActivity ? new Date(r.lastActivity).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                                </td>
                            </tr>
                        ))}
                        {/* Summary row */}
                        <tr className="bg-hui-surface font-semibold border-t-2 border-hui-border">
                            <td className="px-4 py-3 text-hui-textMain" colSpan={3}>Total ({rows.length} projects)</td>
                            <td className="px-4 py-3 text-right text-hui-textMain">{fmt(totalBudget)}</td>
                            <td className="px-4 py-3 text-right text-hui-textMain">{fmt(totalInvoiced)}</td>
                            <td className="px-4 py-3 text-right text-green-600">{fmt(totalPaid)}</td>
                            <td className="px-4 py-3 text-right text-hui-textMain">{fmt(totalBalance)}</td>
                            <td className="px-4 py-3" colSpan={2} />
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
}
