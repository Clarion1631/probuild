"use client";
import { useState, useTransition } from "react";
import { createLeadScheduleTask, updateLeadScheduleTask, deleteLeadScheduleTask } from "@/lib/actions";
import { toast } from "sonner";

interface Task {
    id: string;
    name: string;
    startDate: Date;
    endDate: Date;
    status: string;
    color: string;
}

interface Props {
    leadId: string;
    leadName: string;
    initialTasks: Task[];
}

const STATUS_COLORS: Record<string, string> = {
    "Not Started": "bg-gray-100 text-gray-600",
    "In Progress": "bg-blue-100 text-blue-700",
    "Complete": "bg-green-100 text-green-700",
    "Blocked": "bg-red-100 text-red-700",
};

const STATUSES = ["Not Started", "In Progress", "Complete", "Blocked"];

export default function LeadScheduleClient({ leadId, leadName, initialTasks }: Props) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [showAdd, setShowAdd] = useState(false);
    const [newName, setNewName] = useState("");
    const [newStart, setNewStart] = useState("");
    const [newEnd, setNewEnd] = useState("");
    const [isPending, startTransition] = useTransition();

    function handleAdd() {
        if (!newName.trim() || !newStart || !newEnd) return;
        startTransition(async () => {
            try {
                const task = await createLeadScheduleTask(leadId, {
                    name: newName,
                    startDate: new Date(newStart),
                    endDate: new Date(newEnd),
                });
                setTasks(prev => [...prev, task as Task]);
                setNewName("");
                setNewStart("");
                setNewEnd("");
                setShowAdd(false);
                toast.success("Task added");
            } catch {
                toast.error("Failed to add task");
            }
        });
    }

    function handleStatusChange(taskId: string, status: string) {
        startTransition(async () => {
            try {
                await updateLeadScheduleTask(taskId, leadId, { status });
                setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status } : t));
            } catch {
                toast.error("Failed to update");
            }
        });
    }

    function handleDelete(taskId: string) {
        if (!confirm("Delete this task?")) return;
        startTransition(async () => {
            try {
                await deleteLeadScheduleTask(taskId, leadId);
                setTasks(prev => prev.filter(t => t.id !== taskId));
                toast.success("Task deleted");
            } catch {
                toast.error("Failed to delete");
            }
        });
    }

    return (
        <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Schedule</h1>
                    <p className="text-sm text-hui-textMuted mt-1">{leadName}</p>
                </div>
                <button onClick={() => setShowAdd(true)} className="hui-btn hui-btn-primary text-sm">+ Add Task</button>
            </div>

            {showAdd && (
                <div className="hui-card p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-hui-textMain">New Task</h3>
                    <input
                        placeholder="Task name *"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        className="hui-input w-full"
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">Start Date</label>
                            <input type="date" value={newStart} onChange={e => setNewStart(e.target.value)} className="hui-input w-full" />
                        </div>
                        <div>
                            <label className="block text-xs text-hui-textMuted mb-1">End Date</label>
                            <input type="date" value={newEnd} onChange={e => setNewEnd(e.target.value)} className="hui-input w-full" />
                        </div>
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button onClick={() => setShowAdd(false)} className="hui-btn hui-btn-secondary text-sm">Cancel</button>
                        <button
                            onClick={handleAdd}
                            disabled={isPending || !newName.trim() || !newStart || !newEnd}
                            className="hui-btn hui-btn-primary text-sm disabled:opacity-50"
                        >
                            {isPending ? "Adding…" : "Add Task"}
                        </button>
                    </div>
                </div>
            )}

            {tasks.length === 0 ? (
                <div className="hui-card p-12 text-center text-hui-textMuted text-sm">
                    No tasks yet. Add tasks to plan out this lead.
                </div>
            ) : (
                <div className="hui-card overflow-hidden">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-hui-textMuted uppercase tracking-wide border-b border-hui-border bg-hui-surface">
                                <th className="px-4 py-3">Task</th>
                                <th className="px-4 py-3">Start</th>
                                <th className="px-4 py-3">End</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {tasks.map(task => (
                                <tr key={task.id} className="border-b border-hui-border last:border-0 hover:bg-hui-surface/50">
                                    <td className="px-4 py-3 font-medium text-hui-textMain">{task.name}</td>
                                    <td className="px-4 py-3 text-hui-textMuted">
                                        {new Date(task.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                    </td>
                                    <td className="px-4 py-3 text-hui-textMuted">
                                        {new Date(task.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                    </td>
                                    <td className="px-4 py-3">
                                        <select
                                            value={task.status}
                                            onChange={e => handleStatusChange(task.id, e.target.value)}
                                            disabled={isPending}
                                            className={`text-xs font-semibold rounded-full px-3 py-1 border-0 cursor-pointer focus:ring-1 focus:ring-hui-primary ${STATUS_COLORS[task.status] ?? "bg-gray-100 text-gray-600"}`}
                                        >
                                            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </td>
                                    <td className="px-4 py-3">
                                        <button onClick={() => handleDelete(task.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
