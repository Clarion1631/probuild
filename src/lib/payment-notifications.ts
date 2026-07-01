import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { formatCurrency } from "@/lib/utils";

function isToggleOn(settings: { notificationToggles?: string | null } | null, key: string): boolean {
    if (!settings?.notificationToggles) return true;
    try { return JSON.parse(settings.notificationToggles)[key] !== false; } catch { return true; }
}

type ScheduleLike = {
    id: string;
    name: string;
    amount: number | string | { toString(): string };
    referenceNumber?: string | null;
};

type InvoiceLike = {
    id: string;
    code: string;
    client: { name?: string | null; email?: string | null } | null;
};

type EstimateLike = {
    id: string;
    code: string;
    project?: { client?: { name?: string | null; email?: string | null } | null } | null;
    // Lead email lives on its related Client, not on Lead itself. The older `lead.email` shape
    // was a phantom type that let a real bug reach production (auto receipts silently
    // failed for lead-only estimates).
    lead?: {
        name?: string | null;
        client?: { name?: string | null; email?: string | null } | null;
    } | null;
};

const METHOD_LABELS: Record<string, string> = {
    card: "Card",
    ach: "Bank Transfer (ACH)",
    check: "Check",
    cash: "Cash",
};

function formatMethod(method: string | null | undefined, ref?: string | null): string {
    if (!method) return "Payment";
    const label = METHOD_LABELS[method] ?? method.toUpperCase();
    if (method === "check" && ref) return `Check #${ref}`;
    if (ref) return `${label} (ref ${ref})`;
    return label;
}

