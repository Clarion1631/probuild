import { randomUUID } from "crypto";
import { prismaBase } from "./prisma";
import { writeAudit, type AuditActor } from "./audit";

/**
 * Cascade soft-delete + restore for the customer-data recovery net.
 * See SOFT_DELETE.md for the full cascade/invariant documentation.
 *
 * All work runs through `prismaBase` (the UN-extended client) so it can both read and
 * write soft-deleted rows. Each top-level deletion gets a unique `deleteBatchId`
 * (a UUID) that is stamped on the parent and EVERY row cascaded with it. Restore
 * reverses only the rows in that batch, so an independently-deleted sibling (a
 * different batch) is never resurrected by restoring an unrelated ancestor.
 * `deletedAt` is also stamped (for the read-filter and display).
 */

type Tx = Parameters<Parameters<typeof prismaBase.$transaction>[0]>[0];

// ───────────────────────────── DELETE (capture + mark) ─────────────────────────────

/** Soft-delete a live estimate + its live items/payment-schedules. Returns the captured subtree (or null). */
async function captureAndSoftDeleteEstimate(tx: Tx, estimateId: string, ts: Date, batchId: string, actorId: string | null) {
    const estimate = await tx.estimate.findFirst({
        where: { id: estimateId, deletedAt: null },
        include: {
            items: { where: { deletedAt: null } },
            paymentSchedules: { where: { deletedAt: null } },
        },
    });
    if (!estimate) return null;
    await tx.estimateItem.updateMany({ where: { estimateId, deletedAt: null }, data: { deletedAt: ts, deleteBatchId: batchId } });
    await tx.estimatePaymentSchedule.updateMany({ where: { estimateId, deletedAt: null }, data: { deletedAt: ts, deleteBatchId: batchId } });
    await tx.estimate.update({ where: { id: estimateId }, data: { deletedAt: ts, deletedById: actorId, deleteBatchId: batchId } });
    return estimate;
}

/** Soft-delete a live lead and cascade to its live estimates. Returns the captured subtree (or null). */
async function captureAndSoftDeleteLead(tx: Tx, leadId: string, ts: Date, batchId: string, actorId: string | null) {
    const lead = await tx.lead.findFirst({ where: { id: leadId, deletedAt: null } });
    if (!lead) return null;
    const estimates = await tx.estimate.findMany({ where: { leadId, deletedAt: null }, select: { id: true } });
    const estimateSnaps = [];
    for (const e of estimates) {
        const snap = await captureAndSoftDeleteEstimate(tx, e.id, ts, batchId, actorId);
        if (snap) estimateSnaps.push(snap);
    }
    await tx.lead.update({ where: { id: leadId }, data: { deletedAt: ts, deletedById: actorId, deleteBatchId: batchId } });
    return { ...lead, estimates: estimateSnaps };
}

/** Soft-delete a live project and cascade to its live estimates. Does NOT touch the lead (a lead may live without a project). */
async function captureAndSoftDeleteProject(tx: Tx, projectId: string, ts: Date, batchId: string, actorId: string | null) {
    const project = await tx.project.findFirst({ where: { id: projectId, deletedAt: null } });
    if (!project) return null;
    const estimates = await tx.estimate.findMany({ where: { projectId, deletedAt: null }, select: { id: true } });
    const estimateSnaps = [];
    for (const e of estimates) {
        const snap = await captureAndSoftDeleteEstimate(tx, e.id, ts, batchId, actorId);
        if (snap) estimateSnaps.push(snap);
    }
    await tx.project.update({ where: { id: projectId }, data: { deletedAt: ts, deletedById: actorId, deleteBatchId: batchId } });
    return { ...project, estimates: estimateSnaps };
}

