"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import type { CompanyDashboardData, DashboardProjectRow, DashboardTaskRow } from "@/lib/schedule-core";
import type { VancouverForecastDay } from "@/lib/weather";
import { addDays, formatDate, getFallbackProjectColor, todayUTC } from "@/app/projects/[id]/schedule/schedule-utils";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { isConflictedDay } from "./availability";
import { isTaskActiveOnDay } from "./dispatch-exceptions";
import { isDispatchable } from "@/lib/dispatch-roster";
import { DispatchExceptions } from "./DispatchExceptions";
import { DispatchCrewTaskChooser, type DispatchCrewTaskChoice } from "./DispatchCrewTaskChooser";
import { DispatchDayView } from "./DispatchDayView";
import { disambiguateMemberNames } from "./dispatch-day-rows";
import { DispatchTaskBank, type DispatchTaskBankItem } from "./DispatchTaskBank";
import { createDragVisualLayer, crewChipDragSourceSelector, type DragVisualLayer } from "./dragVisualLayer";

export type DispatchMode = "today" | "week";
export const DISPATCH_MODE_STORAGE_KEY = "gtr-company-schedule-dispatch-mode";

export interface DispatchTaskCreationDefaults {
    defaultProjectId?: string;
    lockProject?: boolean;
    defaultStartDate: string;
    defaultCrewIds?: string[];
    defaultName?: string;
    defaultEstimatedHours?: number | null;
    estimateItemId?: string;
}

interface DispatchViewProps {
    data: CompanyDashboardData;
    weather: VancouverForecastDay[];
    onActivate: (taskId: string) => void;
    onCreateTask: (defaults: DispatchTaskCreationDefaults) => void;
    crewDrafts: Readonly<Record<string, { addUserIds: string[]; removeUserIds: string[] }>>;
    onDraftCrewAdd: (taskId: string, userId: string) => boolean;
    onDraftCrewRemove: (taskId: string, userId: string) => void;
    // Day-list note saves (DispatchDayView) write straight to the DB outside
    // of drafts, which bumps the task's revision independently. These let
    // ScheduleBoard track that: disable Review dispatch while a save is in
    // flight, and record the settled revision immediately (rather than
    // waiting on the refresh poll) so a Review opened right after a note
    // save doesn't compare against a just-stale expectedUpdatedAt.
    onNoteSaveStart: (taskId: string) => void;
    onNoteSaveSettled: (taskId: string, result: { updatedAt: string } | null) => void;
    // Day|Week range — owned by ScheduleBoard so the header row (which shows
    // the day/week-nav controls in the same slot as Prev/Today/Next, and the
    // date label in the title) can read/drive them too.
    mode: DispatchMode;
    onModeChange: (mode: DispatchMode) => void;
    weekStart: Date;
    // The Day lens's selected day (YYYY-MM-DD) — defaults to today but can be
    // paged with the header's ←/Today/→ nav. Drives active-task filtering,
    // the Available bench, staffing, job cards, and task-creation defaults.
    // Independent of `mode`, whose "today" value just picks the single-day
    // (vs. weekly matrix) layout.
    dayKey: string;
}

interface WeekChip {
    project: DashboardProjectRow;
    task: DashboardTaskRow;
    solid: boolean;
    lead: boolean;
}

type MemberDaySegment = "assigned" | "conflict" | "free";

interface MemberDayCell {
    chips: WeekChip[];
    shownChips: WeekChip[];
    overflow: number;
    hasSolid: boolean;
    isFree: boolean;
    isSoftOnly: boolean;
    conflicted: boolean;
    segment: MemberDaySegment;
}

interface CrewIdentity {
    id: string;
    name: string;
}

interface CrewChooserState {
    crew: CrewIdentity;
    choices: DispatchCrewTaskChoice[];
    anchorPoint: { x: number; y: number } | null;
}

const CREW_MOUSE_DRAG_THRESHOLD_PX = 5;
const CREW_TOUCH_DRAG_THRESHOLD_PX = 8;

function dayLabel(day: Date): string {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(day);
}

