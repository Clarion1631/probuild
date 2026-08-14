import type { ReceiptJourney } from "@/lib/automation-events";
import type { SerializedJourney } from "../journey-list";

/**
 * `receiptJourneys()` (automation-events.ts) returns `Date` fields; the
 * shared timeline components (`StepTimeline`, `StateChip`,
 * `isStaleBookedApi` — all in `components/shared/`) were built for
 * `SerializedJourney`, the ISO-string shape that originally crossed the
 * server→client boundary in `journey-list.tsx`. The row drill-down renders
 * server-side and never crosses that boundary, but reuses the same shared
 * components rather than reimplementing them, so it needs the same
 * serialized shape here too.
 */
export function toSerializedJourney(journey: ReceiptJourney): SerializedJourney {
    return {
        docNumber: journey.docNumber,
        fileName: journey.fileName,
        vendor: journey.vendor,
        projectName: journey.projectName,
        amountCents: journey.amountCents,
        taxCents: journey.taxCents,
        firstSeen: journey.firstSeen.toISOString(),
        lastSeen: journey.lastSeen.toISOString(),
        steps: journey.steps.map((s) => ({
            at: s.at.toISOString(),
            stage: s.stage,
            status: s.status,
            reason: s.reason,
            detail: s.detail,
        })),
        finalState: journey.finalState,
        finalReason: journey.finalReason,
        syncedExpenseId: journey.syncedExpenseId,
        syncedProjectName: journey.syncedProjectName,
        backfilled: journey.backfilled,
        driveFileId: journey.driveFileId,
        qbPurchaseId: journey.qbPurchaseId,
        keyConfirmed: journey.keyConfirmed,
        synced: journey.synced
            ? {
                expenseId: journey.synced.expenseId,
                projectId: journey.synced.projectId,
                projectName: journey.synced.projectName,
                amountCents: journey.synced.amountCents,
                vendor: journey.synced.vendor,
                receiptUrl: journey.synced.receiptUrl,
                syncedAt: journey.synced.syncedAt.toISOString(),
            }
            : null,
    };
}
