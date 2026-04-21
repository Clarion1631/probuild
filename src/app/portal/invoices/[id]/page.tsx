import { getInvoiceForPortal, getCompanySettings, getPortalVisibility } from "@/lib/actions";
import { notFound } from "next/navigation";
import PortalInvoiceClient from "./PortalInvoiceClient";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { toNum } from "@/lib/prisma-helpers";

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

        let paymentMethod = "card";
        if (session.payment_intent) {
            try {
                const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string);
                const pmType = pi.payment_method_types?.[0];
                if (pmType === "us_bank_account") paymentMethod = "ach";
                else if (pmType) paymentMethod = pmType;
            } catch {}
        }

        await prisma.paymentSchedule.update({
            where: { id: metadata.paymentScheduleId },
            data: {
                status: "Paid",
                stripePaymentIntentId: session.payment_intent as string | null,
                paymentMethod,
                paymentDate: new Date(),
                paidAt: new Date(),
            },
        });

        const allSchedules = await prisma.paymentSchedule.findMany({
            where: { invoiceId: metadata.invoiceId },
        });
        const invoice = await prisma.invoice.findUnique({ where: { id: metadata.invoiceId } });
        if (invoice) {
            const totalPaid = allSchedules
                .filter(s => s.status === "Paid")
                .reduce((sum, s) => sum + toNum(s.amount), 0);
            const newBalance = Math.max(0, toNum(invoice.totalAmount) - totalPaid);
            await prisma.invoice.update({
                where: { id: invoice.id },
                data: { balanceDue: newBalance, status: newBalance <= 0 ? "Paid" : invoice.status },
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
