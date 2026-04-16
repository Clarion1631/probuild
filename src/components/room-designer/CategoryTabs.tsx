// 7-tab category selector (Cabinets / Appliances / Fixtures / Windows / Doors
// / Lighting / Plants). Lighting + Plants are Stage 1.5 additions sourced from
// Quaternius loose GLBs. No Materials tab in Stage 2 — surfaces/materials
// arrive in Stage 3.

import type { AssetCategory } from "./types";

export interface CategoryTab {
    key: AssetCategory;
    label: string;
    icon: string;
}

export const CATEGORIES: CategoryTab[] = [
    { key: "cabinet", label: "Cabinets", icon: "▦" },
    { key: "appliance", label: "Appliances", icon: "◨" },
    { key: "fixture", label: "Fixtures", icon: "◉" },
    { key: "window", label: "Windows", icon: "▣" },
    { key: "door", label: "Doors", icon: "▯" },
    { key: "lighting", label: "Lighting", icon: "✦" },
    { key: "plants", label: "Plants", icon: "❦" },
];

interface CategoryTabsProps {
    active: AssetCategory;
    onChange: (next: AssetCategory) => void;
}

export function CategoryTabs({ active, onChange }: CategoryTabsProps) {
    return (
        <div className="flex flex-wrap gap-1">
            {CATEGORIES.map((c) => (
                <button
                    key={c.key}
                    type="button"
                    onClick={() => onChange(c.key)}
                    className={`rounded-md border px-2 py-1 text-xs font-medium transition ${
                        active === c.key
                            ? "border-slate-800 bg-slate-900 text-white"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                    }`}
                >
                    <span className="mr-1">{c.icon}</span>
                    {c.label}
                </button>
            ))}
        </div>
    );
}