/** Soft-delete a live client and cascade to ALL its leads and projects (and their estimates). */
async function captureAndSoftDeleteClient(tx: Tx, clientId: string, ts: Date, batchId: string, actorId: string | null) {
    const client = await tx.client.findFirst({ where: { id: clientId, deletedAt: null } });
    if (!client) return null;
    const leads = await tx.lead.findMany({ where: { clientId, deletedAt: null }, select: { id: true } });
    const projects = await tx.project.findMany({ where: { clientId, deletedAt: null }, select: { id: true } });
    const leadSnaps = [];
    for (const l of leads) {
        const snap = await captureAndSoftDeleteLead(tx, l.id, ts, batchId, actorId);
        if (snap) leadSnaps.push(snap);
    }
    const projectSnaps = [];
    for (const p of projects) {
        const snap = await captureAndSoftDeleteProject(tx, p.id, ts, batchId, actorId);
        if (snap) projectSnaps.push(snap);
    }
    await tx.client.update({ where: { id: clientId }, data: { deletedAt: ts, deletedById: actorId, deleteBatchId: batchId } });
    return { ...client, leads: leadSnaps, projects: projectSnaps };
}

export async function softDeleteEstimate(estimateId: string, actor: AuditActor): Promise<void> {
    const ts = new Date();
    const batchId = randomUUID();
    await prismaBase.$transaction(async (tx) => {
        const snapshot = await captureAndSoftDeleteEstimate(tx, estimateId, ts, batchId, actor.id);
        if (!snapshot) return;
        await writeAudit(tx, { entity: "Estimate", entityId: estimateId, action: "DELETE", actor, snapshot });
    });
}

export async function softDeleteLead(leadId: string, actor: AuditActor): Promise<void> {
    const ts = new Date();
    const batchId = randomUUID();
    await prismaBase.$transaction(async (tx) => {
        const snapshot = await captureAndSoftDeleteLead(tx, leadId, ts, batchId, actor.id);
        if (!snapshot) return;
        await writeAudit(tx, { entity: "Lead", entityId: leadId, action: "DELETE", actor, snapshot });
    });
}

export async function softDeleteProject(projectId: string, actor: AuditActor): Promise<void> {
    const ts = new Date();
    const batchId = randomUUID();
    await prismaBase.$transaction(async (tx) => {
        const snapshot = await captureAndSoftDeleteProject(tx, projectId, ts, batchId, actor.id);
        if (!snapshot) return;
        await writeAudit(tx, { entity: "Project", entityId: projectId, action: "DELETE", actor, snapshot });
    });
}

export async function softDeleteClient(clientId: string, actor: AuditActor): Promise<void> {
    const ts = new Date();
    const batchId = randomUUID();
    await prismaBase.$transaction(async (tx) => {
        const snapshot = await captureAndSoftDeleteClient(tx, clientId, ts, batchId, actor.id);
        if (!snapshot) return;
        await writeAudit(tx, { entity: "Client", entityId: clientId, action: "DELETE", actor, snapshot });
    });
}

// ───────────────────────────── RESTORE (batch-matched) ─────────────────────────────

/**
 * Restore the children of the given estimates. Children are 1:1 with their estimate and
 * are only ever soft-deleted alongside it, so FK scoping (estimateId) is sufficient.
 */
async function restoreEstimateChildren(tx: Tx, estimateIds: string[]) {
    if (!estimateIds.length) return;
    await tx.estimateItem.updateMany({ where: { estimateId: { in: estimateIds }, deletedAt: { not: null } }, data: { deletedAt: null, deleteBatchId: null } });
    await tx.estimatePaymentSchedule.updateMany({ where: { estimateId: { in: estimateIds }, deletedAt: { not: null } }, data: { deletedAt: null, deleteBatchId: null } });
}

/** Build a where that selects rows belonging to a cascade batch (falls back to ts for legacy null-batch rows). */
function batchScope(extra: Record<string, unknown>, batchId: string | null, ts: Date) {
    return batchId ? { ...extra, deleteBatchId: batchId } : { ...extra, deletedAt: ts };
}

