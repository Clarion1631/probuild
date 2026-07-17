import { getInvoiceForPortal, getCompanySettings, getPortalVisibility } from "@/lib/actions";
import { notFound, redirect } from "next/navigation";
import PortalInvoiceClient from "./PortalInvoiceClient";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { toNum } from "@/lib/prisma-helpers";
import { withTxRetry, lockMoneyParents } from "@/lib/tx-retry";
import { sendInvoicePaymentReceivedEmails } from "@/lib/payment-notifications";

// Fallback settlement for when the client lands back on the portal invoice page with a
// Stripe session_id before the webhook has processed it. Mirrors the webhook's invoice
// branch exactly: parent locked first, CLAIMED update (status not Paid, scoped to this
// invoice), recompute after the lock, and — only when THIS call won the claim — the same
// receipt/team-alert writer the webhook uses. The claim gate makes settlement + notification
// AT MOST ONCE across the two Stripe paths (whichever loses the claim stays silent), so no
// second lifecycle writer is introduced and no sibling payment's balance update is lost.
// (Guaranteed *delivery* — surviving a crash between commit and email — needs the durable
// outbox tracked as the deferred robustness item; the claim only prevents double sends.)
async function verifyStripeSession(sessionId: string, invoiceId: string): Promise<void> {
    try {
        const existing = await prisma.paymentSchedule.findFirst({
            where: { stripeSessionId: sessionId, status: "Paid" },
        });
        if (existing) return;

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status !== "paid") return;

        const metadata = session.metadata;
        if (!metadata?.paymentScheduleId || !metadata?.invoiceId) return;

        // Ownership check: ensure this Stripe session belongs to the invoice being viewed
        if (metadata.invoiceId !== invoiceId) return;

        const scheduleId = metadata.paymentScheduleId;

        let paymentMethod = "card";
        if (session.payment_intent) {
            try {
                const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string);
                const pmType = pi.payment_method_types?.[0];
                if (pmType === "us_bank_account") paymentMethod = "ach";
                else if (pmType) paymentMethod = pmType;
            } catch {}
        }

        const result = await withTxRetry(() => prisma.$transaction(async (t) => {
            await lockMoneyParents(t, { invoiceId });
            const claim = await t.paymentSchedule.updateMany({
                where: { id: scheduleId, invoiceId, status: { not: "Paid" } },
                data: {
                    status: "Paid",
                    stripeSessionId: sessionId,
                    stripePaymentIntentId: session.payment_intent as string | null,
                    paymentMethod,
                    paymentDate: new Date(),
                    paidAt: new Date(),
                },
            });
            const won = claim.count > 0;
            const allSchedules = await t.paymentSchedule.findMany({ where: { invoiceId } });
            const invoice = await t.invoice.findUnique({ where: { id: invoiceId }, include: { client: true } });
            if (!invoice) return { won: false, invoice: null as null, schedule: null as null, newBalance: 0 };
            const totalPaid = allSchedules
                .filter(s => s.status === "Paid")
                .reduce((sum, s) => sum + toNum(s.amount), 0);
            const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
            const newStatus = newBalance <= 0 ? "Paid" : totalPaid > 0 ? "Partially Paid" : invoice.status;
            await t.invoice.update({
                where: { id: invoice.id },
                data: { balanceDue: newBalance, status: newStatus },
            });
            const schedule = allSchedules.find(s => s.id === scheduleId) ?? null;
            return { won, invoice, schedule, newBalance };
        }));

        if (result.won && result.invoice && result.schedule) {
            await sendInvoicePaymentReceivedEmails({
                invoice: result.invoice,
                schedule: {
                    id: result.schedule.id,
                    name: result.schedule.name,
                    amount: toNum(result.schedule.amount),
                    referenceNumber: result.schedule.referenceNumber,
                },
                method: paymentMethod,
                newBalance: result.newBalance,
                referenceNumber: result.schedule.referenceNumber,
            });
        }
    } catch (e) {
        console.error("verifyStripeSession error:", e);
    }
}

export default async function PortalInvoicePage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ payment?: string; session_id?: string }>;
}) {
    const resolvedParams = await params;
    const resolvedSearch = await searchParams;

    // Support sequential numeric ID double-routing lookups by resolving to the canonical CUID
    const isNumeric = (str: string) => /^\d+$/.test(str);
    if (isNumeric(resolvedParams.id)) {
        const inv = await prisma.invoice.findFirst({
            where: { number: parseInt(resolvedParams.id, 10) },
            select: { id: true }
        });
        if (inv) {
            const queryParams = resolvedSearch.session_id ? `?session_id=${resolvedSearch.session_id}` : '';
            redirect(`/portal/invoices/${inv.id}${queryParams}`);
        } else {
            return notFound();
        }
    }

    if (resolvedSearch.session_id) {
        await verifyStripeSession(resolvedSearch.session_id, resolvedParams.id);
    }

    const invoice = await getInvoiceForPortal(resolvedParams.id);
    const settings = await getCompanySettings();

    if (!invoice) {
        return notFound();
    }

    // Check portal visibility if invoice belongs to a project
    if (invoice.projectId) {
        const visibility = await getPortalVisibility(invoice.projectId);
        if (!visibility.showInvoices) {
            return (
                <div className="max-w-lg mx-auto py-16 text-center">
                    <div className="hui-card p-10">
                        <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-5">
                            <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                        </div>
                        <h2 className="text-xl font-bold text-hui-textMain mb-2">This section is not available</h2>
                        <p className="text-hui-textMuted text-sm mb-6">Invoices are not currently visible for this project. Please contact your project manager for more information.</p>
                        <Link href="/portal" className="hui-btn hui-btn-secondary">Back to Portal</Link>
                    </div>
                </div>
            );
        }
    }

    return (
        <PortalInvoiceClient
            initialInvoice={invoice}
            companySettings={settings}
            paymentSuccess={resolvedSearch.payment === "success"}
        />
    );
}
