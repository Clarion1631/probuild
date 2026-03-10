"use client";

import Link from "next/link";
import { useState } from "react";
import AddLeadModal from "@/app/leads/AddLeadModal";
import { toast } from "sonner";

const PROJECT_STATUSES = [
    { value: "Active", label: "Active", color: "bg-green-100 text-green-800" },
    { value: "In Progress", label: "In Progress", color: "bg-blue-100 text-blue-800" },
    { value: "On Hold", label: "On Hold", color: "bg-amber-100 text-amber-800" },
    { value: "Completed", label: "Completed", color: "bg-purple-100 text-purple-800" },
    { value: "Closed", label: "Closed", color: "bg-slate-100 text-slate-600" },
    { value: "Archived", label: "Archived", color: "bg-slate-100 text-slate-400" },
];

function getStatusColor(status: string) {
    return PROJECT_STATUSES.find(s => s.value === status)?.color || "bg-slate-100 text-slate-600";
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
        // Status filter
        if (statusFilter === "all-active") {
            if (p.status === "Closed" || p.status === "Archived") return false;
        } else if (statusFilter !== "all") {
            if (p.status !== statusFilter) return false;
        }
        // Search
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

    return (
        <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Projects</h1>
                    <p className="text-sm text-hui-textMuted mt-1">{activeCount} active · {projects.length} total</p>
                </div>
                <div className="flex items-center space-x-3">
                    <button className="hui-btn hui-btn-primary" onClick={() => setShowModal(true)}>
                        + New Project
                    </button>
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center mb-6 gap-3">
                <input
                    type="text"
                    placeholder="Search projects..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="hui-input w-64"
                />
                <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="hui-input w-48"
                >
                    <option value="all-active">Active Projects ({activeCount})</option>
                    <option value="all">All Projects ({projects.length})</option>
                    <hr />
                    {PROJECT_STATUSES.map(s => (
                        <option key={s.value} value={s.value}>
                            {s.label} ({statusCounts[s.value] || 0})
                        </option>
                    ))}
                </select>
            </div>

            <div className="hui-card overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50 border-b border-hui-border">
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Project Name</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Client</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Start Date</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Amount</th>
                            <th className="py-3 px-4 text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status</th>
                            <th className="py-3 px-4"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {filteredProjects.map((project) => (
                            <tr key={project.id} className="hover:bg-slate-50 transition-colors group">
                                <td className="py-4 px-4">
                                    <Link href={`/projects/${project.id}`} className="font-medium text-hui-textMain hover:text-hui-primary transition-colors">
                                        {project.name}
                                    </Link>
                                </td>
                                <td className="py-4 px-4 text-sm text-hui-textMuted">{project.client?.name || "No Client"}</td>
                                <td className="py-4 px-4 text-sm text-hui-textMuted">{new Date(project.createdAt).toLocaleDateString()}</td>
                                <td className="py-4 px-4 text-sm text-hui-textMuted">
                                    {project.estimates?.length > 0 
                                        ? `$${(project.estimates[0].totalAmount || 0).toLocaleString()}` 
                                        : "N/A"
                                    }
                                </td>
                                <td className="py-3 px-4">
                                    <select
                                        value={project.status || "Active"}
                                        onChange={e => handleStatusChange(project.id, e.target.value)}
                                        disabled={updatingId === project.id}
                                        className={`text-xs font-medium rounded-full px-3 py-1 border-0 cursor-pointer appearance-none focus:ring-2 focus:ring-hui-primary/30 transition disabled:opacity-50 ${getStatusColor(project.status || "Active")}`}
                                        style={{ backgroundImage: "none", paddingRight: "12px" }}
                                    >
                                        {PROJECT_STATUSES.map(s => (
                                            <option key={s.value} value={s.value}>{s.label}</option>
                                        ))}
                                    </select>
                                </td>
                                <td className="py-4 px-4 text-right">
                                    <Link href={`/projects/${project.id}`} className="text-hui-textMuted hover:text-hui-textMain opacity-0 group-hover:opacity-100 transition-opacity">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                        </svg>
                                    </Link>
                                </td>
                            </tr>
                        ))}
                        {filteredProjects.length === 0 && (
                            <tr>
                                <td colSpan={6} className="py-12 text-center text-hui-textMuted">
                                    No projects match your filters.
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
