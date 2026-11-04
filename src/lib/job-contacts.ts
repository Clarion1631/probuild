import { prisma } from "@/lib/prisma";
import { normalizeE164 } from "./phone";

// Session-free core for JobContact (extra named people on a lead/project).
// Callers authorize first: the staff server actions in actions.ts
// (assertActiveStaff + per-job scope) and the MCP tools (machine/actor auth).
// This file deliberately carries no server-action directive, so nothing here
// is a remotely invokable endpoint.
//
// Contacts are informational only. They get no portal access, no signing and
// no billing, and nothing here sends a message. The main Client stays the
// recipient of estimates, contracts and invoices.

export type JobOwner = { leadId?: string | null; projectId?: string | null };

export type JobContactInput = {
    name: string;
    email?: string | null;
    phone?: string | null;
    isOwner?: boolean;
    isPrimaryContact?: boolean;
    roleNote?: string | null;
};

export type JobContactPatch = Partial<JobContactInput>;

const NAME_MAX = 200;
const NOTE_MAX = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Exactly one of leadId / projectId. Returns the normalized single owner. */
export function resolveJobOwner(owner: JobOwner): { leadId: string } | { projectId: string } {
    const leadId = owner.leadId?.trim() || null;
    const projectId = owner.projectId?.trim() || null;
    if (leadId && projectId) throw new Error("Provide either leadId or projectId, not both.");
    if (!leadId && !projectId) throw new Error("Provide a leadId or a projectId.");
    return leadId ? { leadId } : { projectId: projectId! };
}

function cleanOptional(value: string | null | undefined, max: number, label: string): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (trimmed.length > max) throw new Error(`${label} is too long.`);
    return trimmed;
}

function cleanName(value: string | undefined): string {
    const name = value?.trim();
    if (!name) throw new Error("Contact name is required.");
    if (name.length > NAME_MAX) throw new Error("Contact name is too long.");
    return name;
}

function cleanEmail(value: string | null | undefined): string | null {
    const email = cleanOptional(value, 254, "Email");
    if (email && !EMAIL_RE.test(email)) throw new Error("Email is not valid.");
    return email;
}

function contactFields(input: JobContactPatch) {
    const out: Record<string, unknown> = {};
    if (input.name !== undefined) out.name = cleanName(input.name);
    if (input.email !== undefined) out.email = cleanEmail(input.email);
    if (input.phone !== undefined) {
        const phone = cleanOptional(input.phone, 40, "Phone");
        out.phone = phone;
        // Same normalization the Client write paths use, kept in sync with the raw value.
        out.phoneE164 = normalizeE164(phone);
    }
    if (input.isOwner !== undefined) out.isOwner = !!input.isOwner;
    if (input.isPrimaryContact !== undefined) out.isPrimaryContact = !!input.isPrimaryContact;
    if (input.roleNote !== undefined) out.roleNote = cleanOptional(input.roleNote, NOTE_MAX, "Role note");
    return out;
}

// ONE canonical owner per job. A lead that has been converted IS its project:
// reads, locks and new rows all use the project, so a stale lead URL or an old
// leadId from a caller can never create a second, divergent contact list.
export type CanonicalJob = { projectId: string | null; leadId: string | null };

// Rows that belong to this job. A project that came from a lead also matches
// rows still carrying that leadId (e.g. added in the instant before a
// conversion committed), so nothing is lost and primary clearing sees them.
function scopeWhere(c: CanonicalJob): Record<string, unknown> {
    if (!c.projectId) return { leadId: c.leadId };
    return c.leadId ? { OR: [{ projectId: c.projectId }, { leadId: c.leadId }] } : { projectId: c.projectId };
}

async function resolveCanonical(tx: any, owner: { leadId: string } | { projectId: string }): Promise<CanonicalJob> {
    if ("projectId" in owner) {
        const project = await tx.project.findUnique({ where: { id: owner.projectId }, select: { id: true, leadId: true } });
        if (!project) throw new Error("Project not found");
        return { projectId: project.id, leadId: project.leadId ?? null };
    }
    const project = await tx.project.findUnique({ where: { leadId: owner.leadId }, select: { id: true, leadId: true } });
    if (project) return { projectId: project.id, leadId: owner.leadId };
    const lead = await tx.lead.findUnique({ where: { id: owner.leadId }, select: { id: true } });
    if (!lead) throw new Error("Lead not found");
    return { projectId: null, leadId: owner.leadId };
}

function rowOwner(row: { leadId: string | null; projectId: string | null }): { leadId: string } | { projectId: string } {
    return row.projectId ? { projectId: row.projectId } : { leadId: row.leadId as string };
}

// The lock a job needs, derived without taking it.
async function lockKeyFor(tx: any, owner: { leadId: string } | { projectId: string }): Promise<string> {
    if ("leadId" in owner) return `lead:${owner.leadId}`;
    const project = await tx.project.findUnique({ where: { id: owner.projectId }, select: { leadId: true } });
    if (!project) throw new Error("Project not found");
    return project.leadId ? `lead:${project.leadId}` : `project:${owner.projectId}`;
}

