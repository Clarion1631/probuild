import { getLead, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import EntityContractsClient from "@/components/EntityContractsClient";

export const dynamic = "force-dynamic";

export default async function LeadContractsPage({ params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ action?: string }>;
}) {
    const { id } = await params;
    const { action } = await searchParams;
    const lead = await getLead(id);
    if (!lead) notFound();

    const templates = await getDocumentTemplates();
    const linkedProjectId: string | null = (lead.project as any)?.id ?? null;

    // Fetch all contracts visible to this lead: those directly attached (leadId = X)
    // and those on the linked converted project (projectId = linked-project-id).
    // OR returns unique rows; no manual dedup needed.
    const contracts = await prisma.contract.findMany({
        where: {
            OR: [
                { leadId: lead.id },
                ...(linkedProjectId ? [{ projectId: linkedProjectId }] : []),
            ],
        },
        include: { signingRecords: true },
        orderBy: { createdAt: "desc" },
    });

    // Executed-PDF lookup: widen to cover files saved under either the lead or the project.
    const executedFiles = await prisma.projectFile.findMany({
        where: {
            OR: [
                { leadId: lead.id },
                ...(linkedProjectId ? [{ projectId: linkedProjectId }] : []),
            ],
            mimeType: "application/pdf",
            name: { contains: "Executed_Contract_" },
        },
        orderBy: { createdAt: "desc" },
        select: { name: true, url: true },
    });

    const findExecutedPdfUrl = (contractId: string, title: string) => {
        const exactName = `Executed_Contract_${contractId}.pdf`;
        const byId = executedFiles.find(f => f.name === exactName);
        if (byId) return byId.url;
        const safeName = `Executed_Contract_${title.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        return executedFiles.find(f => f.name.startsWith(safeName))?.url || null;
    };

    const serialized = JSON.parse(JSON.stringify(
        contracts.map(c => ({ ...c, executedPdfUrl: findExecutedPdfUrl(c.id, c.title) }))
    ));

    const linkedEntity = linkedProjectId
        ? { type: "project" as const, id: linkedProjectId, name: (lead.project as any).name }
        : null;

    return (
        <EntityContractsClient
            entity={{ type: "lead", id: lead.id, name: lead.name, clientName: lead.client?.name || "" }}
            contracts={serialized}
            templates={templates.map((t: any) => ({ id: t.id, name: t.name, type: t.type }))}
            linkedEntity={linkedEntity}
            autoCreate={action === "create"}
        />
    );
}
