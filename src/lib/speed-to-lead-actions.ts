"use server";

import { getServerSession } from "next-auth/next";
import { revalidatePath } from "next/cache";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertActiveStaff } from "@/lib/permissions";
import { isApprover } from "@/lib/speed-to-lead/constants";
import { markLeadBooked, markLeadCalled } from "@/lib/speed-to-lead/tracking";
import { markEndpointJunk } from "@/lib/speed-to-lead/contact-endpoint";
import { markLeadIntakeJunk, promoteLeadToReal } from "@/lib/speed-to-lead/intake";
import { setSpeedToLeadPaused } from "@/lib/speed-to-lead/settings";

/**
 * Speed-to-Lead (PB-leads-001) v1a Server Actions — a dedicated file per
 * project convention (matching `src/lib/lead-note-actions.ts`'s pattern),
 * kept out of `src/lib/actions.ts` entirely so that file needs no changes
 * for this feature at all.
 *
 * Booked/Called: any active staff member. Junk, Promote and Pause: Justin
 * only (the single approver).
 */

async function requireApproverEmail(): Promise<string> {
    const session = await getServerSession(authOptions);
    const email = session?.user?.email ?? null;
    if (!isApprover(email)) throw new Error("Unauthorized");
    return email as string;
}

export async function markLeadBookedAction(leadId: string): Promise<void> {
    const user = await assertActiveStaff();
    await markLeadBooked(leadId, user?.email ?? user?.name ?? "unknown");
    revalidatePath(`/leads/${leadId}`);
}

export async function markLeadCalledAction(leadId: string): Promise<void> {
    const user = await assertActiveStaff();
    await markLeadCalled(leadId, user?.email ?? user?.name ?? "unknown");
    revalidatePath(`/leads/${leadId}`);
}

/** Justin-only. Marks the lead's own verdict JUNK and, if it has an email, the endpoint junk too — so a future lead from the same address is JUNK at intake time (triage.ts). No cancellation to run: v1a has nothing outbound to cancel. */
export async function markLeadJunkAction(leadId: string): Promise<void> {
    const approverEmail = await requireApproverEmail();
    await prisma.$transaction(async tx => {
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { client: { select: { email: true } } } });
        await markLeadIntakeJunk(leadId, tx);
        if (lead?.client?.email) await markEndpointJunk("email", lead.client.email, approverEmail, tx);
    });
    revalidatePath(`/leads/${leadId}`);
}

/** Justin-only. Never creates an alert — a later manual promotion is not a new arrival. */
export async function promoteLeadToRealAction(leadId: string): Promise<void> {
    await requireApproverEmail();
    await promoteLeadToReal(leadId);
    revalidatePath(`/leads/${leadId}`);
}

/** Justin-only kill switch. */
export async function setSpeedToLeadPausedAction(paused: boolean): Promise<void> {
    await requireApproverEmail();
    await setSpeedToLeadPaused(paused);
    revalidatePath("/settings/speed-to-lead");
}
