"use client";

import { useState, useRef, useCallback, useEffect } from "react";
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
    const [takeoffs, setTakeoffs] = useState<Takeoff[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showDetailPanel, setShowDetailPanel] = useState<string | null>(null);
    const [detailTakeoff, setDetailTakeoff] = useState<Takeoff | null>(null);

    // Create modal state
    const [createName, setCreateName] = useState("");
    const [createDescription, setCreateDescription] = useState("");
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [creating, setCreating] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // AI context modal state
    const [showAiModal, setShowAiModal] = useState(false);
    const [aiContext, setAiContext] = useState("");
    const [aiLoading, setAiLoading] = useState(false);
    const [aiResult, setAiResult] = useState<any>(null);
    const [aiContextFiles, setAiContextFiles] = useState<File[]>([]);
    const aiFileInputRef = useRef<HTMLInputElement>(null);

    const fetchTakeoffs = useCallback(async () => {
        try {
            const paramKey = contextType === "project" ? "projectId" : "leadId";
            const res = await fetch(`/api/takeoffs?${paramKey}=${contextId}`);
            if (res.ok) {
                const data = await res.json();
                setTakeoffs(data);
            }
        } catch (err) {
            console.error("Failed to fetch takeoffs:", err);
        } finally {
            setLoading(false);
        }
    }, [contextId, contextType]);

    useEffect(() => {
        fetchTakeoffs();
    }, [fetchTakeoffs]);

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

            // Upload files if any
            if (pendingFiles.length > 0) {
                const formData = new FormData();
                formData.append("takeoffId", takeoff.id);
                for (const f of pendingFiles) formData.append("files", f);

                await fetch("/api/takeoffs/upload", { method: "POST", body: formData });
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
            setShowDetailPanel(null);
            setDetailTakeoff(null);
            await fetchTakeoffs();
        } catch {
            toast.error("Failed to delete");
        }
    };

    const openDetail = async (id: string) => {
        setShowDetailPanel(id);
        try {
            const res = await fetch(`/api/takeoffs/${id}`);
            if (res.ok) {
                const data = await res.json();
                setDetailTakeoff(data);
            }
        } catch {
            toast.error("Failed to load takeoff details");
        }
    };

    const handleGenerateEstimate = async () => {
        if (!detailTakeoff) return;
        setAiLoading(true);

        try {
            // Upload additional context files if any
            if (aiContextFiles.length > 0) {
                const formData = new FormData();
                formData.append("takeoffId", detailTakeoff.id);
                for (const f of aiContextFiles) formData.append("files", f);
                await fetch("/api/takeoffs/upload", { method: "POST", body: formData });
            }

            const res = await fetch("/api/takeoffs/ai-estimate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    takeoffId: detailTakeoff.id,
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
            toast.success(`AI generated ${result.count} estimate items — $${result.totalEstimate?.toLocaleString()}`);

            // Refresh detail
            const detailRes = await fetch(`/api/takeoffs/${detailTakeoff.id}`);
            if (detailRes.ok) setDetailTakeoff(await detailRes.json());

            await fetchTakeoffs();
        } catch (err: any) {
            toast.error(err.message || "Failed to generate estimate");
        } finally {
            setAiLoading(false);
        }
    };

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        setPendingFiles(prev => [...prev, ...files]);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
    }, []);

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const statusColors: Record<string, string> = {
        "Draft": "bg-slate-100 text-slate-700",
        "In Progress": "bg-blue-100 text-blue-700",
        "Completed": "bg-green-100 text-green-700",
    };

    // ── EMPTY STATE ─────────────────────────────────────────────
    if (!loading && takeoffs.length === 0 && !showCreateModal) {
        return (
            <div className="max-w-4xl mx-auto pt-4">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <h1 className="text-2xl font-bold text-hui-textMain">Takeoffs</h1>
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="hui-btn hui-btn-primary"
                    >
                        Create a Takeoff
                    </button>
                </div>

                {/* Hero Card */}
                <div className="hui-card p-8">
                    <div className="flex flex-col md:flex-row items-center gap-8">
                        {/* Video/Image Placeholder */}
                        <div className="w-full md:w-1/2 aspect-video bg-gradient-to-br from-emerald-50 to-teal-50 rounded-xl flex items-center justify-center border border-emerald-100 relative overflow-hidden">
                            <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgdmlld0JveD0iMCAwIDEwMCAxMDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTSAxMCAwIEwgMCAwIDAgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzEwYjk4MTEwIiBzdHJva2Utd2lkdGg9IjAuNSIvPjwvcGF0dGVybj48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0idXJsKCNncmlkKSIvPjwvc3ZnPg==')] opacity-50"></div>
                            <div className="relative flex flex-col items-center gap-3">
                                <div className="w-16 h-16 rounded-full bg-white/80 backdrop-blur flex items-center justify-center shadow-lg">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.5">
                                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                                        <polyline points="14,2 14,8 20,8"/>
                                        <line x1="16" y1="13" x2="8" y2="13"/>
                                        <line x1="16" y1="17" x2="8" y2="17"/>
                                        <line x1="10" y1="9" x2="8" y2="9"/>
                                    </svg>
                                </div>
                                <span className="text-sm font-medium text-emerald-700 bg-white/60 px-3 py-1 rounded-full backdrop-blur">
                                    How to create your takeoff categories
                                </span>
                            </div>
                        </div>

                        {/* Text */}
                        <div className="w-full md:w-1/2 space-y-4">
                            <h2 className="text-2xl font-bold text-hui-textMain">
                                Measure Plans in Minutes
                            </h2>
                            <p className="text-hui-textMuted text-sm leading-relaxed">
                                Quickly and accurately measure and markup plans, then turn them into estimates 10x faster. 
                                Upload your construction plans (PDFs, images, or video walkthroughs) and let AI generate 
                                a detailed estimate based on your past projects and local market rates.
                            </p>
                            <button
                                onClick={() => setShowCreateModal(true)}
                                className="hui-btn hui-btn-green"
                            >
                                Create a Takeoff
                            </button>
                        </div>
                    </div>
                </div>

                {renderCreateModal()}
            </div>
        );
    }

    // ── LIST VIEW ───────────────────────────────────────────────
    function renderList() {
        return (
            <div className="max-w-6xl mx-auto pt-4">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <h1 className="text-2xl font-bold text-hui-textMain">Takeoffs</h1>
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="hui-btn hui-btn-primary"
                    >
                        Create a Takeoff
                    </button>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center h-40 text-hui-textMuted">
                        <svg className="w-6 h-6 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Loading takeoffs...
                    </div>
                ) : (
                    <div className="hui-card">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-hui-border bg-slate-50">
                                    <th className="text-left px-4 py-3 font-semibold text-hui-textMuted text-xs uppercase tracking-wider">Name</th>
                                    <th className="text-left px-4 py-3 font-semibold text-hui-textMuted text-xs uppercase tracking-wider">Status</th>
                                    <th className="text-left px-4 py-3 font-semibold text-hui-textMuted text-xs uppercase tracking-wider">Files</th>
                                    <th className="text-left px-4 py-3 font-semibold text-hui-textMuted text-xs uppercase tracking-wider">AI Estimate</th>
                                    <th className="text-left px-4 py-3 font-semibold text-hui-textMuted text-xs uppercase tracking-wider">Created</th>
                                    <th className="text-right px-4 py-3 font-semibold text-hui-textMuted text-xs uppercase tracking-wider">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-hui-border">
                                {takeoffs.map(t => (
                                    <tr
                                        key={t.id}
                                        className="hover:bg-slate-50 transition cursor-pointer"
                                        onClick={() => openDetail(t.id)}
                                    >
                                        <td className="px-4 py-3">
                                            <div>
                                                <p className="font-medium text-hui-textMain">{t.name}</p>
                                                {t.description && (
                                                    <p className="text-xs text-hui-textMuted truncate max-w-xs">{t.description}</p>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[t.status] || "bg-slate-100 text-slate-700"}`}>
                                                {t.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">
                                            {t.files.length} {t.files.length === 1 ? "file" : "files"}
                                        </td>
                                        <td className="px-4 py-3">
                                            {t.aiEstimateData ? (
                                                <span className="text-green-600 text-xs font-medium flex items-center gap-1">
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
                                                    Generated
                                                </span>
                                            ) : (
                                                <span className="text-hui-textMuted text-xs">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted text-xs">
                                            {new Date(t.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}
                                                className="text-red-400 hover:text-red-600 transition p-1"
                                                title="Delete"
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {renderCreateModal()}
                {renderDetailPanel()}
            </div>
        );
    }

    // ── CREATE MODAL ────────────────────────────────────────────
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
                        {/* Name */}
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Takeoff Name *</label>
                            <input
                                type="text"
                                value={createName}
                                onChange={e => setCreateName(e.target.value)}
                                placeholder="e.g., Kitchen Plans Takeoff"
                                className="hui-input"
                                autoFocus
                            />
                        </div>

                        {/* Description */}
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Description</label>
                            <textarea
                                value={createDescription}
                                onChange={e => setCreateDescription(e.target.value)}
                                placeholder="Describe the scope (e.g., full kitchen remodel, 12x15 space, new cabinets and countertops...)"
                                className="hui-input min-h-[80px] resize-y"
                                rows={3}
                            />
                        </div>

                        {/* File Drop Zone */}
                        <div>
                            <label className="block text-sm font-medium text-hui-textMain mb-1">Upload Plans & Media</label>
                            <div
                                onDrop={handleDrop}
                                onDragOver={handleDragOver}
                                onClick={() => fileInputRef.current?.click()}
                                className="border-2 border-dashed border-slate-300 hover:border-hui-primary rounded-xl p-6 text-center cursor-pointer transition-colors group"
                            >
                                <svg className="w-10 h-10 mx-auto mb-2 text-slate-300 group-hover:text-hui-primary transition" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5">
                                    <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                                </svg>
                                <p className="text-sm text-hui-textMuted">
                                    Drop files here or <span className="text-hui-primary font-medium">browse</span>
                                </p>
                                <p className="text-xs text-slate-400 mt-1">PDFs, images, or video walkthroughs</p>
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept=".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.avi"
                                className="hidden"
                                onChange={e => {
                                    if (e.target.files) {
                                        setPendingFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                                    }
                                }}
                            />

                            {/* File List */}
                            {pendingFiles.length > 0 && (
                                <div className="mt-3 space-y-2">
                                    {pendingFiles.map((f, i) => (
                                        <div key={i} className="flex items-center gap-3 px-3 py-2 bg-slate-50 rounded-lg border border-slate-100">
                                            <div className="w-8 h-8 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
                                                {f.type.startsWith("image") ? (
                                                    <svg width="16" height="16" fill="none" stroke="#64748b" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                                                ) : f.type.startsWith("video") ? (
                                                    <svg width="16" height="16" fill="none" stroke="#64748b" strokeWidth="1.5" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                                                ) : (
                                                    <svg width="16" height="16" fill="none" stroke="#64748b" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm text-hui-textMain truncate">{f.name}</p>
                                                <p className="text-xs text-hui-textMuted">{formatFileSize(f.size)}</p>
                                            </div>
                                            <button
                                                onClick={() => setPendingFiles(prev => prev.filter((_, idx) => idx !== i))}
                                                className="text-slate-400 hover:text-red-500 transition shrink-0"
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-hui-border bg-slate-50 rounded-b-2xl">
                        <button
                            onClick={() => { setShowCreateModal(false); setPendingFiles([]); setCreateName(""); setCreateDescription(""); }}
                            className="hui-btn hui-btn-secondary"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleCreate}
                            disabled={creating || !createName.trim()}
                            className="hui-btn hui-btn-green disabled:opacity-50"
                        >
                            {creating ? (
                                <span className="flex items-center gap-2">
                                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                    </svg>
                                    Creating...
                                </span>
                            ) : "Create Takeoff"}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── DETAIL PANEL (SLIDE-IN) ─────────────────────────────────
    function renderDetailPanel() {
        if (!showDetailPanel) return null;

        return (
            <div className="fixed inset-0 bg-black/40 z-50 flex justify-end">
                <div className="w-full max-w-2xl bg-white shadow-2xl flex flex-col h-full overflow-hidden animate-slide-in-right">
                    {/* Panel Header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-hui-border bg-white shrink-0">
                        <div>
                            <h2 className="text-lg font-bold text-hui-textMain">
                                {detailTakeoff?.name || "Loading..."}
                            </h2>
                            {detailTakeoff && (
                                <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[detailTakeoff.status] || "bg-slate-100 text-slate-700"}`}>
                                    {detailTakeoff.status}
                                </span>
                            )}
                        </div>
                        <button
                            onClick={() => { setShowDetailPanel(null); setDetailTakeoff(null); setAiResult(null); setShowAiModal(false); }}
                            className="text-slate-400 hover:text-slate-600 text-2xl leading-none"
                        >
                            &times;
                        </button>
                    </div>

                    {!detailTakeoff ? (
                        <div className="flex-1 flex items-center justify-center text-hui-textMuted">
                            <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                            </svg>
                            Loading...
                        </div>
                    ) : (
                        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                            {/* Description */}
                            {detailTakeoff.description && (
                                <div>
                                    <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2">Description</h3>
                                    <p className="text-sm text-hui-textMain bg-slate-50 rounded-lg p-3 border border-slate-100">
                                        {detailTakeoff.description}
                                    </p>
                                </div>
                            )}

                            {/* Uploaded Files */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                        Uploaded Files ({detailTakeoff.files.length})
                                    </h3>
                                    <button
                                        onClick={() => {
                                            const input = document.createElement("input");
                                            input.type = "file";
                                            input.multiple = true;
                                            input.accept = ".pdf,.png,.jpg,.jpeg,.webp,.mp4,.mov,.avi";
                                            input.onchange = async () => {
                                                if (!input.files?.length) return;
                                                const formData = new FormData();
                                                formData.append("takeoffId", detailTakeoff.id);
                                                for (const f of Array.from(input.files)) formData.append("files", f);
                                                await fetch("/api/takeoffs/upload", { method: "POST", body: formData });
                                                toast.success("Files uploaded!");
                                                const res = await fetch(`/api/takeoffs/${detailTakeoff.id}`);
                                                if (res.ok) setDetailTakeoff(await res.json());
                                            };
                                            input.click();
                                        }}
                                        className="text-xs text-hui-primary hover:text-hui-primaryHover font-medium transition"
                                    >
                                        + Add Files
                                    </button>
                                </div>

                                {detailTakeoff.files.length === 0 ? (
                                    <p className="text-sm text-hui-textMuted italic">No files uploaded yet.</p>
                                ) : (
                                    <div className="grid grid-cols-2 gap-3">
                                        {detailTakeoff.files.map(f => (
                                            <a
                                                key={f.id}
                                                href={f.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-hui-primary hover:bg-slate-50 transition group"
                                            >
                                                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                                                    {f.mimeType.startsWith("image") ? (
                                                        <svg width="20" height="20" fill="none" stroke="#64748b" strokeWidth="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                                                    ) : f.mimeType.startsWith("video") ? (
                                                        <svg width="20" height="20" fill="none" stroke="#64748b" strokeWidth="1.5" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                                                    ) : (
                                                        <svg width="20" height="20" fill="none" stroke="#ef4444" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="text-sm font-medium text-hui-textMain truncate group-hover:text-hui-primary transition">{f.name}</p>
                                                    <p className="text-xs text-hui-textMuted">{formatFileSize(f.size)}</p>
                                                </div>
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* AI Estimate Section */}
                            <div className="border-t border-hui-border pt-5">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">
                                        AI Estimate Generator
                                    </h3>
                                    {detailTakeoff.estimate && (
                                        <a
                                            href={contextType === "project"
                                                ? `/projects/${contextId}/estimates/${detailTakeoff.estimate.id}`
                                                : `/leads/${contextId}/estimates/${detailTakeoff.estimate.id}`
                                            }
                                            className="text-xs text-hui-primary font-medium hover:underline"
                                        >
                                            View Linked Estimate →
                                        </a>
                                    )}
                                </div>

                                {/* AI Context Window */}
                                <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-xl border border-indigo-100 p-5 space-y-4">
                                    <div className="flex items-start gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center border border-indigo-200 shrink-0 mt-0.5">
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5">
                                                <path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z"/>
                                            </svg>
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-indigo-800">AI-Powered Estimate Builder</p>
                                            <p className="text-xs text-indigo-600 mt-0.5">
                                                Add context below to help AI generate a more accurate estimate. Include details about scope, 
                                                materials, finishes, or attach photos and videos for reference.
                                            </p>
                                        </div>
                                    </div>

                                    {/* Additional Context Textarea */}
                                    <textarea
                                        value={aiContext}
                                        onChange={e => setAiContext(e.target.value)}
                                        placeholder="Describe additional details... (e.g., 'Custom walnut cabinets, quartz countertops, under-cabinet lighting, new tile backsplash, relocate plumbing for island sink...')"
                                        className="w-full border border-indigo-200 bg-white rounded-lg px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 resize-y min-h-[80px]"
                                        rows={3}
                                    />

                                    {/* Additional Context Files */}
                                    <div>
                                        <button
                                            onClick={() => aiFileInputRef.current?.click()}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 transition"
                                        >
                                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                                            </svg>
                                            Attach Photos/Video for Context
                                        </button>
                                        <input
                                            ref={aiFileInputRef}
                                            type="file"
                                            multiple
                                            accept=".png,.jpg,.jpeg,.webp,.mp4,.mov"
                                            className="hidden"
                                            onChange={e => {
                                                if (e.target.files) setAiContextFiles(prev => [...prev, ...Array.from(e.target.files!)]);
                                            }}
                                        />
                                        {aiContextFiles.length > 0 && (
                                            <div className="flex flex-wrap gap-2 mt-2">
                                                {aiContextFiles.map((f, i) => (
                                                    <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-indigo-200 rounded-lg text-xs text-indigo-700">
                                                        {f.name}
                                                        <button onClick={() => setAiContextFiles(prev => prev.filter((_, idx) => idx !== i))} className="text-indigo-400 hover:text-red-500">&times;</button>
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Generate Button */}
                                    <button
                                        onClick={handleGenerateEstimate}
                                        disabled={aiLoading}
                                        className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition shadow-sm hover:shadow disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {aiLoading ? (
                                            <>
                                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                                                </svg>
                                                Generating Estimate...
                                            </>
                                        ) : (
                                            <>
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z"/>
                                                </svg>
                                                Generate AI Estimate
                                            </>
                                        )}
                                    </button>
                                </div>

                                {/* AI Results */}
                                {(aiResult || detailTakeoff.aiEstimateData) && (
                                    <div className="mt-4">
                                        {(() => {
                                            const data = aiResult || (detailTakeoff.aiEstimateData ? JSON.parse(detailTakeoff.aiEstimateData) : null);
                                            if (!data) return null;
                                            const items = data.items || [];
                                            const total = data.totalEstimate || items.reduce((s: number, i: any) => s + (i.total || 0), 0);

                                            return (
                                                <div className="space-y-3">
                                                    {data.summary && (
                                                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                                                            <p className="text-sm text-emerald-800">{data.summary}</p>
                                                        </div>
                                                    )}

                                                    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                                                        <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
                                                            <span className="text-sm font-semibold text-hui-textMain">
                                                                {items.length} Line Items
                                                            </span>
                                                            <span className="text-sm font-bold text-green-700">
                                                                Total: ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                            </span>
                                                        </div>
                                                        <div className="max-h-60 overflow-y-auto">
                                                            <table className="w-full text-xs">
                                                                <thead>
                                                                    <tr className="border-b border-slate-100 text-slate-500">
                                                                        <th className="text-left px-3 py-2">Item</th>
                                                                        <th className="text-right px-3 py-2">Qty</th>
                                                                        <th className="text-right px-3 py-2">Unit Cost</th>
                                                                        <th className="text-right px-3 py-2">Total</th>
                                                                    </tr>
                                                                </thead>
                                                                <tbody className="divide-y divide-slate-50">
                                                                    {items.slice(0, 30).map((item: any, idx: number) => (
                                                                        <tr key={idx} className="hover:bg-slate-50">
                                                                            <td className="px-3 py-1.5">
                                                                                <p className="font-medium text-hui-textMain">{item.name}</p>
                                                                                {item.description && (
                                                                                    <p className="text-slate-400 truncate max-w-xs">{item.description}</p>
                                                                                )}
                                                                            </td>
                                                                            <td className="px-3 py-1.5 text-right text-slate-600">{item.quantity}</td>
                                                                            <td className="px-3 py-1.5 text-right text-slate-600">${item.unitCost?.toFixed(2)}</td>
                                                                            <td className="px-3 py-1.5 text-right font-medium text-hui-textMain">${item.total?.toLocaleString()}</td>
                                                                        </tr>
                                                                    ))}
                                                                </tbody>
                                                            </table>
                                                            {items.length > 30 && (
                                                                <p className="text-center text-xs text-slate-400 py-2">
                                                                    + {items.length - 30} more items
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Payment Milestones */}
                                                    {data.paymentMilestones?.length > 0 && (
                                                        <div className="bg-white border border-slate-200 rounded-lg p-3">
                                                            <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2">Payment Milestones</p>
                                                            <div className="space-y-1">
                                                                {data.paymentMilestones.map((m: any, idx: number) => (
                                                                    <div key={idx} className="flex items-center justify-between text-xs">
                                                                        <span className="text-hui-textMain">{m.name}</span>
                                                                        <span className="text-hui-textMuted">{m.percentage}% — ${parseFloat(m.amount).toLocaleString()}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Panel Footer */}
                    {detailTakeoff && (
                        <div className="flex items-center justify-between px-6 py-3 border-t border-hui-border bg-slate-50 shrink-0">
                            <button
                                onClick={() => handleDelete(detailTakeoff.id)}
                                className="text-xs text-red-500 hover:text-red-700 font-medium transition"
                            >
                                Delete Takeoff
                            </button>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => { setShowDetailPanel(null); setDetailTakeoff(null); setAiResult(null); }}
                                    className="hui-btn hui-btn-secondary text-xs py-1.5"
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <>
            {renderList()}
            <style jsx global>{`
                @keyframes slideInRight {
                    from { transform: translateX(100%); }
                    to { transform: translateX(0); }
                }
                .animate-slide-in-right {
                    animation: slideInRight 0.25s ease-out;
                }
            `}</style>
        </>
    );
}
