"use client";

import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { saveMoodBoardItems } from "@/lib/actions";

interface Item {
    id: string; // "temp-..." if unsaved
    type: string;
    content: string;
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex: number;
}

export default function MoodBoardEditor({ board }: { board: any }) {
    const canvasRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<Item[]>(board.items || []);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Click outside to deselect
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (canvasRef.current && e.target === canvasRef.current) {
                setSelectedId(null);
            }
        };
        window.addEventListener("mousedown", handleClick);
        return () => window.removeEventListener("mousedown", handleClick);
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            await saveMoodBoardItems(board.id, items);
            toast.success("Mood board saved!");
        } catch (e: any) {
            toast.error(e.message || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const addText = () => {
        const text = prompt("Enter text:");
        if (!text) return;
        const maxZ = Math.max(0, ...items.map(i => i.zIndex));
        setItems([...items, {
            id: `temp-${Date.now()}`,
            type: "TEXT",
            content: text,
            x: 50,
            y: 50,
            width: 250,
            height: 100,
            zIndex: maxZ + 1
        }]);
    };

    const addSwatch = () => {
        const color = prompt("Enter Hex Code (e.g., #3b82f6):", "#");
        if (!color) return;
        const maxZ = Math.max(0, ...items.map(i => i.zIndex));
        setItems([...items, {
            id: `temp-${Date.now()}`,
            type: "SWATCH",
            content: color,
            x: 100,
            y: 100,
            width: 150,
            height: 150,
            zIndex: maxZ + 1
        }]);
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploading(true);
        try {
            const formData = new FormData();
            formData.append("files", file);
            formData.append("projectId", board.projectId);
            
            const response = await fetch("/api/files", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || "Failed to upload file");
            }

            const data = await response.json();
            const uploadedUrl = data.files[0]?.url;

            if (!uploadedUrl) throw new Error("File URL not returned from server");

            const maxZ = Math.max(0, ...items.map(i => i.zIndex));
            
            setItems(prev => [...prev, {
                id: `temp-${Date.now()}`,
                type: "IMAGE",
                content: uploadedUrl,
                x: 150,
                y: 150,
                width: 300,
                height: 300,
                zIndex: maxZ + 1
            }]);
            
            toast.success("Image added");
        } catch (error: any) {
            console.error(error);
            toast.error(error.message || "Failed to upload image.");
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const updateItem = (id: string, updates: Partial<Item>) => {
        setItems(items.map(i => i.id === id ? { ...i, ...updates } : i));
    };

    const removeItem = (id: string) => {
        setItems(items.filter(i => i.id !== id));
        if (selectedId === id) setSelectedId(null);
    };

    const bringToFront = (id: string) => {
        const maxZ = Math.max(0, ...items.map(i => i.zIndex));
        updateItem(id, { zIndex: maxZ + 1 });
    };

    const sendToBack = (id: string) => {
        const minZ = Math.min(0, ...items.map(i => i.zIndex));
        updateItem(id, { zIndex: minZ - 1 });
    };

    const addImageByURL = () => {
        const url = prompt("Enter Image URL (e.g., from Lowe's or Pinterest):");
        if (!url) return;
        const maxZ = Math.max(0, ...items.map(i => i.zIndex));
        setItems([...items, {
            id: `temp-${Date.now()}`,
            type: "IMAGE",
            content: url,
            x: 100,
            y: 100,
            width: 300,
            height: 300,
            zIndex: maxZ + 1
        }]);
    };

    return (
        <div className="w-full h-full flex flex-col">
            {/* Toolbar */}
            <div className="bg-white border-b border-slate-200 p-3 flex items-center justify-between shadow-sm z-10 shrink-0">
                <div className="flex items-center gap-2">
                    <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        Upload Local Image
                    </button>
                    <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
                    
                    <button onClick={addImageByURL} className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                        Add by URL
                    </button>
                    
                    <button onClick={addText} className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        Add Text
                    </button>
                    
                    <button onClick={addSwatch} className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5">
                        <div className="w-3.5 h-3.5 rounded-full bg-gradient-to-tr from-pink-500 to-indigo-500" />
                        Add Swatch
                    </button>
                </div>
                <div className="flex items-center gap-3">
                    {selectedId && (
                        <div className="flex items-center gap-1 mr-4 bg-slate-100 p-1 rounded-md">
                            <button onClick={() => bringToFront(selectedId)} title="Bring Forward" className="p-1.5 hover:bg-white rounded text-slate-600 transition shadow-sm">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 11l7-7 7 7M5 19l7-7 7 7" /></svg>
                            </button>
                            <button onClick={() => sendToBack(selectedId)} title="Send Backward" className="p-1.5 hover:bg-white rounded text-slate-600 transition shadow-sm">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 13l-7 7-7-7m14-8l-7 7-7-7" /></svg>
                            </button>
                            <div className="w-px h-5 bg-slate-300 mx-1" />
                            <button onClick={() => removeItem(selectedId)} title="Delete" className="p-1.5 hover:bg-white rounded text-red-500 transition shadow-sm">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                        </div>
                    )}
                    <button onClick={handleSave} disabled={saving} className="hui-btn hui-btn-primary">
                        {saving ? "Saving..." : "Save Layout"}
                    </button>
                </div>
            </div>

            {/* Canvas */}
            <div ref={canvasRef} className="flex-1 w-full h-full relative overflow-auto custom-scrollbar" style={{ backgroundImage: 'radial-gradient(#CBD5E1 1px, transparent 1px)', backgroundSize: '20px 20px' }}>
                {items.map(item => (
                    <MoodBoardNode
                        key={item.id}
                        item={item}
                        isSelected={selectedId === item.id}
                        onSelect={() => setSelectedId(item.id)}
                        onChange={(updates) => updateItem(item.id, updates)}
                        canvasRef={canvasRef}
                    />
                ))}
            </div>
        </div>
    );
}

function MoodBoardNode({ item, isSelected, onSelect, onChange, canvasRef }: {
    item: Item;
    isSelected: boolean;
    onSelect: () => void;
    onChange: (updates: Partial<Item>) => void;
    canvasRef: React.RefObject<HTMLDivElement | null>;
}) {
    // Simple drag behavior for resizing bottom-right corner
    const handleResize = (e: React.MouseEvent) => {
        e.stopPropagation();
        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = item.width;
        const startHeight = item.height;

        const onMouseMove = (moveEvent: MouseEvent) => {
            const newWidth = Math.max(50, startWidth + (moveEvent.clientX - startX));
            const newHeight = Math.max(50, startHeight + (moveEvent.clientY - startY));
            onChange({ width: newWidth, height: newHeight });
        };

        const onMouseUp = () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    };

    return (
        <motion.div
            drag
            dragMomentum={false}
            dragConstraints={canvasRef}
            initial={{ x: item.x, y: item.y }}
            onDragEnd={(e, info) => {
                // Ensure to save the exact offset to maintain position
                onChange({ x: item.x + info.offset.x, y: item.y + info.offset.y });
            }}
            onClick={(e) => {
                e.stopPropagation();
                onSelect();
            }}
            style={{
                position: "absolute",
                width: item.width,
                height: item.height,
                zIndex: item.zIndex,
                cursor: "move",
            }}
            className={`group ${isSelected ? "ring-2 ring-hui-primary ring-offset-2" : "hover:ring-2 hover:ring-slate-300 hover:ring-offset-1"}`}
        >
            {item.type === "IMAGE" && (
                <img src={item.content} alt="Mood Board Item" className="w-full h-full object-contain pointer-events-none" />
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

            {/* Resize Handle */}
            {isSelected && (
                <div
                    onMouseDown={handleResize}
                    className="absolute -bottom-2 -right-2 w-5 h-5 bg-hui-primary border-2 border-white rounded-full cursor-nwse-resize z-50 shadow-md"
                />
            )}
        </motion.div>
    );
}
