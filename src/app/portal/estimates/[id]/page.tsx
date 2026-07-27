import { getEstimateForPortal, getPublicCompanySettings, getPortalVisibility } from "@/lib/actions";
import { notFound, redirect } from "next/navigation";
import PortalEstimateClient from "./PortalEstimateClient";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { resolveDocUrl } from "@/lib/secure-storage";

export default async function PortalEstimatePage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    
    // Support sequential numeric ID double-routing lookups by resolving to the canonical CUID
    const isNumeric = (str: string) => /^\d+$/.test(str);
    if (isNumeric(resolvedParams.id)) {
        const est = await prisma.estimate.findFirst({
            where: { number: parseInt(resolvedParams.id, 10) },
            select: { id: true }
        });
        if (est) {
            redirect(`/portal/estimates/${est.id}`);
        } else {
            return notFound();
        }
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
    }

    const estimate = await getEstimateForPortal(resolvedParams.id);
    const settings = await getPublicCompanySettings();

    if (!estimate) {
        return notFound();
    }

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
