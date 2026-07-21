import { createHash, randomUUID } from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./prisma";
import { sendNotification, type NotificationOptions, type NotificationResult } from "./email";

type DbClient = Prisma.TransactionClient | PrismaClient;

export type CanonicalInvoiceStatus = "Draft" | "Issued" | "Partially Paid" | "Paid" | "Canceled";

export function deriveInvoiceStatus(input: {
    currentStatus?: string | null;
    balanceDue: number;
    totalAmount?: number;
    issueDate?: Date | null;
    sentAt?: Date | null;
    paymentStatuses?: string[];
}): CanonicalInvoiceStatus {
    if (input.currentStatus === "Canceled") return "Canceled";
    const active = (input.paymentStatuses || []).filter((status) => status !== "Canceled");
    const anyPaid = active.some((status) => status === "Paid");
    if (input.balanceDue <= 0 || (active.length > 0 && active.every((status) => status === "Paid"))) return "Paid";
    if (anyPaid || (input.totalAmount != null && input.balanceDue < input.totalAmount)) return "Partially Paid";
    if (input.issueDate || input.sentAt) return "Issued";
    return "Draft";
}

export function displayInvoiceStatus(input: {
    status: string;
    dueDates?: Array<Date | null>;
    payments?: Array<{ dueDate: Date | null; status: string }>;
    now?: Date;
}) {
    if (!["Issued", "Partially Paid"].includes(input.status)) return input.status;
    const now = input.now ?? new Date();
    const dueDates = input.payments
        ? input.payments.filter(payment => !["Paid", "Canceled"].includes(payment.status)).map(payment => payment.dueDate)
        : (input.dueDates || []);
    return dueDates.some((dueDate) => dueDate && dueDate.getTime() + 86_400_000 < now.getTime())
        ? "Overdue"
        : input.status;
}

export type InvoiceSendMilestone = {
    id: string;
    name: string;
    amount: number;
};

export type InvoiceSendInput = {
    invoiceId: string;
    recipient: string;
    sendRequestId: string;
    milestones: InvoiceSendMilestone[];
    actorName: string;
    subject: string;
    html: string;
    emailOptions?: NotificationOptions;
};

type SendEmail = typeof sendNotification;

