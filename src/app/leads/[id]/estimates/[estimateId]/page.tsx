import { getEstimate, getLead, getCompanySettings } from "@/lib/actions";
import { notFound } from "next/navigation";
import EstimateEditor from "@/app/projects/[id]/estimates/[estimateId]/EstimateEditor";

export const dynamic = "force-dynamic";

export default async function LeadEstimatePage({ params }: { params: Promise<{ id: string, estimateId: string }> }) {
    const resolvedParams = await params;
    const [lead, estimate, settings] = await Promise.all([
        getLead(resolvedParams.id),
        getEstimate(resolvedParams.estimateId),
        getCompanySettings(),
    ]);

    if (!lead || !estimate) {
        notFound();
    }

    const serializedEstimate = JSON.parse(JSON.stringify(estimate));

    let salesTaxes: { name: string; rate: number; isDefault: boolean }[] = [];
    try {
        salesTaxes = settings.salesTaxes ? JSON.parse(settings.salesTaxes) : [];
    } catch { /* ignore parse errors */ }
    const defaultTax = salesTaxes.find(t => t.isDefault) || salesTaxes[0] || null;

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
                    initialEstimate={serializedEstimate}
                    defaultTax={defaultTax}
                />
            </div>
        </div>
    );
}
