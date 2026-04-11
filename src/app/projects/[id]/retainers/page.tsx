import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/lib/actions";
import DocumentCode from "@/components/DocumentCode";
import { formatCurrency } from "@/lib/utils";

export default async function RetainersPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;

    // Validate project
    const project = await getProject(resolvedParams.id);
    if (!project) notFound();

    const retainers = await prisma.retainer.findMany({
        where: { projectId: resolvedParams.id },
        orderBy: { createdAt: "desc" },
        include: { client: { select: { name: true } } }
    });

    const totalRetainers = retainers.reduce((sum, r) => sum + Number(r.totalAmount), 0);
    const totalPaid = retainers.reduce((sum, r) => sum + Number(r.amountPaid), 0);
    const totalDue = retainers.reduce((sum, r) => sum + Number(r.balanceDue), 0);

    const statusColor: Record<string, string> = {
        "Draft": "bg-slate-100 text-slate-700",
        "Sent": "bg-blue-100 text-blue-800",
        "Partially Paid": "bg-amber-100 text-amber-800",
        "Paid": "bg-emerald-100 text-emerald-800",
    };

    return (
        <div className="flex-1 flex flex-col items-stretch h-full overflow-hidden">
            <div className="flex-none p-6 pb-4 border-b border-hui-border bg-white flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Retainers & Credits</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Manage project retainers, upfront payments, and standing credits.</p>
                </div>
                <div className="flex items-center gap-3">
                    <Link href={`/projects/${resolvedParams.id}`} className="hui-btn hui-btn-secondary">
                        Back to Project
                    </Link>
                    <Link href={`/projects/${resolvedParams.id}/retainers/new`} className="hui-btn hui-btn-primary">
                        + New Retainer
                    </Link>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                {/* Summary Metrics */}
                <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="hui-card p-4 border-l-4 border-l-emerald-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Total Retainers</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {formatCurrency(totalRetainers)}
                        </p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-blue-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Amount Paid</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {formatCurrency(totalPaid)}
                        </p>
                    </div>
                    <div className="hui-card p-4 border-l-4 border-l-amber-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Balance Due</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            {formatCurrency(totalDue)}
                        </p>
                    </div>
                </div>

                <div className="hui-card p-0 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 border-b border-hui-border text-xs uppercase tracking-wider text-hui-textMuted">
                                <th className="px-4 py-3 font-semibold">Code</th>
                                <th className="px-4 py-3 font-semibold">Client</th>
                                <th className="px-4 py-3 font-semibold">Status</th>
                                <th className="px-4 py-3 font-semibold">Due Date</th>
                                <th className="px-4 py-3 relative text-right">Total</th>
                                <th className="px-4 py-3 relative text-right">Balance Due</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hui-border text-sm">
                            {retainers.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-4 py-8 text-center text-hui-textMuted">
                                        <p>No retainers or credits found for this project.</p>
                                        <Link href={`/projects/${resolvedParams.id}/retainers/new`} className="text-blue-600 hover:underline text-sm mt-2 inline-block">
                                            Create your first retainer
                                        </Link>
                                    </td>
                                </tr>
                            ) : (
                                retainers.map((retainer) => (
                                    <tr key={retainer.id} className="hover:bg-slate-50 transition group">
                                        <td className="px-4 py-4 font-medium text-hui-textMain">
                                            <Link href={`/projects/${resolvedParams.id}/retainers/${retainer.id}`} className="text-blue-600 hover:underline">
                                                {retainer.code}
                                            </Link>
                                        </td>
                                        <td className="px-4 py-4 text-hui-textMuted">
                                            {retainer.client?.name || '—'}
                                        </td>
                                        <td className="px-4 py-4">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColor[retainer.status] || "bg-slate-100 text-slate-700"}`}>
                                                {retainer.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-4 text-hui-textMuted">
                                            {retainer.dueDate ? retainer.dueDate.toLocaleDateString() : '—'}
                                        </td>
                                        <td className="px-4 py-4 text-right font-medium text-hui-textMain">
                                            {formatCurrency(Number(retainer.totalAmount))}
                                        </td>
                                        <td className="px-4 py-4 text-right font-medium text-hui-textMain">
                                            {formatCurrency(Number(retainer.balanceDue))}
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
