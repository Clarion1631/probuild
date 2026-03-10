"use client";

import Link from "next/link";
import { useState } from "react";
import AddLeadModal from "@/app/leads/AddLeadModal";
import { toast } from "sonner";

const PROJECT_STATUSES = [
    { value: "Active", label: "Active", color: "bg-green-100 text-green-700", dot: "bg-green-500" },
    { value: "In Progress", label: "In Progress", color: "bg-blue-100 text-blue-700", dot: "bg-blue-500" },
    { value: "On Hold", label: "On Hold", color: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
    { value: "Completed", label: "Completed", color: "bg-purple-100 text-purple-700", dot: "bg-purple-500" },
    { value: "Closed", label: "Closed", color: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
    { value: "Archived", label: "Archived", color: "bg-slate-50 text-slate-400", dot: "bg-slate-300" },
];

function getStatusColor(status: string) {
    return PROJECT_STATUSES.find(s => s.value === status)?.color || "bg-slate-100 text-slate-600";
}

function getStatusDot(status: string) {
    return PROJECT_STATUSES.find(s => s.value === status)?.dot || "bg-slate-400";
}

export default function ProjectsClient({ projects: initialProjects }: { projects: any[] }) {
    const [projects, setProjects] = useState(initialProjects);
    const [statusFilter, setStatusFilter] = useState<string>("all-active");
    const [search, setSearch] = useState("");
    const [showModal, setShowModal] = useState(false);
    const [updatingId, setUpdatingId] = useState<string | null>(null);

    async function handleStatusChange(projectId: string, newStatus: string) {
        setUpdatingId(projectId);
        try {
            const res = await fetch(`/api/projects/${projectId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: newStatus }),
            });
            if (!res.ok) throw new Error("Failed to update");
            setProjects(prev => prev.map(p => p.id === projectId ? { ...p, status: newStatus } : p));
            toast.success(`Status updated to ${newStatus}`);
        } catch {
            toast.error("Failed to update status");
        } finally {
            setUpdatingId(null);
        }
    }

    const filteredProjects = projects.filter(p => {
        if (statusFilter === "all-active") {
            if (p.status === "Closed" || p.status === "Archived") return false;
        } else if (statusFilter !== "all") {
            if (p.status !== statusFilter) return false;
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            const name = (p.name || "").toLowerCase();
            const client = (p.client?.name || "").toLowerCase();
            if (!name.includes(q) && !client.includes(q)) return false;
        }
        return true;
    });

    const statusCounts: Record<string, number> = {};
    projects.forEach(p => {
        const s = p.status || "Active";
        statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const activeCount = projects.filter(p => p.status !== "Closed" && p.status !== "Archived").length;
    const totalValue = projects.reduce((sum, p) => sum + (p.estimates?.[0]?.totalAmount || 0), 0);

    return (
        <div className="max-w-7xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/25">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">Projects</h1>
                        <p className="text-sm text-hui-textMuted mt-0.5">{activeCount} active · {projects.length} total · ${totalValue.toLocaleString()} value</p>
                    </div>
                </div>
                <button className="hui-btn hui-btn-primary flex items-center gap-2 shadow-md shadow-indigo-500/20 hover:shadow-lg hover:shadow-indigo-500/30 transition-all" onClick={() => setShowModal(true)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                    New Project
                </button>
            </div>

            {/* Status Summary Cards */}
            <div className="grid grid-cols-6 gap-3 mb-6">
                {PROJECT_STATUSES.map(s => {
                    const count = statusCounts[s.value] || 0;
                    const isActive = statusFilter === s.value;
                    return (
                        <button
                            key={s.value}
                            onClick={() => setStatusFilter(isActive ? "all-active" : s.value)}
                            className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border transition-all text-left ${
                                isActive
                                    ? "bg-white border-indigo-300 shadow-md ring-2 ring-indigo-100"
                                    : "bg-white border-slate-200/80 shadow-sm hover:shadow-md hover:border-slate-300"
                            }`}
                        >
                            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${s.dot}`} />
                            <div>
                                <p className="text-lg font-bold text-hui-textMain leading-none">{count}</p>
                                <p className="text-[10px] text-slate-400 font-medium mt-0.5">{s.label}</p>
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* Filters */}
            <div className="flex items-center mb-5 gap-3">
                <div className="relative flex-1 max-w-xs">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                    <input
                        type="text"
                        placeholder="Search projects or clients..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="hui-input w-full pl-10"
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="hui-input w-52"
                >
                    <option value="all-active">Active Projects ({activeCount})</option>
                    <option value="all">All Projects ({projects.length})</option>
                    {PROJECT_STATUSES.map(s => (
                        <option key={s.value} value={s.value}>
                            {s.label} ({statusCounts[s.value] || 0})
                        </option>
                    ))}
                </select>
                {statusFilter !== "all-active" && statusFilter !== "all" && (
                    <button onClick={() => setStatusFilter("all-active")} className="text-xs text-slate-400 hover:text-slate-600 transition flex items-center gap-1">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
                        Clear filter
                    </button>
                )}
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200/80 overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-gradient-to-r from-slate-50 to-slate-100/50 border-b border-slate-200">
                            <th className="py-3.5 px-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Project Name</th>
                            <th className="py-3.5 px-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Client</th>
                            <th className="py-3.5 px-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Start Date</th>
                            <th className="py-3.5 px-5 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Amount</th>
                            <th className="py-3.5 px-5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                            <th className="py-3.5 px-3 w-12"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {filteredProjects.map((project) => (
                            <tr key={project.id} className="hover:bg-slate-50/70 transition-colors group">
                                <td className="py-4 px-5">
                                    <Link href={`/projects/${project.id}`} className="flex items-center gap-3">
                                        <div className="w-9 h-9 bg-gradient-to-br from-indigo-50 to-blue-50 rounded-lg flex items-center justify-center shrink-0 border border-indigo-100/50 group-hover:from-indigo-100 group-hover:to-blue-100 transition">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                                        </div>
                                        <div>
                                            <p className="font-semibold text-hui-textMain group-hover:text-hui-primary transition-colors text-sm">{project.name}</p>
                                            {project.location && <p className="text-[10px] text-slate-400">{project.location}</p>}
                                        </div>
                                    </Link>
                                </td>
                                <td className="py-4 px-5">
                                    <div className="flex items-center gap-2">
                                        <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-500 shrink-0">
                                            {(project.client?.name || "?")[0].toUpperCase()}
                                        </div>
                                        <span className="text-sm text-slate-600">{project.client?.name || "No Client"}</span>
                                    </div>
                                </td>
                                <td className="py-4 px-5 text-sm text-slate-400">{new Date(project.createdAt).toLocaleDateString()}</td>
                                <td className="py-4 px-5 text-right">
                                    <span className="text-sm font-semibold text-slate-700">
                                        {project.estimates?.length > 0 
                                            ? `$${(project.estimates[0].totalAmount || 0).toLocaleString()}` 
                                            : <span className="text-slate-300 font-normal">—</span>
                                        }
                                    </span>
                                </td>
                                <td className="py-3.5 px-5">
                                    <select
                                        value={project.status || "Active"}
                                        onChange={e => handleStatusChange(project.id, e.target.value)}
                                        disabled={updatingId === project.id}
                                        className={`text-xs font-semibold rounded-full px-3 py-1.5 border-0 cursor-pointer appearance-none focus:ring-2 focus:ring-indigo-200 transition disabled:opacity-50 ${getStatusColor(project.status || "Active")}`}
                                        style={{ backgroundImage: "none", paddingRight: "14px" }}
                                    >
                                        {PROJECT_STATUSES.map(s => (
                                            <option key={s.value} value={s.value}>{s.label}</option>
                                        ))}
                                    </select>
                                </td>
                                <td className="py-4 px-3 text-right">
                                    <Link href={`/projects/${project.id}`} className="text-slate-300 hover:text-indigo-500 opacity-0 group-hover:opacity-100 transition-all">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                        </svg>
                                    </Link>
                                </td>
                            </tr>
                        ))}
                        {filteredProjects.length === 0 && (
                            <tr>
                                <td colSpan={6} className="py-16 text-center">
                                    <div className="flex flex-col items-center gap-3">
                                        <div className="w-14 h-14 bg-gradient-to-br from-slate-100 to-slate-50 rounded-2xl flex items-center justify-center">
                                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                                        </div>
                                        <p className="text-sm font-medium text-slate-400">No projects match your filters</p>
                                        <button onClick={() => { setStatusFilter("all-active"); setSearch(""); }} className="text-xs text-indigo-600 font-semibold hover:text-indigo-800 transition">Reset filters</button>
                                    </div>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {showModal && <AddLeadModal onClose={() => setShowModal(false)} />}
        </div>
    );
}