export async function restoreEstimateRecord(estimateId: string, actor: AuditActor): Promise<void> {
    await prismaBase.$transaction(async (tx) => {
        const estimate = await tx.estimate.findUnique({ where: { id: estimateId } });
        if (!estimate || !estimate.deletedAt) return;
        await restoreEstimateChildren(tx, [estimateId]);
        await tx.estimate.update({ where: { id: estimateId }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        await writeAudit(tx, { entity: "Estimate", entityId: estimateId, action: "RESTORE", actor });
    });
}

/** Restore a lead and the estimates cascaded with it (same batch). Used directly and by project/client restore. */
async function restoreLeadInTx(tx: Tx, leadId: string, actor: AuditActor): Promise<boolean> {
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead || !lead.deletedAt) return false;
    const estimates = await tx.estimate.findMany({ where: batchScope({ leadId }, lead.deleteBatchId, lead.deletedAt), select: { id: true } });
    const estIds = estimates.map((e) => e.id);
    await restoreEstimateChildren(tx, estIds);
    if (estIds.length) {
        await tx.estimate.updateMany({ where: { id: { in: estIds } }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
    }
    await tx.lead.update({ where: { id: leadId }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
    await writeAudit(tx, { entity: "Lead", entityId: leadId, action: "RESTORE", actor });
    return true;
}

export async function restoreLeadRecord(leadId: string, actor: AuditActor): Promise<void> {
    await prismaBase.$transaction(async (tx) => {
        await restoreLeadInTx(tx, leadId, actor);
    });
}

export async function restoreProjectRecord(projectId: string, actor: AuditActor): Promise<void> {
    await prismaBase.$transaction(async (tx) => {
        const project = await tx.project.findUnique({ where: { id: projectId } });
        if (!project || !project.deletedAt) return;
        const estimates = await tx.estimate.findMany({ where: batchScope({ projectId }, project.deleteBatchId, project.deletedAt), select: { id: true } });
        const estIds = estimates.map((e) => e.id);
        await restoreEstimateChildren(tx, estIds);
        if (estIds.length) {
            await tx.estimate.updateMany({ where: { id: { in: estIds } }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        }
        await tx.project.update({ where: { id: projectId }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        // INVARIANT (project_every_project_has_lead): a live project must have a live
        // lead. If this project's lead is soft-deleted (e.g. the whole client was
        // trashed), restore the lead too so the restored project is never lead-less.
        if (project.leadId) {
            const lead = await tx.lead.findUnique({ where: { id: project.leadId } });
            if (lead?.deletedAt) {
                await restoreLeadInTx(tx, project.leadId, actor);
            }
        }
        await writeAudit(tx, { entity: "Project", entityId: projectId, action: "RESTORE", actor });
    });
}

export async function restoreClientRecord(clientId: string, actor: AuditActor): Promise<void> {
    await prismaBase.$transaction(async (tx) => {
        const client = await tx.client.findUnique({ where: { id: clientId } });
        if (!client || !client.deletedAt) return;
        const batchId = client.deleteBatchId;
        const ts = client.deletedAt;
        const leads = await tx.lead.findMany({ where: batchScope({ clientId }, batchId, ts), select: { id: true } });
        const projects = await tx.project.findMany({ where: batchScope({ clientId }, batchId, ts), select: { id: true } });
        const leadIds = leads.map((l) => l.id);
        const projectIds = projects.map((p) => p.id);
        const estimates = await tx.estimate.findMany({
            where: batchScope({ OR: [{ leadId: { in: leadIds } }, { projectId: { in: projectIds } }] }, batchId, ts),
            select: { id: true },
        });
        const estimateIds = estimates.map((e) => e.id);
        await restoreEstimateChildren(tx, estimateIds);
        if (estimateIds.length) {
            await tx.estimate.updateMany({ where: { id: { in: estimateIds } }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        }
        await tx.lead.updateMany({ where: batchScope({ clientId }, batchId, ts), data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        await tx.project.updateMany({ where: batchScope({ clientId }, batchId, ts), data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        await tx.client.update({ where: { id: clientId }, data: { deletedAt: null, deletedById: null, deleteBatchId: null } });
        await writeAudit(tx, { entity: "Client", entityId: clientId, action: "RESTORE", actor });
    });
}

// ───────────────────────────── TRASH / AUDIT LISTING (admin UI) ─────────────────────────────

export type TrashItem = {
    entity: "Client" | "Lead" | "Project" | "Estimate";
    id: string;
    label: string;
    sublabel: string;
    deletedAt: string;
    deletedById: string | null;
};

/**
 * List the TOP-LEVEL soft-deleted records for the admin Trash view. A record is hidden
 * when an ancestor is also in the trash (restoring the ancestor brings it back), so each
 * row maps 1:1 to a user-initiated deletion.
 */
export async function listTrash(): Promise<TrashItem[]> {
    const [clients, leads, projects, estimates] = await Promise.all([
        prismaBase.client.findMany({
            where: { deletedAt: { not: null } },
            select: { id: true, name: true, companyName: true, deletedAt: true, deletedById: true },
            orderBy: { deletedAt: "desc" },
        }),
        prismaBase.lead.findMany({
            where: { deletedAt: { not: null } },
            select: { id: true, name: true, clientId: true, stage: true, deletedAt: true, deletedById: true, client: { select: { name: true } } },
            orderBy: { deletedAt: "desc" },
        }),
        prismaBase.project.findMany({
            where: { deletedAt: { not: null } },
            select: { id: true, name: true, clientId: true, status: true, deletedAt: true, deletedById: true, client: { select: { name: true } } },
            orderBy: { deletedAt: "desc" },
        }),
        prismaBase.estimate.findMany({
            where: { deletedAt: { not: null } },
            select: { id: true, title: true, code: true, leadId: true, projectId: true, deletedAt: true, deletedById: true },
            orderBy: { deletedAt: "desc" },
        }),
    ]);

    const trashedClientIds = new Set(clients.map((c) => c.id));
    const trashedLeadIds = new Set(leads.map((l) => l.id));
    const trashedProjectIds = new Set(projects.map((p) => p.id));

    const items: TrashItem[] = [];

    for (const c of clients) {
        items.push({
            entity: "Client",
            id: c.id,
            label: c.name,
            sublabel: c.companyName || "Client",
            deletedAt: c.deletedAt!.toISOString(),
            deletedById: c.deletedById ?? null,
        });
    }
    for (const l of leads) {
        if (l.clientId && trashedClientIds.has(l.clientId)) continue; // restored via client
        items.push({
            entity: "Lead",
            id: l.id,
            label: l.name,
            sublabel: `Lead · ${l.client?.name ?? "—"} · ${l.stage}`,
            deletedAt: l.deletedAt!.toISOString(),
            deletedById: l.deletedById ?? null,
        });
    }
    for (const p of projects) {
        if (p.clientId && trashedClientIds.has(p.clientId)) continue; // restored via client
        items.push({
            entity: "Project",
            id: p.id,
            label: p.name,
            sublabel: `Project · ${p.client?.name ?? "—"} · ${p.status}`,
            deletedAt: p.deletedAt!.toISOString(),
            deletedById: p.deletedById ?? null,
        });
    }
    for (const e of estimates) {
        // Hide estimates restored via their parent lead/project.
        if (e.leadId && trashedLeadIds.has(e.leadId)) continue;
        if (e.projectId && trashedProjectIds.has(e.projectId)) continue;
        items.push({
            entity: "Estimate",
            id: e.id,
            label: e.title || e.code,
            sublabel: `Estimate · ${e.code}`,
            deletedAt: e.deletedAt!.toISOString(),
            deletedById: e.deletedById ?? null,
        });
    }

    items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
    return items;
}

export type AuditEntry = {
    id: string;
    entity: string;
    entityId: string;
    action: string;
    actorEmail: string | null;
    createdAt: string;
};

export async function listAuditLog(limit = 200): Promise<AuditEntry[]> {
    const rows = await prismaBase.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, entity: true, entityId: true, action: true, actorEmail: true, createdAt: true },
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
