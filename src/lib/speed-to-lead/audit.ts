import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Append-only `SpeedToLeadEvent` write (v1a's audit trail — the migration's
 * comment on #557 cited a static append-only test that did not exist;
 * `tests/speed-to-lead-audit-append-only.test.ts` on this branch is the real
 * one, asserting no `.update`/`.delete`/`.upsert` on this model anywhere in
 * `src/`).
 *
 * Never throws — an audit-logging failure must not fail the action it
 * describes.
 */
export async function logLeadEvent(db: Db, params: { leadId?: string | null; kind: string; actor?: string | null; detail?: unknown }): Promise<void> {
    try {
        await db.speedToLeadEvent.create({
            data: {
                leadId: params.leadId ?? null,
                kind: params.kind,
                actor: params.actor ?? null,
                detail: (params.detail ?? null) as Prisma.InputJsonValue | undefined,
            },
        });
    } catch (error) {
        console.error("[speed-to-lead] failed to log SpeedToLeadEvent", error instanceof Error ? error.message : "UnknownError");
    }
}
