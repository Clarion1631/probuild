import type { CalendarOverlays, DashboardProjectRow, DashboardTaskRow, OverlayIncomeItem, PersistedScheduleTaskDate } from "@/lib/schedule-core";
import { addDays, formatDate, getDaysBetween, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";

export interface DateRange {
    start: Date;
    end: Date;
}

export interface WeekSegment {
    projectId: string;
    weekIndex: number;
    startColumn: number;
    spanDays: number;
    continuesBefore: boolean;
    continuesAfter: boolean;
    lane: number;
}

export interface TimelineRect {
    left: number;
    width: number;
}

export type UnlanedWeekSegment = Omit<WeekSegment, "lane">;

export interface MilestoneHost extends WeekSegment {
    dateKey: string;
}

export interface MonthProjectLaneLayout {
    visibleWork: WeekSegment[];
    visibleMilestoneHosts: MilestoneHost[];
    hiddenProjectIdsByWeek: Map<number, string[]>;
}

export interface ProjectDropIntent {
    project: DashboardProjectRow;
    originalStart: string;
    targetStart: string;
    deltaDays: number;
}

export type TaskEditMode = "move" | "resize-left" | "resize-right";

export interface TaskDateOverride {
    startDate: string;
    endDate: string;
}

export type PersistedTaskDate = PersistedScheduleTaskDate;

export interface ProjectRefreshExpectation {
    projectStartDate?: string | null;
    taskDates: PersistedTaskDate[];
}

function toUTCDay(date: Date): Date {
    return parseUTCDate(formatDate(date));
}

function parseSerializedUTCDay(value: string): Date {
    return parseUTCDate(value.slice(0, 10));
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
    return a.start < b.end && b.start < a.end;
}

export function getEffectiveProjectRange(project: DashboardProjectRow): DateRange | null {
    const taskRanges = project.tasks
        .filter(task => task.type !== "milestone")
        .map(task => ({
            start: parseSerializedUTCDay(task.startDate),
            end: parseSerializedUTCDay(task.endDate),
        }))
        .filter(range => range.end > range.start);

    const earliestTaskStart = taskRanges.reduce<Date | null>(
        (earliest, range) => !earliest || range.start < earliest ? range.start : earliest,
        null,
    );
    // A marker-only start move (In Progress) leaves tasks in place, so the
    // marker can sit AFTER existing work — the bar must still cover those
    // tasks or they'd clip out of both views. Span from the earliest of
    // marker/first-task to the latest task end.
    const markerStart = project.startDate ? parseSerializedUTCDay(project.startDate) : null;
    const start = markerStart && earliestTaskStart
        ? (earliestTaskStart < markerStart ? earliestTaskStart : markerStart)
        : (markerStart ?? earliestTaskStart);
    if (!start) return null;

    const latestTaskEnd = taskRanges.reduce<Date | null>(
        (latest, range) => range.end > start && (!latest || range.end > latest) ? range.end : latest,
        null,
    );
    // The marker day itself must stay visible even when it sits beyond the
    // last task (end-exclusive, so marker + 1 day).
    const markerEnd = markerStart ? addDays(markerStart, 1) : null;
    const end = [latestTaskEnd, markerEnd].reduce<Date | null>(
        (latest, candidate) => candidate && (!latest || candidate > latest) ? candidate : latest,
        null,
    );
    return { start, end: end ?? addDays(start, 1) };
}

export function createProjectDropIntent(project: DashboardProjectRow, targetStart: string): ProjectDropIntent | null {
    const range = getEffectiveProjectRange(project);
    if (!range) return null;

    const normalizedTarget = formatDate(parseSerializedUTCDay(targetStart));
    const originalStart = formatDate(range.start);
    return {
        project,
        originalStart,
        targetStart: normalizedTarget,
        deltaDays: getDaysBetween(range.start, parseSerializedUTCDay(normalizedTarget)),
    };
}

export function previewProjectMove(project: DashboardProjectRow, targetStart: string): DashboardProjectRow {
    const normalizedTarget = formatDate(parseSerializedUTCDay(targetStart));
    if (!project.startDate) return { ...project, startDate: normalizedTarget };

    const range = getEffectiveProjectRange(project);
    if (!range) return { ...project, startDate: normalizedTarget };

    const deltaDays = getDaysBetween(range.start, parseSerializedUTCDay(normalizedTarget));
    return {
        ...project,
        startDate: normalizedTarget,
        tasks: project.tasks.map(task => ({
            ...task,
            startDate: formatDate(addDays(parseSerializedUTCDay(task.startDate), deltaDays)),
            endDate: formatDate(addDays(parseSerializedUTCDay(task.endDate), deltaDays)),
        })),
    };
}

export function previewProjectWithPersistedTaskDates(
    project: DashboardProjectRow,
    projectStartDate: string | null,
    taskDates: PersistedTaskDate[],
): DashboardProjectRow {
    const taskDatesById = new Map(taskDates.map(task => [task.id, task]));
    return {
        ...project,
        startDate: projectStartDate,
        tasks: project.tasks.map(task => {
            const persisted = taskDatesById.get(task.id);
            return persisted ? { ...task, startDate: persisted.startDate, endDate: persisted.endDate } : task;
        }),
    };
}

export function previewTaskDates(
    task: DashboardTaskRow,
    mode: TaskEditMode,
    deltaDays: number,
): TaskDateOverride | null {
    const originalStart = parseSerializedUTCDay(task.startDate);
    const originalEnd = parseSerializedUTCDay(task.endDate);
    const milestone = task.type === "milestone";

    if (milestone) {
        if (mode !== "move") return null;
        const movedDate = formatDate(addDays(originalStart, deltaDays));
        return { startDate: movedDate, endDate: movedDate };
    }
    if (originalEnd <= originalStart) return null;

    if (mode === "move") {
        return {
            startDate: formatDate(addDays(originalStart, deltaDays)),
            endDate: formatDate(addDays(originalEnd, deltaDays)),
        };
    }
    if (mode === "resize-left") {
        const newStart = addDays(originalStart, deltaDays);
        if (newStart >= originalEnd) return null;
        return { startDate: formatDate(newStart), endDate: formatDate(originalEnd) };
    }

    const newEnd = addDays(originalEnd, deltaDays);
    if (newEnd <= originalStart) return null;
    return { startDate: formatDate(originalStart), endDate: formatDate(newEnd) };
}

export function taskDatesMatch(task: DashboardTaskRow, dates: TaskDateOverride): boolean {
    return task.startDate.slice(0, 10) === dates.startDate.slice(0, 10)
        && task.endDate.slice(0, 10) === dates.endDate.slice(0, 10);
}

export function projectRefreshMatches(
    canonical: DashboardProjectRow | undefined,
    expected: ProjectRefreshExpectation,
): boolean {
    if (!canonical) return false;
    if (expected.projectStartDate !== undefined
        && canonical.startDate?.slice(0, 10) !== expected.projectStartDate?.slice(0, 10)) return false;
    const canonicalTasks = new Map(canonical.tasks.map(task => [task.id, task]));
    return expected.taskDates.every(task => {
        const canonicalTask = canonicalTasks.get(task.id);
        return Boolean(canonicalTask && taskDatesMatch(canonicalTask, task));
    });
}

export function getEffectivePendingProjectIds(
    pendingProjectIds: Iterable<string>,
    pendingTaskIds: Iterable<string>,
    taskProjectById: ReadonlyMap<string, string>,
): Set<string> {
    const result = new Set(pendingProjectIds);
    for (const taskId of pendingTaskIds) {
        const projectId = taskProjectById.get(taskId);
        if (projectId) result.add(projectId);
    }
    return result;
}

export function mergeProjectPendingIds(...sources: Iterable<string>[]): Set<string> {
    return new Set(sources.flatMap(source => [...source]));
}

export function getNewlyPendingProjectIds(
    previous: ReadonlySet<string>,
    current: ReadonlySet<string>,
): Set<string> {
    return new Set([...current].filter(projectId => !previous.has(projectId)));
}

export function projectIdSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    return left.size === right.size && [...left].every(projectId => right.has(projectId));
}

