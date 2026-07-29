"use client";

import { useMemo, useState, type RefObject } from "react";
import { FloatingPopover } from "@/app/company-dashboard/schedule-board/FloatingPopover";
import type { Task } from "./schedule-types";

export type DependencyPickerProps = {
    open: boolean;
    /** The "+ Add" button the panel opens from. */
    anchorRef: RefObject<HTMLElement | null>;
    task: Task;
    allTasks: Task[];
    onPick: (predecessorId: string) => void;
    onClose: () => void;
    align?: "left" | "right";
};

// Walk the dependents graph from `taskId` and collect every reachable id.
// Used to exclude tasks that would create a cycle if linked as a predecessor.
function getReachableSuccessors(taskId: string, tasks: Task[]): Set<string> {
    const reachable = new Set<string>();
    const map = new Map(tasks.map(t => [t.id, t] as const));
    const stack: string[] = [taskId];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        const t = map.get(cur);
        if (!t) continue;
        for (const dep of t.dependents) {
            if (!reachable.has(dep.dependentId)) {
                reachable.add(dep.dependentId);
                stack.push(dep.dependentId);
            }
        }
    }
    return reachable;
}

export default function DependencyPicker({ open, anchorRef, task, allTasks, onPick, onClose, align = "right" }: DependencyPickerProps) {
    const [query, setQuery] = useState("");

    const candidates = useMemo(() => {
        const existing = new Set(task.dependencies.map(d => d.predecessorId));
        const successors = getReachableSuccessors(task.id, allTasks);
        const q = query.trim().toLowerCase();
        return allTasks.filter(t =>
            t.id !== task.id &&
            !existing.has(t.id) &&
            !successors.has(t.id) &&
            (q === "" || t.name.toLowerCase().includes(q))
        );
    }, [task.id, task.dependencies, allTasks, query]);

    return (
        <FloatingPopover open={open} anchorRef={anchorRef} onClose={onClose} width={260} align={align} padded={false} dismissible={false}>
        {/* Keeps its own max-height so the search box stays pinned while only
            the results scroll. React portals still bubble events through the
            React tree, hence the stopPropagation. */}
        <div
            className="max-h-72 overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
        >
            <div className="p-2 border-b border-slate-100">
                <input
                    autoFocus
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search tasks…"
                    className="hui-input text-xs w-full py-1"
                />
            </div>
            <div className="overflow-y-auto py-1">
                {candidates.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-slate-400 italic">
                        {allTasks.length <= 1
                            ? "Add another task first to create a link."
                            : query.trim()
                                ? "No matching tasks."
                                : "No eligible tasks — others would create a cycle or are already linked."}
                    </div>
                ) : (
                    candidates.map(t => (
                        <button
                            key={t.id}
                            onClick={() => { onPick(t.id); onClose(); }}
                            className="w-full text-left px-3 py-2 hover:bg-slate-50 transition flex items-center gap-2 text-xs"
                        >
                            {t.type === "milestone" ? (
                                <div className="w-2.5 h-2.5 rotate-45 shrink-0" style={{ backgroundColor: t.color }} />
                            ) : (
                                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                            )}
                            <span className="font-medium truncate flex-1">{t.name}</span>
                            <span className="text-[9px] text-slate-400">{t.startDate}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
        </FloatingPopover>
    );
}
