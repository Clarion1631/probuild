"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { formatLocalDateString } from "@/lib/report-utils";

interface TimeEntry {
    id: string;
    startTime: Date;
    endTime: Date | null;
    durationHours: number | null;
    laborCost: number | null;
    user: { id: string; name: string | null };
    project: { id: string; name: string };
    costCode: { code: string; name: string } | null;
}

type Option = { id: string; name: string | null };

interface Props {
    entries: TimeEntry[];
    groupBy: string;
    filterFrom: string;
    filterTo: string;
    filterUserId: string;
    filterProjectId: string;
    users: Option[];
    projects: Option[];
}

export default function TimeBillingClient({ entries, groupBy, filterFrom, filterTo, filterUserId, filterProjectId, users, projects }: Props) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [from, setFrom] = useState(filterFrom);
    const [to, setTo] = useState(filterTo);
    const [userId, setUserId] = useState(filterUserId);
    const [projectId, setProjectId] = useState(filterProjectId);

    const totalHours = entries.reduce((s, e) => s + (e.durationHours ?? 0), 0);
    const totalCost = entries.reduce((s, e) => s + (e.laborCost ?? 0), 0);

    const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
    const fmtH = (n: number) => `${n.toFixed(1)}h`;

    function applyFilters(overrides?: { from?: string; to?: string }) {
        const sp = new URLSearchParams(searchParams.toString());
        sp.set("from", overrides?.from ?? from);
        sp.set("to", overrides?.to ?? to);
        if (userId) sp.set("userId", userId); else sp.delete("userId");
        if (projectId) sp.set("projectId", projectId); else sp.delete("projectId");
        router.push(`${pathname}?${sp.toString()}`);
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

    function switchGroupBy(newGroupBy: string) {
        const sp = new URLSearchParams(searchParams.toString());
        sp.set("groupBy", newGroupBy);
        router.push(`${pathname}?${sp.toString()}`);
    }

    const groups: Record<string, TimeEntry[]> = {};
    for (const e of entries) {
        const key = groupBy === "project" ? e.project.name : (e.user.name ?? "Unknown");
        if (!groups[key]) groups[key] = [];
        groups[key].push(e);
    }
    const groupKeys = Object.keys(groups).sort();

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Time & Billing</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Time entries with labor cost summary · {from} → {to}</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => switchGroupBy("employee")}
                        className={`hui-btn text-sm ${groupBy === "employee" ? "hui-btn-primary" : "hui-btn-secondary"}`}>
                        By Employee
                    </button>
                    <button onClick={() => switchGroupBy("project")}
                        className={`hui-btn text-sm ${groupBy === "project" ? "hui-btn-primary" : "hui-btn-secondary"}`}>
                        By Project
                    </button>
                </div>
            </div>

            {/* Filter form */}
            <div className="hui-card p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mr-2">Quick ranges</span>
                    {(["thisMonth", "lastMonth", "thisQuarter", "lastQuarter", "ytd"] as const).map(p => (
                        <button key={p} type="button" onClick={() => applyPreset(p)}
                            className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-100 text-hui-textMain hover:bg-slate-200 transition">
                            {{ thisMonth: "This Month", lastMonth: "Last Month", thisQuarter: "This Quarter", lastQuarter: "Last Quarter", ytd: "YTD" }[p]}
                        </button>
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
                        <label className="block text-xs text-hui-textMuted mb-1">Employee</label>
                        <select value={userId} onChange={e => setUserId(e.target.value)} className="hui-input w-full">
                            <option value="">All employees</option>
                            {users.map(u => <option key={u.id} value={u.id}>{u.name ?? u.id}</option>)}
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
                <div className="flex justify-end gap-2 pt-2 border-t border-hui-border">
                    <button type="button" onClick={() => { setUserId(""); setProjectId(""); const sp = new URLSearchParams(); sp.set("from", from); sp.set("to", to); sp.set("groupBy", groupBy); router.push(`${pathname}?${sp.toString()}`); }}
                        className="hui-btn hui-btn-secondary text-sm">Clear</button>
                    <button type="button" onClick={() => applyFilters()} className="hui-btn hui-btn-primary text-sm">Apply</button>
                </div>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Hours</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{fmtH(totalHours)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Labor Cost</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{fmt(totalCost)}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Avg Rate</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{totalHours > 0 ? fmt(totalCost / totalHours) + "/hr" : "—"}</p>
                </div>
            </div>

            {/* Groups */}
            {entries.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No time entries in this period.</div>
            ) : (
                groupKeys.map(key => {
                    const groupEntries = groups[key];
                    const groupHours = groupEntries.reduce((s, e) => s + (e.durationHours ?? 0), 0);
                    const groupCost = groupEntries.reduce((s, e) => s + (e.laborCost ?? 0), 0);
                    return (
                        <div key={key} className="hui-card overflow-hidden">
                            <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                                <span className="text-sm font-semibold text-hui-textMain">{key}</span>
                                <span className="text-sm text-hui-textMuted">{fmtH(groupHours)} · {fmt(groupCost)}</span>
                            </div>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                        <th className="px-4 py-2">Date</th>
                                        {groupBy === "employee" && <th className="px-4 py-2">Project</th>}
                                        {groupBy === "project" && <th className="px-4 py-2">Employee</th>}
                                        <th className="px-4 py-2">Cost Code</th>
                                        <th className="px-4 py-2 text-right">Hours</th>
                                        <th className="px-4 py-2 text-right">Labor Cost</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {groupEntries.map(e => (
                                        <tr key={e.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {new Date(e.startTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                            </td>
                                            {groupBy === "employee" && (
                                                <td className="px-4 py-3 text-hui-textMain">
                                                    <Link href={`/projects/${e.project.id}`} className="hover:underline">{e.project.name}</Link>
                                                </td>
                                            )}
                                            {groupBy === "project" && (
                                                <td className="px-4 py-3 text-hui-textMuted">{e.user.name ?? "—"}</td>
                                            )}
                                            <td className="px-4 py-3 text-hui-textMuted text-xs">{e.costCode ? `${e.costCode.code} · ${e.costCode.name}` : "—"}</td>
                                            <td className="px-4 py-3 text-right text-hui-textMain">{e.durationHours != null ? fmtH(e.durationHours) : "—"}</td>
                                            <td className="px-4 py-3 text-right font-semibold text-hui-textMain">{e.laborCost != null ? fmt(e.laborCost) : "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    );
                })
            )}
        </div>
    );
}
