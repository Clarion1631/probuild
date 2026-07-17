export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import { parseTransactionsFilters, queryTransactionsData } from "@/lib/transactions-report";
import { formatLocalDateString } from "@/lib/report-utils";
import TransactionsFiltersForm from "./TransactionsFiltersForm";

export default async function TransactionsReportPage({
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
    const filters = parseTransactionsFilters(params);

    const [{ rows, summary }, projects] = await Promise.all([
        queryTransactionsData(filters),
        prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    // Group by project for "By Project" tab
    const byProjectMap: Record<string, { projectName: string; projectId: string | null; incoming: number; outgoing: number; rows: typeof rows }> = {};
    for (const r of rows) {
        const key = r.projectId ?? "no-project";
        if (!byProjectMap[key]) byProjectMap[key] = { projectName: r.projectName, projectId: r.projectId, incoming: 0, outgoing: 0, rows: [] };
        if (r.type === "Income") byProjectMap[key].incoming += r.amount;
        else byProjectMap[key].outgoing += r.amount;
        byProjectMap[key].rows.push(r);
    }

    // Serialize dates for client component
    const serializedRows = rows.map(r => ({ ...r, date: new Date(r.date).toISOString() }));
    const serializedByProject = Object.entries(byProjectMap).map(([key, val]) => ({
        key, ...val,
        rows: val.rows.map(r => ({ ...r, date: new Date(r.date).toISOString() })),
    }));

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
    const dateLabel = `${formatLocalDateString(filters.from)} → ${formatLocalDateString(filters.to)}`;

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Transactions</h1>
                <p className="text-sm text-hui-textMuted mt-1">All incoming and outgoing transactions · {dateLabel}</p>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Incoming</p>
                    <p className="text-2xl font-bold text-green-600 mt-1">{fmt(summary.incoming)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Outgoing</p>
                    <p className="text-2xl font-bold text-red-500 mt-1">{fmt(summary.outgoing)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Net Cash Flow</p>
                    <p className={`text-2xl font-bold mt-1 ${summary.net >= 0 ? "text-green-600" : "text-red-500"}`}>{fmt(summary.net)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Transaction Count</p>
                    <p className="text-2xl font-bold text-hui-textMain mt-1">{summary.count}</p>
                </div>
            </div>

            <TransactionsFiltersForm
                filters={filters}
                rows={serializedRows}
                byProject={serializedByProject}
                projects={projects}
            />
        </div>
    );
}
