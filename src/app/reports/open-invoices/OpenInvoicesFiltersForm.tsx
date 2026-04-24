"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OpenInvoicesFilters } from "@/lib/open-invoices-report";

type Option = { id: string; name: string };

const STATUS_OPTIONS = ["Issued", "Overdue", "Partially Paid"];

export default function OpenInvoicesFiltersForm({
    filters,
    clients,
    projects,
}: {
    filters: OpenInvoicesFilters;
    clients: Option[];
    projects: Option[];
}) {
    const router = useRouter();
    const [clientId, setClientId] = useState(filters.clientId ?? "");
    const [projectId, setProjectId] = useState(filters.projectId ?? "");
    // Empty = all statuses (default). Non-empty = filter to those statuses.
    const [statuses, setStatuses] = useState(new Set(filters.statuses));

    function toggleStatus(s: string) {
        const next = new Set(statuses);
        if (next.has(s)) next.delete(s); else next.add(s);
        setStatuses(next);
    }

    function applyFilters() {
        const sp = new URLSearchParams();
        if (clientId) sp.set("clientId", clientId);
        if (projectId) sp.set("projectId", projectId);
        for (const s of statuses) sp.append("status", s);
        router.push(`/reports/open-invoices?${sp.toString()}`);
    }

    return (
        <div className="hui-card p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
                <label className="block text-xs text-hui-textMuted mb-1">Status</label>
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

            <div className="flex justify-end gap-2 pt-2 border-t border-hui-border">
                <button type="button" onClick={() => { setClientId(""); setProjectId(""); setStatuses(new Set()); router.push("/reports/open-invoices"); }}
                    className="hui-btn hui-btn-secondary text-sm">Clear</button>
                <button type="button" onClick={applyFilters} className="hui-btn hui-btn-primary text-sm">Apply</button>
            </div>
        </div>
    );
}
