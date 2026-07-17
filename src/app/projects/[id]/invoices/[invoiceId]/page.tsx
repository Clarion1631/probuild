import { getProject } from "@/lib/actions";
import { getInvoice } from "@/lib/actions";
import { notFound } from "next/navigation";
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

    return (
        <div className="h-full bg-slate-50 relative">
            <InvoiceEditor project={project} initialInvoice={initialInvoice} />
        </div>
    );
}
