// Decision Template CRUD (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md).
// Plain module (no "server-only" transitively) so it's importable directly
// by e2e specs and the verifier, the same split
// selection-ai-sort-apply-core.ts uses. actions.ts's exported
// createDecisionTemplate/updateDecisionTemplate/archiveDecisionTemplate/
// listDecisionTemplates server actions are thin wrappers around the
// functions below, using the real (default) dependencies.
//
// ADMIN/MANAGER only — template CRUD is the "GTR admin" surface (applying a
// template to a project is the separate, less-restrictive
// decision-template-apply-core.ts).
import { prisma } from "./prisma";
import { getCurrentUserWithPermissions, isAdminOrManager } from "./permissions";
import { revalidatePath } from "next/cache";
import {
    DecisionTemplateAuthError,
    DecisionTemplateNotFoundError,
    validateTemplateName,
    validateTemplateDescription,
    validateTemplateItems,
    type TemplateItemInput,
} from "./decision-template-core";

export type TemplateActor = { role: string } | null;

export type TemplateCrudDependencies = {
    // Defaults to getCurrentUserWithPermissions() (a live session). Tests
    // inject a stand-in that resolves to a specific role — the same seam
    // applySuggestedDecision uses for assertAccess — so the REAL
    // isAdminOrManager check below runs against a real (or test-seeded) user
    // without needing a live NextAuth session in the test process.
    getActor?: () => Promise<TemplateActor>;
    revalidate?: () => void;
};

async function defaultGetActor(): Promise<TemplateActor> {
    return getCurrentUserWithPermissions();
}

function defaultRevalidate(): void {
    revalidatePath("/templates/selections");
}

async function requireAdminOrManager(deps: TemplateCrudDependencies): Promise<void> {
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor || !isAdminOrManager(actor)) throw new DecisionTemplateAuthError();
}

export type DecisionTemplateInput = {
    name: string;
    description?: string | null;
    items: TemplateItemInput[];
};

export async function createDecisionTemplate(input: DecisionTemplateInput, deps: TemplateCrudDependencies = {}) {
    await requireAdminOrManager(deps);
    const name = validateTemplateName(input.name);
    const description = validateTemplateDescription(input.description);
    // A brand-new template's items are never "existing rows" — any id a
    // caller passed for one (stale UI state, tampered payload) is meaningless
    // here and must not be forwarded to Prisma's create (which would
    // otherwise happily set an arbitrary custom id instead of the normal
    // cuid()).
    const items = validateTemplateItems(input.items).map(({ id: _id, ...item }) => item);

    const template = await prisma.decisionTemplate.create({
        data: { name, description, items: { create: items } },
        include: { items: { orderBy: { order: "asc" } } },
    });

    (deps.revalidate ?? defaultRevalidate)();
    return template;
}

/** Items are updated IN PLACE by id, not delete-all-recreate (Codex review
 * round 1, issue 2): a payload item carrying an `id` (an existing row the UI
 * loaded) is updated; an item with no `id` is a genuinely new row and is
 * created; any existing row whose id is no longer present in the payload
 * (removed in the editor) is deleted. Delete-all-recreate would regenerate
 * every retained item's id on every save, which breaks per-item templateKey
 * provenance two ways: (1) renaming an item and reapplying the template
 * would then create a SECOND decision for it (the old templateKey's
 * decision no longer matches any current item, so the name-based dedupe is
 * the only thing standing between it and a duplicate), and (2) a
 * previously soft-deleted templated decision would "resurrect" under the
 * new id's templateKey instead of staying gone. Preserving ids keeps
 * applyDecisionTemplate's per-item provenance stable across edits. */
export async function updateDecisionTemplate(
    templateId: string,
    input: DecisionTemplateInput,
    deps: TemplateCrudDependencies = {},
) {
    await requireAdminOrManager(deps);
    const existing = await prisma.decisionTemplateItem.findMany({
        where: { templateId },
        select: { id: true },
    });
    if (existing.length === 0) {
        const template = await prisma.decisionTemplate.findUnique({ where: { id: templateId }, select: { id: true } });
        if (!template) throw new DecisionTemplateNotFoundError();
    }
    const existingIds = new Set(existing.map((i) => i.id));

    const name = validateTemplateName(input.name);
    const description = validateTemplateDescription(input.description);
    const items = validateTemplateItems(input.items);

    // A payload id that doesn't belong to THIS template (stale/tampered) is
    // treated as a new row — never lets a caller repoint an id from another
    // template's item.
    const retainedIds = new Set(items.map((i) => i.id).filter((id): id is string => !!id && existingIds.has(id)));
    const idsToDelete = [...existingIds].filter((id) => !retainedIds.has(id));

    const template = await prisma.$transaction(async (tx) => {
        if (idsToDelete.length > 0) {
            await tx.decisionTemplateItem.deleteMany({ where: { templateId, id: { in: idsToDelete } } });
        }
        for (const item of items) {
            if (item.id && retainedIds.has(item.id)) {
                await tx.decisionTemplateItem.update({
                    where: { id: item.id },
                    data: {
                        name: item.name,
                        area: item.area,
                        defaultLeadTimeDays: item.defaultLeadTimeDays,
                        scheduleHint: item.scheduleHint,
                        order: item.order,
                    },
                });
            } else {
                await tx.decisionTemplateItem.create({
                    data: {
                        templateId,
                        name: item.name,
                        area: item.area,
                        defaultLeadTimeDays: item.defaultLeadTimeDays,
                        scheduleHint: item.scheduleHint,
                        order: item.order,
                    },
                });
            }
        }
        return tx.decisionTemplate.update({
            where: { id: templateId },
            data: { name, description },
            include: { items: { orderBy: { order: "asc" } } },
        });
    });

    (deps.revalidate ?? defaultRevalidate)();
    return template;
}

/** Archive, never hard-delete — projects that already applied this template
 * keep working; archived templates just drop out of listDecisionTemplates'
 * active set and the apply picker. Idempotent — archiving an already-archived
 * template is a no-op re-write, not an error. */
export async function archiveDecisionTemplate(templateId: string, deps: TemplateCrudDependencies = {}) {
    await requireAdminOrManager(deps);
    const existing = await prisma.decisionTemplate.findUnique({
        where: { id: templateId },
        select: { id: true, archivedAt: true },
    });
    if (!existing) throw new DecisionTemplateNotFoundError();

    const template = await prisma.decisionTemplate.update({
        where: { id: templateId },
        data: { archivedAt: existing.archivedAt ?? new Date() },
    });

    (deps.revalidate ?? defaultRevalidate)();
    return template;
}

/** Active templates first, then archived — both alphabetical within their
 * group. Sorted in JS rather than relying on Postgres's NULLS LAST default
 * for ascending order (which would put active/null-archivedAt templates
 * LAST, the opposite of what "active first" needs). */
export async function listDecisionTemplates(deps: TemplateCrudDependencies = {}) {
    await requireAdminOrManager(deps);
    const templates = await prisma.decisionTemplate.findMany({
        orderBy: { name: "asc" },
        include: { items: { orderBy: { order: "asc" } } },
    });
    return [...templates].sort((a, b) => {
        const aArchived = a.archivedAt ? 1 : 0;
        const bArchived = b.archivedAt ? 1 : 0;
        return aArchived !== bArchived ? aArchived - bArchived : a.name.localeCompare(b.name);
    });
}
