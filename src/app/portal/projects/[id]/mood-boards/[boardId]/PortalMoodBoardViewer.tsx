"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
    portalAddMoodBoardItem,
    portalMoveMoodBoardItem,
    portalDeleteMoodBoardItem,
} from "@/lib/actions";
import { isHttpUrl } from "@/lib/url-safety";

interface Item {
    id: string;
    type: string;
    content: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
    addedByClient?: boolean;
}

interface LibraryEntry {
    key: string;
    name: string;
    imageUrl: string;
    price?: number;
}

interface LibraryCategory {
    categoryName: string;
    items: LibraryEntry[];
}

interface Library {
    categories: LibraryCategory[];
    suggestions: LibraryEntry[];
    favorites: LibraryEntry[];
}

export default function PortalMoodBoardViewer({
    boardId,
    projectId,
    items: initialItems,
    isStaff,
    canUpload,
    library,
}: {
    boardId: string;
    projectId: string;
    items: Item[];
    isStaff: boolean;
    canUpload: boolean;
    library: Library;
}) {
    const canvasRef = useRef<HTMLDivElement>(null);
    const photoInputRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<Item[]>(initialItems);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [trayOpen, setTrayOpen] = useState(initialItems.length === 0);
    const [busy, setBusy] = useState(false);
    const [pendingLibraryKeys, setPendingLibraryKeys] = useState<Set<string>>(new Set());
    const [uploadingPhoto, setUploadingPhoto] = useState(false);
    const [swatchColor, setSwatchColor] = useState("#3b82f6");
    const [noteText, setNoteText] = useState("");

    const onBoardImageUrls = new Set(items.filter(i => i.type === "IMAGE").map(i => i.content));
    const isLibraryEmpty = library.categories.length === 0 && library.suggestions.length === 0 && library.favorites.length === 0;

    const updateLocal = (id: string, updates: Partial<Item>) => {
        setItems(prev => prev.map(i => (i.id === id ? { ...i, ...updates } : i)));
    };

    const getNextZIndex = () => Math.max(0, ...items.map(i => i.zIndex)) + 1;

    const centerPosition = (size: number) => {
        const w = canvasRef.current?.clientWidth ?? 500;
        const h = canvasRef.current?.clientHeight ?? 400;
        return { x: Math.max(0, w / 2 - size / 2), y: Math.max(0, h / 2 - size / 2) };
    };

    const commitMove = async (item: Item) => {
        try {
            await portalMoveMoodBoardItem(boardId, item.id, {
                x: Math.round(item.x),
                y: Math.round(item.y),
                width: Math.round(item.width),
                height: Math.round(item.height),
                zIndex: item.zIndex,
            });
        } catch (e: any) {
            toast.error(e.message || "Failed to save position");
        }
    };

    const handleToggleLibraryItem = async (entry: LibraryEntry) => {
        if (pendingLibraryKeys.has(entry.key)) return;
        setPendingLibraryKeys(prev => new Set(prev).add(entry.key));
        try {
            const existing = items.find(i => i.type === "IMAGE" && i.content === entry.imageUrl);
            if (existing) {
                await portalDeleteMoodBoardItem(boardId, existing.id);
                setItems(prev => prev.filter(i => i.id !== existing.id));
                toast.success("Removed from board");
            } else {
                // Deterministic per-add offset so repeated toggles don't stack
                // items exactly on top of each other — no Math.random, so
                // server-side revalidation/re-render doesn't shift positions.
                const offset = (items.length % 5) * 24;
                const { x, y } = centerPosition(240);
                const item = await portalAddMoodBoardItem(boardId, {
                    type: "IMAGE",
                    content: entry.imageUrl,
                    x: x + offset, y: y + offset, width: 240, height: 240,
                });
                setItems(prev => [...prev, item]);
                toast.success("Added to board");
            }
        } catch (e: any) {
            toast.error(e.message || "Failed to update board");
        } finally {
            setPendingLibraryKeys(prev => {
                const next = new Set(prev);
                next.delete(entry.key);
                return next;
            });
        }
    };

    const handleAddSwatch = async () => {
        setBusy(true);
        try {
            const { x, y } = centerPosition(150);
            const item = await portalAddMoodBoardItem(boardId, {
                type: "SWATCH",
                content: swatchColor,
                x, y, width: 150, height: 150,
            });
            setItems(prev => [...prev, item]);
            toast.success("Swatch added");
        } catch (e: any) {
            toast.error(e.message || "Failed to add swatch");
        } finally {
            setBusy(false);
        }
    };

    const handleAddNote = async () => {
        const trimmed = noteText.trim();
        if (!trimmed) {
            toast.error("Write a note first");
            return;
        }
        setBusy(true);
        try {
            const { x, y } = centerPosition(250);
            const item = await portalAddMoodBoardItem(boardId, {
                type: "TEXT",
                content: trimmed,
                x, y, width: 250, height: 100,
            });
            setItems(prev => [...prev, item]);
            setNoteText("");
            toast.success("Note added");
        } catch (e: any) {
            toast.error(e.message || "Failed to add note");
        } finally {
            setBusy(false);
        }
    };

    const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploadingPhoto(true);
        try {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("projectId", projectId);
            const res = await fetch("/api/portal/files", { method: "POST", body: formData });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Upload failed");
            const url = data.file?.url;
            if (!url) throw new Error("Upload did not return a file URL");
            const { x, y } = centerPosition(240);
            const item = await portalAddMoodBoardItem(boardId, {
                type: "IMAGE",
                content: url,
                x, y, width: 240, height: 240,
            });
            setItems(prev => [...prev, item]);
            toast.success("Photo added");
        } catch (e: any) {
            toast.error(e.message || "Failed to upload photo");
        } finally {
            setUploadingPhoto(false);
            if (photoInputRef.current) photoInputRef.current.value = "";
        }
    };

    const handleDelete = async (itemId: string) => {
        try {
            await portalDeleteMoodBoardItem(boardId, itemId);
            setItems(prev => prev.filter(i => i.id !== itemId));
            if (selectedId === itemId) setSelectedId(null);
        } catch (e: any) {
            toast.error(e.message || "Failed to remove item");
        }
    };

    return (
        <div className="w-full h-full flex flex-col">
            <div className="px-4 py-2 text-xs text-slate-500 border-b border-slate-200 bg-white flex items-center justify-between gap-3 shrink-0">
                <span>Drag things around until it feels right — your project team sees this same board.</span>
                <button onClick={() => setTrayOpen(o => !o)} className="hui-btn hui-btn-secondary text-xs shrink-0">
                    {trayOpen ? "Hide tray" : "Add ideas"}
                </button>
            </div>

            <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                <div
                    ref={canvasRef}
                    className="flex-1 relative overflow-auto custom-scrollbar"
                    style={{ backgroundImage: 'radial-gradient(#CBD5E1 1px, transparent 1px)', backgroundSize: '20px 20px' }}
                    onPointerDown={(e) => { if (e.target === canvasRef.current) setSelectedId(null); }}
                >
                    {items.length === 0 && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 p-8 text-center pointer-events-none">
                            <svg className="w-16 h-16 mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            <p>This board is empty — add your first idea from the tray.</p>
                        </div>
                    )}

                    {items.map(item => (
                        <MoodBoardNode
                            key={item.id}
                            item={item}
                            isSelected={selectedId === item.id}
                            canDelete={isStaff || !!item.addedByClient}
                            onSelect={() => setSelectedId(item.id)}
                            onLocalChange={(updates) => updateLocal(item.id, updates)}
                            onCommit={(updates) => commitMove({ ...item, ...updates })}
                            getNextZIndex={getNextZIndex}
                            onDelete={() => handleDelete(item.id)}
                        />
                    ))}
                </div>

                {trayOpen && (
                    <div className="w-full md:w-72 border-t md:border-t-0 md:border-l border-slate-200 bg-white overflow-y-auto p-4 space-y-6 shrink-0 max-h-[45vh] md:max-h-none">
                        <div>
                            <h3 className="text-sm font-semibold text-slate-700">Project library</h3>
                            <p className="text-xs text-slate-400 mb-2">Tap an item to place it on the board — tap again to take it off.</p>
                            {isLibraryEmpty ? (
                                <p className="text-xs text-slate-400">Options your project manager shares on the Selections tab will appear here.</p>
                            ) : (
                                <div className="space-y-4">
                                    {library.categories.map((cat, idx) => (
                                        <div key={`${idx}-${cat.categoryName}`}>
                                            <h4 className="text-xs font-semibold text-slate-500 mb-2">{cat.categoryName}</h4>
                                            <div className="grid grid-cols-3 gap-2">
                                                {cat.items.map(entry => (
                                                    <LibraryTile
                                                        key={entry.key}
                                                        entry={entry}
                                                        isOnBoard={onBoardImageUrls.has(entry.imageUrl)}
                                                        isPending={pendingLibraryKeys.has(entry.key)}
                                                        onToggle={() => handleToggleLibraryItem(entry)}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    ))}

                                    {library.suggestions.length > 0 && (
                                        <div>
                                            <h4 className="text-xs font-semibold text-slate-500 mb-2">Your suggestions</h4>
                                            <div className="grid grid-cols-3 gap-2">
                                                {library.suggestions.map(entry => (
                                                    <LibraryTile
                                                        key={entry.key}
                                                        entry={entry}
                                                        isOnBoard={onBoardImageUrls.has(entry.imageUrl)}
                                                        isPending={pendingLibraryKeys.has(entry.key)}
                                                        onToggle={() => handleToggleLibraryItem(entry)}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {library.favorites.length > 0 && (
                                        <div>
                                            <h4 className="text-xs font-semibold text-slate-500 mb-2">Team favorites</h4>
                                            <div className="grid grid-cols-3 gap-2">
                                                {library.favorites.map(entry => (
                                                    <LibraryTile
                                                        key={entry.key}
                                                        entry={entry}
                                                        isOnBoard={onBoardImageUrls.has(entry.imageUrl)}
                                                        isPending={pendingLibraryKeys.has(entry.key)}
                                                        onToggle={() => handleToggleLibraryItem(entry)}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div>
                            <h3 className="text-sm font-semibold text-slate-700 mb-2">Color swatch</h3>
                            <div className="flex items-center gap-2">
                                <input
                                    type="color"
                                    value={swatchColor}
                                    onChange={(e) => setSwatchColor(e.target.value)}
                                    className="w-10 h-10 rounded border border-slate-200 cursor-pointer"
                                />
                                <span className="text-xs font-mono text-slate-500">{swatchColor}</span>
                            </div>
                            <button onClick={handleAddSwatch} disabled={busy} className="hui-btn hui-btn-secondary text-xs mt-2 w-full">
                                Add swatch
                            </button>
                        </div>

                        <div>
                            <h3 className="text-sm font-semibold text-slate-700 mb-2">Note</h3>
                            <textarea
                                value={noteText}
                                onChange={(e) => setNoteText(e.target.value)}
                                maxLength={500}
                                rows={3}
                                placeholder="Jot down an idea..."
                                className="hui-input w-full text-sm resize-none"
                            />
                            <button onClick={handleAddNote} disabled={busy} className="hui-btn hui-btn-secondary text-xs mt-2 w-full">
                                Add note
                            </button>
                        </div>

                        {canUpload && (
                            <div>
                                <h3 className="text-sm font-semibold text-slate-700 mb-2">Photo</h3>
                                <input
                                    ref={photoInputRef}
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={handlePhotoChange}
                                />
                                <button
                                    onClick={() => photoInputRef.current?.click()}
                                    disabled={uploadingPhoto}
                                    className="hui-btn hui-btn-secondary text-xs w-full"
                                >
                                    {uploadingPhoto ? "Uploading..." : "Upload a photo"}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function LibraryTile({
    entry,
    isOnBoard,
    isPending,
    onToggle,
}: {
    entry: LibraryEntry;
    isOnBoard: boolean;
    isPending: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            onClick={onToggle}
            disabled={isPending}
            title={entry.name}
            className={`relative rounded-md overflow-hidden border transition disabled:opacity-50 ${
                isOnBoard ? "border-green-500 ring-2 ring-green-200" : "border-slate-200 hover:border-hui-primary"
            }`}
        >
            <div className="aspect-square w-full overflow-hidden bg-slate-100">
                <img src={entry.imageUrl} alt={entry.name} className="w-full h-full object-cover" />
            </div>
            <div className="px-1 py-1 bg-white text-left">
                <p className="text-[11px] text-slate-600 truncate">{entry.name}</p>
                {entry.price != null && (
                    <p className="text-[11px] text-hui-primary font-medium">+${Math.round(entry.price).toLocaleString()}</p>
                )}
            </div>

            {isOnBoard && !isPending && (
                <span className="absolute top-1 right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center text-white text-[10px] shadow">
                    ✓
                </span>
            )}

            {isPending && (
                <span className="absolute inset-0 bg-white/70 flex items-center justify-center">
                    <span className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
                </span>
            )}
        </button>
    );
}

function MoodBoardNode({
    item,
    isSelected,
    canDelete,
    onSelect,
    onLocalChange,
    onCommit,
    getNextZIndex,
    onDelete,
}: {
    item: Item;
    isSelected: boolean;
    canDelete: boolean;
    onSelect: () => void;
    onLocalChange: (updates: Partial<Item>) => void;
    onCommit: (updates: Partial<Item>) => void;
    getNextZIndex: () => number;
    onDelete: () => void;
}) {
    // Final values are tracked in a local variable (not read back from React
    // state) so the eventual onCommit always reflects exactly what the user
    // dragged/resized to — the pointerdown handler's closure over `item` is
    // fixed at drag-start and would otherwise go stale across the many
    // re-renders a drag triggers.
    const handlePointerDownMove = (e: React.PointerEvent) => {
        e.stopPropagation();
        onSelect();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = item.x;
        const origY = item.y;
        const newZ = getNextZIndex();
        let latest: Partial<Item> = { x: origX, y: origY, width: item.width, height: item.height, zIndex: newZ };

        const onMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            latest = { ...latest, x: Math.max(0, origX + dx), y: Math.max(0, origY + dy) };
            onLocalChange(latest);
        };
        const onUp = (upEvent: PointerEvent) => {
            el.releasePointerCapture(upEvent.pointerId);
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onUp);
            onCommit(latest);
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        // pointercancel fires instead of pointerup when the browser aborts the
        // gesture mid-drag (e.g. an OS gesture takes over, or a touch is
        // interrupted) — without handling it the drag state (and pointer
        // capture) is left dangling and the item never gets its commit.
        el.addEventListener("pointercancel", onUp);
    };

    const handlePointerDownResize = (e: React.PointerEvent) => {
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        const origWidth = item.width;
        const origHeight = item.height;
        let latest: Partial<Item> = { x: item.x, y: item.y, width: origWidth, height: origHeight, zIndex: item.zIndex };

        const onMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            latest = { ...latest, width: Math.max(40, origWidth + dx), height: Math.max(40, origHeight + dy) };
            onLocalChange(latest);
        };
        const onUp = (upEvent: PointerEvent) => {
            el.releasePointerCapture(upEvent.pointerId);
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onUp);
            onCommit(latest);
        };
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        // See handlePointerDownMove above — pointercancel must be treated the
        // same as pointerup so an aborted resize gesture doesn't leave drag
        // state dangling.
        el.addEventListener("pointercancel", onUp);
    };

    return (
        <div
            onPointerDown={handlePointerDownMove}
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            style={{
                position: "absolute",
                left: item.x,
                top: item.y,
                width: item.width,
                height: item.height,
                zIndex: item.zIndex,
                touchAction: "none",
                cursor: "move",
            }}
            className={`group ${isSelected ? "ring-2 ring-hui-primary ring-offset-2" : ""}`}
        >
            {item.type === "IMAGE" && (
                isHttpUrl(item.content) ? (
                    <img src={item.content} alt="Mood board item" className="w-full h-full object-contain pointer-events-none" draggable={false} />
                ) : (
                    // Defense in depth for legacy rows that predate the
                    // server-side isHttpUrl validation in
                    // portalAddMoodBoardItem — never hand a non-http(s)
                    // string straight to <img src>.
                    <div className="w-full h-full flex items-center justify-center bg-slate-100 border border-slate-200 rounded-lg pointer-events-none text-slate-300">
                        <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </div>
                )
            )}

            {item.type === "TEXT" && (
                <div className="w-full h-full p-4 bg-white/80 backdrop-blur shadow-sm border border-slate-200 text-slate-800 text-lg flex items-center justify-center text-center overflow-hidden break-words pointer-events-none rounded-lg">
                    {item.content}
                </div>
            )}

            {item.type === "SWATCH" && (
                <div className="w-full h-full shadow-sm rounded-lg flex flex-col overflow-hidden pointer-events-none border border-slate-200">
                    <div className="flex-1" style={{ backgroundColor: item.content }} />
                    <div className="h-8 bg-white flex items-center justify-center text-xs font-mono text-slate-600">
                        {item.content}
                    </div>
                </div>
            )}

            {isSelected && (
                <div
                    onPointerDown={handlePointerDownResize}
                    style={{ touchAction: "none" }}
                    className="absolute -bottom-2 -right-2 w-5 h-5 bg-hui-primary border-2 border-white rounded-full cursor-nwse-resize z-50 shadow-md"
                />
            )}

            {isSelected && canDelete && (
                <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    title="Remove"
                    className="absolute -top-2 -right-2 w-5 h-5 bg-white border border-slate-300 rounded-full flex items-center justify-center text-slate-500 hover:text-red-600 hover:border-red-300 shadow-sm z-50 text-xs leading-none"
                >
                    ✕
                </button>
            )}
        </div>
    );
}
