"use client";
export const dynamic = "force-dynamic";

import { useState, useMemo, useEffect } from "react";
import Avatar from "@/components/Avatar";
import { getLeads } from "@/lib/actions";
import Link from "next/link";
import AddLeadButton from "./AddLeadButton";
import LeadStageDropdown from "./[id]/LeadStageDropdown";
import { toast } from "sonner";

type SortKey = "name" | "stage" | "client" | "source" | "projectType" | "targetRevenue" | "lastActivity";
type SortDir = "asc" | "desc";
type TabKey = "All" | "Hot" | "Won" | "Lost";

// "Hot" = mid-funnel active stages
const HOT_STAGES = ["Connected", "Estimate Sent"];
const WON_STAGE = "Won";
const LOST_STAGE = "Closed";

function TabButton({ active, onClick, count, children }: {
    active: boolean; onClick: () => void; count?: number; children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                active
                    ? "border-hui-primary text-hui-primary"
                    : "border-transparent text-hui-textMuted hover:text-hui-textMain"
            }`}
        >
            {children}
            {count !== undefined && (
                <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                    active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
                }`}>
                    {count}
                </span>
            )}
        </button>
    );
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
    if (sortKey !== col) return (
        <svg className="w-3 h-3 text-slate-300 ml-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
    );
    return (
        <svg className="w-3 h-3 text-hui-primary ml-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {sortDir === "asc"
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />}
        </svg>
    );
}

type ScoreResult = { score: number; rating: string; summary: string; topFactors: string[] };

