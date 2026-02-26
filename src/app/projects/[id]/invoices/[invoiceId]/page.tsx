import { getProject } from "@/lib/actions";
import { getInvoice } from "@/lib/actions";
import { notFound } from "next/navigation";
import InvoiceEditor from "./InvoiceEditor";

export default async function InvoicePage({ params }: { params: { id: string, invoiceId: string } }) {
    const { id, invoiceId } = await params;

    // Fetch critical project and specific invoice data
    const project = await getProject(id);
    const initialInvoice = await getInvoice(invoiceId);

    if (!project || !initialInvoice) {
        notFound();
    }

    return (
        <div className="h-full bg-slate-50 relative">
            <InvoiceEditor project={project} initialInvoice={initialInvoice} />
        </div>
    );
}