export function canonicalSendPayloadHash(input: Pick<InvoiceSendInput, "invoiceId" | "recipient" | "milestones">) {
    const canonical = {
        invoiceId: input.invoiceId,
        recipient: input.recipient.trim().toLowerCase(),
        milestones: input.milestones
            .map((milestone) => ({ id: milestone.id, amount: milestone.amount.toFixed(2) }))
            .sort((a, b) => a.id.localeCompare(b.id)),
    };
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Rebuild milestone projections from immutable invoice-view history and the
 * accepted send attempts that made each milestone visible to the client.
 */
export async function recomputeMilestoneViewProjection(tx: DbClient, invoiceId: string) {
    const [events, attempts, milestones] = await Promise.all([
        tx.invoiceViewEvent.findMany({
            where: { invoiceId },
            orderBy: { viewedAt: "asc" },
            select: { viewedAt: true },
        }),
        tx.sendAttempt.findMany({
            where: { invoiceId, sentAt: { not: null } },
            select: {
                sentAt: true,
                milestones: { select: { paymentScheduleId: true } },
            },
        }),
        tx.paymentSchedule.findMany({ where: { invoiceId }, select: { id: true } }),
    ]);

    const firstAcceptedByMilestone = new Map<string, Date>();
    for (const attempt of attempts) {
        if (!attempt.sentAt) continue;
        for (const milestone of attempt.milestones) {
            const current = firstAcceptedByMilestone.get(milestone.paymentScheduleId);
            if (!current || attempt.sentAt < current) {
                firstAcceptedByMilestone.set(milestone.paymentScheduleId, attempt.sentAt);
            }
        }
    }

    for (const milestone of milestones) {
        const sentAt = firstAcceptedByMilestone.get(milestone.id);
        const applicable = sentAt ? events.filter((event) => event.viewedAt >= sentAt) : [];
        await tx.paymentSchedule.update({
            where: { id: milestone.id },
            data: {
                firstViewedAt: applicable[0]?.viewedAt ?? null,
                lastViewedAt: applicable.at(-1)?.viewedAt ?? null,
            },
        });
    }
}

const BAD_EMAIL_STATUSES = new Set(["bounced", "complained", "failed"]);
const MAX_EMAIL_EVENT_FAILURES = 5;

function normalizedEmailEventType(type: string) {
    const normalized = type.toLowerCase().replace(/^email\./, "");
    return normalized === "delivery_delayed" ? "delayed" : normalized;
}

async function rollUpLatestAttempt(tx: DbClient, invoiceId: string) {
    const latest = await tx.sendAttempt.findFirst({
        where: { invoiceId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { status: true, terminalAt: true },
    });
    await tx.invoice.update({
        where: { id: invoiceId },
        data: {
            emailStatus: latest?.status ?? null,
            emailBouncedAt: latest && ["bounced", "complained", "failed"].includes(latest.status)
                ? latest.terminalAt
                : null,
        },
    });
}

/** Apply one verified Resend event. The caller owns the surrounding transaction. */
export async function applyEmailEventTx(
    tx: Prisma.TransactionClient,
    event: { id: string; resendEmailId: string; type: string; occurredAt: Date; claimToken?: string },
) {
    const eventRow = await tx.emailEvent.findUnique({
        where: { id: event.id },
        select: { processedAt: true, claimToken: true },
    });
    if (eventRow?.processedAt) return true;
    if (!eventRow || (event.claimToken && eventRow.claimToken !== event.claimToken)) return false;

    const attemptRef = await tx.sendAttempt.findUnique({
        where: { resendEmailId: event.resendEmailId },
        select: { invoiceId: true },
    });
    if (!attemptRef) return false;

    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${attemptRef.invoiceId} FOR UPDATE`;
    // The invoice lock may have queued behind another worker. Re-prove event
    // ownership after acquiring it so an expired claimant cannot apply/log late.
    const ownedEvent = await tx.emailEvent.findUnique({
        where: { id: event.id },
        select: { processedAt: true, claimToken: true },
    });
    if (ownedEvent?.processedAt) return true;
    if (!ownedEvent || (event.claimToken && ownedEvent.claimToken !== event.claimToken)) return false;
    const attempt = await tx.sendAttempt.findUniqueOrThrow({
        where: { resendEmailId: event.resendEmailId },
        select: { id: true, invoiceId: true, status: true, sentAt: true, deliveredAt: true, terminalAt: true },
    });
    const incoming = normalizedEmailEventType(event.type);
    const supported = new Set(["delivered", "bounced", "complained", "delayed", "failed"]);
    if (!supported.has(incoming)) {
        await tx.emailEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), claimToken: null, claimedAt: null } });
        return true;
    }

    const currentIsBad = BAD_EMAIL_STATUSES.has(attempt.status);
    const incomingIsBad = BAD_EMAIL_STATUSES.has(incoming);
    const latestHealthyEvent = !incomingIsBad ? await tx.emailEvent.findFirst({
        where: {
            resendEmailId: event.resendEmailId,
            processedAt: { not: null },
            type: { in: ["email.delivered", "email.delivery_delayed"] },
        },
        orderBy: { occurredAt: "desc" },
        select: { occurredAt: true },
    }) : null;
    const latestHealthyAt = latestHealthyEvent?.occurredAt ?? attempt.deliveredAt ?? attempt.sentAt;
    const accept = incomingIsBad
        ? !currentIsBad || !attempt.terminalAt || event.occurredAt >= attempt.terminalAt
        : !currentIsBad && (!latestHealthyAt || event.occurredAt >= latestHealthyAt);

    if (accept) {
        await tx.sendAttempt.update({
            where: { id: attempt.id },
            data: {
                status: incoming,
                deliveredAt: incoming === "delivered" ? event.occurredAt : undefined,
                terminalAt: incomingIsBad ? event.occurredAt : undefined,
                lastError: incomingIsBad ? `resend:${incoming}` : null,
            },
        });
    }
    await tx.emailEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date(), claimToken: null, claimedAt: null, lastError: null },
    });
    await tx.activityLog.create({
        data: {
            actorType: "SYSTEM",
            actorName: "Resend webhook",
            action: `invoice_email_${incoming}`,
            entityType: "invoice",
            entityId: attempt.invoiceId,
            metadata: JSON.stringify({ resendEmailId: event.resendEmailId, occurredAt: event.occurredAt.toISOString() }),
        },
    });
    await rollUpLatestAttempt(tx, attempt.invoiceId);
    return true;
}

export async function replayPendingEmailEventsForAttemptTx(
    tx: Prisma.TransactionClient,
    resendEmailId: string,
) {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    const events = await tx.emailEvent.findMany({
        where: {
            resendEmailId,
            processedAt: null,
            attempts: { lt: MAX_EMAIL_EVENT_FAILURES },
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
        select: { id: true, resendEmailId: true, type: true, occurredAt: true, attempts: true },
    });
    for (const event of events) {
        const claimToken = randomUUID();
        const claim = await tx.emailEvent.updateMany({
            where: {
                id: event.id,
                processedAt: null,
                OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
            },
            data: { claimedAt: new Date(), claimToken },
        });
        if (!claim.count) continue;
        try {
            await applyEmailEventTx(tx, { ...event, claimToken });
        } catch (error) {
            const lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
            const dead = event.attempts + 1 === MAX_EMAIL_EVENT_FAILURES;
            const failed = await tx.emailEvent.updateMany({
                where: { id: event.id, claimToken },
                data: {
                    attempts: { increment: 1 },
                    claimedAt: null,
                    claimToken: null,
                    lastError: dead ? `dead:${lastError}` : lastError,
                    processedAt: null,
                },
            });
            if (dead && failed.count) {
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
                        metadata: JSON.stringify({ eventId: event.id, resendEmailId, attempts: MAX_EMAIL_EVENT_FAILURES, error: lastError }),
                    },
                });
            }
        }
    }
}

export async function executeInvoiceSendAttempt(
    input: InvoiceSendInput,
    deps: {
        sendEmail?: SendEmail;
        beforeRestartAttempt?: () => Promise<void>;
        afterProviderAccepted?: (result: NotificationResult) => Promise<void>;
    } = {},
) {
    if (!input.sendRequestId.trim()) throw new Error("sendRequestId is required");
    if (!input.recipient.trim()) throw new Error("recipient is required");
    if (input.milestones.length === 0) throw new Error("at least one milestone is required");

    const payloadHash = canonicalSendPayloadHash(input);
    let attempt = await prisma.sendAttempt.findUnique({ where: { sendRequestId: input.sendRequestId } });
    if (attempt && attempt.payloadHash !== payloadHash) {
        throw new Error("sendRequestId reused with a different payload");
    }

    if (!attempt) {
        const validMilestones = await prisma.paymentSchedule.count({
            where: { invoiceId: input.invoiceId, id: { in: input.milestones.map((item) => item.id) } },
        });
        if (validMilestones !== input.milestones.length) throw new Error("milestone payload does not match invoice");
        try {
            attempt = await prisma.sendAttempt.create({
                data: {
                    invoiceId: input.invoiceId,
                    recipient: input.recipient.trim(),
                    sendRequestId: input.sendRequestId,
                    payloadHash,
                    status: "sending",
                    milestones: { create: input.milestones.map((item) => ({ paymentScheduleId: item.id })) },
                },
            });
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
            attempt = await prisma.sendAttempt.findUniqueOrThrow({ where: { sendRequestId: input.sendRequestId } });
            if (attempt.payloadHash !== payloadHash) throw new Error("sendRequestId reused with a different payload");
        }
    }

    if (attempt.sentAt && attempt.resendEmailId) {
        return { attemptId: attempt.id, status: attempt.status, resumed: true };
    }

    if (attempt.status !== "sending") {
        const restartAttemptId = attempt.id;
        const restartInvoiceId = attempt.invoiceId;
        await deps.beforeRestartAttempt?.();
        attempt = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${restartInvoiceId} FOR UPDATE`;
            const current = await tx.sendAttempt.findUniqueOrThrow({ where: { id: restartAttemptId } });
            if (current.sentAt && current.resendEmailId) return current;
            await tx.sendAttempt.updateMany({
                where: {
                    id: current.id,
                    status: { not: "sending" },
                    sentAt: null,
                    resendEmailId: null,
                },
                data: { status: "sending", lastError: null, terminalAt: null },
            });
            return tx.sendAttempt.findUniqueOrThrow({ where: { id: current.id } });
        });
        if (attempt.sentAt && attempt.resendEmailId) {
            return { attemptId: attempt.id, status: attempt.status, resumed: true };
        }
    }

    const result = await (deps.sendEmail ?? sendNotification)(
        input.recipient,
        input.subject,
        input.html,
        undefined,
        { ...input.emailOptions, idempotencyKey: attempt.id },
    );

    if (!result.success || !result.id) {
        const failure = await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`;
            const current = await tx.sendAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
            if (current.sentAt && current.resendEmailId) {
                return { status: current.status, resumed: true };
            }
            const updated = await tx.sendAttempt.updateMany({
                where: { id: attempt.id, status: "sending", sentAt: null, resendEmailId: null },
                data: { status: "failed", terminalAt: new Date(), lastError: "email provider failed" },
            });
            if (updated.count) await rollUpLatestAttempt(tx, attempt.invoiceId);
            const latest = updated.count
                ? { status: "failed" }
                : await tx.sendAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true } });
            return { status: latest.status, resumed: updated.count === 0 };
        });
        return { attemptId: attempt.id, ...failure };
    }

    const providerEmailId = result.id;
    await deps.afterProviderAccepted?.(result);
    const acceptedAt = result.acceptedAt ?? attempt.createdAt;

    const finalized = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${input.invoiceId} FOR UPDATE`;
        const current = await tx.sendAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        if (current.sentAt && current.resendEmailId) {
            return { status: current.status, alreadyFinalized: true };
        }
        const sentAt = current.sentAt ?? acceptedAt;
        await tx.sendAttempt.update({
            where: { id: current.id },
            data: {
                resendEmailId: current.resendEmailId ?? providerEmailId,
                status: current.status === "sending" || current.status === "failed" ? "sent" : current.status,
                sentAt,
                terminalAt: null,
                lastError: null,
            },
        });
        await tx.paymentSchedule.updateMany({
            where: { id: { in: input.milestones.map((item) => item.id) } },
            data: { qbInvoiceSentAt: sentAt },
        });
        const invoice = await tx.invoice.findUniqueOrThrow({
            where: { id: input.invoiceId },
            select: {
                projectId: true, code: true, status: true, issueDate: true, sentAt: true, balanceDue: true,
                payments: { select: { status: true } },
            },
        });
        await tx.invoice.update({
            where: { id: input.invoiceId },
            data: {
                status: deriveInvoiceStatus({
                    currentStatus: invoice.status,
                    balanceDue: Number(invoice.balanceDue),
                    issueDate: invoice.issueDate ?? sentAt,
                    sentAt: invoice.sentAt ?? sentAt,
                    paymentStatuses: invoice.payments.map(payment => payment.status),
                }),
                issueDate: invoice.issueDate ?? sentAt,
                sentAt: invoice.sentAt ?? sentAt,
            },
        });
        for (const milestone of input.milestones) {
            await tx.activityLog.create({
                data: {
                    projectId: invoice.projectId,
                    actorType: "TEAM",
                    actorName: input.actorName,
                    action: "sent_invoice",
                    entityType: "invoice",
                    entityId: input.invoiceId,
                    entityName: `Invoice ${invoice.code}`,
                    metadata: JSON.stringify({ milestone: milestone.name, sentTo: input.recipient, sendAttemptId: current.id }),
                },
            });
        }
        await replayPendingEmailEventsForAttemptTx(tx, providerEmailId);
        await rollUpLatestAttempt(tx, input.invoiceId);
        await recomputeMilestoneViewProjection(tx, input.invoiceId);
        const completed = await tx.sendAttempt.findUniqueOrThrow({ where: { id: current.id }, select: { status: true } });
        return { status: completed.status, alreadyFinalized: false };
    });

    return {
        attemptId: attempt.id,
        status: finalized.status,
        resumed: finalized.alreadyFinalized || Boolean(attempt.resendEmailId),
    };
}

