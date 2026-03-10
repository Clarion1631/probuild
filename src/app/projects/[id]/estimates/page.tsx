import ProjectInnerSidebar from "@/components/ProjectInnerSidebar";
import StatusBadge, { StatusType } from "@/components/StatusBadge";
import Avatar from "@/components/Avatar";
import { getProject, createDraftEstimate } from "@/lib/actions";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function EstimatesPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);

    if (!project) return <div className="p-6">Project not found</div>;

    const estimates = project.estimates;

    async function handleNewEstimate() {
        "use server";
        const result = await createDraftEstimate(resolvedParams.id);
        redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <div className="flex-1 overflow-auto p-6 bg-white flex justify-between gap-6">
                <div className="flex-1">
                    <div className="flex items-center justify-between mb-6">
                        <h1 className="text-xl font-bold text-hui-textMain">Estimates</h1>
                        <form action={handleNewEstimate}>
                            <button type="submit" className="hui-btn hui-btn-primary">
                                New Estimate
                            </button>
                        </form>
                    </div>

                    <div className="flex items-center gap-4 mb-4">
                        <input type="text" placeholder="Search" className="hui-input w-64" />
                        <select className="hui-input w-auto"><option>Date Created: 01/...</option></select>
                        <select className="hui-input w-auto"><option>Type: Active</option></select>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Total Approved</p>
                            <p className="text-2xl font-bold text-slate-900">$0.00</p>
                        </div>
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Total Invoiced</p>
                            <p className="text-2xl font-bold text-blue-600">$0.00</p>
                        </div>
                        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Win Rate</p>
                            <p className="text-2xl font-bold text-green-600">0%</p>
                        </div>
                    </div>

                    <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-slate-50 text-slate-500 border-b border-slate-200">
                                <tr>
                                    <th className="px-6 py-3 font-medium">Estimate Name</th>
                                    <th className="px-6 py-3 font-medium">Status</th>
                                    <th className="px-6 py-3 font-medium text-right">Total Amount</th>
                                    <th className="px-6 py-3 font-medium text-right">Date</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {(!estimates || estimates.length === 0) && (
                                    <tr><td colSpan={4} className="px-6 py-8 text-center text-slate-500">No estimates found. Create one to get started.</td></tr>
                                )}
                                {estimates && estimates.map((est: any) => (
                                    <tr key={est.id} className="hover:bg-slate-50 transition">
                                        <td className="px-6 py-4 font-medium text-blue-600 hover:underline">
                                            <Link href={`/projects/${project.id}/estimates/${est.id}`}>{est.title}</Link>
                                        </td>
                                        <td className="px-6 py-4"><StatusBadge status={est.status} /></td>
                                        <td className="px-6 py-4 text-right">${(est.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td className="px-6 py-4 text-right text-slate-500">{new Date(est.createdAt).toLocaleDateString()}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="w-72 flex flex-col gap-6">
                    <div className="bg-white border text-center border-hui-border rounded-md p-6 shadow-sm">
                        <h3 className="font-semibold text-hui-textMain mb-2">Budget</h3>
                        <p className="text-xs text-hui-textMuted mb-4 px-2">Track your estimated costs against your actual spend. It all starts with an estimate.</p>
                        <button className="hui-btn hui-btn-primary w-full">Create a Budget</button>
                    </div>

                    <div className="bg-white border border-hui-border rounded-md p-6 shadow-sm">
                        <h3 className="font-semibold text-hui-textMain mb-2">Total Estimated Cost</h3>
                        <p className="text-2xl font-bold text-hui-textMain mb-6">$258,806.88</p>

                        <div className="space-y-4 text-sm">
                            <div>
                                <p className="text-hui-textMuted text-xs mb-1">Material</p>
                                <p className="font-medium text-hui-textMain">$183,128.01</p>
                            </div>
                            <div>
                                <p className="text-hui-textMuted text-xs mb-1">Labor</p>
                                <p className="font-medium text-hui-textMain">$54,964.75</p>
                            </div>
                            <div>
                                <p className="text-hui-textMuted text-xs mb-1">Tax</p>
                                <p className="font-medium text-hui-textMain">$20,714.12</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
