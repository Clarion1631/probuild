import { getLead, createDraftLeadEstimate, getProjects } from "@/lib/actions";
import { redirect } from "next/navigation";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import LeadEstimatesTable from "./LeadEstimatesTable";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function LeadEstimatesPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);

    if (!lead) return <div className="p-6">Lead not found</div>;

    // Project estimates (from the linked project, if any)
    const linkedProject = lead.project as { id: string; name: string; estimates: any[] } | null;
    const projectEstimates: any[] = (linkedProject?.estimates || []).map((e: any) => ({ ...e, _source: "project" }));

    // Converted estimates carry both leadId and projectId — exclude them from the
    // lead section so they only appear once, in the "Project Estimates" section.
    const projectEstimateIds = new Set<string>(projectEstimates.map((e: any) => e.id));
    const leadEstimates: any[] = (lead.estimates || [])
        .filter((e: any) => !projectEstimateIds.has(e.id))
        .map((e: any) => ({ ...e, _source: "lead" }));

    // Combined for stats (already deduplicated by construction above)
    const allEstimates = [...leadEstimates, ...projectEstimates];

    const APPROVED_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];
    const approvedEstimates = allEstimates.filter((e: any) => APPROVED_STATUSES.includes(e.status));
    const totalApproved = approvedEstimates.reduce((sum: number, e: any) => sum + Number(e.totalAmount || 0), 0);
    const totalAll = allEstimates.reduce((sum: number, e: any) => sum + Number(e.totalAmount || 0), 0);

    // Active projects for "Copy to project" bulk action — exclude Archived
    let allActiveProjects: { id: string; name: string }[] = [];
    try {
        const allProjs = await getProjects();
        allActiveProjects = allProjs
            .filter((p: any) => p.status !== "Archived")
            .map((p: any) => ({ id: p.id, name: p.name }));
    } catch {}

    async function handleNewEstimate() {
        "use server";
        const result = await createDraftLeadEstimate(resolvedParams.id);
        redirect(`/leads/${resolvedParams.id}/estimates/${result.id}`);
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <div className="flex-1 overflow-auto bg-gradient-to-br from-slate-50 via-white to-slate-50/50">
                <div className="p-8 max-w-5xl mx-auto">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-8">
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <Link href={`/leads/${lead.id}`} className="text-sm text-slate-400 hover:text-slate-600 transition">
                                    ← {lead.name}
                                </Link>
                            </div>
                            <h1 className="text-2xl font-bold text-hui-textMain">Estimates</h1>
                            <p className="text-sm text-hui-textMuted mt-1">{allEstimates.length} estimate{allEstimates.length !== 1 ? "s" : ""} for {lead.name}</p>
                        </div>
                        <form action={handleNewEstimate}>
                            <button type="submit" className="px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold rounded-lg transition shadow-sm flex items-center gap-2">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                New Estimate
                            </button>
                        </form>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-5 mb-8">
                        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm relative overflow-hidden">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-green-400 to-emerald-500" />
                            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Total Approved</p>
                            <p className="text-2xl font-bold text-slate-900">{formatCurrency(totalApproved)}</p>
                            <p className="text-[10px] text-slate-400 mt-1">{approvedEstimates.length} approved</p>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm relative overflow-hidden">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-400 to-indigo-500" />
                            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Total Value</p>
                            <p className="text-2xl font-bold text-blue-600">{formatCurrency(totalAll)}</p>
                            <p className="text-[10px] text-slate-400 mt-1">Across all estimates</p>
                        </div>
                        <div className="bg-white p-5 rounded-xl border border-slate-200/80 shadow-sm relative overflow-hidden">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-400 to-violet-500" />
                            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Estimates</p>
                            <p className="text-2xl font-bold text-purple-600">{allEstimates.length}</p>
                            <p className="text-[10px] text-slate-400 mt-1">Total created</p>
                        </div>
                    </div>

                    {/* Project estimates section */}
                    {projectEstimates.length > 0 && (
                        <div className="mb-8">
                            <div className="flex items-center gap-3 mb-3">
                                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Project Estimates</h2>
                                <span className="text-xs text-slate-400">·</span>
                                <Link href={`/projects/${linkedProject!.id}/estimates`} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium transition">
                                    {linkedProject!.name} →
                                </Link>
                            </div>
                            <div className="bg-white rounded-xl shadow-sm border border-indigo-100 overflow-hidden">
                                <table className="w-full text-sm text-left">
                                    <thead>
                                        <tr className="bg-indigo-50/60 border-b border-indigo-100">
                                            <th className="px-6 py-3 font-semibold text-xs text-indigo-400 uppercase tracking-wider">Estimate</th>
                                            <th className="px-6 py-3 font-semibold text-xs text-indigo-400 uppercase tracking-wider">Status</th>
                                            <th className="px-6 py-3 font-semibold text-xs text-indigo-400 uppercase tracking-wider text-right">Amount</th>
                                            <th className="px-6 py-3 font-semibold text-xs text-indigo-400 uppercase tracking-wider text-right">Date</th>
                                            <th className="w-12"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100">
                                        {projectEstimates.map((est: any) => (
                                            <tr key={est.id} className="hover:bg-slate-50/80 transition group">
                                                <td className="px-6 py-4">
                                                    <Link href={`/projects/${linkedProject!.id}/estimates/${est.id}`} className="font-medium text-hui-textMain hover:text-hui-primary transition-colors flex items-center gap-2">
                                                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-50 to-violet-50 flex items-center justify-center shrink-0 border border-indigo-100/50">
                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
                                                        </div>
                                                        <div>
                                                            <span className="text-xs text-slate-400 font-mono">{est.code}</span>
                                                            <span className="ml-2">{est.title}</span>
                                                        </div>
                                                    </Link>
                                                </td>
                                                <td className="px-6 py-4"><StatusBadge status={est.status} /></td>
                                                <td className="px-6 py-4 text-right font-semibold text-slate-700">{formatCurrency(est.totalAmount)}</td>
                                                <td className="px-6 py-4 text-right text-slate-400 text-xs">{new Date(est.createdAt).toLocaleDateString()}</td>
                                                <td className="px-4 py-4">
                                                    <Link href={`/projects/${linkedProject!.id}/estimates/${est.id}`} className="text-slate-300 hover:text-slate-600 opacity-0 group-hover:opacity-100 transition">
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>
                                                    </Link>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Lead estimates section */}
                    <div>
                        {projectEstimates.length > 0 && (
                            <div className="flex items-center gap-2 mb-3">
                                <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wider">Lead Estimates</h2>
                            </div>
                        )}
                        <LeadEstimatesTable
                            leadId={lead.id}
                            estimates={leadEstimates}
                            allProjects={allActiveProjects}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
