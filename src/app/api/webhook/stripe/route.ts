import { NextResponse } from "next/server";
import { after } from "next/server";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { withTxRetry, lockMoneyParents } from "@/lib/tx-retry";
import { enqueueMilestonePaid, drainPaymentNotifications } from "@/lib/payment-outbox";
import { sendNotification } from "@/lib/email";
import { toNum } from "@/lib/prisma-helpers";
import { formatCurrency } from "@/lib/utils";
import { settleStripeEstimatePayment } from "@/lib/stripe-estimate-settlement";
import { mirrorInvoiceSettleToEstimate } from "@/lib/payment-mirror";
import {
    resolveChargeGroup,
    unwindRefundedCharge,
    chargeGroupIsEmpty,
    type UnwindResult,
} from "@/lib/refund-group";

// Helper function to process a single event by eventId asynchronously
async function processEvent(eventId: string) {
    try {
        const stripeEvent = await prisma.stripeEvent.findUnique({
            where: { id: eventId }
        });
        
        if (!stripeEvent) {
            console.error(`StripeEvent not found for ID: ${eventId}`);
            return;
        }

        // If it's already processed, skip
        if (stripeEvent.status === "PROCESSED") {
            return;
        }

        const event = JSON.parse(stripeEvent.payload);

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
                    // One transaction: claim Pending→Paid, re-read sibling schedules, and update the parent
                    // invoice balance/status. This prevents two concurrent webhooks on different schedules of
                    // the same invoice from each reading a stale sibling-set and racing each other's parent update.
                    const scheduleId = metadata.paymentScheduleId;
                    const invoiceId = metadata.invoiceId;
                    const tx = await withTxRetry(() => prisma.$transaction(async (t) => {
                        // Lock the parents in canonical Estimate → Invoice → schedules order.
                        // Two concurrent webhooks settling different milestones of the same
                        // invoice would otherwise each read a stale sibling set and overwrite
                        // each other's balanceDue — the lock serializes the recompute so the
                        // second waits and reads fresh state. The estimate is locked too because
                        // this branch mirrors onto the estimate-side milestone copy below; the
                        // link is read non-locking first so the order can never invert.
                        const invLink = await t.invoice.findUnique({ where: { id: invoiceId }, select: { estimateId: true } });
                        await lockMoneyParents(t, { estimateId: invLink?.estimateId, invoiceId });
                        const claim = await t.paymentSchedule.updateMany({
                            where: { id: scheduleId, status: { not: "Paid" } },
                            data: {
                                status: "Paid",
                                stripePaymentIntentId: session.payment_intent as string | null,
                                paymentMethod,
                                paymentDate: new Date(),
                                paidAt: new Date(),
                            },
                        });
                        const alreadyPaid = claim.count === 0;
                        const siblings = await t.paymentSchedule.findMany({ where: { invoiceId } });
                        const invoice = await t.invoice.findUnique({ where: { id: invoiceId }, include: { client: true } });
                        if (!invoice) return { alreadyPaid, invoice: null as null, paidSchedule: null as null, newBalance: 0 };
                        const totalPaid = siblings.filter(s => s.status === "Paid").reduce((sum, s) => sum + toNum(s.amount), 0);
                        const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
                        const newStatus = newBalance <= 0
                            ? "Paid"
                            : totalPaid > 0 ? "Partially Paid"
                            : invoice.status;
                        await t.invoice.update({
                            where: { id: invoiceId },
                            data: { balanceDue: newBalance, status: newStatus },
                        });
                        const paidSchedule = siblings.find(s => s.id === scheduleId) ?? null;
                        // Mirror onto the estimate-side copy so the estimate editor and the
                        // client portal don't keep showing this milestone as unpaid.
                        if (!alreadyPaid && paidSchedule) {
                            await mirrorInvoiceSettleToEstimate(t, {
                                estimateId: invLink?.estimateId,
                                payment: paidSchedule,
                                data: {
                                    paymentDate: paidSchedule.paymentDate ?? new Date(),
                                    paidAt: paidSchedule.paidAt ?? new Date(),
                                    paymentMethod,
                                    // Same metadata the portal fallback writes, so the mirror
                                    // looks identical whichever rail wins the settle claim.
                                    stripeSessionId: session.id,
                                    stripePaymentIntentId: (session.payment_intent as string | null) ?? null,
                                },
                            });
                        }
                        // Durable notification enqueued in-tx (delivered by the drainer below).
                        if (!alreadyPaid) {
                            await enqueueMilestonePaid(t, { scheduleId, scheduleType: "invoice" });
                        }
                        return { alreadyPaid, invoice, paidSchedule, newBalance };
                    }));
                    if (!tx.alreadyPaid) {
                        await drainPaymentNotifications({ scheduleId }).catch(() => {});
                    }
                }
                // ── Estimate payment branch ─────────────────────────────────
                else if (metadata?.estimatePaymentScheduleId && metadata?.estimateId) {
                    const scheduleId = metadata.estimatePaymentScheduleId;
                    const estimateId = metadata.estimateId;
                    const paidAt = new Date();
                    const tx = await settleStripeEstimatePayment({
                        estimateId,
                        scheduleId,
                        settlement: {
                            stripeSessionId: session.id,
                            stripePaymentIntentId: (session.payment_intent as string | null) ?? null,
                            paymentMethod,
                            paymentDate: paidAt,
                            paidAt,
                        },
                        enqueueNotification: true,
                    });
                    if (!tx.found) {
                        throw new Error(`Estimate milestone ${scheduleId} was not found on estimate ${estimateId}`);
                    }
                    if (tx.notificationEnqueued) {
                        await drainPaymentNotifications({ scheduleId }).catch(() => {});
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

                const chargeAmount = (charge.amount ?? 0) / 100;
                const refundedAmount = (charge.amount_refunded ?? 0) / 100;
                // Only reset the schedule to Pending when the charge is FULLY refunded.
                // Partial refunds leave the schedule Paid and notify the office so the
                // bookkeeper can reconcile manually; Stripe's `charge.refunded` fires on
                // every partial refund and on the final full refund.
                const isFullyRefunded = chargeAmount > 0
                    && Math.abs(chargeAmount - refundedAmount) < 0.005;

                // One charge can be recorded on several milestone rows across both
                // tables — invoice conversion copies the PaymentIntent onto every
                // clone of an already-paid estimate milestone. Resolve the whole
                // group so a full refund releases all of it, instead of picking one
                // row and leaving the rest showing money the client got back.
                // See src/lib/refund-group.ts.
                const group = await resolveChargeGroup(prisma, paymentIntentId);
                if (chargeGroupIsEmpty(group)) break;

                let unwound: UnwindResult | null = null;
                if (isFullyRefunded) {
                    unwound = await unwindRefundedCharge(prisma, paymentIntentId);
                }

                const refundSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                if (refundSettings?.notificationEmail) {
                    const label = (rows: { name: string; parentCode: string | null }[]) =>
                        rows.map((r) => `${r.parentCode ?? "(no code)"} — ${r.name}`);
                    const found = [...label(group.invoiceSchedules), ...label(group.estimateSchedules)];
                    const reset = unwound
                        ? [...label(unwound.invoiceSchedules), ...label(unwound.estimateSchedules)]
                        : [];
                    // Paid mirror partners with no PaymentIntent that sit in a one-to-many
                    // group: they might be this charge or a separate manual payment, so the
                    // unwind refuses to guess and hands them to a human instead.
                    const ambiguous = label(unwound?.unattributable ?? group.unattributable);
                    // `charge.amount_refunded` is the CUMULATIVE refund total, so this message reflects
                    // total-refunded-so-far, not this delivery's delta. We frame it that way explicitly.
                    const summary = !isFullyRefunded
                        ? `This is a <strong>partial refund</strong>. The milestones below remain marked Paid; please reconcile the balances manually in the Stripe dashboard.`
                        // An earlier delivery of this same refund already did the work — say so
                        // rather than reporting a failure the office would chase.
                        : unwound?.alreadyUnwound
                        ? `Already reconciled by an earlier delivery of this refund. Nothing was left to reset.`
                        : reset.length === found.length
                        ? `All ${reset.length} milestone(s) recording this charge were reset to Pending and their balances restored.`
                        : reset.length > 0
                        ? `${reset.length} of ${found.length} milestone(s) were reset. The rest no longer matched this charge when the refund was processed — please reconcile them manually in the Stripe dashboard.`
                        : `These milestones were <strong>not</strong> reset automatically — they no longer matched this charge when the refund was processed. Please reconcile the balances manually in the Stripe dashboard.`;
                    const primaryCode = group.invoiceSchedules[0]?.parentCode
                        ?? group.estimateSchedules[0]?.parentCode
                        ?? group.unattributable[0]?.parentCode
                        ?? paymentIntentId;
                    await sendNotification(
                        refundSettings.notificationEmail,
                        `${isFullyRefunded ? "Refund Issued" : "Partial Refund Issued"}: ${primaryCode}`,
                        `<div style="font-family: sans-serif; padding: 20px;">
                            <h2>Refund Processed</h2>
                            <p>Total refunded to date: <strong>${formatCurrency(refundedAmount)}</strong> of ${formatCurrency(chargeAmount)}.</p>
                            ${found.length > 0 ? `<p>Milestones recording this charge:</p>
                            <ul>${found.map((l) => `<li>${l}</li>`).join("")}</ul>` : ""}
                            <p>${summary}</p>
                            ${ambiguous.length > 0 ? `<p><strong>Needs a human:</strong> these milestones mirror one of the above but carry no
                            payment reference, so we cannot tell whether they recorded this charge or a separate
                            payment. They were left as-is — please check them in the Stripe dashboard:</p>
                            <ul>${ambiguous.map((l) => `<li>${l}</li>`).join("")}</ul>` : ""}
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

        // Mark as successfully processed
        await prisma.stripeEvent.update({
            where: { id: eventId },
            data: {
                status: "PROCESSED",
                processedAt: new Date(),
                error: null
            }
        });
    } catch (err: any) {
        console.error(`Error processing StripeEvent ${eventId}:`, err);
        // Mark as failed and store error
        await prisma.stripeEvent.update({
            where: { id: eventId },
            data: {
                status: "FAILED",
                error: err.message || String(err)
            }
        });
    }
}

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
        // Record raw verified event into the StripeEvent table for idempotency and durability
        const stripeEvent = await prisma.stripeEvent.upsert({
            where: { id: event.id },
            create: {
                id: event.id,
                type: event.type,
                payload: JSON.stringify(event),
                status: "PENDING"
            },
            update: {} // If it already exists, don't change its state
        });

        // If the event has already been successfully processed, just return immediately
        if (stripeEvent.status === "PROCESSED") {
            return new NextResponse(JSON.stringify({ received: true, alreadyProcessed: true }), { status: 200 });
        }

        // Schedule background processing of the event using Next.js after() to immediately release the webhook thread
        after(async () => {
            await processEvent(event.id);
        });

    } catch (error: any) {
        console.error("Error storing StripeEvent:", error);
        // If we fail to even store the event (e.g. database connection issue), we return 500 so Stripe retries it
        return new NextResponse("Webhook Database Queueing Error", { status: 500 });
    }

    return new NextResponse(JSON.stringify({ received: true }), { status: 200 });
}
