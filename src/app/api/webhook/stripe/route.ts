import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { toNum } from "@/lib/prisma-helpers";
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

                // Determine payment method from Stripe PaymentIntent
                let paymentMethod = "unknown";
                if (session.payment_intent) {
                    try {
                        const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent as string);
                        const pmType = paymentIntent.payment_method_types?.[0];
                        if (pmType) {
                            if (pmType === "us_bank_account") paymentMethod = "ach";
                            else if (pmType === "card") paymentMethod = "card";
                            else paymentMethod = pmType;
                        }
                    } catch (e) {
                        console.error("Failed to retrieve payment intent", e);
                    }
                }

                // ── Invoice payment branch ──────────────────────────────────
                if (metadata?.paymentScheduleId && metadata?.invoiceId) {
                    await prisma.paymentSchedule.update({
                        where: { id: metadata.paymentScheduleId },
                        data: {
                            status: "Paid",
                            stripePaymentIntentId: session.payment_intent as string | null,
                            paymentMethod: paymentMethod,
                            paymentDate: new Date(),
                            paidAt: new Date(),
                        },
                    });

                    // Codex R2 Finding 3: recalculate from scratch to avoid race conditions
                    const allInvSchedules = await prisma.paymentSchedule.findMany({
                        where: { invoiceId: metadata.invoiceId },
                    });
                    const invoice = await prisma.invoice.findUnique({ where: { id: metadata.invoiceId } });
                    if (invoice) {
                        const totalInvPaid = allInvSchedules
                            .filter(s => s.status === "Paid")
                            .reduce((sum, s) => sum + toNum(s.amount), 0);
                        const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalInvPaid);
                        const newStatus = newBalance <= 0 ? "Paid" : invoice.status;

                        await prisma.invoice.update({
                            where: { id: invoice.id },
                            data: { balanceDue: newBalance, status: newStatus }
                        });

                        const paidSchedule = allInvSchedules.find(s => s.id === metadata.paymentScheduleId);
                        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                        if (settings?.notificationEmail && paidSchedule) {
                            await sendNotification(
                                settings.notificationEmail,
                                `Payment Received: ${paidSchedule.name} - ${invoice.code}`,
                                `<div style="font-family: sans-serif; padding: 20px;">
                                    <h2>Payment Received! 🎉</h2>
                                    <p>A payment of <strong>${formatCurrency(paidSchedule.amount)}</strong> has been successfully processed via ${paymentMethod.toUpperCase()} for Invoice #${invoice.code}.</p>
                                    <p>Milestone: ${paidSchedule.name}</p>
                                    <p>Remaining Invoice Balance: ${formatCurrency(newBalance)}</p>
                                </div>`
                            );
                        }
                    }
                }
                // ── Estimate payment branch ─────────────────────────────────
                else if (metadata?.estimatePaymentScheduleId && metadata?.estimateId) {
                    const updatedSchedule = await prisma.estimatePaymentSchedule.update({
                        where: { id: metadata.estimatePaymentScheduleId },
                        data: {
                            status: "Paid",
                            stripePaymentIntentId: session.payment_intent as string | null,
                            paymentMethod: paymentMethod,
                            paymentDate: new Date(),
                            paidAt: new Date(),
                        },
                        include: { estimate: true }
                    });

                    // Recalculate estimate balanceDue from remaining unpaid schedules
                    const allSchedules = await prisma.estimatePaymentSchedule.findMany({
                        where: { estimateId: metadata.estimateId },
                    });
                    const totalPaid = allSchedules
                        .filter(s => s.status === "Paid")
                        .reduce((sum, s) => sum + toNum(s.amount), 0);
                    const estimateTotal = toNum(updatedSchedule.estimate.totalAmount);
                    const newBalance = Math.max(0, estimateTotal - totalPaid);

                    await prisma.estimate.update({
                        where: { id: metadata.estimateId },
                        data: { balanceDue: newBalance }
                    });

                    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                    if (settings?.notificationEmail) {
                        await sendNotification(
                            settings.notificationEmail,
                            `Estimate Payment Received: ${updatedSchedule.name} - ${updatedSchedule.estimate.code}`,
                            `<div style="font-family: sans-serif; padding: 20px;">
                                <h2>Estimate Payment Received! 🎉</h2>
                                <p>A payment of <strong>${formatCurrency(updatedSchedule.amount)}</strong> has been successfully processed via ${paymentMethod.toUpperCase()} for Estimate #${updatedSchedule.estimate.code}.</p>
                                <p>Milestone: ${updatedSchedule.name}</p>
                                <p>Remaining Estimate Balance: ${formatCurrency(newBalance)}</p>
                            </div>`
                        );
                    }
                }
                else {
                    console.error("Missing metadata in session:", session.id);
                }
                break;
            }
            case "checkout.session.async_payment_failed": {
                const session = event.data.object as any;
                const metadata = session.metadata;

                // Invoice payment failure
                if (metadata?.paymentScheduleId) {
                    await prisma.paymentSchedule.update({
                        where: { id: metadata.paymentScheduleId },
                        data: { status: "Pending" }
                    });
                }
                // Estimate payment failure
                else if (metadata?.estimatePaymentScheduleId) {
                    await prisma.estimatePaymentSchedule.update({
                        where: { id: metadata.estimatePaymentScheduleId },
                        data: { status: "Pending" }
                    });
                }
                else {
                    break;
                }

                const failSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (failSettings?.notificationEmail) {
                    const milestoneId = metadata.paymentScheduleId || metadata.estimatePaymentScheduleId;
                    const docType = metadata.paymentScheduleId ? "invoice" : "estimate";
                    await sendNotification(
                        failSettings.notificationEmail,
                        `ACH Payment Failed`,
                        `<p>An ACH payment for ${docType} milestone <strong>${milestoneId}</strong> has failed to settle.</p>
                         <p>Please check your Stripe dashboard for details.</p>`
                    );
                }
                break;
            }
            case "charge.refunded": {
                const charge = event.data.object as any;
                const paymentIntentId: string | null = charge.payment_intent ?? null;
                if (!paymentIntentId) break;

                const refundedAmount = (charge.amount_refunded ?? 0) / 100;

                // Try invoice payment schedule first
                const invoiceSchedule = await prisma.paymentSchedule.findFirst({
                    where: { stripePaymentIntentId: paymentIntentId },
                    include: { invoice: true },
                });

                if (invoiceSchedule) {
                    await prisma.paymentSchedule.update({
                        where: { id: invoiceSchedule.id },
                        data: { status: "Pending", paidAt: null },
                    });

                    // Recalculate invoice balance from scratch
                    const allSchedules = await prisma.paymentSchedule.findMany({
                        where: { invoiceId: invoiceSchedule.invoiceId },
                    });
                    const totalPaid = allSchedules
                        .filter(s => s.status === "Paid")
                        .reduce((sum, s) => sum + toNum(s.amount), 0);
                    const newBalance = Math.max(0, toNum(invoiceSchedule.invoice.totalAmount) - totalPaid);

                    await prisma.invoice.update({
                        where: { id: invoiceSchedule.invoice.id },
                        data: {
                            balanceDue: newBalance,
                            status: newBalance > 0 ? "Issued" : "Paid",
                        },
                    });

                    const refundSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                    if (refundSettings?.notificationEmail) {
                        await sendNotification(
                            refundSettings.notificationEmail,
                            `Refund Issued: Invoice ${invoiceSchedule.invoice.code}`,
                            `<div style="font-family: sans-serif; padding: 20px;">
                                <h2>Refund Processed</h2>
                                <p>A refund of <strong>${formatCurrency(refundedAmount)}</strong> was issued for Invoice #${invoiceSchedule.invoice.code} (milestone: ${invoiceSchedule.name}).</p>
                                <p>The payment schedule has been reset to Pending and the invoice balance restored.</p>
                            </div>`
                        );
                    }
                    break;
                }

                // Codex R2 Finding 2: Try estimate payment schedule
                const estSchedule = await prisma.estimatePaymentSchedule.findFirst({
                    where: { stripePaymentIntentId: paymentIntentId },
                    include: { estimate: true },
                });

                if (estSchedule) {
                    await prisma.estimatePaymentSchedule.update({
                        where: { id: estSchedule.id },
                        data: { status: "Pending", paidAt: null },
                    });

                    // Recalculate estimate balance from scratch
                    const allEstSchedules = await prisma.estimatePaymentSchedule.findMany({
                        where: { estimateId: estSchedule.estimateId },
                    });
                    const totalEstPaid = allEstSchedules
                        .filter(s => s.status === "Paid")
                        .reduce((sum, s) => sum + toNum(s.amount), 0);
                    const newEstBalance = Math.max(0, toNum(estSchedule.estimate.totalAmount) - totalEstPaid);

                    await prisma.estimate.update({
                        where: { id: estSchedule.estimateId },
                        data: { balanceDue: newEstBalance },
                    });

                    const refundSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                    if (refundSettings?.notificationEmail) {
                        await sendNotification(
                            refundSettings.notificationEmail,
                            `Refund Issued: Estimate ${estSchedule.estimate.code}`,
                            `<div style="font-family: sans-serif; padding: 20px;">
                                <h2>Refund Processed</h2>
                                <p>A refund of <strong>${formatCurrency(refundedAmount)}</strong> was issued for Estimate #${estSchedule.estimate.code} (milestone: ${estSchedule.name}).</p>
                                <p>The payment schedule has been reset to Pending and the estimate balance restored.</p>
                            </div>`
                        );
                    }
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
                const milestoneId = expiredMeta?.paymentScheduleId || expiredMeta?.estimatePaymentScheduleId;
                if (!milestoneId) break;

                const docType = expiredMeta?.paymentScheduleId ? "invoice" : "estimate";
                const expiredSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (expiredSettings?.notificationEmail) {
                    await sendNotification(
                        expiredSettings.notificationEmail,
                        `Checkout Session Expired`,
                        `<div style="font-family: sans-serif; padding: 20px;">
                            <h2>Checkout Session Expired</h2>
                            <p>A customer did not complete their ${docType} payment for milestone ID <strong>${milestoneId}</strong>.</p>
                            <p>The checkout link has expired. You may resend the ${docType} if needed.</p>
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
