"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { BookOpen, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { publishDispatchAction } from "@/lib/actions";
import { saveCompanyScheduleTaskDatesAction, shiftNotStartedTasksAction, updateProjectEndDateAction, updateProjectStartDateAction } from "@/lib/actions";
import type { CompanyDashboardData, DashboardProjectRow, DashboardTaskRow, OverlayIncomeItem } from "@/lib/schedule-core";
import type { PublishDispatchSuccess } from "@/lib/dispatch-publication";
import type {
    DispatchAssignment,
    DispatchIntent,
    PersistedDispatchProjectState,
    PersistedDispatchTaskState,
} from "@/lib/dispatch-intent";
import type { VancouverForecastDay } from "@/lib/weather";
import { addDays, formatDate, getDaysBetween, getMonday, parseUTCDate, todayUTC } from "@/app/projects/[id]/schedule/schedule-utils";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MonthBarsView } from "./MonthBarsView";
import { TimelineView, CREW_MODE_STORAGE_KEY } from "./TimelineView";
import { DispatchView, DISPATCH_MODE_STORAGE_KEY } from "./DispatchView";
import type { DispatchMode, DispatchTaskCreationDefaults } from "./DispatchView";
import { shiftDayKey, formatDayLabel, isTodayKey } from "./dispatch-day";
import { assertDispatchableTarget, finalTaskUserIds, type DispatchReviewTaskInput } from "./dispatch-day-rows";
import { DispatchReviewDialog } from "./DispatchReviewDialog";
import { AvailabilityPanel } from "./AvailabilityPanel";
import { ShiftConfirmDialog, type ProjectMoveChoice } from "./ShiftConfirmDialog";
import { UnscheduledTray } from "./UnscheduledTray";
import { BoardTaskDrawer } from "./BoardTaskDrawer";
import { BoardProjectDrawer } from "./BoardProjectDrawer";
import TaskCreationDialog from "@/components/TaskCreationDialog";
import {
    computeProjectEndResizeCandidate,
    createProjectDropIntent,
    getEffectiveProjectRange,
    getNewlyPendingProjectIds,
    getTimelineAutoscrollStep,
    getTimelinePointerDelta,
    mergeProjectPendingIds,
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
import type { ProjectEndResizePointerStart, ProjectPointerEditStart } from "./ProjectBar";
import {
    createDragVisualLayer,
    projectDragSourceSelector,
    projectMarkerDragSourceSelector,
    taskDragSourceSelector,
    type DragVisualLayer,
} from "./dragVisualLayer";

export type { ProjectMoveChoice } from "./ShiftConfirmDialog";
export type { ProjectDropIntent } from "./useBarLayout";
export type BoardView = "month" | "timeline" | "dispatch";

const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BOARD_VIEW_STORAGE_KEY = "gtr-company-schedule-board-view";
const TASK_MOUSE_DRAG_THRESHOLD_PX = 5;
const TASK_TOUCH_DRAG_THRESHOLD_PX = 8;
const PROJECT_MOUSE_DRAG_THRESHOLD_PX = 5;
const PROJECT_TOUCH_DRAG_THRESHOLD_PX = 8;
const EDGE_AUTOSCROLL_THRESHOLD_PX = 48;
const MAX_AUTOSCROLL_PX_PER_FRAME = 16;
const EMPTY_PROJECT_IDS: ReadonlySet<string> = new Set();

let scheduleBoardRenderCount = 0;

declare global {
    interface Window {
        __boardRenderCount?: number;
    }
}

interface ScheduleBoardProps {
    data: CompanyDashboardData;
    weather: VancouverForecastDay[];
    externallyPendingProjectIds: ReadonlySet<string>;
    isProjectExternallyPending: (projectId: string) => boolean;
    onEffectivePendingProjectIdsChange: (projectIds: ReadonlySet<string>) => void;
    // Persisted task shifts from sibling writers (legacy StartDateRow) so the
    // board can rewrite saved-awaiting overrides caught in an external shift.
    // An append-only event queue: concurrent legacy shifts resolving in one
    // React batch each keep their event (a single latest-payload slot would
    // drop all but the last).
    externalShiftEvents: { nonce: number; taskDates: { id: string; startDate: string; endDate: string }[] }[];
    // Full-screen dispatch focus mode (see /company-dashboard/dispatch):
    // forces the Dispatch view, strips the surrounding chrome (view toggle,
    // money toggles, month nav, unscheduled tray, availability panel), and
    // fills the viewport.
    focus?: "dispatch";
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
    monthDayWidth: number | null;
    mode: TaskEditMode;
    active: boolean;
    currentCandidate: TaskDateOverride | null;
    visualLayer: DragVisualLayer | null;
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
    visualLayer: DragVisualLayer | null;
    animationFrameId: number | null;
    sourceElement: HTMLElement;
    previousTouchAction: string;
    start: ProjectPointerEditStart;
    cleanup: () => void;
}

// Right-edge resize drag (item 2) — a SEPARATE pointer-drag from
// ActiveProjectPointerEdit above. Its active preview lives in the detached
// visual layer, but its final valid candidate still commits immediately through
// updateProjectEndDateAction and never joins the draft/Save system.
interface ActiveProjectEndResizeEdit {
    projectId: string;
    project: DashboardProjectRow;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    originX: number;
    latestClientX: number;
    latestClientY: number;
    originalStart: string;
    originalEnd: string;
    // Month has no fixed per-day pixel width (Timeline's zoom-driven
    // timelineDayWidth) — measured once at drag start from the underlying
    // week-grid day cell (see measureMonthDayWidth).
    monthDayWidth: number | null;
    active: boolean;
    currentCandidate: string | null;
    visualLayer: DragVisualLayer | null;
    animationFrameId: number | null;
    sourceElement: HTMLElement;
    previousTouchAction: string;
    start: ProjectEndResizePointerStart;
    cleanup: () => void;
}

// Draft-mode: a drafted project-start move accumulated locally until Save.
interface ProjectDraftMove {
    originalStart: string;
    targetStart: string;
    deltaDays: number;
}

interface CrewDraft {
    addUserIds: string[];
    removeUserIds: string[];
    expectedAssignments: DispatchAssignment[];
}

interface DispatchReconciliationExpectation {
    publicationId: string;
    projects: Record<string, PersistedDispatchProjectState>;
    tasks: Record<string, PersistedDispatchTaskState>;
    assignments: Record<string, DispatchAssignment[]>;
}

interface DispatchReviewState {
    clientRequestId: string;
    intents: DispatchIntent[];
    preview: PublishDispatchSuccess;
    published: boolean;
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

// Project-bar right-edge resize (item 2), Month view only: there is no fixed
// per-day pixel width the way Timeline has (its zoom-driven timelineDayWidth)
// — the week grid's day-cell width is measured directly from whichever
// [data-schedule-date] cell sits under the pointer at drag start (every cell
// in a week row is exactly one day wide by construction).
function measureMonthDayWidth(clientX: number, clientY: number): number | null {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
        const cell = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-schedule-date]") : null;
        if (cell) return cell.getBoundingClientRect().width;
    }
    return null;
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

function dashboardTaskAssignments(task: DashboardTaskRow): DispatchAssignment[] {
    return task.assignments
        .map(assignment => ({
            userId: assignment.userId,
            role: assignment.assignmentRole === "lead" ? "lead" as const : "assigned" as const,
        }))
        .sort((left, right) => left.userId.localeCompare(right.userId) || left.role.localeCompare(right.role));
}

function dashboardAssignmentsMatch(
    task: DashboardTaskRow,
    expected: DispatchAssignment[],
): boolean {
    const actual = dashboardTaskAssignments(task);
    return actual.length === expected.length
        && actual.every((assignment, index) =>
            assignment.userId === expected[index]?.userId
            && assignment.role === expected[index]?.role,
        );
}

export function ScheduleBoard({
    data,
    weather,
    externallyPendingProjectIds,
    isProjectExternallyPending,
    onEffectivePendingProjectIdsChange,
    externalShiftEvents,
    focus,
}: ScheduleBoardProps) {
    if (process.env.NODE_ENV !== "production") {
        scheduleBoardRenderCount += 1;
        if (typeof window !== "undefined") window.__boardRenderCount = scheduleBoardRenderCount;
    }
    const router = useRouter();
    const { month, isAdmin, overlays } = data;
    const [showIncome, setShowIncome] = useState(true);
    const [showProjectedCo, setShowProjectedCo] = useState(true);
    const [showExpenses, setShowExpenses] = useState(false);
    const [showHours, setShowHours] = useState(false);
    const [boardView, setBoardView] = useState<BoardView>(focus === "dispatch" ? "dispatch" : "month");
    // Dispatch's Today|Week range — owned here (not inside DispatchView) so the
    // board header can show the range's own nav controls in the same slot as
    // Prev/Today/Next, and its date label in the title.
    const [dispatchMode, setDispatchMode] = useState<DispatchMode>("today");
    const [dispatchWeekStart, setDispatchWeekStart] = useState(() => getMonday(todayUTC()));
    // Dispatch's Day lens selected date — defaults to today, paged with the
    // header's ←/Today/→ nav (never persisted; every fresh visit starts on
    // today, mirroring dispatchWeekStart's reset-on-enter behavior below).
    const [dispatchDayKey, setDispatchDayKey] = useState(() => formatDate(todayUTC()));
    // Same day key DispatchView derives (formatDate(todayUTC())), kept as state
    // (not a plain const) and refreshed on mount/visibility/focus so a tab left
    // open across midnight still shows the right day — a bare call inside a
    // memo with no day dependency would never recompute.
    const [todayKey, setTodayKey] = useState(() => formatDate(todayUTC()));
    useEffect(() => {
        const refreshTodayKey = () => setTodayKey(formatDate(todayUTC()));
        refreshTodayKey();
        document.addEventListener("visibilitychange", refreshTodayKey);
        window.addEventListener("focus", refreshTodayKey);
        return () => {
            document.removeEventListener("visibilitychange", refreshTodayKey);
            window.removeEventListener("focus", refreshTodayKey);
        };
    }, []);
    const [openTaskId, setOpenTaskId] = useState<string | null>(null);
    const [openProjectId, setOpenProjectId] = useState<string | null>(null);
    const [taskCreationOpen, setTaskCreationOpen] = useState(false);
    const [taskCreationDefaults, setTaskCreationDefaults] = useState<Partial<DispatchTaskCreationDefaults>>({});
    // Lifted from TimelineView (see CREW_MODE_STORAGE_KEY) so the
    // availability panel's drill-down can force crew mode on even when
    // Timeline is already mounted — writing localStorage alone wouldn't
    // reach an already-mounted view's own state.
    const [groupByCrew, setGroupByCrew] = useState(false);
    const boardContainerRef = useRef<HTMLDivElement>(null);
    const [projectPreviewOverrides, setProjectPreviewOverrides] = useState<Record<string, DashboardProjectRow>>({});
    const [projectIncomeOverrides, setProjectIncomeOverrides] = useState<Record<string, OverlayIncomeItem[]>>({});
    const [projectRefreshExpectations, setProjectRefreshExpectations] = useState<Record<string, ProjectRefreshExpectation>>({});
    const [dispatchReconciliationExpectation, setDispatchReconciliationExpectation] = useState<DispatchReconciliationExpectation | null>(null);
    // Day list's inline note editor (DispatchDayView) writes doneWhen straight
    // to the DB, which bumps the task's updatedAt/revision outside of drafts
    // entirely. Two things track that so a Review opened right after a note
    // save doesn't compare against a not-yet-refreshed (stale) revision:
    // - pendingNoteSaveTaskIds: a save currently in flight for a task — Review
    //   dispatch is disabled while any are pending, so we never even build
    //   intents from an unsettled revision.
    // - taskRevisionOverrides: the true post-save updatedAt for a task whose
    //   save has settled but whose canonical `data` prop (server-refreshed via
    //   router.refresh() polling) hasn't caught up yet. collectDispatchIntents
    //   reads this instead of the possibly-stale canonicalTaskById value.
    const [pendingNoteSaveTaskIds, setPendingNoteSaveTaskIds] = useState<Set<string>>(new Set());
    const [taskRevisionOverrides, setTaskRevisionOverrides] = useState<Record<string, string>>({});
    const [dispatchReview, setDispatchReview] = useState<DispatchReviewState | null>(null);
    const [dispatchConflictTargetIds, setDispatchConflictTargetIds] = useState<Set<string>>(() => new Set());
    const [isDispatchReviewing, setIsDispatchReviewing] = useState(false);
    const [isDispatchPublishing, setIsDispatchPublishing] = useState(false);
    // Drafts accumulate here — the SAME map drives the live visual preview AND
    // the pending-to-save payload; nothing writes to the server until Save.
    const [taskDateOverrides, setTaskDateOverrides] = useState<Record<string, TaskDateOverride>>({});
    const [projectDrafts, setProjectDrafts] = useState<Record<string, ProjectDraftMove>>({});
    const [crewDrafts, setCrewDrafts] = useState<Record<string, CrewDraft>>({});
    // Read at reconciliation-timeout FIRE time (an effect-render snapshot can
    // miss a just-added draft or resurrect a just-discarded one).
    const projectDraftsRef = useRef(projectDrafts);
    useEffect(() => { projectDraftsRef.current = projectDrafts; }, [projectDrafts]);
    // Batch-save lock set feeding the single derived page-wide publisher.
    const [saveLockedProjectIds, setSaveLockedProjectIds] = useState<ReadonlySet<string>>(EMPTY_PROJECT_IDS);
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
    // Right-edge resize (item 2): a SEPARATE active-drag ref from the
    // whole-bar move above, plus the set of projects with an in-flight
    // updateProjectEndDateAction save (merged into pendingProjectIds below so
    // it participates in the SAME isPending gating as every other lock).
    const activeProjectEndResizeRef = useRef<ActiveProjectEndResizeEdit | null>(null);
    const [endResizeSavingProjectIds, setEndResizeSavingProjectIds] = useState<ReadonlySet<string>>(EMPTY_PROJECT_IDS);
    const previousExternallyPendingProjectIdsRef = useRef<ReadonlySet<string>>(new Set(externallyPendingProjectIds));
    const [confirmIntent, setConfirmIntent] = useState<ProjectDropIntent | null>(null);
    // Bumped on every "Today" click so TimelineView re-scrolls to today even
    // when the anchor month itself doesn't change (item 4) — e.g. the user
    // scrolled elsewhere in the wide canvas and wants back to today.
    const [scrollToTodayNonce, setScrollToTodayNonce] = useState(0);
    // Bridges the ShiftConfirmDialog (shown at SAVE time, one project at a
    // time) back into the sequential save loop below.
    const confirmResolverRef = useRef<((choice: ProjectMoveChoice | "cancel") => void) | null>(null);
    useEffect(() => {
        if (focus === "dispatch") return; // Forced dispatch view — never restore/override from storage.
        try {
            const stored = localStorage.getItem(BOARD_VIEW_STORAGE_KEY);
            if (stored === "month" || stored === "timeline" || stored === "dispatch") setBoardView(stored);
        } catch {
            // Storage can be unavailable in privacy-restricted browser contexts.
        }
    }, [focus]);
    useEffect(() => {
        try {
            const stored = localStorage.getItem(CREW_MODE_STORAGE_KEY);
            if (stored === "true") setGroupByCrew(true);
        } catch {
            // Storage can be unavailable in privacy-restricted browser contexts.
        }
    }, []);
    useEffect(() => {
        let restoreFrame: number | null = null;
        try {
            const stored = localStorage.getItem(DISPATCH_MODE_STORAGE_KEY);
            if (stored === "today" || stored === "week") {
                restoreFrame = window.requestAnimationFrame(() => setDispatchMode(stored));
            }
        } catch {
            // The default Today mode remains usable when storage is unavailable.
        }
        return () => {
            if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
        };
    }, []);
    // Switching INTO Dispatch used to be a remount (key change), which reset
    // the week range for free. It's a persistent view now, so restore that
    // reset explicitly — otherwise a stale dispatchWeekStart from a prior
    // Dispatch visit lingers into the new one.
    useEffect(() => {
        if (boardView === "dispatch") {
            setDispatchWeekStart(getMonday(todayUTC()));
            setDispatchDayKey(formatDate(todayUTC()));
        }
    }, [boardView]);
    function selectDispatchMode(nextMode: DispatchMode) {
        setDispatchMode(nextMode);
        try {
            localStorage.setItem(DISPATCH_MODE_STORAGE_KEY, nextMode);
        } catch {
            // The selected mode still applies for this session.
        }
    }
    function setGroupByCrewMode(next: boolean) {
        setGroupByCrew(next);
        try {
            localStorage.setItem(CREW_MODE_STORAGE_KEY, String(next));
        } catch {
            // The selected mode still applies for this session when persistence fails.
        }
    }
    // Availability panel drill-down: force Timeline + By-crew mode and bring
    // the board into view, regardless of which view/mode was active before.
    function drillDownToCrewTimeline() {
        selectBoardView("timeline");
        setGroupByCrewMode(true);
        boardContainerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const anchor = parseUTCDate(`${month}-01`);
    const monthLabel = `${MONTH_LABELS[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}`;
    // In-page (non-focus) Dispatch title label — "Saturday, Aug 29" in Day
    // mode (the selected dispatchDayKey, not necessarily today), "Week of
    // Mon, Aug 24" in Week mode, so the title always states WHEN.
    const dispatchDateLabel = useMemo(() => {
        if (dispatchMode === "week") {
            return `Week of ${new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(dispatchWeekStart)}`;
        }
        return formatDayLabel(dispatchDayKey);
    }, [dispatchMode, dispatchWeekStart, dispatchDayKey]);
    // Focus-mode header label — mirrors dispatchDateLabel's Today/Week logic
    // (not just today's date) so ← / This week / → have a visible, correct
    // label in focus mode too, the same as the normal in-page header.
    const dispatchHeaderLabel = useMemo(() => `Dispatch — ${dispatchDateLabel}`, [dispatchDateLabel]);
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
    // "Has at least one child" set, scoped per-project like dispatch-day-rows.ts's
    // own private parentIdsOf — feeds assertDispatchableTarget below (a phase
    // parent can never be a crew-draft add target).
    const taskHasChildrenById = useMemo(() => new Set(
        canonicalProjects.flatMap(project => project.tasks.map(task => task.parentId).filter((id): id is string => Boolean(id))),
    ), [canonicalProjects]);
    const dispatchTaskNamesById = useMemo(
        () => new Map(canonicalProjects.flatMap(project => project.tasks.map(task => [task.id, task.name] as const))),
        [canonicalProjects],
    );
    // Day-mode collision warning (DispatchReviewDialog): every canonical
    // task's full window plus its currently-saved dispatchable crew, fed to
    // findReviewCollisions (dispatch-day-rows.ts) with this review's own
    // TASK_CREW changes overlaid — draft-aware, multi-day, not limited to
    // what the server's already-committed crewConflicts can see.
    const dispatchReviewTasks: DispatchReviewTaskInput[] = useMemo(
        () => canonicalProjects.flatMap(project => project.tasks.map(task => ({
            id: task.id,
            projectId: project.id,
            projectName: project.name,
            name: task.name,
            startDate: task.startDate,
            endDate: task.endDate,
            savedUserIds: finalTaskUserIds(task, undefined),
        }))),
        [canonicalProjects],
    );
    const dispatchMemberNamesById = useMemo(() => new Map([
        ...(data.teamMembers ?? []).map(member => [member.id, member.name || member.email] as const),
        ...canonicalProjects.flatMap(project => project.tasks.flatMap(task =>
            task.assignments.map(assignment => [assignment.userId, assignment.name] as const),
        )),
    ]), [canonicalProjects, data.teamMembers]);
    const activeProjectOptions = useMemo(() => canonicalProjects.map(project => ({
        id: project.id,
        name: project.name,
        color: project.color || "#4c9a2a",
    })), [canonicalProjects]);
    const teamMemberById = useMemo(
        () => new Map((data.teamMembers ?? []).map(member => [member.id, member])),
        [data.teamMembers],
    );
    // A saved-but-not-yet-refreshed task keeps its override (pinned to the
    // persisted dates) purely for rendering/reconciliation — it is NOT an
    // unsaved draft and must not count toward or re-enter a Save.
    const dispatchAwaitingTaskIds = useMemo(
        () => new Set(Object.keys(dispatchReconciliationExpectation?.tasks ?? {})),
        [dispatchReconciliationExpectation],
    );
    const draftTaskIds = useMemo(
        () => new Set(Object.keys(taskDateOverrides).filter(taskId =>
            !awaitingTaskRefreshIds.has(taskId) && !dispatchAwaitingTaskIds.has(taskId),
        )),
        [taskDateOverrides, awaitingTaskRefreshIds, dispatchAwaitingTaskIds],
    );
    // A note save's own local revision override must never regress: two
    // overlapping saves on the same task (a second edit started before the
    // first settled) can resolve out of order, and an older response must
    // not clobber a newer one already recorded.
    const handleNoteSaveStart = useCallback((taskId: string) => {
        setPendingNoteSaveTaskIds(current => (current.has(taskId) ? current : new Set(current).add(taskId)));
    }, []);
    const handleNoteSaveSettled = useCallback((taskId: string, result: { updatedAt: string } | null) => {
        setPendingNoteSaveTaskIds(current => {
            if (!current.has(taskId)) return current;
            const next = new Set(current);
            next.delete(taskId);
            return next;
        });
        if (!result) return;
        setTaskRevisionOverrides(current => {
            const existing = current[taskId];
            if (existing && existing >= result.updatedAt) return current;
            return { ...current, [taskId]: result.updatedAt };
        });
    }, []);
    // Drop an override as soon as canonical data (server refresh) has caught
    // up to it or moved past it — including past it via someone ELSE'S edit,
    // which must win over our own stale-by-comparison override so a
    // genuinely concurrent change is never masked.
    useEffect(() => {
        if (Object.keys(taskRevisionOverrides).length === 0) return;
        setTaskRevisionOverrides(current => {
            let changed = false;
            const next = { ...current };
            for (const [taskId, overrideUpdatedAt] of Object.entries(current)) {
                const canonicalUpdatedAt = canonicalTaskById.get(taskId)?.updatedAt;
                if (!canonicalUpdatedAt || canonicalUpdatedAt >= overrideUpdatedAt) {
                    delete next[taskId];
                    changed = true;
                }
            }
            return changed ? next : current;
        });
    }, [canonicalTaskById, taskRevisionOverrides]);
    // What collectDispatchIntents should actually treat as "this task's
    // current revision" — the override when it's ahead of canonical, else
    // canonical itself. Never used to relax the server's own check (still
    // exact-match against the live DB row) — only to feed it the freshest
    // value the client actually knows.
    const taskExpectedUpdatedAt = useCallback(
        (taskId: string, canonicalUpdatedAt: string) => {
            const override = taskRevisionOverrides[taskId];
            return override && override > canonicalUpdatedAt ? override : canonicalUpdatedAt;
        },
        [taskRevisionOverrides],
    );
    const crewDraftTaskIds = useMemo(() => new Set(Object.keys(crewDrafts)), [crewDrafts]);
    const draftProjectIds = useMemo(() => new Set(Object.keys(projectDrafts)), [projectDrafts]);
    const draftCount = draftTaskIds.size + draftProjectIds.size + crewDraftTaskIds.size;
    const openTaskProjectId = openTaskId ? canonicalTaskProjectById.get(openTaskId) : null;
    const openTaskHasDraft = Boolean(openTaskId && (
        draftTaskIds.has(openTaskId)
        || (openTaskProjectId && draftProjectIds.has(openTaskProjectId))
    ));
    const openTaskHasCrewDraft = Boolean(openTaskId && crewDrafts[openTaskId]);

    // Locking during draft mode: a drafted item stays fully interactive.
    // Only an in-flight Save (global — the whole board pauses while
    // committing) or an externally-locked project (the legacy StartDateRow
    // mutating that same project directly) ever blocks an edit.
    const isProjectLocked = useCallback((projectId: string) => (
        (isSaving || isProjectExternallyPending(projectId)) || isDispatchReviewing || isDispatchPublishing
    ), [isDispatchPublishing, isDispatchReviewing, isSaving, isProjectExternallyPending]);
    const isTaskLocked = useCallback((taskId: string) => {
        if (isSaving || isDispatchReviewing || isDispatchPublishing) return true;
        const projectId = canonicalTaskProjectById.get(taskId);
        return Boolean(projectId && isProjectExternallyPending(projectId));
    }, [isDispatchPublishing, isDispatchReviewing, isSaving, isProjectExternallyPending, canonicalTaskProjectById]);

    // End-resize saves are a SECOND source of "externally" pending, alongside
    // the legacy StartDateRow (item 2) — merged so both views' isPending gate
    // (isSaving || pendingProjectIds.has(id)) sees either lock the same way.
    const combinedPendingProjectIds = useMemo(
        () => mergeProjectPendingIds(externallyPendingProjectIds, endResizeSavingProjectIds),
        [externallyPendingProjectIds, endResizeSavingProjectIds],
    );
    // Keyboard edits still gate hover cards through React. Active pointer edits
    // publish below this root from dragVisualLayer, avoiding a board render.
    const isAnyDragActive = projectKeyboardEdit !== null || taskKeyboardEdit !== null;

    useEffect(() => () => onEffectivePendingProjectIdsChange(EMPTY_PROJECT_IDS), [onEffectivePendingProjectIdsChange]);
    // ONE derived publisher for the page-wide lock: the live union of the
    // running batch save's locked projects, every in-flight end-resize
    // save, and — while a dispatch review/publish is in flight — every
    // draft-affected project (the publish transaction will touch exactly
    // those rows; sibling writers like StartDateRow must see them pending).
    // Snapshot-based inline publications left windows where a resize
    // starting mid-batch went unpublished.
    useEffect(() => {
        let pending = mergeProjectPendingIds(saveLockedProjectIds, endResizeSavingProjectIds);
        if (isDispatchReviewing || isDispatchPublishing) {
            const dispatchAffected = new Set(draftProjectIds);
            for (const taskId of [...draftTaskIds, ...crewDraftTaskIds]) {
                const projectId = canonicalTaskProjectById.get(taskId);
                if (projectId) dispatchAffected.add(projectId);
            }
            pending = mergeProjectPendingIds(pending, dispatchAffected);
        }
        onEffectivePendingProjectIdsChange(pending);
    }, [saveLockedProjectIds, endResizeSavingProjectIds, isDispatchReviewing, isDispatchPublishing, draftProjectIds, draftTaskIds, crewDraftTaskIds, canonicalTaskProjectById, onEffectivePendingProjectIdsChange]);

    const applyPreview = (project: DashboardProjectRow) => {
        const projectPreview = projectPreviewOverrides[project.id] ?? project;
        return {
            ...projectPreview,
            tasks: projectPreview.tasks.map(task => {
                const dates = taskDateOverrides[task.id];
                const draft = crewDrafts[task.id];
                const reconciledAssignments = dispatchReconciliationExpectation?.assignments[task.id];
                const expectedAssignments = draft
                    ? draft.expectedAssignments
                        .filter(assignment => !draft.removeUserIds.includes(assignment.userId))
                        .concat(draft.addUserIds.map(userId => ({ userId, role: "assigned" as const })))
                        .sort((left, right) => left.userId.localeCompare(right.userId) || left.role.localeCompare(right.role))
                    : reconciledAssignments;
                const assignments = expectedAssignments
                    ? expectedAssignments.map(assignment => {
                        const existing = task.assignments.find(row => row.userId === assignment.userId);
                        const member = teamMemberById.get(assignment.userId);
                        return {
                            id: existing?.id ?? `crew-draft:${task.id}:${assignment.userId}`,
                            userId: assignment.userId,
                            name: existing?.name ?? member?.name ?? member?.email ?? "Crew member",
                            status: existing?.status ?? "ACTIVATED",
                            userRole: existing?.userRole ?? member?.role ?? "FIELD_CREW",
                            showOnDispatch: existing?.showOnDispatch ?? member?.showOnDispatch ?? false,
                            assignmentRole: assignment.role,
                        };
                    })
                    : task.assignments;
                return { ...task, ...(dates ?? {}), assignments };
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
    const openProject = openProjectId
        ? [
            ...boardData.pipeline.waitingToStart,
            ...boardData.pipeline.scheduled,
            ...boardData.pipeline.inProgress,
            ...boardData.pipeline.substantialCompletion,
        ].find(project => project.id === openProjectId) ?? null
        : null;

    function setTaskKeyboardState(next: TaskKeyboardEditState | null) {
        taskKeyboardEditRef.current = next;
        setTaskKeyboardEdit(next);
    }

    function setTaskPreview(taskId: string, dates: TaskDateOverride) {
        setTaskDateOverrides(current => ({ ...current, [taskId]: dates }));
    }

    function detachDispatchExpectationTargets(input: {
        projectIds?: ReadonlySet<string>;
        taskIds?: ReadonlySet<string>;
    }) {
        setDispatchConflictTargetIds(current => {
            const next = new Set([...current].filter(targetId =>
                !input.projectIds?.has(targetId) && !input.taskIds?.has(targetId),
            ));
            return next.size === current.size ? current : next;
        });
        setDispatchReconciliationExpectation(current => {
            if (!current) return current;
            const projects = Object.fromEntries(Object.entries(current.projects).filter(([projectId]) =>
                !input.projectIds?.has(projectId),
            ));
            const tasks = Object.fromEntries(Object.entries(current.tasks).filter(([taskId]) =>
                !input.taskIds?.has(taskId),
            ));
            const assignments = Object.fromEntries(Object.entries(current.assignments).filter(([taskId]) =>
                !input.taskIds?.has(taskId),
            ));
            if (Object.keys(projects).length === 0
                && Object.keys(tasks).length === 0
                && Object.keys(assignments).length === 0) {
                return null;
            }
            return { ...current, projects, tasks, assignments };
        });
    }

    // Shared by the board's own save loop AND external (legacy StartDateRow)
    // shifts: saved-awaiting overrides pinned to pre-shift dates can never
    // reconcile — rewrite them to the persisted shifted dates.
    function rewriteAwaitingOverridesFromShift(taskDates: { id: string; startDate: string; endDate: string }[]) {
        if (taskDates.length === 0) return;
        const shiftedById = new Map(taskDates.map(row => [row.id, row]));
        setTaskDateOverrides(current => {
            let changed = false;
            const next = { ...current };
            for (const taskId of awaitingTaskRefreshIds) {
                const shifted = shiftedById.get(taskId);
                if (!shifted || !(taskId in next)) continue;
                next[taskId] = { startDate: shifted.startDate.slice(0, 10), endDate: shifted.endDate.slice(0, 10) };
                changed = true;
            }
            return changed ? next : current;
        });
    }

    // External writers (the legacy waiting-list date setter) report their
    // persisted shifts here; every unseen nonce is applied exactly once, in
    // order — so two shifts landing in one React batch both take effect.
    const lastExternalShiftNonceRef = useRef(0);
    useEffect(() => {
        const unseen = externalShiftEvents.filter(event => event.nonce > lastExternalShiftNonceRef.current);
        if (unseen.length === 0) return;
        lastExternalShiftNonceRef.current = Math.max(...unseen.map(event => event.nonce));
        rewriteAwaitingOverridesFromShift(unseen.flatMap(event => event.taskDates));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- rewrite reads current awaiting state by design
    }, [externalShiftEvents]);

    function clearTaskPreview(taskId: string) {
        // A saved-awaiting task's override IS its committed state pending
        // refresh — cancelling a speculative edit must restore it, never
        // delete it (deleting strands the awaiting id and the refresh poll).
        if (awaitingTaskRefreshIds.has(taskId)) return;
        if (dispatchAwaitingTaskIds.has(taskId)) return;
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
            // A reconciled refresh (e.g. an end-resize save) must not eat the
            // visual preview of a still-UNSAVED start draft on the same
            // project — rebuild that preview from fresh canonical data.
            for (const projectId of reconciled) {
                const draft = projectDraftsRef.current[projectId];
                const canonical = canonicalProjectById.get(projectId);
                if (draft && canonical) setProjectPreview(canonical, draft.targetStart);
            }
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [canonicalProjectById, projectRefreshExpectations]);

    useEffect(() => {
        const expectation = dispatchReconciliationExpectation;
        if (!expectation) return;
        const projectsMatch = Object.entries(expectation.projects).every(([projectId, expected]) => {
            const canonical = canonicalProjectById.get(projectId);
            return Boolean(
                canonical
                && (canonical.startDate ? canonical.startDate.slice(0, 10) : null) === expected.startDate
                && (canonical.endDate ? canonical.endDate.slice(0, 10) : null) === expected.endDate,
            );
        });
        const tasksMatch = Object.entries(expectation.tasks).every(([taskId, expected]) => {
            const canonical = canonicalTaskById.get(taskId);
            return Boolean(
                canonical
                && canonical.startDate.slice(0, 10) === expected.startDate
                && canonical.endDate.slice(0, 10) === expected.endDate,
            );
        });
        const assignmentsMatch = Object.entries(expectation.assignments).every(([taskId, expected]) => {
            const canonical = canonicalTaskById.get(taskId);
            return Boolean(canonical && dashboardAssignmentsMatch(canonical, expected));
        });
        if (!projectsMatch || !tasksMatch || !assignmentsMatch) return;

        const projectIds = new Set(Object.keys(expectation.projects));
        const taskIds = new Set([
            ...Object.keys(expectation.tasks),
            ...Object.keys(expectation.assignments),
        ]);
        const timeoutId = window.setTimeout(() => {
            setProjectPreviewOverrides(current => Object.fromEntries(
                Object.entries(current).filter(([projectId]) => !projectIds.has(projectId)),
            ));
            setProjectIncomeOverrides(current => Object.fromEntries(
                Object.entries(current).filter(([projectId]) => !projectIds.has(projectId)),
            ));
            setTaskDateOverrides(current => Object.fromEntries(
                Object.entries(current).filter(([taskId]) => !taskIds.has(taskId)),
            ));
            setDispatchReconciliationExpectation(current =>
                current?.publicationId === expectation.publicationId ? null : current,
            );
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [canonicalProjectById, canonicalTaskById, dispatchReconciliationExpectation]);

    useEffect(() => {
        if (Object.keys(projectRefreshExpectations).length === 0
            && awaitingTaskRefreshIds.size === 0
            && !dispatchReconciliationExpectation) return;
        const intervalId = window.setInterval(() => router.refresh(), 2_000);
        return () => window.clearInterval(intervalId);
    }, [awaitingTaskRefreshIds.size, dispatchReconciliationExpectation, projectRefreshExpectations, router]);

    useEffect(() => () => {
        activeProjectPointerRef.current?.cleanup();
        activeProjectEndResizeRef.current?.cleanup();
        projectKeyboardCleanupRef.current?.();
        activeTaskPointerRef.current?.cleanup();
        taskKeyboardCleanupRef.current?.();
    }, []);

    function selectBoardView(nextView: BoardView) {
        if (focus === "dispatch") return; // Forced dispatch view — the toggle is hidden, but stay inert if ever called.
        cancelActiveProjectEdit();
        cancelActiveTaskEdit();
        setBoardView(nextView);
        try {
            localStorage.setItem(BOARD_VIEW_STORAGE_KEY, nextView);
        } catch {
            // The selected view still applies for this session when persistence fails.
        }
    }

    const openTaskCreation = useCallback((defaults: Partial<DispatchTaskCreationDefaults> = {}) => {
        setTaskCreationDefaults(defaults);
        setTaskCreationOpen(true);
    }, []);

    const handleBlockActivate = useCallback((taskId: string) => {
        setOpenProjectId(null);
        setOpenTaskId(taskId);
    }, []);
    const closeTaskDrawer = useCallback(() => setOpenTaskId(null), []);
    const handleProjectActivate = useCallback((projectId: string) => {
        setOpenTaskId(null);
        setOpenProjectId(projectId);
    }, []);
    const closeProjectDrawer = useCallback(() => setOpenProjectId(null), []);
    const selectDrawerTask = useCallback((taskId: string) => {
        setOpenProjectId(null);
        setOpenTaskId(taskId);
    }, []);
    const handleDrawerTaskDeleted = useCallback((taskId: string) => {
        if (activeTaskPointerRef.current?.taskId === taskId) activeTaskPointerRef.current.cleanup();
        if (taskKeyboardEditRef.current?.taskId === taskId) {
            taskKeyboardCleanupRef.current?.();
            setTaskKeyboardState(null);
        }
        setTaskDateOverrides(current => {
            if (!(taskId in current)) return current;
            const next = { ...current };
            delete next[taskId];
            return next;
        });
        setAwaitingTaskRefreshIds(current => {
            if (!current.has(taskId)) return current;
            const next = new Set(current);
            next.delete(taskId);
            return next;
        });
        setCrewDrafts(current => {
            if (!(taskId in current)) return current;
            const next = { ...current };
            delete next[taskId];
            return next;
        });
        setOpenTaskId(null);
    }, []);

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

    function queueCrewAddition(taskId: string, userId: string): boolean {
        const task = canonicalTaskById.get(taskId);
        if (!data.canEdit || isTaskLocked(taskId) || !task) return false;
        const notDispatchableReason = assertDispatchableTarget({ type: task.type, status: task.status, hasChildren: taskHasChildrenById.has(taskId) });
        if (notDispatchableReason) {
            toast.error(`That task can't be dispatched: ${notDispatchableReason}`);
            return false;
        }
        const existingDraft = crewDrafts[taskId];
        const expectedAssignments = existingDraft?.expectedAssignments ?? dashboardTaskAssignments(task);
        const addUserIds = new Set(existingDraft?.addUserIds ?? []);
        const removeUserIds = new Set(existingDraft?.removeUserIds ?? []);
        const isExpected = expectedAssignments.some(assignment => assignment.userId === userId);
        const isEffectivelyAssigned = (isExpected && !removeUserIds.has(userId)) || addUserIds.has(userId);
        if (isEffectivelyAssigned) {
            toast.info(`${teamMemberById.get(userId)?.name ?? "Crew member"} is already on ${task.name}.`);
            return false;
        }

        if (isExpected) removeUserIds.delete(userId);
        else addUserIds.add(userId);
        detachDispatchExpectationTargets({ taskIds: new Set([taskId]) });
        if (addUserIds.size === 0 && removeUserIds.size === 0) {
            setCrewDrafts(current => {
                if (!(taskId in current)) return current;
                const next = { ...current };
                delete next[taskId];
                return next;
            });
            return true;
        }
        setCrewDrafts(current => ({
            ...current,
            [taskId]: {
                expectedAssignments,
                addUserIds: [...addUserIds].sort(),
                removeUserIds: [...removeUserIds].sort(),
            },
        }));
        return true;
    }

    function queueCrewRemoval(taskId: string, userId: string) {
        const task = canonicalTaskById.get(taskId);
        if (!data.canEdit || isTaskLocked(taskId) || !task) return;
        const existingDraft = crewDrafts[taskId];
        const expectedAssignments = existingDraft?.expectedAssignments ?? dashboardTaskAssignments(task);
        const addUserIds = new Set(existingDraft?.addUserIds ?? []);
        const removeUserIds = new Set(existingDraft?.removeUserIds ?? []);
        const isExpected = expectedAssignments.some(assignment => assignment.userId === userId);
        const isEffectivelyAssigned = (isExpected && !removeUserIds.has(userId)) || addUserIds.has(userId);
        if (!isEffectivelyAssigned) return;

        if (addUserIds.has(userId)) addUserIds.delete(userId);
        else if (isExpected) removeUserIds.add(userId);
        detachDispatchExpectationTargets({ taskIds: new Set([taskId]) });
        if (addUserIds.size === 0 && removeUserIds.size === 0) {
            setCrewDrafts(current => {
                if (!(taskId in current)) return current;
                const next = { ...current };
                delete next[taskId];
                return next;
            });
            return;
        }
        setCrewDrafts(current => ({
            ...current,
            [taskId]: {
                expectedAssignments,
                addUserIds: [...addUserIds].sort(),
                removeUserIds: [...removeUserIds].sort(),
            },
        }));
    }

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
        // The back-to-canonical shortcut only applies to live drafts: for a
        // saved-awaiting task the canonical props are STALE, so "back to the
        // old date" is a real revert that must become a draft — shortcutting
        // would delete the pinned override and strand the awaiting id.
        if (!awaitingTaskRefreshIds.has(taskId)
            && normalizedDates.startDate === originalDates.startDate
            && normalizedDates.endDate === originalDates.endDate
            && !dispatchAwaitingTaskIds.has(taskId)) {
            clearTaskPreview(taskId);
            return;
        }
        // Re-editing a saved-awaiting task turns it back into a live draft.
        setAwaitingTaskRefreshIds(current => {
            if (!current.has(taskId)) return current;
            return new Set([...current].filter(id => id !== taskId));
        });
        detachDispatchExpectationTargets({ taskIds: new Set([taskId]) });
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
            // Cancelling a project draft must also UNDO the rebase it applied
            // to this project's task drafts, or they'd save shifted for a
            // project move that never happened.
            const previousDelta = projectDrafts[project.id]?.deltaDays ?? 0;
            if (previousDelta !== 0 && canonicalProject.status !== "In Progress") {
                const projectTaskIds = new Set(canonicalProject.tasks.map(task => task.id));
                setTaskDateOverrides(current => Object.fromEntries(Object.entries(current).map(([taskId, dates]) => {
                    if (!projectTaskIds.has(taskId) || awaitingTaskRefreshIds.has(taskId)) return [taskId, dates];
                    return [taskId, {
                        startDate: formatDate(addDays(parseUTCDate(dates.startDate), -previousDelta)),
                        endDate: formatDate(addDays(parseUTCDate(dates.endDate), -previousDelta)),
                    }];
                })));
            }
            clearProjectPreview(project.id);
            clearProjectDraft(project.id);
            return;
        }
        detachDispatchExpectationTargets({
            projectIds: new Set([project.id]),
            taskIds: new Set(canonicalProject.tasks.map(task => task.id)),
        });
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
                    // Saved-awaiting overrides are persisted state, not drafts —
                    // never rebase them.
                    if (!projectTaskIds.has(taskId) || awaitingTaskRefreshIds.has(taskId)) return [taskId, dates];
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
        setCrewDrafts({});
        // Discard clears UNSAVED drafts only. Saved-awaiting overrides are
        // committed state pending refresh — removing them here would strand
        // their awaiting ids and the refresh poll forever.
        setTaskDateOverrides(current => {
            const savedAwaitingEntries = Object.entries(current).filter(([taskId]) => awaitingTaskRefreshIds.has(taskId));
            const dispatchAwaitingEntries = Object.entries(current).filter(([taskId]) => dispatchAwaitingTaskIds.has(taskId));
            return Object.fromEntries([...savedAwaitingEntries, ...dispatchAwaitingEntries]);
        });
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

    function handleDispatchFailure(result: Exclude<Awaited<ReturnType<typeof publishDispatchAction>>, { ok: true }>) {
        if (result.code === "STALE_DISPATCH") {
            setDispatchConflictTargetIds(new Set(result.conflicts.map(conflict => conflict.targetId)));
            setDispatchReview(null);
            toast.error("Dispatch changed while you were reviewing. Nothing was queued. Your drafts are still here.");
            router.refresh();
            return;
        }
        if (result.code === "NO_CHANGES") {
            toast.info(result.message);
            return;
        }
        toast.error(result.message);
    }

    async function collectDispatchIntents(): Promise<DispatchIntent[] | null> {
        const projectEntries = Object.entries(projectDrafts);
        const taskEntries = [...draftTaskIds].map(taskId => [taskId, taskDateOverrides[taskId]!] as const);
        const crewEntries = Object.entries(crewDrafts);
        if (projectEntries.length === 0 && taskEntries.length === 0 && crewEntries.length === 0) return [];

        const affectedProjectIds = new Set([
            ...projectEntries.map(([projectId]) => projectId),
            ...taskEntries
                .map(([taskId]) => canonicalTaskProjectById.get(taskId))
                .filter((projectId): projectId is string => Boolean(projectId)),
            ...crewEntries
                .map(([taskId]) => canonicalTaskProjectById.get(taskId))
                .filter((projectId): projectId is string => Boolean(projectId)),
        ]);
        const lockedNames = [...affectedProjectIds]
            .filter(projectId => combinedPendingProjectIds.has(projectId))
            .map(projectId => canonicalProjectById.get(projectId)?.name ?? projectId);
        if (lockedNames.length > 0) {
            toast.info(`Review will be available after another edit finishes: ${lockedNames.join(", ")}`);
            return null;
        }

        const inProgressChoices = new Map<string, ProjectMoveChoice>();
        for (const [projectId, draft] of projectEntries) {
            const project = canonicalProjectById.get(projectId);
            if (!project) {
                toast.error(`Project ${projectId} is no longer on this schedule. Refresh before reviewing.`);
                router.refresh();
                return null;
            }
            if (project.status !== "In Progress") continue;
            const refreshedIntent = createProjectDropIntent(project, draft.targetStart);
            if (!refreshedIntent) {
                toast.error(`${project.name} no longer has a movable schedule range. Refresh before reviewing.`);
                router.refresh();
                return null;
            }
            setConfirmIntent(refreshedIntent);
            const choice = await waitForConfirmChoice();
            setConfirmIntent(null);
            if (choice === "cancel") return null;
            inProgressChoices.set(projectId, choice);
        }

        const intents: DispatchIntent[] = [];
        for (const [projectId, draft] of projectEntries) {
            const project = canonicalProjectById.get(projectId);
            if (!project) return null;
            intents.push({
                kind: "PROJECT_START",
                projectId,
                expectedUpdatedAt: project.updatedAt,
                expectedTasks: project.tasks.map(task => ({
                    taskId: task.id,
                    expectedUpdatedAt: taskExpectedUpdatedAt(task.id, task.updatedAt),
                    expectedAssignments: dashboardTaskAssignments(task),
                })),
                startDate: draft.targetStart,
                shiftMode: project.status === "In Progress"
                    ? inProgressChoices.get(projectId) === "marker-only"
                        ? "MARKER_ONLY"
                        : "NOT_STARTED_TASKS"
                    : "ALL_TASKS",
            });
        }
        for (const [taskId, dates] of taskEntries) {
            const task = canonicalTaskById.get(taskId);
            const projectId = canonicalTaskProjectById.get(taskId);
            if (!task || !projectId) {
                toast.error(`Task ${taskId} is no longer on this schedule. Refresh before reviewing.`);
                router.refresh();
                return null;
            }
            intents.push({
                kind: "TASK_DATES",
                projectId,
                taskId,
                expectedUpdatedAt: taskExpectedUpdatedAt(taskId, task.updatedAt),
                expectedAssignments: dashboardTaskAssignments(task),
                startDate: dates.startDate,
                endDate: dates.endDate,
            });
        }
        for (const [taskId, draft] of crewEntries) {
            const task = canonicalTaskById.get(taskId);
            const projectId = canonicalTaskProjectById.get(taskId);
            if (!task || !projectId) {
                toast.error(`Task ${taskId} is no longer on this schedule. Refresh before reviewing.`);
                router.refresh();
                return null;
            }
            const removeIds = new Set(draft.removeUserIds);
            const assignments = draft.expectedAssignments
                .filter(assignment => !removeIds.has(assignment.userId))
                .concat(draft.addUserIds.map(userId => ({ userId, role: "assigned" as const })))
                .sort((left, right) => left.userId.localeCompare(right.userId) || left.role.localeCompare(right.role));
            intents.push({
                kind: "TASK_CREW",
                projectId,
                taskId,
                expectedUpdatedAt: taskExpectedUpdatedAt(taskId, task.updatedAt),
                expectedAssignments: draft.expectedAssignments,
                assignments,
            });
        }
        return intents;
    }

    async function reviewDispatchDrafts() {
        if (isDispatchReviewing || isDispatchPublishing || isSaving || draftCount === 0 || pendingNoteSaveTaskIds.size > 0) return;
        cancelActiveTaskEdit();
        cancelActiveProjectEdit();
        setIsDispatchReviewing(true);
        try {
            const intents = await collectDispatchIntents();
            if (!intents || intents.length === 0) return;
            const clientRequestId = crypto.randomUUID();
            const result = await publishDispatchAction({
                clientRequestId,
                intents,
                dryRun: true,
            });
            if (!result.ok) {
                handleDispatchFailure(result);
                return;
            }
            setDispatchReview({
                clientRequestId,
                intents,
                preview: result,
                published: false,
            });
        } finally {
            setConfirmIntent(null);
            setIsDispatchReviewing(false);
        }
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
        setSaveLockedProjectIds(lockedProjectIds); // the derived publisher unions live resize saves

        const failedProjectNames: string[] = [];
        const succeededProjectIds: string[] = [];
        const failedProjectIds = new Set<string>();
        const projectExpectations: Record<string, ProjectRefreshExpectation> = {};
        // Persisted task dates from successful shifts — saved-awaiting tasks
        // caught in a shift must have their pinned overrides rewritten to the
        // shifted dates or their awaiting ids can never reconcile.
        const shiftedPersistedDates: { id: string; startDate: string; endDate: string }[] = [];
        // Core-side side notes (skipped QB milestones, cleared end dates, …)
        // surfaced to the user after the batch settles.
        const saveNotes: string[] = [];

        for (const [projectId, draft] of projectEntries) {
            const canonicalProject = canonicalProjectById.get(projectId);
            if (!canonicalProject) {
                failedProjectNames.push(projectId);
                failedProjectIds.add(projectId);
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
                        if (result.notes?.length) saveNotes.push(...result.notes.map(note => `${canonicalProject.name}: ${note}`));
                    } else {
                        // Owner-decided semantics: the bar drag moves the start
                        // marker AND the not-started work — the whole future of
                        // the job follows the drag; started work stays put.
                        const markerResult = await updateProjectStartDateAction(projectId, draft.targetStart, false);
                        const shiftResult = await shiftNotStartedTasksAction(projectId, draft.deltaDays);
                        shiftedPersistedDates.push(...shiftResult.shiftedTaskDates);
                        projectExpectations[projectId] = {
                            projectStartDate: markerResult.startDate,
                            taskDates: shiftResult.shiftedTaskDates.filter(row => !batchedTaskIds.has(row.id)),
                        };
                        const notes = [...(markerResult.notes ?? []), ...(shiftResult.notes ?? [])];
                        if (notes.length) saveNotes.push(...notes.map(note => `${canonicalProject.name}: ${note}`));
                    }
                } else {
                    const result = await updateProjectStartDateAction(projectId, draft.targetStart, true);
                    shiftedPersistedDates.push(...result.shiftedTaskDates);
                    projectExpectations[projectId] = { projectStartDate: result.startDate, taskDates: result.shiftedTaskDates.filter(row => !batchedTaskIds.has(row.id)) };
                    if (result.notes?.length) saveNotes.push(...result.notes.map(note => `${canonicalProject.name}: ${note}`));
                }
                succeededProjectIds.push(projectId);
            } catch (error) {
                failedProjectNames.push(canonicalProject.name);
                failedProjectIds.add(projectId);
            }
        }

        if (succeededProjectIds.length > 0) {
            const succeeded = new Set(succeededProjectIds);
            setProjectDrafts(current => Object.fromEntries(Object.entries(current).filter(([id]) => !succeeded.has(id))));
            setProjectRefreshExpectations(current => ({ ...current, ...projectExpectations }));
            // Rewrite saved-awaiting overrides that a shift just moved: their
            // pinned dates must track the PERSISTED (shifted) dates or their
            // awaiting ids never match refreshed canonical rows.
            rewriteAwaitingOverridesFromShift(shiftedPersistedDates);
        }

        let failedTaskNames: string[] = [];
        let succeededTaskCount = 0;
        // Task drafts on a project whose shift FAILED stay drafted (their
        // overrides are stored rebased against that shift; saving them now
        // would write post-shift dates onto an unshifted schedule). They save
        // with the project on the next attempt.
        const sendableTaskEntries = taskEntries.filter(([taskId]) => {
            const projectId = canonicalTaskProjectById.get(taskId);
            return !projectId || !failedProjectIds.has(projectId);
        });
        if (sendableTaskEntries.length > 0) {
            const changes = sendableTaskEntries.map(([taskId, dates]) => ({ taskId, startDate: dates.startDate, endDate: dates.endDate }));
            try {
                // Chunked to the server's 200-change cap so any draft count
                // saves in one gesture. Failures are isolated PER CHUNK: a
                // rejected chunk synthesizes failure rows for its own tasks
                // only — earlier chunks' successes are never discarded or
                // retried as if unsaved.
                const allResults = [] as Awaited<ReturnType<typeof saveCompanyScheduleTaskDatesAction>>["results"];
                for (let offset = 0; offset < changes.length; offset += 200) {
                    const chunk = changes.slice(offset, offset + 200);
                    try {
                        const batchResult = await saveCompanyScheduleTaskDatesAction(chunk);
                        allResults.push(...batchResult.results);
                    } catch (chunkError: any) {
                        const message = chunkError?.message ?? "Save failed";
                        allResults.push(...chunk.map(change => ({ taskId: change.taskId, ok: false as const, error: message })));
                    }
                }
                const succeededRows = allResults.filter(row => row.ok);
                failedTaskNames = allResults
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
        setSaveLockedProjectIds(EMPTY_PROJECT_IDS); // derived publisher keeps live resize saves locked
        router.refresh();

        if (saveNotes.length > 0) toast.info(saveNotes.join(" "));
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

    async function publishDispatchDrafts() {
        if (!dispatchReview || dispatchReview.published || isDispatchPublishing) return;
        setIsDispatchPublishing(true);
        try {
            const result = await publishDispatchAction({
                clientRequestId: dispatchReview.clientRequestId,
                intents: dispatchReview.intents,
                dryRun: false,
            });
            if (!result.ok) {
                handleDispatchFailure(result);
                return;
            }
            if (!result.publicationId) {
                toast.error("Dispatch committed without a publication ID. Refresh before trying again.");
                return;
            }

            const publishedProjectIds = new Set(dispatchReview.intents
                .filter(intent => intent.kind === "PROJECT_START")
                .map(intent => intent.projectId));
            const explicitlyDraftedTaskIds = new Set(dispatchReview.intents
                .filter(intent => intent.kind === "TASK_DATES")
                .map(intent => intent.taskId));
            const publishedCrewTaskIds = new Set(dispatchReview.intents
                .filter(intent => intent.kind === "TASK_CREW")
                .map(intent => intent.taskId));

            setProjectDrafts(current => Object.fromEntries(
                Object.entries(current).filter(([projectId]) => !publishedProjectIds.has(projectId)),
            ));
            setProjectPreviewOverrides(current => {
                const next = { ...current };
                for (const [projectId, expected] of Object.entries(result.reconciliation.projects)) {
                    const row = next[projectId] ?? canonicalProjectById.get(projectId);
                    if (!row) continue;
                    next[projectId] = {
                        ...row,
                        startDate: expected.startDate ? `${expected.startDate}T00:00:00.000Z` : null,
                        endDate: expected.endDate ? `${expected.endDate}T00:00:00.000Z` : null,
                    };
                }
                return next;
            });
            setTaskDateOverrides(current => {
                const next = Object.fromEntries(
                    Object.entries(current).filter(([taskId]) => !explicitlyDraftedTaskIds.has(taskId)),
                );
                for (const [taskId, dates] of Object.entries(result.reconciliation.tasks)) {
                    next[taskId] = dates;
                }
                return next;
            });
            setCrewDrafts(current => Object.fromEntries(
                Object.entries(current).filter(([taskId]) => !publishedCrewTaskIds.has(taskId)),
            ));
            setDispatchReconciliationExpectation({
                publicationId: result.publicationId,
                projects: result.reconciliation.projects,
                tasks: result.reconciliation.tasks,
                assignments: result.reconciliation.assignments,
            });
            setDispatchConflictTargetIds(new Set());
            setDispatchReview({
                ...dispatchReview,
                preview: result,
                published: true,
            });
            toast.success("Dispatch recorded — delivery pending");
            router.refresh();
        } finally {
            setIsDispatchPublishing(false);
        }
    }

    function cancelProjectEditsForProjects(projectIds: ReadonlySet<string>) {
        const pointerEdit = activeProjectPointerRef.current;
        if (pointerEdit && projectIds.has(pointerEdit.projectId)) {
            pointerEdit.cleanup();
        }
        const endResizeEdit = activeProjectEndResizeRef.current;
        if (endResizeEdit && projectIds.has(endResizeEdit.projectId)) {
            endResizeEdit.cleanup();
        }
        const keyboardEdit = projectKeyboardEditRef.current;
        if (keyboardEdit && projectIds.has(keyboardEdit.projectId)) {
            projectKeyboardCleanupRef.current?.();
            setProjectKeyboardState(null);
        }
    }

    function cancelActiveProjectEdit() {
        activeProjectPointerRef.current?.cleanup();
        activeProjectEndResizeRef.current?.cleanup();
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
            visualLayer: null,
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
            const visualLayer = drag.visualLayer;
            if (visualLayer) {
                visualLayer.update({
                    clientX: drag.latestClientX,
                    clientY: drag.latestClientY,
                    label: candidate ? `UTC start ${candidate}` : null,
                    targetDate: candidate ? hitTestScheduleDate(drag.latestClientX, drag.latestClientY) : null,
                });
            }
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
                drag.visualLayer = createDragVisualLayer({
                    sourceElement: drag.sourceElement,
                    sourceSelector: drag.project.status === "In Progress"
                        ? projectMarkerDragSourceSelector(project.id)
                        : projectDragSourceSelector(project.id),
                    kind: drag.project.status === "In Progress" ? "project-marker-move" : "project-move",
                    startClientX: drag.startX,
                    startClientY: drag.startY,
                    cloneSelector: drag.project.status === "In Progress" ? '[data-drag-project-title="true"]' : undefined,
                });
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
        const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== "Escape" || !drag.active) return;
            event.preventDefault();
            finish(true);
        };
        drag.cleanup = () => {
            if (activeProjectPointerRef.current === drag) activeProjectPointerRef.current = null;
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            window.removeEventListener("blur", onWindowBlur);
            window.removeEventListener("keydown", onWindowKeyDown);
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            drag.visualLayer?.cleanup();
            drag.visualLayer = null;
            drag.sourceElement.style.touchAction = drag.previousTouchAction;
            try {
                if (drag.sourceElement.hasPointerCapture(drag.pointerId)) drag.sourceElement.releasePointerCapture(drag.pointerId);
            } catch {
                // A refresh may replace the originating weekly segment.
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
        window.addEventListener("keydown", onWindowKeyDown);
    }

    // Immediate server write for a released end-resize drag (item 2) — NOT
    // part of the draft system. getEffectiveProjectRange treats endDate as an
    // EXTEND-ONLY candidate, so a released end shorter than the last task's
    // end still saves (owner-approved semantics) but the bar keeps showing
    // through the task-derived date — surfaced here as an info toast.
    function commitProjectEndResize(project: DashboardProjectRow, candidateEnd: string) {
        const taskDerivedRange = getEffectiveProjectRange({ ...project, endDate: null });
        setEndResizeSavingProjectIds(current => new Set([...current, project.id]));
        void (async () => {
            try {
                await updateProjectEndDateAction(project.id, candidateEnd);
                // Reconcile the resize preview through the expectation system —
                // it clears the override once canonical endDate matches;
                // leaving the override unmanaged would mask ALL later
                // refreshed data for this project.
                setProjectRefreshExpectations(current => ({
                    ...current,
                    [project.id]: { projectEndDate: candidateEnd, taskDates: [] },
                }));
                router.refresh();
                if (taskDerivedRange && parseUTCDate(candidateEnd) < taskDerivedRange.end) {
                    toast.info(`End date saved — the bar still shows through ${formatDate(addDays(taskDerivedRange.end, -1))} because tasks run that long.`);
                } else {
                    toast.success("End date saved");
                }
            } catch (error: any) {
                clearProjectPreview(project.id);
                toast.error(error?.message || "Failed to update end date");
            } finally {
                setEndResizeSavingProjectIds(current => {
                    if (!current.has(project.id)) return current;
                    const next = new Set(current);
                    next.delete(project.id);
                    return next;
                });
            }
        })();
    }

    function handleProjectEndResizeStart(project: DashboardProjectRow, start: ProjectEndResizePointerStart) {
        const canonicalProject = canonicalProjectById.get(project.id);
        if (!data.canEdit || !canonicalProject || isProjectLocked(project.id)) return;
        cancelActiveProjectEdit();
        cancelActiveTaskEdit();
        const drag: ActiveProjectEndResizeEdit = {
            projectId: project.id,
            project: canonicalProject,
            pointerId: start.pointerId,
            pointerType: start.pointerType,
            startX: start.clientX,
            startY: start.clientY,
            originX: start.clientX,
            latestClientX: start.clientX,
            latestClientY: start.clientY,
            originalStart: start.originalStart,
            originalEnd: start.originalEnd,
            monthDayWidth: start.timelineDayWidth ? null : measureMonthDayWidth(start.clientX, start.clientY),
            active: false,
            currentCandidate: null,
            visualLayer: null,
            animationFrameId: null,
            sourceElement: start.sourceElement,
            previousTouchAction: start.sourceElement.style.touchAction,
            start,
            cleanup: () => undefined,
        };

        const calculateEndResizeCandidate = (): string | null => {
            const dayWidth = drag.start.timelineDayWidth ?? drag.monthDayWidth;
            if (!dayWidth) return null;
            const deltaDays = getTimelinePointerDelta(drag.latestClientX, drag.originX, dayWidth);
            // Clamp against the PERSISTED start marker when one exists — the
            // effective range can start at an earlier task (marker-only moves),
            // and the server rejects end <= persisted startDate.
            const clampStart = drag.project.startDate
                ? parseUTCDate(drag.project.startDate.slice(0, 10))
                : parseUTCDate(drag.originalStart);
            const candidateEnd = computeProjectEndResizeCandidate(
                parseUTCDate(drag.originalEnd),
                clampStart,
                deltaDays,
            );
            return formatDate(candidateEnd);
        };
        const getEndResizeAutoscrollStep = () => {
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
        const updateEndResizeVisual = () => {
            const candidate = calculateEndResizeCandidate();
            drag.currentCandidate = candidate;
            const dayWidth = drag.start.timelineDayWidth ?? drag.monthDayWidth;
            const deltaX = candidate && dayWidth
                ? getDaysBetween(parseUTCDate(drag.originalEnd), parseUTCDate(candidate)) * dayWidth
                : undefined;
            const visualLayer = drag.visualLayer;
            if (visualLayer) {
                visualLayer.update({
                    clientX: drag.latestClientX,
                    clientY: drag.latestClientY,
                    deltaX,
                    sourceOffsetX: drag.originX - drag.startX,
                    label: candidate ? `UTC end ${candidate}` : null,
                    targetDate: candidate ? hitTestScheduleDate(drag.latestClientX, drag.latestClientY) : null,
                });
            }
        };
        const runEndResizeFrame = () => {
            drag.animationFrameId = null;
            if (!drag.active) return;
            const container = drag.start.timelineScrollContainerRef?.current;
            const scrollDelta = getEndResizeAutoscrollStep();
            if (container && scrollDelta !== 0) {
                const before = container.scrollLeft;
                container.scrollLeft += scrollDelta;
                drag.originX -= container.scrollLeft - before;
            }
            updateEndResizeVisual();
            if (getEndResizeAutoscrollStep() !== 0 && drag.animationFrameId == null) {
                drag.animationFrameId = requestAnimationFrame(runEndResizeFrame);
            }
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
                drag.visualLayer = createDragVisualLayer({
                    sourceElement: drag.sourceElement,
                    sourceSelector: projectDragSourceSelector(project.id),
                    kind: "project-end-resize",
                    startClientX: drag.startX,
                    startClientY: drag.startY,
                });
            }
            event.preventDefault();
            if (drag.animationFrameId == null) drag.animationFrameId = requestAnimationFrame(runEndResizeFrame);
        };
        const finish = (cancelled: boolean, releaseEvent?: PointerEvent) => {
            if (releaseEvent) {
                drag.latestClientX = releaseEvent.clientX;
                drag.latestClientY = releaseEvent.clientY;
            }
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            const candidate = drag.active && !cancelled ? calculateEndResizeCandidate() : null;
            drag.cleanup();
            if (!drag.active || cancelled || !candidate || candidate === drag.originalEnd) {
                clearProjectPreview(drag.projectId);
                return;
            }
            setProjectPreviewOverrides(current => ({
                ...current,
                [drag.projectId]: { ...drag.project, endDate: `${candidate}T00:00:00.000Z` },
            }));
            commitProjectEndResize(drag.project, candidate);
        };
        const onPointerUp = (event: PointerEvent) => {
            if (event.pointerId === drag.pointerId) finish(false, event);
        };
        const onPointerCancel = (event: PointerEvent) => {
            if (event.pointerId === drag.pointerId) finish(true);
        };
        const onWindowBlur = () => finish(true);
        const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== "Escape" || !drag.active) return;
            event.preventDefault();
            finish(true);
        };
        drag.cleanup = () => {
            if (activeProjectEndResizeRef.current === drag) activeProjectEndResizeRef.current = null;
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            window.removeEventListener("blur", onWindowBlur);
            window.removeEventListener("keydown", onWindowKeyDown);
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            drag.visualLayer?.cleanup();
            drag.visualLayer = null;
            drag.sourceElement.style.touchAction = drag.previousTouchAction;
            try {
                if (drag.sourceElement.hasPointerCapture(drag.pointerId)) drag.sourceElement.releasePointerCapture(drag.pointerId);
            } catch {
                // A refresh may replace the originating weekly segment.
            }
        };
        activeProjectEndResizeRef.current = drag;
        try {
            start.sourceElement.setPointerCapture(start.pointerId);
        } catch {
            // Window listeners keep ownership stable when capture is unavailable.
        }
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("keydown", onWindowKeyDown);
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
            monthDayWidth: start.timelineDayWidth ? null : measureMonthDayWidth(start.clientX, start.clientY),
            mode,
            active: false,
            currentCandidate: originalDates,
            visualLayer: null,
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
        const updateTaskVisual = (): TaskDateOverride | null => {
            const candidate = calculatePointerCandidate();
            drag.currentCandidate = candidate;
            let deltaX: number | undefined;
            const dayWidth = start.timelineDayWidth ?? drag.monthDayWidth;
            if (candidate && dayWidth && mode !== "move") {
                const originalBoundary = mode === "resize-left" ? originalDates.startDate : originalDates.endDate;
                const candidateBoundary = mode === "resize-left" ? candidate.startDate : candidate.endDate;
                deltaX = getDaysBetween(parseUTCDate(originalBoundary), parseUTCDate(candidateBoundary)) * dayWidth;
            }
            const visualLayer = drag.visualLayer;
            if (visualLayer) {
                visualLayer.update({
                    clientX: drag.latestClientX,
                    clientY: drag.latestClientY,
                    deltaX,
                    sourceOffsetX: drag.originX - drag.startX,
                    label: candidate ? `UTC ${candidate.startDate} to ${candidate.endDate}` : null,
                    targetDate: candidate ? hitTestScheduleDate(drag.latestClientX, drag.latestClientY) : null,
                });
            }
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
            updateTaskVisual();
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
                drag.visualLayer = createDragVisualLayer({
                    sourceElement: drag.sourceElement,
                    sourceSelector: taskDragSourceSelector(task.id),
                    kind: mode === "move" ? "task-move" : mode === "resize-left" ? "task-resize-left" : "task-resize-right",
                    startClientX: drag.startX,
                    startClientY: drag.startY,
                });
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
        const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key !== "Escape" || !drag.active) return;
            event.preventDefault();
            finish(true);
        };

        drag.cleanup = () => {
            if (activeTaskPointerRef.current === drag) activeTaskPointerRef.current = null;
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            window.removeEventListener("blur", onWindowBlur);
            window.removeEventListener("keydown", onWindowKeyDown);
            if (drag.animationFrameId != null) cancelAnimationFrame(drag.animationFrameId);
            drag.animationFrameId = null;
            drag.visualLayer?.cleanup();
            drag.visualLayer = null;
            drag.sourceElement.style.touchAction = drag.previousTouchAction;
            try {
                if (drag.sourceElement.hasPointerCapture(drag.pointerId)) drag.sourceElement.releasePointerCapture(drag.pointerId);
            } catch {
                // A refresh may replace the originating weekly segment.
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
        window.addEventListener("keydown", onWindowKeyDown);
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
        dispatchReconciliationExpectation ? "dispatch" : null,
    ].filter((kind): kind is string => Boolean(kind));

    return (
        <MotionConfig reducedMotion="user">
        <div ref={boardContainerRef} className={focus === "dispatch" ? "hui-card overflow-hidden min-h-[calc(100vh-4rem)]" : "hui-card mb-6 overflow-hidden"}>
            <div className="flex flex-col gap-2.5 px-4 py-3 border-b border-hui-border">
                {/* Title row — WHAT you're looking at, plus WHEN, left to right; page-level links right-aligned. */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base font-semibold text-hui-textMain">
                        {focus === "dispatch"
                            ? dispatchHeaderLabel
                            : `Project Schedule — ${boardView === "dispatch" ? dispatchDateLabel : monthLabel}`}
                    </h2>
                    <div className="flex items-center gap-2">
                        {focus === "dispatch" ? (
                            draftCount > 0 ? (
                                <button
                                    type="button"
                                    aria-disabled="true"
                                    title={`Confirm or discard your ${draftCount} draft${draftCount === 1 ? "" : "s"} first`}
                                    className="hui-btn hui-btn-secondary h-8 text-xs text-hui-textMuted/60 cursor-not-allowed"
                                >
                                    Exit full screen
                                </button>
                            ) : (
                                <Link href="/company-dashboard" className="hui-btn hui-btn-secondary h-8 text-xs">
                                    Exit full screen
                                </Link>
                            )
                        ) : (
                            <>
                                <Link href="/company-dashboard/guide" target="_blank" rel="noopener" className="hui-btn hui-btn-secondary h-8 text-xs inline-flex items-center gap-1.5">
                                    <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
                                    How to use
                                </Link>
                                {boardView === "dispatch" && (
                                    draftCount > 0 ? (
                                        <button
                                            type="button"
                                            aria-disabled="true"
                                            title={`Confirm or discard your ${draftCount} draft${draftCount === 1 ? "" : "s"} first`}
                                            className="hui-btn hui-btn-secondary h-8 text-xs text-hui-textMuted/60 cursor-not-allowed inline-flex items-center gap-1.5"
                                        >
                                            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                                            Full screen
                                        </button>
                                    ) : (
                                        <Link href="/company-dashboard/dispatch" className="hui-btn hui-btn-secondary h-8 text-xs inline-flex items-center gap-1.5">
                                            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                                            Full screen
                                        </Link>
                                    )
                                )}
                            </>
                        )}
                    </div>
                </div>
                {/* Controls row — view switch, the one primary action, then WHEN nav. */}
                <div className="flex flex-wrap items-center gap-3">
                    {focus !== "dispatch" && (
                        <SegmentedControl
                            ariaLabel="Schedule view"
                            value={boardView}
                            onChange={selectBoardView}
                            options={[
                                { value: "month", label: "Month" },
                                { value: "timeline", label: "Timeline" },
                                { value: "dispatch", label: "Dispatch" },
                            ]}
                        />
                    )}
                    <div className="flex items-center gap-2">
                        {data.canEdit && (
                            <button
                                type="button"
                                onClick={() => openTaskCreation()}
                                className={`hui-btn h-8 text-sm ${boardView === "dispatch" ? "hui-btn-secondary" : "hui-btn-primary"}`}
                            >
                                + Task
                            </button>
                        )}
                        {boardView === "dispatch" && data.canEdit && (
                            <button
                                type="button"
                                onClick={() => void reviewDispatchDrafts()}
                                disabled={draftCount === 0 || isDispatchReviewing || isDispatchPublishing || pendingNoteSaveTaskIds.size > 0}
                                title={pendingNoteSaveTaskIds.size > 0 ? "Waiting for a note to finish saving..." : undefined}
                                className="hui-btn hui-btn-green h-8 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {pendingNoteSaveTaskIds.size > 0 ? (
                                    "Saving note..."
                                ) : isDispatchReviewing ? (
                                    "Reviewing..."
                                ) : draftCount > 0 ? (
                                    <>
                                        {"Review dispatch ("}
                                        <motion.span
                                            key={draftCount}
                                            data-motion-scope="dispatch-count"
                                            initial={{ opacity: 0, scale: 0.85 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            transition={{ duration: 0.16 }}
                                            className="inline-block tabular-nums"
                                        >
                                            {draftCount}
                                        </motion.span>
                                        {")"}
                                    </>
                                ) : (
                                    "Review dispatch"
                                )}
                            </button>
                        )}
                    </div>
                    {focus !== "dispatch" && boardView !== "dispatch" && isAdmin && overlays && (
                        <>
                            <div className="h-6 w-px bg-hui-border" aria-hidden="true" />
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-hui-textMuted">Show:</span>
                                <button type="button" onClick={() => setShowIncome(value => !value)} className={`h-8 text-xs font-semibold px-2.5 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showIncome ? "bg-green-100 text-green-700 border-green-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Income</button>
                                <button type="button" onClick={() => setShowExpenses(value => !value)} className={`h-8 text-xs font-semibold px-2.5 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showExpenses ? "bg-red-100 text-red-700 border-red-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Expenses</button>
                                <button type="button" onClick={() => setShowProjectedCo(value => !value)} className={`h-8 text-xs font-semibold px-2.5 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showProjectedCo ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Projected CO</button>
                                <button type="button" onClick={() => setShowHours(value => !value)} className={`h-8 text-xs font-semibold px-2.5 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary ${showHours ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-white text-hui-textMuted border-hui-border"}`}>Hours</button>
                            </div>
                        </>
                    )}
                    {focus !== "dispatch" && boardView !== "dispatch" && (
                        <>
                            <div className="h-6 w-px bg-hui-border" aria-hidden="true" />
                            <div className="flex items-center gap-2">
                                <button type="button" onClick={() => router.push('/company-dashboard?month=' + shiftMonth(month, -1))} className="hui-btn hui-btn-secondary h-8 text-sm">← Prev</button>
                                <button type="button" onClick={() => { router.push("/company-dashboard"); setScrollToTodayNonce(n => n + 1); }} className="hui-btn hui-btn-secondary h-8 text-sm">Today</button>
                                <button type="button" onClick={() => router.push('/company-dashboard?month=' + shiftMonth(month, 1))} className="hui-btn hui-btn-secondary h-8 text-sm">Next →</button>
                            </div>
                        </>
                    )}
                    {boardView === "dispatch" && dispatchMode === "week" && (
                        <>
                            <div className="h-6 w-px bg-hui-border" aria-hidden="true" />
                            <div className="flex items-center gap-2">
                                <button type="button" onClick={() => setDispatchWeekStart(current => addDays(current, -7))} className="hui-btn hui-btn-secondary h-8 text-sm" aria-label="Previous week">←</button>
                                <button type="button" onClick={() => setDispatchWeekStart(getMonday(todayUTC()))} className="hui-btn hui-btn-secondary h-8 text-sm">This week</button>
                                <button type="button" onClick={() => setDispatchWeekStart(current => addDays(current, 7))} className="hui-btn hui-btn-secondary h-8 text-sm" aria-label="Next week">→</button>
                            </div>
                        </>
                    )}
                    {boardView === "dispatch" && dispatchMode === "today" && (
                        <>
                            <div className="h-6 w-px bg-hui-border" aria-hidden="true" />
                            <div className="flex items-center gap-2">
                                <button type="button" onClick={() => setDispatchDayKey(current => shiftDayKey(current, -1))} className="hui-btn hui-btn-secondary h-8 text-sm" aria-label="Previous day">←</button>
                                <button
                                    type="button"
                                    onClick={() => setDispatchDayKey(formatDate(todayUTC()))}
                                    disabled={isTodayKey(dispatchDayKey, todayKey)}
                                    className="hui-btn hui-btn-secondary h-8 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Today
                                </button>
                                <button type="button" onClick={() => setDispatchDayKey(current => shiftDayKey(current, 1))} className="hui-btn hui-btn-secondary h-8 text-sm" aria-label="Next day">→</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
            <AnimatePresence initial={false}>
            {draftCount > 0 && (
                <motion.div
                    key="draft-status"
                    data-motion-scope="status-change"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    role="status"
                    className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-900"
                >
                    <span>{draftCount} unsaved change{draftCount === 1 ? "" : "s"}</span>
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={discardAllDrafts} disabled={isSaving || isDispatchReviewing || isDispatchPublishing} className="hui-btn hui-btn-secondary text-xs disabled:cursor-wait disabled:opacity-60">
                            Discard
                        </button>
                        {boardView !== "dispatch" && (
                            <button type="button" onClick={() => void saveAllDrafts()} disabled={isSaving} className="hui-btn hui-btn-green text-xs disabled:cursor-wait disabled:opacity-60">
                                {isSaving ? "Saving..." : "Save"}
                            </button>
                        )}
                    </div>
                </motion.div>
            )}
            </AnimatePresence>
            {focus !== "dispatch" && (
                <UnscheduledTray
                    projects={data.pipeline.waitingToStart}
                    canEdit={data.canEdit}
                    pendingProjectIds={externallyPendingProjectIds}
                    onMoveProject={scheduleUnscheduledProject}
                />
            )}
            <AnimatePresence initial={false}>
            {(Object.keys(projectRefreshExpectations).length > 0 || awaitingTaskRefreshIds.size > 0 || dispatchReconciliationExpectation) && (
                <motion.div
                    key="refresh-status"
                    data-motion-scope="status-change"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
                    role="status"
                >
                    <span>Refreshing saved {pendingRefreshKinds.join(" and ")} schedule changes...</span>
                    <button type="button" className="font-semibold underline" onClick={() => router.refresh()}>Retry now</button>
                </motion.div>
            )}
            </AnimatePresence>
            <span ref={projectKeyboardSentinelRef} tabIndex={-1} className="sr-only" aria-live="polite" data-project-keyboard-sentinel="true">
                {projectKeyboardEdit ? `Moving project to ${projectKeyboardEdit.targetStart}. Use arrow keys, Enter to save, or Escape to cancel.` : ""}
            </span>
            <span ref={taskKeyboardSentinelRef} tabIndex={-1} className="sr-only" aria-live="polite" data-task-keyboard-sentinel="true">
                {taskKeyboardEdit ? `Keyboard editing ${taskKeyboardEdit.mode}` : ""}
            </span>
            {boardView === "dispatch" ? (
                <DispatchView
                    data={boardData}
                    weather={weather}
                    onActivate={handleBlockActivate}
                    onCreateTask={openTaskCreation}
                    crewDrafts={crewDrafts}
                    onDraftCrewAdd={queueCrewAddition}
                    onDraftCrewRemove={queueCrewRemoval}
                    mode={dispatchMode}
                    onModeChange={selectDispatchMode}
                    weekStart={dispatchWeekStart}
                    dayKey={dispatchDayKey}
                    onNoteSaveStart={handleNoteSaveStart}
                    onNoteSaveSettled={handleNoteSaveSettled}
                />
            ) : boardView === "month" ? (
                <MonthBarsView
                    data={boardData}
                    weather={weather}
                    showIncome={showIncome}
                    showProjectedCo={showProjectedCo}
                    showExpenses={showExpenses}
                    showHours={showHours}
                    pendingProjectIds={combinedPendingProjectIds}
                    pendingTaskIds={EMPTY_PROJECT_IDS}
                    draftProjectIds={draftProjectIds}
                    draftTaskIds={draftTaskIds}
                    isSaving={isSaving}
                    activeTaskKeyboardEdit={taskKeyboardEdit}
                    onTrayProjectDrop={scheduleUnscheduledProject}
                    onCreateTask={openTaskCreation}
                    teamMembers={data.teamMembers ?? []}
                    isAnyDragActive={isAnyDragActive}
                    activeProjectKeyboardId={projectKeyboardEdit?.projectId ?? null}
                    onProjectActivate={handleProjectActivate}
                    onProjectPointerEditStart={handleProjectPointerEditStart}
                    onProjectKeyboardStart={handleProjectKeyboardStart}
                    onProjectKeyboardAdjust={handleProjectKeyboardAdjust}
                    onProjectKeyboardCommit={handleProjectKeyboardCommit}
                    onProjectKeyboardCancel={handleProjectKeyboardCancel}
                    onProjectMoveCommit={handleProjectMoveCommit}
                    onProjectEndResizeStart={handleProjectEndResizeStart}
                    onTaskPointerEditStart={handleTaskPointerEditStart}
                    onTaskKeyboardStart={handleTaskKeyboardStart}
                    onTaskKeyboardAdjust={handleTaskKeyboardAdjust}
                    onTaskKeyboardCommit={handleTaskKeyboardCommit}
                    onTaskKeyboardCancel={handleTaskKeyboardCancel}
                    onTaskDatesCommit={handleTaskDatesCommit}
                    onTaskMoveBy={handleTaskMoveBy}
                    onActivate={handleBlockActivate}
                />
            ) : (
                <TimelineView
                    data={boardData}
                    weather={weather}
                    showIncome={showIncome}
                    showProjectedCo={showProjectedCo}
                    showExpenses={showExpenses}
                    showHours={showHours}
                    pendingProjectIds={combinedPendingProjectIds}
                    pendingTaskIds={EMPTY_PROJECT_IDS}
                    draftProjectIds={draftProjectIds}
                    draftTaskIds={draftTaskIds}
                    isSaving={isSaving}
                    activeTaskKeyboardEdit={taskKeyboardEdit}
                    onTrayProjectDrop={scheduleUnscheduledProject}
                    onCreateTask={openTaskCreation}
                    groupByCrew={groupByCrew}
                    onToggleGroupByCrew={() => setGroupByCrewMode(!groupByCrew)}
                    scrollToTodayNonce={scrollToTodayNonce}
                    teamMembers={data.teamMembers ?? []}
                    isAnyDragActive={isAnyDragActive}
                    activeProjectKeyboardId={projectKeyboardEdit?.projectId ?? null}
                    onProjectActivate={handleProjectActivate}
                    onProjectPointerEditStart={handleProjectPointerEditStart}
                    onProjectKeyboardStart={handleProjectKeyboardStart}
                    onProjectKeyboardAdjust={handleProjectKeyboardAdjust}
                    onProjectKeyboardCommit={handleProjectKeyboardCommit}
                    onProjectKeyboardCancel={handleProjectKeyboardCancel}
                    onProjectMoveCommit={handleProjectMoveCommit}
                    onProjectEndResizeStart={handleProjectEndResizeStart}
                    onTaskPointerEditStart={handleTaskPointerEditStart}
                    onTaskKeyboardStart={handleTaskKeyboardStart}
                    onTaskKeyboardAdjust={handleTaskKeyboardAdjust}
                    onTaskKeyboardCommit={handleTaskKeyboardCommit}
                    onTaskKeyboardCancel={handleTaskKeyboardCancel}
                    onTaskDatesCommit={handleTaskDatesCommit}
                    onTaskMoveBy={handleTaskMoveBy}
                    onActivate={handleBlockActivate}
                />
            )}
            {focus !== "dispatch" && boardView !== "dispatch" && data.canEdit && <AvailabilityPanel data={data} onDrillDown={drillDownToCrewTimeline} />}
            <ShiftConfirmDialog
                intent={confirmIntent}
                isPending={false}
                onChoice={handleMoveChoice}
                onCancel={cancelConfirmedMove}
            />
            <DispatchReviewDialog
                result={dispatchReview?.preview ?? null}
                published={dispatchReview?.published ?? false}
                isPending={isDispatchPublishing}
                conflictTargetIds={dispatchConflictTargetIds}
                taskNamesById={dispatchTaskNamesById}
                memberNamesById={dispatchMemberNamesById}
                tasks={dispatchReviewTasks}
                onConfirm={() => void publishDispatchDrafts()}
                onClose={() => setDispatchReview(null)}
            />
            <BoardTaskDrawer
                taskId={openTaskId}
                hasDraft={openTaskHasDraft}
                hasCrewDraft={openTaskHasCrewDraft}
                teamMembers={data.teamMembers ?? []}
                onClose={closeTaskDrawer}
                onSelectTask={selectDrawerTask}
                onDeleted={handleDrawerTaskDeleted}
            />
            <BoardProjectDrawer
                project={openProject}
                teamMembers={data.teamMembers ?? []}
                isPending={Boolean(openProject && (isSaving || combinedPendingProjectIds.has(openProject.id)))}
                onMoveCommit={handleProjectMoveCommit}
                onClose={closeProjectDrawer}
            />
            <TaskCreationDialog
                open={taskCreationOpen}
                onClose={() => setTaskCreationOpen(false)}
                defaultProjectId={taskCreationDefaults.defaultProjectId}
                lockProject={taskCreationDefaults.lockProject}
                defaultStartDate={taskCreationDefaults.defaultStartDate}
                defaultCrewIds={taskCreationDefaults.defaultCrewIds}
                defaultName={taskCreationDefaults.defaultName}
                defaultEstimatedHours={taskCreationDefaults.defaultEstimatedHours}
                estimateItemId={taskCreationDefaults.estimateItemId}
                projects={activeProjectOptions}
            />
        </div>
        </MotionConfig>
    );
}
