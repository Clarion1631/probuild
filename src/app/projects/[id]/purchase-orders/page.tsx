import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";

export default async function PurchaseOrdersPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id: projectId } = await params;
    
    // Auth Check
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) redirect("/login");

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            purchaseOrders: {
                include: {
                    vendor: true,
                    items: true
                },
                orderBy: { createdAt: "desc" }
            }
        }
    });

    if (!project) redirect("/projects");

    const pos = project.purchaseOrders;

    return (
        <div className="w-full max-w-6xl mx-auto pb-20">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Purchase Orders</h1>
                    <p className="text-sm text-hui-textLight">Manage POs sent to vendors for {project.name}</p>
                </div>
                <div className="flex items-center gap-3">
                    <Link
                        href={`/projects/${projectId}/purchase-orders/new`}
                        className="hui-btn hui-btn-primary flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        Create PO
                    </Link>
                </div>
            </div>

            {/* List */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <table className="w-full text-left text-sm text-hui-textMain">
                    <thead className="bg-slate-50 border-b border-hui-border text-[11px] uppercase text-hui-textMuted tracking-wider">
                        <tr>
                            <th className="px-5 py-3.5 font-semibold">PO Number</th>
                            <th className="px-5 py-3.5 font-semibold">Vendor</th>
                            <th className="px-5 py-3.5 font-semibold">Status</th>
                            <th className="px-5 py-3.5 font-semibold">Date</th>
                            <th className="px-5 py-3.5 font-semibold text-right">Amount</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {pos.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                                    No purchase orders created yet.
                                </td>
                            </tr>
                        ) : (
                            pos.map(po => {
                                const total = po.totalAmount;
                                return (
                                    <tr key={po.id} className="hover:bg-slate-50/80 transition group relative">
                                        <td className="px-5 py-4 font-semibold text-hui-textMain">
                                            <Link href={`/projects/${projectId}/purchase-orders/${po.id}`} className="absolute inset-0" />
                                            {po.code}
                                        </td>
                                        <td className="px-5 py-4">{po.vendor.name}</td>
                                        <td className="px-5 py-4">
                                            <StatusBadge status={po.status} />
                                        </td>
                                        <td className="px-5 py-4 text-slate-500">
                                            {new Date(po.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-5 py-4 text-right font-medium tabular-nums">
                                            ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
