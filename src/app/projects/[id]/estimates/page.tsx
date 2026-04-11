import StatusBadge, { StatusType } from "@/components/StatusBadge";
import { getProject, createDraftEstimate, duplicateEstimate, getEstimateTemplates, createEstimateFromTemplate, getProjects } from "@/lib/actions";
import { redirect } from "next/navigation";
import Link from "next/link";
import EstimatesListClient from "./EstimatesListClient";
import CopyToProjectButton from "@/components/CopyToProjectButton";
import DeleteEstimateButton from "@/components/DeleteEstimateButton";
import { formatCurrency } from "@/lib/utils";

export default async function EstimatesPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const project = await getProject(resolvedParams.id);

    if (!project) return <div className="p-6">Project not found</div>;

    const estimates = project.estimates || [];
    let templates: any[] = [];
    try { templates = await getEstimateTemplates(); } catch {}

    // Active projects for "Copy to another project" feature — exclude Archived
    let allActiveProjects: { id: string; name: string }[] = [];
    try {
        const allProjs = await getProjects();
        allActiveProjects = allProjs
            .filter((p: any) => p.status !== "Archived")
            .map((p: any) => ({ id: p.id, name: p.name }));
    } catch {}

    // Calculate real stats
    const approvedEstimates = estimates.filter((e: any) => e.status === 'Approved' || e.status === 'Sent');
    const totalApproved = approvedEstimates.reduce((sum: number, e: any) => sum + Number(e.totalAmount || 0), 0);
    const totalAll = estimates.reduce((sum: number, e: any) => sum + Number(e.totalAmount || 0), 0);
    const winRate = estimates.length > 0 ? Math.round((approvedEstimates.length / estimates.length) * 100) : 0;

    async function handleNewEstimate() {
        "use server";
        const result = await createDraftEstimate(resolvedParams.id);
        redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
    }

    async function handleNewFromTemplate(formData: FormData) {
        "use server";
        const templateId = formData.get("templateId") as string;
        if (!templateId) return;
        const result = await createEstimateFromTemplate(resolvedParams.id, templateId);
        redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
    }

    async function handleDuplicate(formData: FormData) {
        "use server";
        const estimateId = formData.get("estimateId") as string;
        if (!estimateId) return;
        const result = await duplicateEstimate(estimateId);
        redirect(`/projects/${resolvedParams.id}/estimates/${result.id}`);
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <div className="flex-1 overflow-auto bg-gradient-to-br from-slate-50 via-white to-slate-50/50">
                <div className="p-8 max-w-6xl mx-auto">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <h1 className="text-2xl font-bold text-hui-textMain">Estimates</h1>
                            <p className="text-sm text-hui-textMuted mt-1">{estimates.length} estimate{estimates.length !== 1 ? 's' : ''} for {project.name}</p>
                        </div>
                        <EstimatesListClient
                            projectId={resolvedParams.id}
                            templates={templates}
                            handleNewEstimate={handleNewEstimate}
                            handleNewFromTemplate={handleNewFromTemplate}
                        />
                    </div>

                    {/* Stats Cards */}
                    <div className="grid grid-cols-3 gap-5 mb-8">
                        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-green-400 to-emerald-500" />
                            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Total Approved</p>
                            <p className="text-2xl font-bold text-slate-900">{formatCurrency(totalApproved)}</p>
                            <p className="text-[10px] text-slate-400 mt-1">{approvedEstimates.length} approved estimate{approvedEstimates.length !== 1 ? 's' : ''}</p>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-400 to-indigo-500" />
                            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Total Value</p>
                            <p className="text-2xl font-bold text-blue-600">{formatCurrency(totalAll)}</p>
                            <p className="text-[10px] text-slate-400 mt-1">Across all estimates</p>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-400 to-violet-500" />
                            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Win Rate</p>
                            <div className="flex items-end gap-2">
                                <p className="text-2xl font-bold text-purple-600">{winRate}%</p>
                                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden mb-1.5">
                                    <div className="h-full bg-gradient-to-r from-purple-400 to-violet-500 rounded-full transition-all" style={{ width: `${winRate}%` }} />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Estimates Table */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200/80 overflow-hidden">
                        <table className="w-full text-sm text-left">
                            <thead>
                                <tr className="bg-gradient-to-r from-slate-50 to-slate-100/50 border-b border-slate-200">
                                    <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider">Estimate Name</th>
                                    <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider">Status</th>
                                    <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider text-right">Total Amount</th>
                                    <th className="px-6 py-3.5 font-semibold text-xs text-slate-500 uppercase tracking-wider text-right">Date</th>
                                    <th className="w-24"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {estimates.length === 0 && (
                                    <tr>
                                        <td colSpan={5} className="px-6 py-16 text-center">
                                            <div className="flex flex-col items-center gap-3">
                                                <div className="w-14 h-14 bg-gradient-to-br from-indigo-100 to-purple-100 rounded-2xl flex items-center justify-center">
                                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
                                                </div>
                                                <p className="text-sm font-medium text-slate-500">No estimates yet</p>
                                                <p className="text-xs text-slate-400 max-w-xs">Create your first estimate to start tracking project costs and send proposals to clients.</p>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                                {estimates.map((est: any) => (
                                    <tr key={est.id} className="hover:bg-slate-50/80 transition group">
                                        <td className="px-6 py-4">
                                            <Link href={`/projects/${project.id}/estimates/${est.id}`} className="font-medium text-hui-textMain hover:text-hui-primary transition-colors flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center shrink-0 border border-indigo-100/50">
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
                                                </div>
                                                {est.title}
                                            </Link>
                                        </td>
                                        <td className="px-6 py-4"><StatusBadge status={est.status} /></td>
                                        <td className="px-6 py-4 text-right font-semibold text-slate-700">{formatCurrency(Number(est.totalAmount || 0))}</td>
                                        <td className="px-6 py-4 text-right text-slate-400 text-xs">{new Date(est.createdAt).toLocaleDateString()}</td>
                                        <td className="px-4 py-4 flex items-center gap-1 justify-end">
                                            <form action={handleDuplicate}>
                                                <input type="hidden" name="estimateId" value={est.id} />
                                                <button
                                                    type="submit"
                                                    title="Duplicate estimate (same project)"
                                                    className="text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded p-1.5 transition opacity-0 group-hover:opacity-100"
                                                >
                                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                                </button>
                                            </form>
                                            <CopyToProjectButton
                                                estimateId={est.id}
                                                estimateTitle={est.title}
                                                currentProjectId={resolvedParams.id}
                                                allProjects={allActiveProjects}
                                            />
                                            <DeleteEstimateButton
                                                estimateId={est.id}
                                                estimateTitle={est.title}
                                                status={est.status}
                                            />
                                            <Link href={`/projects/${project.id}/estimates/${est.id}`} className="text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>
                                            </Link>
                                        </td>
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
