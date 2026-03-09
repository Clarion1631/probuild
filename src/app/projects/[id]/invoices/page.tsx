import { getProject, getProjectInvoices } from "@/lib/actions";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";

export default async function ProjectInvoices({ params }: { params: { id: string } }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return <div className="p-6 text-hui-textMain">Project not found</div>;
    const invoices = await getProjectInvoices(id);

    // Calculate metrics
    const totalAmount = invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const balanceDue = invoices.reduce((sum, inv) => sum + (inv.balanceDue || 0), 0);
    const totalPaid = totalAmount - balanceDue;

    return (
        <div className="flex h-full bg-hui-background">
            <ProjectInnerSidebar projectId={project.id} />
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-6xl mx-auto space-y-6">
                    <div className="flex justify-between items-center">
                        <h1 className="text-2xl font-bold text-hui-textMain">Invoices</h1>
                        <Link 
                            href={`/projects/${project.id}/invoices/new`}
                            className="hui-btn hui-btn-primary flex items-center gap-2"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
                            New Invoice
                        </Link>
                    </div>

                    {/* Metrics Grid */}
                    <div className="grid grid-cols-3 gap-4">
                        <div className="hui-card p-5">
                            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Total Invoiced</p>
                            <p className="text-2xl font-bold text-hui-textMain">${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </div>
                        <div className="hui-card p-5">
                            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Paid</p>
                            <p className="text-2xl font-bold text-hui-primary">${totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </div>
                        <div className="hui-card p-5">
                            <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Balance Due</p>
                            <p className="text-2xl font-bold text-red-600">${balanceDue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </div>
                    </div>

                    <div className="hui-card overflow-hidden">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-slate-50 text-hui-textMuted border-b border-hui-border">
                                <tr>
                                    <th className="px-6 py-3 font-medium">Invoice #</th>
                                    <th className="px-6 py-3 font-medium">Issue Date</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Total</th>
                                    <th className="px-6 py-3 font-medium text-right">Balance Due</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {invoices.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-12 text-center text-hui-textMuted">
                                            <div className="flex flex-col items-center justify-center">
                                                <svg className="w-12 h-12 mb-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                                <p className="text-base font-medium text-hui-textMain mb-1">No invoices yet</p>
                                                <p className="text-sm mb-4">Create an invoice from your project estimates.</p>
                                                <Link 
                                                    href={`/projects/${project.id}/invoices/new`}
                                                    className="hui-btn hui-btn-secondary"
                                                >
                                                    Create Invoice
                                                </Link>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {invoices.map((inv: any) => (
                                    <tr key={inv.id} className="hover:bg-slate-50 transition">
                                        <td className="px-6 py-4 font-medium text-blue-600 hover:underline">
                                            <Link href={`/projects/${project.id}/invoices/${inv.id}`}>{inv.code}</Link>
                                        </td>
                                        <td className="px-6 py-4 text-hui-textMain">
                                            {inv.issueDate ? new Date(inv.issueDate).toLocaleDateString() : new Date(inv.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4"><StatusBadge status={inv.status as NonNullable<React.ComponentProps<typeof StatusBadge>["status"]>} /></td>
                                        <td className="px-6 py-4 text-right text-hui-textMain">${(inv.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td className="px-6 py-4 text-right font-medium text-hui-textMain">${(inv.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
