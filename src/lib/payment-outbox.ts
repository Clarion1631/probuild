import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Durable notification outbox for paid milestones.
 *
 * The problem it solves: milestone-paid side effects (team alert, client receipt,
 * activity log) used to run inline AFTER the settle transaction committed. A crash
 * between commit and that inline call left a paid milestone with NO notification, and
 * nothing re-tried it.
 *
 * The fix: `enqueueMilestonePaid` writes a PENDING row INSIDE the settle transaction, so
 * it commits atomically with the payment. A drainer then delivers it:
 *   - inline fast-path right after commit (best-effort, scoped to that one schedule), and
 *   - an hourly cron backstop that recovers anything still pending after a crash.
 * Delivery goes through the canonical single-writer notifiers (notifyMilestonePaid /
 * notifyEstimateMilestonePaid), which are idempotent (receiptSentAt guard + activity-log
 * dedupe by scheduleId), so a re-claim after a mid-delivery crash never double-charges the
 * customer a receipt.
 */

export type ScheduleType = "invoice" | "estimate";

// A PROCESSING row older than this is assumed to belong to a worker that died mid-delivery,
// and is re-claimed by the next drainer.
const STALE_PROCESSING_MS = 5 * 60_000;
// A PENDING row that just failed a send waits this long before the cron retries it (so a
// down email provider isn't hammered by every subsequent settle's inline drain).
const RETRY_BACKOFF_MS = 60_000;
// Give up (mark FAILED) after this many attempts so a permanently-bad row can't loop forever.
const MAX_ATTEMPTS = 8;

/**
 * Enqueue a milestone-paid notification. MUST be called inside the settle transaction (pass
 * its tx client) so the outbox row commits atomically with the payment. Not deduped: an
 * undo + re-pay is a new settlement event that must notify again — the upstream settle claim
 * is what guarantees this runs once per event.
 */
export async function enqueueMilestonePaid(
    tx: Prisma.TransactionClient,
    input: { scheduleId: string; scheduleType: ScheduleType },
): Promise<void> {
    await tx.paymentNotification.create({
        data: {
            scheduleId: input.scheduleId,
            scheduleType: input.scheduleType,
            kind: "milestone_paid",
            status: "PENDING",
        },
    });
}

async function deliver(row: { id: string; scheduleId: string; scheduleType: string }): Promise<{ ok: boolean }> {
    const { notifyMilestonePaid, notifyEstimateMilestonePaid } = await import("./payment-notifications");
    // Pass the outbox row id as the dedupe key so the activity-log dedupe is per-settlement-EVENT,
    // not per-schedule — an undo + re-pay reuses the same scheduleId but gets a new outbox row,
    // and so correctly logs a second payment_received.
    return row.scheduleType === "estimate"
        ? notifyEstimateMilestonePaid(row.scheduleId, { dedupeKey: row.id })
        : notifyMilestonePaid(row.scheduleId, { dedupeKey: row.id });
}

/**
 * Deliver pending milestone-paid notifications.
 *  - Pass `{ scheduleId }` for the inline fast-path: delivers just the row(s) that
 *    schedule's settle just enqueued, immediately after commit.
 *  - Pass nothing for the cron backstop: delivers the backlog — never-attempted rows,
 *    failed rows past their retry backoff, and rows stuck in PROCESSING (dead worker).
 *
 * Safe to run concurrently: each row is claimed with an atomic conditional status
 * transition, so two drainers never deliver the same row.
 */
export async function drainPaymentNotifications(
    opts?: { scheduleId?: string; limit?: number },
): Promise<{ processed: number; retried: number; failed: number }> {
    const limit = opts?.limit ?? 25;
    const now = Date.now();
    const staleBefore = new Date(now - STALE_PROCESSING_MS);
    const retryBackoff = new Date(now - RETRY_BACKOFF_MS);
    const result = { processed: 0, retried: 0, failed: 0 };

    const where: Prisma.PaymentNotificationWhereInput = opts?.scheduleId
        ? { scheduleId: opts.scheduleId, status: "PENDING" }
        : {
              OR: [
                  { status: "PENDING", processingStartedAt: null },
                  { status: "PENDING", processingStartedAt: { lt: retryBackoff } },
                  { status: "PROCESSING", processingStartedAt: { lt: staleBefore } },
              ],
          };

    const candidates = await prisma.paymentNotification.findMany({
        where,
        orderBy: { createdAt: "asc" },
        select: { id: true, scheduleId: true, scheduleType: true, attempts: true, status: true },
        take: limit,
    });

    const { randomUUID } = await import("crypto");

    for (const row of candidates) {
        // Atomic claim scoped to the exact state we observed, so two concurrent drainers
        // (inline + cron) can't both transition this row to PROCESSING. The claimToken we set
        // here fences the completion update below.
        const claimToken = randomUUID();
        const claim = await prisma.paymentNotification.updateMany({
            where: {
                id: row.id,
                status: row.status,
                ...(row.status === "PROCESSING" ? { processingStartedAt: { lt: staleBefore } } : {}),
            },
            data: { status: "PROCESSING", processingStartedAt: new Date(), attempts: { increment: 1 }, claimToken },
        });
        if (claim.count === 0) continue; // another drainer already took it

        // Read back the attempts we just set — safe because we now hold the fresh lease (a
        // re-claim requires a stale processingStartedAt) — so the FAILED cap counts the true
        // value rather than the possibly-stale findMany snapshot.
        const claimed = await prisma.paymentNotification.findUnique({
            where: { id: row.id },
            select: { attempts: true },
        });
        const attempts = claimed?.attempts ?? row.attempts + 1;

        let outcome: { ok: boolean } = { ok: false };
        let lastError: string | null = null;
        try {
            outcome = await deliver({ id: row.id, scheduleId: row.scheduleId, scheduleType: row.scheduleType });
        } catch (e: any) {
            lastError = String(e?.message ?? e).slice(0, 500);
        }

        // Completion fenced on claimToken: if our lease expired and another drainer re-claimed
        // (writing a new token), this update matches 0 rows and no-ops — no overwrite of the new
        // owner's result, and the new owner's own completion still lands.
        if (outcome.ok) {
            const done = await prisma.paymentNotification.updateMany({
                where: { id: row.id, claimToken },
                data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
            }).catch(() => ({ count: 0 }));
            if (done.count > 0) result.processed++;
        } else {
            const dead = attempts >= MAX_ATTEMPTS;
            const done = await prisma.paymentNotification.updateMany({
                where: { id: row.id, claimToken },
                data: { status: dead ? "FAILED" : "PENDING", lastError },
            }).catch(() => ({ count: 0 }));
            if (done.count > 0) {
                if (dead) result.failed++;
                else result.retried++;
            }
        }
    }

    return result;
}
