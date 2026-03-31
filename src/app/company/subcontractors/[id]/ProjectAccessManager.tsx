"use client";
import { useState, useEffect } from "react";
import { getProjects, getSubcontractorExplicitProjects, saveSubcontractorExplicitProjects } from "@/lib/actions";
import { toast } from "sonner";

export default function ProjectAccessManager({ subcontractorId }: { subcontractorId: string }) {
    const [projects, setProjects] = useState<any[]>([]);
    const [assignedIds, setAssignedIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [search, setSearch] = useState("");

    useEffect(() => {
        async function load() {
            try {
                const [allRes, assignedRes] = await Promise.all([
                    getProjects(),
                    getSubcontractorExplicitProjects(subcontractorId)
                ]);
                setProjects(allRes);
                setAssignedIds(assignedRes);
            } catch {
                toast.error("Failed to load project assignments");
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [subcontractorId]);

    const handleToggle = async (projectId: string, isChecked: boolean) => {
        let newIds = [...assignedIds];
        if (isChecked) {
            newIds.push(projectId);
        } else {
            newIds = newIds.filter(id => id !== projectId);
        }
        setAssignedIds(newIds);
        
        // Optimistic save
        setSaving(true);
        try {
            await saveSubcontractorExplicitProjects(subcontractorId, newIds);
            toast.success("Project access updated");
        } catch {
            toast.error("Failed to update access");
            // Revert
            setAssignedIds(assignedIds);
        } finally {
            setSaving(false);
        }
    };

    const filtered = projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || (p.client?.name && p.client.name.toLowerCase().includes(search.toLowerCase())));

    if (loading) return <div className="p-4 text-center text-sm text-slate-500">Loading projects...</div>;

    return (
        <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden mt-6">
            <div className="p-4 border-b border-hui-border bg-slate-50/50 flex justify-between items-center">
                <h2 className="text-sm font-bold text-hui-textMain uppercase tracking-wider">Explicit Project Access</h2>
            </div>
            <div className="p-5">
                <p className="text-xs text-slate-500 mb-4">
                    Select projects that this subcontractor should have explicit access to in their portal. This is completely separate from implicit access via Task Assignments.
                </p>
                <div className="relative mb-4">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                    <input
                        type="text" placeholder="Search Projects" value={search} onChange={e => setSearch(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 border border-hui-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20 bg-white"
                    />
                </div>
                
                <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[300px] overflow-y-auto">
                    <table className="w-full">
                        <thead className="bg-slate-50 sticky top-0 border-b border-slate-200">
                            <tr className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                                <th className="px-4 py-3 w-10"></th>
                                <th className="px-4 py-3">Project</th>
                                <th className="px-4 py-3">Client</th>
                                <th className="px-4 py-3 text-right">Created Date</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filtered.length === 0 ? (
                                <tr><td colSpan={4} className="text-center py-8 text-sm text-slate-400 italic">No projects found</td></tr>
                            ) : (
                                filtered.map(p => (
                                    <tr key={p.id} className="hover:bg-slate-50/50 transition">
                                        <td className="px-4 py-3">
                                            <input 
                                                type="checkbox" 
                                                checked={assignedIds.includes(p.id)} 
                                                onChange={e => handleToggle(p.id, e.target.checked)}
                                                disabled={saving}
                                                className="w-4 h-4 text-hui-primary border-slate-300 rounded focus:ring-hui-primary/20"
                                            />
                                        </td>
                                        <td className="px-4 py-3 text-sm font-medium text-slate-700">{p.name}</td>
                                        <td className="px-4 py-3 text-sm text-slate-500">{p.client?.name || "—"}</td>
                                        <td className="px-4 py-3 text-sm text-slate-500 text-right">{new Date(p.createdAt).toLocaleDateString()}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="mt-5 p-4 bg-orange-50/50 border border-orange-100 rounded-lg">
                    <h3 className="text-xs font-semibold text-orange-800 mb-2">Subcontractors have access to:</h3>
                    <div className="grid grid-cols-2 gap-4 text-xs text-slate-600">
                        <div>
                            <span className="font-semibold block text-slate-700">✓ Project Overview</span>
                            Project details (e.g. location, description)
                        </div>
                        <div>
                            <span className="font-semibold block text-slate-700">✓ Schedule & Tasks</span>
                            Create/view assigned tasks and shared schedule
                        </div>
                        <div>
                            <span className="font-semibold block text-slate-700">✓ Files & Photos</span>
                            Upload and view shared documents
                        </div>
                        <div>
                            <span className="font-semibold block text-slate-700">✓ Daily Logs</span>
                            View shared daily logs
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
