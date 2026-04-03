import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";

export async function POST(req: Request) {
    const payload = await req.text();
    const sig = req.headers.get("Stripe-Signature");
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !webhookSecret) {
        return new NextResponse("Missing Stripe Signature or Webhook Secret", { status: 400 });
    }

    let event;

    try {
        event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
    } catch (err: any) {
        console.error("Webhook signature verification failed:", err.message);
        return new NextResponse(`Webhook Error: ${err.message}`, { status: 400 });
    }

    try {
        switch (event.type) {
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded": {
                const session = event.data.object as any;
                
                // If it's a synchronous payment (card) OR a successful async payment (ACH)
                if (event.type === "checkout.session.completed" && session.payment_status !== "paid") {
                    // It's likely an async payment that will trigger async_payment_succeeded later
                    break; 
                }

                const metadata = session.metadata;
                if (!metadata?.paymentScheduleId || !metadata?.invoiceId) {
                    console.error("Missing metadata in session:", session.id);
                    break;
                }

                // Get payment intent to determine the method used
                let paymentMethod = "unknown";
                if (session.payment_intent) {
                    try {
                        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent as string);
                        const pmType = paymentIntent.payment_method_types?.[0]; // e.g. "card", "us_bank_account", "affirm"
                        if (pmType) {
                            if (pmType === "us_bank_account") paymentMethod = "ach";
                            else if (pmType === "card") paymentMethod = "card";
                            else paymentMethod = pmType;
                        }
                    } catch (e) {
                        console.error("Failed to retrieve payment intent", e);
                    }
                }

                // Update PaymentSchedule to Paid
                const updatedSchedule = await prisma.paymentSchedule.update({
                    where: { id: metadata.paymentScheduleId },
                    data: {
                        status: "Paid",
                        stripePaymentIntentId: session.payment_intent as string | null,
                        paymentMethod: paymentMethod,
                        paymentDate: new Date(),
                        paidAt: new Date(),
                    },
                    include: { invoice: true }
                });

                // Update Invoice balance and status
                const invoice = updatedSchedule.invoice;
                const newBalance = Math.max(0, (invoice.balanceDue || 0) - updatedSchedule.amount);
                const newStatus = newBalance <= 0 ? "Paid" : invoice.status;

                await prisma.invoice.update({
                    where: { id: invoice.id },
                    data: {
                        balanceDue: newBalance,
                        status: newStatus
                    }
                });

                // Send notification email
                const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (settings?.notificationEmail) {
                    await sendNotification(
                        settings.notificationEmail,
                        `Payment Received: ${updatedSchedule.name} - ${invoice.code}`,
                        `<div style="font-family: sans-serif; padding: 20px;">
                            <h2>Payment Received! 🎉</h2>
                            <p>A payment of <strong>$${updatedSchedule.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong> has been successfully processed via ${paymentMethod.toUpperCase()} for Invoice #${invoice.code}.</p>
                            <p>Milestone: ${updatedSchedule.name}</p>
                            <p>Remaining Invoice Balance: $${newBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                        </div>`
                    );
                }
                break;
            }
            case "checkout.session.async_payment_failed": {
                const session = event.data.object as any;
                const metadata = session.metadata;
                if (!metadata?.paymentScheduleId) break;

                // Update PaymentSchedule to Failed or just leave Pending but notify
                await prisma.paymentSchedule.update({
                    where: { id: metadata.paymentScheduleId },
                    data: {
                        status: "Pending", // Or "Failed" if you want a dedicated status
                        // Could add a notes field if necessary
                    }
                });

                // Send Notification
                const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (settings?.notificationEmail) {
                    await sendNotification(
                        settings.notificationEmail,
                        `🚨 ACH Payment Failed`,
                        `<p>An ACH payment for milestone <strong>${metadata.paymentScheduleId}</strong> has failed to settle.</p>
                         <p>Please check your Stripe dashboard for details.</p>`
                    );
                }
                break;
            }
            default:
                // Intentionally unhandled — Stripe sends many event types
                break;
        }
    } catch (error) {
        console.error("Error processing webhook:", error);
        return new NextResponse("Webhook Handler Error", { status: 500 });
    }

    return new NextResponse(JSON.stringify({ received: true }), { status: 200 });
}
