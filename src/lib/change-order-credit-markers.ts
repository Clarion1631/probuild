// Server-side reader for credit change-order markers (ChangeOrderBilling rows whose
// snapshot.kind === "credit"). Kept apart from billing-core so progress-billing can use it
// with a plain static import: no import cycle, and no dynamic import inside a money path.
import type { Prisma } from "@prisma/client";

/**
 * How much credit (positive cents) credit change orders took off each milestone of this
 * invoice, keyed by milestone id. The estimate mirror of such a milestone is its invoice
 * amount plus this, and v1 refuses to split or delete it. Callers read it under their own
 * invoice locks, inside their transaction.
 */
export async function creditCentsByMilestoneInTx(tx: Prisma.TransactionClient, invoiceId: string): Promise<Map<string, number>> {
    const markers = await tx.changeOrderBilling.findMany({
        where: { paymentScheduleId: null, snapshot: { path: ["invoiceId"], equals: invoiceId } },
        select: { totalCents: true, snapshot: true },
    });
    const byMilestone = new Map<string, number>();
    for (const marker of markers) {
        const snapshot = marker.snapshot as { kind?: unknown; paymentScheduleId?: unknown } | null;
        if (snapshot?.kind !== "credit" || typeof snapshot.paymentScheduleId !== "string") continue;
        byMilestone.set(snapshot.paymentScheduleId, (byMilestone.get(snapshot.paymentScheduleId) ?? 0) + Math.abs(marker.totalCents));
    }
    return byMilestone;
}
