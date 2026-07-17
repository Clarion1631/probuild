"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import type { TransactionsFilters, TransactionType } from "@/lib/transactions-report";
import { formatLocalDateString } from "@/lib/report-utils";

type Option = { id: string; name: string };

type SerializedRow = {
    id: string;
    date: string;
    description: string;
    type: "Income" | "Expense";
    amount: number;
    projectName: string;
    projectId: string | null;
    category: string;
};

type ProjectGroup = {
    key: string;
    projectName: string;
    projectId: string | null;
    incoming: number;
    outgoing: number;
    rows: SerializedRow[];
};

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

export default function TransactionsFiltersForm({
    filters,
    rows,
    byProject,
    projects,
}: {
    filters: TransactionsFilters;
    rows: SerializedRow[];
    byProject: ProjectGroup[];
    projects: Option[];
}) {
    const router = useRouter();
    const [from, setFrom] = useState(formatLocalDateString(filters.from));
    const [to, setTo] = useState(formatLocalDateString(filters.to));
    const [projectId, setProjectId] = useState(filters.projectId ?? "");
    const [type, setType] = useState<TransactionType>(filters.type);
    const [tab, setTab] = useState<"all" | "project">(filters.tab);

    function buildParams(overrides?: { from?: string; to?: string; tab?: "all" | "project" }) {
        const sp = new URLSearchParams();
        sp.set("from", overrides?.from ?? from);
        sp.set("to", overrides?.to ?? to);
        if (projectId) sp.set("projectId", projectId);
        if (type !== "both") sp.set("type", type);
        const activeTab = overrides?.tab ?? tab;
        if (activeTab !== "all") sp.set("tab", activeTab);
        return sp;
    }

    function applyFilters(overrides?: { from?: string; to?: string }) {
        router.push(`/reports/transactions?${buildParams(overrides).toString()}`);
    }

    function switchTab(newTab: "all" | "project") {
        setTab(newTab);
        router.push(`/reports/transactions?${buildParams({ tab: newTab }).toString()}`);
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

    const typeBtnClass = (t: TransactionType) =>
        `px-3 py-1.5 rounded-md text-sm font-medium transition ${type === t ? "bg-hui-primary text-white" : "bg-slate-100 text-hui-textMain hover:bg-slate-200"}`;

    return (
        <>
            {/* Filter card */}
            <div className="hui-card p-4 space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mr-2">Show</span>
                    <button type="button" onClick={() => setType("both")} className={typeBtnClass("both")}>All</button>
                    <button type="button" onClick={() => setType("income")} className={typeBtnClass("income")}>Income only</button>
                    <button type="button" onClick={() => setType("expense")} className={typeBtnClass("expense")}>Expenses only</button>
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
                    <button type="button" onClick={() => { setProjectId(""); setType("both"); router.push(`/reports/transactions?from=${from}&to=${to}`); }}
                        className="hui-btn hui-btn-secondary text-sm">Clear</button>
                    <button type="button" onClick={() => applyFilters()} className="hui-btn hui-btn-primary text-sm">Apply</button>
                </div>
            </div>

            {/* Tab bar */}
            <div className="flex border-b border-hui-border">
                <TabButton active={tab === "all"} onClick={() => switchTab("all")}>All Transactions</TabButton>
                <TabButton active={tab === "project"} onClick={() => switchTab("project")}>By Project</TabButton>
            </div>

            {/* All Transactions tab */}
            {tab === "all" && (
                rows.length === 0 ? (
                    <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No transactions in this period.</div>
                ) : (
                    <div className="hui-card overflow-hidden">
                        <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                            <span className="text-sm font-semibold text-hui-textMain">All Transactions</span>
                            <span className="text-sm text-hui-textMuted">{rows.length} transaction{rows.length !== 1 ? "s" : ""}</span>
                        </div>
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                    <th className="px-4 py-2">Date</th>
                                    <th className="px-4 py-2">Description</th>
                                    <th className="px-4 py-2">Type</th>
                                    <th className="px-4 py-2">Project</th>
                                    <th className="px-4 py-2">Category</th>
                                    <th className="px-4 py-2 text-right">Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => (
                                    <tr key={row.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                        <td className="px-4 py-3 text-hui-textMuted">
                                            {new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">{row.description}</td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${row.type === "Income" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                                                {row.type}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMain">
                                            {row.projectId ? (
                                                <Link href={`/projects/${row.projectId}`} className="hover:underline">{row.projectName}</Link>
                                            ) : (
                                                <span className="text-hui-textMuted">{row.projectName}</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-hui-textMuted">{row.category}</td>
                                        <td className={`px-4 py-3 text-right font-semibold ${row.type === "Income" ? "text-green-600" : "text-red-500"}`}>
                                            {row.type === "Income" ? "+" : "-"}{fmt(row.amount)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )
            )}

            {/* By Project tab */}
            {tab === "project" && (
                byProject.length === 0 ? (
                    <div className="hui-card p-12 text-center text-hui-textMuted text-sm">No transactions in this period.</div>
                ) : (
                    byProject.map(group => (
                        <div key={group.key} className="hui-card overflow-hidden">
                            <div className="px-4 py-3 border-b border-hui-border bg-hui-surface flex items-center justify-between">
                                <span className="text-sm font-semibold text-hui-textMain">
                                    {group.projectId ? (
                                        <Link href={`/projects/${group.projectId}`} className="hover:underline">{group.projectName}</Link>
                                    ) : group.projectName}
                                </span>
                                <div className="flex gap-4 text-sm">
                                    <span className="text-green-600">In: {fmt(group.incoming)}</span>
                                    <span className="text-red-500">Out: {fmt(group.outgoing)}</span>
                                    <span className={group.incoming - group.outgoing >= 0 ? "text-green-600 font-semibold" : "text-red-500 font-semibold"}>
                                        Net: {fmt(group.incoming - group.outgoing)}
                                    </span>
                                </div>
                            </div>
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border">
                                        <th className="px-4 py-2">Date</th>
                                        <th className="px-4 py-2">Description</th>
                                        <th className="px-4 py-2">Type</th>
                                        <th className="px-4 py-2">Category</th>
                                        <th className="px-4 py-2 text-right">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {group.rows.map(row => (
                                        <tr key={row.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                            <td className="px-4 py-3 text-hui-textMuted">
                                                {new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMain">{row.description}</td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${row.type === "Income" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                                                    {row.type}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-hui-textMuted">{row.category}</td>
                                            <td className={`px-4 py-3 text-right font-semibold ${row.type === "Income" ? "text-green-600" : "text-red-500"}`}>
                                                {row.type === "Income" ? "+" : "-"}{fmt(row.amount)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ))
                )
            )}
        </>
    );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
        <button onClick={onClick}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${active ? "border-hui-primary text-hui-primary" : "border-transparent text-hui-textMuted hover:text-hui-textMain"}`}>
            {children}
        </button>
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
