import type { CrewConflict, DashboardProjectRow } from "@/lib/schedule-core";
import { addDays, formatDate, getFallbackProjectColor, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";
import { getEffectiveProjectRange } from "./useBarLayout";

export interface AvailabilityMember {
    id: string;
    name: string;
    role: string;
    showOnDispatch: boolean;
    burdenedHourlyRate?: number;
}

export interface AvailabilityChip {
    kind: "booked" | "soft";
    projectId: string;
    projectName: string;
    projectColor: string;
    taskName: string | null;
    startDate: string;
    endDate: string;
    distanceMilesFromShop: number | null;
}

export interface AvailabilityRow {
    userId: string;
    name: string;
    burdenedHourlyRate?: number;
    chipsByDay: Map<string, AvailabilityChip[]>;
}

/**
 * Shared per-person/per-day availability derivation. Booked chips come from
 * active task assignments; soft chips come from project crew coverage only
 * when that person has no task on the project that day.
 */
export function buildAvailabilityRows(
    members: AvailabilityMember[],
    projects: DashboardProjectRow[],
    days: Date[],
): AvailabilityRow[] {
    const dayKeys = days.map(formatDate);
    const memberById = new Map(members.map(member => [member.id, member]));
    const rowsByUser = new Map<string, AvailabilityRow>();
    const rowFor = (member: AvailabilityMember): AvailabilityRow => {
        let row = rowsByUser.get(member.id);
        if (!row) {
            row = {
                userId: member.id,
                name: member.name,
                burdenedHourlyRate: member.burdenedHourlyRate,
                chipsByDay: new Map(),
            };
            rowsByUser.set(member.id, row);
        }
        return row;
    };

    for (const project of projects) {
        const projectColor = project.color || getFallbackProjectColor(project.id);
        const bookedDaysByUser = new Map<string, Set<string>>();

        for (const task of project.tasks) {
            const start = parseUTCDate(task.startDate.slice(0, 10));
            const end = task.type === "milestone" ? addDays(start, 1) : parseUTCDate(task.endDate.slice(0, 10));
            if (end <= start) continue;
            for (const assignment of task.assignments) {
                if (assignment.status !== "ACTIVATED") continue;
                const member = memberById.get(assignment.userId);
                if (!member) continue;
                for (const dayKey of dayKeys) {
                    const day = parseUTCDate(dayKey);
                    if (day < start || day >= end) continue;
                    const row = rowFor(member);
                    const chips = row.chipsByDay.get(dayKey) ?? [];
                    if (chips.some(chip => chip.kind === "booked" && chip.projectId === project.id)) continue;
                    chips.push({
                        kind: "booked",
                        projectId: project.id,
                        projectName: project.name,
                        projectColor,
                        taskName: task.name,
                        startDate: task.startDate.slice(0, 10),
                        endDate: task.endDate.slice(0, 10),
                        distanceMilesFromShop: project.distanceMilesFromShop,
                    });
                    row.chipsByDay.set(dayKey, chips);
                    const booked = bookedDaysByUser.get(member.id) ?? new Set<string>();
                    booked.add(dayKey);
                    bookedDaysByUser.set(member.id, booked);
                }
            }
        }

        const range = getEffectiveProjectRange(project);
        if (!range) continue;
        for (const crewMember of project.crew) {
            if (crewMember.status !== "ACTIVATED") continue;
            const member = memberById.get(crewMember.id);
            if (!member) continue;
            for (const dayKey of dayKeys) {
                const day = parseUTCDate(dayKey);
                if (day < range.start || day >= range.end) continue;
                if (bookedDaysByUser.get(member.id)?.has(dayKey)) continue;
                const row = rowFor(member);
                const chips = row.chipsByDay.get(dayKey) ?? [];
                chips.push({
                    kind: "soft",
                    projectId: project.id,
                    projectName: project.name,
                    projectColor,
                    taskName: null,
                    startDate: formatDate(range.start),
                    endDate: formatDate(range.end),
                    distanceMilesFromShop: project.distanceMilesFromShop,
                });
                row.chipsByDay.set(dayKey, chips);
            }
        }
    }

    return members
        .map(member => rowsByUser.get(member.id) ?? {
            userId: member.id,
            name: member.name,
            burdenedHourlyRate: member.burdenedHourlyRate,
            chipsByDay: new Map<string, AvailabilityChip[]>(),
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

export const MAX_VISIBLE_BOOKED_CHIPS = 2;

export interface AvailabilityCellSummary {
    /** Booked chips to render, already truncated to MAX_VISIBLE_BOOKED_CHIPS. */
    booked: AvailabilityChip[];
    /** Booked chips beyond the visible cap — render as a "+N" chip. */
    overflow: number;
    /** Count of soft (job-crew, no task) chips for this cell. */
    softCount: number;
}

/**
 * Reduces a cell's raw chip list to the information-design rules: booked
 * chips are the only thing ever rendered as a chip (capped, with a "+N"
 * overflow marker); soft membership collapses to a count so five identical
 * outlined pills don't wallpaper the cell.
 */
export function summarizeCell(chips: AvailabilityChip[]): AvailabilityCellSummary {
    const bookedAll = chips.filter(chip => chip.kind === "booked");
    const softCount = chips.filter(chip => chip.kind === "soft").length;
    return {
        booked: bookedAll.slice(0, MAX_VISIBLE_BOOKED_CHIPS),
        overflow: Math.max(0, bookedAll.length - MAX_VISIBLE_BOOKED_CHIPS),
        softCount,
    };
}

/**
 * Reads the canonical serialized conflict windows. `solidOnly` narrows the
 * result to pairs backed by two task assignments, excluding project-crew
 * fallback overlaps from Dispatch's red true-conflict treatment.
 */
export function isConflictedDay(
    conflicts: CrewConflict[] | null,
    userId: string,
    dayKey: string,
    solidOnly = false,
): boolean {
    const entry = conflicts?.find(conflict => conflict.userId === userId);
    if (!entry) return false;
    const day = parseUTCDate(dayKey);
    return entry.pairs.some(pair => {
        if (solidOnly && (!pair.taskA || !pair.taskB)) return false;
        const start = parseUTCDate(pair.overlapStart.slice(0, 10));
        const end = parseUTCDate(pair.overlapEnd.slice(0, 10));
        return day >= start && day < end;
    });
}
