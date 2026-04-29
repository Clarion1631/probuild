import { getLead, getDocumentTemplates } from "@/lib/actions";
import LeadMessaging from "./LeadMessaging";
import LeadDetailsSidebar from "./LeadDetailsSidebar";
import { prisma } from "@/lib/prisma";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const leadRaw = await getLead(resolvedParams.id);
    if (!leadRaw) return <div className="p-6">Lead not found</div>;
    const lead = {
        ...leadRaw,
        targetRevenue: leadRaw.targetRevenue != null ? Number(leadRaw.targetRevenue) : null,
        expectedProfit: leadRaw.expectedProfit != null ? Number(leadRaw.expectedProfit) : null,
    };

    const [estimates, leadFull] = await Promise.all([
        prisma.estimate.findMany({
            where: { leadId: lead.id },
            select: { id: true, code: true, title: true, status: true },
            orderBy: { createdAt: "desc" },
        }),
        prisma.lead.findUnique({
            where: { id: lead.id },
            select: { message: true },
        }),
    ]);

    return (
        <>
            <LeadMessaging
                leadId={lead.id}
                clientName={lead.client?.name || ""}
                leadName={lead.name}
                leadSource={lead.source}
                createdAt={typeof lead.createdAt === "string" ? lead.createdAt : lead.createdAt.toISOString()}
                location={lead.location}
                clientEmail={lead.client?.email || null}
                clientPhone={(lead.client as any)?.primaryPhone || null}
                initialMessage={leadFull?.message || null}
                estimates={estimates}
            />
            <LeadDetailsSidebar
                leadId={lead.id}
                leadName={lead.name}
                leadSource={lead.source}
                leadStage={lead.stage}
                expectedStartDate={lead.expectedStartDate ? (typeof lead.expectedStartDate === "string" ? lead.expectedStartDate.split("T")[0] : lead.expectedStartDate.toISOString().split("T")[0]) : null}
                targetRevenue={lead.targetRevenue}
                location={lead.location}
                projectType={lead.projectType}
                clientId={lead.client?.id || ""}
                clientName={lead.client?.name || ""}
                clientEmail={lead.client?.email || null}
                clientAdditionalEmail={(lead.client as any)?.additionalEmail || null}
                clientPhone={(lead.client as any)?.primaryPhone || null}
                clientAddress={(lead.client as any)?.addressLine1 || null}
                clientCity={(lead.client as any)?.city || null}
                clientState={(lead.client as any)?.state || null}
                clientZip={(lead.client as any)?.zipCode || null}
                initialMessage={leadFull?.message || null}
                managerId={(lead as any).manager?.id || null}
                managerName={(lead as any).manager?.name || null}
            />
        </>
    );
}
