"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";

interface SafetyTip {
    title: string;
    tip: string;
}

interface Props {
    subcontractorId: string;
}

const safetyIcons = [
    // Hard hat
    <svg key="0" className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>,
    // Warning sign
    <svg key="1" className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
    // Eye
    <svg key="2" className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>,
    // Clipboard check
    <svg key="3" className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>,
];

export default function SubSafetyTipsCard({ subcontractorId }: Props) {
    const [tips, setTips] = useState<SafetyTip[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);

    async function fetchTips() {
        setLoading(true);
        try {
            const res = await fetch("/api/ai/sub-safety-tips", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subcontractorId }),
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || "Failed to generate safety tips");
                return;
            }
            setTips(data.tips);
            setLoaded(true);
        } catch {
            toast.error("Failed to connect to AI service");
        } finally {
            setLoading(false);
        }
    }

    // Auto-fetch on mount
    useEffect(() => {
        fetchTips();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="hui-card overflow-hidden border border-amber-100 mb-8">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 bg-amber-50/50">
                <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span className="text-sm font-semibold text-hui-textMain">AI Safety Tips</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 uppercase tracking-wider">AI</span>
                </div>
                <button
                    onClick={fetchTips}
                    disabled={loading}
                    className="text-xs text-amber-600 hover:text-amber-800 font-medium transition disabled:opacity-50"
                >
                    {loading ? "Generating..." : "Refresh"}
                </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 border-t border-amber-100">
                {loading && !loaded ? (
                    <div className="flex items-center justify-center py-6 gap-3 text-sm text-hui-textMuted">
                        <svg className="w-5 h-5 animate-spin text-amber-500" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Generating personalized safety tips...
                    </div>
                ) : tips.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {tips.map((tip, idx) => (
                            <div key={idx} className="flex gap-3 p-3 rounded-lg bg-white border border-slate-100 hover:border-amber-200 transition">
                                <div className="flex-shrink-0 mt-0.5">
                                    {safetyIcons[idx % safetyIcons.length]}
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-hui-textMain mb-1">{tip.title}</p>
                                    <p className="text-xs text-hui-textMuted leading-relaxed">{tip.tip}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-hui-textMuted text-center py-4">No safety tips available. Click Refresh to generate.</p>
                )}
            </div>
        </div>
    );
}
