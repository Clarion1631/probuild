import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { getCurrentUserWithPermissions } from "@/lib/permissions";
import { toNum } from "@/lib/prisma-helpers";

export const maxDuration = 60;

export interface BackfillDetail {
    sessionId: string;
    type: "invoice" | "estimate" | "unknown";
    id: string;
    action: "synced" | "skipped" | "no_metadata" | "not_found";
    // Human-readable context
    clientName?: string;
    docCode?: string;
    milestoneName?: string;
    amount?: number;
    paymentDate?: string;
    paymentMethod?: string;
}

interface BackfillError {
    sessionId: string;
    message: string;
}

export async function POST(req: Request) {
    const user = await getCurrentUserWithPermissions();
    if (!user || (user.role !== "ADMIN" && user.role !== "MANAGER")) {
        return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    let startDate: string, endDate: string, dryRun: boolean;
    try {
        ({ startDate, endDate, dryRun = true } = await req.json());
    } catch {
        return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    // Live writes restricted to ADMIN only
    if (!dryRun && user.role !== "ADMIN") {
        return NextResponse.json({ error: "Live backfill requires ADMIN role" }, { status: 403 });
    }

    const startTs = Math.floor(new Date(startDate).getTime() / 1000);
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);
    if (isNaN(startTs) || isNaN(endTs) || startTs >= endTs) {
        return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }

    const details: BackfillDetail[] = [];
    const errors: BackfillError[] = [];

    let startingAfter: string | undefined;
    let hasMore = true;

    while (hasMore) {
        let page: any;
        try {
            page = await (stripe.checkout.sessions.list as any)({
                status: "complete",
                created: { gte: startTs, lte: endTs },
                expand: ["data.payment_intent", "data.payment_intent.payment_method"],
                limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {}),
            });
        } catch (err: any) {
            const processed = details.filter(d => d.action === "synced").length;
            const skipped = details.filter(d => d.action === "skipped").length;
            return NextResponse.json(
                { error: `Stripe API error: ${err.message}`, processed, skipped, errors, details },
                { status: 500 }
            );
        }

        if (page.has_more && page.data.length === 0) {
            errors.push({ sessionId: "pagination", message: "Stripe returned has_more=true with empty page — aborting" });
            break;
        }

        for (const session of page.data as any[]) {
            if (session.payment_status !== "paid") continue;
            try {
                await processSession(session, dryRun, details);
            } catch (err: any) {
                errors.push({ sessionId: session.id, message: err.message });
            }
        }

        hasMore = page.has_more;
        if (hasMore && page.data.length > 0) {
            startingAfter = page.data[page.data.length - 1].id;
        }
    }

    const processed = details.filter(d => d.action === "synced").length;
    const skipped = details.filter(d => d.action === "skipped").length;

    return NextResponse.json({ processed, skipped, errors, details });
}

