"use client";

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";

type FileRecord = {
    id: string;
    name: string;
    url: string;
    size: number;
    mimeType: string;
    createdAt: string;
    uploadedBy?: { id: string; name: string | null; email: string } | null;
};

type FolderRecord = {
    id: string;
    name: string;
    _count: { files: number; children: number };
};

function formatBytes(bytes: number) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function isImage(mime: string) {
    return mime.startsWith("image/");
}

function getFileIcon(mime: string) {
    if (mime.startsWith("image/")) return "🖼️";
    if (mime.includes("pdf")) return "📄";
    if (mime.includes("word") || mime.includes("document")) return "📝";
    if (mime.includes("sheet") || mime.includes("excel")) return "📊";
    if (mime.includes("video")) return "🎬";
    if (mime.includes("zip") || mime.includes("rar") || mime.includes("archive")) return "📦";
    return "📎";
}

export default function FileBrowser({ projectId, leadId }: { projectId?: string; leadId?: string }) {
    const [folders, setFolders] = useState<FolderRecord[]>([]);
    const [files, setFiles] = useState<FileRecord[]>([]);
    const [currentFolder, setCurrentFolder] = useState<string | null>(null);
    const [folderPath, setFolderPath] = useState<{ id: string | null; name: string }[]>([{ id: null, name: "All Files" }]);
    const [isUploading, setIsUploading] = useState(false);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [showNewFolder, setShowNewFolder] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
    const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [loaded, setLoaded] = useState(false);

    const fetchFiles = useCallback(async (folderId: string | null = currentFolder) => {
        const params = new URLSearchParams();
        if (projectId) params.set("projectId", projectId);
        if (leadId) params.set("leadId", leadId);
        if (folderId) params.set("folderId", folderId);

        const res = await fetch(`/api/files?${params}`);
        const data = await res.json();
        setFolders(data.folders || []);
        setFiles(data.files || []);
        setLoaded(true);
    }, [projectId, leadId, currentFolder]);

    // Load on mount
    useState(() => { fetchFiles(null); });

    async function handleUpload(fileList: FileList | null) {
        if (!fileList || fileList.length === 0) return;
        setIsUploading(true);
        try {
            const formData = new FormData();
            if (projectId) formData.append("projectId", projectId);
            if (leadId) formData.append("leadId", leadId);
            if (currentFolder) formData.append("folderId", currentFolder);

            Array.from(fileList).forEach(f => formData.append("files", f));

            const res = await fetch("/api/files", { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || `Upload failed (${res.status})`);
                console.error("Upload error:", data);
                return;
            }
            setFiles(prev => [...data.files, ...prev]);
            toast.success(`${data.files.length} file${data.files.length > 1 ? "s" : ""} uploaded`);
        } catch (err: any) {
            console.error("Upload error:", err);
            toast.error(err.message || "Upload failed — check console for details");
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function handleCreateFolder() {
        if (!newFolderName.trim()) return;
        setIsCreatingFolder(true);
        try {
            const res = await fetch("/api/files/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: newFolderName.trim(),
                    projectId,
                    leadId,
                    parentId: currentFolder,
                }),
            });
            if (!res.ok) throw new Error("Failed");
            const folder = await res.json();
            setFolders(prev => [...prev, folder]);
            setNewFolderName("");
            setShowNewFolder(false);
            toast.success("Folder created");
        } catch {
            toast.error("Failed to create folder");
        } finally {
            setIsCreatingFolder(false);
        }
    }

    async function handleDeleteFile(fileId: string) {
        try {
            await fetch(`/api/files?fileId=${fileId}`, { method: "DELETE" });
            setFiles(prev => prev.filter(f => f.id !== fileId));
            toast.success("File deleted");
        } catch { toast.error("Delete failed"); }
    }

    async function handleDeleteFolder(folderId: string) {
        try {
            await fetch(`/api/files?folderId=${folderId}`, { method: "DELETE" });
            setFolders(prev => prev.filter(f => f.id !== folderId));
            toast.success("Folder deleted");
        } catch { toast.error("Delete failed"); }
    }

    function navigateToFolder(folderId: string | null, folderName: string) {
        if (folderId === currentFolder) return;
        if (folderId === null) {
            setFolderPath([{ id: null, name: "All Files" }]);
        } else {
            // Check if we're going back
            const existingIdx = folderPath.findIndex(f => f.id === folderId);
            if (existingIdx >= 0) {
                setFolderPath(prev => prev.slice(0, existingIdx + 1));
            } else {
                setFolderPath(prev => [...prev, { id: folderId, name: folderName }]);
            }
        }
        setCurrentFolder(folderId);
        fetchFiles(folderId);
    }

    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragOver(false);
        handleUpload(e.dataTransfer.files);
    }

    const isEmpty = folders.length === 0 && files.length === 0;

    return (
        <div className="h-full flex flex-col">
            {/* Toolbar */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-amber-400 to-orange-500 rounded-xl flex items-center justify-center shadow-lg shadow-amber-500/25">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">Files & Photos</h1>
                        <p className="text-sm text-hui-textMuted">{files.length} file{files.length !== 1 ? "s" : ""} · {folders.length} folder{folders.length !== 1 ? "s" : ""}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {/* View toggle */}
                    <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                        <button onClick={() => setViewMode("grid")} className={`p-1.5 rounded-md transition ${viewMode === "grid" ? "bg-white shadow-sm" : "text-slate-400 hover:text-slate-600"}`}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                        </button>
                        <button onClick={() => setViewMode("list")} className={`p-1.5 rounded-md transition ${viewMode === "list" ? "bg-white shadow-sm" : "text-slate-400 hover:text-slate-600"}`}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                        </button>
                    </div>
                    <button onClick={() => setShowNewFolder(true)} className="hui-btn hui-btn-secondary text-xs flex items-center gap-1.5">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/><path d="M12 11v6M9 14h6"/></svg>
                        New Folder
                    </button>
                    <button onClick={() => fileInputRef.current?.click()} disabled={isUploading}
                        className="hui-btn hui-btn-primary text-xs flex items-center gap-1.5 shadow-md shadow-indigo-500/20">
                        {isUploading ? (
                            <span className="animate-pulse">Uploading...</span>
                        ) : (
                            <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                                Upload Files
                            </>
                        )}
                    </button>
                    <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => handleUpload(e.target.files)} />
                </div>
            </div>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1.5 mb-5">
                {folderPath.map((crumb, i) => (
                    <div key={crumb.id || "root"} className="flex items-center gap-1.5">
                        {i > 0 && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>}
                        <button
                            onClick={() => navigateToFolder(crumb.id, crumb.name)}
                            className={`text-xs font-medium transition ${
                                i === folderPath.length - 1
                                    ? "text-hui-textMain font-semibold"
                                    : "text-indigo-600 hover:text-indigo-800"
                            }`}
                        >
                            {crumb.name}
                        </button>
                    </div>
                ))}
            </div>

            {/* New Folder Input */}
            {showNewFolder && (
                <div className="flex items-center gap-2 mb-4 bg-indigo-50 p-3 rounded-xl border border-indigo-100 animate-in fade-in">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    <input
                        autoFocus
                        type="text"
                        value={newFolderName}
                        onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
                        placeholder="Folder name..."
                        className="hui-input flex-1 text-sm"
                    />
                    <button onClick={handleCreateFolder} disabled={isCreatingFolder} className="hui-btn hui-btn-primary text-xs">Create</button>
                    <button onClick={() => setShowNewFolder(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                </div>
            )}

            {/* Drop Zone / Content */}
            <div
                className={`flex-1 rounded-xl border-2 border-dashed transition-all ${
                    dragOver
                        ? "border-indigo-400 bg-indigo-50/50"
                        : isEmpty && loaded
                        ? "border-slate-200 bg-slate-50/50"
                        : "border-transparent bg-transparent"
                }`}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
            >
                {/* Empty State */}
                {isEmpty && loaded && (
                    <div className="flex flex-col items-center justify-center py-20 gap-4">
                        <div className="relative">
                            <div className="w-20 h-20 bg-gradient-to-br from-amber-100 to-orange-100 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-100/50">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                            </div>
                        </div>
                        <div className="text-center">
                            <h3 className="text-lg font-bold text-hui-textMain">Drop files here</h3>
                            <p className="text-sm text-hui-textMuted mt-1">or click Upload to browse your computer</p>
                        </div>
                        <button onClick={() => fileInputRef.current?.click()} className="hui-btn hui-btn-primary">
                            Upload Files
                        </button>
                    </div>
                )}

                {/* Folders */}
                {folders.length > 0 && (
                    <div className="mb-6">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Folders</p>
                        <div className={viewMode === "grid" ? "grid grid-cols-4 gap-3" : "space-y-1"}>
                            {folders.map(folder => (
                                <div
                                    key={folder.id}
                                    onClick={() => navigateToFolder(folder.id, folder.name)}
                                    className={`group cursor-pointer transition-all ${
                                        viewMode === "grid"
                                            ? "bg-white rounded-xl border border-slate-200/80 p-4 hover:shadow-md hover:border-indigo-200"
                                            : "bg-white rounded-lg border border-slate-100 px-4 py-3 hover:bg-slate-50 flex items-center justify-between"
                                    }`}
                                >
                                    <div className={`flex items-center gap-3 ${viewMode === "grid" ? "flex-col text-center" : ""}`}>
                                        <div className={`bg-gradient-to-br from-amber-50 to-orange-50 rounded-lg flex items-center justify-center border border-amber-100/50 group-hover:from-amber-100 group-hover:to-orange-100 transition ${viewMode === "grid" ? "w-12 h-12" : "w-9 h-9"}`}>
                                            <svg width={viewMode === "grid" ? "20" : "16"} viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                                        </div>
                                        <div>
                                            <p className="text-sm font-semibold text-hui-textMain group-hover:text-indigo-600 transition">{folder.name}</p>
                                            <p className="text-[10px] text-slate-400">{folder._count.files} file{folder._count.files !== 1 ? "s" : ""}</p>
                                        </div>
                                    </div>
                                    <button onClick={e => { e.stopPropagation(); handleDeleteFolder(folder.id); }} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition p-1">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Files */}
                {files.length > 0 && (
                    <div>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Files</p>
                        {viewMode === "grid" ? (
                            <div className="grid grid-cols-4 gap-3">
                                {files.map(file => (
                                    <div key={file.id} className="bg-white rounded-xl border border-slate-200/80 overflow-hidden hover:shadow-md transition group">
                                        {/* Preview */}
                                        <div className="h-32 bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center relative">
                                            {isImage(file.mimeType) ? (
                                                <img src={file.url} alt={file.name} className="h-full w-full object-cover cursor-pointer" onClick={() => setPreviewFile(file)} />
                                            ) : (
                                                <span className="text-3xl">{getFileIcon(file.mimeType)}</span>
                                            )}
                                            <button onClick={() => handleDeleteFile(file.id)} className="absolute top-2 right-2 bg-white/90 rounded-full p-1.5 shadow-sm text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                                            </button>
                                        </div>
                                        <div className="p-3">
                                            <a href={file.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-hui-textMain hover:text-indigo-600 truncate block transition">{file.name}</a>
                                            <div className="flex items-center justify-between mt-1">
                                                <span className="text-[10px] text-slate-400">{formatBytes(file.size)}</span>
                                                <span className="text-[10px] text-slate-400">{new Date(file.createdAt).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="bg-white rounded-xl border border-slate-200/80 divide-y divide-slate-100 overflow-hidden">
                                {files.map(file => (
                                    <div key={file.id} className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50/50 transition group">
                                        <div className="w-9 h-9 rounded-lg bg-slate-50 flex items-center justify-center shrink-0 border border-slate-100">
                                            {isImage(file.mimeType) ? (
                                                <img src={file.url} alt="" className="w-9 h-9 rounded-lg object-cover cursor-pointer" onClick={() => setPreviewFile(file)} />
                                            ) : (
                                                <span className="text-base">{getFileIcon(file.mimeType)}</span>
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <a href={file.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-hui-textMain hover:text-indigo-600 truncate block transition">{file.name}</a>
                                            <p className="text-[10px] text-slate-400">{formatBytes(file.size)} · {file.uploadedBy?.name || file.uploadedBy?.email || "Unknown"}</p>
                                        </div>
                                        <span className="text-[10px] text-slate-400 shrink-0">{new Date(file.createdAt).toLocaleDateString()}</span>
                                        <button onClick={() => handleDeleteFile(file.id)} className="text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition p-1">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Image Preview Modal */}
            {previewFile && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-8" onClick={() => setPreviewFile(null)}>
                    <div className="relative max-w-4xl max-h-full" onClick={e => e.stopPropagation()}>
                        <img src={previewFile.url} alt={previewFile.name} className="max-w-full max-h-[80vh] rounded-xl shadow-2xl" />
                        <div className="absolute -top-10 right-0 flex items-center gap-3">
                            <p className="text-white text-sm font-medium">{previewFile.name}</p>
                            <button onClick={() => setPreviewFile(null)} className="text-white/70 hover:text-white transition">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
