"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { toast } from "sonner";
import { createOfficeTask, updateOfficeTask, moveOfficeTask, deleteOfficeTask, getOfficeTasksBoard } from "@/lib/actions";
import { formatLocalDateString, parseLocalDateString } from "@/lib/report-utils";

const STATUSES = ["To Do", "In Progress", "Done"] as const;
type Status = (typeof STATUSES)[number];

type BoardUser = { id: string; name: string | null; email: string };

type Task = {
    id: string;
    title: string;
    notes: string | null;
    status: string;
    position: number;
    dueDate: Date | string | null;
    assigneeId: string | null;
    assignee: BoardUser | null;
    aiPrompt: string | null;
    createdById: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
};

interface Props {
    initialTasks: Task[];
    users: BoardUser[];
}

const AVATAR_COLORS = [
    "bg-blue-100 text-blue-700",
    "bg-green-100 text-green-700",
    "bg-amber-100 text-amber-700",
    "bg-purple-100 text-purple-700",
    "bg-pink-100 text-pink-700",
    "bg-teal-100 text-teal-700",
    "bg-indigo-100 text-indigo-700",
    "bg-orange-100 text-orange-700",
];

function hashString(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function avatarColor(id: string): string {
    return AVATAR_COLORS[hashString(id) % AVATAR_COLORS.length];
}

function getInitials(name: string | null | undefined, email: string): string {
    if (name) {
        const parts = name.trim().split(/\s+/);
        if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
        return name.slice(0, 2).toUpperCase();
    }
    return email.slice(0, 2).toUpperCase();
}

function firstName(user: BoardUser): string {
    if (user.name) return user.name.trim().split(/\s+/)[0];
    return user.email.split("@")[0];
}

// dueDate is stored as UTC midnight for the picked calendar date (see
// parseOfficeTaskDateOnly in actions.ts). Extracting the date via toISOString()
// recovers exactly that calendar date regardless of the viewer's local timezone —
// using .toLocaleDateString()/local getters here would shift the date backward
// by a day west of UTC (e.g. Pacific time).
function dueDateToISO(dueDate: Date | string): string {
    return new Date(dueDate).toISOString().slice(0, 10);
}

// Format a "YYYY-MM-DD" string for display without reintroducing timezone drift.
function formatISODateForDisplay(iso: string): string {
    const d = parseLocalDateString(iso);
    if (!d) return iso;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function dueDateInfo(dueDate: Date | string | null, status: string): { label: string; className: string } | null {
    if (!dueDate) return null;
    const iso = dueDateToISO(dueDate);
    const label = formatISODateForDisplay(iso);
    if (status === "Done") return { label, className: "bg-slate-100 text-slate-600" };

    const todayStr = formatLocalDateString(new Date());
    if (iso < todayStr) return { label, className: "bg-red-100 text-red-700" };

    const dueLocal = parseLocalDateString(iso);
    const todayLocal = parseLocalDateString(todayStr);
    const diffDays = dueLocal && todayLocal ? Math.round((dueLocal.getTime() - todayLocal.getTime()) / 86400000) : 999;
    if (diffDays <= 2) return { label, className: "bg-amber-100 text-amber-700" };
    return { label, className: "bg-slate-100 text-slate-600" };
}

function composePrompt(title: string, notes: string, dueDate: Date | string | null): string {
    const dueStr = dueDate ? formatISODateForDisplay(dueDateToISO(dueDate)) : "No due date";
    return `Help me complete this Golden Touch office task: ${title}. Details: ${notes || "none"}. Due: ${dueStr}. You have access to our ProBuild backend, QuickBooks, Gmail, and Google Drive — pull whatever you need and draft the pieces that require a human to review or send.`;
}

function chipClass(active: boolean): string {
    return `px-3 py-1.5 rounded-full text-xs font-semibold transition whitespace-nowrap ${active ? "bg-hui-primary text-white" : "bg-slate-100 text-hui-textMuted hover:bg-slate-200"
        }`;
}

function NoteIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
    );
}

function SparkleIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2zM19 14l.8 2.7L22.5 17.5l-2.7.8L19 21l-.8-2.7-2.7-.8 2.7-.8L19 14z" />
        </svg>
    );
}

