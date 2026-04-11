import { getProject, createDraftEstimate, getEstimateTemplates, createEstimateFromTemplate, getProjects } from "@/lib/actions";
import { redirect } from "next/navigation";
import EstimatesListClient from "./EstimatesListClient";
import ProjectEstimatesTable from "./ProjectEstimatesTable";
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
                    <ProjectEstimatesTable
                        projectId={resolvedParams.id}
                        estimates={estimates}
                        allProjects={allActiveProjects}
                    />
                </div>
            </div>
        </div>
    );
}
