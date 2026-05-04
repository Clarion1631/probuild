"use client";

import { useState, useCallback, useEffect } from "react";

type FileRecord = {
    id: string;
    name: string;
    url: string;
    size: number;
    mimeType: string;
    createdAt: string;
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
    if (mime.startsWith("image/")) return "\u{1F5BC}️";
    if (mime.includes("pdf")) return "\u{1F4C4}";
    if (mime.includes("word") || mime.includes("document")) return "\u{1F4DD}";
    if (mime.includes("sheet") || mime.includes("excel")) return "\u{1F4CA}";
    if (mime.includes("video")) return "\u{1F3AC}";
    return "\u{1F4CE}";
}

export default function PortalFileBrowser({ projectId }: { projectId: string }) {
    const [folders, setFolders] = useState<FolderRecord[]>([]);
    const [files, setFiles] = useState<FileRecord[]>([]);
    const [currentFolder, setCurrentFolder] = useState<string | null>(null);
    const [folderPath, setFolderPath] = useState<{ id: string | null; name: string }[]>([{ id: null, name: "All Files" }]);
    const [viewMode, setViewMode] = useState<"grid" | "list">("list");
    const [previewFile, setPreviewFile] = useState<FileRecord | null>(null);
    const [loaded, setLoaded] = useState(false);

    const fetchFiles = useCallback(async (folderId: string | null = currentFolder) => {
        const params = new URLSearchParams({ projectId });
        if (folderId) params.set("folderId", folderId);

        const res = await fetch(`/api/portal/files?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        setFolders(data.folders || []);
        setFiles(data.files || []);
        setLoaded(true);
    }, [projectId, currentFolder]);

    useEffect(() => { fetchFiles(null); }, []);

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

    const isEmpty = folders.length === 0 && files.length === 0;

    return (
        <div className="flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-indigo-500 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/25">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-hui-textMain">Files & Documents</h2>
                        <p className="text-sm text-hui-textMuted">{files.length} file{files.length !== 1 ? "s" : ""}</p>
                    </div>
                </div>
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                    <button onClick={() => setViewMode("grid")} className={`p-1.5 rounded-md transition ${viewMode === "grid" ? "bg-white shadow-sm" : "text-slate-400 hover:text-slate-600"}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    </button>
                    <button onClick={() => setViewMode("list")} className={`p-1.5 rounded-md transition ${viewMode === "list" ? "bg-white shadow-sm" : "text-slate-400 hover:text-slate-600"}`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                    </button>
                </div>
            </div>

            {/* Breadcrumb */}
            <div className="flex items-center gap-1.5 mb-5">
                {folderPath.map((crumb, i) => (
                    <div key={crumb.id || "root"} className="flex items-center gap-1.5">
                        {i > 0 && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M9 5l7 7-7 7"/></svg>}
                        <button
                            onClick={() => navigateToFolder(crumb.id, crumb.name)}
                            className={`text-xs font-medium transition ${i === folderPath.length - 1 ? "text-hui-textMain font-semibold" : "text-blue-600 hover:text-blue-800"}`}
                        >
                            {crumb.name}
                        </button>
                    </div>
                ))}
            </div>

            {/* Empty State */}
            {isEmpty && loaded && (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    </div>
                    <p className="text-sm text-hui-textMuted">No shared files available yet.</p>
                </div>
            )}

            {/* Folders */}
            {folders.length > 0 && (
                <div className="mb-6">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Folders</p>
                    <div className={viewMode === "grid" ? "grid grid-cols-3 gap-3" : "space-y-1"}>
                        {folders.map(folder => (
                            <div
                                key={folder.id}
                                onClick={() => navigateToFolder(folder.id, folder.name)}
                                className="group cursor-pointer bg-white rounded-lg border border-slate-200 px-4 py-3 hover:bg-slate-50 hover:border-blue-200 flex items-center gap-3 transition"
                            >
                                <div className="w-9 h-9 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg flex items-center justify-center border border-blue-100/50 shrink-0">
                                    <svg width="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-hui-textMain group-hover:text-blue-600 transition">{folder.name}</p>
                                    <p className="text-[10px] text-slate-400">{folder._count.files} file{folder._count.files !== 1 ? "s" : ""}</p>
                                </div>
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
                        <div className="grid grid-cols-3 gap-3">
                            {files.map(file => (
                                <div key={file.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition">
                                    <div className="h-28 bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center">
                                        {isImage(file.mimeType) ? (
                                            <img src={file.url} alt={file.name} className="h-full w-full object-cover cursor-pointer" onClick={() => setPreviewFile(file)} />
                                        ) : (
                                            <span className="text-3xl">{getFileIcon(file.mimeType)}</span>
                                        )}
                                    </div>
                                    <div className="p-3">
                                        <a href={file.url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-hui-textMain hover:text-blue-600 truncate block transition">{file.name}</a>
                                        <div className="flex items-center justify-between mt-1">
                                            <span className="text-[10px] text-slate-400">{formatBytes(file.size)}</span>
                                            <span className="text-[10px] text-slate-400">{new Date(file.createdAt).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                            {files.map(file => (
                                <div key={file.id} className="px-4 py-3 flex items-center gap-3 hover:bg-slate-50/50 transition">
                                    <div className="w-9 h-9 rounded-lg bg-slate-50 flex items-center justify-center shrink-0 border border-slate-100">
                                        {isImage(file.mimeType) ? (
                                            <img src={file.url} alt="" className="w-9 h-9 rounded-lg object-cover cursor-pointer" onClick={() => setPreviewFile(file)} />
                                        ) : (
                                            <span className="text-base">{getFileIcon(file.mimeType)}</span>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <a href={file.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-hui-textMain hover:text-blue-600 truncate block transition">{file.name}</a>
                                        <p className="text-[10px] text-slate-400">{formatBytes(file.size)}</p>
                                    </div>
                                    <span className="text-[10px] text-slate-400 shrink-0">{new Date(file.createdAt).toLocaleDateString()}</span>
                                    <a href={file.url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-blue-600 transition p-1" title="Download">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                                    </a>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

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