export async function markInvoiceViewedCore(
    invoiceId: string,
    clientId: string,
    deps: {
        now?: () => Date;
        source?: string;
        beforeActivityLog?: () => Promise<void>;
    } = {},
) {
    const viewedAt = deps.now?.() ?? new Date();
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: { client: true, project: { include: { client: true } } },
        });
        if (!invoice || (invoice.clientId !== clientId && invoice.project?.clientId !== clientId)) {
            throw new Error("Invoice not found");
        }
        const firstView = invoice.viewCount === 0;
        await tx.invoiceViewEvent.create({
            data: { invoiceId, viewedAt, source: deps.source ?? "portal" },
        });
        await tx.invoice.update({
            where: { id: invoiceId },
            data: {
                viewedAt: invoice.viewedAt ?? viewedAt,
                lastViewedAt: viewedAt,
                viewCount: { increment: 1 },
            },
        });
        await recomputeMilestoneViewProjection(tx, invoiceId);
        await deps.beforeActivityLog?.();
        const clientName = invoice.client?.name || invoice.project?.client?.name || "Client";
        await tx.activityLog.create({
            data: {
                projectId: invoice.projectId,
                actorType: "CLIENT",
                actorName: clientName,
                action: "viewed_invoice",
                entityType: "invoice",
                entityId: invoiceId,
                entityName: `Invoice ${invoice.code}`,
                metadata: JSON.stringify({ repeat: !firstView, viewedAt: viewedAt.toISOString() }),
            },
        });
        return {
            firstView,
            viewedAt,
            invoice: {
                id: invoice.id,
                code: invoice.code,
                projectId: invoice.projectId,
                projectName: invoice.project?.name ?? null,
                clientName,
            },
        };
    });
}

export async function sweepStrandedSendAttempts(input: { now?: Date; limit?: number } = {}) {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - 10 * 60 * 1000);
    const stranded = await prisma.sendAttempt.findMany({
        where: { status: "sending", createdAt: { lt: cutoff } },
        orderBy: { createdAt: "asc" },
        take: input.limit ?? 100,
        select: { id: true, invoiceId: true },
    });
    if (stranded.length === 0) return 0;
    let swept = 0;
    for (const attempt of stranded) {
        swept += await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`;
            const updated = await tx.sendAttempt.updateMany({
                where: { id: attempt.id, status: "sending" },
                data: { status: "failed", terminalAt: now, lastError: "interrupted" },
            });
            if (updated.count) await rollUpLatestAttempt(tx, attempt.invoiceId);
            return updated.count;
        });
    }
    return swept;
}

export function newSendRequestId(prefix = "send") {
    return `${prefix}:${randomUUID()}`;
}
