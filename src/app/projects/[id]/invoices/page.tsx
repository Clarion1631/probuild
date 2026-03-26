import { getProject, getProjectInvoices } from "@/lib/actions";
import InvoiceListClient from "./InvoiceListClient";

export default async function ProjectInvoices({ params }: { params: { id: string } }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) return <div className="p-6 text-hui-textMain">Project not found</div>;
    const invoices = await getProjectInvoices(id);

    return (
        <div className="flex h-full bg-hui-background">
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-6xl mx-auto space-y-6">
                    <InvoiceListClient project={project} invoices={invoices} />
                </div>
            </div>
        </div>
    );
}