// Lock protocol shared with convertLeadToProjectCore: whenever the job has a
// lead, serialize on the LEAD row (FOR NO KEY UPDATE); only a project with no
// lead locks its own row. The conversion takes the same lead lock first, so a
// contact write and a conversion cannot interleave. The canonical owner is
// resolved AFTER the lock, from fresh reads.
async function lockAndResolve(tx: any, owner: { leadId: string } | { projectId: string }): Promise<{ canonical: CanonicalJob; lockKey: string }> {
    const lockKey = await lockKeyFor(tx, owner);
    const id = lockKey.slice(lockKey.indexOf(":") + 1);
    const rows = lockKey.startsWith("lead:")
        ? await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${id} FOR NO KEY UPDATE`
        : await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${id} FOR NO KEY UPDATE`;
    if (!rows.length) throw new Error(lockKey.startsWith("lead:") ? "Lead not found" : "Project not found");
    return { canonical: await resolveCanonical(tx, owner), lockKey };
}

/** Canonical job for access checks (no lock). */
export async function resolveJobScope(owner: JobOwner, db: any = prisma): Promise<CanonicalJob> {
    return resolveCanonical(db, resolveJobOwner(owner));
}

/** Canonical job of an existing contact, for access checks (no lock). */
export async function jobScopeOfContact(contactId: string, db: any = prisma): Promise<CanonicalJob> {
    const row = await db.jobContact.findUnique({ where: { id: contactId } });
    if (!row) throw new Error("Contact not found");
    return resolveCanonical(db, rowOwner(row));
}

export async function listJobContactsCore(ownerInput: JobOwner, db: any = prisma) {
    const canonical = await resolveCanonical(db, resolveJobOwner(ownerInput));
    const contacts: any[] = await db.jobContact.findMany({
        where: scopeWhere(canonical),
        orderBy: { createdAt: "asc" },
    });

    const clientSelect = { select: { id: true, name: true, email: true, primaryPhone: true } };
    const job = canonical.projectId
        ? await db.project.findUnique({ where: { id: canonical.projectId }, select: { client: clientSelect } })
        : await db.lead.findUnique({ where: { id: canonical.leadId }, select: { client: clientSelect } });
    if (!job) throw new Error(canonical.projectId ? "Project not found" : "Lead not found");

    return {
        // The main client is shown first and is read-only here. It is the implied
        // primary contact when no JobContact is marked primary.
        mainClient: job.client
            ? { id: job.client.id, name: job.client.name, email: job.client.email, phone: job.client.primaryPhone }
            : null,
        contacts,
        mainClientIsPrimary: !contacts.some((c: any) => c.isPrimaryContact),
    };
}

export async function addJobContactCore(ownerInput: JobOwner, input: JobContactInput, db: any = prisma) {
    const owner = resolveJobOwner(ownerInput);
    const fields = contactFields({ ...input, name: input.name });
    return db.$transaction(async (tx: any) => {
        const { canonical } = await lockAndResolve(tx, owner);
        if (fields.isPrimaryContact === true) {
            await tx.jobContact.updateMany({ where: scopeWhere(canonical), data: { isPrimaryContact: false } });
        }
        // A converted lead writes to its project, never to the lead.
        const ownerData = canonical.projectId ? { projectId: canonical.projectId } : { leadId: canonical.leadId };
        return tx.jobContact.create({ data: { ...fields, ...ownerData } });
    });
}

export async function updateJobContactCore(contactId: string, patch: JobContactPatch, db: any = prisma) {
    const fields = contactFields(patch);
    return db.$transaction(async (tx: any) => {
        // Lock first, then trust only a fresh read. The unlocked read only tells
        // us WHICH lock to take; if the contact's job moved before we held it,
        // retry once with the new lock, then give up.
        let guess = await tx.jobContact.findUnique({ where: { id: contactId } });
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!guess) throw new Error("Contact not found");
            const { canonical, lockKey } = await lockAndResolve(tx, rowOwner(guess));
            const fresh = await tx.jobContact.findUnique({ where: { id: contactId } });
            if (!fresh) throw new Error("Contact not found");
            if ((await lockKeyFor(tx, rowOwner(fresh))) !== lockKey) { guess = fresh; continue; }
            if (fields.isPrimaryContact === true) {
                await tx.jobContact.updateMany({
                    where: { AND: [scopeWhere(canonical), { id: { not: contactId } }] },
                    data: { isPrimaryContact: false },
                });
            }
            const updated = await tx.jobContact.update({ where: { id: contactId }, data: fields });
            const owner: { leadId: string } | { projectId: string } = canonical.projectId
                ? { projectId: canonical.projectId }
                : { leadId: canonical.leadId as string };
            return { contact: updated, owner };
        }
        throw new Error("Contact moved while updating; try again.");
    });
}

export async function removeJobContactCore(contactId: string, db: any = prisma) {
    const existing = await db.jobContact.findUnique({ where: { id: contactId } });
    if (!existing) throw new Error("Contact not found");
    await db.jobContact.delete({ where: { id: contactId } });
    return { leadId: existing.leadId as string | null, projectId: existing.projectId as string | null };
}
