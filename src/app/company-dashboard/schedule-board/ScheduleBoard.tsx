"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { shiftNotStartedTasksAction, updateCompanyScheduleTaskDatesAction, updateProjectStartDateAction } from "@/lib/actions";
import type { CompanyDashboardData, DashboardProjectRow, DashboardTaskRow, OverlayIncomeItem } from "@/lib/schedule-core";
import { addDays, formatDate, getDaysBetween, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { MonthBarsView } from "./MonthBarsView";
import { TimelineView } from "./TimelineView";
import { ShiftConfirmDialog, type ProjectMoveChoice } from "./ShiftConfirmDialog";
import { UnscheduledTray } from "./UnscheduledTray";
import {
    createProjectDropIntent,
    getEffectivePendingProjectIds,
    getEffectiveProjectRange,
    getNewlyPendingProjectIds,
    getTimelineAutoscrollStep,
    getTimelinePointerDelta,
    previewProjectMove,
    previewProjectWithPersistedTaskDates,
    previewProjectIncomeOverlays,
    previewShiftedTaskIncomeOverlays,
    previewTaskDates,
    previewTaskPointerCandidate,
    projectRefreshMatches,
    taskDatesMatch,
    type ProjectDropIntent,
    type ProjectRefreshExpectation,
    type TaskDateOverride,
    type TaskEditMode,
} from "./useBarLayout";
import type { TaskPointerEditStart } from "./TaskBlockSegment";
import type { ProjectPointerEditStart } from "./ProjectBar";

export type { ProjectMoveChoice } from "./ShiftConfirmDialog";
export type { ProjectDropIntent } from "./useBarLayout";
export type BoardView = "month" | "timeline";

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BOARD_VIEW_STORAGE_KEY = "gtr-company-schedule-board-view";
const TASK_MOUSE_DRAG_THRESHOLD_PX = 5;
const TASK_TOUCH_DRAG_THRESHOLD_PX = 8;
const PROJECT_MOUSE_DRAG_THRESHOLD_PX = 5;
const PROJECT_TOUCH_DRAG_THRESHOLD_PX = 8;
const EDGE_AUTOSCROLL_THRESHOLD_PX = 48;
const MAX_AUTOSCROLL_PX_PER_FRAME = 16;
const EMPTY_PROJECT_IDS: ReadonlySet<string> = new Set();

interface ScheduleBoardProps {
    data: CompanyDashboardData;
    externallyPendingProjectIds: ReadonlySet<string>;
    isProjectExternallyPending: (projectId: string) => boolean;
    onEffectivePendingProjectIdsChange: (projectIds: ReadonlySet<string>) => void;
}

interface TaskKeyboardEditState {
    taskId: string;
    projectId: string;
    mode: TaskEditMode;
    deltaDays: number;
}

interface ActiveTaskPointerEdit {
    taskId: string;
    projectId: string;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    originX: number;
    latestClientX: number;
    latestClientY: number;
    grabDate: string | null;
    mode: TaskEditMode;
    active: boolean;
    currentCandidate: TaskDateOverride | null;
    animationFrameId: number | null;
    sourceElement: HTMLElement;
    previousTouchAction: string;
    cleanup: () => void;
}

interface ProjectKeyboardEditState {
    projectId: string;
    targetStart: string;
}

interface ActiveProjectPointerEdit {
    projectId: string;
    project: DashboardProjectRow;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    originX: number;
    latestClientX: number;
    latestClientY: number;
    grabDate: string;
    originalStart: string;
    active: boolean;
    animationFrameId: number | null;
    sourceElement: HTMLElement;
    previousTouchAction: string;
    start: ProjectPointerEditStart;
    cleanup: () => void;
}

function hitTestScheduleDate(clientX: number, clientY: number): string | null {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        const cell = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-schedule-date]") : null;
        if (cell?.dataset.scheduleDate) return cell.dataset.scheduleDate;
    }
    return null;
}

function hitTestTimelineScheduleGrid(clientX: number, clientY: number): boolean {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.closest("[data-timeline-sticky-label]")) return false;
        const grid = element.closest<HTMLElement>("[data-timeline-schedule-grid]");
        if (!grid) continue;
        const bounds = grid.getBoundingClientRect();
        return clientX >= bounds.left && clientX <= bounds.right
            && clientY >= bounds.top && clientY <= bounds.bottom;
    }
    return false;
}

function isInteractiveTaskFallbackTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && Boolean(target.closest(
        'a,button,input,select,textarea,summary,[contenteditable="true"],[role="button"],[role="group"],[tabindex]:not([tabindex="-1"])',
    ));
}