function receiptBodyHtml(opts: {
    invoiceLike: { code: string; kind: "invoice" | "estimate" };
    clientName: string;
    schedule: { name: string; amount: any };
    method: string | null | undefined;
    referenceNumber?: string | null;
    newBalance: number;
    portalUrl: string;
    companyName: string;
    phone?: string | null;
    email?: string | null;
}) {
    const { invoiceLike, clientName, schedule, method, referenceNumber, newBalance, portalUrl, companyName, phone, email } = opts;
    const methodLine = method
        ? `<p style="margin:4px 0;color:#475569;">Payment method: <strong>${formatMethod(method, referenceNumber)}</strong></p>`
        : "";
    const balanceLine = newBalance > 0
        ? `<p>Remaining balance: <strong>${formatCurrency(newBalance)}</strong></p>`
        : `<p>Your ${invoiceLike.kind} is now <strong>paid in full</strong>. Thank you!</p>`;
    const noun = invoiceLike.kind === "invoice" ? "Invoice" : "Estimate";
    return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#166534;margin-bottom:8px;">Payment Confirmed</h2>
        <p>Hi ${clientName || 'there'},</p>
        <p>We've received your payment of <strong>${formatCurrency(schedule.amount)}</strong> for <strong>${schedule.name}</strong> on ${noun} #${invoiceLike.code}.</p>
        ${methodLine}
        ${balanceLine}
        <p style="margin-top:24px;">
            <a href="${portalUrl}" style="background:#166534;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:600;">View ${noun}</a>
        </p>
        <p style="color:#9ca3af;font-size:12px;margin-top:32px;">
            ${companyName}${phone ? ` · ${phone}` : ''}${email ? ` · ${email}` : ''}
        </p>
    </div>`;
}

/**
 * THE single entry point for "an invoice milestone got paid" side effects:
 * team alert (Settings → Notifications · Payment Received toggle), client
 * receipt (deduped via receiptSentAt), and the project activity-feed entry.
 * Called by every settle path — QuickBooks sync, manual invoice recording,
 * estimate-side recording via its mirrored invoice copy. The Stripe webhook
 * predates this and uses sendInvoicePaymentReceivedEmails below; a milestone
 * can only be claimed once, so the two can never both fire for one payment.
 *
 * Fetches fresh state by id (call AFTER the settle transaction commits, so
 * balanceDue is already recalculated). Never throws.
 */
export async function notifyMilestonePaid(paymentScheduleId: string): Promise<{ success: boolean; id?: string } | void> {
    try {
        const s = await prisma.paymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            select: {
                id: true, name: true, amount: true, status: true, paymentMethod: true, referenceNumber: true,
                paymentDate: true, paidAt: true, receiptSentAt: true,
                invoice: {
                    select: {
                        id: true, code: true, balanceDue: true,
                        project: { select: { id: true, name: true } },
                        client: { select: { name: true, email: true } },
                    },
                },
            },
        });
        if (!s?.invoice) return;
        // Hard guard: side effects only for milestones that are actually Paid
        // (protects the maintenance test action and any future mis-call).
        if (s.status !== "Paid") return;
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Golden Touch Remodeling";
        const amount = formatCurrency(s.amount);
        const remaining = formatCurrency(s.invoice.balanceDue);
        const newBalanceNum = Number(s.invoice.balanceDue.toString());
        const when = (s.paymentDate || s.paidAt || new Date()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        const link = s.invoice.project
            ? `https://probuild.goldentouchremodeling.com/projects/${s.invoice.project.id}/invoices/${s.invoice.id}`
            : "https://probuild.goldentouchremodeling.com/invoices";

        // 1. Activity feed (independent of notification toggles — the audit trail
        //    must survive notifications being switched off)
        await prisma.activityLog.create({
            data: {
                projectId: s.invoice.project?.id ?? null,
                actorType: s.paymentMethod === "quickbooks" ? "SYSTEM" : "TEAM",
                actorName: s.paymentMethod === "quickbooks" ? "QuickBooks" : "Team",
                action: "payment_received",
                entityType: "invoice",
                entityId: s.invoice.id,
                entityName: `Invoice ${s.invoice.code}`,
                metadata: JSON.stringify({ milestone: s.name, amount: Number(s.amount.toString()), method: s.paymentMethod, referenceNumber: s.referenceNumber || undefined }),
            },
        }).catch(() => {});

        // 2. Team alert
        let adminSend: { success: boolean; id?: string } | undefined;
        if (settings?.notificationEmail && isToggleOn(settings, "paymentReceived")) {
            adminSend = await sendNotification(
                settings.notificationEmail,
                `💰 Payment received — ${amount} · ${s.invoice.code}`,
                `<div style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px;">
                    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 22px;">
                        <h2 style="margin: 0 0 10px; color: #166534; font-size: 18px;">Payment received</h2>
                        <table style="width: 100%; font-size: 13px; color: #444;">
                            <tr><td style="padding: 3px 0;">Amount</td><td style="text-align: right; font-weight: 700; color: #166534;">${amount}</td></tr>
                            <tr><td style="padding: 3px 0;">Client</td><td style="text-align: right; font-weight: 600;">${s.invoice.client?.name || "—"}</td></tr>
                            <tr><td style="padding: 3px 0;">Project</td><td style="text-align: right;">${s.invoice.project?.name || "—"}</td></tr>
                            <tr><td style="padding: 3px 0;">Milestone</td><td style="text-align: right;">${s.name} · ${s.invoice.code}</td></tr>
                            <tr><td style="padding: 3px 0;">Method</td><td style="text-align: right; text-transform: capitalize;">${formatMethod(s.paymentMethod, s.referenceNumber)}</td></tr>
                            <tr><td style="padding: 3px 0;">Date</td><td style="text-align: right;">${when}</td></tr>
                            <tr><td style="padding: 3px 0; border-top: 1px solid #d1fae5;">Invoice balance left</td><td style="text-align: right; border-top: 1px solid #d1fae5; font-weight: 600;">${remaining}</td></tr>
                        </table>
                        <a href="${link}" style="display: inline-block; margin-top: 14px; background: #166534; color: #fff; font-size: 13px; font-weight: 600; padding: 9px 18px; border-radius: 7px; text-decoration: none;">Open Invoice</a>
                    </div>
                </div>`
            );
        }

        // 3. Client receipt (once per milestone — receiptSentAt is the guard)
        if (s.invoice.client?.email && !s.receiptSentAt) {
            const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || "https://probuild.goldentouchremodeling.com"}/portal/invoices/${s.invoice.id}`;
            await sendNotification(
                s.invoice.client.email,
                `Payment Receipt — Invoice #${s.invoice.code}`,
                receiptBodyHtml({
                    invoiceLike: { code: s.invoice.code, kind: "invoice" },
                    clientName: s.invoice.client.name || "",
                    schedule: { name: s.name, amount: s.amount },
                    method: s.paymentMethod,
                    referenceNumber: s.referenceNumber,
                    newBalance: newBalanceNum,
                    portalUrl,
                    companyName,
                    phone: settings?.phone,
                    email: settings?.email,
                }),
                undefined,
                { fromName: companyName, replyTo: settings?.email ?? undefined }
            );
            await prisma.paymentSchedule.update({
                where: { id: s.id },
                data: { receiptSentAt: new Date() },
            }).catch(() => {});
        }
        return adminSend;
    } catch (e) {
        console.error("[notifyMilestonePaid] failed:", e);
    }
}