export function previewTaskPointerCandidate(
    task: DashboardTaskRow,
    mode: TaskEditMode,
    deltaDays: number | null,
): TaskDateOverride | null {
    return deltaDays == null ? null : previewTaskDates(task, mode, deltaDays);
}

export function previewProjectIncomeOverlays(
    rows: OverlayIncomeItem[],
    projectId: string,
    deltaDays: number,
    eligibleTaskIds?: ReadonlySet<string>,
): OverlayIncomeItem[] {
    if (deltaDays === 0) return rows;
    return rows.map(row => {
        if (row.projectId !== projectId || !row.anchoredToTask || row.inQuickBooks) return row;
        if (eligibleTaskIds && (!row.scheduleTaskId || !eligibleTaskIds.has(row.scheduleTaskId))) return row;
        return {
            ...row,
            dueDate: row.dueDate ? formatDate(addDays(parseSerializedUTCDay(row.dueDate), deltaDays)) : null,
            effectiveDueDate: formatDate(addDays(parseSerializedUTCDay(row.effectiveDueDate), deltaDays)),
        };
    });
}

export function previewShiftedTaskIncomeOverlays(
    rows: OverlayIncomeItem[],
    projectId: string,
    deltaDays: number,
    eligibleTaskIds: ReadonlySet<string>,
): OverlayIncomeItem[] {
    if (deltaDays === 0) return rows;
    return rows.map(row => {
        // shiftNotStartedTasks does not write payment rows. Only a null-dated
        // milestone inherits its moved task's start date; explicit due dates
        // remain fixed and QB-linked rows remain outside optimistic money edits.
        if (row.projectId !== projectId || row.dueDate !== null || row.inQuickBooks
            || !row.scheduleTaskId || !eligibleTaskIds.has(row.scheduleTaskId)) return row;
        return {
            ...row,
            effectiveDueDate: formatDate(addDays(parseSerializedUTCDay(row.effectiveDueDate), deltaDays)),
        };
    });
}

