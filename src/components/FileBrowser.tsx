"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { toast } from "sonner";
import {
    DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
    DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub,
    DropdownMenuSubTrigger, DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";

type FileRecord = {
    id: string;
    name: string;
    url: string;
    size: number;
    mimeType: string;
    createdAt: string;
    visibility?: string | null;
    effectiveVisibility?: string;
    uploadedBy?: { id: string; name: string | null; email: string } | null;
};

type FolderRecord = {
    id: string;
    name: string;
    visibility?: string;
    _count: { files: number; children: number };
};

type VisibilityTab = "all" | "shared" | "financial";

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
    if (mime.startsWith("image/")) return "\u{1F5BC}️";
    if (mime.includes("pdf")) return "\u{1F4C4}";
    if (mime.includes("word") || mime.includes("document")) return "\u{1F4DD}";
    if (mime.includes("sheet") || mime.includes("excel")) return "\u{1F4CA}";
    if (mime.includes("video")) return "\u{1F3AC}";
    if (mime.includes("zip") || mime.includes("rar") || mime.includes("archive")) return "\u{1F4E6}";
    return "\u{1F4CE}";
}

function VisibilityBadge({ visibility, inherited }: { visibility: string; inherited?: boolean }) {
    if (visibility === "team") return null;
    const isShared = visibility === "shared";
    return (
        <span className={`inline-flex items-center text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${
            isShared
                ? inherited ? "text-blue-500 border border-blue-200 bg-blue-50/50" : "text-blue-600 bg-blue-100"
                : inherited ? "text-amber-500 border border-amber-200 bg-amber-50/50" : "text-amber-600 bg-amber-100"
        }`}>
            {isShared ? "Shared" : "Financial"}
        </span>
    );
}

const HOVER_REVEAL = "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition";

