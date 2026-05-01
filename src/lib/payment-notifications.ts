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
