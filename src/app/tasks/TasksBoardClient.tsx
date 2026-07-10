"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { toast } from "sonner";
import {
    createOfficeTask,
    updateOfficeTask,
    moveOfficeTask,
    deleteOfficeTask,
    archiveOfficeTask,
    restoreOfficeTask,
    createBoardColumn,
    renameBoardColumn,
    reorderBoardColumn,
    deleteBoardColumn,
    getOfficeTasksBoard,
} from "@/lib/actions";
import { formatLocalDateString, parseLocalDateString } from "@/lib/report-utils";

type BoardUser = { id: string; name: string | null; email: string };

type BoardColumn = {
    id: string;
    name: string;
    position: number;
    isDoneColumn: boolean;
    createdAt: Date | string;
};

type Task = {
    id: string;
    title: string;
    notes: string | null;
    status: string;
    columnId: string | null;
    position: number;
    archivedAt: Date | string | null;
    dueDate: Date | string | null;
    assigneeId: string | null;
    assignee: BoardUser | null;
    aiPrompt: string | null;
    automationGap: string | null;
    createdById: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
};

interface Props {
    initialColumns: BoardColumn[];
    initialTasks: Task[];
    initialArchived: Task[];
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

function dueDateInfo(dueDate: Date | string | null, isDoneColumn: boolean): { label: string; className: string } | null {
    if (!dueDate) return null;
    const iso = dueDateToISO(dueDate);
    const label = formatISODateForDisplay(iso);
    if (isDoneColumn) return { label, className: "bg-slate-100 text-slate-600" };

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

function normalizeGapKey(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, " ");
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

function WrenchIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.7 6.3a4 4 0 00-5.6 4.6L4 16l1.4 1.4L10.6 12.7a4 4 0 004.6-5.6l-2.1 2.1a1.5 1.5 0 01-2.1-2.1l2.1-2.1z" />
        </svg>
    );
}

