import { getSessionOrDev } from "./auth";
import { prisma } from "./prisma";

export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "RESTORE";
export type AuditActor = { id: string | null; email: string | null };

/**
 * A Prisma client/transaction handle that can write AuditLog rows. Accepting a
 * narrow shape lets callers pass either `prisma`/`prismaBase` or a transaction
 * client (`tx`) so the audit write is atomic with the mutation.
 */
type AuditWriter = { auditLog: { create: (args: any) => Promise<unknown> } };

/** Resolve the acting user from the session (falls back to the dev session locally). */
export async function getAuditActor(): Promise<AuditActor> {
    try {
        const session = await getSessionOrDev();
        const email = session?.user?.email ?? null;
        const id = (session?.user as any)?.id ?? null;
        return { id, email };
    } catch {
        return { id: null, email: null };
    }
}

/** Convert a row (Prisma Decimals/Dates included) into a JSON-safe snapshot value. */
function toJsonSafe(value: unknown): any {
    return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Write one audit entry. Pass a transaction client as `db` to make the write
 * atomic with the surrounding mutation (used by the delete/restore cascades).
 */
export async function writeAudit(
    db: AuditWriter,
    params: {
        entity: string;
        entityId: string;
        action: AuditAction;
        actor: AuditActor;
        snapshot?: unknown;
    }
): Promise<void> {
    await db.auditLog.create({
        data: {
            entity: params.entity,
            entityId: params.entityId,
            action: params.action,
            actorId: params.actor.id,
            actorEmail: params.actor.email,
            snapshot: params.snapshot === undefined ? undefined : toJsonSafe(params.snapshot),
        },
    });
}

/**
 * Best-effort audit write for non-critical CREATE/UPDATE events. Resolves the actor
 * itself and never throws — a failed audit must not break the underlying operation.
 */
export async function recordAuditSafe(params: {
    entity: string;
    entityId: string;
    action: AuditAction;
    snapshot?: unknown;
}): Promise<void> {
    try {
        const actor = await getAuditActor();
        await writeAudit(prisma, { ...params, actor });
    } catch (err) {
        console.error("[audit] failed to record", params.entity, params.action, err);
    }
}
