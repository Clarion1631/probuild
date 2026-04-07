import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { formatCurrency } from "@/lib/utils";

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
                            <p>A payment of <strong>${formatCurrency(updatedSchedule.amount)}</strong> has been successfully processed via ${paymentMethod.toUpperCase()} for Invoice #${invoice.code}.</p>
                            <p>Milestone: ${updatedSchedule.name}</p>
                            <p>Remaining Invoice Balance: ${formatCurrency(newBalance)}</p>
                        </div>`
                    );
                }

                // Post payment activity to message thread
                if (invoice.projectId) {
                    try {
                        let thread = await prisma.messageThread.findUnique({
                            where: { projectId_subcontractorId: { projectId: invoice.projectId, subcontractorId: null } },
                        });
                        if (!thread) {
                            thread = await prisma.messageThread.create({
                                data: { projectId: invoice.projectId, subcontractorId: null },
                            });
                        }
                        await prisma.message.create({
                            data: {
                                threadId: thread.id,
                                senderType: "CLIENT",
                                senderName: "System",
                                body: `💰 Payment received: ${formatCurrency(updatedSchedule.amount)} via ${paymentMethod.toUpperCase()} for Invoice #${invoice.code} — ${updatedSchedule.name}`,
                            },
                        });
                    } catch (e) {
                        console.error("[webhook] Failed to post payment activity:", e);
                    }
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
            case "charge.refunded": {
                const charge = event.data.object as any;
                const paymentIntentId: string | null = charge.payment_intent ?? null;
                if (!paymentIntentId) break;

                // Find the payment schedule tied to this payment intent and reverse it
                const schedule = await prisma.paymentSchedule.findFirst({
                    where: { stripePaymentIntentId: paymentIntentId },
                    include: { invoice: true },
                });
                if (!schedule) break;

                const refundedAmount = (charge.amount_refunded ?? 0) / 100; // Stripe amounts are in cents

                await prisma.paymentSchedule.update({
                    where: { id: schedule.id },
                    data: { status: "Pending", paidAt: null },
                });

                // Restore invoice balance
                await prisma.invoice.update({
                    where: { id: schedule.invoice.id },
                    data: {
                        balanceDue: (schedule.invoice.balanceDue || 0) + refundedAmount,
                        status: "Sent",
                    },
                });

                const refundSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (refundSettings?.notificationEmail) {
                    await sendNotification(
                        refundSettings.notificationEmail,
                        `Refund Issued: Invoice ${schedule.invoice.code}`,
                        `<div style="font-family: sans-serif; padding: 20px;">
                            <h2>Refund Processed</h2>
                            <p>A refund of <strong>${formatCurrency(refundedAmount)}</strong> was issued for Invoice #${schedule.invoice.code} (milestone: ${schedule.name}).</p>
                            <p>The payment schedule has been reset to Pending and the invoice balance restored.</p>
                        </div>`
                    );
                }
                break;
            }
            case "charge.dispute.created": {
                const dispute = event.data.object as any;
                const disputeSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (disputeSettings?.notificationEmail) {
                    await sendNotification(
                        disputeSettings.notificationEmail,
                        `🚨 Payment Dispute Filed`,
                        `<div style="font-family: sans-serif; padding: 20px;">
                            <h2>Payment Dispute Opened</h2>
                            <p>A dispute has been filed for <strong>${formatCurrency((dispute.amount ?? 0) / 100)}</strong>.</p>
                            <p>Reason: ${dispute.reason ?? "Not specified"}</p>
                            <p>Dispute ID: ${dispute.id}</p>
                            <p>Please respond in your <a href="https://dashboard.stripe.com/disputes">Stripe dashboard</a> before the deadline.</p>
                        </div>`
                    );
                }
                break;
            }
            case "checkout.session.expired": {
                const expired = event.data.object as any;
                const expiredMeta = expired.metadata;
                if (!expiredMeta?.paymentScheduleId) break;

                const expiredSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (expiredSettings?.notificationEmail) {
                    await sendNotification(
                        expiredSettings.notificationEmail,
                        `Checkout Session Expired`,
                        `<div style="font-family: sans-serif; padding: 20px;">
                            <h2>Checkout Session Expired</h2>
                            <p>A customer did not complete their payment for milestone ID <strong>${expiredMeta.paymentScheduleId}</strong>.</p>
                            <p>The checkout link has expired. You may resend the invoice if needed.</p>
                        </div>`
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
