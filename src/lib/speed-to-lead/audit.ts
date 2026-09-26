import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Append-only OutreachEvent write, shared by every module that needs one —
 * drafts, edits, approvals, suppression/junk/bounce changes, and dispatch
 * outcomes all log through this ONE implementation rather than each having
 * its own copy that could drift (or, before this file existed, several of
 * them simply not logging at all: "logged implicitly" in a comment recorded
 * nothing).
 *
 * Never throws — an audit-logging failure must not fail the action it
 * describes.
 */
export async function logOutreachEvent(db: Db, params: { leadId?: string | null; messageId?: string | null; kind: string; detail?: unknown }): Promise<void> {
    try {
        await db.outreachEvent.create({
            data: {
                leadId: params.leadId ?? null,
                messageId: params.messageId ?? null,
                kind: params.kind,
                detail: (params.detail ?? null) as Prisma.InputJsonValue | undefined,
            },
        });
    } catch (error) {
        console.error("[speed-to-lead] failed to log OutreachEvent", error instanceof Error ? error.message : "UnknownError");
    }
}
