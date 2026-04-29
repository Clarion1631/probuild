import { getLead, getLeadMeetings } from "@/lib/actions";
import LeadDetailsSidebar from "../LeadDetailsSidebar";
import LeadMeetingsPanel from "./LeadMeetingsPanel";

export default async function LeadMeetingsPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);
    if (!lead) return <div className="p-6">Lead not found</div>;

    const meetings = await getLeadMeetings(resolvedParams.id);

    const serializedMeetings = meetings.map((m: any) => ({
        ...m,
        scheduledAt: m.scheduledAt.toISOString(),
        endAt: m.endAt.toISOString(),
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
    }));

    return (
        <>
            <LeadMeetingsPanel
                leadId={lead.id}
                clientName={lead.client.name}
                meetings={serializedMeetings}
            />
            <LeadDetailsSidebar
                leadId={lead.id}
                leadName={lead.name}
                leadSource={lead.source}
                leadStage={lead.stage}
                expectedStartDate={lead.expectedStartDate?.toISOString().split("T")[0] || null}
                targetRevenue={lead.targetRevenue ? Number(lead.targetRevenue) : null}
                location={lead.location}
                projectType={lead.projectType}
                clientId={lead.client.id}
                clientName={lead.client.name}
                clientEmail={lead.client.email}
                clientAdditionalEmail={(lead.client as any)?.additionalEmail || null}
                clientPhone={(lead.client as any)?.primaryPhone || null}
                clientAddress={(lead.client as any)?.addressLine1 || null}
                clientCity={(lead.client as any)?.city || null}
                clientState={(lead.client as any)?.state || null}
                clientZip={(lead.client as any)?.zipCode || null}
                initialMessage={lead.message || null}
            />
        </>
    );
}
