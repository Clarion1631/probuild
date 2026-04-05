export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import TransactionTabs from "./TransactionTabs";

type TransactionRow = {
    id: string;
    date: Date;
    description: string;
    type: "Income" | "Expense";
    amount: number;
    projectName: string;
    projectId: string | null;
    category: string;
};

export default async function TransactionsReportPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
    if (!user && process.env.NODE_ENV !== "development") {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }
    if (user && user.role !== "ADMIN" && user.role !== "MANAGER" && user.role !== "FINANCE") {
        return <div className="p-8 text-red-500">Access Denied.</div>;
    }

    // Incoming: Paid payment schedules
    const paidPayments = await prisma.paymentSchedule.findMany({
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

    // Outgoing: Expenses
    const expenses = await prisma.expense.findMany({
        include: {
            estimate: {
                select: {
                    project: { select: { id: true, name: true } },
                },
            },
        },
        orderBy: { date: "desc" },
    });

    // Outgoing: Purchase Orders (Sent or Received)
    const purchaseOrders = await prisma.purchaseOrder.findMany({
        where: { status: { in: ["Sent", "Received"] } },
        include: {
            project: { select: { id: true, name: true } },
            vendor: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    // Build unified rows
    const rows: TransactionRow[] = [];

    for (const p of paidPayments) {
        rows.push({
            id: `pay-${p.id}`,
            date: p.paidAt ?? p.paymentDate ?? p.createdAt,
            description: `Payment: ${p.name} (${p.invoice.code})`,
            type: "Income",
            amount: Number(p.amount),
            projectName: p.invoice.project.name,
            projectId: p.invoice.project.id,
            category: "Invoice Payment",
        });
    }

    for (const exp of expenses) {
        rows.push({
            id: `exp-${exp.id}`,
            date: exp.date ?? exp.createdAt,
            description: exp.description ?? exp.vendor ?? "Expense",
            type: "Expense",
            amount: Number(exp.amount),
            projectName: exp.estimate.project?.name ?? "No Project",
            projectId: exp.estimate.project?.id ?? null,
            category: "Expense",
        });
    }

    for (const po of purchaseOrders) {
        rows.push({
            id: `po-${po.id}`,
            date: po.sentAt ?? po.createdAt,
            description: `PO ${po.code} — ${po.vendor.name}`,
            type: "Expense",
            amount: Number(po.totalAmount),
            projectName: po.project.name,
            projectId: po.project.id,
            category: "Purchase Order",
        });
    }

    // Sort by date descending
    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Summary calculations
    const totalIncoming = rows
        .filter((r) => r.type === "Income")
        .reduce((sum, r) => sum + r.amount, 0);
    const totalOutgoing = rows
        .filter((r) => r.type === "Expense")
        .reduce((sum, r) => sum + r.amount, 0);
    const netCashFlow = totalIncoming - totalOutgoing;

    const fmt = (n: number) =>
        n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    // Group by project for "By Project" tab
    const byProject: Record<string, { projectName: string; projectId: string | null; incoming: number; outgoing: number; rows: TransactionRow[] }> = {};
    for (const r of rows) {
        const key = r.projectId ?? "no-project";
        if (!byProject[key]) {
            byProject[key] = { projectName: r.projectName, projectId: r.projectId, incoming: 0, outgoing: 0, rows: [] };
        }
        if (r.type === "Income") byProject[key].incoming += r.amount;
        else byProject[key].outgoing += r.amount;
        byProject[key].rows.push(r);
    }

    // Serialize dates for client component
    const serializedRows = rows.map((r) => ({
        ...r,
        date: new Date(r.date).toISOString(),
    }));

    const serializedByProject = Object.entries(byProject).map(([key, val]) => ({
        key,
        ...val,
        rows: val.rows.map((r) => ({ ...r, date: new Date(r.date).toISOString() })),
    }));

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Transactions</h1>
                <p className="text-sm text-hui-textMuted mt-1">
                    All incoming and outgoing transactions in one view.
                </p>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Incoming</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">{fmt(totalIncoming)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Outgoing</p>
                    <p className="text-2xl font-bold text-red-500 mt-1">{fmt(totalOutgoing)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Net Cash Flow</p>
                    <p className={`text-2xl font-bold mt-1 ${netCashFlow >= 0 ? "text-green-600" : "text-red-500"}`}>
                        {fmt(netCashFlow)}
                    </p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Transaction Count</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{rows.length}</p>
                </div>
            </div>

            {/* Tabs */}
            <TransactionTabs
                rows={serializedRows}
                byProject={serializedByProject}
            />
        </div>
    );
}
