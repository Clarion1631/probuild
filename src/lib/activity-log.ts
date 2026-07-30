import { prisma } from "./prisma";

// The raw activity-log writer. Deliberately NOT in actions.ts.
//
// actions.ts is a "use server" module, so every export there is a remotely
// invokable endpoint. While this function lived beside them, any caller could
// POST an arbitrary actorType/actorName/action/entity and forge history — a
// "sent_contract" event attributed to anyone they liked — even though the send
// functions themselves derive their actor from what authenticated the call.
// Moving it here removes it from the action surface entirely; only server code
// that imports it can write an audit row.
//
// Never re-export this from a "use server" module.

export type ActivityLogEntry = {
    projectId?: string | null;
    leadId?: string | null;
    actorType: string;
    actorName: string;
    actorUserId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    entityName?: string;
    metadata?: Record<string, unknown>;
};

/** Best-effort: a failed audit write must never break the operation it describes. */
export async function logActivity({
    projectId,
    leadId,
    actorType,
    actorName,
    actorUserId,
    action,
    entityType,
    entityId,
    entityName,
    metadata,
}: ActivityLogEntry) {
    try {
        await prisma.activityLog.create({
            data: {
                projectId: projectId ?? null,
                leadId: leadId ?? null,
                actorType,
                actorName,
                actorUserId: actorUserId ?? null,
                action,
                entityType: entityType ?? null,
                entityId: entityId ?? null,
                entityName: entityName ?? null,
                metadata: metadata ? JSON.stringify(metadata) : null,
            },
        });
    } catch (err) {
        console.error("[logActivity] Failed:", err);
    }
}
