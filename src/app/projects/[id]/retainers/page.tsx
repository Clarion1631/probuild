import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/lib/actions";

export default async function RetainersPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    
    // Validate project
    const project = await getProject(resolvedParams.id);
    if (!project) notFound();

    const retainers = await prisma.retainer.findMany({
        where: { projectId: resolvedParams.id },
        orderBy: { date: "desc" }
    });

    const totalRetainers = retainers.reduce((sum, r) => sum + r.amount, 0);

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
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 bg-hui-background">
                {/* Summary Metrics */}
                <div className="grid grid-cols-4 gap-4 mb-6">
                    <div className="hui-card p-4 border-l-4 border-l-emerald-500">
                        <p className="text-xs font-semibold text-hui-textMuted uppercase">Total Retainers</p>
                        <p className="text-2xl font-bold text-hui-textMain mt-1">
                            ${totalRetainers.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>

                <div className="hui-card p-0 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50 border-b border-hui-border text-xs uppercase tracking-wider text-hui-textMuted">
                                <th className="px-4 py-3 font-semibold">Title</th>
                                <th className="px-4 py-3 font-semibold">Status</th>
                                <th className="px-4 py-3 font-semibold">Date</th>
                                <th className="px-4 py-3 relative text-right">Amount</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-hui-border text-sm">
                            {retainers.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className="px-4 py-8 text-center text-hui-textMuted">
                                        <p>No retainers or credits found for this project.</p>
                                    </td>
                                </tr>
                            ) : (
                                retainers.map((retainer) => (
                                    <tr key={retainer.id} className="hover:bg-slate-50 transition group">
                                        <td className="px-4 py-4 font-medium text-hui-textMain">
                                            {retainer.name || 'Project Retainer'}
                                        </td>
                                        <td className="px-4 py-4">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800`}>
                                                {retainer.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-4 text-hui-textMuted">
                                            {retainer.date.toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-4 text-right font-medium text-hui-textMain">
                                            ${retainer.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
