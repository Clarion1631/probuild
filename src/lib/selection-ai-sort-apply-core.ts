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
import { normalizeForDedupe } from "./decision-template-core";

const NEW_CATEGORY_NAME_MAX = 120;

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

export type CreateDecisionForSuggestionResult = { decisionId: string; existed: boolean };

/**
 * Resolves the review modal's "Create <name>" option to a real Decision —
 * called once per unique chosen new-category name (never once per row; the
 * modal dedupes before calling this). AUTH FIRST: unlike
 * applySuggestedDecision/dismissSelectionSuggestion above (which must look up
 * the item first to even KNOW its projectId), the caller already has
 * projectId directly here, so there is no lookup that legitimately needs to
 * happen before authorization — assertAccess runs before any Prisma call at
 * all (the round-2 lesson from decision-template-apply-core.ts's
 * requireProjectStaff).
 *
 * Runs inside ONE transaction opened with the same project-scoped Postgres
 * advisory lock as applyDecisionTemplate (decision-template-apply-core.ts) —
 * two concurrent "Create <name>" resolutions for the same category (e.g. two
 * staff both applying AI-sort review modals, or this racing a manual
 * createDecision) must not both read the same "does this name already
 * exist" snapshot and then both create, producing duplicate-looking
 * decisions. pg_advisory_xact_lock auto-releases at transaction end.
 *
 * Dedupe uses normalizeForDedupe (same shared comparison as
 * applyDecisionTemplate) against every LIVE decision on the project: a match
 * is reused ({ existed: true }), never duplicated — re-resolving the same
 * category name (e.g. a retried Apply) is always safe.
 */
export async function createDecisionForSuggestion(
    projectId: string,
    name: string,
    deps: AiSortApplyDependencies = {},
): Promise<CreateDecisionForSuggestionResult> {
    const assertAccess = deps.assertAccess ?? assertAiSortStaffAccess;
    const revalidate = deps.revalidate ?? realRevalidate;

    await assertAccess(projectId);

    const trimmed = (name ?? "").trim();
    if (!trimmed || trimmed.length > NEW_CATEGORY_NAME_MAX) {
        throw new Error(`Category name must be 1-${NEW_CATEGORY_NAME_MAX} characters`);
    }

    const result = await prisma.$transaction(async (tx) => {
        // $executeRaw, not $queryRaw — pg_advisory_xact_lock returns void.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;

        const nameNormalized = normalizeForDedupe(trimmed);
        const existingDecisions = await tx.decision.findMany({
            where: { projectId, deletedAt: null },
            select: { id: true, name: true },
        });
        const existing = existingDecisions.find((d) => normalizeForDedupe(d.name) === nameNormalized);
        if (existing) {
            return { decisionId: existing.id, existed: true };
        }

        const maxOrder = await tx.decision.aggregate({ where: { projectId }, _max: { sortOrder: true } });
        const decision = await tx.decision.create({
            data: {
                projectId,
                name: trimmed,
                sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
                createdByClient: false,
            },
        });
        return { decisionId: decision.id, existed: false };
    });

    revalidate(projectId);
    return result;
}
