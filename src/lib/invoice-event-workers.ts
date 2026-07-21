import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { applyEmailEventTx, sweepStrandedSendAttempts } from "./invoice-lifecycle";
import { drainPaymentNotifications } from "./payment-outbox";
import { getQBPayment, probeQBInvoice } from "./quickbooks";
import { getFreshQBTokens, markMilestonePaidFromQB } from "./quickbooks-payments";
import { recordAlignmentFinding, resolveAlignmentFindingsWithEvidence } from "./invoice-alignment";
import type { QBTokens } from "./quickbooks";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type DrainCounts = { processed: number; retried: number; dead: number; unmatched: number };

async function logEmailDeadLetter(eventId: string, resendEmailId: string, claimToken: string, lastError: string) {
    return prisma.$transaction(async (tx) => {
        const done = await tx.emailEvent.updateMany({
            where: { id: eventId, claimToken },
            data: {
                attempts: { increment: 1 },
                claimedAt: null,
                claimToken: null,
                lastError: `dead:${lastError}`,
                processedAt: null,
            },
        });
        if (!done.count) return false;
        const attempt = await tx.sendAttempt.findUnique({
            where: { resendEmailId },
            select: { invoiceId: true, invoice: { select: { projectId: true, code: true } } },
        });
        await tx.activityLog.create({
            data: {
                projectId: attempt?.invoice.projectId ?? null,
                actorType: "SYSTEM",
                actorName: "Invoice lifecycle worker",
                action: "invoice_email_dead_letter",
                entityType: "invoice",
                entityId: attempt?.invoiceId ?? null,
                entityName: attempt ? `Invoice ${attempt.invoice.code}` : null,
                metadata: JSON.stringify({ eventId, resendEmailId, attempts: MAX_ATTEMPTS, error: lastError }),
            },
        });
        return true;
    });
}

export async function drainEmailEvents(limit: number): Promise<DrainCounts> {
    const result = { processed: 0, retried: 0, dead: 0, unmatched: 0 };
    const staleBefore = new Date(Date.now() - LEASE_MS);
    const unmatchedRows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS "count"
        FROM "EmailEvent" e
        LEFT JOIN "SendAttempt" s ON s."resendEmailId" = e."resendEmailId"
        WHERE e."processedAt" IS NULL AND e."attempts" = 0 AND s."id" IS NULL
    `);
    result.unmatched = unmatchedRows[0]?.count ?? 0;
    // Join before limiting so a burst of pre-finalization events cannot keep
    // matched events behind it from ever reaching the worker.
    const candidateIds = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT e."id"
        FROM "EmailEvent" e
        INNER JOIN "SendAttempt" s ON s."resendEmailId" = e."resendEmailId"
        WHERE e."processedAt" IS NULL
          AND e."attempts" < ${MAX_ATTEMPTS}
          AND (e."claimedAt" IS NULL OR e."claimedAt" < ${staleBefore})
        ORDER BY e."createdAt" ASC
        LIMIT ${limit}
    `);
    const candidates = await prisma.emailEvent.findMany({
        where: { id: { in: candidateIds.map(row => row.id) } },
        orderBy: { createdAt: "asc" },
    });

    for (const row of candidates) {
        // Provider events can win the race with send finalization. Keep them
        // pending, unclaimed, and at zero attempts until that attempt appears.
        const claimToken = randomUUID();
        const claim = await prisma.emailEvent.updateMany({
            where: {
                id: row.id,
                processedAt: null,
                attempts: row.attempts,
                OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
            },
            data: { claimedAt: new Date(), claimToken },
        });
        if (claim.count === 0) continue;
        const attemptNumber = row.attempts + 1;
        try {
            const processed = await prisma.$transaction(async (tx) => {
                const owned = await tx.emailEvent.findFirst({
                    where: { id: row.id, claimToken },
                    select: { id: true, resendEmailId: true, type: true, occurredAt: true },
                });
                if (!owned) return false;
                return applyEmailEventTx(tx, { ...owned, claimToken });
            });
            if (processed) result.processed++;
        } catch (error) {
            const lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
            const dead = attemptNumber === MAX_ATTEMPTS;
            if (dead) {
                if (await logEmailDeadLetter(row.id, row.resendEmailId, claimToken, lastError)) result.dead++;
            } else {
                const retry = await prisma.emailEvent.updateMany({
                    where: { id: row.id, claimToken },
                    data: {
                        attempts: { increment: 1 },
                        claimedAt: null,
                        claimToken: null,
                        lastError,
                        processedAt: null,
                    },
                });
                if (retry.count) result.retried++;
            }
        }
    }
    return result;
}

type QboProcessingDeps = {
    getTokens?: typeof getFreshQBTokens;
    getPayment?: typeof getQBPayment;
    probeInvoice?: typeof probeQBInvoice;
    markPaid?: typeof markMilestonePaidFromQB;
    drainNotifications?: typeof drainPaymentNotifications;
};

