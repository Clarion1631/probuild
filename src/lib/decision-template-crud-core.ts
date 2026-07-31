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
    const items = validateTemplateItems(input.items);

    const template = await prisma.decisionTemplate.create({
        data: { name, description, items: { create: items } },
        include: { items: { orderBy: { order: "asc" } } },
    });

    (deps.revalidate ?? defaultRevalidate)();
    return template;
}

/** Full items replace — items are few; wholesale replace keeps ordering
 * simple. Existing DecisionTemplateItem rows are deleted and recreated in a
 * transaction; this never touches Decisions already applied from this
 * template (their templateKey/name/leadTimeDays are copies, not live
 * references). */
export async function updateDecisionTemplate(
    templateId: string,
    input: DecisionTemplateInput,
    deps: TemplateCrudDependencies = {},
) {
    await requireAdminOrManager(deps);
    const existing = await prisma.decisionTemplate.findUnique({ where: { id: templateId }, select: { id: true } });
    if (!existing) throw new DecisionTemplateNotFoundError();

    const name = validateTemplateName(input.name);
    const description = validateTemplateDescription(input.description);
    const items = validateTemplateItems(input.items);

    const template = await prisma.$transaction(async (tx) => {
        await tx.decisionTemplateItem.deleteMany({ where: { templateId } });
        return tx.decisionTemplate.update({
            where: { id: templateId },
            data: { name, description, items: { create: items } },
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
