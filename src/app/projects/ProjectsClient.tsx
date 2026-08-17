"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useMemo, useRef, useEffect } from "react";
import NewProjectModal from "./NewProjectModal";
import { toast } from "sonner";
import { updateProjectStatus, deleteProjects, updateProjectTags } from "@/lib/actions";
import { CustomizeStatusModal, ManageStatusModal, ProjectStatus } from "./StatusModals";
import ProjectsKanbanBoard from "./ProjectsKanbanBoard";
import BulkActionBar, { DeleteIcon } from "@/components/BulkActionBar";
import { PROJECT_STATUSES, OPEN_PROJECT_STATUSES, projectStatusRank } from "@/lib/project-status";

const DEFAULT_PROJECT_STATUSES: ProjectStatus[] = PROJECT_STATUSES;

const SORTABLE_COLUMNS: { key: string; label: string }[] = [
    { key: "name", label: "Project Name" },
    { key: "client", label: "Client Name" },
    { key: "createdAt", label: "Created" },
    { key: "location", label: "Location" },
    { key: "status", label: "Status" },
    { key: "type", label: "Type" },
    { key: "code", label: "#Code" },
    { key: "tags", label: "Tags" },
];

function getStatusColor(status: string, statuses: ProjectStatus[]) {
    return statuses.find(s => s.value === status)?.color || "bg-slate-100 text-slate-600";
}

function getStatusDot(status: string, statuses: ProjectStatus[]) {
    return statuses.find(s => s.value === status)?.dot || "bg-slate-400";
}

