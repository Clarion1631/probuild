// Apply-a-template-to-a-project flow (Phase 3 —
// docs/superpowers/plans/2026-07-31-selection-templates-due-dates.md). Plain
// module, importable directly by e2e specs/the verifier — mirrors
// selection-ai-sort-apply-core.ts's split from its CRUD-ish sibling.
//
// Deliberately a DIFFERENT (looser) authorization bar than
// decision-template-crud-core.ts: applying a template is authorized for ANY
// staff member with canAccessProject — the same bar createDecision uses
// today — NOT ADMIN/MANAGER. Template CRUD is the restricted "GTR admin"
// surface; applying one is routine project work.
import { prisma } from "./prisma";
import { getCurrentUserWithPermissions, canAccessProject } from "./permissions";
import { revalidatePath } from "next/cache";
import { buildTemplateKey, DecisionTemplateNotFoundError } from "./decision-template-core";

export type ApplyActor = {
    role: string;
    projectAccess?: { projectId: string }[];
    assignedProjects?: { id: string }[];
} | null;

export type ApplyDependencies = {
    getActor?: () => Promise<ApplyActor>;
    revalidate?: (projectId: string) => void;
};

async function defaultGetActor(): Promise<ApplyActor> {
    return getCurrentUserWithPermissions();
}

function defaultRevalidate(projectId: string): void {
    revalidatePath(`/projects/${projectId}/selections`);
    revalidatePath(`/portal/projects/${projectId}/selections`);
}

async function requireProjectStaff(projectId: string, deps: ApplyDependencies): Promise<ApplyActor> {
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor || !canAccessProject(actor, projectId)) throw new Error("Forbidden");
    return actor;
}

/** Active templates + their item previews, for the "Apply template" picker
 * on the staff selections page. Staff-only (any role with a session) — no
 * project scoping needed since nothing is written here. */
export async function listActiveDecisionTemplatesForApply(deps: Pick<ApplyDependencies, "getActor"> = {}) {
    const actor = await (deps.getActor ?? defaultGetActor)();
    if (!actor) throw new Error("Forbidden");
    return prisma.decisionTemplate.findMany({
        where: { archivedAt: null },
        orderBy: { name: "asc" },
        include: { items: { orderBy: { order: "asc" } } },
    });
}

export type ApplyDecisionTemplateResult = { created: number; skipped: string[] };

/**
 * Creates one Decision per template item, in item order, appended after the
 * project's existing sortOrder (createDecision precedent). Each Decision
 * gets a PER-ITEM templateKey ("decision-template:<templateId>:<itemId>") —
 * Decision has @@unique([projectId, templateKey]), so a shared per-template
 * key would make every item after the first fail. Items whose name matches
 * an existing LIVE decision on the project case-insensitively are skipped
 * and reported, never duplicated — re-applying the same template is always
 * safe.
 */
export async function applyDecisionTemplate(
    projectId: string,
    templateId: string,
    deps: ApplyDependencies = {},
): Promise<ApplyDecisionTemplateResult> {
    await requireProjectStaff(projectId, deps);

    const template = await prisma.decisionTemplate.findUnique({
        where: { id: templateId },
        include: { items: { orderBy: { order: "asc" } } },
    });
    if (!template) throw new DecisionTemplateNotFoundError();

    const existingDecisions = await prisma.decision.findMany({
        where: { projectId, deletedAt: null },
        select: { name: true },
    });
    const existingNamesLower = new Set(existingDecisions.map((d) => d.name.trim().toLowerCase()));

    const maxOrder = await prisma.decision.aggregate({ where: { projectId }, _max: { sortOrder: true } });
    let nextSortOrder = (maxOrder._max.sortOrder ?? -1) + 1;

    const skipped: string[] = [];
    let created = 0;
    for (const item of template.items) {
        const nameLower = item.name.trim().toLowerCase();
        if (existingNamesLower.has(nameLower)) {
            skipped.push(item.name);
            continue;
        }

        const templateKey = buildTemplateKey(template.id, item.id);
        try {
            await prisma.decision.create({
                data: {
                    projectId,
                    name: item.name,
                    area: item.area,
                    templateKey,
                    leadTimeDays: item.defaultLeadTimeDays,
                    sortOrder: nextSortOrder,
                },
            });
        } catch (err) {
            // Defensive: templateKey is permanent even across a soft-deleted
            // Decision (deletedAt doesn't participate in the
            // @@unique([projectId, templateKey]) constraint), so a template
            // item whose prior Decision was soft-deleted (and therefore
            // excluded from existingNamesLower above) would otherwise throw
            // a raw P2002 here. Treat that the same as a name-match skip —
            // re-applying never duplicates, and never crashes either.
            if (isUniqueConstraintError(err)) {
                skipped.push(item.name);
                continue;
            }
            throw err;
        }

        existingNamesLower.add(nameLower); // guard within-batch duplicate item names too
        nextSortOrder += 1;
        created += 1;
    }

    (deps.revalidate ?? defaultRevalidate)(projectId);
    return { created, skipped };
}

function isUniqueConstraintError(err: unknown): boolean {
    return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}