function ChevronIcon({ className, open }: { className?: string; open: boolean }) {
    return (
        <svg className={`${className} transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
    );
}

function DotsIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
        </svg>
    );
}

export default function TasksBoardClient({ initialColumns, initialTasks, initialArchived, users }: Props) {
    const [columns, setColumns] = useState<BoardColumn[]>(initialColumns);
    const [tasks, setTasks] = useState<Task[]>(initialTasks);
    const [archived, setArchived] = useState<Task[]>(initialArchived);
    const [filterId, setFilterId] = useState<string | null>(null);
    const [quickAdd, setQuickAdd] = useState<Record<string, string>>({});
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [draftTitle, setDraftTitle] = useState("");
    const [draftNotes, setDraftNotes] = useState("");
    const [draftAiPrompt, setDraftAiPrompt] = useState("");
    const [draftAutomationGap, setDraftAutomationGap] = useState("");
    const [addingColumn, setAddingColumn] = useState(false);
    const [newColumnName, setNewColumnName] = useState("");
    const [openColumnMenuId, setOpenColumnMenuId] = useState<string | null>(null);
    const [renamingColumnId, setRenamingColumnId] = useState<string | null>(null);
    const [renameDraftName, setRenameDraftName] = useState("");
    const [renameDraftIsDone, setRenameDraftIsDone] = useState(false);
    const [archivedOpen, setArchivedOpen] = useState(false);
    const [gapsOpen, setGapsOpen] = useState(false);
    const [expandedGapKey, setExpandedGapKey] = useState<string | null>(null);
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
            setDraftAutomationGap(selectedTask.automationGap || "");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTaskId]);

    const columnsSorted = useMemo(() => [...columns].sort((a, b) => a.position - b.position), [columns]);
    const firstColumnId = columnsSorted[0]?.id ?? null;

    const columnById = useMemo(() => {
        const map: Record<string, BoardColumn> = {};
        for (const c of columns) map[c.id] = c;
        return map;
    }, [columns]);

    // Tasks with no columnId (shouldn't exist after backfill, but a column could
    // be deleted out from under an archived task and later restored) render in
    // the first column.
    function effectiveColumnId(task: Task): string | null {
        if (task.columnId && columnById[task.columnId]) return task.columnId;
        return firstColumnId;
    }

    const visibleTasks = useMemo(() => {
        if (!filterId) return tasks;
        return tasks.filter((t) => t.assigneeId === filterId);
    }, [tasks, filterId]);

    const tasksByColumn = useMemo(() => {
        const map: Record<string, Task[]> = {};
        for (const c of columnsSorted) map[c.id] = [];
        for (const t of visibleTasks) {
            const key = effectiveColumnId(t);
            if (key) (map[key] ||= []).push(t);
        }
        for (const key of Object.keys(map)) map[key].sort((a, b) => a.position - b.position);
        return map;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleTasks, columnsSorted, firstColumnId]);

    // Purely client-side rollup of open (non-archived) tasks with a non-empty
    // automationGap, grouped by normalized text.
    const automationGapGroups = useMemo(() => {
        const map = new Map<string, { count: number; original: string; tasks: { id: string; title: string }[] }>();
        for (const t of tasks) {
            const raw = (t.automationGap || "").trim();
            if (!raw) continue;
            const key = normalizeGapKey(raw);
            const existing = map.get(key);
            if (existing) {
                existing.count++;
                existing.tasks.push({ id: t.id, title: t.title });
            } else {
                map.set(key, { count: 1, original: raw, tasks: [{ id: t.id, title: t.title }] });
            }
        }
        return Array.from(map.entries())
            .map(([key, v]) => ({ key, ...v }))
            .sort((a, b) => b.count - a.count);
    }, [tasks]);

    // On any server-action failure, re-fetch the authoritative board state instead
    // of restoring a whole-board snapshot — a snapshot restore would also wipe out
    // any other operation that succeeded concurrently. Re-syncs the open dialog's
    // drafts from the refreshed task (or closes the dialog if it was deleted
    // elsewhere).
    async function refreshBoard() {
        try {
            const board = await getOfficeTasksBoard();
            setColumns(board.columns as unknown as BoardColumn[]);
            const freshTasks = board.tasks as unknown as Task[];
            setTasks(freshTasks);
            setArchived(board.archived as unknown as Task[]);
            const currentSelectedId = selectedTaskIdRef.current;
            if (currentSelectedId) {
                const fresh = freshTasks.find((t) => t.id === currentSelectedId);
                if (fresh) {
                    setDraftTitle(fresh.title);
                    setDraftNotes(fresh.notes || "");
                    setDraftAiPrompt(fresh.aiPrompt || "");
                    setDraftAutomationGap(fresh.automationGap || "");
                } else {
                    setSelectedTaskId(null);
                }
            }
        } catch {
            toast.error("Failed to refresh board");
        }
    }

    function performMove(taskId: string, newColumnId: string, newIndex: number) {
        const moved = tasks.find((t) => t.id === taskId);
        if (!moved) return;

        const byColumn: Record<string, Task[]> = {};
        for (const c of columns) byColumn[c.id] = [];
        for (const t of tasks) {
            if (t.id === taskId) continue;
            const key = effectiveColumnId(t);
            if (key) (byColumn[key] ||= []).push(t);
        }
        for (const key of Object.keys(byColumn)) byColumn[key].sort((a, b) => a.position - b.position);

        const destList = byColumn[newColumnId] || (byColumn[newColumnId] = []);
        const clampedIndex = Math.max(0, Math.min(newIndex, destList.length));
        destList.splice(clampedIndex, 0, { ...moved, columnId: newColumnId });

        const next: Task[] = [];
        for (const key of Object.keys(byColumn)) {
            byColumn[key].forEach((t, i) => next.push({ ...t, position: i }));
        }
        setTasks(next);

        startTransition(async () => {
            try {
                await moveOfficeTask(taskId, newColumnId, clampedIndex);
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

    function handleQuickAdd(columnId: string) {
        const title = (quickAdd[columnId] || "").trim();
        if (!title) return;
        setQuickAdd((prev) => ({ ...prev, [columnId]: "" }));
        startTransition(async () => {
            try {
                const created = await createOfficeTask({ title, columnId });
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
        automationGap?: string | null;
    }) {
        setTasks((prev) =>
            prev.map((t) => {
                if (t.id !== id) return t;
                const updated: Task = { ...t };
                if (data.title !== undefined) updated.title = data.title;
                if (data.notes !== undefined) updated.notes = data.notes;
                if (data.dueDate !== undefined) updated.dueDate = data.dueDate;
                if (data.aiPrompt !== undefined) updated.aiPrompt = data.aiPrompt;
                if (data.automationGap !== undefined) updated.automationGap = data.automationGap;
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

    function handleColumnSelect(newColumnId: string) {
        if (!selectedTask) return;
        const currentColumnId = effectiveColumnId(selectedTask);
        if (newColumnId === currentColumnId) return;
        const destCount = (tasksByColumn[newColumnId] || []).length;
        performMove(selectedTask.id, newColumnId, destCount);
    }

    function handleDelete(id: string) {
        if (!confirm("Delete this task? This cannot be undone.")) return;
        setTasks((prev) => prev.filter((t) => t.id !== id));
        setArchived((prev) => prev.filter((t) => t.id !== id));
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

    function handleArchive(id: string) {
        const task = tasks.find((t) => t.id === id);
        if (!task) return;
        setTasks((prev) => prev.filter((t) => t.id !== id));
        setArchived((prev) => [{ ...task, archivedAt: new Date().toISOString() }, ...prev]);
        setSelectedTaskId(null);
        startTransition(async () => {
            try {
                await archiveOfficeTask(id);
                toast.success("Task archived");
            } catch {
                toast.error("Failed to archive task");
                await refreshBoard();
            }
        });
    }

    function handleRestore(id: string) {
        setArchived((prev) => prev.filter((t) => t.id !== id));
        startTransition(async () => {
            try {
                const restored = await restoreOfficeTask(id);
                setTasks((prev) => [...prev, restored as unknown as Task]);
                toast.success("Task restored");
            } catch {
                toast.error("Failed to restore task");
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

    function handleAddColumn() {
        const name = newColumnName.trim();
        if (!name) return;
        setNewColumnName("");
        setAddingColumn(false);
        startTransition(async () => {
            try {
                const created = await createBoardColumn(name);
                setColumns((prev) => [...prev, created as unknown as BoardColumn]);
            } catch (e: any) {
                toast.error(e?.message || "Failed to create column");
            }
        });
    }

    function openRenameDialog(column: BoardColumn) {
        setRenamingColumnId(column.id);
        setRenameDraftName(column.name);
        setRenameDraftIsDone(column.isDoneColumn);
        setOpenColumnMenuId(null);
    }

    function handleRenameSubmit() {
        if (!renamingColumnId) return;
        const trimmed = renameDraftName.trim();
        if (!trimmed) {
            toast.error("Column name is required");
            return;
        }
        const id = renamingColumnId;
        setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, name: trimmed, isDoneColumn: renameDraftIsDone } : c)));
        setRenamingColumnId(null);
        startTransition(async () => {
            try {
                await renameBoardColumn(id, trimmed, renameDraftIsDone);
            } catch (e: any) {
                toast.error(e?.message || "Failed to rename column");
                await refreshBoard();
            }
        });
    }

    function handleColumnReorder(columnId: string, direction: -1 | 1) {
        setOpenColumnMenuId(null);
        const idx = columnsSorted.findIndex((c) => c.id === columnId);
        if (idx === -1) return;
        const newIndex = idx + direction;
        if (newIndex < 0 || newIndex >= columnsSorted.length) return;

        const reordered = [...columnsSorted];
        const [moved] = reordered.splice(idx, 1);
        reordered.splice(newIndex, 0, moved);
        setColumns(reordered.map((c, i) => ({ ...c, position: i })));

        startTransition(async () => {
            try {
                await reorderBoardColumn(columnId, newIndex);
            } catch {
                toast.error("Failed to reorder column");
                await refreshBoard();
            }
        });
    }

    function handleDeleteColumn(columnId: string) {
        setOpenColumnMenuId(null);
        const columnTasks = tasksByColumn[columnId] || [];
        if (columnTasks.length > 0) {
            toast.error("Move or archive all tasks out of this column before deleting it");
            return;
        }
        if (columns.length <= 1) {
            toast.error("The board must have at least one column");
            return;
        }
        if (!confirm("Delete this column?")) return;
        setColumns((prev) => prev.filter((c) => c.id !== columnId));
        startTransition(async () => {
            try {
                await deleteBoardColumn(columnId);
            } catch (e: any) {
                toast.error(e?.message || "Failed to delete column");
                await refreshBoard();
            }
        });
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

            {/* Automation gaps rollup — hidden entirely when there are no gaps */}
            {automationGapGroups.length > 0 && (
                <div className="px-6 pt-3 shrink-0">
                    <div className="hui-card">
                        <button
                            type="button"
                            onClick={() => setGapsOpen((o) => !o)}
                            className="w-full flex items-center justify-between px-4 py-2.5"
                        >
                            <span className="text-sm font-semibold text-hui-textMain flex items-center gap-1.5">
                                <WrenchIcon className="w-4 h-4 text-amber-600" />
                                Automation gaps ({automationGapGroups.length})
                            </span>
                            <ChevronIcon className="w-4 h-4 text-hui-textMuted" open={gapsOpen} />
                        </button>
                        {gapsOpen && (
                            <div className="border-t border-hui-border divide-y divide-slate-100">
                                {automationGapGroups.map((g) => (
                                    <div key={g.key}>
                                        <button
                                            type="button"
                                            onClick={() => setExpandedGapKey((k) => (k === g.key ? null : g.key))}
                                            className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-slate-50 transition"
                                        >
                                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 shrink-0">
                                                {g.count}
                                            </span>
                                            <span className="text-sm text-hui-textMain flex-1">{g.original}</span>
                                            <ChevronIcon className="w-3.5 h-3.5 text-hui-textMuted shrink-0" open={expandedGapKey === g.key} />
                                        </button>
                                        {expandedGapKey === g.key && (
                                            <div className="px-4 pb-2 pl-9 space-y-1">
                                                {g.tasks.map((t) => (
                                                    <button
                                                        key={t.id}
                                                        type="button"
                                                        onClick={() => setSelectedTaskId(t.id)}
                                                        className="block text-xs text-hui-primary hover:underline text-left"
                                                    >
                                                        {t.title}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Board */}
            <div className="flex-1 overflow-x-auto overflow-y-hidden">
                <DragDropContext onDragEnd={handleDragEnd}>
                    <div className="flex gap-4 h-full px-6 py-4 min-w-max">
                        {columnsSorted.map((column) => (
                            <Droppable droppableId={column.id} key={column.id}>
                                {(provided, snapshot) => (
                                    <div
                                        ref={provided.innerRef}
                                        {...provided.droppableProps}
                                        className={`w-80 shrink-0 flex flex-col bg-white rounded-xl shadow-sm border border-hui-border p-3 h-full ${snapshot.isDraggingOver ? "bg-slate-50" : ""
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-2 px-1 relative">
                                            <h3 className="text-sm font-semibold text-hui-textMain flex items-center gap-1.5">
                                                {column.name}
                                                {column.isDoneColumn && (
                                                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">
                                                        Done
                                                    </span>
                                                )}
                                            </h3>
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs text-hui-textMuted">{(tasksByColumn[column.id] || []).length}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenColumnMenuId((id) => (id === column.id ? null : column.id))}
                                                    className="text-hui-textMuted hover:text-hui-textMain transition p-0.5"
                                                >
                                                    <DotsIcon className="w-4 h-4" />
                                                </button>
                                            </div>

                                            {openColumnMenuId === column.id && (
                                                <div
                                                    className="absolute right-0 top-6 z-20 bg-white border border-hui-border rounded-lg shadow-lg py-1 w-44"
                                                    onMouseLeave={() => setOpenColumnMenuId(null)}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => openRenameDialog(column)}
                                                        className="w-full text-left px-3 py-1.5 text-sm text-hui-textMain hover:bg-slate-50"
                                                    >
                                                        Rename
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleColumnReorder(column.id, -1)}
                                                        disabled={columnsSorted.findIndex((c) => c.id === column.id) === 0}
                                                        className="w-full text-left px-3 py-1.5 text-sm text-hui-textMain hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    >
                                                        ← Move left
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleColumnReorder(column.id, 1)}
                                                        disabled={columnsSorted.findIndex((c) => c.id === column.id) === columnsSorted.length - 1}
                                                        className="w-full text-left px-3 py-1.5 text-sm text-hui-textMain hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                                                    >
                                                        Move right →
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeleteColumn(column.id)}
                                                        className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
                                            )}
                                        </div>

                                        <input
                                            className="hui-input text-sm mb-2"
                                            placeholder="+ Add a task…"
                                            value={quickAdd[column.id] || ""}
                                            onChange={(e) => setQuickAdd((prev) => ({ ...prev, [column.id]: e.target.value }))}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") handleQuickAdd(column.id);
                                            }}
                                        />
                                        <div className="flex-1 overflow-y-auto space-y-2 min-h-[40px]">
                                            {(tasksByColumn[column.id] || []).map((task, index) => {
                                                const due = dueDateInfo(task.dueDate, column.isDoneColumn);
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
                                                                    {task.automationGap && <WrenchIcon className="w-3.5 h-3.5 text-amber-600" />}
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

                        {/* + Add column */}
                        <div className="w-64 shrink-0 h-full">
                            {addingColumn ? (
                                <div className="bg-white rounded-xl shadow-sm border border-hui-border p-3">
                                    <input
                                        autoFocus
                                        className="hui-input text-sm mb-2"
                                        placeholder="Column name…"
                                        value={newColumnName}
                                        onChange={(e) => setNewColumnName(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") handleAddColumn();
                                            if (e.key === "Escape") {
                                                setAddingColumn(false);
                                                setNewColumnName("");
                                            }
                                        }}
                                    />
                                    <div className="flex gap-2">
                                        <button type="button" onClick={handleAddColumn} className="hui-btn hui-btn-green text-xs">
                                            Add
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setAddingColumn(false);
                                                setNewColumnName("");
                                            }}
                                            className="hui-btn hui-btn-secondary text-xs"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setAddingColumn(true)}
                                    className="w-full h-11 rounded-xl border border-dashed border-hui-border text-sm text-hui-textMuted hover:border-hui-primary hover:text-hui-primary transition bg-white/50"
                                >
                                    + Add column
                                </button>
                            )}
                        </div>
                    </div>
                </DragDropContext>
            </div>

            {/* Archived drawer */}
            <div className="px-6 pb-4 shrink-0">
                <div className="hui-card">
                    <button
                        type="button"
                        onClick={() => setArchivedOpen((o) => !o)}
                        className="w-full flex items-center justify-between px-4 py-2.5"
                    >
                        <span className="text-sm font-semibold text-hui-textMain">Archived ({archived.length})</span>
                        <ChevronIcon className="w-4 h-4 text-hui-textMuted" open={archivedOpen} />
                    </button>
                    {archivedOpen && (
                        <div className="border-t border-hui-border max-h-64 overflow-y-auto">
                            {archived.length === 0 ? (
                                <p className="px-4 py-3 text-xs text-hui-textMuted">No archived tasks.</p>
                            ) : (
                                <table className="w-full text-sm">
                                    <tbody className="divide-y divide-slate-100">
                                        {archived.map((task) => (
                                            <tr key={task.id}>
                                                <td className="px-4 py-2 text-hui-textMain">{task.title}</td>
                                                <td className="px-4 py-2 text-hui-textMuted text-xs">
                                                    {task.assignee ? task.assignee.name || task.assignee.email : "Unassigned"}
                                                </td>
                                                <td className="px-4 py-2 text-hui-textMuted text-xs whitespace-nowrap">
                                                    {task.archivedAt ? formatISODateForDisplay(dueDateToISO(task.archivedAt)) : ""}
                                                </td>
                                                <td className="px-4 py-2 text-right whitespace-nowrap">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRestore(task.id)}
                                                        className="hui-btn hui-btn-secondary text-xs mr-2"
                                                    >
                                                        Restore
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDelete(task.id)}
                                                        className="hui-btn text-xs text-red-600 hover:bg-red-50"
                                                    >
                                                        Delete
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Rename column dialog */}
            {renamingColumnId && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    onClick={() => setRenamingColumnId(null)}
                >
                    <div
                        className="bg-white rounded-xl shadow-xl max-w-sm w-full border border-hui-border p-6"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 className="text-base font-bold text-hui-textMain mb-4">Rename Column</h2>
                        <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Name</label>
                        <input
                            autoFocus
                            className="hui-input mt-1 w-full mb-4"
                            value={renameDraftName}
                            onChange={(e) => setRenameDraftName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleRenameSubmit();
                            }}
                        />
                        <label className="flex items-center gap-2 text-sm text-hui-textMain mb-4 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={renameDraftIsDone}
                                onChange={(e) => setRenameDraftIsDone(e.target.checked)}
                            />
                            This is a &quot;Done&quot; column (overdue badges are suppressed here)
                        </label>
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setRenamingColumnId(null)} className="hui-btn hui-btn-secondary">
                                Cancel
                            </button>
                            <button type="button" onClick={handleRenameSubmit} className="hui-btn hui-btn-green">
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
                                <label className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Column</label>
                                <select
                                    className="hui-input mt-1 w-full cursor-pointer"
                                    value={effectiveColumnId(selectedTask) || ""}
                                    onChange={(e) => handleColumnSelect(e.target.value)}
                                >
                                    {columnsSorted.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name}
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

                            <div className="border-t border-hui-border pt-4">
                                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-1 flex items-center gap-1">
                                    <WrenchIcon className="w-3.5 h-3.5" /> Automation Gap
                                </p>
                                <p className="text-xs text-hui-textMuted mb-2">What would make this automatic next time?</p>
                                <textarea
                                    className="hui-input w-full bg-amber-50/50 border-amber-200 focus:border-amber-400 focus:ring-amber-400"
                                    rows={3}
                                    placeholder="e.g. we don't have API access to the vendor portal to check order status automatically"
                                    value={draftAutomationGap}
                                    onChange={(e) => setDraftAutomationGap(e.target.value)}
                                    onBlur={() => {
                                        if (draftAutomationGap !== (selectedTask.automationGap || "")) {
                                            handleFieldUpdate(selectedTask.id, { automationGap: draftAutomationGap || null });
                                        }
                                    }}
                                />
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t border-hui-border flex justify-between items-center">
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleDelete(selectedTask.id)}
                                    className="hui-btn text-red-600 hover:bg-red-50"
                                >
                                    Delete
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleArchive(selectedTask.id)}
                                    className="hui-btn hui-btn-secondary"
                                >
                                    Archive
                                </button>
                            </div>
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
