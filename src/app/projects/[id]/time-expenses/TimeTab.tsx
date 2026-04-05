"use client";

import { useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { deleteTimeEntry, getTimeEntries } from "@/lib/time-expense-actions";

interface TimeEntry {
    id: string;
    userId: string;
    projectId: string;
    startTime: string | Date;
    durationHours: number | null;
    laborCost: any;
    user: { id: string; name: string | null; email: string; hourlyRate?: any };
    costCode: { id: string; name: string; code: string } | null;
}

interface Props {
    projectId: string;
    entries: TimeEntry[];
    onAddNew: () => void;
    currentUser: { id: string; role: string; name: string };
}

function num(v: unknown): number {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "object" && "toNumber" in (v as Record<string, unknown>)
        ? (v as { toNumber: () => number }).toNumber()
        : Number(v);
    return isNaN(n) ? 0 : n;
}

function fmtMoney(v: number): string {
    return "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function TimeTab({ projectId, entries: initialEntries, onAddNew, currentUser }: Props) {
    const [entries, setEntries] = useState<TimeEntry[]>(initialEntries);
    const [filter, setFilter] = useState("");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const refreshEntries = useCallback(async () => {
        try {
            const fresh = await getTimeEntries(projectId);
            setEntries(fresh as TimeEntry[]);
        } catch { /* server revalidation will handle it */ }
    }, [projectId]);

    const summary = useMemo(() => {
        let totalHours = 0;
        let totalCost = 0;
        for (const e of entries) {
            totalHours += num(e.durationHours);
            totalCost += num(e.laborCost);
        }
        return { totalHours, totalCost, count: entries.length };
    }, [entries]);

    const filtered = useMemo(() => {
        if (!filter) return entries;
        const q = filter.toLowerCase();
        return entries.filter(e =>
            (e.user.name || e.user.email).toLowerCase().includes(q) ||
            e.costCode?.name.toLowerCase().includes(q) ||
            e.costCode?.code.toLowerCase().includes(q)
        );
    }, [entries, filter]);

    function toggleSelect(id: string) {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function toggleAll() {
        if (selectedIds.size === filtered.length) setSelectedIds(new Set());
        else setSelectedIds(new Set(filtered.map(e => e.id)));
    }

    async function handleDelete(id: string) {
        if (!confirm("Delete this time entry?")) return;
        try {
            await deleteTimeEntry(id);
            toast.success("Entry deleted");
            await refreshEntries();
        } catch (err: any) {
            toast.error(err.message || "Failed to delete");
        }
    }

    function handleExport() {
        const headers = ["Date", "Team Member", "Cost Code", "Hours", "Cost"];
        const rows = [headers.join(",")];
        for (const e of filtered) {
            rows.push([
                new Date(e.startTime).toLocaleDateString(),
                `"${e.user.name || e.user.email}"`,
                `"${e.costCode ? `${e.costCode.code} — ${e.costCode.name}` : ""}"`,
                num(e.durationHours).toFixed(2),
                num(e.laborCost).toFixed(2),
            ].join(","));
        }
        const blob = new Blob([rows.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "time-entries.csv";
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Time entries exported");
    }

    return (
        <div>
            {/* Summary Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-gradient-to-br from-blue-50 to-blue-100/50 border border-blue-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Duration</div>
                    <div className="text-xl font-bold text-blue-700">{summary.totalHours.toFixed(1)}h</div>
                    <div className="text-xs text-slate-500">{summary.count} entries</div>
                </div>
                <div className="bg-gradient-to-br from-emerald-50 to-emerald-100/50 border border-emerald-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Cost</div>
                    <div className="text-xl font-bold text-emerald-700">{fmtMoney(summary.totalCost)}</div>
                </div>
                <div className="bg-gradient-to-br from-amber-50 to-amber-100/50 border border-amber-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Billable</div>
                    <div className="text-xl font-bold text-amber-700">{fmtMoney(summary.totalCost)}</div>
                </div>
                <div className="bg-gradient-to-br from-purple-50 to-purple-100/50 border border-purple-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Invoiced</div>
                    <div className="text-xl font-bold text-purple-700">$0.00</div>
                    <div className="text-xs text-slate-500">0% of billable</div>
                </div>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        placeholder="Filter by name or cost code..."
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        className="hui-input text-sm py-1.5 px-3 w-64"
                    />
                    {selectedIds.size > 0 && (
                        <button
                            onClick={() => toast.info("Create Invoice from selected entries — coming soon")}
                            className="hui-btn hui-btn-green text-sm px-3 py-1.5 flex items-center gap-1.5"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            Create Invoice ({selectedIds.size})
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={handleExport} className="hui-btn bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm px-3 py-1.5">
                        Export
                    </button>
                    <button onClick={onAddNew} className="hui-btn hui-btn-green text-sm px-3 py-1.5 flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        New Entry
                    </button>
                </div>
            </div>

            {/* Table */}
            {filtered.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                    <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h3 className="text-lg font-semibold text-slate-600 mb-1">No time entries yet</h3>
                    <p className="text-sm text-slate-400">Click "New Entry" to log time for this project.</p>
                </div>
            ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-200">
                                    <th className="px-4 py-3 text-left w-10">
                                        <input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={toggleAll} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary" />
                                    </th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Date</th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Team Member</th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Cost Code</th>
                                    <th className="px-4 py-3 text-right font-semibold text-slate-600 uppercase text-xs tracking-wider">Hours</th>
                                    <th className="px-4 py-3 text-right font-semibold text-slate-600 uppercase text-xs tracking-wider">Cost</th>
                                    <th className="px-4 py-3 text-right font-semibold text-slate-600 uppercase text-xs tracking-wider w-20"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filtered.map(entry => (
                                    <tr key={entry.id} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3">
                                            <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={() => toggleSelect(entry.id)} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary" />
                                        </td>
                                        <td className="px-4 py-3 text-slate-600 tabular-nums">{new Date(entry.startTime).toLocaleDateString()}</td>
                                        <td className="px-4 py-3 font-medium text-hui-textMain">{entry.user.name || entry.user.email}</td>
                                        <td className="px-4 py-3 text-slate-600">{entry.costCode ? `${entry.costCode.code} — ${entry.costCode.name}` : "—"}</td>
                                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{num(entry.durationHours).toFixed(1)}h</td>
                                        <td className="px-4 py-3 text-right tabular-nums font-medium text-hui-textMain">{fmtMoney(num(entry.laborCost))}</td>
                                        <td className="px-4 py-3 text-right">
                                            {(currentUser.role === "ADMIN" || currentUser.role === "MANAGER") && (
                                                <button onClick={() => handleDelete(entry.id)} className="text-slate-400 hover:text-red-500 transition" title="Delete">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                                    </svg>
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
