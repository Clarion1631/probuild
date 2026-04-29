import { getProject, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import EntityContractsClient from "@/components/EntityContractsClient";

export const dynamic = "force-dynamic";

export default async function ProjectContractsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const project = await getProject(id);
    if (!project) notFound();

    const templates = await getDocumentTemplates();
    const linkedLeadId: string | null = (project as any).leadId ?? null;

    // Fetch all contracts visible to this project: those directly attached (projectId = X)
    // and those on the linked originating lead (leadId = linked-lead-id).
    // OR returns unique rows; no manual dedup needed.
    const contracts = await prisma.contract.findMany({
        where: {
            OR: [
                { projectId: project.id },
                ...(linkedLeadId ? [{ leadId: linkedLeadId }] : []),
            ],
        },
        include: { signingRecords: true },
        orderBy: { createdAt: "desc" },
    });

    // Executed-PDF lookup: widen to cover files saved under either the project or the lead.
    const executedFiles = await prisma.projectFile.findMany({
        where: {
            OR: [
                { projectId: project.id },
                ...(linkedLeadId ? [{ leadId: linkedLeadId }] : []),
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

    const linkedEntity = linkedLeadId
        ? { type: "lead" as const, id: linkedLeadId, name: (project as any).lead?.name ?? "" }
        : null;

    return (
        <div className="max-w-5xl mx-auto">
            <EntityContractsClient
                entity={{ type: "project", id: project.id, name: project.name, clientName: (project as any).client?.name || "Client" }}
                contracts={serialized}
                templates={templates.map((t: any) => ({ id: t.id, name: t.name, type: t.type }))}
                linkedEntity={linkedEntity}
            />
        </div>
    );
}
