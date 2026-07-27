"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    addTaskComment,
    addTaskPunchItem,
    aiGeneratePunchlist,
    assignSubToTask,
    assignUserToTask,
    deletePunchItem,
    deleteScheduleTask,
    getActiveSubcontractors,
    getEstimateItemsForProject,
    getScheduleTaskDetail,
    getTaskComments,
    getTaskPunchItems,
    linkTasks,
    setTaskLead,
    togglePunchItem,
    unassignSubFromTask,
    unassignUserFromTask,
    unlinkTasks,
    updateScheduleTask,
} from "@/lib/actions";
import TaskDetailPanel from "@/app/projects/[id]/schedule/TaskDetailPanel";
import type { Comment, EstimateItemSummary, PunchItem, Subcontractor, Task, TeamMember } from "@/app/projects/[id]/schedule/schedule-types";
import { BoardDrawerShell } from "./BoardDrawerShell";

type BoardTaskDrawerProps = {
    taskId: string | null;
    hasDraft: boolean;
    hasCrewDraft: boolean;
    teamMembers: TeamMember[];
    onClose: () => void;
    onSelectTask: (taskId: string) => void;
    onDeleted: (taskId: string) => void;
};

function messageFromError(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
}

export function BoardTaskDrawer({ taskId, hasDraft, hasCrewDraft, teamMembers, onClose, onSelectTask, onDeleted }: BoardTaskDrawerProps) {
    const router = useRouter();
    const requestRef = useRef(0);
    const [task, setTask] = useState<Task | null>(null);
    const [allTasks, setAllTasks] = useState<Task[]>([]);
    const [punchItems, setPunchItems] = useState<PunchItem[]>([]);
    const [comments, setComments] = useState<Comment[]>([]);
    const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([]);
    const [estimateItems, setEstimateItems] = useState<EstimateItemSummary[]>([]);
    const [panelTab, setPanelTab] = useState<"details" | "punch" | "conversation">("details");
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isAiPunching, setIsAiPunching] = useState(false);

    const refreshDetail = useCallback(async () => {
        if (!taskId) return;
        const requestId = ++requestRef.current;
        setIsLoading(true);
        setLoadError(null);
        try {
            // Authorize and load the canonical task before fetching the legacy
            // supplemental endpoints, which intentionally retain their existing contracts.
            const detail = await getScheduleTaskDetail(taskId);
            const [nextPunchItems, nextComments, nextSubcontractors] = await Promise.all([
                getTaskPunchItems(taskId),
                getTaskComments(taskId),
                getActiveSubcontractors(),
            ]);
            if (requestId !== requestRef.current) return;
            const { allTasks: detailTasks, ...selectedTask } = detail;
            setTask(selectedTask as Task);
            setAllTasks(detailTasks as Task[]);
            setPunchItems(nextPunchItems as PunchItem[]);
            setComments(nextComments.map(comment => ({ ...comment, createdAt: comment.createdAt.toISOString?.() ?? String(comment.createdAt) })) as Comment[]);
            setSubcontractors(nextSubcontractors as Subcontractor[]);
        } catch (error) {
            if (requestId !== requestRef.current) return;
            const message = messageFromError(error, "Could not load task details");
            setLoadError(message);
            toast.error(message);
        } finally {
            if (requestId === requestRef.current) setIsLoading(false);
        }
    }, [taskId]);

    useEffect(() => {
        setTask(null);
        setAllTasks([]);
        setPanelTab("details");
        setEstimateItems([]);
        if (taskId) void refreshDetail();
        return () => { requestRef.current += 1; };
    }, [taskId, refreshDetail]);

    async function mutate(operation: () => Promise<unknown>, fallback: string, success?: string) {
        try {
            await operation();
            if (success) toast.success(success);
            await refreshDetail();
            router.refresh();
        } catch (error) {
            toast.error(messageFromError(error, fallback));
            await refreshDetail();
        }
    }

    if (!taskId) return null;

    return (
        <BoardDrawerShell open ariaLabel="Task details" onClose={onClose}>
            {task && task.id === taskId ? (
                    <TaskDetailPanel
                        task={task}
                        onClose={onClose}
                        panelTab={panelTab}
                        setPanelTab={setPanelTab}
                        onStatusChange={(id, status, blockedReason) => { void mutate(() => updateScheduleTask(id, { status, blockedReason: status === "Blocked" ? blockedReason : null }), "Could not update status"); }}
                        onNameChange={(id, name) => { void mutate(() => updateScheduleTask(id, { name }), "Could not update task name"); }}
                        onDoneWhenChange={(id, doneWhen) => { void mutate(() => updateScheduleTask(id, { doneWhen }), "Could not update completion criteria"); }}
                        onDateChange={(id, field, value) => { void mutate(() => updateScheduleTask(id, { [field]: value }), "Could not update task dates"); }}
                        onEstimatedHoursChange={(id, estimatedHours) => { void mutate(() => updateScheduleTask(id, { estimatedHours }), "Could not update estimated hours"); }}
                        onColorChange={(id, color) => { void mutate(() => updateScheduleTask(id, { color }), "Could not update task color"); }}
                        onDelete={id => {
                            void (async () => {
                                try {
                                    await deleteScheduleTask(id);
                                    toast.success("Task deleted");
                                    onDeleted(id);
                                    router.refresh();
                                } catch (error) {
                                    toast.error(messageFromError(error, "Could not delete task"));
                                }
                            })();
                        }}
                        estimateItems={estimateItems}
                        onLinkEstimateItem={(id, item) => { void mutate(() => updateScheduleTask(id, { estimateItemId: item.id }), "Could not link estimate item"); }}
                        onUnlinkEstimateItem={id => { void mutate(() => updateScheduleTask(id, { estimateItemId: null }), "Could not remove estimate link"); }}
                        onFetchEstimateItems={() => {
                            getEstimateItemsForProject(task.projectId as string)
                                .then(items => setEstimateItems(items as EstimateItemSummary[]))
                                .catch(error => toast.error(messageFromError(error, "Could not load estimate items")));
                        }}
                        teamMembers={teamMembers}
                        subcontractors={subcontractors}
                        onAssign={userId => { void mutate(() => assignUserToTask(task.id, userId), "Could not assign crew member"); }}
                        onUnassign={userId => { void mutate(() => unassignUserFromTask(task.id, userId), "Could not remove crew member"); }}
                        onSetLead={userId => { void mutate(() => setTaskLead(task.id, userId), "Could not update task lead"); }}
                        onAssignSub={subcontractorId => { void mutate(() => assignSubToTask(task.id, subcontractorId), "Could not assign subcontractor"); }}
                        onUnassignSub={subcontractorId => { void mutate(() => unassignSubFromTask(task.id, subcontractorId), "Could not remove subcontractor"); }}
                        punchItems={punchItems}
                        onAddPunch={name => { void mutate(() => addTaskPunchItem(task.id, name), "Could not add punch item"); }}
                        onTogglePunch={id => { void mutate(() => togglePunchItem(id), "Could not update punch item"); }}
                        onDeletePunch={id => { void mutate(() => deletePunchItem(id), "Could not delete punch item"); }}
                        onAiPunchlist={() => {
                            setIsAiPunching(true);
                            void mutate(() => aiGeneratePunchlist(task.id), "Could not generate punch list", "Punch list generated").finally(() => setIsAiPunching(false));
                        }}
                        isAiPunching={isAiPunching}
                        comments={comments}
                        onAddComment={text => { void mutate(() => addTaskComment(task.id, text), "Could not add comment"); }}
                        showCriticalPath={false}
                        criticalPathIds={new Set<string>()}
                        allTasks={allTasks}
                        onLinkPredecessor={predecessorId => { void mutate(() => linkTasks(predecessorId, task.id), "Could not add predecessor"); }}
                        onUnlinkPredecessor={predecessorId => { void mutate(() => unlinkTasks(predecessorId, task.id), "Could not remove predecessor"); }}
                        onSelectTask={onSelectTask}
                        onAppointmentChange={(id, data) => { void mutate(() => updateScheduleTask(id, data), "Could not update appointment"); }}
                        datesReadOnly={hasDraft}
                        dateReadOnlyNote="This task has unsaved changes on the board — Save or Discard them first."
                        crewReadOnly={hasCrewDraft}
                        crewReadOnlyNote="Crew changes are drafted for dispatch — Review or Discard them first."
                        embedded
                    />
                ) : (
                    <div className="flex h-full flex-col bg-white">
                        <div className="flex items-center justify-between border-b border-hui-border bg-slate-50 px-5 py-4">
                            <span className="text-sm font-bold text-hui-textMain">Task details</span>
                            <button type="button" onClick={onClose} aria-label="Close task details" className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg></button>
                        </div>
                        <div className="flex flex-1 items-center justify-center px-6 text-center">
                            {isLoading || (!loadError && task?.id !== taskId) ? <div><div className="mx-auto h-7 w-7 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" /><p className="mt-3 text-xs text-hui-textMuted">Loading task…</p></div> : <div><p className="text-sm font-semibold text-hui-textMain">Could not open this task</p><p className="mt-1 text-xs text-hui-textMuted">{loadError}</p><button type="button" onClick={() => void refreshDetail()} className="hui-btn hui-btn-secondary mt-4 text-xs">Try again</button></div>}
                        </div>
                    </div>
            )}
        </BoardDrawerShell>
    );
}
