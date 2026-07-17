import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { formatCurrency } from "@/lib/utils";

// Same writer as actions.ts's logActivity, but reached via a lazy dynamic import so this
// module (imported by the cron route) never pulls in actions.ts's "use server"
// surface — see billing-core.ts's logActivityLazy for the same convention.
async function logActivityLazy(entry: Parameters<typeof import("./actions").logActivity>[0]) {
    const { logActivity } = await import("./actions");
    return logActivity(entry);
}

// Local copy of the same one-liner used by src/app/api/client-messages/route.ts and the
// portal contract components — this codebase doesn't have a shared text-utils module yet.
function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isHttpsUrl(url: string | null | undefined): url is string {
    return !!url && /^https:\/\//i.test(url);
}

// Invoice statuses a client can actually see in the portal (mirrors the filter in
// src/app/portal/page.tsx) — Draft/Paid/Canceled invoices never get a reminder.
const CLIENT_VISIBLE_INVOICE_STATUSES = ["Issued", "Overdue", "Partially Paid"];

const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_DAYS = 3; // remind for milestones due within N calendar days...
const MAX_OVERDUE_DAYS = 60; // ...through N calendar days overdue
const THROTTLE_DAYS = 6; // at most ~1 reminder/week per milestone
const BATCH_SIZE = 50; // per-run cap, oldest-due-first

export type PaymentReminderResult = {
    scanned: number;
    sent: number;
    skipped: number;
    failed: number;
    dryRun: boolean;
    errors: string[];
};

