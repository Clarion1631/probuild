import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const body = await req.json();
        const { invoiceId, paymentScheduleId } = body;

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

        // Verify that the logged-in user is the client who owns the project
        if (paymentSchedule.invoice.project.client.email?.toLowerCase() !== session.user.email.toLowerCase()) {
            return new NextResponse("Forbidden", { status: 403 });
        }

        // Check company settings for enabled payment methods
        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        
        if (!settings?.stripeEnabled) {
            return new NextResponse("Stripe payments are not enabled", { status: 400 });
        }

        const paymentMethodTypes: any[] = [];
        if (settings.enableCard) paymentMethodTypes.push("card");
        if (settings.enableBankTransfer) paymentMethodTypes.push("us_bank_account");
        if (settings.enableAffirm) paymentMethodTypes.push("affirm");
        if (settings.enableKlarna) paymentMethodTypes.push("klarna");

        // Fallback to card if nothing is selected
        if (paymentMethodTypes.length === 0) {
            paymentMethodTypes.push("card");
        }

        const projectId = paymentSchedule.invoice.projectId;
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000";

        // Create Stripe checkout session
        const stripeSession = await stripe.checkout.sessions.create({
            payment_method_types: paymentMethodTypes,
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: `Invoice #${paymentSchedule.invoice.code} - ${paymentSchedule.name}`,
                            description: paymentSchedule.invoice.project.name,
                        },
                        unit_amount: Math.round(paymentSchedule.amount * 100), // Stripe expects cents
                    },
                    quantity: 1,
                },
            ],
            mode: "payment",
            success_url: `${appUrl}/portal/projects/${projectId}?payment=success`,
            cancel_url: `${appUrl}/portal/projects/${projectId}?payment=cancelled`,
            metadata: {
                invoiceId: paymentSchedule.invoiceId,
                paymentScheduleId: paymentSchedule.id,
                projectId: projectId,
            },
        });

        // Store the session ID in the database
        await prisma.paymentSchedule.update({
            where: { id: paymentSchedule.id },
            data: { stripeSessionId: stripeSession.id }
        });

        return NextResponse.json({ url: stripeSession.url });

    } catch (error) {
        console.error("Error creating stripe session:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}
