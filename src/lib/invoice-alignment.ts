import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { sendNotification } from "./email";
import { formatCurrency } from "./utils";
import { drainPaymentNotifications } from "./payment-outbox";
import { getQBPayment, probeQBInvoice } from "./quickbooks";
import { getFreshQBTokens, markMilestonePaidFromQB } from "./quickbooks-payments";
import { listReceivables } from "./billing-core";

type FindingEvidence = { kind: string; detail: Record<string, unknown> };

export async function recordAlignmentFinding(paymentScheduleId: string, qbInvoiceId: string, runId: string, evidence: FindingEvidence) {
    const key = { paymentScheduleId_qbInvoiceId_kind: { paymentScheduleId, qbInvoiceId, kind: evidence.kind } };
    const now = new Date();
    await prisma.$transaction(async (tx) => {
        // Increment only for a resolved row. Concurrent detectors serialize on
        // this conditional update; after the first clears resolvedAt, the next
        // detector no longer counts the same reopen twice.
        await tx.alignmentFinding.updateMany({
            where: { paymentScheduleId, qbInvoiceId, kind: evidence.kind, resolvedAt: { not: null } },
            data: { reopenedCount: { increment: 1 } },
        });
        await tx.alignmentFinding.upsert({
            where: key,
            create: {
                paymentScheduleId,
                qbInvoiceId,
                kind: evidence.kind,
                detail: evidence.detail as Prisma.InputJsonValue,
                lastRunId: runId,
            },
            update: {
                detail: evidence.detail as Prisma.InputJsonValue,
                lastSeenAt: now,
                lastRunId: runId,
                resolvedAt: null,
            },
        });
    });
}

export async function resolveAlignmentFindingsWithEvidence(
    paymentScheduleId: string,
    qbInvoiceId: string,
    runId: string,
    observedKinds: Set<string>,
) {
    await prisma.alignmentFinding.updateMany({
        where: {
            paymentScheduleId,
            qbInvoiceId,
            resolvedAt: null,
            lastRunId: { not: runId },
            kind: { notIn: [...observedKinds] },
        },
        data: { resolvedAt: new Date() },
    });
}

export async function runInvoiceAlignmentAudit(deps: {
    getTokens?: typeof getFreshQBTokens;
    probeInvoice?: typeof probeQBInvoice;
    getPayment?: typeof getQBPayment;
    markPaid?: typeof markMilestonePaidFromQB;
    drainNotifications?: typeof drainPaymentNotifications;
} = {}) {
    const runId = randomUUID();
    const summary = { runId, checked: 0, findings: 0, healed: 0, transientErrors: 0 };
    const [tokens, settings, schedules] = await Promise.all([
        (deps.getTokens ?? getFreshQBTokens)(),
        prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { qbAlsoSendIntuitEmail: true } }),
        prisma.paymentSchedule.findMany({
            where: { status: { notIn: ["Paid", "Canceled"] }, qbInvoiceId: { not: null } },
            orderBy: { createdAt: "asc" },
            select: {
                id: true, invoiceId: true, qbInvoiceId: true, name: true, amount: true,
                sendAttemptMilestones: {
                    orderBy: { sendAttempt: { createdAt: "desc" } },
                    take: 1,
                    select: { sendAttempt: { select: { status: true } } },
                },
            },
        }),
    ]);

    for (const schedule of schedules) {
        const qbInvoiceId = schedule.qbInvoiceId!;
        summary.checked++;
        const probe = await (deps.probeInvoice ?? probeQBInvoice)(tokens, qbInvoiceId);
        if (probe.state === "error") {
            summary.transientErrors++;
            continue; // no evidence means no finding transition
        }

        const evidence: FindingEvidence[] = [];
        if (probe.state === "voided" || probe.state === "notFound") {
            evidence.push({ kind: "qbo_invoice_missing", detail: { state: probe.state, milestone: schedule.name } });
        } else {
            const amountMatches = Math.abs(probe.total - Number(schedule.amount)) <= 0.005;
            if (!amountMatches) {
                evidence.push({ kind: "amount_mismatch", detail: { probuildAmount: Number(schedule.amount), qboTotal: probe.total } });
            }

            if (amountMatches && probe.total > 0 && probe.balance <= 0) {
                const paymentId = probe.paymentTxnIds[0] || null;
                const payment = paymentId ? await (deps.getPayment ?? getQBPayment)(tokens, paymentId) : null;
                const paidAt = payment?.txnDate ? new Date(`${payment.txnDate}T12:00:00`) : new Date();
                const healed = await (deps.markPaid ?? markMilestonePaidFromQB)(schedule.id, schedule.invoiceId, {
                    paidAt,
                    referenceNumber: payment?.referenceNumber || null,
                    qbPaymentId: paymentId,
                });
                if (healed) {
                    summary.healed++;
                    await (deps.drainNotifications ?? drainPaymentNotifications)({ scheduleId: schedule.id }).catch(() => undefined);
                }
            } else if (Math.abs(probe.balance - Number(schedule.amount)) > 0.005) {
                evidence.push({ kind: "balance_mismatch", detail: { probuildOpenAmount: Number(schedule.amount), qboBalance: probe.balance } });
            }

            const deliveryStatus = schedule.sendAttemptMilestones[0]?.sendAttempt.status ?? null;
            if (settings?.qbAlsoSendIntuitEmail && deliveryStatus && ["sent", "delivered"].includes(deliveryStatus)
                && probe.emailStatus !== "EmailSent") {
                evidence.push({ kind: "email_status_mismatch", detail: { probuild: deliveryStatus, qbo: probe.emailStatus } });
            }
        }

        const observedKinds = new Set(evidence.map(item => item.kind));
        for (const item of evidence) {
            await recordAlignmentFinding(schedule.id, qbInvoiceId, runId, item);
            summary.findings++;
        }
        // Only a successful, current QBO read is evidence that an older
        // discrepancy is absent. A missing/voided/transient response never
        // auto-resolves unrelated historical findings.
        if (probe.state === "ok") {
            await resolveAlignmentFindingsWithEvidence(schedule.id, qbInvoiceId, runId, observedKinds);
        }
    }
    return summary;
}

