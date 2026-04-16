// Search input with a clear (✕) button. Controlled component — parent owns
// the query string.

import { X } from "lucide-react";

interface AssetSearchProps {
    value: string;
    onChange: (next: string) => void;
}

export function AssetSearch({ value, onChange }: AssetSearchProps) {
    return (
        <div className="relative">
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="Search assets…"
                className="hui-input w-full pr-7 py-1 text-sm"
            />
            {value.length > 0 && (
                <button
                    type="button"
                    onClick={() => onChange("")}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                    <X size={14} />
                </button>
            )}
        </div>
    );
}