/** One milestone whose linked QBO invoice was found voided/deleted by the sync poller. */
export type QBSyncIssue = {
    scheduleId: string;
    invoiceId: string;
    invoiceCode: string;
    milestoneName: string;
    projectId: string | null;
    projectName: string | null;
    state: "voided" | "notFound";
};

/**
 * Report milestones whose QuickBooks invoice was voided/deleted (so the cron can
 * never settle them). Writes a project activity entry per milestone and sends ONE
 * digest email to the team. Callers pass only NEWLY-flagged rows, so this fires
 * once per breakage, not every hourly run. Never throws.
 */
export async function notifyQBSyncIssues(issues: QBSyncIssue[]): Promise<void> {
    if (issues.length === 0) return;
    try {
        const stateLabel = (s: QBSyncIssue["state"]) => (s === "notFound" ? "deleted/missing" : "voided");

        // 1. Activity feed — one entry per affected milestone (independent of toggles).
        for (const i of issues) {
            await prisma.activityLog.create({
                data: {
                    projectId: i.projectId,
                    actorType: "SYSTEM",
                    actorName: "QuickBooks",
                    action: "qb_sync_issue",
                    entityType: "invoice",
                    entityId: i.invoiceId,
                    entityName: `Invoice ${i.invoiceCode}`,
                    metadata: JSON.stringify({ milestone: i.milestoneName, state: i.state }),
                },
            }).catch(() => {});
        }

        // 2. Team digest email (respects Settings → Notifications · quickbooksSyncIssue).
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        if (!settings?.notificationEmail || !isToggleOn(settings, "quickbooksSyncIssue")) return;

        const rows = issues.map(i => {
            const link = i.projectId
                ? `https://probuild.goldentouchremodeling.com/projects/${i.projectId}/invoices/${i.invoiceId}`
                : `https://probuild.goldentouchremodeling.com/invoices`;
            return `<tr>
                <td style="padding: 6px 8px; border-bottom: 1px solid #fde68a;">${i.invoiceCode}</td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #fde68a;">${i.milestoneName}</td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #fde68a;">${i.projectName || "—"}</td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #fde68a; text-transform: capitalize;">${stateLabel(i.state)}</td>
                <td style="padding: 6px 8px; border-bottom: 1px solid #fde68a;"><a href="${link}" style="color: #b45309; font-weight: 600;">Open</a></td>
            </tr>`;
        }).join("");

        const count = issues.length;
        await sendNotification(
            settings.notificationEmail,
            `⚠ ${count} QuickBooks invoice${count === 1 ? "" : "s"} voided/deleted — milestone${count === 1 ? "" : "s"} need re-issue`,
            `<div style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
                <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 22px;">
                    <h2 style="margin: 0 0 8px; color: #b45309; font-size: 18px;">QuickBooks invoices no longer collectible</h2>
                    <p style="margin: 0 0 14px; font-size: 13px; color: #444;">
                        The QuickBooks invoice${count === 1 ? "" : "s"} below ${count === 1 ? "was" : "were"} voided or deleted in QuickBooks, so the matching payment milestone${count === 1 ? "" : "s"} can no longer settle and ${count === 1 ? "is" : "are"} stuck on <strong>Pending</strong>. Open each invoice and click <strong>Break QB Link</strong> to clear the link, then re-create it.
                    </p>
                    <table style="width: 100%; font-size: 13px; color: #444; border-collapse: collapse;">
                        <tr style="text-align: left; color: #92400e;">
                            <th style="padding: 6px 8px; border-bottom: 2px solid #fcd34d;">Invoice</th>
                            <th style="padding: 6px 8px; border-bottom: 2px solid #fcd34d;">Milestone</th>
                            <th style="padding: 6px 8px; border-bottom: 2px solid #fcd34d;">Project</th>
                            <th style="padding: 6px 8px; border-bottom: 2px solid #fcd34d;">State</th>
                            <th style="padding: 6px 8px; border-bottom: 2px solid #fcd34d;"></th>
                        </tr>
                        ${rows}
                    </table>
                </div>
            </div>`
        );
    } catch (e) {
        console.error("[notifyQBSyncIssues] failed:", e);
    }
}

