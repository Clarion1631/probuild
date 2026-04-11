import { getLead, getContracts, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
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

    // Fetch all executed PDF ProjectFiles for this lead in one pass, then match to contracts
    // by the naming convention in /api/portal/contracts/[id]/finalize/route.ts. New files
    // embed the contractId (`_Executed_Contract_{contractId}.pdf`); legacy files use the
    // safe-title prefix. We match new-format first so title collisions don't confuse us.
    const executedFiles = await prisma.projectFile.findMany({
        where: {
            leadId: lead.id,
            mimeType: "application/pdf",
            name: { contains: "Executed_Contract_" },
        },
        orderBy: { createdAt: "desc" },
        select: { name: true, url: true, createdAt: true },
    });

    const findExecutedPdfUrl = (contractId: string, title: string) => {
        // Preferred: exact-match on the contractId-embedded filename.
        // (finalize/route.ts sets `ProjectFile.name` to exactly `Executed_Contract_{id}.pdf`
        // — timestamp lives in the storage path, not the DB name column.)
        const exactName = `Executed_Contract_${contractId}.pdf`;
        const byId = executedFiles.find(f => f.name === exactName);
        if (byId) return byId.url;
        // Legacy fallback: filename based on the contract title
        const safeName = `Executed_Contract_${title.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        return executedFiles.find(f => f.name.startsWith(safeName))?.url || null;
    };

    return (
        <div className="flex h-[calc(100vh-64px)] -m-6 overflow-hidden bg-hui-background">
            <LeadContractsClient
                leadId={lead.id}
                leadName={lead.name}
                clientName={lead.client?.name || ""}
                contracts={contracts.map(c => ({
                    ...c,
                    createdAt: c.createdAt.toISOString(),
                    updatedAt: c.updatedAt.toISOString(),
                    sentAt: c.sentAt?.toISOString() || null,
                    approvedAt: c.approvedAt?.toISOString() || null,
                    nextDueDate: c.nextDueDate?.toISOString() || null,
                    viewedAt: c.viewedAt?.toISOString() || null,
                    executedPdfUrl: findExecutedPdfUrl(c.id, c.title),
                }))}
                templates={templates.map(t => ({ id: t.id, name: t.name, type: t.type }))}
                autoCreate={resolvedSearch.action === "create"}
            />
        </div>
    );
}
