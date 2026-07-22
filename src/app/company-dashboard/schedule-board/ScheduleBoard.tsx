"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveCompanyScheduleTaskDatesAction, shiftNotStartedTasksAction, updateProjectStartDateAction } from "@/lib/actions";
import type { CompanyDashboardData, DashboardProjectRow, DashboardTaskRow, OverlayIncomeItem } from "@/lib/schedule-core";
import { addDays, formatDate, getDaysBetween, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { MonthBarsView } from "./MonthBarsView";
import { TimelineView } from "./TimelineView";
import { ShiftConfirmDialog, type ProjectMoveChoice } from "./ShiftConfirmDialog";
import { UnscheduledTray } from "./UnscheduledTray";
import {
    createProjectDropIntent,
    getEffectiveProjectRange,
    getNewlyPendingProjectIds,
    getTimelineAutoscrollStep,
    getTimelinePointerDelta,
    previewProjectMove,
    previewProjectIncomeOverlays,
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

// Draft-mode: a drafted project-start move accumulated locally until Save.
interface ProjectDraftMove {
    originalStart: string;
    targetStart: string;
    deltaDays: number;
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
    // Drafts accumulate here — the SAME map drives the live visual preview AND
    // the pending-to-save payload; nothing writes to the server until Save.
    const [taskDateOverrides, setTaskDateOverrides] = useState<Record<string, TaskDateOverride>>({});
    const [projectDrafts, setProjectDrafts] = useState<Record<string, ProjectDraftMove>>({});
    const [isSaving, setIsSaving] = useState(false);
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
    const previousExternallyPendingProjectIdsRef = useRef<ReadonlySet<string>>(new Set(externallyPendingProjectIds));
    const [confirmIntent, setConfirmIntent] = useState<ProjectDropIntent | null>(null);
    // Bridges the ShiftConfirmDialog (shown at SAVE time, one project at a
    // time) back into the sequential save loop below.
    const confirmResolverRef = useRef<((choice: ProjectMoveChoice | "cancel") => void) | null>(null);
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
    // A saved-but-not-yet-refreshed task keeps its override (pinned to the
    // persisted dates) purely for rendering/reconciliation — it is NOT an
    // unsaved draft and must not count toward or re-enter a Save.
    const draftTaskIds = useMemo(
        () => new Set(Object.keys(taskDateOverrides).filter(taskId => !awaitingTaskRefreshIds.has(taskId))),
        [taskDateOverrides, awaitingTaskRefreshIds],
    );
    const draftProjectIds = useMemo(() => new Set(Object.keys(projectDrafts)), [projectDrafts]);
    const draftCount = draftTaskIds.size + draftProjectIds.size;

    // Locking during draft mode: a drafted item stays fully interactive.
    // Only an in-flight Save (global — the whole board pauses while
    // committing) or an externally-locked project (the legacy StartDateRow
    // mutating that same project directly) ever blocks an edit.
    const isProjectLocked = useCallback((projectId: string) => (
        isSaving || isProjectExternallyPending(projectId)
    ), [isSaving, isProjectExternallyPending]);
    const isTaskLocked = useCallback((taskId: string) => {
        if (isSaving) return true;
        const projectId = canonicalTaskProjectById.get(taskId);
        return Boolean(projectId && isProjectExternallyPending(projectId));
    }, [isSaving, isProjectExternallyPending, canonicalTaskProjectById]);

    useEffect(() => () => onEffectivePendingProjectIdsChange(EMPTY_PROJECT_IDS), [onEffectivePendingProjectIdsChange]);

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
        }
        const keyboardEdit = taskKeyboardEditRef.current;
        if (keyboardEdit && projectIds.has(keyboardEdit.projectId)) {
            taskKeyboardCleanupRef.current?.();
            setTaskKeyboardState(null);
        }
    }

    function cancelActiveTaskEdit() {
        activeTaskPointerRef.current?.cleanup();
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
        // Until refreshed canonical rows match, saved overrides stay rendered.
        const timeoutId = window.setTimeout(() => {
            const reconciled = new Set(reconciledTaskIds);
            setTaskDateOverrides(current => Object.fromEntries(
                Object.entries(current).filter(([taskId]) => !reconciled.has(taskId)),
            ));
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

    function clearProjectDraft(projectId: string) {
        setProjectDrafts(current => {
            if (!(projectId in current)) return current;
            const next = { ...current };
            delete next[projectId];
            return next;
        });
    }

    // ── Draft-mode writers: accumulate locally, never touch the server. ──

    function draftTaskChange(taskId: string, dates: TaskDateOverride) {
        const canonicalTask = canonicalTaskById.get(taskId);
        if (!data.canEdit || isTaskLocked(taskId) || !canonicalTask) {
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
        // Re-editing a saved-awaiting task turns it back into a live draft.
        setAwaitingTaskRefreshIds(current => {
            if (!current.has(taskId)) return current;
            return new Set([...current].filter(id => id !== taskId));
        });
        setTaskPreview(taskId, normalizedDates);
    }

    function draftProjectMove(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) {
            clearProjectPreview(project.id);
            return;
        }
        const intent = createProjectDropIntent(canonicalProject, targetStart);
        if (!intent || intent.deltaDays === 0) {
            clearProjectPreview(project.id);
            clearProjectDraft(project.id);
            return;
        }
        setProjectPreview(canonicalProject, intent.targetStart);
        // Rebase this project's existing task drafts by the CHANGE in project
        // delta (full-shift projects only — the preview shifts their tasks, so
        // a task drafted at X before a +D project drag must follow to X+D or
        // Save would write the stale pre-shift date over the shifted schedule).
        // In Progress previews never move tasks, so their drafts stay absolute.
        if (canonicalProject.status !== "In Progress") {
            const previousDelta = projectDrafts[project.id]?.deltaDays ?? 0;
            const deltaChange = intent.deltaDays - previousDelta;
            if (deltaChange !== 0) {
                const projectTaskIds = new Set(canonicalProject.tasks.map(task => task.id));
                setTaskDateOverrides(current => Object.fromEntries(Object.entries(current).map(([taskId, dates]) => {
                    if (!projectTaskIds.has(taskId)) return [taskId, dates];
                    return [taskId, {
                        startDate: formatDate(addDays(parseUTCDate(dates.startDate), deltaChange)),
                        endDate: formatDate(addDays(parseUTCDate(dates.endDate), deltaChange)),
                    }];
                })));
            }
        }
        setProjectDrafts(current => ({
            ...current,
            [project.id]: { originalStart: intent.originalStart, targetStart: intent.targetStart, deltaDays: intent.deltaDays },
        }));
    }

    function discardAllDrafts() {
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        for (const projectId of Object.keys(projectDrafts)) clearProjectPreview(projectId);
        setProjectDrafts({});
        setTaskDateOverrides({});
    }

    function waitForConfirmChoice(): Promise<ProjectMoveChoice | "cancel"> {
        return new Promise(resolve => {
            confirmResolverRef.current = resolve;
        });
    }

    function handleMoveChoice(choice: ProjectMoveChoice) {
        confirmResolverRef.current?.(choice);
        confirmResolverRef.current = null;
    }

    function cancelConfirmedMove() {
        confirmResolverRef.current?.("cancel");
        confirmResolverRef.current = null;
    }

    // Commits every drafted change in one Save gesture: project-start moves
    // via the existing single-project actions (In Progress projects get their
    // marker-only vs shift-Not-Started-tasks confirmation HERE, one project at
    // a time — deferred from drag time), then every drafted task-date change
    // in ONE batch call. Failures are isolated per item; only one
    // router.refresh() fires, after everything settles.
    async function saveAllDrafts() {
        if (isSaving) return;
        // Drafts on a project the legacy StartDateRow is mutating RIGHT NOW are
        // retained (not sent) — the board must never serialize over a sibling
        // writer's in-flight result. They save on the next click.
        const retainedForExternalLock: string[] = [];
        const projectEntries = Object.entries(projectDrafts).filter(([projectId]) => {
            if (!isProjectExternallyPending(projectId)) return true;
            retainedForExternalLock.push(canonicalProjectById.get(projectId)?.name ?? projectId);
            return false;
        });
        const taskEntries = Object.entries(taskDateOverrides).filter(([taskId]) => {
            if (awaitingTaskRefreshIds.has(taskId)) return false; // already saved, awaiting refresh
            const projectId = canonicalTaskProjectById.get(taskId);
            if (!projectId || !isProjectExternallyPending(projectId)) return true;
            retainedForExternalLock.push(canonicalTaskById.get(taskId)?.name ?? taskId);
            return false;
        });
        if (retainedForExternalLock.length > 0) {
            toast.info(`${retainedForExternalLock.length} draft${retainedForExternalLock.length === 1 ? "" : "s"} kept unsaved while another edit finishes: ${retainedForExternalLock.join(", ")}`);
        }
        if (projectEntries.length === 0 && taskEntries.length === 0) return;
        // The batch below reconciles these tasks itself (override + awaiting
        // id); project-shift expectations must not also claim them or the two
        // mechanisms deadlock the refresh poll on conflicting dates.
        const batchedTaskIds = new Set(taskEntries.map(([taskId]) => taskId));

        setIsSaving(true);
        const lockedProjectIds = new Set<string>([
            ...projectEntries.map(([projectId]) => projectId),
            ...taskEntries
                .map(([taskId]) => canonicalTaskProjectById.get(taskId))
                .filter((id): id is string => Boolean(id)),
        ]);
        onEffectivePendingProjectIdsChange(lockedProjectIds);

        const failedProjectNames: string[] = [];
        const succeededProjectIds: string[] = [];
        const projectExpectations: Record<string, ProjectRefreshExpectation> = {};

        for (const [projectId, draft] of projectEntries) {
            const canonicalProject = canonicalProjectById.get(projectId);
            if (!canonicalProject) {
                failedProjectNames.push(projectId);
                continue;
            }
            let choice: ProjectMoveChoice = "not-started-tasks";
            if (canonicalProject.status === "In Progress") {
                setConfirmIntent({ project: canonicalProject, originalStart: draft.originalStart, targetStart: draft.targetStart, deltaDays: draft.deltaDays });
                const resolved = await waitForConfirmChoice();
                setConfirmIntent(null);
                if (resolved === "cancel") continue; // leave this draft in place for later
                choice = resolved;
            }
            try {
                if (canonicalProject.status === "In Progress") {
                    if (choice === "marker-only") {
                        const result = await updateProjectStartDateAction(projectId, draft.targetStart, false);
                        projectExpectations[projectId] = { projectStartDate: result.startDate, taskDates: [] };
                    } else {
                        const result = await shiftNotStartedTasksAction(projectId, draft.deltaDays);
                        projectExpectations[projectId] = { taskDates: result.shiftedTaskDates.filter(row => !batchedTaskIds.has(row.id)) };
                    }
                } else {
                    const result = await updateProjectStartDateAction(projectId, draft.targetStart, true);
                    projectExpectations[projectId] = { projectStartDate: result.startDate, taskDates: result.shiftedTaskDates.filter(row => !batchedTaskIds.has(row.id)) };
                }
                succeededProjectIds.push(projectId);
            } catch (error) {
                failedProjectNames.push(canonicalProject.name);
            }
        }

        if (succeededProjectIds.length > 0) {
            const succeeded = new Set(succeededProjectIds);
            setProjectDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !succeeded.has(id))));
            setProjectRefreshExpectations(current => ({ ...current, ...projectExpectations }));
        }

        let failedTaskNames: string[] = [];
        let succeededTaskCount = 0;
        if (taskEntries.length > 0) {
            const changes = taskEntries.map(([taskId, dates]) => ({ taskId, startDate: dates.startDate, endDate: dates.endDate }));
            try {
                const batchResult = await saveCompanyScheduleTaskDatesAction(changes);
                const succeededRows = batchResult.results.filter(row => row.ok);
                failedTaskNames = batchResult.results
                    .filter(row => !row.ok)
                    .map(row => canonicalTaskById.get(row.taskId)?.name ?? row.taskId);
                succeededTaskCount = succeededRows.length;
                if (succeededRows.length > 0) {
                    // Keep the override (pinned to the PERSISTED dates) until the
                    // refresh poll sees matching canonical rows — reconciliation
                    // requires the override to exist; deleting it here would
                    // leave awaiting ids stranded and the poll running forever.
                    const savedById = new Map(succeededRows.map(row => [row.taskId, {
                        startDate: row.startDate!.slice(0, 10),
                        endDate: row.endDate!.slice(0, 10),
                    }]));
                    setTaskDateOverrides(current => {
                        const next = { ...current };
                        for (const [taskId, dates] of savedById) next[taskId] = dates;
                        return next;
                    });
                    setAwaitingTaskRefreshIds(current => new Set([...current, ...savedById.keys()]));
                }
            } catch (error) {
                failedTaskNames = taskEntries.map(([taskId]) => canonicalTaskById.get(taskId)?.name ?? taskId);
            }
        }

        setIsSaving(false);
        onEffectivePendingProjectIdsChange(EMPTY_PROJECT_IDS);
        router.refresh();

        const totalSucceeded = succeededProjectIds.length + succeededTaskCount;
        const totalFailed = failedProjectNames.length + failedTaskNames.length;
        if (totalFailed === 0 && totalSucceeded > 0) {
            toast.success(`Saved ${totalSucceeded} change${totalSucceeded === 1 ? "" : "s"}`);
        } else if (totalFailed > 0) {
            const failedNames = [...failedProjectNames, ...failedTaskNames];
            toast.error(
                `${totalFailed} change${totalFailed === 1 ? "" : "s"} failed to save: ${failedNames.join(", ")}`,
                totalSucceeded > 0 ? { description: `${totalSucceeded} other change${totalSucceeded === 1 ? "" : "s"} saved.` } : undefined,
            );
        }
    }

    function cancelProjectEditsForProjects(projectIds: ReadonlySet<string>) {
        const pointerEdit = activeProjectPointerRef.current;
        if (pointerEdit && projectIds.has(pointerEdit.projectId)) {
            pointerEdit.cleanup();
        }
        const keyboardEdit = projectKeyboardEditRef.current;
        if (keyboardEdit && projectIds.has(keyboardEdit.projectId)) {
            projectKeyboardCleanupRef.current?.();
            setProjectKeyboardState(null);
        }
    }

    function cancelActiveProjectEdit() {
        activeProjectPointerRef.current?.cleanup();
        projectKeyboardCleanupRef.current?.();
        setProjectKeyboardState(null);
    }

    function setProjectKeyboardState(next: ProjectKeyboardEditState | null) {
        projectKeyboardEditRef.current = next;
        setProjectKeyboardEdit(next);
    }

    const cancelExternallyLockedProjectEdits = useEffectEvent((newlyPendingProjectIds: ReadonlySet<string>) => {
        cancelProjectEditsForProjects(newlyPendingProjectIds);
        cancelTaskEditsForProjects(newlyPendingProjectIds);
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
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) return;
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
            if (candidate) setProjectPreview(drag.project, candidate);
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
            if (!drag.active) return;
            if (cancelled || !candidate) {
                clearProjectPreview(drag.projectId);
                return;
            }
            draftProjectMove(drag.project, candidate);
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
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) return;
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
        if (!current || current.projectId !== project.id || isProjectLocked(project.id)) return;
        const targetStart = formatDate(addDays(parseUTCDate(current.targetStart), deltaDays));
        setProjectKeyboardState({ ...current, targetStart });
        const canonicalProject = canonicalProjectById.get(project.id);
        if (canonicalProject) setProjectPreview(canonicalProject, targetStart);
    }

    function handleProjectKeyboardCommit(project: DashboardProjectRow) {
        const current = projectKeyboardEditRef.current;
        if (!current || current.projectId !== project.id) return;
        if (isProjectLocked(project.id)) {
            handleProjectKeyboardCancel(project);
            return;
        }
        projectKeyboardCleanupRef.current?.();
        setProjectKeyboardState(null);
        draftProjectMove(project, current.targetStart);
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
        if (!data.canEdit || isTaskLocked(task.id) || !canonicalTask || !projectId) return;
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
            draftTaskChange(task.id, candidate);
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
        if (!data.canEdit || isTaskLocked(task.id) || !canonicalTask || !projectId) return;
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
        if (!data.canEdit || isTaskLocked(task.id) || !canonicalTask || current?.taskId !== task.id || current.mode !== mode) return;
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
        if (!data.canEdit || isTaskLocked(task.id) || !canonicalTask || current?.taskId !== task.id || current.mode !== mode) return;
        const dates = previewTaskDates(canonicalTask, mode, current.deltaDays);
        taskKeyboardCleanupRef.current?.();
        setTaskKeyboardState(null);
        if (dates) draftTaskChange(task.id, dates);
    }

    function handleTaskKeyboardCancel(task: DashboardTaskRow) {
        if (!data.canEdit || taskKeyboardEditRef.current?.taskId !== task.id) return;
        clearTaskPreview(task.id);
        taskKeyboardCleanupRef.current?.();
        setTaskKeyboardState(null);
    }

    function handleTaskDatesCommit(task: DashboardTaskRow, dates: TaskDateOverride) {
        if (!data.canEdit || isTaskLocked(task.id) || !canonicalTaskById.has(task.id)) return;
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        draftTaskChange(task.id, dates);
    }

    function handleTaskMoveBy(task: DashboardTaskRow, deltaDays: number) {
        const canonicalTask = canonicalTaskById.get(task.id);
        if (!data.canEdit || isTaskLocked(task.id) || !canonicalTask) return;
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        const dates = previewTaskDates(canonicalTask, "move", deltaDays);
        if (dates) draftTaskChange(task.id, dates);
    }

    // Tray drop for an unscheduled (Waiting-to-Start, no startDate yet)
    // project — drafts the move the same as any other project drag.
    function scheduleUnscheduledProject(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) return;
        cancelActiveTaskEdit();
        const normalizedTarget = formatDate(parseUTCDate(targetStart));
        if (!canonicalProject.startDate) {
            // No prior date to diff against — preview + draft directly from the
            // unscheduled state (createProjectDropIntent needs an existing
            // range, which an unscheduled project's task-only range still
            // provides when tasks exist; otherwise seed a bare marker draft).
            const preview = { ...canonicalProject, startDate: normalizedTarget };
            setProjectPreviewOverrides(current => ({ ...current, [project.id]: preview }));
            setProjectDrafts(current => ({
                ...current,
                [project.id]: { originalStart: normalizedTarget, targetStart: normalizedTarget, deltaDays: 0 },
            }));
            return;
        }
        draftProjectMove(canonicalProject, normalizedTarget);
    }

    function handleProjectMovePreview(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) {
            clearProjectPreview(project.id);
            return;
        }
        const intent = createProjectDropIntent(canonicalProject, targetStart);
        if (!intent || intent.deltaDays === 0) clearProjectPreview(project.id);
        else setProjectPreview(canonicalProject, intent.targetStart);
    }

    function handleProjectMoveCommit(project: DashboardProjectRow, targetStart: string) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) {
            clearProjectPreview(project.id);
            return;
        }
        cancelActiveTaskEdit();
        draftProjectMove(canonicalProject, targetStart);
    }

    const pendingRefreshKinds = [
        Object.keys(projectRefreshExpectations).length > 0 ? "project" : null,
        awaitingTaskRefreshIds.size > 0 ? "task" : null,
    ].filter((kind): kind is string => Boolean(kind));

    return (
        <div className="hui-card mb-6 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-hui-border">
                <div className="flex items-baseline gap-3">
                    <h2 className="text-base font-semibold text-hui-textMain">Project Schedule — {monthLabel}</h2>
                    <Link href="/company-dashboard/guide" className="text-xs text-hui-textMuted hover:text-hui-primary underline underline-offset-2 whitespace-nowrap">
                        How to use
                    </Link>
                </div>
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
            {draftCount > 0 && (
                <div role="status" className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900">
                    <span>{draftCount} unsaved change{draftCount === 1 ? "" : "s"}</span>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={discardAllDrafts} disabled={isSaving} className="hui-btn hui-btn-secondary text-xs disabled:cursor-wait disabled:opacity-60">
                            Discard
                        </button>
                        <button type="button" onClick={() => void saveAllDrafts()} disabled={isSaving} className="hui-btn hui-btn-green text-xs disabled:cursor-wait disabled:opacity-60">
                            {isSaving ? "Saving..." : "Save"}
                        </button>
                    </div>
                </div>
            )}
            <UnscheduledTray
                projects={data.pipeline.waitingToStart}
                canEdit={data.canEdit}
                pendingProjectIds={externallyPendingProjectIds}
                onMoveProject={scheduleUnscheduledProject}
            />
            {(Object.keys(projectRefreshExpectations).length > 0 || awaitingTaskRefreshIds.size > 0) && (
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
                    pendingProjectIds={externallyPendingProjectIds}
                    pendingTaskIds={EMPTY_PROJECT_IDS}
                    draftProjectIds={draftProjectIds}
                    draftTaskIds={draftTaskIds}
                    isSaving={isSaving}
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
                    pendingProjectIds={externallyPendingProjectIds}
                    pendingTaskIds={EMPTY_PROJECT_IDS}
                    draftProjectIds={draftProjectIds}
                    draftTaskIds={draftTaskIds}
                    isSaving={isSaving}
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
                isPending={false}
                onChoice={handleMoveChoice}
                onCancel={cancelConfirmedMove}
            />
        </div>
    );
}
