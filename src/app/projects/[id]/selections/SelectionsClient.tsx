"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    createSelectionBoard,
    deleteSelectionBoard,
    createSelectionCategory,
    deleteSelectionCategory,
    createSelectionOption,
    deleteSelectionOption,
    sendSelectionBoardToClient,
    updateSelectionBoard,
} from "@/lib/actions";

interface Option {
    id: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    price: number | null;
    vendorUrl: string | null;
    selected: boolean;
    order: number;
}

interface Category {
    id: string;
    name: string;
    order: number;
    options: Option[];
}

interface Board {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    categories: Category[];
}

export default function SelectionsClient({
    projectId,
    initialBoards,
}: {
    projectId: string;
    initialBoards: Board[];
}) {
    const router = useRouter();
    const [boards] = useState<Board[]>(initialBoards);
    const [showNewBoard, setShowNewBoard] = useState(false);
    const [newBoardTitle, setNewBoardTitle] = useState("");
    const [creating, setCreating] = useState(false);

    // Category creation state
    const [addingCatFor, setAddingCatFor] = useState<string | null>(null);
    const [newCatName, setNewCatName] = useState("");

    // Option creation state
    const [addingOptFor, setAddingOptFor] = useState<string | null>(null);
    const [optForm, setOptForm] = useState({ name: "", description: "", imageUrl: "", price: "", vendorUrl: "" });

    // Expanded board
    const [expandedBoard, setExpandedBoard] = useState<string | null>(
        initialBoards.length > 0 ? initialBoards[0].id : null
    );

    const handleCreateBoard = async () => {
        if (!newBoardTitle.trim()) return;
        setCreating(true);
        try {
            await createSelectionBoard(projectId, newBoardTitle.trim());
            toast.success("Selection board created");
            setNewBoardTitle("");
            setShowNewBoard(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to create board");
        } finally {
            setCreating(false);
        }
    };

    const handleDeleteBoard = async (boardId: string) => {
        if (!confirm("Delete this entire selection board? This cannot be undone.")) return;
        try {
            await deleteSelectionBoard(boardId);
            toast.success("Board deleted");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to delete");
        }
    };

    const handleAddCategory = async (boardId: string) => {
        if (!newCatName.trim()) return;
        try {
            await createSelectionCategory(boardId, newCatName.trim());
            toast.success("Category added");
            setNewCatName("");
            setAddingCatFor(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to add category");
        }
    };

    const handleDeleteCategory = async (catId: string) => {
        if (!confirm("Delete this category and all its options?")) return;
        try {
            await deleteSelectionCategory(catId);
            toast.success("Category deleted");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to delete");
        }
    };

    const handleAddOption = async (categoryId: string) => {
        if (!optForm.name.trim()) return;
        try {
            await createSelectionOption(categoryId, {
                name: optForm.name.trim(),
                description: optForm.description || undefined,
                imageUrl: optForm.imageUrl || undefined,
                price: optForm.price ? parseFloat(optForm.price) : undefined,
                vendorUrl: optForm.vendorUrl || undefined,
            });
            toast.success("Option added");
            setOptForm({ name: "", description: "", imageUrl: "", price: "", vendorUrl: "" });
            setAddingOptFor(null);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to add option");
        }
    };

    const handleDeleteOption = async (optId: string) => {
        if (!confirm("Delete this option?")) return;
        try {
            await deleteSelectionOption(optId);
            toast.success("Option deleted");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to delete");
        }
    };

    const handleSendToClient = async (boardId: string) => {
        if (!confirm("Send this selection board to the client? They will receive an email notification.")) return;
        try {
            await sendSelectionBoardToClient(boardId);
            toast.success("Board sent to client!");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to send");
        }
    };

    const handleResetToDraft = async (boardId: string) => {
        try {
            await updateSelectionBoard(boardId, { status: "Draft" });
            toast.success("Board reset to draft");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to reset");
        }
    };

    const statusColor = (s: string) => {
        if (s === "Draft") return "bg-slate-100 text-slate-600";
        if (s === "Sent") return "bg-blue-100 text-blue-700";
        return "bg-green-100 text-green-700";
    };

    return (
        <div className="max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Selections &amp; Mood Boards</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Create selection boards with categories and options for clients to choose from.
                    </p>
                </div>
                <button
                    onClick={() => setShowNewBoard(true)}
                    className="hui-btn hui-btn-green flex items-center gap-2"
                >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    New Board
                </button>
            </div>

            {/* Create Board Modal */}
            {showNewBoard && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6">
                        <h3 className="text-lg font-bold text-hui-textMain mb-4">Create Selection Board</h3>
                        <input
                            type="text"
                            placeholder="Board title (e.g. Kitchen Selections)"
                            value={newBoardTitle}
                            onChange={(e) => setNewBoardTitle(e.target.value)}
                            className="hui-input w-full mb-4"
                            autoFocus
                            onKeyDown={(e) => e.key === "Enter" && handleCreateBoard()}
                        />
                        <div className="flex gap-3 justify-end">
                            <button
                                onClick={() => { setShowNewBoard(false); setNewBoardTitle(""); }}
                                className="hui-btn hui-btn-secondary"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateBoard}
                                disabled={creating || !newBoardTitle.trim()}
                                className="hui-btn hui-btn-green disabled:opacity-50"
                            >
                                {creating ? "Creating..." : "Create Board"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Empty State */}
            {boards.length === 0 && !showNewBoard && (
                <div className="hui-card p-12 text-center">
                    <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                    </div>
                    <h3 className="text-lg font-semibold text-hui-textMain mb-2">No Selection Boards Yet</h3>
                    <p className="text-sm text-hui-textMuted mb-6 max-w-md mx-auto">
                        Create a selection board with categories like Countertops, Flooring, and Fixtures.
                        Add options with images and pricing, then send to your client for review.
                    </p>
                    <button onClick={() => setShowNewBoard(true)} className="hui-btn hui-btn-green">
                        Create Your First Board
                    </button>
                </div>
            )}

            {/* Board List */}
            <div className="space-y-6">
                {boards.map((board) => {
                    const isExpanded = expandedBoard === board.id;
                    return (
                        <div key={board.id} className="hui-card overflow-hidden">
                            {/* Board Header */}
                            <div
                                className="flex items-center justify-between p-5 cursor-pointer hover:bg-slate-50 transition"
                                onClick={() => setExpandedBoard(isExpanded ? null : board.id)}
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 bg-gradient-to-br from-emerald-100 to-teal-100 rounded-xl flex items-center justify-center">
                                        <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                        </svg>
                                    </div>
                                    <div>
                                        <h2 className="text-base font-semibold text-hui-textMain">{board.title}</h2>
                                        <p className="text-xs text-hui-textMuted">
                                            {board.categories.length} categories · {board.categories.reduce((a, c) => a + c.options.length, 0)} options
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${statusColor(board.status)}`}>
                                        {board.status}
                                    </span>
                                    <svg
                                        className={`w-5 h-5 text-slate-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                        fill="none" stroke="currentColor" viewBox="0 0 24 24"
                                    >
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                </div>
                            </div>

                            {/* Expanded Content */}
                            {isExpanded && (
                                <div className="border-t border-hui-border">
                                    {/* Board Actions */}
                                    <div className="flex items-center gap-2 px-5 py-3 bg-slate-50 border-b border-hui-border">
                                        {board.status === "Draft" && (
                                            <button
                                                onClick={() => handleSendToClient(board.id)}
                                                className="hui-btn hui-btn-green text-sm flex items-center gap-1.5"
                                                disabled={board.categories.length === 0}
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                                </svg>
                                                Send to Client
                                            </button>
                                        )}
                                        {board.status !== "Draft" && (
                                            <button
                                                onClick={() => handleResetToDraft(board.id)}
                                                className="hui-btn hui-btn-secondary text-sm"
                                            >
                                                Reset to Draft
                                            </button>
                                        )}
                                        <button
                                            onClick={() => { setAddingCatFor(board.id); setNewCatName(""); }}
                                            className="hui-btn hui-btn-secondary text-sm flex items-center gap-1.5"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                            </svg>
                                            Add Category
                                        </button>
                                        <div className="flex-1" />
                                        <button
                                            onClick={() => handleDeleteBoard(board.id)}
                                            className="text-sm text-red-500 hover:text-red-700 transition px-2 py-1"
                                        >
                                            Delete Board
                                        </button>
                                    </div>

                                    {/* Add Category Inline */}
                                    {addingCatFor === board.id && (
                                        <div className="flex items-center gap-3 px-5 py-3 bg-amber-50 border-b border-amber-200">
                                            <input
                                                type="text"
                                                placeholder="Category name (e.g. Countertops)"
                                                value={newCatName}
                                                onChange={(e) => setNewCatName(e.target.value)}
                                                className="hui-input flex-1 text-sm"
                                                autoFocus
                                                onKeyDown={(e) => e.key === "Enter" && handleAddCategory(board.id)}
                                            />
                                            <button onClick={() => handleAddCategory(board.id)} className="hui-btn hui-btn-green text-sm" disabled={!newCatName.trim()}>
                                                Add
                                            </button>
                                            <button onClick={() => setAddingCatFor(null)} className="hui-btn hui-btn-secondary text-sm">
                                                Cancel
                                            </button>
                                        </div>
                                    )}

                                    {/* Categories */}
                                    {board.categories.length === 0 && (
                                        <div className="p-8 text-center text-sm text-hui-textMuted">
                                            No categories yet. Add a category like &quot;Countertops&quot;, &quot;Flooring&quot;, or &quot;Fixtures&quot; to get started.
                                        </div>
                                    )}

                                    {board.categories.map((cat) => (
                                        <div key={cat.id} className="border-b border-hui-border last:border-b-0">
                                            {/* Category Header */}
                                            <div className="flex items-center justify-between px-5 py-3 bg-white">
                                                <h3 className="text-sm font-semibold text-hui-textMain uppercase tracking-wider">
                                                    {cat.name}
                                                </h3>
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => { setAddingOptFor(cat.id); setOptForm({ name: "", description: "", imageUrl: "", price: "", vendorUrl: "" }); }}
                                                        className="text-xs text-hui-primary hover:text-hui-primaryHover font-medium flex items-center gap-1 transition"
                                                    >
                                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                                        </svg>
                                                        Add Option
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteCategory(cat.id)}
                                                        className="text-xs text-red-400 hover:text-red-600 transition ml-2"
                                                    >
                                                        Remove
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Add Option Form */}
                                            {addingOptFor === cat.id && (
                                                <div className="px-5 py-4 bg-green-50 border-t border-green-200">
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                                                        <input
                                                            type="text"
                                                            placeholder="Option name *"
                                                            value={optForm.name}
                                                            onChange={(e) => setOptForm({ ...optForm, name: e.target.value })}
                                                            className="hui-input text-sm"
                                                            autoFocus
                                                        />
                                                        <input
                                                            type="text"
                                                            placeholder="Price (e.g. 2500)"
                                                            value={optForm.price}
                                                            onChange={(e) => setOptForm({ ...optForm, price: e.target.value })}
                                                            className="hui-input text-sm"
                                                        />
                                                        <input
                                                            type="text"
                                                            placeholder="Image URL"
                                                            value={optForm.imageUrl}
                                                            onChange={(e) => setOptForm({ ...optForm, imageUrl: e.target.value })}
                                                            className="hui-input text-sm"
                                                        />
                                                        <input
                                                            type="text"
                                                            placeholder="Vendor/Product Link"
                                                            value={optForm.vendorUrl}
                                                            onChange={(e) => setOptForm({ ...optForm, vendorUrl: e.target.value })}
                                                            className="hui-input text-sm"
                                                        />
                                                    </div>
                                                    <textarea
                                                        placeholder="Description (optional)"
                                                        value={optForm.description}
                                                        onChange={(e) => setOptForm({ ...optForm, description: e.target.value })}
                                                        className="hui-input w-full text-sm mb-3"
                                                        rows={2}
                                                    />
                                                    <div className="flex gap-2">
                                                        <button
                                                            onClick={() => handleAddOption(cat.id)}
                                                            className="hui-btn hui-btn-green text-sm"
                                                            disabled={!optForm.name.trim()}
                                                        >
                                                            Add Option
                                                        </button>
                                                        <button onClick={() => setAddingOptFor(null)} className="hui-btn hui-btn-secondary text-sm">
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Options Grid */}
                                            {cat.options.length === 0 && addingOptFor !== cat.id && (
                                                <div className="px-5 py-4 text-xs text-hui-textMuted italic border-t border-slate-100">
                                                    No options yet. Click &quot;Add Option&quot; to begin.
                                                </div>
                                            )}

                                            {cat.options.length > 0 && (
                                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5 border-t border-slate-100">
                                                    {cat.options.map((opt) => (
                                                        <div
                                                            key={opt.id}
                                                            className={`hui-card overflow-hidden group relative ${opt.selected ? "ring-2 ring-hui-primary" : ""}`}
                                                        >
                                                            {opt.selected && (
                                                                <div className="absolute top-2 right-2 z-10 bg-hui-primary text-white text-xs font-bold px-2 py-0.5 rounded-full">
                                                                    ✓ Selected
                                                                </div>
                                                            )}
                                                            {/* Image */}
                                                            <div className="h-36 bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center overflow-hidden">
                                                                {opt.imageUrl ? (
                                                                    <img
                                                                        src={opt.imageUrl}
                                                                        alt={opt.name}
                                                                        className="w-full h-full object-cover"
                                                                    />
                                                                ) : (
                                                                    <svg className="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                                    </svg>
                                                                )}
                                                            </div>
                                                            {/* Info */}
                                                            <div className="p-3">
                                                                <div className="flex items-start justify-between mb-1">
                                                                    <h4 className="text-sm font-semibold text-hui-textMain">{opt.name}</h4>
                                                                    {opt.price != null && (
                                                                        <span className="text-sm font-bold text-hui-primary ml-2 whitespace-nowrap">
                                                                            ${opt.price.toLocaleString()}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                {opt.description && (
                                                                    <p className="text-xs text-hui-textMuted mb-2 line-clamp-2">{opt.description}</p>
                                                                )}
                                                                <div className="flex items-center gap-2">
                                                                    {opt.vendorUrl && (
                                                                        <a
                                                                            href={opt.vendorUrl}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                                                                        >
                                                                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                                                            </svg>
                                                                            View Product
                                                                        </a>
                                                                    )}
                                                                    <div className="flex-1" />
                                                                    <button
                                                                        onClick={() => handleDeleteOption(opt.id)}
                                                                        className="text-xs text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                                                                    >
                                                                        Delete
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
