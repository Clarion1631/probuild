export const dynamic = "force-dynamic";
import { prisma } from "@/lib/prisma";
import { getSessionOrDev } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

function agingBucket(issueDate: Date | null): string {
    if (!issueDate) return "90+";
    const days = Math.floor((Date.now() - new Date(issueDate).getTime()) / (1000 * 60 * 60 * 24));
    if (days <= 30) return "0–30";
    if (days <= 60) return "31–60";
    if (days <= 90) return "61–90";
    return "90+";
}

const BUCKET_ORDER = ["0–30", "31–60", "61–90", "90+"];

export default async function OpenInvoicesPage() {
    const session = await getSessionOrDev();
    if (!session?.user) return redirect("/login");

    const invoices = await prisma.invoice.findMany({
        where: { status: { in: ["Issued", "Overdue"] } },
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
        },
        orderBy: { issueDate: "asc" },
    });

    const totalOutstanding = invoices.reduce((sum, inv) => sum + inv.balanceDue, 0);
    const overdueCount = invoices.filter(i => i.status === "Overdue").length;

    const byBucket: Record<string, typeof invoices> = { "0–30": [], "31–60": [], "61–90": [], "90+": [] };
    for (const inv of invoices) {
        const bucket = agingBucket(inv.issueDate);
        byBucket[bucket].push(inv);
    }

    const bucketTotals = BUCKET_ORDER.map(b => ({
        label: b,
        count: byBucket[b].length,
        total: byBucket[b].reduce((s, i) => s + i.balanceDue, 0),
    }));

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-hui-textMain">Open Invoices</h1>
                <p className="text-sm text-hui-textMuted mt-1">Invoices that have been issued but not yet paid.</p>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {bucketTotals.map(b => (
                    <div key={b.label} className="hui-card p-4">
                        <p className="text-xs text-hui-textMuted font-medium">{b.label} days</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">{fmt(b.total)}</p>
                        <p className="text-xs text-hui-textMuted mt-1">{b.count} invoice{b.count !== 1 ? "s" : ""}</p>
                    </div>
                ))}
            </div>

            {/* Totals banner */}
            <div className="hui-card p-4 flex items-center justify-between">
                <div>
                    <p className="text-sm text-hui-textMuted">Total Outstanding</p>
                    <p className="text-3xl font-bold text-hui-textMain">{fmt(totalOutstanding)}</p>
                </div>
                <div className="text-right">
                    <p className="text-sm text-hui-textMuted">Open Invoices</p>
                    <p className="text-3xl font-bold text-hui-textMain">{invoices.length}</p>
                </div>
                <div className="text-right">
                    <p className="text-sm text-hui-textMuted">Overdue</p>
                    <p className="text-3xl font-bold text-red-500">{overdueCount}</p>
                </div>
            </div>

            {/* Table by aging bucket */}
            {invoices.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No open invoices.</div>
            ) : (
                BUCKET_ORDER.filter(b => byBucket[b].length > 0).map(bucket => (
                    <div key={bucket} className="hui-card overflow-hidden">
                        <div className="px-4 py-3 border-b border-hui-border bg-hui-surface">
                            <span className="text-sm font-semibold text-hui-textMain">{bucket} days</span>
                            <span className="ml-2 text-sm text-hui-textMuted">({byBucket[bucket].length} invoices · {fmt(byBucket[bucket].reduce((s, i) => s + i.balanceDue, 0))})</span>
                        </div>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                    <th className="px-4 py-2">Invoice #</th>
                                    <th className="px-4 py-2">Project</th>
                                    <th className="px-4 py-2">Client</th>
                                    <th className="px-4 py-2">Issue Date</th>
                                    <th className="px-4 py-2 text-right">Total</th>
                                    <th className="px-4 py-2 text-right">Balance Due</th>
                                    <th className="px-4 py-2">Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {byBucket[bucket].map(inv => (
                                    <tr key={inv.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                        <td className="px-4 py-3 font-mono text-xs">
                                            <Link href={`/projects/${inv.project.id}/invoices/${inv.id}`} className="text-hui-primary hover:underline">
                                                {inv.code}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">
                                            <Link href={`/projects/${inv.project.id}`} className="hover:underline">{inv.project.name}</Link>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">{inv.client.name}</td>
                                        <td className="px-4 py-3 text-hui-textMuted">
                                            {inv.issueDate ? new Date(inv.issueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                                        </td>
                                        <td className="px-4 py-3 text-right text-hui-textMain">{fmt(inv.totalAmount)}</td>
                                        <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{fmt(inv.balanceDue)}</td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${inv.status === "Overdue" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                                                {inv.status}
                                            </span>
                                        </td>
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