function shiftMonth(month: string, delta: number): string {
    const [year, monthNumber] = month.split("-").map(Number);
    const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function ScheduleBoard({
    data,
    externallyPendingProjectIds,
    isProjectExternallyPending,
    onEffectivePendingProjectIdsChange,
}: ScheduleBoardProps) {
    const router = useRouter();
    const { month, isAdmin, overlays } = data;
    const [showIncome, setShowIncome] = useState(true);
    const [showProjectedCo, setShowProjectedCo] = useState(true);
    const [showExpenses, setShowExpenses] = useState(false);
    const [showHours, setShowHours] = useState(false);
    const [boardView, setBoardView] = useState<BoardView>("month");
    const [projectPreviewOverrides, setProjectPreviewOverrides] = useState<Record<string, DashboardProjectRow>>({});
    const [projectIncomeOverrides, setProjectIncomeOverrides] = useState<Record<string, OverlayIncomeItem[]>>({});
    const [projectRefreshExpectations, setProjectRefreshExpectations] = useState<Record<string, ProjectRefreshExpectation>>({});
    const [taskDateOverrides, setTaskDateOverrides] = useState<Record<string, TaskDateOverride>>({});
    const [pendingProjectIds, setPendingProjectIds] = useState<Set<string>>(() => new Set());
    const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(() => new Set());
    const [awaitingTaskRefreshIds, setAwaitingTaskRefreshIds] = useState<Set<string>>(() => new Set());
    const [taskKeyboardEdit, setTaskKeyboardEdit] = useState<TaskKeyboardEditState | null>(null);
    const taskKeyboardEditRef = useRef<TaskKeyboardEditState | null>(null);
    const taskKeyboardCleanupRef = useRef<(() => void) | null>(null);
    const taskKeyboardSourceRef = useRef<HTMLElement | null>(null);
    const taskKeyboardSentinelRef = useRef<HTMLSpanElement>(null);
    const activeTaskPointerRef = useRef<ActiveTaskPointerEdit | null>(null);
    const [projectKeyboardEdit, setProjectKeyboardEdit] = useState<ProjectKeyboardEditState | null>(null);
    const projectKeyboardEditRef = useRef<ProjectKeyboardEditState | null>(null);
    const projectKeyboardCleanupRef = useRef<(() => void) | null>(null);
    const projectKeyboardSentinelRef = useRef<HTMLSpanElement>(null);
    const activeProjectPointerRef = useRef<ActiveProjectPointerEdit | null>(null);
    const effectivePendingTaskIdsRef = useRef<Set<string>>(new Set());
    const effectivePendingProjectIdsRef = useRef<Set<string>>(new Set());
    const previousExternallyPendingProjectIdsRef = useRef<ReadonlySet<string>>(new Set(externallyPendingProjectIds));
    const [confirmIntent, setConfirmIntent] = useState<ProjectDropIntent | null>(null);
    const confirmIntentRef = useRef<ProjectDropIntent | null>(null);
    confirmIntentRef.current = confirmIntent;
    const [, startTransition] = useTransition();
    useEffect(() => {
        try {
            const stored = localStorage.getItem(BOARD_VIEW_STORAGE_KEY);
            if (stored === "month" || stored === "timeline") setBoardView(stored);
        } catch {
            // Storage can be unavailable in privacy-restricted browser contexts.
        }
    }, []);
    const anchor = parseUTCDate(`${month}-01`);
    const monthLabel = `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;
    const canonicalProjects = useMemo(() => [
        ...data.pipeline.waitingToStart,
        ...data.pipeline.scheduled,
        ...data.pipeline.inProgress,
        ...data.pipeline.substantialCompletion,
    ], [data.pipeline]);
    const canonicalProjectById = useMemo(() => new Map(canonicalProjects.map(project => [project.id, project])), [canonicalProjects]);
    const canonicalTaskById = useMemo(() => new Map(canonicalProjects.flatMap(project => project.tasks.map(task => [task.id, task] as const))), [canonicalProjects]);
    const canonicalTaskProjectById = useMemo(() => new Map(canonicalProjects.flatMap(project => (
        project.tasks.map(task => [task.id, project.id] as const)
    ))), [canonicalProjects]);
    const effectivePendingTaskIds = useMemo(
        () => new Set([...pendingTaskIds, ...awaitingTaskRefreshIds]),
        [awaitingTaskRefreshIds, pendingTaskIds],
    );
    const effectivePendingProjectIds = useMemo(() => getEffectivePendingProjectIds(
        [...pendingProjectIds, ...Object.keys(projectRefreshExpectations), ...externallyPendingProjectIds],
        effectivePendingTaskIds,
        canonicalTaskProjectById,
    ), [canonicalTaskProjectById, effectivePendingTaskIds, externallyPendingProjectIds, pendingProjectIds, projectRefreshExpectations]);
    effectivePendingTaskIdsRef.current = effectivePendingTaskIds;
    effectivePendingProjectIdsRef.current = effectivePendingProjectIds;
    const isProjectPending = (projectId: string) => (
        effectivePendingProjectIdsRef.current.has(projectId) || isProjectExternallyPending(projectId)
    );
    const publishEffectivePendingProjectIds = useCallback((next: ReadonlySet<string>) => {
        effectivePendingProjectIdsRef.current = new Set(next);
        onEffectivePendingProjectIdsChange(next);
    }, [onEffectivePendingProjectIdsChange]);
    useEffect(() => {
        publishEffectivePendingProjectIds(effectivePendingProjectIds);
    }, [effectivePendingProjectIds, publishEffectivePendingProjectIds]);
    useEffect(() => () => onEffectivePendingProjectIdsChange(EMPTY_PROJECT_IDS), [onEffectivePendingProjectIdsChange]);
    const isTaskOrProjectPending = (taskId: string) => {
        const projectId = canonicalTaskProjectById.get(taskId);
        return effectivePendingTaskIdsRef.current.has(taskId) || Boolean(projectId && isProjectPending(projectId));
    };
    const projectRefreshCount = Object.keys(projectRefreshExpectations).length;
    const pendingRefreshKinds = [
        projectRefreshCount > 0 ? "project" : null,
        awaitingTaskRefreshIds.size > 0 ? "task" : null,
    ].filter((kind): kind is string => Boolean(kind));
    const applyPreview = (project: DashboardProjectRow) => {
        const projectPreview = projectPreviewOverrides[project.id] ?? project;
        return {
            ...projectPreview,
            tasks: projectPreview.tasks.map(task => {
                const dates = taskDateOverrides[task.id];
                return dates ? { ...task, ...dates } : task;
            }),
        };
    };
    let previewOverlays = data.overlays;
    if (previewOverlays) {
        for (const [projectId, rows] of Object.entries(projectIncomeOverrides)) {
            const rowById = new Map(rows.map(row => [row.id, row]));
            previewOverlays = {
                ...previewOverlays,
                income: previewOverlays.income.map(row => row.projectId === projectId ? rowById.get(row.id) ?? row : row),
            };
        }
    }
    const boardData: CompanyDashboardData = {
        ...data,
        pipeline: {
            ...data.pipeline,
            waitingToStart: data.pipeline.waitingToStart.map(applyPreview),
            scheduled: data.pipeline.scheduled.map(applyPreview),
            inProgress: data.pipeline.inProgress.map(applyPreview),
            substantialCompletion: data.pipeline.substantialCompletion.map(applyPreview),
        },
        overlays: data.overlays ? previewOverlays : null,
    };

    function setProjectPending(projectId: string, pending: boolean) {
        if (pending) {
            const next = new Set(effectivePendingProjectIdsRef.current).add(projectId);
            publishEffectivePendingProjectIds(next);
        }
        setPendingProjectIds(current => {
            const next = new Set(current);
            if (pending) next.add(projectId);
            else next.delete(projectId);
            return next;
        });
    }

    function setTaskPending(taskId: string, pending: boolean) {
        if (pending) {
            effectivePendingTaskIdsRef.current = new Set(effectivePendingTaskIdsRef.current).add(taskId);
            const projectId = canonicalTaskProjectById.get(taskId);
            if (projectId) {
                const next = new Set(effectivePendingProjectIdsRef.current).add(projectId);
                publishEffectivePendingProjectIds(next);
            }
        }
        setPendingTaskIds(current => {
            const next = new Set(current);
            if (pending) next.add(taskId);
            else next.delete(taskId);
            return next;
        });
    }

    function setTaskKeyboardState(next: TaskKeyboardEditState | null) {
        taskKeyboardEditRef.current = next;
        setTaskKeyboardEdit(next);
    }

    function setTaskPreview(taskId: string, dates: TaskDateOverride) {
        setTaskDateOverrides(current => ({ ...current, [taskId]: dates }));
    }

    function clearTaskPreview(taskId: string) {
        setTaskDateOverrides(current => {
            if (!(taskId in current)) return current;
            const next = { ...current };
            delete next[taskId];
            return next;
        });
    }

    function cancelTaskEditsForProjects(projectIds: ReadonlySet<string>) {
        const pointerEdit = activeTaskPointerRef.current;
        if (pointerEdit && projectIds.has(pointerEdit.projectId)) {
            pointerEdit.cleanup();
            clearTaskPreview(pointerEdit.taskId);
        }
        const keyboardEdit = taskKeyboardEditRef.current;
        if (keyboardEdit && projectIds.has(keyboardEdit.projectId)) {
            clearTaskPreview(keyboardEdit.taskId);
            taskKeyboardCleanupRef.current?.();
            setTaskKeyboardState(null);
        }
    }

    function cancelActiveTaskEdit() {
        const pointerEdit = activeTaskPointerRef.current;
        if (pointerEdit) {
            pointerEdit.cleanup();
            clearTaskPreview(pointerEdit.taskId);
        }
        const keyboardEdit = taskKeyboardEditRef.current;
        if (keyboardEdit) clearTaskPreview(keyboardEdit.taskId);
        taskKeyboardCleanupRef.current?.();
        setTaskKeyboardState(null);
    }

    useEffect(() => {
        const refreshedTaskById = new Map([
            ...data.pipeline.waitingToStart,
            ...data.pipeline.scheduled,
            ...data.pipeline.inProgress,
            ...data.pipeline.substantialCompletion,
        ].flatMap(project => project.tasks.map(task => [task.id, task] as const)));
        const reconciledTaskIds = [...awaitingTaskRefreshIds].filter(taskId => {
            const canonicalTask = refreshedTaskById.get(taskId);
            const dates = taskDateOverrides[taskId];
            return Boolean(canonicalTask && dates && taskDatesMatch(canonicalTask, dates));
        });
        if (reconciledTaskIds.length === 0) return;

        // Prop reconciliation is intentionally deferred out of the effect body.
        // Until refreshed canonical rows match, saved overrides stay rendered and
        // the task remains gated against stale-base sequential edits.
        const timeoutId = window.setTimeout(() => {
            const reconciled = new Set(reconciledTaskIds);
            setTaskDateOverrides(current => Object.fromEntries(
                Object.entries(current).filter(([taskId]) => !reconciled.has(taskId)),
            ));
            setPendingTaskIds(current => new Set([...current].filter(taskId => !reconciled.has(taskId))));
            setAwaitingTaskRefreshIds(current => new Set([...current].filter(taskId => !reconciled.has(taskId))));
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [awaitingTaskRefreshIds, data, taskDateOverrides]);

    useEffect(() => {
        const reconciledProjectIds = Object.entries(projectRefreshExpectations).flatMap(([projectId, expectation]) => {
            const canonical = canonicalProjectById.get(projectId);
            return projectRefreshMatches(canonical, expectation) ? [projectId] : [];
        });
        if (reconciledProjectIds.length === 0) return;
        const reconciled = new Set(reconciledProjectIds);
        const timeoutId = window.setTimeout(() => {
            setProjectPreviewOverrides(current => Object.fromEntries(Object.entries(current).filter(([id]) => !reconciled.has(id))));
            setProjectIncomeOverrides(current => Object.fromEntries(Object.entries(current).filter(([id]) => !reconciled.has(id))));
            setProjectRefreshExpectations(current => Object.fromEntries(Object.entries(current).filter(([id]) => !reconciled.has(id))));
            setPendingProjectIds(current => new Set([...current].filter(id => !reconciled.has(id))));
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [canonicalProjectById, projectRefreshExpectations]);

    useEffect(() => {
        if (Object.keys(projectRefreshExpectations).length === 0 && awaitingTaskRefreshIds.size === 0) return;
        const intervalId = window.setInterval(() => router.refresh(), 2_000);
        return () => window.clearInterval(intervalId);
    }, [awaitingTaskRefreshIds.size, projectRefreshExpectations, router]);

    useEffect(() => () => {
        activeProjectPointerRef.current?.cleanup();
        projectKeyboardCleanupRef.current?.();
        activeTaskPointerRef.current?.cleanup();
        taskKeyboardCleanupRef.current?.();
    }, []);

    function selectBoardView(nextView: BoardView) {
        cancelActiveProjectEdit();
        cancelActiveTaskEdit();
        setBoardView(nextView);
        try {
            localStorage.setItem(BOARD_VIEW_STORAGE_KEY, nextView);
        } catch {
            // The selected view still applies for this session when persistence fails.
        }
    }

    function setProjectPreview(project: DashboardProjectRow, targetStart: string) {
        const preview = previewProjectMove(project, targetStart);
        setProjectPreviewOverrides(current => ({ ...current, [project.id]: preview }));
        if (data.overlays && project.status === "Waiting to Start" && project.startDate) {
            const intent = createProjectDropIntent(project, targetStart);
            if (intent) {
                setProjectIncomeOverrides(current => ({
                    ...current,
                    [project.id]: previewProjectIncomeOverlays(data.overlays!.income, project.id, intent.deltaDays),
                }));
            }
        }
    }

    function clearProjectPreview(projectId: string) {
        setProjectPreviewOverrides(current => {
            if (!(projectId in current)) return current;
            const next = { ...current };
            delete next[projectId];
            return next;
        });
        setProjectIncomeOverrides(current => {
            if (!(projectId in current)) return current;
            const next = { ...current };
            delete next[projectId];
            return next;
        });
    }

    function awaitProjectRefresh(
        project: DashboardProjectRow,
        expectation: ProjectRefreshExpectation,
        income: OverlayIncomeItem[] | null,
    ) {
        setProjectPreviewOverrides(current => ({ ...current, [project.id]: project }));
        if (income) setProjectIncomeOverrides(current => ({ ...current, [project.id]: income }));
        else setProjectIncomeOverrides(current => {
            const next = { ...current };
            delete next[project.id];
            return next;
        });
        setProjectRefreshExpectations(current => ({ ...current, [project.id]: expectation }));
        router.refresh();
    }

    async function commitTaskDates(taskId: string, dates: TaskDateOverride): Promise<void> {
        const canonicalTask = canonicalTaskById.get(taskId);
        if (!data.canEdit || isTaskOrProjectPending(taskId) || !canonicalTask) {
            clearTaskPreview(taskId);
            return;
        }

        const normalizedDates = {
            startDate: formatDate(parseUTCDate(dates.startDate)),
            endDate: canonicalTask.type === "milestone"
                ? formatDate(parseUTCDate(dates.startDate))
                : formatDate(parseUTCDate(dates.endDate)),
        };
        if (canonicalTask.type !== "milestone" && parseUTCDate(normalizedDates.endDate) <= parseUTCDate(normalizedDates.startDate)) {
            clearTaskPreview(taskId);
            toast.error("Task end date must be after its start date");
            return;
        }
        const originalDates = {
            startDate: canonicalTask.startDate.slice(0, 10),
            endDate: canonicalTask.endDate.slice(0, 10),
        };
        if (normalizedDates.startDate === originalDates.startDate && normalizedDates.endDate === originalDates.endDate) {
            clearTaskPreview(taskId);
            return;
        }

        dates = normalizedDates;
        setTaskPreview(taskId, normalizedDates);
        setTaskPending(taskId, true);
        try {
            const saved = await updateCompanyScheduleTaskDatesAction(taskId, { startDate: dates.startDate, endDate: dates.endDate });
            const persistedDates = { startDate: formatDate(saved.startDate), endDate: formatDate(saved.endDate) };
            setTaskPreview(taskId, persistedDates);
            toast.success("Task dates updated");
            setAwaitingTaskRefreshIds(current => new Set(current).add(taskId));
            router.refresh();
        } catch (error) {
            clearTaskPreview(taskId);
            setAwaitingTaskRefreshIds(current => {
                const next = new Set(current);
                next.delete(taskId);
                return next;
            });
            setTaskPending(taskId, false);
            toast.error(error instanceof Error ? error.message : "Failed to update task dates");
        }
    }

    function showSuccess(message: string, notes: string[]) {
        if (notes.length > 0) toast.success(message, { description: notes.join(" ") });
        else toast.success(message);
    }

    function showFailure(error: unknown, fallback: string) {
        toast.error(error instanceof Error ? error.message : fallback);
    }

    function scheduleUnscheduledProject(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectPending(project.id)) return;
        cancelActiveTaskEdit();
        const normalizedTarget = formatDate(parseUTCDate(targetStart));
        setProjectPreview(canonicalProject, normalizedTarget);
        setProjectPending(project.id, true);
        startTransition(async () => {
            try {
                const result = await updateProjectStartDateAction(project.id, normalizedTarget, true);
                toast.success("Project scheduled", result.notes.length > 0 ? { description: result.notes.join(" ") } : undefined);
                const preview = previewProjectWithPersistedTaskDates(canonicalProject, result.startDate, result.shiftedTaskDates);
                awaitProjectRefresh(preview, {
                    projectStartDate: result.startDate,
                    taskDates: result.shiftedTaskDates,
                }, data.overlays?.income ?? null);
            } catch (error) {
                clearProjectPreview(project.id);
                showFailure(error, "Failed to schedule project");
            } finally {
                setProjectPending(project.id, false);
            }
        });
    }

    function commitWaitingProjectMove(intent: ProjectDropIntent) {
        if (!data.canEdit || isProjectPending(intent.project.id)) {
            clearProjectPreview(intent.project.id);
            return;
        }
        cancelActiveTaskEdit();
        setProjectPending(intent.project.id, true);
        startTransition(async () => {
            try {
                const result = await updateProjectStartDateAction(intent.project.id, intent.targetStart, true);
                showSuccess("Project moved", result.notes);
                const expected = previewProjectWithPersistedTaskDates(intent.project, result.startDate, result.shiftedTaskDates);
                const income = data.overlays
                    ? previewProjectIncomeOverlays(data.overlays.income, intent.project.id, intent.deltaDays)
                    : null;
                awaitProjectRefresh(expected, {
                    projectStartDate: result.startDate,
                    taskDates: result.shiftedTaskDates,
                }, income);
            } catch (error) {
                clearProjectPreview(intent.project.id);
                showFailure(error, "Failed to move project");
            } finally {
                setProjectPending(intent.project.id, false);
            }
        });
    }

    function handleProjectMovePreview(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectPending(project.id)) {
            clearProjectPreview(project.id);
            return;
        }
        const intent = createProjectDropIntent(canonicalProject, targetStart);
        if (!intent || intent.deltaDays === 0) clearProjectPreview(project.id);
        else setProjectPreview(canonicalProject, intent.targetStart);
    }

    function handleProjectMoveCommit(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectPending(project.id)) {
            clearProjectPreview(project.id);
            setConfirmIntent(null);
            return;
        }
        cancelActiveTaskEdit();
        const intent = createProjectDropIntent(canonicalProject, targetStart);
        if (!intent || intent.deltaDays === 0) {
            clearProjectPreview(project.id);
            setConfirmIntent(null);
            return;
        }

        setProjectPreview(canonicalProject, intent.targetStart);
        if (canonicalProject.status === "In Progress") setConfirmIntent(intent);
        else commitWaitingProjectMove(intent);
    }

    function handleMoveChoice(choice: ProjectMoveChoice) {
        const intent = confirmIntent;
        if (!data.canEdit || !intent) return;
        if (isProjectPending(intent.project.id)) {
            clearProjectPreview(intent.project.id);
            setConfirmIntent(null);
            return;
        }
        cancelActiveTaskEdit();
        setProjectPending(intent.project.id, true);
        startTransition(async () => {
            try {
                if (choice === "marker-only") {
                    const result = await updateProjectStartDateAction(intent.project.id, intent.targetStart, false);
                    showSuccess("Start marker moved", result.notes);
                    const preview = previewProjectWithPersistedTaskDates(intent.project, result.startDate, []);
                    awaitProjectRefresh(preview, { projectStartDate: result.startDate, taskDates: [] }, data.overlays?.income ?? null);
                } else {
                    const result = await shiftNotStartedTasksAction(intent.project.id, intent.deltaDays);
                    showSuccess("Not Started tasks shifted", result.notes);
                    const shiftedTaskIds = new Set(result.shiftedTaskIds);
                    const expected = previewProjectWithPersistedTaskDates(intent.project, intent.project.startDate, result.shiftedTaskDates);
                    const income = data.overlays
                        ? previewShiftedTaskIncomeOverlays(data.overlays.income, intent.project.id, intent.deltaDays, shiftedTaskIds)
                        : null;
                    awaitProjectRefresh(expected, { taskDates: result.shiftedTaskDates }, income);
                }
                setConfirmIntent(null);
            } catch (error) {
                setConfirmIntent(null);
                clearProjectPreview(intent.project.id);
                showFailure(error, "Failed to move project");
            } finally {
                setProjectPending(intent.project.id, false);
            }
        });
    }

    function cancelConfirmedMove() {
        if (!confirmIntent || pendingProjectIds.has(confirmIntent.project.id)) return;
        clearProjectPreview(confirmIntent.project.id);
        setConfirmIntent(null);
    }

    function setProjectKeyboardState(next: ProjectKeyboardEditState | null) {
        projectKeyboardEditRef.current = next;
        setProjectKeyboardEdit(next);
    }

    function cancelProjectEditsForProjects(projectIds: ReadonlySet<string>) {
        const pointerEdit = activeProjectPointerRef.current;
        if (pointerEdit && projectIds.has(pointerEdit.projectId)) {
            pointerEdit.cleanup();
            clearProjectPreview(pointerEdit.projectId);
        }
        const keyboardEdit = projectKeyboardEditRef.current;
        if (keyboardEdit && projectIds.has(keyboardEdit.projectId)) {
            clearProjectPreview(keyboardEdit.projectId);
            projectKeyboardCleanupRef.current?.();
            setProjectKeyboardState(null);
        }
    }

    function cancelActiveProjectEdit() {
        const pointerEdit = activeProjectPointerRef.current;
        if (pointerEdit) {
            pointerEdit.cleanup();
            clearProjectPreview(pointerEdit.projectId);
        }
        const keyboardEdit = projectKeyboardEditRef.current;
        if (keyboardEdit) clearProjectPreview(keyboardEdit.projectId);
        projectKeyboardCleanupRef.current?.();
        setProjectKeyboardState(null);
    }

    const cancelExternallyLockedProjectEdits = useEffectEvent((newlyPendingProjectIds: ReadonlySet<string>) => {
        cancelProjectEditsForProjects(newlyPendingProjectIds);
        cancelTaskEditsForProjects(newlyPendingProjectIds);
        const intent = confirmIntentRef.current;
        if (intent && newlyPendingProjectIds.has(intent.project.id)) {
            clearProjectPreview(intent.project.id);
            setConfirmIntent(null);
        }
    });

    useEffect(() => {
        const newlyPendingProjectIds = getNewlyPendingProjectIds(
            previousExternallyPendingProjectIdsRef.current,
            externallyPendingProjectIds,
        );
        previousExternallyPendingProjectIdsRef.current = new Set(externallyPendingProjectIds);
        if (newlyPendingProjectIds.size === 0) return;

        cancelExternallyLockedProjectEdits(newlyPendingProjectIds);
    }, [externallyPendingProjectIds]);

    function handleProjectPointerEditStart(project: DashboardProjectRow, start: ProjectPointerEditStart) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectPending(project.id)) return;
        cancelActiveProjectEdit();
        cancelActiveTaskEdit();
        const drag: ActiveProjectPointerEdit = {
            projectId: project.id,
            project: canonicalProject,
            pointerId: start.pointerId,
            pointerType: start.pointerType,
            startX: start.clientX,
            startY: start.clientY,
            originX: start.clientX,
            latestClientX: start.clientX,
            latestClientY: start.clientY,
            grabDate: hitTestScheduleDate(start.clientX, start.clientY) ?? start.fallbackGrabDate,
            originalStart: start.originalStart,
            active: false,
            animationFrameId: null,
            sourceElement: start.sourceElement,
            previousTouchAction: start.sourceElement.style.touchAction,
            start,
            cleanup: () => undefined,
        };

        const calculateProjectPointerCandidate = (): string | null => {
            let deltaDays: number | null = null;
            if (drag.start.timelineDayWidth) {
                if (hitTestTimelineScheduleGrid(drag.latestClientX, drag.latestClientY)) {
                    deltaDays = getTimelinePointerDelta(drag.latestClientX, drag.originX, drag.start.timelineDayWidth);
                }
            } else {
                const hitDate = hitTestScheduleDate(drag.latestClientX, drag.latestClientY);
                if (hitDate) deltaDays = getDaysBetween(parseUTCDate(drag.grabDate), parseUTCDate(hitDate));
            }
            return deltaDays == null ? null : formatDate(addDays(parseUTCDate(drag.originalStart), deltaDays));
        };
        const getProjectAutoscrollStep = () => {
            const container = drag.start.timelineScrollContainerRef?.current;
            if (!container || !drag.start.timelineDayWidth) return 0;
            const bounds = container.getBoundingClientRect();
            return getTimelineAutoscrollStep({
                clientX: drag.latestClientX,
                containerLeft: bounds.left,
                containerRight: bounds.right,
                timelineLeftInset: drag.start.timelineLeftInset ?? 0,
                scrollLeft: container.scrollLeft,
                scrollWidth: container.scrollWidth,
                clientWidth: container.clientWidth,
                threshold: EDGE_AUTOSCROLL_THRESHOLD_PX,
                maxStep: MAX_AUTOSCROLL_PX_PER_FRAME,
            });
        };
        const runProjectPointerFrame = () => {
            drag.animationFrameId = null;
            if (!drag.active) return;
            const container = drag.start.timelineScrollContainerRef?.current;
            const scrollDelta = getProjectAutoscrollStep();
            if (container && scrollDelta !== 0) {
                const before = container.scrollLeft;
                container.scrollLeft += scrollDelta;
                drag.originX -= container.scrollLeft - before;
            }
            const candidate = calculateProjectPointerCandidate();
            if (candidate) handleProjectMovePreview(drag.project, candidate);
            else clearProjectPreview(drag.projectId);
            if (getProjectAutoscrollStep() !== 0 && drag.animationFrameId == null) {
                drag.animationFrameId = requestAnimationFrame(runProjectPointerFrame);
            }
        };
        const requestProjectPointerFrame = () => {
            if (drag.animationFrameId == null) drag.animationFrameId = requestAnimationFrame(runProjectPointerFrame);
        };
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerId !== drag.pointerId) return;
            drag.latestClientX = event.clientX;
            drag.latestClientY = event.clientY;
            if (!drag.active) {
                const threshold = drag.pointerType === "touch" ? PROJECT_TOUCH_DRAG_THRESHOLD_PX : PROJECT_MOUSE_DRAG_THRESHOLD_PX;
                if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < threshold) return;
                drag.active = true;
                drag.sourceElement.style.touchAction = "none";
            }
            event.preventDefault();
            requestProjectPointerFrame();
        };
        const finish = (cancelled: boolean, releaseEvent?: PointerEvent) => {
            if (releaseEvent) {
                drag.latestClientX = releaseEvent.clientX;
                drag.latestClientY = releaseEvent.clientY;
            }
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            const candidate = drag.active && !cancelled ? calculateProjectPointerCandidate() : null;
            drag.cleanup();
            if (!drag.active || cancelled || !candidate) {
                clearProjectPreview(drag.projectId);
                return;
            }
            handleProjectMoveCommit(drag.project, candidate);
        };
        const onPointerUp = (event: PointerEvent) => {
            if (event.pointerId === drag.pointerId) finish(false, event);
        };
        const onPointerCancel = (event: PointerEvent) => {
            if (event.pointerId === drag.pointerId) finish(true);
        };
        const onWindowBlur = () => finish(true);
        drag.cleanup = () => {
            if (activeProjectPointerRef.current === drag) activeProjectPointerRef.current = null;
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            window.removeEventListener("blur", onWindowBlur);
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            drag.sourceElement.style.touchAction = drag.previousTouchAction;
            try {
                if (drag.sourceElement.hasPointerCapture(drag.pointerId)) drag.sourceElement.releasePointerCapture(drag.pointerId);
            } catch {
                // The optimistic preview may re-key the originating segment.
            }
        };
        activeProjectPointerRef.current = drag;
        try {
            start.sourceElement.setPointerCapture(start.pointerId);
        } catch {
            // Window listeners keep ownership stable when capture is unavailable.
        }
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        window.addEventListener("blur", onWindowBlur);
    }

    function handleProjectKeyboardStart(project: DashboardProjectRow, sourceElement: HTMLElement) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectPending(project.id)) return;
        const range = getEffectiveProjectRange(canonicalProject);
        if (!range) return;
        const intent = createProjectDropIntent(canonicalProject, formatDate(range.start));
        if (!intent) return;
        cancelActiveProjectEdit();
        cancelActiveTaskEdit();
        setProjectKeyboardState({ projectId: project.id, targetStart: intent.originalStart });
        const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
            const activeElement = document.activeElement;
            if (isInteractiveTaskFallbackTarget(event.target) || isInteractiveTaskFallbackTarget(activeElement)) return;
            const sentinelOwnsFocus = document.activeElement === projectKeyboardSentinelRef.current;
            const disconnectedFocus = !sourceElement.isConnected && activeElement === document.body;
            if (!sentinelOwnsFocus && !disconnectedFocus) return;
            if (disconnectedFocus) projectKeyboardSentinelRef.current?.focus({ preventScroll: true });
            const current = projectKeyboardEditRef.current;
            if (!current) return;
            if (event.key === "Escape") {
                event.preventDefault();
                handleProjectKeyboardCancel(canonicalProject);
            } else if (event.key === "Enter") {
                event.preventDefault();
                handleProjectKeyboardCommit(canonicalProject);
            } else {
                const step = event.shiftKey ? 7 : 1;
                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                    event.preventDefault();
                    handleProjectKeyboardAdjust(canonicalProject, -step);
                } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    handleProjectKeyboardAdjust(canonicalProject, step);
                }
            }
        };
        projectKeyboardCleanupRef.current = () => {
            window.removeEventListener("keydown", onWindowKeyDown);
            if (document.activeElement === projectKeyboardSentinelRef.current) projectKeyboardSentinelRef.current?.blur();
            projectKeyboardCleanupRef.current = null;
        };
        window.addEventListener("keydown", onWindowKeyDown);
    }

    function handleProjectKeyboardAdjust(project: DashboardProjectRow, deltaDays: number) {
        const current = projectKeyboardEditRef.current;
        if (!current || current.projectId !== project.id || isProjectPending(project.id)) return;
        const targetStart = formatDate(addDays(parseUTCDate(current.targetStart), deltaDays));
        setProjectKeyboardState({ ...current, targetStart });
        handleProjectMovePreview(project, targetStart);
    }

    function handleProjectKeyboardCommit(project: DashboardProjectRow) {
        const current = projectKeyboardEditRef.current;
        if (!current || current.projectId !== project.id) return;
        if (isProjectPending(project.id)) {
            handleProjectKeyboardCancel(project);
            return;
        }
        projectKeyboardCleanupRef.current?.();
        setProjectKeyboardState(null);
        handleProjectMoveCommit(project, current.targetStart);
    }

    function handleProjectKeyboardCancel(project: DashboardProjectRow) {
        if (projectKeyboardEditRef.current?.projectId !== project.id) return;
        clearProjectPreview(project.id);
        projectKeyboardCleanupRef.current?.();
        setProjectKeyboardState(null);
    }

    function handleTaskPointerEditStart(task: DashboardTaskRow, mode: TaskEditMode, start: TaskPointerEditStart) {
        const canonicalTask = canonicalTaskById.get(task.id);
        const projectId = canonicalTaskProjectById.get(task.id);
        if (!data.canEdit || isTaskOrProjectPending(task.id) || !canonicalTask || !projectId) return;
        if (canonicalTask.type === "milestone" && mode !== "move") return;

        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        const originalDates = previewTaskDates(canonicalTask, "move", 0);
        if (!originalDates) return;
        const drag: ActiveTaskPointerEdit = {
            taskId: task.id,
            projectId,
            pointerId: start.pointerId,
            pointerType: start.pointerType,
            startX: start.clientX,
            startY: start.clientY,
            originX: start.clientX,
            latestClientX: start.clientX,
            latestClientY: start.clientY,
            grabDate: hitTestScheduleDate(start.clientX, start.clientY),
            mode,
            active: false,
            currentCandidate: originalDates,
            animationFrameId: null,
            sourceElement: start.sourceElement,
            previousTouchAction: start.sourceElement.style.touchAction,
            cleanup: () => undefined,
        };

        const calculatePointerCandidate = (): TaskDateOverride | null => {
            let deltaDays: number | null = null;
            if (start.timelineDayWidth) {
                if (hitTestTimelineScheduleGrid(drag.latestClientX, drag.latestClientY)) {
                    deltaDays = getTimelinePointerDelta(drag.latestClientX, drag.originX, start.timelineDayWidth);
                }
            } else {
                const hitDate = hitTestScheduleDate(drag.latestClientX, drag.latestClientY);
                if (drag.grabDate && hitDate) {
                    deltaDays = getDaysBetween(parseUTCDate(drag.grabDate), parseUTCDate(hitDate));
                }
            }
            return previewTaskPointerCandidate(canonicalTask, mode, deltaDays);
        };
        const applyPointerCandidate = (): TaskDateOverride | null => {
            const candidate = calculatePointerCandidate();
            const previousCandidate = drag.currentCandidate;
            drag.currentCandidate = candidate;
            if (!candidate) {
                drag.currentCandidate = null;
                clearTaskPreview(task.id);
                return null;
            }
            if (previousCandidate?.startDate === candidate.startDate && previousCandidate.endDate === candidate.endDate) return candidate;
            if (candidate.startDate === originalDates.startDate && candidate.endDate === originalDates.endDate) clearTaskPreview(task.id);
            else setTaskPreview(task.id, candidate);
            return candidate;
        };
        const getTaskAutoscrollStep = () => {
            const container = start.timelineScrollContainerRef?.current;
            if (!container || !start.timelineDayWidth) return 0;
            const bounds = container.getBoundingClientRect();
            return getTimelineAutoscrollStep({
                clientX: drag.latestClientX,
                containerLeft: bounds.left,
                containerRight: bounds.right,
                timelineLeftInset: start.timelineLeftInset ?? 0,
                scrollLeft: container.scrollLeft,
                scrollWidth: container.scrollWidth,
                clientWidth: container.clientWidth,
                threshold: EDGE_AUTOSCROLL_THRESHOLD_PX,
                maxStep: MAX_AUTOSCROLL_PX_PER_FRAME,
            });
        };
        const runTaskPointerFrame = () => {
            drag.animationFrameId = null;
            if (!drag.active) return;
            const container = start.timelineScrollContainerRef?.current;
            const scrollDelta = getTaskAutoscrollStep();
            if (container && scrollDelta !== 0) {
                const before = container.scrollLeft;
                container.scrollLeft += scrollDelta;
                drag.originX -= container.scrollLeft - before;
            }
            applyPointerCandidate();
            if (getTaskAutoscrollStep() !== 0 && drag.animationFrameId == null) {
                drag.animationFrameId = requestAnimationFrame(runTaskPointerFrame);
            }
        };
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerId !== drag.pointerId) return;
            drag.latestClientX = event.clientX;
            drag.latestClientY = event.clientY;
            if (!drag.active) {
                const threshold = drag.pointerType === "touch" ? TASK_TOUCH_DRAG_THRESHOLD_PX : TASK_MOUSE_DRAG_THRESHOLD_PX;
                if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < threshold) return;
                drag.active = true;
                drag.sourceElement.style.touchAction = "none";
            }
            event.preventDefault();
            if (drag.animationFrameId == null) drag.animationFrameId = requestAnimationFrame(runTaskPointerFrame);
        };
        const finish = (cancelled: boolean, releaseEvent?: PointerEvent) => {
            if (releaseEvent) {
                drag.latestClientX = releaseEvent.clientX;
                drag.latestClientY = releaseEvent.clientY;
            }
            if (drag.animationFrameId != null) {
                cancelAnimationFrame(drag.animationFrameId);
                drag.animationFrameId = null;
            }
            const candidate = drag.active && !cancelled ? calculatePointerCandidate() : null;
            drag.currentCandidate = candidate;
            drag.cleanup();
            if (!drag.active || cancelled || !candidate) {
                clearTaskPreview(task.id);
                return;
            }
            setTaskPreview(task.id, candidate);
            void commitTaskDates(task.id, candidate);
        };
        const onPointerUp = (event: PointerEvent) => {
            if (event.pointerId === drag.pointerId) finish(false, event);
        };
        const onPointerCancel = (event: PointerEvent) => {
            if (event.pointerId === drag.pointerId) finish(true);
        };
        const onWindowBlur = () => finish(true);

        drag.cleanup = () => {
            if (activeTaskPointerRef.current === drag) activeTaskPointerRef.current = null;
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            window.removeEventListener("blur", onWindowBlur);
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            drag.sourceElement.style.touchAction = drag.previousTouchAction;
            try {
                if (drag.sourceElement.hasPointerCapture(drag.pointerId)) drag.sourceElement.releasePointerCapture(drag.pointerId);
            } catch {
                // A task preview can unmount its original weekly segment.
            }
        };
        activeTaskPointerRef.current = drag;
        try {
            start.sourceElement.setPointerCapture(start.pointerId);
        } catch {
            // Window listeners still provide a stable controller when capture is unavailable.
        }
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        window.addEventListener("blur", onWindowBlur);
    }

    function handleTaskKeyboardStart(task: DashboardTaskRow, mode: TaskEditMode, sourceElement: HTMLElement) {
        const canonicalTask = canonicalTaskById.get(task.id);
        const projectId = canonicalTaskProjectById.get(task.id);
        if (!data.canEdit || isTaskOrProjectPending(task.id) || !canonicalTask || !projectId) return;
        if (canonicalTask.type === "milestone" && mode !== "move") return;
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        taskKeyboardSourceRef.current = sourceElement;
        setTaskKeyboardState({ taskId: task.id, projectId, mode, deltaDays: 0 });
        const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
            const activeElement = document.activeElement;
            if (isInteractiveTaskFallbackTarget(event.target) || isInteractiveTaskFallbackTarget(activeElement)) return;
            const sentinelOwnsFocus = document.activeElement === taskKeyboardSentinelRef.current;
            const disconnectedFocus = !sourceElement.isConnected && activeElement === document.body;
            if (!sentinelOwnsFocus && !disconnectedFocus) return;
            if (disconnectedFocus) taskKeyboardSentinelRef.current?.focus({ preventScroll: true });
            if (event.key === "Escape") {
                event.preventDefault();
                handleTaskKeyboardCancel(canonicalTask);
                return;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                handleTaskKeyboardCommit(canonicalTask, mode);
                return;
            }
            const step = event.shiftKey ? 7 : 1;
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                handleTaskKeyboardAdjust(canonicalTask, mode, -step);
            } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                handleTaskKeyboardAdjust(canonicalTask, mode, step);
            }
        };
        taskKeyboardCleanupRef.current = () => {
            window.removeEventListener("keydown", onWindowKeyDown);
            if (document.activeElement === taskKeyboardSentinelRef.current) taskKeyboardSentinelRef.current?.blur();
            taskKeyboardSourceRef.current = null;
            taskKeyboardCleanupRef.current = null;
        };
        window.addEventListener("keydown", onWindowKeyDown);
    }

    function handleTaskKeyboardAdjust(task: DashboardTaskRow, mode: TaskEditMode, deltaDays: number) {
        const canonicalTask = canonicalTaskById.get(task.id);
        const current = taskKeyboardEditRef.current;
        if (!data.canEdit || isTaskOrProjectPending(task.id) || !canonicalTask || current?.taskId !== task.id || current.mode !== mode) return;
        const nextDeltaDays = current.deltaDays + deltaDays;
        const dates = previewTaskDates(canonicalTask, mode, nextDeltaDays);
        if (!dates) return;
        const originalDates = previewTaskDates(canonicalTask, "move", 0);
        if (originalDates && dates.startDate === originalDates.startDate && dates.endDate === originalDates.endDate) clearTaskPreview(task.id);
        else setTaskPreview(task.id, dates);
        setTaskKeyboardState({ ...current, deltaDays: nextDeltaDays });
    }

    function handleTaskKeyboardCommit(task: DashboardTaskRow, mode: TaskEditMode) {
        const canonicalTask = canonicalTaskById.get(task.id);
        const current = taskKeyboardEditRef.current;
        if (!data.canEdit || isTaskOrProjectPending(task.id) || !canonicalTask || current?.taskId !== task.id || current.mode !== mode) return;
        const dates = previewTaskDates(canonicalTask, mode, current.deltaDays);
        taskKeyboardCleanupRef.current?.();
        setTaskKeyboardState(null);
        if (dates) void commitTaskDates(task.id, dates);
    }

    function handleTaskKeyboardCancel(task: DashboardTaskRow) {
        if (!data.canEdit || taskKeyboardEditRef.current?.taskId !== task.id) return;
        clearTaskPreview(task.id);
        taskKeyboardCleanupRef.current?.();
        setTaskKeyboardState(null);
    }

    function handleTaskDatesCommit(task: DashboardTaskRow, dates: TaskDateOverride) {
        if (!data.canEdit || isTaskOrProjectPending(task.id) || !canonicalTaskById.has(task.id)) return;
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        void commitTaskDates(task.id, dates);
    }

    function handleTaskMoveBy(task: DashboardTaskRow, deltaDays: number) {
        const canonicalTask = canonicalTaskById.get(task.id);
        if (!data.canEdit || isTaskOrProjectPending(task.id) || !canonicalTask) return;
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        const dates = previewTaskDates(canonicalTask, "move", deltaDays);
        if (dates) void commitTaskDates(task.id, dates);
    }

    return (
        <div className="hui-card mb-6 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-hui-border">
                <h2 className="text-base font-semibold text-hui-textMain">Project Schedule — {monthLabel}</h2>
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="inline-flex rounded-md border border-hui-border bg-white p-0.5" role="group" aria-label="Schedule view">
                        <button
                            type="button"
                            onClick={() => selectBoardView("month")}
                            aria-pressed={boardView === "month"}
                            className={`rounded px-2 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${boardView === "month" ? "bg-hui-primary text-white" : "text-hui-textMuted hover:bg-slate-50"}`}
                        >
                            Month
                        </button>
                        <button
                            type="button"
                            onClick={() => selectBoardView("timeline")}
                            aria-pressed={boardView === "timeline"}
                            className={`rounded px-2 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${boardView === "timeline" ? "bg-hui-primary text-white" : "text-hui-textMuted hover:bg-slate-50"}`}
                        >
                            Timeline
                        </button>
                    </div>
                    {isAdmin && overlays && (
                        <div className="flex flex-wrap items-center gap-1 mr-1">
                            <button type="button" onClick={() => setShowIncome(value => !value)} className={`text-xs font-semibold px-2 py-1 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showIncome ? "bg-green-100 text-green-700 border-green-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Income</button>
                            <button type="button" onClick={() => setShowExpenses(value => !value)} className={`text-xs font-semibold px-2 py-1 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showExpenses ? "bg-red-100 text-red-700 border-red-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Expenses</button>
                            <button type="button" onClick={() => setShowProjectedCo(value => !value)} className={`text-xs font-semibold px-2 py-1 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showProjectedCo ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Projected CO</button>
                            <button type="button" onClick={() => setShowHours(value => !value)} className={`text-xs font-semibold px-2 py-1 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showHours ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Hours</button>
                        </div>
                    )}
                    <button type="button" onClick={() => router.push('/company-dashboard?month=' + shiftMonth(month, -1))} className="hui-btn hui-btn-secondary text-sm">← Prev</button>
                    <button type="button" onClick={() => router.push("/company-dashboard")} className="hui-btn hui-btn-secondary text-sm">Today</button>
                    <button type="button" onClick={() => router.push('/company-dashboard?month=' + shiftMonth(month, 1))} className="hui-btn hui-btn-secondary text-sm">Next →</button>
                </div>
            </div>
            <UnscheduledTray
                estimating={data.pipeline.estimating}
                projects={data.pipeline.waitingToStart}
                canEdit={data.canEdit}
                pendingProjectIds={effectivePendingProjectIds}
                onMoveProject={scheduleUnscheduledProject}
            />
            {(projectRefreshCount > 0 || awaitingTaskRefreshIds.size > 0) && (
                <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900" role="status">
                    <span>Refreshing saved {pendingRefreshKinds.join(" and ")} schedule changes...</span>
                    <button type="button" className="font-semibold underline" onClick={() => router.refresh()}>Retry now</button>
                </div>
            )}
            <span ref={projectKeyboardSentinelRef} tabIndex={-1} className="sr-only" aria-live="polite" data-project-keyboard-sentinel="true">
                {projectKeyboardEdit ? `Moving project to ${projectKeyboardEdit.targetStart}. Use arrow keys, Enter to save, or Escape to cancel.` : ""}
            </span>
            <span ref={taskKeyboardSentinelRef} tabIndex={-1} className="sr-only" aria-live="polite" data-task-keyboard-sentinel="true">
                {taskKeyboardEdit ? `Keyboard editing ${taskKeyboardEdit.mode}` : ""}
            </span>
            {boardView === "month" ? (
                <MonthBarsView
                    data={boardData}
                    showIncome={showIncome}
                    showProjectedCo={showProjectedCo}
                    showExpenses={showExpenses}
                    showHours={showHours}
                    pendingProjectIds={effectivePendingProjectIds}
                    pendingTaskIds={effectivePendingTaskIds}
                    activeTaskKeyboardEdit={taskKeyboardEdit}
                    onTrayProjectDrop={scheduleUnscheduledProject}
                    activeProjectKeyboardId={projectKeyboardEdit?.projectId ?? null}
                    onProjectPointerEditStart={handleProjectPointerEditStart}
                    onProjectKeyboardStart={handleProjectKeyboardStart}
                    onProjectKeyboardAdjust={handleProjectKeyboardAdjust}
                    onProjectKeyboardCommit={handleProjectKeyboardCommit}
                    onProjectKeyboardCancel={handleProjectKeyboardCancel}
                    onProjectMoveCommit={handleProjectMoveCommit}
                    onTaskPointerEditStart={handleTaskPointerEditStart}
                    onTaskKeyboardStart={handleTaskKeyboardStart}
                    onTaskKeyboardAdjust={handleTaskKeyboardAdjust}
                    onTaskKeyboardCommit={handleTaskKeyboardCommit}
                    onTaskKeyboardCancel={handleTaskKeyboardCancel}
                    onTaskDatesCommit={handleTaskDatesCommit}
                    onTaskMoveBy={handleTaskMoveBy}
                />
            ) : (
                <TimelineView
                    data={boardData}
                    showIncome={showIncome}
                    showProjectedCo={showProjectedCo}
                    showExpenses={showExpenses}
                    showHours={showHours}
                    pendingProjectIds={effectivePendingProjectIds}
                    pendingTaskIds={effectivePendingTaskIds}
                    activeTaskKeyboardEdit={taskKeyboardEdit}
                    onTrayProjectDrop={scheduleUnscheduledProject}
                    activeProjectKeyboardId={projectKeyboardEdit?.projectId ?? null}
                    onProjectPointerEditStart={handleProjectPointerEditStart}
                    onProjectKeyboardStart={handleProjectKeyboardStart}
                    onProjectKeyboardAdjust={handleProjectKeyboardAdjust}
                    onProjectKeyboardCommit={handleProjectKeyboardCommit}
                    onProjectKeyboardCancel={handleProjectKeyboardCancel}
                    onProjectMoveCommit={handleProjectMoveCommit}
                    onTaskPointerEditStart={handleTaskPointerEditStart}
                    onTaskKeyboardStart={handleTaskKeyboardStart}
                    onTaskKeyboardAdjust={handleTaskKeyboardAdjust}
                    onTaskKeyboardCommit={handleTaskKeyboardCommit}
                    onTaskKeyboardCancel={handleTaskKeyboardCancel}
                    onTaskDatesCommit={handleTaskDatesCommit}
                    onTaskMoveBy={handleTaskMoveBy}
                />
            )}
            <ShiftConfirmDialog
                intent={confirmIntent}
                isPending={Boolean(confirmIntent && isProjectPending(confirmIntent.project.id))}
                onChoice={handleMoveChoice}
                onCancel={cancelConfirmedMove}
            />
        </div>
    );
}
