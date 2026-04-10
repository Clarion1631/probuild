"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { duplicateEstimate } from "@/lib/actions";
import { toast } from "sonner";

type Project = { id: string; name: string };

export default function CopyToProjectButton({
    estimateId,
    currentProjectId,
    allProjects,
}: {
    estimateId: string;
    currentProjectId: string;
    allProjects: Project[];
}) {
    const [showModal, setShowModal] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [isCopying, setIsCopying] = useState(false);
    const router = useRouter();

    const otherProjects = allProjects.filter((p) => p.id !== currentProjectId);

    async function handleCopy() {
        if (!selectedProjectId) return;
        setIsCopying(true);
        try {
            const result = await duplicateEstimate(estimateId, selectedProjectId);
            const targetName = allProjects.find((p) => p.id === selectedProjectId)?.name || "target project";
            toast.success(`Copied to ${targetName}`);
            setShowModal(false);
            router.push(`/projects/${selectedProjectId}/estimates/${result.id}`);
        } catch (e: any) {
            toast.error(e?.message || "Failed to copy estimate");
        } finally {
            setIsCopying(false);
        }
    }

    return (
        <>
            <button
                title="Copy to another project"
                onClick={() => { setSelectedProjectId(""); setShowModal(true); }}
                className="text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded p-1.5 transition opacity-0 group-hover:opacity-100"
            >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 8h1a4 4 0 010 8h-1" /><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z" /><line x1="6" y1="1" x2="6" y2="4" /><line x1="10" y1="1" x2="10" y2="4" /><line x1="14" y1="1" x2="14" y2="4" />
                </svg>
            </button>

            {showModal && (
                <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" onClick={() => setShowModal(false)}>
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border" onClick={(e) => e.stopPropagation()}>
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-base font-bold text-hui-textMain">Copy to another project</h2>
                            <button onClick={() => setShowModal(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            {otherProjects.length === 0 ? (
                                <p className="text-sm text-slate-500">No other active projects found.</p>
                            ) : (
                                <div>
                                    <label className="block text-sm font-medium text-hui-textMain mb-1">Select project</label>
                                    <select
                                        className="hui-input w-full"
                                        value={selectedProjectId}
                                        onChange={(e) => setSelectedProjectId(e.target.value)}
                                    >
                                        <option value="">— Pick a project —</option>
                                        {otherProjects.map((p) => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                            <button onClick={() => setShowModal(false)} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button
                                onClick={handleCopy}
                                disabled={!selectedProjectId || isCopying}
                                className="hui-btn hui-btn-primary disabled:opacity-50"
                            >
                                {isCopying ? "Copying..." : "Copy"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
