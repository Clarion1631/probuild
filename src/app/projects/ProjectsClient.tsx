"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useMemo, useRef, useEffect } from "react";
import AddLeadModal from "@/app/leads/AddLeadModal";
import { toast } from "sonner";
import { updateProjectStatus, deleteProjects, updateProjectTags } from "@/lib/actions";
import { CustomizeStatusModal, ManageStatusModal, ProjectStatus } from "./StatusModals";
import ProjectsKanbanBoard from "./ProjectsKanbanBoard";
import BulkActionBar, { DeleteIcon } from "@/components/BulkActionBar";

const DEFAULT_PROJECT_STATUSES: ProjectStatus[] = [
    { value: "Open", label: "Open", color: "bg-blue-100 text-blue-700", dot: "bg-blue-500", rawColor: "#3b82f6", isActive: true },
    { value: "In Progress", label: "In Progress", color: "bg-green-100 text-green-700", dot: "bg-green-500", rawColor: "#22c55e", isActive: true },
    { value: "Done", label: "Done", color: "bg-teal-100 text-teal-700", dot: "bg-teal-600", rawColor: "#0d9488", isActive: true },
    { value: "Closed", label: "Closed", color: "bg-amber-100 text-amber-700", dot: "bg-amber-400", rawColor: "#fbbf24", isActive: true },
    { value: "Paid, Ready to Start", label: "Paid, Ready to Start", color: "bg-cyan-100 text-cyan-700", dot: "bg-cyan-400", rawColor: "#22d3ee", isActive: true },
];

function getStatusColor(status: string, statuses: ProjectStatus[]) {
    return statuses.find(s => s.value === status)?.color || "bg-slate-100 text-slate-600";
}

function getStatusDot(status: string, statuses: ProjectStatus[]) {
    return statuses.find(s => s.value === status)?.dot || "bg-slate-400";
}

