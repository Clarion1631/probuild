import { getEstimate, getLead, getCompanySettings, getEstimateActivity } from "@/lib/actions";
import { notFound } from "next/navigation";
import EstimateEditor from "@/app/projects/[id]/estimates/[estimateId]/EstimateEditor";

export const dynamic = "force-dynamic";

export default async function LeadEstimatePage({ params }: { params: Promise<{ id: string, estimateId: string }> }) {
    const resolvedParams = await params;
    const [lead, estimate, settings, activityEvents] = await Promise.all([
        getLead(resolvedParams.id),
        getEstimate(resolvedParams.estimateId),
        getCompanySettings(),
        getEstimateActivity(resolvedParams.estimateId),
    ]);

    if (!lead || !estimate) {
        notFound();
    }

    const serializedEstimate = JSON.parse(JSON.stringify(estimate));

    let salesTaxes: { id?: string; name: string; rate: number; isDefault: boolean }[] = [];
    try {
        salesTaxes = settings.salesTaxes ? JSON.parse(settings.salesTaxes) : [];
    } catch { /* ignore parse errors */ }

    return (
        <div className="flex-1 flex h-full overflow-hidden">
            <div className="flex-1 bg-slate-50 overflow-hidden flex flex-col">
                <EstimateEditor
                    context={{
                        type: "lead",
                        id: lead.id,
                        name: lead.name,
                        clientName: lead.client.name,
                        clientEmail: lead.client.email || undefined,
                        location: lead.location || undefined,
                        clientTaxExemptCertUrl: (lead.client as any)?.taxExemptCertUrl || null,
                        clientTaxExemptCertExpiresAt: (lead.client as any)?.taxExemptCertExpiresAt?.toISOString?.() || null
                    }}
                    initialEstimate={serializedEstimate}
                    salesTaxes={salesTaxes}
                    settings={settings}
                    activityEvents={activityEvents}
                />
            </div>
        </div>
    );
}
