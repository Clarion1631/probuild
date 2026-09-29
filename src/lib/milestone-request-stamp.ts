import type { Prisma } from "@prisma/client";

/**
 * PaymentSchedule carries two request dates:
 *   qbInvoiceSentAt   the LAST time a payment request was emailed. Every send
 *                     and resend moves it forward ("Sent · <date>", lastEmailedAt).
 *   firstRequestedAt  the FIRST time. Set once, never moved, never cleared.
 *                     AR aging (receivables.ts) and the bank-deposit
 *                     chronology bound (deposit-ingest route) read it.
 *
 * firstRequestedAt != null implies qbInvoiceSentAt != null, so "was it ever
 * requested" is still qbInvoiceSentAt != null. "When was it first requested"
 * is firstRequestedAt ?? qbInvoiceSentAt: the fallback covers a row requested
 * before this column existed and not backfilled, or requested by the previous
 * build during a deploy. Both columns only ever hold real send times, so that
 * date is never EARLIER than the true first request.
 */

/**
 * Record the first request for these milestones. Run it in the SAME
 * transaction as, and BEFORE, this send's qbInvoiceSentAt write: COALESCE reads
 * the row's current qbInvoiceSentAt, so a milestone that was already asked for
 * keeps that earlier date instead of this send's. Column-to-column inside one
 * UPDATE, never a value read into JS first (same reason as
 * setPercentCompleteOverride in actions.ts): under a concurrent send the
 * IS NULL guard and the SET are re-evaluated against the committed row, so two
 * sends can never both set it. An old-build send that COMMITS before this
 * statement runs is kept, exactly like any other prior send — but if the old
 * build RESENDS the same still-unstamped row during the deploy window, the
 * earlier date is lost the same as before this fix: AR age can be
 * understated, while the deposit gate only ever stays conservative (it can
 * wrongly exclude a real payment, never wrongly include one). Pending only,
 * matching the whole-invoice write.
 */
export function stampFirstRequested(
    db: Pick<Prisma.TransactionClient, "$executeRaw">,
    invoiceId: string,
    milestoneIds: string[],
    at: Date,
) {
    return db.$executeRaw`
        UPDATE "PaymentSchedule"
           SET "firstRequestedAt" = COALESCE("qbInvoiceSentAt", (${at}::timestamptz AT TIME ZONE 'UTC')::timestamp(3))
         WHERE "invoiceId" = ${invoiceId}
           AND "id" = ANY(${milestoneIds}::text[])
           AND "status" = 'Pending'
           AND "firstRequestedAt" IS NULL`;
}