export default function TasksBoardClient({ initialTasks, users }: Props) {
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [filterId, setFilterId] = useState<string | null>(null);
    const [quickAdd, setQuickAdd] = useState<Record<string, string>>({});
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [draftTitle, setDraftTitle] = useState("");
    const [draftNotes, setDraftNotes] = useState("");
    const [draftAiPrompt, setDraftAiPrompt] = useState("");
    const [, startTransition] = useTransition();

    const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;

    // Tracks the CURRENT dialog selection for async callbacks (refreshBoard)
    // that may resolve after the user has since opened a different task's
    // dialog — reading selectedTaskId itself there would close over whichever
    // task was selected when the failed mutation started, not what's open now.
    const selectedTaskIdRef = useRef<string | null>(null);
    useEffect(() => {
        selectedTaskIdRef.current = selectedTaskId;
    }, [selectedTaskId]);

    useEffect(() => {
        if (selectedTask) {
            setDraftTitle(selectedTask.title);
            setDraftNotes(selectedTask.notes || "");
            setDraftAiPrompt(selectedTask.aiPrompt || "");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTaskId]);

    const visibleTasks = useMemo(() => {
        if (!filterId) return tasks;
        return tasks.filter((t) => t.assigneeId === filterId);
    }, [tasks, filterId]);

    const columns = useMemo(() => {
        const map: Record<string, Task[]> = { "To Do": [], "In Progress": [], Done: [] };
        for (const t of visibleTasks) {
            (map[t.status] ||= []).push(t);
        }
        for (const s of STATUSES) map[s].sort((a, b) => a.position - b.position);
        return map;
    }, [visibleTasks]);

    // On any server-action failure, re-fetch the authoritative board state instead
    // of restoring a whole-board snapshot — a snapshot restore would also wipe out
    // any other operation that succeeded concurrently. Re-syncs the open dialog's
    // drafts from the refreshed task (or closes the dialog if it was deleted
    // elsewhere).
    async function refreshBoard() {
        try {
            const board = await getOfficeTasksBoard();
            const freshTasks = board.tasks as unknown as Task[];
            setTasks(freshTasks);
            const currentSelectedId = selectedTaskIdRef.current;
            if (currentSelectedId) {
                const fresh = freshTasks.find((t) => t.id === currentSelectedId);
                if (fresh) {
                    setDraftTitle(fresh.title);
                    setDraftNotes(fresh.notes || "");
                    setDraftAiPrompt(fresh.aiPrompt || "");
                } else {
                    setSelectedTaskId(null);
                }
            }
        } catch {
            toast.error("Failed to refresh board");
        }
    }

    function performMove(taskId: string, newStatus: string, newIndex: number) {
        const moved = tasks.find((t) => t.id === taskId);
        if (!moved) return;

        const byStatus: Record<string, Task[]> = { "To Do": [], "In Progress": [], Done: [] };
        for (const t of tasks) {
            if (t.id === taskId) continue;
            (byStatus[t.status] ||= []).push(t);
        }
        for (const s of STATUSES) byStatus[s].sort((a, b) => a.position - b.position);

        const destList = byStatus[newStatus];
        const clampedIndex = Math.max(0, Math.min(newIndex, destList.length));
        destList.splice(clampedIndex, 0, { ...moved, status: newStatus });

        const next: Task[] = [];
        for (const s of STATUSES) {
            byStatus[s].forEach((t, i) => next.push({ ...t, position: i }));
        }
        setTasks(next);

        startTransition(async () => {
            try {
                await moveOfficeTask(taskId, newStatus, clampedIndex);
            } catch {
                toast.error("Failed to move task");
                await refreshBoard();
            }
        });
    }

    function handleDragEnd(result: DropResult) {
        const { source, destination, draggableId } = result;
        if (!destination) return;
        if (source.droppableId === destination.droppableId && source.index === destination.index) return;
        performMove(draggableId, destination.droppableId, destination.index);
    }

    function handleQuickAdd(status: string) {
        const title = (quickAdd[status] || "").trim();
        if (!title) return;
        setQuickAdd((prev) => ({ ...prev, [status]: "" }));
        startTransition(async () => {
            try {
                const created = await createOfficeTask({ title, status });
                setTasks((prev) => [...prev, created as unknown as Task]);
            } catch {
                toast.error("Failed to create task");
            }
        });
    }

    function handleFieldUpdate(id: string, data: {
        title?: string;
        notes?: string | null;
        dueDate?: string | null;
        assigneeId?: string | null;
        aiPrompt?: string | null;
    }) {
        setTasks((prev) =>
            prev.map((t) => {
                if (t.id !== id) return t;
                const updated: Task = { ...t };
                if (data.title !== undefined) updated.title = data.title;
                if (data.notes !== undefined) updated.notes = data.notes;
                if (data.dueDate !== undefined) updated.dueDate = data.dueDate;
                if (data.aiPrompt !== undefined) updated.aiPrompt = data.aiPrompt;
                if (data.assigneeId !== undefined) {
                    updated.assigneeId = data.assigneeId;
                    updated.assignee = data.assigneeId ? users.find((u) => u.id === data.assigneeId) || null : null;
                }
                return updated;
            })
        );
        startTransition(async () => {
            try {
                await updateOfficeTask(id, data);
            } catch {
                toast.error("Failed to update task");
                await refreshBoard();
            }
        });
    }

    function handleStatusSelect(newStatus: string) {
        if (!selectedTask || newStatus === selectedTask.status) return;
        const destCount = tasks.filter((t) => t.status === newStatus && t.id !== selectedTask.id).length;
        performMove(selectedTask.id, newStatus, destCount);
    }

    function handleDelete(id: string) {
        if (!confirm("Delete this task? This cannot be undone.")) return;
        setTasks((prev) => prev.filter((t) => t.id !== id));
        setSelectedTaskId(null);
        startTransition(async () => {
            try {
                await deleteOfficeTask(id);
                toast.success("Task deleted");
            } catch {
                toast.error("Failed to delete task");
                await refreshBoard();
            }
        });
    }

    function handleSuggestPrompt() {
        if (!selectedTask) return;
        const suggested = composePrompt(draftTitle, draftNotes, selectedTask.dueDate);
        setDraftAiPrompt(suggested);
        handleFieldUpdate(selectedTask.id, { aiPrompt: suggested });
    }

    async function handleCopyForClaude() {
        if (!selectedTask) return;
        const text = draftAiPrompt.trim() || composePrompt(draftTitle, draftNotes, selectedTask.dueDate);
        try {
            await navigator.clipboard.writeText(text);
            toast.success("Copied to clipboard");
        } catch {
            toast.error("Failed to copy — clipboard unavailable");
        }
    }

    return (
        <>
            {/* Toolbar */}
            <div className="bg-white border-b border-hui-border px-6 py-4 flex items-center justify-between gap-4 flex-wrap shrink-0">
                <div>
                    <h1 className="text-xl font-bold text-hui-textMain">Office Tasks</h1>
                    <p className="text-sm text-hui-textMuted mt-0.5">{tasks.length} tasks</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => setFilterId(null)} className={chipClass(filterId === null)}>
                        All
                    </button>
                    {users.map((u) => (
                        <button key={u.id} onClick={() => setFilterId(u.id)} className={chipClass(filterId === u.id)}>
                            {firstName(u)}
                        </button>
                    ))}
                </div>
            </div>

            {filterId && (
                <div className="px-6 pt-2 text-xs text-hui-textMuted shrink-0">
                    Filtered — clear the filter to reorder cards.
                </div>
            )}

            {/* Board */}
            <div className="flex-1 overflow-x-auto overflow-y-hidden">
                <DragDropContext onDragEnd={handleDragEnd}>
                    <div className="flex gap-4 h-full px-6 py-4 min-w-max">
                        {STATUSES.map((status) => (
                            <Droppable droppableId={status} key={status}>
                                {(provided, snapshot) => (
                                    <div
                                        ref={provided.innerRef}
                                        {...provided.droppableProps}
                                        className={`w-80 shrink-0 flex flex-col bg-white rounded-xl shadow-sm border border-hui-border p-3 h-full ${snapshot.isDraggingOver ? "bg-slate-50" : ""
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-2 px-1">
                                            <h3 className="text-sm font-semibold text-hui-textMain">{status}</h3>
                                            <span className="text-xs text-hui-textMuted">{columns[status].length}</span>
                                        </div>
                                        <input
                                            className="hui-input text-sm mb-2"
                                            placeholder="+ Add a task…"
                                            value={quickAdd[status] || ""}
                                            onChange={(e) => setQuickAdd((prev) => ({ ...prev, [status]: e.target.value }))}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") handleQuickAdd(status);
                                            }}
                                        />
                                        <div className="flex-1 overflow-y-auto space-y-2 min-h-[40px]">
                                            {columns[status].map((task, index) => {
                                                const due = dueDateInfo(task.dueDate, task.status);
                                                return (
                                                    <Draggable draggableId={task.id} index={index} key={task.id} isDragDisabled={!!filterId}>
                                                        {(dragProvided, dragSnapshot) => (
                                                            <div
                                                                ref={dragProvided.innerRef}
                                                                {...dragProvided.draggableProps}
                                                                {...dragProvided.dragHandleProps}
                                                                onClick={() => setSelectedTaskId(task.id)}
                                                                className={`bg-white border border-hui-border rounded-lg p-3 cursor-pointer hover:border-hui-primary/50 transition ${dragSnapshot.isDragging ? "shadow-lg" : "shadow-sm"
                                                                    }`}
                                                            >
                                                                <p className="text-sm font-medium text-hui-textMain">{task.title}</p>
                                                                <div className="flex items-center gap-2 mt-2 flex-wrap">
                                                                    {task.assignee && (
                                                                        <div
                                                                            title={task.assignee.name || task.assignee.email}
                                                                            className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${avatarColor(
                                                                                task.assignee.id
                                                                            )}`}
                                                                        >
                                                                            {getInitials(task.assignee.name, task.assignee.email)}
                                                                        </div>
                                                                    )}
                                                                    {due && (
                                                                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${due.className}`}>
                                                                            {due.label}
                                                                        </span>
                                                                    )}
                                                                    {task.notes && <NoteIcon className="w-3.5 h-3.5 text-hui-textMuted" />}
                                                                    {task.aiPrompt && <SparkleIcon className="w-3.5 h-3.5 text-hui-primary" />}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                );
                                            })}
                                            {provided.placeholder}
                                        </div>
                                    </div>
                                )}
                            </Droppable>
                        ))}
                    </div>
                </DragDropContext>
            </div>

            {/* Edit dialog */}
            {selectedTask && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    onClick={() => setSelectedTaskId(null)}
                >
                    <div
                        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-hui-border"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center sticky top-0 bg-white z-10">
                            <h2 className="text-lg font-bold text-hui-textMain">Edit Task</h2>
                            <button
                                onClick={() => setSelectedTaskId(null)}
                                className="text-hui-textMuted hover:text-hui-textMain transition"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="p-6 space-y-4 text-sm">
                            <div>
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Title</label>
                                <input
                                    className="hui-input mt-1 w-full"
                                    value={draftTitle}
                                    onChange={(e) => setDraftTitle(e.target.value)}
                                    onBlur={() => {
                                        if (draftTitle.trim() && draftTitle !== selectedTask.title) {
                                            handleFieldUpdate(selectedTask.id, { title: draftTitle.trim() });
                                        }
                                    }}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Notes</label>
                                <textarea
                                    className="hui-input mt-1 w-full"
                                    rows={3}
                                    value={draftNotes}
                                    onChange={(e) => setDraftNotes(e.target.value)}
                                    onBlur={() => {
                                        if (draftNotes !== (selectedTask.notes || "")) {
                                            handleFieldUpdate(selectedTask.id, { notes: draftNotes || null });
                                        }
                                    }}
                                />
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Assignee</label>
                                    <select
                                        className="hui-input mt-1 w-full cursor-pointer"
                                        value={selectedTask.assigneeId || ""}
                                        onChange={(e) => handleFieldUpdate(selectedTask.id, { assigneeId: e.target.value || null })}
                                    >
                                        <option value="">Unassigned</option>
                                        {users.map((u) => (
                                            <option key={u.id} value={u.id}>
                                                {u.name || u.email}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Due Date</label>
                                    <input
                                        type="date"
                                        className="hui-input mt-1 w-full"
                                        value={selectedTask.dueDate ? dueDateToISO(selectedTask.dueDate) : ""}
                                        onChange={(e) => handleFieldUpdate(selectedTask.id, { dueDate: e.target.value || null })}
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Status</label>
                                <select
                                    className="hui-input mt-1 w-full cursor-pointer"
                                    value={selectedTask.status}
                                    onChange={(e) => handleStatusSelect(e.target.value)}
                                >
                                    {STATUSES.map((s) => (
                                        <option key={s} value={s}>
                                            {s}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="border-t border-hui-border pt-4">
                                <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2 flex items-center gap-1">
                                    <SparkleIcon className="w-3.5 h-3.5 text-hui-primary" /> AI Assist
                                </p>
                                <textarea
                                    className="hui-input w-full"
                                    rows={4}
                                    placeholder="What should an AI assistant do for this task?"
                                    value={draftAiPrompt}
                                    onChange={(e) => setDraftAiPrompt(e.target.value)}
                                    onBlur={() => {
                                        if (draftAiPrompt !== (selectedTask.aiPrompt || "")) {
                                            handleFieldUpdate(selectedTask.id, { aiPrompt: draftAiPrompt || null });
                                        }
                                    }}
                                />
                                <div className="flex gap-2 mt-2">
                                    <button
                                        type="button"
                                        disabled={draftAiPrompt.trim().length > 0}
                                        onClick={handleSuggestPrompt}
                                        className="hui-btn hui-btn-secondary text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        Suggest prompt
                                    </button>
                                    <button type="button" onClick={handleCopyForClaude} className="hui-btn hui-btn-secondary text-xs">
                                        Copy for Claude
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-hui-border flex justify-between items-center">
                            <button
                                type="button"
                                onClick={() => handleDelete(selectedTask.id)}
                                className="hui-btn text-red-600 hover:bg-red-50"
                            >
                                Delete
                            </button>
                            <button type="button" onClick={() => setSelectedTaskId(null)} className="hui-btn hui-btn-secondary">
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
