import { getProject, getProjectInvoices } from "@/lib/actions";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";

export default async function ProjectInvoices({ params }: { params: { id: string } }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return <div className="p-6">Project not found</div>;
    const invoices = await getProjectInvoices(id);

    return (
        <div className="flex h-full">
            <ProjectInnerSidebar projectId={project.id} />
            <div className="flex-1 overflow-auto bg-slate-50 p-8">
                <div className="max-w-6xl mx-auto space-y-6">
                    <div className="flex justify-between items-center">
                        <h1 className="text-2xl font-bold text-hui-textMain">Invoices</h1>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                        <div className="hui-card p-5">
                            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Total</p>
                            <p className="text-2xl font-bold text-hui-textMain">$0.00</p>
                        </div>
                        <div className="hui-card p-5">
                            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Paid</p>
                            <p className="text-2xl font-bold text-green-600">$0.00</p>
                        </div>
                        <div className="hui-card p-5">
                            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Balance</p>
                            <p className="text-2xl font-bold text-red-500">$0.00</p>
                        </div>
                    </div>

                    <div className="hui-card overflow-hidden">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-slate-50 text-hui-textMuted border-b border-hui-border">
                                <tr>
                                    <th className="px-6 py-3 font-medium">Invoice #</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Total</th>
                                    <th className="px-6 py-3 font-medium text-right">Balance Due</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {invoices.length === 0 && (
                                    <tr>
                                        <td colSpan={4} className="px-6 py-8 text-center text-slate-500">
                                            No invoices found. Create one from an estimate.
                                        </td>
                                    </tr>
                                )}
                                {invoices.map((inv: any) => (
                                    <tr key={inv.id} className="hover:bg-slate-50 transition">
                                        <td className="px-6 py-4 font-medium text-blue-600 hover:underline">
                                            <Link href={`/projects/${project.id}/invoices/${inv.id}`}>{inv.code}</Link>
                                        </td>
                                        <td className="px-6 py-4"><StatusBadge status={inv.status as NonNullable<React.ComponentProps<typeof StatusBadge>["status"]>} /></td>
                                        <td className="px-6 py-4 text-right">${(inv.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td className="px-6 py-4 text-right font-medium text-slate-800">${(inv.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
