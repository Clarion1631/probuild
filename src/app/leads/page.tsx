"use client";
export const dynamic = "force-dynamic";

import { useState, useMemo, useEffect } from "react";
import Avatar from "@/components/Avatar";
import { getLeads, deleteLead, deleteLeads, copyLeads } from "@/lib/actions";
import Link from "next/link";
import AddLeadButton from "./AddLeadButton";
import LeadStageDropdown from "./[id]/LeadStageDropdown";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import BulkActionBar, { DeleteIcon, CopyIcon } from "@/components/BulkActionBar";

type SortKey = "name" | "stage" | "client" | "source" | "projectType" | "targetRevenue" | "lastActivity";
type SortDir = "asc" | "desc";
type TabKey = "All" | "New" | "Hot" | "Qualified" | "Won" | "Lost" | "Snoozed" | "Archived";

// "Hot" = mid-funnel active stages
const HOT_STAGES = ["Connected", "Estimate Sent"];
const QUALIFIED_STAGES = ["Followed Up", "Connected"];
const WON_STAGE = "Won";
const LOST_STAGE = "Closed";
const NEW_STAGE = "New";

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

export default function LeadsPage() {
    const [leads, setLeads] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<TabKey>("All");
    const [searchTerm, setSearchTerm] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("lastActivity");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [sourceFilter, setSourceFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isBulking, setIsBulking] = useState(false);

    useEffect(() => {
        getLeads().then(data => {
            setLeads(data);
            setLoading(false);
        }).catch((err) => {
            console.error("[Leads] Failed to load:", err);
            setLoadError("Failed to load leads. Please refresh the page.");
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

    async function handleDelete(lead: any, e: React.MouseEvent) {
        e.stopPropagation();
        if (lead.project) {
            toast.error("This lead has a linked project. Delete the project first before deleting the lead.");
            return;
        }
        if (!confirm(`Delete "${lead.name}"? This cannot be undone.`)) return;
        setDeletingId(lead.id);
        try {
            await deleteLead(lead.id);
            setLeads(prev => prev.filter(l => l.id !== lead.id));
            toast.success("Lead deleted");
        } catch (err: any) {
            toast.error(err?.message || "Failed to delete lead");
        } finally {
            setDeletingId(null);
        }
    }

    async function refreshLeads() {
        try {
            const data = await getLeads();
            setLeads(data);
        } catch (err) {
            console.error("[Leads] Failed to refresh:", err);
        }
    }

    async function handleBulkDelete() {
        if (selectedIds.length === 0) return;
        if (!confirm(`Delete ${selectedIds.length} lead${selectedIds.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
        setIsBulking(true);
        try {
            const res = await deleteLeads(selectedIds);
            setSelectedIds([]);
            await refreshLeads();
            if (res.skipped.length > 0) {
                toast.success(`Deleted ${res.deleted} · ${res.skipped.length} skipped (${res.skipped[0].reason})`);
            } else {
                toast.success(`Deleted ${res.deleted} lead${res.deleted === 1 ? "" : "s"}`);
            }
        } catch (err: any) {
            toast.error(err?.message || "Failed to delete leads");
        } finally {
            setIsBulking(false);
        }
    }

    async function handleBulkCopy() {
        if (selectedIds.length === 0) return;
        setIsBulking(true);
        try {
            const res = await copyLeads(selectedIds);
            setSelectedIds([]);
            await refreshLeads();
            if (res.created.length === 0) {
                toast.error("No leads were copied");
            } else if (res.skipped.length > 0) {
                toast.success(`Copied ${res.created.length} lead${res.created.length === 1 ? "" : "s"} · ${res.skipped.length} skipped`);
            } else {
                toast.success(`Copied ${res.created.length} lead${res.created.length === 1 ? "" : "s"}`);
            }
        } catch (err: any) {
            toast.error(err?.message || "Failed to copy leads");
        } finally {
            setIsBulking(false);
        }
    }

    // Derive filter options from data
    const sources = useMemo(() => [...new Set(leads.map(l => l.source).filter(Boolean))], [leads]);
    const types = useMemo(() => [...new Set(leads.map(l => l.projectType).filter(Boolean))], [leads]);

    // Separate active leads from archived/snoozed for tab counting
    const activeLeads = useMemo(() => leads.filter(l => !l.isArchived), [leads]);
    const now = new Date();

    // Tab counts
    const tabCounts = useMemo(() => ({
        All: activeLeads.length,
        New: activeLeads.filter(l => l.stage === NEW_STAGE).length,
        Hot: activeLeads.filter(l => HOT_STAGES.includes(l.stage)).length,
        Qualified: activeLeads.filter(l => QUALIFIED_STAGES.includes(l.stage)).length,
        Won: activeLeads.filter(l => l.stage === WON_STAGE).length,
        Lost: activeLeads.filter(l => l.stage === LOST_STAGE).length,
        Snoozed: leads.filter(l => l.snoozedUntil && new Date(l.snoozedUntil) > now && !l.isArchived).length,
        Archived: leads.filter(l => l.isArchived).length,
    }), [leads, activeLeads]);

    const filtered = useMemo(() => {
        let list = leads;

        // Tab filter
        if (activeTab === "Archived") {
            list = list.filter(l => l.isArchived);
        } else if (activeTab === "Snoozed") {
            list = list.filter(l => l.snoozedUntil && new Date(l.snoozedUntil) > now && !l.isArchived);
        } else {
            // All active tabs exclude archived leads
            list = list.filter(l => !l.isArchived);
            if (activeTab === "New") list = list.filter(l => l.stage === NEW_STAGE);
            else if (activeTab === "Hot") list = list.filter(l => HOT_STAGES.includes(l.stage));
            else if (activeTab === "Qualified") list = list.filter(l => QUALIFIED_STAGES.includes(l.stage));
            else if (activeTab === "Won") list = list.filter(l => l.stage === WON_STAGE);
            else if (activeTab === "Lost") list = list.filter(l => l.stage === LOST_STAGE);
        }

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

    const totalRevenue = leads.reduce((sum, l) => sum + Number(l.targetRevenue || 0), 0);
    const hotCount = tabCounts.Hot;
    const wonRevenue = leads.filter(l => l.stage === WON_STAGE).reduce((sum, l) => sum + Number(l.targetRevenue || 0), 0);

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
                    <p className="text-xs text-hui-textMuted mt-1">{wonRevenue > 0 ? `${formatCurrency(wonRevenue)}` : "no revenue yet"}</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Pipeline Value</p>
                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(totalRevenue)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">estimated revenue</p>
                </div>
            </div>

            {/* Tabs + Search */}
            <div className="flex items-end justify-between border-b border-hui-border mb-4">
                <div className="flex gap-0 overflow-x-auto scrollbar-none" style={{ scrollbarWidth: "none" }}>
                    {(["All", "New", "Hot", "Qualified", "Won", "Lost"] as TabKey[]).map(tab => (
                        <TabButton
                            key={tab}
                            active={activeTab === tab}
                            onClick={() => setActiveTab(tab)}
                            count={tabCounts[tab]}
                        >
                            {tab}
                        </TabButton>
                    ))}
                    <div className="w-px bg-slate-200 mx-1 my-2" />
                    {(["Snoozed", "Archived"] as TabKey[]).map(tab => (
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
                    <BulkActionBar
                        count={selectedIds.length}
                        actions={[
                            {
                                label: "Copy",
                                icon: CopyIcon,
                                onClick: handleBulkCopy,
                                disabled: isBulking,
                            },
                            {
                                label: "Delete",
                                icon: DeleteIcon,
                                onClick: handleBulkDelete,
                                variant: "danger",
                                disabled: isBulking,
                            },
                        ]}
                    />
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
                {loadError ? (
                    <div className="p-12 text-center">
                        <div className="w-14 h-14 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                            <svg className="w-7 h-7 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                            </svg>
                        </div>
                        <h3 className="text-base font-semibold text-hui-textMain mb-1">Error Loading Leads</h3>
                        <p className="text-sm text-red-600 mb-4">{loadError}</p>
                        <button onClick={() => window.location.reload()} className="hui-btn hui-btn-secondary">Retry</button>
                    </div>
                ) : loading ? (
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
                                <th scope="col" className="px-4 py-3 w-10 text-center" onClick={e => e.stopPropagation()}>
                                    <input
                                        type="checkbox"
                                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                        checked={filtered.length > 0 && filtered.every((l: any) => selectedIds.includes(l.id))}
                                        onChange={e => {
                                            if (e.target.checked) setSelectedIds(filtered.map((l: any) => l.id));
                                            else setSelectedIds([]);
                                        }}
                                    />
                                </th>
                                <SORT_HEADER col="name">Lead Name</SORT_HEADER>
                                <SORT_HEADER col="stage">Stage</SORT_HEADER>
                                <SORT_HEADER col="client">Client</SORT_HEADER>
                                <SORT_HEADER col="projectType">Project Type</SORT_HEADER>
                                <SORT_HEADER col="targetRevenue">Revenue</SORT_HEADER>
                                <SORT_HEADER col="source">Source</SORT_HEADER>
                                <SORT_HEADER col="lastActivity">Last Activity</SORT_HEADER>
                                <th scope="col" className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider text-center"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filtered.map((l: any) => {
                                const isSelected = selectedIds.includes(l.id);
                                return (
                                    <tr
                                        key={l.id}
                                        className={`hover:bg-slate-50 cursor-pointer transition group ${isSelected ? "bg-indigo-50/30" : ""}`}
                                        onClick={() => window.location.href = `/leads/${l.id}`}
                                    >
                                        <td className="px-4 py-4 text-center" onClick={e => e.stopPropagation()}>
                                            <input
                                                type="checkbox"
                                                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                checked={isSelected}
                                                onChange={e => {
                                                    if (e.target.checked) setSelectedIds([...selectedIds, l.id]);
                                                    else setSelectedIds(selectedIds.filter(id => id !== l.id));
                                                }}
                                            />
                                        </td>
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
                                            {l.targetRevenue ? `${formatCurrency(l.targetRevenue)}` : "—"}
                                        </td>
                                        <td className="px-6 py-4 text-hui-textMuted">{l.source || "—"}</td>
                                        <td className="px-6 py-4 text-hui-textMuted text-xs">
                                            {new Date(l.lastActivityAt || l.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                                        </td>
                                        <td className="px-3 py-4 text-center" onClick={e => e.stopPropagation()}>
                                            <button
                                                onClick={e => handleDelete(l, e)}
                                                disabled={deletingId === l.id}
                                                title={l.project ? "Delete project first" : "Delete lead"}
                                                className={`opacity-0 group-hover:opacity-100 transition p-1.5 rounded hover:bg-red-50 disabled:opacity-40 ${l.project ? "text-slate-300 cursor-not-allowed" : "text-slate-400 hover:text-red-600"}`}
                                            >
                                                {deletingId === l.id ? (
                                                    <span className="w-4 h-4 border-2 border-slate-300 border-t-red-500 rounded-full animate-spin block" />
                                                ) : (
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                    </svg>
                                                )}
                                            </button>
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
