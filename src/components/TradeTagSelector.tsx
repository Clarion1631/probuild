"use client";
import { useState, useEffect, useRef } from "react";
import { getCompanySubcontractorTrades } from "@/lib/actions";
import ManageTradesModal from "./ManageTradesModal";

export default function TradeTagSelector({
    value,
    onChange
}: {
    value: string; // comma-separated
    onChange: (val: string) => void;
}) {
    const [availableTrades, setAvailableTrades] = useState<string[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const [isManageModalOpen, setIsManageModalOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    const loadTrades = async () => {
        const trades = await getCompanySubcontractorTrades();
        setAvailableTrades(trades);
    };

    useEffect(() => {
        loadTrades();
        
        function handleClickOutside(event: MouseEvent) {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const selectedTags = value ? value.split(",").map(t => t.trim()).filter(Boolean) : [];

    const handleSelect = (trade: string) => {
        if (!selectedTags.includes(trade)) {
            const newTags = [...selectedTags, trade];
            onChange(newTags.join(", "));
        }
        setIsOpen(false);
    };

    const handleRemove = (trade: string) => {
        const newTags = selectedTags.filter(t => t !== trade);
        onChange(newTags.join(", "));
    };

    const unselectedTrades = availableTrades.filter(t => !selectedTags.includes(t));

    return (
        <div className="relative" ref={wrapperRef}>
            <div 
                className="w-full min-h-[42px] border border-hui-border rounded-lg px-3 py-1.5 flex flex-wrap gap-2 items-center cursor-text bg-white"
                onClick={() => setIsOpen(true)}
            >
                {selectedTags.map(tag => (
                    <span key={tag} className="flex items-center gap-1 bg-slate-100 border border-slate-200 text-slate-700 text-xs font-medium px-2 py-1 rounded-md">
                        {tag}
                        <button 
                            type="button" 
                            onClick={(e) => { e.stopPropagation(); handleRemove(tag); }}
                            className="text-slate-400 hover:text-slate-600 focus:outline-none"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                    </span>
                ))}
                <input 
                    type="text" 
                    className="flex-1 outline-none min-w-[50px] text-sm bg-transparent"
                    placeholder={selectedTags.length === 0 ? "Select trades..." : ""}
                    readOnly
                    onFocus={() => setIsOpen(true)}
                />
            </div>

            {isOpen && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden max-h-60 flex flex-col">
                    <div className="overflow-y-auto flex-1 p-1">
                        {unselectedTrades.length === 0 ? (
                            <div className="p-3 text-sm text-slate-500 text-center italic">No additional trades available</div>
                        ) : (
                            unselectedTrades.map(trade => (
                                <button
                                    key={trade}
                                    type="button"
                                    onClick={() => handleSelect(trade)}
                                    className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-md transition"
                                >
                                    {trade}
                                </button>
                            ))
                        )}
                    </div>
                    <div className="border-t border-slate-100 p-1 bg-slate-50">
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setIsOpen(false); setIsManageModalOpen(true); }}
                            className="w-full text-left px-3 py-2 text-sm font-medium text-hui-primary hover:bg-slate-100 rounded-md transition flex items-center gap-2"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                            Manage Trades
                        </button>
                    </div>
                </div>
            )}

            {isManageModalOpen && (
                <ManageTradesModal 
                    onClose={() => {
                        setIsManageModalOpen(false);
                        loadTrades(); // Reload after managing
                    }} 
                />
            )}
        </div>
    );
}