export default function ProjectsClient({ projects: initialProjects, initialStatuses }: { projects: any[], initialStatuses?: ProjectStatus[] | null }) {
    const router = useRouter();
    const [projects, setProjects] = useState(initialProjects);
    const [statuses, setStatuses] = useState<ProjectStatus[]>(initialStatuses || DEFAULT_PROJECT_STATUSES);
    const [statusFilter, setStatusFilter] = useState<string>("all-active");
    const [search, setSearch] = useState("");
    const [showModal, setShowModal] = useState(false);
    const [updatingId, setUpdatingId] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showCustomizeModal, setShowCustomizeModal] = useState(false);
    const [showManageModal, setShowManageModal] = useState(false);
    const [openCardMenu, setOpenCardMenu] = useState<string | null>(null);
    const cardMenuRef = useRef<HTMLDivElement>(null);
    const [editingTagsId, setEditingTagsId] = useState<string | null>(null);
    const [tagInput, setTagInput] = useState("");

    // Close card menu on click outside
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (cardMenuRef.current && !cardMenuRef.current.contains(e.target as Node)) {
                setOpenCardMenu(null);
            }
        }
        if (openCardMenu) {
            document.addEventListener("mousedown", handleClickOutside);
            return () => document.removeEventListener("mousedown", handleClickOutside);
        }
    }, [openCardMenu]);

    const activeStatuses = statuses.filter(s => s.isActive);

    async function handleDeleteProject(projectId: string) {
        if (!confirm("Are you sure you want to delete this project?")) return;
        try {
            await deleteProjects([projectId]);
            setProjects((prev: any) => prev.filter((p: any) => p.id !== projectId));
            toast.success("Project deleted");
        } catch {
            toast.error("Failed to delete project");
        }
        setOpenCardMenu(null);
    }

    async function handleStatusChange(projectId: string, newStatus: string) {
        if (newStatus === "Manage Status") {
            setShowCustomizeModal(true);
            return;
        }
        setUpdatingId(projectId);
        try {
            await updateProjectStatus(projectId, newStatus);
            setProjects((prev: any) => prev.map((p: any) => p.id === projectId ? { ...p, status: newStatus } : p));
            toast.success(`Status updated to ${newStatus}`);
        } catch {
            toast.error("Failed to update status");
        } finally {
            setUpdatingId(null);
        }
    }

    async function handleTagsSave(projectId: string) {
        const tags = tagInput.trim();
        try {
            await updateProjectTags(projectId, tags);
            setProjects((prev: any) => prev.map((p: any) => p.id === projectId ? { ...p, tags: tags || null } : p));
            toast.success("Tags updated");
        } catch {
            toast.error("Failed to update tags");
        } finally {
            setEditingTagsId(null);
            setTagInput("");
        }
    }

    async function handleDeleteSelected() {
        if (!confirm(`Are you sure you want to delete ${selectedIds.length} projects?`)) return;
        setIsDeleting(true);
        try {
            await deleteProjects(selectedIds);
            setProjects((prev: any) => prev.filter((p: any) => !selectedIds.includes(p.id)));
            setSelectedIds([]);
            toast.success("Projects deleted successfully");
        } catch {
            toast.error("Failed to delete projects");
        } finally {
            setIsDeleting(false);
        }
    }

    const filteredProjects = projects.filter((p: any) => {
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
    projects.forEach((p: any) => {
        const s = p.status || "Open";
        statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const activeCount = projects.filter((p: any) => p.status !== "Closed" && p.status !== "Archived").length;


    // Stat card computations
    const totalCount = projects.length;
    const inProgressCount = projects.filter((p: any) => p.status === "In Progress" || p.status === "Open").length;
    const completedCount = projects.filter((p: any) => p.status === "Done" || p.status === "Closed").length;
    const totalRevenue = projects.reduce((sum: number, p: any) => {
        const est = (p.estimates || []).reduce((s: number, e: any) => s + Number(e.totalAmount || 0), 0);
        return sum + est;
    }, 0);

    return (
        <div className="max-w-screen-2xl mx-auto px-4 md:px-8 pb-10">
            {/* Stat Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-6 mb-6">
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Projects</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{totalCount}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">In Progress</p>
                    <p className="text-3xl font-bold text-blue-600 mt-1">{inProgressCount}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Completed</p>
                    <p className="text-3xl font-bold text-green-600 mt-1">{completedCount}</p>
                </div>
                <div className="hui-card p-4">
                    <p className="text-xs text-hui-textMuted font-medium">Total Revenue</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{totalRevenue.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
                </div>
            </div>

            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <h1 className="text-2xl font-bold text-hui-textMain">All Projects ({projects.length})</h1>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex bg-slate-100 rounded-lg p-1 border border-slate-200">
                        <button onClick={() => setViewMode("list")} className={`p-1.5 rounded-md transition ${viewMode === "list" ? "bg-white shadow-sm text-slate-800" : "text-slate-400 hover:text-slate-600"}`}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        </button>
                        <button onClick={() => setViewMode("kanban")} className={`p-1.5 rounded-md transition ${viewMode === "kanban" ? "bg-white shadow-sm text-slate-800" : "text-slate-400 hover:text-slate-600"}`}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                        </button>
                    </div>
                    <button className="hui-btn hui-btn-primary flex items-center gap-2" onClick={() => setShowModal(true)}>
                        Create Project
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                </div>
            </div>

            {/* Shared Filters Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-3 bg-white p-1 rounded-lg border border-slate-200 shadow-sm">
                    <div className="relative w-48 sm:w-64">
                        <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                        <input
                            type="text"
                            placeholder="Search"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="w-full pl-9 pr-3 py-1.5 text-sm bg-transparent border-0 focus:ring-0 text-slate-800 placeholder:text-slate-400"
                        />
                    </div>
                    <div className="h-5 w-px bg-slate-200"></div>
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value)}
                        className="text-sm border-0 bg-transparent py-1.5 pl-2 pr-8 focus:ring-0 text-slate-700 font-medium"
                    >
                        <option value="all-active">Status: Active</option>
                        <option value="all">Status: All</option>
                        {activeStatuses.map(s => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                    <div className="h-5 w-px bg-slate-200"></div>
                    <select className="text-sm border-0 bg-transparent py-1.5 pl-2 pr-8 focus:ring-0 text-slate-700 font-medium">
                        <option>Tags: None</option>
                    </select>
                    <div className="h-5 w-px bg-slate-200"></div>
                    <select className="text-sm border-0 bg-transparent py-1.5 pl-2 pr-8 focus:ring-0 text-slate-700 font-medium">
                        <option>All Managers</option>
                    </select>
                </div>

                {/* Bulk Actions Toolbar for List View */}
                {viewMode === "list" && (
                    <BulkActionBar
                        count={selectedIds.length}
                        actions={[
                            {
                                label: "Delete",
                                icon: DeleteIcon,
                                onClick: handleDeleteSelected,
                                variant: "danger",
                                disabled: isDeleting,
                            },
                        ]}
                    />
                )}
            </div>

            {/* Kanban View */}
            {viewMode === "kanban" && (
                <ProjectsKanbanBoard 
                    projects={filteredProjects} 
                    statuses={activeStatuses} 
                    onStatusChange={handleStatusChange} 
                    onCustomizeClick={() => setShowCustomizeModal(true)} 
                />
            )}

            {/* List View */}
            {viewMode === "list" && (
                <>
                    {/* Table */}
                    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                        <table className="w-full text-left bg-white text-sm">
                            <thead>
                                <tr className="border-b border-slate-200">
                                    <th className="py-3 px-4 w-10 text-center">
                                        <input 
                                            type="checkbox" 
                                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                            checked={selectedIds.length === filteredProjects.length && filteredProjects.length > 0}
                                            onChange={(e) => {
                                                if (e.target.checked) setSelectedIds(filteredProjects.map((p: any) => p.id));
                                                else setSelectedIds([]);
                                            }}
                                        />
                                    </th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Project Name</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Client Name</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Created</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Location</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Status</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Type</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">#Code</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Tags</th>
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Managers</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filteredProjects.map((project: any) => (
                                    <tr key={project.id} className={`hover:bg-slate-50/70 transition-colors group ${selectedIds.includes(project.id) ? "bg-indigo-50/30" : ""}`}>
                                        <td className="py-4 px-4 text-center">
                                            <input 
                                                type="checkbox" 
                                                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                checked={selectedIds.includes(project.id)}
                                                onChange={(e) => {
                                                    if (e.target.checked) setSelectedIds([...selectedIds, project.id]);
                                                    else setSelectedIds(selectedIds.filter(id => id !== project.id));
                                                }}
                                            />
                                        </td>
                                        <td className="py-4 px-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-1.5 h-6 rounded-full" style={{ backgroundColor: project.color || getStatusColor(project.status || "Open", statuses).replace("bg-", "").split("-")[0] }} />
                                                <Link href={`/projects/${project.id}`} className="font-medium text-slate-800 hover:text-indigo-600 transition">
                                                    {project.name}
                                                </Link>
                                            </div>
                                        </td>
                                        <td className="py-4 px-4">
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6 rounded-full bg-[#34d399] flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                                                    {(project.client?.name || "?")[0].toUpperCase()}
                                                </div>
                                                <span className="text-slate-600">{project.client?.name || "No Client"}</span>
                                            </div>
                                        </td>
                                        <td className="py-4 px-4 text-slate-500 whitespace-nowrap">
                                            {new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </td>
                                        <td className="py-4 px-4 text-slate-600">
                                            {project.location || "—"}
                                        </td>
                                        <td className="py-4 px-4">
                                            <select
                                                value={project.status || "Open"}
                                                onChange={e => handleStatusChange(project.id, e.target.value)}
                                                disabled={updatingId === project.id}
                                                className={`text-xs font-semibold rounded-full px-3 py-1.5 border border-slate-200 cursor-pointer focus:ring-2 focus:ring-indigo-200 transition disabled:opacity-50 appearance-none bg-white pr-8 bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2212%22%20height%3D%2212%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M4%205l4%204%204-4%22%20fill%3D%22none%22%20stroke%3D%22%23666%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_8px_center] ${getStatusColor(project.status || "Open", statuses).replace("bg-", "text-").replace("100", "700")}`}
                                            >
                                                {activeStatuses.map(s => (
                                                    <option key={s.value} value={s.value}>• {s.label}</option>
                                                ))}
                                                <option disabled>────────</option>
                                                <option value="Manage Status">⚙ Manage Status</option>
                                            </select>
                                        </td>
                                        <td className="py-4 px-4 text-slate-600">
                                            {project.type || "—"}
                                        </td>
                                        <td className="py-4 px-4 text-slate-600">
                                            {project.code || "—"}
                                        </td>
                                        <td className="py-4 px-4">
                                            {editingTagsId === project.id ? (
                                                <div className="flex items-center gap-1">
                                                    <input
                                                        type="text"
                                                        autoFocus
                                                        value={tagInput}
                                                        onChange={e => setTagInput(e.target.value)}
                                                        onKeyDown={e => {
                                                            if (e.key === "Enter") handleTagsSave(project.id);
                                                            if (e.key === "Escape") { setEditingTagsId(null); setTagInput(""); }
                                                        }}
                                                        className="hui-input py-1 text-xs w-28"
                                                        placeholder="e.g. kitchen"
                                                    />
                                                    <button onClick={() => handleTagsSave(project.id)} className="text-xs text-hui-primary font-medium hover:underline">Save</button>
                                                </div>
                                            ) : project.tags ? (
                                                <button onClick={() => { setEditingTagsId(project.id); setTagInput(project.tags); }} className="text-slate-600 hover:text-hui-primary transition text-sm">
                                                    {project.tags}
                                                </button>
                                            ) : (
                                                <button onClick={() => { setEditingTagsId(project.id); setTagInput(""); }} className="text-slate-400 hover:text-slate-700 font-medium flex items-center gap-1 transition">
                                                    + Add Tags
                                                </button>
                                            )}
                                        </td>
                                        <td className="py-4 px-4">
                                            <div className="w-7 h-7 rounded-full bg-[#1d4ed8] text-white flex items-center justify-center font-bold text-xs ring-2 ring-white">
                                                R
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                {filteredProjects.length === 0 && (
                                    <tr>
                                        <td colSpan={10} className="py-16 text-center">
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
                </>
            )}

            {showModal && <AddLeadModal onClose={() => setShowModal(false)} />}
            {showCustomizeModal && (
                <CustomizeStatusModal 
                    statuses={statuses} 
                    onClose={() => setShowCustomizeModal(false)}
                    onSave={setStatuses}
                    onManageClick={() => setShowManageModal(true)}
                />
            )}
            {showManageModal && (
                <ManageStatusModal 
                    statuses={statuses} 
                    onClose={() => setShowManageModal(false)}
                    onSave={setStatuses}
                />
            )}
        </div>
    );
}
