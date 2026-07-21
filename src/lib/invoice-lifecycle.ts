import { createHash, randomUUID } from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./prisma";
import { sendNotification, type NotificationOptions, type NotificationResult } from "./email";

type DbClient = Prisma.TransactionClient | PrismaClient;

export type CanonicalInvoiceStatus = "Draft" | "Issued" | "Partially Paid" | "Paid" | "Canceled";

export function deriveInvoiceStatus(input: {
    currentStatus?: string | null;
    balanceDue: number;
    issueDate?: Date | null;
    sentAt?: Date | null;
    paymentStatuses?: string[];
}): CanonicalInvoiceStatus {
    if (input.currentStatus === "Canceled") return "Canceled";
    const active = (input.paymentStatuses || []).filter((status) => status !== "Canceled");
    const anyPaid = active.some((status) => status === "Paid");
    if (input.balanceDue <= 0 || (active.length > 0 && active.every((status) => status === "Paid"))) return "Paid";
    if (anyPaid) return "Partially Paid";
    if (input.issueDate || input.sentAt) return "Issued";
    return "Draft";
}

export function displayInvoiceStatus(input: {
    status: string;
    dueDates?: Array<Date | null>;
    now?: Date;
}) {
    if (!["Issued", "Partially Paid"].includes(input.status)) return input.status;
    const now = input.now ?? new Date();
    return (input.dueDates || []).some((dueDate) => dueDate && dueDate.getTime() + 86_400_000 < now.getTime())
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
            emailBouncedAt: latest && ["bounced", "complained"].includes(latest.status)
                ? latest.terminalAt
                : null,
        },
    });
}

/** Apply one verified Resend event. The caller owns the surrounding transaction. */
export async function applyEmailEventTx(
    tx: Prisma.TransactionClient,
    event: { id: string; resendEmailId: string; type: string; occurredAt: Date },
) {
    const attempt = await tx.sendAttempt.findUnique({
        where: { resendEmailId: event.resendEmailId },
        select: { id: true, invoiceId: true, status: true, terminalAt: true },
    });
    if (!attempt) return false;

    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${attempt.invoiceId} FOR UPDATE`;
    const incoming = normalizedEmailEventType(event.type);
    const supported = new Set(["delivered", "bounced", "complained", "delayed", "failed"]);
    if (!supported.has(incoming)) {
        await tx.emailEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), claimToken: null, claimedAt: null } });
        return true;
    }

    const currentIsBad = BAD_EMAIL_STATUSES.has(attempt.status);
    const incomingIsBad = BAD_EMAIL_STATUSES.has(incoming);
    const accept = incomingIsBad
        ? !currentIsBad || !attempt.terminalAt || event.occurredAt >= attempt.terminalAt
        : !currentIsBad;

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

async function replayPendingEmailEventsForAttemptTx(
    tx: Prisma.TransactionClient,
    resendEmailId: string,
) {
    const events = await tx.emailEvent.findMany({
        where: { resendEmailId, processedAt: null },
        orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
        select: { id: true, resendEmailId: true, type: true, occurredAt: true },
    });
    for (const event of events) await applyEmailEventTx(tx, event);
}

export async function executeInvoiceSendAttempt(
    input: InvoiceSendInput,
    deps: {
        sendEmail?: SendEmail;
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
        attempt = await prisma.sendAttempt.update({
            where: { id: attempt.id },
            data: { status: "sending", lastError: null, terminalAt: null },
        });
    }

    const result = await (deps.sendEmail ?? sendNotification)(
        input.recipient,
        input.subject,
        input.html,
        undefined,
        { ...input.emailOptions, idempotencyKey: attempt.id },
    );

    if (!result.success || !result.id) {
        await prisma.sendAttempt.update({
            where: { id: attempt.id },
            data: { status: "failed", terminalAt: new Date(), lastError: "email provider failed" },
        });
        return { attemptId: attempt.id, status: "failed", resumed: false };
    }

    const providerEmailId = result.id;
    await deps.afterProviderAccepted?.(result);
    const acceptedAt = result.acceptedAt ?? attempt.createdAt;

    const finalized = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${input.invoiceId} FOR UPDATE`;
        const current = await tx.sendAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
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
                emailStatus: "sent",
                emailBouncedAt: null,
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
        await recomputeMilestoneViewProjection(tx, input.invoiceId);
        return tx.sendAttempt.findUniqueOrThrow({ where: { id: current.id }, select: { status: true } });
    });

    return { attemptId: attempt.id, status: finalized.status, resumed: Boolean(attempt.resendEmailId) };
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
        select: { id: true },
    });
    if (stranded.length === 0) return 0;
    const result = await prisma.sendAttempt.updateMany({
        where: { id: { in: stranded.map((attempt) => attempt.id) }, status: "sending" },
        data: { status: "failed", terminalAt: now, lastError: "interrupted" },
    });
    return result.count;
}

export function newSendRequestId(prefix = "send") {
    return `${prefix}:${randomUUID()}`;
}
