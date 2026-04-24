"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GlobalTrackerFilters } from "@/lib/global-tracker-report";

type Option = { id: string; name: string };

const STATUS_OPTIONS = ["In Progress", "Closed", "Paid Ready to Start"];

export default function GlobalTrackerFiltersForm({
    filters,
    clients,
}: {
    filters: GlobalTrackerFilters;
    clients: Option[];
}) {
    const router = useRouter();
    const [statuses, setStatuses] = useState(new Set(filters.statuses));
    const [clientId, setClientId] = useState(filters.clientId ?? "");

    function toggleStatus(s: string) {
        const next = new Set(statuses);
        if (next.has(s)) next.delete(s); else next.add(s);
        setStatuses(next);
    }

    function applyFilters() {
        const sp = new URLSearchParams();
        for (const s of statuses) sp.append("status", s);
        if (clientId) sp.set("clientId", clientId);
        router.push(`/reports/global-tracker?${sp.toString()}`);
    }

    return (
        <div className="hui-card p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label className="block text-xs text-hui-textMuted mb-2">Project Status</label>
                    <div className="flex flex-wrap gap-2">
                        {STATUS_OPTIONS.map(s => {
                            const active = statuses.has(s);
                            return (
                                <button key={s} type="button" onClick={() => toggleStatus(s)}
                                    className={`px-3 py-1 rounded-full text-xs font-medium border transition ${active ? "bg-hui-primary/10 border-hui-primary text-hui-primary" : "bg-white border-hui-border text-hui-textMuted hover:bg-slate-50"}`}>
                                    {s}
                                </button>
                            );
                        })}
                    </div>
                    <p className="text-[11px] text-hui-textMuted mt-1">Leave all off to show every status.</p>
                </div>
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">Client</label>
                    <select value={clientId} onChange={e => setClientId(e.target.value)} className="hui-input w-full">
                        <option value="">All clients</option>
                        {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-hui-border">
                <button type="button" onClick={() => { setStatuses(new Set()); setClientId(""); router.push("/reports/global-tracker"); }}
                    className="hui-btn hui-btn-secondary text-sm">Clear</button>
                <button type="button" onClick={applyFilters} className="hui-btn hui-btn-primary text-sm">Apply</button>
            </div>
        </div>
    );
}
