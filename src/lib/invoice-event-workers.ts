import { randomUUID } from "crypto";
import { prisma } from "./prisma";
import { applyEmailEventTx, sweepStrandedSendAttempts } from "./invoice-lifecycle";
import { drainPaymentNotifications } from "./payment-outbox";
import { getQBPayment, probeQBInvoice } from "./quickbooks";
import { getFreshQBTokens, markMilestonePaidFromQB } from "./quickbooks-payments";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type DrainCounts = { processed: number; retried: number; dead: number; unmatched: number };

async function drainEmailEvents(limit: number): Promise<DrainCounts> {
    const result = { processed: 0, retried: 0, dead: 0, unmatched: 0 };
    const staleBefore = new Date(Date.now() - LEASE_MS);
    const candidates = await prisma.emailEvent.findMany({
        where: {
            processedAt: null,
            attempts: { lt: MAX_ATTEMPTS },
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
    });

    for (const row of candidates) {
        // Provider events can win the race with send finalization. Keep them
        // pending, unclaimed, and at zero attempts until that attempt appears.
        const matched = await prisma.sendAttempt.findUnique({ where: { resendEmailId: row.resendEmailId }, select: { id: true } });
        if (!matched) {
            result.unmatched++;
            continue;
        }

        const claimToken = randomUUID();
        const claim = await prisma.emailEvent.updateMany({
            where: {
                id: row.id,
                processedAt: null,
                attempts: row.attempts,
                OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
            },
            data: { claimedAt: new Date(), claimToken, attempts: { increment: 1 } },
        });
        if (claim.count === 0) continue;
        const attemptNumber = row.attempts + 1;
        try {
            await prisma.$transaction(async (tx) => {
                const owned = await tx.emailEvent.findFirst({
                    where: { id: row.id, claimToken },
                    select: { id: true, resendEmailId: true, type: true, occurredAt: true },
                });
                if (!owned) return;
                await applyEmailEventTx(tx, owned);
            });
            result.processed++;
        } catch (error) {
            const lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
            const dead = attemptNumber === MAX_ATTEMPTS;
            await prisma.emailEvent.updateMany({
                where: { id: row.id, claimToken },
                data: {
                    claimedAt: null,
                    claimToken: null,
                    lastError: dead ? `dead:${lastError}` : lastError,
                    processedAt: dead ? new Date() : null,
                },
            });
            if (dead) result.dead++;
            else result.retried++;
        }
    }
    return result;
}

async function settleQboInvoice(qbInvoiceId: string, paymentIdHint?: string) {
    const tokens = await getFreshQBTokens();
    const schedules = await prisma.paymentSchedule.findMany({
        where: { qbInvoiceId, status: { not: "Paid" } },
        select: { id: true, invoiceId: true },
    });
    if (schedules.length === 0) return;
    const probe = await probeQBInvoice(tokens, qbInvoiceId);
    if (probe.state !== "ok" || probe.total <= 0 || probe.balance > 0) return;

    const paymentId = paymentIdHint || probe.paymentTxnIds[0] || null;
    const payment = paymentId ? await getQBPayment(tokens, paymentId) : null;
    const paidAt = payment?.txnDate ? new Date(`${payment.txnDate}T12:00:00`) : new Date();
    for (const schedule of schedules) {
        const recorded = await markMilestonePaidFromQB(schedule.id, schedule.invoiceId, {
            paidAt,
            referenceNumber: payment?.referenceNumber || null,
            qbPaymentId: paymentId,
        });
        if (recorded) await drainPaymentNotifications({ scheduleId: schedule.id }).catch(() => undefined);
    }
}

async function processQboEvent(entity: string, entityQboId: string) {
    if (entity.toLowerCase() === "invoice") {
        await settleQboInvoice(entityQboId);
        return;
    }
    if (entity.toLowerCase() === "payment") {
        const tokens = await getFreshQBTokens();
        const payment = await getQBPayment(tokens, entityQboId);
        if (!payment) throw new Error("QBO payment was not readable");
        for (const qbInvoiceId of payment.linkedInvoiceIds) {
            await settleQboInvoice(qbInvoiceId, entityQboId);
        }
    }
}

async function drainQboEvents(limit: number): Promise<DrainCounts> {
    const result = { processed: 0, retried: 0, dead: 0, unmatched: 0 };
    const staleBefore = new Date(Date.now() - LEASE_MS);
    const candidates = await prisma.inboundQboEvent.findMany({
        where: {
            processedAt: null,
            attempts: { lt: MAX_ATTEMPTS },
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        take: limit,
    });

    for (const row of candidates) {
        const claimToken = randomUUID();
        const claim = await prisma.inboundQboEvent.updateMany({
            where: {
                id: row.id,
                processedAt: null,
                attempts: row.attempts,
                OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
            },
            data: { claimedAt: new Date(), claimToken, attempts: { increment: 1 } },
        });
        if (claim.count === 0) continue;
        const attemptNumber = row.attempts + 1;
        try {
            await processQboEvent(row.entity, row.entityQboId);
            const done = await prisma.inboundQboEvent.updateMany({
                where: { id: row.id, claimToken },
                data: { processedAt: new Date(), claimedAt: null, claimToken: null, lastError: null },
            });
            if (done.count) result.processed++;
        } catch (error) {
            const lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
            const dead = attemptNumber === MAX_ATTEMPTS;
            const done = await prisma.inboundQboEvent.updateMany({
                where: { id: row.id, claimToken },
                data: {
                    claimedAt: null,
                    claimToken: null,
                    lastError: dead ? `dead:${lastError}` : lastError,
                    processedAt: dead ? new Date() : null,
                },
            });
            if (done.count) {
                if (dead) result.dead++;
                else result.retried++;
            }
        }
    }
    return result;
}

export async function drainInvoiceLifecycleEvents(options: { limit?: number } = {}) {
    const limit = options.limit ?? 50;
    const [email, qbo, strandedSends] = await Promise.all([
        drainEmailEvents(limit),
        drainQboEvents(limit),
        sweepStrandedSendAttempts({ limit }),
    ]);
    return { email, qbo, strandedSends };
}
