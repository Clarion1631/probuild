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
import { buildTemplateKey, DecisionTemplateNotFoundError, normalizeForDedupe } from "./decision-template-core";

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
 * an existing LIVE decision on the project (normalizeForDedupe — Codex
 * review round 2, N1) are skipped and reported, never duplicated —
 * re-applying the same template is always safe.
 *
 * The whole thing runs inside ONE interactive transaction, opened with a
 * project-scoped Postgres advisory lock (Codex review round 1, issues 3+4):
 * without it, two concurrent applies (or an apply racing a manual
 * createDecision) could both read the same "existing names"/"max sortOrder"
 * snapshot and then both write, producing duplicate-looking decisions with
 * colliding sortOrder — and a mid-loop failure would leave a partial apply
 * committed with no way to tell which items actually landed. The advisory
 * lock serializes concurrent applies on the SAME project (other projects are
 * unaffected — hashtext(projectId) scopes the lock key); the transaction
 * makes the whole apply atomic, so any failure rolls back to nothing rather
 * than a partially-applied template. pg_advisory_xact_lock auto-releases at
 * transaction end (commit or rollback) — no manual unlock needed.
 */
export async function applyDecisionTemplate(
    projectId: string,
    templateId: string,
    deps: ApplyDependencies = {},
): Promise<ApplyDecisionTemplateResult> {
    await requireProjectStaff(projectId, deps);

    // Archived templates are hidden from the apply picker but are NOT
    // otherwise deleted — reject applying one directly too (Codex review
    // round 1, issue 1), e.g. a stale picker tab or a replayed request.
    const template = await prisma.decisionTemplate.findFirst({
        where: { id: templateId, archivedAt: null },
        include: { items: { orderBy: { order: "asc" } } },
    });
    if (!template) throw new DecisionTemplateNotFoundError();

    return prisma.$transaction(async (tx) => {
        // $executeRaw, not $queryRaw — pg_advisory_xact_lock returns void,
        // which $queryRaw's result-set deserialization can't handle
        // ("Failed to deserialize column of type 'void'"); $executeRaw
        // doesn't try to parse a result set at all.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;

        const existingDecisions = await tx.decision.findMany({
            where: { projectId, deletedAt: null },
            select: { name: true },
        });
        const existingNamesNormalized = new Set(existingDecisions.map((d) => normalizeForDedupe(d.name)));

        const maxOrder = await tx.decision.aggregate({ where: { projectId }, _max: { sortOrder: true } });
        let nextSortOrder = (maxOrder._max.sortOrder ?? -1) + 1;

        const skipped: string[] = [];
        let created = 0;
        for (const item of template.items) {
            const nameNormalized = normalizeForDedupe(item.name);
            if (existingNamesNormalized.has(nameNormalized)) {
                skipped.push(item.name);
                continue;
            }

            const templateKey = buildTemplateKey(template.id, item.id);
            const existingByKey = await tx.decision.findFirst({
                where: { projectId, templateKey },
                select: { id: true },
            });
            if (existingByKey) {
                // templateKey is permanent even across a soft-deleted
                // Decision (deletedAt doesn't participate in the
                // @@unique([projectId, templateKey]) constraint), so a
                // template item whose prior Decision was soft-deleted (and
                // therefore excluded from existingNamesNormalized above)
                // would otherwise collide on that unique constraint. Treat
                // that the same as a name-match skip — re-applying never
                // duplicates, and never crashes either.
                skipped.push(item.name);
                continue;
            }

            await tx.decision.create({
                data: {
                    projectId,
                    name: item.name,
                    area: item.area,
                    templateKey,
                    leadTimeDays: item.defaultLeadTimeDays,
                    sortOrder: nextSortOrder,
                },
            });

            existingNamesNormalized.add(nameNormalized); // guard within-batch duplicate item names too
            nextSortOrder += 1;
            created += 1;
        }

        return { created, skipped };
    }).then((result) => {
        // Counts are only returned after commit — revalidate now that the
        // whole apply is durable.
        (deps.revalidate ?? defaultRevalidate)(projectId);
        return result;
    });
}
