import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cancelMessagesForLead } from "./cancellation";
import { pushToJustin } from "./push";
import { createOutreachDraft } from "./approval";
import { FOLLOWUP_BUSINESS_DAY_OFFSETS } from "./constants";

/** Goal 8: "Manual Booked and Called buttons, and reminders to Justin." Any signed-in user may press these (spec Approval "Who") — they only cancel. */
export async function markLeadBooked(leadId: string, db: PrismaClient = prisma): Promise<void> {
    await db.lead.updateMany({ where: { id: leadId, bookedAt: null }, data: { bookedAt: new Date() } });
    await cancelMessagesForLead(leadId, "booked", db);
}

export async function markLeadCalled(leadId: string, db: PrismaClient = prisma): Promise<void> {
    await db.lead.updateMany({ where: { id: leadId, calledAt: null }, data: { calledAt: new Date() } });
    await cancelMessagesForLead(leadId, "called", db);
}

/** Weekdays only (no holiday calendar in v1) — adds `days` business days to `from`. */
export function addBusinessDays(from: Date, days: number): Date {
    const result = new Date(from);
    let remaining = days;
    while (remaining > 0) {
        result.setUTCDate(result.getUTCDate() + 1);
        const weekday = result.getUTCDay();
        if (weekday !== 0 && weekday !== 6) remaining--;
    }
    return result;
}

export interface FollowupCandidate {
    leadId: string;
    offsetDays: number;
}

/**
 * Spec Goal 8: "At +1 and +3 business days a push offers a follow-up draft,
 * which needs approval." Finds leads whose intake fell exactly on a +1/+3
 * business-day boundary as of `now`, with no personal reply and no booking
 * yet, and that don't already have a live FOLLOWUP draft.
 */
export async function findFollowupCandidates(now: Date, db: PrismaClient = prisma): Promise<FollowupCandidate[]> {
    const candidates: FollowupCandidate[] = [];
    for (const offsetDays of FOLLOWUP_BUSINESS_DAY_OFFSETS) {
        // A lead is due once `addBusinessDays(lead.createdAt, offsetDays) <= now`
        // and it hasn't already been offered at this offset.
        const leads = await db.lead.findMany({
            where: { personalReplyAt: null, bookedAt: null, isArchived: false },
            select: { id: true, createdAt: true },
        });
        for (const lead of leads) {
            const dueAt = addBusinessDays(lead.createdAt, offsetDays);
            if (dueAt.getTime() > now.getTime()) continue;
            const dedupeKey = `followup:${lead.id}:${offsetDays}`;
            const exists = await db.outreachMessage.findUnique({ where: { dedupeKey } });
            if (exists) continue;
            candidates.push({ leadId: lead.id, offsetDays });
        }
    }
    return candidates;
}

/** Creates the offered draft and pushes Justin — never sends anything itself. */
export async function offerFollowupDraft(candidate: FollowupCandidate, db: PrismaClient = prisma): Promise<void> {
    const lead = await db.lead.findUnique({ where: { id: candidate.leadId }, select: { name: true, client: { select: { email: true, name: true } } } });
    if (!lead?.client?.email) return;
    await createOutreachDraft({
        leadId: candidate.leadId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${candidate.leadId}:${candidate.offsetDays}`,
        content: {
            to: lead.client.email,
            subject: `Following up, ${lead.client.name ?? "there"}`,
            body: "",
            footer: "",
            threading: { inReplyTo: null, references: null, threadId: null },
        },
    }, db);
    await pushToJustin(
        "Speed-to-Lead: follow-up draft ready",
        `${lead.name} — a +${candidate.offsetDays}-business-day follow-up draft is waiting for your approval.`,
    );
}

export async function runFollowupSweep(now: Date = new Date(), db: PrismaClient = prisma): Promise<number> {
    const candidates = await findFollowupCandidates(now, db);
    for (const candidate of candidates) await offerFollowupDraft(candidate, db);
    return candidates.length;
}

/** Goal 8: "There is also a 09:00 list of unanswered and unbooked leads." */
export async function send0900Digest(db: PrismaClient = prisma): Promise<void> {
    const leads = await db.lead.findMany({
        where: { personalReplyAt: null, bookedAt: null, isArchived: false },
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 50,
    });
    if (leads.length === 0) return;
    const lines = leads.map(l => `- ${l.name} (received ${l.createdAt.toISOString().slice(0, 10)})`);
    await pushToJustin(`Speed-to-Lead: ${leads.length} unanswered/unbooked lead(s)`, lines.join("\n"));
}
