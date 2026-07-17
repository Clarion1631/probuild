"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PayoutsFilters, PayoutsType } from "@/lib/payouts-report";
import { formatLocalDateString } from "@/lib/report-utils";

type Option = { id: string; name: string };

export default function PayoutsFiltersForm({
    filters,
    projects,
}: {
    filters: PayoutsFilters;
    projects: Option[];
}) {
    const router = useRouter();
    const [from, setFrom] = useState(formatLocalDateString(filters.from));
    const [to, setTo] = useState(formatLocalDateString(filters.to));
    const [projectId, setProjectId] = useState(filters.projectId ?? "");
    const [type, setType] = useState<PayoutsType>(filters.type);

    function applyFilters(overrides?: { from?: string; to?: string }) {
        const sp = new URLSearchParams();
        sp.set("from", overrides?.from ?? from);
        sp.set("to", overrides?.to ?? to);
        if (projectId) sp.set("projectId", projectId);
        if (type !== "both") sp.set("type", type);
        router.push(`/reports/payouts?${sp.toString()}`);
    }

    function applyPreset(preset: "thisMonth" | "lastMonth" | "thisQuarter" | "lastQuarter" | "ytd") {
        const now = new Date();
        let fromDate: Date, toDate: Date;
        switch (preset) {
            case "thisMonth":
                fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
                toDate = new Date(now.getFullYear(), now.getMonth() + 1, 0); break;
            case "lastMonth":
                fromDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                toDate = new Date(now.getFullYear(), now.getMonth(), 0); break;
            case "thisQuarter": {
                const q = Math.floor(now.getMonth() / 3);
                fromDate = new Date(now.getFullYear(), q * 3, 1);
                toDate = new Date(now.getFullYear(), q * 3 + 3, 0); break;
            }
            case "lastQuarter": {
                const q = Math.floor(now.getMonth() / 3);
                const startMonth = q === 0 ? 9 : (q - 1) * 3;
                const startYear = q === 0 ? now.getFullYear() - 1 : now.getFullYear();
                fromDate = new Date(startYear, startMonth, 1);
                toDate = new Date(startYear, startMonth + 3, 0); break;
            }
            case "ytd":
                fromDate = new Date(now.getFullYear(), 0, 1);
                toDate = now; break;
        }
        const fromStr = formatLocalDateString(fromDate!);
        const toStr = formatLocalDateString(toDate!);
        setFrom(fromStr); setTo(toStr);
        applyFilters({ from: fromStr, to: toStr });
    }

    const typeBtnClass = (t: PayoutsType) =>
        `px-3 py-1.5 rounded-md text-sm font-medium transition ${type === t ? "bg-hui-primary text-white" : "bg-slate-100 text-hui-textMain hover:bg-slate-200"}`;

    return (
        <div className="hui-card p-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mr-2">Type</span>
                <button type="button" onClick={() => setType("both")} className={typeBtnClass("both")}>Both</button>
                <button type="button" onClick={() => setType("expense")} className={typeBtnClass("expense")}>Expenses</button>
                <button type="button" onClick={() => setType("po")} className={typeBtnClass("po")}>Purchase Orders</button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mr-2">Quick ranges</span>
                {(["thisMonth", "lastMonth", "thisQuarter", "lastQuarter", "ytd"] as const).map(p => (
                    <PresetButton key={p} onClick={() => applyPreset(p)} label={{ thisMonth: "This Month", lastMonth: "Last Month", thisQuarter: "This Quarter", lastQuarter: "Last Quarter", ytd: "YTD" }[p]} />
                ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">From</label>
                    <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="hui-input w-full" />
                </div>
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">To</label>
                    <input type="date" value={to} onChange={e => setTo(e.target.value)} className="hui-input w-full" />
                </div>
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">Project</label>
                    <select value={projectId} onChange={e => setProjectId(e.target.value)} className="hui-input w-full">
                        <option value="">All projects</option>
                        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-hui-border">
                <button type="button" onClick={() => { setProjectId(""); setType("both"); router.push(`/reports/payouts?from=${from}&to=${to}`); }}
                    className="hui-btn hui-btn-secondary text-sm">Clear</button>
                <button type="button" onClick={() => applyFilters()} className="hui-btn hui-btn-primary text-sm">Apply</button>
            </div>
        </div>
    );
}

function PresetButton({ onClick, label }: { onClick: () => void; label: string }) {
    return (
        <button type="button" onClick={onClick}
            className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-hui-textMain hover:bg-slate-200 transition">
            {label}
        </button>
    );
}
