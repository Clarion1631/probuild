"use client";

import { useState } from "react";
import { toast } from "sonner";

interface Props {
    projectId: string;
    subcontractorId: string;
}

export default function SubTaskSummaryCard({ projectId, subcontractorId }: Props) {
    const [summary, setSummary] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(true);

    async function handleGenerate() {
        setLoading(true);
        try {
            const res = await fetch("/api/ai/sub-task-summary", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, subcontractorId }),
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || "Failed to generate summary");
                return;
            }
            setSummary(data.result);
            setOpen(true);
            toast.success("AI summary generated");
        } catch {
            toast.error("Failed to connect to AI service");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="mb-8">
            {/* Generate Button */}
            {!summary && (
                <button
                    onClick={handleGenerate}
                    disabled={loading}
                    className="hui-btn hui-btn-secondary text-sm inline-flex items-center gap-2"
                >
                    {loading ? (
                        <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Generating Summary...
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                            </svg>
                            AI Summary
                        </>
                    )}
                </button>
            )}

            {/* Summary Card */}
            {summary && (
                <div className="hui-card overflow-hidden border border-purple-100">
                    {/* Header */}
                    <button
                        onClick={() => setOpen(!open)}
                        className="w-full flex items-center justify-between px-6 py-4 bg-purple-50/50 hover:bg-purple-50 transition"
                    >
                        <div className="flex items-center gap-2">
                            <svg className="w-5 h-5 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                            </svg>
                            <span className="text-sm font-semibold text-hui-textMain">AI Task Summary</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleGenerate();
                                }}
                                disabled={loading}
                                className="text-xs text-purple-600 hover:text-purple-800 font-medium transition"
                            >
                                {loading ? "Refreshing..." : "Refresh"}
                            </button>
                            <svg className={`w-4 h-4 text-hui-textMuted transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                        </div>
                    </button>

                    {/* Body */}
                    {open && (
                        <div className="px-6 py-5 border-t border-purple-100">
                            <div className="prose prose-sm max-w-none text-hui-textMain whitespace-pre-wrap leading-relaxed">
                                {summary}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
