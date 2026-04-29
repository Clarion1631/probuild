import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { stripe } from "@/lib/stripe";

export async function POST(req: Request) {
    const requestId = Math.random().toString(36).slice(2, 10);
    const ua = req.headers.get("user-agent") || "";
    try {
        const body = await req.json();
        const { invoiceId, estimateId, paymentScheduleId, selectedMethod } = body;

        console.info("[create-session] enter", { requestId, ua, paymentScheduleId, invoiceId, estimateId, selectedMethod });

        if (!paymentScheduleId) {
            return new NextResponse("Missing paymentScheduleId", { status: 400 });
        }
        if (!invoiceId && !estimateId) {
            return new NextResponse("Missing invoiceId or estimateId", { status: 400 });
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        // Idempotency key includes the schedule's current amount so admin amount edits invalidate
        // any stale session, but rapid double-taps within the same amount window dedupe to one session.
        const scheduleAmount = estimateId
            ? (await prisma.estimatePaymentSchedule.findUnique({ where: { id: paymentScheduleId }, select: { amount: true } }))?.amount?.toString() || "0"
            : (await prisma.paymentSchedule.findUnique({ where: { id: paymentScheduleId }, select: { amount: true } }))?.amount?.toString() || "0";
        const idempotencyKey = `pay-session:${paymentScheduleId}:${selectedMethod || "default"}:${scheduleAmount}`;

        // Validate selectedMethod is enabled in company settings
        if (selectedMethod && typeof selectedMethod !== "string") {
            return new NextResponse("Invalid selectedMethod", { status: 400 });
        }
        if (selectedMethod) {
            const methodAllowed =
                (selectedMethod === "card" && settings?.enableCard !== false) ||
                (selectedMethod === "us_bank_account" && settings?.enableBankTransfer === true) ||
                (selectedMethod === "affirm" && settings?.enableAffirm === true) ||
                (selectedMethod === "klarna" && settings?.enableKlarna === true);
            if (!methodAllowed) {
                return new NextResponse(`Payment method "${selectedMethod}" is not enabled`, { status: 400 });
            }
        }

        // Build payment method types
        const paymentMethodTypes: any[] = [];
        if (selectedMethod) {
            paymentMethodTypes.push(selectedMethod);
        } else {
            if (settings?.enableCard !== false) paymentMethodTypes.push("card");
            if (settings?.enableBankTransfer) paymentMethodTypes.push("us_bank_account");
            if (settings?.enableAffirm) paymentMethodTypes.push("affirm");
            if (settings?.enableKlarna) paymentMethodTypes.push("klarna");
            if (paymentMethodTypes.length === 0) paymentMethodTypes.push("card");
        }

        // ── Estimate payment branch ──────────────────────────────────────────
        if (estimateId) {
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

            if (!schedule || schedule.estimateId !== estimateId) {
                return new NextResponse("Estimate payment schedule not found", { status: 404 });
            }
            if (schedule.status === "Paid") {
                return new NextResponse("This milestone has already been paid", { status: 400 });
            }
            if (Number(schedule.amount) <= 0) {
                return new NextResponse("Payment schedule has no amount — please update the milestone in the estimate editor.", { status: 400 });
            }

            const estimate = schedule.estimate;
            const clientName =
                estimate.project?.client?.name || estimate.lead?.client?.name || "Client";
            const rawClientEmail =
                (estimate.project?.client?.email || estimate.lead?.client?.email || "").trim();
            const clientEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawClientEmail) ? rawClientEmail : null;
            const projectName =
                estimate.project?.name || estimate.lead?.name || "Services";

            // Processing fee
            let feeLineItem = null;
            if (settings?.passProcessingFee && selectedMethod && selectedMethod !== "us_bank_account") {
                const rate = Number(settings.cardProcessingRate ?? 2.9);
                const flat = Number(settings.cardProcessingFlat ?? 0.30);
                const feeAmount = Number(schedule.amount) * (rate / 100) + flat;
                const feeName = flat > 0
                    ? `Processing Fee (${rate}% + $${flat.toFixed(2)})`
                    : `Processing Fee (${rate}%)`;
                feeLineItem = {
                    price_data: {
                        currency: "usd",
                        product_data: { name: feeName, description: "Convenience fee for online card payment" },
                        unit_amount: Math.round(feeAmount * 100),
                    },
                    quantity: 1,
                };
            }

            const lineItems: any[] = [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: `Estimate #${estimate.code} — ${schedule.name}`,
                            description: `${projectName} • ${clientName}`,
                        },
                        unit_amount: Math.round(Number(schedule.amount) * 100),
                    },
                    quantity: 1,
                },
            ];
            if (feeLineItem) lineItems.push(feeLineItem);

            const stripeSession = await stripe.checkout.sessions.create({
                payment_method_types: paymentMethodTypes,
                line_items: lineItems,
                mode: "payment",
                success_url: `${appUrl}/portal/estimates/${estimateId}?payment=success`,
                cancel_url: `${appUrl}/portal/estimates/${estimateId}?payment=cancelled`,
                ...(clientEmail
                    ? {
                        customer_email: clientEmail,
                        payment_intent_data: { receipt_email: clientEmail },
                    }
                    : {}),
                metadata: {
                    estimateId,
                    estimatePaymentScheduleId: schedule.id,
                    projectId: estimate.projectId || "none",
                },
            }, { idempotencyKey });

            await prisma.estimatePaymentSchedule.update({
                where: { id: schedule.id },
                data: { stripeSessionId: stripeSession.id },
            });

            console.info("[create-session] success", { requestId, branch: "estimate", sessionId: stripeSession.id, paymentScheduleId });
            return NextResponse.json({ url: stripeSession.url });
        }

        // ── Invoice payment branch ───────────────────────────────────────────
        if (!invoiceId) {
            return new NextResponse("Missing invoiceId", { status: 400 });
        }

        const paymentSchedule = await prisma.paymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            include: {
                invoice: {
                    include: {
                        project: { include: { client: true } },
                    },
                },
            },
        });

        if (!paymentSchedule || paymentSchedule.invoiceId !== invoiceId) {
            return new NextResponse("Payment schedule not found", { status: 404 });
        }
        if (paymentSchedule.status === "Paid") {
            return new NextResponse("This milestone has already been paid", { status: 400 });
        }

        const projectId = paymentSchedule.invoice.projectId;
        const clientName = paymentSchedule.invoice.project?.client?.name || "Client";
        const rawClientEmail = (paymentSchedule.invoice.project?.client?.email || "").trim();
        const clientEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawClientEmail) ? rawClientEmail : null;
        const projectName = paymentSchedule.invoice.project?.name || "Services";

        let feeLineItem = null;
        if (settings?.passProcessingFee && selectedMethod && selectedMethod !== 'us_bank_account') {
            const rate = toNum(settings.cardProcessingRate ?? 2.9);
            const flat = toNum(settings.cardProcessingFlat ?? 0.30);
            const feeAmount = (toNum(paymentSchedule.amount) * (rate / 100)) + flat;
            
            const feeName = flat > 0 ? `Processing Fee (${rate}% + $${flat.toFixed(2)})` : `Processing Fee (${rate}%)`;
            
            feeLineItem = {
                price_data: {
                    currency: "usd",
                    product_data: { name: feeName, description: "Convenience fee for online card payment" },
                    unit_amount: Math.round(feeAmount * 100),
                },
                quantity: 1,
            };
        }

        const lineItems: any[] = [
            {
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: `Invoice #${paymentSchedule.invoice.code} — ${paymentSchedule.name}`,
                        description: `${projectName} • ${clientName}`,
                    },
                    unit_amount: Math.round(toNum(paymentSchedule.amount) * 100), // Stripe expects cents
                },
                quantity: 1,
            },
        ];
        if (feeLineItem) lineItems.push(feeLineItem);

        const stripeSession = await stripe.checkout.sessions.create({
            payment_method_types: paymentMethodTypes,
            line_items: lineItems,
            mode: "payment",
            success_url: `${appUrl}/portal/invoices/${invoiceId}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/portal/invoices/${invoiceId}?payment=cancelled`,
            ...(clientEmail
                ? {
                    customer_email: clientEmail,
                    payment_intent_data: { receipt_email: clientEmail },
                }
                : {}),
            metadata: {
                invoiceId: paymentSchedule.invoiceId,
                paymentScheduleId: paymentSchedule.id,
                projectId: projectId || "none",
            },
        }, { idempotencyKey });

        await prisma.paymentSchedule.update({
            where: { id: paymentSchedule.id },
            data: { stripeSessionId: stripeSession.id },
        });

        console.info("[create-session] success", { requestId, branch: "invoice", sessionId: stripeSession.id, paymentScheduleId });
        return NextResponse.json({ url: stripeSession.url });

    } catch (error: any) {
        console.error("[create-session] error", { requestId, message: error?.message, stack: error?.stack });
        return new NextResponse(error?.message || "Internal Server Error", { status: 500 });
    }
}
