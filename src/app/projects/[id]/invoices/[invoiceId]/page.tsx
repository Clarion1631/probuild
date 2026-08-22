import { getProject } from "@/lib/actions";
import { getInvoice } from "@/lib/actions";
import { notFound } from "next/navigation";
import { fetchCheckEvidenceForPayments, type CheckEvidence } from "@/lib/check-evidence";
import InvoiceEditor from "./InvoiceEditor";

export default async function InvoicePage({ params }: { params: Promise<{ id: string, invoiceId: string }> }) {
    const { id, invoiceId } = await params;

    // Fetch critical project and specific invoice data
    const project = await getProject(id);
    const initialInvoice = await getInvoice(invoiceId);

    if (!project || !initialInvoice) {
        notFound();
    }

    // The route's project id and the invoice's own projectId must agree —
    // otherwise this would render an invoice from a different project inside
    // this project's page (and its DocumentComments mount would read/write
    // against invoiceId while every other action on this page trusts `id`).
    if (initialInvoice.projectId !== id) {
        notFound();
    }

    // Check evidence for paid-by-check milestones: a human-confirmed
    // BankImageMatch whose check number AND amount agree lets the editor show
    // "Paid by <payer>, chk#<n>" from the physical instrument. Display-only
    // and best-effort — a failure here must never take down the invoice.
    let checkEvidence: Record<string, CheckEvidence> = {};
    try {
        checkEvidence = await fetchCheckEvidenceForPayments(
            (initialInvoice.payments ?? [])
                .filter((p) => p.status === "Paid" && p.referenceNumber)
                .map((p) => ({
                    id: p.id,
                    referenceNumber: p.referenceNumber,
                    // Decimal dollars → integer cents; a NaN becomes null and
                    // the matcher skips it rather than matching loosely.
                    amountCents: Number.isFinite(Number(p.amount)) ? Math.round(Number(p.amount) * 100) : null,
                })),
        );
    } catch (error) {
        console.error("check evidence fetch failed", error instanceof Error ? error.message : "UnknownError");
    }

    return (
        <div className="h-full bg-slate-50 relative">
            <InvoiceEditor project={project} initialInvoice={initialInvoice} checkEvidence={checkEvidence} />
        </div>
    );
}
