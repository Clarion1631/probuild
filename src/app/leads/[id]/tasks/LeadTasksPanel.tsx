"use client";

import { useState } from "react";
import { createLeadTask, updateLeadTask, deleteLeadTask } from "@/lib/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import Avatar from "@/components/Avatar";

interface Task {
    id: string;
    title: string;
    status: string;
    dueDate: string | null;
    tags: string | null;
    assigneeId: string | null;
    assignee: { id: string; name: string | null; email: string } | null;
    createdAt: string;
    updatedAt: string;
}

interface TeamMember {
    id: string;
    name: string | null;
    email: string;
    role: string;
}

interface LeadTasksPanelProps {
    leadId: string;
    tasks: Task[];
    teamMembers: TeamMember[];
}

export default function LeadTasksPanel({ leadId, tasks, teamMembers }: LeadTasksPanelProps) {
    const router = useRouter();
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("All");
    const [sortBy, setSortBy] = useState("Due Date");
    const [showModal, setShowModal] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [saving, setSaving] = useState(false);
    const [showActions, setShowActions] = useState(false);

    // Form state
    const [formTitle, setFormTitle] = useState("");
    const [formStatus, setFormStatus] = useState("To Do");
    const [formDueDate, setFormDueDate] = useState("");
    const [formTags, setFormTags] = useState("");
    const [formAssigneeId, setFormAssigneeId] = useState("");

    const statuses = ["To Do", "In Progress", "Done"];

    const getStatusColor = (status: string) => {
        switch (status) {
            case "To Do": return "bg-slate-100 text-slate-700 border-slate-200";
            case "In Progress": return "bg-blue-100 text-blue-700 border-blue-200";
            case "Done": return "bg-green-100 text-green-700 border-green-200";
            default: return "bg-slate-100 text-slate-700 border-slate-200";
        }
    };

    const filteredTasks = tasks
        .filter(t => statusFilter === "All" || t.status === statusFilter)
        .filter(t => !search || t.title.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
            if (sortBy === "Due Date") {
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
            }
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });

    const openCreateModal = () => {
        setEditingTask(null);
        setFormTitle("");
        setFormStatus("To Do");
        setFormDueDate("");
        setFormTags("");
        setFormAssigneeId("");
        setShowModal(true);
    };

    const openEditModal = (task: Task) => {
        setEditingTask(task);
        setFormTitle(task.title);
        setFormStatus(task.status);
        setFormDueDate(task.dueDate?.split("T")[0] || "");
        setFormTags(task.tags || "");
        setFormAssigneeId(task.assigneeId || "");
        setShowModal(true);
    };

    const handleSave = async () => {
        if (!formTitle.trim()) { toast.error("Title is required"); return; }
        setSaving(true);
        try {
            if (editingTask) {
                await updateLeadTask(editingTask.id, {
                    title: formTitle,
                    status: formStatus,
                    dueDate: formDueDate || null,
                    tags: formTags || null,
                    assigneeId: formAssigneeId || null,
                });
                toast.success("Task updated");
            } else {
                await createLeadTask(leadId, {
                    title: formTitle,
                    status: formStatus,
                    dueDate: formDueDate || null,
                    tags: formTags || null,
                    assigneeId: formAssigneeId || null,
                });
                toast.success("Task created");
            }
            setShowModal(false);
            router.refresh();
        } catch (e: any) {
            toast.error(e.message || "Failed to save task");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (taskId: string) => {
        if (!confirm("Delete this task?")) return;
        try {
            await deleteLeadTask(taskId);
            toast.success("Task deleted");
            router.refresh();
        } catch {
            toast.error("Failed to delete task");
        }
    };

    const handleStatusChange = async (taskId: string, newStatus: string) => {
        try {
            await updateLeadTask(taskId, { status: newStatus });
            router.refresh();
        } catch {
            toast.error("Failed to update status");
        }
    };

    return (
        <div className="flex-1 flex flex-col bg-white min-w-0">
            {/* Header */}
            <div className="px-6 py-4 border-b border-hui-border flex items-center justify-between bg-white sticky top-0 z-10">
                <h2 className="text-xl font-bold text-hui-textMain">Tasks</h2>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <button
                            onClick={() => setShowActions(!showActions)}
                            className="px-4 py-2 text-sm font-medium text-hui-textMain bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition flex items-center gap-1.5"
                        >
                            Actions
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        {showActions && (
                            <div className="absolute right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-20 w-40 overflow-hidden">
                                <button
                                    onClick={() => { setShowActions(false); toast.info("Import coming soon"); }}
                                    className="w-full text-left px-4 py-2.5 text-sm text-hui-textMain hover:bg-slate-50 transition"
                                >Import Tasks</button>
                                <button
                                    onClick={() => { setShowActions(false); toast.info("Export coming soon"); }}
                                    className="w-full text-left px-4 py-2.5 text-sm text-hui-textMain hover:bg-slate-50 transition"
                                >Export Tasks</button>
                            </div>
                        )}
                    </div>
                    <button
                        onClick={openCreateModal}
                        className="px-4 py-2 bg-hui-textMain text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition shadow-sm flex items-center gap-1.5"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                        Add New Task
                    </button>
                </div>
            </div>

            {/* Filter Bar */}
            <div className="px-6 py-3 border-b border-hui-border flex items-center gap-3 flex-wrap bg-white">
                <div className="relative flex-shrink-0">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                    <input
                        type="text"
                        placeholder="Search"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white focus:ring-1 focus:ring-green-500 focus:border-green-500 outline-none transition w-44"
                    />
                </div>
                <select
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value)}
                    className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none"
                >
                    <option>Sort by: Due Date</option>
                    <option>Sort by: Created</option>
                </select>
                <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none"
                >
                    <option value="All">Status: All</option>
                    {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none">
                    <option>Tags: None</option>
                </select>
                <select className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none">
                    <option>All Assignees</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                </select>
                <select className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:ring-1 focus:ring-green-500 outline-none">
                    <option>All Creators</option>
                </select>
            </div>

            {/* Table / Content */}
            <div className="flex-1 overflow-y-auto">
                {filteredTasks.length === 0 ? (
                    /* Empty State */
                    <div className="flex flex-col items-center justify-center h-full text-center px-6">
                        <div className="w-48 h-48 mb-6 relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-slate-100 to-slate-50 rounded-full"></div>
                            <div className="absolute inset-6 flex items-center justify-center">
                                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg>
                            </div>
                        </div>
                        <h3 className="text-xl font-bold text-hui-textMain mb-2">Boost productivity with tasks</h3>
                        <p className="text-sm text-slate-500 max-w-sm mb-8">
                            Making sure tasks are added, managed, and assigned is a great way to keep your team and project on the track.
                        </p>
                        <button
                            onClick={openCreateModal}
                            className="px-6 py-3 bg-hui-textMain text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition shadow-sm mb-3"
                        >
                            Add New Task
                        </button>
                        <button className="text-sm text-hui-textMain underline hover:text-green-700 transition font-medium">
                            Use Template
                        </button>
                    </div>
                ) : (
                    /* Tasks Table */
                    <table className="w-full">
                        <thead className="bg-slate-50 sticky top-0 z-[5]">
                            <tr className="border-b border-slate-200">
                                <th className="w-8 px-4 py-3">
                                    <input type="checkbox" className="w-3.5 h-3.5 rounded border-slate-300 text-green-600 focus:ring-green-500" />
                                </th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Title</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Assignees</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Due Date</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Status</th>
                                <th className="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3">Tags</th>
                                <th className="w-16 px-4 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filteredTasks.map(task => (
                                <tr
                                    key={task.id}
                                    className="hover:bg-slate-50/50 transition cursor-pointer group"
                                    onClick={() => openEditModal(task)}
                                >
                                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                                        <input
                                            type="checkbox"
                                            checked={task.status === "Done"}
                                            onChange={() => handleStatusChange(task.id, task.status === "Done" ? "To Do" : "Done")}
                                            className="w-3.5 h-3.5 rounded border-slate-300 text-green-600 focus:ring-green-500"
                                        />
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className={`text-sm font-medium ${task.status === "Done" ? "line-through text-slate-400" : "text-hui-textMain"}`}>
                                            {task.title}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        {task.assignee ? (
                                            <div className="flex items-center gap-2">
                                                <div className="w-6 h-6">
                                                    <Avatar name={task.assignee.name || task.assignee.email} color="blue" />
                                                </div>
                                                <span className="text-xs text-slate-600">{task.assignee.name || task.assignee.email}</span>
                                            </div>
                                        ) : (
                                            <span className="text-xs text-slate-400">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className="text-sm text-slate-600">
                                            {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : <span className="text-slate-400">—</span>}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                                        <select
                                            value={task.status}
                                            onChange={e => handleStatusChange(task.id, e.target.value)}
                                            className={`appearance-none text-xs font-semibold px-2.5 py-1 pr-6 rounded-full border cursor-pointer ${getStatusColor(task.status)} focus:outline-none focus:ring-1 focus:ring-green-500`}
                                        >
                                            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </td>
                                    <td className="px-4 py-3">
                                        {task.tags ? (
                                            <div className="flex gap-1 flex-wrap">
                                                {task.tags.split(",").map((tag, i) => (
                                                    <span key={i} className="px-2 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded-full">{tag.trim()}</span>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-xs text-slate-400">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                                        <button
                                            onClick={() => handleDelete(task.id)}
                                            className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600 transition p-1"
                                        >
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3,6 5,6 21,6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Add/Edit Task Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6">
                        <div className="flex items-center justify-between mb-5">
                            <h3 className="text-lg font-bold text-hui-textMain">
                                {editingTask ? "Edit Task" : "Add New Task"}
                            </h3>
                            <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 transition text-xl leading-none">&times;</button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Title *</label>
                                <input
                                    type="text"
                                    value={formTitle}
                                    onChange={e => setFormTitle(e.target.value)}
                                    placeholder="Enter task title..."
                                    className="hui-input w-full"
                                    autoFocus
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                                    <select value={formStatus} onChange={e => setFormStatus(e.target.value)} className="hui-input w-full">
                                        {statuses.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Due Date</label>
                                    <input
                                        type="date"
                                        value={formDueDate}
                                        onChange={e => setFormDueDate(e.target.value)}
                                        className="hui-input w-full"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Assignee</label>
                                <select value={formAssigneeId} onChange={e => setFormAssigneeId(e.target.value)} className="hui-input w-full">
                                    <option value="">Unassigned</option>
                                    {teamMembers.map(m => (
                                        <option key={m.id} value={m.id}>{m.name || m.email}</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Tags</label>
                                <input
                                    type="text"
                                    value={formTags}
                                    onChange={e => setFormTags(e.target.value)}
                                    placeholder="e.g. urgent, followup (comma-separated)"
                                    className="hui-input w-full"
                                />
                            </div>

                            <div className="flex gap-3 justify-end pt-3 border-t border-slate-100">
                                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition">
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-5 py-2 bg-hui-textMain text-white text-sm font-semibold rounded-lg hover:bg-slate-800 transition disabled:opacity-50 shadow-sm"
                                >
                                    {saving ? "Saving..." : editingTask ? "Save Changes" : "Add Task"}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
