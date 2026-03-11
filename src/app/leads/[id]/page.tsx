import { getLead, convertLeadToProject, getDocumentTemplates } from "@/lib/actions";
import { redirect } from "next/navigation";
import LeadSidebar from "./LeadSidebar";
import LeadMessaging from "./LeadMessaging";
import LeadDetailsSidebar from "./LeadDetailsSidebar";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);
    if (!lead) return <div className="p-6">Lead not found</div>;

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
                clientName={lead.client.name}
                onConvert={handleConvert}
            />

            {/* Center - Messaging */}
            <LeadMessaging
                leadId={lead.id}
                clientName={lead.client.name}
                leadName={lead.name}
                leadSource={lead.source}
                createdAt={lead.createdAt.toISOString()}
                location={lead.location}
                clientEmail={lead.client.email}
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
                clientId={lead.client.id}
                clientName={lead.client.name}
                clientEmail={lead.client.email}
                clientPhone={(lead.client as any).primaryPhone || null}
                clientAddress={(lead.client as any).addressLine1 || null}
                clientCity={(lead.client as any).city || null}
                clientState={(lead.client as any).state || null}
                clientZip={(lead.client as any).zipCode || null}
            />
        </div>
    );
}
