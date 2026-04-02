import { getProject } from "@/lib/actions";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import NewInvoiceClient from "./NewInvoiceClient";

export default async function NewInvoicePage({ params }: { params: { id: string } }) {
    const { id } = await params;
    const project = await getProject(id);
    
    if (!project) return <div className="p-6 text-hui-textMain">Project not found</div>;

    // Fetch estimates with payment schedules for milestone count display
    const estimates = await prisma.estimate.findMany({
        where: { projectId: id },
        orderBy: { createdAt: "desc" },
        include: { paymentSchedules: true },
    });

    return (
        <div className="flex h-full bg-hui-background">
            <div className="flex-1 overflow-auto p-8">
                <div className="max-w-6xl mx-auto space-y-6">
                    <div className="flex items-center gap-4 border-b border-hui-border pb-4">
                        <Link href={`/projects/${project.id}/invoices`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm w-fit">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                            Back to Invoices
                        </Link>
                    </div>
                    
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain mb-2">Generate New Invoice</h1>
                        <p className="text-hui-textMuted text-sm">Select an estimate to automatically generate an invoice with mapped line items from the estimate's payment schedule.</p>
                    </div>

                    <NewInvoiceClient project={project} estimates={estimates} />
                </div>
            </div>
        </div>
    );
}
