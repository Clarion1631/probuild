import { getEstimate, getLead } from "@/lib/actions";
import { notFound } from "next/navigation";
import EstimateEditor from "@/app/projects/[id]/estimates/[estimateId]/EstimateEditor";

export const dynamic = "force-dynamic";

export default async function LeadEstimatePage({ params }: { params: Promise<{ id: string, estimateId: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);
    const estimate = await getEstimate(resolvedParams.estimateId);

    if (!lead || !estimate) {
        notFound();
    }

    return (
        <div className="flex h-full -m-6 h-[calc(100vh-64px)] overflow-hidden">
            <div className="flex-1 overflow-auto bg-slate-50">
                <EstimateEditor
                    context={{
                        type: "lead",
                        id: lead.id,
                        name: lead.name,
                        clientName: lead.client.name,
                        clientEmail: lead.client.email || undefined,
                        location: lead.location || undefined
                    }}
                    initialEstimate={estimate}
                />
            </div>
        </div>
    );
}
