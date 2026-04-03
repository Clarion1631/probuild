"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { getProjects, createDraftEstimate } from "@/lib/actions";
import { toast } from "sonner";

export default function NewEstimateButton() {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [open, setOpen] = useState(false);
    const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
    const [selectedProject, setSelectedProject] = useState("");
    const [loading, setLoading] = useState(false);

    async function handleOpen() {
        setOpen(true);
        setLoading(true);
        try {
            const data = await getProjects();
            setProjects(data.map((p: any) => ({ id: p.id, name: p.name })));
            if (data.length > 0) setSelectedProject(data[0].id);
        } catch {
            toast.error("Failed to load projects");
            setOpen(false);
        } finally {
            setLoading(false);
        }
    }

    function handleCreate() {
        if (!selectedProject) return;
        startTransition(async () => {
            try {
                const result = await createDraftEstimate(selectedProject);
                setOpen(false);
                router.push(`/projects/${selectedProject}/estimates/${result.id}`);
            } catch {
                toast.error("Failed to create estimate");
            }
        });
    }

    return (
        <>
            <button className="hui-btn hui-btn-primary" onClick={handleOpen}>
                New Estimate
            </button>

            {open && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-md w-full border border-hui-border overflow-hidden">
                        <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between">
                            <h2 className="text-lg font-bold text-hui-textMain">New Estimate</h2>
                            <button onClick={() => setOpen(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            {loading ? (
                                <p className="text-sm text-hui-textMuted">Loading projects…</p>
                            ) : (
                                <div>
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">
                                        Select Project <span className="text-red-500">*</span>
                                    </label>
                                    <select
                                        className="hui-input w-full"
                                        value={selectedProject}
                                        onChange={e => setSelectedProject(e.target.value)}
                                    >
                                        {projects.length === 0 && (
                                            <option value="">No projects found</option>
                                        )}
                                        {projects.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3">
                            <button className="hui-btn hui-btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
                            <button
                                className="hui-btn hui-btn-primary disabled:opacity-50"
                                disabled={!selectedProject || isPending || loading}
                                onClick={handleCreate}
                            >
                                {isPending ? "Creating…" : "Create Estimate"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
