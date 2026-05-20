import { useState, useEffect } from "react";
import { useRoomStore } from "./hooks/useRoomStore";
import { toast } from "sonner";
import { X, Sparkles, RefreshCw, CheckCircle, AlertTriangle, Info, Compass } from "lucide-react";

interface LegData {
    distanceFeet: number;
    status: "perfect" | "too-close" | "too-far";
    message: string;
}

interface AuditResult {
    overallScore: number;
    overallAssessment: string;
    workTriangleLegs: {
        fridgeToSink: LegData;
        sinkToStove: LegData;
        stoveToFridge: LegData;
    };
    clearanceIssues: {
        issue: string;
        severity: "warning" | "caution" | "note";
        fix: string;
    }[];
    designRecommendations: {
        recommendation: string;
        impact: string;
    }[];
}

export function DesignerAssistantPanel() {
    const show = useRoomStore((s) => s.showAssistant);
    const setShow = useRoomStore((s) => s.setShowAssistant);
    const roomType = useRoomStore((s) => s.roomType);
    const layout = useRoomStore((s) => s.layout);
    const assets = useRoomStore((s) => s.assets);

    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<AuditResult | null>(null);

    const runAudit = async () => {
        setLoading(true);
        try {
            const response = await fetch("/api/ai/room-designer-review", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    roomType,
                    layout,
                    assets,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || "Failed to analyze layout");
            }

            const data = await response.json();
            setResult(data as AuditResult);
            toast.success("AI Design audit completed successfully!");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            toast.error(`Audit failed: ${msg}`);
        } finally {
            setLoading(false);
        }
    };

    // Run audit automatically on mount/open if we don't have results yet
    useEffect(() => {
        if (show && !result && !loading && assets.length > 0) {
            runAudit();
        }
    }, [show]);

    if (!show) return null;

    return (
        <aside className="flex h-full w-80 shrink-0 flex-col border-l border-slate-200 bg-white shadow-lg z-20 transition-all duration-300">
            {/* Header */}
            <header className="flex items-center justify-between border-b border-slate-100 p-4">
                <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-100 text-[#531b7e]">
                        <Sparkles className="h-4 w-4" />
                    </div>
                    <div>
                        <h3 className="text-xs font-bold uppercase tracking-wider text-[#2e103f]">
                            AI Designer Assistant
                        </h3>
                        <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">
                            NKBA Spatial Audit
                        </span>
                    </div>
                </div>
                <button
                    type="button"
                    title="Close"
                    onClick={() => setShow(false)}
                    className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
                >
                    <X className="h-4 w-4" />
                </button>
            </header>

            {/* Scrollable Contents */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                        <div className="relative flex h-16 w-16 items-center justify-center">
                            <div className="absolute inset-0 rounded-full border-4 border-purple-100 border-t-[#531b7e] animate-spin" />
                            <Sparkles className="h-6 w-6 text-[#531b7e] animate-pulse" />
                        </div>
                        <div>
                            <h4 className="font-bold text-slate-700 text-sm">Evaluating spatial layout...</h4>
                            <p className="text-xs text-slate-400 mt-1 max-w-[200px] leading-relaxed">
                                Gemini is calculating work triangles, dishwasher proximity, and NKBA guidelines.
                            </p>
                        </div>
                    </div>
                ) : assets.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 border border-slate-100 text-slate-400">
                            <Compass className="h-5 w-5" />
                        </div>
                        <div>
                            <h4 className="font-bold text-slate-700 text-sm">Room is Empty</h4>
                            <p className="text-xs text-slate-400 mt-1 max-w-[220px] leading-relaxed">
                                Place cabinets, appliances, and fixtures in the room first, then run the audit.
                            </p>
                        </div>
                    </div>
                ) : !result ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-purple-50 text-[#531b7e]">
                            <Sparkles className="h-5 w-5" />
                        </div>
                        <div>
                            <h4 className="font-bold text-slate-700 text-sm">Ready to Audit</h4>
                            <p className="text-xs text-slate-400 mt-1 max-w-[220px] leading-relaxed">
                                Click the button below to perform a live NKBA-certified spatial audit of your design.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={runAudit}
                            className="hui-btn hui-btn-green w-full"
                        >
                            Run Design Audit
                        </button>
                    </div>
                ) : (
                    <div className="space-y-5">
                        {/* Overall Score Dial */}
                        <div className="rounded-xl border border-slate-100 bg-slate-50/30 p-4 flex items-center gap-4 relative overflow-hidden group">
                            <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-4 border-purple-50 shadow-inner">
                                <span className={`text-xl font-extrabold ${
                                    result.overallScore >= 80 ? "text-emerald-600" :
                                    result.overallScore >= 60 ? "text-amber-600" : "text-red-500"
                                }`}>
                                    {result.overallScore}
                                </span>
                                <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#531b7e] -rotate-45" />
                            </div>
                            <div>
                                <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wide">Design Quality Score</h4>
                                <p className="text-xs text-slate-400 mt-0.5 leading-snug">
                                    Based on efficiency, accessibility, and safety compliance.
                                </p>
                            </div>
                        </div>

                        {/* Assessment */}
                        <div className="space-y-1.5">
                            <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                Overall Assessment
                            </h4>
                            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50/20 p-3 rounded-lg border border-slate-100">
                                {result.overallAssessment}
                            </p>
                        </div>

                        {/* Work Triangle Section */}
                        <div className="space-y-2.5">
                            <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                                <span>Kitchen Work Triangle</span>
                                <span className="text-[9px] font-semibold text-slate-400 uppercase font-mono">Feet</span>
                            </h4>

                            <div className="space-y-2">
                                <TriangleLegRow
                                    label="Fridge ⟷ Sink"
                                    leg={result.workTriangleLegs.fridgeToSink}
                                />
                                <TriangleLegRow
                                    label="Sink ⟷ Stove"
                                    leg={result.workTriangleLegs.sinkToStove}
                                />
                                <TriangleLegRow
                                    label="Stove ⟷ Fridge"
                                    leg={result.workTriangleLegs.stoveToFridge}
                                />
                            </div>
                        </div>

                        {/* Clearance Issues */}
                        {result.clearanceIssues.length > 0 && (
                            <div className="space-y-2.5">
                                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                    Clearance & Safety Alerts
                                </h4>
                                <div className="space-y-2">
                                    {result.clearanceIssues.map((issue, idx) => (
                                        <div
                                            key={idx}
                                            className={`rounded-lg border p-3 space-y-1 text-xs ${
                                                issue.severity === "warning" ? "bg-red-50/50 border-red-100 text-red-900" :
                                                issue.severity === "caution" ? "bg-amber-50/50 border-amber-100 text-amber-900" :
                                                "bg-slate-50/50 border-slate-100 text-slate-800"
                                            }`}
                                        >
                                            <div className="flex items-start gap-1.5 font-bold">
                                                {issue.severity === "warning" ? <AlertTriangle className="h-3.5 w-3.5 text-red-600 mt-0.5 shrink-0" /> :
                                                 issue.severity === "caution" ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" /> :
                                                 <Info className="h-3.5 w-3.5 text-slate-500 mt-0.5 shrink-0" />}
                                                <span>{issue.issue}</span>
                                            </div>
                                            <div className="text-[10px] pl-5 leading-normal opacity-90">
                                                <span className="font-bold uppercase text-[9px] tracking-wide text-slate-500 block mb-0.5">Proposed Fix:</span>
                                                {issue.fix}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Design Recommendations */}
                        {result.designRecommendations.length > 0 && (
                            <div className="space-y-2.5">
                                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                    Recommendations
                                </h4>
                                <div className="space-y-2 bg-slate-50/30 border border-slate-100 rounded-lg p-3 divide-y divide-slate-100">
                                    {result.designRecommendations.map((rec, idx) => (
                                        <div key={idx} className={`text-xs space-y-0.5 ${idx > 0 ? "pt-2" : ""}`}>
                                            <div className="font-bold text-slate-700">{rec.recommendation}</div>
                                            <div className="text-[10px] text-slate-400 leading-normal">{rec.impact}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Sticky Actions Footer */}
            {result && !loading && assets.length > 0 && (
                <footer className="border-t border-slate-100 p-4 bg-white">
                    <button
                        type="button"
                        onClick={runAudit}
                        className="hui-btn hui-btn-secondary w-full flex items-center justify-center gap-1.5"
                    >
                        <RefreshCw className="h-3.5 w-3.5 text-slate-500" />
                        Re-run Design Audit
                    </button>
                </footer>
            )}
        </aside>
    );
}

interface TriangleLegRowProps {
    label: string;
    leg: LegData;
}

function TriangleLegRow({ label, leg }: TriangleLegRowProps) {
    const isPerfect = leg.status === "perfect";
    const isTooFar = leg.status === "too-far";

    return (
        <div className="rounded-lg border border-slate-100 bg-slate-50/20 p-2.5 space-y-1 text-xs">
            <div className="flex justify-between items-center">
                <span className="font-bold text-slate-700">{label}</span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${
                    isPerfect ? "bg-emerald-50 text-emerald-700 border border-emerald-100" :
                    isTooFar ? "bg-amber-50 text-amber-700 border border-amber-100" :
                    "bg-red-50 text-red-700 border border-red-100"
                }`}>
                    {isPerfect ? <CheckCircle className="h-2.5 w-2.5 text-emerald-600" /> : <AlertTriangle className="h-2.5 w-2.5" />}
                    {leg.status === "perfect" ? "Perfect" :
                     leg.status === "too-far" ? "Attention" : "Too Close"}
                </span>
            </div>
            <div className="text-[10px] text-slate-400 leading-normal">
                {leg.distanceFeet > 0 ? `${leg.distanceFeet.toFixed(1)} ft — ` : ""}{leg.message}
            </div>
        </div>
    );
}