function taskLabel(task: DashboardTaskRow): string {
    if (task.type === "milestone") return `\u25C6 ${task.name}`;
    if (task.type === "appointment") return `\u{1F550}${task.scheduledTime ? ` ${task.scheduledTime}` : ""} ${task.name}`;
    return task.name;
}

function weekChipsForMember(projects: DashboardProjectRow[], memberId: string, dayKey: string): WeekChip[] {
    const chips: WeekChip[] = [];
    for (const project of projects) {
        const isProjectCrew = project.crew.some(member => member.id === memberId && isDispatchable(member));
        for (const task of project.tasks) {
            if (!isTaskActiveOnDay(task, dayKey)) continue;
            const assignment = task.assignments.find(candidate => candidate.userId === memberId && candidate.status === "ACTIVATED");
            if (!assignment && !isProjectCrew) continue;
            chips.push({ project, task, solid: Boolean(assignment), lead: assignment?.assignmentRole === "lead" });
        }
    }
    return chips;
}

// Chips are the only way to open a task from the grid, so the cap is a safety valve
// for pathological days, not a design limit: four solid assignments in one day is rare.
export const WEEK_CELL_MAX_CHIPS = 4;

export interface VisibleWeekChips {
    chips: WeekChip[];
    overflow: number;
}

/**
 * Filters a cell's chips down to just the solid (task-assigned) ones, capped at
 * WEEK_CELL_MAX_CHIPS with the rest folded into an overflow count. Soft (job-crew-only)
 * chips are never rendered in the grid — they're the noise this exists to cut.
 */
export function visibleWeekChips(chips: WeekChip[]): VisibleWeekChips {
    const solid = chips.filter(chip => chip.solid);
    return {
        chips: solid.slice(0, WEEK_CELL_MAX_CHIPS),
        overflow: Math.max(0, solid.length - WEEK_CELL_MAX_CHIPS),
    };
}

function taskChoicesForDay(projects: DashboardProjectRow[], dayKey: string): DispatchCrewTaskChoice[] {
    return projects.flatMap(project => project.tasks
        .filter(task => isTaskActiveOnDay(task, dayKey))
        .map(task => ({
            projectId: project.id,
            projectName: project.name,
            taskId: task.id,
            taskName: task.name,
            dayLabel: dayKey,
        })));
}

