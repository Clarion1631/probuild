import { getLead, getContracts, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import LeadContractsClient from "./LeadContractsClient";

export const dynamic = "force-dynamic";

export default async function LeadContractsPage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ action?: string }>;
}) {
    const resolvedParams = await params;
    const resolvedSearch = await searchParams;
    const lead = await getLead(resolvedParams.id);
    if (!lead) notFound();

    const contracts = await getContracts(undefined, lead.id);
    const templates = await getDocumentTemplates();

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <LeadContractsClient
                leadId={lead.id}
                leadName={lead.name}
                clientName={lead.client.name}
                contracts={contracts.map(c => ({
                    ...c,
                    createdAt: c.createdAt.toISOString(),
                    updatedAt: c.updatedAt.toISOString(),
                    sentAt: c.sentAt?.toISOString() || null,
                    approvedAt: c.approvedAt?.toISOString() || null,
                    nextDueDate: c.nextDueDate?.toISOString() || null,
                    viewedAt: c.viewedAt?.toISOString() || null,
                }))}
                templates={templates.map(t => ({ id: t.id, name: t.name, type: t.type }))}
                autoCreate={resolvedSearch.action === "create"}
            />
        </div>
    );
}
