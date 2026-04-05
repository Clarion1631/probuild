"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { submitClientSelections } from "@/lib/actions";

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
    categories: Category[];
}

export default function PortalSelectionsClient({ boards }: { boards: Board[] }) {
    const router = useRouter();
    const [submitting, setSubmitting] = useState<Record<string, boolean>>({});

    // Track local selections per board: { boardId: { categoryId: optionId } }
    const [localSelections, setLocalSelections] = useState<Record<string, Record<string, string>>>(() => {
        const initial: Record<string, Record<string, string>> = {};
        for (const board of boards) {
            initial[board.id] = {};
            for (const cat of board.categories) {
                const selectedOpt = cat.options.find(o => o.selected);
                if (selectedOpt) {
                    initial[board.id][cat.id] = selectedOpt.id;
                }
            }
        }
        return initial;
    });

    const handleSelect = (boardId: string, categoryId: string, optionId: string) => {
        setLocalSelections(prev => ({
            ...prev,
            [boardId]: {
                ...(prev[boardId] || {}),
                [categoryId]: optionId
            }
        }));
    };

    const handleSubmit = async (boardId: string) => {
        const selections = localSelections[boardId] || {};
        
        // Ensure all categories have a selection
        const board = boards.find(b => b.id === boardId);
        if (!board) return;
        
        const missingCats = board.categories.filter(c => !selections[c.id]);
        if (missingCats.length > 0) {
            toast.error(`Please select an option for: ${missingCats.map(c => c.name).join(", ")}`);
            return;
        }

        if (!confirm("Submit your selections? You won't be able to change them afterwards.")) return;

        setSubmitting(prev => ({ ...prev, [boardId]: true }));
        try {
            await submitClientSelections(boardId, selections);
            toast.success("Selections submitted successfully!");
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to submit selections");
        } finally {
            setSubmitting(prev => ({ ...prev, [boardId]: false }));
        }
    };

    return (
        <div className="space-y-12">
            {boards.map(board => {
                const boardSelections = localSelections[board.id] || {};
                const isSubmitted = board.status === "Selections Made";

                return (
                    <div key={board.id} className="hui-card overflow-hidden">
                        <div className="bg-slate-50 border-b border-hui-border px-6 py-5 flex items-center justify-between">
                            <div>
                                <h2 className="text-xl font-bold text-hui-textMain">{board.title}</h2>
                                {isSubmitted ? (
                                    <p className="text-sm text-green-600 mt-1 font-medium flex items-center gap-1">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                        Selections Submitted
                                    </p>
                                ) : (
                                    <p className="text-sm text-amber-600 mt-1 font-medium">Please select one option from each category below.</p>
                                )}
                            </div>
                            {!isSubmitted && (
                                <button
                                    onClick={() => handleSubmit(board.id)}
                                    disabled={submitting[board.id]}
                                    className="hui-btn hui-btn-green"
                                >
                                    {submitting[board.id] ? "Submitting..." : "Submit Selections"}
                                </button>
                            )}
                        </div>

                        <div className="p-6 space-y-10">
                            {board.categories.map(cat => (
                                <div key={cat.id}>
                                    <div className="flex items-center justify-between mb-4 border-b border-slate-200 pb-2">
                                        <h3 className="text-lg font-semibold text-slate-800">{cat.name}</h3>
                                        {!isSubmitted && (
                                            <span className={`text-sm font-medium ${boardSelections[cat.id] ? 'text-green-600' : 'text-slate-400'}`}>
                                                {boardSelections[cat.id] ? '✓ Option Selected' : 'Not Selected'}
                                            </span>
                                        )}
                                    </div>
                                    
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                        {cat.options.map(opt => {
                                            const isSelected = boardSelections[cat.id] === opt.id;
                                            
                                            // Render read-only if submitted, otherwise interactive
                                            if (isSubmitted && !isSelected) return null; // In submitted state, only show selected options (or gray out unselected ones)

                                            return (
                                                <div 
                                                    key={opt.id} 
                                                    className={`
                                                        rounded-xl border-2 overflow-hidden transition-all duration-200 group relative
                                                        ${isSelected ? 'border-hui-primary shadow-md' : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'}
                                                        ${!isSubmitted ? 'cursor-pointer' : ''}
                                                    `}
                                                    onClick={() => !isSubmitted && handleSelect(board.id, cat.id, opt.id)}
                                                >
                                                    {isSelected && (
                                                        <div className="absolute top-3 right-3 z-10 bg-hui-primary text-white text-xs font-bold px-3 py-1 rounded-full shadow-sm flex items-center gap-1">
                                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                                            Selected
                                                        </div>
                                                    )}
                                                    
                                                    <div className="h-48 bg-slate-100 flex items-center justify-center overflow-hidden">
                                                        {opt.imageUrl ? (
                                                            <img 
                                                                src={opt.imageUrl} 
                                                                alt={opt.name}
                                                                className={`w-full h-full object-cover transition-transform duration-500 ${!isSubmitted ? 'group-hover:scale-105' : ''}`}
                                                            />
                                                        ) : (
                                                            <svg className="w-12 h-12 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                                            </svg>
                                                        )}
                                                    </div>
                                                    
                                                    <div className="p-4 bg-white">
                                                        <div className="flex justify-between items-start mb-2 gap-2">
                                                            <h4 className="font-bold text-slate-800 leading-tight">{opt.name}</h4>
                                                            {opt.price != null && (
                                                                <span className="font-semibold text-slate-600 shrink-0">+${Number(opt.price).toLocaleString()}</span>
                                                            )}
                                                        </div>
                                                        
                                                        {opt.description && (
                                                            <p className="text-sm text-slate-500 mb-4 line-clamp-3">{opt.description}</p>
                                                        )}
                                                        
                                                        <div className="flex items-center justify-between mt-auto">
                                                            {opt.vendorUrl ? (
                                                                <a 
                                                                    href={opt.vendorUrl} 
                                                                    target="_blank" 
                                                                    rel="noopener noreferrer"
                                                                    onClick={(e) => e.stopPropagation()}
                                                                    className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1"
                                                                >
                                                                    View Product
                                                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                                                                </a>
                                                            ) : <div />}
                                                            
                                                            {!isSubmitted && (
                                                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'border-hui-primary bg-hui-primary' : 'border-slate-300'}`}>
                                                                    {isSelected && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
