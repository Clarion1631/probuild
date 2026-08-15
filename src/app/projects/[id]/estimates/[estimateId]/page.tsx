import { getEstimate, getProject, getCompanySettings, getEstimateActivity } from "@/lib/actions";
import EstimateEditor from "./EstimateEditor";
import { notFound } from "next/navigation";
import { resolveDocUrl } from "@/lib/secure-storage";
import { parseSalesTaxes } from "@/lib/sales-tax";
import { sanitizeCompanySalesTaxes } from "@/lib/estimate-tax-options";

export const dynamic = "force-dynamic";

export default async function EstimatePage({
    params
}: {
    params: Promise<{ id: string; estimateId: string }>
}) {
    const resolvedParams = await params;
    const [project, estimate, settings, activityEvents] = await Promise.all([
        getProject(resolvedParams.id),
        getEstimate(resolvedParams.estimateId),
        getCompanySettings(),
        getEstimateActivity(resolvedParams.estimateId),
    ]);

    if (!project) return <div>Project not found</div>;
    if (!estimate) {
        notFound();
    }

    // Parse sales taxes from company settings. parseSalesTaxes, not a hand-rolled JSON.parse: the
    // stored value can be "null" or "{}" (both parse fine and are not arrays) or an array holding
    // nulls, and the editor maps over this.
    const salesTaxes = sanitizeCompanySalesTaxes(parseSalesTaxes(settings.salesTaxes));

    const serializedEstimate = JSON.parse(JSON.stringify(estimate));
    serializedEstimate.signatureUrl = await resolveDocUrl((estimate as any).signatureUrl);
    if (Array.isArray(serializedEstimate.files)) {
        serializedEstimate.files = await Promise.all(
            serializedEstimate.files.map(async (f: any) => ({ ...f, url: await resolveDocUrl(f.url) }))
        );
    }

    return (
        <div className="flex h-[calc(100%+48px)] -m-6 overflow-hidden">
            <div className="flex-1 bg-slate-50 overflow-hidden flex flex-col">
                <EstimateEditor
                    context={{
                        type: "project",
                        id: project.id,
                        name: project.name,
                        clientName: project.client.name,
                        clientEmail: project.client.email || undefined,
                        location: project.location || undefined,
                        clientTaxExemptCertUrl: (project.client as any)?.taxExemptCertUrl || null,
                        clientTaxExemptCertExpiresAt: (project.client as any)?.taxExemptCertExpiresAt?.toISOString?.() || null
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