export async function sendInvoiceLifecycleDigest() {
    const unmatchedBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [findings, deadEmail, deadQbo, unmatchedEmail, settings, receivables] = await Promise.all([
        prisma.alignmentFinding.findMany({
            where: { resolvedAt: null },
            orderBy: { lastSeenAt: "desc" },
            take: 100,
            include: { paymentSchedule: { select: { name: true, amount: true, invoice: { select: { code: true } } } } },
        }),
        prisma.emailEvent.count({ where: { lastError: { startsWith: "dead:" } } }),
        prisma.inboundQboEvent.count({ where: { lastError: { startsWith: "dead:" } } }),
        prisma.emailEvent.count({
            where: { processedAt: null, attempts: 0, createdAt: { lt: unmatchedBefore } },
        }),
        prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { notificationEmail: true, email: true, companyName: true } }),
        listReceivables(),
    ]);
    const bucketCounts = receivables.invoices
        .flatMap(invoice => invoice.unpaidMilestones)
        .reduce<Record<string, number>>((counts, milestone) => {
            counts[milestone.lifecycleBucket] = (counts[milestone.lifecycleBucket] ?? 0) + 1;
            return counts;
        }, {});
    const bucketSummary = Object.entries(bucketCounts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucket, count]) => `${bucket}: ${count}`)
        .join(" · ") || "No open milestones";
    const to = settings?.notificationEmail?.trim() || settings?.email?.trim();
    if (!to) return { sent: false, reason: "no notification email configured", findings: findings.length, deadEmail, deadQbo, unmatchedEmail, bucketCounts };
    if (!findings.length && !deadEmail && !deadQbo && !unmatchedEmail && Object.keys(bucketCounts).length === 0) {
        return { sent: false, reason: "nothing to report", findings: 0, deadEmail, deadQbo, unmatchedEmail, bucketCounts };
    }

    const rows = findings.map(finding => `<tr>
        <td style="padding:6px;border-bottom:1px solid #eee">${finding.paymentSchedule.invoice.code}</td>
        <td style="padding:6px;border-bottom:1px solid #eee">${finding.paymentSchedule.name}</td>
        <td style="padding:6px;border-bottom:1px solid #eee">${finding.kind}</td>
        <td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${formatCurrency(Number(finding.paymentSchedule.amount))}</td>
    </tr>`).join("");
    const sent = await sendNotification(
        to,
        `Invoice alignment digest — ${findings.length} unresolved finding${findings.length === 1 ? "" : "s"}`,
        `<div style="font-family:-apple-system,sans-serif;max-width:680px;margin:auto;padding:24px">
            <h2>Invoice alignment</h2>
            <p><strong>${findings.length}</strong> unresolved · <strong>${deadEmail + deadQbo}</strong> dead letters · <strong>${unmatchedEmail}</strong> unmatched email events older than 24h</p>
            <p><strong>Lifecycle radar:</strong> ${bucketSummary}</p>
            <table style="border-collapse:collapse;width:100%;font-size:13px"><tr><th>Invoice</th><th>Milestone</th><th>Finding</th><th>Amount</th></tr>${rows}</table>
        </div>`,
        undefined,
        { fromName: settings?.companyName || "ProBuild" },
    );
    return { sent: sent.success, findings: findings.length, deadEmail, deadQbo, unmatchedEmail, bucketCounts };
}
