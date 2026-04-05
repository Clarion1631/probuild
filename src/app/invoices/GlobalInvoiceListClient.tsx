"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

const STATUS_TABS = ["All", "Draft", "Issued", "Paid", "Overdue", "Partially Paid"] as const;

type SortKey = "code" | "project" | "client" | "status" | "totalAmount" | "balanceDue" | "issueDate";
type SortDir = "asc" | "desc";

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
            {count !== undefined && count > 0 && (
                <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                    active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
                }`}>
                    {count}
                </span>
            )}
        </button>
    );
}

function QBSyncButton({ invoiceId }: { invoiceId: string }) {
    const [syncing, setSyncing] = useState(false);
    async function handleSync() {
        setSyncing(true);
        try {
            const res = await fetch("/api/quickbooks/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "invoice", id: invoiceId }),
            });
            const data = await res.json();
            if (data.notConnected) { toast.error("Connect QuickBooks in Settings → Integrations first."); return; }
            if (!res.ok) throw new Error(data.error || "Sync failed");
            toast.success("Invoice synced to QuickBooks!", {
                action: data.qbUrl ? { label: "View in QB", onClick: () => window.open(data.qbUrl, "_blank") } : undefined,
            });
        } catch (e: any) {
            toast.error(e.message || "QB sync failed");
        } finally {
            setSyncing(false);
        }
    }
    return (
        <button
            onClick={handleSync}
            disabled={syncing}
            title="Sync to QuickBooks"
            className="text-xs font-bold text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 px-2 py-1 rounded disabled:opacity-50 transition"
        >
            {syncing ? "…" : "QB"}
        </button>
    );
}

export default function GlobalInvoiceListClient({ invoices }: { invoices: any[] }) {
    const [activeTab, setActiveTab] = useState<string>("All");
    const [sortKey, setSortKey] = useState<SortKey>("issueDate");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [searchTerm, setSearchTerm] = useState("");

    function handleSort(key: SortKey) {
        if (sortKey === key) {
            setSortDir(d => d === "asc" ? "desc" : "asc");
        } else {
            setSortKey(key);
            setSortDir("desc");
        }
    }

    const filtered = useMemo(() => {
        let list = invoices;

        if (searchTerm) {
            const q = searchTerm.toLowerCase();
            list = list.filter(inv =>
                inv.code.toLowerCase().includes(q) ||
                (inv.project?.name || "").toLowerCase().includes(q) ||
                (inv.client?.name || "").toLowerCase().includes(q)
            );
        }

        if (activeTab !== "All") {
            list = list.filter(inv => inv.status === activeTab);
        }

        list = [...list].sort((a, b) => {
            let aVal: any, bVal: any;
            switch (sortKey) {
                case "code": aVal = a.code; bVal = b.code; break;
                case "project": aVal = a.project?.name || ""; bVal = b.project?.name || ""; break;
                case "client": aVal = a.client?.name || ""; bVal = b.client?.name || ""; break;
                case "status": aVal = a.status; bVal = b.status; break;
                case "totalAmount": aVal = a.totalAmount || 0; bVal = b.totalAmount || 0; break;
                case "balanceDue": aVal = a.balanceDue || 0; bVal = b.balanceDue || 0; break;
                case "issueDate":
                    aVal = a.issueDate ? new Date(a.issueDate).getTime() : new Date(a.createdAt).getTime();
                    bVal = b.issueDate ? new Date(b.issueDate).getTime() : new Date(b.createdAt).getTime();
                    break;
            }
            if (typeof aVal === "string") return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
            return sortDir === "asc" ? aVal - bVal : bVal - aVal;
        });
        return list;
    }, [invoices, activeTab, sortKey, sortDir, searchTerm]);

    // Stat calculations
    const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const totalBalanceDue = invoices.reduce((sum, inv) => sum + (inv.balanceDue || 0), 0);
    const collected = totalInvoiced - totalBalanceDue;
    const overdueAmount = invoices
        .filter(i => i.status === "Overdue")
        .reduce((sum, i) => sum + (i.balanceDue || 0), 0);
    const overdueCount = invoices.filter(i => i.status === "Overdue").length;

    const SortIcon = ({ col }: { col: SortKey }) => {
        if (sortKey !== col) return <svg className="w-3 h-3 text-slate-300 ml-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" /></svg>;
        return (
            <svg className="w-3 h-3 text-hui-primary ml-1 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {sortDir === "asc"
                    ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />}
            </svg>
        );
    };

    return (
        <>
            {/* Header */}
            <div className="flex justify-between items-center">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">All Invoices</h1>
                    <p className="text-sm text-hui-textMuted mt-1">{invoices.length} invoice{invoices.length !== 1 ? "s" : ""} across all projects</p>
                </div>
                <input
                    type="text"
                    placeholder="Search invoices..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="hui-input w-56"
                />
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Total Invoiced</p>
                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(totalInvoiced)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.length} invoice{invoices.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Collected</p>
                    <p className="text-2xl font-bold text-hui-primary">{formatCurrency(collected)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.filter(i => i.status === "Paid").length} paid in full</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Outstanding</p>
                    <p className={`text-2xl font-bold ${totalBalanceDue > 0 ? "text-amber-600" : "text-emerald-600"}`}>{formatCurrency(totalBalanceDue)}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.filter(i => i.balanceDue > 0).length} unpaid</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-1">Overdue</p>
                    <p className={`text-2xl font-bold ${overdueCount > 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {overdueCount > 0 ? formatCurrency(overdueAmount) : "$0.00"}
                    </p>
                    <p className="text-xs text-hui-textMuted mt-1">{overdueCount > 0 ? `${overdueCount} overdue` : "All current"}</p>
                </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-0 border-b border-hui-border overflow-x-auto">
                {STATUS_TABS.map(tab => {
                    const count = tab === "All" ? invoices.length : invoices.filter(i => i.status === tab).length;
                    return (
                        <TabButton
                            key={tab}
                            active={activeTab === tab}
                            onClick={() => setActiveTab(tab)}
                            count={tab === "All" ? undefined : count}
                        >
                            {tab}
                        </TabButton>
                    );
                })}
            </div>

            {/* Table */}
            <div className="hui-card overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 border-b border-hui-border">
                        <tr>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("code")}>
                                Invoice # <SortIcon col="code" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("project")}>
                                Project <SortIcon col="project" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("client")}>
                                Client <SortIcon col="client" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("status")}>
                                Status <SortIcon col="status" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider text-right cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("totalAmount")}>
                                Total <SortIcon col="totalAmount" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider text-right cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("balanceDue")}>
                                Balance Due <SortIcon col="balanceDue" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("issueDate")}>
                                Issued <SortIcon col="issueDate" />
                            </th>
                            <th className="px-6 py-3 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">QB</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-6 py-16 text-center">
                                    <div className="flex flex-col items-center justify-center">
                                        <div className="w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center mb-3">
                                            <svg className="w-7 h-7 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                            </svg>
                                        </div>
                                        <p className="text-base font-semibold text-hui-textMain mb-1">
                                            {searchTerm ? "No matching invoices" : activeTab === "All" ? "No invoices yet" : `No ${activeTab.toLowerCase()} invoices`}
                                        </p>
                                        <p className="text-sm text-hui-textMuted">
                                            {searchTerm ? "Try a different search term." : "Create invoices from project estimates to see them here."}
                                        </p>
                                    </div>
                                </td>
                            </tr>
                        )}
                        {filtered.map((inv: any) => (
                            <tr key={inv.id} className="hover:bg-slate-50 transition">
                                <td className="px-6 py-4 font-medium text-blue-600 hover:underline">
                                    <Link href={`/projects/${inv.project?.id || inv.projectId}/invoices/${inv.id}`}>{inv.code}</Link>
                                </td>
                                <td className="px-6 py-4 text-hui-textMain">
                                    <Link href={`/projects/${inv.project?.id || inv.projectId}`} className="hover:text-hui-primary transition">
                                        {inv.project?.name || "—"}
                                    </Link>
                                </td>
                                <td className="px-6 py-4 text-hui-textMuted">{inv.client?.name || "—"}</td>
                                <td className="px-6 py-4"><StatusBadge status={inv.status} /></td>
                                <td className="px-6 py-4 text-right text-hui-textMain">{formatCurrency(inv.totalAmount)}</td>
                                <td className="px-6 py-4 text-right font-semibold text-hui-textMain">{formatCurrency(inv.balanceDue)}</td>
                                <td className="px-6 py-4 text-hui-textMuted text-sm">
                                    {inv.issueDate
                                        ? new Date(inv.issueDate).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                                        : new Date(inv.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                                </td>
                                <td className="px-6 py-4">
                                    <QBSyncButton invoiceId={inv.id} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
