import { CLOSED_PROJECT_STATUSES } from "./gpt-estimate";
import { prisma } from "./prisma";
import { recomputeProjectProjectionInTransaction } from "./project-projection";

const MAX_PROJECTS_PER_SWEEP = 100;

export type ProjectProjectionSweepResult = {
    selected: number;
    recomputed: number;
    skipped: number;
    failed: number;
    hasMore: boolean;
};

type ProjectionSweepDependencies = {
    listStaleProjectIds: (input: { staleBefore: Date; limit: number }) => Promise<string[]>;
    recomputeProject: (input: { projectId: string; asOf: Date; staleBefore: Date }) => Promise<"recomputed" | "skipped">;
};

type ProjectionSweepOptions = {
    asOf?: Date;
    limit?: number;
};

function startOfUtcDay(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function defaultDependencies(): ProjectionSweepDependencies {
    return {
        listStaleProjectIds: async ({ staleBefore, limit }) => prisma.project.findMany({
            where: {
                status: { notIn: CLOSED_PROJECT_STATUSES },
                OR: [
                    { projectedEndComputedAt: null },
                    { projectedEndComputedAt: { lt: staleBefore } },
                ],
            },
            orderBy: { updatedAt: "asc" },
            take: limit,
            select: { id: true },
        }).then(projects => projects.map(project => project.id)),
        recomputeProject: async ({ projectId, asOf }) => {
            await prisma.$transaction(tx => recomputeProjectProjectionInTransaction(tx, projectId, asOf));
            return "recomputed";
        },
    };
}

/**
 * Recomputes projections that have not been refreshed today. The bounded,
 * failure-isolated sweep is safe for a Vercel cron retry: task writes also
 * recompute synchronously, so a skipped run can only leave stale display data.
 */
export async function runProjectProjectionSweep(
    dependencies: ProjectionSweepDependencies = defaultDependencies(),
    options: ProjectionSweepOptions = {},
): Promise<ProjectProjectionSweepResult> {
    const asOf = options.asOf ?? new Date();
    const staleBefore = startOfUtcDay(asOf);
    const limit = Math.min(MAX_PROJECTS_PER_SWEEP, Math.max(1, Math.floor(options.limit ?? MAX_PROJECTS_PER_SWEEP)));
    const candidateIds = await dependencies.listStaleProjectIds({ staleBefore, limit });
    const projectIds = candidateIds.slice(0, limit);
    let recomputed = 0;
    let skipped = 0;
    let failed = 0;

    for (const projectId of projectIds) {
        try {
            const outcome = await dependencies.recomputeProject({ projectId, asOf, staleBefore });
            if (outcome === "recomputed") recomputed += 1;
            else skipped += 1;
        } catch (error) {
            failed += 1;
            console.error("[project-projection-sweep] failed", {
                projectId,
                error: error instanceof Error ? error.name : "UnknownError",
            });
        }
    }

    return {
        selected: projectIds.length,
        recomputed,
        skipped,
        failed,
        hasMore: candidateIds.length > projectIds.length,
    };
}
