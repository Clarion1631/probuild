import { prisma } from "@/lib/prisma";
import { normalizeE164 } from "./phone";

// Session-free core for JobContact (extra named people on a lead/project).
// Callers authorize first: the staff server actions in actions.ts
// (assertActiveStaff) and the MCP tools (machine/actor auth). This file
// deliberately carries no server-action directive, so nothing here is a
// remotely invokable endpoint.
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

// Rows that belong to the same job as `owner`. For a project that also covers
// rows still pointing at the lead it was converted from, so nothing is lost if
// a conversion ever leaves leadId in place.
async function jobScope(tx: any, owner: { leadId: string } | { projectId: string }) {
    if ("leadId" in owner) return { where: { leadId: owner.leadId } };
    const project = await tx.project.findUnique({
        where: { id: owner.projectId },
        select: { id: true, leadId: true },
    });
    if (!project) throw new Error("Project not found");
    return {
        where: project.leadId
            ? { OR: [{ projectId: project.id }, { leadId: project.leadId }] }
            : { projectId: project.id },
    };
}

async function assertOwnerExists(tx: any, owner: { leadId: string } | { projectId: string }) {
    if ("leadId" in owner) {
        const lead = await tx.lead.findUnique({ where: { id: owner.leadId }, select: { id: true } });
        if (!lead) throw new Error("Lead not found");
    } else {
        const project = await tx.project.findUnique({ where: { id: owner.projectId }, select: { id: true } });
        if (!project) throw new Error("Project not found");
    }
}

// Serializes concurrent primary-contact changes on one job so "at most one
// primary" holds without a partial unique index (Prisma cannot express one and
// check-migrations-match would flag the drift).
async function lockOwnerRow(tx: any, owner: { leadId: string } | { projectId: string }) {
    if ("leadId" in owner) await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${owner.leadId} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${owner.projectId} FOR UPDATE`;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
    const seen = new Set<string>();
    return rows.filter(row => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

export async function listJobContactsCore(ownerInput: JobOwner, db: any = prisma) {
    const owner = resolveJobOwner(ownerInput);
    const scope = await jobScope(db, owner);
    const rows = await db.jobContact.findMany({
        where: scope.where,
        orderBy: { createdAt: "asc" },
    });

    const clientSelect = { select: { id: true, name: true, email: true, primaryPhone: true } };
    const job = "leadId" in owner
        ? await db.lead.findUnique({ where: { id: owner.leadId }, select: { client: clientSelect } })
        : await db.project.findUnique({ where: { id: owner.projectId }, select: { client: clientSelect } });
    if (!job) throw new Error("leadId" in owner ? "Lead not found" : "Project not found");

    const contacts = dedupeById<any>(rows);
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
        await assertOwnerExists(tx, owner);
        await lockOwnerRow(tx, owner);
        if (fields.isPrimaryContact === true) {
            const scope = await jobScope(tx, owner);
            await tx.jobContact.updateMany({ where: scope.where, data: { isPrimaryContact: false } });
        }
        return tx.jobContact.create({ data: { ...fields, ...owner } });
    });
}

export async function updateJobContactCore(contactId: string, patch: JobContactPatch, db: any = prisma) {
    const fields = contactFields(patch);
    return db.$transaction(async (tx: any) => {
        const existing = await tx.jobContact.findUnique({ where: { id: contactId } });
        if (!existing) throw new Error("Contact not found");
        const owner = existing.leadId ? { leadId: existing.leadId as string } : { projectId: existing.projectId as string };
        await lockOwnerRow(tx, owner);
        if (fields.isPrimaryContact === true) {
            const scope = await jobScope(tx, owner);
            await tx.jobContact.updateMany({
                where: { AND: [scope.where, { id: { not: contactId } }] },
                data: { isPrimaryContact: false },
            });
        }
        const updated = await tx.jobContact.update({ where: { id: contactId }, data: fields });
        return { contact: updated, owner };
    });
}

export async function removeJobContactCore(contactId: string, db: any = prisma) {
    const existing = await db.jobContact.findUnique({ where: { id: contactId } });
    if (!existing) throw new Error("Contact not found");
    await db.jobContact.delete({ where: { id: contactId } });
    return { leadId: existing.leadId as string | null, projectId: existing.projectId as string | null };
}
