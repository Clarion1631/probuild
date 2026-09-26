import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CLOSED_LEAD_STAGES } from "@/lib/gpt-estimate";
import { cancelMessagesForLeadInTx } from "./cancellation";
import { pushToJustin } from "./push";
import { createOutreachDraft } from "./approval";
import { FOLLOWUP_BUSINESS_DAY_OFFSETS, COMMERCIAL_FOOTER, speedToLeadMode } from "./constants";

/**
 * A Speed-to-Lead-owned lead — one that actually went through this feature's
 * own intake, via its LeadIntakeEvent relation. `personalReplyAt`/`bookedAt`/
 * `calledAt` are brand-new columns this feature's migration added, so every
 * pre-existing CRM lead (created long before Speed-to-Lead existed) reads as
 * "never replied, never booked, never called" — without this scope, the very
 * first sweep after deploy would offer a follow-up draft, or list in the
 * 09:00 digest, every such legacy lead ever created.
 */
const SPEED_TO_LEAD_OWNED_LEAD_WHERE = {
    personalReplyAt: null,
    bookedAt: null,
    calledAt: null,
    isArchived: false,
    stage: { notIn: CLOSED_LEAD_STAGES },
    leadIntakeEvents: { some: {} },
} as const;

/**
 * Goal 8: "Manual Booked and Called buttons, and reminders to Justin." Any
 * signed-in user may press these (spec Approval "Who") — they only cancel.
 *
 * The lead update and the cancellation run in ONE transaction — as two
 * separate calls, a dispatch racing the gap between them could read
 * bookedAt/calledAt as still null and commit before cancellation's lock ever
 * applied (dispatch.ts's own lead-row check is the other half of closing
 * this: it re-reads bookedAt/calledAt from the SAME row this locks).
 */
export async function markLeadBooked(leadId: string, db: PrismaClient = prisma): Promise<void> {
    await db.$transaction(async tx => {
        // cancelMessagesForLeadInTx FIRST — it locks the shared rung in
        // dispatch.ts's own fixed order (pause/mode, template, ContactEndpoint,
        // then Lead FOR UPDATE). The bookedAt update must not lock Lead ahead
        // of it: a `tx.lead.updateMany` before this call takes the Lead row
        // lock first, and dispatch.ts's commit takes AutomationSetting BEFORE
        // Lead — two transactions taking those two rows in opposite orders is
        // a textbook circular-wait deadlock. Updating bookedAt AFTER reuses
        // the SAME lock cancelMessagesForLeadInTx already holds on this row.
        await cancelMessagesForLeadInTx(tx, leadId, "booked");
        await tx.lead.updateMany({ where: { id: leadId, bookedAt: null }, data: { bookedAt: new Date() } });
    });
}

export async function markLeadCalled(leadId: string, db: PrismaClient = prisma): Promise<void> {
    await db.$transaction(async tx => {
        // See markLeadBooked above — same lock-order reasoning.
        await cancelMessagesForLeadInTx(tx, leadId, "called");
        await tx.lead.updateMany({ where: { id: leadId, calledAt: null }, data: { calledAt: new Date() } });
    });
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
    /** This lead's OWN intake test-origin (LeadIntakeEvent.isTest) — never defaulted to false, or a test lead's follow-up could dispatch as a real send and even set firstLiveSendAt. */
    isTest: boolean;
}

/**
 * Spec Goal 8: "At +1 and +3 business days a push offers a follow-up draft,
 * which needs approval." Finds leads whose intake fell exactly on a +1/+3
 * business-day boundary as of `now`, with no personal reply, no booking, no
 * call logged, not closed, and that don't already have a live FOLLOWUP
 * draft — scoped to leads Speed-to-Lead actually owns (see
 * SPEED_TO_LEAD_OWNED_LEAD_WHERE).
 */
export async function findFollowupCandidates(now: Date, db: PrismaClient = prisma): Promise<FollowupCandidate[]> {
    const candidates: FollowupCandidate[] = [];
    for (const offsetDays of FOLLOWUP_BUSINESS_DAY_OFFSETS) {
        // A lead is due once `addBusinessDays(lead.createdAt, offsetDays) <= now`
        // and it hasn't already been offered at this offset.
        const leads = await db.lead.findMany({
            where: SPEED_TO_LEAD_OWNED_LEAD_WHERE,
            select: { id: true, createdAt: true, leadIntakeEvents: { select: { isTest: true }, take: 1 } },
        });
        for (const lead of leads) {
            const dueAt = addBusinessDays(lead.createdAt, offsetDays);
            if (dueAt.getTime() > now.getTime()) continue;
            const dedupeKey = `followup:${lead.id}:${offsetDays}`;
            const exists = await db.outreachMessage.findUnique({ where: { dedupeKey } });
            if (exists) continue;
            candidates.push({ leadId: lead.id, offsetDays, isTest: lead.leadIntakeEvents[0]?.isTest ?? false });
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
        isTest: candidate.isTest,
        content: {
            to: lead.client.email,
            subject: `Following up, ${lead.client.name ?? "there"}`,
            body: "",
            // Required content, never an empty footer (spec: an opt-out
            // instruction must always be present) — Justin edits body/subject
            // in the approval UI, but the compliant footer is not his to omit.
            footer: COMMERCIAL_FOOTER,
            threading: { inReplyTo: null, references: null, threadId: null },
        },
    }, db);
    await pushToJustin(
        "Speed-to-Lead: follow-up draft ready",
        `${lead.name} — a +${candidate.offsetDays}-business-day follow-up draft is waiting for your approval.`,
    );
}

/** Never runs in OFF (spec Release "Mode") — unlike the inbox poll, a follow-up draft is a forward-looking action, not a safety-critical opt-out processor, so it has no reason to run while the feature is off. */
export async function runFollowupSweep(now: Date = new Date(), db: PrismaClient = prisma): Promise<number> {
    if (speedToLeadMode() === "OFF") return 0;
    const candidates = await findFollowupCandidates(now, db);
    for (const candidate of candidates) await offerFollowupDraft(candidate, db);
    return candidates.length;
}

/** Goal 8: "There is also a 09:00 list of unanswered and unbooked leads." Scoped the same way findFollowupCandidates is — see SPEED_TO_LEAD_OWNED_LEAD_WHERE. */
export async function send0900Digest(db: PrismaClient = prisma): Promise<void> {
    const leads = await db.lead.findMany({
        where: SPEED_TO_LEAD_OWNED_LEAD_WHERE,
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 50,
    });
    if (leads.length === 0) return;
    const lines = leads.map(l => `- ${l.name} (received ${l.createdAt.toISOString().slice(0, 10)})`);
    await pushToJustin(`Speed-to-Lead: ${leads.length} unanswered/unbooked lead(s)`, lines.join("\n"));
}