export function DispatchView({
    data,
    weather,
    onActivate,
    onCreateTask,
    crewDrafts,
    onDraftCrewAdd,
    onDraftCrewRemove,
    mode,
    onModeChange,
    weekStart,
    dayKey,
    onNoteSaveStart,
    onNoteSaveSettled,
}: DispatchViewProps) {
    const [highlightedProjectId, setHighlightedProjectId] = useState<string | null>(null);
    const [taskBankProjectId, setTaskBankProjectId] = useState(
        () => data.pipeline.inProgress[0]?.id
            ?? data.pipeline.scheduled[0]?.id
            ?? data.pipeline.waitingToStart[0]?.id
            ?? data.pipeline.substantialCompletion[0]?.id
            ?? "",
    );
    const [crewChooser, setCrewChooser] = useState<CrewChooserState | null>(null);
    const crewChooserAnchorRef = useRef<HTMLElement | null>(null);
    const activeCrewDragCleanupRef = useRef<(() => void) | null>(null);

    const projects = useMemo(() => [
        ...data.pipeline.waitingToStart,
        ...data.pipeline.scheduled,
        ...data.pipeline.inProgress,
        ...data.pipeline.substantialCompletion,
    ], [data.pipeline]);

    useEffect(() => () => activeCrewDragCleanupRef.current?.(), []);

    // Real "today" — distinct from `dayKey` (the selected Day-lens date) —
    // used only to decide whether the selected day IS today (e.g. the
    // Exceptions strip's "Unstaffed today" vs. "Unstaffed" label).
    const trueTodayKey = formatDate(todayUTC());
    const weatherByDate = new Map(weather.map(forecast => [forecast.date, forecast]));
    // Two accounts can share a display name (e.g. two "Justin Adkins") —
    // disambiguate over the FULL team pool (not just today's dispatchable
    // subset) so the label is stable regardless of who happens to be
    // dispatchable today, then carry it onto the roster the Day list and
    // popover read from.
    const memberLabelsById = useMemo(() => disambiguateMemberNames(data.teamMembers ?? []), [data.teamMembers]);
    const roster = useMemo(() => (data.teamMembers ?? [])
        .filter(isDispatchable)
        .map(member => ({ ...member, name: memberLabelsById.get(member.id) ?? member.name })),
        [data.teamMembers, memberLabelsById]);
    // Day mode's plain list needs names for people who show up as a drafted
    // addition but aren't (yet) on the project's crew — union the full
    // company roster (already-disambiguated names) with every name already
    // carried on an assignment, roster winning so an assigned duplicate
    // Justin Adkins reads disambiguated too (dispatch-day-rows.ts prefers
    // this map over the raw assignment name).
    const memberNamesById = useMemo(() => new Map<string, string>([
        ...projects.flatMap(project => project.tasks.flatMap(task => task.assignments.map(a => [a.userId, a.name] as const))),
        ...roster.map(member => [member.id, member.name] as const),
    ]), [roster, projects]);
    const memberEmailsById = useMemo(() => new Map<string, string>(roster.map(member => [member.id, member.email])), [roster]);

    // Memoized so the day arrays hold a stable reference across re-renders
    // (they only actually change when the week or the weekend-visibility
    // inputs change) — the member×day chip matrix below is keyed on
    // visibleWeekDays, and an unstable array reference there would defeat the
    // memoization by invalidating it on every render.
    const mondayToFriday = useMemo(() => Array.from({ length: 5 }, (_, index) => addDays(weekStart, index)), [weekStart]);
    const saturday = useMemo(() => addDays(weekStart, 5), [weekStart]);
    const sunday = useMemo(() => addDays(weekStart, 6), [weekStart]);
    const showSaturday = projects.some(project => project.tasks.some(task => isTaskActiveOnDay(task, formatDate(saturday))));
    const showSunday = projects.some(project => project.tasks.some(task => isTaskActiveOnDay(task, formatDate(sunday))));
    const visibleWeekDays = useMemo(
        () => [...mondayToFriday, ...(showSaturday ? [saturday] : []), ...(showSunday ? [sunday] : [])],
        [mondayToFriday, saturday, sunday, showSaturday, showSunday],
    );
    const selectedTaskBankProjectId = projects.some(project => project.id === taskBankProjectId)
        ? taskBankProjectId
        : data.pipeline.inProgress[0]?.id ?? projects[0]?.id ?? "";
    const taskBankRefreshKey = projects.reduce((sum, project) => sum + project.tasks.length, 0);
    const crewConflicts = data.crewConflicts;
    // Member×day chip matrix — one weekChipsForMember scan per member/day
    // instead of the two-to-three redundant scans the cell + summary bar
    // used to run independently, so keystrokes elsewhere (search, filters)
    // that re-render this view don't rescan every project per cell.
    const memberDayMatrix = useMemo(() => {
        const matrix = new Map<string, Map<string, MemberDayCell>>();
        for (const member of roster) {
            const byDay = new Map<string, MemberDayCell>();
            for (const day of visibleWeekDays) {
                const dayKey = formatDate(day);
                const chips = weekChipsForMember(projects, member.id, dayKey);
                const { chips: shownChips, overflow } = visibleWeekChips(chips);
                const hasSolid = shownChips.length > 0;
                const isFree = chips.length === 0;
                const isSoftOnly = !hasSolid && !isFree;
                const conflicted = isConflictedDay(crewConflicts, member.id, dayKey, true);
                const segment: MemberDaySegment = conflicted ? "conflict" : chips.some(chip => chip.solid) ? "assigned" : "free";
                byDay.set(dayKey, { chips, shownChips, overflow, hasSolid, isFree, isSoftOnly, conflicted, segment });
            }
            matrix.set(member.id, byDay);
        }
        return matrix;
    }, [projects, visibleWeekDays, roster, crewConflicts]);
    const headerForecast = mode === "today"
        ? weatherByDate.get(dayKey)
        : visibleWeekDays
            .map(day => weatherByDate.get(formatDate(day)))
            .find((forecast): forecast is VancouverForecastDay => Boolean(forecast));

    useEffect(() => {
        if (!highlightedProjectId || mode !== "today") return;
        const frame = window.requestAnimationFrame(() => {
            document.getElementById(`dispatch-project-${highlightedProjectId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        const timeout = window.setTimeout(() => setHighlightedProjectId(null), 1_800);
        return () => {
            window.cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
        };
    }, [highlightedProjectId, mode]);

    function focusProject(projectId: string) {
        onModeChange("today");
        setHighlightedProjectId(projectId);
    }

    function openCrewChooser(
        crew: CrewIdentity,
        choices: DispatchCrewTaskChoice[],
        anchorElement: HTMLElement | null,
        anchorPoint: { x: number; y: number } | null,
    ) {
        crewChooserAnchorRef.current = anchorElement;
        setCrewChooser({ crew, choices, anchorPoint });
    }

    function closeCrewChooser() {
        setCrewChooser(null);
        crewChooserAnchorRef.current = null;
    }

    function applyCrewChoice(taskId: string) {
        if (!crewChooser) return;
        const added = onDraftCrewAdd(taskId, crewChooser.crew.id);
        if (added) closeCrewChooser();
    }

    function resolveCrewDrop(crew: CrewIdentity, clientX: number, clientY: number) {
        const elements = document.elementsFromPoint(clientX, clientY);
        const taskTarget = elements
            .map(element => element instanceof HTMLElement ? element.closest<HTMLElement>("[data-dispatch-task-id]") : null)
            .find((element): element is HTMLElement => Boolean(element));
        const directTaskId = taskTarget?.dataset.dispatchTaskId;
        if (directTaskId) {
            onDraftCrewAdd(directTaskId, crew.id);
            return;
        }

        const weekCell = elements
            .map(element => element instanceof HTMLElement ? element.closest<HTMLElement>("[data-dispatch-week-cell]") : null)
            .find((element): element is HTMLElement => Boolean(element));
        if (!weekCell) {
            toast.info("Drop crew onto a task or a Week day cell.");
            return;
        }
        if (weekCell.dataset.dispatchMemberId !== crew.id) {
            toast.info(`Drop ${crew.name} on ${crew.name}'s own Week row.`);
            return;
        }
        const dayKey = weekCell.dataset.dispatchDay;
        if (!dayKey) return;
        const choices = taskChoicesForDay(projects, dayKey);
        if (choices.length === 1) {
            onDraftCrewAdd(choices[0].taskId, crew.id);
        } else {
            openCrewChooser(crew, choices, null, { x: clientX, y: clientY });
        }
    }

    function handleCrewPointerDragStart(event: ReactPointerEvent<HTMLElement>, crew: CrewIdentity) {
        if (!data.canEdit || event.button !== 0) return;
        activeCrewDragCleanupRef.current?.();
        const sourceElement = event.currentTarget;
        const pointerId = event.pointerId;
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        const threshold = event.pointerType === "touch" ? CREW_TOUCH_DRAG_THRESHOLD_PX : CREW_MOUSE_DRAG_THRESHOLD_PX;
        let dragVisual: DragVisualLayer | null = null;
        let lastClientX = startClientX;
        let lastClientY = startClientY;
        let cleaned = false;

        sourceElement.setPointerCapture?.(pointerId);

        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            dragVisual?.cleanup();
            if (sourceElement.hasPointerCapture?.(pointerId)) sourceElement.releasePointerCapture(pointerId);
            window.removeEventListener("pointermove", onWindowPointerMove);
            window.removeEventListener("pointerup", onWindowPointerUp);
            window.removeEventListener("pointercancel", onWindowPointerCancel);
            window.removeEventListener("keydown", onWindowKeyDown);
            if (activeCrewDragCleanupRef.current === cleanup) activeCrewDragCleanupRef.current = null;
        }

        function onWindowPointerMove(moveEvent: PointerEvent) {
            if (moveEvent.pointerId !== pointerId) return;
            lastClientX = moveEvent.clientX;
            lastClientY = moveEvent.clientY;
            if (!dragVisual && Math.hypot(lastClientX - startClientX, lastClientY - startClientY) >= threshold) {
                dragVisual = createDragVisualLayer({
                    sourceElement,
                    sourceSelector: crewChipDragSourceSelector(crew.id),
                    kind: "crew-chip",
                    startClientX,
                    startClientY,
                });
            }
            if (!dragVisual) return;
            moveEvent.preventDefault();
            dragVisual.update({ clientX: lastClientX, clientY: lastClientY, label: crew.name });
        }

        function onWindowPointerUp(upEvent: PointerEvent) {
            if (upEvent.pointerId !== pointerId) return;
            const didDrag = Boolean(dragVisual);
            lastClientX = upEvent.clientX;
            lastClientY = upEvent.clientY;
            if (didDrag) upEvent.preventDefault();
            cleanup();
            if (didDrag) resolveCrewDrop(crew, lastClientX, lastClientY);
        }

        function onWindowPointerCancel(cancelEvent: PointerEvent) {
            if (cancelEvent.pointerId === pointerId) cleanup();
        }

        function onWindowKeyDown(keyEvent: KeyboardEvent) {
            if (keyEvent.key !== "Escape") return;
            keyEvent.preventDefault();
            cleanup();
        }

        window.addEventListener("pointermove", onWindowPointerMove, { passive: false });
        window.addEventListener("pointerup", onWindowPointerUp);
        window.addEventListener("pointercancel", onWindowPointerCancel);
        window.addEventListener("keydown", onWindowKeyDown);
        activeCrewDragCleanupRef.current = cleanup;
    }

    function handleCrewKeyboardActivate(event: ReactKeyboardEvent<HTMLElement>, crew: CrewIdentity) {
        if (!data.canEdit || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        const choices = mode === "today"
            ? taskChoicesForDay(projects, dayKey)
            : visibleWeekDays.flatMap(day => taskChoicesForDay(projects, formatDate(day)));
        openCrewChooser(crew, choices, event.currentTarget, null);
    }

    function scheduleTaskBankItem(item: DispatchTaskBankItem) {
        onCreateTask({
            defaultProjectId: selectedTaskBankProjectId,
            lockProject: true,
            defaultStartDate: dayKey,
            defaultName: item.name,
            defaultEstimatedHours: item.estimatedHours,
            estimateItemId: item.estimateItemId,
        });
    }

    return (
        <div className="min-w-0">
            {mode === "week" && (
                <DispatchExceptions
                    projects={projects}
                    crewConflicts={data.crewConflicts}
                    dayKey={dayKey}
                    isToday={dayKey === trueTodayKey}
                    onActivate={onActivate}
                    onProjectFocus={focusProject}
                />
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hui-border px-4 py-2.5">
                {mode === "week" ? (
                    <p className="text-xs text-hui-textMuted">
                        {headerForecast ? `Vancouver: ${headerForecast.precipitationProbability}% rain · ${headerForecast.high}°/${headerForecast.low}°` : "Vancouver forecast unavailable"}
                        {"  ·  Jobs first today, people across the week."}
                    </p>
                ) : <span />}
                <div className="flex flex-wrap items-center gap-2">
                    <SegmentedControl
                        ariaLabel="Dispatch range"
                        value={mode}
                        onChange={onModeChange}
                        options={[
                            { value: "today", label: "Day" },
                            { value: "week", label: "Week" },
                        ]}
                    />
                    <Link href="/company-dashboard/staging" className="hui-btn hui-btn-secondary text-xs h-8 inline-flex items-center gap-1.5">
                        <Package className="h-3.5 w-3.5" aria-hidden="true" />
                        Staging queue
                    </Link>
                </div>
            </div>

            <div className="min-w-0 xl:flex">
            <div className="min-w-0 flex-1">
            {mode === "today" ? (
                <DispatchDayView
                    dayProjects={data.pipeline.inProgress}
                    allProjects={projects}
                    dayKey={dayKey}
                    roster={roster}
                    crewDrafts={crewDrafts}
                    memberNamesById={memberNamesById}
                    memberEmailsById={memberEmailsById}
                    canEdit={data.canEdit}
                    highlightedProjectId={highlightedProjectId}
                    onActivate={onActivate}
                    onCreateTask={onCreateTask}
                    onDraftCrewAdd={onDraftCrewAdd}
                    onDraftCrewRemove={onDraftCrewRemove}
                    onCrewPointerDown={handleCrewPointerDragStart}
                    onCrewKeyboardActivate={handleCrewKeyboardActivate}
                    onNoteSaveStart={onNoteSaveStart}
                    onNoteSaveSettled={onNoteSaveSettled}
                />
            ) : (
                <div className="p-4">
                    <div className="max-w-full overflow-x-auto rounded-lg border border-hui-border">
                        <div
                            role="table"
                            aria-label="Weekly crew dispatch"
                            style={{ minWidth: 290 + visibleWeekDays.length * 150 }}
                        >
                            <div className="grid bg-slate-50" role="row" style={{ gridTemplateColumns: `180px repeat(${visibleWeekDays.length}, minmax(140px, 1fr)) 110px` }}>
                                <div role="columnheader" className="border-b border-r border-hui-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Crew</div>
                                {visibleWeekDays.map(day => {
                                    const dayKey = formatDate(day);
                                    const forecast = weatherByDate.get(dayKey);
                                    return (
                                        <div key={dayKey} role="columnheader" className="border-b border-r border-hui-border px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                            <div>{dayLabel(day)}</div>
                                            {forecast && <div className="mt-0.5 normal-case tracking-normal text-slate-600">{forecast.glyph} {forecast.precipitationProbability}% {forecast.high}{"\u00B0"}</div>}
                                        </div>
                                    );
                                })}
                                <div role="columnheader" className="border-b border-hui-border px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">Assigned</div>
                            </div>

                            {roster.length === 0 ? (
                                <p className="px-4 py-8 text-center text-sm text-hui-textMuted">No field crew to dispatch.</p>
                            ) : roster.map(member => {
                                const weekdaySegments = mondayToFriday.map(day => (
                                    memberDayMatrix.get(member.id)?.get(formatDate(day))?.segment ?? "free"
                                ));
                                // A conflict day is still an assigned day (double-booked, not idle) —
                                // it just also carries a double-booking, called out separately below.
                                const weekdayAssignedCount = weekdaySegments.filter(segment => segment === "assigned" || segment === "conflict").length;
                                const weekdayConflictCount = weekdaySegments.filter(segment => segment === "conflict").length;
                                return (
                                    <div key={member.id} className="grid" role="row" style={{ gridTemplateColumns: `180px repeat(${visibleWeekDays.length}, minmax(140px, 1fr)) 110px` }}>
                                        <div role="rowheader" className="border-b border-r border-hui-border bg-white px-3 py-3 text-xs font-semibold text-hui-textMain">
                                            <button
                                                type="button"
                                                data-dispatch-crew-chip="true"
                                                data-dispatch-user-id={member.id}
                                                onPointerDown={event => handleCrewPointerDragStart(event, member)}
                                                onKeyDown={event => handleCrewKeyboardActivate(event, member)}
                                                className="touch-none rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                                title={`Drag ${member.name} to a Week day, or press Enter to choose a task`}
                                            >
                                                {member.name}
                                            </button>
                                        </div>
                                        {visibleWeekDays.map(day => {
                                            const dayKey = formatDate(day);
                                            const cell = memberDayMatrix.get(member.id)?.get(dayKey);
                                            const chips = cell?.chips ?? [];
                                            const shownChips = cell?.shownChips ?? [];
                                            const overflow = cell?.overflow ?? 0;
                                            const hasSolid = cell?.hasSolid ?? false;
                                            const isFree = cell?.isFree ?? true;
                                            const isSoftOnly = cell?.isSoftOnly ?? false;
                                            const softOnlyLabel = `On job crew for ${chips.length} job${chips.length === 1 ? "" : "s"}, no task yet`;
                                            const conflicted = cell?.conflicted ?? false;
                                            return (
                                                <div
                                                    key={`${member.id}-${dayKey}`}
                                                    role="cell"
                                                    data-dispatch-week-cell="true"
                                                    data-dispatch-member-id={member.id}
                                                    data-dispatch-day={dayKey}
                                                    title={isSoftOnly ? softOnlyLabel : isFree ? "Free" : undefined}
                                                    aria-label={isSoftOnly ? softOnlyLabel : isFree ? "Free" : undefined}
                                                    className="min-h-16 border-b border-r border-hui-border bg-white p-1.5"
                                                >
                                                    <div
                                                        className={`relative flex min-h-12 flex-col gap-1 rounded ${conflicted ? "ring-2 ring-red-500 ring-inset" : ""}`}
                                                    >
                                                        {isSoftOnly && (
                                                            <span aria-hidden="true" className="pointer-events-none absolute left-0.5 top-0.5 text-[10px] leading-none text-slate-300">
                                                                {"\u00b7"}
                                                            </span>
                                                        )}
                                                        {shownChips.map(chip => {
                                                            const color = chip.project.color || getFallbackProjectColor(chip.project.id);
                                                            return (
                                                                <button
                                                                    key={chip.task.id}
                                                                    type="button"
                                                                    data-dispatch-task-id={chip.task.id}
                                                                    onClick={() => onActivate(chip.task.id)}
                                                                    title={`${chip.project.name} \u2014 ${taskLabel(chip.task)}`}
                                                                    className="block truncate rounded px-1.5 py-1 text-left text-[11px] font-semibold leading-tight text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                                                    style={{ backgroundColor: color }}
                                                                >
                                                                    {chip.lead ? "\u2605 " : ""}{chip.project.name}
                                                                </button>
                                                            );
                                                        })}
                                                        {overflow > 0 && (
                                                            <span
                                                                className="block truncate rounded border-2 border-dashed border-slate-300 px-1.5 py-1 text-left text-[11px] font-semibold leading-tight text-slate-400"
                                                                title={`${overflow} more job${overflow === 1 ? "" : "s"}`}
                                                            >
                                                                +{overflow}
                                                            </span>
                                                        )}
                                                        {!hasSolid && data.canEdit && (
                                                            <button
                                                                type="button"
                                                                onClick={() => onCreateTask({ defaultStartDate: dayKey, defaultCrewIds: [member.id] })}
                                                                className="min-h-12 rounded border border-dashed border-transparent text-[10px] text-slate-300 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-500 focus-visible:border-hui-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hui-primary"
                                                                aria-label={`Create task for ${member.name} on ${dayKey}`}
                                                            >
                                                                + Task
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        <div
                                            role="cell"
                                            className="border-b border-hui-border bg-white px-2 py-3"
                                            title={`${weekdayAssignedCount} of 5 days assigned${weekdayConflictCount > 0 ? `, ${weekdayConflictCount} double-booked` : ""}`}
                                        >
                                            <div className="flex items-center justify-center gap-0.5" aria-hidden="true">
                                                {weekdaySegments.map((segment, index) => (
                                                    <span
                                                        key={index}
                                                        className={`h-1.5 w-4 rounded-full ${segment === "assigned" ? "bg-green-500" : segment === "conflict" ? "bg-red-500" : "bg-slate-200"}`}
                                                    />
                                                ))}
                                            </div>
                                            <span className="sr-only">{weekdayAssignedCount} of 5 days assigned{weekdayConflictCount > 0 ? `, ${weekdayConflictCount} double-booked` : ""}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
            </div>
            {mode === "week" && (
                <DispatchTaskBank
                    projects={projects.map(project => ({ id: project.id, name: project.name, taskCount: project.taskCount }))}
                    selectedProjectId={selectedTaskBankProjectId}
                    refreshKey={taskBankRefreshKey}
                    canSchedule={data.canEdit}
                    onProjectChange={setTaskBankProjectId}
                    onSchedule={scheduleTaskBankItem}
                />
            )}
            </div>
            <DispatchCrewTaskChooser
                open={Boolean(crewChooser)}
                crewName={crewChooser?.crew.name ?? ""}
                choices={crewChooser?.choices ?? []}
                anchorPoint={crewChooser?.anchorPoint ?? null}
                anchorRef={crewChooserAnchorRef}
                onChoose={applyCrewChoice}
                onClose={closeCrewChooser}
            />
        </div>
    );
}
