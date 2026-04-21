import { getLead, getLeadTasks, getTeamMembers, convertLeadToProject } from "@/lib/actions";
import { redirect } from "next/navigation";
import LeadSidebar from "../LeadSidebar";
import LeadDetailsSidebar from "../LeadDetailsSidebar";
import LeadTasksPanel from "./LeadTasksPanel";

export default async function LeadTasksPage({ params }: { params: Promise<{ id: string }> }) {
    const resolvedParams = await params;
    const lead = await getLead(resolvedParams.id);
    if (!lead) return <div className="p-6">Lead not found</div>;

    const [tasks, teamMembers] = await Promise.all([
        getLeadTasks(lead.id),
        getTeamMembers(),
    ]);

    async function handleConvert() {
        "use server";
        const project = await convertLeadToProject(lead!.id);
        redirect(`/`);
    }

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <LeadSidebar
                leadId={lead.id}
                leadName={lead.name}
                clientName={lead.client?.name || ""}
                onConvert={handleConvert}
            />

            <LeadTasksPanel
                leadId={lead.id}
                tasks={tasks.map(t => ({
                    ...t,
                    dueDate: t.dueDate?.toISOString() || null,
                    createdAt: t.createdAt.toISOString(),
                    updatedAt: t.updatedAt.toISOString(),
                }))}
                teamMembers={teamMembers as any}
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
                clientId={lead.client?.id || ""}
                clientName={lead.client?.name || ""}
                clientEmail={lead.client?.email || null}
                clientAdditionalEmail={(lead.client as any)?.additionalEmail || null}
                clientPhone={(lead.client as any)?.primaryPhone || null}
                clientAddress={(lead.client as any)?.addressLine1 || null}
                clientCity={(lead.client as any)?.city || null}
                clientState={(lead.client as any)?.state || null}
                clientZip={(lead.client as any)?.zipCode || null}
                initialMessage={lead.message || null}
            />
        </div>
    );
}
