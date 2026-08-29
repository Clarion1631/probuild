import { Prisma } from "@prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

type ProjectionTask = {
    id: string;
    startDate: Date;
    endDate: Date;
    progress: number;
    status: string;
    dependencies: { predecessorId: string }[];
};

function startOfUtcDay(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
    const result = new Date(value);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

/**
 * Build B §6 projection. In-progress tasks project from today using their
 * scheduled duration and recorded progress. Not-started successors inherit an
 * in-progress predecessor's lag; the job projection is the furthest open task.
 */
export function calculateProjectedEnd(tasks: readonly ProjectionTask[], asOf = new Date()): Date | null {
    const today = startOfUtcDay(asOf);
    const taskById = new Map(tasks.map(task => [task.id, task]));
    const lagByInProgressTask = new Map<string, number>();

    for (const task of tasks) {
        if (task.status !== "In Progress" || task.progress >= 100) continue;
        const scheduledStart = startOfUtcDay(task.startDate);
        const scheduledEnd = startOfUtcDay(task.endDate);
        const durationDays = Math.max(1, Math.ceil((scheduledEnd.getTime() - scheduledStart.getTime()) / DAY_MS));
        const progress = Math.min(100, Math.max(0, task.progress));
        const remainingDays = Math.ceil(durationDays * (100 - progress) / 100);
        const projected = new Date(Math.max(scheduledEnd.getTime(), addDays(today, remainingDays).getTime()));
        lagByInProgressTask.set(task.id, Math.max(0, Math.ceil((projected.getTime() - scheduledEnd.getTime()) / DAY_MS)));
    }

    function nearestInProgressLag(task: ProjectionTask): number {
        let predecessorIds = task.dependencies.map(dependency => dependency.predecessorId);
        const visited = new Set<string>([task.id]);

        while (predecessorIds.length > 0) {
            const nextIds: string[] = [];
            const nearestLags: number[] = [];
            for (const predecessorId of predecessorIds) {
                if (visited.has(predecessorId)) continue;
                visited.add(predecessorId);
                const predecessor = taskById.get(predecessorId);
                if (!predecessor) continue;
                const lag = lagByInProgressTask.get(predecessorId);
                if (lag !== undefined) {
                    nearestLags.push(lag);
                } else {
                    nextIds.push(...predecessor.dependencies.map(dependency => dependency.predecessorId));
                }
            }
            if (nearestLags.length > 0) return Math.max(...nearestLags);
            predecessorIds = nextIds;
        }
        return 0;
    }

    const projectedDates: Date[] = [];

    for (const task of tasks) {
        if (task.status === "Complete" || task.progress >= 100) continue;
        const scheduledEnd = startOfUtcDay(task.endDate);
        const scheduledStart = startOfUtcDay(task.startDate);
        if (task.status === "In Progress") {
            projectedDates.push(addDays(scheduledEnd, lagByInProgressTask.get(task.id) ?? 0));
            continue;
        }

        // A future task keeps its planned date. Only work that should already
        // have started can be pulled later by an in-progress predecessor.
        const inheritedLag = task.status === "Not Started" && scheduledStart < today
            ? nearestInProgressLag(task)
            : 0;
        projectedDates.push(addDays(scheduledEnd, inheritedLag));
    }

    return projectedDates.length
        ? new Date(Math.max(...projectedDates.map(date => date.getTime())))
        : null;
}

export async function recomputeProjectProjectionInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    asOf = new Date(),
): Promise<Date | null> {
    const tasks = await tx.scheduleTask.findMany({
        where: { projectId },
        select: { id: true, startDate: true, endDate: true, progress: true, status: true, dependencies: { select: { predecessorId: true } } },
    });
    const projectedEndDate = calculateProjectedEnd(tasks, asOf);
    await tx.project.update({
        where: { id: projectId },
        data: { projectedEndDate, projectedEndComputedAt: asOf },
    });
    return projectedEndDate;
}
