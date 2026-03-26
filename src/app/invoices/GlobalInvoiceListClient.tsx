"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import StatusBadge from "@/components/StatusBadge";

const STATUS_TABS = ["All", "Draft", "Issued", "Paid", "Overdue", "Partially Paid"] as const;

type SortKey = "code" | "project" | "client" | "status" | "totalAmount" | "balanceDue" | "issueDate";
type SortDir = "asc" | "desc";

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

        // Search
        if (searchTerm) {
            const q = searchTerm.toLowerCase();
            list = list.filter(inv =>
                inv.code.toLowerCase().includes(q) ||
                (inv.project?.name || "").toLowerCase().includes(q) ||
                (inv.client?.name || "").toLowerCase().includes(q)
            );
        }

        // Status filter
        if (activeTab !== "All") {
            list = list.filter(inv => inv.status === activeTab);
        }

        // Sort
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

    // Metrics
    const totalAmount = invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const balanceDue = invoices.reduce((sum, inv) => sum + (inv.balanceDue || 0), 0);
    const totalPaid = totalAmount - balanceDue;
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
                    <h1 className="text-2xl font-bold text-hui-textMain">All Invoices</h1>
                    <p className="text-sm text-hui-textMuted mt-1">Financial overview across all projects</p>
                </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-4 gap-4">
                <div className="hui-card p-5">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Total Invoiced</p>
                    <p className="text-2xl font-bold text-hui-textMain">${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.length} invoice{invoices.length !== 1 ? 's' : ''}</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Total Paid</p>
                    <p className="text-2xl font-bold text-hui-primary">${totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.filter(i => i.status === "Paid").length} paid in full</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Outstanding</p>
                    <p className={`text-2xl font-bold ${balanceDue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>${balanceDue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{invoices.filter(i => i.balanceDue > 0).length} unpaid</p>
                </div>
                <div className="hui-card p-5">
                    <p className="text-xs text-hui-textMuted font-medium uppercase tracking-wider mb-1">Overdue</p>
                    <p className={`text-2xl font-bold ${overdueCount > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{overdueCount}</p>
                    <p className="text-xs text-hui-textMuted mt-1">{overdueCount > 0 ? 'Needs attention' : 'All current'}</p>
                </div>
            </div>

            {/* Filter Bar */}
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-white border border-hui-border rounded-lg p-1 flex-1">
                    {STATUS_TABS.map(tab => {
                        const count = tab === "All" ? invoices.length : invoices.filter(i => i.status === tab).length;
                        return (
                            <button
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${
                                    activeTab === tab
                                        ? "bg-hui-primary text-white shadow-sm"
                                        : "text-hui-textMuted hover:text-hui-textMain hover:bg-slate-50"
                                }`}
                            >
                                {tab}
                                {count > 0 && (
                                    <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                                        activeTab === tab ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
                                    }`}>
                                        {count}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
                <input
                    type="text"
                    placeholder="Search invoices..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="hui-input w-64"
                />
            </div>

            {/* Table */}
            <div className="hui-card overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-hui-textMuted border-b border-hui-border">
                        <tr>
                            <th className="px-6 py-3 font-medium cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("code")}>
                                Invoice # <SortIcon col="code" />
                            </th>
                            <th className="px-6 py-3 font-medium cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("project")}>
                                Project <SortIcon col="project" />
                            </th>
                            <th className="px-6 py-3 font-medium cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("client")}>
                                Client <SortIcon col="client" />
                            </th>
                            <th className="px-6 py-3 font-medium cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("status")}>
                                Status <SortIcon col="status" />
                            </th>
                            <th className="px-6 py-3 font-medium text-right cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("totalAmount")}>
                                Total <SortIcon col="totalAmount" />
                            </th>
                            <th className="px-6 py-3 font-medium text-right cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("balanceDue")}>
                                Balance <SortIcon col="balanceDue" />
                            </th>
                            <th className="px-6 py-3 font-medium cursor-pointer select-none hover:text-hui-textMain" onClick={() => handleSort("issueDate")}>
                                Date <SortIcon col="issueDate" />
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-6 py-12 text-center text-hui-textMuted">
                                    <div className="flex flex-col items-center justify-center">
                                        <svg className="w-12 h-12 mb-3 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                        <p className="text-base font-medium text-hui-textMain mb-1">
                                            {searchTerm ? "No matching invoices" : activeTab === "All" ? "No invoices yet" : `No ${activeTab.toLowerCase()} invoices`}
                                        </p>
                                        <p className="text-sm">
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
                                <td className="px-6 py-4 text-right text-hui-textMain">${(inv.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                <td className="px-6 py-4 text-right font-medium text-hui-textMain">${(inv.balanceDue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                <td className="px-6 py-4 text-hui-textMuted">
                                    {inv.issueDate
                                        ? new Date(inv.issueDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
                                        : new Date(inv.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}