async function settleQboInvoice(
    tokens: QBTokens,
    qbInvoiceId: string,
    runId: string,
    paymentIdHint?: string,
    deps: QboProcessingDeps = {},
) {
    const schedules = await prisma.paymentSchedule.findMany({
        where: { qbInvoiceId },
        select: { id: true, invoiceId: true, amount: true, status: true },
    });
    if (schedules.length === 0) return;
    if (schedules.length !== 1) {
        for (const schedule of schedules) {
            await recordAlignmentFinding(schedule.id, qbInvoiceId, runId, {
                kind: "duplicate_qbo_mapping",
                detail: { mappingCount: schedules.length },
            });
        }
        return;
    }
    const probe = await (deps.probeInvoice ?? probeQBInvoice)(tokens, qbInvoiceId);
    if (probe.state !== "ok" || probe.total <= 0) return;
    const schedule = schedules[0];
    const observedKinds = new Set<string>();
    if (Math.abs(Number(schedule.amount) - probe.total) > 0.005) {
        observedKinds.add("amount_mismatch");
        await recordAlignmentFinding(schedule.id, qbInvoiceId, runId, {
            kind: "amount_mismatch",
            detail: { probuildAmount: Number(schedule.amount), qboTotal: probe.total },
        });
    }
    if (probe.balance > 0 && Math.abs(Number(schedule.amount) - probe.balance) > 0.005) {
        observedKinds.add("balance_mismatch");
        await recordAlignmentFinding(schedule.id, qbInvoiceId, runId, {
            kind: "balance_mismatch",
            detail: { probuildOpenAmount: Number(schedule.amount), qboBalance: probe.balance },
        });
    }
    await resolveAlignmentFindingsWithEvidence(schedule.id, qbInvoiceId, runId, observedKinds);
    if (observedKinds.size || probe.balance > 0 || ["Paid", "Canceled"].includes(schedule.status)) return;

    const paymentId = paymentIdHint || probe.paymentTxnIds[0] || null;
    const payment = paymentId ? await (deps.getPayment ?? getQBPayment)(tokens, paymentId) : null;
    const paidAt = payment?.txnDate ? new Date(`${payment.txnDate}T12:00:00`) : new Date();
    const recorded = await (deps.markPaid ?? markMilestonePaidFromQB)(schedule.id, schedule.invoiceId, {
        paidAt,
        referenceNumber: payment?.referenceNumber || null,
        qbPaymentId: paymentId,
    });
    if (recorded) await (deps.drainNotifications ?? drainPaymentNotifications)({ scheduleId: schedule.id }).catch(() => undefined);
}

export async function processQboEvent(
    row: { id: string; realmId: string; entity: string; entityQboId: string },
    deps: QboProcessingDeps = {},
) {
    const tokens = await (deps.getTokens ?? getFreshQBTokens)();
    if (tokens.realmId !== row.realmId) throw new Error("realm-mismatch-quarantined");
    const runId = `qbo-event:${row.id}`;
    if (row.entity.toLowerCase() === "invoice") {
        await settleQboInvoice(tokens, row.entityQboId, runId, undefined, deps);
        return;
    }
    if (row.entity.toLowerCase() === "payment") {
        const payment = await (deps.getPayment ?? getQBPayment)(tokens, row.entityQboId);
        if (!payment) throw new Error("QBO payment was not readable");
        for (const qbInvoiceId of payment.linkedInvoiceIds) {
            await settleQboInvoice(tokens, qbInvoiceId, runId, row.entityQboId, deps);
        }
    }
}

async function logQboDeadLetter(
    row: { id: string; entity: string; entityQboId: string },
    claimToken: string,
    lastError: string,
) {
    return prisma.$transaction(async (tx) => {
        const done = await tx.inboundQboEvent.updateMany({
            where: { id: row.id, claimToken },
            data: { claimedAt: null, claimToken: null, lastError: `dead:${lastError}`, processedAt: null },
        });
        if (!done.count) return false;
        const schedule = row.entity.toLowerCase() === "invoice"
            ? await tx.paymentSchedule.findFirst({
                where: { qbInvoiceId: row.entityQboId },
                select: { invoiceId: true, invoice: { select: { projectId: true, code: true } } },
            })
            : null;
        await tx.activityLog.create({
            data: {
                projectId: schedule?.invoice.projectId ?? null,
                actorType: "SYSTEM",
                actorName: "Invoice lifecycle worker",
                action: "qbo_event_dead_letter",
                entityType: schedule ? "invoice" : "qbo_event",
                entityId: schedule?.invoiceId ?? row.id,
                entityName: schedule ? `Invoice ${schedule.invoice.code}` : `${row.entity} ${row.entityQboId}`,
                metadata: JSON.stringify({ eventId: row.id, entity: row.entity, entityQboId: row.entityQboId, attempts: MAX_ATTEMPTS, error: lastError }),
            },
        });
        return true;
    });
}

export async function drainQboEvents(
    limit: number,
    deps: { processEvent?: typeof processQboEvent } = {},
): Promise<DrainCounts> {
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
            await (deps.processEvent ?? processQboEvent)(row);
            const done = await prisma.inboundQboEvent.updateMany({
                where: { id: row.id, claimToken },
                data: { processedAt: new Date(), claimedAt: null, claimToken: null, lastError: null },
            });
            if (done.count) result.processed++;
        } catch (error) {
            const lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
            const dead = attemptNumber === MAX_ATTEMPTS;
            if (dead) {
                if (await logQboDeadLetter(row, claimToken, lastError)) result.dead++;
            } else {
                const done = await prisma.inboundQboEvent.updateMany({
                    where: { id: row.id, claimToken },
                    data: { claimedAt: null, claimToken: null, lastError, processedAt: null },
                });
                if (done.count) result.retried++;
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
