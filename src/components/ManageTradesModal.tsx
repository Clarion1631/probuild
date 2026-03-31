"use client";
import { useState, useEffect } from "react";
import { getCompanySubcontractorTrades, saveCompanySubcontractorTrades } from "@/lib/actions";
import { toast } from "sonner";

export default function ManageTradesModal({ onClose }: { onClose: () => void }) {
    const [trades, setTrades] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [newTrade, setNewTrade] = useState("");
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editingText, setEditingText] = useState("");

    useEffect(() => {
        loadTrades();
    }, []);

    const loadTrades = async () => {
        const data = await getCompanySubcontractorTrades();
        setTrades(data);
        setLoading(false);
    };

    const handleSave = async (updatedTrades: string[]) => {
        setSaving(true);
        try {
            await saveCompanySubcontractorTrades(updatedTrades);
            setTrades(updatedTrades);
        } catch {
            toast.error("Failed to save trades");
        } finally {
            setSaving(false);
        }
    };

    const handleAdd = async (e: React.FormEvent) => {
        e.preventDefault();
        const t = newTrade.trim();
        if (!t) return;
        if (trades.includes(t)) {
            toast.error("Trade already exists");
            return;
        }
        
        const newTrades = [...trades, t].sort();
        setNewTrade("");
        await handleSave(newTrades);
    };

    const handleDelete = async (index: number) => {
        if (!confirm("Remove this trade?")) return;
        const newTrades = trades.filter((_, i) => i !== index);
        await handleSave(newTrades);
    };

    const handleEditStart = (index: number) => {
        setEditingIndex(index);
        setEditingText(trades[index]);
    };

    const handleEditSave = async (index: number) => {
        const t = editingText.trim();
        if (!t) return;
        
        if (t !== trades[index] && trades.includes(t)) {
            toast.error("Trade already exists");
            return;
        }

        const newTrades = [...trades];
        newTrades[index] = t;
        newTrades.sort();
        setEditingIndex(null);
        await handleSave(newTrades);
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]">
                <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center bg-slate-50/50">
                    <h2 className="text-lg font-bold text-hui-textMain">Manage Trades</h2>
                    <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded-lg text-slate-500 transition">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                
                <div className="p-6 flex-1 overflow-y-auto">
                    <form onSubmit={handleAdd} className="flex gap-2 mb-6">
                        <input
                            type="text"
                            value={newTrade}
                            onChange={(e) => setNewTrade(e.target.value)}
                            placeholder="Add new trade type..."
                            className="flex-1 border border-hui-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-hui-primary/20"
                        />
                        <button 
                            type="submit" 
                            disabled={!newTrade.trim() || saving}
                            className="bg-hui-primary text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-hui-primaryHover disabled:opacity-50 transition"
                        >
                            Add
                        </button>
                    </form>

                    {loading ? (
                        <div className="text-center py-8 text-slate-500">Loading...</div>
                    ) : (
                        <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                            {trades.length === 0 ? (
                                <li className="p-4 text-center text-sm text-slate-500 italic">No trades defined</li>
                            ) : (
                                trades.map((trade, idx) => (
                                    <li key={idx} className="flex items-center justify-between p-3 hover:bg-slate-50 transition group">
                                        {editingIndex === idx ? (
                                            <div className="flex flex-1 gap-2 items-center">
                                                <input 
                                                    autoFocus
                                                    type="text"
                                                    value={editingText}
                                                    onChange={e => setEditingText(e.target.value)}
                                                    onKeyDown={e => {
                                                        if (e.key === "Enter") handleEditSave(idx);
                                                        if (e.key === "Escape") setEditingIndex(null);
                                                    }}
                                                    className="flex-1 border border-hui-primary rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-hui-primary"
                                                />
                                                <button onClick={() => handleEditSave(idx)} className="p-1.5 text-hui-primary hover:bg-indigo-50 rounded">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                </button>
                                                <button onClick={() => setEditingIndex(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                        ) : (
                                            <>
                                                <span className="text-sm font-medium text-slate-700">{trade}</span>
                                                <div className="flex items-center opacity-0 group-hover:opacity-100 transition">
                                                    <button onClick={() => handleEditStart(idx)} className="p-1.5 text-slate-400 hover:text-hui-primary rounded">
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                                                    </button>
                                                    <button onClick={() => handleDelete(idx)} className="p-1.5 text-slate-400 hover:text-red-500 rounded">
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                    </li>
                                ))
                            )}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
