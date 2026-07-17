"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PaymentsFilters } from "@/lib/payments-report";
import { formatLocalDateString } from "@/lib/report-utils";

type Option = { id: string; name: string };

const METHOD_OPTIONS = [
    { value: "card", label: "Card" },
    { value: "ach", label: "ACH / Bank Transfer" },
    { value: "check", label: "Check" },
    { value: "cash", label: "Cash" },
];

export default function PaymentsFiltersForm({
    filters,
    clients,
    projects,
}: {
    filters: PaymentsFilters;
    clients: Option[];
    projects: Option[];
}) {
    const router = useRouter();
    const [from, setFrom] = useState(formatLocalDateString(filters.from));
    const [to, setTo] = useState(formatLocalDateString(filters.to));
    const [clientId, setClientId] = useState(filters.clientId ?? "");
    const [projectId, setProjectId] = useState(filters.projectId ?? "");
    const [methods, setMethods] = useState(new Set(filters.methods));

    function toggleMethod(m: string) {
        const next = new Set(methods);
        if (next.has(m)) next.delete(m); else next.add(m);
        setMethods(next);
    }

    function applyFilters(overrides?: { from?: string; to?: string }) {
        const sp = new URLSearchParams();
        sp.set("from", overrides?.from ?? from);
        sp.set("to", overrides?.to ?? to);
        if (clientId) sp.set("clientId", clientId);
        if (projectId) sp.set("projectId", projectId);
        for (const m of methods) sp.append("method", m);
        router.push(`/reports/payments?${sp.toString()}`);
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

    return (
        <div className="hui-card p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mr-2">Quick ranges</span>
                {(["thisMonth", "lastMonth", "thisQuarter", "lastQuarter", "ytd"] as const).map(p => (
                    <PresetButton key={p} onClick={() => applyPreset(p)} label={{ thisMonth: "This Month", lastMonth: "Last Month", thisQuarter: "This Quarter", lastQuarter: "Last Quarter", ytd: "YTD" }[p]} />
                ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">From</label>
                    <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="hui-input w-full" />
                </div>
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">To</label>
                    <input type="date" value={to} onChange={e => setTo(e.target.value)} className="hui-input w-full" />
                </div>
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">Client</label>
                    <select value={clientId} onChange={e => setClientId(e.target.value)} className="hui-input w-full">
                        <option value="">All clients</option>
                        {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-xs text-hui-textMuted mb-1">Project</label>
                    <select value={projectId} onChange={e => setProjectId(e.target.value)} className="hui-input w-full">
                        <option value="">All projects</option>
                        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                </div>
            </div>

            <div>
                <label className="block text-xs text-hui-textMuted mb-1">Payment Methods</label>
                <div className="flex flex-wrap gap-2">
                    {METHOD_OPTIONS.map(opt => {
                        const active = methods.has(opt.value);
                        return (
                            <button key={opt.value} type="button" onClick={() => toggleMethod(opt.value)}
                                className={`px-3 py-1 rounded-full text-xs font-medium border transition ${active ? "bg-hui-primary/10 border-hui-primary text-hui-primary" : "bg-white border-hui-border text-hui-textMuted hover:bg-slate-50"}`}>
                                {opt.label}
                            </button>
                        );
                    })}
                </div>
                <p className="text-[11px] text-hui-textMuted mt-1">Leave all off to include every method.</p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-hui-border">
                <button type="button" onClick={() => { setClientId(""); setProjectId(""); setMethods(new Set()); router.push(`/reports/payments?from=${from}&to=${to}`); }}
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
