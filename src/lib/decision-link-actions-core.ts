// linkDecisionToSchedule + setDecisionDueDateOverride (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md). Plain
// module, importable directly by e2e specs/the verifier — mirrors
// selection-ai-sort-apply-core.ts's DI seam.
import { prisma } from "./prisma";
import { getCurrentUserWithPermissions, canAccessProject, isAdminOrManager } from "./permissions";
import { revalidatePath } from "next/cache";

export type LinkActor = {
    role: string;
    projectAccess?: { projectId: string }[];
    assignedProjects?: { id: string }[];
} | null;

export type LinkActionDependencies = {
    getActor?: () => Promise<LinkActor>;
    revalidate?: (projectId: string) => void;
};

async function defaultGetActor(): Promise<LinkActor> {
    return getCurrentUserWithPermissions();
}

function defaultRevalidate(projectId: string): void {
    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
}

const LEAD_TIME_MIN = 0;
const LEAD_TIME_MAX = 365;

/**
 * Argument contract: a NON-NULL scheduleTaskId REQUIRES an integer
 * leadTimeDays in 0..365 (derivation needs a numeric lead time).
 * scheduleTaskId: null is an explicit UNLINK, where leadTimeDays must also
 * be null (both link fields clear together). Non-null taskId is validated
 * as belonging to the same project (cross-project tamper check, Phase 2
 * precedent). CAS updateMany writing ONLY the link fields — this NEVER
 * reads or writes `dueDate` (the override column is exclusively written by
 * setDecisionDueDateOverride below).
 */
export async function linkDecisionToSchedule(
    decisionId: string,
    scheduleTaskId: string | null,
    leadTimeDays: number | null,
    deps: LinkActionDependencies = {},
): Promise<{ success: true }> {
    // Auth before lookup (Codex review round 1, issue 11): resolve the actor
    // FIRST — an entirely unauthenticated/no-session caller is rejected
    // before the decision table is ever queried, so it can never learn
    // whether a decisionId exists. The project-scoped canAccessProject check
    // still needs the decision's projectId, so it runs after the lookup —
    // but only once we already know a real actor made the call.
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor) throw new Error("Forbidden");

    const decision = await prisma.decision.findFirst({
        where: { id: decisionId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!decision) throw new Error("Decision not found");
    if (!canAccessProject(actor, decision.projectId)) throw new Error("Forbidden");

    if (scheduleTaskId === null) {
        if (leadTimeDays !== null) {
            throw new Error("leadTimeDays must be null when unlinking");
        }
    } else {
        if (!Number.isInteger(leadTimeDays) || (leadTimeDays as number) < LEAD_TIME_MIN || (leadTimeDays as number) > LEAD_TIME_MAX) {
            throw new Error(`leadTimeDays must be a whole number between ${LEAD_TIME_MIN} and ${LEAD_TIME_MAX} when linking to a schedule task`);
        }
        const task = await prisma.scheduleTask.findFirst({
            where: { id: scheduleTaskId, projectId: decision.projectId },
            select: { id: true },
        });
        if (!task) {
            throw new Error("That schedule task doesn't belong to this project — refresh and try again.");
        }
    }

    const updated = await prisma.decision.updateMany({
        where: { id: decisionId, deletedAt: null },
        data: { scheduleTaskId, leadTimeDays },
    });
    if (updated.count === 0) throw new Error("Decision not found");

    (deps.revalidate ?? defaultRevalidate)(decision.projectId);
    return { success: true };
}

/** ADMIN/MANAGER only — the "GTR admin override" that always wins. Sets or
 * clears (dueDate: null) the manual override; clearing returns the decision
 * to its derived (or no) due date. Never reads or writes scheduleTaskId/
 * leadTimeDays. */
export async function setDecisionDueDateOverride(
    decisionId: string,
    dueDate: Date | null,
    deps: LinkActionDependencies = {},
): Promise<{ success: true }> {
    // Auth before lookup (Codex review round 1, issue 11) — isAdminOrManager
    // doesn't even need the decision's projectId, so this check runs
    // entirely before any decision lookup.
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor || !isAdminOrManager(actor)) throw new Error("Forbidden");

    const decision = await prisma.decision.findFirst({
        where: { id: decisionId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!decision) throw new Error("Decision not found");

    const updated = await prisma.decision.updateMany({
        where: { id: decisionId, deletedAt: null },
        data: { dueDate },
    });
    if (updated.count === 0) throw new Error("Decision not found");

    (deps.revalidate ?? defaultRevalidate)(decision.projectId);
    return { success: true };
}
