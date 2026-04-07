import { getCompanySettings, getProject } from "@/lib/actions";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCurrency } from "@/lib/utils";

export default async function ChangeOrdersPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    
    const [project, changeOrders, invoices] = await Promise.all([
        getProject(resolvedParams.id),
        prisma.changeOrder.findMany({
            where: { projectId: resolvedParams.id },
            orderBy: { createdAt: "desc" },
            include: { estimate: { select: { id: true, code: true, title: true, status: true, totalAmount: true } } }
        }),
        prisma.invoice.findMany({
            where: { projectId: resolvedParams.id, status: { not: "Draft" } }
        })
    ]);

    if (!project) notFound();

    const totalInvoiced = invoices.reduce((sum: number, inv: any) => sum + Number(inv.totalAmount), 0);
    const totalCOs = changeOrders.reduce((sum: number, co: any) => sum + Number(co.totalAmount), 0);

    return (
        <div className="flex-1 flex flex-col items-stretch h-full overflow-hidden">
            <div className="flex-none p-6 pb-4 border-b border-hui-border bg-white flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Change Orders</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Manage modifications to the project scope and budget.</p>
                </div>
                <div className="flex items-center gap-3">
                    <Link href={`/projects/${resolvedParams.id}`} className="hui-btn hui-btn-secondary">
                        Back to Project
                    </Link>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                {/* Summary Metrics */}
                <div className="grid grid-cols-4 gap-4 mb-6">
                    <div className="hui-card p-4 border-l-4 border-l-blue-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Total (All COs)</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {formatCurrency(totalCOs)}
                        </p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-orange-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Unapplied Payments</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">$0.00</p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-green-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Invoiced</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {formatCurrency(totalInvoiced)}
                        </p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-amber-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Balance</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {formatCurrency(totalCOs)}
                        </p>
                    </div>
                </div>

                <div className="hui-card p-0 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 border-b border-hui-border text-xs uppercase tracking-wider text-hui-textMuted">
                                <th className="px-4 py-3 font-semibold">Title</th>
                                <th className="px-4 py-3 font-semibold">Code</th>
                                <th className="px-4 py-3 font-semibold">Status</th>
                                <th className="px-4 py-3 font-semibold">Base Estimate</th>
                                <th className="px-4 py-3 font-semibold">Created</th>
                                <th className="px-4 py-3 relative text-right">Total</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hui-border text-sm">
                            {changeOrders.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-4 py-8 text-center text-hui-textMuted">
                                        <p>No change orders found.</p>
                                        <p className="text-xs mt-1">Go to an Estimate and select items to generate a Change Order.</p>
                                    </td>
                                </tr>
                            ) : (
                                changeOrders.map((co) => (
                                    <tr key={co.id} className="hover:bg-slate-50 transition group">
                                        <td className="px-4 py-4 font-medium text-hui-textMain">
                                            <Link href={`/projects/${resolvedParams.id}/change-orders/${co.id}`} className="hover:text-hui-primary transition">
                                                {co.title}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-4 text-hui-textMuted">{co.code}</td>
                                        <td className="px-4 py-4">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                                co.status === "Approved" ? "bg-green-100 text-green-800" :
                                                co.status === "Sent" ? "bg-blue-100 text-blue-800" :
                                                co.status === "Declined" ? "bg-red-100 text-red-800" :
                                                "bg-gray-100 text-gray-800"
                                            }`}>
                                                {co.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-4 text-hui-textMuted">
                                            {co.estimate?.code}
                                        </td>
                                        <td className="px-4 py-4 text-hui-textMuted">
                                            {co.createdAt.toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-4 text-right font-medium text-hui-textMain">
                                            {formatCurrency(co.totalAmount)}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
