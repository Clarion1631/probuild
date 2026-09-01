// Database side of percent complete (docs/plans/PHASE-4-EARNED-MARGIN-SPEC.md
// §3 + §6). The rules live in the pure percent-complete.ts; this file only
// gathers the inputs and writes the result.
//
// ── READ THIS BEFORE CALLING recalcProjectPercentComplete ────────────────────
// It runs `loadProjectVariance` for ONE project, which is ~6 queries per job.
// That is fine nightly across a handful of active jobs and is NOT fine on a
// page render. Pages read the stored `Project.percentComplete*` columns; the
// nightly cron is the only writer of the auto value.

import { prisma } from "@/lib/prisma";
import { loadProjectVariance } from "@/lib/job-variance-db";
import { OVERHEAD_PROJECT_ID } from "@/lib/overhead-project";
import { PROJECT_STATUS_IN_PROGRESS } from "@/lib/project-status";
import { computeAutoPercentComplete, type PhaseProgressInput } from "@/lib/percent-complete";

/** Schedule status that counts as done — the canonical value in SCHEDULE_TASK_STATUSES. */
const TASK_STATUS_COMPLETE = "Complete";

/**
 * "An active job", for every Phase 4 surface.
 *
 * In Progress, not the overhead bucket ("Shop" has no client and no bid, so job
 * profitability does not apply to it), and not a logistics/shop bucket. One
 * definition so the recalc, the Monday card and the dragging-us email cannot
 * disagree about which jobs are in scope.
 */
export function activeJobWhere() {
    return {
        status: PROJECT_STATUS_IN_PROGRESS,
        id: { not: OVERHEAD_PROJECT_ID },
        isLogistics: false,
    };
}

export interface PercentCompleteRecalcResult {
    projectId: string;
    projectName: string;
    /** The computed value, or null when the trust gate refused to guess. */
    auto: number | null;
    /** True when a MANUAL override meant `percentComplete` was left alone. */
    manualOverrideKept: boolean;
    /** The effective value after the write. */
    percentComplete: number | null;
}

/**
 * Recompute one job's automatic percent complete and store it.
 *
 * `percentCompleteAuto` is ALWAYS written, even under a manual override — that
 * is what makes the >5-point drift flag possible. `percentComplete` itself is
 * only touched when nobody has overridden it.
 */