export function previewProjectOverlays(
    overlays: CalendarOverlays,
    projectId: string,
    deltaDays: number,
): CalendarOverlays {
    return {
        ...overlays,
        income: previewProjectIncomeOverlays(overlays.income, projectId, deltaDays),
    };
}

export function clipRange(range: DateRange, window: DateRange): DateRange | null {
    const start = toUTCDay(range.start) > toUTCDay(window.start) ? toUTCDay(range.start) : toUTCDay(window.start);
    const end = toUTCDay(range.end) < toUTCDay(window.end) ? toUTCDay(range.end) : toUTCDay(window.end);

    return end > start ? { start, end } : null;
}

export function segmentProjectRange(
    projectId: string,
    range: DateRange,
    gridStart: Date,
    gridEnd: Date,
): UnlanedWeekSegment[] {
    const normalizedRange = { start: toUTCDay(range.start), end: toUTCDay(range.end) };
    const normalizedGridStart = toUTCDay(gridStart);
    const clipped = clipRange(normalizedRange, { start: normalizedGridStart, end: toUTCDay(gridEnd) });
    if (!clipped) return [];

    const segments: UnlanedWeekSegment[] = [];
    let segmentStart = clipped.start;
    while (segmentStart < clipped.end) {
        const daysFromGridStart = getDaysBetween(normalizedGridStart, segmentStart);
        const weekIndex = Math.floor(daysFromGridStart / 7);
        const startColumn = daysFromGridStart % 7;
        const weekEnd = addDays(normalizedGridStart, (weekIndex + 1) * 7);
        const segmentEnd = clipped.end < weekEnd ? clipped.end : weekEnd;

        segments.push({
            projectId,
            weekIndex,
            startColumn,
            spanDays: getDaysBetween(segmentStart, segmentEnd),
            continuesBefore: segmentStart > normalizedRange.start,
            continuesAfter: segmentEnd < normalizedRange.end,
        });
        segmentStart = segmentEnd;
    }

    return segments;
}