export default function ProjectsClient({ projects: initialProjects, initialStatuses, revenueIsComplete, canDeleteProjects }: { projects: any[], initialStatuses?: ProjectStatus[] | null, revenueIsComplete: boolean, canDeleteProjects: boolean }) {
    const router = useRouter();
    const [projects, setProjects] = useState(initialProjects);
    const [statuses, setStatuses] = useState<ProjectStatus[]>(initialStatuses || DEFAULT_PROJECT_STATUSES);
    const [selectedStatuses, setSelectedStatuses] = useState<string[]>(OPEN_PROJECT_STATUSES);
    const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
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
            const result = await deleteProjects([projectId]);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
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
            const result = await deleteProjects(selectedIds);
            if (!result.success) {
                toast.error(result.error);
                return;
            }
            setProjects((prev: any) => prev.filter((p: any) => !selectedIds.includes(p.id)));
            setSelectedIds([]);
            toast.success("Projects deleted successfully");
        } catch {
            toast.error("Failed to delete projects");
        } finally {
            setIsDeleting(false);
        }
    }

    // Checkbox status filter — empty selection means no status filter (show all),
    // same convention as the global tracker report filters.
    const filteredProjects = projects.filter((p: any) => {
        if (selectedStatuses.length > 0 && !selectedStatuses.includes(p.status)) return false;
        if (search.trim()) {
            const q = search.toLowerCase();
            const name = (p.name || "").toLowerCase();
            const client = (p.client?.name || "").toLowerCase();
            if (!name.includes(q) && !client.includes(q)) return false;
        }
        return true;
    });

    const sortedProjects = useMemo(() => {
        if (!sort) return filteredProjects;
        const dir = sort.dir === "asc" ? 1 : -1;
        const val = (p: any) => {
            switch (sort.key) {
                case "client": return p.client?.name || "";
                case "status": return projectStatusRank(p.status);
                case "createdAt": return new Date(p.createdAt).getTime();
                default: return p[sort.key] || "";
            }
        };
        return [...filteredProjects].sort((a, b) => {
            const av = val(a), bv = val(b);
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
            return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * dir;
        });
    }, [filteredProjects, sort]);

    function toggleSort(key: string) {
        setSort(prev => {
            if (!prev || prev.key !== key) return { key, dir: "asc" };
            if (prev.dir === "asc") return { key, dir: "desc" };
            return null; // third click restores default (recently viewed) order
        });
    }

    function toggleStatusFilter(value: string) {
        setSelectedStatuses(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
    }

    const statusCounts: Record<string, number> = {};
    projects.forEach((p: any) => {
        statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    });

    const visibleStatuses = selectedStatuses.length > 0
        ? activeStatuses.filter(s => selectedStatuses.includes(s.value))
        : activeStatuses;

    // Stat card computations
    const totalCount = projects.length;
    const inProgressCount = statusCounts["In Progress"] || 0;
    const substantialCount = statusCounts["Substantial Completion"] || 0;
    const APPROVED_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"];
    const totalRevenue = projects.reduce((sum: number, p: any) => {
        const est = (p.estimates || [])
            .filter((e: any) => APPROVED_STATUSES.includes(e.status))
            .reduce((s: number, e: any) => s + Number(e.totalAmount || 0), 0);
        return sum + est;
    }, 0);

    return (
        <div className="max-w-screen-2xl mx-auto px-4 md:px-8 pb-10">
            {viewMode === "list" && canDeleteProjects && (
                <BulkActionBar
                    count={selectedIds.length}
                    onClear={() => setSelectedIds([])}
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
                    <p className="text-xs text-hui-textMuted font-medium">Substantial Completion</p>
                    <p className="text-3xl font-bold text-amber-600 mt-1">{substantialCount}</p>
                </div>
                <div className="hui-card p-4">
                    {/* Estimates are scoped to the caller while this project list is
                        not, so an unscoped label here would overstate a partial sum. */}
                    <p className="text-xs text-hui-textMuted font-medium">{revenueIsComplete ? "Total Revenue" : "Revenue (your projects)"}</p>
                    <p className="text-3xl font-bold text-hui-textMain mt-1">{totalRevenue.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
                    {!revenueIsComplete && (
                        <p className="text-[10px] text-hui-textMuted mt-1">Excludes projects you don&apos;t have access to</p>
                    )}
                </div>
            </div>

            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <h1 className="text-2xl font-bold text-hui-textMain">All Projects ({projects.length})</h1>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex bg-slate-100 rounded-lg p-1 border border-slate-200">
                        <button onClick={() => setViewMode("list")} aria-label="List view" title="List view" className={`p-1.5 rounded-md transition ${viewMode === "list" ? "bg-white shadow-sm text-slate-800" : "text-slate-400 hover:text-slate-600"}`}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        </button>
                        <button onClick={() => setViewMode("kanban")} aria-label="Kanban view" title="Kanban view" className={`p-1.5 rounded-md transition ${viewMode === "kanban" ? "bg-white shadow-sm text-slate-800" : "text-slate-400 hover:text-slate-600"}`}>
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
                <div className="flex flex-wrap items-center gap-3 bg-white p-1 rounded-lg border border-slate-200 shadow-sm">
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
                    <div className="flex items-center gap-1 flex-wrap px-1">
                        {activeStatuses.map(s => (
                            <label key={s.value} className="flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer hover:bg-slate-50 text-sm font-medium text-slate-700 select-none whitespace-nowrap">
                                <input
                                    type="checkbox"
                                    checked={selectedStatuses.includes(s.value)}
                                    onChange={() => toggleStatusFilter(s.value)}
                                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.rawColor }} />
                                {s.label}
                                <span className="text-xs text-slate-400">({statusCounts[s.value] || 0})</span>
                            </label>
                        ))}
                    </div>
                    <div className="h-5 w-px bg-slate-200"></div>
                    <select className="text-sm border-0 bg-transparent py-1.5 pl-2 pr-8 focus:ring-0 text-slate-700 font-medium">
                        <option>Tags: None</option>
                    </select>
                    <div className="h-5 w-px bg-slate-200"></div>
                    <select className="text-sm border-0 bg-transparent py-1.5 pl-2 pr-8 focus:ring-0 text-slate-700 font-medium">
                        <option>All Managers</option>
                    </select>
                </div>

            </div>

            {/* Kanban View */}
            {viewMode === "kanban" && (
                <ProjectsKanbanBoard
                    projects={filteredProjects}
                    statuses={visibleStatuses}
                    onStatusChange={handleStatusChange} 
                    onCustomizeClick={() => setShowCustomizeModal(true)} 
                />
            )}

            {/* List View */}
            {viewMode === "list" && (
                <>
                    {/* Mobile card list (< lg) — the 10-column table is unreadable on touch */}
                    <div className="lg:hidden space-y-3">
                        {sortedProjects.map((project: any) => (
                            <div key={project.id} className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                                <div className="flex items-start gap-3">
                                    <div className="w-1.5 self-stretch min-h-[2.5rem] rounded-full" style={{ backgroundColor: project.color || getStatusColor(project.status || "In Progress", statuses).replace("bg-", "").split("-")[0] }} />
                                    <div className="flex-1 min-w-0">
                                        <Link href={`/projects/${project.id}`} className="font-semibold text-slate-800 hover:text-indigo-600 transition block truncate">
                                            {project.name}
                                        </Link>
                                        <div className="mt-1 flex items-center gap-2 text-sm text-slate-600">
                                            <div className="w-5 h-5 rounded-full bg-[#34d399] flex items-center justify-center text-[10px] font-bold text-white shrink-0">
                                                {(project.client?.name || "?")[0].toUpperCase()}
                                            </div>
                                            <span className="truncate">{project.client?.name || "No Client"}</span>
                                        </div>
                                        <div className="mt-1 text-xs text-slate-500">
                                            {project.location ? `${project.location} · ` : ""}{new Date(project.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-3">
                                    <select
                                        value={project.status || "In Progress"}
                                        onChange={e => handleStatusChange(project.id, e.target.value)}
                                        disabled={updatingId === project.id}
                                        className={`w-full text-xs font-semibold rounded-full px-3 py-2 border border-slate-200 focus:ring-2 focus:ring-indigo-200 transition disabled:opacity-50 appearance-none bg-white ${getStatusColor(project.status || "In Progress", statuses).replace("bg-", "text-").replace("100", "700")}`}
                                    >
                                        {activeStatuses.map(s => (
                                            <option key={s.value} value={s.value}>• {s.label}</option>
                                        ))}
                                        <option disabled>────────</option>
                                        <option value="Manage Status">⚙ Manage Status</option>
                                    </select>
                                </div>
                            </div>
                        ))}
                        {sortedProjects.length === 0 && (
                            <div className="bg-white rounded-xl shadow-sm border border-slate-200 py-16 text-center">
                                <div className="flex flex-col items-center gap-3">
                                    <div className="w-14 h-14 bg-gradient-to-br from-slate-100 to-slate-50 rounded-2xl flex items-center justify-center">
                                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                                    </div>
                                    <p className="text-sm font-medium text-slate-400">No projects match your filters</p>
                                    <button onClick={() => { setSelectedStatuses(OPEN_PROJECT_STATUSES); setSearch(""); }} className="text-xs text-indigo-600 font-semibold hover:text-indigo-800 transition">Reset filters</button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Table (>= lg) */}
                    <div className="hidden lg:block bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
                        <table className="w-full text-left bg-white text-sm">
                            <thead>
                                <tr className="border-b border-slate-200">
                                    {canDeleteProjects && <th className="py-3 px-4 w-10 text-center">
                                        <input
                                            type="checkbox" 
                                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                            checked={selectedIds.length === filteredProjects.length && filteredProjects.length > 0}
                                            onChange={(e) => {
                                                if (e.target.checked) setSelectedIds(filteredProjects.map((p: any) => p.id));
                                                else setSelectedIds([]);
                                            }}
                                        />
                                    </th>}
                                    {SORTABLE_COLUMNS.map(col => (
                                        <th key={col.key} className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">
                                            <button
                                                onClick={() => toggleSort(col.key)}
                                                className="group/sort flex items-center gap-1 hover:text-slate-800 transition"
                                                title={`Sort by ${col.label}`}
                                            >
                                                {col.label}
                                                {sort?.key === col.key ? (
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-indigo-600 shrink-0">
                                                        {sort.dir === "asc" ? <path d="M18 15l-6-6-6 6"/> : <path d="M6 9l6 6 6-6"/>}
                                                    </svg>
                                                ) : (
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-0 group-hover/sort:opacity-40 [@media(hover:none)]:opacity-30 transition">
                                                        <path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>
                                                    </svg>
                                                )}
                                            </button>
                                        </th>
                                    ))}
                                    <th className="py-3 px-4 font-normal text-slate-500 whitespace-nowrap">Managers</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {sortedProjects.map((project: any) => (
                                    <tr key={project.id} className={`hover:bg-slate-50/70 transition-colors group ${selectedIds.includes(project.id) ? "bg-indigo-50/30" : ""}`}>
                                        {canDeleteProjects && <td className="py-4 px-4 text-center">
                                            <input
                                                type="checkbox" 
                                                className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                                checked={selectedIds.includes(project.id)}
                                                onChange={(e) => {
                                                    if (e.target.checked) setSelectedIds([...selectedIds, project.id]);
                                                    else setSelectedIds(selectedIds.filter(id => id !== project.id));
                                                }}
                                            />
                                        </td>}
                                        <td className="py-4 px-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-1.5 h-6 rounded-full" style={{ backgroundColor: project.color || getStatusColor(project.status || "In Progress", statuses).replace("bg-", "").split("-")[0] }} />
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
                                                value={project.status || "In Progress"}
                                                onChange={e => handleStatusChange(project.id, e.target.value)}
                                                disabled={updatingId === project.id}
                                                className={`text-xs font-semibold rounded-full px-3 py-1.5 border border-slate-200 cursor-pointer focus:ring-2 focus:ring-indigo-200 transition disabled:opacity-50 appearance-none bg-white pr-8 bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2212%22%20height%3D%2212%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M4%205l4%204%204-4%22%20fill%3D%22none%22%20stroke%3D%22%23666%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[position:right_8px_center] ${getStatusColor(project.status || "In Progress", statuses).replace("bg-", "text-").replace("100", "700")}`}
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
                                {sortedProjects.length === 0 && (
                                    <tr>
                                        <td colSpan={10} className="py-16 text-center">
                                            <div className="flex flex-col items-center gap-3">
                                                <div className="w-14 h-14 bg-gradient-to-br from-slate-100 to-slate-50 rounded-2xl flex items-center justify-center">
                                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                                                </div>
                                                <p className="text-sm font-medium text-slate-400">No projects match your filters</p>
                                                <button onClick={() => { setSelectedStatuses(OPEN_PROJECT_STATUSES); setSearch(""); }} className="text-xs text-indigo-600 font-semibold hover:text-indigo-800 transition">Reset filters</button>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {showModal && <NewProjectModal statusOptions={activeStatuses.map(s => s.label)} onClose={() => setShowModal(false)} />}
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
