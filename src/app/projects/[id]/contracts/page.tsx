import { getProject, getDocumentTemplates } from "@/lib/actions";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import EntityContractsClient from "@/components/EntityContractsClient";
import { resolveDocUrl } from "@/lib/secure-storage";
import { currentStaffUserOrNull, contractScopeWhere } from "@/lib/permissions";

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
    // Scoped by the SAME rule the contract server actions assert. The layout
    // above checks project access but never the `contracts` permission, and
    // this page queries Prisma directly rather than through getContracts — so
    // without this filter a FINANCE user (role default: `estimates`, not
    // `contracts`) holding project access could read the contract body,
    // signatures and the signing accessToken here despite being refused by
    // every guarded action. It also stops the page rendering rows whose edit /
    // delete / history buttons would throw Forbidden: the linked-lead union
    // below is deliberately bidirectional, and canAccessJobScope lets the
    // project id win whenever a converted contract carries both.
    const viewer = await currentStaffUserOrNull();
    const contracts = await prisma.contract.findMany({
        where: {
            AND: [
                contractScopeWhere(viewer),
                {
                    OR: [
                        { projectId: project.id },
                        ...(linkedLeadId ? [{ leadId: linkedLeadId }] : []),
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

    // Executed-PDF lookup: widen to cover files saved under either the project or the lead.
    // ProjectFile.url may hold either a legacy public URL or a secure ref — resolve per row.
    const executedFilesRaw = await prisma.projectFile.findMany({
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
