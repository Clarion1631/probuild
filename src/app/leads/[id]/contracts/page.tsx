import { getLead, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import EntityContractsClient from "@/components/EntityContractsClient";
import { resolveDocUrl } from "@/lib/secure-storage";
import { currentStaffUserOrNull, contractScopeWhere } from "@/lib/permissions";

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
    // Scoped by the SAME rule the contract server actions assert — see the
    // matching comment on the project contracts page. The lead layout checks
    // only `leadAccess`, so without this a staffer with no `contracts`
    // permission read the body, signatures and signing accessToken here; and
    // the linked-project union below would otherwise surface converted
    // contracts (which carry BOTH ids, and canAccessJobScope lets the project
    // win) whose edit / delete / history buttons throw Forbidden.
    const viewer = await currentStaffUserOrNull();
    const contracts = await prisma.contract.findMany({
        where: {
            AND: [
                contractScopeWhere(viewer),
                {
                    OR: [
                        { leadId: lead.id },
                        ...(linkedProjectId ? [{ projectId: linkedProjectId }] : []),
                    ],
                },
            ],
        },
        // Only the record COUNT is rendered here; the Signing History modal loads full
        // records (with resolved signature URLs) on demand. Selecting just the id keeps raw
        // `secure:` signature paths out of the serialized page payload.
        include: { signingRecords: { select: { id: true } } },
        orderBy: { createdAt: "desc" },
    });

    // Executed-PDF lookup: widen to cover files saved under either the lead or the project.
    // ProjectFile.url may hold either a legacy public URL or a secure ref — resolve per row.
    const executedFilesRaw = await prisma.projectFile.findMany({
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
    const executedFiles = await Promise.all(
        executedFilesRaw.map(async (f) => ({ name: f.name, url: await resolveDocUrl(f.url) }))
    );

    const findOriginalPdfUrl = (originalPdfPath: string | null) => resolveDocUrl(originalPdfPath);

    const findExecutedPdfUrl = (contractId: string, title: string) => {
        const exactName = `Executed_Contract_${contractId}.pdf`;
        const byId = executedFiles.find(f => f.name === exactName);
        if (byId) return byId.url;
        const safeName = `Executed_Contract_${title.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        return executedFiles.find(f => f.name.startsWith(safeName))?.url || null;
    };

    const resolvedContracts = await Promise.all(contracts.map(async (c) => ({
        ...c,
        signatureUrl: await resolveDocUrl(c.signatureUrl),
        contractorSignatureUrl: await resolveDocUrl(c.contractorSignatureUrl),
        companySignatureUrl: await resolveDocUrl(c.companySignatureUrl),
        executedPdfUrl: findExecutedPdfUrl(c.id, c.title),
        originalPdfUrl: await findOriginalPdfUrl(c.originalPdfPath),
    })));

    const serialized = JSON.parse(JSON.stringify(resolvedContracts));

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
