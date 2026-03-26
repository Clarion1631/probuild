import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { invoiceId, paymentScheduleId, selectedMethod } = body;

        if (!invoiceId || !paymentScheduleId) {
            return new NextResponse("Missing invoiceId or paymentScheduleId", { status: 400 });
        }

        const paymentSchedule = await prisma.paymentSchedule.findUnique({
            where: { id: paymentScheduleId },
            include: {
                invoice: {
                    include: {
                        project: {
                            include: { client: true }
                        }
                    }
                }
            }
        });

        if (!paymentSchedule || paymentSchedule.invoiceId !== invoiceId) {
            return new NextResponse("Payment schedule not found", { status: 404 });
        }

        if (paymentSchedule.status === "Paid") {
            return new NextResponse("This milestone has already been paid", { status: 400 });
        }

        // Check company settings for enabled payment methods
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

        // Build payment method types based on settings or the specific selection
        const paymentMethodTypes: any[] = [];
        if (selectedMethod) {
            paymentMethodTypes.push(selectedMethod);
        } else {
            if (settings?.enableCard !== false) paymentMethodTypes.push("card");
            if (settings?.enableBankTransfer) paymentMethodTypes.push("us_bank_account");
            if (settings?.enableAffirm) paymentMethodTypes.push("affirm");
            if (settings?.enableKlarna) paymentMethodTypes.push("klarna");

            // Fallback to card if nothing is selected
            if (paymentMethodTypes.length === 0) {
                paymentMethodTypes.push("card");
            }
        }

        const projectId = paymentSchedule.invoice.projectId;
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";
        const clientName = paymentSchedule.invoice.project?.client?.name || "Client";

        const projectName = paymentSchedule.invoice.project?.name || "Services";

        // Calculate Processing Fees
        let feeLineItem = null;
        if (settings?.passProcessingFee && selectedMethod && selectedMethod !== 'us_bank_account') {
            const rate = settings.cardProcessingRate ?? 2.9;
            const flat = settings.cardProcessingFlat ?? 0.30;
            const feeAmount = (paymentSchedule.amount * (rate / 100)) + flat;
            
            feeLineItem = {
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: `Processing Fee (${rate}% + $${flat.toFixed(2)})`,
                        description: `Convenience fee for online card payment`,
                    },
                    unit_amount: Math.round(feeAmount * 100), // Stripe expects cents
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
                    unit_amount: Math.round(paymentSchedule.amount * 100), // Stripe expects cents
                },
                quantity: 1,
            },
        ];

        if (feeLineItem) {
            lineItems.push(feeLineItem);
        }

        // Create Stripe checkout session
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

        // Store the session ID in the database
        await prisma.paymentSchedule.update({
            where: { id: paymentSchedule.id },
            data: { stripeSessionId: stripeSession.id }
        });

        return NextResponse.json({ url: stripeSession.url });

    } catch (error: any) {
        console.error("Error creating stripe session:", error);
        return new NextResponse(error?.message || "Internal Server Error", { status: 500 });
    }
}
