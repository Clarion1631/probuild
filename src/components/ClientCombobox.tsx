"use client";

import { useState, useEffect, useRef } from "react";
import { getClients } from "@/lib/actions";

export default function ClientCombobox({ name, defaultValue = "", onSelect }: { name: string, defaultValue?: string, onSelect?: (client: any) => void }) {
    const [query, setQuery] = useState(defaultValue);
    const [clients, setClients] = useState<any[]>([]);
    const [isOpen, setIsOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        getClients().then(setClients);
        
        function handleClickOutside(event: MouseEvent) {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const filtered = clients.filter(c => c.name.toLowerCase().includes(query.toLowerCase()));

    return (
        <div className="relative" ref={wrapperRef}>
            <input 
                type="text" 
                name={name}
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setIsOpen(true);
                }}
                onFocus={() => setIsOpen(true)}
                className="hui-input w-full"
                autoComplete="off"
                placeholder="Search or type new name..."
                required
            />
            {isOpen && query && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-hui-border rounded-md shadow-lg max-h-60 overflow-y-auto">
                    {filtered.map(c => (
                        <button
                            key={c.id}
                            type="button"
                            className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm text-hui-textMain border-b border-hui-border last:border-0"
                            onClick={() => {
                                setQuery(c.name);
                                setIsOpen(false);
                                if (onSelect) onSelect(c);
                            }}
                        >
                            <span className="font-medium block">{c.name}</span>
                            {(c.email || c.primaryPhone) && (
                                <span className="text-xs text-hui-textMuted block mt-0.5">{c.email} {c.primaryPhone ? `• ${c.primaryPhone}` : ''}</span>
                            )}
                        </button>
                    ))}
                    {filtered.length === 0 || !filtered.find(c => c.name.toLowerCase() === query.trim().toLowerCase()) ? (
                        <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm text-hui-primary bg-slate-50 font-medium hover:bg-slate-100 transition"
                            onClick={() => setIsOpen(false)}
                        >
                            + Create New "{query}"
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}
