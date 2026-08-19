// Single source of truth for "which phases (cost codes) may the crew clock in
// against on this project?".
//
// This exists because two call sites used to answer that question separately
// and could disagree:
//   1. GET /api/projects/[id]/cost-codes — what the mobile clock-in picker SHOWS.
//   2. POST /api/time-entries — what the server ACCEPTS.
// (1) listed every cost code referenced by ANY estimate item on the project,
// including drafts and archived estimates, while (2)'s legacy `costCodeId`
// branch only checked the code existed globally — so a crew member could post
// labor against a code that has nothing to do with the job. Now the picker and
// the validation both compose their answer from `resolveProjectPhaseCodes()`
// below, so they cannot drift apart.
//
// Pure rules live here as plain functions; the Prisma-backed reader is
// dependency-injected (`PhaseDataSource`) so the rules are unit-testable with
// no database (mirrors src/lib/phase-options.ts's convention).

import { PROJECT_STATUS_IN_PROGRESS } from "@/lib/project-status";

/**
 * Estimate statuses whose items represent real, committed work. Must stay
 * identical to the predicate the clock-in route uses for `estimateItemId`
 * (src/app/api/time-entries/route.ts POST) — a phase the picker offers must be
 * a phase the server accepts.
 */
export const PHASE_ELIGIBLE_ESTIMATE_STATUSES = ["Approved", "Invoiced", "Partially Paid", "Paid"] as const;

/** Prisma `where` fragment for the estimates whose items define a project's phases. */
export const PHASE_ELIGIBLE_ESTIMATE_WHERE = {
    // Mutable array on purpose — Prisma's generated `in` filter rejects a
    // readonly tuple.
    status: { in: PHASE_ELIGIBLE_ESTIMATE_STATUSES.map((status) => status) },
    archivedAt: null as null,
};

/**
 * The company-wide Safety Meeting phase. It is deliberately NOT an estimate
 * line item — safety meetings are billed to overhead, not to a bid line — so
 * it is appended to a project's phase list rather than discovered from
 * estimate items. `CostCode.code` is unique, so this string is the key.
 * The row is created by scripts/apply-safety-cost-code.mjs.
 */
export const SAFETY_COST_CODE = "22-SAFETY";
export const SAFETY_COST_CODE_NAME = "Safety Meeting";

/** The narrow cost-code shape both the picker response and validation need. */
export interface PhaseCostCode {
    id: string;
    code: string;
    name: string;
    description?: string | null;
    isActive?: boolean;
}

/**
 * Safety meetings only happen on jobs that are actually being worked. A
 * "Waiting to Start" or closed job must not offer the phase, or crew can book
 * labor to a job nobody is on.
 *
 * NOTE (2026-08): the mobile project picker now only lists In Progress jobs
 * (src/app/api/mobile/me/route.ts), which makes this check effectively
 * always-true for anything a crew member can see. It is kept anyway — the
 * routes are reachable by id from other clients, and this is the rule, not an
 * artifact of what the picker happens to show.
 */
export function shouldIncludeSafetyPhase(projectStatus: string | null | undefined): boolean {
    return projectStatus === PROJECT_STATUS_IN_PROGRESS;
}

/**
 * Compose the final phase list: the project's estimate-derived cost codes,
 * plus the Safety Meeting phase when the project qualifies. Deduplicated by
 * code (an estimate that already carries a 22-SAFETY line must not produce two
 * rows) and sorted by code — plain string sort, correct for zero-padded codes
 * like "01-DEMO".
 */
export function composeProjectPhases(args: {
    estimateCostCodes: PhaseCostCode[];
    projectStatus: string | null | undefined;
    safetyCostCode: PhaseCostCode | null;
}): PhaseCostCode[] {
    const byCode = new Map<string, PhaseCostCode>();
    for (const costCode of args.estimateCostCodes) {
        if (!costCode) continue;
        if (!byCode.has(costCode.code)) byCode.set(costCode.code, costCode);
    }
    if (args.safetyCostCode && shouldIncludeSafetyPhase(args.projectStatus)) {
        byCode.set(args.safetyCostCode.code, args.safetyCostCode);
    }
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * The data the rules need, injected so the rules stay testable without Prisma.
 * `getProject` returning null means "no such project" — an unknown project has
 * no phases and accepts no cost code.
 */
export interface PhaseDataSource {
    getProject(projectId: string): Promise<{ id: string; status: string } | null>;
    /** Distinct cost codes referenced by items on the project's ELIGIBLE estimates. */
    getEstimateCostCodes(projectId: string): Promise<PhaseCostCode[]>;
    /** The 22-SAFETY CostCode row, or null if it hasn't been seeded yet. */
    getSafetyCostCode(): Promise<PhaseCostCode | null>;
}

/**
 * THE answer to "what phases does this project have?". Both the picker route
 * and the clock-in validation call this — that is the whole point of the file.
 */
export async function resolveProjectPhaseCodes(
    dataSource: PhaseDataSource,
    projectId: string
): Promise<PhaseCostCode[]> {
    const project = await dataSource.getProject(projectId);
    if (!project) return [];
    const [estimateCostCodes, safetyCostCode] = await Promise.all([
        dataSource.getEstimateCostCodes(projectId),
        shouldIncludeSafetyPhase(project.status) ? dataSource.getSafetyCostCode() : Promise.resolve(null),
    ]);
    return composeProjectPhases({ estimateCostCodes, projectStatus: project.status, safetyCostCode });
}

/**
 * Clock-in validation: is `costCodeId` a phase that actually belongs to this
 * project (or the Safety Meeting phase on an In Progress project)? Anything
 * else must be rejected — "the cost code exists" is not a permission.
 */
export async function isCostCodeAllowedForProject(
    dataSource: PhaseDataSource,
    projectId: string,
    costCodeId: string
): Promise<boolean> {
    const phases = await resolveProjectPhaseCodes(dataSource, projectId);
    return phases.some((phase) => phase.id === costCodeId);
}