async function processSession(session: any, dryRun: boolean, details: BackfillDetail[]) {
    const metadata = session.metadata ?? {};
    const paymentDate = new Date(session.created * 1000);

    let paymentMethod = "unknown";
    const pi = session.payment_intent;
    if (pi && typeof pi === "object") {
        const pmType: string | undefined = pi.payment_method?.type;
        if (pmType === "us_bank_account") paymentMethod = "ach";
        else if (pmType === "card") paymentMethod = "card";
        else if (pmType) paymentMethod = pmType;
    }
    const paymentIntentId: string | null = typeof pi === "string" ? pi : pi?.id ?? null;

    // ── Invoice branch ────────────────────────────────────────────────────────
    if (metadata.paymentScheduleId && metadata.invoiceId) {
        const scheduleId = metadata.paymentScheduleId as string;
        const invoiceId = metadata.invoiceId as string;

        let existing = await prisma.paymentSchedule.findUnique({
            where: { id: scheduleId },
            include: { invoice: { include: { client: true } } },
        });
        if (!existing && paymentIntentId) {
            existing = await prisma.paymentSchedule.findFirst({
                where: { stripePaymentIntentId: paymentIntentId },
                include: { invoice: { include: { client: true } } },
            });
        }

        const context: Partial<BackfillDetail> = {
            clientName: existing?.invoice?.client?.name ?? undefined,
            docCode: existing?.invoice?.code ?? undefined,
            milestoneName: existing?.name ?? undefined,
            amount: existing ? toNum(existing.amount) : undefined,
            paymentDate: paymentDate.toISOString(),
            paymentMethod,
        };

        if (!existing) {
            details.push({ sessionId: session.id, type: "invoice", id: scheduleId, action: "not_found", ...context });
            return;
        }
        if (existing.status === "Paid") {
            details.push({ sessionId: session.id, type: "invoice", id: existing.id, action: "skipped", ...context });
            return;
        }

        if (!dryRun) {
            await prisma.$transaction(async (t) => {
                await t.paymentSchedule.update({
                    where: { id: existing!.id },
                    data: { status: "Paid", stripeSessionId: session.id, stripePaymentIntentId: paymentIntentId, paymentMethod, paymentDate, paidAt: paymentDate },
                });
                const siblings = await t.paymentSchedule.findMany({ where: { invoiceId } });
                const invoice = await t.invoice.findUnique({ where: { id: invoiceId } });
                if (!invoice) return;
                const totalPaid = siblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
                const newStatus = newBalance <= 0 ? "Paid" : totalPaid > 0 ? "Partially Paid" : invoice.status;
                await t.invoice.update({ where: { id: invoiceId }, data: { balanceDue: newBalance, status: newStatus } });
            });
        }

        details.push({ sessionId: session.id, type: "invoice", id: existing.id, action: "synced", ...context });
        return;
    }

    // ── Estimate branch ───────────────────────────────────────────────────────
    if (metadata.estimatePaymentScheduleId && metadata.estimateId) {
        const scheduleId = metadata.estimatePaymentScheduleId as string;
        const estimateId = metadata.estimateId as string;

        let existing = await prisma.estimatePaymentSchedule.findUnique({
            where: { id: scheduleId },
            include: {
                estimate: {
                    include: {
                        project: { include: { client: true } },
                        lead: { include: { client: true } },
                    },
                },
            },
        });
        if (!existing && paymentIntentId) {
            existing = await prisma.estimatePaymentSchedule.findFirst({
                where: { stripePaymentIntentId: paymentIntentId },
                include: {
                    estimate: {
                        include: {
                            project: { include: { client: true } },
                            lead: { include: { client: true } },
                        },
                    },
                },
            });
        }

        const clientName = existing?.estimate?.project?.client?.name
            ?? existing?.estimate?.lead?.client?.name
            ?? undefined;

        const context: Partial<BackfillDetail> = {
            clientName,
            docCode: existing?.estimate?.code ?? undefined,
            milestoneName: existing?.name ?? undefined,
            amount: existing ? toNum(existing.amount) : undefined,
            paymentDate: paymentDate.toISOString(),
            paymentMethod,
        };

        if (!existing) {
            details.push({ sessionId: session.id, type: "estimate", id: scheduleId, action: "not_found", ...context });
            return;
        }
        if (existing.status === "Paid") {
            details.push({ sessionId: session.id, type: "estimate", id: existing.id, action: "skipped", ...context });
            return;
        }

        if (!dryRun) {
            await prisma.$transaction(async (t) => {
                await t.estimatePaymentSchedule.update({
                    where: { id: existing!.id },
                    data: { status: "Paid", stripeSessionId: session.id, stripePaymentIntentId: paymentIntentId, paymentMethod, paymentDate, paidAt: paymentDate },
                });
                const siblings = await t.estimatePaymentSchedule.findMany({ where: { estimateId } });
                const estimate = await t.estimate.findUnique({ where: { id: estimateId } });
                if (!estimate) return;
                const totalPaid = siblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                const newBalance = Math.max(0, toNum(estimate.totalAmount) - totalPaid);
                await t.estimate.update({ where: { id: estimateId }, data: { balanceDue: newBalance } });
            });
        }

        details.push({ sessionId: session.id, type: "estimate", id: existing.id, action: "synced", ...context });
        return;
    }

    details.push({ sessionId: session.id, type: "unknown", id: session.id, action: "no_metadata" });
}