function segmentRange(segment: UnlanedWeekSegment): DateRange {
    const epoch = parseUTCDate("1970-01-01");
    const start = addDays(epoch, segment.weekIndex * 7 + segment.startColumn);
    return { start, end: addDays(start, segment.spanDays) };
}

export function assignProjectLanes(
    segmentsByProject: Map<string, UnlanedWeekSegment[]>,
): { visible: WeekSegment[]; hiddenByWeek: Map<number, number> } {
    const occupiedByLane: DateRange[][] = [];
    const visible: WeekSegment[] = [];
    const hiddenByWeek = new Map<number, number>();

    for (const segments of segmentsByProject.values()) {
        const ranges = segments.map(segmentRange);
        let lane = 0;
        while (occupiedByLane[lane]?.some(occupied => ranges.some(range => rangesOverlap(occupied, range)))) {
            lane++;
        }
        (occupiedByLane[lane] ??= []).push(...ranges);

        for (const segment of segments) {
            const lanedSegment = { ...segment, lane };
            if (lane < 4) {
                visible.push(lanedSegment);
            } else {
                hiddenByWeek.set(segment.weekIndex, (hiddenByWeek.get(segment.weekIndex) ?? 0) + 1);
            }
        }
    }

    return { visible, hiddenByWeek };
}

function segmentOffset(segment: UnlanedWeekSegment): number {
    return segment.weekIndex * 7 + segment.startColumn;
}

function segmentContainsDay(segment: UnlanedWeekSegment, dayOffset: number): boolean {
    const start = segmentOffset(segment);
    return dayOffset >= start && dayOffset < start + segment.spanDays;
}

export function assignMonthProjectLanes(
    workSegmentsByProject: Map<string, UnlanedWeekSegment[]>,
    milestoneDaysByProject: Map<string, Date[]>,
    gridStart: Date,
    gridEnd: Date,
): MonthProjectLaneLayout {
    const normalizedGridStart = toUTCDay(gridStart);
    const normalizedGridEnd = toUTCDay(gridEnd);
    const projectIds = new Set([...workSegmentsByProject.keys(), ...milestoneDaysByProject.keys()]);
    const occupancyByProject = new Map<string, UnlanedWeekSegment[]>();
    const milestoneHosts: Array<UnlanedWeekSegment & { dateKey: string }> = [];

    for (const projectId of projectIds) {
        const workSegments = workSegmentsByProject.get(projectId) ?? [];
        const hosts: Array<UnlanedWeekSegment & { dateKey: string }> = [];
        const seenDays = new Set<string>();

        for (const milestoneDay of milestoneDaysByProject.get(projectId) ?? []) {
            const day = toUTCDay(milestoneDay);
            const dateKey = formatDate(day);
            if (seenDays.has(dateKey) || day < normalizedGridStart || day >= normalizedGridEnd) continue;
            seenDays.add(dateKey);

            const dayOffset = getDaysBetween(normalizedGridStart, day);
            if (workSegments.some(segment => segmentContainsDay(segment, dayOffset))) continue;

            const [host] = segmentProjectRange(projectId, { start: day, end: addDays(day, 1) }, normalizedGridStart, normalizedGridEnd);
            if (host) hosts.push({ ...host, dateKey });
        }

        occupancyByProject.set(projectId, [...workSegments, ...hosts]);
        milestoneHosts.push(...hosts);
    }

    const assigned = assignProjectLanes(occupancyByProject);
    const laneByProject = new Map<string, number>();
    for (const segment of assigned.visible) laneByProject.set(segment.projectId, segment.lane);

    const visibleWork: WeekSegment[] = [];
    for (const [projectId, segments] of workSegmentsByProject) {
        const lane = laneByProject.get(projectId);
        if (lane == null) continue;
        visibleWork.push(...segments.map(segment => ({ ...segment, lane })));
    }

    const visibleMilestoneHosts = milestoneHosts.flatMap(host => {
        const lane = laneByProject.get(host.projectId);
        return lane == null ? [] : [{ ...host, lane }];
    });

    const hiddenProjectIdsByWeek = new Map<number, string[]>();
    for (const [projectId, segments] of occupancyByProject) {
        if (laneByProject.has(projectId)) continue;
        for (const weekIndex of new Set(segments.map(segment => segment.weekIndex))) {
            hiddenProjectIdsByWeek.set(weekIndex, [...(hiddenProjectIdsByWeek.get(weekIndex) ?? []), projectId]);
        }
    }

    return { visibleWork, visibleMilestoneHosts, hiddenProjectIdsByWeek };
}