export default function LeadsPage() {
    const [leads, setLeads] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<TabKey>("All");
    const [searchTerm, setSearchTerm] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("lastActivity");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [sourceFilter, setSourceFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [scores, setScores] = useState<Record<string, ScoreResult | "loading">>({});

    useEffect(() => {
        getLeads().then(data => {
            setLeads(data);
            setLoading(false);
        });
    }, []);

    function handleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir(d => d === "asc" ? "desc" : "asc");
        } else {
            setSortKey(key);
            setSortDir("asc");
        }
    }

    async function scoreLead(leadId: string, e: React.MouseEvent) {
        e.stopPropagation();
        setScores(prev => ({ ...prev, [leadId]: "loading" }));
        try {
            const res = await fetch(`/api/leads/${leadId}/score`, { method: "POST" });
            if (!res.ok) throw new Error("Score failed");
            const data: ScoreResult = await res.json();
            setScores(prev => ({ ...prev, [leadId]: data }));
            toast.success(`Lead scored: ${data.score}/100 (${data.rating})`);
        } catch {
            setScores(prev => {
                const next = { ...prev };
                delete next[leadId];
                return next;
            });
            toast.error("Scoring failed. Try again.");
        }
    }

    // Derive filter options from data
    const sources = useMemo(() => [...new Set(leads.map(l => l.source).filter(Boolean))], [leads]);
    const types = useMemo(() => [...new Set(leads.map(l => l.projectType).filter(Boolean))], [leads]);

    // Tab counts
    const tabCounts = useMemo(() => ({
        All: leads.length,
        Hot: leads.filter(l => HOT_STAGES.includes(l.stage)).length,
        Won: leads.filter(l => l.stage === WON_STAGE).length,
        Lost: leads.filter(l => l.stage === LOST_STAGE).length,
    }), [leads]);

    const filtered = useMemo(() => {
        let list = leads;

        // Tab filter
        if (activeTab === "Hot") list = list.filter(l => HOT_STAGES.includes(l.stage));
        else if (activeTab === "Won") list = list.filter(l => l.stage === WON_STAGE);
        else if (activeTab === "Lost") list = list.filter(l => l.stage === LOST_STAGE);

        // Search
        if (searchTerm) {
            const q = searchTerm.toLowerCase();
            list = list.filter(l =>
                l.name.toLowerCase().includes(q) ||
                (l.client?.name || "").toLowerCase().includes(q) ||
                (l.location || "").toLowerCase().includes(q) ||
                (l.source || "").toLowerCase().includes(q)
            );
        }

        // Source filter
        if (sourceFilter) list = list.filter(l => l.source === sourceFilter);

        // Type filter
        if (typeFilter) list = list.filter(l => l.projectType === typeFilter);

        // Sort
        list = [...list].sort((a, b) => {
            let aVal: any, bVal: any;
            switch (sortKey) {
                case "name": aVal = a.name; bVal = b.name; break;
                case "stage": aVal = a.stage; bVal = b.stage; break;
                case "client": aVal = a.client?.name || ""; bVal = b.client?.name || ""; break;
                case "source": aVal = a.source || ""; bVal = b.source || ""; break;
                case "projectType": aVal = a.projectType || ""; bVal = b.projectType || ""; break;
                case "targetRevenue": aVal = a.targetRevenue || 0; bVal = b.targetRevenue || 0; break;
                case "lastActivity":
                    aVal = new Date(a.lastActivityAt || a.createdAt).getTime();
                    bVal = new Date(b.lastActivityAt || b.createdAt).getTime();
                    break;
            }
            if (typeof aVal === "string") return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            return sortDir === "asc" ? aVal - bVal : bVal - aVal;
        });

        return list;
    }, [leads, activeTab, searchTerm, sourceFilter, typeFilter, sortKey, sortDir]);

    const totalRevenue = leads.reduce((sum, l) => sum + (l.targetRevenue || 0), 0);
    const hotCount = tabCounts.Hot;
    const wonRevenue = leads.filter(l => l.stage === WON_STAGE).reduce((sum, l) => sum + (l.targetRevenue || 0), 0);

    const SORT_HEADER = ({ col, children }: { col: SortKey; children: React.ReactNode }) => (
        <th
            scope="col"
            className="px-6 py-3 text-left text-xs font-semibold text-hui-textMuted uppercase tracking-wider cursor-pointer select-none hover:text-hui-textMain"
            onClick={() => handleSort(col)}
        >
            {children}
            <SortIcon col={col} sortKey={sortKey} sortDir={sortDir} />
        </th>
    );

    return (
        <div className="max-w-7xl mx-auto py-8 px-6">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Leads</h1>
                    <p className="text-sm text-hui-textMuted mt-1">{leads.length} total lead{leads.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="flex items-center gap-3">
                    <Link href="/settings/company" className="hui-btn hui-btn-secondary">Contact Form</Link>
                    <Link href="/reports" className="hui-btn hui-btn-secondary">Insights</Link>
                    <AddLeadButton />
                </div>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Total Leads</p>
                    <p className="text-2xl font-bold text-hui-textMain">{leads.length}</p>
                    <p className="text-xs text-hui-textMuted mt-1">all time</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Hot</p>
                    <p className="text-2xl font-bold text-amber-600">{hotCount}</p>
                    <p className="text-xs text-hui-textMuted mt-1">connected or estimating</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Won</p>
                    <p className="text-2xl font-bold text-hui-primary">{tabCounts.Won}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{wonRevenue > 0 ? `$${wonRevenue.toLocaleString()}` : "no revenue yet"}</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Pipeline Value</p>
                    <p className="text-2xl font-bold text-hui-textMain">${totalRevenue > 0 ? totalRevenue.toLocaleString() : "0"}</p>
                    <p className="text-xs text-hui-textMuted mt-1">estimated revenue</p>
                </div>
            </div>

            {/* Tabs + Search */}
            <div className="flex items-end justify-between border-b border-hui-border mb-4">
                <div className="flex gap-0">
                    {(["All", "Hot", "Won", "Lost"] as TabKey[]).map(tab => (
                        <TabButton
                            key={tab}
                            active={activeTab === tab}
                            onClick={() => setActiveTab(tab)}
                            count={tabCounts[tab]}
                        >
                            {tab}
                        </TabButton>
                    ))}
                </div>
                <div className="flex items-center gap-2 pb-2">
                    <input
                        type="text"
                        placeholder="Search leads..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                        className="hui-input w-52"
                    />
                    {sources.length > 0 && (
                        <select
                            value={sourceFilter}
                            onChange={e => setSourceFilter(e.target.value)}
                            className="hui-input w-auto"
                        >
                            <option value="">All Sources</option>
                            {sources.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    )}
                    {types.length > 0 && (
                        <select
                            value={typeFilter}
                            onChange={e => setTypeFilter(e.target.value)}
                            className="hui-input w-auto"
                        >
                            <option value="">All Types</option>
                            {types.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                    )}
                </div>
            </div>

            {/* Table */}
            <div className="hui-card overflow-hidden">
                {loading ? (
                    <div className="p-12 text-center text-hui-textMuted">Loading leads...</div>
                ) : filtered.length === 0 ? (
                    <div className="p-16 flex flex-col items-center">
                        <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mb-3">
                            <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                            </svg>
                        </div>
                        <h3 className="text-base font-semibold text-hui-textMain mb-1">
                            {searchTerm ? "No matching leads" : `No ${activeTab === "All" ? "" : activeTab.toLowerCase() + " "}leads`}
                        </h3>
                        <p className="text-sm text-hui-textMuted mb-4">
                            {searchTerm ? "Try a different search term." : "Add your first lead to start tracking opportunities."}
                        </p>
                        {!searchTerm && activeTab === "All" && <AddLeadButton />}
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 border-b border-hui-border">
                            <tr>
                                <SORT_HEADER col="name">Lead Name</SORT_HEADER>
                                <SORT_HEADER col="stage">Stage</SORT_HEADER>
                                <SORT_HEADER col="client">Client</SORT_HEADER>
                                <SORT_HEADER col="projectType">Project Type</SORT_HEADER>
                                <SORT_HEADER col="targetRevenue">Revenue</SORT_HEADER>
                                <SORT_HEADER col="source">Source</SORT_HEADER>
                                <SORT_HEADER col="lastActivity">Last Activity</SORT_HEADER>
                                <th scope="col" className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider text-center">AI Score</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filtered.map((l: any) => {
                                const scoreResult = scores[l.id];
                                const isScoring = scoreResult === "loading";
                                const scored = scoreResult && scoreResult !== "loading" ? scoreResult as ScoreResult : null;

                                return (
                                    <tr
                                        key={l.id}
                                        className="hover:bg-slate-50 transition cursor-pointer group"
                                        onClick={() => window.location.href = `/leads/${l.id}`}
                                    >
                                        <td className="px-6 py-4 font-medium text-hui-textMain group-hover:text-hui-primary transition">
                                            {l.name}
                                        </td>
                                        <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                                            <LeadStageDropdown leadId={l.id} currentStage={l.stage} variant="pill" />
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <Avatar name={l.client?.name || "?"} color="blue" />
                                                <span className="text-sm text-hui-textMain">{l.client?.name || "—"}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-hui-textMuted">{l.projectType || "—"}</td>
                                        <td className="px-6 py-4 text-hui-textMuted">
                                            {l.targetRevenue ? `$${Number(l.targetRevenue).toLocaleString()}` : "—"}
                                        </td>
                                        <td className="px-6 py-4 text-hui-textMuted">{l.source || "—"}</td>
                                        <td className="px-6 py-4 text-hui-textMuted text-xs">
                                            {new Date(l.lastActivityAt || l.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                                        </td>
                                        <td className="px-6 py-4 text-center" onClick={e => e.stopPropagation()}>
                                            {scored ? (
                                                <div className="flex flex-col items-center gap-1" title={scored.summary}>
                                                    <span className={`text-sm font-bold ${scored.score >= 70 ? "text-green-600" : scored.score >= 40 ? "text-amber-600" : "text-slate-500"}`}>
                                                        {scored.score}
                                                    </span>
                                                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                                        scored.rating === "Hot" ? "bg-red-100 text-red-700"
                                                        : scored.rating === "Warm" ? "bg-amber-100 text-amber-700"
                                                        : "bg-slate-100 text-slate-600"
                                                    }`}>
                                                        {scored.rating}
                                                    </span>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={e => scoreLead(l.id, e)}
                                                    disabled={isScoring}
                                                    className="text-xs font-semibold text-purple-600 bg-purple-50 hover:bg-purple-100 px-2.5 py-1 rounded-md transition disabled:opacity-50 flex items-center gap-1 mx-auto"
                                                >
                                                    {isScoring ? (
                                                        <span className="w-3 h-3 border-2 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
                                                    ) : (
                                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                                        </svg>
                                                    )}
                                                    {isScoring ? "Scoring..." : "AI Score"}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