export default function FileBrowser({
    projectId,
    leadId,
    canSeeFinancial = false,
    showVisibilityTabs = false,
}: {
    projectId?: string;
    leadId?: string;
    canSeeFinancial?: boolean;
    showVisibilityTabs?: boolean;
}) {
    const [folders, setFolders] = useState<FolderRecord[]>([]);
    const [files, setFiles] = useState<FileRecord[]>([]);
    const [currentFolder, setCurrentFolder] = useState<string | null>(null);
    const [folderPath, setFolderPath] = useState<{ id: string | null; name: string }[]>([{ id: null, name: "All Files" }]);
    const [isUploading, setIsUploading] = useState(false);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [showNewFolder, setShowNewFolder] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [viewMode, setViewMode] = useState<"grid" | "list">("list");
    const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
    const [moveFileId, setMoveFileId] = useState<string | null>(null);
    const [allFolders, setAllFolders] = useState<FolderRecord[]>([]);
    const [activeTab, setActiveTab] = useState<VisibilityTab>("all");
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
    const [renameFolderValue, setRenameFolderValue] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [loaded, setLoaded] = useState(false);

    const fetchFiles = useCallback(async (folderId: string | null = currentFolder) => {
        const params = new URLSearchParams();
        if (projectId) params.set("projectId", projectId);
        if (leadId) params.set("leadId", leadId);
        if (folderId) params.set("folderId", folderId);
        if (activeTab !== "all") params.set("visibility", activeTab);

        const res = await fetch(`/api/files?${params}`);
        const data = await res.json();
        setFolders(data.folders || []);
        setFiles(data.files || []);
        setLoaded(true);
    }, [projectId, leadId, currentFolder, activeTab]);

    useEffect(() => { fetchFiles(null); }, []);
    useEffect(() => { fetchFiles(currentFolder); }, [activeTab]);

    function getUploadVisibility(): string | undefined {
        if (activeTab === "shared") return "shared";
        if (activeTab === "financial") return "financial";
        return undefined;
    }

    async function handleUpload(fileList: FileList | null) {
        if (!fileList || fileList.length === 0) return;
        setIsUploading(true);
        try {
            const fileArray = Array.from(fileList);
            const visibility = getUploadVisibility();

            const signRes = await fetch("/api/files/signed-upload", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectId,
                    leadId,
                    folderId: currentFolder,
                    visibility,
                    files: fileArray.map(f => ({ name: f.name, size: f.size, mimeType: f.type || "application/octet-stream" })),
                }),
            });
            const signData = await signRes.json();
            if (!signRes.ok) {
                toast.error(signData.error || `Upload failed (${signRes.status})`);
                return;
            }

            const uploadResults = await Promise.all(
                signData.uploads.map((upload: any, i: number) =>
                    fetch(upload.signedUrl, {
                        method: "PUT",
                        headers: {
                            "Content-Type": fileArray[i].type || "application/octet-stream",
                            "x-upsert": "false",
                        },
                        body: fileArray[i],
                    })
                )
            );
            for (let i = 0; i < uploadResults.length; i++) {
                const r = uploadResults[i];
                if (!r.ok) {
                    let msg = `Storage upload failed (${r.status})`;
                    try { const t = await r.text(); if (t) msg = t; } catch {}
                    throw new Error(msg);
                }
            }

            const regRes = await fetch("/api/files/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    files: signData.uploads.map((upload: any) => ({
                        name: upload.name,
                        url: upload.publicUrl,
                        size: upload.size,
                        mimeType: upload.mimeType,
                        projectId: upload.projectId,
                        leadId: upload.leadId,
                        folderId: upload.folderId,
                        visibility: upload.visibility,
                    })),
                }),
            });
            const regData = await regRes.json();
            if (!regRes.ok) {
                toast.error(regData.error || `Failed to save file records (${regRes.status})`);
                return;
            }
            setFiles(prev => [...regData.files, ...prev]);
            toast.success(`${regData.files.length} file${regData.files.length > 1 ? "s" : ""} uploaded`);
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
            const visibility = getUploadVisibility();
            const res = await fetch("/api/files/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: newFolderName.trim(),
                    projectId,
                    leadId,
                    parentId: currentFolder,
                    ...(visibility && { visibility }),
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
        if (!confirm("Delete this file?")) return;
        try {
            await fetch(`/api/files?fileId=${fileId}`, { method: "DELETE" });
            setFiles(prev => prev.filter(f => f.id !== fileId));
            toast.success("File deleted");
        } catch { toast.error("Delete failed"); }
    }

    async function handleDeleteFolder(folderId: string) {
        if (!confirm("Delete this folder and all its contents?")) return;
        try {
            await fetch(`/api/files?folderId=${folderId}`, { method: "DELETE" });
            setFolders(prev => prev.filter(f => f.id !== folderId));
            toast.success("Folder deleted");
        } catch { toast.error("Delete failed"); }
    }

    async function handleRenameFile(fileId: string, newName: string) {
        if (!newName.trim() || newName === files.find(f => f.id === fileId)?.name) {
            setRenamingId(null);
            return;
        }
        try {
            const res = await fetch("/api/files", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileId, name: newName.trim() }),
            });
            if (!res.ok) { toast.error("Rename failed"); return; }
            const updated = await res.json();
            setFiles(prev => prev.map(f => f.id === fileId ? { ...f, ...updated } : f));
            toast.success("File renamed");
        } catch { toast.error("Rename failed"); }
        setRenamingId(null);
    }

    async function handleRenameFolder(folderId: string, newName: string) {
        if (!newName.trim() || newName === folders.find(f => f.id === folderId)?.name) {
            setRenamingFolderId(null);
            return;
        }
        try {
            const res = await fetch("/api/files/folders", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: folderId, name: newName.trim() }),
            });
            if (!res.ok) { toast.error("Rename failed"); return; }
            const updated = await res.json();
            setFolders(prev => prev.map(f => f.id === folderId ? { ...f, ...updated } : f));
            toast.success("Folder renamed");
        } catch { toast.error("Rename failed"); }
        setRenamingFolderId(null);
    }

    async function handleSetFileVisibility(fileId: string, visibility: string | null) {
        try {
            const res = await fetch("/api/files", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileId, visibility }),
            });
            if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); return; }
            const updated = await res.json();
            setFiles(prev => prev.map(f => f.id === fileId ? { ...f, ...updated } : f));
            const label = visibility === "shared" ? "Shared with client" : visibility === "financial" ? "Financial (internal)" : "Team only";
            toast.success(`File set to: ${label}`);
        } catch { toast.error("Failed to update visibility"); }
    }

    async function handleSetFolderVisibility(folderId: string, visibility: string) {
        try {
            const res = await fetch("/api/files/folders", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: folderId, visibility }),
            });
            if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); return; }
            const updated = await res.json();
            setFolders(prev => prev.map(f => f.id === folderId ? { ...f, ...updated } : f));
            const label = visibility === "shared" ? "Shared" : visibility === "financial" ? "Financial" : "Team";
            toast.success(`Folder set to ${label} — files inside will inherit this unless individually overridden`);
        } catch { toast.error("Failed to update visibility"); }
    }

    async function openMoveModal(fileId: string) {
        setMoveFileId(fileId);
        const params = new URLSearchParams();
        if (projectId) params.set("projectId", projectId);
        if (leadId) params.set("leadId", leadId);
        params.set("allFolders", "true");
        const res = await fetch(`/api/files/folders?${params}`);
        if (res.ok) {
            const data = await res.json();
            setAllFolders(data);
        }
    }

    async function handleMoveFile(targetFolderId: string | null) {
        if (!moveFileId) return;
        try {
            const res = await fetch("/api/files", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileId: moveFileId, folderId: targetFolderId }),
            });
            if (!res.ok) { const d = await res.json(); toast.error(d.error || "Move failed"); return; }
            setFiles(prev => prev.filter(f => f.id !== moveFileId));
            toast.success("File moved");
        } catch { toast.error("Move failed"); }
        setMoveFileId(null);
    }

    function navigateToFolder(folderId: string | null, folderName: string) {
        if (folderId === currentFolder) return;
        if (folderId === null) {
            setFolderPath([{ id: null, name: "All Files" }]);
        } else {
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

    function startRenameFile(file: FileRecord) {
        setRenamingId(file.id);
        setRenameValue(file.name);
    }

    function startRenameFolder(folder: FolderRecord) {
        setRenamingFolderId(folder.id);
        setRenameFolderValue(folder.name);
    }

    const isEmpty = folders.length === 0 && files.length === 0;

    // --- File context menu ---
    function FileContextMenu({ file }: { file: FileRecord }) {
        const effVis = file.effectiveVisibility || "team";
        const isInherited = !file.visibility;
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        className={`p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition ${HOVER_REVEAL}`}
                        onClick={e => e.stopPropagation()}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => startRenameFile(file)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openMoveModal(file.id)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                        Move to Folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => window.open(file.url, "_blank")}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                        Download
                    </DropdownMenuItem>
                    {showVisibilityTabs && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                    Visibility{isInherited ? " (inherited)" : ""}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-48">
                                    <DropdownMenuItem onClick={() => handleSetFileVisibility(file.id, null)}>
                                        {isInherited && <span className="mr-1.5 text-indigo-600">&#10003;</span>}
                                        Inherit from folder
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSetFileVisibility(file.id, "team")}>
                                        {!isInherited && effVis === "team" && <span className="mr-1.5 text-indigo-600">&#10003;</span>}
                                        Team Only
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSetFileVisibility(file.id, "shared")}>
                                        {!isInherited && effVis === "shared" && <span className="mr-1.5 text-blue-600">&#10003;</span>}
                                        <span className="text-blue-600">Share with Client</span>
                                    </DropdownMenuItem>
                                    {canSeeFinancial && (
                                        <DropdownMenuItem onClick={() => handleSetFileVisibility(file.id, "financial")}>
                                            {!isInherited && effVis === "financial" && <span className="mr-1.5 text-amber-600">&#10003;</span>}
                                            <span className="text-amber-600">Financial Only</span>
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => handleDeleteFile(file.id)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        Delete
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    // --- Folder context menu ---
    function FolderContextMenu({ folder }: { folder: FolderRecord }) {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        className={`p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition ${HOVER_REVEAL}`}
                        onClick={e => e.stopPropagation()}
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => startRenameFolder(folder)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        Rename
                    </DropdownMenuItem>
                    {showVisibilityTabs && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                    Visibility
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="w-48">
                                    <DropdownMenuItem onClick={() => handleSetFolderVisibility(folder.id, "team")}>
                                        {(folder.visibility || "team") === "team" && <span className="mr-1.5 text-indigo-600">&#10003;</span>}
                                        Team Only
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleSetFolderVisibility(folder.id, "shared")}>
                                        {folder.visibility === "shared" && <span className="mr-1.5 text-blue-600">&#10003;</span>}
                                        <span className="text-blue-600">Share with Client</span>
                                    </DropdownMenuItem>
                                    {canSeeFinancial && (
                                        <DropdownMenuItem onClick={() => handleSetFolderVisibility(folder.id, "financial")}>
                                            {folder.visibility === "financial" && <span className="mr-1.5 text-amber-600">&#10003;</span>}
                                            <span className="text-amber-600">Financial Only</span>
                                        </DropdownMenuItem>
                                    )}
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => handleDeleteFolder(folder.id)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        Delete
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    // --- Inline file name (rename or link) ---
    function FileName({ file, className }: { file: FileRecord; className?: string }) {
        if (renamingId === file.id) {
            return (
                <input
                    autoFocus
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") handleRenameFile(file.id, renameValue);
                        if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => handleRenameFile(file.id, renameValue)}
                    className="hui-input text-xs py-0.5 px-1 w-full"
                    onClick={e => e.stopPropagation()}
                />
            );
        }
        return (
            <a href={file.url} target="_blank" rel="noreferrer" className={className}>
                {file.name}
            </a>
        );
    }

    // --- Inline folder name (rename or text) ---
    function FolderName({ folder, className }: { folder: FolderRecord; className?: string }) {
        if (renamingFolderId === folder.id) {
            return (
                <input
                    autoFocus
                    type="text"
                    value={renameFolderValue}
                    onChange={e => setRenameFolderValue(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") handleRenameFolder(folder.id, renameFolderValue);
                        if (e.key === "Escape") setRenamingFolderId(null);
                    }}
                    onBlur={() => handleRenameFolder(folder.id, renameFolderValue)}
                    className="hui-input text-xs py-0.5 px-1 w-full"
                    onClick={e => e.stopPropagation()}
                />
            );
        }
        return <p className={className}>{folder.name}</p>;
    }

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

            {/* Visibility Tabs */}
            {showVisibilityTabs && (
                <div className="flex items-center gap-1 mb-4 border-b border-slate-200">
                    <button
                        onClick={() => setActiveTab("all")}
                        className={`px-3 py-2 text-xs font-medium border-b-2 transition ${activeTab === "all" ? "border-indigo-600 text-indigo-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
                    >
                        All Files
                    </button>
                    <button
                        onClick={() => setActiveTab("shared")}
                        className={`px-3 py-2 text-xs font-medium border-b-2 transition ${activeTab === "shared" ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
                    >
                        Shared with Client
                    </button>
                    {canSeeFinancial && (
                        <button
                            onClick={() => setActiveTab("financial")}
                            className={`px-3 py-2 text-xs font-medium border-b-2 transition ${activeTab === "financial" ? "border-amber-600 text-amber-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
                        >
                            Financial (Internal)
                        </button>
                    )}
                </div>
            )}

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
                            <h3 className="text-lg font-bold text-hui-textMain">
                                {activeTab === "shared" ? "No shared files" : activeTab === "financial" ? "No financial files" : "Drop files here"}
                            </h3>
                            <p className="text-sm text-hui-textMuted mt-1">
                                {activeTab === "shared" ? "Mark files as 'Shared' to make them visible in the client portal" : activeTab === "financial" ? "Mark files as 'Financial' to restrict access to finance team" : "or click Upload to browse your computer"}
                            </p>
                        </div>
                        {activeTab === "all" && (
                            <button onClick={() => fileInputRef.current?.click()} className="hui-btn hui-btn-primary">
                                Upload Files
                            </button>
                        )}
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
                                    onClick={() => renamingFolderId !== folder.id && navigateToFolder(folder.id, folder.name)}
                                    className={`group cursor-pointer transition-all ${
                                        viewMode === "grid"
                                            ? "bg-white rounded-xl border border-slate-200/80 p-4 hover:shadow-md hover:border-indigo-200"
                                            : "bg-white rounded-lg border border-slate-100 px-4 py-3 hover:bg-slate-50 flex items-center justify-between"
                                    }`}
                                >
                                    <div className={`flex items-center gap-3 min-w-0 ${viewMode === "grid" ? "flex-col text-center" : "flex-1"}`}>
                                        <div className={`bg-gradient-to-br from-amber-50 to-orange-50 rounded-lg flex items-center justify-center border border-amber-100/50 group-hover:from-amber-100 group-hover:to-orange-100 transition shrink-0 ${viewMode === "grid" ? "w-12 h-12" : "w-9 h-9"}`}>
                                            <svg width={viewMode === "grid" ? "20" : "16"} viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                                        </div>
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <FolderName folder={folder} className="text-sm font-semibold text-hui-textMain group-hover:text-indigo-600 transition truncate" />
                                                {folder.visibility && <VisibilityBadge visibility={folder.visibility} />}
                                            </div>
                                            <p className="text-[10px] text-slate-400">{folder._count.files} file{folder._count.files !== 1 ? "s" : ""}</p>
                                        </div>
                                    </div>
                                    <FolderContextMenu folder={folder} />
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
                                {files.map(file => {
                                    const effVis = file.effectiveVisibility || "team";
                                    const isInherited = !file.visibility;
                                    return (
                                        <div key={file.id} className="bg-white rounded-xl border border-slate-200/80 overflow-hidden hover:shadow-md transition group">
                                            <div className="h-32 bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center relative">
                                                {isImage(file.mimeType) ? (
                                                    <img src={file.url} alt={file.name} className="h-full w-full object-cover cursor-pointer" onClick={() => setPreviewFile(file)} />
                                                ) : (
                                                    <span className="text-3xl">{getFileIcon(file.mimeType)}</span>
                                                )}
                                                <div className="absolute top-2 right-2">
                                                    <FileContextMenu file={file} />
                                                </div>
                                            </div>
                                            <div className="p-3">
                                                <div className="flex items-center gap-1.5">
                                                    <FileName file={file} className="text-xs font-semibold text-hui-textMain hover:text-indigo-600 truncate block transition flex-1 min-w-0" />
                                                    {showVisibilityTabs && <VisibilityBadge visibility={effVis} inherited={isInherited} />}
                                                </div>
                                                <div className="flex items-center justify-between mt-1">
                                                    <span className="text-[10px] text-slate-400">{formatBytes(file.size)}</span>
                                                    <span className="text-[10px] text-slate-400">{new Date(file.createdAt).toLocaleDateString()}</span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="bg-white rounded-xl border border-slate-200/80 divide-y divide-slate-100 overflow-hidden">
                                {files.map(file => {
                                    const effVis = file.effectiveVisibility || "team";
                                    const isInherited = !file.visibility;
                                    return (
                                        <div key={file.id} className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50/50 transition group">
                                            <div className="w-9 h-9 rounded-lg bg-slate-50 flex items-center justify-center shrink-0 border border-slate-100">
                                                {isImage(file.mimeType) ? (
                                                    <img src={file.url} alt="" className="w-9 h-9 rounded-lg object-cover cursor-pointer" onClick={() => setPreviewFile(file)} />
                                                ) : (
                                                    <span className="text-base">{getFileIcon(file.mimeType)}</span>
                                                )}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <FileName file={file} className="text-sm font-medium text-hui-textMain hover:text-indigo-600 truncate block transition" />
                                                    {showVisibilityTabs && <VisibilityBadge visibility={effVis} inherited={isInherited} />}
                                                </div>
                                                <p className="text-[10px] text-slate-400">{formatBytes(file.size)} · {file.uploadedBy?.name || file.uploadedBy?.email || "Unknown"}</p>
                                            </div>
                                            <span className="text-[10px] text-slate-400 shrink-0">{new Date(file.createdAt).toLocaleDateString()}</span>
                                            <FileContextMenu file={file} />
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Move to Folder Modal */}
            {moveFileId && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setMoveFileId(null)}>
                    <div className="bg-white rounded-2xl shadow-2xl w-96 max-h-[60vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
                            <h3 className="font-bold text-hui-textMain">Move to Folder</h3>
                            <button onClick={() => setMoveFileId(null)} className="text-slate-400 hover:text-slate-600 transition">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3">
                            <button
                                onClick={() => handleMoveFile(null)}
                                className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition text-left"
                            >
                                <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
                                </div>
                                <div>
                                    <p className="text-sm font-medium text-hui-textMain">Root / All Files</p>
                                    <p className="text-[10px] text-slate-400">No folder</p>
                                </div>
                            </button>
                            {allFolders.map(folder => (
                                <button
                                    key={folder.id}
                                    onClick={() => handleMoveFile(folder.id)}
                                    className={`w-full flex items-center gap-3 p-3 rounded-xl hover:bg-amber-50 transition text-left ${folder.id === currentFolder ? "bg-amber-50 ring-1 ring-amber-200" : ""}`}
                                >
                                    <div className="w-9 h-9 bg-gradient-to-br from-amber-50 to-orange-50 rounded-lg flex items-center justify-center border border-amber-100/50">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium text-hui-textMain">{folder.name}</p>
                                        <p className="text-[10px] text-slate-400">{folder._count.files} file{folder._count.files !== 1 ? "s" : ""}</p>
                                    </div>
                                </button>
                            ))}
                            {allFolders.length === 0 && (
                                <p className="text-sm text-slate-400 text-center py-6">No folders yet. Create one first!</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

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
