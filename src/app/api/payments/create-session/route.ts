import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { stripe } from "@/lib/stripe";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { invoiceId, estimateId, paymentScheduleId, selectedMethod } = body;

        if (!paymentScheduleId) {
            return new NextResponse("Missing paymentScheduleId", { status: 400 });
        }
        if (!invoiceId && !estimateId) {
            return new NextResponse("Missing invoiceId or estimateId", { status: 400 });
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

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
                metadata: {
                    estimateId,
                    estimatePaymentScheduleId: schedule.id,
                    projectId: estimate.projectId || "none",
                },
            });

            await prisma.estimatePaymentSchedule.update({
                where: { id: schedule.id },
                data: { stripeSessionId: stripeSession.id },
            });

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
            success_url: `${appUrl}/portal/invoices/${invoiceId}?payment=success`,
            cancel_url: `${appUrl}/portal/invoices/${invoiceId}?payment=cancelled`,
            metadata: {
                invoiceId: paymentSchedule.invoiceId,
                paymentScheduleId: paymentSchedule.id,
                projectId: projectId || "none",
            },
        });

        await prisma.paymentSchedule.update({
            where: { id: paymentSchedule.id },
            data: { stripeSessionId: stripeSession.id },
        });

        return NextResponse.json({ url: stripeSession.url });

    } catch (error: any) {
        console.error("Error creating stripe session:", error);
        return new NextResponse(error?.message || "Internal Server Error", { status: 500 });
    }
}
