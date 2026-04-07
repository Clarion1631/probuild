import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { formatCurrency } from "@/lib/utils";
import { findOrCreateClientThread } from "@/lib/actions";

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

                // Get payment intent to determine the method used
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

                // ── Estimate payment branch ──────────────────────────────────
                if (metadata?.estimatePaymentScheduleId) {
                    // Atomic idempotency: updateMany with status != "Paid" closes TOCTOU race
                    const updatedEstSchedule = await prisma.$transaction(async (tx) => {
                        const result = await tx.estimatePaymentSchedule.updateMany({
                            where: { id: metadata.estimatePaymentScheduleId, status: { not: "Paid" } },
                            data: {
                                status: "Paid",
                                stripePaymentIntentId: session.payment_intent as string | null,
                                paymentMethod,
                                paymentDate: new Date(),
                                paidAt: new Date(),
                            },
                        });
                        if (result.count === 0) return null;

                        const schedule = await tx.estimatePaymentSchedule.findUnique({
                            where: { id: metadata.estimatePaymentScheduleId },
                            include: { estimate: true },
                        });

                        const estimate = schedule!.estimate;
                        const newBalance = Math.max(0, Number(estimate.balanceDue || 0) - Number(schedule!.amount));
                        const newStatus = newBalance <= 0 ? "Paid" : estimate.status;

                        await tx.estimate.update({
                            where: { id: estimate.id },
                            data: { balanceDue: newBalance, status: newStatus },
                        });

                        return schedule;
                    });

                    if (!updatedEstSchedule) {
                        console.log(`[webhook] EstimatePaymentSchedule ${metadata.estimatePaymentScheduleId} already paid — skipping duplicate event ${event.id}`);
                        break;
                    }

                    const estimate = updatedEstSchedule.estimate;
                    const newEstBalance = Math.max(0, Number(estimate.balanceDue || 0) - Number(updatedEstSchedule.amount));

                    const estSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                    if (estSettings?.notificationEmail) {
                        await sendNotification(
                            estSettings.notificationEmail,
                            `Estimate Payment Received: ${updatedEstSchedule.name} - ${estimate.code}`,
                            `<div style="font-family: sans-serif; padding: 20px;">
                                <h2>Estimate Payment Received! 🎉</h2>
                                <p>A payment of <strong>${formatCurrency(updatedEstSchedule.amount)}</strong> has been successfully processed via ${paymentMethod.toUpperCase()} for Estimate #${estimate.code}.</p>
                                <p>Milestone: ${updatedEstSchedule.name}</p>
                                <p>Remaining Estimate Balance: ${formatCurrency(newEstBalance)}</p>
                            </div>`
                        );
                    }

                    // Post activity to message thread if project-linked
                    const projectId = estimate.projectId;
                    if (projectId) {
                        try {
                            let thread = await prisma.messageThread.findFirst({
                                where: { projectId, subcontractorId: null },
                            });
                            if (!thread) {
                                thread = await prisma.messageThread.create({
                                    data: { projectId, subcontractorId: null },
                                });
                            }
                            await prisma.message.create({
                                data: {
                                    threadId: thread.id,
                                    senderType: "CLIENT",
                                    senderName: "System",
                                    body: `💰 Estimate payment received: ${formatCurrency(updatedEstSchedule.amount)} via ${paymentMethod.toUpperCase()} for Estimate #${estimate.code} — ${updatedEstSchedule.name}`,
                                },
                            });
                        } catch (e) {
                            console.error("[webhook] Failed to post estimate payment activity:", e);
                        }
                    }
                    break;
                }

                // ── Invoice payment branch ───────────────────────────────────
                if (!metadata?.paymentScheduleId || !metadata?.invoiceId) {
                    console.error("Missing metadata in session:", session.id);
                    break;
                }

                // Idempotency: skip if already paid (duplicate webhook delivery)
                const existingSchedule = await prisma.paymentSchedule.findUnique({
                    where: { id: metadata.paymentScheduleId },
                    select: { status: true, stripePaymentIntentId: true }
                });
                if (existingSchedule?.status === "Paid") {
                    console.log(`[webhook] PaymentSchedule ${metadata.paymentScheduleId} already paid — skipping duplicate event ${event.id}`);
                    break;
                }

                // Atomic: update schedule and invoice together
                const [updatedSchedule] = await prisma.$transaction(async (tx) => {
                    const schedule = await tx.paymentSchedule.update({
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

                    const invoice = schedule.invoice;
                    const newBalance = Math.max(0, Number(invoice.balanceDue || 0) - Number(schedule.amount));
                    const newStatus = newBalance <= 0 ? "Paid" : invoice.status;

                    await tx.invoice.update({
                        where: { id: invoice.id },
                        data: { balanceDue: newBalance, status: newStatus }
                    });

                    return [schedule];
                });

                const invoice = updatedSchedule.invoice;
                const newBalance = Math.max(0, Number(invoice.balanceDue || 0) - Number(updatedSchedule.amount));
                const newStatus = newBalance <= 0 ? "Paid" : invoice.status;

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
                        let thread = await prisma.messageThread.findFirst({
                            where: { projectId: invoice.projectId, subcontractorId: null },
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

                // Estimate branch
                if (metadata?.estimatePaymentScheduleId) {
                    await prisma.estimatePaymentSchedule.updateMany({
                        where: { id: metadata.estimatePaymentScheduleId, status: { not: "Paid" } },
                        data: { status: "Pending", stripeSessionId: null },
                    });
                    const estFailSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                    if (estFailSettings?.notificationEmail) {
                        await sendNotification(
                            estFailSettings.notificationEmail,
                            `🚨 ACH Estimate Payment Failed`,
                            `<p>An ACH payment for estimate milestone <strong>${metadata.estimatePaymentScheduleId}</strong> has failed to settle.</p>
                             <p>Please check your Stripe dashboard for details.</p>`
                        );
                    }
                    break;
                }

                // Invoice branch
                if (!metadata?.paymentScheduleId) break;

                await prisma.paymentSchedule.update({
                    where: { id: metadata.paymentScheduleId },
                    data: { status: "Pending" }
                });

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

                // Use this-event refund amount (not cumulative amount_refunded)
                const refundedAmount = (charge.refunds?.data?.[0]?.amount ?? charge.amount_refunded ?? 0) / 100;

                // Check estimate payment schedule first
                const estSchedule = await prisma.estimatePaymentSchedule.findFirst({
                    where: { stripePaymentIntentId: paymentIntentId },
                    include: { estimate: true },
                });
                if (estSchedule) {
                    if (estSchedule.status !== "Paid") break;
                    await prisma.$transaction(async (tx) => {
                        await tx.estimatePaymentSchedule.update({
                            where: { id: estSchedule.id },
                            data: { status: "Pending", paidAt: null },
                        });
                        await tx.estimate.update({
                            where: { id: estSchedule.estimate.id },
                            data: {
                                balanceDue: Number(estSchedule.estimate.balanceDue || 0) + refundedAmount,
                                status: "Approved",
                            },
                        });
                    });
                    break;
                }

                // Find the payment schedule tied to this payment intent and reverse it
                const schedule = await prisma.paymentSchedule.findFirst({
                    where: { stripePaymentIntentId: paymentIntentId },
                    include: { invoice: true },
                });
                if (!schedule) break;

                // Idempotency: skip if already reversed
                if (schedule.status === "Pending" || schedule.status === "Refunded") {
                    console.log(`[webhook] Schedule ${schedule.id} already reversed — skipping duplicate refund event ${event.id}`);
                    break;
                }

                // Atomic: reverse schedule and restore invoice together
                await prisma.$transaction(async (tx) => {
                    await tx.paymentSchedule.update({
                        where: { id: schedule.id },
                        data: { status: "Pending", paidAt: null },
                    });

                    await tx.invoice.update({
                        where: { id: schedule.invoice.id },
                        data: {
                            balanceDue: Number(schedule.invoice.balanceDue || 0) + refundedAmount,
                            status: "Sent",
                        },
                    });
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

                // Estimate branch: clear stale session ID so client can retry
                if (expiredMeta?.estimatePaymentScheduleId) {
                    await prisma.estimatePaymentSchedule.updateMany({
                        where: { id: expiredMeta.estimatePaymentScheduleId, status: { not: "Paid" } },
                        data: { stripeSessionId: null },
                    }).catch(() => {});
                    break;
                }

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
