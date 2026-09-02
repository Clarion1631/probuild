/**
 * Orphaned-object bookkeeping.
 *
 * When an intake row is rejected (oversize, wrong format, empty) the object it
 * pointed at has to go too — the row is deleted, so after that NOTHING in the
 * database references those bytes and they would sit in a private bucket
 * forever. Storage deletes fail for the same boring reasons every other call
 * does, so "best effort, shrug" is not good enough on a path we take
 * deliberately.
 *
 * An AutomationEvent is used rather than a new table: this is rare, it is
 * already the audit surface the Command Center reads, and a table for it would
 * be schema churn for a queue that should normally be empty.
 */
import { logAutomationEvent } from "@/lib/automation-events";
import { prisma } from "@/lib/prisma";
import { removeSecureDoc, toSecureRef } from "@/lib/secure-storage";

export const STORAGE_CLEANUP_KIND = "storage-cleanup-pending";

/**
 * Delete the object. If that fails, record the path so the sweep can retry.
 * Never throws: the caller is already rejecting a row and must not be derailed
 * by the cleanup of it.
 */
export async function deleteObjectOrRecord(storagePath: string, reason: string): Promise<boolean> {
    try {
        await removeSecureDoc(toSecureRef(storagePath));
        return true;
    } catch (error) {
        console.error("[receipts/intake] object delete failed", storagePath, error instanceof Error ? error.name : "error");
        await logAutomationEvent({
            kind: STORAGE_CLEANUP_KIND,
            status: "pending",
            reason,
            source: "receipt-intake",
            detail: { storagePath },
        }).catch(() => { /* audit only — the orphan is the lesser problem */ });
        return false;
    }
}

/**
 * Retry the deletions that failed earlier. Bounded per pass, like every other
 * housekeeping step in the worker, and it resolves each event it clears so the
 * queue drains instead of growing.
 */
export async function retryPendingCleanups(limit: number, shouldStop: () => boolean): Promise<number> {
    const pending = await prisma.automationEvent.findMany({
        where: { kind: STORAGE_CLEANUP_KIND, status: "pending" },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, detail: true },
    });

    let cleared = 0;
    for (const event of pending) {
        if (shouldStop()) break;
        let storagePath: string | null = null;
        try {
            storagePath = (JSON.parse(event.detail ?? "{}") as { storagePath?: string }).storagePath ?? null;
        } catch {
            storagePath = null;
        }
        if (!storagePath) {
            // Unparseable detail can never be acted on; close it rather than
            // retrying it every five minutes forever.
            await prisma.automationEvent.update({ where: { id: event.id }, data: { status: "abandoned" } });
            continue;
        }
        try {
            await removeSecureDoc(toSecureRef(storagePath));
            await prisma.automationEvent.update({ where: { id: event.id }, data: { status: "resolved" } });
            cleared++;
        } catch {
            // Still failing. Leave it pending for the next pass.
        }
    }
    return cleared;
}
