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
import { computeAutoPercentComplete, phasesMentionedInLogs, type PhaseProgressInput } from "@/lib/percent-complete";

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

/**
 * Repair pass: give change-order tasks their cost code.
 *
 * WHY THIS RUNS NIGHTLY AND NOT JUST ONCE. The pre-deploy apply script runs
 * BEFORE the new build is live, so every CO task the OLD build creates in the
 * window between the script finishing and the deploy going out is born without
 * a cost code — and a one-shot backfill has already been and gone. Anything
 * caught in that window would stay unattributed forever, which is precisely the
 * bug this whole change exists to fix. Re-running it nightly closes the window
 * and costs one indexed UPDATE against a handful of rows.
 *
 * IDEMPOTENT by construction: `st."costCodeId" IS NULL` means a second run
 * matches nothing it already fixed.
 *
 * The name is the only join available — there is no task→ChangeOrderItem FK,
 * the child task is simply created from the item's `name` — so it is applied
 * ONLY where the name is unambiguous on BOTH sides. Anything ambiguous stays
 * null and goes on being honestly unattributed rather than guessed.
 *
 * Kept byte-identical to BACKFILL_CO_TASK_COST_CODES in
 * scripts/apply-percent-complete.mjs; tests/percent-complete-backfill.test.ts
 * fails if the two ever drift.
 */
export const BACKFILL_CO_TASK_COST_CODES = `
    UPDATE "ScheduleTask" st
    SET "costCodeId" = ci."costCodeId"
    FROM "ChangeOrderItem" ci
    WHERE st."generatedFromChangeOrderId" = ci."changeOrderId"
      AND st."name" = ci."name"
      AND st."costCodeId" IS NULL
      AND st."estimateItemId" IS NULL
      AND st."type" = 'task'
      AND ci."costCodeId" IS NOT NULL
      AND (SELECT COUNT(*) FROM "ChangeOrderItem" c2
           WHERE c2."changeOrderId" = ci."changeOrderId" AND c2."name" = ci."name") = 1
      AND (SELECT COUNT(*) FROM "ScheduleTask" s2
           WHERE s2."generatedFromChangeOrderId" = st."generatedFromChangeOrderId"
             AND s2."name" = st."name" AND s2."type" = 'task') = 1`;

/**
 * Run the CO-task cost-code repair. Returns how many rows it fixed — zero on
 * every run after the first, which is the point.
 */
export async function repairChangeOrderTaskCostCodes(): Promise<number> {
    return prisma.$executeRawUnsafe(BACKFILL_CO_TASK_COST_CODES);
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
        // Free-text evidence for phases that have NO schedule tasks at all.
        // aiSuggestedTaskId is deliberately NOT used: it only ever resolves to a
        // schedule task, and a phase with a task never reaches the task-less
        // fallback — routing evidence through it made the fallback dead code.
        prisma.dailyLog.findMany({
            where: { projectId: project.id },
            select: { workPerformed: true },
        }),
    ]);

    const variance = reports[0]?.variance;

    const counts = new Map<string, { totalTasks: number; doneTasks: number }>();
    for (const task of tasks) {
        // Resolution order, and the null case matters:
        //   - the estimate item EXISTS  -> its costCodeId is the answer, even
        //     when that is null. A line deliberately re-coded to "no cost code"
        //     is UNCODED, and falling through to the generation-time stamp would
        //     silently keep counting it under the phase it used to be in.
        //   - the relation is GONE (estimateItemId null, or SetNull'd by an item
        //     delete) -> the stamp is the only thing left, and for a CO task it
        //     is the only thing there ever was.
        const costCodeId = task.estimateItem ? task.estimateItem.costCodeId : task.costCodeId;
        if (!costCodeId) continue; // an uncoded item belongs to no phase
        // Milestones and appointments are markers, not work — they must not
        // dilute (or inflate) a phase's completion ratio.
        if (task.type !== "task") continue;
        const row = counts.get(costCodeId) ?? { totalTasks: 0, doneTasks: 0 };
        row.totalTasks += 1;
        if (task.status === TASK_STATUS_COMPLETE) row.doneTasks += 1;
        counts.set(costCodeId, row);
    }

    const mentionedPhases = phasesMentionedInLogs(
        logs.map((log) => log.workPerformed),
        (variance?.phases ?? []).map((phase) => ({
            costCodeId: phase.costCodeId, code: phase.code, name: phase.name,
        }))
    );

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
        // POSITIVE uncoded dollars, not the net: a $10k uncoded charge plus a
        // $10k uncoded credit nets to $0 and would report a half-uncoded
        // estimate as fully coded.
        uncodedPositiveBudget: variance?.uncodedPositiveBudget ?? 0,
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

export interface RecalcSweepResult {
    repairedCoTasks: number;
    results: PercentCompleteRecalcResult[];
}

/**
 * Recompute every active job, after repairing any CO task that is still missing
 * its cost code. The repair runs FIRST so a task fixed tonight is counted in
 * tonight's percentage rather than tomorrow's.
 */
export async function recalcAllActivePercentComplete(): Promise<RecalcSweepResult> {
    const repairedCoTasks = await repairChangeOrderTaskCostCodes();
    if (repairedCoTasks > 0) {
        console.log("[percent-complete] repaired change-order task cost codes", { rows: repairedCoTasks });
    }

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
    return { repairedCoTasks, results };
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
