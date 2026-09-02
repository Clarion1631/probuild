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
    /**
     * The UPDATE matched no row — the project was deleted between being listed
     * and being written. NOT an error: a nightly sweep must not abort the
     * remaining jobs over one vanished row. But it must not be reported as a
     * successful recalc with a null percentage either, which is exactly what a
     * zero-row RETURNING used to look like.
     */
    notFound: boolean;
    /** The computed value, or null when the trust gate refused to guess. */
    auto: number | null;
    /** True when a MANUAL override meant `percentComplete` was left alone. */
    manualOverrideKept: boolean;
    /** The effective value after the write, or null when nothing was written. */
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
    const [reports, tasks, logs] = await Promise.all([
        // Budgets come from the variance basis, so the percentage is weighted by
        // the same dollars the variance report shows. Never re-derive them here.
        loadProjectVariance([project.id]),
        // A task reaches a phase EITHER through its estimate item's cost code
        // or through its own stamped one. Both are needed: change-order tasks
        // can never have an estimateItemId (their scope lives in
        // ChangeOrderItem), yet approved CO dollars are counted in the phase
        // budget — so filtering on estimateItemId alone left every CO-only
        // phase permanently at 0% while its budget dragged the weighted average
        // down, and made CO work in a shared phase inherit the estimate tasks'
        // progress instead of reporting its own.
        prisma.scheduleTask.findMany({
            where: {
                projectId: project.id,
                OR: [{ estimateItemId: { not: null } }, { costCodeId: { not: null } }],
            },
            select: {
                id: true, status: true, type: true, costCodeId: true,
                estimateItem: { select: { costCodeId: true } },
            },
        }),
        prisma.dailyLog.findMany({
            where: { projectId: project.id, aiSuggestedTaskId: { not: null } },
            select: { aiSuggestedTaskId: true },
        }),
    ]);

    const variance = reports[0]?.variance;

    // taskId → phase, for the daily-log mentions. Unfiltered by type on purpose:
    // a log matched to a milestone still evidences that work happened.
    const phaseByTaskId = new Map<string, string>();
    const counts = new Map<string, { totalTasks: number; doneTasks: number }>();
    for (const task of tasks) {
        // The LIVE estimate item wins over the stamped column: re-coding an
        // estimate line must move its task's phase immediately, and the stamp
        // is a generation-time snapshot that would go stale. The stamp is the
        // fallback (and, for a CO task, the only value there is).
        const costCodeId = task.estimateItem?.costCodeId ?? task.costCodeId;
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

    // ── ONE conditional statement, deliberately ─────────────────────────────
    // Reading percentCompleteSource in JS and then updating on the strength of
    // that read is a lost update: this recalc does ~8 queries per job, and
    // somebody saving a manual override anywhere in that window would have it
    // silently stamped back to AUTO. The guard therefore has to be evaluated by
    // the database, inside the same UPDATE that writes.
    //
    // Every CASE below sees the row's PRE-UPDATE percentCompleteSource, so the
    // four assignments cannot disagree with each other. percentCompleteAuto is
    // written unconditionally — the drift flag depends on it staying current
    // even under an override.
    //
    // IS DISTINCT FROM (not <>) because the column is NULL on a job that has
    // never been computed, and `NULL <> 'MANUAL'` is NULL, i.e. false — which
    // would skip exactly the jobs that most need an auto value.
    const now = new Date();
    const rows = await prisma.$queryRaw<Array<{
        percentComplete: unknown;
        percentCompleteSource: string | null;
    }>>`
        UPDATE "Project" SET
            "percentCompleteAuto" = ${auto}::numeric,
            "percentComplete" = CASE WHEN "percentCompleteSource" IS DISTINCT FROM 'MANUAL'
                THEN ${auto}::numeric ELSE "percentComplete" END,
            "percentCompleteSource" = CASE WHEN "percentCompleteSource" IS DISTINCT FROM 'MANUAL'
                THEN 'AUTO'::"PercentCompleteSource" ELSE "percentCompleteSource" END,
            "percentCompleteAsOf" = CASE WHEN "percentCompleteSource" IS DISTINCT FROM 'MANUAL'
                THEN ${now}::timestamp(3) ELSE "percentCompleteAsOf" END
        WHERE "id" = ${project.id}
        RETURNING "percentComplete", "percentCompleteSource"`;

    const row = rows[0];
    if (!row) {
        // Zero rows means the WHERE matched nothing: the project was deleted
        // between being listed and being updated (or a caller passed a stale
        // id). Nothing was stored, so say so — `percentComplete: null` alone
        // reads identically to "computed, and the answer was unknowable".
        return {
            projectId: project.id,
            projectName: project.name,
            notFound: true,
            auto,
            manualOverrideKept: false,
            percentComplete: null,
        };
    }

    const manualOverrideKept = row.percentCompleteSource === "MANUAL";
    const percentComplete = row.percentComplete == null ? null : Number(row.percentComplete);

    return {
        projectId: project.id,
        projectName: project.name,
        notFound: false,
        auto,
        manualOverrideKept,
        percentComplete,
    };
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
        const result = await recalcProjectPercentComplete(project);
        // Log and carry on: one project deleted mid-sweep must not cost the
        // other jobs their nightly recalculation.
        if (result.notFound) {
            console.warn("[percent-complete] skipped — project vanished mid-recalc", {
                projectId: result.projectId,
                projectName: result.projectName,
            });
        }
        results.push(result);
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
