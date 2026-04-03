"use client";
import { useState, useTransition } from "react";
import {
    createScheduleTask,
    updateScheduleTask,
    deleteScheduleTask,
    addTaskPunchItem,
    togglePunchItem,
    deletePunchItem,
} from "@/lib/actions";
import { toast } from "sonner";

const STATUS_OPTIONS = ["Not Started", "In Progress", "Complete", "Blocked"];
const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-slate-100 text-slate-600",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

interface Task {
    id: string;
    name: string;
    status: string;
    startDate: Date | null;
    endDate: Date | null;
    progress: number;
    color: string;
    type: string;
    assignments: { user: { id: string; name: string | null; email: string } }[];
    punchItems?: { id: string; name: string; completed: boolean; order: number }[];
}

interface Props {
    projectId: string;
    initialTasks: any[];
    teamMembers: any[];
}

export default function TasksClient({ projectId, initialTasks, teamMembers }: Props) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [activeTab, setActiveTab] = useState<"tasks" | "punchlist">("tasks");
    const [expandedTask, setExpandedTask] = useState<string | null>(null);
    const [showAddTask, setShowAddTask] = useState(false);
    const [newTask, setNewTask] = useState({ name: "", startDate: "", endDate: "", status: "Not Started" });
    const [punchInputs, setPunchInputs] = useState<Record<string, string>>({});
    const [isPending, startTransition] = useTransition();

    const groupedByStatus = STATUS_OPTIONS.reduce((acc, status) => {
        acc[status] = tasks.filter(t => (t.status || "Not Started") === status && t.type !== "milestone");
        return acc;
    }, {} as Record<string, Task[]>);

    const milestones = tasks.filter(t => t.type === "milestone");
    const allPunchTasks = tasks.filter(t => t.punchItems && t.punchItems.length > 0);

    const handleAddTask = () => {
        if (!newTask.name.trim() || !newTask.startDate || !newTask.endDate) {
            toast.error("Name, start date, and end date are required");
            return;
        }
        startTransition(async () => {
            try {
                const created = await createScheduleTask(projectId, newTask);
                setTasks(prev => [...prev, { ...created, punchItems: [] }]);
                setNewTask({ name: "", startDate: "", endDate: "", status: "Not Started" });
                setShowAddTask(false);
                toast.success("Task added");
            } catch {
                toast.error("Failed to add task");
            }
        });
    };

    const handleStatusChange = (taskId: string, status: string) => {
        startTransition(async () => {
            try {
                await updateScheduleTask(taskId, { status });
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
            } catch {
                toast.error("Failed to update status");
            }
        });
    };

    const handleDeleteTask = (taskId: string) => {
        if (!confirm("Delete this task?")) return;
        startTransition(async () => {
            try {
                await deleteScheduleTask(taskId);
                setTasks(prev => prev.filter(t => t.id !== taskId));
                toast.success("Task deleted");
            } catch {
                toast.error("Failed to delete task");
            }
        });
    };

    const handleAddPunchItem = (taskId: string) => {
        const name = punchInputs[taskId]?.trim();
        if (!name) return;
        startTransition(async () => {
            try {
                const item = await addTaskPunchItem(taskId, name);
                setTasks(prev => prev.map(t => t.id === taskId
                    ? { ...t, punchItems: [...(t.punchItems || []), item] }
                    : t
                ));
                setPunchInputs(prev => ({ ...prev, [taskId]: "" }));
            } catch {
                toast.error("Failed to add punch item");
            }
        });
    };

    const handleTogglePunch = (taskId: string, itemId: string) => {
        startTransition(async () => {
            try {
                const updated = await togglePunchItem(itemId);
                setTasks(prev => prev.map(t => t.id === taskId
                    ? { ...t, punchItems: t.punchItems?.map(p => p.id === itemId ? { ...p, completed: updated.completed } : p) }
                    : t
                ));
            } catch {
                toast.error("Failed to update punch item");
            }
        });
    };

    const handleDeletePunchItem = (taskId: string, itemId: string) => {
        startTransition(async () => {
            try {
                await deletePunchItem(itemId);
                setTasks(prev => prev.map(t => t.id === taskId
                    ? { ...t, punchItems: t.punchItems?.filter(p => p.id !== itemId) }
                    : t
                ));
            } catch {
                toast.error("Failed to delete punch item");
            }
        });
    };

    return (
        <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold text-hui-textMain">Tasks & Punchlist</h1>
                <button onClick={() => setShowAddTask(true)} className="hui-btn hui-btn-primary text-sm">
                    + Add Task
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-hui-border gap-0">
                {(["tasks", "punchlist"] as const).map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px capitalize transition-colors ${activeTab === tab ? "border-hui-primary text-hui-primary" : "border-transparent text-hui-textMuted hover:text-hui-textMain"}`}
                    >
                        {tab === "tasks" ? `Tasks (${tasks.filter(t => t.type !== "milestone").length})` : `Punchlist (${tasks.reduce((a, t) => a + (t.punchItems?.length ?? 0), 0)})`}
                    </button>
                ))}
            </div>

            {/* Add Task Form */}
            {showAddTask && (
                <div className="hui-card p-5 space-y-3">
                    <h3 className="font-semibold text-hui-textMain text-sm">New Task</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                        <input
                            className="hui-input sm:col-span-2"
                            placeholder="Task name"
                            value={newTask.name}
                            onChange={e => setNewTask(prev => ({ ...prev, name: e.target.value }))}
                            autoFocus
                        />
                        <input type="date" className="hui-input" value={newTask.startDate} onChange={e => setNewTask(prev => ({ ...prev, startDate: e.target.value }))} />
                        <input type="date" className="hui-input" value={newTask.endDate} onChange={e => setNewTask(prev => ({ ...prev, endDate: e.target.value }))} />
                    </div>
                    <div className="flex gap-2">
                        <button onClick={handleAddTask} disabled={isPending} className="hui-btn hui-btn-primary text-sm">
                            {isPending ? "Adding…" : "Add Task"}
                        </button>
                        <button onClick={() => setShowAddTask(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                    </div>
                </div>
            )}

            {activeTab === "tasks" ? (
                <div className="space-y-6">
                    {tasks.length === 0 ? (
                        <div className="hui-card p-12 text-center">
                            <p className="font-semibold text-hui-textMain mb-2">No tasks yet</p>
                            <p className="text-sm text-hui-textMuted mb-4">Add tasks to track progress on this project.</p>
                            <button onClick={() => setShowAddTask(true)} className="hui-btn hui-btn-primary text-sm">Add First Task</button>
                        </div>
                    ) : (
                        <>
                            {STATUS_OPTIONS.map(status => {
                                const statusTasks = groupedByStatus[status];
                                if (statusTasks.length === 0) return null;
                                return (
                                    <div key={status}>
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[status]}`}>{status}</span>
                                            <span className="text-xs text-hui-textMuted">{statusTasks.length}</span>
                                        </div>
                                        <div className="hui-card overflow-hidden divide-y divide-hui-border">
                                            {statusTasks.map(task => (
                                                <div key={task.id}>
                                                    <div
                                                        className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 cursor-pointer"
                                                        onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                                                    >
                                                        <div
                                                            className="w-3 h-3 rounded-sm shrink-0"
                                                            style={{ backgroundColor: task.color || "#4c9a2a" }}
                                                        />
                                                        <span className="flex-1 text-sm font-medium text-hui-textMain">{task.name}</span>
                                                        {task.assignments?.length > 0 && (
                                                            <div className="flex -space-x-1">
                                                                {task.assignments.slice(0, 3).map(a => (
                                                                    <div key={a.user.id} title={a.user.name || a.user.email} className="w-6 h-6 rounded-full bg-hui-primary/20 border border-white flex items-center justify-center text-[9px] font-bold text-hui-primary">
                                                                        {(a.user.name || a.user.email).charAt(0).toUpperCase()}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                        {task.startDate && (
                                                            <span className="text-xs text-hui-textMuted tabular-nums whitespace-nowrap">
                                                                {new Date(task.startDate).toLocaleDateString()} – {task.endDate ? new Date(task.endDate).toLocaleDateString() : "?"}
                                                            </span>
                                                        )}
                                                        <select
                                                            value={task.status || "Not Started"}
                                                            onClick={e => e.stopPropagation()}
                                                            onChange={e => handleStatusChange(task.id, e.target.value)}
                                                            className={`text-xs px-2 py-0.5 rounded-full border-0 font-medium cursor-pointer focus:outline-none ${STATUS_COLORS[task.status || "Not Started"]}`}
                                                        >
                                                            {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                                                        </select>
                                                        <button
                                                            onClick={e => { e.stopPropagation(); handleDeleteTask(task.id); }}
                                                            className="text-slate-300 hover:text-red-500 transition ml-1"
                                                        >
                                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                        </button>
                                                    </div>
                                                    {expandedTask === task.id && (
                                                        <div className="px-4 pb-3 bg-slate-50 border-t border-hui-border space-y-3">
                                                            <div className="pt-3">
                                                                <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2">Punch Items</p>
                                                                {(task.punchItems || []).map(p => (
                                                                    <label key={p.id} className="flex items-center gap-2 py-1 group cursor-pointer">
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={p.completed}
                                                                            onChange={() => handleTogglePunch(task.id, p.id)}
                                                                            className="rounded text-hui-primary focus:ring-hui-primary"
                                                                        />
                                                                        <span className={`text-sm flex-1 ${p.completed ? "line-through text-hui-textMuted" : "text-hui-textMain"}`}>{p.name}</span>
                                                                        <button onClick={() => handleDeletePunchItem(task.id, p.id)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition">
                                                                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                                                        </button>
                                                                    </label>
                                                                ))}
                                                                <div className="flex gap-2 mt-2">
                                                                    <input
                                                                        className="hui-input text-xs py-1 flex-1"
                                                                        placeholder="Add punch item…"
                                                                        value={punchInputs[task.id] || ""}
                                                                        onChange={e => setPunchInputs(prev => ({ ...prev, [task.id]: e.target.value }))}
                                                                        onKeyDown={e => { if (e.key === "Enter") handleAddPunchItem(task.id); }}
                                                                    />
                                                                    <button onClick={() => handleAddPunchItem(task.id)} className="hui-btn hui-btn-secondary text-xs py-1 px-3">Add</button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}

                            {milestones.length > 0 && (
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">Milestones</span>
                                    </div>
                                    <div className="hui-card overflow-hidden divide-y divide-hui-border">
                                        {milestones.map(task => (
                                            <div key={task.id} className="flex items-center gap-3 px-4 py-3">
                                                <span className="text-purple-500">◆</span>
                                                <span className="flex-1 text-sm font-medium text-hui-textMain">{task.name}</span>
                                                {task.startDate && <span className="text-xs text-hui-textMuted">{new Date(task.startDate).toLocaleDateString()}</span>}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            ) : (
                /* Punchlist Tab */
                <div className="space-y-4">
                    {allPunchTasks.length === 0 ? (
                        <div className="hui-card p-12 text-center">
                            <p className="font-semibold text-hui-textMain mb-2">No punch items yet</p>
                            <p className="text-sm text-hui-textMuted">Expand a task in the Tasks tab to add punch list items.</p>
                        </div>
                    ) : (
                        allPunchTasks.map(task => (
                            <div key={task.id} className="hui-card overflow-hidden">
                                <div className="flex items-center gap-2 px-4 py-2.5 bg-slate-50 border-b border-hui-border">
                                    <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: task.color || "#4c9a2a" }} />
                                    <span className="text-sm font-semibold text-hui-textMain">{task.name}</span>
                                    <span className="text-xs text-hui-textMuted ml-auto">
                                        {task.punchItems?.filter(p => p.completed).length}/{task.punchItems?.length} done
                                    </span>
                                </div>
                                <div className="divide-y divide-hui-border">
                                    {task.punchItems?.map(p => (
                                        <label key={p.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 cursor-pointer group">
                                            <input
                                                type="checkbox"
                                                checked={p.completed}
                                                onChange={() => handleTogglePunch(task.id, p.id)}
                                                className="rounded text-hui-primary focus:ring-hui-primary"
                                            />
                                            <span className={`text-sm flex-1 ${p.completed ? "line-through text-hui-textMuted" : "text-hui-textMain"}`}>{p.name}</span>
                                            <button onClick={() => handleDeletePunchItem(task.id, p.id)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition">
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                            </button>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
