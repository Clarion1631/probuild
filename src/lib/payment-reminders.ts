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

// Invoice statuses a client can actually see in the portal (mirrors the filter in
// src/app/portal/page.tsx) — Draft/Paid/Canceled invoices never get a reminder.
const CLIENT_VISIBLE_INVOICE_STATUSES = ["Issued", "Overdue", "Partially Paid"];

const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_DAYS = 3; // remind for milestones due within N days...
const MAX_OVERDUE_DAYS = 60; // ...through N days overdue
const THROTTLE_DAYS = 6; // at most ~1 reminder/week per milestone

export type PaymentReminderResult = {
    scanned: number;
    sent: number;
    skipped: number;
    failed: number;
    errors: string[];
};

function dueDateLabel(dueDate: Date, now: Date): string {
    const daysUntil = Math.round((dueDate.getTime() - now.getTime()) / DAY_MS);
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
    dueDate: Date;
    now: Date;
    payUrl: string;
    companyName: string;
    phone?: string | null;
    email?: string | null;
}) {
    const { clientName, milestoneName, invoiceCode, amount, dueDate, now, payUrl, companyName, phone, email } = opts;
    const isOverdue = dueDate.getTime() < now.getTime();
    const dueLabel = dueDateLabel(dueDate, now);
    return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:${isOverdue ? "#b91c1c" : "#1e293b"};margin-bottom:8px;">Payment Reminder</h2>
        <p>Hi ${clientName || "there"},</p>
        <p>This is a reminder that <strong>${milestoneName}</strong> on Invoice #${invoiceCode} is <strong>${dueLabel}</strong>.</p>
        <p>Amount due: <strong>${formatCurrency(amount)}</strong></p>
        <p style="margin-top:24px;">
            <a href="${payUrl}" style="background:#1e293b;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:600;">Pay Now</a>
        </p>
        <p style="color:#9ca3af;font-size:12px;margin-top:32px;">
            ${companyName}${phone ? ` · ${phone}` : ""}${email ? ` · ${email}` : ""}
        </p>
    </div>`;
}

/**
 * Daily sweep: email clients about payment-schedule milestones due soon or
 * recently overdue. Selection rules (see migrations/payment_reminders.sql for the
 * additive columns this depends on):
 *   - PaymentSchedule.status === "Pending", dueDate set, due within the next 3
 *     days through 60 days overdue.
 *   - Invoice.status is one the client can actually see in the portal (Issued,
 *     Overdue, Partially Paid) — never Draft/Paid/Canceled.
 *   - Project.paymentRemindersEnabled is true (Settings → Client Dashboard toggle).
 *   - lastReminderAt is null or older than 6 days, so a milestone gets at most
 *     ~1 reminder/week.
 * Each milestone is sent+updated independently so one failure can't abort the run.
 * Never throws.
 */
export async function sendPaymentReminders(): Promise<PaymentReminderResult> {
    const result: PaymentReminderResult = { scanned: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
    try {
        const now = new Date();
        const upcomingCutoff = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * DAY_MS);
        const overdueFloor = new Date(now.getTime() - MAX_OVERDUE_DAYS * DAY_MS);
        const throttleCutoff = new Date(now.getTime() - THROTTLE_DAYS * DAY_MS);

        const candidates = await prisma.paymentSchedule.findMany({
            where: {
                status: "Pending",
                dueDate: { not: null, lte: upcomingCutoff, gte: overdueFloor },
                OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: throttleCutoff } }],
                invoice: {
                    status: { in: CLIENT_VISIBLE_INVOICE_STATUSES },
                    project: { paymentRemindersEnabled: true },
                },
            },
            select: {
                id: true,
                name: true,
                amount: true,
                dueDate: true,
                qbInvoiceLink: true,
                invoice: {
                    select: {
                        id: true,
                        code: true,
                        project: { select: { id: true, name: true } },
                        client: { select: { name: true, email: true } },
                    },
                },
            },
            take: 250, // safety cap per run
        });

        result.scanned = candidates.length;
        if (candidates.length === 0) return result;

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Golden Touch Remodeling";
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com";

        for (const schedule of candidates) {
            try {
                const invoice = schedule.invoice;
                const clientEmail = invoice.client?.email;
                if (!clientEmail || !schedule.dueDate) {
                    result.skipped++;
                    continue;
                }

                const payUrl = schedule.qbInvoiceLink || `${appUrl}/portal/invoices/${invoice.id}`;
                const send = await sendNotification(
                    clientEmail,
                    `Payment Reminder — Invoice #${invoice.code}`,
                    reminderEmailHtml({
                        clientName: invoice.client?.name || "",
                        milestoneName: schedule.name,
                        invoiceCode: invoice.code,
                        amount: schedule.amount,
                        dueDate: schedule.dueDate,
                        now,
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
                    continue;
                }

                await prisma.paymentSchedule.update({
                    where: { id: schedule.id },
                    data: { lastReminderAt: now },
                });

                await logActivityLazy({
                    projectId: invoice.project?.id ?? null,
                    actorType: "SYSTEM",
                    actorName: "Payment Reminders",
                    action: "payment_reminder_sent",
                    entityType: "invoice",
                    entityId: invoice.id,
                    entityName: `Invoice ${invoice.code}`,
                    metadata: { milestone: schedule.name, amount: Number(schedule.amount.toString()), dueDate: schedule.dueDate.toISOString(), sentTo: clientEmail },
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
