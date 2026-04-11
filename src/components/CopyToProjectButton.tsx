"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { duplicateEstimate } from "@/lib/actions";
import { toast } from "sonner";

type Project = { id: string; name: string };

export default function CopyToProjectButton({
    estimateId,
    estimateTitle,
    currentProjectId,
    allProjects,
}: {
    estimateId: string;
    estimateTitle?: string;
    currentProjectId: string;
    allProjects: Project[];
}) {
    const [showModal, setShowModal] = useState(false);
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const [newTitle, setNewTitle] = useState("");
    const [isCopying, setIsCopying] = useState(false);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const router = useRouter();

    const otherProjects = allProjects.filter((p) => p.id !== currentProjectId);

    // Auto-suggest a name whenever the project selection changes
    useEffect(() => {
        if (!selectedProjectId) {
            setNewTitle("");
            return;
        }
        const targetName = otherProjects.find((p) => p.id === selectedProjectId)?.name || "";
        const base = estimateTitle || "Estimate";
        setNewTitle(`${base} — ${targetName}`);
        // Focus & select the title field so the user can rename immediately
        setTimeout(() => {
            titleInputRef.current?.focus();
            titleInputRef.current?.select();
        }, 50);
    }, [selectedProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

    function handleOpen() {
        setSelectedProjectId("");
        setNewTitle("");
        setShowModal(true);
    }

    async function handleCopy() {
        if (!selectedProjectId) return;
        setIsCopying(true);
        try {
            const result = await duplicateEstimate(estimateId, selectedProjectId, newTitle);
            const targetName = otherProjects.find((p) => p.id === selectedProjectId)?.name || "target project";
            setShowModal(false);
            // Refresh the current list so it reflects any same-project copies, then navigate
            router.refresh();
            router.push(`/projects/${selectedProjectId}/estimates/${result.id}`);
            toast.success(`Copied to ${targetName}`);
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
                onClick={handleOpen}
                className="text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded p-1.5 transition opacity-0 group-hover:opacity-100"
            >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
            </button>

            {showModal && (
                <div
                    className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4"
                    onClick={() => setShowModal(false)}
                >
                    <div
                        className="bg-white rounded-xl shadow-xl w-full max-w-sm border border-hui-border"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <div>
                                <h2 className="text-base font-bold text-hui-textMain">Copy estimate</h2>
                                <p className="text-xs text-hui-textMuted mt-0.5">Copies all line items and payment schedule as a Draft.</p>
                            </div>
                            <button onClick={() => setShowModal(false)} className="text-hui-textMuted hover:text-hui-textMain ml-4 shrink-0">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                        <div className="p-6 space-y-5">
                            {otherProjects.length === 0 ? (
                                <p className="text-sm text-slate-500">No other active projects found.</p>
                            ) : (
                                <>
                                    {/* Step 1 — project picker */}
                                    <div>
                                        <label className="block text-sm font-medium text-hui-textMain mb-1">
                                            Destination project
                                        </label>
                                        <select
                                            className="hui-input w-full"
                                            value={selectedProjectId}
                                            onChange={(e) => setSelectedProjectId(e.target.value)}
                                            autoFocus
                                        >
                                            <option value="">— Pick a project —</option>
                                            {otherProjects.map((p) => (
                                                <option key={p.id} value={p.id}>{p.name}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Step 2 — editable name (appears once project is chosen) */}
                                    {selectedProjectId && (
                                        <div>
                                            <label className="block text-sm font-medium text-hui-textMain mb-1">
                                                New estimate title
                                                <span className="text-hui-textMuted font-normal ml-1">(rename if needed)</span>
                                            </label>
                                            <input
                                                ref={titleInputRef}
                                                type="text"
                                                className="hui-input w-full"
                                                value={newTitle}
                                                onChange={(e) => setNewTitle(e.target.value)}
                                                placeholder="Estimate title..."
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" && newTitle.trim()) handleCopy();
                                                    if (e.key === "Escape") setShowModal(false);
                                                }}
                                            />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50 rounded-b-xl">
                            <button
                                onClick={() => setShowModal(false)}
                                className="hui-btn hui-btn-secondary"
                                disabled={isCopying}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCopy}
                                disabled={!selectedProjectId || !newTitle.trim() || isCopying}
                                className="hui-btn hui-btn-primary disabled:opacity-50 flex items-center gap-2"
                            >
                                {isCopying ? (
                                    <>
                                        <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                        Copying…
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" strokeWidth="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeWidth="2" /></svg>
                                        Copy estimate
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