/**
 * Send admin alert + customer receipt for a newly-paid invoice milestone.
 * Used by the Stripe webhook (auto) — callers must handle idempotency themselves.
 */
export async function sendInvoicePaymentReceivedEmails(opts: {
    invoice: InvoiceLike;
    schedule: ScheduleLike;
    method: string;
    newBalance: number;
    referenceNumber?: string | null;
}) {
    const { invoice, schedule, method, newBalance, referenceNumber } = opts;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Golden Touch Remodeling";
    const methodLabel = formatMethod(method, referenceNumber);

    if (settings?.notificationEmail && isToggleOn(settings, "paymentReceived")) {
        await sendNotification(
            settings.notificationEmail,
            `Payment Received: ${schedule.name} - ${invoice.code}`,
            `<div style="font-family: sans-serif; padding: 20px;">
                <h2>Payment Received! 🎉</h2>
                <p>A payment of <strong>${formatCurrency(schedule.amount)}</strong> has been successfully processed via ${methodLabel} for Invoice #${invoice.code}.</p>
                <p>Milestone: ${schedule.name}</p>
                <p>Remaining Invoice Balance: ${formatCurrency(newBalance)}</p>
            </div>`
        );
    }

    if (invoice.client?.email) {
        const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/portal/invoices/${invoice.id}`;
        await sendNotification(
            invoice.client.email,
            `Payment Receipt — Invoice #${invoice.code}`,
            receiptBodyHtml({
                invoiceLike: { code: invoice.code, kind: "invoice" },
                clientName: invoice.client.name || "",
                schedule,
                method,
                referenceNumber,
                newBalance,
                portalUrl,
                companyName,
                phone: settings?.phone,
                email: settings?.email,
            }),
            undefined,
            { replyTo: settings?.email ?? undefined }
        );
        await prisma.paymentSchedule.update({
            where: { id: schedule.id },
            data: { receiptSentAt: new Date() },
        });
    }
}

/**
 * Send admin alert + customer receipt for a newly-paid estimate deposit milestone.
 * Used by the Stripe webhook (auto).
 */
export async function sendEstimatePaymentReceivedEmails(opts: {
    estimate: EstimateLike;
    schedule: ScheduleLike;
    method: string;
    newBalance: number;
    referenceNumber?: string | null;
}) {
    const { estimate, schedule, method, newBalance, referenceNumber } = opts;
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Golden Touch Remodeling";
    const methodLabel = formatMethod(method, referenceNumber);

    if (settings?.notificationEmail && isToggleOn(settings, "paymentReceived")) {
        await sendNotification(
            settings.notificationEmail,
            `Estimate Payment Received: ${schedule.name} - ${estimate.code}`,
            `<div style="font-family: sans-serif; padding: 20px;">
                <h2>Estimate Payment Received! 🎉</h2>
                <p>A payment of <strong>${formatCurrency(schedule.amount)}</strong> has been successfully processed via ${methodLabel} for Estimate #${estimate.code}.</p>
                <p>Milestone: ${schedule.name}</p>
                <p>Remaining Estimate Balance: ${formatCurrency(newBalance)}</p>
            </div>`
        );
    }

    const clientEmail = estimate.project?.client?.email || estimate.lead?.client?.email || null;
    const clientName = estimate.project?.client?.name || estimate.lead?.client?.name || estimate.lead?.name || "";
    if (clientEmail) {
        const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/portal/estimates/${estimate.id}`;
        await sendNotification(
            clientEmail,
            `Payment Receipt — Estimate #${estimate.code}`,
            receiptBodyHtml({
                invoiceLike: { code: estimate.code, kind: "estimate" },
                clientName,
                schedule,
                method,
                referenceNumber,
                newBalance,
                portalUrl,
                companyName,
                phone: settings?.phone,
                email: settings?.email,
            }),
            undefined,
            { replyTo: settings?.email ?? undefined }
        );
        await prisma.estimatePaymentSchedule.update({
            where: { id: schedule.id },
            data: { receiptSentAt: new Date() },
        });
    }
}

