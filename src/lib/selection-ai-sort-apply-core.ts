// Plain (non-"use server") module holding the AI Auto-Sort apply/dismiss CAS
// logic — kept out of src/lib/actions.ts so it's importable directly by
// tests. actions.ts is a "use server" file that transitively imports
// "server-only" (via selection-item-note-persistence.ts), which is not
// resolvable outside a Next.js build context — the exact reason
// selection-item-thread-core.ts/selection-item-note-persistence-core.ts are
// split out the same way. actions.ts's exported applySuggestedDecision/
// dismissSelectionSuggestion server actions are thin wrappers around the two
// functions below, using the real (default) dependencies.
//
// assertAccess/revalidate are injectable (defaulting to the real
// implementations) rather than hardcoded, for the same reason
// postSelectionItemComment injects assertAccess: getCurrentUserWithPermissions
// (via next-auth's getServerSession) and revalidatePath both require a live
// Next.js request scope — calling the real ones from a bare test process
// (no HTTP request in flight) throws. Tests inject stand-ins; production
// (actions.ts) always uses the defaults.
import { prisma } from "./prisma";
import { getCurrentUserWithPermissions, canAccessProject } from "./permissions";
import { revalidatePath } from "next/cache";

/** Staff-only access check — deliberately NOT assertDecisionActorAccess
 * (which also admits portal clients): the portal never sees suggestions, so
 * applying/dismissing one is staff-only, the same auth shape as
 * POST /api/selections/ai-sort. */
async function assertAiSortStaffAccess(projectId: string): Promise<void> {
    const user = await getCurrentUserWithPermissions();
    if (!user || !canAccessProject(user, projectId)) throw new Error("Forbidden");
}

function realRevalidate(projectId: string): void {
    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
}

export type AiSortApplyDependencies = {
    assertAccess?: (projectId: string) => Promise<void>;
    revalidate?: (projectId: string) => void;
};

/**
 * Applies one AI suggestion (chip ✓ or a row in the review modal's Apply) —
 * a dedicated CAS action, NOT assignItemToDecision, because it must
 * additionally (1) validate the TARGET decision belongs to the item's
 * project server-side (a tampered decisionId must never create a
 * cross-project assignment) and (2) guard on status: "Idea" so an item
 * archived/chosen during review can't be moved out from under that state.
 * Returns { applied: false } instead of throwing when the CAS write matches
 * zero rows (concurrently filed/deleted/archived elsewhere) — the caller
 * reports this as "skipped", never overwriting manual work.
 */
export async function applySuggestedDecision(
    itemId: string,
    decisionId: string,
    deps: AiSortApplyDependencies = {},
): Promise<{ applied: boolean }> {
    const assertAccess = deps.assertAccess ?? assertAiSortStaffAccess;
    const revalidate = deps.revalidate ?? realRevalidate;

    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!item) throw new Error("Item not found");
    await assertAccess(item.projectId);

    const decision = await prisma.decision.findFirst({
        where: { id: decisionId, projectId: item.projectId, deletedAt: null },
        select: { id: true },
    });
    if (!decision) throw new Error("That decision doesn't belong to this project — refresh and try again.");

    const claim = await prisma.selectionProposal.updateMany({
        where: { id: itemId, decisionId: null, deletedAt: null, status: "Idea" },
        data: { decisionId, suggestedDecisionId: null, suggestedAt: null },
    });
    if (claim.count === 0) {
        return { applied: false };
    }

    revalidate(item.projectId);
    return { applied: true };
}

/** Clears a persisted AI suggestion without moving the item (chip ✕). */
export async function dismissSelectionSuggestion(
    itemId: string,
    deps: AiSortApplyDependencies = {},
): Promise<{ success: true }> {
    const assertAccess = deps.assertAccess ?? assertAiSortStaffAccess;
    const revalidate = deps.revalidate ?? realRevalidate;

    const item = await prisma.selectionProposal.findFirst({
        where: { id: itemId, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (!item) throw new Error("Item not found");
    await assertAccess(item.projectId);

    await prisma.selectionProposal.updateMany({
        where: { id: itemId, deletedAt: null },
        data: { suggestedDecisionId: null, suggestedAt: null },
    });

    revalidate(item.projectId);
    return { success: true };
}
