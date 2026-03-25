"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface TakeoffFile {
    id: string;
    name: string;
    url: string;
    mimeType: string;
    size: number;
}

interface Takeoff {
    id: string;
    name: string;
    description: string | null;
    status: string;
    aiEstimateData: string | null;
    estimateId: string | null;
    estimate: { id: string; title: string; code: string; totalAmount: number } | null;
    files: TakeoffFile[];
    createdAt: string;
    updatedAt: string;
}

interface TakeoffsClientProps {
    contextType: "project" | "lead";
    contextId: string;
    contextName: string;
}

export default function TakeoffsClient({ contextType, contextId, contextName }: TakeoffsClientProps) {
    const router = useRouter();
    const [takeoffs, setTakeoffs] = useState<Takeoff[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [selectedTakeoff, setSelectedTakeoff] = useState<Takeoff | null>(null);
    const [activeTab, setActiveTab] = useState<"plans" | "estimate">("plans");
    const [converting, setConverting] = useState(false);
    const [viewMode, setViewMode] = useState<"internal" | "client">("internal");
    const [globalMarkup, setGlobalMarkup] = useState(25);
    const [adjustedItems, setAdjustedItems] = useState<any[] | null>(null);

    // Create modal state
    const [createName, setCreateName] = useState("");
    const [createDescription, setCreateDescription] = useState("");
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [creating, setCreating] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // AI state
    const [aiContext, setAiContext] = useState("");
    const [aiLoading, setAiLoading] = useState(false);
    const [aiResult, setAiResult] = useState<any>(null);
    const [selectedPlanFile, setSelectedPlanFile] = useState<TakeoffFile | null>(null);

    const fetchTakeoffs = useCallback(async () => {
        try {
            const paramKey = contextType === "project" ? "projectId" : "leadId";
            const res = await fetch(`/api/takeoffs?${paramKey}=${contextId}`);
            if (res.ok) setTakeoffs(await res.json());
        } catch (err) {
            console.error("Failed to fetch takeoffs:", err);
        } finally {
            setLoading(false);
        }
    }, [contextId, contextType]);

    useEffect(() => { fetchTakeoffs(); }, [fetchTakeoffs]);

    const handleCreate = async () => {
        if (!createName.trim()) return toast.error("Please enter a takeoff name");
        setCreating(true);
        try {
            const body: any = { name: createName, description: createDescription || null };
            if (contextType === "project") body.projectId = contextId;
            else body.leadId = contextId;

            const res = await fetch("/api/takeoffs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error("Failed to create takeoff");
            const takeoff = await res.json();

            if (pendingFiles.length > 0) {
                const uploadResult = await uploadFilesToTakeoff(takeoff.id, pendingFiles);
                if (!uploadResult.success) {
                    toast.warning(`Takeoff created but file upload failed: ${uploadResult.error}`);
                }
            }

            toast.success("Takeoff created!");
            setShowCreateModal(false);
            setCreateName("");
            setCreateDescription("");
            setPendingFiles([]);
            await fetchTakeoffs();
        } catch (err: any) {
            toast.error(err.message || "Failed to create takeoff");
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Delete this takeoff and all its files?")) return;
        try {
            await fetch(`/api/takeoffs/${id}`, { method: "DELETE" });
            toast.success("Takeoff deleted");
            if (selectedTakeoff?.id === id) { setSelectedTakeoff(null); setAiResult(null); }
            await fetchTakeoffs();
        } catch { toast.error("Failed to delete"); }
    };

    const openTakeoff = async (id: string) => {
        try {
            const res = await fetch(`/api/takeoffs/${id}`);
            if (res.ok) {
                const data = await res.json();
                setSelectedTakeoff(data);
                setActiveTab("plans");
                setAiResult(null);
                // Auto-select first file for preview
                if (data.files.length > 0) setSelectedPlanFile(data.files[0]);
                else setSelectedPlanFile(null);
            }
        } catch { toast.error("Failed to load takeoff"); }
    };

    // Direct-to-Supabase upload via signed URLs (bypasses Vercel 4.5MB limit)
    const uploadFilesToTakeoff = async (takeoffId: string, filesToUpload: File[]): Promise<{ success: boolean; count: number; error?: string }> => {
        try {
            // Step 1: Get signed upload URLs from our API
            const fileInfos = filesToUpload.map(f => ({ name: f.name, type: f.type, size: f.size }));
            const urlRes = await fetch("/api/takeoffs/upload", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ takeoffId, files: fileInfos }),
            });

            if (!urlRes.ok) {
                const errText = await urlRes.text();
                let errMsg = "Failed to get upload URLs";
                try { errMsg = JSON.parse(errText).error || errMsg; } catch {}
                return { success: false, count: 0, error: errMsg };
            }

            const { uploadUrls } = await urlRes.json();

            // Step 2: Upload each file directly to Supabase using the signed URL
            const registeredFiles = [];
            for (let i = 0; i < filesToUpload.length; i++) {
                const file = filesToUpload[i];
                const urlInfo = uploadUrls[i];
                toast.info(`Uploading ${file.name} (${i + 1}/${filesToUpload.length})...`);

                const uploadRes = await fetch(urlInfo.signedUrl, {
                    method: "PUT",
                    headers: { "Content-Type": file.type || "application/octet-stream" },
                    body: file,
                });

                if (!uploadRes.ok) {
                    console.error(`Direct upload failed for ${file.name}:`, await uploadRes.text());
                    toast.error(`Failed to upload ${file.name}`);
                    continue;
                }

                registeredFiles.push({
                    name: file.name,
                    url: urlInfo.publicUrl,
                    mimeType: file.type || "application/octet-stream",
                    size: file.size,
                });
            }

            // Step 3: Register all uploaded files in the database
            if (registeredFiles.length > 0) {
                const regRes = await fetch("/api/takeoffs/register-file", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ takeoffId, files: registeredFiles }),
                });

                if (!regRes.ok) {
                    const errData = await regRes.json();
                    return { success: false, count: 0, error: errData.error || "Failed to register files" };
                }
            }

            return { success: true, count: registeredFiles.length };
        } catch (err: any) {
            return { success: false, count: 0, error: err.message || "Upload failed" };
        }
    };

    const handleUploadMore = async () => {
        if (!selectedTakeoff) return;
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = ".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.avi";
        input.onchange = async () => {
            if (!input.files?.length) return;
            const result = await uploadFilesToTakeoff(selectedTakeoff.id, Array.from(input.files));
            if (result.success) {
                toast.success(`${result.count} file(s) uploaded!`);
                openTakeoff(selectedTakeoff.id);
                await fetchTakeoffs();
            } else {
                toast.error(`Upload failed: ${result.error}`);
            }
        };
        input.click();
    };

    const handleGenerateEstimate = async () => {
        if (!selectedTakeoff) return;
        setAiLoading(true);
        setActiveTab("estimate");
        try {
            const res = await fetch("/api/takeoffs/ai-estimate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    takeoffId: selectedTakeoff.id,
                    additionalContext: aiContext,
                    projectName: contextName,
                }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "AI estimate failed");
            }
            const result = await res.json();
            setAiResult(result);
            toast.success(`AI analyzed plans and generated ${result.count} line items!`);
            openTakeoff(selectedTakeoff.id);
        } catch (err: any) {
            toast.error(err.message || "Failed to generate estimate");
        } finally {
            setAiLoading(false);
        }
    };

    const handleConvertToEstimate = async () => {
        if (!selectedTakeoff) return;
        setConverting(true);
        try {
            const res = await fetch("/api/takeoffs/convert-to-estimate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ takeoffId: selectedTakeoff.id }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Failed to convert");
            }
            const result = await res.json();
            toast.success(`Estimate ${result.code} created with ${result.itemCount} line items!`);
            router.push(result.redirectUrl);
        } catch (err: any) {
            toast.error(err.message || "Failed to convert to estimate");
        } finally {
            setConverting(false);
        }
    };

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setPendingFiles(prev => [...prev, ...Array.from(e.dataTransfer.files)]);
    }, []);

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const statusColors: Record<string, string> = {
        "Draft": "bg-slate-100 text-slate-700 border-slate-200",
        "In Progress": "bg-blue-50 text-blue-700 border-blue-200",
        "Completed": "bg-green-50 text-green-700 border-green-200",
    };

    // ══════════════════════════════════════════════════════════════
    // FULL-SCREEN TAKEOFF WORKSPACE (when a takeoff is selected)
    // ══════════════════════════════════════════════════════════════
    if (selectedTakeoff) {
        const parsedAiData = aiResult || (selectedTakeoff.aiEstimateData ? JSON.parse(selectedTakeoff.aiEstimateData) : null);
        const planAnalysis = parsedAiData?.planAnalysis;

        return (
            <div className="fixed inset-0 bg-white z-40 flex flex-col" style={{ marginLeft: "calc(5rem + 14rem)" }}>
                {/* Top Bar */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-white shrink-0 shadow-sm">
                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => { setSelectedTakeoff(null); setAiResult(null); }}
                            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition font-medium"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7"/></svg>
                            Back
                        </button>
                        <div className="w-px h-5 bg-slate-200" />
                        <div>
                            <h1 className="text-base font-bold text-hui-textMain flex items-center gap-2">
                                {selectedTakeoff.name}
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusColors[selectedTakeoff.status]}`}>
                                    {selectedTakeoff.status}
                                </span>
                            </h1>
                            {selectedTakeoff.description && (
                                <p className="text-xs text-hui-textMuted mt-0.5">{selectedTakeoff.description}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={handleUploadMore} className="hui-btn hui-btn-secondary text-xs py-1.5 gap-1.5">
                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                            Add Files
                        </button>
                        <button onClick={() => handleDelete(selectedTakeoff.id)} className="text-xs text-red-500 hover:text-red-700 px-2 py-1.5 transition font-medium">
                            Delete
                        </button>
                    </div>
                </div>

                {/* Workspace Tabs */}
                <div className="flex items-center gap-1 px-5 pt-2 pb-0 bg-slate-50 border-b border-slate-200 shrink-0">
                    <button
                        onClick={() => setActiveTab("plans")}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition -mb-px ${
                            activeTab === "plans"
                                ? "bg-white text-hui-textMain border border-slate-200 border-b-white"
                                : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
                        }`}
                    >
                        <span className="flex items-center gap-2">
                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                            Plans & Files ({selectedTakeoff.files.length})
                        </span>
                    </button>
                    <button
                        onClick={() => setActiveTab("estimate")}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition -mb-px ${
                            activeTab === "estimate"
                                ? "bg-white text-hui-textMain border border-slate-200 border-b-white"
                                : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
                        }`}
                    >
                        <span className="flex items-center gap-2">
                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z"/></svg>
                            AI Estimate {parsedAiData ? `(${parsedAiData.items?.length || 0} items)` : ""}
                        </span>
                    </button>
                </div>

                {/* Main Content */}
                <div className="flex-1 flex overflow-hidden">
                    {activeTab === "plans" ? (
                        // ── PLANS TAB ─────────────────────────────
                        <div className="flex flex-1 overflow-hidden">
                            {/* File List Sidebar */}
                            <div className="w-60 border-r border-slate-200 bg-slate-50 flex flex-col shrink-0 overflow-y-auto">
                                <div className="p-3 border-b border-slate-200 bg-white">
                                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Plan Files</p>
                                </div>
                                {selectedTakeoff.files.length === 0 ? (
                                    <div className="p-4 text-center">
                                        <p className="text-xs text-slate-400">No files yet</p>
                                        <button onClick={handleUploadMore} className="text-xs text-hui-primary font-medium mt-2 hover:underline">
                                            Upload Plans
                                        </button>
                                    </div>
                                ) : (
                                    <div className="p-2 space-y-1">
                                        {selectedTakeoff.files.map(f => (
                                            <button
                                                key={f.id}
                                                onClick={() => setSelectedPlanFile(f)}
                                                className={`w-full text-left px-3 py-2.5 rounded-lg transition flex items-start gap-2.5 ${
                                                    selectedPlanFile?.id === f.id
                                                        ? "bg-indigo-50 border border-indigo-200 shadow-sm"
                                                        : "hover:bg-white border border-transparent"
                                                }`}
                                            >
                                                <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 mt-0.5 ${
                                                    f.mimeType === "application/pdf" ? "bg-red-100" :
                                                    f.mimeType.startsWith("image") ? "bg-blue-100" :
                                                    f.mimeType.startsWith("video") ? "bg-purple-100" : "bg-slate-100"
                                                }`}>
                                                    {f.mimeType === "application/pdf" ? (
                                                        <svg width="14" height="14" fill="none" stroke="#ef4444" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                                    ) : f.mimeType.startsWith("image") ? (
                                                        <svg width="14" height="14" fill="none" stroke="#3b82f6" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                                                    ) : (
                                                        <svg width="14" height="14" fill="none" stroke="#8b5cf6" strokeWidth="1.5" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className={`text-xs font-medium truncate ${selectedPlanFile?.id === f.id ? "text-indigo-800" : "text-hui-textMain"}`}>
                                                        {f.name}
                                                    </p>
                                                    <p className="text-[10px] text-slate-400">{formatFileSize(f.size)}</p>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                {/* AI Analyze Button */}
                                <div className="mt-auto p-3 border-t border-slate-200 bg-white">
                                    <div className="space-y-2">
                                        <textarea
                                            value={aiContext}
                                            onChange={e => setAiContext(e.target.value)}
                                            placeholder="Add context for AI... (scope details, finishes, special requirements)"
                                            className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-xs text-slate-700 resize-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                                            rows={3}
                                        />
                                        <button
                                            onClick={handleGenerateEstimate}
                                            disabled={aiLoading}
                                            className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white text-xs font-bold rounded-lg transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
                                        >
                                            {aiLoading ? (
                                                <>
                                                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                                    Analyzing Plans...
                                                </>
                                            ) : (
                                                <>
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z"/></svg>
                                                    Analyze Plans & Estimate
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Plan Viewer */}
                            <div className="flex-1 bg-slate-100 flex items-center justify-center overflow-hidden relative">
                                {selectedPlanFile ? (
                                    selectedPlanFile.mimeType === "application/pdf" ? (
                                        <iframe
                                            src={`${selectedPlanFile.url}#toolbar=1&navpanes=0&scrollbar=1`}
                                            className="w-full h-full border-0"
                                            title={selectedPlanFile.name}
                                            style={{ minHeight: "100%" }}
                                        />
                                    ) : selectedPlanFile.mimeType.startsWith("image") ? (
                                        <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
                                            <img
                                                src={selectedPlanFile.url}
                                                alt={selectedPlanFile.name}
                                                className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
                                            />
                                        </div>
                                    ) : selectedPlanFile.mimeType.startsWith("video") ? (
                                        <div className="w-full h-full flex items-center justify-center p-8">
                                            <video
                                                src={selectedPlanFile.url}
                                                controls
                                                className="max-w-full max-h-full rounded-xl shadow-lg"
                                            >
                                                Your browser does not support video.
                                            </video>
                                        </div>
                                    ) : (
                                        <div className="text-center p-8">
                                            <p className="text-sm text-slate-500 mb-3">Preview not available for this file type</p>
                                            <a href={selectedPlanFile.url} target="_blank" rel="noopener noreferrer" className="hui-btn hui-btn-secondary text-xs">
                                                Download File
                                            </a>
                                        </div>
                                    )
                                ) : (
                                    <div className="text-center p-8">
                                        <div className="w-20 h-20 rounded-2xl bg-white border-2 border-dashed border-slate-300 flex items-center justify-center mx-auto mb-4">
                                            <svg width="32" height="32" fill="none" stroke="#94a3b8" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                        </div>
                                        <p className="text-sm font-medium text-slate-500 mb-1">No plans uploaded yet</p>
                                        <p className="text-xs text-slate-400 mb-4">Upload architect plans, photos, or videos to get started</p>
                                        <button onClick={handleUploadMore} className="hui-btn hui-btn-green text-xs">
                                            Upload Plans
                                        </button>
                                    </div>
                                )}

                                {/* Plan Analysis Overlay (if available) */}
                                {planAnalysis && activeTab === "plans" && (
                                    <div className="absolute bottom-4 left-4 right-4 bg-white/95 backdrop-blur rounded-xl shadow-xl border border-slate-200 p-4 max-h-48 overflow-y-auto">
                                        <div className="flex items-start gap-3">
                                            <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-bold text-emerald-800 uppercase tracking-wider mb-1">AI Plan Analysis</p>
                                                {planAnalysis.roomDimensions && (
                                                    <p className="text-xs text-slate-700"><span className="font-semibold">Dimensions:</span> {planAnalysis.roomDimensions}</p>
                                                )}
                                                {planAnalysis.totalSqFt > 0 && (
                                                    <p className="text-xs text-slate-700"><span className="font-semibold">Total Area:</span> {planAnalysis.totalSqFt.toLocaleString()} sq ft</p>
                                                )}
                                                {planAnalysis.detectedItems?.length > 0 && (
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {planAnalysis.detectedItems.map((item: string, i: number) => (
                                                            <span key={i} className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-[10px] font-medium border border-emerald-200">
                                                                {item}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                {planAnalysis.scopeNotes && (
                                                    <p className="text-xs text-slate-600 mt-1.5">{planAnalysis.scopeNotes}</p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        // ── ESTIMATE TAB ──────────────────────────
                        <div className="flex-1 overflow-y-auto bg-white">
                            {aiLoading ? (
                                <div className="flex flex-col items-center justify-center h-full gap-4">
                                    <div className="relative">
                                        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center">
                                            <svg className="w-8 h-8 animate-spin text-indigo-600" fill="none" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                            </svg>
                                        </div>
                                        <div className="absolute -top-1 -right-1 w-5 h-5 bg-indigo-600 rounded-full animate-pulse" />
                                    </div>
                                    <div className="text-center">
                                        <p className="text-base font-bold text-hui-textMain">Analyzing Your Plans</p>
                                        <p className="text-sm text-slate-500 mt-1">AI is reading the architect drawings, identifying items,<br/>and generating a detailed estimate...</p>
                                    </div>
                                    <div className="flex items-center gap-2 mt-2">
                                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                                    </div>
                                </div>
                            ) : parsedAiData ? (
                                <div className="max-w-5xl mx-auto p-6 space-y-6">
                                    {/* Plan Analysis Card */}
                                    {planAnalysis && (
                                        <div className="bg-gradient-to-r from-emerald-50 to-teal-50 rounded-xl border border-emerald-200 p-5">
                                            <div className="flex items-start gap-3 mb-3">
                                                <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0">
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                                </div>
                                                <div>
                                                    <h3 className="text-sm font-bold text-emerald-800">What AI Detected from Your Plans</h3>
                                                    {planAnalysis.scopeNotes && <p className="text-xs text-emerald-700 mt-1">{planAnalysis.scopeNotes}</p>}
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                                {planAnalysis.roomDimensions && (
                                                    <div className="bg-white/70 rounded-lg px-3 py-2 border border-emerald-100">
                                                        <p className="text-[10px] font-semibold text-emerald-600 uppercase">Dimensions</p>
                                                        <p className="text-sm font-medium text-slate-800">{planAnalysis.roomDimensions}</p>
                                                    </div>
                                                )}
                                                {planAnalysis.totalSqFt > 0 && (
                                                    <div className="bg-white/70 rounded-lg px-3 py-2 border border-emerald-100">
                                                        <p className="text-[10px] font-semibold text-emerald-600 uppercase">Total Area</p>
                                                        <p className="text-sm font-medium text-slate-800">{planAnalysis.totalSqFt.toLocaleString()} sq ft</p>
                                                    </div>
                                                )}
                                                {planAnalysis.detectedItems?.length > 0 && (
                                                    <div className="bg-white/70 rounded-lg px-3 py-2 border border-emerald-100 col-span-full">
                                                        <p className="text-[10px] font-semibold text-emerald-600 uppercase mb-1">Detected Items</p>
                                                        <div className="flex flex-wrap gap-1">
                                                            {planAnalysis.detectedItems.map((item: string, i: number) => (
                                                                <span key={i} className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-[10px] font-medium border border-emerald-200">{item}</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Summary */}
                                    {parsedAiData.summary && (
                                        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
                                            <p className="text-sm text-indigo-800">{parsedAiData.summary}</p>
                                        </div>
                                    )}

                                    {/* Estimate Total + Convert Button */}
                                    <div className="flex items-center justify-between bg-slate-900 rounded-xl px-6 py-4 text-white">
                                        <div>
                                            <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">Total Estimate</p>
                                            <p className="text-3xl font-bold">${(parsedAiData.totalEstimate || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <div className="text-right">
                                                <p className="text-xs text-slate-400">{parsedAiData.items?.length || 0} line items</p>
                                                <p className="text-xs text-slate-400">{parsedAiData.paymentMilestones?.length || 0} milestones</p>
                                            </div>
                                            {selectedTakeoff?.estimateId ? (
                                                <button
                                                    onClick={() => {
                                                        const url = contextType === "project"
                                                            ? `/projects/${contextId}/estimates/${selectedTakeoff.estimateId}`
                                                            : `/leads/${contextId}/estimates/${selectedTakeoff.estimateId}`;
                                                        router.push(url);
                                                    }}
                                                    className="px-5 py-2.5 bg-white text-slate-900 rounded-lg font-bold text-sm hover:bg-slate-100 transition flex items-center gap-2 shadow-lg"
                                                >
                                                    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                                    View Estimate
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={handleConvertToEstimate}
                                                    disabled={converting}
                                                    className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white rounded-lg font-bold text-sm transition flex items-center gap-2 shadow-lg disabled:opacity-50"
                                                >
                                                    {converting ? (
                                                        <>
                                                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                                            Converting...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9,15 12,12 15,15"/></svg>
                                                            Convert to Estimate →
                                                        </>
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Line Items Table */}
                                    <div className="hui-card overflow-hidden">
                                        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                                            <h3 className="text-sm font-bold text-hui-textMain">Line Items</h3>
                                            <div className="flex items-center gap-3">
                                                {/* Global Markup Control (internal only) */}
                                                {viewMode === "internal" && (
                                                    <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5">
                                                        <span className="text-[10px] text-slate-500 font-semibold uppercase">Global Markup</span>
                                                        <input
                                                            type="number"
                                                            value={globalMarkup}
                                                            onChange={(e) => {
                                                                const newMarkup = parseFloat(e.target.value) || 0;
                                                                setGlobalMarkup(newMarkup);
                                                                const items = adjustedItems || parsedAiData.items || [];
                                                                setAdjustedItems(items.map((item: any) => {
                                                                    const base = item.baseCost || item.unitCost / (1 + (item.markupPercent || 25) / 100);
                                                                    const sell = base * (1 + newMarkup / 100);
                                                                    return { ...item, markupPercent: newMarkup, unitCost: Math.round(sell * 100) / 100, total: Math.round(sell * item.quantity * 100) / 100 };
                                                                }));
                                                            }}
                                                            className="w-14 text-center text-xs font-bold border border-slate-200 rounded px-1 py-0.5"
                                                            min={0}
                                                            max={100}
                                                            step={1}
                                                        />
                                                        <span className="text-xs font-bold text-slate-600">%</span>
                                                    </div>
                                                )}
                                                {/* View Mode Toggle */}
                                                <div className="flex rounded-lg overflow-hidden border border-slate-200">
                                                    <button
                                                        onClick={() => setViewMode("internal")}
                                                        className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition ${
                                                            viewMode === "internal"
                                                                ? "bg-slate-800 text-white"
                                                                : "bg-white text-slate-500 hover:bg-slate-50"
                                                        }`}
                                                    >
                                                        🔒 Internal
                                                    </button>
                                                    <button
                                                        onClick={() => setViewMode("client")}
                                                        className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition ${
                                                            viewMode === "client"
                                                                ? "bg-emerald-600 text-white"
                                                                : "bg-white text-slate-500 hover:bg-slate-50"
                                                        }`}
                                                    >
                                                        👁️ Client
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Internal View: Margin Summary Bar */}
                                        {viewMode === "internal" && (() => {
                                            const items = adjustedItems || parsedAiData.items || [];
                                            const totalCost = items.reduce((s: number, i: any) => s + ((i.baseCost || i.unitCost / (1 + (i.markupPercent || 25) / 100)) * (i.quantity || 1)), 0);
                                            const totalSell = items.reduce((s: number, i: any) => s + (i.total || 0), 0);
                                            const totalMarkup = totalSell - totalCost;
                                            const marginPct = totalSell > 0 ? (totalMarkup / totalSell * 100) : 0;
                                            return (
                                                <div className="px-4 py-2.5 bg-gradient-to-r from-slate-800 to-slate-700 flex items-center justify-between text-white text-xs">
                                                    <div className="flex items-center gap-6">
                                                        <div>
                                                            <span className="text-slate-400 uppercase text-[9px] font-semibold">Total Cost</span>
                                                            <p className="font-bold">${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                                        </div>
                                                        <div>
                                                            <span className="text-slate-400 uppercase text-[9px] font-semibold">Markup</span>
                                                            <p className="font-bold text-emerald-400">+${totalMarkup.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                                        </div>
                                                        <div>
                                                            <span className="text-slate-400 uppercase text-[9px] font-semibold">Profit Margin</span>
                                                            <p className="font-bold text-amber-400">{marginPct.toFixed(1)}%</p>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <span className="text-slate-400 uppercase text-[9px] font-semibold">Sell Price</span>
                                                        <p className="font-bold text-lg">${totalSell.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                                                    </div>
                                                </div>
                                            );
                                        })()}

                                        <div className="overflow-x-auto">
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className="border-b border-slate-100 bg-slate-50/50">
                                                        <th className="text-left px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Phase</th>
                                                        <th className="text-left px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Item</th>
                                                        <th className="text-left px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Type</th>
                                                        <th className="text-right px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Qty</th>
                                                        <th className="text-right px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Unit</th>
                                                        {viewMode === "internal" && (
                                                            <>
                                                                <th className="text-right px-4 py-2.5 font-semibold text-blue-600 uppercase tracking-wider text-[10px] bg-blue-50/50">Base Cost</th>
                                                                <th className="text-right px-4 py-2.5 font-semibold text-blue-600 uppercase tracking-wider text-[10px] bg-blue-50/50">Markup %</th>
                                                            </>
                                                        )}
                                                        <th className="text-right px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">{viewMode === "internal" ? "Sell Price" : "Unit Cost"}</th>
                                                        <th className="text-right px-4 py-2.5 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Total</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-slate-50">
                                                    {((adjustedItems || parsedAiData.items || [])).map((item: any, idx: number) => {
                                                        const baseCost = item.baseCost || item.unitCost / (1 + (item.markupPercent || 25) / 100);
                                                        const mkp = item.markupPercent ?? 25;
                                                        return (
                                                            <tr key={idx} className={`hover:bg-slate-50 transition ${item.isAllowance ? "bg-amber-50/30" : ""}`}>
                                                                <td className="px-4 py-2">
                                                                    <span className="px-1.5 py-0.5 bg-slate-100 rounded text-[10px] font-mono text-slate-600">{item.costCode || "—"}</span>
                                                                </td>
                                                                <td className="px-4 py-2">
                                                                    <div>
                                                                        <p className="font-medium text-hui-textMain flex items-center gap-1">
                                                                            {item.name}
                                                                            {item.isAllowance && <span className="px-1 py-0.5 bg-amber-100 text-amber-700 rounded text-[9px] font-bold">ALLOWANCE</span>}
                                                                        </p>
                                                                        {item.description && <p className="text-slate-400 truncate max-w-sm">{item.description}</p>}
                                                                    </div>
                                                                </td>
                                                                <td className="px-4 py-2 text-slate-500">{item.type || item.costType}</td>
                                                                <td className="px-4 py-2 text-right text-slate-700 font-medium">{item.quantity}</td>
                                                                <td className="px-4 py-2 text-right text-slate-500">{item.unit || "ea"}</td>
                                                                {viewMode === "internal" && (
                                                                    <>
                                                                        <td className="px-4 py-2 text-right text-blue-700 font-medium bg-blue-50/30">
                                                                            ${baseCost.toFixed(2)}
                                                                        </td>
                                                                        <td className="px-4 py-2 text-right bg-blue-50/30">
                                                                            <input
                                                                                type="number"
                                                                                value={mkp}
                                                                                onChange={(e) => {
                                                                                    const newMkp = parseFloat(e.target.value) || 0;
                                                                                    const items = adjustedItems || parsedAiData.items || [];
                                                                                    const newItems = [...items];
                                                                                    const base = newItems[idx].baseCost || newItems[idx].unitCost / (1 + (newItems[idx].markupPercent || 25) / 100);
                                                                                    const sell = base * (1 + newMkp / 100);
                                                                                    newItems[idx] = { ...newItems[idx], markupPercent: newMkp, unitCost: Math.round(sell * 100) / 100, total: Math.round(sell * newItems[idx].quantity * 100) / 100 };
                                                                                    setAdjustedItems(newItems);
                                                                                }}
                                                                                className="w-14 text-right text-xs font-bold text-blue-700 border border-blue-200 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                                                                                min={0}
                                                                                max={100}
                                                                                step={1}
                                                                            />
                                                                            <span className="text-blue-500 ml-0.5">%</span>
                                                                        </td>
                                                                    </>
                                                                )}
                                                                <td className="px-4 py-2 text-right text-slate-700">${item.unitCost?.toFixed(2)}</td>
                                                                <td className="px-4 py-2 text-right font-bold text-hui-textMain">${item.total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                                <tfoot>
                                                    <tr className="bg-slate-50 border-t-2 border-slate-200">
                                                        <td colSpan={viewMode === "internal" ? 8 : 6} className="px-4 py-3 text-right font-bold text-sm text-hui-textMain">TOTAL</td>
                                                        <td className="px-4 py-3 text-right font-bold text-sm text-green-700">
                                                            ${((adjustedItems || parsedAiData.items || []).reduce((s: number, i: any) => s + (i.total || 0), 0) || parsedAiData.totalEstimate || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                        </td>
                                                    </tr>
                                                </tfoot>
                                            </table>
                                        </div>
                                    </div>

                                    {/* Payment Milestones */}
                                    {parsedAiData.paymentMilestones?.length > 0 && (
                                        <div className="hui-card p-5">
                                            <h3 className="text-sm font-bold text-hui-textMain mb-3">Payment Milestones</h3>
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                                {parsedAiData.paymentMilestones.map((m: any, idx: number) => (
                                                    <div key={idx} className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                                                        <p className="text-xs text-slate-500 font-medium">{m.name}</p>
                                                        <p className="text-lg font-bold text-hui-textMain">${parseFloat(m.amount).toLocaleString()}</p>
                                                        <p className="text-[10px] text-slate-400">{m.percentage}% of total</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Actions */}
                                    <div className="flex items-center justify-center gap-6 py-4">
                                        <button
                                            onClick={() => { setActiveTab("plans"); }}
                                            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium transition"
                                        >
                                            ← Back to Plans to Refine & Re-generate
                                        </button>
                                        {!selectedTakeoff?.estimateId && (
                                            <button
                                                onClick={handleConvertToEstimate}
                                                disabled={converting}
                                                className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white rounded-lg font-bold text-sm transition flex items-center gap-2 shadow disabled:opacity-50"
                                            >
                                                {converting ? "Converting..." : "✅ Convert to Estimate & Open Editor →"}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
                                    <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center">
                                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5">
                                            <path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z"/>
                                        </svg>
                                    </div>
                                    <div className="text-center max-w-md">
                                        <h3 className="text-lg font-bold text-hui-textMain">AI-Powered Estimating</h3>
                                        <p className="text-sm text-slate-500 mt-2">
                                            Upload your architect plans, then click <strong>"Analyze Plans & Estimate"</strong> in the Plans tab. 
                                            AI will read the drawings, identify fixtures, measure dimensions, and generate a detailed line-item estimate.
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => setActiveTab("plans")}
                                        className="hui-btn hui-btn-secondary text-sm mt-2"
                                    >
                                        Go to Plans Tab →
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════
    // EMPTY STATE
    // ══════════════════════════════════════════════════════════════
    if (!loading && takeoffs.length === 0) {
        return (
            <div className="max-w-4xl mx-auto pt-4">
                <div className="flex items-center justify-between mb-8">
                    <h1 className="text-2xl font-bold text-hui-textMain">Takeoffs</h1>
                    <button onClick={() => setShowCreateModal(true)} className="hui-btn hui-btn-primary">
                        Create a Takeoff
                    </button>
                </div>

                <div className="hui-card p-8">
                    <div className="flex flex-col md:flex-row items-center gap-8">
                        <div className="w-full md:w-1/2 aspect-video bg-gradient-to-br from-indigo-50 via-violet-50 to-purple-50 rounded-xl flex items-center justify-center border border-indigo-100 relative overflow-hidden">
                            <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgdmlld0JveD0iMCAwIDEwMCAxMDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAxMCAwIEwgMCAwIDAgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzgxOGNmODIwIiBzdHJva2Utd2lkdGg9IjAuNSIvPjwvcGF0dGVybj48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0idXJsKCNncmlkKSIvPjwvc3ZnPg==')] opacity-50"></div>
                            <div className="relative flex flex-col items-center gap-4">
                                <div className="w-20 h-20 rounded-2xl bg-white/80 backdrop-blur flex items-center justify-center shadow-xl border border-white/50">
                                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5">
                                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                                        <polyline points="14,2 14,8 20,8"/>
                                        <path d="M12 11v6M9 14h6"/>
                                    </svg>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="px-3 py-1.5 bg-white/70 backdrop-blur rounded-full border border-white/50 shadow-sm">
                                        <span className="text-xs font-semibold text-indigo-700">📐 Auto-measure from plans</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="w-full md:w-1/2 space-y-4">
                            <h2 className="text-2xl font-bold text-hui-textMain">
                                Measure Plans in Minutes
                            </h2>
                            <p className="text-hui-textMuted text-sm leading-relaxed">
                                Upload architect plans (PDFs or images) and let AI analyze the drawings to automatically 
                                identify fixtures, measure dimensions, and generate a detailed line-item estimate — all in seconds.
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {["📄 PDF Plans", "📸 Site Photos", "🎥 Video Walkthrough", "🤖 AI Analysis"].map(tag => (
                                    <span key={tag} className="px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-full text-xs font-medium border border-indigo-100">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                            <button onClick={() => setShowCreateModal(true)} className="hui-btn hui-btn-green">
                                Create a Takeoff
                            </button>
                        </div>
                    </div>
                </div>

                {renderCreateModal()}
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════
    // LIST VIEW
    // ══════════════════════════════════════════════════════════════
    function renderCreateModal() {
        if (!showCreateModal) return null;
        return (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-hui-border">
                        <h2 className="text-lg font-bold text-hui-textMain">Create a Takeoff</h2>
                        <button onClick={() => { setShowCreateModal(false); setPendingFiles([]); setCreateName(""); setCreateDescription(""); }}
                            className="text-slate-400 hover:text-slate-600 text-2xl leading-none">&times;</button>
                    </div>
                    <div className="p-6 space-y-5">
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Takeoff Name *</label>
                            <input type="text" value={createName} onChange={e => setCreateName(e.target.value)}
                                placeholder="e.g., Atherton Kitchen Remodel Plans" className="hui-input" autoFocus />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Scope Description</label>
                            <textarea value={createDescription} onChange={e => setCreateDescription(e.target.value)}
                                placeholder="Describe what's included... (e.g., Full kitchen gut and remodel, 12x15 space, custom walnut cabinets, quartz countertops, island with sink relocation...)"
                                className="hui-input min-h-[80px] resize-y" rows={3} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Upload Architect Plans & Media</label>
                            <div onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => fileInputRef.current?.click()}
                                className="border-2 border-dashed border-slate-300 hover:border-indigo-400 rounded-xl p-6 text-center cursor-pointer transition-colors group bg-slate-50 hover:bg-indigo-50/30">
                                <svg className="w-10 h-10 mx-auto mb-2 text-slate-300 group-hover:text-indigo-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                                    <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                                </svg>
                                <p className="text-sm text-hui-textMuted">Drop architect plans here or <span className="text-indigo-600 font-medium">browse</span></p>
                                <p className="text-xs text-slate-400 mt-1">PDFs, images, or video walkthroughs</p>
                            </div>
                            <input ref={fileInputRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.avi" className="hidden"
                                onChange={e => { if (e.target.files) setPendingFiles(prev => [...prev, ...Array.from(e.target.files!)]); }} />
                            {pendingFiles.length > 0 && (
                                <div className="mt-3 space-y-2">
                                    {pendingFiles.map((f, i) => (
                                        <div key={i} className="flex items-center gap-3 px-3 py-2 bg-slate-50 rounded-lg border border-slate-100">
                                            <div className="w-8 h-8 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
                                                {f.type === "application/pdf" ? "📄" : f.type.startsWith("image") ? "📸" : "🎥"}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm text-hui-textMain truncate">{f.name}</p>
                                                <p className="text-xs text-hui-textMuted">{formatFileSize(f.size)}</p>
                                            </div>
                                            <button onClick={() => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                                                className="text-slate-400 hover:text-red-500 transition shrink-0">&times;</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hui-border bg-slate-50 rounded-b-2xl">
                        <button onClick={() => { setShowCreateModal(false); setPendingFiles([]); }} className="hui-btn hui-btn-secondary">Cancel</button>
                        <button onClick={handleCreate} disabled={creating || !createName.trim()} className="hui-btn hui-btn-green disabled:opacity-50">
                            {creating ? "Creating..." : "Create Takeoff"}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto pt-4">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold text-hui-textMain">Takeoffs</h1>
                <button onClick={() => setShowCreateModal(true)} className="hui-btn hui-btn-primary">Create a Takeoff</button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center h-40 text-hui-textMuted">
                    <svg className="w-6 h-6 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Loading...
                </div>
            ) : (
                <div className="grid gap-4">
                    {takeoffs.map(t => {
                        const hasAi = !!t.aiEstimateData;
                        const aiData = hasAi ? JSON.parse(t.aiEstimateData!) : null;
                        return (
                            <div key={t.id} onClick={() => openTakeoff(t.id)}
                                className="hui-card p-5 hover:shadow-md transition cursor-pointer group">
                                <div className="flex items-start justify-between">
                                    <div className="flex items-start gap-4">
                                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                                            hasAi ? "bg-gradient-to-br from-emerald-100 to-green-100" : "bg-gradient-to-br from-slate-100 to-slate-50"
                                        }`}>
                                            {hasAi ? (
                                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="1.5"><path d="M20 6L9 17l-5-5"/></svg>
                                            ) : (
                                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                            )}
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-bold text-hui-textMain group-hover:text-indigo-700 transition">{t.name}</h3>
                                            {t.description && <p className="text-xs text-hui-textMuted mt-0.5 max-w-md truncate">{t.description}</p>}
                                            <div className="flex items-center gap-3 mt-2">
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusColors[t.status]}`}>{t.status}</span>
                                                <span className="text-xs text-slate-400">{t.files.length} {t.files.length === 1 ? "file" : "files"}</span>
                                                <span className="text-xs text-slate-400">{new Date(t.createdAt).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {hasAi && (
                                            <div className="text-right">
                                                <p className="text-xs text-slate-400">AI Estimate</p>
                                                <p className="text-sm font-bold text-green-700">${aiData?.totalEstimate?.toLocaleString()}</p>
                                            </div>
                                        )}
                                        <button onClick={e => { e.stopPropagation(); handleDelete(t.id); }}
                                            className="text-slate-300 hover:text-red-500 transition opacity-0 group-hover:opacity-100 p-1">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {renderCreateModal()}
        </div>
    );
}