/**
 * Send only the customer receipt for an already-paid invoice milestone.
 * Used by the manual "Send Receipt" button — safe to call multiple times.
 */
export async function sendInvoicePaymentReceiptOnly(paymentScheduleId: string) {
    const schedule = await prisma.paymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        include: { invoice: { include: { client: true } } },
    });
    if (!schedule || schedule.status !== "Paid") {
        return { success: false, error: "Milestone is not paid" as const };
    }
    const invoice = schedule.invoice;
    const clientEmail = invoice.client?.email;
    if (!clientEmail) {
        return { success: false, error: "Client has no email on file" as const };
    }

    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Golden Touch Remodeling";
    const allPaid = await prisma.paymentSchedule.findMany({
        where: { invoiceId: invoice.id, status: "Paid" },
        select: { amount: true },
    });
    const totalPaid = allPaid.reduce((s, p) => s + Number(p.amount), 0);
    const newBalance = Math.max(0, Number(invoice.totalAmount) - totalPaid);

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/portal/invoices/${invoice.id}`;
    const result = await sendNotification(
        clientEmail,
        `Payment Receipt — Invoice #${invoice.code}`,
        receiptBodyHtml({
            invoiceLike: { code: invoice.code, kind: "invoice" },
            clientName: invoice.client?.name || "",
            schedule: { name: schedule.name, amount: schedule.amount },
            method: schedule.paymentMethod,
            referenceNumber: schedule.referenceNumber,
            newBalance,
            portalUrl,
            companyName,
            phone: settings?.phone,
            email: settings?.email,
        }),
        undefined,
        { replyTo: settings?.email ?? undefined }
    );
    if (result.success) {
        await prisma.paymentSchedule.update({
            where: { id: paymentScheduleId },
            data: { receiptSentAt: new Date() },
        });
    }
    return { success: result.success };
}

/**
 * Send only the customer receipt for an already-paid estimate deposit milestone.
 * Used by the manual "Send Receipt" button — safe to call multiple times.
 */
export async function sendEstimatePaymentReceiptOnly(paymentScheduleId: string) {
    const schedule = await prisma.estimatePaymentSchedule.findUnique({
        where: { id: paymentScheduleId },
        include: {
            estimate: {
                include: {
                    project: { include: { client: true } },
                    lead: { include: { client: true } },
                },
            },
        },
    });
    if (!schedule || schedule.status !== "Paid") {
        return { success: false, error: "Milestone is not paid" as const };
    }
    const estimate = schedule.estimate;
    const clientEmail = estimate.project?.client?.email || estimate.lead?.client?.email || null;
    const clientName = estimate.project?.client?.name || estimate.lead?.client?.name || estimate.lead?.name || "";
    if (!clientEmail) {
        return { success: false, error: "Client has no email on file" as const };
    }

    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const companyName = settings?.companyName || "Golden Touch Remodeling";
    const allPaid = await prisma.estimatePaymentSchedule.findMany({
        where: { estimateId: estimate.id, status: "Paid" },
        select: { amount: true },
    });
    const totalPaid = allPaid.reduce((s, p) => s + Number(p.amount), 0);
    const newBalance = Math.max(0, Number(estimate.totalAmount) - totalPaid);

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/portal/estimates/${estimate.id}`;
    const result = await sendNotification(
        clientEmail,
        `Payment Receipt — Estimate #${estimate.code}`,
        receiptBodyHtml({
            invoiceLike: { code: estimate.code, kind: "estimate" },
            clientName,
            schedule: { name: schedule.name, amount: schedule.amount },
            method: schedule.paymentMethod,
            referenceNumber: schedule.referenceNumber,
            newBalance,
            portalUrl,
            companyName,
            phone: settings?.phone,
            email: settings?.email,
        }),
        undefined,
        { replyTo: settings?.email ?? undefined }
    );
    if (result.success) {
        await prisma.estimatePaymentSchedule.update({
            where: { id: paymentScheduleId },
            data: { receiptSentAt: new Date() },
        });
    }
    return { success: result.success };
}
