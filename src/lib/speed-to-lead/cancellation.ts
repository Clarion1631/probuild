import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEndpoint } from "./contact-endpoint";

/**
 * Cancellation (spec "Suppression and cancellation — Cancellation"): "any
 * reply, opt-out, bounce, Booked, Called, junk mark or lead close cancels
 * every message for that lead that is still before commitment: DRAFT, READY,
 * PENDING_APPROVAL and APPROVED are all set to CANCELLED with a reason."
 *
 * Uses the SAME lock order dispatch.ts's commitment point does (pause/mode,
 * template, ContactEndpoint, lead, message) — cancellation is one of the
 * "invalidating actions" that must never deadlock against a concurrent
 * commit.
 */
const CANCELLABLE_STATUSES = ["DRAFT", "READY", "PENDING_APPROVAL", "APPROVED"] as const;

export interface CancellationResult {
    cancelledMessageIds: string[];
}

export async function cancelMessagesForLead(
    leadId: string,
    reason: string,
    db: PrismaClient = prisma,
): Promise<CancellationResult> {
    return db.$transaction(async tx => {
        // 1. pause/mode rows — same lock as dispatch's step 1, so a cancel and a
        // concurrent commit checking the pause switch can never form a cycle.
        await tx.$queryRaw`SELECT key FROM "AutomationSetting" WHERE key = ANY(${["speedToLeadPaused", "liveActivation", "firstLiveSendAt"]}) ORDER BY key FOR UPDATE`;

        const candidates = await tx.outreachMessage.findMany({
            where: { leadId, status: { in: [...CANCELLABLE_STATUSES] } },
            orderBy: { id: "asc" },
            select: { id: true, kind: true, generation: true, approvedVersionId: true },
        });

        // 2. template rows for any TEMPLATE_A candidates, sorted for a stable order.
        const templateVersionIds = new Set<string>();
        for (const c of candidates) {
            if (c.kind !== "TEMPLATE_A") continue;
            const version = await tx.outreachVersion.findFirst({ where: { messageId: c.id, generation: c.generation } });
            if (version?.templateVersionId) templateVersionIds.add(version.templateVersionId);
        }
        for (const id of [...templateVersionIds].sort()) {
            await tx.$queryRaw`SELECT id FROM "OutreachTemplate" WHERE id = ${id} FOR UPDATE`;
        }

        // 3. ContactEndpoint row for this lead's client email.
        const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { client: { select: { email: true } } } });
        const clientEmail = lead?.client?.email ?? null;
        if (clientEmail) {
            const endpoint = normalizeEndpoint(clientEmail);
            await tx.$executeRaw`INSERT INTO "ContactEndpoint" (id, endpoint, "createdAt", "updatedAt") SELECT gen_random_uuid()::text, ${endpoint}, now(), now() WHERE NOT EXISTS (SELECT 1 FROM "ContactEndpoint" WHERE endpoint = ${endpoint})`;
            await tx.$queryRaw`SELECT endpoint FROM "ContactEndpoint" WHERE endpoint = ${endpoint} FOR UPDATE`;
        }

        // 4. lead row.
        await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;

        // 5. message rows, one at a time, sorted — matches dispatch's per-message lock.
        const cancelledMessageIds: string[] = [];
        for (const c of candidates) {
            const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
                SELECT id, status FROM "OutreachMessage" WHERE id = ${c.id} FOR UPDATE`;
            const row = rows[0];
            if (!row || !(CANCELLABLE_STATUSES as readonly string[]).includes(row.status)) continue;
            await tx.outreachMessage.update({ where: { id: c.id }, data: { status: "CANCELLED" } });
            await tx.outreachEvent.create({
                data: { leadId, messageId: c.id, kind: "cancelled", detail: { reason } as Prisma.InputJsonValue },
            }).catch(() => undefined);
            cancelledMessageIds.push(c.id);
        }

        return { cancelledMessageIds };
    });
}