// ── Calendar-date helpers ──────────────────────────────────────────────────────
// dueDate may carry an arbitrary time-of-day depending on how it was entered, but
// "due in N days" / the reminder window are calendar-day concepts, not 24h-tick
// concepts — comparing raw millisecond deltas would put a milestone due at 11pm
// today a day off from one due at 1am today depending on what time the cron runs.
// Everything below normalizes to UTC midnight before diffing.
function utcMidnight(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function daysBetweenUtc(from: Date, to: Date): number {
    return Math.round((utcMidnight(to).getTime() - utcMidnight(from).getTime()) / DAY_MS);
}
function dueDateLabel(daysUntil: number): string {
    if (daysUntil > 1) return `due in ${daysUntil} days`;
    if (daysUntil === 1) return "due tomorrow";
    if (daysUntil === 0) return "due today";
    const daysOverdue = Math.abs(daysUntil);
    return `${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;
}

function reminderEmailHtml(opts: {
    clientName: string;
    milestoneName: string;
    invoiceCode: string;
    amount: number | string | { toString(): string };
    daysUntil: number;
    payUrl: string | null;
    companyName: string;
    phone?: string | null;
    email?: string | null;
}) {
    const { clientName, milestoneName, invoiceCode, amount, daysUntil, payUrl, companyName, phone, email } = opts;
    const isOverdue = daysUntil < 0;
    const dueLabel = dueDateLabel(daysUntil);
    // Only emit the pay link when it's https — qbInvoiceLink comes from QuickBooks and the
    // portal fallback comes from our own env config, but neither is worth trusting blind.
    const payButton = payUrl
        ? `<p style="margin-top:24px;">
            <a href="${escapeHtml(payUrl)}" style="background:#1e293b;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:600;">Pay Now</a>
        </p>`
        : "";
    return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:${isOverdue ? "#b91c1c" : "#1e293b"};margin-bottom:8px;">Payment Reminder</h2>
        <p>Hi ${escapeHtml(clientName || "there")},</p>
        <p>This is a reminder that <strong>${escapeHtml(milestoneName)}</strong> on Invoice #${escapeHtml(invoiceCode)} is <strong>${dueLabel}</strong>.</p>
        <p>Amount due: <strong>${formatCurrency(amount)}</strong></p>
        ${payButton}
        <p style="color:#9ca3af;font-size:12px;margin-top:32px;">
            ${escapeHtml(companyName)}${phone ? ` · ${escapeHtml(phone)}` : ""}${email ? ` · ${escapeHtml(email)}` : ""}
        </p>
    </div>`;
}

/**
 * Daily sweep: email clients about payment-schedule milestones due soon or
 * recently overdue. Selection rules (see migrations/payment_reminders.sql for the
 * additive columns this depends on):
 *   - PaymentSchedule.status === "Pending", dueDate set, due within the next 3
 *     calendar days through 60 calendar days overdue.
 *   - Invoice.status is one the client can actually see in the portal (Issued,
 *     Overdue, Partially Paid) — never Draft/Paid/Canceled.
 *   - Project.paymentRemindersEnabled is true (opt-in, off by default — Settings →
 *     Client Dashboard toggle).
 *   - Invoice.client.email is present (checked in the query so email-less rows
 *     never occupy the per-run batch cap).
 *   - lastReminderAt is null or <= 6 days ago, so a milestone gets at most ~1
 *     reminder/week.
 * A milestone whose sourceScheduleId points to an already-Paid EstimatePaymentSchedule
 * is skipped defensively — the estimate side can settle without the invoice-side mirror
 * following (known writer gap, tracked separately).
 *
 * Idempotent: each candidate is claimed with a conditional updateMany carrying the
 * FULL eligibility predicate before it's sent, so overlapping/retried runs can't
 * double-send (see the claim comment below). Each milestone is handled in its own
 * try/catch so one failure can't abort the run.
 *
 * dryRun (opts.dryRun, ?dryRun=1 on the route, or PAYMENT_REMINDERS_DRY_RUN=1) runs the
 * full selection and reports what would happen — no emails, no lastReminderAt writes.
 * Never throws.
 */
export async function sendPaymentReminders(opts?: { dryRun?: boolean }): Promise<PaymentReminderResult> {
    const dryRun = opts?.dryRun ?? process.env.PAYMENT_REMINDERS_DRY_RUN === "1";
    const result: PaymentReminderResult = { scanned: 0, sent: 0, skipped: 0, failed: 0, dryRun, errors: [] };
    try {
        const now = new Date();
        const todayStart = utcMidnight(now);
        // Upper bound is an EXCLUSIVE start-of-day boundary (today + WINDOW + 1) so any
        // dueDate time-of-day on the last eligible calendar day is still caught. Lower
        // bound is an INCLUSIVE start-of-day boundary for the same reason.
        const upcomingCutoff = new Date(todayStart.getTime() + (UPCOMING_WINDOW_DAYS + 1) * DAY_MS);
        const overdueFloor = new Date(todayStart.getTime() - MAX_OVERDUE_DAYS * DAY_MS);
        // lastReminderAt <= now - 6 days (inclusive: a milestone reminded exactly 6 days
        // ago is eligible again today).
        const throttleCutoff = new Date(now.getTime() - THROTTLE_DAYS * DAY_MS);

        const eligibilityWhere: Prisma.PaymentScheduleWhereInput = {
            status: "Pending",
            dueDate: { not: null, lt: upcomingCutoff, gte: overdueFloor },
            OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: throttleCutoff } }],
            invoice: {
                status: { in: CLIENT_VISIBLE_INVOICE_STATUSES },
                project: { paymentRemindersEnabled: true },
                client: { email: { not: null } },
            },
        };

        const candidates = await prisma.paymentSchedule.findMany({
            where: eligibilityWhere,
            select: {
                id: true,
                name: true,
                amount: true,
                dueDate: true,
                qbInvoiceLink: true,
                sourceScheduleId: true,
                invoice: {
                    select: {
                        id: true,
                        code: true,
                        project: { select: { id: true, name: true } },
                        client: { select: { id: true, name: true, email: true } },
                    },
                },
            },
            orderBy: [{ dueDate: "asc" }, { id: "asc" }], // deterministic across runs
            take: BATCH_SIZE,
        });

        result.scanned = candidates.length;
        if (candidates.length === 0) return result;

        // Mirror safety: batch-check which of this run's sourceScheduleIds already
        // settled on the estimate side.
        const sourceIds = candidates.map(c => c.sourceScheduleId).filter((id): id is string => !!id);
        const paidSourceIds = sourceIds.length
            ? new Set(
                  (await prisma.estimatePaymentSchedule.findMany({
                      where: { id: { in: sourceIds }, status: "Paid" },
                      select: { id: true },
                  })).map(s => s.id)
              )
            : new Set<string>();

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Golden Touch Remodeling";

        for (const schedule of candidates) {
            try {
                if (schedule.sourceScheduleId && paidSourceIds.has(schedule.sourceScheduleId)) {
                    result.skipped++;
                    continue;
                }

                const invoice = schedule.invoice;
                const clientEmail = invoice.client?.email;
                if (!clientEmail || !schedule.dueDate) {
                    result.skipped++;
                    continue;
                }

                const daysUntil = daysBetweenUtc(now, schedule.dueDate);

                if (dryRun) {
                    // Full selection ran; report what would be sent without claiming or emailing.
                    result.sent++;
                    continue;
                }

                // Claim-before-send: an atomic conditional update using the FULL eligibility
                // predicate (plus this row's id) as the where clause. Only the run that flips
                // this row from eligible->claimed gets updateMany's count===1 and proceeds to
                // send; a concurrent/overlapping run (or a retry racing the same minute) sees
                // count===0 — lastReminderAt no longer satisfies the OR clause once claimed —
                // and skips instead of double-sending. If the send itself then fails, the
                // claim is reverted (matched by the exact claimed timestamp) so the next daily
                // run can retry. The only gap this doesn't close is a crash between the claim
                // and the send/revert: that suppresses one reminder for that milestone, and
                // next week's run (throttle window) picks it back up — an acceptable tradeoff
                // for never double-sending.
                const claimedAt = new Date();
                const claim = await prisma.paymentSchedule.updateMany({
                    where: { ...eligibilityWhere, id: schedule.id },
                    data: { lastReminderAt: claimedAt },
                });
                if (claim.count !== 1) {
                    result.skipped++;
                    continue;
                }

                // Portal fallback link routes through the same one-click client-login helper
                // every other outbound portal email uses (buildClientPortalUrl — see
                // billing-core.ts's change-order emails), so a logged-out client doesn't just
                // 404 on /portal/invoices/[id].
                const { buildClientPortalUrl } = await import("./client-portal-auth");
                const portalUrl = await buildClientPortalUrl(invoice.client?.id, clientEmail, `/portal/invoices/${invoice.id}`);
                const payUrl = isHttpsUrl(schedule.qbInvoiceLink)
                    ? schedule.qbInvoiceLink
                    : isHttpsUrl(portalUrl)
                      ? portalUrl
                      : null;

                const send = await sendNotification(
                    clientEmail,
                    `Payment Reminder — Invoice #${invoice.code}`,
                    reminderEmailHtml({
                        clientName: invoice.client?.name || "",
                        milestoneName: schedule.name,
                        invoiceCode: invoice.code,
                        amount: schedule.amount,
                        daysUntil,
                        payUrl,
                        companyName,
                        phone: settings?.phone,
                        email: settings?.email,
                    }),
                    undefined,
                    { fromName: companyName, replyTo: settings?.email ?? undefined }
                );

                if (!send.success) {
                    result.failed++;
                    result.errors.push(`schedule ${schedule.id}: send failed`);
                    // Revert the claim (only if it's still exactly what we set) so a future
                    // run can retry instead of silently throttling a reminder that never sent.
                    await prisma.paymentSchedule.updateMany({
                        where: { id: schedule.id, lastReminderAt: claimedAt },
                        data: { lastReminderAt: null },
                    }).catch(() => {});
                    continue;
                }

                await logActivityLazy({
                    projectId: invoice.project?.id ?? null,
                    actorType: "SYSTEM",
                    actorName: "Payment Reminders",
                    action: "payment_reminder_sent",
                    entityType: "invoice",
                    entityId: invoice.id,
                    entityName: `Invoice ${invoice.code}`,
                    metadata: {
                        milestone: schedule.name,
                        amount: Number(schedule.amount.toString()),
                        dueDate: schedule.dueDate.toISOString(),
                        sentTo: clientEmail,
                    },
                });

                result.sent++;
            } catch (err: any) {
                result.failed++;
                result.errors.push(`schedule ${schedule.id}: ${err?.message || "unexpected error"}`);
            }
        }
        return result;
    } catch (e: any) {
        console.error("[sendPaymentReminders] failed:", e);
        result.errors.push(e?.message || "unexpected error");
        return result;
    }
}