export async function recalcProjectPercentComplete(
    project: { id: string; name: string }
): Promise<PercentCompleteRecalcResult> {
    const [reports, tasks, logs, stored] = await Promise.all([
        // Budgets come from the variance basis, so the percentage is weighted by
        // the same dollars the variance report shows. Never re-derive them here.
        loadProjectVariance([project.id]),
        // A task reaches a phase only through its estimate item's cost code.
        prisma.scheduleTask.findMany({
            where: { projectId: project.id, estimateItemId: { not: null } },
            select: { id: true, status: true, type: true, estimateItem: { select: { costCodeId: true } } },
        }),
        prisma.dailyLog.findMany({
            where: { projectId: project.id, aiSuggestedTaskId: { not: null } },
            select: { aiSuggestedTaskId: true },
        }),
        prisma.project.findUnique({
            where: { id: project.id },
            select: { percentCompleteSource: true },
        }),
    ]);

    const variance = reports[0]?.variance;

    // taskId → phase, for the daily-log mentions. Unfiltered by type on purpose:
    // a log matched to a milestone still evidences that work happened.
    const phaseByTaskId = new Map<string, string>();
    const counts = new Map<string, { totalTasks: number; doneTasks: number }>();
    for (const task of tasks) {
        const costCodeId = task.estimateItem?.costCodeId;
        if (!costCodeId) continue; // an uncoded item belongs to no phase
        phaseByTaskId.set(task.id, costCodeId);
        // Milestones and appointments are markers, not work — they must not
        // dilute (or inflate) a phase's completion ratio.
        if (task.type !== "task") continue;
        const row = counts.get(costCodeId) ?? { totalTasks: 0, doneTasks: 0 };
        row.totalTasks += 1;
        if (task.status === TASK_STATUS_COMPLETE) row.doneTasks += 1;
        counts.set(costCodeId, row);
    }

    const mentionedPhases = new Set<string>();
    for (const log of logs) {
        const phase = log.aiSuggestedTaskId ? phaseByTaskId.get(log.aiSuggestedTaskId) : undefined;
        if (phase) mentionedPhases.add(phase);
    }

    const phases: PhaseProgressInput[] = (variance?.phases ?? []).map((phase) => {
        const count = counts.get(phase.costCodeId) ?? { totalTasks: 0, doneTasks: 0 };
        return {
            costCodeId: phase.costCodeId,
            budget: phase.totalBudget,
            totalTasks: count.totalTasks,
            doneTasks: count.doneTasks,
            hasDailyLogMention: mentionedPhases.has(phase.costCodeId),
        };
    });

    const auto = computeAutoPercentComplete({
        phases,
        uncodedBudget: variance?.uncodedBudget ?? 0,
    });

    const manualOverrideKept = stored?.percentCompleteSource === "MANUAL";
    const now = new Date();

    await prisma.project.update({
        where: { id: project.id },
        data: manualOverrideKept
            ? { percentCompleteAuto: auto }
            : {
                percentCompleteAuto: auto,
                percentComplete: auto,
                percentCompleteSource: "AUTO",
                percentCompleteAsOf: now,
            },
    });

    let percentComplete = auto;
    if (manualOverrideKept) {
        const after = await prisma.project.findUnique({
            where: { id: project.id },
            select: { percentComplete: true },
        });
        percentComplete = after?.percentComplete == null ? null : Number(after.percentComplete);
    }

    return { projectId: project.id, projectName: project.name, auto, manualOverrideKept, percentComplete };
}

/** Recompute every active job. Returns one row per job for the cron log. */
export async function recalcAllActivePercentComplete(): Promise<PercentCompleteRecalcResult[]> {
    const projects = await prisma.project.findMany({
        where: activeJobWhere(),
        select: { id: true, name: true },
        orderBy: { name: "asc" },
    });

    const results: PercentCompleteRecalcResult[] = [];
    // Sequential on purpose: each iteration is already ~8 queries, and running
    // six jobs in parallel would burst the pooler for no useful latency win on a
    // nightly cron.
    for (const project of projects) {
        results.push(await recalcProjectPercentComplete(project));
    }
    return results;
}

export interface ActiveJobPercentComplete {
    id: string;
    name: string;
    percentComplete: number | null;
    percentCompleteSource: "AUTO" | "MANUAL" | null;
    percentCompleteAsOf: Date | null;
    percentCompleteAuto: number | null;
    percentCompleteAutoAtOverride: number | null;
}

/** The active jobs plus their stored percent-complete columns, as plain numbers. */
export async function listActiveJobsWithPercentComplete(): Promise<ActiveJobPercentComplete[]> {
    const rows = await prisma.project.findMany({
        where: activeJobWhere(),
        select: {
            id: true,
            name: true,
            percentComplete: true,
            percentCompleteSource: true,
            percentCompleteAsOf: true,
            percentCompleteAuto: true,
            percentCompleteAutoAtOverride: true,
        },
        orderBy: { name: "asc" },
    });

    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        percentComplete: row.percentComplete == null ? null : Number(row.percentComplete),
        percentCompleteSource: (row.percentCompleteSource ?? null) as "AUTO" | "MANUAL" | null,
        percentCompleteAsOf: row.percentCompleteAsOf ?? null,
        percentCompleteAuto: row.percentCompleteAuto == null ? null : Number(row.percentCompleteAuto),
        percentCompleteAutoAtOverride:
            row.percentCompleteAutoAtOverride == null ? null : Number(row.percentCompleteAutoAtOverride),
    }));
}