export const MAX_TASK_LANES = 3;

export interface TaskLaneRange {
    id: string;
    start: Date;
    end: Date;
}

export interface TaskLaneLayout {
    laneByTaskId: Map<string, number>;
    hiddenTaskIds: string[];
    laneCount: number;
}

/**
 * Stack a project's own tasks into overlap-free mini-lanes (a project can
 * carry concurrent phases — e.g. concrete + deck). Same greedy
 * interval-partition idea as assignProjectLanes, capped at MAX_TASK_LANES;
 * tasks beyond the cap are reported as hidden for a "+N" affordance. Sorted
 * by start (tie-broken by id) for a deterministic, stable assignment.
 */
export function assignTaskLanes(tasks: TaskLaneRange[]): TaskLaneLayout {
    const sorted = [...tasks].sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
    const laneEnds: Date[] = [];
    const laneByTaskId = new Map<string, number>();
    const hiddenTaskIds: string[] = [];

    for (const task of sorted) {
        let lane = laneEnds.findIndex(end => end <= task.start);
        if (lane === -1) lane = laneEnds.length;
        if (lane >= MAX_TASK_LANES) {
            hiddenTaskIds.push(task.id);
            continue;
        }
        laneEnds[lane] = task.end;
        laneByTaskId.set(task.id, lane);
    }

    const laneCount = laneByTaskId.size === 0 ? 0 : Math.max(...laneByTaskId.values()) + 1;
    return { laneByTaskId, hiddenTaskIds, laneCount };
}

export function toTimelineRect(range: DateRange, origin: Date, dayWidth: number): TimelineRect {
    const normalizedOrigin = toUTCDay(origin);
    const start = toUTCDay(range.start);
    const end = toUTCDay(range.end);
    return {
        left: getDaysBetween(normalizedOrigin, start) * dayWidth,
        width: getDaysBetween(start, end) * dayWidth,
    };
}

export function getTimelinePointerDelta(clientX: number, originX: number, dayWidth: number): number {
    return Math.round((clientX - originX) / dayWidth);
}

export interface TimelineAutoscrollInput {
    clientX: number;
    containerLeft: number;
    containerRight: number;
    timelineLeftInset: number;
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
    threshold: number;
    maxStep: number;
}

export function getTimelineAutoscrollStep({
    clientX,
    containerLeft,
    containerRight,
    timelineLeftInset,
    scrollLeft,
    scrollWidth,
    clientWidth,
    threshold,
    maxStep,
}: TimelineAutoscrollInput): number {
    const visibleLeft = containerLeft + timelineLeftInset;
    const leftDistance = Math.abs(clientX - visibleLeft);
    if (scrollLeft > 0 && leftDistance < threshold) {
        return -Math.min(maxStep, Math.ceil((threshold - leftDistance) / 3));
    }

    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    const rightDistance = Math.abs(clientX - containerRight);
    if (scrollLeft < maxScrollLeft && rightDistance < threshold) {
        return Math.min(maxStep, Math.ceil((threshold - rightDistance) / 3));
    }

    return 0;
}
