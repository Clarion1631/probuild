import { getEstimateForPortal, getPublicCompanySettings, getPortalVisibility } from "@/lib/actions";
import { notFound, redirect } from "next/navigation";
import PortalEstimateClient from "./PortalEstimateClient";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { resolveDocUrl } from "@/lib/secure-storage";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { portalVisibleEstimateWhere } from "@/lib/estimate-portal-visibility";
import type { Prisma } from "@prisma/client";

// An explicit allowlist, not "any truthy role" — the staff branch of
// getEstimateForPortal bypasses the client gate entirely, so anything that can
// carry a role must be a known staff role to reach it.
const STAFF_ROLES = ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"];

export default async function PortalEstimatePage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    
    const staffSession = await getServerSession(authOptions);
    const isStaff = STAFF_ROLES.includes((staffSession?.user as { role?: string } | undefined)?.role ?? "");

    // Support sequential numeric ID double-routing lookups by resolving to the
    // canonical CUID. For a portal client this is scoped by the SAME rules the
    // detail fetch uses — ownership plus shared-ness. An unscoped lookup turns the
    // sequential `number` into an enumeration oracle: it hands back a real CUID
    // (confirming the estimate exists) even when getEstimateForPortal then denies it.
    const isNumeric = (str: string) => /^\d+$/.test(str);
    if (isNumeric(resolvedParams.id)) {
        let numberWhere: Prisma.EstimateWhereInput = { number: parseInt(resolvedParams.id, 10) };
        if (!isStaff) {
            const sessionClientId = await resolveSessionClientId();
            if (!sessionClientId) return notFound();
            numberWhere = {
                AND: [
                    numberWhere,
                    {
                        OR: [
                            { project: { is: { clientId: sessionClientId } } },
                            { lead: { is: { clientId: sessionClientId } } },
                        ],
                    },
                    portalVisibleEstimateWhere(),
                ],
            };
        }
        const est = await prisma.estimate.findFirst({
            where: numberWhere,
            select: { id: true }
        });
        if (est) {
            redirect(`/portal/estimates/${est.id}`);
        } else {
            return notFound();
        }
    }

    // Authorize BEFORE any money-path work. The QuickBooks pull below mutates
    // payment state, and it used to run first — so anyone holding a CUID could
    // trigger a sync on an estimate they cannot read. getEstimateForPortal is the
    // single authority for both callers (client ownership + shared-ness, or the
    // staff project scope), so it has to be what gates the sync. An earlier
    // version probed only the client path and let staff through unscoped; an
    // out-of-scope staff session could still drive the sync.
    const estimate = await getEstimateForPortal(resolvedParams.id);
    if (!estimate) {
        return notFound();
    }

    // Self-healing payment state: if a milestone on this estimate's invoice is
    // still Pending but lives on the QuickBooks rail, pull settled payments NOW
    // so a client returning from the Intuit pay page sees "Paid" immediately
    // (the hourly cron remains the backstop).
    const pendingQB = await prisma.paymentSchedule.findFirst({
        where: { status: "Pending", qbInvoiceId: { not: null }, invoice: { estimateId: resolvedParams.id } },
        select: { invoiceId: true },
    });
    if (pendingQB) {
        const { syncQuickBooksPayments } = await import("@/lib/quickbooks-payments");
        await syncQuickBooksPayments({ invoiceId: pendingQB.invoiceId }).catch(() => {});
        // The sync just rewrote the very payment rows `estimate` carries, and
        // getEstimateForPortal is request-cached — re-reading it would hand back
        // the pre-sync snapshot. Re-read the milestones directly and splice them
        // in, so the client sees "Paid" on this render rather than the next one.
        const freshInvoice = await prisma.invoice.findFirst({
            where: { estimateId: resolvedParams.id },
            select: {
                id: true, code: true, status: true,
                payments: {
                    select: {
                        id: true, name: true, amount: true, status: true, dueDate: true,
                        paidAt: true, paymentDate: true, paymentMethod: true,
                        stripeSessionId: true, qbInvoiceLink: true,
                    },
                    orderBy: { createdAt: "asc" },
                },
            },
            orderBy: { createdAt: "asc" },
        });
        if (freshInvoice) {
            (estimate as { invoices?: unknown[] }).invoices = JSON.parse(JSON.stringify([freshInvoice]));
        }
    }

    const settings = await getPublicCompanySettings();

    // Check portal visibility if estimate belongs to a project
    if (estimate.projectId) {
        const visibility = await getPortalVisibility(estimate.projectId);
        if (!visibility.showEstimates) {
            return (
                <div className="max-w-lg mx-auto py-16 text-center">
                    <div className="hui-card p-10">
                        <div className="w-14 h-14 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-5">
                            <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                        </div>
                        <h2 className="text-xl font-bold text-hui-textMain mb-2">This section is not available</h2>
                        <p className="text-hui-textMuted text-sm mb-6">Estimates are not currently visible for this project. Please contact your project manager for more information.</p>
                        <Link href="/portal" className="hui-btn hui-btn-secondary">Back to Portal</Link>
                    </div>
                </div>
            );
        }
    }

    const resolvedEstimate: any = {
        ...estimate,
        signatureUrl: await resolveDocUrl((estimate as any).signatureUrl),
    };
    if (Array.isArray((estimate as any).files)) {
        resolvedEstimate.files = await Promise.all(
            (estimate as any).files.map(async (f: any) => ({ ...f, url: await resolveDocUrl(f.url) }))
        );
    }

    return <PortalEstimateClient initialEstimate={resolvedEstimate} companySettings={settings} />;
}
