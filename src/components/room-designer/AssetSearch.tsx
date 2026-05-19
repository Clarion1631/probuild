// Search input with a clear (✕) button. Controlled component — parent owns
// the query string.

import { X, Search } from "lucide-react";

interface AssetSearchProps {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
}

export function AssetSearch({ value, onChange, placeholder = "Search assets…" }: AssetSearchProps) {
    return (
        <div className="relative">
            <div className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Search className="h-4 w-4" />
            </div>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full rounded-full border border-purple-100 bg-purple-50/30 py-1.5 pl-8 pr-8 text-[11px] font-medium text-slate-700 placeholder:text-slate-400 focus:border-[#531b7e] focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#531b7e] transition-all"
            />
            {value.length > 0 && (
                <button
                    type="button"
                    onClick={() => onChange("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                    <X className="h-3 w-3" />
                </button>
            )}
        </div>
    );
}
