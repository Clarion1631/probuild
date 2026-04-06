import { getLead, convertLeadToProject, getDocumentTemplates } from "@/lib/actions";
import { redirect } from "next/navigation";
import LeadSidebar from "./LeadSidebar";
import LeadMessaging from "./LeadMessaging";
import LeadDetailsSidebar from "./LeadDetailsSidebar";
import { prisma } from "@/lib/prisma";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const leadRaw = await getLead(resolvedParams.id);
    if (!leadRaw) return <div className="p-6">Lead not found</div>;
    // Normalize Decimal fields to plain numbers for client component serialization
    const lead = {
        ...leadRaw,
        targetRevenue: leadRaw.targetRevenue != null ? Number(leadRaw.targetRevenue) : null,
        expectedProfit: leadRaw.expectedProfit != null ? Number(leadRaw.expectedProfit) : null,
    };

    // Fetch estimates for the attachment picker
    const estimates = await prisma.estimate.findMany({
        where: { leadId: lead.id },
        select: { id: true, code: true, title: true, status: true },
        orderBy: { createdAt: "desc" },
    });

    // Fetch the initial message field
    const leadFull = await prisma.lead.findUnique({
        where: { id: lead.id },
        select: { message: true },
    });

    async function handleConvert() {
        "use server";
        const project = await convertLeadToProject(lead!.id);
        redirect(`/`);
    }

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            {/* Left Sidebar - Navigation */}
            <LeadSidebar
                leadId={lead.id}
                leadName={lead.name}
                clientName={lead.client?.name || ""}
                onConvert={handleConvert}
            />

            {/* Center - Messaging */}
            <LeadMessaging
                leadId={lead.id}
                clientName={lead.client?.name || ""}
                leadName={lead.name}
                leadSource={lead.source}
                createdAt={lead.createdAt.toISOString()}
                location={lead.location}
                clientEmail={lead.client?.email || null}
                clientPhone={(lead.client as any)?.primaryPhone || null}
                initialMessage={leadFull?.message || null}
                estimates={estimates}
            />

            {/* Right Sidebar - Details */}
            <LeadDetailsSidebar
                leadId={lead.id}
                leadName={lead.name}
                leadSource={lead.source}
                leadStage={lead.stage}
                expectedStartDate={lead.expectedStartDate?.toISOString().split("T")[0] || null}
                targetRevenue={lead.targetRevenue}
                location={lead.location}
                projectType={lead.projectType}
                clientId={lead.client?.id || ""}
                clientName={lead.client?.name || ""}
                clientEmail={lead.client?.email || null}
                clientPhone={(lead.client as any)?.primaryPhone || null}
                clientAddress={(lead.client as any)?.addressLine1 || null}
                clientCity={(lead.client as any)?.city || null}
                clientState={(lead.client as any)?.state || null}
                clientZip={(lead.client as any)?.zipCode || null}
                initialMessage={leadFull?.message || null}
            />
        </div>
    );
}
